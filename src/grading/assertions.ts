import { resolve } from 'node:path';
import _Ajv from 'ajv';
import type { Assertion, AssertionDetail, AssertionResults, ExecutorFn, Sample, ToolCallInfo } from '../types/index.js';
import { ASSERTION_LAYER } from './layered-scores.js';
import { buildSemanticSimilarityPrompt, SEMANTIC_SIMILARITY_SYSTEM, buildRagJudgePrompt } from '../shared/llm-prompts/judge-prompts.js';

const Ajv = _Ajv.default ?? _Ajv;
const ajv = new Ajv();
const CUSTOM_ASSERTION_TIMEOUT_MS = 30_000;

export const ASYNC_ASSERTION_TYPES = new Set([
  'semantic_similarity',
  'custom',
  // RAG-specific judge metrics. All three go through the LLM-judge path
  // and inherit the same length-debias instruction as the main rubric judge.
  'faithfulness',
  'answer_relevancy',
  'context_recall',
]);

export interface AsyncAssertionContext {
  executor: ExecutorFn;
  judgeModel: string;
  sample: Sample;
  samplesDir: string;
}

interface JudgeResponse {
  score?: number | string;
  reason?: string;
}

interface CustomAssertionModule {
  default?: CustomAssertionFn;
  check?: CustomAssertionFn;
}

interface CustomAssertionResult {
  pass?: boolean;
  message?: string;
}

type CustomAssertionFn = (output: string, context: { sample: Sample; assertion: Assertion }) =>
  Promise<CustomAssertionResult> | CustomAssertionResult;

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ratioToScore(ratio: number): number {
  return Number((1 + ratio * 4).toFixed(2));
}

// ===========================================================================
// Deterministic similarity metrics
// ===========================================================================

/** Tokenizer: Latin words/numbers as units; CJK chars as single-char units. */
function tokenize(s: string): string[] {
  const m = s.toLowerCase().match(/[a-z0-9]+|[一-龥]/g);
  return m ?? [];
}

function ngrams(tokens: string[], n: number): string[] {
  if (n <= 0 || tokens.length < n) return [];
  const out: string[] = new Array(tokens.length - n + 1);
  for (let i = 0; i <= tokens.length - n; i++) {
    out[i] = tokens.slice(i, i + n).join(' ');
  }
  return out;
}

function clippedOverlap(candNgrams: string[], refNgrams: string[]): number {
  if (candNgrams.length === 0 || refNgrams.length === 0) return 0;
  const candCount = new Map<string, number>();
  const refCount = new Map<string, number>();
  for (const g of candNgrams) candCount.set(g, (candCount.get(g) ?? 0) + 1);
  for (const g of refNgrams) refCount.set(g, (refCount.get(g) ?? 0) + 1);
  let total = 0;
  for (const [g, cc] of candCount) {
    total += Math.min(cc, refCount.get(g) ?? 0);
  }
  return total;
}

/**
 * ROUGE-N (recall-oriented). N-gram overlap divided by the reference's
 * n-gram count. Multi-set form per Lin 2004 — repeated n-grams are clipped
 * to their reference count, so a candidate that repeats a single matching
 * n-gram many times can't game the score above 1.
 */
export function rougeN(candidate: string, reference: string, n: number): number {
  const cn = ngrams(tokenize(candidate), n);
  const rn = ngrams(tokenize(reference), n);
  if (rn.length === 0) return 0;
  return clippedOverlap(cn, rn) / rn.length;
}

/** Standard Levenshtein edit distance with O(min(m,n)) memory. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure b is the shorter one for memory.
  if (a.length < b.length) [a, b] = [b, a];
  const m = a.length, n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * BLEU score (corpus-level form, single reference). Geometric mean of
 * precision at n=1..maxN, multiplied by the brevity penalty for short
 * candidates. Unsmoothed — returns 0 if any n-gram precision is 0, which
 * is a known sharpness of the original BLEU; threshold accordingly.
 */
export function bleu(candidate: string, reference: string, maxN = 4): number {
  const ct = tokenize(candidate);
  const rt = tokenize(reference);
  if (ct.length === 0 || rt.length === 0) return 0;

  let logSum = 0;
  for (let n = 1; n <= maxN; n++) {
    const cn = ngrams(ct, n);
    const rn = ngrams(rt, n);
    if (cn.length === 0) return 0;
    const overlap = clippedOverlap(cn, rn);
    if (overlap === 0) return 0;
    logSum += Math.log(overlap / cn.length);
  }
  const bp = ct.length >= rt.length ? 1 : Math.exp(1 - rt.length / ct.length);
  return bp * Math.exp(logSum / maxN);
}

export function validateJsonSchema(data: unknown, schema: Record<string, unknown>): boolean {
  if (!schema || typeof schema !== 'object') return true;
  try {
    const validate = ajv.compile(schema);
    return validate(data) as boolean;
  } catch {
    return false;
  }
}

/**
 * Evaluate a single assertion against the output. Returns the raw pass/fail
 * BEFORE applying `not`. Pulled out of `runAssertions` so `assert-set` can
 * recurse on children without rebuilding the context.
 *
 * Universal negation (`not: true`) and `assert-set` (any/all combinator) are
 * supported here. Legacy `not_contains` / `not_equals` / etc. still work;
 * their negation is hard-coded inline as before.
 */
function evalAssertion(
  output: string,
  assertion: Assertion,
  ctx: { outputLower: string; toolCalls: ToolCallInfo[]; toolNames: string[]; costUSD?: number; durationMs?: number; numTurns?: number; mockStats?: { hits: number; misses: number; perMock: Record<string, number> } },
): boolean {
  const { outputLower, toolCalls, toolNames } = ctx;

  if (assertion.type === 'assert-set') {
    const children = assertion.children ?? [];
    if (children.length === 0) return false;
    const mode = assertion.mode ?? 'all';
    const childPasses = children.map((c) => {
      const raw = evalAssertion(output, c, ctx);
      return c.not ? !raw : raw;
    });
    return mode === 'any' ? childPasses.some(Boolean) : childPasses.every(Boolean);
  }

  switch (assertion.type) {
    case 'contains':
      return outputLower.includes(String(assertion.value).toLowerCase());
    case 'not_contains':
      return !outputLower.includes(String(assertion.value).toLowerCase());
    case 'regex': {
      const flags = assertion.flags || 'i';
      const re = new RegExp(assertion.pattern!, flags);
      return re.test(output);
    }
    case 'min_length':
      return output.length >= (assertion.value as number);
    case 'max_length':
      return output.length <= (assertion.value as number);
    case 'json_valid':
      try { JSON.parse(output); return true; } catch { return false; }
    case 'json_schema':
      try {
        const data = JSON.parse(output);
        return validateJsonSchema(data, assertion.schema!);
      } catch { return false; }
    case 'starts_with':
      return outputLower.startsWith(String(assertion.value).toLowerCase());
    case 'ends_with':
      return outputLower.endsWith(String(assertion.value).toLowerCase());
    case 'equals':
      return output.trim() === String(assertion.value).trim();
    case 'not_equals':
      return output.trim() !== String(assertion.value).trim();
    case 'word_count_min':
      return output.split(/\s+/).filter(Boolean).length >= (assertion.value as number);
    case 'word_count_max':
      return output.split(/\s+/).filter(Boolean).length <= (assertion.value as number);
    case 'contains_all':
      return (assertion.values || []).every((v) => outputLower.includes(String(v).toLowerCase()));
    case 'contains_any':
      return (assertion.values || []).some((v) => outputLower.includes(String(v).toLowerCase()));
    case 'cost_max':
      return (ctx.costUSD ?? Infinity) <= (assertion.value as number);
    case 'latency_max':
      return (ctx.durationMs ?? Infinity) <= (assertion.value as number);
    case 'turns_max':
      return (ctx.numTurns ?? Infinity) <= (assertion.value as number);
    case 'turns_min':
      return (ctx.numTurns ?? 0) >= (assertion.value as number);
    case 'tools_called':
      return (assertion.values || []).every((v) => toolNames.includes(String(v).toLowerCase()));
    case 'tools_not_called':
      return (assertion.values || []).every((v) => !toolNames.includes(String(v).toLowerCase()));
    case 'tools_count_max':
      return toolCalls.length <= (assertion.value as number);
    case 'tools_count_min':
      return toolCalls.length >= (assertion.value as number);
    case 'tool_output_contains': {
      const sep = String(assertion.value).indexOf(':');
      if (sep <= 0) return false;
      const targetTool = String(assertion.value).slice(0, sep).toLowerCase();
      const expected = String(assertion.value).slice(sep + 1).toLowerCase();
      return toolCalls.some((tc) =>
        tc.tool.toLowerCase() === targetTool &&
        String(tc.output || '').toLowerCase().includes(expected),
      );
    }
    case 'tool_input_contains': {
      const sep = String(assertion.value).indexOf(':');
      if (sep <= 0) return false;
      const targetTool = String(assertion.value).slice(0, sep).toLowerCase();
      const expected = String(assertion.value).slice(sep + 1).toLowerCase();
      return toolCalls.some((tc) =>
        tc.tool.toLowerCase() === targetTool &&
        JSON.stringify(tc.input || '').toLowerCase().includes(expected),
      );
    }
    case 'tool_input_not_contains': {
      const sep = String(assertion.value).indexOf(':');
      // value 必须是 "Tool:needle" 格式。无冒号(generator 偶尔产 "--force" / "lastTaskPatrol"
      // 这种裸 needle)在 _contains 语义里算 false(没法判定哪个工具),但 _not_contains 语义
      // 应该 trivially pass(没有匹配 = 没传 needle = 满足"不应包含"约束)。否则会变成
      // 假阳性失败,扭曲通过率。loader 已加格式校验拒绝这种 value,这里是 grader 兜底。
      if (sep <= 0) return true;
      const targetTool = String(assertion.value).slice(0, sep).toLowerCase();
      const expected = String(assertion.value).slice(sep + 1).toLowerCase();
      return !toolCalls.some((tc) =>
        tc.tool.toLowerCase() === targetTool &&
        JSON.stringify(tc.input || '').toLowerCase().includes(expected),
      );
    }
    // mock_hit:校验"驱动流程"——指定 mock 是否被命中至少 N 次
    // value 是 mockStats.perMock 的 key,格式 "Tool:N"(N 为 sample.mocks 数组里的 1-based 序号)
    // threshold 可选,默认 >=1
    // 例: { type: 'mock_hit', value: 'Bash:2' } 检查第 2 条 Bash mock 被调过
    case 'mock_hit': {
      const stats = ctx.mockStats;
      if (!stats) return false;
      const key = String(assertion.value);
      const hits = stats.perMock[key] ?? 0;
      const min = assertion.threshold ?? 1;
      return hits >= min;
    }
    case 'rouge_n_min':
      return rougeN(output, String(assertion.reference ?? assertion.value ?? ''), assertion.n ?? 1)
        >= (assertion.threshold ?? 0.5);
    case 'levenshtein_max':
      return levenshtein(output, String(assertion.reference ?? assertion.value ?? ''))
        <= (assertion.value as number ?? Infinity);
    case 'bleu_min':
      return bleu(output, String(assertion.reference ?? assertion.value ?? ''))
        >= (assertion.threshold ?? 0.5);
    default:
      return false;
  }
}

/**
 * assert-set 是布尔组合器,不是叶子断言,没有静态的「层」。它在 runAssertions 里只产出一条聚合明细
 * (`type: 'assert-set'`、aggregate pass/fail),computeLayeredScores 无法据此判 fact / behavior。
 * 这里在 grading 期(能看到 children 树时)按**叶子子断言**的层解析:递归收集所有叶子(穿透嵌套 assert-set),
 *   - 同层(全 fact 或全 behavior)→ 返回该层:聚合 pass/fail 归这一层,与 any/all 模式无关(同层信号无歧义)。
 *   - 混层 / 空 / 含未分类叶子 → 返回 undefined:不归层(混层组合器塞进单层会引入口径偏差,诚实做法是不计入分层)。
 * 解析结果落到 detail.layer,computeLayeredScores 优先读它。
 */
function resolveAssertSetLayer(assertion: Assertion): 'fact' | 'behavior' | undefined {
  const layers = new Set<'fact' | 'behavior' | 'unknown'>();
  const collect = (a: Assertion): void => {
    if (a.type === 'assert-set') {
      for (const c of a.children ?? []) collect(c);
      return;
    }
    layers.add(ASSERTION_LAYER[a.type] ?? 'unknown');
  };
  collect(assertion);
  if (layers.size !== 1) return undefined; // 0 / 混层 → 不归层
  const [only] = [...layers];
  return only === 'unknown' ? undefined : only;
}

export function runAssertions(
  output: string,
  assertions: Assertion[],
  context: { costUSD?: number; durationMs?: number; numTurns?: number; toolCalls?: ToolCallInfo[]; mockStats?: { hits: number; misses: number; perMock: Record<string, number> } } = {},
): AssertionResults {
  const outputLower = output.toLowerCase();
  const toolCalls = context.toolCalls || [];
  const toolNames = toolCalls.map((tc) => tc.tool.toLowerCase());
  const ctx = { outputLower, toolCalls, toolNames, costUSD: context.costUSD, durationMs: context.durationMs, numTurns: context.numTurns, mockStats: context.mockStats };

  const details: AssertionDetail[] = [];
  for (const assertion of assertions) {
    const weight = assertion.weight ?? 1;
    const raw = evalAssertion(output, assertion, ctx);
    const passed = assertion.not ? !raw : raw;
    // assert-set 组合器:在此(能看到 children)解析其层,供 computeLayeredScores 用;叶子断言按静态映射归层、不带 layer。
    const layer = assertion.type === 'assert-set' ? resolveAssertSetLayer(assertion) : undefined;
    details.push({
      type: assertion.type,
      value: assertion.value ?? assertion.pattern ?? assertion.values?.join(', ') ?? '',
      weight,
      passed,
      ...(layer ? { layer } : {}),
    });
  }

  const totalWeight = details.reduce((s, d) => s + d.weight, 0);
  const passedWeight = details.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
  const passedCount = details.filter((d) => d.passed).length;
  const ratio = totalWeight > 0 ? passedWeight / totalWeight : 0;

  return {
    passed: passedCount,
    total: details.length,
    score: ratioToScore(ratio),
    details,
  };
}

export async function runAsyncAssertions(output: string, assertions: Assertion[], { executor, judgeModel, sample, samplesDir }: AsyncAssertionContext): Promise<AssertionResults> {
  const details: AssertionDetail[] = [];
  let asyncCostUSD = 0;
  let anyCostUnreported = false;

  for (const assertion of assertions) {
    const weight = assertion.weight ?? 1;
    let passed = false;
    let message = '';

    if (assertion.type === 'semantic_similarity') {
      const reference = assertion.reference || '';
      const result = await executor({
        model: judgeModel,
        system: SEMANTIC_SIMILARITY_SYSTEM,
        prompt: buildSemanticSimilarityPrompt(reference, output),
      });

      asyncCostUSD += result.costUSD || 0;
      if (result.costReportedByExecutor === false) anyCostUnreported = true;
      if (result.ok) {
        try {
          const jsonMatch = result.output!.trim().match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as JudgeResponse;
            const score = Number(parsed.score) || 0;
            const threshold = assertion.threshold ?? 3;
            passed = score >= threshold;
            message = parsed.reason || '';
          } else {
            process.stderr.write(`[omk] semantic_similarity judge returned non-JSON: ${result.output!.slice(0, 100)}\n`);
          }
        } catch (parseErr: unknown) {
          process.stderr.write(`[omk] semantic_similarity judge parse error: ${getErrorMessage(parseErr)}\n`);
        }
      }
    } else if (
      assertion.type === 'faithfulness' ||
      assertion.type === 'answer_relevancy' ||
      assertion.type === 'context_recall'
    ) {
      const ragResult = await runRagJudge(assertion, output, sample, executor, judgeModel);
      asyncCostUSD += ragResult.costUSD;
      if (ragResult.costReportedByExecutor === false) anyCostUnreported = true;
      passed = ragResult.passed;
      message = ragResult.message;
    } else if (assertion.type === 'custom') {
      try {
        const fnPath = resolve(samplesDir, assertion.fn!);
        const mod = await import(fnPath) as CustomAssertionModule;
        const fn = mod.default || mod.check;
        if (!fn) throw new Error('custom assertion module must export default or check');
        const result = await Promise.race<CustomAssertionResult>([
          fn(output, { sample, assertion }),
          new Promise<CustomAssertionResult>((_, reject) => setTimeout(() => reject(new Error(`custom assertion timed out (${CUSTOM_ASSERTION_TIMEOUT_MS / 1000}s)`)), CUSTOM_ASSERTION_TIMEOUT_MS)),
        ]);
        passed = Boolean(result.pass);
        message = result.message || '';
      } catch (err: unknown) {
        passed = false;
        message = `custom assertion error: ${getErrorMessage(err)}`;
      }
    }

    details.push({
      type: assertion.type,
      value: assertion.reference || assertion.fn || '',
      weight,
      passed,
      ...(message && { message }),
    });
  }

  const totalWeight = details.reduce((s, d) => s + d.weight, 0);
  const passedWeight = details.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
  const passedCount = details.filter((d) => d.passed).length;
  const ratio = totalWeight > 0 ? passedWeight / totalWeight : 0;

  return {
    passed: passedCount,
    total: details.length,
    score: ratioToScore(ratio),
    details,
    judgeCostUSD: asyncCostUSD,
    ...(anyCostUnreported && { judgeCostReportedByExecutor: false }),
  };
}

// ===========================================================================
// RAG-specific judge metrics
// ===========================================================================
//
// Three metrics, all running through the LLM judge:
//
//  - faithfulness:      does the output's content stay grounded in the
//                       reference context? Anti-hallucination check.
//  - answer_relevancy:  does the output directly answer the user's question?
//                       Catches verbose dodges and topic drift.
//  - context_recall:    are the key facts from the gold context actually
//                       used in the output? Catches retrieved-but-ignored
//                       context (a common RAG bug).
//
// Implementation notes:
//
//  1. Each prompt is a SINGLE-CALL judge (1-5 score) rather than the multi-step
//     statement-decomposition that RAGAS uses. This is honest tradeoff: simpler,
//     faster, less rigorous than RAGAS but consistent with omk's other LLM-judge
//     assertions. Users who need RAGAS-grade decomposition can drop down to a
//     custom assertion.
//  2. The prompt carries the same debias instructions as the rubric judge
//     (length + presentation/tone) — verbosity, formatting, and confident tone
//     are not quality signals here either.
//  3. Reference resolution:
//       faithfulness:    sample.context  (or assertion.reference override)
//       context_recall:  assertion.reference (or sample.context fallback)
//       answer_relevancy: sample.prompt — no reference needed
//  4. Threshold defaults to 3 (same as semantic_similarity). User can override.

interface RagJudgeOutcome {
  passed: boolean;
  message: string;
  costUSD: number;
  /** False = judge executor 不报 cost(如 codex)→ costUSD 是占位 0。 */
  costReportedByExecutor?: boolean;
}

async function runRagJudge(
  assertion: Assertion,
  output: string,
  sample: Sample,
  executor: ExecutorFn,
  judgeModel: string,
): Promise<RagJudgeOutcome> {
  const threshold = assertion.threshold ?? 3;

  let prompt: string;
  let system: string;

  if (assertion.type === 'faithfulness') {
    const context = assertion.reference || sample.context || '';
    if (!context) {
      return { passed: false, message: 'faithfulness: 缺少 sample.context 或 assertion.reference', costUSD: 0 };
    }
    ({ system, prompt } = buildRagJudgePrompt('faithfulness', { output, context }));
  } else if (assertion.type === 'answer_relevancy') {
    ({ system, prompt } = buildRagJudgePrompt('answer_relevancy', { output, question: sample.prompt }));
  } else {
    // context_recall
    const reference = assertion.reference || sample.context || '';
    if (!reference) {
      return { passed: false, message: 'context_recall: 缺少 assertion.reference 或 sample.context', costUSD: 0 };
    }
    ({ system, prompt } = buildRagJudgePrompt('context_recall', { output, reference }));
  }

  const result = await executor({ model: judgeModel, system, prompt });
  const reported = result.costReportedByExecutor === false ? { costReportedByExecutor: false as const } : {};
  if (!result.ok) {
    return {
      passed: false,
      message: `${assertion.type} judge error: ${result.error}`,
      costUSD: result.costUSD || 0,
      ...reported,
    };
  }

  try {
    const text = result.output!.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      process.stderr.write(`[omk] ${assertion.type} judge returned non-JSON: ${text.slice(0, 100)}\n`);
      return { passed: false, message: 'judge returned non-JSON', costUSD: result.costUSD || 0, ...reported };
    }
    const parsed = JSON.parse(jsonMatch[0]) as JudgeResponse;
    const score = Number(parsed.score) || 0;
    return {
      passed: score >= threshold,
      message: parsed.reason ? String(parsed.reason) : '',
      costUSD: result.costUSD || 0,
      ...reported,
    };
  } catch (parseErr: unknown) {
    process.stderr.write(`[omk] ${assertion.type} judge parse error: ${getErrorMessage(parseErr)}\n`);
    return { passed: false, message: 'failed to parse judge response', costUSD: result.costUSD || 0, ...reported };
  }
}
