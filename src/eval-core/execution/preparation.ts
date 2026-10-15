/** Runtime binding validation before run resources are opened. */
import { IdentifierSchema, canonicalizeJson, type RuntimeIdentity } from '../contracts/index.js';
import { ExecutorCapabilitiesSchema, type ProtocolManifest, type SealedRunPlan } from '../compiler/index.js';
import { Semaphore } from './semaphore.js';
import {
  ExecutionRuntimeConfigurationError,
  type ExecutionExecutor,
  type ExecutionRunOptions,
  type ExecutionRuntimePorts,
} from './types.js';
import type { PreparedRuntime } from './runtime-state.js';


function configurationError(code: string, message: string): never {
  throw new ExecutionRuntimeConfigurationError(code, message);
}

function validateOptions(options: ExecutionRunOptions): void {
  const runId = IdentifierSchema.safeParse(options.runId);
  const bundleId = IdentifierSchema.safeParse(options.bundleId);
  if (!runId.success || !bundleId.success) {
    configurationError(
      'EXECUTION_RUNTIME_IDENTIFIER_INVALID',
      'runId and bundleId must be valid Evaluation Core identifiers.',
    );
  }
  if (options.eventBufferCapacity !== undefined
      && (!Number.isSafeInteger(options.eventBufferCapacity)
        || options.eventBufferCapacity < 1)) {
    configurationError(
      'EXECUTION_RUNTIME_EVENT_BUFFER_INVALID',
      'eventBufferCapacity must be a positive safe integer.',
    );
  }
}

function resolvedRuntimeByTarget(plan: SealedRunPlan): Map<string, RuntimeIdentity> {
  const result = new Map<string, RuntimeIdentity>();
  for (const runtime of plan.execution.runtimes) {
    if (runtime.runtimeKind !== 'executor') continue;
    if (result.has(runtime.referenceId)) {
      configurationError(
        'EXECUTION_RUNTIME_BINDING_INVALID',
        `ExecutionPlan contains duplicate Runtime binding for ${runtime.referenceId}.`,
      );
    }
    result.set(runtime.referenceId, runtime.identity as RuntimeIdentity);
  }
  return result;
}

function protocolForTarget(
  targetId: string,
  protocolId: string,
  runtime: RuntimeIdentity,
): ProtocolManifest {
  const capabilities = ExecutorCapabilitiesSchema.safeParse(runtime.capabilities);
  if (!capabilities.success) {
    configurationError(
      'EXECUTION_RUNTIME_CAPABILITY_INVALID',
      `Sealed Runtime capabilities for ${targetId} are invalid.`,
    );
  }
  const protocol = capabilities.data.protocols.find(
    (candidate) => candidate.protocolId === protocolId,
  );
  if (protocol === undefined) {
    configurationError(
      'EXECUTION_RUNTIME_CAPABILITY_INVALID',
      `Sealed Runtime for ${targetId} does not contain its protocol manifest.`,
    );
  }
  return protocol;
}

export function prepareRuntime(
  plan: SealedRunPlan,
  ports: ExecutionRuntimePorts,
  options: ExecutionRunOptions,
): PreparedRuntime {
  validateOptions(options);
  if (ports.eventSequencer === undefined) {
    configurationError(
      'EXECUTION_RUNTIME_EVENT_SEQUENCER_REQUIRED',
      'Execution runtime requires a shared per-Run EventSequencer.',
    );
  }
  const cacheMode = plan.execution.policy.executionCacheMode;
  if (cacheMode !== 'disabled' && ports.cache === undefined) {
    configurationError(
      'EXECUTION_RUNTIME_CACHE_REQUIRED',
      `Execution cache mode ${cacheMode} requires an injected cache port.`,
    );
  }
  const evidence = plan.measurementPolicy.evidence;
  if ((evidence.output === 'reference' || evidence.trace === 'reference')
      && ports.contentStore === undefined) {
    configurationError(
      'EXECUTION_RUNTIME_CONTENT_STORE_REQUIRED',
      'Reference evidence capture requires an injected ContentStore.',
    );
  }
  const delivery = plan.measurementPolicy.eventDelivery;
  if (delivery.writerMode === 'required' && ports.eventWriter === undefined) {
    configurationError(
      'EXECUTION_RUNTIME_EVENT_WRITER_REQUIRED',
      'Required EventWriter mode needs an injected EventWriter.',
    );
  }

  const expectedRuntimes = resolvedRuntimeByTarget(plan);
  const executorLimits = new Map<ExecutionExecutor, number>();
  const partialBindings: Array<{
    target: SealedRunPlan['execution']['targets'][number];
    executor: ExecutionExecutor;
    runtime: RuntimeIdentity;
    protocol: ProtocolManifest;
  }> = [];
  for (const target of plan.execution.targets) {
    const executor = ports.executorsByTargetId.get(target.targetId);
    if (executor === undefined) {
      configurationError(
        'EXECUTION_RUNTIME_EXECUTOR_MISSING',
        `No Executor binding is registered for Target ${target.targetId}.`,
      );
    }
    const expectedRuntime = expectedRuntimes.get(target.targetId);
    if (expectedRuntime === undefined
        || canonicalizeJson(executor.identity) !== canonicalizeJson(expectedRuntime)) {
      configurationError(
        'EXECUTION_RUNTIME_IDENTITY_MISMATCH',
        `Executor identity for ${target.targetId} differs from the sealed ExecutionPlan.`,
      );
    }
    const protocol = protocolForTarget(target.targetId, target.protocolId, expectedRuntime);
    const budgetPolicy = plan.measurementPolicy.budget;
    const executionCostBudgetConfigured = budgetPolicy.run.maxProviderCost !== undefined
      || budgetPolicy.stages.execution.maxProviderCost !== undefined
      || budgetPolicy.coordinate.maxProviderCost !== undefined
      || budgetPolicy.attempt.maxProviderCost !== undefined;
    if (executionCostBudgetConfigured
        && budgetPolicy.providerCostAdmission.admissionMode === 'strict-reservation'
        && (expectedRuntime.assuranceLevel !== 'verified'
          || protocol.execution.telemetry.providerCost?.reporting !== 'required'
          || protocol.execution.telemetry.providerCost.trustedUpperBound === undefined)) {
      configurationError(
        'EXECUTION_RUNTIME_PROVIDER_COST_BOUND_REQUIRED',
        `Strict provider-cost admission requires a verified upper bound for ${target.targetId}.`,
      );
    }
    const capabilityLimit = protocol.execution.concurrency.safety === 'serialized'
      ? 1
      : (protocol.execution.concurrency.maxInFlight
        ?? plan.execution.policy.execution.maxConcurrency);
    const currentLimit = executorLimits.get(executor);
    executorLimits.set(
      executor,
      currentLimit === undefined ? capabilityLimit : Math.min(currentLimit, capabilityLimit),
    );
    partialBindings.push({ target, executor, runtime: expectedRuntime, protocol });
  }
  const semaphores = new Map(
    [...executorLimits].map(([executor, limit]) => [executor, new Semaphore(limit)]),
  );
  return {
    bindings: new Map(partialBindings.map((binding) => [binding.target.targetId, {
      ...binding,
      semaphore: semaphores.get(binding.executor) as Semaphore,
    }])),
    globalSemaphore: new Semaphore(plan.execution.policy.execution.maxConcurrency),
  };
}
