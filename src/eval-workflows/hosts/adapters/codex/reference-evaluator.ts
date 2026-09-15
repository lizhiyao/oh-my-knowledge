import { deepFreezeCanonicalJson } from '../../../../eval-core/contracts/index.js';
import type { Judge, RubricJudgeEvaluator } from '../../../../eval-runtime/evaluation/contracts.js';
import type { OmkLlmJudgeInvocationRequest } from '../../../../eval-runtime/judges/invocation.js';
import {
  createCodexCliReferenceRuntime,
  type CreateCodexCliReferenceExecutorInput,
} from './reference-executor.js';

export interface CreateCodexCliReferenceEvaluatorInput
  extends Omit<CreateCodexCliReferenceExecutorInput, 'executorId' | 'sandbox'>,
    Omit<RubricJudgeEvaluator, 'evaluatorKind' | 'judges' | 'aggregation'> {
  readonly judgeId: string;
}

/** Ready for evaluate(); the standard rubric pipeline owns prompts, parsing and score semantics. */
export async function createCodexCliReferenceEvaluator(
  input: Readonly<CreateCodexCliReferenceEvaluatorInput>,
): Promise<RubricJudgeEvaluator> {
  const { judgeId, evaluatorId, rubrics, lengthDebias, tracePolicy,
    actualPointer, tracePointer, classification, ...configuration } = input;
  const evaluator = deepFreezeCanonicalJson({
    evaluatorKind: 'rubric-judge' as const,
    evaluatorId,
    rubrics: rubrics.map((rubric) => ({ ...rubric })),
    aggregation: { method: 'mean' as const, missing: 'require-complete' as const },
    ...(lengthDebias === undefined ? {} : { lengthDebias }),
    ...(tracePolicy === undefined ? {} : { tracePolicy }),
    ...(actualPointer === undefined ? {} : { actualPointer }),
    ...(tracePointer === undefined ? {} : { tracePointer }),
    ...(classification === undefined ? {} : { classification }),
  });
  const runtime = await createCodexCliReferenceRuntime({
    ...configuration, executorId: judgeId, sandbox: 'read-only',
  }, {
    version: 'omk.codex-cli-rubric-prepended/v2',
    system: 'prepended-with-separator',
    task: 'rubric-prompt-verbatim',
  });
  const { model, effort } = runtime.configuration;
  const judge: Judge = Object.freeze({
    judgeId,
    version: runtime.version,
    providerCost: Object.freeze({ reporting: 'unsupported' as const }),
    fingerprintFacets: deepFreezeCanonicalJson(runtime.fingerprintFacets),
    async invoke(request: Readonly<OmkLlmJudgeInvocationRequest>) {
      if (request.executorId !== judgeId || request.model !== model || request.effort !== effort) {
        return { invocationStatus: 'failed' as const, reasonCode: 'OMK_CODEX_CLI_JUDGE_BINDING_MISMATCH' };
      }
      const result = await runtime.invokePrompt(
        `${request.system}\n\n---\n\n${request.prompt}`, request.signal,
      );
      const usage = result.usage === undefined ? {} : { usage: result.usage };
      return result.errorCode !== undefined || result.output === undefined
        ? { invocationStatus: 'failed' as const,
            reasonCode: result.errorCode ?? 'OMK_CODEX_CLI_JUDGE_OUTPUT_MISSING', ...usage }
        : { invocationStatus: 'completed' as const, output: result.output, ...usage };
    },
  });
  return Object.freeze({
    ...evaluator,
    judges: Object.freeze([Object.freeze({
      memberId: 'primary', model, judge, ...(effort === undefined ? {} : { effort }),
    })]),
  });
}
