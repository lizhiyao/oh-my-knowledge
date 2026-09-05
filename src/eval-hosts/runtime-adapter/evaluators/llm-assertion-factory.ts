import { EvaluationPortFailure } from '../../../eval-core/evaluation/index.js';
import { createSameProcessEvaluatorAdapter } from '../../../eval-runtime/adapters/same-process.js';
import { captureLlmJudgeInvocationPort } from '../../../eval-runtime/judges/invocation.js';
import type { OmkEvaluatorBindingContext, OmkRuntimePortBinding } from '../types.js';
import type { OmkLlmJudgeInvocationResolver } from './llm-judge-invocation.js';
import {
  parseLlmAssertionConfig,
  createLlmAssertionEvaluatorIdentity,
  createLlmAssertionEvaluatorImplementation,
} from '../../../eval-workflows/measurement/evaluators/llm-assertions.js';
export type { OmkLlmJudgeInvocationPort, OmkLlmJudgeInvocationRequest, OmkLlmJudgeInvocationBinding, OmkLlmJudgeInvocationResolver } from './llm-judge-invocation.js';

function failure(code: string, message: string): never {
  throw new EvaluationPortFailure({ code, stage: 'evaluation', message });
}

/** Builds the host factory without introducing a second control plane for model calls. */
export function createLlmAssertionEvaluatorBindingFactory(
  resolveInvocation: OmkLlmJudgeInvocationResolver,
): (
  context: Readonly<OmkEvaluatorBindingContext>,
) => Promise<OmkRuntimePortBinding<ReturnType<typeof createSameProcessEvaluatorAdapter>>> {
  return async (context) => {
    const config = parseLlmAssertionConfig(context.evaluator.config);
    const qualification = context.binding.qualification;
    if (context.evaluator.measurement.instrumentId !== config.evaluator.value.promptId
        || qualification === undefined
        || qualification.executorId !== config.runtime.executorId
        || qualification.model !== config.runtime.model
        || qualification.deploymentRevision !== config.runtime.deploymentRevision
        || qualification.effort !== config.runtime.effort
        || qualification.promptVariant !== config.runtime.promptVariant) {
      return failure(
        'omk-llm-assertion-runtime-binding-mismatch',
        'LLM assertion Runtime binding differs from the sealed Evaluator configuration.',
      );
    }
    const resolved = await resolveInvocation(context);
    const invocation = captureLlmJudgeInvocationPort(resolved.port);
    if (invocation.identity.implementationId !== config.runtime.executorId) {
      return failure(
        'omk-llm-assertion-provider-identity-mismatch',
        'LLM judge invocation Runtime identity differs from the selected executor.',
      );
    }
    const identity = createLlmAssertionEvaluatorIdentity({
      instrument: config.evaluator.value,
      runtime: config.runtime,
      invocation,
    });
    return {
      port: createSameProcessEvaluatorAdapter({
        identity,
        sessionIsolationKey: context.sessionIsolationKey,
        resourceLeases: context.resourceLeases,
        implementation: createLlmAssertionEvaluatorImplementation(invocation),
      }),
      satisfiesVersionConstraint: true,
      preflightDeclarations: resolved.preflightDeclarations,
    };
  };
}
