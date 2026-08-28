import type {
  AnalysisGraphDefinition,
  ComparisonDefinition,
  DecisionPolicyDefinition,
  EvaluationDataset,
  EvaluatorDefinition,
  ExperimentDesign,
  MeasurementPolicy,
  MetricDefinition,
  TargetDefinition,
} from './definition.js';
import {
  ANALYSIS_PLAN_SCHEMA_VERSION,
  DECISION_PLAN_SCHEMA_VERSION,
  EVALUATION_PLAN_SCHEMA_VERSION,
  EXECUTION_PLAN_SCHEMA_VERSION,
  RUN_PLAN_SCHEMA_VERSION,
  type EvaluationInputSample,
  type ExecutionInputSample,
  type PlanDigests,
  type ResolvedRuntime,
} from './plans.js';
import type { Extensions, SchemaIdentity } from './common.js';
import {
  assertCanonicalJson,
  digestCanonicalJson,
  type Sha256Digest,
} from './json.js';

export interface DatasetDigests {
  datasetRevisionDigest: Sha256Digest;
  executionInputDigest: Sha256Digest;
  evaluationInputDigest: Sha256Digest;
}

export function projectExecutionInputs(
  dataset: EvaluationDataset,
): ExecutionInputSample[] {
  return dataset.samples.map((sample) => ({
    sampleId: sample.sampleId,
    input: sample.input,
    ...(sample.executionContext !== undefined
      ? { executionContext: sample.executionContext }
      : {}),
  }));
}

export function projectEvaluationInputs(
  dataset: EvaluationDataset,
): EvaluationInputSample[] {
  return dataset.samples.map((sample) => ({
    sampleId: sample.sampleId,
    input: sample.input,
    ...(sample.executionContext !== undefined
      ? { executionContext: sample.executionContext }
      : {}),
    ...(sample.expected !== undefined ? { expected: sample.expected } : {}),
    ...(sample.evaluationContext !== undefined
      ? { evaluationContext: sample.evaluationContext }
      : {}),
  }));
}

export function computeDatasetDigests(dataset: EvaluationDataset): DatasetDigests {
  return {
    datasetRevisionDigest: digestCanonicalJson(dataset),
    executionInputDigest: digestCanonicalJson({
      datasetId: dataset.datasetId,
      samples: projectExecutionInputs(dataset),
    }),
    evaluationInputDigest: digestCanonicalJson({
      datasetId: dataset.datasetId,
      samples: projectEvaluationInputs(dataset),
    }),
  };
}

export interface ExecutionPlanIdentityInput {
  executionInputDigest: Sha256Digest;
  targets: TargetDefinition[];
  executorRuntimes: ResolvedRuntime[];
  experiment: ExperimentDesign;
  policy: {
    execution: MeasurementPolicy['execution'];
    retry: MeasurementPolicy['retry'];
    budget: MeasurementPolicy['budget'];
    executionCacheMode: MeasurementPolicy['cache']['executionMode'];
    failure: MeasurementPolicy['failure'];
  };
  extensions?: Extensions;
}

export function computeExecutionPlanDigest(
  input: ExecutionPlanIdentityInput,
): Sha256Digest {
  return digestCanonicalJson({
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    executionInputDigest: input.executionInputDigest,
    targets: input.targets,
    executorRuntimes: input.executorRuntimes,
    experiment: input.experiment,
    policy: input.policy,
    ...(input.extensions !== undefined ? { extensions: input.extensions } : {}),
  });
}

export interface EvaluationPlanIdentityInput {
  executionPlanDigest: Sha256Digest;
  evaluationInputDigest: Sha256Digest;
  evaluators: EvaluatorDefinition[];
  metrics: MetricDefinition[];
  evaluatorRuntimes: ResolvedRuntime[];
  policy: {
    evaluationCacheMode: MeasurementPolicy['cache']['evaluationMode'];
    evidence: MeasurementPolicy['evidence'];
    failure: MeasurementPolicy['failure'];
  };
  extensions?: Extensions;
}

export function computeEvaluationPlanDigest(
  input: EvaluationPlanIdentityInput,
): Sha256Digest {
  return digestCanonicalJson({
    schemaVersion: EVALUATION_PLAN_SCHEMA_VERSION,
    executionPlanDigest: input.executionPlanDigest,
    evaluationInputDigest: input.evaluationInputDigest,
    evaluators: input.evaluators,
    metrics: input.metrics,
    evaluatorRuntimes: input.evaluatorRuntimes,
    policy: input.policy,
    ...(input.extensions !== undefined ? { extensions: input.extensions } : {}),
  });
}

export interface AnalysisPlanIdentityInput {
  evaluationPlanDigest: Sha256Digest;
  analysisGraph: AnalysisGraphDefinition;
  sampling: ExperimentDesign['sampling'];
  analysisRuntimes: ResolvedRuntime[];
  extensions?: Extensions;
}

export function computeAnalysisPlanDigest(
  input: AnalysisPlanIdentityInput,
): Sha256Digest {
  return digestCanonicalJson({
    schemaVersion: ANALYSIS_PLAN_SCHEMA_VERSION,
    evaluationPlanDigest: input.evaluationPlanDigest,
    analysisGraph: input.analysisGraph,
    sampling: input.sampling,
    analysisRuntimes: input.analysisRuntimes,
    ...(input.extensions !== undefined ? { extensions: input.extensions } : {}),
  });
}

export interface DecisionPlanIdentityInput {
  analysisPlanDigest: Sha256Digest;
  comparisons: ComparisonDefinition[];
  decisionPolicy?: DecisionPolicyDefinition;
  extensions?: Extensions;
}

export function computeDecisionPlanDigest(
  input: DecisionPlanIdentityInput,
): Sha256Digest {
  return digestCanonicalJson({
    schemaVersion: DECISION_PLAN_SCHEMA_VERSION,
    analysisPlanDigest: input.analysisPlanDigest,
    comparisons: input.comparisons,
    ...(input.decisionPolicy !== undefined
      ? { decisionPolicy: input.decisionPolicy }
      : {}),
    ...(input.extensions !== undefined ? { extensions: input.extensions } : {}),
  });
}

export interface RunContractIdentityInput {
  executionPlanDigest: Sha256Digest;
  evaluationPlanDigest: Sha256Digest;
  analysisPlanDigest: Sha256Digest;
  decisionPlanDigest: Sha256Digest;
  schemaIdentities: SchemaIdentity[];
  eventDeliveryPolicy: MeasurementPolicy['eventDelivery'];
  extensions?: Extensions;
}

export function computeRunContractDigest(
  input: RunContractIdentityInput,
): Sha256Digest {
  return digestCanonicalJson({
    schemaVersion: RUN_PLAN_SCHEMA_VERSION,
    executionPlanDigest: input.executionPlanDigest,
    evaluationPlanDigest: input.evaluationPlanDigest,
    analysisPlanDigest: input.analysisPlanDigest,
    decisionPlanDigest: input.decisionPlanDigest,
    schemaIdentities: [...input.schemaIdentities].sort((left, right) => {
      if (left.schemaVersion < right.schemaVersion) return -1;
      if (left.schemaVersion > right.schemaVersion) return 1;
      if (left.schemaUri < right.schemaUri) return -1;
      if (left.schemaUri > right.schemaUri) return 1;
      if (left.schemaDigest < right.schemaDigest) return -1;
      if (left.schemaDigest > right.schemaDigest) return 1;
      return 0;
    }),
    eventDeliveryPolicy: input.eventDeliveryPolicy,
    ...(input.extensions !== undefined ? { extensions: input.extensions } : {}),
  });
}

export interface PlanDigestInput {
  dataset: EvaluationDataset;
  targets: TargetDefinition[];
  evaluators: EvaluatorDefinition[];
  metrics: MetricDefinition[];
  experiment: ExperimentDesign;
  analysisGraph: AnalysisGraphDefinition;
  comparisons: ComparisonDefinition[];
  decisionPolicy?: DecisionPolicyDefinition;
  measurementPolicy: MeasurementPolicy;
  executorRuntimes: ResolvedRuntime[];
  evaluatorRuntimes: ResolvedRuntime[];
  analysisRuntimes: ResolvedRuntime[];
  schemaIdentities: SchemaIdentity[];
  stageExtensions?: {
    execution?: Extensions;
    evaluation?: Extensions;
    analysis?: Extensions;
    decision?: Extensions;
    run?: Extensions;
  };
}

export function computePlanDigests(input: PlanDigestInput): PlanDigests {
  const dataset = computeDatasetDigests(input.dataset);
  const executionPlanDigest = computeExecutionPlanDigest({
    executionInputDigest: dataset.executionInputDigest,
    targets: input.targets,
    executorRuntimes: input.executorRuntimes,
    experiment: input.experiment,
    policy: {
      execution: input.measurementPolicy.execution,
      retry: input.measurementPolicy.retry,
      budget: input.measurementPolicy.budget,
      executionCacheMode: input.measurementPolicy.cache.executionMode,
      failure: input.measurementPolicy.failure,
    },
    ...(input.stageExtensions?.execution !== undefined
      ? { extensions: input.stageExtensions.execution }
      : {}),
  });
  const evaluationPlanDigest = computeEvaluationPlanDigest({
    executionPlanDigest,
    evaluationInputDigest: dataset.evaluationInputDigest,
    evaluators: input.evaluators,
    metrics: input.metrics,
    evaluatorRuntimes: input.evaluatorRuntimes,
    policy: {
      evaluationCacheMode: input.measurementPolicy.cache.evaluationMode,
      evidence: input.measurementPolicy.evidence,
      failure: input.measurementPolicy.failure,
    },
    ...(input.stageExtensions?.evaluation !== undefined
      ? { extensions: input.stageExtensions.evaluation }
      : {}),
  });
  const analysisPlanDigest = computeAnalysisPlanDigest({
    evaluationPlanDigest,
    analysisGraph: input.analysisGraph,
    sampling: input.experiment.sampling,
    analysisRuntimes: input.analysisRuntimes,
    ...(input.stageExtensions?.analysis !== undefined
      ? { extensions: input.stageExtensions.analysis }
      : {}),
  });
  const decisionPlanDigest = computeDecisionPlanDigest({
    analysisPlanDigest,
    comparisons: input.comparisons,
    ...(input.decisionPolicy !== undefined
      ? { decisionPolicy: input.decisionPolicy }
      : {}),
    ...(input.stageExtensions?.decision !== undefined
      ? { extensions: input.stageExtensions.decision }
      : {}),
  });
  const runContractDigest = computeRunContractDigest({
    executionPlanDigest,
    evaluationPlanDigest,
    analysisPlanDigest,
    decisionPlanDigest,
    schemaIdentities: input.schemaIdentities,
    eventDeliveryPolicy: input.measurementPolicy.eventDelivery,
    ...(input.stageExtensions?.run !== undefined
      ? { extensions: input.stageExtensions.run }
      : {}),
  });

  return {
    ...dataset,
    executionPlanDigest,
    evaluationPlanDigest,
    analysisPlanDigest,
    decisionPlanDigest,
    runContractDigest,
  };
}

export function digestArtifactPayload(
  artifact: unknown,
  digestField: 'bundleDigest' | 'reportDigest',
): Sha256Digest {
  assertCanonicalJson(artifact);
  if (artifact === null || Array.isArray(artifact) || typeof artifact !== 'object') {
    throw new TypeError('A Bundle or Report digest payload must be a JSON object.');
  }
  const payload = { ...artifact };
  delete payload[digestField];
  return digestCanonicalJson(payload);
}
