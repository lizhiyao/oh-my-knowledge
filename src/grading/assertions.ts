import { resolve } from 'node:path';
import type { Assertion, AssertionDetail, AssertionResults, ExecutorFn, Sample, ToolCallInfo } from '../types/index.js';
import { buildSemanticSimilarityPrompt, SEMANTIC_SIMILARITY_SYSTEM, buildRagJudgePrompt } from '../shared/llm-prompts/judge-prompts.js';
import {
  assertionContractValidationError,
} from '../shared/sample-contract.js';
import {
  ASYNC_ASSERTION_TYPES,
  SYNC_ASSERTION_TYPES,
} from '../shared/assertion-types.js';
import {
  evaluateDeterministicAssertion,
  ratioToScore,
} from '../shared/assertions/deterministic.js';
import { resolveAssertionLayer } from '../shared/assertions/layers.js';

export { ASYNC_ASSERTION_TYPES } from '../shared/assertion-types.js';
export {
  bleu,
  levenshtein,
  ratioToScore,
  rougeN,
  validateJsonSchema,
} from '../shared/assertions/deterministic.js';

const CUSTOM_ASSERTION_TIMEOUT_MS = 30_000;

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

export function runAssertions(
  output: string,
  assertions: Assertion[],
  context: { costUSD?: number; durationMs?: number; numTurns?: number; toolCalls?: ToolCallInfo[]; mockStats?: { hits: number; misses: number; perMock: Record<string, number> } } = {},
): AssertionResults {
  assertions.forEach((assertion, index) => {
    const error = assertionContractValidationError(assertion);
    if (error) throw new TypeError(`assertions[${index}]: ${error}`);
    if (!SYNC_ASSERTION_TYPES.has(assertion.type)) {
      throw new TypeError(`assertions[${index}]: async assertion ${JSON.stringify(assertion.type)} requires runAsyncAssertions()`);
    }
  });
  const details: AssertionDetail[] = [];
  for (const assertion of assertions) {
    const weight = assertion.weight ?? 1;
    const passed = evaluateDeterministicAssertion(output, assertion, context);
    // assert-set 组合器:在此(能看到 children)解析其层,供 computeLayeredScores 用;叶子断言按静态映射归层、不带 layer。
    const layer = assertion.type === 'assert-set' ? resolveAssertionLayer(assertion) : undefined;
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
  assertions.forEach((assertion, index) => {
    const error = assertionContractValidationError(assertion);
    if (error) throw new TypeError(`assertions[${index}]: ${error}`);
    if (!ASYNC_ASSERTION_TYPES.has(assertion.type)) {
      throw new TypeError(`assertions[${index}]: sync assertion ${JSON.stringify(assertion.type)} requires runAssertions()`);
    }
  });
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
