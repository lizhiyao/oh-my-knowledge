import {
  digestCanonicalJson,
  EvaluationErrorSchema,
  type AnalysisBundle,
  type DecisionResult,
  type EvaluationError,
  type EvaluationEvent,
  type EvaluationBundle,
  type EvaluationBundleSource,
  type ExecutionBundle,
  type ExecutionBundleSource,
  type AnalysisBundleSource,
  type DecisionResultSource,
} from '../contracts/index.js';
import {
  EvaluationDefinitionError,
  prepareEvaluationPlan,
  type SealedRunPlan,
} from '../compiler/index.js';
import {
  AnalysisPortFailure,
  AnalysisRuntimeConfigurationError,
  startAnalysis,
  startDecision,
  startReportMaterialization,
  type AnalysisRuntimePorts,
} from '../analysis/index.js';
import {
  EvaluationPortFailure,
  EvaluationRuntimeConfigurationError,
  startEvaluation,
  type EvaluationRuntimePorts,
} from '../evaluation/index.js';
import {
  ExecutionPortFailure,
  ExecutionRuntimeConfigurationError,
  InMemoryRuntimeEventSequencer,
  startExecution,
  type ExecutionRuntimePorts,
} from '../execution/index.js';
import { BoundedEventStream } from '../runtime/event-stream.js';
import { createRunBudgetSource } from '../budget/index.js';
import type {
  EvaluationEngine,
  EvaluationEngineRuntime,
  EvaluationRun,
  EvaluationRunArtifacts,
  EvaluationRunOptions,
  EvaluationRunResult,
  PartialEvaluationRunArtifacts,
  PreparedEvaluation,
  PreparedEvaluationRunOptions,
} from './types.js';

export * from './types.js';

const DEFAULT_EVENT_BUFFER_CAPACITY = 256;

function configurationFailure(
  code: string,
  message: string,
  details?: EvaluationError['details'],
): EvaluationRun {
  const events = new BoundedEventStream(DEFAULT_EVENT_BUFFER_CAPACITY);
  events.close();
  return {
    events,
    result: Promise.resolve({
      status: 'failed',
      error: {
        code,
        stage: 'configuration',
        message,
        ...(details === undefined ? {} : { details }),
      },
    }),
  };
}

function isValidEventBufferCapacity(capacity: number): boolean {
  return Number.isSafeInteger(capacity) && capacity >= 1;
}

interface StageRun<T> {
  events: AsyncIterable<EvaluationEvent>;
  source: Promise<T>;
}

function artifactId(runId: string, artifactKind: string): string {
  return `${artifactKind}-${digestCanonicalJson({
    derivation: 'omk.embedded-artifact-id/v1',
    runId,
    artifactKind,
  })}`;
}

async function settleStage<T>(
  run: StageRun<T>,
  output: BoundedEventStream,
): Promise<T> {
  const events = (async () => {
    for await (const event of run.events) output.push(event);
  })();
  try {
    return await run.source;
  } finally {
    await events;
  }
}

function firstArtifactError(
  execution: ExecutionBundle,
  evaluation: EvaluationBundle,
  analysis: AnalysisBundle,
  decision: DecisionResult | undefined,
): EvaluationError | undefined {
  for (const record of execution.records) {
    if (record.executionStatus === 'failed') return record.error;
  }
  for (const record of evaluation.records) {
    if (record.evaluationStatus === 'failed') return record.error;
  }
  for (const record of analysis.records) {
    if (record.analysisStatus === 'failed') return record.error;
  }
  if (decision?.decisionStatus === 'failed') return decision.error;
  for (const artifact of [execution, evaluation, analysis]) {
    const facets = artifact.provenance.facets;
    if (facets === undefined || facets === null || Array.isArray(facets)
        || typeof facets !== 'object') continue;
    const parsed = EvaluationErrorSchema.safeParse(facets.terminalError);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function runtimeError(error: unknown): EvaluationError {
  if (error instanceof EvaluationDefinitionError) return error.toJSON();
  if (error instanceof ExecutionPortFailure
      || error instanceof EvaluationPortFailure
      || error instanceof AnalysisPortFailure) {
    return error.evaluationError;
  }
  if (error instanceof ExecutionRuntimeConfigurationError
      || error instanceof EvaluationRuntimeConfigurationError
      || error instanceof AnalysisRuntimeConfigurationError) {
    return {
      code: error.code,
      stage: 'configuration',
      message: error.message,
    };
  }
  return {
    code: 'EVALUATION_ENGINE_INTERNAL',
    stage: 'internal',
    message: 'Evaluation Engine 遇到未分类的内部错误。',
  };
}

function executionPorts(
  runtime: EvaluationEngineRuntime,
  sequencer: InMemoryRuntimeEventSequencer,
  options: PreparedEvaluationRunOptions,
): ExecutionRuntimePorts {
  return {
    executors: runtime.executors,
    clock: runtime.clock,
    eventSequencer: sequencer,
    ...(runtime.executionCache === undefined ? {} : { cache: runtime.executionCache }),
    ...(runtime.executionContentStore === undefined
      ? {}
      : { contentStore: runtime.executionContentStore }),
    ...(options.eventWriter === undefined ? {} : { eventWriter: options.eventWriter }),
  };
}

function evaluationPorts(
  runtime: EvaluationEngineRuntime,
  sequencer: InMemoryRuntimeEventSequencer,
  options: PreparedEvaluationRunOptions,
): EvaluationRuntimePorts {
  return {
    evaluators: runtime.evaluators,
    clock: runtime.clock,
    eventSequencer: sequencer,
    ...(runtime.contentResolver === undefined
      ? {}
      : { contentResolver: runtime.contentResolver }),
    ...(runtime.evaluationContentStore === undefined
      ? {}
      : { contentStore: runtime.evaluationContentStore }),
    ...(runtime.evaluationCache === undefined ? {} : { cache: runtime.evaluationCache }),
    ...(options.eventWriter === undefined ? {} : { eventWriter: options.eventWriter }),
  };
}

function analysisPorts(
  runtime: EvaluationEngineRuntime,
  sequencer: InMemoryRuntimeEventSequencer,
  options: PreparedEvaluationRunOptions,
): AnalysisRuntimePorts {
  return {
    analysisNodes: runtime.analysisNodes,
    schemaValidators: runtime.schemaValidators,
    missingPolicies: runtime.missingPolicies,
    decisionPolicies: runtime.decisionPolicies,
    clock: runtime.clock,
    eventSequencer: sequencer,
    ...(options.eventWriter === undefined ? {} : { eventWriter: options.eventWriter }),
  };
}

async function executePipeline(
  runtime: EvaluationEngineRuntime,
  planPromise: Promise<SealedRunPlan>,
  options: PreparedEvaluationRunOptions,
  events: BoundedEventStream,
): Promise<EvaluationRunResult> {
  let executionSource: ExecutionBundleSource | undefined;
  let evaluationSource: EvaluationBundleSource | undefined;
  let analysisSource: AnalysisBundleSource | undefined;
  let decisionSource: DecisionResultSource | undefined;
  try {
    const plan = await planPromise;
    const sequencer = new InMemoryRuntimeEventSequencer();
    const budgetSource = createRunBudgetSource(plan, options.runId, runtime.clock);
    const stageCapacity = options.eventBufferCapacity ?? DEFAULT_EVENT_BUFFER_CAPACITY;
    const execution = await settleStage(startExecution(
      plan,
      executionPorts(runtime, sequencer, options),
      {
        runId: options.runId,
        bundleId: artifactId(options.runId, 'execution'),
        budgetSource,
        eventBufferCapacity: stageCapacity,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    ), events);
    executionSource = execution;
    const evaluation = await settleStage(startEvaluation(
      plan,
      execution,
      evaluationPorts(runtime, sequencer, options),
      {
        runId: options.runId,
        bundleId: artifactId(options.runId, 'evaluation'),
        budgetSource,
        eventBufferCapacity: stageCapacity,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    ), events);
    evaluationSource = evaluation;
    const ports = analysisPorts(runtime, sequencer, options);
    const analysis = await settleStage(startAnalysis(
      plan,
      execution,
      evaluation,
      ports,
      {
        runId: options.runId,
        bundleId: artifactId(options.runId, 'analysis'),
        eventBufferCapacity: stageCapacity,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    ), events);
    analysisSource = analysis;
    const decision = await settleStage(startDecision(
      plan,
      execution,
      evaluation,
      analysis,
      ports,
      {
        runId: options.runId,
        eventBufferCapacity: stageCapacity,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    ), events);
    decisionSource = decision;
    const reportRun = startReportMaterialization(
      plan,
      execution,
      evaluation,
      analysis,
      decision,
      ports,
      {
        runId: options.runId,
        reportId: artifactId(options.runId, 'report'),
        eventBufferCapacity: stageCapacity,
        ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
        ...(options.summaries === undefined ? {} : { summaries: options.summaries }),
      },
    );
    const report = await settleStage({
      events: reportRun.events,
      source: reportRun.result,
    }, events);
    const artifacts: EvaluationRunArtifacts = {
      execution: execution.bundle,
      evaluation: evaluation.bundle,
      analysis: analysis.bundle,
      ...(decision === undefined ? {} : { decision: decision.result }),
    };
    if (report.status.runStatus === 'failed') {
      return {
        status: 'failed',
        error: firstArtifactError(
          artifacts.execution,
          artifacts.evaluation,
          artifacts.analysis,
          artifacts.decision,
        ) ?? {
          code: 'EVALUATION_RUN_FAILED',
          stage: 'internal',
          message: 'Evaluation run 以 failed 状态结束。',
        },
        artifacts,
        report,
      };
    }
    return { status: report.status.runStatus, artifacts, report };
  } catch (error) {
    const artifacts: PartialEvaluationRunArtifacts = {
      ...(executionSource === undefined ? {} : { execution: executionSource.bundle }),
      ...(evaluationSource === undefined ? {} : { evaluation: evaluationSource.bundle }),
      ...(analysisSource === undefined ? {} : { analysis: analysisSource.bundle }),
      ...(decisionSource === undefined ? {} : { decision: decisionSource.result }),
    };
    return {
      status: 'failed',
      error: runtimeError(error),
      ...(Object.keys(artifacts).length === 0 ? {} : { artifacts }),
    };
  } finally {
    events.close();
  }
}

function startPrepared(
  runtime: EvaluationEngineRuntime,
  createPlan: () => Promise<SealedRunPlan>,
  options: PreparedEvaluationRunOptions,
  activeRunIds: Set<string>,
): EvaluationRun {
  const eventBufferCapacity = options.eventBufferCapacity === undefined
    ? DEFAULT_EVENT_BUFFER_CAPACITY
    : options.eventBufferCapacity;
  if (!isValidEventBufferCapacity(eventBufferCapacity)) {
    return configurationFailure(
      'EVALUATION_ENGINE_EVENT_BUFFER_CAPACITY_INVALID',
      'eventBufferCapacity 必须是正安全整数。',
      { eventBufferCapacity: String(eventBufferCapacity) },
    );
  }
  if (activeRunIds.has(options.runId)) {
    return configurationFailure(
      'EVALUATION_ENGINE_RUN_ID_ACTIVE',
      `runId "${options.runId}" 在当前 Evaluation Engine 中已有运行中的任务。`,
      { runId: options.runId },
    );
  }

  activeRunIds.add(options.runId);
  const events = new BoundedEventStream(eventBufferCapacity);
  const planPromise = Promise.resolve().then(createPlan);
  const result = executePipeline(runtime, planPromise, options, events)
    .finally(() => {
      activeRunIds.delete(options.runId);
    });
  return {
    events,
    result,
  };
}

function prepareRuntime(runtime: EvaluationEngineRuntime) {
  return {
    ...runtime.preparation,
    schemaValidators: runtime.schemaValidators,
    ...(runtime.validateExtension === undefined
      ? {}
      : { validateExtension: runtime.validateExtension }),
  };
}

export function createEvaluationEngine(runtime: EvaluationEngineRuntime): EvaluationEngine {
  const activeRunIds = new Set<string>();
  return {
    async prepare(definition, policy): Promise<PreparedEvaluation> {
      const plan = await prepareEvaluationPlan(definition, policy, prepareRuntime(runtime));
      return {
        plan,
        start: (options) => startPrepared(
          runtime,
          async () => plan,
          options,
          activeRunIds,
        ),
      };
    },
    start(definition, options: EvaluationRunOptions): EvaluationRun {
      const runOptions: PreparedEvaluationRunOptions = {
        runId: options.runId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
        ...(options.summaries === undefined ? {} : { summaries: options.summaries }),
        ...(options.eventWriter === undefined ? {} : { eventWriter: options.eventWriter }),
        ...(options.eventBufferCapacity === undefined
          ? {}
          : { eventBufferCapacity: options.eventBufferCapacity }),
      };
      return startPrepared(
        runtime,
        () => prepareEvaluationPlan(
          definition,
          options.policy,
          prepareRuntime(runtime),
        ),
        runOptions,
        activeRunIds,
      );
    },
  };
}
