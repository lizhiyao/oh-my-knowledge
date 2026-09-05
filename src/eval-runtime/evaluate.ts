import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  IdentifierSchema,
  EvaluationDefinitionSchema,
  EvaluationDatasetSchema,
  EvaluatorDefinitionSchema,
  JsonPointerSchema,
  JsonValueSchema,
  MetricDefinitionSchema,
  bonferroniMarginalAlpha,
  bonferroniMarginalConfidenceLevel,
  deepFreezeCanonicalJson,
  canonicalizeJson,
  derivePlannedExecutionCoordinates,
  digestCanonicalJson,
  type EvaluationDefinition,
  type AnalysisCohortDefinition,
  type AnalysisRecord,
  type EvaluationSample,
  type EvaluatorDefinition,
  type JsonValue,
  type MetricDefinition,
  type UsageRecord,
} from '../eval-core/contracts/index.js';
import {
  createEvaluationEngine as createCoreEvaluationEngine,
  type EvaluationEngineClock,
  type EvaluationRunResult,
  type PreparedEvaluation as CorePreparedEvaluation,
} from '../eval-core/engine/index.js';
import type {
  EvaluatorRuntimeRequirement,
  SealedRunPlan,
} from '../eval-core/compiler/index.js';
import { EvaluationDefinitionError } from '../eval-core/compiler/index.js';
import type { EvaluationEvaluator } from '../eval-core/evaluation/index.js';
import {
  assertFreshExecutorSessionObject,
  createJsonExecutorAdapter,
  createJsonSessionExecutorAdapter,
  type RuntimeValueParser,
} from './adapters/json-executor.js';
import {
  createMeasurementPolicy,
  MeasurementPolicyBuilderInputSchema,
  type MeasurementFailurePolicyInput,
  type MeasurementAttemptBudgetScopeInput,
  type MeasurementBudgetPolicyInput,
  type MeasurementBudgetScopeInput,
  type MeasurementPolicyBuilderInput,
  type MeasurementProviderCostLimitInput,
  type MeasurementRetryBackoffInput,
  type MeasurementRetryPolicyInput,
  type MeasurementRunBudgetScopeInput,
  type MeasurementStagePolicyInput,
} from './builders/policy.js';
import {
  EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID,
  createExactMatchEvaluator,
} from './evaluators/exact-match.js';
import {
  RETRIEVAL_EVALUATOR_IMPLEMENTATION_ID,
  createRetrievalEvaluator,
  type RetrievalMetricIds,
} from './evaluators/retrieval.js';
import {
  TOOL_TRAJECTORY_EVALUATOR_IMPLEMENTATION_ID,
  createToolTrajectoryEvaluator,
  type ToolTrajectoryMatchMode,
} from './evaluators/tool-trajectory.js';
import { SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION } from './traces/source-neutral.js';
import {
  createInvokeExecutorIdentity,
  createRuntimeIdentity,
  createSessionExecutorIdentity,
} from './identity.js';
import {
  captureCustomEvaluator,
  type CustomEvaluator,
} from './custom-evaluator.js';
import type {
  OmkLlmJudgeEffort,
  OmkLlmJudgeInvocationRequest,
  OmkLlmJudgeInvocationResult,
} from './judges/invocation.js';
import {
  createRubricJudgeEvaluationContext,
  createRubricJudgeKit,
  createRubricJudgeRegistration,
  type RubricJudgeKit,
} from './judges/rubric-kit.js';
import type {
  RubricJudgeCriterion,
  RubricJudgeTracePolicy,
} from './judges/rubric-contracts.js';
import {
  EvaluationEventConsumptionError as AdvancedEvaluationEventConsumptionError,
  runPreparedEvaluation,
  type EvaluationEventObserver,
} from './runner.js';
import {
  createEvaluationRuntime,
  EvaluationRuntimeAssemblyError,
  type RuntimePortRegistration,
} from './runtime.js';
import {
  runExecutorConformance,
  type ExecutorConformanceResult,
  type RuntimeConformanceCheck,
} from './conformance/executor.js';

const ARTIFACT_KINDS = ['baseline', 'skill', 'prompt', 'agent', 'workflow'] as const;
const ARTIFACT_SOURCES = [
  'baseline',
  'variant-name',
  'file-path',
  'git',
  'inline',
  'custom',
] as const;
const VARIANT_CONFIG_SCHEMA_VERSION = 'omk.eval-runtime.variant-config/v3' as const;
const MAX_RUBRIC_PANEL_COORDINATES = 1_000;

const ArtifactSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(ARTIFACT_KINDS),
  source: z.enum(ARTIFACT_SOURCES),
  content: z.string().nullable(),
  contentHash: z.string().min(1).optional(),
  locator: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  resolvedCommit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  metadata: JsonValueSchema.optional(),
}).strict().superRefine((artifact, context) => {
  if (artifact.kind === 'baseline' && (artifact.source !== 'baseline' || artifact.content !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'baseline artifact must use baseline source and null content.',
    });
  }
  if (artifact.kind !== 'baseline' && artifact.source === 'baseline') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only a baseline artifact may use baseline source.',
    });
  }
});

const RuntimeContextSchema = z.object({
  values: JsonValueSchema.optional(),
}).strict();

const RetrievalEvaluatorInputSchema = z.object({
  evaluatorKind: z.literal('retrieval'),
  evaluatorId: IdentifierSchema,
  cutoff: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ranking: z.object({
    source: z.enum(['output', 'trace']),
    pointer: JsonPointerSchema,
  }).strict(),
  relevantDocumentIdsPointer: JsonPointerSchema,
  metricIds: z.object({
    recallAtK: IdentifierSchema,
    precisionAtK: IdentifierSchema,
    reciprocalRankAtK: IdentifierSchema,
    ndcgAtK: IdentifierSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const ids = Object.values(value.metricIds);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: 'custom',
      path: ['metricIds'],
      message: 'Retrieval Metric IDs must be unique',
    });
  }
});

const ToolTrajectoryEvaluatorInputSchema = z.object({
  evaluatorKind: z.literal('tool-trajectory'),
  evaluatorId: IdentifierSchema,
  metricId: IdentifierSchema,
  tracePointer: JsonPointerSchema,
  expectedToolNamesPointer: JsonPointerSchema,
  match: z.enum([
    'exact-order',
    'same-tools',
    'contains-in-order',
    'contains-any-order',
  ]),
}).strict();

const SamplingDesignInputSchema = z.discriminatedUnion('samplingKind', [
  z.object({
    samplingKind: z.literal('solo'),
    clusterKey: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/).optional(),
    stratumKey: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/).optional(),
  }).strict(),
  z.object({
    samplingKind: z.literal('paired'),
    pairingKey: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/).optional(),
    stratumKey: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/).optional(),
    seedCoupling: z.enum([
      'shared-within-block',
      'independent-by-target',
      'uncontrolled',
    ]).optional(),
  }).strict(),
  z.object({
    samplingKind: z.literal('independent'),
    allocations: z.array(z.object({
      variantId: IdentifierSchema,
      weight: z.number().finite().positive(),
    }).strict()).min(2),
    stratumKey: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/).optional(),
    minimumSamplesPerVariant: z.number().int().min(2),
    minimumSamplesPerVariantPerStratum: z.number().int().positive(),
  }).strict(),
]);

const ExperimentSchema = z.object({
  seed: z.string().min(1),
  trials: z.number().int().positive().optional(),
  sampling: SamplingDesignInputSchema,
  scheduling: z.object({
    schedulingKind: z.enum(['sequential', 'interleaved', 'randomized-block']),
    blockSize: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();

const CohortFilterInputSchema = z.object({
  includeCohortIds: z.array(IdentifierSchema).min(1).optional(),
  excludeCohortIds: z.array(IdentifierSchema).min(1).optional(),
}).strict().refine((filter) => (
  filter.includeCohortIds !== undefined || filter.excludeCohortIds !== undefined
));

const ComparisonFamilyMemberInputSchema = z.object({
  analysisId: IdentifierSchema,
  comparisonId: IdentifierSchema,
  treatmentVariantId: IdentifierSchema,
  metricId: IdentifierSchema,
}).strict();

const CompositeComponentInputSchema = z.object({
  metricId: IdentifierSchema,
  weight: z.number().finite().positive(),
}).strict();

const CompositeAggregationInputSchema = z.object({
  method: z.literal('weighted-mean'),
  missing: z.literal('require-complete'),
}).strict();

const CompositeRequestFieldsSchema = z.object({
  compositeMetricId: IdentifierSchema,
  components: z.array(CompositeComponentInputSchema).min(2),
  aggregation: CompositeAggregationInputSchema,
  confidence: z.object({
    method: z.literal('percentile-bootstrap'),
    level: z.number().gt(0).lt(1),
    resamples: z.number().int().positive(),
  }).strict(),
  cohortFilter: CohortFilterInputSchema.optional(),
}).strict();

const AnalysesInputSchema = z.array(z.discriminatedUnion('analysisKind', [
    z.object({
      analysisId: IdentifierSchema,
      analysisKind: z.literal('summary'),
      statistic: z.enum(['mean', 'rate', 'quantile']),
      variantId: IdentifierSchema,
      metricId: IdentifierSchema,
      probability: z.number().min(0).max(1).optional(),
      cohortFilter: CohortFilterInputSchema.optional(),
    }).strict(),
    z.object({
      analysisId: IdentifierSchema,
      analysisKind: z.literal('quality-interval'),
      statistic: z.literal('mean'),
      variantId: IdentifierSchema,
      metricId: IdentifierSchema,
      confidence: z.object({
        method: z.literal('percentile-bootstrap'),
        level: z.number().gt(0).lt(1),
        resamples: z.number().int().positive(),
      }).strict(),
      cohortFilter: CohortFilterInputSchema.optional(),
    }).strict(),
    z.object({
      analysisId: IdentifierSchema,
      analysisKind: z.literal('comparison-interval'),
      statistic: z.literal('mean-difference'),
      comparisonId: IdentifierSchema,
      treatmentVariantId: IdentifierSchema,
      metricId: IdentifierSchema,
      confidence: z.object({
        method: z.literal('percentile-bootstrap'),
        level: z.number().gt(0).lt(1),
        resamples: z.number().int().positive(),
      }).strict(),
      cohortFilter: CohortFilterInputSchema.optional(),
    }).strict(),
    z.object({
      analysisId: IdentifierSchema,
      analysisKind: z.literal('comparison-family'),
      statistic: z.literal('mean-difference'),
      members: z.array(ComparisonFamilyMemberInputSchema).min(2),
      confidence: z.object({
        method: z.literal('bonferroni-percentile-bootstrap'),
        level: z.number().gt(0).lt(1),
        resamples: z.number().int().positive(),
      }).strict(),
      cohortFilter: CohortFilterInputSchema.optional(),
    }).strict(),
    CompositeRequestFieldsSchema.extend({
      analysisId: IdentifierSchema,
      analysisKind: z.literal('composite-quality-interval'),
      variantId: IdentifierSchema,
    }).strict(),
    CompositeRequestFieldsSchema.extend({
      analysisId: IdentifierSchema,
      analysisKind: z.literal('composite-comparison-interval'),
      comparisonId: IdentifierSchema,
      treatmentVariantId: IdentifierSchema,
    }).strict(),
  ]));

const ComparisonInputSchema = z.object({
  comparisonId: IdentifierSchema,
  controlVariantId: IdentifierSchema,
  treatmentVariantIds: z.array(IdentifierSchema).min(1),
  metricIds: z.array(IdentifierSchema).min(1),
}).strict();

const FamilyDecisionCriterionInputSchema = z.object({
  analysisId: IdentifierSchema,
  minimumEffect: z.number().finite().optional(),
  maximumEffect: z.number().finite().optional(),
}).strict().superRefine((criterion, context) => {
  if (criterion.minimumEffect === undefined && criterion.maximumEffect === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'A comparison-family decision criterion requires an effect boundary',
    });
  }
  if (criterion.minimumEffect !== undefined
      && criterion.maximumEffect !== undefined
      && criterion.minimumEffect > criterion.maximumEffect) {
    context.addIssue({
      code: 'custom',
      path: ['minimumEffect'],
      message: 'minimumEffect must not exceed maximumEffect',
    });
  }
});

const DecisionInputSchema = z.union([
  z.object({
    decisionKind: z.literal('analysis'),
    analysisId: IdentifierSchema,
    threshold: z.number().finite().optional(),
    equivalence: z.number().finite().nonnegative().optional(),
    minimumEvidenceStatus: z.enum(['complete', 'partial', 'unresolvable']).optional(),
  }).strict(),
  z.object({
    decisionKind: z.literal('comparison-family'),
    analysisId: IdentifierSchema,
    rule: z.literal('all'),
    criteria: z.array(FamilyDecisionCriterionInputSchema).min(2),
    minimumEvidenceStatus: z.enum(['complete', 'partial', 'unresolvable']).optional(),
  }).strict(),
]);

const PolicyInputSchema = MeasurementPolicyBuilderInputSchema.omit({ eventDelivery: true });

const VariantConfigEnvelopeSchema = z.object({
  schemaVersion: z.literal(VARIANT_CONFIG_SCHEMA_VERSION),
  artifact: ArtifactSchema,
  runtimeContext: RuntimeContextSchema.optional(),
  executorConfig: JsonValueSchema.optional(),
}).strict();

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
}

export interface ExecutorSessionAttempt {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly signal: AbortSignal;
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
export type EventObserver = EvaluationEventObserver;
export type Clock = EvaluationEngineClock;

/** Stable, redacted event-consumption failure from the canonical facade. */
export class EvaluationEventConsumptionError extends Error {
  readonly code:
    | 'EVAL_RUNTIME_EVENT_OBSERVER_FAILED'
    | 'EVAL_RUNTIME_EVENT_STREAM_FAILED';
  readonly runResult?: EvaluationResult;

  constructor(input: Readonly<{
    code: EvaluationEventConsumptionError['code'];
    message: string;
    runResult?: EvaluationResult;
  }>) {
    super(input.message);
    this.name = 'EvaluationEventConsumptionError';
    this.code = input.code;
    this.runResult = input.runResult;
  }
}

export interface EvaluateInput {
  readonly dataset: Dataset;
  readonly variants: readonly Variant[];
  readonly evaluators: readonly Evaluator[];
  readonly comparisons: readonly Comparison[];
  readonly analyses: readonly AnalysisRequest[];
  readonly decision?: Decision;
  readonly experiment: Experiment;
  readonly policy: Policy;
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
export type { RuntimeConformanceCheck };

export class EvaluationConfigurationError extends TypeError {
  readonly code:
    | 'EVAL_RUNTIME_INPUT_INVALID'
    | 'EVAL_RUNTIME_EXECUTOR_INVALID'
    | 'EVAL_RUNTIME_VARIANT_INVALID'
    | 'EVAL_RUNTIME_EVALUATOR_INVALID';

  constructor(code: EvaluationConfigurationError['code'], message: string) {
    super(message);
    this.name = 'EvaluationConfigurationError';
    this.code = code;
  }
}

interface CapturedExecutor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue,
> {
  readonly declaration: EvaluationExecutor<Input, Config, Output, Trace>;
  readonly protocolId: 'omk.invoke/v1' | 'omk.session/v1';
  readonly inputParser: RuntimeValueParser<Input>;
  readonly configParser: RuntimeValueParser<Config>;
  readonly outputParser: RuntimeValueParser<Output>;
  readonly createPort: (
    targetId: string,
  ) => ReturnType<typeof createJsonExecutorAdapter<Input, JsonValue, Output, Trace>>;
}

function configurationFailure(
  code: EvaluationConfigurationError['code'],
  message: string,
): never {
  throw new EvaluationConfigurationError(code, message);
}

function captureParser<Value>(
  parser: Readonly<RuntimeValueParser<Value>> | undefined,
  code: EvaluationConfigurationError['code'],
): RuntimeValueParser<Value> | undefined {
  if (parser === undefined) return undefined;
  if (typeof parser.parse !== 'function') {
    return configurationFailure(code, 'Evaluation schema 缺少可调用的 parse 方法。');
  }
  const parse = parser.parse;
  return Object.freeze({
    parse: (value: unknown) => Reflect.apply(parse, parser, [value]) as Value,
  });
}

function parseWithoutTransform<Value extends JsonValue>(
  parser: Readonly<RuntimeValueParser<Value>>,
  value: unknown,
  code: EvaluationConfigurationError['code'],
  message: string,
): Value {
  try {
    const wire = JsonValueSchema.parse(structuredClone(value));
    const parsed = parser.parse(structuredClone(wire));
    const parsedWire = JsonValueSchema.parse(parsed);
    if (canonicalizeJson(wire) !== canonicalizeJson(parsedWire)) {
      return configurationFailure(code, message);
    }
    return parsed;
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    return configurationFailure(code, message);
  }
}

function parseOptionalWithoutTransform<Value extends JsonValue | undefined>(
  parser: Readonly<RuntimeValueParser<Value>>,
  value: unknown,
  code: EvaluationConfigurationError['code'],
  message: string,
): Value {
  if (value !== undefined) {
    return parseWithoutTransform(
      parser as RuntimeValueParser<Exclude<Value, undefined>>,
      value,
      code,
      message,
    ) as Value;
  }
  try {
    const parsed = parser.parse(undefined);
    if (parsed !== undefined) return configurationFailure(code, message);
    return parsed;
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    return configurationFailure(code, message);
  }
}

function captureArtifact(value: Readonly<Artifact>): Artifact {
  try {
    const parsed = ArtifactSchema.parse(structuredClone(value));
    return deepFreezeCanonicalJson(parsed) as Artifact;
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variant 包含无效 artifact。',
    );
  }
}

function captureRuntimeContext(
  value: Readonly<RuntimeContext> | undefined,
): RuntimeContext | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = RuntimeContextSchema.parse(structuredClone(value));
    return deepFreezeCanonicalJson(parsed) as RuntimeContext;
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variant 包含无效 runtime context。',
    );
  }
}

function undefinedConfigParser<Config extends JsonValue | undefined>(): RuntimeValueParser<Config> {
  return Object.freeze({
    parse(value: unknown): Config {
      if (value !== undefined) throw new TypeError('Executor config schema is required.');
      return undefined as Config;
    },
  });
}

function captureExecutor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue,
>(
  value: Readonly<EvaluationExecutor<Input, Config, Output, Trace>>,
): CapturedExecutor<Input, Config, Output, Trace> {
  const executorId = IdentifierSchema.safeParse(value?.executorId);
  const protocol = value?.protocol ?? 'invoke';
  if (!executorId.success
      || typeof value?.version !== 'string'
      || value.version.length === 0
      || (protocol !== 'invoke' && protocol !== 'session')
      || (protocol === 'invoke'
        ? typeof (value as InvokeExecutor<Input, Config, Output, Trace>)?.execute !== 'function'
        : typeof (value as SessionExecutor<Input, Config, Output, Trace>)?.openSession
          !== 'function')) {
    return configurationFailure(
      'EVAL_RUNTIME_EXECUTOR_INVALID',
      'Evaluation executor declaration 无效。',
    );
  }
  const inputParser = captureParser(
    value.schemas?.input,
    'EVAL_RUNTIME_EXECUTOR_INVALID',
  );
  const configParser = captureParser(
    value.schemas?.config,
    'EVAL_RUNTIME_EXECUTOR_INVALID',
  ) ?? undefinedConfigParser<Config>();
  const outputParser = captureParser(
    value.schemas?.output,
    'EVAL_RUNTIME_EXECUTOR_INVALID',
  );
  const traceParser = captureParser(
    value.schemas?.trace,
    'EVAL_RUNTIME_EXECUTOR_INVALID',
  );
  if (inputParser === undefined || outputParser === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_EXECUTOR_INVALID',
      'Evaluation executor 必须声明 input 与 output schema。',
    );
  }
  const capabilities = value.capabilities ?? {};
  const telemetry = capabilities.telemetry ?? {};
  const outputClassification = value.outputClassification ?? 'sensitive';
  const traceClassification = value.traceClassification ?? outputClassification;
  const identity = (() => {
    try {
      const createIdentity = protocol === 'session'
        ? createSessionExecutorIdentity
        : createInvokeExecutorIdentity;
      return createIdentity({
        implementationId: executorId.data,
        version: value.version,
        determinism: capabilities.determinism ?? 'unknown',
        cancellation: capabilities.cancellation ?? 'best-effort',
        concurrency: capabilities.concurrency ?? { safety: 'serialized' },
        seedControl: capabilities.seedControl ?? 'unsupported',
        telemetry: {
          trace: telemetry.trace ?? (traceParser === undefined ? 'unsupported' : 'optional'),
          usage: telemetry.usage ?? 'optional',
          providerCost: telemetry.providerCost ?? { reporting: 'optional' },
        },
        fingerprintFacets: {
          facade: {
            version: 'omk.eval-runtime.evaluate/v3',
            outputClassification,
            traceClassification,
            ...(value.outputMediaType === undefined
              ? {}
              : { outputMediaType: value.outputMediaType }),
            ...(value.traceMediaType === undefined
              ? {}
              : { traceMediaType: value.traceMediaType }),
          },
          ...(value.fingerprintFacets === undefined
            ? {}
            : { host: structuredClone(value.fingerprintFacets) }),
        },
      });
    } catch {
      return configurationFailure(
        'EVAL_RUNTIME_EXECUTOR_INVALID',
        'Evaluation executor capabilities declaration 无效。',
      );
    }
  })();
  if (!['public', 'sensitive', 'secret', 'gold'].includes(outputClassification)
      || (value.traceClassification !== undefined
        && !['public', 'sensitive', 'secret', 'gold'].includes(value.traceClassification))) {
    return configurationFailure(
      'EVAL_RUNTIME_EXECUTOR_INVALID',
      'Evaluation executor classification declaration 无效。',
    );
  }
  const commonDeclaration = {
    executorId: executorId.data,
    version: value.version,
    schemas: Object.freeze({
      input: inputParser,
      ...(value.schemas.config === undefined ? {} : { config: configParser }),
      output: outputParser,
      ...(traceParser === undefined ? {} : { trace: traceParser }),
    }),
    outputClassification,
    ...(value.traceClassification === undefined
      ? {}
      : { traceClassification: value.traceClassification }),
    ...(value.outputMediaType === undefined ? {} : { outputMediaType: value.outputMediaType }),
    ...(value.traceMediaType === undefined ? {} : { traceMediaType: value.traceMediaType }),
    ...(value.capabilities === undefined ? {} : {
      capabilities: deepFreezeCanonicalJson(structuredClone(value.capabilities)),
    }),
    ...(value.fingerprintFacets === undefined ? {} : {
      fingerprintFacets: deepFreezeCanonicalJson(structuredClone(value.fingerprintFacets)),
    }),
  };
  const declaration: EvaluationExecutor<Input, Config, Output, Trace> = protocol === 'session'
    ? Object.freeze({
      ...commonDeclaration,
      protocol: 'session' as const,
      openSession: (value as SessionExecutor<Input, Config, Output, Trace>).openSession,
    })
    : Object.freeze({
      ...commonDeclaration,
      ...(value.protocol === 'invoke' ? { protocol: 'invoke' as const } : {}),
      execute: (value as InvokeExecutor<Input, Config, Output, Trace>).execute,
    });

  function adaptResult(result: ExecutorResult<Output, Trace>) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      return result as never;
    }
    if ('errorCode' in result) {
      return {
        invocationStatus: 'failed' as const,
        errorCode: result.errorCode as string,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    }
    return {
      invocationStatus: 'completed' as const,
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(result.trace === undefined ? {} : { trace: result.trace }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  }

  const adapterInput = {
    identity,
    inputParser,
    targetConfigParser: {
      parse(raw: unknown): JsonValue {
        const envelope = VariantConfigEnvelopeSchema.parse(raw);
        return deepFreezeCanonicalJson({
          schemaVersion: VARIANT_CONFIG_SCHEMA_VERSION,
          artifact: envelope.artifact,
          ...(envelope.runtimeContext === undefined
            ? {}
            : { runtimeContext: envelope.runtimeContext }),
          ...(envelope.executorConfig === undefined
            ? {}
            : { executorConfig: envelope.executorConfig }),
        });
      },
    },
    outputParser,
    ...(traceParser === undefined ? {} : { traceParser }),
    outputClassification,
    ...(value.traceClassification === undefined
      ? {}
      : { traceClassification: value.traceClassification }),
    ...(value.outputMediaType === undefined ? {} : { outputMediaType: value.outputMediaType }),
    ...(value.traceMediaType === undefined ? {} : { traceMediaType: value.traceMediaType }),
  };
  const createPort = (targetId: string) => protocol === 'session'
    ? createJsonSessionExecutorAdapter({
      ...adapterInput,
      async openSession(sessionContext) {
        const targetConfig = VariantConfigEnvelopeSchema.parse(sessionContext.targetConfig);
        const host = declaration as SessionExecutor<Input, Config, Output, Trace>;
        const session = await Reflect.apply(host.openSession, host, [{
          runId: sessionContext.runId,
          trialId: sessionContext.trialId,
          input: sessionContext.input,
          artifact: targetConfig.artifact,
          ...(targetConfig.runtimeContext === undefined
            ? {}
            : { runtimeContext: targetConfig.runtimeContext }),
          config: targetConfig.executorConfig as Config,
          ...(sessionContext.executionContext === undefined
            ? {}
            : { executionContext: sessionContext.executionContext }),
          sampleId: sessionContext.sampleId,
          variantId: targetId,
          trialIndex: sessionContext.trialIndex,
          ...(sessionContext.trialSeed === undefined
            ? {}
            : { trialSeed: sessionContext.trialSeed }),
        }]) as ExecutorSession<Output, Trace>;
        if (session === null || typeof session !== 'object'
            || typeof session.execute !== 'function'
            || typeof session.close !== 'function') {
          throw new TypeError('Session Executor returned an invalid session lifecycle.');
        }
        assertFreshExecutorSessionObject(session);
        const executeSession = session.execute;
        const closeSession = session.close;
        return Object.freeze({
          execute: async (attempt: Readonly<ExecutorSessionAttempt>) => adaptResult(
            await Reflect.apply(
              executeSession,
              session,
              [attempt],
            ) as ExecutorResult<Output, Trace>,
          ),
          close: () => Reflect.apply(closeSession, session, []) as void | Promise<void>,
        });
      },
    })
    : createJsonExecutorAdapter({
      ...adapterInput,
      async invoke(invocation) {
        const targetConfig = VariantConfigEnvelopeSchema.parse(invocation.targetConfig);
        const host = declaration as InvokeExecutor<Input, Config, Output, Trace>;
        const result = await Reflect.apply(host.execute, host, [{
          input: invocation.input,
          artifact: targetConfig.artifact,
          ...(targetConfig.runtimeContext === undefined
            ? {}
            : { runtimeContext: targetConfig.runtimeContext }),
          config: targetConfig.executorConfig as Config,
          ...(invocation.executionContext === undefined
            ? {}
            : { executionContext: invocation.executionContext }),
          sampleId: invocation.sampleId,
          variantId: targetId,
          trialIndex: invocation.trialIndex,
          ...(invocation.trialSeed === undefined ? {} : { trialSeed: invocation.trialSeed }),
          attemptNumber: invocation.attemptNumber,
          signal: invocation.signal,
        }]) as ExecutorResult<Output, Trace>;
        return adaptResult(result);
      },
    });

  return Object.freeze({
    declaration,
    protocolId: protocol === 'session' ? 'omk.session/v1' : 'omk.invoke/v1',
    inputParser,
    configParser,
    outputParser,
    createPort,
  });
}

function captureDataset(value: Readonly<Dataset>): Dataset {
  try {
    const parsed = EvaluationDatasetSchema.parse(structuredClone(value));
    return deepFreezeCanonicalJson(parsed);
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation dataset 无效。',
    );
  }
}

interface CapturedVariant {
  variantId: string;
  artifact: Artifact;
  runtimeContext?: RuntimeContext;
  config?: JsonValue;
  envelope: JsonValue;
  executor: CapturedExecutor<JsonValue, JsonValue | undefined, JsonValue, JsonValue>;
}

function captureVariant(value: Readonly<Variant>): Readonly<CapturedVariant> {
  const variantId = IdentifierSchema.safeParse(value?.variantId);
  if (!variantId.success || value.execution === null || typeof value.execution !== 'object') {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variantId 或 execution binding 无效。',
    );
  }
  const executor = captureExecutor(value.execution.executor);
  const artifact = captureArtifact(value.artifact);
  const runtimeContext = captureRuntimeContext(value.execution.runtimeContext);
  const config = parseOptionalWithoutTransform(
    executor.configParser,
    value.execution.config,
    'EVAL_RUNTIME_VARIANT_INVALID',
    'Evaluation variant config 不符合 Executor schema，或 schema 改变了值。',
  );
  const envelope = deepFreezeCanonicalJson(VariantConfigEnvelopeSchema.parse({
    schemaVersion: VARIANT_CONFIG_SCHEMA_VERSION,
    artifact,
    ...(runtimeContext === undefined ? {} : { runtimeContext }),
    ...(config === undefined ? {} : { executorConfig: config }),
  }));
  return Object.freeze({
    variantId: variantId.data,
    artifact,
    ...(runtimeContext === undefined ? {} : { runtimeContext }),
    ...(config === undefined ? {} : { config }),
    envelope,
    executor,
  });
}

function captureJudge(value: Readonly<Judge>) {
  if (typeof value?.invoke !== 'function') {
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Rubric 评委声明无效。',
    );
  }
  const invoke = value.invoke;
  try {
    const providerCost = deepFreezeCanonicalJson(structuredClone(value.providerCost));
    const fingerprintFacets = value.fingerprintFacets === undefined
      ? undefined
      : deepFreezeCanonicalJson(structuredClone(value.fingerprintFacets));
    const identity = createRuntimeIdentity({
      implementationId: value.judgeId,
      version: value.version,
      capabilities: {
        invocationKind: 'llm-judge',
        cancellation: 'cooperative',
        providerCost,
      },
      fingerprintFacets: {
        facade: 'omk.eval-runtime.rubric-judge/v1',
        ...(fingerprintFacets === undefined
          ? {}
          : { host: fingerprintFacets }),
      },
    });
    const receiver: Judge = Object.freeze({
      judgeId: identity.implementationId,
      version: value.version,
      providerCost,
      ...(fingerprintFacets === undefined ? {} : { fingerprintFacets }),
      invoke,
    });
    return Object.freeze({
      identity,
      providerCost: receiver.providerCost,
      invoke: (request: Readonly<OmkLlmJudgeInvocationRequest>) => Reflect.apply(
        invoke,
        receiver,
        [request],
      ) as Promise<OmkLlmJudgeInvocationResult>,
    });
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Rubric 评委身份或费用声明无效。',
    );
  }
}

function attachDefinition(
  result: EvaluationRunResult,
  runId: string,
  definition: PreparedEvaluationPlan['definition'],
  policy: PreparedEvaluationPlan['measurementPolicy'],
): EvaluationResult {
  const records = result.artifacts?.analysis?.records ?? [];
  const analysisResults = Object.freeze(Object.fromEntries(
    [...records]
      .sort((left, right) => compareStrings(left.resultId, right.resultId))
      .map((record) => [record.resultId, record]),
  ));
  return Object.freeze({ ...result, runId, definition, policy, analysisResults });
}

interface CapturedEvaluators {
  readonly dataset: Dataset;
  readonly definitions: readonly EvaluatorDefinition[];
  readonly metrics: readonly MetricDefinition[];
  readonly measurementAggregations: ReadonlyMap<string, MeasurementAggregationPlan>;
  readonly registrations: readonly RuntimePortRegistration<
    EvaluationEvaluator,
    EvaluatorRuntimeRequirement
  >[];
}

interface MeasurementAggregationPlan {
  readonly method: 'mean' | 'weighted-mean';
  readonly missing: 'require-complete';
  readonly replicateGroupId: string;
  readonly members: readonly Readonly<{
    ensembleMemberId: string;
    weight?: number;
    replicates: readonly Readonly<{
      evaluatorId: string;
      instrumentId: string;
      replicateIndex: number;
    }>[];
  }>[];
}

function panelEvaluatorId(panelId: string, memberId: string, replicateIndex: number): string {
  const readable = `${panelId}/${memberId}/replicate-${replicateIndex}`;
  return IdentifierSchema.safeParse(readable).success
    ? readable
    : `rubric-panel:${digestCanonicalJson({
        derivation: 'omk.eval-runtime.rubric-panel-evaluator-id/v1',
        panelId,
        memberId,
        replicateIndex,
      }).slice('sha256:'.length)}`;
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function exactMatchDefinition(input: Readonly<ExactMatchEvaluator>): Readonly<{
  definition: EvaluatorDefinition;
  metric: MetricDefinition;
  port: EvaluationEvaluator;
}> {
  const metricId = IdentifierSchema.parse(input.metricId ?? 'correct');
  const readableDefaultId = `exact-match-${metricId}`;
  const defaultEvaluatorId = metricId === 'correct'
    ? 'exact-match'
    : IdentifierSchema.safeParse(readableDefaultId).success
      ? readableDefaultId
      : `exact-match:${digestCanonicalJson({
          derivation: 'omk.eval-runtime.exact-match-evaluator-id/v1',
          metricId,
        }).slice('sha256:'.length)}`;
  const evaluatorId = IdentifierSchema.parse(
    input.evaluatorId ?? defaultEvaluatorId,
  );
  const definition = EvaluatorDefinitionSchema.parse({
    evaluatorId,
    evaluatorKind: 'assertion',
    implementationId: EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID,
    measurement: {
      instrumentId: 'canonical-json-exact-match-v1',
      ensembleMemberId: 'deterministic-local',
      replicateGroupId: 'deterministic-primary',
      replicateIndex: 0,
    },
    metricIds: [metricId],
    inputs: [
      { bindingId: 'actual', sourceKind: 'output', pointer: '' },
      { bindingId: 'expected', sourceKind: 'expected', pointer: '' },
    ],
  });
  const metric = MetricDefinitionSchema.parse({
    metricId,
    valueType: 'boolean',
    scope: 'sample',
    direction: 'higher-is-better',
    missingPolicyId: 'exclude/v1',
  });
  return Object.freeze({
    definition,
    metric,
    port: createExactMatchEvaluator({ metricId }),
  });
}

function retrievalDefinition(input: Readonly<RetrievalEvaluator>): Readonly<{
  definition: EvaluatorDefinition;
  metrics: readonly MetricDefinition[];
  port: EvaluationEvaluator;
}> {
  const parsed = RetrievalEvaluatorInputSchema.parse(structuredClone(input));
  const metricIds = [
    parsed.metricIds.recallAtK,
    parsed.metricIds.precisionAtK,
    parsed.metricIds.reciprocalRankAtK,
    parsed.metricIds.ndcgAtK,
  ];
  const portInput = {
    evaluatorId: parsed.evaluatorId,
    cutoff: parsed.cutoff,
    metricIds: parsed.metricIds,
    rankingSource: parsed.ranking.source,
    rankingPointer: parsed.ranking.pointer,
    relevantDocumentIdsPointer: parsed.relevantDocumentIdsPointer,
  };
  return Object.freeze({
    definition: EvaluatorDefinitionSchema.parse({
      evaluatorId: parsed.evaluatorId,
      evaluatorKind: 'assertion',
      implementationId: RETRIEVAL_EVALUATOR_IMPLEMENTATION_ID,
      measurement: {
        instrumentId: 'binary-top-k-retrieval-v1',
        ensembleMemberId: 'deterministic-local',
        replicateGroupId: 'deterministic-primary',
        replicateIndex: 0,
      },
      metricIds,
      inputs: [{
        bindingId: 'ranking',
        sourceKind: parsed.ranking.source,
        pointer: parsed.ranking.pointer,
      }, {
        bindingId: 'relevant-document-ids',
        sourceKind: 'expected',
        pointer: parsed.relevantDocumentIdsPointer,
      }],
      config: {
        cutoff: parsed.cutoff,
        relevance: 'binary',
        discount: 'log2',
        precisionDenominator: 'cutoff',
      },
    }),
    metrics: metricIds.map((metricId) => MetricDefinitionSchema.parse({
      metricId,
      valueType: 'numeric',
      scope: 'sample',
      scale: { min: 0, max: 1 },
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    })),
    port: createRetrievalEvaluator(portInput),
  });
}

function toolTrajectoryDefinition(input: Readonly<ToolTrajectoryEvaluator>): Readonly<{
  definition: EvaluatorDefinition;
  metric: MetricDefinition;
  port: EvaluationEvaluator;
}> {
  const parsed = ToolTrajectoryEvaluatorInputSchema.parse(structuredClone(input));
  const portInput = {
    evaluatorId: parsed.evaluatorId,
    metricId: parsed.metricId,
    tracePointer: parsed.tracePointer,
    expectedToolNamesPointer: parsed.expectedToolNamesPointer,
    match: parsed.match,
  };
  return Object.freeze({
    definition: EvaluatorDefinitionSchema.parse({
      evaluatorId: parsed.evaluatorId,
      evaluatorKind: 'assertion',
      implementationId: TOOL_TRAJECTORY_EVALUATOR_IMPLEMENTATION_ID,
      measurement: {
        instrumentId: 'source-neutral-tool-trajectory-v1',
        ensembleMemberId: 'deterministic-local',
        replicateGroupId: 'deterministic-primary',
        replicateIndex: 0,
      },
      metricIds: [parsed.metricId],
      inputs: [{
        bindingId: 'trace',
        sourceKind: 'trace',
        pointer: parsed.tracePointer,
      }, {
        bindingId: 'expected-tool-names',
        sourceKind: 'expected',
        pointer: parsed.expectedToolNamesPointer,
      }],
      config: {
        match: parsed.match,
        traceSchemaVersion: SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
        toolIdentityComparison: 'case-sensitive',
        toolCallCollection: 'top-level-toolCalls',
        toolCallOrder: 'array-order',
        toolCallSelection: 'all-statuses',
        traceRoleSelection: 'all',
        multiplicity: 'preserved',
      },
    }),
    metric: MetricDefinitionSchema.parse({
      metricId: parsed.metricId,
      valueType: 'boolean',
      scope: 'sample',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    }),
    port: createToolTrajectoryEvaluator(portInput),
  });
}

function captureEvaluators(
  dataset: Readonly<Dataset>,
  values: readonly Evaluator[],
): CapturedEvaluators {
  if (!Array.isArray(values) || values.length === 0) {
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Evaluation 至少需要一个 evaluator。',
    );
  }
  const definitions: EvaluatorDefinition[] = [];
  const metrics: MetricDefinition[] = [];
  const measurementAggregations = new Map<string, MeasurementAggregationPlan>();
  const exactPorts = new Map<string, EvaluationEvaluator>();
  const retrievalPorts = new Map<string, EvaluationEvaluator>();
  const toolTrajectoryPorts = new Map<string, EvaluationEvaluator>();
  const rubricEntries: Array<Readonly<{
    kit: Readonly<RubricJudgeKit>;
    criterion: Readonly<RubricJudgeCriterion>;
  }>> = [];
  const customEntries: Array<Readonly<{
    evaluatorId: string;
    implementationId: string;
    version: string;
    port: EvaluationEvaluator;
  }>> = [];
  try {
    for (const value of values) {
      if (value.evaluatorKind === 'exact-match') {
        const captured = exactMatchDefinition(value);
        definitions.push(captured.definition);
        metrics.push(captured.metric);
        exactPorts.set(captured.definition.evaluatorId, captured.port);
        continue;
      }
      if (value.evaluatorKind === 'retrieval') {
        let captured;
        try {
          captured = retrievalDefinition(value);
        } catch {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Retrieval Evaluator 配置无效。',
          );
        }
        definitions.push(captured.definition);
        metrics.push(...captured.metrics);
        retrievalPorts.set(captured.definition.evaluatorId, captured.port);
        continue;
      }
      if (value.evaluatorKind === 'tool-trajectory') {
        let captured;
        try {
          captured = toolTrajectoryDefinition(value);
        } catch {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Tool Trajectory Evaluator 配置无效。',
          );
        }
        definitions.push(captured.definition);
        metrics.push(captured.metric);
        toolTrajectoryPorts.set(captured.definition.evaluatorId, captured.port);
        continue;
      }
      if (value.evaluatorKind === 'custom') {
        let captured;
        try {
          captured = captureCustomEvaluator(value);
        } catch {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Custom Evaluator 配置无效。',
          );
        }
        definitions.push(captured.definition);
        metrics.push(captured.metric);
        customEntries.push({
          evaluatorId: captured.definition.evaluatorId,
          implementationId: captured.implementationId,
          version: captured.version,
          port: captured.port,
        });
        continue;
      }
      if (value.evaluatorKind !== 'rubric-judge') {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          'Evaluation evaluatorKind 不受支持。',
        );
      }
      const panelId = IdentifierSchema.parse(value.evaluatorId);
      const metricId = IdentifierSchema.parse(value.metricId);
      if (!hasOnlyKeys(value, [
        'evaluatorKind', 'evaluatorId', 'metricId', 'judges', 'aggregation', 'rubric',
        'lengthDebias', 'tracePolicy', 'actualPointer', 'tracePointer', 'classification',
      ])
          || !Array.isArray(value.judges) || value.judges.length === 0
          || value.judges.length > MAX_RUBRIC_PANEL_COORDINATES
          || value.aggregation === null || typeof value.aggregation !== 'object'
          || (value.aggregation.method !== 'mean'
            && value.aggregation.method !== 'weighted-mean')
          || value.aggregation.missing !== 'require-complete'
          || !hasOnlyKeys(
            value.aggregation,
            value.aggregation.method === 'weighted-mean'
              ? ['method', 'missing', 'weights']
              : ['method', 'missing'],
          )) {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          'Rubric 评委 panel 配置无效。',
        );
      }
      const panelJudges = value.judges as readonly RubricJudgeMember[];
      if (panelJudges.some((member) => (
        member === null || typeof member !== 'object'
        || !hasOnlyKeys(member, ['memberId', 'model', 'judge', 'effort', 'replicateCount'])
      ))) {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          'Rubric 评委 member 配置无效。',
        );
      }
      const memberIds = panelJudges.map((member) => IdentifierSchema.parse(member.memberId));
      if (new Set(memberIds).size !== memberIds.length) {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          'Rubric 评委 memberId 必须唯一。',
        );
      }
      const replicateCounts = panelJudges.map((member) => member.replicateCount ?? 1);
      if (replicateCounts.some((count) => !Number.isSafeInteger(count) || count < 1)
          || replicateCounts.reduce((sum, count) => sum + count, 0)
            > MAX_RUBRIC_PANEL_COORDINATES) {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          `Rubric 评委 panel 最多包含 ${MAX_RUBRIC_PANEL_COORDINATES} 个测量坐标。`,
        );
      }
      const weights = value.aggregation.method === 'weighted-mean'
        ? value.aggregation.weights
        : undefined;
      if (weights !== undefined) {
        if (weights === null || Array.isArray(weights) || typeof weights !== 'object'
            || Object.keys(weights).sort(compareStrings).join('\u0000')
              !== [...memberIds].sort(compareStrings).join('\u0000')
            || memberIds.some((memberId) => (
              typeof weights[memberId] !== 'number'
              || !Number.isFinite(weights[memberId])
              || weights[memberId] <= 0
            ))
            || Math.abs(memberIds.reduce((sum, memberId) => sum + weights[memberId], 0) - 1)
              > 1e-12) {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Rubric 评委权重必须完整覆盖 member、为正数且总和为 1。',
          );
        }
      }
      const aggregationMembers: MeasurementAggregationPlan['members'][number][] = [];
      let metric: MetricDefinition | undefined;
      for (const [memberIndex, member] of panelJudges.entries()) {
        const memberId = memberIds[memberIndex];
        const replicateCount = replicateCounts[memberIndex];
        const invocation = captureJudge(member.judge);
        const replicates: MeasurementAggregationPlan['members'][number]['replicates'][number][] = [];
        for (let replicateIndex = 0; replicateIndex < replicateCount; replicateIndex += 1) {
          const evaluatorId = panelEvaluatorId(panelId, memberId, replicateIndex);
          const kit = createRubricJudgeKit({
            evaluatorId,
            metricId,
            model: member.model,
            invocation,
            ...(member.effort === undefined ? {} : { effort: member.effort }),
            ...(value.lengthDebias === undefined ? {} : { lengthDebias: value.lengthDebias }),
            ...(value.tracePolicy === undefined ? {} : { tracePolicy: value.tracePolicy }),
            ...(value.actualPointer === undefined ? {} : { actualPointer: value.actualPointer }),
            ...(value.tracePointer === undefined ? {} : { tracePointer: value.tracePointer }),
            ...(value.classification === undefined ? {} : { classification: value.classification }),
            ensembleMemberId: memberId,
            replicateGroupId: panelId,
            replicateIndex,
          });
          definitions.push(kit.evaluatorDefinition);
          metric ??= kit.metricDefinition;
          rubricEntries.push({
            kit,
            criterion: {
              schemaVersion: 'omk.rubric-judge-context/v1',
              ...value.rubric,
            },
          });
          replicates.push({
            evaluatorId,
            instrumentId: kit.evaluatorDefinition.measurement.instrumentId,
            replicateIndex,
          });
        }
        aggregationMembers.push({
          ensembleMemberId: memberId,
          ...(weights === undefined ? {} : { weight: weights[memberId] }),
          replicates,
        });
      }
      if (metric === undefined) {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          'Rubric 评委 panel 未产生 Metric。',
        );
      }
      metrics.push(metric);
      measurementAggregations.set(metricId, {
        method: value.aggregation.method,
        missing: 'require-complete',
        replicateGroupId: panelId,
        members: [...aggregationMembers].sort((left, right) => compareStrings(
          left.ensembleMemberId,
          right.ensembleMemberId,
        )),
      });
    }
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Rubric 评委配置无效。',
    );
  }
  const evaluatorIds = definitions.map((definition) => definition.evaluatorId);
  const metricIds = metrics.map((metric) => metric.metricId);
  if (new Set(evaluatorIds).size !== evaluatorIds.length
      || new Set(metricIds).size !== metricIds.length) {
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Evaluation evaluatorId 与 metricId 必须分别唯一。',
    );
  }
  let preparedDataset = dataset;
  if (rubricEntries.length > 0) {
    try {
      const samples = dataset.samples.map((sample) => {
        const base = sample.evaluationContext;
        if (base !== undefined
            && (base === null || Array.isArray(base) || typeof base !== 'object')) {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Rubric 评委要求用例的 evaluationContext 为 JSON object。',
          );
        }
        return {
          ...structuredClone(sample),
          evaluationContext: createRubricJudgeEvaluationContext(
            rubricEntries,
            base as Readonly<{ [key: string]: JsonValue }> | undefined,
          ),
        };
      });
      preparedDataset = captureDataset({ datasetId: dataset.datasetId, samples });
    } catch (error) {
      if (error instanceof EvaluationConfigurationError) throw error;
      return configurationFailure(
        'EVAL_RUNTIME_EVALUATOR_INVALID',
        'Rubric 评委 evaluationContext 无效。',
      );
    }
  }
  const registrations: RuntimePortRegistration<
    EvaluationEvaluator,
    EvaluatorRuntimeRequirement
  >[] = [];
  if (exactPorts.size > 0) {
    registrations.push({
      implementationId: EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID,
      createPort(requirement) {
        const port = exactPorts.get(requirement.referenceId);
        if (port === undefined) {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Evaluation Runtime 收到了未知 exact-match evaluator binding。',
          );
        }
        return port;
      },
    });
  }
  if (retrievalPorts.size > 0) {
    registrations.push({
      implementationId: RETRIEVAL_EVALUATOR_IMPLEMENTATION_ID,
      createPort(requirement) {
        const port = retrievalPorts.get(requirement.referenceId);
        if (port === undefined) {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Evaluation Runtime 收到了未知 retrieval evaluator binding。',
          );
        }
        return port;
      },
    });
  }
  if (toolTrajectoryPorts.size > 0) {
    registrations.push({
      implementationId: TOOL_TRAJECTORY_EVALUATOR_IMPLEMENTATION_ID,
      createPort(requirement) {
        const port = toolTrajectoryPorts.get(requirement.referenceId);
        if (port === undefined) {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Evaluation Runtime 收到了未知 tool trajectory evaluator binding。',
          );
        }
        return port;
      },
    });
  }
  if (rubricEntries.length > 0) {
    registrations.push(createRubricJudgeRegistration(
      rubricEntries.map((entry) => entry.kit),
    ));
  }
  for (const implementationId of [...new Set(customEntries.map(
    (entry) => entry.implementationId,
  ))].sort(compareStrings)) {
    const matchingEntries = customEntries.filter((entry) => (
      entry.implementationId === implementationId
    ));
    const versions = new Set(matchingEntries.map((entry) => entry.version));
    if (versions.size !== 1) {
      return configurationFailure(
        'EVAL_RUNTIME_EVALUATOR_INVALID',
        '同一 Custom Evaluator implementationId 在一次 Evaluation 中只能声明一个版本。',
      );
    }
    const version = matchingEntries[0]!.version;
    const ports = new Map(matchingEntries.map((entry) => [entry.evaluatorId, entry.port]));
    registrations.push({
      implementationId,
      satisfiesVersionConstraint: (constraint) => constraint === version,
      createPort(requirement) {
        const port = ports.get(requirement.referenceId);
        if (port === undefined) {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Evaluation Runtime 收到了未知 custom evaluator binding。',
          );
        }
        return port;
      },
    });
  }
  return Object.freeze({
    dataset: preparedDataset,
    definitions: Object.freeze([...definitions].sort((left, right) => (
      left.evaluatorId < right.evaluatorId ? -1 : left.evaluatorId > right.evaluatorId ? 1 : 0
    ))),
    metrics: Object.freeze([...metrics].sort((left, right) => (
      left.metricId < right.metricId ? -1 : left.metricId > right.metricId ? 1 : 0
    ))),
    measurementAggregations,
    registrations: Object.freeze(registrations),
  });
}

interface AnalysisBinding {
  readonly analysisId: string;
  readonly analysisKind: AnalysisRequest['analysisKind'];
  readonly resultId: string;
  readonly metricId: string;
  readonly variantId?: string;
  readonly comparisonId?: string;
  readonly treatmentVariantId?: string;
}

function stableFacadeId(
  identityKind: 'node' | 'decision' | 'slot',
  selector: Readonly<Record<string, JsonValue>>,
): string {
  return `${identityKind}:${digestCanonicalJson({
    derivation: 'omk.eval-runtime.definition-binding/v1',
    selector,
  }).slice('sha256:'.length)}`;
}

function targetDefinition(variant: Readonly<CapturedVariant>) {
  return {
    targetId: variant.variantId,
    targetKind: variant.artifact.kind,
    protocolId: variant.executor.protocolId,
    executorId: variant.executor.declaration.executorId,
    executionRequirements: {
      systemInstructions: 'not-required' as const,
      workspace: 'not-required' as const,
      mcp: 'not-required' as const,
      mockInterception: 'not-required' as const,
      toolPolicy: 'runtime-default' as const,
      skillDiscovery: 'runtime-default' as const,
    },
    executionControls: {
      defaults: {
        workspace: { workspaceMode: 'not-required' as const },
        tools: { toolPolicyKind: 'runtime-default' as const },
      },
      sampleOverrides: [],
    },
    config: variant.envelope,
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function alphaFromConfidenceLevel(level: number): number {
  return Number((1 - level).toPrecision(15));
}

function createGeneralDefinition(input: Readonly<{
  variants: readonly Readonly<CapturedVariant>[];
  evaluators: CapturedEvaluators;
  comparisons: readonly Comparison[];
  experiment: Experiment;
  analyses: readonly AnalysisRequest[];
  decision?: Decision;
}>): EvaluationDefinition {
  const variants = [...input.variants].sort((left, right) => (
    compareStrings(left.variantId, right.variantId)
  ));
  const variantIds = variants.map((variant) => variant.variantId);
  if (new Set(variantIds).size !== variantIds.length) {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variantId 必须唯一。',
    );
  }
  const metrics = [...input.evaluators.metrics];
  const declaredCompositeMetricIds = new Set(input.analyses.flatMap((request) => (
    request.analysisKind === 'composite-quality-interval'
      || request.analysisKind === 'composite-comparison-interval'
      ? [request.compositeMetricId]
      : []
  )));
  const metricIds = new Set([
    ...metrics.map((metric) => metric.metricId),
    ...declaredCompositeMetricIds,
  ]);
  let comparisons: Comparison[];
  try {
    comparisons = input.comparisons.map((comparison) => (
      ComparisonInputSchema.parse(structuredClone(comparison))
    )).sort((left, right) => compareStrings(left.comparisonId, right.comparisonId));
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation comparisons declaration 无效。',
    );
  }
  if (new Set(comparisons.map((comparison) => comparison.comparisonId)).size
      !== comparisons.length) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation comparisonId 必须唯一。',
    );
  }
  const variantIdSet = new Set(variantIds);
  for (const comparison of comparisons) {
    const treatmentIds = new Set(comparison.treatmentVariantIds);
    if (!variantIdSet.has(comparison.controlVariantId)
        || treatmentIds.size !== comparison.treatmentVariantIds.length
        || treatmentIds.has(comparison.controlVariantId)
        || [...treatmentIds].some((variantId) => !variantIdSet.has(variantId))
        || new Set(comparison.metricIds).size !== comparison.metricIds.length
        || comparison.metricIds.some((metricId) => !metricIds.has(metricId))) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation comparison 引用了无效或重复的 Variant／Metric。',
      );
    }
  }
  const sampling = input.experiment.sampling;
  const isClustered = sampling.samplingKind === 'solo' && sampling.clusterKey !== undefined;
  if (sampling.samplingKind === 'solo') {
    if (variants.length !== 1 || comparisons.length !== 0) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'solo sampling 要求恰好一个 Variant，且不声明 Comparison。',
      );
    }
  } else {
    const participatingVariantIds = new Set(comparisons.flatMap((comparison) => [
      comparison.controlVariantId,
      ...comparison.treatmentVariantIds,
    ]));
    if (variants.length < 2 || comparisons.length === 0
        || variantIds.some((variantId) => !participatingVariantIds.has(variantId))) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        `${sampling.samplingKind} sampling 要求至少两个 Variant，且每个 Variant 都进入显式 Comparison。`,
      );
    }
    if (sampling.samplingKind === 'independent') {
      const allocationIds = sampling.allocations.map((allocation) => allocation.variantId);
      if (new Set(allocationIds).size !== allocationIds.length
          || [...allocationIds].sort(compareStrings).join('\u0000')
            !== [...variantIds].sort(compareStrings).join('\u0000')) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'independent allocations 必须恰好声明每个 Variant 一次。',
        );
      }
    }
  }
  let analyses: z.infer<typeof AnalysesInputSchema>;
  try {
    analyses = AnalysesInputSchema.parse(structuredClone(input.analyses));
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation analysis declaration 无效。',
    );
  }
  const requests = [...analyses].sort((left, right) => (
    compareStrings(left.analysisId, right.analysisId)
  ));
  const declaredAnalysisIds = requests.flatMap((request) => [
    request.analysisId,
    ...(request.analysisKind === 'comparison-family'
      ? request.members.map((member) => member.analysisId)
      : []),
  ]);
  if (new Set(declaredAnalysisIds).size !== declaredAnalysisIds.length) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation analysisId 必须唯一。',
    );
  }
  const sourceMetricsById = new Map(input.evaluators.metrics.map((metric) => [
    metric.metricId,
    metric,
  ]));
  const compositeContractById = new Map<string, string>();
  for (const request of requests) {
    if (request.analysisKind !== 'composite-quality-interval'
        && request.analysisKind !== 'composite-comparison-interval') continue;
    const components = [...request.components].sort((left, right) => (
      compareStrings(left.metricId, right.metricId)
    ));
    const componentIds = components.map((component) => component.metricId);
    const totalWeight = components.reduce((sum, component) => sum + component.weight, 0);
    const sourcesSupported = components.every((component) => {
      const metric = sourceMetricsById.get(component.metricId);
      if (metric === undefined || metric.scope !== 'sample'
          || metric.missingPolicyId !== 'exclude/v1'
          || (metric.direction !== 'higher-is-better'
            && metric.direction !== 'lower-is-better')) return false;
      return metric.valueType === 'boolean'
        || (metric.valueType === 'numeric'
          && typeof metric.scale?.min === 'number'
          && Number.isFinite(metric.scale.min)
          && typeof metric.scale.max === 'number'
          && Number.isFinite(metric.scale.max)
          && metric.scale.min < metric.scale.max
          && metric.scale.target === undefined);
    });
    if (sourceMetricsById.has(request.compositeMetricId)
        || componentIds.length < 2
        || new Set(componentIds).size !== componentIds.length
        || componentIds.includes(request.compositeMetricId)
        || totalWeight !== 1
        || !sourcesSupported) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Composite analysis 要求唯一的 derived Metric、至少两个受支持 source Metric，以及严格求和为一的正权重。',
      );
    }
    const contract = canonicalizeJson({
      components,
      aggregation: request.aggregation,
    });
    const existing = compositeContractById.get(request.compositeMetricId);
    if (existing !== undefined && existing !== contract) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        '同一 compositeMetricId 在一次 Evaluation 中必须声明完全一致的 construct。',
      );
    }
    compositeContractById.set(request.compositeMetricId, contract);
  }
  const compositeComparisonBindings = new Set(requests.flatMap((request) => (
    request.analysisKind === 'composite-comparison-interval'
      ? [canonicalizeJson([request.comparisonId, request.compositeMetricId])]
      : []
  )));
  for (const comparison of comparisons) {
    if (comparison.metricIds.some((metricId) => (
      compositeContractById.has(metricId)
      && !compositeComparisonBindings.has(canonicalizeJson([
        comparison.comparisonId,
        metricId,
      ]))
    ))) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Derived composite Metric 只能绑定到声明它的 composite comparison。',
      );
    }
  }
  for (const compositeMetricId of [...compositeContractById.keys()].sort(compareStrings)) {
    metrics.push(MetricDefinitionSchema.parse({
      metricId: compositeMetricId,
      valueType: 'numeric',
      scope: 'sample',
      scale: { min: 0, max: 1 },
      unit: 'utility',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    }));
  }
  const cohortIds = new Set(
    (input.evaluators.dataset.analysisCohorts ?? []).map((cohort) => cohort.cohortId),
  );
  const analysisNodes: EvaluationDefinition['analysisGraph']['nodes'] = [];
  const analysisBindings: AnalysisBinding[] = [];
  type CanonicalCohortFilter = Readonly<{
    includeCohortIds?: string[];
    excludeCohortIds?: string[];
  }>;
  const canonicalCohortFilter = (
    filter: z.infer<typeof CohortFilterInputSchema> | undefined,
  ): CanonicalCohortFilter | undefined => {
    const selectedCohortIds = [
      ...(filter?.includeCohortIds ?? []),
      ...(filter?.excludeCohortIds ?? []),
    ];
    if (new Set(selectedCohortIds).size !== selectedCohortIds.length
        || selectedCohortIds.some((cohortId) => !cohortIds.has(cohortId))) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation analysis 引用了未知或重复的 cohort。',
      );
    }
    if (filter?.includeCohortIds?.some((cohortId) => (
      filter.excludeCohortIds?.includes(cohortId)
    ))) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation analysis 不能同时包含并排除同一个 cohort。',
      );
    }
    return filter === undefined ? undefined : {
      ...(filter.includeCohortIds === undefined ? {} : {
        includeCohortIds: [...filter.includeCohortIds].sort(compareStrings),
      }),
      ...(filter.excludeCohortIds === undefined ? {} : {
        excludeCohortIds: [...filter.excludeCohortIds].sort(compareStrings),
      }),
    };
  };
  const addComparisonInterval = (
    selector: Readonly<{
      analysisId: string;
      comparisonId: string;
      treatmentVariantId: string;
      metricId: string;
    }>,
    parameters: Readonly<{ alpha: number; resamples: number }>,
    cohortFilter: CanonicalCohortFilter | undefined,
  ): void => {
    const metric = sourceMetricsById.get(selector.metricId);
    if (metric === undefined
        || (metric.valueType !== 'numeric' && metric.valueType !== 'boolean')) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation comparison interval 只接受已声明的 numeric 或 boolean Metric。',
      );
    }
    const comparison = comparisons.find((candidate) => (
      candidate.comparisonId === selector.comparisonId
    ));
    if (comparison === undefined
        || !comparison.treatmentVariantIds.includes(selector.treatmentVariantId)
        || !comparison.metricIds.includes(selector.metricId)) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation comparison interval 引用了未知 Comparison、Treatment 或 Metric。',
      );
    }
    const measurementAggregation = input.evaluators.measurementAggregations.get(selector.metricId);
    analysisNodes.push({
      analysisNodeKind: 'estimator',
      nodeId: stableFacadeId('node', { analysisId: selector.analysisId }),
      implementationId: sampling.samplingKind === 'independent'
        ? measurementAggregation === undefined
          ? 'bootstrap.unpaired-difference-percentile/v1'
          : 'bootstrap.hierarchical-unpaired-difference-percentile/v1'
        : measurementAggregation === undefined
          ? 'bootstrap.paired-difference-percentile/v1'
          : 'bootstrap.hierarchical-paired-difference-percentile/v1',
      inputs: [{
        inputKind: 'metric-observations',
        referenceId: selector.metricId,
      }, {
        inputKind: 'comparison',
        referenceId: selector.comparisonId,
        treatmentTargetId: selector.treatmentVariantId,
        metricId: selector.metricId,
      }],
      outputResultId: selector.analysisId,
      ...(cohortFilter === undefined ? {} : { cohortFilter }),
      parameters: {
        ...parameters,
        ...(measurementAggregation === undefined ? {} : {
          measurementAggregation: JsonValueSchema.parse(
            structuredClone(measurementAggregation),
          ),
        }),
      },
    });
    analysisBindings.push({
      analysisId: selector.analysisId,
      analysisKind: 'comparison-interval',
      resultId: selector.analysisId,
      metricId: selector.metricId,
      comparisonId: selector.comparisonId,
      treatmentVariantId: selector.treatmentVariantId,
    });
  };
  for (const request of requests) {
    const cohortFilter = canonicalCohortFilter(request.cohortFilter);
    if (request.analysisKind === 'comparison-family') {
      const members = [...request.members].sort((left, right) => (
        compareStrings(left.analysisId, right.analysisId)
      ));
      const contrastSelectors = members.map((member) => canonicalizeJson([
        member.comparisonId,
        member.treatmentVariantId,
        member.metricId,
      ]));
      if (new Set(contrastSelectors).size !== contrastSelectors.length) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation comparison family 不能重复声明同一个 contrast。',
        );
      }
      let alpha: number;
      try {
        alpha = bonferroniMarginalAlpha(request.confidence.level, members.length);
        bonferroniMarginalConfidenceLevel(request.confidence.level, members.length);
      } catch {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation comparison family 无法表示有效的边际置信度。',
        );
      }
      for (const member of members) {
        addComparisonInterval(
          member,
          { alpha, resamples: request.confidence.resamples },
          cohortFilter,
        );
      }
      analysisNodes.push({
        analysisNodeKind: 'correction',
        nodeId: stableFacadeId('node', { analysisId: request.analysisId }),
        implementationId: 'simultaneous-intervals.bonferroni/v1',
        inputs: members.map((member) => ({
          inputKind: 'analysis-result',
          referenceId: member.analysisId,
        })),
        outputResultId: request.analysisId,
        parameters: {
          familyConfidenceLevel: request.confidence.level,
          resamples: request.confidence.resamples,
        },
      });
      continue;
    }
    if (request.analysisKind === 'composite-quality-interval'
        || request.analysisKind === 'composite-comparison-interval') {
      const components = [...request.components].sort((left, right) => (
        compareStrings(left.metricId, right.metricId)
      ));
      const parameters = {
        compositeMetricId: request.compositeMetricId,
        components: components.map((component) => {
          const measurementAggregation = input.evaluators.measurementAggregations.get(
            component.metricId,
          );
          return {
            metricId: component.metricId,
            weight: component.weight,
            ...(measurementAggregation === undefined ? {} : {
              measurementAggregation: JsonValueSchema.parse(
                structuredClone(measurementAggregation),
              ),
            }),
          };
        }),
        aggregation: request.aggregation,
        resamples: request.confidence.resamples,
        alpha: alphaFromConfidenceLevel(request.confidence.level),
      };
      const common = {
        analysisNodeKind: 'estimator' as const,
        nodeId: stableFacadeId('node', { analysisId: request.analysisId }),
        inputs: components.map((component) => ({
          inputKind: 'metric-observations' as const,
          referenceId: component.metricId,
        })),
        outputResultId: request.analysisId,
        ...(cohortFilter === undefined ? {} : { cohortFilter }),
        parameters,
      };
      if (request.analysisKind === 'composite-quality-interval') {
        if (!variantIdSet.has(request.variantId)) {
          return configurationFailure(
            'EVAL_RUNTIME_INPUT_INVALID',
            'Composite quality interval 引用了未知 Variant。',
          );
        }
        analysisNodes.push({
          ...common,
          targetFilter: { includeTargetIds: [request.variantId] },
          implementationId: isClustered
            ? 'bootstrap.composite-cluster-percentile/v1'
            : 'bootstrap.composite-mean-percentile/v1',
        });
        analysisBindings.push({
          analysisId: request.analysisId,
          analysisKind: request.analysisKind,
          resultId: request.analysisId,
          metricId: request.compositeMetricId,
          variantId: request.variantId,
        });
        continue;
      }
      const comparison = comparisons.find((candidate) => (
        candidate.comparisonId === request.comparisonId
      ));
      if (sampling.samplingKind === 'solo'
          || comparison === undefined
          || !comparison.treatmentVariantIds.includes(request.treatmentVariantId)) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Composite comparison interval 要求 paired 或 independent sampling，以及有效的 Comparison 与 Treatment。',
        );
      }
      analysisNodes.push({
        ...common,
        implementationId: sampling.samplingKind === 'independent'
          ? 'bootstrap.composite-unpaired-difference-percentile/v1'
          : 'bootstrap.composite-paired-difference-percentile/v1',
        inputs: [...common.inputs, {
          inputKind: 'comparison',
          referenceId: request.comparisonId,
          treatmentTargetId: request.treatmentVariantId,
          metricId: request.compositeMetricId,
        }],
      });
      analysisBindings.push({
        analysisId: request.analysisId,
        analysisKind: request.analysisKind,
        resultId: request.analysisId,
        metricId: request.compositeMetricId,
        comparisonId: request.comparisonId,
        treatmentVariantId: request.treatmentVariantId,
      });
      continue;
    }
    const metric = sourceMetricsById.get(request.metricId);
    if (metric === undefined) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation analysis 引用了未知 Metric。',
      );
    }
    const resultId = request.analysisId;
    const common = {
      nodeId: stableFacadeId('node', { analysisId: request.analysisId }),
      inputs: [{ inputKind: 'metric-observations' as const, referenceId: request.metricId }],
      outputResultId: resultId,
      ...(cohortFilter === undefined ? {} : {
        cohortFilter,
      }),
    };
    const measurementAggregation = input.evaluators.measurementAggregations.get(request.metricId);
    if (request.analysisKind === 'summary') {
      if (!variantIdSet.has(request.variantId)
          || (request.statistic === 'mean' && metric.valueType !== 'numeric')
          || (request.statistic === 'rate' && metric.valueType !== 'boolean')
          || (request.statistic === 'quantile' && metric.valueType !== 'numeric')
          || (request.statistic === 'quantile') !== (request.probability !== undefined)) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation summary 的 Variant、Metric、statistic 或 probability 不匹配。',
        );
      }
      analysisNodes.push({
        ...common,
        analysisNodeKind: 'reducer',
        targetFilter: { includeTargetIds: [request.variantId] },
        implementationId: measurementAggregation === undefined
          ? `descriptive.${request.statistic}/v1`
          : `descriptive.hierarchical-${request.statistic}/v1`,
        parameters: {
          ...(request.statistic === 'quantile'
            ? { probability: request.probability as number }
            : {}),
          ...(measurementAggregation === undefined ? {} : {
            measurementAggregation: JsonValueSchema.parse(
              structuredClone(measurementAggregation),
            ),
          }),
        },
      });
      analysisBindings.push({
        analysisId: request.analysisId,
        analysisKind: request.analysisKind,
        resultId,
        metricId: request.metricId,
        variantId: request.variantId,
      });
      continue;
    }
    if (metric.valueType !== 'numeric' && metric.valueType !== 'boolean') {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation interval 只接受 numeric 或 boolean Metric。',
      );
    }
    const parameters = {
      resamples: request.confidence.resamples,
      alpha: alphaFromConfidenceLevel(request.confidence.level),
      ...(measurementAggregation === undefined ? {} : {
        measurementAggregation: JsonValueSchema.parse(structuredClone(measurementAggregation)),
      }),
    };
    if (request.analysisKind === 'quality-interval') {
      if (!variantIdSet.has(request.variantId)) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation quality interval 引用了未知 Variant。',
        );
      }
      analysisNodes.push({
        ...common,
        analysisNodeKind: 'estimator',
        targetFilter: { includeTargetIds: [request.variantId] },
        implementationId: isClustered
          ? measurementAggregation === undefined
            ? 'bootstrap.cluster-percentile/v1'
            : 'bootstrap.hierarchical-cluster-percentile/v1'
          : measurementAggregation === undefined
            ? 'bootstrap.mean-percentile/v1'
            : 'bootstrap.hierarchical-mean-percentile/v1',
        parameters,
      });
      analysisBindings.push({
        analysisId: request.analysisId,
        analysisKind: request.analysisKind,
        resultId,
        metricId: request.metricId,
        variantId: request.variantId,
      });
      continue;
    }
    addComparisonInterval(request, parameters, cohortFilter);
  }
  let decisionPolicy;
  if (input.decision !== undefined) {
    let parsedDecision: z.infer<typeof DecisionInputSchema>;
    try {
      parsedDecision = DecisionInputSchema.parse(structuredClone(input.decision));
    } catch {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation decision declaration 无效。',
      );
    }
    if (parsedDecision.decisionKind === 'comparison-family') {
      const family = requests.find((request) => (
        request.analysisId === parsedDecision.analysisId
        && request.analysisKind === 'comparison-family'
      ));
      if (family === undefined || family.analysisKind !== 'comparison-family') {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation comparison-family decision 必须精确选择一个 comparison-family analysis。',
        );
      }
      const criteria = [...parsedDecision.criteria].sort((left, right) => (
        compareStrings(left.analysisId, right.analysisId)
      ));
      const criterionIds = criteria.map((criterion) => criterion.analysisId);
      const memberIds = [...family.members]
        .map((member) => member.analysisId)
        .sort(compareStrings);
      if (new Set(criterionIds).size !== criterionIds.length
          || canonicalizeJson(criterionIds) !== canonicalizeJson(memberIds)) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation comparison-family decision criteria 必须恰好覆盖全部 family member。',
        );
      }
      const members = [...family.members].sort((left, right) => (
        compareStrings(left.analysisId, right.analysisId)
      ));
      decisionPolicy = {
        decisionPolicyId: stableFacadeId('decision', {
          decisionKind: parsedDecision.decisionKind,
          resultId: family.analysisId,
        }),
        implementationId: 'release-family/v1',
        analysisResultIds: [family.analysisId],
        comparisonFamily: members.map((member) => ({
          comparisonId: member.comparisonId,
          treatmentTargetId: member.treatmentVariantId,
          metricId: member.metricId,
          analysisResultId: member.analysisId,
        })),
        comparisonFamilyResultId: family.analysisId,
        multipleComparisonPolicyId: 'simultaneous-intervals.bonferroni/v1',
        minimumEvidenceStatus: parsedDecision.minimumEvidenceStatus ?? 'complete',
        parameters: {
          rule: parsedDecision.rule,
          criteria: criteria.map((criterion) => ({
            analysisResultId: criterion.analysisId,
            ...(criterion.minimumEffect === undefined ? {} : {
              minimumEffect: criterion.minimumEffect,
            }),
            ...(criterion.maximumEffect === undefined ? {} : {
              maximumEffect: criterion.maximumEffect,
            }),
          })),
        },
      };
    } else {
      const selected = analysisBindings.filter((binding) => (
        binding.analysisId === parsedDecision.analysisId
      ));
      if (selected.length !== 1
          || (selected[0].analysisKind !== 'quality-interval'
            && selected[0].analysisKind !== 'comparison-interval'
            && selected[0].analysisKind !== 'composite-quality-interval'
            && selected[0].analysisKind !== 'composite-comparison-interval')) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation decision 必须精确选择一个 interval analysis。',
        );
      }
      const chosen = selected[0];
      const decisionMetric = metrics.find((metric) => metric.metricId === chosen.metricId);
      if (decisionMetric?.direction !== 'higher-is-better') {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Canonical progress Decision 只接受 higher-is-better Metric。',
        );
      }
      decisionPolicy = {
        decisionPolicyId: stableFacadeId('decision', {
          decisionKind: parsedDecision.decisionKind,
          resultId: chosen.resultId,
        }),
        implementationId: 'progress/v2',
        analysisResultIds: [chosen.resultId],
        ...(chosen.comparisonId === undefined ? {} : {
          comparisonFamily: [{
            comparisonId: chosen.comparisonId,
            treatmentTargetId: chosen.treatmentVariantId as string,
            metricId: chosen.metricId,
            analysisResultId: chosen.resultId,
          }],
        }),
        minimumEvidenceStatus: parsedDecision.minimumEvidenceStatus ?? 'complete',
        parameters: {
          threshold: parsedDecision.threshold ?? 0,
          equivalence: parsedDecision.equivalence ?? 0,
        },
      };
    }
  }
  const trials = input.experiment.trials ?? 1;
  const hasHierarchicalMeasurement = input.evaluators.measurementAggregations.size > 0;
  const estimatorId = sampling.samplingKind === 'solo'
    ? isClustered
      ? hasHierarchicalMeasurement
        ? 'bootstrap.hierarchical-cluster-percentile/v1'
        : 'bootstrap.cluster-percentile/v1'
      : hasHierarchicalMeasurement
        ? 'bootstrap.hierarchical-mean-percentile/v1'
        : 'bootstrap.mean-percentile/v1'
    : sampling.samplingKind === 'independent'
      ? hasHierarchicalMeasurement
        ? 'bootstrap.hierarchical-unpaired-difference-percentile/v1'
        : 'bootstrap.unpaired-difference-percentile/v1'
      : hasHierarchicalMeasurement
        ? 'bootstrap.hierarchical-paired-difference-percentile/v1'
        : 'bootstrap.paired-difference-percentile/v1';
  const randomizationSlots = variants.map((variant) => ({
    targetId: variant.variantId,
    randomizationSlotId: stableFacadeId('slot', { variantId: variant.variantId }),
  })).sort((left, right) => compareStrings(
    left.randomizationSlotId,
    right.randomizationSlotId,
  ));
  const slotByVariant = new Map(randomizationSlots.map((slot) => (
    [slot.targetId, slot.randomizationSlotId] as const
  )));
  const derivedComparisonMetricIds = new Map<string, Set<string>>();
  for (const request of requests) {
    if (request.analysisKind !== 'composite-comparison-interval') continue;
    const ids = derivedComparisonMetricIds.get(request.comparisonId) ?? new Set<string>();
    ids.add(request.compositeMetricId);
    derivedComparisonMetricIds.set(request.comparisonId, ids);
  }
  const definition = EvaluationDefinitionSchema.parse({
    schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
    dataset: input.evaluators.dataset,
    targets: variants.map(targetDefinition),
    evaluators: input.evaluators.definitions,
    metrics,
    experiment: {
      trials,
      seed: input.experiment.seed,
      assignment: sampling.samplingKind === 'independent' ? {
        assignmentKind: 'independent-groups',
        algorithmId: 'assignment.stratified-fixed-quota/v1',
        ...(sampling.stratumKey === undefined ? {} : { stratumKey: sampling.stratumKey }),
        allocations: sampling.allocations.map((allocation) => {
          const randomizationSlotId = slotByVariant.get(allocation.variantId);
          if (randomizationSlotId === undefined) {
            return configurationFailure(
              'EVAL_RUNTIME_INPUT_INVALID',
              'independent allocation 引用了未知 Variant。',
            );
          }
          return { randomizationSlotId, weight: allocation.weight };
        }).sort((left, right) => compareStrings(
          left.randomizationSlotId,
          right.randomizationSlotId,
        )),
        minimumUnitsPerTarget: sampling.minimumSamplesPerVariant,
        minimumUnitsPerTargetPerStratum: sampling.minimumSamplesPerVariantPerStratum,
      } : {
        assignmentKind: 'complete-block',
        algorithmId: 'assignment.complete-block/v1',
        ...(sampling.stratumKey === undefined ? {} : { stratumKey: sampling.stratumKey }),
        randomizationSlotIds: randomizationSlots.map((slot) => slot.randomizationSlotId),
      },
      sampling: sampling.samplingKind === 'solo' ? {
        experimentalUnit: isClustered ? 'cluster' : 'sample',
        ...(sampling.clusterKey === undefined ? {} : { clusterKey: sampling.clusterKey }),
        repeatedMeasures: trials > 1,
        resamplingUnit: isClustered ? 'cluster' : 'sample',
        estimatorId,
        seedCoupling: 'independent-by-target',
      } : {
        experimentalUnit: 'sample',
        ...(sampling.samplingKind === 'paired'
          ? { pairingKey: sampling.pairingKey ?? '/sampleId' }
          : {}),
        repeatedMeasures: trials > 1,
        resamplingUnit: sampling.samplingKind === 'independent' ? 'sample' : 'paired-block',
        estimatorId,
        seedCoupling: sampling.samplingKind === 'independent'
          ? 'independent-by-target'
          : sampling.seedCoupling ?? 'shared-within-block',
      },
      scheduling: input.experiment.scheduling ?? {
        schedulingKind: sampling.samplingKind === 'solo' ? 'sequential' : 'interleaved',
      },
      randomizationSlots,
    },
    analysisGraph: {
      analysisMode: 'preregistered',
      nodes: analysisNodes.sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
    },
    comparisons: comparisons.map((comparison) => ({
      comparisonId: comparison.comparisonId,
      controlTargetId: comparison.controlVariantId,
      treatmentTargetIds: [...comparison.treatmentVariantIds].sort(compareStrings),
      metricIds: [
        ...new Set([
          ...comparison.metricIds,
          ...(derivedComparisonMetricIds.get(comparison.comparisonId) ?? []),
        ]),
      ].sort(compareStrings),
    })),
    ...(decisionPolicy === undefined ? {} : { decisionPolicy }),
  });
  return deepFreezeCanonicalJson(definition);
}

function assertEvaluateInput(input: Readonly<{
  variants: readonly Variant[];
  evaluators: readonly Evaluator[];
  comparisons: readonly Comparison[];
  experiment: Experiment;
  analyses: readonly AnalysisRequest[];
  decision?: Decision;
  policy: Policy;
}>) {
  const allowedKeys = new Set([
    'dataset',
    'variants',
    'evaluators',
    'comparisons',
    'analyses',
    'decision',
    'experiment',
    'policy',
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))
      || !Array.isArray(input.variants) || input.variants.length === 0
      || !Array.isArray(input.evaluators) || input.evaluators.length === 0
      || !Array.isArray(input.comparisons)
      || !ExperimentSchema.safeParse(input.experiment).success
      || !AnalysesInputSchema.safeParse(input.analyses).success
      || (input.decision !== undefined && !DecisionInputSchema.safeParse(input.decision).success)
      || !z.array(ComparisonInputSchema).safeParse(input.comparisons).success
      || !PolicyInputSchema.safeParse(input.policy).success) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation input 包含无效或不受支持的字段。',
    );
  }
}

function captureRunOptions(
  value: Readonly<EvaluationRunOptions> | undefined,
): Readonly<EvaluationRunOptions> {
  const input = value === undefined ? {} : value;
  const allowedKeys = new Set([
    'runId',
    'signal',
    'annotations',
    'summaries',
    'eventBufferCapacity',
    'onEvent',
    'clock',
  ]);
  if (input === null || typeof input !== 'object'
      || Object.keys(input).some((key) => !allowedKeys.has(key))
      || (input.runId !== undefined && !IdentifierSchema.safeParse(input.runId).success)
      || (input.eventBufferCapacity !== undefined
        && (!Number.isSafeInteger(input.eventBufferCapacity) || input.eventBufferCapacity < 1))
      || (input.signal !== undefined && (
        input.signal === null || typeof input.signal !== 'object'
        || typeof input.signal.aborted !== 'boolean'
        || typeof input.signal.addEventListener !== 'function'
        || typeof input.signal.removeEventListener !== 'function'
      ))
      || (input.annotations !== undefined && !JsonValueSchema.safeParse(input.annotations).success)
      || (input.summaries !== undefined && !JsonValueSchema.safeParse(input.summaries).success)
      || (input.onEvent !== undefined && typeof input.onEvent !== 'function')
      || (input.clock !== undefined && (
        input.clock === null || typeof input.clock !== 'object'
        || typeof input.clock.monotonicNow !== 'function'
        || typeof input.clock.timestamp !== 'function'
        || typeof input.clock.sleep !== 'function'
      ))) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation run options 包含无效或不受支持的字段。',
    );
  }
  return Object.freeze({
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.annotations === undefined ? {} : {
      annotations: deepFreezeCanonicalJson(structuredClone(input.annotations)),
    }),
    ...(input.summaries === undefined ? {} : {
      summaries: deepFreezeCanonicalJson(structuredClone(input.summaries)),
    }),
    ...(input.eventBufferCapacity === undefined
      ? {}
      : { eventBufferCapacity: input.eventBufferCapacity }),
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
}

function collectResolvedRuntimes(plan: SealedRunPlan): readonly RuntimeCapabilityResolution[] {
  const unique = new Map<string, RuntimeCapabilityResolution>();
  for (const runtime of [
    ...plan.execution.runtimes,
    ...plan.evaluation.runtimes,
    ...plan.analysis.runtimes,
    ...plan.decision.runtimes,
  ]) {
    unique.set(canonicalizeJson(runtime), runtime);
  }
  return Object.freeze([...unique.values()].sort((left, right) => (
    compareStrings(
      `${left.runtimeKind}\u0000${left.referenceId}\u0000${canonicalizeJson(left.identity)}`,
      `${right.runtimeKind}\u0000${right.referenceId}\u0000${canonicalizeJson(right.identity)}`,
    )
  )));
}

function estimateEvaluationWork(plan: SealedRunPlan): EvaluationWorkEstimate {
  const trials = plan.execution.experiment.trials;
  const executionCoordinates = derivePlannedExecutionCoordinates(plan);
  const evaluatorsBySampleId = new Map<string, number>();
  for (const sample of plan.evaluation.samples) {
    evaluatorsBySampleId.set(sample.sampleId, plan.evaluation.evaluators.filter((evaluator) => (
      evaluator.applicableSampleIds === undefined
      || evaluator.applicableSampleIds.includes(sample.sampleId)
    )).length);
  }
  const evaluationCoordinates = executionCoordinates.reduce((total, coordinate) => (
    total + (evaluatorsBySampleId.get(coordinate.sampleId) ?? 0)
  ), 0);
  const uncertain: EvaluationWorkEstimate['uncertain'][number][] = [
    'early-termination',
    'active-duration',
    'wall-clock',
    'provider-cost',
  ];
  if (plan.measurementPolicy.retry.maxAttempts > 1
      || plan.measurementPolicy.evaluation.retry.maxAttempts > 1) {
    uncertain.unshift('retries');
  }
  return Object.freeze({
    sampleCount: plan.execution.samples.length,
    variantCount: plan.execution.targets.length,
    trialCount: trials,
    executionCoordinates: executionCoordinates.length,
    evaluationCoordinates,
    plannedInvocations: executionCoordinates.length + evaluationCoordinates,
    uncertain: Object.freeze(uncertain),
  });
}

async function runPrepared(
  prepared: CorePreparedEvaluation,
  optionsInput?: Readonly<EvaluationRunOptions>,
): Promise<EvaluationResult> {
  const options = captureRunOptions(optionsInput);
  const runId = options.runId ?? `run-${randomUUID()}`;
  const definition = prepared.plan.definition;
  const policy = prepared.plan.measurementPolicy;
  try {
    const result = await runPreparedEvaluation({
      prepared,
      runId,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
      ...(options.summaries === undefined ? {} : { summaries: options.summaries }),
      ...(options.eventBufferCapacity === undefined
        ? {}
        : { eventBufferCapacity: options.eventBufferCapacity }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    return attachDefinition(result, runId, definition, policy);
  } catch (error) {
    if (error instanceof AdvancedEvaluationEventConsumptionError) {
      throw new EvaluationEventConsumptionError({
        code: error.code,
        message: error.message,
        ...(error.runResult === undefined
          ? {}
          : { runResult: attachDefinition(error.runResult, runId, definition, policy) }),
      });
    }
    throw error;
  }
}

/** Seals one evaluation declaration without calling a Target or Evaluator. */
export async function prepareEvaluation(
  input: Readonly<EvaluateInput>,
): Promise<PreparedEvaluation> {
  if (input === null || typeof input !== 'object') {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation input 无效。',
    );
  }
  assertEvaluateInput(input);
  const dataset = captureDataset(input.dataset);
  const variants = input.variants.map(captureVariant);
  const evaluators = captureEvaluators(dataset, input.evaluators);

  let definition: EvaluationDefinition;
  try {
    definition = createGeneralDefinition({
      variants,
      evaluators,
      comparisons: input.comparisons,
      experiment: input.experiment,
      analyses: input.analyses,
      ...(input.decision === undefined ? {} : { decision: input.decision }),
    });
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    if (error instanceof EvaluationDefinitionError && error.stage !== 'configuration') {
      throw error;
    }
    if (!(error instanceof EvaluationDefinitionError)
        && !(error instanceof EvaluationRuntimeAssemblyError)) {
      throw error;
    }
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation experiment 无法编译为 Core Definition。',
    );
  }

  let policy;
  try {
    policy = createMeasurementPolicy(input.policy);
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation policy 无效。',
    );
  }
  const variantsByExecutor = new Map<string, Map<string, Readonly<CapturedVariant>>>();
  for (const variant of variants) {
    const executorId = variant.executor.declaration.executorId;
    const byVariant = variantsByExecutor.get(executorId) ?? new Map();
    byVariant.set(variant.variantId, variant);
    variantsByExecutor.set(executorId, byVariant);
  }
  const runtime = createEvaluationRuntime({
    executors: [...variantsByExecutor.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([executorId, byVariant]) => ({
        implementationId: executorId,
        createPort: (requirement) => {
          const variant = byVariant.get(requirement.referenceId);
          if (variant === undefined) {
            return configurationFailure(
              'EVAL_RUNTIME_VARIANT_INVALID',
              'Evaluation Runtime 收到了未知 variant binding。',
            );
          }
          return variant.executor.createPort(variant.variantId);
        },
    })),
    evaluators: evaluators.registrations,
  });
  try {
    const prepared = await createCoreEvaluationEngine(runtime).prepare(definition, policy);
    const plan = prepared.plan;
    return Object.freeze({
      definition: plan.definition,
      policy: plan.measurementPolicy,
      plan,
      planDigest: plan.digests.runContractDigest,
      resolvedRuntimes: collectResolvedRuntimes(plan),
      estimatedWork: estimateEvaluationWork(plan),
      run: (options?: Readonly<EvaluationRunOptions>) => runPrepared(prepared, options),
    });
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation 无法封存为可执行 Plan。',
    );
  }
}

/** Runs one explicit evaluation declaration through OMK's canonical user-facing API. */
export async function evaluate(
  input: Readonly<EvaluateInput>,
  options?: Readonly<EvaluationRunOptions>,
): Promise<EvaluationResult> {
  const capturedOptions = captureRunOptions(options);
  return (await prepareEvaluation(input)).run(capturedOptions);
}

/** Exercises one Executor through success, failure, cancellation, cleanup, and measurement checks. */
export async function checkExecutor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
>(
  input: Readonly<ExecutorCheckInput<Input, Config, Output, Trace>>,
): Promise<ExecutorCheckResult> {
  if (input === null || typeof input !== 'object') {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Executor check input 无效。',
    );
  }
  if (input.success === null || typeof input.success !== 'object'
      || input.failure === null || typeof input.failure !== 'object'
      || input.cancellation === null || typeof input.cancellation !== 'object'
      || (input.seed !== undefined && (typeof input.seed !== 'string' || input.seed.length === 0))
      || (input.runId !== undefined && !IdentifierSchema.safeParse(input.runId).success)) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Executor check probe declaration 无效。',
    );
  }
  const variant = captureVariant(input.variant);
  const executor = variant.executor;
  const successInput = parseWithoutTransform(
    executor.inputParser,
    input.success.input,
    'EVAL_RUNTIME_INPUT_INVALID',
    'Executor check success input 不符合 input schema，或 schema 改变了值。',
  );
  const successExpected = parseWithoutTransform(
    executor.outputParser,
    input.success.expected,
    'EVAL_RUNTIME_INPUT_INVALID',
    'Executor check expected output 不符合 output schema，或 schema 改变了值。',
  );
  const failureInput = parseWithoutTransform(
    executor.inputParser,
    input.failure.input,
    'EVAL_RUNTIME_INPUT_INVALID',
    'Executor check failure input 不符合 input schema，或 schema 改变了值。',
  );
  const cancellationInput = parseWithoutTransform(
    executor.inputParser,
    input.cancellation.input,
    'EVAL_RUNTIME_INPUT_INVALID',
    'Executor check cancellation input 不符合 input schema，或 schema 改变了值。',
  );
  if (!IdentifierSchema.safeParse(input.failure.expectedErrorCode).success) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Executor check expectedErrorCode 无效。',
    );
  }
  return runExecutorConformance({
    implementationId: executor.declaration.executorId,
    protocolId: executor.protocolId,
    createExecutor() {
      return executor.createPort(variant.variantId);
    },
    success: {
      input: successInput,
      expected: successExpected,
      targetConfig: variant.envelope,
    },
    failure: {
      input: failureInput,
      expectedErrorCode: input.failure.expectedErrorCode,
      targetConfig: variant.envelope,
    },
    cancellation: {
      input: cancellationInput,
      targetConfig: variant.envelope,
    },
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
}
