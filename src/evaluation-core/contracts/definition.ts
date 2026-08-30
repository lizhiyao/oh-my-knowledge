import { z } from 'zod';
import {
  ContentClassificationSchema,
  ExtensionsSchema,
  IdentifierSchema,
  JsonPointerSchema,
  NonEmptyStringSchema,
} from './common.js';
import { JsonValueSchema } from './json.js';

export const EVALUATION_DEFINITION_SCHEMA_VERSION = 'omk.evaluation-definition/v1' as const;
export const MEASUREMENT_POLICY_SCHEMA_VERSION = 'omk.measurement-policy/v1' as const;

export const EvaluationSampleSchema = z.object({
  sampleId: IdentifierSchema,
  input: JsonValueSchema,
  executionContext: JsonValueSchema.optional(),
  expected: JsonValueSchema.optional(),
  evaluationContext: JsonValueSchema.optional(),
  annotations: JsonValueSchema.optional(),
}).strict();

export const EvaluationDatasetSchema = z.object({
  datasetId: IdentifierSchema,
  samples: z.array(EvaluationSampleSchema).min(1),
  annotations: JsonValueSchema.optional(),
}).strict();

export const TargetDefinitionSchema = z.object({
  targetId: IdentifierSchema,
  targetKind: IdentifierSchema,
  protocolId: z.enum(['omk.invoke/v1', 'omk.session/v1']),
  executorId: IdentifierSchema,
  versionConstraint: NonEmptyStringSchema.optional(),
  config: JsonValueSchema.optional(),
}).strict();

export const EvaluatorInputBindingSchema = z.object({
  bindingId: IdentifierSchema,
  sourceKind: z.enum(['output', 'trace', 'expected', 'evaluation-context']),
  pointer: JsonPointerSchema,
}).strict();

export const EvaluatorDefinitionSchema = z.object({
  evaluatorId: IdentifierSchema,
  evaluatorKind: IdentifierSchema,
  implementationId: IdentifierSchema,
  versionConstraint: NonEmptyStringSchema.optional(),
  metricIds: z.array(IdentifierSchema).min(1),
  inputs: z.array(EvaluatorInputBindingSchema),
  config: JsonValueSchema.optional(),
}).strict();

export const MetricDefinitionSchema = z.object({
  metricId: IdentifierSchema,
  valueType: z.enum(['numeric', 'boolean', 'categorical', 'text', 'ranking']),
  scope: z.enum(['sample', 'target', 'comparison', 'run']),
  scale: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
    target: z.number().optional(),
  }).strict().optional(),
  unit: NonEmptyStringSchema.optional(),
  direction: z.enum([
    'higher-is-better',
    'lower-is-better',
    'target-is-best',
  ]).optional(),
  missingPolicyId: IdentifierSchema,
}).strict();

export const SeedCouplingSchema = z.enum([
  'shared-within-block',
  'independent-by-target',
  'uncontrolled',
]);

export const SamplingDesignSchema = z.object({
  experimentalUnit: z.enum(['sample', 'run', 'cluster']),
  pairingKey: JsonPointerSchema.optional(),
  clusterKey: JsonPointerSchema.optional(),
  stratumKey: JsonPointerSchema.optional(),
  repeatedMeasures: z.boolean(),
  resamplingUnit: z.enum(['sample', 'paired-block', 'cluster', 'run']),
  estimatorId: IdentifierSchema,
  seedCoupling: SeedCouplingSchema,
}).strict();

export const SchedulingPolicySchema = z.object({
  schedulingKind: z.enum(['sequential', 'interleaved', 'randomized-block']),
  blockSize: z.number().int().positive().optional(),
}).strict();

export const RandomizationSlotSchema = z.object({
  targetId: IdentifierSchema,
  randomizationSlotId: IdentifierSchema,
}).strict();

export const ExperimentDesignSchema = z.object({
  trials: z.number().int().positive(),
  seed: NonEmptyStringSchema,
  sampling: SamplingDesignSchema,
  scheduling: SchedulingPolicySchema,
  randomizationSlots: z.array(RandomizationSlotSchema).min(1),
}).strict();

export const ExecutionSamplingDesignSchema = SamplingDesignSchema.omit({
  estimatorId: true,
}).strict();

export const ExecutionExperimentDesignSchema = ExperimentDesignSchema.extend({
  sampling: ExecutionSamplingDesignSchema,
}).strict();

const AnalysisMetricInputReferenceSchema = z.object({
  inputKind: z.literal('metric-observations'),
  referenceId: IdentifierSchema,
}).strict();

const AnalysisResultInputReferenceSchema = z.object({
  inputKind: z.literal('analysis-result'),
  referenceId: IdentifierSchema,
}).strict();

const AnalysisComparisonInputReferenceSchema = z.object({
  inputKind: z.literal('comparison'),
  referenceId: IdentifierSchema,
  treatmentTargetId: IdentifierSchema,
  metricId: IdentifierSchema,
}).strict();

export const AnalysisInputReferenceSchema = z.discriminatedUnion('inputKind', [
  AnalysisMetricInputReferenceSchema,
  AnalysisResultInputReferenceSchema,
  AnalysisComparisonInputReferenceSchema,
]);

const AnalysisNodeBaseSchema = z.object({
  nodeId: IdentifierSchema,
  implementationId: IdentifierSchema,
  versionConstraint: NonEmptyStringSchema.optional(),
  inputs: z.array(AnalysisInputReferenceSchema).min(1),
  outputResultId: IdentifierSchema,
  parameters: JsonValueSchema.optional(),
}).strict();

export const ReducerDefinitionSchema = AnalysisNodeBaseSchema.extend({
  analysisNodeKind: z.literal('reducer'),
}).strict();

export const EstimatorDefinitionSchema = AnalysisNodeBaseSchema.extend({
  analysisNodeKind: z.literal('estimator'),
}).strict();

export const CorrectionDefinitionSchema = AnalysisNodeBaseSchema.extend({
  analysisNodeKind: z.literal('correction'),
}).strict();

export const AnalysisNodeDefinitionSchema = z.discriminatedUnion('analysisNodeKind', [
  ReducerDefinitionSchema,
  EstimatorDefinitionSchema,
  CorrectionDefinitionSchema,
]);

export const AnalysisGraphDefinitionSchema = z.object({
  analysisMode: z.enum(['preregistered', 'exploratory']),
  nodes: z.array(AnalysisNodeDefinitionSchema),
}).strict();

export const ComparisonDefinitionSchema = z.object({
  comparisonId: IdentifierSchema,
  controlTargetId: IdentifierSchema,
  treatmentTargetIds: z.array(IdentifierSchema).min(1),
  metricIds: z.array(IdentifierSchema).min(1),
}).strict();

const ComparisonFamilyMemberBaseSchema = z.object({
  comparisonId: IdentifierSchema,
  treatmentTargetId: IdentifierSchema,
  metricId: IdentifierSchema,
  analysisResultId: IdentifierSchema,
}).strict();

export const ComparisonFamilyMemberSchema = z.union([
  ComparisonFamilyMemberBaseSchema,
  ComparisonFamilyMemberBaseSchema.extend({
    hypothesisId: IdentifierSchema,
  }).strict(),
]);

export const DecisionPolicyDefinitionSchema = z.object({
  decisionPolicyId: IdentifierSchema,
  implementationId: IdentifierSchema,
  versionConstraint: NonEmptyStringSchema.optional(),
  analysisResultIds: z.array(IdentifierSchema).min(1),
  comparisonFamily: z.array(ComparisonFamilyMemberSchema).min(1).optional(),
  multipleComparisonPolicyId: IdentifierSchema.optional(),
  minimumEvidenceStatus: z.enum(['complete', 'partial', 'unresolvable']),
  parameters: JsonValueSchema.optional(),
}).strict();

export const EvaluationDefinitionSchema = z.object({
  schemaVersion: z.literal(EVALUATION_DEFINITION_SCHEMA_VERSION),
  dataset: EvaluationDatasetSchema,
  targets: z.array(TargetDefinitionSchema).min(1),
  evaluators: z.array(EvaluatorDefinitionSchema),
  metrics: z.array(MetricDefinitionSchema),
  experiment: ExperimentDesignSchema,
  analysisGraph: AnalysisGraphDefinitionSchema,
  comparisons: z.array(ComparisonDefinitionSchema),
  decisionPolicy: DecisionPolicyDefinitionSchema.optional(),
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Evaluation Definition v1',
});

export const ExecutionPolicySchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  maxConcurrency: z.number().int().positive(),
}).strict();

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive(),
  retryableErrorCodes: z.array(IdentifierSchema),
  backoff: z.object({
    backoffKind: z.enum(['none', 'fixed', 'exponential']),
    initialDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict();

export const BudgetPolicySchema = z.object({
  maxTargetInvocations: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxProviderCost: z.object({
    amount: z.number().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict().optional(),
}).strict();

export const EvaluationRuntimePolicySchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  maxConcurrency: z.number().int().positive(),
  retry: RetryPolicySchema,
  budget: z.object({
    maxEvaluatorInvocations: z.number().int().positive().optional(),
    maxDurationMs: z.number().int().positive().optional(),
    maxProviderCost: z.object({
      amount: z.number().nonnegative(),
      currency: z.string().regex(/^[A-Z]{3}$/),
    }).strict().optional(),
  }).strict(),
}).strict();

export const CachePolicySchema = z.object({
  executionMode: z.enum(['disabled', 'replay-only', 'transparent-deterministic']),
  evaluationMode: z.enum(['disabled', 'reuse']),
}).strict();

export const CaptureModeSchema = z.enum(['full', 'reference', 'digest', 'none']);

export const EvidencePolicySchema = z.object({
  input: CaptureModeSchema,
  output: CaptureModeSchema,
  trace: CaptureModeSchema,
  expected: CaptureModeSchema,
  evidence: CaptureModeSchema,
  maximumClassification: ContentClassificationSchema,
}).strict();

export const FailurePolicySchema = z.object({
  failureMode: z.enum(['continue', 'fail-fast', 'failure-threshold']),
  maxFailures: z.number().int().nonnegative().optional(),
}).strict();

export const EventDeliveryPolicySchema = z.object({
  writerMode: z.enum(['disabled', 'optional', 'required']),
  backpressureMode: z.enum(['block']),
  writerFailureMode: z.enum(['ignore', 'fail-run']),
}).strict();

export const MeasurementPolicySchema = z.object({
  schemaVersion: z.literal(MEASUREMENT_POLICY_SCHEMA_VERSION),
  execution: ExecutionPolicySchema,
  retry: RetryPolicySchema,
  budget: BudgetPolicySchema,
  evaluation: EvaluationRuntimePolicySchema,
  cache: CachePolicySchema,
  evidence: EvidencePolicySchema,
  failure: FailurePolicySchema,
  eventDelivery: EventDeliveryPolicySchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Measurement Policy v1',
});

export type EvaluationSample = z.infer<typeof EvaluationSampleSchema>;
export type EvaluationDataset = z.infer<typeof EvaluationDatasetSchema>;
export type TargetDefinition = z.infer<typeof TargetDefinitionSchema>;
export type EvaluatorDefinition = z.infer<typeof EvaluatorDefinitionSchema>;
export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>;
export type SeedCoupling = z.infer<typeof SeedCouplingSchema>;
export type SamplingDesign = z.infer<typeof SamplingDesignSchema>;
export type ExecutionSamplingDesign = z.infer<typeof ExecutionSamplingDesignSchema>;
export type RandomizationSlot = z.infer<typeof RandomizationSlotSchema>;
export type ExperimentDesign = z.infer<typeof ExperimentDesignSchema>;
export type ExecutionExperimentDesign = z.infer<typeof ExecutionExperimentDesignSchema>;
export type ReducerDefinition = z.infer<typeof ReducerDefinitionSchema>;
export type AnalysisNodeDefinition = z.infer<typeof AnalysisNodeDefinitionSchema>;
export type AnalysisGraphDefinition = z.infer<typeof AnalysisGraphDefinitionSchema>;
export type ComparisonDefinition = z.infer<typeof ComparisonDefinitionSchema>;
export type ComparisonFamilyMember = z.infer<typeof ComparisonFamilyMemberSchema>;
export type DecisionPolicyDefinition = z.infer<typeof DecisionPolicyDefinitionSchema>;
export type EvaluationDefinition = z.infer<typeof EvaluationDefinitionSchema>;
export type EvaluationRuntimePolicy = z.infer<typeof EvaluationRuntimePolicySchema>;
export type MeasurementPolicy = z.infer<typeof MeasurementPolicySchema>;
