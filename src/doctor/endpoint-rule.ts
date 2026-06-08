/**
 * endpoint-rule — 接口驱动的自定义检查维度。
 *
 * 普通自定义维度走 LLM health composer(promptSection 喂 prompt);带 `endpoint`
 * 的维度则注册成独立 DoctorRule:doctor 运行时把 skill 完整快照 POST 给用户的
 * 接口,接口按协议返回判定结果。适合"调外部服务做深度审查"(eg. 安全风险审查)
 * 这类靠 prompt 表达不了、需要真实逻辑/模型的场景。
 *
 * 请求协议(doctor → endpoint):
 *   POST <endpoint>  Content-Type: application/json
 *   {
 *     "dimensionId": "deep-security-audit",
 *     "params": { ... },                  // YAML 里用户透传的自定义参数
 *     "skill": {
 *       "name": "my-skill",
 *       "content": "SKILL.md 全文",        // file-skill / directory-skill 主文件
 *       "skillRoot": "/abs/path" | null,   // git / inline 来源可能为 null
 *       "ref": "abc1234" | null,           // git 来源的 commit
 *       "files": { "references/x.md": "...", "scripts/y.sh": "..." }  // 子文件快照
 *     }
 *   }
 *
 * 响应协议(endpoint → doctor):
 *   { "status": "pass" | "warn" | "fail", "message": "...", "hint"?: "...", "detail"?: {...} }
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DoctorRule,
  DoctorRuleCheckOutcome,
  DoctorContext,
  DoctorSeverity,
} from '../types/doctor.js';

export interface EndpointDimensionSpec {
  id: string;
  displayName: string;
  severity: DoctorSeverity;
  /** 检查接口地址。doctor 把 skill 快照 POST 到这里。 */
  endpoint: string;
  /** 用户自定义参数,原样放进请求 body.params 透传给接口。 */
  params?: Record<string, unknown>;
  /** 是否把子文件(references / scripts 等)内容一起传。默认 true。
   *  关掉可显著缩小 payload(接口只看主文件时)。 */
  includeFiles?: boolean;
  /** 附加请求头(eg. 鉴权 token)。 */
  headers?: Record<string, string>;
  /** 单文件内容上限(字节),超过截断。默认 200KB。 */
  maxFileBytes?: number;
  /** 整个 files 块的总上限(字节),超过停止收集。默认 2MB。 */
  maxTotalBytes?: number;
}

/** endpoint 必须返回的判定结构。 */
interface EndpointResponse {
  status: 'pass' | 'warn' | 'fail';
  message: string;
  hint?: string;
  detail?: Record<string, unknown>;
}

const DEFAULT_MAX_FILE_BYTES = 200 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/** 二进制 / 大文件不可读时跳过;只收文本。简单按扩展名 + 内容嗅探。 */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.gz', '.tar', '.tgz', '.exe', '.bin', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.mp4', '.mov', '.mp3', '.wav',
]);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

/** 收集 skillRoot 下的子文件内容(排除主 SKILL.md / 隐藏文件 / node_modules)。
 *  受 maxFileBytes / maxTotalBytes 双重限制,避免 payload 过大。 */
function collectFiles(
  skillRoot: string | null,
  maxFileBytes: number,
  maxTotalBytes: number,
): Record<string, string> {
  const files: Record<string, string> = {};
  if (!skillRoot || !existsSync(skillRoot)) return files;
  let total = 0;

  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 3 || total >= maxTotalBytes) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (total >= maxTotalBytes) return;
      if (entry.startsWith('.')) continue;
      if (entry === 'node_modules') continue;
      if (entry === 'SKILL.md' && rel === '') continue;
      const full = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full, relPath, depth + 1);
      } else if (st.isFile()) {
        if (SKIP_EXTENSIONS.has(extOf(entry))) continue;
        let content: string;
        try { content = readFileSync(full, 'utf-8'); } catch { continue; }
        if (Buffer.byteLength(content, 'utf-8') > maxFileBytes) {
          content = content.slice(0, maxFileBytes) + '\n…[truncated]';
        }
        files[relPath] = content;
        total += Buffer.byteLength(content, 'utf-8');
      }
    }
  };
  walk(skillRoot, '', 0);
  return files;
}

function isValidStatus(s: unknown): s is EndpointResponse['status'] {
  return s === 'pass' || s === 'warn' || s === 'fail';
}

/** 可注入的 fetch(测试用),默认走全局 fetch。 */
export type FetchFn = typeof fetch;

/**
 * 把一个 endpoint spec 编译成 DoctorRule。check() 内组装 skill 快照、POST、
 * 校验响应协议并映射成 DoctorRuleCheckOutcome。
 *
 * 所有失败(网络错误 / 非 2xx / 非法 JSON / 协议字段缺失)都返回 status='fail',
 * 让用户立刻看到接口侧的问题,而不是静默放行。
 */
export function makeEndpointRule(
  spec: EndpointDimensionSpec,
  fetchFn: FetchFn = fetch,
): DoctorRule {
  return {
    id: spec.id,
    severity: spec.severity,
    // 自定义 key 不在 DOCTOR_MESSAGES 字典里,renderer 会 fallback 到 ruleId(=spec.id)。
    labelKey: `cli.doctor.endpoint.${spec.id}`,
    // 网络检查,与 health composer 同档:默认跑,--static-only 跳过。
    external: true,
    async check(ctx: DoctorContext): Promise<DoctorRuleCheckOutcome> {
      const artifact = ctx.artifact;
      const content = artifact.content ?? '';
      const skillName = artifact.name.replace(/\.md$/, '').split('/').pop() ?? artifact.name;
      const skillRoot = artifact.skillRoot ?? null;
      const includeFiles = spec.includeFiles !== false;
      const files = includeFiles
        ? collectFiles(
            skillRoot,
            spec.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
            spec.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
          )
        : {};

      const body = {
        dimensionId: spec.id,
        params: spec.params ?? {},
        skill: {
          name: skillName,
          content,
          skillRoot,
          ref: artifact.ref ?? null,
          files,
        },
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
      let res: Response;
      try {
        res = await fetchFn(spec.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...spec.headers },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: 'fail',
          message: failMsg(ctx, spec, `请求失败: ${msg}`, `request failed: ${msg}`),
          hint: hintNet(ctx, spec.endpoint),
          detail: { endpoint: spec.endpoint, error: msg },
        };
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        return {
          status: 'fail',
          message: failMsg(ctx, spec, `接口返回 HTTP ${res.status}`, `endpoint returned HTTP ${res.status}`),
          hint: hintNet(ctx, spec.endpoint),
          detail: { endpoint: spec.endpoint, httpStatus: res.status },
        };
      }

      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: 'fail',
          message: failMsg(ctx, spec, `响应不是合法 JSON: ${msg}`, `response is not valid JSON: ${msg}`),
          hint: hintProto(ctx),
          detail: { endpoint: spec.endpoint, error: msg },
        };
      }

      const resp = parsed as Partial<EndpointResponse>;
      if (!isValidStatus(resp.status) || typeof resp.message !== 'string') {
        return {
          status: 'fail',
          message: failMsg(
            ctx, spec,
            '响应缺少必填字段 status(pass/warn/fail) 或 message',
            'response missing required field status (pass/warn/fail) or message',
          ),
          hint: hintProto(ctx),
          detail: { endpoint: spec.endpoint, received: parsed },
        };
      }

      return {
        status: resp.status,
        message: `${spec.displayName}: ${resp.message}`,
        hint: resp.hint,
        detail: resp.detail ?? { endpoint: spec.endpoint },
      };
    },
  };
}

function failMsg(ctx: DoctorContext, spec: EndpointDimensionSpec, zh: string, en: string): string {
  const head = `${spec.displayName}`;
  return ctx.lang === 'zh' ? `${head}: ${zh}` : `${head}: ${en}`;
}

function hintNet(ctx: DoctorContext, endpoint: string): string {
  return ctx.lang === 'zh'
    ? `确认接口 ${endpoint} 可达、鉴权 header 正确,或调大 --timeout`
    : `Verify endpoint ${endpoint} is reachable, auth headers are correct, or raise --timeout`;
}

function hintProto(ctx: DoctorContext): string {
  return ctx.lang === 'zh'
    ? '接口需返回 JSON: { status: "pass"|"warn"|"fail", message: string, hint?, detail? }'
    : 'Endpoint must return JSON: { status: "pass"|"warn"|"fail", message: string, hint?, detail? }';
}
