import { z } from 'zod';
import {
  CacheProvenanceSchema,
  CapturedContentSchema,
  EvaluationErrorSchema,
  ExtensionsSchema,
  IdentifierSchema,
  NonEmptyStringSchema,
  ProvenanceSchema,
  ReplayabilitySchema,
  RuntimeIdentitySchema,
  Sha256DigestSchema,
  TimestampSchema,
  UriSchema,
} from './common.js';
import { JsonValueSchema } from './json.js';

export const EVALUATION_EVENT_SCHEMA_VERSION = 'omk.evaluation-event/v1' as const;
export const EXECUTION_BUNDLE_SCHEMA_VERSION = 'omk.execution-bundle/v1' as const;
export const EVALUATION_BUNDLE_SCHEMA_VERSION = 'omk.evaluation-bundle/v1' as const;
export const ANALYSIS_BUNDLE_SCHEMA_VERSION = 'omk.analysis-bundle/v1' as const;
export const EVALUATION_REPORT_SCHEMA_VERSION = 'omk.evaluation-report/v1' as const;

export const TimingRecordSchema = z.object({
  startedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
}).strict();

export const ProviderCostSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reportedByProvider: z.literal(true),
}).strict();

export const UsageRecordSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  providerCost: ProviderCostSchema.optional(),
  details: JsonValueSchema.optional(),
}).strict();

const ExecutionAttemptBaseSchema = z.object({
  attemptId: Sha256DigestSchema,
  attemptNumber: z.number().int().positive(),
  timing: TimingRecordSchema,
  usage: UsageRecordSchema.optional(),
}).strict();

export const ExecutionAttemptSchema = z.discriminatedUnion('attemptStatus', [
  ExecutionAttemptBaseSchema.extend({
    attemptStatus: z.literal('completed'),
  }).strict(),
  ExecutionAttemptBaseSchema.extend({
    attemptStatus: z.literal('failed'),
    error: EvaluationErrorSchema,
  }).strict(),
  ExecutionAttemptBaseSchema.extend({
    attemptStatus: z.literal('cancelled'),
    error: EvaluationErrorSchema.optional(),
  }).strict(),
]);

export const SamplingUnitIdsSchema = z.object({
  pairingBlockId: Sha256DigestSchema.optional(),
  clusterId: Sha256DigestSchema.optional(),
  stratumId: Sha256DigestSchema.optional(),
}).strict();

const ExecutionRecordIdentitySchema = z.object({
  targetId: IdentifierSchema,
  sampleId: IdentifierSchema,
  trialIndex: z.number().int().nonnegative(),
  trialId: Sha256DigestSchema,
  trialSeed: Sha256DigestSchema,
  schedulingBlockId: Sha256DigestSchema,
  samplingUnitIds: SamplingUnitIdsSchema,
  runtime: RuntimeIdentitySchema,
  provenance: ProvenanceSchema,
}).strict();

const ActiveExecutionRecordBaseSchema = ExecutionRecordIdentitySchema.extend({
  attempts: z.array(ExecutionAttemptSchema).min(1),
  timing: TimingRecordSchema,
  usage: UsageRecordSchema.optional(),
  trace: CapturedContentSchema.optional(),
  cache: CacheProvenanceSchema,
}).strict();

export const CompletedExecutionRecordSchema = ActiveExecutionRecordBaseSchema.extend({
  executionStatus: z.literal('completed'),
  output: CapturedContentSchema.optional(),
}).strict();

export const FailedExecutionRecordSchema = ActiveExecutionRecordBaseSchema.extend({
  executionStatus: z.literal('failed'),
  error: EvaluationErrorSchema,
}).strict();

export const CancelledExecutionRecordSchema = ActiveExecutionRecordBaseSchema.extend({
  executionStatus: z.literal('cancelled'),
  error: EvaluationErrorSchema.optional(),
}).strict();

export const CensoredExecutionRecordSchema = ExecutionRecordIdentitySchema.extend({
  executionStatus: z.literal('budget-censored'),
  censorReasonCode: IdentifierSchema,
  censoredAt: TimestampSchema,
}).strict();

export const ExecutionRecordSchema = z.discriminatedUnion('executionStatus', [
  CompletedExecutionRecordSchema,
  FailedExecutionRecordSchema,
  CancelledExecutionRecordSchema,
  CensoredExecutionRecordSchema,
]);

export const ExecutionCoverageSchema = z.object({
  planned: z.number().int().nonnegative(),
  started: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  budgetCensored: z.number().int().nonnegative(),
  notStarted: z.number().int().nonnegative(),
}).strict();

export const ExecutionBundleSchema = z.object({
  schemaVersion: z.literal(EXECUTION_BUNDLE_SCHEMA_VERSION),
  bundleId: IdentifierSchema,
  runContractDigest: Sha256DigestSchema,
  executionPlanDigest: Sha256DigestSchema,
  datasetRevisionDigest: Sha256DigestSchema,
  executionInputDigest: Sha256DigestSchema,
  executionBundleStatus: z.enum([
    'completed',
    'cancelled',
    'budget-exhausted',
    'failed',
  ]),
  terminationReasonCode: IdentifierSchema.optional(),
  coverage: ExecutionCoverageSchema,
  replayability: ReplayabilitySchema,
  records: z.array(ExecutionRecordSchema),
  provenance: ProvenanceSchema,
  bundleDigest: Sha256DigestSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Execution Bundle v1',
});

const MetricObservationBaseSchema = z.object({
  observationId: Sha256DigestSchema,
  metricId: IdentifierSchema,
  evidence: CapturedContentSchema.optional(),
  metadata: CapturedContentSchema.optional(),
}).strict();

export const NumericMetricObservationSchema = MetricObservationBaseSchema.extend({
  observationStatus: z.literal('observed'),
  valueType: z.literal('numeric'),
  value: z.number(),
}).strict();

export const BooleanMetricObservationSchema = MetricObservationBaseSchema.extend({
  observationStatus: z.literal('observed'),
  valueType: z.literal('boolean'),
  value: z.boolean(),
}).strict();

export const CategoricalMetricObservationSchema = MetricObservationBaseSchema.extend({
  observationStatus: z.literal('observed'),
  valueType: z.literal('categorical'),
  value: z.string(),
}).strict();

export const TextMetricObservationSchema = MetricObservationBaseSchema.extend({
  observationStatus: z.literal('observed'),
  valueType: z.literal('text'),
  value: z.string(),
}).strict();

export const RankingMetricObservationSchema = MetricObservationBaseSchema.extend({
  observationStatus: z.literal('observed'),
  valueType: z.literal('ranking'),
  value: z.array(IdentifierSchema),
}).strict();

export const MissingMetricObservationSchema = MetricObservationBaseSchema.extend({
  observationStatus: z.literal('missing'),
  valueType: z.enum(['numeric', 'boolean', 'categorical', 'text', 'ranking']),
  reasonCode: IdentifierSchema,
}).strict();

export const InvalidMetricObservationSchema = MetricObservationBaseSchema.extend({
  observationStatus: z.literal('invalid'),
  valueType: z.enum(['numeric', 'boolean', 'categorical', 'text', 'ranking']),
  reasonCode: IdentifierSchema,
  invalidValue: CapturedContentSchema.optional(),
}).strict();

export const MetricObservationSchema = z.union([
  NumericMetricObservationSchema,
  BooleanMetricObservationSchema,
  CategoricalMetricObservationSchema,
  TextMetricObservationSchema,
  RankingMetricObservationSchema,
  MissingMetricObservationSchema,
  InvalidMetricObservationSchema,
]);

const EvaluationAttemptBaseSchema = z.object({
  attemptId: Sha256DigestSchema,
  attemptNumber: z.number().int().positive(),
  timing: TimingRecordSchema,
  usage: UsageRecordSchema.optional(),
}).strict();

export const EvaluationAttemptSchema = z.discriminatedUnion('attemptStatus', [
  EvaluationAttemptBaseSchema.extend({
    attemptStatus: z.literal('completed'),
  }).strict(),
  EvaluationAttemptBaseSchema.extend({
    attemptStatus: z.literal('failed'),
    error: EvaluationErrorSchema,
  }).strict(),
  EvaluationAttemptBaseSchema.extend({
    attemptStatus: z.literal('cancelled'),
    error: EvaluationErrorSchema.optional(),
  }).strict(),
]);

const EvaluationRecordIdentitySchema = z.object({
  targetId: IdentifierSchema,
  sampleId: IdentifierSchema,
  trialIndex: z.number().int().nonnegative(),
  trialId: Sha256DigestSchema,
  evaluatorId: IdentifierSchema,
  evaluationId: Sha256DigestSchema,
  runtime: RuntimeIdentitySchema,
  provenance: ProvenanceSchema,
}).strict();

const ActiveEvaluationRecordBaseSchema = EvaluationRecordIdentitySchema.extend({
  sourceRecordDigest: Sha256DigestSchema,
  attempts: z.array(EvaluationAttemptSchema).min(1),
  timing: TimingRecordSchema,
  usage: UsageRecordSchema.optional(),
  evidence: CapturedContentSchema.optional(),
  cache: CacheProvenanceSchema,
}).strict();

export const CompletedEvaluationRecordSchema = ActiveEvaluationRecordBaseSchema.extend({
  evaluationStatus: z.literal('completed'),
  observations: z.array(MetricObservationSchema),
}).strict();

export const FailedEvaluationRecordSchema = ActiveEvaluationRecordBaseSchema.extend({
  evaluationStatus: z.literal('failed'),
  error: EvaluationErrorSchema,
}).strict();

export const CancelledEvaluationRecordSchema = ActiveEvaluationRecordBaseSchema.extend({
  evaluationStatus: z.literal('cancelled'),
  error: EvaluationErrorSchema.optional(),
}).strict();

export const NotEvaluatedEvaluationRecordSchema = EvaluationRecordIdentitySchema.extend({
  evaluationStatus: z.literal('not-evaluated'),
  notEvaluatedReasonCode: IdentifierSchema,
  notEvaluatedAt: TimestampSchema,
  sourceRecordDigest: Sha256DigestSchema.optional(),
}).strict();

export const EvaluationRecordSchema = z.discriminatedUnion('evaluationStatus', [
  CompletedEvaluationRecordSchema,
  FailedEvaluationRecordSchema,
  CancelledEvaluationRecordSchema,
  NotEvaluatedEvaluationRecordSchema,
]);

export const EvaluationCoverageSchema = z.object({
  planned: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  sourceUnavailable: z.number().int().nonnegative(),
  started: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  notStarted: z.number().int().nonnegative(),
}).strict();

export const EvaluationBundleSchema = z.object({
  schemaVersion: z.literal(EVALUATION_BUNDLE_SCHEMA_VERSION),
  bundleId: IdentifierSchema,
  runContractDigest: Sha256DigestSchema,
  executionBundleDigest: Sha256DigestSchema,
  evaluationPlanDigest: Sha256DigestSchema,
  evaluationInputDigest: Sha256DigestSchema,
  evaluationBundleStatus: z.enum([
    'completed',
    'cancelled',
    'budget-exhausted',
    'failed',
  ]),
  terminationReasonCode: IdentifierSchema.optional(),
  coverage: EvaluationCoverageSchema,
  replayability: ReplayabilitySchema,
  records: z.array(EvaluationRecordSchema),
  provenance: ProvenanceSchema,
  bundleDigest: Sha256DigestSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Evaluation Bundle v1',
});

export const AnalysisObservationCoverageSchema = z.object({
  planned: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  evaluationFailed: z.number().int().nonnegative(),
  sourceUnavailable: z.number().int().nonnegative(),
  notStarted: z.number().int().nonnegative(),
  censored: z.number().int().nonnegative(),
  included: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  comparable: z.number().int().nonnegative(),
}).strict();

export const AssumptionCheckSchema = z.object({
  assumptionId: IdentifierSchema,
  nodeId: IdentifierSchema,
  checkStatus: z.enum(['passed', 'failed', 'not-evaluated']),
  reasonCode: IdentifierSchema.optional(),
  details: JsonValueSchema.optional(),
}).strict();

export const AnalysisExclusionSchema = z.object({
  rowId: Sha256DigestSchema,
  reasonCode: IdentifierSchema,
}).strict();

const AnalysisRecordBaseSchema = z.object({
  resultId: IdentifierSchema,
  nodeId: IdentifierSchema,
  analysisNodeKind: z.enum(['reducer', 'estimator', 'correction']),
  implementation: RuntimeIdentitySchema,
  outputSchema: z.object({
    schemaVersion: NonEmptyStringSchema,
    schemaUri: UriSchema,
    schemaDigest: Sha256DigestSchema,
  }).strict(),
  inputReferences: z.array(z.object({
    inputKind: z.enum(['metric-observations', 'analysis-result', 'comparison']),
    referenceId: IdentifierSchema,
  }).strict()).min(1),
  coverage: AnalysisObservationCoverageSchema,
  exclusions: z.array(AnalysisExclusionSchema),
  assumptionChecks: z.array(AssumptionCheckSchema),
  analysisMode: z.enum(['preregistered', 'exploratory']),
  derivedAt: TimestampSchema,
  parentDigests: z.array(Sha256DigestSchema).min(1),
}).strict();

export const CompletedAnalysisRecordSchema = AnalysisRecordBaseSchema.extend({
  analysisStatus: z.literal('completed'),
  resultType: z.enum([
    'scalar',
    'interval',
    'distribution',
    'table',
    'matrix',
    'curve',
  ]),
  value: JsonValueSchema,
  recordDigest: Sha256DigestSchema,
}).strict();

export const InconclusiveAnalysisRecordSchema = AnalysisRecordBaseSchema.extend({
  analysisStatus: z.literal('inconclusive'),
  reasonCodes: z.array(IdentifierSchema).min(1),
  recordDigest: Sha256DigestSchema,
}).strict();

export const FailedAnalysisRecordSchema = AnalysisRecordBaseSchema.extend({
  analysisStatus: z.literal('failed'),
  error: EvaluationErrorSchema,
  recordDigest: Sha256DigestSchema,
}).strict();

export const NotEvaluatedAnalysisRecordSchema = AnalysisRecordBaseSchema.extend({
  analysisStatus: z.literal('not-evaluated'),
  reasonCodes: z.array(IdentifierSchema).min(1),
  recordDigest: Sha256DigestSchema,
}).strict();

export const AnalysisRecordSchema = z.discriminatedUnion('analysisStatus', [
  CompletedAnalysisRecordSchema,
  InconclusiveAnalysisRecordSchema,
  FailedAnalysisRecordSchema,
  NotEvaluatedAnalysisRecordSchema,
]);

export const AnalysisCoverageSchema = z.object({
  planned: z.number().int().nonnegative(),
  started: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  inconclusive: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  notStarted: z.number().int().nonnegative(),
}).strict();

export const AnalysisBundleSchema = z.object({
  schemaVersion: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
  bundleId: IdentifierSchema,
  runContractDigest: Sha256DigestSchema,
  evaluationBundleDigest: Sha256DigestSchema,
  analysisPlanDigest: Sha256DigestSchema,
  analysisBundleStatus: z.enum(['completed', 'cancelled', 'failed']),
  terminationReasonCode: IdentifierSchema.optional(),
  coverage: AnalysisCoverageSchema,
  records: z.array(AnalysisRecordSchema),
  provenance: ProvenanceSchema,
  bundleDigest: Sha256DigestSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Analysis Bundle v1',
});

export const EvaluationStatusSchema = z.object({
  runStatus: z.enum(['completed', 'cancelled', 'budget-exhausted', 'failed']),
  evidenceStatus: z.enum(['complete', 'partial', 'unresolvable']),
  conclusionStatus: z.enum(['conclusive', 'inconclusive', 'not-evaluated']),
}).strict();

export const BundleReferenceSchema = z.object({
  bundleKind: z.enum(['execution', 'evaluation', 'analysis']),
  schemaVersion: NonEmptyStringSchema,
  bundleDigest: Sha256DigestSchema,
  uri: UriSchema.optional(),
}).strict();

const DecisionResultBaseSchema = z.object({
  decisionPolicyId: IdentifierSchema,
  implementation: RuntimeIdentitySchema,
  analysisBundleDigest: Sha256DigestSchema,
  decisionPlanDigest: Sha256DigestSchema,
  policyDigest: Sha256DigestSchema,
  analysisResultIds: z.array(IdentifierSchema).min(1),
  decidedAt: TimestampSchema,
}).strict();

export const DecisionResultSchema = z.discriminatedUnion('decisionStatus', [
  DecisionResultBaseSchema.extend({
    decisionStatus: z.literal('decided'),
    verdict: IdentifierSchema,
    decisionDigest: Sha256DigestSchema,
  }).strict(),
  DecisionResultBaseSchema.extend({
    decisionStatus: z.literal('not-decided'),
    reasonCodes: z.array(IdentifierSchema).min(1),
    decisionDigest: Sha256DigestSchema,
  }).strict(),
  DecisionResultBaseSchema.extend({
    decisionStatus: z.literal('failed'),
    error: EvaluationErrorSchema,
    decisionDigest: Sha256DigestSchema,
  }).strict(),
]);

export const EvaluationReportSchema = z.object({
  schemaVersion: z.literal(EVALUATION_REPORT_SCHEMA_VERSION),
  reportId: IdentifierSchema,
  runContractDigest: Sha256DigestSchema,
  status: EvaluationStatusSchema,
  bundles: z.array(BundleReferenceSchema),
  decision: DecisionResultSchema.optional(),
  summaries: JsonValueSchema.optional(),
  annotations: JsonValueSchema.optional(),
  provenance: ProvenanceSchema,
  reportDigest: Sha256DigestSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Evaluation Report v1',
});

export const EvaluationEventSchema = z.object({
  schemaVersion: z.literal(EVALUATION_EVENT_SCHEMA_VERSION),
  eventId: IdentifierSchema,
  sequence: z.number().int().nonnegative(),
  runId: IdentifierSchema,
  eventKind: IdentifierSchema,
  time: TimestampSchema,
  subject: z.object({
    subjectKind: IdentifierSchema,
    subjectId: IdentifierSchema,
  }).strict(),
  data: JsonValueSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Evaluation Event v1',
});

export type TimingRecord = z.infer<typeof TimingRecordSchema>;
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>;
export type SamplingUnitIds = z.infer<typeof SamplingUnitIdsSchema>;
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
export type ExecutionCoverage = z.infer<typeof ExecutionCoverageSchema>;
export type ExecutionBundle = z.infer<typeof ExecutionBundleSchema>;
export type MetricObservation = z.infer<typeof MetricObservationSchema>;
export type EvaluationAttempt = z.infer<typeof EvaluationAttemptSchema>;
export type EvaluationRecord = z.infer<typeof EvaluationRecordSchema>;
export type EvaluationCoverage = z.infer<typeof EvaluationCoverageSchema>;
export type EvaluationBundle = z.infer<typeof EvaluationBundleSchema>;
export type AnalysisObservationCoverage = z.infer<typeof AnalysisObservationCoverageSchema>;
export type AnalysisExclusion = z.infer<typeof AnalysisExclusionSchema>;
export type AssumptionCheck = z.infer<typeof AssumptionCheckSchema>;
export type AnalysisRecord = z.infer<typeof AnalysisRecordSchema>;
export type AnalysisCoverage = z.infer<typeof AnalysisCoverageSchema>;
export type AnalysisBundle = z.infer<typeof AnalysisBundleSchema>;
export type EvaluationStatus = z.infer<typeof EvaluationStatusSchema>;
export type DecisionResult = z.infer<typeof DecisionResultSchema>;
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;
export type EvaluationEvent = z.infer<typeof EvaluationEventSchema>;
