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

import { existsSync, readFileSync, readdirSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setOwnRecordValue } from '../shared/record-count.js';
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
  /** 是否放行私网/本机 endpoint。默认 false:hostname 为 localhost、*.local、::1、
   *  127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、169.254.0.0/16
   *  (含云 metadata 169.254.169.254)时直接 fail。动机:check() 会把 skill 完整
   *  快照 POST 给 endpoint 并把响应回填进报告,等于一个 SSRF response oracle,
   *  默认不能指向内网/本机。确属可信内网检查服务时显式置 true 放行。 */
  allowPrivateHost?: boolean;
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
      // lstat(不跟随 symlink):跳过符号链接,防止 skillRoot 下的 link 指向 root 外
      // (如 /etc/passwd)被读取并随 payload 外发。
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(full, relPath, depth + 1);
      } else if (st.isFile()) {
        if (SKIP_EXTENSIONS.has(extOf(entry))) continue;
        let buf: Buffer;
        if (st.size > maxFileBytes) {
          // 大文件守卫:不整文件读入(超大文件会撑内存,超 Buffer 上限的 throw
          // 还会被 catch 静默跳过),只读前 maxFileBytes + 1 字节,NUL 嗅探与
          // 截断都在这个前缀上做。
          let fd: number;
          try { fd = openSync(full, 'r'); } catch { continue; }
          try {
            const head = Buffer.allocUnsafe(maxFileBytes + 1);
            const n = readSync(fd, head, 0, head.length, 0);
            buf = head.subarray(0, n);
          } catch { continue; } finally { closeSync(fd); }
        } else {
          try { buf = readFileSync(full); } catch { continue; }
        }
        // 内容嗅探:含 NUL 字节 → 二进制,跳过(扩展名漏网的 binary 兜底)。
        if (buf.includes(0)) continue;
        // 按字节截断(中文等多字节内容也不会冲穿上限);单文件受 maxFileBytes 与
        // 剩余总预算双重收口,超限只收前缀,toString 会把尾部可能被切断的半个
        // UTF-8 字符替换成 U+FFFD。total 按实际写入的字节数累计(含截断标记与
        // U+FFFD 展开),所以 maxTotalBytes 至多被末文件冲破十几个字节(常数级)。
        const cap = Math.min(maxFileBytes, maxTotalBytes - total);
        const over = buf.length > cap;
        const slice = over ? buf.subarray(0, cap) : buf;
        const text = slice.toString('utf-8') + (over ? '\n…[truncated]' : '');
        setOwnRecordValue(files, relPath, text);
        total += Buffer.byteLength(text, 'utf-8');
      }
    }
  };
  walk(skillRoot, '', 0);
  return files;
}

function isValidStatus(s: unknown): s is EndpointResponse['status'] {
  return s === 'pass' || s === 'warn' || s === 'fail';
}

/** ::ffff:a.b.c.d / 规范化后的 ::ffff:hhhh:hhhh 还原成点分 IPv4;无法解析返回 null。
 *  WHATWG URL 会把 ::ffff:127.0.0.1 规范成 hex 形态 ::ffff:7f00:1。 */
function mappedToIPv4(suffix: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(suffix)) return suffix;
  const hx = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(suffix);
  if (!hx) return null;
  const hi = parseInt(hx[1], 16);
  const lo = parseInt(hx[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** 私网/本机 hostname 判定(SSRF 防护用)。只做字面 hostname 检查的
 *  defense-in-depth:不做 DNS 解析,公网域名解析到内网(DNS rebinding)不在
 *  防护范围。WHATWG URL 会把 0x7f.0.0.1 / 0 之类写法规整成点分十进制,所以
 *  IPv4 直接按规范化后的 hostname 判断即可。 */
function isPrivateHostname(hostname: string): boolean {
  // 转小写、去 IPv6 字面量方括号([::1] → ::1)、去 FQDN 尾点(localhost. / foo.local.)。
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.local')) return true;

  if (h.includes(':')) {
    // IPv6 字面量。
    if (h === '::1' || h === '::') return true;       // loopback / unspecified
    if (/^f[cd]/.test(h)) return true;                // fc00::/7 ULA
    if (/^fe[89ab]/.test(h)) return true;             // fe80::/10 link-local
    // IPv4-mapped(::ffff:…)归并到点分 IPv4 再判;无法解析的保守拒绝。
    const mapped = /^::ffff:(.+)$/.exec(h);
    if (!mapped) return false;
    const dotted = mappedToIPv4(mapped[1]);
    if (dotted == null) return true;
    h = dotted;
  }

  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0) return true;                          // 0.0.0.0/8(含 0.0.0.0、http://0/)
  if (a === 127) return true;                        // 127.0.0.0/8 loopback
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16(含云 metadata 169.254.169.254)
  return false;
}

/** outcome 自由文本/JSON 字段的统一上限(字符),与协议违规路径的 received 截断对齐。 */
const MAX_OUTCOME_CHARS = 2000;

/** 响应体声明长度(Content-Length)上限(字节):超过即拒读,避免超大 body 撑爆内存。
 *  注意只挡声明了 Content-Length 的情况;分块且不声明长度的响应仍只受 timeoutMs 墙钟约束。 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function clampText(s: string): string {
  return s.length > MAX_OUTCOME_CHARS ? `${s.slice(0, MAX_OUTCOME_CHARS)}…[truncated]` : s;
}

/** detail 先序列化判长:超限替换成 { truncated: true, preview } 结构,
 *  保证仍是合法 JSON 值且不会无界塞进 report。 */
function clampDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(detail) ?? '';
  if (json.length <= MAX_OUTCOME_CHARS) return detail;
  return { truncated: true, preview: json.slice(0, MAX_OUTCOME_CHARS) };
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
    // 网络检查,与 health composer 同档:CLI doctor 默认跑(在线检查)。
    external: true,
    async check(ctx: DoctorContext): Promise<DoctorRuleCheckOutcome> {
      // SSRF 防护(defense-in-depth):endpoint 会收到 skill 完整快照,且响应
      // 原样回填进报告(response oracle),所以组装请求前先校验 scheme 与 host,
      // 私网/本机地址默认拒绝(云 metadata 169.254.169.254、内网主机等)。
      // 只做字面校验、不做 DNS 解析:公网域名解析到内网(DNS rebinding)不在
      // 防护范围。
      let endpointUrl: URL;
      try {
        endpointUrl = new URL(spec.endpoint);
      } catch {
        return {
          status: 'fail',
          message: failMsg(
            ctx, spec,
            `endpoint 不是合法 URL：${spec.endpoint}`,
            `endpoint is not a valid URL: ${spec.endpoint}`,
          ),
          detail: { endpoint: spec.endpoint },
        };
      }
      if (endpointUrl.protocol !== 'http:' && endpointUrl.protocol !== 'https:') {
        return {
          status: 'fail',
          message: failMsg(
            ctx, spec,
            `endpoint 协议必须是 http/https，实际是 ${endpointUrl.protocol}`,
            `endpoint protocol must be http/https, got ${endpointUrl.protocol}`,
          ),
          detail: { endpoint: spec.endpoint, protocol: endpointUrl.protocol },
        };
      }
      if (!spec.allowPrivateHost && isPrivateHostname(endpointUrl.hostname)) {
        return {
          status: 'fail',
          message: failMsg(
            ctx, spec,
            `endpoint 指向私网/本机地址（${endpointUrl.hostname}），默认拒绝以防 SSRF（skill 快照会被外发、响应会回填进报告）；确认该内网服务可信后，可在维度配置加 allowPrivateHost: true 放行`,
            `endpoint points to a private/loopback host (${endpointUrl.hostname}); refused by default to prevent SSRF (the skill snapshot is sent out and the response is echoed into the report). Set allowPrivateHost: true in the dimension config if this internal service is trusted`,
          ),
          detail: { endpoint: spec.endpoint, hostname: endpointUrl.hostname },
        };
      }

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
      let parsed: unknown;
      try {
        let res: Response;
        try {
          res = await fetchFn(spec.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...spec.headers },
            body: JSON.stringify(body),
            signal: controller.signal,
            // redirect:'manual' —— 不跟随重定向。否则一个可信公网 endpoint 返回
            // 302 Location: http://169.254.169.254/… 即可让 fetch 透明跳到私网,
            // 绕过上面的 host 校验(请求前只校验一次原始 URL)。3xx 一律拒绝。
            redirect: 'manual',
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            status: 'fail',
            message: failMsg(ctx, spec, `请求失败：${msg}`, `request failed: ${msg}`),
            hint: hintNet(ctx, spec.endpoint),
            detail: { endpoint: spec.endpoint, error: msg },
          };
        }

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers?.get?.('location') ?? null;
          return {
            status: 'fail',
            message: failMsg(
              ctx, spec,
              `endpoint 返回重定向（HTTP ${res.status}），默认拒绝以防 SSRF（重定向目标可能指向私网）`,
              `endpoint returned a redirect (HTTP ${res.status}); refused by default to prevent SSRF (the redirect target may point to a private host)`,
            ),
            hint: hintNet(ctx, spec.endpoint),
            detail: { endpoint: spec.endpoint, httpStatus: res.status, location },
          };
        }

        const declaredLen = Number(res.headers?.get?.('content-length') ?? '');
        if (Number.isFinite(declaredLen) && declaredLen > MAX_RESPONSE_BYTES) {
          return {
            status: 'fail',
            message: failMsg(
              ctx, spec,
              `响应体过大（Content-Length ${declaredLen} 字节，上限 ${MAX_RESPONSE_BYTES}）`,
              `response body too large (Content-Length ${declaredLen} bytes, limit ${MAX_RESPONSE_BYTES})`,
            ),
            hint: hintProto(ctx),
            detail: { endpoint: spec.endpoint, contentLength: declaredLen },
          };
        }

        if (!res.ok) {
          return {
            status: 'fail',
            message: failMsg(ctx, spec, `接口返回 HTTP ${res.status}`, `endpoint returned HTTP ${res.status}`),
            hint: hintNet(ctx, spec.endpoint),
            detail: { endpoint: spec.endpoint, httpStatus: res.status },
          };
        }

        try {
          parsed = await res.json();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            status: 'fail',
            message: failMsg(ctx, spec, `响应不是合法 JSON：${msg}`, `response is not valid JSON: ${msg}`),
            hint: hintProto(ctx),
            detail: { endpoint: spec.endpoint, error: msg },
          };
        }
      } finally {
        // timer 覆盖 fetch + body 读取(res.json()):两者都完成或任一出错后才清,
        // 防止慢速/滴流响应体绕过 ctx.timeoutMs 无限挂起。
        clearTimeout(timer);
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
          // received 截断:接口可能返回超大 body,避免无界塞进 report JSON。
          detail: { endpoint: spec.endpoint, received: JSON.stringify(parsed).slice(0, MAX_OUTCOME_CHARS) },
        };
      }

      // 合法响应同样截断:message / hint / detail 都来自外部接口,不加界会被
      // 无界写入 outcome 落盘(与上面 received 的处理风格对齐)。
      return {
        status: resp.status,
        message: `${spec.displayName}: ${clampText(resp.message)}`,
        hint: typeof resp.hint === 'string' ? clampText(resp.hint) : resp.hint,
        detail: resp.detail == null ? { endpoint: spec.endpoint } : clampDetail(resp.detail),
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
    ? `确认接口 ${endpoint} 可达、鉴权 header 正确，或调大 --timeout`
    : `Verify endpoint ${endpoint} is reachable, auth headers are correct, or raise --timeout`;
}

function hintProto(ctx: DoctorContext): string {
  return ctx.lang === 'zh'
    ? '接口需返回 JSON: { status: "pass"|"warn"|"fail", message: string, hint?, detail? }'
    : 'Endpoint must return JSON: { status: "pass"|"warn"|"fail", message: string, hint?, detail? }';
}
