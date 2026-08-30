import type {
  AnalysisBundle,
  DecisionResult,
  EvaluationBundle,
  EvaluationDefinition,
  EvaluationError,
  EvaluationEvent,
  EvaluationReport,
  ExecutionBundle,
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
} from '../analysis/index.js';
import type {
  EvaluationCache,
  EvaluationClock,
  EvaluationContentResolver,
  EvaluationContentStore,
  EvaluationEvaluator,
} from '../evaluation/index.js';
import type {
  ExecutionCache,
  ExecutionClock,
  ExecutionContentStore,
  ExecutionExecutor,
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

export interface PreparedEvaluation {
  readonly plan: SealedRunPlan;
  start(options: PreparedEvaluationRunOptions): EvaluationRun;
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

export type EvaluationExtensionValidationRequest = ExtensionValidationRequest;
