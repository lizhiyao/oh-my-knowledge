/**
 * omk doctor 内置规则注册表。
 *
 * 每条 rule 回答一个独立的「skill 能不能被有意义评测」子问题:
 *   - skill_readable: 文件能读、内容非空且有最小长度
 *   - skill_metadata: front-matter(若有) YAML 合法、directory-skill 有 SKILL.md
 *   - dependencies: 引用的 tool / file / env / preflight 完整(复用 preflightDependencies)
 *   - executor_smoke: skill + executor 组合能跑通,拿到非空响应
 *   - samples_contract: 仅在传 samples 时跑,warn 级,校验 samples 非空 + 含 prompt
 *
 * fatal-fail 时 rule 引擎不中断后续 rule 执行(让用户一次看到全貌),
 * 但 DoctorReport.failed 会置 true。
 *
 * 扩展接口预留: registerRule() 允许业务方注入自定义 rule(v0.22 不暴露 CLI flag,
 * 仅作为 library API 占位)。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { CliMessageKey } from '../cli/i18n-dict.js';
import { tCli } from '../cli/i18n.js';
import { preflightDependencies } from '../eval-core/dependency-checker.js';
import type { DependencyIssue } from '../eval-core/dependency-checker.js';
import { createExecutor } from '../executors/index.js';
import type {
  DoctorRule,
  DoctorContext,
  DoctorRuleCheckOutcome,
} from '../types/doctor.js';
import { runExecutorSmoke } from './smoke.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface YamlErrorLike {
  mark?: { line: number };
  reason?: string;
  message?: string;
}

/** 用 js-yaml 真正解析 front-matter。能抓 unterminated string、非法缩进、
 *  duplicate key 等手写 pattern check 漏掉的 case。 */
function checkFrontmatter(content: string): { ok: boolean; error?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { ok: true };
  try {
    yaml.load(match[1]);
    return { ok: true };
  } catch (err: unknown) {
    const e = (typeof err === 'object' && err !== null ? err : {}) as YamlErrorLike;
    const lineSuffix = e.mark ? ` at line ${e.mark.line + 1}` : '';
    return { ok: false, error: `${e.reason || e.message || 'YAML parse error'}${lineSuffix}` };
  }
}

function summarizeDependencyIssues(missing: DependencyIssue[], lang: 'zh' | 'en'): string {
  const counts = { tool: 0, file: 0, env: 0 };
  for (const m of missing) counts[m.category] += 1;
  const parts: string[] = [];
  const labels = lang === 'zh'
    ? { tool: '工具', file: '文件', env: '环境变量' }
    : { tool: 'tool', file: 'file', env: 'env' };
  if (counts.tool > 0) parts.push(`${counts.tool} ${labels.tool}`);
  if (counts.file > 0) parts.push(`${counts.file} ${labels.file}`);
  if (counts.env > 0) parts.push(`${counts.env} ${labels.env}`);
  return parts.join(', ') || (lang === 'zh' ? '未知' : 'unknown');
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const SKILL_MIN_LENGTH = 10;

export const skillReadableRule: DoctorRule = {
  id: 'skill_readable',
  severity: 'fatal',
  labelKey: 'cli.doctor.rule.skill_readable',
  async check(ctx: DoctorContext): Promise<DoctorRuleCheckOutcome> {
    const content = ctx.artifact.content;
    if (content === null || content === undefined) {
      return {
        status: 'fail',
        message: tCli('cli.doctor.skill_readable.fail.missing', ctx.lang),
        hint: tCli('cli.doctor.skill_readable.hint.missing', ctx.lang),
        detail: { length: 0 },
      };
    }
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return {
        status: 'fail',
        message: tCli('cli.doctor.skill_readable.fail.empty', ctx.lang),
        hint: tCli('cli.doctor.skill_readable.hint.missing', ctx.lang),
        detail: { length: 0 },
      };
    }
    if (trimmed.length < SKILL_MIN_LENGTH) {
      return {
        status: 'fail',
        message: tCli('cli.doctor.skill_readable.fail.too_short', ctx.lang, { length: trimmed.length }),
        hint: tCli('cli.doctor.skill_readable.hint.too_short', ctx.lang),
        detail: { length: trimmed.length, minimum: SKILL_MIN_LENGTH },
      };
    }
    return {
      status: 'pass',
      message: tCli('cli.doctor.skill_readable.pass', ctx.lang, { length: trimmed.length }),
      detail: { length: trimmed.length },
    };
  },
};

export const skillMetadataRule: DoctorRule = {
  id: 'skill_metadata',
  severity: 'fatal',
  labelKey: 'cli.doctor.rule.skill_metadata',
  async check(ctx: DoctorContext): Promise<DoctorRuleCheckOutcome> {
    // directory-skill 必须有 SKILL.md
    if (ctx.artifact.skillRoot) {
      const skillMdPath = join(ctx.artifact.skillRoot, 'SKILL.md');
      if (!existsSync(skillMdPath)) {
        return {
          status: 'fail',
          message: tCli('cli.doctor.skill_metadata.fail.missing_skillmd', ctx.lang),
          hint: tCli('cli.doctor.skill_metadata.hint.missing_skillmd', ctx.lang),
          detail: { skillRoot: ctx.artifact.skillRoot, expectedPath: skillMdPath },
        };
      }
    }
    // front-matter 若存在则要合法(走 js-yaml 真解析)。不存在 = pure markdown skill,合法。
    const content = ctx.artifact.content ?? '';
    const fmCheck = checkFrontmatter(content);
    if (!fmCheck.ok) {
      return {
        status: 'fail',
        message: tCli('cli.doctor.skill_metadata.fail.frontmatter_invalid', ctx.lang, { error: fmCheck.error ?? '' }),
        hint: tCli('cli.doctor.skill_metadata.hint.frontmatter', ctx.lang),
        detail: { error: fmCheck.error },
      };
    }
    return {
      status: 'pass',
      message: tCli('cli.doctor.skill_metadata.pass', ctx.lang),
    };
  },
};

export const dependenciesPresentRule: DoctorRule = {
  id: 'dependencies_present',
  severity: 'fatal',
  labelKey: 'cli.doctor.rule.dependencies',
  async check(ctx: DoctorContext): Promise<DoctorRuleCheckOutcome> {
    const content = ctx.artifact.content ?? '';
    const result = await preflightDependencies(
      [content],
      ctx.samples ?? [],
      ctx.dependencyCwd ?? ctx.cwd, // 与 evaluation preflight 同规则; 见 DoctorContext.dependencyCwd
      ctx.requires,                  // samples wrapper 显式 requires
      [ctx.artifact],
    );
    if (!result.ok) {
      const summary = summarizeDependencyIssues(result.missing, ctx.lang);
      return {
        status: 'fail',
        message: tCli('cli.doctor.dependencies.fail', ctx.lang, { summary }),
        hint: tCli('cli.doctor.dependencies.hint', ctx.lang),
        detail: { missing: result.missing },
      };
    }
    return {
      status: 'pass',
      message: tCli('cli.doctor.dependencies.pass', ctx.lang),
    };
  },
};

export const executorSmokeRule: DoctorRule = {
  id: 'executor_smoke',
  severity: 'fatal',
  labelKey: 'cli.doctor.rule.executor_smoke',
  async check(ctx: DoctorContext): Promise<DoctorRuleCheckOutcome> {
    const executor = createExecutor(ctx.executorName);
    const result = await runExecutorSmoke(ctx.artifact, executor, ctx.model, ctx.cwd, ctx.timeoutMs);
    if (!result.ok) {
      const failureKind = result.failureKind ?? 'error';
      const error = (result.error ?? '').slice(0, 120);
      let messageKey: CliMessageKey;
      let hintKey: CliMessageKey;
      const params: Record<string, string | number> = { error, timeout: ctx.timeoutMs, executor: ctx.executorName };

      if (failureKind === 'timeout') {
        messageKey = 'cli.doctor.executor_smoke.fail.timeout';
        hintKey = 'cli.doctor.executor_smoke.hint.timeout';
      } else if (failureKind === 'auth') {
        messageKey = 'cli.doctor.executor_smoke.fail.auth';
        hintKey = 'cli.doctor.executor_smoke.hint.auth';
      } else if (failureKind === 'empty') {
        messageKey = 'cli.doctor.executor_smoke.fail.empty';
        hintKey = 'cli.doctor.executor_smoke.hint.empty';
      } else {
        messageKey = 'cli.doctor.executor_smoke.fail.error';
        hintKey = 'cli.doctor.executor_smoke.hint.generic';
      }

      return {
        status: 'fail',
        message: tCli(messageKey, ctx.lang, params),
        hint: tCli(hintKey, ctx.lang, params),
        detail: { failureKind, durationMs: result.durationMs, error: result.error },
      };
    }
    return {
      status: 'pass',
      message: tCli('cli.doctor.executor_smoke.pass', ctx.lang, { duration: result.durationMs }),
      detail: {
        durationMs: result.durationMs,
        outputPreview: (result.output ?? '').slice(0, 100),
      },
    };
  },
};

export const samplesContractAlignedRule: DoctorRule = {
  id: 'samples_contract_aligned',
  severity: 'warn',
  labelKey: 'cli.doctor.rule.samples_contract',
  async check(ctx: DoctorContext): Promise<DoctorRuleCheckOutcome> {
    if (!ctx.samples) {
      return {
        status: 'skipped',
        message: tCli('cli.doctor.samples_contract.skipped', ctx.lang),
      };
    }
    if (ctx.samples.length === 0) {
      return {
        status: 'warn',
        message: tCli('cli.doctor.samples_contract.warn.empty', ctx.lang),
        hint: tCli('cli.doctor.samples_contract.hint', ctx.lang),
        detail: { count: 0 },
      };
    }
    const missing = ctx.samples.filter((s) => !s.prompt || s.prompt.trim().length === 0);
    if (missing.length > 0) {
      return {
        status: 'warn',
        message: tCli('cli.doctor.samples_contract.warn.missing_prompt', ctx.lang, { count: missing.length }),
        hint: tCli('cli.doctor.samples_contract.hint', ctx.lang),
        detail: { missingCount: missing.length, totalCount: ctx.samples.length },
      };
    }
    return {
      status: 'pass',
      message: tCli('cli.doctor.samples_contract.pass', ctx.lang, { count: ctx.samples.length }),
      detail: { count: ctx.samples.length },
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** v0.22 内置规则注册表。执行顺序即此处定义顺序。 */
export const BUILTIN_RULES: DoctorRule[] = [
  skillReadableRule,
  skillMetadataRule,
  dependenciesPresentRule,
  executorSmokeRule,
  samplesContractAlignedRule,
];

/** 扩展 hook(v0.22 不通过 CLI flag 暴露,仅 library API 占位)。 */
const customRules: DoctorRule[] = [];

export function registerRule(rule: DoctorRule): void {
  if (BUILTIN_RULES.some((r) => r.id === rule.id) || customRules.some((r) => r.id === rule.id)) {
    throw new Error(`doctor rule id collision: ${rule.id}`);
  }
  customRules.push(rule);
}

export function getRegisteredRules(): DoctorRule[] {
  return [...BUILTIN_RULES, ...customRules];
}

export function __resetCustomRulesForTest(): void {
  customRules.length = 0;
}
