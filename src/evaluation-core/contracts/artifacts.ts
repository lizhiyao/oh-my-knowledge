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

export const ExecutionAttemptSchema = z.object({
  attemptId: IdentifierSchema,
  attemptNumber: z.number().int().positive(),
  attemptStatus: z.enum(['completed', 'failed', 'cancelled']),
  timing: TimingRecordSchema,
  error: EvaluationErrorSchema.optional(),
}).strict();

const ExecutionRecordBaseSchema = z.object({
  targetId: IdentifierSchema,
  sampleId: IdentifierSchema,
  trialId: IdentifierSchema,
  runtime: RuntimeIdentitySchema,
  attempts: z.array(ExecutionAttemptSchema).min(1),
  timing: TimingRecordSchema,
  usage: UsageRecordSchema.optional(),
  trace: CapturedContentSchema.optional(),
  provenance: ProvenanceSchema,
  cache: CacheProvenanceSchema,
}).strict();

export const CompletedExecutionRecordSchema = ExecutionRecordBaseSchema.extend({
  executionStatus: z.literal('completed'),
  output: CapturedContentSchema,
}).strict();

export const FailedExecutionRecordSchema = ExecutionRecordBaseSchema.extend({
  executionStatus: z.literal('failed'),
  error: EvaluationErrorSchema,
}).strict();

export const CancelledExecutionRecordSchema = ExecutionRecordBaseSchema.extend({
  executionStatus: z.literal('cancelled'),
  error: EvaluationErrorSchema.optional(),
}).strict();

export const CensoredExecutionRecordSchema = ExecutionRecordBaseSchema.extend({
  executionStatus: z.literal('budget-censored'),
  censorReason: NonEmptyStringSchema,
}).strict();

export const ExecutionRecordSchema = z.discriminatedUnion('executionStatus', [
  CompletedExecutionRecordSchema,
  FailedExecutionRecordSchema,
  CancelledExecutionRecordSchema,
  CensoredExecutionRecordSchema,
]);

export const ExecutionBundleSchema = z.object({
  schemaVersion: z.literal(EXECUTION_BUNDLE_SCHEMA_VERSION),
  bundleId: IdentifierSchema,
  runContractDigest: Sha256DigestSchema,
  executionPlanDigest: Sha256DigestSchema,
  datasetRevisionDigest: Sha256DigestSchema,
  executionInputDigest: Sha256DigestSchema,
  replayability: ReplayabilitySchema,
  records: z.array(ExecutionRecordSchema),
  provenance: ProvenanceSchema,
  bundleDigest: Sha256DigestSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Execution Bundle v1',
});

const MetricObservationBaseSchema = z.object({
  observationId: IdentifierSchema,
  metricId: IdentifierSchema,
  evidence: CapturedContentSchema.optional(),
  metadata: JsonValueSchema.optional(),
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

const EvaluationRecordBaseSchema = z.object({
  targetId: IdentifierSchema,
  sampleId: IdentifierSchema,
  trialId: IdentifierSchema,
  evaluatorId: IdentifierSchema,
  runtime: RuntimeIdentitySchema,
  timing: TimingRecordSchema,
  evidence: CapturedContentSchema.optional(),
  provenance: ProvenanceSchema,
  cache: CacheProvenanceSchema,
}).strict();

export const CompletedEvaluationRecordSchema = EvaluationRecordBaseSchema.extend({
  evaluationStatus: z.literal('completed'),
  observations: z.array(MetricObservationSchema),
}).strict();

export const FailedEvaluationRecordSchema = EvaluationRecordBaseSchema.extend({
  evaluationStatus: z.literal('failed'),
  error: EvaluationErrorSchema,
}).strict();

export const EvaluationRecordSchema = z.discriminatedUnion('evaluationStatus', [
  CompletedEvaluationRecordSchema,
  FailedEvaluationRecordSchema,
]);

export const EvaluationBundleSchema = z.object({
  schemaVersion: z.literal(EVALUATION_BUNDLE_SCHEMA_VERSION),
  bundleId: IdentifierSchema,
  runContractDigest: Sha256DigestSchema,
  executionBundleDigest: Sha256DigestSchema,
  evaluationPlanDigest: Sha256DigestSchema,
  evaluationInputDigest: Sha256DigestSchema,
  replayability: ReplayabilitySchema,
  records: z.array(EvaluationRecordSchema),
  provenance: ProvenanceSchema,
  bundleDigest: Sha256DigestSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Evaluation Bundle v1',
});

export const AnalysisResultSchema = z.object({
  resultId: IdentifierSchema,
  nodeId: IdentifierSchema,
  resultType: z.enum([
    'scalar',
    'interval',
    'distribution',
    'table',
    'matrix',
    'curve',
  ]),
  value: JsonValueSchema,
  implementation: RuntimeIdentitySchema,
  parentDigests: z.array(Sha256DigestSchema).min(1),
  analysisMode: z.enum(['preregistered', 'exploratory']),
  derivedAt: TimestampSchema,
}).strict();

export const AssumptionCheckSchema = z.object({
  assumptionId: IdentifierSchema,
  checkStatus: z.enum(['passed', 'failed', 'not-evaluated']),
  message: NonEmptyStringSchema.optional(),
  details: JsonValueSchema.optional(),
}).strict();

export const CoverageRecordSchema = z.object({
  started: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  comparable: z.number().int().nonnegative(),
  censored: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
}).strict();

export const AnalysisBundleSchema = z.object({
  schemaVersion: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
  bundleId: IdentifierSchema,
  runContractDigest: Sha256DigestSchema,
  evaluationBundleDigest: Sha256DigestSchema,
  analysisPlanDigest: Sha256DigestSchema,
  results: z.array(AnalysisResultSchema),
  assumptionChecks: z.array(AssumptionCheckSchema),
  coverage: CoverageRecordSchema,
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

export const DecisionResultSchema = z.discriminatedUnion('decisionStatus', [
  z.object({
    decisionStatus: z.literal('decided'),
    verdict: IdentifierSchema,
    policyDigest: Sha256DigestSchema,
    analysisResultIds: z.array(IdentifierSchema).min(1),
  }).strict(),
  z.object({
    decisionStatus: z.literal('not-decided'),
    reasonCodes: z.array(IdentifierSchema).min(1),
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
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
export type ExecutionBundle = z.infer<typeof ExecutionBundleSchema>;
export type MetricObservation = z.infer<typeof MetricObservationSchema>;
export type EvaluationRecord = z.infer<typeof EvaluationRecordSchema>;
export type EvaluationBundle = z.infer<typeof EvaluationBundleSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
export type AnalysisBundle = z.infer<typeof AnalysisBundleSchema>;
export type EvaluationStatus = z.infer<typeof EvaluationStatusSchema>;
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;
export type EvaluationEvent = z.infer<typeof EvaluationEventSchema>;
