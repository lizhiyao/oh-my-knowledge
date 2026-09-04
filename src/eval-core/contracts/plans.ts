import { z } from 'zod';
import {
  ExtensionsSchema,
  IdentifierSchema,
  RuntimeIdentitySchema,
  SchemaIdentitySchema,
  Sha256DigestSchema,
} from './common.js';
import {
  AnalysisGraphDefinitionSchema,
  AnalysisCohortDefinitionSchema,
  AnalysisSampleInputSchema,
  BudgetPolicySchema,
  CachePolicySchema,
  ComparisonDefinitionSchema,
  DecisionPolicyDefinitionSchema,
  EvidencePolicySchema,
  EvaluationRuntimePolicySchema,
  EvaluationDefinitionSchema,
  EvaluationSampleSchema,
  EvaluatorDefinitionSchema,
  ExecutionExperimentDesignSchema,
  ExperimentDesignSchema,
  ExecutionPolicySchema,
  FailurePolicySchema,
  MeasurementPolicySchema,
  MetricDefinitionSchema,
  RetryPolicySchema,
  TargetDefinitionSchema,
} from './definition.js';

export const EXECUTION_PLAN_SCHEMA_VERSION = 'omk.execution-plan/v2' as const;
export const EVALUATION_PLAN_SCHEMA_VERSION = 'omk.evaluation-plan/v1' as const;
export const ANALYSIS_PLAN_SCHEMA_VERSION = 'omk.analysis-plan/v2' as const;
export const DECISION_PLAN_SCHEMA_VERSION = 'omk.decision-plan/v1' as const;
export const RUN_PLAN_SCHEMA_VERSION = 'omk.run-plan/v2' as const;

export const ExecutionInputSampleSchema = EvaluationSampleSchema.pick({
  sampleId: true,
  input: true,
  executionContext: true,
}).strict();

export const EvaluationInputSampleSchema = EvaluationSampleSchema.pick({
  sampleId: true,
  input: true,
  executionContext: true,
  expected: true,
  evaluationContext: true,
}).strict();

export const AnalysisInputSampleSchema = z.object({
  sampleId: IdentifierSchema,
  analysis: AnalysisSampleInputSchema.optional(),
}).strict();

export const ResolvedRuntimeSchema = z.object({
  runtimeKind: z.enum([
    'executor',
    'evaluator',
    'analysis-node',
    'missing-policy',
    'decision-policy',
  ]),
  referenceId: IdentifierSchema,
  identity: RuntimeIdentitySchema,
}).strict();

export const ExecutionPlanPolicySchema = z.object({
  execution: ExecutionPolicySchema,
  retry: RetryPolicySchema,
  budget: BudgetPolicySchema,
  executionCacheMode: CachePolicySchema.shape.executionMode,
  evidence: EvidencePolicySchema.pick({
    output: true,
    trace: true,
    maximumClassification: true,
  }).strict(),
  failure: FailurePolicySchema,
}).strict();

export const EvaluationPlanPolicySchema = z.object({
  runtime: EvaluationRuntimePolicySchema,
  budget: BudgetPolicySchema,
  evaluationCacheMode: CachePolicySchema.shape.evaluationMode,
  evidence: EvidencePolicySchema,
  failure: FailurePolicySchema,
}).strict();

export const SchedulingTargetGroupSchema = z.array(IdentifierSchema).min(1);

export const AssignmentMembershipSchema = z.object({
  sampleId: IdentifierSchema,
  targetId: IdentifierSchema,
  randomizationSlotId: IdentifierSchema,
}).strict();

export const ExecutionPlanSchema = z.object({
  schemaVersion: z.literal(EXECUTION_PLAN_SCHEMA_VERSION),
  executionInputDigest: Sha256DigestSchema,
  randomizationDesignDigest: Sha256DigestSchema,
  samples: z.array(ExecutionInputSampleSchema).min(1),
  targets: z.array(TargetDefinitionSchema).min(1),
  assignments: z.array(AssignmentMembershipSchema).min(1),
  schedulingTargetGroups: z.array(SchedulingTargetGroupSchema).min(1),
  experiment: ExecutionExperimentDesignSchema,
  runtimes: z.array(ResolvedRuntimeSchema),
  policy: ExecutionPlanPolicySchema,
  executionPlanDigest: Sha256DigestSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Execution Plan v2',
});

export const EvaluationPlanSchema = z.object({
  schemaVersion: z.literal(EVALUATION_PLAN_SCHEMA_VERSION),
  executionPlanDigest: Sha256DigestSchema,
  evaluationInputDigest: Sha256DigestSchema,
  samples: z.array(EvaluationInputSampleSchema).min(1),
  evaluators: z.array(EvaluatorDefinitionSchema),
  metrics: z.array(MetricDefinitionSchema),
  runtimes: z.array(ResolvedRuntimeSchema),
  policy: EvaluationPlanPolicySchema,
  evaluationPlanDigest: Sha256DigestSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Evaluation Plan v1',
});

export const AnalysisPlanSchema = z.object({
  schemaVersion: z.literal(ANALYSIS_PLAN_SCHEMA_VERSION),
  evaluationPlanDigest: Sha256DigestSchema,
  analysisInputDigest: Sha256DigestSchema,
  samples: z.array(AnalysisInputSampleSchema).min(1),
  cohorts: z.array(AnalysisCohortDefinitionSchema),
  metrics: z.array(MetricDefinitionSchema),
  analysisGraph: AnalysisGraphDefinitionSchema,
  experiment: ExperimentDesignSchema,
  comparisons: z.array(ComparisonDefinitionSchema),
  runtimes: z.array(ResolvedRuntimeSchema),
  analysisPlanDigest: Sha256DigestSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Analysis Plan v2',
});

export const DecisionPlanSchema = z.object({
  schemaVersion: z.literal(DECISION_PLAN_SCHEMA_VERSION),
  analysisPlanDigest: Sha256DigestSchema,
  analysisInputDigest: Sha256DigestSchema,
  decisionPolicy: DecisionPolicyDefinitionSchema.optional(),
  runtimes: z.array(ResolvedRuntimeSchema),
  decisionPlanDigest: Sha256DigestSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Decision Plan v1',
});

export const PlanDigestsSchema = z.object({
  datasetRevisionDigest: Sha256DigestSchema,
  executionInputDigest: Sha256DigestSchema,
  evaluationInputDigest: Sha256DigestSchema,
  analysisInputDigest: Sha256DigestSchema,
  randomizationDesignDigest: Sha256DigestSchema,
  executionPlanDigest: Sha256DigestSchema,
  evaluationPlanDigest: Sha256DigestSchema,
  analysisPlanDigest: Sha256DigestSchema,
  decisionPlanDigest: Sha256DigestSchema,
  runContractDigest: Sha256DigestSchema,
}).strict();

export const RunPlanSchema = z.object({
  schemaVersion: z.literal(RUN_PLAN_SCHEMA_VERSION),
  definition: EvaluationDefinitionSchema,
  measurementPolicy: MeasurementPolicySchema,
  execution: ExecutionPlanSchema,
  evaluation: EvaluationPlanSchema,
  analysis: AnalysisPlanSchema,
  decision: DecisionPlanSchema,
  schemaIdentities: z.array(SchemaIdentitySchema).min(1),
  digests: PlanDigestsSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({
  title: 'OMK Run Plan v2',
});

export type ExecutionInputSample = z.infer<typeof ExecutionInputSampleSchema>;
export type AssignmentMembership = z.infer<typeof AssignmentMembershipSchema>;
export type ExecutionPlanPolicy = z.infer<typeof ExecutionPlanPolicySchema>;
export type EvaluationInputSample = z.infer<typeof EvaluationInputSampleSchema>;
export type AnalysisInputSample = z.infer<typeof AnalysisInputSampleSchema>;
export type ResolvedRuntime = z.infer<typeof ResolvedRuntimeSchema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
export type EvaluationPlan = z.infer<typeof EvaluationPlanSchema>;
export type AnalysisPlan = z.infer<typeof AnalysisPlanSchema>;
export type DecisionPlan = z.infer<typeof DecisionPlanSchema>;
export type PlanDigests = z.infer<typeof PlanDigestsSchema>;
export type RunPlan = z.infer<typeof RunPlanSchema>;
