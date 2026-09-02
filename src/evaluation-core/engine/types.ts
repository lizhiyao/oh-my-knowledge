import type {
  AnalysisBundle,
  AnalysisBundleSource,
  AnalysisBundleVerificationContext,
  DecisionResult,
  DecisionResultSource,
  DecisionResultVerificationContext,
  EvaluationBundle,
  EvaluationBundleSource,
  EvaluationBundleVerificationContext,
  EvaluationDefinition,
  EvaluationError,
  EvaluationEvent,
  EvaluationReport,
  ExecutionBundle,
  ExecutionBundleSource,
  ExecutionBundleVerificationContext,
  CoreSchemaValidator,
  JsonValue,
  MeasurementPolicy,
} from '../contracts/index.js';
import type {
  AnalysisRuntimeRequirement,
  ExecutorRuntimeRequirement,
  ExtensionValidationRequest,
  EvaluatorRuntimeRequirement,
  RuntimeResolution,
  SealedRunPlan,
} from '../compiler/index.js';
import type {
  AnalysisClock,
  AnalysisDecisionPolicy,
  AnalysisMissingPolicy,
  AnalysisNodeImplementation,
  AnalysisRun as CoreAnalysisRun,
  DecisionRun as CoreDecisionRun,
  EvaluationReportRun as CoreEvaluationReportRun,
} from '../analysis/index.js';
import type {
  EvaluationCache,
  EvaluationClock,
  EvaluationContentResolver,
  EvaluationContentStore,
  EvaluationEvaluator,
  EvaluationRun as CoreEvaluationStageRun,
} from '../evaluation/index.js';
import type {
  ExecutionCache,
  ExecutionClock,
  ExecutionContentStore,
  ExecutionExecutor,
  ExecutionRun as CoreExecutionRun,
} from '../execution/index.js';
export type Executor = ExecutionExecutor;
export type Evaluator = EvaluationEvaluator;

export interface EvaluationEngineClock
  extends ExecutionClock, EvaluationClock, AnalysisClock {}

export interface EvaluationEngineExecutorBinding {
  readonly runtimeKind: 'executor';
  readonly resolution: RuntimeResolution;
  readonly port: Executor;
}

export interface EvaluationEngineEvaluatorBinding {
  readonly runtimeKind: 'evaluator';
  readonly resolution: RuntimeResolution;
  readonly port: Evaluator;
}

export type EvaluationEngineAnalysisBinding = {
  readonly runtimeKind: 'analysis-node';
  readonly resolution: RuntimeResolution;
  readonly port: AnalysisNodeImplementation;
} | {
  readonly runtimeKind: 'missing-policy';
  readonly resolution: RuntimeResolution;
  readonly port: AnalysisMissingPolicy;
} | {
  readonly runtimeKind: 'decision-policy';
  readonly resolution: RuntimeResolution;
  readonly port: AnalysisDecisionPolicy;
};

export interface EvaluationEngineRuntimeBindings {
  resolveExecutor(
    requirement: Readonly<ExecutorRuntimeRequirement>,
  ): EvaluationEngineExecutorBinding | Promise<EvaluationEngineExecutorBinding>;
  resolveEvaluator(
    requirement: Readonly<EvaluatorRuntimeRequirement>,
  ): EvaluationEngineEvaluatorBinding | Promise<EvaluationEngineEvaluatorBinding>;
  resolveAnalysis(
    requirement: Readonly<AnalysisRuntimeRequirement>,
  ): EvaluationEngineAnalysisBinding | Promise<EvaluationEngineAnalysisBinding>;
}

export interface EvaluationEngineRuntime {
  bindings: EvaluationEngineRuntimeBindings;
  clock: EvaluationEngineClock;
  schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
  validateExtension?(
    request: Readonly<ExtensionValidationRequest>,
  ): unknown | Promise<unknown>;
  executionCache?: ExecutionCache;
  evaluationCache?: EvaluationCache;
  executionContentStore?: ExecutionContentStore;
  evaluationContentStore?: EvaluationContentStore;
  contentResolver?: EvaluationContentResolver;
}

export interface EvaluationEngineEventWriter {
  write(event: Readonly<EvaluationEvent>): Promise<void>;
}

export interface EvaluationRunOptions {
  policy: MeasurementPolicy;
  runId: string;
  signal?: AbortSignal;
  annotations?: JsonValue;
  summaries?: JsonValue;
  eventWriter?: EvaluationEngineEventWriter;
  eventBufferCapacity?: number;
}

export type PreparedEvaluationRunOptions = Omit<EvaluationRunOptions, 'policy'>;

export interface EvaluationRunArtifacts {
  execution: ExecutionBundle;
  evaluation: EvaluationBundle;
  analysis: AnalysisBundle;
  decision?: DecisionResult;
}

export interface PartialEvaluationRunArtifacts {
  execution?: ExecutionBundle;
  evaluation?: EvaluationBundle;
  analysis?: AnalysisBundle;
  decision?: DecisionResult;
}

export type EvaluationRunResult = {
  status: 'completed' | 'cancelled' | 'budget-exhausted';
  artifacts: EvaluationRunArtifacts;
  report: EvaluationReport;
} | {
  status: 'failed';
  error: EvaluationError;
  artifacts?: PartialEvaluationRunArtifacts;
  report?: EvaluationReport;
};

export interface EvaluationRun {
  events: AsyncIterable<EvaluationEvent>;
  result: Promise<EvaluationRunResult>;
}

export interface PreparedEvaluationStageSession {
  readonly runId: string;
  execute(): CoreExecutionRun;
  evaluate(input: Readonly<{
    execution: ExecutionBundleSource;
  }>): CoreEvaluationStageRun;
  analyze(input: Readonly<{
    execution: ExecutionBundleSource;
    evaluation: EvaluationBundleSource;
  }>): CoreAnalysisRun;
  decide(input: Readonly<{
    execution: ExecutionBundleSource;
    evaluation: EvaluationBundleSource;
    analysis: AnalysisBundleSource;
  }>): CoreDecisionRun;
  materializeReport(input: Readonly<{
    execution: ExecutionBundleSource;
    evaluation: EvaluationBundleSource;
    analysis: AnalysisBundleSource;
    decision?: DecisionResultSource;
  }>): CoreEvaluationReportRun;
  close(): Promise<void>;
}

export type EvaluationStageSessionErrorCode =
  | 'EVALUATION_STAGE_SESSION_RUN_ID_INVALID'
  | 'EVALUATION_STAGE_SESSION_RUN_ID_ACTIVE'
  | 'EVALUATION_STAGE_SESSION_EVENT_BUFFER_CAPACITY_INVALID'
  | 'EVALUATION_STAGE_SESSION_CLOSED'
  | 'EVALUATION_STAGE_SESSION_BUSY'
  | 'EVALUATION_STAGE_ALREADY_STARTED';

export interface PreparedEvaluation {
  readonly plan: SealedRunPlan;
  start(options: PreparedEvaluationRunOptions): EvaluationRun;
}

export interface AdvancedPreparedEvaluation extends PreparedEvaluation {
  stages(options: PreparedEvaluationRunOptions): PreparedEvaluationStageSession;
  admitExecutionBundle(
    value: unknown,
    verification?: ExecutionBundleVerificationContext,
  ): ExecutionBundleSource;
  admitEvaluationBundle(
    value: unknown,
    input: Readonly<{
      execution: ExecutionBundleSource;
      verification?: EvaluationBundleVerificationContext;
    }>,
  ): EvaluationBundleSource;
  admitAnalysisBundle(
    value: unknown,
    input: Readonly<{
      execution: ExecutionBundleSource;
      evaluation: EvaluationBundleSource;
      verification?: AnalysisBundleVerificationContext;
    }>,
  ): AnalysisBundleSource;
  admitDecisionResult(
    value: unknown,
    input: Readonly<{
      execution: ExecutionBundleSource;
      evaluation: EvaluationBundleSource;
      analysis: AnalysisBundleSource;
      verification?: DecisionResultVerificationContext;
    }>,
  ): DecisionResultSource;
  admitReport(
    value: unknown,
    input: Readonly<{
      execution: ExecutionBundleSource;
      evaluation: EvaluationBundleSource;
      analysis: AnalysisBundleSource;
      decision?: DecisionResultSource;
    }>,
  ): EvaluationReport;
}

export interface EvaluationEngine {
  prepare(
    definition: EvaluationDefinition,
    policy: MeasurementPolicy,
  ): Promise<PreparedEvaluation>;
  start(
    definition: EvaluationDefinition,
    options: EvaluationRunOptions,
  ): EvaluationRun;
}

export interface AdvancedEvaluationEngine extends EvaluationEngine {
  prepare(
    definition: EvaluationDefinition,
    policy: MeasurementPolicy,
  ): Promise<AdvancedPreparedEvaluation>;
}

export type EvaluationExtensionValidationRequest = ExtensionValidationRequest;
