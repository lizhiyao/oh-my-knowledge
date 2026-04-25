import { resolve } from 'node:path';
import _Ajv from 'ajv';
import type { Assertion, AssertionDetail, AssertionResults, ExecutorFn, Sample, ToolCallInfo } from '../types.js';

const Ajv = _Ajv.default ?? _Ajv;
const ajv = new Ajv();
const CUSTOM_ASSERTION_TIMEOUT_MS = 30_000;

export const ASYNC_ASSERTION_TYPES = new Set(['semantic_similarity', 'custom']);

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
// v0.21 Phase 5b — deterministic similarity metrics
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
 * v0.21 Phase 5a — added `not: true` (universal negation) and `assert-set`
 * (any/all combinator). Legacy `not_contains` / `not_equals` / etc. still
 * work; their negation is hard-coded inline as before.
 */
function evalAssertion(
  output: string,
  assertion: Assertion,
  ctx: { outputLower: string; toolCalls: ToolCallInfo[]; toolNames: string[]; costUSD?: number; durationMs?: number; numTurns?: number },
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

export function runAssertions(
  output: string,
  assertions: Assertion[],
  context: { costUSD?: number; durationMs?: number; numTurns?: number; toolCalls?: ToolCallInfo[] } = {},
): AssertionResults {
  const outputLower = output.toLowerCase();
  const toolCalls = context.toolCalls || [];
  const toolNames = toolCalls.map((tc) => tc.tool.toLowerCase());
  const ctx = { outputLower, toolCalls, toolNames, costUSD: context.costUSD, durationMs: context.durationMs, numTurns: context.numTurns };

  const details: AssertionDetail[] = [];
  for (const assertion of assertions) {
    const weight = assertion.weight ?? 1;
    const raw = evalAssertion(output, assertion, ctx);
    const passed = assertion.not ? !raw : raw;
    details.push({
      type: assertion.type,
      value: assertion.value ?? assertion.pattern ?? assertion.values?.join(', ') ?? '',
      weight,
      passed,
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

  for (const assertion of assertions) {
    const weight = assertion.weight ?? 1;
    let passed = false;
    let message = '';

    if (assertion.type === 'semantic_similarity') {
      const reference = assertion.reference || '';
      const judgePrompt = [
        '请判断以下两段文本的语义相似度。',
        '',
        '## 参考文本',
        reference,
        '',
        '## 待评估文本',
        output,
        '',
        '请返回 JSON（不要包含 markdown 代码块标记）：',
        '{"score": <1-5的整数>, "reason": "<简短理由>"}',
        '',
        '评分：1=完全无关, 2=略有关联, 3=部分相似, 4=大致相同, 5=高度一致',
      ].join('\n');

      const result = await executor({
        model: judgeModel,
        system: '你是语义相似度评审员。只返回 JSON，不要其他内容。',
        prompt: judgePrompt,
      });

      asyncCostUSD += result.costUSD || 0;
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

  return { passed: passedCount, total: details.length, score: ratioToScore(ratio), details, judgeCostUSD: asyncCostUSD };
}
