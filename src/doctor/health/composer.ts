/**
 * skill_health composer rule — 健康度体检的"复合 rule"。
 *
 * 单次 LLM 调用产出全部已注册维度的 checklist;composer.checkAll() 返回 N+1 条
 * outcome:N = 注册维度数(每维一条),1 = summary(top_suggestions / overall_health
 * / feature_points 落在这条)。
 *
 * doctor engine 检测 kind='composer' 时把 outcome[] 展开成 N+1 条独立 DoctorRuleResult,
 * 共享 groupId = composer.id,renderer 按 groupId 分组渲染。
 *
 * 工厂模式 makeSkillHealthComposer(execFactory) 给测试注入 mock executor。
 * 默认 import 时不注册;register.ts 才做 registerRule 副作用。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tCli } from '../../cli/i18n.js';
import { createExecutor } from '../../executors/index.js';
import type { ExecutorFn } from '../../types/executor.js';
import type {
  ComposerOutcome,
  ComposerRule,
  DoctorContext,
  DoctorRuleStatus,
} from '../../types/doctor.js';
import type {
  HealthDimensionLevel,
  HealthDimensionResult,
  HealthDimensionSpec,
} from './dimension-spec.js';
import { getRegisteredHealthDimensions } from './dimension-registry.js';
import { buildHealthPrompt } from './prompt-builder.js';
import { deriveOverallHealth, extractJson, parseHealthOutput } from './parser.js';

export const SKILL_HEALTH_COMPOSER_ID = 'skill_health';

export type ExecutorFactory = (name: string) => ExecutorFn;
const defaultExecutorFactory: ExecutorFactory = createExecutor;

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function mapDimLevelToStatus(level: HealthDimensionLevel, missing?: boolean): DoctorRuleStatus {
  if (missing) return 'skipped';
  switch (level) {
    case '不健康': return 'fail';
    case '亚健康': return 'warn';
    case '健康':   return 'pass';
    case '不适用': return 'skipped';
  }
}

// ---------------------------------------------------------------------------
// Per-dim outcome rendering
// ---------------------------------------------------------------------------

function dimMessage(dim: HealthDimensionSpec, r: HealthDimensionResult, lang: 'zh' | 'en'): string {
  if (r._missing) {
    return tCli('cli.doctor.health.dim.missing', lang, { dim: dim.displayName });
  }
  const errs = r.findings.filter((f) => f.level === '错误').length;
  const warns = r.findings.filter((f) => f.level === '警告').length;
  const sugs = r.findings.filter((f) => f.level === '建议').length;
  return tCli('cli.doctor.health.dim.message', lang, {
    level: r.level, err: errs, warn: warns, sug: sugs,
  });
}

function dimHint(r: HealthDimensionResult): string | undefined {
  if (r.suggestions.length === 0) return undefined;
  return r.suggestions[0];
}

// ---------------------------------------------------------------------------
// Sub-files / siblings discovery (与上一版本相同)
// ---------------------------------------------------------------------------

function listSubFiles(skillRoot: string | null): string[] {
  if (!skillRoot || !existsSync(skillRoot)) return [];
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 2) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      if (entry === 'SKILL.md' && rel === '') continue;
      if (entry === 'node_modules') continue;
      const full = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, relPath, depth + 1);
      else if (st.isFile()) out.push(relPath);
    }
  };
  walk(skillRoot, '', 0);
  return out.sort();
}

function listSiblingSkills(skillRoot: string | null): string[] {
  if (!skillRoot || !existsSync(skillRoot)) return [];
  const parent = dirname(skillRoot);
  if (!existsSync(parent)) return [];
  const self = skillRoot.split('/').pop() ?? '';
  let entries: string[] = [];
  try { entries = readdirSync(parent); } catch { return []; }
  return entries
    .filter((e) => !e.startsWith('.') && e !== self)
    .filter((e) => {
      try { return statSync(join(parent, e)).isDirectory(); } catch { return false; }
    })
    .sort();
}

// ---------------------------------------------------------------------------
// Composer factory
// ---------------------------------------------------------------------------

export function makeSkillHealthComposer(
  execFactory: ExecutorFactory = defaultExecutorFactory,
): ComposerRule {
  return {
    id: SKILL_HEALTH_COMPOSER_ID,
    kind: 'composer',
    severity: 'fatal',
    labelKey: 'cli.doctor.rule.skill_health_check',
    checkAll: (ctx) => composerCheckAll(ctx, execFactory),
  };
}

async function composerCheckAll(
  ctx: DoctorContext,
  execFactory: ExecutorFactory,
): Promise<ComposerOutcome[]> {
  const dims = getRegisteredHealthDimensions();

  // Programmatic opt-out: runHealthCheck=false → 给 summary 一条 skipped,
  // 各维度不展开避免污染报告。CLI 的 --static-only 会直接过滤掉 composer rule。
  if (!ctx.runHealthCheck) {
    return [{
      subId: '_summary',
      severity: 'info',
      labelKey: 'cli.doctor.rule.skill_health_check',
      status: 'skipped',
      message: tCli('cli.doctor.health.skipped', ctx.lang),
    }];
  }

  // 没注册任何维度 → 短路
  if (dims.length === 0) {
    return [{
      subId: '_summary',
      severity: 'info',
      labelKey: 'cli.doctor.rule.skill_health_check',
      status: 'skipped',
      message: tCli('cli.doctor.health.no_dimensions', ctx.lang),
    }];
  }

  const content = ctx.artifact.content;
  if (!content || content.trim().length === 0) {
    // skill_readable rule 也会 fail;这里只是 short-circuit 防止白白调 LLM
    return [{
      subId: '_summary',
      severity: 'info',
      labelKey: 'cli.doctor.rule.skill_health_check',
      status: 'skipped',
      message: tCli('cli.doctor.health.skipped', ctx.lang),
    }];
  }

  const skillName = ctx.artifact.name.replace(/\.md$/, '').split('/').pop() ?? ctx.artifact.name;
  const skillRoot = ctx.artifact.skillRoot ?? null;
  const subFiles = listSubFiles(skillRoot);
  const siblingSkills = listSiblingSkills(skillRoot);

  const prompt = buildHealthPrompt(
    { skillName, skillContent: content, skillRoot, subFiles, siblingSkills },
    dims,
  );

  const executor = execFactory(ctx.executorName);
  let res;
  try {
    res = await executor({
      model: ctx.model,
      prompt,
      cwd: skillRoot ?? ctx.cwd,
      skillDir: skillRoot ?? null,
      timeoutMs: ctx.timeoutMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [errorSummaryOutcome(ctx, 'executor', msg)];
  }

  if (!res.ok) {
    return [errorSummaryOutcome(ctx, 'executor', res.error ?? 'unknown')];
  }
  if (!res.output || res.output.trim().length === 0) {
    return [errorSummaryOutcome(ctx, 'empty_output', '')];
  }
  const cleaned = extractJson(res.output);
  if (cleaned === null) {
    return [errorSummaryOutcome(ctx, 'extract', '', { rawOutput: res.output.slice(0, 4000) })];
  }

  const parseResult = parseHealthOutput(cleaned, dims);
  const overall = parseResult.overall ?? deriveOverallHealth(parseResult.byDimId);
  // 诊断:如果所有维度都被标 _missing,说明 LLM 输出 JSON 里 dim_id 字段缺失或写错。
  // 把 cleaned JSON 的前 3KB 塞进 summary 的 detail.rawSample,方便用户排查。
  const allMissing = [...parseResult.byDimId.values()].every((r) => r._missing);
  const rawSample = allMissing ? cleaned.slice(0, 3000) : undefined;

  // 汇总 finding 计数(框架算,不信 LLM 算术)
  const finding = { '错误': 0, '警告': 0, '建议': 0 };
  const dimCount = { '健康': 0, '亚健康': 0, '不健康': 0, '不适用': 0 };
  for (const r of parseResult.byDimId.values()) {
    if (r._missing) continue;
    dimCount[r.level] += 1;
    for (const f of r.findings) finding[f.level] += 1;
  }

  // N 条维度 outcome
  const dimOutcomes: ComposerOutcome[] = dims.map((dim) => {
    const r = parseResult.byDimId.get(dim.id)!;
    return {
      subId: dim.id,
      labelKey: dim.labelKey,
      severity: dim.severity,
      status: mapDimLevelToStatus(r.level, r._missing),
      message: dimMessage(dim, r, ctx.lang),
      hint: dimHint(r),
      detail: {
        dimensionId: dim.id,
        displayName: dim.displayName,
        level: r.level,
        findings: r.findings,
        suggestions: r.suggestions,
        missing: r._missing ?? false,
      },
    };
  });

  // 1 条 summary outcome
  const summaryOutcome: ComposerOutcome = {
    subId: '_summary',
    severity: 'info',
    labelKey: 'cli.doctor.health.summary.label',
    status: 'pass', // summary 永远 pass(信息性,不影响 outcome)
    message: tCli('cli.doctor.health.summary.message', ctx.lang, {
      overall,
      h: dimCount['健康'], sh: dimCount['亚健康'], bad: dimCount['不健康'], na: dimCount['不适用'],
      err: finding['错误'], warn: finding['警告'], sug: finding['建议'],
    }),
    hint: parseResult.topSuggestions.slice(0, 3).join(' | ')
      || tCli('cli.doctor.health.summary.no_top', ctx.lang),
    detail: {
      overall,
      dimensionLevelCount: dimCount,
      findingCountByLevel: finding,
      topSuggestions: parseResult.topSuggestions,
      featurePoints: parseResult.featurePoints,
      durationMs: res.durationMs,
      durationApiMs: res.durationApiMs,
      // turns:claude-cli 在内部跑的 LLM 轮次(每轮 = 1 次 messages.create)
      // numTurns:assistant turn 数 / fullNumTurns:含 tool turn 的总数
      llmTurns: { numTurns: res.numTurns, fullNumTurns: res.fullNumTurns },
      tokens: {
        input: res.inputTokens, output: res.outputTokens,
        cacheRead: res.cacheReadTokens, cacheCreation: res.cacheCreationTokens,
      },
      costUSD: res.costUSD,
      executor: { name: ctx.executorName, model: ctx.model },
      ...(rawSample !== undefined ? { rawSample, _diagnostic: 'all dims missing — likely dim_id field absent in LLM output' } : {}),
    },
  };

  return [...dimOutcomes, summaryOutcome];
}

function errorSummaryOutcome(
  ctx: DoctorContext,
  phase: 'executor' | 'empty_output' | 'extract',
  errMsg: string,
  extra: Record<string, unknown> = {},
): ComposerOutcome {
  const messageKey = phase === 'executor'
    ? 'cli.doctor.health.fail.executor'
    : phase === 'empty_output'
      ? 'cli.doctor.health.fail.empty_output'
      : 'cli.doctor.health.fail.parse';
  const hintKey = phase === 'executor'
    ? 'cli.doctor.health.hint.executor'
    : 'cli.doctor.health.hint.parse';
  return {
    subId: '_summary',
    severity: 'fatal',
    labelKey: 'cli.doctor.health.summary.label',
    status: 'fail',
    message: tCli(messageKey, ctx.lang, { error: errMsg.slice(0, 200) }),
    hint: tCli(hintKey, ctx.lang),
    detail: { phase, error: errMsg, ...extra },
  };
}
