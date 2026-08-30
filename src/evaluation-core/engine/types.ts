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
  ExtensionValidationRequest,
  PreparationRuntime,
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

export interface EvaluationEngineRuntime {
  preparation: Omit<PreparationRuntime, 'schemaValidators' | 'validateExtension'>;
  executors: ReadonlyMap<string, Executor>;
  evaluators: ReadonlyMap<string, Evaluator>;
  clock: EvaluationEngineClock;
  schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
  analysisNodes: ReadonlyMap<string, AnalysisNodeImplementation>;
  missingPolicies: ReadonlyMap<string, AnalysisMissingPolicy>;
  decisionPolicies: ReadonlyMap<string, AnalysisDecisionPolicy>;
  validateExtension?: PreparationRuntime['validateExtension'];
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
