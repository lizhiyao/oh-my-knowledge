/** Runtime binding validation before run resources are opened. */
import {
  IdentifierSchema,
  canonicalizeJson,
  type ExecutionBundleSource,
  type RuntimeIdentity,
} from '../contracts/index.js';
import { assertExecutionBundleSourceMatchesPlan } from '../verify/index.js';
import type { SealedRunPlan } from '../compiler/index.js';
import { EvaluatorCapabilitiesSchema } from '../compiler/index.js';
import { EvaluationRuntimeConfigurationError, type EvaluationRunOptions, type EvaluationRuntimePorts } from './types.js';
import type { EvaluatorBinding, PreparedRuntime } from './runtime-state.js';


function configurationError(code: string, message: string): never {
  throw new EvaluationRuntimeConfigurationError(code, message);
}

function validateOptions(options: EvaluationRunOptions): void {
  if (!IdentifierSchema.safeParse(options.runId).success
      || !IdentifierSchema.safeParse(options.bundleId).success) {
    configurationError(
      'EVALUATION_RUNTIME_IDENTIFIER_INVALID',
      'runId and bundleId must be valid Evaluation Core identifiers.',
    );
  }
  if (options.eventBufferCapacity !== undefined
      && (!Number.isSafeInteger(options.eventBufferCapacity)
        || options.eventBufferCapacity < 1)) {
    configurationError(
      'EVALUATION_RUNTIME_EVENT_BUFFER_INVALID',
      'eventBufferCapacity must be a positive safe integer.',
    );
  }
}

export function prepareRuntime(
  plan: SealedRunPlan,
  source: ExecutionBundleSource,
  ports: EvaluationRuntimePorts,
  options: EvaluationRunOptions,
): PreparedRuntime {
  validateOptions(options);
  if (ports.eventSequencer === undefined) {
    configurationError(
      'EVALUATION_RUNTIME_EVENT_SEQUENCER_REQUIRED',
      'Evaluation runtime requires a shared per-Run EventSequencer.',
    );
  }
  assertExecutionBundleSourceMatchesPlan(source, plan);
  if (plan.evaluation.policy.evaluationCacheMode !== 'disabled' && ports.cache === undefined) {
    configurationError(
      'EVALUATION_RUNTIME_CACHE_REQUIRED',
      'Evaluation cache reuse requires an injected EvaluationCache.',
    );
  }
  if (plan.measurementPolicy.evidence.evidence === 'reference'
      && ports.contentStore === undefined) {
    configurationError(
      'EVALUATION_RUNTIME_CONTENT_STORE_REQUIRED',
      'Reference evidence capture requires an injected EvaluationContentStore.',
    );
  }
  if (plan.measurementPolicy.eventDelivery.writerMode === 'required'
      && ports.eventWriter === undefined) {
    configurationError(
      'EVALUATION_RUNTIME_EVENT_WRITER_REQUIRED',
      'Required EventWriter mode needs an injected EventWriter.',
    );
  }
  const runtimes = new Map<string, RuntimeIdentity>();
  for (const runtime of plan.evaluation.runtimes) {
    if (runtime.runtimeKind !== 'evaluator') continue;
    if (runtimes.has(runtime.referenceId)) {
      configurationError(
        'EVALUATION_RUNTIME_BINDING_INVALID',
        `EvaluationPlan contains duplicate Runtime binding for ${runtime.referenceId}.`,
      );
    }
    runtimes.set(runtime.referenceId, runtime.identity as RuntimeIdentity);
  }
  const bindings = new Map<string, EvaluatorBinding>();
  for (const evaluator of plan.evaluation.evaluators) {
    const port = ports.evaluatorsByEvaluatorId.get(evaluator.evaluatorId);
    const runtime = runtimes.get(evaluator.evaluatorId);
    if (port === undefined) {
      configurationError(
        'EVALUATION_RUNTIME_EVALUATOR_MISSING',
        `No Evaluator binding is registered for ${evaluator.evaluatorId}.`,
      );
    }
    if (runtime === undefined
        || canonicalizeJson(port.identity) !== canonicalizeJson(runtime)) {
      configurationError(
        'EVALUATION_RUNTIME_IDENTITY_MISMATCH',
        `Evaluator identity for ${evaluator.evaluatorId} differs from the sealed plan.`,
      );
    }
    const capabilities = EvaluatorCapabilitiesSchema.safeParse(runtime.capabilities);
    const budgetPolicy = plan.measurementPolicy.budget;
    const evaluationCostBudgetConfigured = budgetPolicy.run.maxProviderCost !== undefined
      || budgetPolicy.stages.evaluation.maxProviderCost !== undefined
      || budgetPolicy.coordinate.maxProviderCost !== undefined
      || budgetPolicy.attempt.maxProviderCost !== undefined;
    if (evaluationCostBudgetConfigured
        && budgetPolicy.providerCostAdmission.admissionMode === 'strict-reservation'
        && (runtime.assuranceLevel !== 'verified'
          || !capabilities.success
          || capabilities.data.providerCost?.reporting !== 'required'
          || capabilities.data.providerCost.trustedUpperBound === undefined)) {
      configurationError(
        'EVALUATION_RUNTIME_PROVIDER_COST_BOUND_REQUIRED',
        `Strict provider-cost admission requires a verified upper bound for ${evaluator.evaluatorId}.`,
      );
    }
    bindings.set(evaluator.evaluatorId, { evaluator, port, runtime });
  }
  return { bindings, source };
}
