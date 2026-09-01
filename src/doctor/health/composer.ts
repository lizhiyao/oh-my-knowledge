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
import { tDoctorMessage } from '../messages.js';
import type { Lang } from '../../types/shared.js';
import { createExecutor } from '../../executors/index.js';
import type { ExecResult, ExecutorFn } from '../../types/executor.js';
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
import { deriveOverallHealth, extractJson, parseHealthOutput, type HealthParseResult } from './parser.js';
import {
  enumerateFindingsForMerge,
  mergeHealthSamples,
  mergeHealthSamplesLlm,
  parseMergeClusters,
} from './consensus.js';
import { buildHealthMergePrompt } from '../../shared/llm-prompts/skill-health-merge.js';

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

function dimMessage(dim: HealthDimensionSpec, r: HealthDimensionResult, lang: Lang): string {
  if (r._missing) {
    return tDoctorMessage('cli.doctor.health.dim.missing', lang, { dim: dim.displayName });
  }
  const errs = r.findings.filter((f) => f.level === '错误').length;
  const warns = r.findings.filter((f) => f.level === '警告').length;
  const sugs = r.findings.filter((f) => f.level === '建议').length;
  return tDoctorMessage('cli.doctor.health.dim.message', lang, {
    level: r.level, err: errs, warn: warns, sug: sugs,
  });
}

function dimHint(r: HealthDimensionResult): string | undefined {
  // 优先从 finding-level suggestion 取（新契约），fallback 到维度级 suggestions（旧契约兼容）
  const fromFinding = r.findings.find((f) => f.suggestion)?.suggestion;
  if (fromFinding) return fromFinding;
  if (r.suggestions.length > 0) return r.suggestions[0];
  return undefined;
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
// 有界并发 map
// ---------------------------------------------------------------------------

/** 最多 limit 个任务并发,返回与 items 同序的结果(worker-pool,对齐评测执行口径)。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 1, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Composer factory
// ---------------------------------------------------------------------------

export function makeSkillHealthComposer(
  execFactory: ExecutorFactory = defaultExecutorFactory,
): ComposerRule {
  return {
    id: SKILL_HEALTH_COMPOSER_ID,
    ruleKind: 'composer',
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
  // 各维度不展开避免污染报告。eval preflight 走这条(只跑静态 rule,不触发 LLM)。
  if (!ctx.runHealthCheck) {
    return [{
      subId: '_summary',
      severity: 'info',
      labelKey: 'cli.doctor.rule.skill_health_check',
      status: 'skipped',
      message: tDoctorMessage('cli.doctor.health.skipped', ctx.lang),
    }];
  }

  // 没注册任何维度 → 短路
  if (dims.length === 0) {
    return [{
      subId: '_summary',
      severity: 'info',
      labelKey: 'cli.doctor.rule.skill_health_check',
      status: 'skipped',
      message: tDoctorMessage('cli.doctor.health.no_dimensions', ctx.lang),
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
      message: tDoctorMessage('cli.doctor.health.skipped', ctx.lang),
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
  // 采样次数(self-consistency):默认 1;非有限值(NaN/Infinity)兜底 1;上限 10 防 fat-finger
  // / 资源耗尽(并发默认=采样数,会一起放大)。
  const MAX_HEALTH_SAMPLES = 10;
  const rawSamples = ctx.healthSamples;
  const requested = Math.min(
    MAX_HEALTH_SAMPLES,
    Math.max(1, Math.floor(Number.isFinite(rawSamples) ? (rawSamples as number) : 1)),
  );

  // 跨采样累计的执行指标(token / cost / 时长 / 轮次都求和,反映真实总开销)。
  const agg = {
    durationMs: 0, durationApiMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUSD: 0, numTurns: 0, fullNumTurns: 0,
  };
  const accumulate = (r: ExecResult): void => {
    agg.durationMs += r.durationMs ?? 0;
    agg.durationApiMs += r.durationApiMs ?? 0;
    agg.inputTokens += r.inputTokens ?? 0;
    agg.outputTokens += r.outputTokens ?? 0;
    agg.cacheReadTokens += r.cacheReadTokens ?? 0;
    agg.cacheCreationTokens += r.cacheCreationTokens ?? 0;
    agg.costUSD += r.costUSD ?? 0;
    agg.numTurns += r.numTurns ?? 0;
    agg.fullNumTurns += r.fullNumTurns ?? 0;
  };

  // 采样并发:默认全并行(并发=采样数,样本间相互独立),`--concurrency 1` 退回串行。
  // 非有限值兜底为 requested。
  const rawConc = ctx.healthConcurrency;
  const concurrency = Math.max(1, Math.min(requested,
    Math.floor(Number.isFinite(rawConc) ? (rawConc as number) : requested)));

  type SampleError = { phase: 'executor' | 'empty_output' | 'extract'; msg: string; extra?: Record<string, unknown> };
  interface SampleResult { res?: ExecResult; parsed?: HealthParseResult; error?: SampleError }
  const runSample = async (): Promise<SampleResult> => {
    let res: ExecResult;
    try {
      res = await executor({
        model: ctx.model,
        prompt,
        cwd: skillRoot ?? ctx.cwd,
        skillDir: skillRoot ?? null,
        timeoutMs: ctx.timeoutMs,
        effort: ctx.effort ?? 'low',
        lean: true,
      });
    } catch (err) {
      return { error: { phase: 'executor', msg: err instanceof Error ? err.message : String(err) } };
    }
    if (!res.ok) return { res, error: { phase: 'executor', msg: res.error ?? 'unknown' } };
    if (!res.output || res.output.trim().length === 0) return { res, error: { phase: 'empty_output', msg: '' } };
    const cleaned = extractJson(res.output);
    if (cleaned === null) return { res, error: { phase: 'extract', msg: '', extra: { rawOutput: res.output.slice(0, 4000) } } };
    const pr = parseHealthOutput(cleaned, dims);
    // 全维度 _missing → 该样本的 JSON 里 dim_id 缺失或写错,丢弃(不当作"全部通过")。
    if ([...pr.byDimId.values()].every((r) => r._missing)) {
      return { res, error: { phase: 'extract', msg: 'LLM output missing all dimension IDs', extra: { rawSample: cleaned.slice(0, 3000) } } };
    }
    return { res, parsed: pr };
  };

  // 跑 N 次(并发受 concurrency 限),收集成功解析的样本。单样本报错 / 空输出 / JSON 抽不出 /
  // 全维度漏报都跳过(记最后一次错误);只要 ≥1 成功就走并集合并,全失败才报 fail。
  const sampleResults = await mapWithConcurrency(
    Array.from({ length: requested }, (_, i) => i), concurrency, () => runSample(),
  );
  const parsed: HealthParseResult[] = [];
  let lastError: SampleError | null = null;
  for (const sr of sampleResults) {
    if (sr.res) accumulate(sr.res);
    if (sr.parsed) parsed.push(sr.parsed);
    else if (sr.error) lastError = sr.error;
  }

  if (parsed.length === 0) {
    return [errorSummaryOutcome(ctx, lastError?.phase ?? 'extract', lastError?.msg ?? '', lastError?.extra ?? {})];
  }

  // 归并:healthMerge='string' 走字符串键;='llm'(CLI 默认)且确有可并 finding 时,多跑一次
  // LLM 聚类(跨措辞同根因归并),失败回退 string。单样本时两者都等价于直通 + support={1,1}。
  const mergeStrategy = ctx.healthMerge ?? 'string';
  let merged: HealthParseResult | null = null;
  let mergeMode = 'string';
  if (mergeStrategy === 'llm' && parsed.length > 1) {
    const tagged = enumerateFindingsForMerge(parsed, dims);
    // 仅当某维度内 ≥2 条 finding 才值得跑 LLM 聚类(否则没东西可并,白花一次调用)。
    const mergeable = dims.some((d) => tagged.filter((t) => t.dimId === d.id).length >= 2);
    if (mergeable) {
      let mres: ExecResult | null = null;
      try {
        mres = await executor({
          model: ctx.model,
          prompt: buildHealthMergePrompt(dims, tagged),
          cwd: skillRoot ?? ctx.cwd,
          skillDir: skillRoot ?? null,
          timeoutMs: ctx.timeoutMs,
          effort: ctx.effort ?? 'low',
          lean: true,
        });
      } catch { mres = null; }
      if (mres) accumulate(mres);
      const cleaned = mres?.ok && mres.output ? extractJson(mres.output) : null;
      const clusters = cleaned ? parseMergeClusters(cleaned) : null;
      if (clusters) {
        merged = mergeHealthSamplesLlm(parsed, dims, tagged, clusters);
        mergeMode = 'llm';
      } else {
        mergeMode = 'string(llm-fallback)'; // LLM 合并失败 → 用字符串键兜底
      }
    }
  }
  if (!merged) merged = mergeHealthSamples(parsed, dims);
  const overall = merged.overall ?? deriveOverallHealth(merged.byDimId);
  const succeeded = parsed.length;

  // 汇总 finding 计数(框架算,不信 LLM 算术)
  const finding = { '错误': 0, '警告': 0, '建议': 0 };
  const dimCount = { '健康': 0, '亚健康': 0, '不健康': 0, '不适用': 0 };
  for (const r of merged.byDimId.values()) {
    if (r._missing) continue;
    dimCount[r.level] += 1;
    for (const f of r.findings) finding[f.level] += 1;
  }

  // N 条维度 outcome
  const dimOutcomes: ComposerOutcome[] = dims.map((dim) => {
    const r = merged.byDimId.get(dim.id)!;
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

  // summary message:多采样时(requested>1)追加采样次数说明,让终端看到"并集来自几次采样"。
  let summaryMessage = tDoctorMessage('cli.doctor.health.summary.message', ctx.lang, {
    overall,
    h: dimCount['健康'], sh: dimCount['亚健康'], bad: dimCount['不健康'], na: dimCount['不适用'],
    err: finding['错误'], warn: finding['警告'], sug: finding['建议'],
  });
  if (requested > 1) {
    summaryMessage += tDoctorMessage(
      succeeded < requested
        ? 'cli.doctor.health.summary.samples_degraded'
        : 'cli.doctor.health.summary.samples',
      ctx.lang,
      { requested, succeeded },
    );
  }
  const sampleDegraded = requested > 1 && succeeded < requested;

  // 1 条 summary outcome
  const summaryOutcome: ComposerOutcome = {
    subId: '_summary',
    severity: 'info',
    labelKey: 'cli.doctor.health.summary.label',
    status: sampleDegraded ? 'warn' : 'pass',
    message: summaryMessage,
    hint: merged.topSuggestions.slice(0, 3).join(' | ')
      || tDoctorMessage('cli.doctor.health.summary.no_top', ctx.lang),
    detail: {
      overall,
      // 采样次数:requested=请求几次,succeeded=成功解析几次。finding 的 support=k/n
      // 即"被评估的 n 次里有 k 次报了这条"。mergeMode=归并实现(string / llm / 回退)。
      samples: { requested, succeeded, concurrency, degraded: sampleDegraded },
      mergeMode,
      dimensionLevelCount: dimCount,
      findingCountByLevel: finding,
      topSuggestions: merged.topSuggestions,
      featurePoints: merged.featurePoints,
      durationMs: agg.durationMs,
      durationApiMs: agg.durationApiMs,
      // turns:claude-cli 在内部跑的 LLM 轮次(每轮 = 1 次 messages.create),多采样累加。
      // numTurns:assistant turn 数 / fullNumTurns:含 tool turn 的总数
      llmTurns: { numTurns: agg.numTurns, fullNumTurns: agg.fullNumTurns },
      tokens: {
        input: agg.inputTokens, output: agg.outputTokens,
        cacheRead: agg.cacheReadTokens, cacheCreation: agg.cacheCreationTokens,
      },
      costUSD: agg.costUSD,
      executor: { name: ctx.executorName, model: ctx.model },
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
    message: tDoctorMessage(messageKey, ctx.lang, { error: errMsg.slice(0, 200) }),
    hint: tDoctorMessage(hintKey, ctx.lang),
    detail: { phase, error: errMsg, ...extra },
  };
}
