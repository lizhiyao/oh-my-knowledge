import type {
  AnalysisGraphDefinition,
  ComparisonDefinition,
  DecisionPolicyDefinition,
  EvaluationDataset,
  EvaluationDefinition,
  EvaluatorDefinition,
  ExecutionExperimentDesign,
  ExperimentDesign,
  AssignmentAllocation,
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
  type AnalysisInputSample,
  type AssignmentMembership,
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
  analysisInputDigest: Sha256Digest;
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

export function projectAnalysisInputs(
  dataset: EvaluationDataset,
): AnalysisInputSample[] {
  return dataset.samples.map((sample) => ({
    sampleId: sample.sampleId,
    ...(sample.analysis !== undefined ? {
      analysis: {
        memberships: [...sample.analysis.memberships].sort((left, right) => (
          compareStrings(left.cohortId, right.cohortId)
        )),
        ...(sample.analysis.context !== undefined ? { context: sample.analysis.context } : {}),
      },
    } : {}),
  }));
}

export function projectAnalysisCohorts(
  dataset: EvaluationDataset,
): NonNullable<EvaluationDataset['analysisCohorts']> {
  return [...(dataset.analysisCohorts ?? [])].sort((left, right) => (
    compareStrings(left.cohortSetId, right.cohortSetId)
    || compareStrings(left.cohortId, right.cohortId)
  ));
}

export function projectAnalysisGraph(
  graph: AnalysisGraphDefinition,
): AnalysisGraphDefinition {
  return {
    analysisMode: graph.analysisMode,
    nodes: graph.nodes.map((node) => ({
      ...node,
      ...(node.targetFilter === undefined ? {} : {
        targetFilter: {
          includeTargetIds: [...node.targetFilter.includeTargetIds].sort(compareStrings),
        },
      }),
      ...(node.cohortFilter === undefined ? {} : {
        cohortFilter: {
          ...(node.cohortFilter.includeCohortIds === undefined ? {} : {
            includeCohortIds: [...node.cohortFilter.includeCohortIds].sort(compareStrings),
          }),
          ...(node.cohortFilter.excludeCohortIds === undefined ? {} : {
            excludeCohortIds: [...node.cohortFilter.excludeCohortIds].sort(compareStrings),
          }),
        },
      }),
    })),
  };
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
    analysisInputDigest: digestCanonicalJson({
      datasetId: dataset.datasetId,
      cohorts: projectAnalysisCohorts(dataset),
      samples: projectAnalysisInputs(dataset),
    }),
  };
}

export interface ExecutionPlanIdentityInput {
  executionInputDigest: Sha256Digest;
  randomizationDesignDigest: Sha256Digest;
  targets: TargetDefinition[];
  assignments: AssignmentMembership[];
  schedulingTargetGroups: string[][];
  executorRuntimes: ResolvedRuntime[];
  experiment: ExecutionExperimentDesign;
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
    assignments: input.assignments,
    schedulingTargetGroups: input.schedulingTargetGroups,
    executorRuntimes: input.executorRuntimes,
    experiment: projectExecutionExperimentDesign(input.experiment),
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

export interface AssignmentDerivationInput {
  samples: readonly ExecutionInputSample[];
  experiment: Pick<ExperimentDesign, 'seed' | 'assignment' | 'randomizationSlots'>;
}

function compareAssignments(left: AssignmentMembership, right: AssignmentMembership): number {
  return compareStrings(left.randomizationSlotId, right.randomizationSlotId)
    || compareStrings(left.sampleId, right.sampleId)
    || compareStrings(left.targetId, right.targetId);
}

function assignmentStrata(input: AssignmentDerivationInput): Array<{
  stratumKey: string;
  samples: ExecutionInputSample[];
}> {
  const pointer = input.experiment.assignment.stratumKey;
  const groups = new Map<string, ExecutionInputSample[]>();
  for (const sample of input.samples) {
    const stratumKey = pointer === undefined
      ? 'unstratified:'
      : `value:${canonicalizeJson(resolveSamplingPointer(sample, pointer))}`;
    const members = groups.get(stratumKey) ?? [];
    members.push(sample);
    groups.set(stratumKey, members);
  }
  return [...groups.entries()]
    .map(([stratumKey, samples]) => ({ stratumKey, samples }))
    .sort((left, right) => compareStrings(left.stratumKey, right.stratumKey));
}

function fixedQuotaCounts(
  size: number,
  allocations: readonly AssignmentAllocation[],
  seed: string,
  algorithmId: string,
  stratumKey: string,
): Map<string, number> {
  const maximumWeight = Math.max(...allocations.map((allocation) => allocation.weight));
  const normalized = allocations.map((allocation) => ({
    ...allocation,
    normalizedWeight: allocation.weight / maximumWeight,
  }));
  if (normalized.some((allocation) => allocation.normalizedWeight === 0)) {
    throw new TypeError('Assignment weight ratio is outside the supported numeric range.');
  }
  const totalWeight = normalized.reduce((sum, allocation) => (
    sum + allocation.normalizedWeight
  ), 0);
  const quotas = normalized.map((allocation) => {
    const exact = size * allocation.normalizedWeight / totalWeight;
    return {
      randomizationSlotId: allocation.randomizationSlotId,
      count: Math.floor(exact),
      remainder: exact - Math.floor(exact),
      tieBreak: digestCanonicalJson({
        derivation: 'omk.assignment-fixed-quota-tie/v1',
        seed,
        algorithmId,
        stratumKey,
        randomizationSlotId: allocation.randomizationSlotId,
      }),
    };
  });
  let remaining = size - quotas.reduce((sum, quota) => sum + quota.count, 0);
  const remainderOrder = [...quotas].sort((left, right) => (
    right.remainder - left.remainder
      || compareStrings(left.tieBreak, right.tieBreak)
      || compareStrings(left.randomizationSlotId, right.randomizationSlotId)
  ));
  for (const quota of remainderOrder) {
    if (remaining === 0) break;
    quota.count += 1;
    remaining -= 1;
  }
  if (remaining !== 0) throw new TypeError('Assignment fixed quota could not allocate every sample.');
  return new Map(quotas.map((quota) => [quota.randomizationSlotId, quota.count]));
}

export function deriveAssignmentMemberships(
  input: AssignmentDerivationInput,
): AssignmentMembership[] {
  const slotById = new Map(input.experiment.randomizationSlots.map((slot) => (
    [slot.randomizationSlotId, slot] as const
  )));
  const assignment = input.experiment.assignment;
  if (assignment.assignmentKind === 'complete-block') {
    return input.samples.flatMap((sample) => assignment.randomizationSlotIds.map((slotId) => {
      const slot = slotById.get(slotId);
      if (slot === undefined) throw new TypeError(`Unknown assignment slot ${slotId}.`);
      return {
        sampleId: sample.sampleId,
        targetId: slot.targetId,
        randomizationSlotId: slot.randomizationSlotId,
      };
    })).sort(compareAssignments);
  }

  const memberships: AssignmentMembership[] = [];
  for (const stratum of assignmentStrata(input)) {
    const counts = fixedQuotaCounts(
      stratum.samples.length,
      assignment.allocations,
      input.experiment.seed,
      assignment.algorithmId,
      stratum.stratumKey,
    );
    for (const allocation of assignment.allocations) {
      if ((counts.get(allocation.randomizationSlotId) ?? 0)
          < assignment.minimumUnitsPerTargetPerStratum) {
        throw new TypeError(
          `Independent assignment cannot satisfy per-stratum minimum for ${allocation.randomizationSlotId}.`,
        );
      }
    }
    const samples = [...stratum.samples].sort((left, right) => {
      const leftScore = digestCanonicalJson({
        derivation: 'omk.assignment-sample-order/v1',
        seed: input.experiment.seed,
        algorithmId: assignment.algorithmId,
        stratumKey: stratum.stratumKey,
        sampleId: left.sampleId,
      });
      const rightScore = digestCanonicalJson({
        derivation: 'omk.assignment-sample-order/v1',
        seed: input.experiment.seed,
        algorithmId: assignment.algorithmId,
        stratumKey: stratum.stratumKey,
        sampleId: right.sampleId,
      });
      return compareStrings(leftScore, rightScore) || compareStrings(left.sampleId, right.sampleId);
    });
    let offset = 0;
    for (const allocation of assignment.allocations) {
      const slot = slotById.get(allocation.randomizationSlotId);
      if (slot === undefined) {
        throw new TypeError(`Unknown assignment slot ${allocation.randomizationSlotId}.`);
      }
      const count = counts.get(allocation.randomizationSlotId) ?? 0;
      for (const sample of samples.slice(offset, offset + count)) {
        memberships.push({
          sampleId: sample.sampleId,
          targetId: slot.targetId,
          randomizationSlotId: slot.randomizationSlotId,
        });
      }
      offset += count;
    }
    if (offset !== samples.length) {
      throw new TypeError('Independent assignment did not consume every sample exactly once.');
    }
  }
  const countBySlot = new Map<string, number>();
  for (const membership of memberships) {
    countBySlot.set(
      membership.randomizationSlotId,
      (countBySlot.get(membership.randomizationSlotId) ?? 0) + 1,
    );
  }
  for (const allocation of assignment.allocations) {
    if ((countBySlot.get(allocation.randomizationSlotId) ?? 0)
        < assignment.minimumUnitsPerTarget) {
      throw new TypeError(
        `Independent assignment cannot satisfy target minimum for ${allocation.randomizationSlotId}.`,
      );
    }
  }
  return memberships.sort(compareAssignments);
}

export interface RandomizationDesignIdentityInput {
  executionInputDigest: Sha256Digest;
  samples: readonly ExecutionInputSample[];
  schedulingTargetGroups: readonly (readonly string[])[];
  experiment: ExperimentDesign;
  assignments: readonly AssignmentMembership[];
}

export function projectExecutionExperimentDesign(
  experiment: ExecutionExperimentDesign,
): ExecutionExperimentDesign {
  return {
    trials: experiment.trials,
    seed: experiment.seed,
    assignment: experiment.assignment.assignmentKind === 'complete-block' ? {
      assignmentKind: experiment.assignment.assignmentKind,
      algorithmId: experiment.assignment.algorithmId,
      ...(experiment.assignment.stratumKey === undefined ? {} : {
        stratumKey: experiment.assignment.stratumKey,
      }),
      randomizationSlotIds: [...experiment.assignment.randomizationSlotIds],
    } : {
      assignmentKind: experiment.assignment.assignmentKind,
      algorithmId: experiment.assignment.algorithmId,
      ...(experiment.assignment.stratumKey === undefined ? {} : {
        stratumKey: experiment.assignment.stratumKey,
      }),
      allocations: experiment.assignment.allocations.map((allocation) => ({ ...allocation })),
      minimumUnitsPerTarget: experiment.assignment.minimumUnitsPerTarget,
      minimumUnitsPerTargetPerStratum:
        experiment.assignment.minimumUnitsPerTargetPerStratum,
    },
    sampling: {
      experimentalUnit: experiment.sampling.experimentalUnit,
      ...(experiment.sampling.pairingKey === undefined ? {} : {
        pairingKey: experiment.sampling.pairingKey,
      }),
      ...(experiment.sampling.clusterKey === undefined ? {} : {
        clusterKey: experiment.sampling.clusterKey,
      }),
      repeatedMeasures: experiment.sampling.repeatedMeasures,
      resamplingUnit: experiment.sampling.resamplingUnit,
      seedCoupling: experiment.sampling.seedCoupling,
    },
    scheduling: {
      schedulingKind: experiment.scheduling.schedulingKind,
      ...(experiment.scheduling.blockSize === undefined ? {} : {
        blockSize: experiment.scheduling.blockSize,
      }),
    },
    randomizationSlots: experiment.randomizationSlots.map((slot) => ({
      targetId: slot.targetId,
      randomizationSlotId: slot.randomizationSlotId,
    })),
  };
}

export function computeRandomizationDesignDigest(
  input: RandomizationDesignIdentityInput,
): Sha256Digest {
  const experiment = projectExecutionExperimentDesign(input.experiment);
  const targetToSlot = new Map(experiment.randomizationSlots.map((slot) => [
    slot.targetId,
    slot.randomizationSlotId,
  ]));
  if (targetToSlot.size !== experiment.randomizationSlots.length) {
    throw new TypeError('randomizationSlots must map every Target at most once');
  }
  const slotIds = experiment.randomizationSlots
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
  const { sampling } = experiment;
  return digestCanonicalJson({
    derivation: 'omk.randomization-design/v2',
    executionInputDigest: input.executionInputDigest,
    trials: experiment.trials,
    rootSeed: experiment.seed,
    sampling,
    assignment: experiment.assignment,
    assignments: [...input.assignments].sort(compareAssignments).map((membership) => ({
      sampleId: membership.sampleId,
      randomizationSlotId: membership.randomizationSlotId,
    })),
    scheduling: experiment.scheduling,
    randomizationSlotIds: slotIds,
    schedulingSlotGroups,
    samplingMemberships: {
      pairing: projectSamplingMemberships(input.samples, sampling.pairingKey),
      cluster: projectSamplingMemberships(input.samples, sampling.clusterKey),
      stratum: projectSamplingMemberships(input.samples, experiment.assignment.stratumKey),
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
    budget: MeasurementPolicy['budget'];
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
  analysisInputDigest: Sha256Digest;
  samples: AnalysisInputSample[];
  cohorts: NonNullable<EvaluationDataset['analysisCohorts']>;
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
    analysisInputDigest: input.analysisInputDigest,
    samples: input.samples,
    cohorts: input.cohorts,
    metrics: input.metrics,
    analysisGraph: projectAnalysisGraph(input.analysisGraph),
    experiment: input.experiment,
    comparisons: input.comparisons,
    analysisRuntimes: input.analysisRuntimes,
    ...(input.extensions !== undefined ? { extensions: input.extensions } : {}),
  });
}

export interface DecisionPlanIdentityInput {
  analysisPlanDigest: Sha256Digest;
  analysisInputDigest: Sha256Digest;
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
    analysisInputDigest: input.analysisInputDigest,
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
  seriesMembership?: EvaluationDefinition['seriesMembership'];
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
    ...(input.seriesMembership !== undefined
      ? { seriesMembership: input.seriesMembership }
      : {}),
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
  seriesMembership?: EvaluationDefinition['seriesMembership'];
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
  const assignments = deriveAssignmentMemberships({
    samples: executionSamples,
    experiment: input.experiment,
  });
  const randomizationDesignDigest = computeRandomizationDesignDigest({
    executionInputDigest: dataset.executionInputDigest,
    samples: executionSamples,
    schedulingTargetGroups,
    experiment: input.experiment,
    assignments,
  });
  const executionPlanDigest = computeExecutionPlanDigest({
    executionInputDigest: dataset.executionInputDigest,
    randomizationDesignDigest,
    targets: input.targets,
    assignments,
    schedulingTargetGroups,
    executorRuntimes: input.executorRuntimes,
    experiment: projectExecutionExperimentDesign(input.experiment),
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
      budget: input.measurementPolicy.budget,
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
    analysisInputDigest: dataset.analysisInputDigest,
    samples: projectAnalysisInputs(input.dataset),
    cohorts: projectAnalysisCohorts(input.dataset),
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
    analysisInputDigest: dataset.analysisInputDigest,
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
    ...(input.seriesMembership !== undefined
      ? { seriesMembership: input.seriesMembership }
      : {}),
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
