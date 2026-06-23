/**
 * omk doctor 内置规则注册表。
 *
 * BUILTIN_RULES 是**纯静态/低成本检查**, 不碰 LLM 连通性 — executor / judge
 * 连通性由 evaluation preflight 负责。用户入口 `omk doctor` 只跑 skill_health
 * composer 做 LLM 审计;这里的静态规则不从 CLI 暴露,仅作 eval 的评测前置门禁
 * (run-evaluation.ts 经 runDoctor 调,dependencies_present 守依赖完整性)。
 *
 * 每条 rule 回答一个独立的「skill 能不能被有意义评测」子问题:
 *   - skill_readable: 文件能读、内容非空且有最小长度
 *   - skill_metadata: front-matter(若有) YAML 合法、directory-skill 有 SKILL.md
 *   - dependencies: 引用的 tool / file / env / preflight 完整(复用 preflightDependencies)
 *   - samples_contract: 仅在传 samples 时跑,warn 级,校验 samples 非空 + 含 prompt
 *
 * fatal-fail 时 rule 引擎不中断后续 rule 执行(让用户一次看到全貌),
 * 但 DoctorReport.outcome 会置 'failed'。
 *
 * 扩展接口预留: registerRule() 允许业务方注入自定义 rule(v0.22 不暴露 CLI flag,
 * 仅作为 library API 占位)。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { tDoctorMessage } from './messages.js';
import type { Lang } from '../types/shared.js';
import { preflightDependencies } from '../eval-core/dependency-checker.js';
import { validateSkillHardRules, validateSkillWorkflows } from '../shared/hard-rules.js';
import type { DependencyIssue } from '../eval-core/dependency-checker.js';
import type {
  DoctorRule,
  DoctorRuleLike,
  DoctorContext,
  DoctorRuleCheckOutcome,
} from '../types/doctor.js';

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

function summarizeDependencyIssues(missing: DependencyIssue[], lang: Lang): string {
  const counts = { tool: 0, file: 0, env: 0, preflight: 0 };
  for (const m of missing) counts[m.category] += 1;
  const parts: string[] = [];
  const labels = lang === 'zh'
    ? { tool: '工具', file: '文件', env: '环境变量', preflight: 'preflight' }
    : { tool: 'tool', file: 'file', env: 'env', preflight: 'preflight' };
  if (counts.tool > 0) parts.push(`${counts.tool} ${labels.tool}`);
  if (counts.file > 0) parts.push(`${counts.file} ${labels.file}`);
  if (counts.env > 0) parts.push(`${counts.env} ${labels.env}`);
  if (counts.preflight > 0) parts.push(`${counts.preflight} ${labels.preflight}`);
  return parts.join(', ') || (lang === 'zh' ? '未知' : 'unknown');
}

function renderIssue(issue: DependencyIssue, lang: Lang): string {
  const params: Record<string, string | number> = { name: issue.name };
  if (issue.reasonDetail) params.detail = issue.reasonDetail;
  switch (issue.reasonCode) {
    case 'tool_not_found':
      return tDoctorMessage('cli.doctor.dependencies.issue.tool_not_found', lang, params);
    case 'file_not_found':
      return tDoctorMessage('cli.doctor.dependencies.issue.file_not_found', lang, params);
    case 'env_not_set':
      return tDoctorMessage('cli.doctor.dependencies.issue.env_not_set', lang, params);
    case 'preflight_failed':
      return tDoctorMessage('cli.doctor.dependencies.issue.preflight_failed', lang, params);
  }
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
    // Echo the path that was tried, so the hint is concretely actionable
    // (CI / agent and humans both see exactly where to look).
    const triedPath = ctx.artifact.locator
      ?? ctx.artifact.skillRoot
      ?? `<inline:${ctx.artifact.name}>`;
    if (content === null || content === undefined) {
      return {
        status: 'fail',
        message: tDoctorMessage('cli.doctor.skill_readable.fail.missing', ctx.lang),
        hint: tDoctorMessage('cli.doctor.skill_readable.hint.missing', ctx.lang, { path: triedPath }),
        detail: { length: 0, triedPath },
      };
    }
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return {
        status: 'fail',
        message: tDoctorMessage('cli.doctor.skill_readable.fail.empty', ctx.lang),
        hint: tDoctorMessage('cli.doctor.skill_readable.hint.missing', ctx.lang, { path: triedPath }),
        detail: { length: 0, triedPath },
      };
    }
    if (trimmed.length < SKILL_MIN_LENGTH) {
      return {
        status: 'fail',
        message: tDoctorMessage('cli.doctor.skill_readable.fail.too_short', ctx.lang, { length: trimmed.length }),
        hint: tDoctorMessage('cli.doctor.skill_readable.hint.too_short', ctx.lang),
        detail: { length: trimmed.length, minimum: SKILL_MIN_LENGTH },
      };
    }
    return {
      status: 'pass',
      message: tDoctorMessage('cli.doctor.skill_readable.pass', ctx.lang, { length: trimmed.length }),
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
          message: tDoctorMessage('cli.doctor.skill_metadata.fail.missing_skillmd', ctx.lang),
          hint: tDoctorMessage('cli.doctor.skill_metadata.hint.missing_skillmd', ctx.lang),
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
        message: tDoctorMessage('cli.doctor.skill_metadata.fail.frontmatter_invalid', ctx.lang, { error: fmCheck.error ?? '' }),
        hint: tDoctorMessage('cli.doctor.skill_metadata.hint.frontmatter', ctx.lang),
        detail: { error: fmCheck.error },
      };
    }
    const hardRulesCheck = validateSkillHardRules(content);
    if (!hardRulesCheck.ok) {
      return {
        status: 'fail',
        message: tDoctorMessage('cli.doctor.skill_metadata.fail.hardrules_invalid', ctx.lang, { error: hardRulesCheck.errors.join('; ') }),
        hint: tDoctorMessage('cli.doctor.skill_metadata.hint.hardrules', ctx.lang),
        detail: {
          errors: hardRulesCheck.errors,
          declared: hardRulesCheck.declared,
        },
      };
    }
    const workflowsCheck = validateSkillWorkflows(content);
    if (!workflowsCheck.ok) {
      return {
        status: 'fail',
        message: tDoctorMessage('cli.doctor.skill_metadata.fail.workflows_invalid', ctx.lang, { error: workflowsCheck.errors.join('; ') }),
        hint: tDoctorMessage('cli.doctor.skill_metadata.hint.workflows', ctx.lang),
        detail: {
          errors: workflowsCheck.errors,
          declared: workflowsCheck.declared,
        },
      };
    }
    return {
      status: 'pass',
      message: tDoctorMessage('cli.doctor.skill_metadata.pass', ctx.lang),
      detail: {
        hardRulesDeclared: hardRulesCheck.declared,
        hardRulesCount: hardRulesCheck.rules.length,
        workflowsDeclared: workflowsCheck.declared,
        workflowsCount: workflowsCheck.workflows.length,
        workflowNodeCount: workflowsCheck.workflows.reduce((sum, workflow) => sum + workflow.nodes.length, 0),
      },
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
      // Hint composition: per-issue translated reason (carries the specific stderr /
      // path / cmd via reasonDetail) + per-category fix advice. The per-issue line
      // is what tells the user *what* failed; the category advice tells them *how*
      // to fix the class of failure.
      const hintParts: string[] = [];
      for (const m of result.missing) hintParts.push(renderIssue(m, ctx.lang));
      const counts = { tool: 0, file: 0, env: 0, preflight: 0 };
      for (const m of result.missing) counts[m.category] += 1;
      if (counts.tool > 0) hintParts.push(tDoctorMessage('cli.doctor.dependencies.hint.tool', ctx.lang));
      if (counts.file > 0) hintParts.push(tDoctorMessage('cli.doctor.dependencies.hint.file', ctx.lang));
      if (counts.env > 0) hintParts.push(tDoctorMessage('cli.doctor.dependencies.hint.env', ctx.lang));
      if (counts.preflight > 0) hintParts.push(tDoctorMessage('cli.doctor.dependencies.hint.preflight', ctx.lang));
      return {
        status: 'fail',
        message: tDoctorMessage('cli.doctor.dependencies.fail', ctx.lang, { summary }),
        hint: hintParts.join('; '),
        detail: { missing: result.missing },
      };
    }
    return {
      status: 'pass',
      message: tDoctorMessage('cli.doctor.dependencies.pass', ctx.lang),
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
        message: tDoctorMessage('cli.doctor.samples_contract.skipped', ctx.lang),
      };
    }
    if (ctx.samples.length === 0) {
      return {
        status: 'warn',
        message: tDoctorMessage('cli.doctor.samples_contract.warn.empty', ctx.lang),
        hint: tDoctorMessage('cli.doctor.samples_contract.hint', ctx.lang),
        detail: { count: 0 },
      };
    }
    const missing = ctx.samples.filter((s) => !s.prompt || s.prompt.trim().length === 0);
    if (missing.length > 0) {
      return {
        status: 'warn',
        message: tDoctorMessage('cli.doctor.samples_contract.warn.missing_prompt', ctx.lang, { count: missing.length }),
        hint: tDoctorMessage('cli.doctor.samples_contract.hint', ctx.lang),
        detail: { missingCount: missing.length, totalCount: ctx.samples.length },
      };
    }
    return {
      status: 'pass',
      message: tDoctorMessage('cli.doctor.samples_contract.pass', ctx.lang, { count: ctx.samples.length }),
      detail: { count: ctx.samples.length },
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** v0.22 内置规则注册表。执行顺序即此处定义顺序。
 *  doctor 不包含 executor 连通性检查 — 该职责属于 evaluation preflight。 */
export const BUILTIN_RULES: DoctorRule[] = [
  skillReadableRule,
  skillMetadataRule,
  dependenciesPresentRule,
  samplesContractAlignedRule,
];

/** 扩展 hook。可注册普通 DoctorRule 或 ComposerRule(健康度体检走 composer)。 */
const customRules: DoctorRuleLike[] = [];

export function registerRule(rule: DoctorRuleLike): void {
  if (BUILTIN_RULES.some((r) => r.id === rule.id) || customRules.some((r) => r.id === rule.id)) {
    throw new Error(`doctor rule id collision: ${rule.id}`);
  }
  customRules.push(rule);
}

export function getRegisteredRules(): DoctorRuleLike[] {
  return [...BUILTIN_RULES, ...customRules];
}

export function __resetCustomRulesForTest(): void {
  customRules.length = 0;
}
