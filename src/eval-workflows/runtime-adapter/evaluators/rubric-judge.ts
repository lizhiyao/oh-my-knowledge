export * from '../../../eval-runtime/judges/rubric-judge.js';

import {
  createRubricJudgeEvaluatorImplementation,
  createRubricJudgeEvaluatorIdentity,
  parseRubricJudgeConfig,
  rubricJudgeInstrumentId,
} from '../../../eval-runtime/judges/rubric-judge.js';
import { captureLlmJudgeInvocationPort } from '../../../eval-runtime/judges/invocation.js';
import { EvaluationPortFailure } from '../../../eval-core/evaluation/index.js';
import { createSameProcessEvaluatorAdapter } from '../adapters/shared/omk-resource-same-process.js';
import type {
  OmkEvaluatorBindingContext,
  OmkRuntimePortBinding,
} from '../types.js';
import type { OmkLlmJudgeInvocationResolver } from './llm-judge-invocation.js';

function failure(code: string, message: string): never {
  throw new EvaluationPortFailure({ code, stage: 'evaluation', message });
}

/** OMK product-host wiring; the Judge measurement implementation lives in eval-runtime. */
export function createRubricJudgeEvaluatorBindingFactory(
  resolveInvocation: OmkLlmJudgeInvocationResolver,
): (
  context: Readonly<OmkEvaluatorBindingContext>,
) => Promise<OmkRuntimePortBinding<ReturnType<typeof createSameProcessEvaluatorAdapter>>> {
  return async (context) => {
    const config = parseRubricJudgeConfig(context.evaluator.config);
    const qualification = context.binding.qualification;
    if (context.evaluator.measurement.instrumentId
          !== rubricJudgeInstrumentId(config.evaluator.value)
        || qualification === undefined
        || qualification.executorId !== config.runtime.executorId
        || qualification.model !== config.runtime.model
        || qualification.effort !== config.runtime.effort
        || qualification.promptVariant !== config.runtime.promptVariant) {
      return failure(
        'omk-rubric-judge-runtime-binding-mismatch',
        'Rubric judge Runtime binding differs from the sealed Evaluator configuration.',
      );
    }
    const resolved = await resolveInvocation(context);
    const invocation = captureLlmJudgeInvocationPort(resolved.port);
    if (invocation.identity.implementationId !== config.runtime.executorId) {
      return failure(
        'omk-rubric-judge-provider-identity-mismatch',
        'LLM judge invocation Runtime identity differs from the selected executor.',
      );
    }
    return {
      port: createSameProcessEvaluatorAdapter({
        identity: createRubricJudgeEvaluatorIdentity({
          instrument: config.evaluator.value,
          runtime: config.runtime,
          invocation,
        }),
        sessionIsolationKey: context.sessionIsolationKey,
        resourceLeases: context.resourceLeases,
        implementation: createRubricJudgeEvaluatorImplementation(invocation, {
          instrument: config.evaluator.value,
          runtime: config.runtime,
        }),
      }),
      satisfiesVersionConstraint: true,
      preflightDeclarations: resolved.preflightDeclarations,
    };
  };
}
