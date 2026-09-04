import type { JsonValue } from '../../eval-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutionExecutor,
  type ExecutionExecutorRun,
  type ExecutionExecutorTrial,
  type ExecutorAttemptContext,
  type ExecutorRunContext,
  type ExecutorTrialContext,
} from '../../eval-core/execution/index.js';
import type { EvaluationRunResult, Executor } from '../../eval-core/engine/index.js';
import {
  invokeProtocol,
  validateInvokeFailureTelemetry,
  validateInvokeTelemetry,
} from '../adapters/invoke-contract.js';
import { createExactMatchDefinition } from '../builders/exact-match.js';
import { createMeasurementPolicy } from '../builders/policy.js';
import { createExactMatchEvaluator } from '../evaluators/exact-match.js';
import { runEvaluation } from '../runner.js';
import { createEvaluationRuntime } from '../runtime.js';

export interface ExecutorConformanceProbeCase {
  readonly input: JsonValue;
  readonly targetConfig?: JsonValue;
}

export interface ExecutorConformanceProbeInput {
  readonly implementationId: string;
  /** A fresh Core Executor is required for each Target binding and probe phase. */
  readonly createExecutor: (targetId: string) => Executor;
  readonly success: ExecutorConformanceProbeCase & { readonly expected: JsonValue };
  /** Must make the host return the declared stable failure code without leaking private details. */
  readonly failure: ExecutorConformanceProbeCase & { readonly expectedErrorCode: string };
  /** Must be bounded when cancellation is ignored; conformance does not isolate hostile code. */
  readonly cancellation: ExecutorConformanceProbeCase;
  readonly seed?: string;
  readonly runId?: string;
}

export interface RuntimeConformanceCheck {
  readonly checkId:
    | 'configuration'
    | 'binding-isolation'
    | 'lifecycle-cleanup'
    | 'cancellation-contract'
    | 'telemetry-contract'
    | 'failure-contract'
    | 'terminal-status'
    | 'execution-coverage'
    | 'evaluation-observation'
    | 'paired-analysis'
    | 'decision';
  readonly checkStatus: 'passed' | 'failed';
  readonly reasonCode?: string;
}

export interface ExecutorConformanceResult {
  readonly conformant: boolean;
  readonly checks: readonly RuntimeConformanceCheck[];
  /** Successful probe run retained for artifact and measurement inspection. */
  readonly run?: EvaluationRunResult;
}

export class RuntimeConformanceError extends TypeError {
  readonly code = 'EVAL_RUNTIME_CONFORMANCE_FAILED' as const;
  readonly failedCheckIds: readonly RuntimeConformanceCheck['checkId'][];

  constructor(result: Readonly<ExecutorConformanceResult>) {
    const failedCheckIds = result.checks
      .filter((check) => check.checkStatus === 'failed')
      .map((check) => check.checkId);
    super(`Runtime conformance failed: ${failedCheckIds.join(', ')}.`);
    this.name = 'RuntimeConformanceError';
    this.failedCheckIds = Object.freeze(failedCheckIds);
  }
}

type ProbePhase = 'success' | 'failure' | 'cancellation';

interface LifecycleObservation {
  readonly phase: ProbePhase;
  readonly executor: ExecutionExecutor;
  openRuns: number;
  disposedRuns: number;
  openTrials: number;
  disposedTrials: number;
}

interface ProbeObservations {
  phase: ProbePhase;
  readonly lifecycles: LifecycleObservation[];
  readonly attemptSignals: boolean[];
  readonly telemetry: boolean[];
  cancellationAttemptObserved: boolean;
  cancellationRejected: boolean;
  cancellationController?: AbortController;
}

function check(
  checkId: RuntimeConformanceCheck['checkId'],
  passed: boolean,
  reasonCode: string,
): RuntimeConformanceCheck {
  return Object.freeze({
    checkId,
    checkStatus: passed ? 'passed' : 'failed',
    ...(passed ? {} : { reasonCode }),
  });
}

function instrumentTrial(
  trial: ExecutionExecutorTrial,
  lifecycle: LifecycleObservation,
  observations: ProbeObservations,
): ExecutionExecutorTrial {
  return Object.freeze({
    async execute(context: Readonly<ExecutorAttemptContext>) {
      observations.attemptSignals.push(context.signal instanceof AbortSignal);
      const cancellationAttempt = observations.phase === 'cancellation'
        && !observations.cancellationAttemptObserved;
      if (cancellationAttempt) {
        observations.cancellationAttemptObserved = true;
      }
      try {
        const execution = trial.execute(context);
        if (cancellationAttempt) {
          observations.cancellationController?.abort('runtime-conformance-cancellation');
        }
        const result = await execution;
        if (observations.phase === 'cancellation') {
          observations.cancellationRejected = false;
        }
        try {
          validateInvokeTelemetry(invokeProtocol(lifecycle.executor.identity), result);
          observations.telemetry.push(true);
        } catch {
          observations.telemetry.push(false);
        }
        return result;
      } catch (error) {
        if (observations.phase === 'cancellation' && context.signal.aborted) {
          observations.cancellationRejected = true;
        }
        if (error instanceof ExecutionPortFailure
            && error.evaluationError.code === 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION') {
          observations.telemetry.push(false);
        } else if (error instanceof ExecutionPortFailure) {
          try {
            validateInvokeFailureTelemetry(
              invokeProtocol(lifecycle.executor.identity),
              error.usage,
            );
            observations.telemetry.push(true);
          } catch {
            observations.telemetry.push(false);
          }
        }
        throw error;
      }
    },
    async dispose() {
      await trial.dispose();
      lifecycle.disposedTrials += 1;
    },
  });
}

function instrumentRun(
  run: ExecutionExecutorRun,
  lifecycle: LifecycleObservation,
  observations: ProbeObservations,
): ExecutionExecutorRun {
  return Object.freeze({
    async openTrial(context: Readonly<ExecutorTrialContext>) {
      const trial = await run.openTrial(context);
      lifecycle.openTrials += 1;
      return instrumentTrial(trial, lifecycle, observations);
    },
    async dispose() {
      await run.dispose();
      lifecycle.disposedRuns += 1;
    },
  });
}

function instrumentExecutor(
  executor: ExecutionExecutor,
  observations: ProbeObservations,
): ExecutionExecutor {
  const lifecycle: LifecycleObservation = {
    phase: observations.phase,
    executor,
    openRuns: 0,
    disposedRuns: 0,
    openTrials: 0,
    disposedTrials: 0,
  };
  observations.lifecycles.push(lifecycle);
  return Object.freeze({
    identity: executor.identity,
    async openRun(context: Readonly<ExecutorRunContext>) {
      const run = await executor.openRun(context);
      lifecycle.openRuns += 1;
      return instrumentRun(run, lifecycle, observations);
    },
  });
}

function definition(
  input: Readonly<ExecutorConformanceProbeInput>,
  phase: ProbePhase,
  probe: Readonly<ExecutorConformanceProbeCase>,
  expected: JsonValue,
) {
  const target = (targetId: 'control' | 'treatment') => ({
    targetId,
    executorId: input.implementationId,
    ...(probe.targetConfig === undefined
      ? {}
      : { config: structuredClone(probe.targetConfig) }),
  });
  return createExactMatchDefinition({
    datasetId: `eval-runtime-conformance-${phase}`,
    seed: input.seed ?? 'eval-runtime-conformance-v2',
    samples: ['probe-a', 'probe-b'].map((sampleId) => ({
      sampleId,
      input: structuredClone(probe.input),
      expected: structuredClone(expected),
    })),
    control: target('control'),
    treatment: target('treatment'),
    bootstrap: { resamples: 100 },
  });
}

async function runProbe(
  input: Readonly<ExecutorConformanceProbeInput>,
  observations: ProbeObservations,
  phase: ProbePhase,
  probe: Readonly<ExecutorConformanceProbeCase>,
  expected: JsonValue,
  signal?: AbortSignal,
): Promise<EvaluationRunResult> {
  observations.phase = phase;
  const runtime = createEvaluationRuntime({
    executors: [{
      implementationId: input.implementationId,
      createPort: (requirement) => instrumentExecutor(
        input.createExecutor(requirement.referenceId),
        observations,
      ),
    }],
    evaluators: [{ port: createExactMatchEvaluator() }],
  });
  return runEvaluation({
    runtime,
    definition: definition(input, phase, probe, expected),
    policy: createMeasurementPolicy({ maxConcurrency: 1 }),
    runId: `${input.runId ?? 'eval-runtime-conformance'}-${phase}`,
    eventBufferCapacity: 1,
    ...(signal === undefined ? {} : { signal }),
  });
}

function lifecycleConforms(lifecycles: readonly LifecycleObservation[]): boolean {
  return lifecycles.length === 6 && lifecycles.every((lifecycle) => (
    lifecycle.openRuns === lifecycle.disposedRuns
    && lifecycle.openRuns <= 1
    && lifecycle.openTrials === lifecycle.disposedTrials
    && (lifecycle.phase === 'cancellation'
      ? lifecycle.openTrials <= 2
      : lifecycle.openRuns === 1 && lifecycle.openTrials === 2)
  ));
}

/**
 * Exercises a framework-neutral `omk.invoke/v1` adapter through real success,
 * structured-failure, and externally cancelled Core runs.
 */
export async function runExecutorConformance(
  input: Readonly<ExecutorConformanceProbeInput>,
): Promise<ExecutorConformanceResult> {
  const observations: ProbeObservations = {
    phase: 'success',
    lifecycles: [],
    attemptSignals: [],
    telemetry: [],
    cancellationAttemptObserved: false,
    cancellationRejected: false,
  };
  let run: EvaluationRunResult;
  let failureRun: EvaluationRunResult;
  let cancellationRun: EvaluationRunResult;
  try {
    run = await runProbe(input, observations, 'success', input.success, input.success.expected);
    failureRun = await runProbe(input, observations, 'failure', input.failure, null);
    const controller = new AbortController();
    observations.cancellationController = controller;
    cancellationRun = await runProbe(
      input,
      observations,
      'cancellation',
      input.cancellation,
      null,
      controller.signal,
    );
  } catch {
    return Object.freeze({
      conformant: false,
      checks: Object.freeze([check(
        'configuration',
        false,
        'runtime-conformance-configuration-failed',
      )]),
    });
  }

  const completed = run.status === 'completed' ? run : undefined;
  const executionRecords = completed?.artifacts.execution.records ?? [];
  const failureRecords = failureRun.status === 'completed'
    ? failureRun.artifacts.execution.records
    : [];
  const evaluationRecords = completed?.artifacts.evaluation.records ?? [];
  const observed = evaluationRecords.flatMap((record) => (
    record.evaluationStatus === 'completed' ? record.observations : []
  ));
  const analysis = completed?.artifacts.analysis.records[0];
  const decision = completed?.artifacts.decision;
  const checks = Object.freeze([
    check('configuration', true, 'runtime-conformance-configuration-failed'),
    check(
      'binding-isolation',
      observations.lifecycles.length === 6
        && new Set(observations.lifecycles.map((item) => item.executor)).size === 6,
      'runtime-conformance-binding-not-isolated',
    ),
    check(
      'lifecycle-cleanup',
      lifecycleConforms(observations.lifecycles),
      'runtime-conformance-lifecycle-incomplete',
    ),
    check(
      'cancellation-contract',
      observations.cancellationAttemptObserved
        && observations.cancellationRejected
        && cancellationRun.status === 'cancelled'
        && observations.attemptSignals.every(Boolean),
      'runtime-conformance-cancellation-ignored',
    ),
    check(
      'telemetry-contract',
      observations.telemetry.length > 0 && observations.telemetry.every(Boolean),
      'runtime-conformance-telemetry-invalid',
    ),
    check(
      'failure-contract',
      failureRecords.length === 4
        && failureRecords.every((record) => (
          record.executionStatus === 'failed'
          && record.error.code === input.failure.expectedErrorCode
        )),
      'runtime-conformance-failure-contract-invalid',
    ),
    check('terminal-status', completed !== undefined, 'runtime-conformance-run-incomplete'),
    check(
      'execution-coverage',
      executionRecords.length === 4
        && executionRecords.every((record) => record.executionStatus === 'completed'),
      'runtime-conformance-execution-incomplete',
    ),
    check(
      'evaluation-observation',
      observed.length === 4
        && observed.every((observation) => (
          observation.observationStatus === 'observed' && observation.value === true
        )),
      'runtime-conformance-output-mismatch',
    ),
    check(
      'paired-analysis',
      analysis?.analysisStatus === 'completed'
        && typeof analysis.value === 'object'
        && analysis.value !== null
        && !Array.isArray(analysis.value)
        && analysis.value.estimate === 0,
      'runtime-conformance-analysis-incomplete',
    ),
    check(
      'decision',
      decision?.decisionStatus === 'decided' && decision.verdict === 'NOISE',
      'runtime-conformance-decision-incomplete',
    ),
  ]);
  return Object.freeze({
    conformant: checks.every((candidate) => candidate.checkStatus === 'passed'),
    checks,
    run,
  });
}

export function assertExecutorConformance(
  result: Readonly<ExecutorConformanceResult>,
): asserts result is ExecutorConformanceResult & { readonly conformant: true } {
  if (!result.conformant) throw new RuntimeConformanceError(result);
}
