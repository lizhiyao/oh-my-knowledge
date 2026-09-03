import {
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
  resolveBuiltinAnalysisRuntime,
} from '../eval-core/analysis/index.js';
import type {
  AnalysisRuntimeRequirement,
  EvaluatorRuntimeRequirement,
  ExecutorRuntimeRequirement,
} from '../eval-core/compiler/index.js';
import type {
  EvaluationEngineRuntime,
  EvaluationEngineClock,
  Evaluator,
  Executor,
} from '../eval-core/engine/index.js';
import { createNodeEvaluationClock } from './clock.js';

interface RuntimePortRegistrationBase {
  /** Omit to fail closed whenever a Definition declares a version constraint. */
  readonly satisfiesVersionConstraint?: (constraint: string) => boolean;
}

export type RuntimePortRegistration<Port, BindingRequirement = unknown> =
  RuntimePortRegistrationBase & (
  | {
      /** Use for a port that will be bound exactly once in one Definition. */
      readonly port: Port;
      readonly implementationId?: never;
      readonly createPort?: never;
    }
  | {
      /** Use a factory when multiple Definition bindings share one implementation. */
      readonly implementationId: string;
      readonly createPort: (requirement: Readonly<BindingRequirement>) => Port;
      readonly port?: never;
    }
);

export interface CreateEvaluationRuntimeInput {
  readonly executors: readonly RuntimePortRegistration<Executor, ExecutorRuntimeRequirement>[];
  readonly evaluators: readonly RuntimePortRegistration<Evaluator, EvaluatorRuntimeRequirement>[];
  readonly clock?: EvaluationEngineClock;
  /** Optional host-owned in-memory or durable artifact/cache ports. */
  readonly support?: EvaluationRuntimeSupportPorts;
}

export type EvaluationRuntimeSupportPorts = Pick<
  EvaluationEngineRuntime,
  | 'executionCache'
  | 'evaluationCache'
  | 'executionContentStore'
  | 'evaluationContentStore'
  | 'contentResolver'
>;

export class EvaluationRuntimeAssemblyError extends TypeError {
  readonly code:
    | 'EVAL_RUNTIME_DUPLICATE_IMPLEMENTATION'
    | 'EVAL_RUNTIME_INVALID_REGISTRATION'
    | 'EVAL_RUNTIME_IMPLEMENTATION_NOT_FOUND'
    | 'EVAL_RUNTIME_ANALYSIS_NOT_FOUND';

  constructor(code: EvaluationRuntimeAssemblyError['code'], message: string) {
    super(message);
    this.name = 'EvaluationRuntimeAssemblyError';
    this.code = code;
  }
}

function registry<
  Port extends { readonly identity: { readonly implementationId: string } },
  BindingRequirement,
>(
  entries: readonly RuntimePortRegistration<Port, BindingRequirement>[],
  runtimeKind: 'Executor' | 'Evaluator',
): ReadonlyMap<string, RuntimePortRegistration<Port, BindingRequirement>> {
  const result = new Map<string, RuntimePortRegistration<Port, BindingRequirement>>();
  for (const entry of entries) {
    const implementationId = entry.port?.identity.implementationId ?? entry.implementationId;
    if (implementationId === undefined) {
      throw new EvaluationRuntimeAssemblyError(
        'EVAL_RUNTIME_INVALID_REGISTRATION',
        `${runtimeKind} Runtime registration 缺少 port 或 implementationId。`,
      );
    }
    if (result.has(implementationId)) {
      throw new EvaluationRuntimeAssemblyError(
        'EVAL_RUNTIME_DUPLICATE_IMPLEMENTATION',
        `${runtimeKind} Runtime implementationId 重复：“${implementationId}”。`,
      );
    }
    result.set(implementationId, Object.freeze({ ...entry }));
  }
  return result;
}

function port<
  Port extends { readonly identity: { readonly implementationId: string } },
  BindingRequirement,
>(
  registration: RuntimePortRegistration<Port, BindingRequirement>,
  expectedImplementationId: string,
  requirement: Readonly<BindingRequirement>,
): Port {
  let resolved = registration.port;
  if (resolved === undefined) {
    if (registration.createPort === undefined) {
      throw new EvaluationRuntimeAssemblyError(
        'EVAL_RUNTIME_INVALID_REGISTRATION',
        `Runtime registration 缺少 port factory：“${expectedImplementationId}”。`,
      );
    }
    resolved = registration.createPort(requirement);
  }
  if (resolved.identity.implementationId !== expectedImplementationId) {
    throw new EvaluationRuntimeAssemblyError(
      'EVAL_RUNTIME_IMPLEMENTATION_NOT_FOUND',
      `Runtime factory 返回了不匹配的 implementationId：“${resolved.identity.implementationId}”。`,
    );
  }
  return resolved;
}

function versionSatisfied<Port, BindingRequirement>(
  registration: RuntimePortRegistration<Port, BindingRequirement>,
  constraint: string | undefined,
): boolean {
  if (constraint === undefined) return true;
  return registration.satisfiesVersionConstraint?.(constraint) ?? false;
}

function missing(runtimeKind: 'Executor' | 'Evaluator', implementationId: string): never {
  throw new EvaluationRuntimeAssemblyError(
    'EVAL_RUNTIME_IMPLEMENTATION_NOT_FOUND',
    `未注册 ${runtimeKind} Runtime：“${implementationId}”。`,
  );
}

/**
 * Assembles a host-neutral Core Runtime from explicit ports plus Core built-ins.
 * It performs no filesystem, environment, provider, CLI, Studio, or MCP discovery.
 */
export function createEvaluationRuntime(
  input: Readonly<CreateEvaluationRuntimeInput>,
): EvaluationEngineRuntime {
  const executors = registry(input.executors, 'Executor');
  const evaluators = registry(input.evaluators, 'Evaluator');
  const analysisNodes = createBuiltinAnalysisNodes();
  const missingPolicies = createBuiltinMissingPolicies();
  const decisionPolicies = createBuiltinDecisionPolicies();

  return Object.freeze({
    ...(input.support ?? {}),
    clock: input.clock ?? createNodeEvaluationClock(),
    schemaValidators: createBuiltinAnalysisSchemaValidators(),
    bindings: Object.freeze({
      resolveExecutor(requirement: Readonly<ExecutorRuntimeRequirement>) {
        const registration = executors.get(requirement.executorId)
          ?? missing('Executor', requirement.executorId);
        const executor = port(registration, requirement.executorId, requirement);
        return {
          runtimeKind: 'executor' as const,
          resolution: {
            identity: executor.identity,
            satisfiesVersionConstraint: versionSatisfied(
              registration,
              requirement.versionConstraint,
            ),
          },
          port: executor,
        };
      },
      resolveEvaluator(requirement: Readonly<EvaluatorRuntimeRequirement>) {
        const registration = evaluators.get(requirement.implementationId)
          ?? missing('Evaluator', requirement.implementationId);
        const evaluator = port(registration, requirement.implementationId, requirement);
        return {
          runtimeKind: 'evaluator' as const,
          resolution: {
            identity: evaluator.identity,
            satisfiesVersionConstraint: versionSatisfied(
              registration,
              requirement.versionConstraint,
            ),
          },
          port: evaluator,
        };
      },
      resolveAnalysis(requirement: Readonly<AnalysisRuntimeRequirement>) {
        const resolution = resolveBuiltinAnalysisRuntime(requirement);
        if (resolution === undefined) {
          throw new EvaluationRuntimeAssemblyError(
            'EVAL_RUNTIME_ANALYSIS_NOT_FOUND',
            `eval-runtime 未注册 Analysis Runtime：“${requirement.implementationId}”。`,
          );
        }
        if (requirement.requirementKind === 'missing-policy') {
          const port = missingPolicies.get(requirement.implementationId);
          if (port === undefined) throw new EvaluationRuntimeAssemblyError(
            'EVAL_RUNTIME_ANALYSIS_NOT_FOUND',
            `eval-runtime 未注册 MissingPolicy：“${requirement.implementationId}”。`,
          );
          return { runtimeKind: 'missing-policy' as const, resolution, port };
        }
        if (requirement.requirementKind === 'decision-policy') {
          const port = decisionPolicies.get(requirement.implementationId);
          if (port === undefined) throw new EvaluationRuntimeAssemblyError(
            'EVAL_RUNTIME_ANALYSIS_NOT_FOUND',
            `eval-runtime 未注册 DecisionPolicy：“${requirement.implementationId}”。`,
          );
          return { runtimeKind: 'decision-policy' as const, resolution, port };
        }
        const port = analysisNodes.get(requirement.implementationId);
        if (port === undefined) throw new EvaluationRuntimeAssemblyError(
          'EVAL_RUNTIME_ANALYSIS_NOT_FOUND',
          `eval-runtime 未注册 AnalysisNode：“${requirement.implementationId}”。`,
        );
        return { runtimeKind: 'analysis-node' as const, resolution, port };
      },
    }),
  });
}
