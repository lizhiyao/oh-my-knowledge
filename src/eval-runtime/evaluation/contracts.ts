import {
  ARTIFACT_KINDS,
  ARTIFACT_SOURCES,
} from './schemas.js';
import {
  type JsonValue,
  type EvaluationSample,
  type AnalysisCohortDefinition,
  type UsageRecord,
  type AnalysisRecord,
  type ComparisonScope,
  type ComparabilityAssessment,
} from '../../eval-core/contracts/index.js';
import {
  type WorkspaceInput,
  type WorkspaceAccess,
  type WorkspaceProvider,
} from '../workspace.js';
import {
  type AllowedToolsInput,
} from '../tool-policy.js';
import {
  type McpConfigInput,
  type McpConfigAccess,
  type McpConfigProvider,
} from '../mcp-config.js';
import {
  type MockInterceptionInput,
  type MockInterceptionAccess,
  type MockInterceptionProvider,
} from '../mock-interception.js';
import {
  type RuntimeValueParser,
} from '../adapters/json-executor.js';
import {
  type RetrievalMetricIds,
} from '../evaluators/retrieval.js';
import {
  type ToolTrajectoryMatchMode,
} from '../evaluators/tool-trajectory.js';
import {
  type OmkLlmJudgeInvocationRequest,
  type OmkLlmJudgeInvocationResult,
  type OmkLlmJudgeEffort,
} from '../judges/invocation.js';
import {
  type RubricJudgeTracePolicy,
} from '../judges/rubric-contracts.js';
import {
  type AbstentionEvaluator,
} from '../evaluators/abstention.js';
import {
  type CustomEvaluator,
} from '../custom-evaluator.js';
import {
  type MeasurementRetryBackoffInput,
  type MeasurementRetryPolicyInput,
  type MeasurementStagePolicyInput,
  type MeasurementFailurePolicyInput,
  type MeasurementProviderCostLimitInput,
  type MeasurementBudgetScopeInput,
  type MeasurementRunBudgetScopeInput,
  type MeasurementAttemptBudgetScopeInput,
  type MeasurementBudgetPolicyInput,
  type MeasurementCachePolicyInput,
  type MeasurementEvidencePolicyInput,
  type MeasurementPolicyBuilderInput,
} from '../builders/policy.js';
import {
  type SealedRunPlan,
} from '../../eval-core/compiler/index.js';
import {
  type EvaluationRunResult,
  type EvaluationEngineClock,
} from '../../eval-core/engine/index.js';
import {
  type EvaluationEventObserver,
} from '../runner.js';
import {
  type EvaluationInfrastructure,
} from '../infrastructure.js';
import {
  type ExecutorConformanceResult,
} from '../conformance/executor.js';

export type ArtifactKind = typeof ARTIFACT_KINDS[number];

export type ArtifactSource = typeof ARTIFACT_SOURCES[number];

export interface Artifact {
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly source: ArtifactSource;
  readonly content: string | null;
  readonly contentHash?: string;
  readonly locator?: string;
  readonly ref?: string;
  readonly resolvedCommit?: string;
  readonly metadata?: JsonValue;
}

export interface RuntimeContext {
  readonly values?: JsonValue;
}

export interface VariantExecution<
  Input extends JsonValue = JsonValue,
  Config extends JsonValue | undefined = JsonValue | undefined,
  Output extends JsonValue = JsonValue,
  Trace extends JsonValue = JsonValue,
> {
  readonly executor: EvaluationExecutor<Input, Config, Output, Trace>;
  readonly runtimeContext?: RuntimeContext;
  readonly config?: Config;
  /** Logical, content-addressed workspace selection; physical paths belong to the provider. */
  readonly workspace?: WorkspaceInput;
  /** Exact tool allow-list; an empty list disables every tool. */
  readonly allowedTools?: AllowedToolsInput;
  /** Logical native MCP configuration; config values remain inside the provider lease. */
  readonly mcpConfig?: McpConfigInput;
  /** Logical pre-tool-call interception plan; rules remain inside attempt-scoped provider leases. */
  readonly mockInterception?: MockInterceptionInput;
}

export interface Variant<
  Input extends JsonValue = JsonValue,
  Config extends JsonValue | undefined = JsonValue | undefined,
  Output extends JsonValue = JsonValue,
  Trace extends JsonValue = JsonValue,
> {
  readonly variantId: string;
  readonly artifact: Artifact;
  readonly execution: VariantExecution<Input, Config, Output, Trace>;
}

export interface Dataset {
  readonly datasetId: string;
  readonly samples: readonly EvaluationSample[];
  readonly analysisCohorts?: readonly AnalysisCohortDefinition[];
  readonly annotations?: JsonValue;
}

export interface ExecutorCapabilities {
  readonly determinism?: 'deterministic' | 'stochastic' | 'unknown';
  readonly cancellation?: 'cooperative' | 'best-effort' | 'unsupported';
  readonly concurrency?: Readonly<{
    safety: 'serialized' | 'parallel-safe';
    maxInFlight?: number;
  }>;
  readonly seedControl?: 'unsupported' | 'optional' | 'required';
  /** Declares that the Executor consumes a native per-trial MCP configuration. */
  readonly mcp?: 'native-config';
  /** Declares that the Executor applies an attempt-private pre-tool-call interceptor. */
  readonly mockInterception?: 'pre-tool-call';
  /** Declares that the Executor strictly enforces per-trial tool allow-lists. */
  readonly toolPolicy?: 'allow-list';
  readonly telemetry?: Readonly<{
    trace?: 'unsupported' | 'optional' | 'required';
    usage?: 'unsupported' | 'optional' | 'required';
    providerCost?: Readonly<{
      reporting: 'unsupported' | 'optional' | 'required';
      trustedUpperBound?: Readonly<{ amount: number; currency: string }>;
    }>;
  }>;
}

export interface ExecutorInvocation<
  Input,
  Config extends JsonValue | undefined,
> {
  readonly input: Input;
  readonly artifact: Artifact;
  readonly runtimeContext?: RuntimeContext;
  readonly config: Config;
  readonly executionContext?: JsonValue;
  readonly sampleId: string;
  readonly variantId: string;
  readonly trialIndex: number;
  readonly trialSeed?: string;
  readonly attemptNumber: number;
  readonly signal: AbortSignal;
  readonly workspace?: WorkspaceAccess;
  readonly mcpConfig?: McpConfigAccess;
  readonly mockInterception?: MockInterceptionAccess;
  /** Undefined means use the Executor runtime default; an empty list denies every tool. */
  readonly allowedTools?: readonly string[];
}

export interface ExecutorSessionContext<
  Input,
  Config extends JsonValue | undefined,
> {
  readonly runId: string;
  readonly trialId: string;
  readonly input: Input;
  readonly artifact: Artifact;
  readonly runtimeContext?: RuntimeContext;
  readonly config: Config;
  readonly executionContext?: JsonValue;
  readonly sampleId: string;
  readonly variantId: string;
  readonly trialIndex: number;
  readonly trialSeed?: string;
  readonly workspace?: WorkspaceAccess;
  readonly mcpConfig?: McpConfigAccess;
  /** Undefined means use the Executor runtime default; an empty list denies every tool. */
  readonly allowedTools?: readonly string[];
}

export interface ExecutorSessionAttempt {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly signal: AbortSignal;
  readonly mockInterception?: MockInterceptionAccess;
}

export type ExecutorResult<Output extends JsonValue, Trace extends JsonValue = JsonValue> =
  | {
      readonly output?: Output;
      readonly trace?: Trace;
      readonly usage?: UsageRecord;
      readonly errorCode?: never;
    }
  | {
      /** Stable, non-sensitive failure category. */
      readonly errorCode: string;
      readonly usage?: UsageRecord;
      readonly output?: never;
      readonly trace?: never;
    };

interface ExecutorDeclaration<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
> {
  readonly executorId: string;
  readonly version: string;
  readonly schemas: Readonly<{
    input: RuntimeValueParser<Input>;
    config?: RuntimeValueParser<Config>;
    output: RuntimeValueParser<Output>;
    trace?: RuntimeValueParser<Trace>;
  }>;
  /** Defaults to `sensitive`; declare `public` only when outputs are safe to disclose. */
  readonly outputClassification?: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly traceClassification?: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly outputMediaType?: string;
  readonly traceMediaType?: string;
  readonly capabilities?: ExecutorCapabilities;
  /** Host-owned materializer for fresh, trial-private workspace overlays. */
  readonly workspaceProvider?: WorkspaceProvider;
  /** Host-owned materializer for validated, trial-private native MCP config. */
  readonly mcpConfigProvider?: McpConfigProvider;
  /** Host-owned materializer for fresh, attempt-private mock interception. */
  readonly mockInterceptionProvider?: MockInterceptionProvider;
  /** Host-declared deployment or implementation facets beyond executorId and version. */
  readonly fingerprintFacets?: JsonValue;
}

export interface Executor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
> extends ExecutorDeclaration<Input, Config, Output, Trace> {
  readonly protocol?: 'invoke';
  execute(
    invocation: Readonly<ExecutorInvocation<Input, Config>>,
  ): Promise<ExecutorResult<Output, Trace>>;
}

export type InvokeExecutor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
> = Executor<Input, Config, Output, Trace>;

export interface ExecutorSession<Output extends JsonValue, Trace extends JsonValue = JsonValue> {
  execute(
    attempt: Readonly<ExecutorSessionAttempt>,
  ): Promise<ExecutorResult<Output, Trace>>;
  close(): void | Promise<void>;
}

export interface SessionExecutor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
> extends ExecutorDeclaration<Input, Config, Output, Trace> {
  readonly protocol: 'session';
  openSession(
    context: Readonly<ExecutorSessionContext<Input, Config>>,
  ): Promise<ExecutorSession<Output, Trace>>;
}

export type EvaluationExecutor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
> = Executor<Input, Config, Output, Trace> | SessionExecutor<Input, Config, Output, Trace>;

export interface ExactMatchEvaluator {
  readonly evaluatorKind: 'exact-match';
  readonly evaluatorId?: string;
  readonly metricId?: string;
}

export interface RetrievalEvaluator {
  readonly evaluatorKind: 'retrieval';
  readonly evaluatorId: string;
  readonly cutoff: number;
  readonly ranking: Readonly<{
    readonly source: 'output' | 'trace';
    readonly pointer: string;
  }>;
  readonly relevantDocumentIdsPointer: string;
  readonly metricIds: RetrievalMetricIds;
}

export interface ToolTrajectoryEvaluator {
  readonly evaluatorKind: 'tool-trajectory';
  readonly evaluatorId: string;
  readonly metricId: string;
  readonly tracePointer: string;
  readonly expectedToolNamesPointer: string;
  readonly match: ToolTrajectoryMatchMode;
}

export interface Judge {
  readonly judgeId: string;
  readonly version: string;
  readonly providerCost: Readonly<{
    reporting: 'unsupported' | 'optional' | 'required';
    trustedUpperBound?: Readonly<{ amount: number; currency: string }>;
  }>;
  readonly fingerprintFacets?: JsonValue;
  invoke(
    request: Readonly<OmkLlmJudgeInvocationRequest>,
  ): Promise<OmkLlmJudgeInvocationResult>;
}

export interface Rubric {
  readonly criterionId: string;
  readonly prompt: string;
  readonly rubric: string;
}

export interface RubricJudgeMember {
  readonly memberId: string;
  readonly model: string;
  readonly judge: Judge;
  readonly effort?: OmkLlmJudgeEffort;
  /** Independent measurements by this judge; defaults to one. */
  readonly replicateCount?: number;
}

export type RubricJudgeAggregation =
  | Readonly<{
      method: 'mean';
      missing: 'require-complete';
    }>
  | Readonly<{
      method: 'weighted-mean';
      missing: 'require-complete';
      weights: Readonly<Record<string, number>>;
    }>;

export interface RubricJudgeEvaluator {
  readonly evaluatorKind: 'rubric-judge';
  readonly evaluatorId: string;
  readonly metricId: string;
  readonly judges: readonly RubricJudgeMember[];
  readonly aggregation: RubricJudgeAggregation;
  readonly rubric: Rubric;
  readonly lengthDebias?: boolean;
  readonly tracePolicy?: RubricJudgeTracePolicy;
  readonly actualPointer?: string;
  readonly tracePointer?: string;
  readonly classification?: 'public' | 'sensitive';
}

export type Evaluator =
  | ExactMatchEvaluator
  | RetrievalEvaluator
  | AbstentionEvaluator
  | ToolTrajectoryEvaluator
  | RubricJudgeEvaluator
  | CustomEvaluator;

export interface Experiment {
  /** Required measurement seed; never sourced from time, environment, or randomness. */
  readonly seed: string;
  readonly trials?: number;
  readonly sampling: SamplingDesign;
  readonly scheduling?: Readonly<{
    schedulingKind: 'sequential' | 'interleaved' | 'randomized-block';
    blockSize?: number;
  }>;
}

export type SamplingDesign =
  | Readonly<{
      samplingKind: 'solo';
      clusterKey?: string;
      stratumKey?: string;
    }>
  | Readonly<{
      samplingKind: 'paired';
      pairingKey?: string;
      stratumKey?: string;
      seedCoupling?: 'shared-within-block' | 'independent-by-target' | 'uncontrolled';
    }>
  | Readonly<{
      samplingKind: 'independent';
      allocations: readonly Readonly<{ variantId: string; weight: number }>[];
      stratumKey?: string;
      minimumSamplesPerVariant: number;
      minimumSamplesPerVariantPerStratum: number;
    }>;

export type CohortFilter =
  | Readonly<{
      includeCohortIds: readonly string[];
      excludeCohortIds?: readonly string[];
    }>
  | Readonly<{
      includeCohortIds?: readonly string[];
      excludeCohortIds: readonly string[];
    }>;

export interface ComparisonFamilyMember {
  readonly analysisId: string;
  readonly comparisonId: string;
  readonly treatmentVariantId: string;
  readonly metricId: string;
}

export interface CompositeMetricComponent {
  readonly metricId: string;
  readonly weight: number;
}

export interface CompositeAggregation {
  readonly method: 'weighted-mean';
  readonly missing: 'require-complete';
}

export type AnalysisRequest =
  | (Readonly<{
      analysisId: string;
      analysisKind: 'summary';
      variantId: string;
      metricId: string;
      cohortFilter?: CohortFilter;
    }> & (
      | Readonly<{ statistic: 'mean' | 'rate'; probability?: never }>
      | Readonly<{ statistic: 'quantile'; probability: number }>
    ))
  | Readonly<{
      analysisId: string;
      analysisKind: 'quality-interval';
      statistic: 'mean';
      variantId: string;
      metricId: string;
      confidence: Readonly<{
        method: 'percentile-bootstrap';
        level: number;
        resamples: number;
      }>;
      cohortFilter?: CohortFilter;
    }>
  | Readonly<{
      analysisId: string;
      analysisKind: 'comparison-interval';
      statistic: 'mean-difference';
      comparisonId: string;
      treatmentVariantId: string;
      metricId: string;
      confidence: Readonly<{
        method: 'percentile-bootstrap';
        level: number;
        resamples: number;
      }>;
      cohortFilter?: CohortFilter;
    }>
  | Readonly<{
      analysisId: string;
      analysisKind: 'comparison-family';
      statistic: 'mean-difference';
      members: readonly [ComparisonFamilyMember, ComparisonFamilyMember, ...ComparisonFamilyMember[]];
      confidence: Readonly<{
        method: 'bonferroni-percentile-bootstrap';
        level: number;
        resamples: number;
      }>;
      cohortFilter?: CohortFilter;
    }>
  | Readonly<{
      analysisId: string;
      analysisKind: 'composite-quality-interval';
      compositeMetricId: string;
      variantId: string;
      components: readonly [
        CompositeMetricComponent,
        CompositeMetricComponent,
        ...CompositeMetricComponent[],
      ];
      aggregation: CompositeAggregation;
      confidence: Readonly<{
        method: 'percentile-bootstrap';
        level: number;
        resamples: number;
      }>;
      cohortFilter?: CohortFilter;
    }>
  | Readonly<{
      analysisId: string;
      analysisKind: 'composite-comparison-interval';
      compositeMetricId: string;
      comparisonId: string;
      treatmentVariantId: string;
      components: readonly [
        CompositeMetricComponent,
        CompositeMetricComponent,
        ...CompositeMetricComponent[],
      ];
      aggregation: CompositeAggregation;
      confidence: Readonly<{
        method: 'percentile-bootstrap';
        level: number;
        resamples: number;
      }>;
      cohortFilter?: CohortFilter;
    }>;

export interface Comparison {
  readonly comparisonId: string;
  readonly controlVariantId: string;
  readonly treatmentVariantIds: readonly string[];
  readonly metricIds: readonly string[];
}

interface AnalysisDecision {
  readonly decisionKind: 'analysis';
  readonly analysisId: string;
  readonly threshold?: number;
  readonly equivalence?: number;
  readonly minimumEvidenceStatus?: 'complete' | 'partial' | 'unresolvable';
}

export type FamilyDecisionCriterion = Readonly<
  | { analysisId: string; minimumEffect: number; maximumEffect?: number }
  | { analysisId: string; minimumEffect?: number; maximumEffect: number }
>;

interface ComparisonFamilyDecision {
  readonly decisionKind: 'comparison-family';
  readonly analysisId: string;
  readonly rule: 'all';
  readonly criteria: readonly [
    FamilyDecisionCriterion,
    FamilyDecisionCriterion,
    ...FamilyDecisionCriterion[],
  ];
  readonly minimumEvidenceStatus?: 'complete' | 'partial' | 'unresolvable';
}

export type Decision = Readonly<AnalysisDecision | ComparisonFamilyDecision>;

export type RetryBackoff = MeasurementRetryBackoffInput;

export type RetryPolicy = MeasurementRetryPolicyInput;

export type StagePolicy = MeasurementStagePolicyInput;

export type FailurePolicy = MeasurementFailurePolicyInput;

export type ProviderCostLimit = MeasurementProviderCostLimitInput;

export type BudgetScope = MeasurementBudgetScopeInput;

export type RunBudgetScope = MeasurementRunBudgetScopeInput;

export type AttemptBudgetScope = MeasurementAttemptBudgetScopeInput;

export type BudgetPolicy = MeasurementBudgetPolicyInput;

export type CachePolicy = MeasurementCachePolicyInput;

export type EvidencePolicy = MeasurementEvidencePolicyInput;

export type Policy = Omit<MeasurementPolicyBuilderInput, 'eventDelivery'>;

export type Sample = EvaluationSample;

export type PreparedEvaluationPlan = SealedRunPlan;

export type RuntimeCapabilityResolution = PreparedEvaluationPlan['execution']['runtimes'][number];

export interface EvaluationWorkEstimate {
  readonly sampleCount: number;
  readonly variantCount: number;
  readonly trialCount: number;
  readonly executionCoordinates: number;
  readonly evaluationCoordinates: number;
  /** Planned Target plus Evaluator calls before retries or early termination. */
  readonly plannedInvocations: number;
  /** Quantities that cannot be known exactly before runtime observations exist. */
  readonly uncertain: readonly (
    | 'retries'
    | 'early-termination'
    | 'active-duration'
    | 'wall-clock'
    | 'provider-cost'
  )[];
}

/** Core run result plus the exact sealed contract executed by the façade. */
export type EvaluationResult = EvaluationRunResult & Readonly<{
  runId: string;
  definition: PreparedEvaluationPlan['definition'];
  policy: PreparedEvaluationPlan['measurementPolicy'];
  analysisResults: Readonly<Record<string, AnalysisRecord>>;
}>;

/** One intentional subject mapping between two independently sealed Runs. */
export interface EvaluationComparabilitySubject {
  readonly subjectId: string;
  readonly leftVariantId: string;
  readonly rightVariantId: string;
}

/** Cross-Run comparability request over canonical results retained in this process. */
export interface AssessComparabilityInput {
  readonly comparisonScope: ComparisonScope;
  readonly subjects: readonly EvaluationComparabilitySubject[];
  readonly left: EvaluationResult;
  readonly right: EvaluationResult;
}

/** Core-authored assessment; its three statuses must be interpreted independently. */
export type EvaluationComparabilityAssessment = ComparabilityAssessment;

export type EventObserver = EvaluationEventObserver;

export type Clock = EvaluationEngineClock;

export interface EvaluateInput {
  readonly dataset: Dataset;
  readonly variants: readonly Variant[];
  readonly evaluators: readonly Evaluator[];
  readonly comparisons: readonly Comparison[];
  readonly analyses: readonly AnalysisRequest[];
  readonly decision?: Decision;
  readonly experiment: Experiment;
  readonly policy: Policy;
  /** Host infrastructure ports; implementations and credentials never enter the Definition. */
  readonly infrastructure?: EvaluationInfrastructure;
}

export interface EvaluationRunOptions {
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly annotations?: JsonValue;
  readonly summaries?: JsonValue;
  readonly eventBufferCapacity?: number;
  readonly onEvent?: EventObserver;
  readonly clock?: Clock;
}

export interface PreparedEvaluation {
  readonly definition: PreparedEvaluationPlan['definition'];
  readonly policy: PreparedEvaluationPlan['measurementPolicy'];
  readonly plan: PreparedEvaluationPlan;
  /** Digest of the complete sealed run contract. */
  readonly planDigest: PreparedEvaluationPlan['digests']['runContractDigest'];
  readonly resolvedRuntimes: readonly RuntimeCapabilityResolution[];
  readonly estimatedWork: EvaluationWorkEstimate;
  run(options?: Readonly<EvaluationRunOptions>): Promise<EvaluationResult>;
}

export interface ExecutorCheckInput<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
> {
  readonly variant: Variant<Input, Config, Output, Trace>;
  readonly success: Readonly<{ input: Input; expected: Output }>;
  /** Input that must make the Executor return this stable, non-sensitive error code. */
  readonly failure: Readonly<{ input: Input; expectedErrorCode: string }>;
  /** Input that must keep running until the supplied AbortSignal is cancelled. */
  readonly cancellation: Readonly<{ input: Input }>;
  readonly seed?: string;
  readonly runId?: string;
}

export type ExecutorCheckResult = ExecutorConformanceResult;
