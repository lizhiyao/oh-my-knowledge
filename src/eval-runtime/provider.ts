import {
  prepareEvaluationSeriesPlan,
  type EvaluationSeriesDefinition,
  type EvaluationSeriesMemberSource,
  type EvaluationSeriesPlan,
} from '../eval-core/contracts/index.js';
import {
  runEvaluationSeries,
  type EvaluationSeriesRuntimePorts,
  type EvaluationSeriesRunOptions,
  type EvaluationSeriesRunResult,
} from '../eval-core/series/index.js';
import type { EvaluationExecutionInput, PreparedEvaluationExecution } from './execution.js';

export interface EvaluationPreparationOptions {
  readonly signal?: AbortSignal;
}

/** Readiness evidence from the host; never part of the sealed measurement identity. */
export interface EvaluationReadinessRecord {
  readonly runtimeKind: 'executor' | 'evaluator' | 'analysis-node' | 'missing-policy'
    | 'decision-policy' | 'series-analysis-node' | 'series-decision-policy';
  readonly bindingId: string;
  readonly referenceId: string;
  readonly implementationId: string;
  readonly preflightKind: 'doctor' | 'credential' | 'connectivity' | 'filesystem'
    | 'mcp-readiness' | 'mock-readiness';
  readonly checkId: string;
  readonly preflightStatus: 'passed' | 'skipped' | 'not-required';
  readonly reasonCode?: string;
}

export interface EvaluationReadiness {
  readonly records: readonly EvaluationReadinessRecord[];
}

export interface PreparedRuntimeEvaluation extends PreparedEvaluationExecution {
  readonly preflight: EvaluationReadiness;
}

export interface PreparedRuntimeSeries {
  readonly plan: EvaluationSeriesPlan;
  run(
    sources: readonly EvaluationSeriesMemberSource[],
    options: Readonly<EvaluationSeriesRunOptions>,
  ): Promise<EvaluationSeriesRunResult>;
}

/** Hosts inject this capability. Products neither construct adapters nor manage their leases. */
export interface EvaluationRuntimeProvider {
  prepare(
    input: Readonly<EvaluationExecutionInput>,
    options?: Readonly<EvaluationPreparationOptions>,
  ): Promise<PreparedRuntimeEvaluation>;
  prepareSeries(definition: EvaluationSeriesDefinition): Promise<PreparedRuntimeSeries>;
}

/** Runtime is the execution boundary; Core still validates and executes every Series contract. */
export function prepareRuntimeSeries(input: Readonly<{
  definition: EvaluationSeriesDefinition;
  runtimes: Parameters<typeof prepareEvaluationSeriesPlan>[1];
  ports: EvaluationSeriesRuntimePorts;
}>): PreparedRuntimeSeries {
  const plan = prepareEvaluationSeriesPlan(input.definition, input.runtimes);
  const ports = input.ports;
  return Object.freeze({
    plan,
    run(sources: readonly EvaluationSeriesMemberSource[], options: Readonly<EvaluationSeriesRunOptions>) {
      return runEvaluationSeries(plan, sources, ports, options);
    },
  });
}
