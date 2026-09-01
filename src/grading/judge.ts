import type { DimensionResult, EnsembleJudgeResult, ExecutorFn, JudgeAgreement, JudgeConfig, ToolCallInfo, TurnInfo } from '../types/index.js';
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from '../shared/llm-prompts/judge-prompts.js';
import { buildJudgeTraceSummary } from '../shared/llm-prompts/judge-trace.js';
// 评分类 prompt 已收口到 shared/llm-prompts/judge-prompts.ts(单一来源 + prompt-registry 冻结)。
// 这里 re-export 保对外 API 不破:既有消费方仍从 grading/judge.js import 这两个符号。
export { buildJudgePrompt, getJudgePromptHash } from '../shared/llm-prompts/judge-prompts.js';

interface JudgeResponse {
  score?: number | string;
  reason?: string;
  reasoning?: string;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function salvageJudgeResponse(text: string): JudgeResponse | null {
  const scoreMatch = text.match(/"score"\s*:\s*([0-5](?:\.\d+)?)(?![\d.])/i)
    ?? text.match(/\bscore\b\s*[:=]\s*([0-5](?:\.\d+)?)(?![\d.])/i);
  if (!scoreMatch) return null;

  const score = Number(scoreMatch[1]);
  if (!Number.isFinite(score) || score < 0 || score > 5) return null;

  return {
    score,
    reason: 'judge returned malformed JSON; score salvaged',
    reasoning: text.trim().slice(0, 2000),
  };
}

interface LlmJudgeOptions {
  output: string;
  rubric: string;
  prompt: string;
  executor: ExecutorFn;
  model: string;
  traceSummary?: string | null;
  /**
   * When true (default), the judge prompt includes an explicit
   * "length is not a quality signal" instruction. Pass false to drop it (the
   * debias-off prompt variant) — only useful for reproducing older no-length-debias
   * reports or running A/B comparisons with alternate length-debias settings.
   * (The presentation/tone neutrality instruction is always on, independent of this.)
   */
  lengthDebias?: boolean;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tool input 单行预览。Bash 命令(input.command)直接拿;其它 tool 走 JSON 序列化。
 * 截断到 INPUT_PREVIEW_MAX 字符,避免 prompt 膨胀过头。
 *
 * 关键:wrapper-style skill(mcporter / code-host CLI / git CLI 等)的真实语义调用
 * 编码在 Bash 命令字符串里(`mcporter --tool X` / `code-host pr show Y`),判官看不到
 * 就会下"没调指定工具"的错误结论。这个预览是判官识别这层语义的唯一通道。
 */
export function buildTraceSummary(turns?: TurnInfo[], toolCalls?: ToolCallInfo[]): string | null {
  return buildJudgeTraceSummary(turns, toolCalls);
}

export async function llmJudge({ output, rubric, prompt, executor, model, traceSummary, lengthDebias }: LlmJudgeOptions): Promise<DimensionResult> {
  const judgePrompt = buildJudgePrompt(prompt, rubric, output, traceSummary || null, lengthDebias ?? true);

  const result = await executor({
    model,
    system: JUDGE_SYSTEM_PROMPT,
    prompt: judgePrompt,
  });

  // 透传 executor 是否报告 cost。codex executor `costReportedByExecutor: false`,
  // 让各评委消费路径仍能识别 cost 非真值。
  const reportedField = result.costReportedByExecutor === false ? { judgeCostReportedByExecutor: false } : {};
  if (!result.ok) return { score: 0, reason: `judge error: ${result.error}`, judgeCostUSD: result.costUSD, ...reportedField };

  try {
    const text = result.output!.trim();
    const jsonText = extractFirstJsonObject(text);
    if (!jsonText) {
      process.stderr.write(`[omk] LLM judge returned non-JSON: ${text.slice(0, 100)}\n`);
      return { score: 0, reason: 'judge returned non-JSON', judgeCostUSD: result.costUSD, ...reportedField };
    }
    const parsed = JSON.parse(jsonText) as JudgeResponse;
    return {
      score: Number(parsed.score) || 0,
      reason: String(parsed.reason || ''),
      reasoning: parsed.reasoning ? String(parsed.reasoning) : undefined,
      judgeCostUSD: result.costUSD,
      ...reportedField,
    };
  } catch (parseErr: unknown) {
    const salvaged = salvageJudgeResponse(result.output || '');
    if (salvaged) {
      process.stderr.write(`[omk] LLM judge malformed JSON salvaged: ${getErrorMessage(parseErr)}\n`);
      return {
        score: Number(salvaged.score) || 0,
        reason: String(salvaged.reason || ''),
        reasoning: salvaged.reasoning ? String(salvaged.reasoning) : undefined,
        judgeCostUSD: result.costUSD,
        ...reportedField,
      };
    }
    process.stderr.write(`[omk] LLM judge parse error: ${getErrorMessage(parseErr)}\n`);
    return { score: 0, reason: 'failed to parse judge response', judgeCostUSD: result.costUSD, ...reportedField };
  }
}

/**
 * Max concurrent judge calls within a single sample × dimension. Each judge call
 * is one API request; running N=3 sequentially means 3× latency, but going wide
 * open risks hitting per-account RPM limits. 3 is a conservative middle ground —
 * for N=3 (the common case) it's fully parallel; for N=10 it's 4 batches.
 */
const JUDGE_REPEAT_CONCURRENCY = 3;

async function runInChunks<T>(
  items: number,
  chunkSize: number,
  fn: (i: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(items);
  for (let start = 0; start < items; start += chunkSize) {
    const end = Math.min(start + chunkSize, items);
    const batch = await Promise.all(
      Array.from({ length: end - start }, (_, k) => fn(start + k)),
    );
    for (let k = 0; k < batch.length; k++) results[start + k] = batch[k];
  }
  return results;
}

/**
 * Judge a single (output, rubric) pair N times and aggregate. Returns mean score,
 * stddev across runs, raw score samples, and the first-call reasoning (we keep one
 * reasoning sample, not N — only the score distribution matters for stability).
 *
 * Calls run with bounded concurrency (JUDGE_REPEAT_CONCURRENCY) to amortize latency
 * without burning rate limit. N=3 finishes in ~1 round-trip; N=10 in ~4. Cost is
 * summed across all N calls. When N <= 1 this is equivalent to llmJudge() with
 * scoreSamples = [score], scoreStddev = 0. The repeat value is clamped to >= 1
 * here as well as at the CLI layer — library callers shouldn't see surprises.
 *
 * Failures: any call returning score=0 (non-JSON / executor error / parse error) is
 * counted in `judgeFailureCount`. stddev is computed only over successful calls. If
 * stddev is 0 but judgeFailureCount > 0, that's NOT "judge agreed perfectly" — it
 * means most calls failed and one happened to succeed. Always inspect both fields.
 */
export async function llmJudgeRepeat(
  options: LlmJudgeOptions,
  repeat: number,
): Promise<DimensionResult> {
  const n = Math.max(1, Math.floor(repeat) || 1);
  if (n === 1) {
    const single = await llmJudge(options);
    const failed = single.score <= 0 ? 1 : 0;
    return { ...single, scoreSamples: [single.score], scoreStddev: 0, judgeFailureCount: failed };
  }

  // Run N judge calls with bounded concurrency. Result array preserves input order
  // (call 0 → results[0]) so "first call reasoning" is well-defined regardless of
  // which physical call returned first.
  const calls = await runInChunks(n, JUDGE_REPEAT_CONCURRENCY, () => llmJudge(options));

  const samples = calls.map((c) => c.score);
  const totalCost = calls.reduce((sum, c) => sum + (c.judgeCostUSD || 0), 0);
  // 任一 call 的 executor 不报 cost → 整个 repeat 的 totalCost 不可信
  const anyCostUnreported = calls.some((c) => c.judgeCostReportedByExecutor === false);
  const firstReasoning = calls[0]?.reasoning;
  const firstReason = calls.find((c) => c.reason)?.reason || '';

  const validSamples = samples.filter((s) => s > 0);
  const failures = samples.length - validSamples.length;
  const mean = validSamples.length > 0 ? validSamples.reduce((a, b) => a + b, 0) / validSamples.length : 0;
  const variance = validSamples.length > 1
    ? validSamples.reduce((s, x) => s + (x - mean) ** 2, 0) / (validSamples.length - 1)
    : 0;
  const stddev = Math.sqrt(variance);

  return {
    score: Number(mean.toFixed(2)),
    reason: firstReason,
    reasoning: firstReasoning,
    judgeCostUSD: totalCost,
    ...(anyCostUnreported && { judgeCostReportedByExecutor: false }),
    scoreSamples: samples,
    scoreStddev: Number(stddev.toFixed(3)),
    judgeFailureCount: failures,
  };
}

// ===========================================================================
// Multi-judge ensemble — cross-model agreement
// ===========================================================================

/** Format a JudgeConfig as "executor:model" identifier for reports / logs. */
export function judgeId(config: JudgeConfig): string {
  return `${config.executor}:${config.model}`;
}

/**
 * Pearson correlation between two number arrays of equal length. Returns null when
 * either array has zero variance (constant scores) — Pearson is undefined in that
 * case (division by zero), and reporting 0 would be misleading.
 */
function pearson(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const n = a.length;
  const meanA = a.reduce((s, x) => s + x, 0) / n;
  const meanB = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let denomA = 0;
  let denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  if (denomA === 0 || denomB === 0) return null;
  return num / Math.sqrt(denomA * denomB);
}

/** Mean absolute difference between two equal-length number arrays. */
function meanAbsDiff(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * Compute pairwise inter-judge agreement metrics across an ensemble. For N judges
 * we get N*(N-1)/2 pairs; metrics are pairwise-averaged.
 *
 * Each judge contributes ONE score per sample (its mean if judge-repeat > 1). We
 * then compute Pearson and mean-abs-diff over the N-judge × M-sample score matrix.
 *
 * NOTE: Within a single (sample × dimension) call, each judge gives ONE aggregated
 * score. So `pairwise` here means "two judges' scores on this one sample". With a
 * single sample point Pearson is undefined (need ≥ 2). For per-sample agreement we
 * fall back to mean-abs-diff alone; Pearson kicks in at the report-aggregate level
 * (across many samples).
 */
export function computeJudgeAgreement(judgeScores: number[][]): JudgeAgreement {
  // judgeScores[i][j] = score from judge i on sample j. All rows same length.
  const n = judgeScores.length;
  if (n < 2) return { meanAbsDiff: 0, pairCount: 0 };

  let madSum = 0;
  let pearsonSum = 0;
  let pearsonCount = 0;
  let pairs = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairs++;
      madSum += meanAbsDiff(judgeScores[i], judgeScores[j]);
      const p = pearson(judgeScores[i], judgeScores[j]);
      if (p !== null) {
        pearsonSum += p;
        pearsonCount++;
      }
    }
  }

  const result: JudgeAgreement = {
    meanAbsDiff: Number((madSum / pairs).toFixed(3)),
    pairCount: pairs,
  };
  if (pearsonCount > 0) {
    result.pearson = Number((pearsonSum / pearsonCount).toFixed(3));
  }
  return result;
}

/**
 * Judge a single (output, rubric) pair with N judge models in parallel. Each judge
 * may use a different executor (e.g. claude:opus + openai-api:gpt-4o). Each
 * judge can also be repeated `judgeRepeat` times — final per-judge score is its mean.
 *
 * Returns: aggregate DimensionResult (score = mean across judges; this is the "consensus"
 * score), per-judge breakdown in `ensemble`, and agreement metrics in `agreement`.
 *
 * The aggregate score is the mean of per-judge scores. This is a defensible default
 * but not the only choice — one could argue median (robust to outlier judges) or
 * majority vote (if scores are categorical). Mean is what most papers report; we
 * provide the raw ensemble so downstream can recompute.
 */
export async function llmJudgeEnsemble(
  options: LlmJudgeOptions,
  judges: JudgeConfig[],
  executorByName: (name: string) => ExecutorFn,
  judgeRepeat = 1,
): Promise<DimensionResult> {
  if (judges.length === 0) {
    throw new Error('llmJudgeEnsemble called with empty judges array');
  }
  if (judges.length === 1) {
    // Degenerate case — fall through to non-ensemble path.
    return llmJudgeRepeat({ ...options, executor: executorByName(judges[0].executor), model: judges[0].model }, judgeRepeat);
  }

  // Run all judges in parallel — they're independent. Each judge internally handles
  // its judge-repeat sequence.
  const perJudge = await Promise.all(
    judges.map(async (jc) => {
      const r = await llmJudgeRepeat(
        { ...options, executor: executorByName(jc.executor), model: jc.model },
        judgeRepeat,
      );
      const entry: EnsembleJudgeResult = {
        judge: judgeId(jc),
        score: r.score,
        scoreStddev: r.scoreStddev,
        scoreSamples: r.scoreSamples,
        judgeFailureCount: r.judgeFailureCount,
        reasoning: r.reasoning,
        costUSD: r.judgeCostUSD,
        ...(r.judgeCostReportedByExecutor === false && { costReportedByExecutor: false }),
      };
      return { entry, raw: r };
    }),
  );

  const ensemble = perJudge.map((p) => p.entry);
  const totalCost = perJudge.reduce((s, p) => s + (p.raw.judgeCostUSD || 0), 0);
  // 任一 judge 的 executor 不报 cost → ensemble totalCost 不可信
  const anyCostUnreported = perJudge.some((p) => p.raw.judgeCostReportedByExecutor === false);

  // Aggregate score = mean of per-judge means (consensus).
  const validScores = ensemble.map((e) => e.score).filter((s) => s > 0);
  const consensusScore = validScores.length > 0
    ? Number((validScores.reduce((a, b) => a + b, 0) / validScores.length).toFixed(2))
    : 0;

  // Per-judge agreement: only one sample point here (this single output), so Pearson
  // is undefined and we report mean-abs-diff. Aggregate-level Pearson (across all
  // samples in the run) is computed by the report-level aggregator, not here.
  const judgeScoreMatrix = ensemble.map((e) => [e.score]);
  const agreement = computeJudgeAgreement(judgeScoreMatrix);

  // Pick the "spokesperson" reasoning from the first judge that produced one.
  const spokesperson = ensemble.find((e) => e.reasoning);

  return {
    score: consensusScore,
    reason: `consensus across ${judges.length} judges`,
    reasoning: spokesperson?.reasoning,
    judgeCostUSD: totalCost,
    ...(anyCostUnreported && { judgeCostReportedByExecutor: false }),
    ensemble,
    agreement,
  };
}
