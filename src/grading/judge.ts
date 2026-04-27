import { createHash } from 'node:crypto';
import type { DimensionResult, EnsembleJudgeResult, ExecutorFn, JudgeAgreement, JudgeConfig, ToolCallInfo, TurnInfo } from '../types/index.js';

interface JudgeResponse {
  score?: number | string;
  reason?: string;
  reasoning?: string;
}

/**
 * Judge prompt template version.
 *
 *  - 'v2-cot'         — legacy; CoT scoring without explicit length-debias instruction.
 *                       Kept for `--no-debias-length` so users can reproduce historical
 *                       reports byte-for-byte.
 *  - 'v3-cot-length'  — adds a paragraph telling the judge that length is not a quality
 *                       signal. Default since v0.21 Phase 3a (research consistently shows
 *                       LLM judges over-weight verbosity; explicit instruction mitigates).
 *
 * Bump when the prompt's intent or structure changes meaningfully — reports tagged
 * with the same hash are score-comparable; mismatched hashes mean "we changed how we
 * ask the judge to think" and should not be compared blind.
 */
const JUDGE_PROMPT_VERSION_DEBIAS_OFF = 'v2-cot';
const JUDGE_PROMPT_VERSION_DEBIAS_ON = 'v3-cot-length';

const JUDGE_SYSTEM_PROMPT = '你是一个严格的 AI 输出质量评审员。先逐条对照评分标准做推理，再给最终分数。只返回 JSON，不要其他内容。';

const LENGTH_DEBIAS_INSTRUCTION = [
  '## 重要：长度不是质量信号',
  '评分时聚焦内容实质与正确性。回答的篇幅、行文丰富度、结构复杂度本身不是质量指标 ——',
  '简洁正确的回答不应因短而扣分；冗长但偏题或重复的回答不应因长而加分。',
  '研究显示 LLM 评委容易隐性偏向更长的回答，请在打分前先警觉这一点。',
].join('\n');

export function buildJudgePrompt(
  prompt: string,
  rubric: string,
  output: string,
  traceSummary: string | null,
  lengthDebias = true,
): string {
  const version = lengthDebias ? JUDGE_PROMPT_VERSION_DEBIAS_ON : JUDGE_PROMPT_VERSION_DEBIAS_OFF;
  const traceSection = traceSummary
    ? ['', '## Agent 执行过程', traceSummary, '', '请同时考虑执行过程的合理性（工具选择、步骤效率、错误恢复）。']
    : [];
  const debiasSection = lengthDebias ? ['', LENGTH_DEBIAS_INSTRUCTION] : [];

  return [
    `请对以下 AI 输出进行质量评分（template ${version}）。`,
    '',
    '## 原始任务',
    prompt,
    '',
    '## 评分标准',
    rubric,
    '',
    '## AI 输出',
    output,
    ...traceSection,
    ...debiasSection,
    '',
    '## 评分流程',
    '1. 逐条对照评分标准，先做推理（reasoning）：列出 AI 输出哪些点对应哪条标准，哪些缺失，哪些有歧义。',
    '2. 基于推理给出最终分数（1-5 的整数）和简短理由。',
    '',
    '请返回 JSON（不要包含 markdown 代码块标记）：',
    '{"reasoning": "<对照标准的逐条推理>", "score": <1-5的整数>, "reason": "<最终结论的简短理由>"}',
    '',
    '评分标准：1=完全不达标, 2=部分涉及, 3=基本达标, 4=较好, 5=优秀',
  ].join('\n');
}

/**
 * Stable hash of the judge prompt template. Saved into ReportMeta.judgePromptHash so
 * downstream readers can detect "the judge prompt changed between these two reports".
 *
 * `lengthDebias` defaults to true (v0.21+ default). Pass false when running under
 * `--no-debias-length` so the hash matches historical v2-cot reports.
 */
export function getJudgePromptHash(lengthDebias = true): string {
  const version = lengthDebias ? JUDGE_PROMPT_VERSION_DEBIAS_ON : JUDGE_PROMPT_VERSION_DEBIAS_OFF;
  // Hash the template-shaping function source + the version tag together. We hash a
  // deterministic stringified form of the template (with placeholder inputs) so any
  // structural edit shows up.
  const sample = buildJudgePrompt('<P>', '<R>', '<O>', '<T>', lengthDebias);
  return createHash('sha256').update(version + '\n' + sample).digest('hex').slice(0, 12);
}

interface LlmJudgeOptions {
  output: string;
  rubric: string;
  prompt: string;
  executor: ExecutorFn;
  model: string;
  traceSummary?: string | null;
  /**
   * When true (default since v0.21), the judge prompt includes an explicit
   * "length is not a quality signal" instruction. Pass false to fall back to
   * the legacy v2-cot prompt — only useful for reproducing pre-v0.21 reports
   * or running A/B comparisons inside `omk bench debias-validate length`.
   */
  lengthDebias?: boolean;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function buildTraceSummary(turns?: TurnInfo[], toolCalls?: ToolCallInfo[]): string | null {
  if ((!turns || turns.length === 0) && (!toolCalls || toolCalls.length === 0)) return null;

  const lines: string[] = [];

  if (toolCalls && toolCalls.length > 0) {
    lines.push(`共调用 ${toolCalls.length} 个工具：`);
    const successCount = toolCalls.filter((tc) => tc.success).length;
    const failureCount = toolCalls.length - successCount;
    lines.push(`  成功 ${successCount}/${toolCalls.length}`);
    if (failureCount > 0) lines.push(`  失败 ${failureCount}/${toolCalls.length}`);

    const dist: Record<string, number> = {};
    for (const tc of toolCalls) {
      dist[tc.tool] = (dist[tc.tool] || 0) + 1;
    }
    lines.push(`  工具分布：${Object.entries(dist).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    const failedTools = toolCalls.filter((tc) => !tc.success).map((tc) => tc.tool);
    if (failedTools.length > 0) {
      lines.push(`  失败工具：${[...new Set(failedTools)].join(', ')}`);
    }
  }

  if (turns && turns.length > 0) {
    lines.push('');
    lines.push('执行轨迹摘要：');
    const assistantTurns = turns.filter((turn) => turn.role === 'assistant').length;
    const toolTurns = turns.filter((turn) => turn.role === 'tool').length;
    lines.push(`  共 ${turns.length} 步（assistant ${assistantTurns} / tool ${toolTurns}）`);
    const maxTurns = Math.min(turns.length, 10);
    for (let i = 0; i < maxTurns; i++) {
      const t = turns[i];
      const preview = t.content.slice(0, 100) + (t.content.length > 100 ? '...' : '');
      if (t.role === 'assistant' && t.toolCalls?.length) {
        lines.push(`  [${i + 1}] assistant: 调用 ${t.toolCalls.map((tc) => tc.tool).join(', ')}`);
      } else if (t.role === 'tool') {
        lines.push(`  [${i + 1}] tool: ${preview}`);
      } else {
        lines.push(`  [${i + 1}] ${t.role}: ${preview}`);
      }
    }
    if (turns.length > maxTurns) lines.push(`  ... 还有 ${turns.length - maxTurns} 步`);
  }

  return lines.join('\n');
}

export async function llmJudge({ output, rubric, prompt, executor, model, traceSummary, lengthDebias }: LlmJudgeOptions): Promise<DimensionResult> {
  const judgePrompt = buildJudgePrompt(prompt, rubric, output, traceSummary || null, lengthDebias ?? true);

  const result = await executor({
    model,
    system: JUDGE_SYSTEM_PROMPT,
    prompt: judgePrompt,
  });

  if (!result.ok) return { score: 0, reason: `judge error: ${result.error}`, judgeCostUSD: result.costUSD };

  try {
    const text = result.output!.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      process.stderr.write(`[omk] LLM judge returned non-JSON: ${text.slice(0, 100)}\n`);
      return { score: 0, reason: 'judge returned non-JSON', judgeCostUSD: result.costUSD };
    }
    const parsed = JSON.parse(jsonMatch[0]) as JudgeResponse;
    return {
      score: Number(parsed.score) || 0,
      reason: String(parsed.reason || ''),
      reasoning: parsed.reasoning ? String(parsed.reasoning) : undefined,
      judgeCostUSD: result.costUSD,
    };
  } catch (parseErr: unknown) {
    process.stderr.write(`[omk] LLM judge parse error: ${getErrorMessage(parseErr)}\n`);
    return { score: 0, reason: 'failed to parse judge response', judgeCostUSD: result.costUSD };
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
 * may use a different executor (e.g. claude:opus + openai:gpt-4o + gemini:pro). Each
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
      };
      return { entry, raw: r };
    }),
  );

  const ensemble = perJudge.map((p) => p.entry);
  const totalCost = perJudge.reduce((s, p) => s + (p.raw.judgeCostUSD || 0), 0);

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
    ensemble,
    agreement,
  };
}
