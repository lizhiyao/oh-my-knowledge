import {
  createEvaluationEngine,
  type EvaluationRunResult,
  type Executor,
} from '../../eval-core/engine/index.js';
import type { JsonValue } from '../../eval-core/contracts/index.js';
import { createExactMatchDefinition } from '../builders/exact-match.js';
import { createMeasurementPolicy } from '../builders/policy.js';
import { createExactMatchEvaluator } from '../evaluators/exact-match.js';
import { createEvaluationRuntime } from '../runtime.js';

export interface ExecutorConformanceProbeInput {
  readonly implementationId: string;
  /** A fresh Core Executor is required for each Target binding. */
  readonly createExecutor: () => Executor;
  readonly input: JsonValue;
  readonly expected: JsonValue;
  readonly seed?: string;
  readonly runId?: string;
}

export interface RuntimeConformanceCheck {
  readonly checkId:
    | 'configuration'
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

/**
 * Runs a framework-neutral adapter probe through the real Core pipeline.
 * The supplied Target is invoked for two paired samples in both control and treatment.
 * Two samples are the minimum required by the built-in paired bootstrap analysis.
 */
export async function runExecutorConformance(
  input: Readonly<ExecutorConformanceProbeInput>,
): Promise<ExecutorConformanceResult> {
  let run: EvaluationRunResult;
  try {
    const runtime = createEvaluationRuntime({
      executors: [{
        implementationId: input.implementationId,
        createPort: input.createExecutor,
      }],
      evaluators: [{ port: createExactMatchEvaluator() }],
    });
    const definition = createExactMatchDefinition({
      datasetId: 'eval-runtime-conformance',
      seed: input.seed ?? 'eval-runtime-conformance-v1',
      samples: ['probe-a', 'probe-b'].map((sampleId) => ({
        sampleId,
        input: structuredClone(input.input),
        expected: structuredClone(input.expected),
      })),
      control: { targetId: 'control', executorId: input.implementationId },
      treatment: { targetId: 'treatment', executorId: input.implementationId },
      bootstrap: { resamples: 100 },
    });
    const prepared = await createEvaluationEngine(runtime).prepare(
      definition,
      createMeasurementPolicy({ maxConcurrency: 1 }),
    );
    const started = prepared.start({
      runId: input.runId ?? 'eval-runtime-conformance',
      eventBufferCapacity: 128,
    });
    const draining = (async () => {
      for await (const event of started.events) void event;
    })();
    run = await started.result;
    await draining;
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
  const evaluationRecords = completed?.artifacts.evaluation.records ?? [];
  const observed = evaluationRecords.flatMap((record) => (
    record.evaluationStatus === 'completed' ? record.observations : []
  ));
  const analysis = completed?.artifacts.analysis.records[0];
  const decision = completed?.artifacts.decision;
  const checks = Object.freeze([
    check('configuration', true, 'runtime-conformance-configuration-failed'),
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
