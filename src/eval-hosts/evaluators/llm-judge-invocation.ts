export {
  assertLlmJudgeInvocationResult,
  captureLlmJudgeInvocationPort,
  parseLlmJudgeUsage,
  redactLlmJudgeFailureUsage,
  type OmkLlmJudgeEffort,
  type OmkLlmJudgeInvocationPort,
  type OmkLlmJudgeInvocationRequest,
  type OmkLlmJudgeInvocationResult,
} from '../../eval-runtime/judges/invocation.js';

import type { OmkLlmJudgeInvocationPort } from '../../eval-runtime/judges/invocation.js';
import type {
  OmkEvaluatorBindingContext,
  OmkRuntimePreflightDeclaration,
} from '../types.js';

export interface OmkLlmJudgeInvocationBinding {
  readonly port: OmkLlmJudgeInvocationPort;
  readonly preflightDeclarations: readonly OmkRuntimePreflightDeclaration[];
}

export type OmkLlmJudgeInvocationResolver = (
  context: Readonly<OmkEvaluatorBindingContext>,
) => OmkLlmJudgeInvocationBinding | Promise<OmkLlmJudgeInvocationBinding>;
