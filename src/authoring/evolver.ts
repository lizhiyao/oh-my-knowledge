import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, basename } from 'node:path';
import { runEvaluation } from '../eval-workflows/run-evaluation.js';
import { createExecutor, DEFAULT_MODEL, JUDGE_MODEL } from '../executors/index.js';
import { persistReport, DEFAULT_OUTPUT_DIR, generateRunId } from '../eval-core/evaluation-reporting.js';
import { createFileStore } from '../server/report-store.js';
import { analyzeResults } from '../analysis/report-diagnostics.js';
import { loadSamples } from '../inputs/load-samples.js';
import { fixSamples } from './sample-fixer.js';
import type { JudgeConfig, ProgressCallback, Report, ResultEntry, Sample, VariantResult } from '../types/index.js';

const IMPROVE_SYSTEM_PROMPT = `你是一个 AI 提示词改进专家。你的任务是分析评测结果中的薄弱环节，针对性地改进 skill（系统提示词），使其在评测中获得更高的分数。

改进原则：
1. 针对低分用例暴露的具体问题做改进，不要泛泛修改
2. 保留当前版本中已经表现良好的部分
3. 保持 skill 的整体结构和格式
4. 改进应该具体、可执行，不要空泛的描述
5. 改动必须最小化：只修改或新增与低分用例直接相关的段落，不要重写未出问题的部分
6. 禁止重新组织整篇结构、格式或措辞；保留原文中未出问题的段落原封不动
7. 每轮改动行数不超过原文的 20%

直接输出改进后的 skill 内容，不要包含 markdown 代码块标记或任何解释说明。`;

const IMPROVE_AGENT_SYSTEM_PROMPT = `你是一个 AI 提示词改进专家。你的任务是分析评测结果中的薄弱环节，使用 Edit 工具针对性地修改 skill 文件。

改进原则：
1. 只修改与低分用例直接相关的段落，不要动已经表现良好的部分
2. 使用 Edit 工具做最小化修改，不要重写整篇文件
3. 每次 Edit 只改一处具体问题，可以多次 Edit
4. 不要重新组织文档结构、不要调整格式、不要修改措辞风格
5. 新增内容应紧跟在相关现有段落之后，不要大段插入
6. 改进应该具体、可执行，不要空泛的描述
7. 修改完成后不要输出文件全文，只说明改了什么`;

interface WeakSample {
  sample_id: string;
  compositeScore: number;
  llmReason: string | null;
  failedAssertions: string[];
  dimensions: Record<string, number> | null;
  diagnostic?: {
    summary?: string;
    expected?: string;
    actual?: string;
    rootCause?: string[];
    skillSuggestion?: string;
    sampleSuggestion?: string;
    none?: string;
  };
}

/**
 * Read the `name` field from a SKILL.md frontmatter.
 * Returns null if the file has no frontmatter or no name field.
 * Used to give evolve reports semantic filenames instead of "evolve-SKILL-xxx".
 */
function hashString(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 12);
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const entries = Object.keys(value as Record<string, unknown>).sort();
  return '{' + entries.map((k) => JSON.stringify(k) + ':' + canonicalStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

function hashSampleForReuse(sample: Sample): string {
  return hashString(canonicalStringify({
    prompt: sample.prompt,
    rubric: sample.rubric ?? null,
    dimensions: sample.dimensions ?? null,
    assertions: sample.assertions ?? null,
    schema: sample.schema ?? null,
  }));
}

function sameJudgeModels(report: Report, judges: JudgeConfig[]): boolean {
  const metaJudges = report.meta.judgeModels ?? [];
  if (metaJudges.length !== judges.length) return false;
  return metaJudges.every((j, i) => j.executor === judges[i].executor && j.model === judges[i].model);
}

function sampleHashesMatch(report: Report, samples: Sample[]): boolean {
  const hashes = report.meta.sampleHashes;
  if (!hashes) return false;
  return samples.every((s) => hashes[s.sample_id] === hashSampleForReuse(s));
}

function singleVariantReport(report: Report, variantKey: string): Report {
  const summary = report.summary[variantKey];
  return {
    ...report,
    meta: {
      ...report.meta,
      variants: [variantKey],
      artifactHashes: report.meta.artifactHashes?.[variantKey]
        ? { [variantKey]: report.meta.artifactHashes[variantKey] }
        : {},
      ...(report.meta.variantConfigs ? { variantConfigs: report.meta.variantConfigs.filter((cfg) => cfg.variant === variantKey) } : {}),
      ...(report.meta.skillIsolation ? { skillIsolation: { [variantKey]: report.meta.skillIsolation[variantKey] ?? null } } : {}),
    },
    summary: { [variantKey]: summary },
    results: report.results.map((entry) => ({
      sample_id: entry.sample_id,
      variants: entry.variants[variantKey] ? { [variantKey]: entry.variants[variantKey] } : {},
    })),
  };
}

async function findReusableBaselineReport(opts: {
  skillContent: string;
  samplesPath: string;
  model: string;
  executorName: string;
  judgeModels: JudgeConfig[];
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  noDiagnostic?: boolean;
}): Promise<Report | null> {
  const store = createFileStore(DEFAULT_OUTPUT_DIR);
  const { samples } = loadSamples(opts.samplesPath);
  const artifactHash = hashString(opts.skillContent);
  const reports = await store.findByArtifactHash(artifactHash);
  for (const report of reports) {
    if (report.meta.model !== opts.model || report.meta.executor !== opts.executorName) continue;
    if ((report.meta.effort ?? undefined) !== (opts.effort ?? undefined)) continue;
    if (report.meta.noJudge) continue;
    if (report.meta.budgetExhausted) continue;
    if (!sameJudgeModels(report, opts.judgeModels)) continue;
    if (!sampleHashesMatch(report, samples)) continue;

    const variantKey = report.meta.variants.find((name) => report.meta.artifactHashes?.[name] === artifactHash);
    if (!variantKey || !report.summary[variantKey]) continue;
    return singleVariantReport(report, variantKey);
  }
  return null;
}

function readSkillName(skillPath: string): string | null {
  try {
    const content = readFileSync(skillPath, 'utf-8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const nameMatch = match[1].match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m);
    return nameMatch ? nameMatch[1].trim() : null;
  } catch {
    return null;
  }
}

export function extractWeakSamples(report: Report, variantKey: string, count: number = 5): WeakSample[] {
  const weakSamples: WeakSample[] = [];
  for (const r of report.results) {
    const v = r.variants[variantKey];
    if (!v || typeof v.compositeScore !== 'number') continue;
    const suggestion = v.diagnostic?.suggestion;
    weakSamples.push({
      sample_id: r.sample_id,
      compositeScore: v.compositeScore,
      llmReason: v.llmReason || null,
      failedAssertions: v.assertions?.details?.filter((a) => !a.passed).map((a) => `${a.type}: ${a.value ?? ''}`) || [],
      dimensions: v.dimensions
        ? Object.fromEntries(Object.entries(v.dimensions).map(([k, info]) => [k, typeof info === 'object' ? info.score : info as number]))
        : null,
      ...(v.diagnostic ? {
        diagnostic: {
          summary: v.diagnostic.summary,
          expected: v.diagnostic.expected,
          actual: v.diagnostic.actual,
          rootCause: v.diagnostic.rootCause,
          skillSuggestion: suggestion?.skill,
          sampleSuggestion: suggestion?.sample,
          none: suggestion?.none,
        },
      } : {}),
    });
  }
  return weakSamples
    .sort((a, b) => a.compositeScore - b.compositeScore)
    .slice(0, count);
}

export function allNonTripwireAssertionsPass(report: Report, variantKey: string): boolean {
  for (const entry of report.results) {
    const variant = entry.variants[variantKey];
    if (!variant || variant.ok === false) return false;
    const snapshotTripwire = report.sampleSnapshots?.[entry.sample_id]?.tripwire === true;
    const diagnosticTripwire = (variant.diagnostic?.rootCause ?? []).includes('tripwire_intentional');
    if (snapshotTripwire || diagnosticTripwire) continue;
    const details = variant.assertions?.details ?? [];
    if (!details.every((d) => d.passed)) return false;
  }
  return true;
}

const FIX_AGENT_SYSTEM_PROMPT = `你是一个评测用例修复专家。你的任务是使用 Edit 工具直接修改 samples JSON 文件中有问题的用例。

修复原则：
1. 先分析失败原因——是 sample 设计问题（mock 缺失 / 断言写错 / 工具名不匹配）还是 LLM 行为问题（LLM 真的做错了,低分合理）
2. 如果是 LLM 行为问题（低分合理）,不要改 sample
3. 如果是 sample 设计问题,用 Edit 工具修复对应 sample 的 mocks / assertions / environment
4. 保持 sample_id 不变,保持测试意图不变
5. 每次 Edit 只改一个 sample 的一处问题,可以多次 Edit
6. 不要重写整个 JSON 文件,只改有问题的字段
7. 断言修复只保留核心行为节点,不要过度绑定实现细节
8. 不要删除整条用例
9. 只能修改 sample,绝对不能建议修改 SKILL.md`;

function createSampleFixExecutor(executorName: string) {
  const executor = createExecutor(executorName);
  return async (opts: { model: string; system: string; prompt: string; timeoutMs: number; lean?: boolean; cwd?: string }) => {
    const result = await executor({
      model: opts.model,
      system: opts.system,
      prompt: opts.prompt,
      timeoutMs: opts.timeoutMs,
      lean: opts.lean,
      ...(opts.cwd && { cwd: opts.cwd }),
    });
    return { ok: result.ok, text: result.output ?? '', costUSD: result.costUSD };
  };
}

async function autoFixSamplesAgent(opts: {
  samplesPath: string;
  skillContent: string;
  report: Report;
  treatmentKey: string;
  executorName: string;
  model: string;
  maxAttemptsPerSample: number;
}): Promise<{ fixedCount: number; costUSD: number }> {
  const { samples } = loadSamples(opts.samplesPath);
  const sampleMap = new Map(samples.map((s) => [s.sample_id, s]));
  const fixContexts: Array<{ sampleId: string; diag: string; failedAssertions: string }> = [];

  for (const entry of opts.report.results) {
    const variant = entry.variants?.[opts.treatmentKey];
    if (!variant) continue;
    const variantObj = variant as unknown as Record<string, unknown>;
    if (variantObj.ok === false) continue;
    const assertionDetails = (variantObj.assertions as Record<string, unknown>)?.details as Array<{ type: string; value: string; passed: boolean }> ?? [];
    if (assertionDetails.length === 0 || assertionDetails.every((d) => d.passed)) continue;
    const sid = entry.sample_id;
    const original = sampleMap.get(sid);
    if (!original) continue;
    if (typeof (original as Record<string, unknown>).omkFix === 'object') {
      const attempts = ((original as Record<string, unknown>).omkFix as Record<string, unknown>)?.attempts;
      if (typeof attempts === 'number' && attempts >= opts.maxAttemptsPerSample) continue;
    }
    const diag = variantObj.diagnostic as Record<string, unknown> | undefined;
    const toolCalls = (variantObj.toolCalls ?? []) as Array<{ tool: string; input: unknown; success: boolean }>;
    const failedList = assertionDetails.filter((a) => !a.passed).map((a) => `${a.type}: ${a.value}`).join('\n');
    const toolSummary = toolCalls.length > 0
      ? toolCalls.map((tc, i) => `[${i}] ${tc.tool} success=${tc.success}`).join('\n')
      : '(无工具调用)';
    fixContexts.push({
      sampleId: sid,
      diag: `归因: ${((diag?.rootCause as string[]) ?? []).join(', ') || '(无)'}\n摘要: ${(diag?.summary as string) ?? ''}\n期望: ${(diag?.expected as string) ?? ''}\n实际: ${(diag?.actual as string) ?? ''}\n建议: ${((diag?.suggestion as Record<string, string>)?.sample) ?? '(无)'}`,
      failedAssertions: `失败断言:\n${failedList}\n\n实际工具调用:\n${toolSummary}`,
    });
  }

  if (fixContexts.length === 0) return { fixedCount: 0, costUSD: 0 };

  const skillPreview = opts.skillContent.length > 4000
    ? opts.skillContent.slice(0, 4000) + '\n\n... (truncated)'
    : opts.skillContent;

  const sampleSections = fixContexts.map((ctx) =>
    `### ${ctx.sampleId}\n\n${ctx.diag}\n\n${ctx.failedAssertions}`
  ).join('\n\n---\n\n');

  const prompt = `以下有 ${fixContexts.length} 条失败的评测用例需要分析修复。

## Skill 原文（参考，不可修改）

${skillPreview}

## 待修复的用例

${sampleSections}

请使用 Edit 工具修改文件 ${opts.samplesPath}，只改有问题的 sample 的 assertions / mocks / environment 字段。如果判断是 LLM 行为问题（低分合理），不要改该 sample。`;

  const executor = createExecutor(opts.executorName);
  const beforeContent = readFileSync(opts.samplesPath, 'utf-8');
  const result = await executor({
    model: opts.model,
    system: FIX_AGENT_SYSTEM_PROMPT,
    prompt,
    cwd: dirname(opts.samplesPath),
    timeoutMs: 300_000,
  });

  const afterContent = readFileSync(opts.samplesPath, 'utf-8');
  const changed = afterContent !== beforeContent;
  const fixedCount = changed ? fixContexts.length : 0;
  return { fixedCount, costUSD: result.costUSD };
}

async function autoFixSamplesAfterSkillRound(opts: {
  samplesPath: string;
  skillContent: string;
  report: Report;
  treatmentKey: string;
  executorName: string;
  model: string;
  maxAttemptsPerSample: number;
  improveMode?: 'agent' | 'rewrite';
}): Promise<{ fixedCount: number; costUSD: number }> {
  const { samples } = loadSamples(opts.samplesPath);

  if (opts.improveMode === 'agent') {
    return autoFixSamplesAgent(opts);
  }

  const result = await fixSamples({
    skillContent: opts.skillContent,
    samples: samples as unknown as Record<string, unknown>[],
    report: opts.report,
    treatmentKey: opts.treatmentKey,
    executor: createSampleFixExecutor(opts.executorName),
    model: opts.model,
    maxAttemptsPerSample: opts.maxAttemptsPerSample,
  });
  if (result.fixedCount > 0) {
    writeFileSync(opts.samplesPath, JSON.stringify(result.samples, null, 2));
  }
  return { fixedCount: result.fixedCount, costUSD: result.costUSD };
}

export function buildImprovementPrompt(skillContent: string, score: number, weakSamples: WeakSample[]): string {
  const weakDetails = weakSamples.map((s) => {
    const parts = [`### ${s.sample_id}（${s.compositeScore}/5.0）`];
    if (s.llmReason) parts.push(`评委反馈: ${s.llmReason}`);
    if (s.failedAssertions.length > 0) parts.push(`失败断言: ${s.failedAssertions.join(', ')}`);
    if (s.diagnostic) {
      if (s.diagnostic.rootCause?.length) parts.push(`诊断归因: ${s.diagnostic.rootCause.join(', ')}`);
      if (s.diagnostic.summary) parts.push(`诊断摘要: ${s.diagnostic.summary}`);
      if (s.diagnostic.expected) parts.push(`期望行为: ${s.diagnostic.expected}`);
      if (s.diagnostic.actual) parts.push(`实际行为: ${s.diagnostic.actual}`);
      if (s.diagnostic.skillSuggestion) parts.push(`建议修改 skill: ${s.diagnostic.skillSuggestion}`);
      if (s.diagnostic.sampleSuggestion) parts.push(`建议修改 sample: ${s.diagnostic.sampleSuggestion}`);
      if (s.diagnostic.none) parts.push(`无需改动说明: ${s.diagnostic.none}`);
    }
    if (s.dimensions) {
      const dimStr = Object.entries(s.dimensions).map(([k, v]) => `${k}: ${v}`).join(', ');
      parts.push(`维度分数: ${dimStr}`);
    }
    return parts.join('\n');
  }).join('\n\n');

  return `## 当前 Skill（平均分: ${score.toFixed(2)}/5.0）

${skillContent}

## 低分用例分析

${weakDetails || '（无低分用例）'}`;
}

function buildImprovementSuffix(mode: 'agent' | 'rewrite', candidatePath?: string): string {
  if (mode === 'agent') {
    return `\n\n请使用 Edit 工具修改文件 ${candidatePath}，只改与上述问题直接相关的部分。不要重写整篇文件。`;
  }
  return '\n\n请基于以上分析改进 Skill，使其在这些场景中表现更好。直接输出改进后的完整 Skill 内容。';
}

function parseImprovedSkill(output: string): string {
  let content = output.trim();
  // Strip markdown code fences if present
  const match = content.match(/```(?:markdown|md)?\s*([\s\S]*?)```/);
  if (match) content = match[1].trim();
  // Strip leading explanation lines before the actual skill content
  if (content.startsWith('以下是') || content.startsWith('改进后')) {
    const lines = content.split('\n');
    const startIdx = lines.findIndex((l) => l.startsWith('#') || l.startsWith('你是'));
    if (startIdx > 0) content = lines.slice(startIdx).join('\n');
  }
  return content;
}

/** @deprecated Use ProgressCallback from evaluation-core.ts */
export type EvolveProgressInfo = Parameters<ProgressCallback>[0];

export interface EvolveRoundProgressInfo {
  round: number;
  totalRounds: number;
  phase: string;
  score?: number;
  delta?: number;
  accepted?: boolean;
  costUSD?: number;
  /** False = exec 或 judge executor 不报 cost(如 codex)→ costUSD 是占位 0。
   *  CLI 输出据此把 "$0.0000" 改成「—」。 */
  costReported?: boolean;
  error?: string;
  reused?: boolean;
}

interface EvolveOptions {
  skillPath: string;
  samplesPath: string;
  rounds?: number;
  target?: number | null;
  stopOnAssertionsPass?: boolean;
  autoFixSamples?: boolean;
  sampleFixMaxAttempts?: number;
  reuseLatestEval?: boolean;
  model?: string;
  /** Single-judge config. evolve 不支持 ensemble — CLI 在 length>=2 时 exit 2,
   *  programmatic API 在 evolveSkill 入口同样 throw,二者一致。Default
   *  `[{ executor: <executorName>, model: 'haiku' }]`. */
  judgeModels?: JudgeConfig[];
  improveModel?: string;
  /** 改写策略。'agent' 用 agent 工具增量 Edit；'rewrite' 用单次 LLM 输出全文。默认 'agent'。 */
  improveMode?: 'agent' | 'rewrite';
  executorName?: string;
  concurrency?: number;
  timeoutMs?: number;
  skipConnectivity?: boolean;
  /** 控被评测 LLM 的扩展思考预算。默认 'low' 跟 omk eval 一致。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 关闭 diagnostic LLM 调用。默认 false。 */
  noDiagnostic?: boolean;
  /** 跳过 doctor 健康检查门禁。默认 false。 */
  skipDoctor?: boolean;
  onProgress?: ProgressCallback | null;
  onRoundProgress?: ((progress: EvolveRoundProgressInfo) => void) | null;
}

interface TrajectoryEntry {
  round: number;
  score: number;
  delta: number;
  accepted: boolean;
  costUSD: number;
}

export interface EvolveResult {
  startScore: number;
  finalScore: number;
  bestRound: number;
  totalRounds: number;
  totalCostUSD: number;
  stopReason?: 'target' | 'assertions-pass' | 'consecutive-rejects' | 'rounds';
  sampleFixes?: Array<{ round: number; fixedCount: number; costUSD: number }>;
  reusedBaselineReportId?: string;
  /** False = 任一轮的 exec / judge 不报 cost → totalCostUSD 是 lower-bound 而非真值。 */
  costReported?: boolean;
  trajectory: TrajectoryEntry[];
  bestSkillPath: string;
  allVersions: string[];
  reportId?: string;
}

export interface RoundReport {
  round: number;
  accepted: boolean;
  report: Report;
}

export function mergeEvolveReports(
  roundReports: RoundReport[],
  skillName: string,
  totalCostUSD: number,
  samples?: Sample[],
  skillPath?: string,
): Report {
  const firstReport = roundReports[0].report;

  // Build variant labels: "round-0", "round-1", "round-2", ...
  const variantLabels = roundReports.map(({ round }) => `round-${round}`);

  // Build summary: map each variant label to its round's summary
  const summary: Record<string, Report['summary'][string]> = {};
  for (let i = 0; i < roundReports.length; i++) {
    const { report } = roundReports[i];
    const originalKey = Object.keys(report.summary)[0];
    summary[variantLabels[i]] = report.summary[originalKey];
  }

  // Build results: merge per-sample variant data across rounds
  const sampleIds = firstReport.results.map((r) => r.sample_id);
  const results: ResultEntry[] = sampleIds.map((sampleId) => {
    const variants: Record<string, VariantResult> = {};
    for (let i = 0; i < roundReports.length; i++) {
      const entry = roundReports[i].report.results.find((r) => r.sample_id === sampleId);
      if (entry) {
        const originalKey = Object.keys(entry.variants)[0];
        variants[variantLabels[i]] = entry.variants[originalKey];
      }
    }
    return { sample_id: sampleId, variants };
  });

  // Build variantConfigs: collect from each round, relabel variant name; mark round-0 as baseline
  const variantConfigs = roundReports.flatMap(({ round, report }, i) =>
    (report.meta.variantConfigs || []).map((cfg) => ({
      ...cfg,
      variant: variantLabels[i],
      ...(round === 0 ? { experimentType: 'baseline' as const, artifactKind: 'baseline' as const, executionStrategy: 'baseline' as const } : {}),
    })),
  );

  // Build artifactHashes: collect from each round, relabel key
  const artifactHashes: Record<string, string> = {};
  for (let i = 0; i < roundReports.length; i++) {
    const hashes = roundReports[i].report.meta.artifactHashes || {};
    const originalKey = Object.keys(hashes)[0];
    if (originalKey) artifactHashes[variantLabels[i]] = hashes[originalKey];
  }

  const runId = `evolve-${skillName}-${generateRunId([skillName]).split('-').slice(-2).join('-')}`;

  const report: Report = {
    kind: 'evaluation',
    id: runId,
    meta: {
      ...firstReport.meta,
      variants: variantLabels,
      variantConfigs,
      artifactHashes,
      totalCostUSD: Number(totalCostUSD.toFixed(6)),
      timestamp: new Date().toISOString(),
      evolve: {
        skillName,
        ...(skillPath ? { skillPath } : {}),
      },
    },
    summary,
    results,
    ...(firstReport.sampleSnapshots ? { sampleSnapshots: firstReport.sampleSnapshots } : {}),
  };

  // pass samples to populate analysis.sampleQuality (capability/difficulty/
  // construct/provenance coverage). Without samples, sampleQuality is omitted but
  // structured insights are still computed.
  report.analysis = analyzeResults(report, { samples });

  return report;
}

export async function evolveSkill({
  skillPath,
  samplesPath,
  rounds = 5,
  target = null,
  stopOnAssertionsPass = false,
  autoFixSamples = false,
  sampleFixMaxAttempts = 2,
  reuseLatestEval = false,
  model = DEFAULT_MODEL,
  judgeModels,
  improveModel = DEFAULT_MODEL,
  improveMode = 'agent',
  executorName = 'claude',
  concurrency = 1,
  timeoutMs,
  skipConnectivity = false,
  effort,
  noDiagnostic,
  skipDoctor,
  onProgress = null,
  onRoundProgress = null,
}: EvolveOptions): Promise<EvolveResult> {
  if (judgeModels && judgeModels.length > 1) {
    throw new Error(
      'evolveSkill does not support multi-judge ensemble (received '
      + `${judgeModels.length} judges). Pass a single-judge array, e.g. `
      + `[{ executor: 'claude', model: 'haiku' }]`,
    );
  }
  const effectiveJudgeModels: JudgeConfig[] = judgeModels && judgeModels.length > 0
    ? judgeModels
    : [{ executor: executorName, model: JUDGE_MODEL }];
  const absSkillPath = resolve(skillPath);
  const absSamplesPath = resolve(samplesPath);
  const skillDir = dirname(absSkillPath);
  const fileBaseName = basename(absSkillPath, '.md');
  const skillName = readSkillName(absSkillPath) ?? (fileBaseName === 'SKILL' ? basename(skillDir) : fileBaseName);
  const evolveDir = join(skillDir, 'evolve');

  if (!existsSync(absSkillPath)) throw new Error(`skill file not found: ${absSkillPath}`);
  if (!existsSync(absSamplesPath)) throw new Error(`samples file not found: ${absSamplesPath}`);
  mkdirSync(evolveDir, { recursive: true });

  // Save original as r0
  let currentBest = readFileSync(absSkillPath, 'utf-8').trim();
  const r0Path = join(evolveDir, `${skillName}.r0.md`);
  writeFileSync(r0Path, currentBest);
  const allVersions: string[] = [r0Path];

  let bestScore = 0;
  let bestRound = 0;
  let totalCostUSD = 0;
  let totalCostReported = true; // 任一 round 走不报 cost 的 executor → 整体 lower-bound
  let consecutiveRejects = 0;
  const trajectory: TrajectoryEntry[] = [];
  const roundReports: RoundReport[] = [];
  const sampleFixes: NonNullable<EvolveResult['sampleFixes']> = [];
  let reusedBaselineReportId: string | undefined;
  let baselineReused = false;
  let stopReason: EvolveResult['stopReason'] = 'rounds';

  // 给定一个 report 看任一 variant 的 exec/judge cost 是否未报告
  const reportHasUnreportedCost = (rep: Report): boolean =>
    Object.values(rep.summary).some((v) => v.execCostReported === false || v.judgeCostReported === false);

  // Round 0: baseline evaluation
  let baselineReport = reuseLatestEval
    ? await findReusableBaselineReport({
      skillContent: currentBest,
      samplesPath: absSamplesPath,
      model,
      executorName,
      judgeModels: effectiveJudgeModels,
      effort,
      noDiagnostic,
    })
    : null;
  if (baselineReport) {
    reusedBaselineReportId = baselineReport.id;
    baselineReused = true;
  } else {
    baselineReport = await evaluate(r0Path, {
      samplesPath: absSamplesPath, skillDir, model, judgeModels: effectiveJudgeModels, executorName, concurrency, timeoutMs, skipConnectivity, effort, noDiagnostic, skipDoctor, onProgress,
    });
  }
  const baselineVariantKey = Object.keys(baselineReport.summary)[0];
  bestScore = baselineReport.summary[baselineVariantKey]?.avgCompositeScore ?? 0;
  const baselineCost = baselineReused ? 0 : baselineReport.meta.totalCostUSD;
  totalCostUSD += baselineCost;
  const baselineCostReported = baselineReused || !reportHasUnreportedCost(baselineReport);
  if (!baselineCostReported) totalCostReported = false;

  trajectory.push({ round: 0, score: bestScore, delta: 0, accepted: true, costUSD: baselineCost });
  roundReports.push({ round: 0, accepted: true, report: baselineReport });
  if (onRoundProgress) onRoundProgress({ round: 0, totalRounds: rounds, phase: 'baseline', score: bestScore, costUSD: baselineCost, costReported: baselineCostReported, reused: baselineReused });

  if (stopOnAssertionsPass && allNonTripwireAssertionsPass(baselineReport, baselineVariantKey)) {
    stopReason = 'assertions-pass';
    writeFileSync(absSkillPath, currentBest);
    const { samples } = loadSamples(absSamplesPath);
    const mergedReport = mergeEvolveReports(roundReports, skillName, totalCostUSD, samples, absSkillPath);
    persistReport(mergedReport, DEFAULT_OUTPUT_DIR);
    return {
      startScore: bestScore,
      finalScore: bestScore,
      bestRound,
      totalRounds: 0,
      totalCostUSD: Number(totalCostUSD.toFixed(6)),
      stopReason,
      ...(sampleFixes.length > 0 && { sampleFixes }),
      ...(reusedBaselineReportId && { reusedBaselineReportId }),
      ...(totalCostReported ? {} : { costReported: false }),
      trajectory,
      bestSkillPath: allVersions[bestRound],
      allVersions,
      reportId: mergedReport.id,
    };
  }

  // Evolution loop
  for (let round = 1; round <= rounds; round++) {
    // Extract weak samples from last accepted evaluation. round=1 reuses baselineReport
    // (already paid for above). round≥2 re-evaluates the current best skill to get fresh
    // weak samples — this evaluation costs real money and MUST be added to totalCostUSD,
    // otherwise the user-facing budget tracker undercounts by ~N-1 evaluations across
    // an N-round run. (Bug found in  UltraReview.)
    let lastReport: Report;
    if (round === 1) {
      lastReport = baselineReport;
    } else {
      lastReport = await evaluate(allVersions[bestRound], {
        samplesPath: absSamplesPath, skillDir, model, judgeModels: effectiveJudgeModels, executorName, concurrency, timeoutMs, skipConnectivity, effort, noDiagnostic, skipDoctor, onProgress,
      });
      totalCostUSD += lastReport.meta.totalCostUSD;
      if (reportHasUnreportedCost(lastReport)) totalCostReported = false;
    }
    const lastVariantKey = Object.keys(lastReport.summary)[0];
    const weakSamples = extractWeakSamples(lastReport, lastVariantKey);

    // Generate improvement
    const candidatePath = join(evolveDir, `${skillName}.r${round}.md`);
    const basePrompt = buildImprovementPrompt(currentBest, bestScore, weakSamples);
    const executor = createExecutor(executorName);
    let candidateContent: string;
    let improveCostUSD: number;
    let improveCostReported = true;

    if (improveMode === 'agent') {
      writeFileSync(candidatePath, currentBest);
      const improvePrompt = basePrompt + buildImprovementSuffix('agent', candidatePath);
      const improveResult = await executor({ model: improveModel, system: IMPROVE_AGENT_SYSTEM_PROMPT, prompt: improvePrompt, cwd: skillDir, timeoutMs });
      if (!improveResult.ok) {
        if (onRoundProgress) onRoundProgress({ round, totalRounds: rounds, phase: 'error', error: improveResult.error });
        consecutiveRejects++;
        trajectory.push({ round, score: bestScore, delta: 0, accepted: false, costUSD: improveResult.costUSD });
        totalCostUSD += improveResult.costUSD;
        if (improveResult.costReportedByExecutor === false) totalCostReported = false;
        if (consecutiveRejects >= 2) { stopReason = 'consecutive-rejects'; break; }
        continue;
      }
      improveCostUSD = improveResult.costUSD;
      if (improveResult.costReportedByExecutor === false) improveCostReported = false;
      candidateContent = readFileSync(candidatePath, 'utf-8');
    } else {
      const improvePrompt = basePrompt + buildImprovementSuffix('rewrite');
      const improveResult = await executor({ model: improveModel, system: IMPROVE_SYSTEM_PROMPT, prompt: improvePrompt, timeoutMs, lean: true });
      if (!improveResult.ok) {
        if (onRoundProgress) onRoundProgress({ round, totalRounds: rounds, phase: 'error', error: improveResult.error });
        consecutiveRejects++;
        trajectory.push({ round, score: bestScore, delta: 0, accepted: false, costUSD: improveResult.costUSD });
        totalCostUSD += improveResult.costUSD;
        if (improveResult.costReportedByExecutor === false) totalCostReported = false;
        if (consecutiveRejects >= 2) { stopReason = 'consecutive-rejects'; break; }
        continue;
      }
      improveCostUSD = improveResult.costUSD;
      if (improveResult.costReportedByExecutor === false) improveCostReported = false;
      candidateContent = parseImprovedSkill(improveResult.output!);
      writeFileSync(candidatePath, candidateContent);
    }
    if (!improveCostReported) totalCostReported = false;
    allVersions.push(candidatePath);

    let preEvalSampleFixCost = 0;
    if (autoFixSamples) {
      const sampleFix = await autoFixSamplesAfterSkillRound({
        samplesPath: absSamplesPath,
        skillContent: candidateContent,
        report: lastReport,
        treatmentKey: lastVariantKey,
        executorName,
        model: improveModel,
        maxAttemptsPerSample: sampleFixMaxAttempts,
        improveMode,
      });
      if (sampleFix.fixedCount > 0) {
        sampleFixes.push({ round, fixedCount: sampleFix.fixedCount, costUSD: sampleFix.costUSD });
      }
      preEvalSampleFixCost = sampleFix.costUSD;
      totalCostUSD += sampleFix.costUSD;
    }

    // Evaluate candidate with any sample fixes already applied.
    const candidateReport = await evaluate(candidatePath, {
      samplesPath: absSamplesPath, skillDir, model, judgeModels: effectiveJudgeModels, executorName, concurrency, timeoutMs, skipConnectivity, effort, noDiagnostic, skipDoctor, onProgress,
    });
    const candidateVariantKey = Object.keys(candidateReport.summary)[0];
    const candidateScore = candidateReport.summary[candidateVariantKey]?.avgCompositeScore ?? 0;
    const roundCost = improveCostUSD + preEvalSampleFixCost + candidateReport.meta.totalCostUSD;
    const roundCostReported = improveCostReported && !reportHasUnreportedCost(candidateReport);
    if (!roundCostReported) totalCostReported = false;
    totalCostUSD += improveCostUSD + candidateReport.meta.totalCostUSD;

    const accepted = candidateScore > bestScore;

    const finalRoundReport = candidateReport;
    const finalRoundVariantKey = candidateVariantKey;
    const finalRoundScore = candidateScore;
    const finalRoundCost = roundCost;
    const finalRoundCostReported = roundCostReported;

    if (accepted) {
      currentBest = candidateContent;
      bestScore = candidateScore;
      bestRound = round;
      consecutiveRejects = 0;
    } else {
      consecutiveRejects++;
    }

    if (accepted) roundReports.push({ round, accepted, report: finalRoundReport });
    const roundDelta = finalRoundScore - trajectory[trajectory.length - 1].score;
    trajectory.push({ round, score: finalRoundScore, delta: roundDelta, accepted, costUSD: finalRoundCost });
    if (onRoundProgress) onRoundProgress({ round, totalRounds: rounds, phase: 'done', score: finalRoundScore, delta: roundDelta, accepted, costUSD: finalRoundCost, costReported: finalRoundCostReported });

    // Early stop
    if (stopOnAssertionsPass && accepted && allNonTripwireAssertionsPass(finalRoundReport, finalRoundVariantKey)) {
      stopReason = 'assertions-pass';
      break;
    }
    if (target && bestScore >= target) {
      stopReason = 'target';
      break;
    }
    if (consecutiveRejects >= 2) {
      stopReason = 'consecutive-rejects';
      break;
    }
  }

  // Write best version back to original file only if an improvement was accepted
  if (bestRound > 0) {
    writeFileSync(absSkillPath, currentBest);
  }

  // Merge all round reports into one and persist
  let reportId: string | undefined;
  if (roundReports.length > 0) {
    // load samples once to enable analysis.sampleQuality on the merged report.
    const { samples } = loadSamples(absSamplesPath);
    const mergedReport = mergeEvolveReports(roundReports, skillName, totalCostUSD, samples, absSkillPath);
    persistReport(mergedReport, DEFAULT_OUTPUT_DIR);
    reportId = mergedReport.id;
  }

  return {
    startScore: trajectory[0].score,
    finalScore: bestScore,
    bestRound,
    totalRounds: trajectory.length - 1, // excluding baseline
    totalCostUSD: Number(totalCostUSD.toFixed(6)),
    stopReason,
    ...(sampleFixes.length > 0 && { sampleFixes }),
    ...(reusedBaselineReportId && { reusedBaselineReportId }),
    ...(totalCostReported ? {} : { costReported: false }),
    trajectory,
    bestSkillPath: allVersions[bestRound],
    allVersions,
    reportId,
  };
}

interface EvaluateOptions {
  samplesPath: string;
  skillDir: string;
  model: string;
  judgeModels: JudgeConfig[];
  executorName: string;
  concurrency: number;
  timeoutMs?: number;
  skipConnectivity?: boolean;
  /** 跟 omk eval 同档:控被评测 LLM 的扩展思考预算。默认 'low' 跟 eval 一致,
   *  否则 evolve 隐式跑 high effort,跟 eval 默认配置不一致(用户会觉得"omk
   *  evolve 比 omk eval 慢 8x")。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 关闭 diagnostic LLM 调用。默认 false(跑诊断)。 */
  noDiagnostic?: boolean;
  /** 跳过 doctor 健康检查。默认 false。 */
  skipDoctor?: boolean;
  onProgress: ((progress: EvolveProgressInfo) => void) | null;
}

async function evaluate(skillFilePath: string, { samplesPath, skillDir, model, judgeModels, executorName, concurrency, timeoutMs, skipConnectivity, effort, noDiagnostic, skipDoctor, onProgress }: EvaluateOptions): Promise<Report> {
  const { report } = await runEvaluation({
    samplesPath,
    skillDir,
    // evolve 评测每一轮只跑当前迭代的 skill，没有对照组；标为 treatment。
    variantSpecs: [{ name: skillFilePath, role: 'treatment', expr: skillFilePath }],
    model,
    judgeModels,
    outputDir: null, // don't persist intermediate reports
    concurrency,
    timeoutMs,
    executorName,
    skipConnectivity,
    effort,
    noDiagnostic,
    skipDoctor,
    onProgress,
  });
  return report as Report;
}
