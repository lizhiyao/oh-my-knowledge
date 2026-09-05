import {
  canonicalizeJson,
  digestCanonicalJson,
  EvaluationErrorSchema,
  IdentifierSchema,
  RuntimeIdentitySchema,
  type AnalysisBundle,
  type DecisionResult,
  type EvaluationError,
  type EvaluationEvent,
  type EvaluationBundle,
  type EvaluationBundleSource,
  type EvaluationReport,
  type ExecutionBundle,
  type ExecutionBundleSource,
  type AnalysisBundleSource,
  type AnalysisBundleVerificationContext,
  type DecisionResultSource,
  type DecisionResultVerificationContext,
  type EvaluationBundleVerificationContext,
  type ExecutionBundleVerificationContext,
  type CoreSchemaValidator,
  parseEvaluationReport,
  verifyAnalysisBundle,
  verifyDecisionResult,
  verifyEvaluationBundle,
  verifyExecutionBundle,
} from '../contracts/index.js';
import {
  EvaluationDefinitionError,
  prepareEvaluationPlan,
  RuntimeResolutionSchema,
  type AnalysisRuntimeRequirement,
  type ExecutorRuntimeRequirement,
  type EvaluatorRuntimeRequirement,
  type RuntimeResolution,
  type SealedRunPlan,
} from '../compiler/index.js';
import { snapshotJson } from '../compiler/immutability.js';
import {
  AnalysisPortFailure,
  AnalysisRuntimeConfigurationError,
  startAnalysis,
  startDecision,
  startReportMaterialization,
  type AnalysisDecisionPolicy,
  type AnalysisMissingPolicy,
  type AnalysisNodeImplementation,
  type AnalysisRuntimePorts,
} from '../analysis/index.js';
import {
  EvaluationPortFailure,
  EvaluationRuntimeConfigurationError,
  startEvaluation,
  type EvaluationEvaluator,
  type EvaluationRuntimePorts,
} from '../evaluation/index.js';
import {
  ExecutionPortFailure,
  ExecutionRuntimeConfigurationError,
  InMemoryRuntimeEventSequencer,
  startExecution,
  type ExecutionExecutor,
  type ExecutionRuntimePorts,
} from '../execution/index.js';
import { BoundedEventStream } from '../runtime/event-stream.js';
import {
  RuntimeBindingSnapshotError,
  snapshotSchemaValidators,
} from '../runtime/snapshot.js';
import { createRunBudgetSource } from '../budget/index.js';
import type {
  AdvancedEvaluationEngine,
  AdvancedPreparedEvaluation,
  EvaluationEngineRuntime,
  EvaluationRun,
  EvaluationRunArtifacts,
  EvaluationRunOptions,
  EvaluationRunResult,
  PartialEvaluationRunArtifacts,
  PreparedEvaluationRunOptions,
  PreparedEvaluationStageSession,
  EvaluationStageSessionErrorCode,
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

interface PreparedRuntimeBindings {
  readonly executorsByTargetId: ReadonlyMap<string, ExecutionExecutor>;
  readonly evaluatorsByEvaluatorId: ReadonlyMap<string, EvaluationEvaluator>;
  readonly analysisNodesByNodeId: ReadonlyMap<string, AnalysisNodeImplementation>;
  readonly missingPoliciesByPolicyId: ReadonlyMap<string, AnalysisMissingPolicy>;
  readonly decisionPoliciesByDecisionPolicyId: ReadonlyMap<string, AnalysisDecisionPolicy>;
}

interface PreparedEngineRun {
  readonly plan: SealedRunPlan;
  readonly bindings: PreparedRuntimeBindings;
  readonly runtime: EvaluationEngineRuntime;
}

type MutableRuntimeBindings = {
  executorsByTargetId: Map<string, ExecutionExecutor>;
  evaluatorsByEvaluatorId: Map<string, EvaluationEvaluator>;
  analysisNodesByNodeId: Map<string, AnalysisNodeImplementation>;
  missingPoliciesByPolicyId: Map<string, AnalysisMissingPolicy>;
  decisionPoliciesByDecisionPolicyId: Map<string, AnalysisDecisionPolicy>;
};

function emptyRuntimeBindings(): MutableRuntimeBindings {
  return {
    executorsByTargetId: new Map(),
    evaluatorsByEvaluatorId: new Map(),
    analysisNodesByNodeId: new Map(),
    missingPoliciesByPolicyId: new Map(),
    decisionPoliciesByDecisionPolicyId: new Map(),
  };
}

function snapshotRuntime(runtime: EvaluationEngineRuntime): EvaluationEngineRuntime {
  const bindings = runtime.bindings;
  let schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
  try {
    schemaValidators = snapshotSchemaValidators(runtime.schemaValidators);
  } catch (error) {
    if (error instanceof RuntimeBindingSnapshotError) {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_RUNTIME_BINDING_INVALID',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'Schema validator registry 包含无效 binding。',
        details: { referenceId: error.referenceId },
      });
    }
    throw error;
  }
  return Object.freeze({
    bindings: Object.freeze({
      resolveExecutor: bindings.resolveExecutor.bind(bindings),
      resolveEvaluator: bindings.resolveEvaluator.bind(bindings),
      resolveAnalysis: bindings.resolveAnalysis.bind(bindings),
    }),
    clock: runtime.clock,
    schemaValidators,
    ...(runtime.validateExtension === undefined
      ? {}
      : { validateExtension: runtime.validateExtension.bind(runtime) }),
    ...(runtime.executionCache === undefined ? {} : { executionCache: runtime.executionCache }),
    ...(runtime.evaluationCache === undefined
      ? {}
      : { evaluationCache: runtime.evaluationCache }),
    ...(runtime.executionContentStore === undefined
      ? {}
      : { executionContentStore: runtime.executionContentStore }),
    ...(runtime.evaluationContentStore === undefined
      ? {}
      : { evaluationContentStore: runtime.evaluationContentStore }),
    ...(runtime.contentResolver === undefined
      ? {}
      : { contentResolver: runtime.contentResolver }),
  });
}

function captureBinding<T>(
  bindings: Map<string, T>,
  referenceId: string,
  port: T,
): void {
  if (bindings.has(referenceId)) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_RUNTIME_BINDING_INVALID',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: '同一 referenceId 解析出了重复 Runtime binding。',
      details: { referenceId },
    });
  }
  bindings.set(referenceId, port);
}

function validatedResolution(
  expectedRuntimeKind: 'executor' | 'evaluator' | 'analysis-node' | 'missing-policy'
    | 'decision-policy',
  actualRuntimeKind: unknown,
  resolutionInput: unknown,
  portIdentityInput: unknown,
  referenceId: string,
): RuntimeResolution {
  const resolution = RuntimeResolutionSchema.safeParse(resolutionInput);
  const portIdentity = RuntimeIdentitySchema.safeParse(portIdentityInput);
  if (!resolution.success) {
    throw new TypeError('Runtime binding resolver returned an invalid resolution.');
  }
  if (actualRuntimeKind !== expectedRuntimeKind || !portIdentity.success
      || canonicalizeJson(resolution.data.identity) !== canonicalizeJson(portIdentity.data)) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_RUNTIME_BINDING_INVALID',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'Runtime binding kind 或 port identity 与解析结果不一致。',
      details: { referenceId, expectedRuntimeKind },
    });
  }
  return resolution.data;
}

async function prepareEngineRun(
  runtime: EvaluationEngineRuntime,
  definition: Parameters<typeof prepareEvaluationPlan>[0],
  policy: Parameters<typeof prepareEvaluationPlan>[1],
): Promise<PreparedEngineRun> {
  const captured = emptyRuntimeBindings();
  const plan = await prepareEvaluationPlan(definition, policy, {
    schemaValidators: runtime.schemaValidators,
    async resolveExecutor(requirement: Readonly<ExecutorRuntimeRequirement>) {
      const binding = await runtime.bindings.resolveExecutor(requirement);
      const resolution = validatedResolution(
        'executor',
        binding?.runtimeKind,
        binding?.resolution,
        binding?.port?.identity,
        requirement.referenceId,
      );
      captureBinding(captured.executorsByTargetId, requirement.referenceId, binding.port);
      return resolution;
    },
    async resolveEvaluator(requirement: Readonly<EvaluatorRuntimeRequirement>) {
      const binding = await runtime.bindings.resolveEvaluator(requirement);
      const resolution = validatedResolution(
        'evaluator',
        binding?.runtimeKind,
        binding?.resolution,
        binding?.port?.identity,
        requirement.referenceId,
      );
      captureBinding(captured.evaluatorsByEvaluatorId, requirement.referenceId, binding.port);
      return resolution;
    },
    async resolveAnalysis(requirement: Readonly<AnalysisRuntimeRequirement>) {
      const binding = await runtime.bindings.resolveAnalysis(requirement);
      const expectedRuntimeKind = requirement.requirementKind === 'missing-policy'
        ? 'missing-policy'
        : requirement.requirementKind === 'decision-policy'
          ? 'decision-policy'
          : 'analysis-node';
      const resolution = validatedResolution(
        expectedRuntimeKind,
        binding?.runtimeKind,
        binding?.resolution,
        binding?.port?.identity,
        requirement.referenceId,
      );
      if (binding.runtimeKind === 'missing-policy') {
        captureBinding(
          captured.missingPoliciesByPolicyId,
          requirement.referenceId,
          binding.port,
        );
      } else if (binding.runtimeKind === 'decision-policy') {
        captureBinding(
          captured.decisionPoliciesByDecisionPolicyId,
          requirement.referenceId,
          binding.port,
        );
      } else {
        captureBinding(captured.analysisNodesByNodeId, requirement.referenceId, binding.port);
      }
      return resolution;
    },
    ...(runtime.validateExtension === undefined
      ? {}
      : { validateExtension: runtime.validateExtension }),
  });
  return {
    plan,
    runtime,
    bindings: {
      executorsByTargetId: new Map(captured.executorsByTargetId),
      evaluatorsByEvaluatorId: new Map(captured.evaluatorsByEvaluatorId),
      analysisNodesByNodeId: new Map(captured.analysisNodesByNodeId),
      missingPoliciesByPolicyId: new Map(captured.missingPoliciesByPolicyId),
      decisionPoliciesByDecisionPolicyId: new Map(
        captured.decisionPoliciesByDecisionPolicyId,
      ),
    },
  };
}

function artifactId(runId: string, artifactKind: string): string {
  return `${artifactKind}-${digestCanonicalJson({
    derivation: 'omk.embedded-artifact-id/v1',
    runId,
    artifactKind,
  })}`;
}

export interface AuthenticatedEvaluationRunSources {
  readonly execution?: ExecutionBundleSource;
  readonly evaluation?: EvaluationBundleSource;
  readonly analysis?: AnalysisBundleSource;
  readonly decision?: DecisionResultSource;
}

const authenticatedEvaluationRunSources = new WeakMap<
  object,
  AuthenticatedEvaluationRunSources
>();

/** Internal bridge for façades that preserve the exact Engine result object. */
export function getAuthenticatedEvaluationRunSources(
  result: EvaluationRunResult,
): AuthenticatedEvaluationRunSources | undefined {
  return authenticatedEvaluationRunSources.get(result);
}

export interface AuthenticatedEvaluationRunResultInput {
  readonly plan: SealedRunPlan;
  readonly execution: ExecutionBundleSource;
  readonly evaluation: EvaluationBundleSource;
  readonly analysis: AnalysisBundleSource;
  readonly decision?: DecisionResultSource;
  readonly report: EvaluationReport;
}

/** Internal result materializer shared by full and staged façade runs. */
export function materializeAuthenticatedEvaluationRunResult(
  input: Readonly<AuthenticatedEvaluationRunResultInput>,
): EvaluationRunResult {
  const report = parseEvaluationReport(
    input.report,
    input.plan,
    input.execution,
    input.evaluation,
    input.analysis,
    input.decision,
  );
  const artifacts: EvaluationRunArtifacts = {
    execution: input.execution.bundle,
    evaluation: input.evaluation.bundle,
    analysis: input.analysis.bundle,
    ...(input.decision === undefined ? {} : { decision: input.decision.result }),
  };
  const result: EvaluationRunResult = report.status.runStatus === 'failed'
    ? {
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
      }
    : { status: report.status.runStatus, artifacts, report };
  authenticatedEvaluationRunSources.set(result, Object.freeze({
    execution: input.execution,
    evaluation: input.evaluation,
    analysis: input.analysis,
    ...(input.decision === undefined ? {} : { decision: input.decision }),
  }));
  return result;
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
  bindings: PreparedRuntimeBindings,
  sequencer: InMemoryRuntimeEventSequencer,
  options: PreparedEvaluationRunOptions,
): ExecutionRuntimePorts {
  return {
    executorsByTargetId: bindings.executorsByTargetId,
    clock: options.clock ?? runtime.clock,
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
  bindings: PreparedRuntimeBindings,
  sequencer: InMemoryRuntimeEventSequencer,
  options: PreparedEvaluationRunOptions,
): EvaluationRuntimePorts {
  return {
    evaluatorsByEvaluatorId: bindings.evaluatorsByEvaluatorId,
    clock: options.clock ?? runtime.clock,
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
  bindings: PreparedRuntimeBindings,
  sequencer: InMemoryRuntimeEventSequencer,
  options: PreparedEvaluationRunOptions,
): AnalysisRuntimePorts {
  return {
    analysisNodesByNodeId: bindings.analysisNodesByNodeId,
    schemaValidators: runtime.schemaValidators,
    missingPoliciesByPolicyId: bindings.missingPoliciesByPolicyId,
    decisionPoliciesByDecisionPolicyId: bindings.decisionPoliciesByDecisionPolicyId,
    clock: options.clock ?? runtime.clock,
    eventSequencer: sequencer,
    ...(options.eventWriter === undefined ? {} : { eventWriter: options.eventWriter }),
  };
}

async function executePipeline(
  preparedPromise: Promise<PreparedEngineRun>,
  options: PreparedEvaluationRunOptions,
  events: BoundedEventStream,
): Promise<EvaluationRunResult> {
  let executionSource: ExecutionBundleSource | undefined;
  let evaluationSource: EvaluationBundleSource | undefined;
  let analysisSource: AnalysisBundleSource | undefined;
  let decisionSource: DecisionResultSource | undefined;
  const authenticate = (result: EvaluationRunResult): EvaluationRunResult => {
    authenticatedEvaluationRunSources.set(result, Object.freeze({
      ...(executionSource === undefined ? {} : { execution: executionSource }),
      ...(evaluationSource === undefined ? {} : { evaluation: evaluationSource }),
      ...(analysisSource === undefined ? {} : { analysis: analysisSource }),
      ...(decisionSource === undefined ? {} : { decision: decisionSource }),
    }));
    return result;
  };
  try {
    const { plan, bindings, runtime } = await preparedPromise;
    const sequencer = new InMemoryRuntimeEventSequencer();
    const budgetSource = createRunBudgetSource(
      plan,
      options.runId,
      options.clock ?? runtime.clock,
    );
    const stageCapacity = options.eventBufferCapacity ?? DEFAULT_EVENT_BUFFER_CAPACITY;
    const execution = await settleStage(startExecution(
      plan,
      executionPorts(runtime, bindings, sequencer, options),
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
      evaluationPorts(runtime, bindings, sequencer, options),
      {
        runId: options.runId,
        bundleId: artifactId(options.runId, 'evaluation'),
        budgetSource,
        eventBufferCapacity: stageCapacity,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    ), events);
    evaluationSource = evaluation;
    const ports = analysisPorts(runtime, bindings, sequencer, options);
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
    return materializeAuthenticatedEvaluationRunResult({
      plan,
      execution,
      evaluation,
      analysis,
      ...(decision === undefined ? {} : { decision }),
      report,
    });
  } catch (error) {
    const artifacts: PartialEvaluationRunArtifacts = {
      ...(executionSource === undefined ? {} : { execution: executionSource.bundle }),
      ...(evaluationSource === undefined ? {} : { evaluation: evaluationSource.bundle }),
      ...(analysisSource === undefined ? {} : { analysis: analysisSource.bundle }),
      ...(decisionSource === undefined ? {} : { decision: decisionSource.result }),
    };
    return authenticate({
      status: 'failed',
      error: runtimeError(error),
      ...(Object.keys(artifacts).length === 0 ? {} : { artifacts }),
    });
  } finally {
    events.close();
  }
}

function startPrepared(
  createPreparedRun: () => Promise<PreparedEngineRun>,
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
  const preparedPromise = Promise.resolve().then(createPreparedRun);
  const result = executePipeline(preparedPromise, options, events)
    .finally(() => {
      activeRunIds.delete(options.runId);
    });
  return {
    events,
    result,
  };
}

export class EvaluationStageSessionError extends TypeError {
  readonly code: EvaluationStageSessionErrorCode;

  constructor(code: EvaluationStageSessionErrorCode, message: string) {
    super(message);
    this.name = 'EvaluationStageSessionError';
    this.code = code;
  }
}

function createStageSession(
  prepared: PreparedEngineRun,
  inputOptions: PreparedEvaluationRunOptions,
  activeRunIds: Set<string>,
): PreparedEvaluationStageSession {
  const runtime = prepared.runtime;
  const options: PreparedEvaluationRunOptions = Object.freeze({
    runId: inputOptions.runId,
    ...(inputOptions.clock === undefined ? {} : { clock: inputOptions.clock }),
    ...(inputOptions.signal === undefined ? {} : { signal: inputOptions.signal }),
    ...(inputOptions.annotations === undefined
      ? {}
      : { annotations: snapshotJson(inputOptions.annotations) }),
    ...(inputOptions.summaries === undefined
      ? {}
      : { summaries: snapshotJson(inputOptions.summaries) }),
    ...(inputOptions.eventWriter === undefined
      ? {}
      : { eventWriter: inputOptions.eventWriter }),
    ...(inputOptions.eventBufferCapacity === undefined
      ? {}
      : { eventBufferCapacity: inputOptions.eventBufferCapacity }),
  });
  if (!IdentifierSchema.safeParse(options.runId).success) {
    throw new EvaluationStageSessionError(
      'EVALUATION_STAGE_SESSION_RUN_ID_INVALID',
      '分阶段运行的 runId 不符合 Evaluation Core identifier contract。',
    );
  }
  if (!isValidEventBufferCapacity(
    options.eventBufferCapacity ?? DEFAULT_EVENT_BUFFER_CAPACITY,
  )) {
    throw new EvaluationStageSessionError(
      'EVALUATION_STAGE_SESSION_EVENT_BUFFER_CAPACITY_INVALID',
      '分阶段运行的 eventBufferCapacity 必须是正安全整数。',
    );
  }
  if (activeRunIds.has(options.runId)) {
    throw new EvaluationStageSessionError(
      'EVALUATION_STAGE_SESSION_RUN_ID_ACTIVE',
      `runId "${options.runId}" 在当前 Evaluation Engine 中已有运行中的任务。`,
    );
  }

  const sequencer = new InMemoryRuntimeEventSequencer();
  const sessionAbort = new AbortController();
  const signal = options.signal === undefined
    ? sessionAbort.signal
    : AbortSignal.any([options.signal, sessionAbort.signal]);
  const startedStages = new Set<string>();
  const budgetByExecutionSource = new WeakMap<object, ReturnType<typeof createRunBudgetSource>>();
  const stageCapacity = options.eventBufferCapacity ?? DEFAULT_EVENT_BUFFER_CAPACITY;
  let inFlight: Promise<unknown> | undefined;
  let closing = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true;
      sessionAbort.abort(new Error('Evaluation stage session closed by host.'));
      if (inFlight !== undefined) await Promise.allSettled([inFlight]);
      activeRunIds.delete(options.runId);
      closed = true;
    })();
    return closePromise;
  }

  function track(completion: Promise<unknown>, terminal: boolean): void {
    inFlight = completion;
    void completion.then(
      () => {
        inFlight = undefined;
        if (terminal) void close();
      },
      () => {
        inFlight = undefined;
        void close();
      },
    );
  }

  function startOnce<T>(
    stageKind: string,
    start: () => T,
    completion: (run: T) => Promise<unknown>,
    terminal = false,
  ): T {
    if (closed || closing) {
      throw new EvaluationStageSessionError(
        'EVALUATION_STAGE_SESSION_CLOSED',
        '分阶段运行已经关闭，不能再启动新阶段。',
      );
    }
    if (inFlight !== undefined) {
      throw new EvaluationStageSessionError(
        'EVALUATION_STAGE_SESSION_BUSY',
        '前一个 Evaluation stage 尚未结束，不能并发启动下一阶段。',
      );
    }
    if (startedStages.has(stageKind)) {
      throw new EvaluationStageSessionError(
        'EVALUATION_STAGE_ALREADY_STARTED',
        `Evaluation stage "${stageKind}" 在当前 session 中已经启动过。`,
      );
    }
    const run = start();
    startedStages.add(stageKind);
    track(completion(run), terminal);
    return run;
  }

  const session: PreparedEvaluationStageSession = {
    runId: options.runId,
    execute() {
      const run = startOnce('execution', () => startExecution(
        prepared.plan,
        executionPorts(runtime, prepared.bindings, sequencer, options),
        {
          runId: options.runId,
          bundleId: artifactId(options.runId, 'execution'),
          eventBufferCapacity: stageCapacity,
          signal,
        },
      ), (started) => started.source);
      void run.source.then(
        (source) => { budgetByExecutionSource.set(source, run.budgetSource); },
        () => undefined,
      );
      return run;
    },
    evaluate(input) {
      const budgetSource = budgetByExecutionSource.get(input.execution);
      return startOnce('evaluation', () => startEvaluation(
        prepared.plan,
        input.execution,
        evaluationPorts(runtime, prepared.bindings, sequencer, options),
        {
          runId: options.runId,
          bundleId: artifactId(options.runId, 'evaluation'),
          eventBufferCapacity: stageCapacity,
          ...(budgetSource === undefined ? {} : { budgetSource }),
          signal,
        },
      ), (started) => started.source);
    },
    analyze(input) {
      return startOnce('analysis', () => startAnalysis(
        prepared.plan,
        input.execution,
        input.evaluation,
        analysisPorts(runtime, prepared.bindings, sequencer, options),
        {
          runId: options.runId,
          bundleId: artifactId(options.runId, 'analysis'),
          eventBufferCapacity: stageCapacity,
          signal,
        },
      ), (started) => started.source);
    },
    decide(input) {
      return startOnce('decision', () => startDecision(
        prepared.plan,
        input.execution,
        input.evaluation,
        input.analysis,
        analysisPorts(runtime, prepared.bindings, sequencer, options),
        {
          runId: options.runId,
          eventBufferCapacity: stageCapacity,
          signal,
        },
      ), (started) => started.source);
    },
    materializeReport(input) {
      return startOnce('report', () => startReportMaterialization(
        prepared.plan,
        input.execution,
        input.evaluation,
        input.analysis,
        input.decision,
        analysisPorts(runtime, prepared.bindings, sequencer, options),
        {
          runId: options.runId,
          reportId: artifactId(options.runId, 'report'),
          eventBufferCapacity: stageCapacity,
          ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
          ...(options.summaries === undefined ? {} : { summaries: options.summaries }),
        },
      ), (started) => started.result, true);
    },
    close,
  };
  activeRunIds.add(options.runId);
  return Object.freeze(session);
}

function bindPreparedEvaluation(
  prepared: PreparedEngineRun,
  activeRunIds: Set<string>,
): AdvancedPreparedEvaluation {
  const plan = prepared.plan;
  const runtime = prepared.runtime;
  const bound: AdvancedPreparedEvaluation = {
    plan,
    start: (options) => startPrepared(
      async () => prepared,
      options,
      activeRunIds,
    ),
    stages: (options) => createStageSession(prepared, options, activeRunIds),
    admitExecutionBundle(
      value: unknown,
      verification?: ExecutionBundleVerificationContext,
    ) {
      return verifyExecutionBundle(value, plan, verification);
    },
    admitEvaluationBundle(
      value: unknown,
      input: Readonly<{
        execution: ExecutionBundleSource;
        verification?: EvaluationBundleVerificationContext;
      }>,
    ) {
      return verifyEvaluationBundle(value, plan, input.execution, input.verification);
    },
    admitAnalysisBundle(
      value: unknown,
      input: Readonly<{
        execution: ExecutionBundleSource;
        evaluation: EvaluationBundleSource;
        verification?: AnalysisBundleVerificationContext;
      }>,
    ) {
      return verifyAnalysisBundle(
        value,
        plan,
        input.execution,
        input.evaluation,
        { schemaValidators: runtime.schemaValidators },
        input.verification,
      );
    },
    admitDecisionResult(
      value: unknown,
      input: Readonly<{
        execution: ExecutionBundleSource;
        evaluation: EvaluationBundleSource;
        analysis: AnalysisBundleSource;
        verification?: DecisionResultVerificationContext;
      }>,
    ) {
      return verifyDecisionResult(
        value,
        plan,
        input.execution,
        input.evaluation,
        input.analysis,
        input.verification,
      );
    },
    admitReport(value, input) {
      return parseEvaluationReport(
        value,
        plan,
        input.execution,
        input.evaluation,
        input.analysis,
        input.decision,
      );
    },
  };
  return bound;
}

export function createEvaluationEngine(runtime: EvaluationEngineRuntime): AdvancedEvaluationEngine {
  const activeRunIds = new Set<string>();
  return {
    async prepare(definition, policy): Promise<AdvancedPreparedEvaluation> {
      const prepared = await prepareEngineRun(snapshotRuntime(runtime), definition, policy);
      return bindPreparedEvaluation(prepared, activeRunIds);
    },
    start(definition, options: EvaluationRunOptions): EvaluationRun {
      const runOptions: PreparedEvaluationRunOptions = {
        runId: options.runId,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
        ...(options.summaries === undefined ? {} : { summaries: options.summaries }),
        ...(options.eventWriter === undefined ? {} : { eventWriter: options.eventWriter }),
        ...(options.eventBufferCapacity === undefined
          ? {}
          : { eventBufferCapacity: options.eventBufferCapacity }),
      };
      let capturedRuntime: EvaluationEngineRuntime;
      try {
        capturedRuntime = snapshotRuntime(runtime);
      } catch (error) {
        const failure = runtimeError(error);
        return configurationFailure(failure.code, failure.message, failure.details);
      }
      return startPrepared(
        () => prepareEngineRun(capturedRuntime, definition, options.policy),
        runOptions,
        activeRunIds,
      );
    },
  };
}
