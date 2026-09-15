import { deepFreezeCanonicalJson, type JsonValue } from '../eval-core/contracts/index.js';
import type { CustomEvaluator } from './custom-evaluator.js';
import { evaluate } from './evaluation/prepare.js';
import { EvaluationConfigurationError } from './evaluation/errors.js';
import { captureRubricDebug, type DebugJudgeInvocation } from './debug-rubric.js';
export type { DebugJudgeInvocation, DebugJudgeResponse, DebugRubricReading } from './debug-rubric.js';
import type {
  EvaluateInput,
  EvaluationResult,
  EvaluationRunOptions,
  Policy,
  Sample,
  Variant,
  RubricJudgeEvaluator,
} from './evaluation/contracts.js';

export interface DebugEvaluatorInput<
  Bindings extends Record<string, JsonValue> = Record<string, JsonValue>,
  Parameters extends JsonValue | undefined = JsonValue | undefined,
> {
  readonly evaluator: CustomEvaluator<Bindings, Parameters> | RubricJudgeEvaluator;
  readonly sample: Sample;
  readonly variant: Variant;
  readonly seed?: string;
  readonly policy?: Policy;
  readonly infrastructure?: EvaluateInput['infrastructure'];
}

export interface DebugEvaluatorResult {
  /** Rubric provider calls in start order. Additional raw diagnostics stay in memory only. */
  readonly judgeInvocations: readonly DebugJudgeInvocation[];
  /** Raw projected inputs, one per parser invocation, before validation (including retries). */
  readonly bindingInputs: readonly Readonly<Record<string, JsonValue>>[];
  /** Canonical records, observations, stable failure codes, and accounting are authoritative. */
  readonly run: EvaluationResult;
}

/**
 * Executes one real sample/variant/trial through Runtime, with no comparison or release decision.
 * Binding inputs can contain gold/secret data. Returned in memory only; never sent to event sinks.
 */
export async function debugEvaluator<
  Bindings extends Record<string, JsonValue> = Record<string, JsonValue>,
  Parameters extends JsonValue | undefined = JsonValue | undefined,
>(
  input: Readonly<DebugEvaluatorInput<Bindings, Parameters>>,
  options?: Readonly<EvaluationRunOptions>,
): Promise<DebugEvaluatorResult> {
  let collecting = true;
  const bindingInputs: Readonly<Record<string, JsonValue>>[] = [];
  let observed: CustomEvaluator<Bindings, Parameters> | RubricJudgeEvaluator;
  let rubric: ReturnType<typeof captureRubricDebug> | undefined;
  try {
    const evaluator = input.evaluator;
    if (evaluator?.evaluatorKind === 'rubric-judge') {
      rubric = captureRubricDebug(evaluator);
      observed = rubric.evaluator;
    } else {
      const parser = evaluator?.implementation?.schemas?.bindings;
      const parse = parser?.parse;
      // Keep invalid declarations untouched so the canonical boundary reports their field paths.
      observed = typeof parse !== 'function' ? evaluator : {
        ...evaluator,
        implementation: {
          ...evaluator.implementation,
          schemas: {
            ...evaluator.implementation.schemas,
            bindings: {
              parse(value: unknown): Bindings {
                if (collecting) bindingInputs.push(deepFreezeCanonicalJson(structuredClone(value) as Record<string, JsonValue>));
                return Reflect.apply(parse, parser, [value]) as Bindings;
              },
            },
          },
        },
      };
    }
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    throw new EvaluationConfigurationError(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Custom Evaluator 调试声明不可读取。',
    );
  }
  let run: EvaluationResult;
  try {
    run = await evaluate({
      dataset: { datasetId: 'omk-debug-evaluator', samples: [input.sample] },
      variants: [input.variant],
      evaluators: [observed],
      comparisons: [],
      analyses: [],
      experiment: { seed: input.seed ?? 'omk-debug-evaluator', sampling: { samplingKind: 'solo' } },
      policy: input.policy ?? {},
      ...(input.infrastructure === undefined ? {} : { infrastructure: input.infrastructure }),
    }, options);
  } finally {
    collecting = false;
    rubric?.stop();
  }
  return Object.freeze({ bindingInputs: Object.freeze([...bindingInputs]), judgeInvocations: Object.freeze([...(rubric?.invocations ?? [])]), run });
}
