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
import type { Extensions, RuntimeIdentity, SchemaIdentity } from './common.js';
import {
  assertCanonicalJson,
  canonicalizeJson,
  digestCanonicalJson,
  type JsonValue,
  type Sha256Digest,
} from './json.js';
import { deriveSchedulingTargetGroups } from './execution-identities.js';

export interface DatasetDigests {
  datasetRevisionDigest: Sha256Digest;
  executionInputDigest: Sha256Digest;
  evaluationInputDigest: Sha256Digest;
}

export function computeRuntimeIdentityDigest(
  identity: RuntimeIdentity,
): Sha256Digest {
  return digestCanonicalJson({
    derivation: 'omk.runtime-identity/v1',
    identity,
  });
}

export function computeRuntimeImplementationDigest(
  identity: RuntimeIdentity,
): Sha256Digest {
  return digestCanonicalJson({
    derivation: 'omk.runtime-implementation-identity/v1',
    implementationId: identity.implementationId,
    ...(identity.version !== undefined ? { version: identity.version } : {}),
    fingerprint: identity.fingerprint,
    capabilities: identity.capabilities,
    implementationManifest: identity.implementationManifest,
  });
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
  randomizationDesignDigest: Sha256Digest;
  targets: TargetDefinition[];
  schedulingTargetGroups: string[][];
  executorRuntimes: ResolvedRuntime[];
  experiment: ExperimentDesign;
  policy: {
    execution: MeasurementPolicy['execution'];
    retry: MeasurementPolicy['retry'];
    budget: MeasurementPolicy['budget'];
    executionCacheMode: MeasurementPolicy['cache']['executionMode'];
    evidence: Pick<MeasurementPolicy['evidence'], 'output' | 'trace' | 'maximumClassification'>;
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
    randomizationDesignDigest: input.randomizationDesignDigest,
    targets: input.targets,
    schedulingTargetGroups: input.schedulingTargetGroups,
    executorRuntimes: input.executorRuntimes,
    experiment: input.experiment,
    policy: input.policy,
    ...(input.extensions !== undefined ? { extensions: input.extensions } : {}),
  });
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function resolveSamplingPointer(value: unknown, pointer: string): JsonValue {
  let current = value;
  if (pointer !== '') {
    for (const encodedToken of pointer.slice(1).split('/')) {
      const token = encodedToken.replaceAll('~1', '/').replaceAll('~0', '~');
      if (current === null || typeof current !== 'object') {
        throw new TypeError(`Sampling pointer ${pointer} does not resolve`);
      }
      if (Array.isArray(current)) {
        if (!/^(?:0|[1-9]\d*)$/.test(token)) {
          throw new TypeError(`Sampling pointer ${pointer} does not resolve`);
        }
        current = current[Number(token)];
      } else {
        if (!Object.prototype.hasOwnProperty.call(current, token)) {
          throw new TypeError(`Sampling pointer ${pointer} does not resolve`);
        }
        current = (current as Record<string, unknown>)[token];
      }
    }
  }
  assertCanonicalJson(current);
  return current as JsonValue;
}

function projectSamplingMemberships(
  samples: readonly ExecutionInputSample[],
  pointer: string | undefined,
): string[][] {
  if (pointer === undefined) return [];
  const groups = new Map<string, string[]>();
  for (const sample of samples) {
    const key = canonicalizeJson(resolveSamplingPointer(sample, pointer));
    const members = groups.get(key) ?? [];
    members.push(sample.sampleId);
    groups.set(key, members);
  }
  return [...groups.values()]
    .map((members) => [...members].sort(compareStrings))
    .sort((left, right) => compareStrings(canonicalizeJson(left), canonicalizeJson(right)));
}

export interface RandomizationDesignIdentityInput {
  executionInputDigest: Sha256Digest;
  samples: readonly ExecutionInputSample[];
  schedulingTargetGroups: readonly (readonly string[])[];
  experiment: ExperimentDesign;
}

export function computeRandomizationDesignDigest(
  input: RandomizationDesignIdentityInput,
): Sha256Digest {
  const targetToSlot = new Map(input.experiment.randomizationSlots.map((slot) => [
    slot.targetId,
    slot.randomizationSlotId,
  ]));
  if (targetToSlot.size !== input.experiment.randomizationSlots.length) {
    throw new TypeError('randomizationSlots must map every Target at most once');
  }
  const slotIds = input.experiment.randomizationSlots
    .map((slot) => slot.randomizationSlotId)
    .sort(compareStrings);
  if (new Set(slotIds).size !== slotIds.length) {
    throw new TypeError('randomizationSlots must use unique randomizationSlotId values');
  }
  const schedulingSlotGroups = input.schedulingTargetGroups.map((group) => (
    group.map((targetId) => {
      const slotId = targetToSlot.get(targetId);
      if (slotId === undefined) {
        throw new TypeError(`Missing randomization slot for Target ${targetId}`);
      }
      return slotId;
    }).sort(compareStrings)
  )).sort((left, right) => compareStrings(canonicalizeJson(left), canonicalizeJson(right)));
  const { sampling } = input.experiment;
  return digestCanonicalJson({
    derivation: 'omk.randomization-design/v1',
    executionInputDigest: input.executionInputDigest,
    trials: input.experiment.trials,
    rootSeed: input.experiment.seed,
    sampling,
    scheduling: input.experiment.scheduling,
    randomizationSlotIds: slotIds,
    schedulingSlotGroups,
    samplingMemberships: {
      pairing: projectSamplingMemberships(input.samples, sampling.pairingKey),
      cluster: projectSamplingMemberships(input.samples, sampling.clusterKey),
      stratum: projectSamplingMemberships(input.samples, sampling.stratumKey),
    },
  });
}

export interface EvaluationPlanIdentityInput {
  executionPlanDigest: Sha256Digest;
  evaluationInputDigest: Sha256Digest;
  evaluators: EvaluatorDefinition[];
  metrics: MetricDefinition[];
  evaluatorRuntimes: ResolvedRuntime[];
  policy: {
    runtime: MeasurementPolicy['evaluation'];
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
  metrics: MetricDefinition[];
  analysisGraph: AnalysisGraphDefinition;
  experiment: ExperimentDesign;
  comparisons: ComparisonDefinition[];
  analysisRuntimes: ResolvedRuntime[];
  extensions?: Extensions;
}

export function computeAnalysisPlanDigest(
  input: AnalysisPlanIdentityInput,
): Sha256Digest {
  return digestCanonicalJson({
    schemaVersion: ANALYSIS_PLAN_SCHEMA_VERSION,
    evaluationPlanDigest: input.evaluationPlanDigest,
    metrics: input.metrics,
    analysisGraph: input.analysisGraph,
    experiment: input.experiment,
    comparisons: input.comparisons,
    analysisRuntimes: input.analysisRuntimes,
    ...(input.extensions !== undefined ? { extensions: input.extensions } : {}),
  });
}

export interface DecisionPlanIdentityInput {
  analysisPlanDigest: Sha256Digest;
  decisionPolicy?: DecisionPolicyDefinition;
  decisionRuntimes: ResolvedRuntime[];
  extensions?: Extensions;
}

export function computeDecisionPlanDigest(
  input: DecisionPlanIdentityInput,
): Sha256Digest {
  return digestCanonicalJson({
    schemaVersion: DECISION_PLAN_SCHEMA_VERSION,
    analysisPlanDigest: input.analysisPlanDigest,
    ...(input.decisionPolicy !== undefined
      ? { decisionPolicy: input.decisionPolicy }
      : {}),
    decisionRuntimes: input.decisionRuntimes,
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
  decisionRuntimes: ResolvedRuntime[];
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
  const schedulingTargetGroups = deriveSchedulingTargetGroups({
    targetIds: input.targets.map((target) => target.targetId),
    comparisons: input.comparisons,
    paired: input.experiment.sampling.resamplingUnit === 'paired-block',
  });
  const executionSamples = projectExecutionInputs(input.dataset);
  const randomizationDesignDigest = computeRandomizationDesignDigest({
    executionInputDigest: dataset.executionInputDigest,
    samples: executionSamples,
    schedulingTargetGroups,
    experiment: input.experiment,
  });
  const executionPlanDigest = computeExecutionPlanDigest({
    executionInputDigest: dataset.executionInputDigest,
    randomizationDesignDigest,
    targets: input.targets,
    schedulingTargetGroups,
    executorRuntimes: input.executorRuntimes,
    experiment: input.experiment,
    policy: {
      execution: input.measurementPolicy.execution,
      retry: input.measurementPolicy.retry,
      budget: input.measurementPolicy.budget,
      executionCacheMode: input.measurementPolicy.cache.executionMode,
      evidence: {
        output: input.measurementPolicy.evidence.output,
        trace: input.measurementPolicy.evidence.trace,
        maximumClassification: input.measurementPolicy.evidence.maximumClassification,
      },
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
      runtime: input.measurementPolicy.evaluation,
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
    metrics: input.metrics,
    analysisGraph: input.analysisGraph,
    experiment: input.experiment,
    comparisons: input.comparisons,
    analysisRuntimes: input.analysisRuntimes,
    ...(input.stageExtensions?.analysis !== undefined
      ? { extensions: input.stageExtensions.analysis }
      : {}),
  });
  const decisionPlanDigest = computeDecisionPlanDigest({
    analysisPlanDigest,
    ...(input.decisionPolicy !== undefined
      ? { decisionPolicy: input.decisionPolicy }
      : {}),
    decisionRuntimes: input.decisionRuntimes,
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
    randomizationDesignDigest,
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
