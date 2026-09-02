import {
  digestCanonicalJson,
  type EvaluationRecord,
} from '../../eval-core/contracts/index.js';
import type { GoldDataset } from '../../grading/gold-dataset.js';
import {
  computeAgreementWithCI,
  type RatingPair,
} from '../../grading/human-gold.js';
import type { StoredCoreRunArtifacts } from '../artifact-store/index.js';
import {
  CORE_GOLD_COMPARISON_SCHEMA_VERSION,
  CoreDownstreamProjectionError,
  type CoreGoldComparisonResult,
  type CoreGoldMetricSelector,
} from './contracts.js';
import { assertCoreProjectionSource } from './source.js';

export interface CompareGoldToCoreRunInput {
  readonly source: Readonly<StoredCoreRunArtifacts>;
  readonly gold: CoreGoldDatasetInput;
  readonly selector: Readonly<CoreGoldMetricSelector>;
  readonly bootstrapSamples?: number;
  readonly bootstrapSeed?: number;
}

export interface CoreGoldDatasetInput {
  readonly metadata: Readonly<GoldDataset['metadata']>;
  readonly annotations: readonly GoldDataset['annotations'][number][];
  readonly sourcePaths: readonly string[];
}

function matchesSelector(
  record: EvaluationRecord,
  selector: Readonly<CoreGoldMetricSelector>,
): boolean {
  return record.targetId === selector.targetId
    && record.evaluatorId === selector.evaluatorId
    && (selector.trialIndex === undefined || record.trialIndex === selector.trialIndex)
    && (selector.instrumentId === undefined
      || record.measurement.instrumentId === selector.instrumentId)
    && (selector.ensembleMemberId === undefined
      || record.measurement.ensembleMemberId === selector.ensembleMemberId)
    && (selector.replicateGroupId === undefined
      || record.measurement.replicateGroupId === selector.replicateGroupId)
    && (selector.replicateIndex === undefined
      || record.measurement.replicateIndex === selector.replicateIndex);
}

function normalizedIdentity(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function sealedEvaluatorRuntimeAliases(config: unknown): string[] {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return [];
  const runtime = (config as Record<string, unknown>).runtime;
  if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime)) return [];
  const { executorId, model } = runtime as Record<string, unknown>;
  if (typeof model !== 'string' || model.trim() === '') return [];
  return [
    model,
    ...(typeof executorId === 'string' && executorId.trim() !== ''
      ? [`${executorId}:${model}`]
      : []),
  ];
}

function jsonNumber(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * Compare one explicitly selected Core numeric observation with external gold.
 * The projector refuses implicit pooling: every sample must resolve to at most
 * one observed value after the caller's trial/measurement selector is applied.
 */
export function compareGoldToCoreRun(
  input: Readonly<CompareGoldToCoreRunInput>,
): CoreGoldComparisonResult {
  assertCoreProjectionSource(input.source);
  const { plan, evaluation, report } = input.source;
  const { selector, gold } = input;
  const target = plan.execution.targets.find((entry) => entry.targetId === selector.targetId);
  const evaluator = plan.evaluation.evaluators.find(
    (entry) => entry.evaluatorId === selector.evaluatorId,
  );
  const metric = plan.evaluation.metrics.find((entry) => entry.metricId === selector.metricId);
  const evaluatorRuntime = plan.evaluation.runtimes.find((runtime) => (
    runtime.runtimeKind === 'evaluator' && runtime.referenceId === selector.evaluatorId
  ));
  if (target === undefined
      || evaluator === undefined
      || metric === undefined
      || evaluatorRuntime === undefined
      || !evaluator.metricIds.includes(metric.metricId)) {
    throw new CoreDownstreamProjectionError(
      'CORE_GOLD_SELECTOR_INVALID',
      'Gold comparison selector must reference one sealed Target, Evaluator, and owned Metric.',
    );
  }
  const sealedMeasurement = evaluator.measurement;
  if ((selector.trialIndex !== undefined
        && (!Number.isInteger(selector.trialIndex) || selector.trialIndex < 0))
      || (selector.instrumentId !== undefined
        && selector.instrumentId !== sealedMeasurement.instrumentId)
      || (selector.ensembleMemberId !== undefined
        && selector.ensembleMemberId !== sealedMeasurement.ensembleMemberId)
      || (selector.replicateGroupId !== undefined
        && selector.replicateGroupId !== sealedMeasurement.replicateGroupId)
      || (selector.replicateIndex !== undefined
        && selector.replicateIndex !== sealedMeasurement.replicateIndex)) {
    throw new CoreDownstreamProjectionError(
      'CORE_GOLD_SELECTOR_INVALID',
      'Gold comparison measurement selector must match the Evaluator measurement sealed in the Plan.',
    );
  }
  if (metric.valueType !== 'numeric'
      || metric.scale?.min === undefined
      || metric.scale.max === undefined
      || !Number.isFinite(metric.scale.min)
      || !Number.isFinite(metric.scale.max)
      || metric.scale.min >= metric.scale.max) {
    throw new CoreDownstreamProjectionError(
      'CORE_GOLD_SCALE_INCOMPATIBLE',
      'Gold comparison requires a numeric Core Metric with an explicit finite min/max scale.',
    );
  }
  const scale = gold.metadata.scale ?? { min: 1, max: 5 };
  if (!Number.isFinite(scale.min)
      || !Number.isFinite(scale.max)
      || scale.min >= scale.max
      || scale.min !== metric.scale.min
      || scale.max !== metric.scale.max) {
    throw new CoreDownstreamProjectionError(
      'CORE_GOLD_SCALE_INCOMPATIBLE',
      'Gold and Core Metric scales must match exactly; rescaling requires a preregistered analysis.',
    );
  }
  const annotationIds = gold.annotations.map((annotation) => annotation.sample_id);
  if (new Set(annotationIds).size !== annotationIds.length
      || gold.annotations.some((annotation) => (
        !annotation.sample_id
        || !Number.isFinite(annotation.score)
        || annotation.score < scale.min
        || annotation.score > scale.max
      ))) {
    throw new CoreDownstreamProjectionError(
      'CORE_GOLD_ANNOTATION_INVALID',
      'Gold annotations require unique sample IDs and finite scores inside the declared scale.',
    );
  }

  const sampleIds = new Set(plan.evaluation.samples.map((sample) => sample.sampleId));
  const records = evaluation.records.filter((record) => matchesSelector(record, selector));
  const pairs: RatingPair[] = [];
  const rows: CoreGoldComparisonResult['rows'][number][] = [];
  const missingSampleIds: string[] = [];
  const unscoredSampleIds: string[] = [];

  for (const annotation of [...gold.annotations].sort((left, right) => (
    left.sample_id.localeCompare(right.sample_id)
  ))) {
    if (!sampleIds.has(annotation.sample_id)) {
      missingSampleIds.push(annotation.sample_id);
      continue;
    }
    const observations = records.flatMap((record) => (
      record.sampleId === annotation.sample_id && record.evaluationStatus === 'completed'
        ? record.observations.flatMap((observation) => (
          observation.metricId === selector.metricId
            && observation.observationStatus === 'observed'
            && observation.valueType === 'numeric'
            ? [{ record, observation }]
            : []
        ))
        : []
    ));
    if (observations.length > 1) {
      throw new CoreDownstreamProjectionError(
        'CORE_GOLD_OBSERVATION_AMBIGUOUS',
        'A Gold sample resolves to multiple Core observations; refine the measurement/trial selector.',
      );
    }
    const selected = observations[0];
    if (selected === undefined) {
      unscoredSampleIds.push(annotation.sample_id);
      continue;
    }
    if (!Number.isFinite(selected.observation.value)
        || selected.observation.value < scale.min
        || selected.observation.value > scale.max) {
      throw new CoreDownstreamProjectionError(
        'CORE_PROJECTION_SOURCE_INVALID',
        'Selected Core observation is outside its sealed Metric scale.',
      );
    }
    pairs.push({
      unitId: annotation.sample_id,
      coderA: annotation.score,
      coderB: selected.observation.value,
    });
    rows.push({
      sampleId: annotation.sample_id,
      goldScore: annotation.score,
      observedScore: selected.observation.value,
      difference: Number((selected.observation.value - annotation.score).toFixed(4)),
      evaluationId: selected.record.evaluationId,
      observationId: selected.observation.observationId,
    });
  }

  const annotator = normalizedIdentity(gold.metadata.annotator);
  const runtimeIds = [
    evaluator.implementationId,
    evaluatorRuntime.identity.implementationId,
    evaluatorRuntime.identity.fingerprint,
    ...sealedEvaluatorRuntimeAliases(evaluator.config),
  ].map(normalizedIdentity);
  const contaminationWarning = runtimeIds.includes(annotator)
    ? `gold annotator "${gold.metadata.annotator}" exactly matches the selected evaluator identity; agreement may be inflated`
    : undefined;
  const agreement = computeAgreementWithCI(pairs, {
    samples: input.bootstrapSamples,
    seed: input.bootstrapSeed,
    scale,
  });
  const goldDatasetDigest = digestCanonicalJson({
    metadata: {
      annotator: gold.metadata.annotator,
      annotatedAt: gold.metadata.annotatedAt,
      version: gold.metadata.version,
      ...(gold.metadata.scale === undefined ? {} : { scale: gold.metadata.scale }),
      ...(gold.metadata.notes === undefined ? {} : { notes: gold.metadata.notes }),
    },
    annotations: [...gold.annotations]
      .sort((left, right) => left.sample_id.localeCompare(right.sample_id))
      .map((annotation) => ({
        sample_id: annotation.sample_id,
        score: annotation.score,
        ...(annotation.reason === undefined ? {} : { reason: annotation.reason }),
      })),
  });

  return {
    projectionKind: 'core-gold-comparison',
    schemaVersion: CORE_GOLD_COMPARISON_SCHEMA_VERSION,
    runContractDigest: plan.digests.runContractDigest,
    reportDigest: report.reportDigest,
    gold: {
      datasetDigest: goldDatasetDigest,
      annotator: gold.metadata.annotator,
      annotatedAt: gold.metadata.annotatedAt,
      version: gold.metadata.version,
    },
    selector: { ...selector },
    scale: { ...scale },
    evaluatorRuntime: evaluatorRuntime.identity,
    agreement: {
      alpha: jsonNumber(agreement.alpha),
      alphaCI: {
        low: jsonNumber(agreement.alphaCI.low),
        high: jsonNumber(agreement.alphaCI.high),
        estimate: jsonNumber(agreement.alphaCI.estimate),
        samples: agreement.alphaCI.samples,
      },
      weightedKappa: jsonNumber(agreement.weightedKappa),
      pearson: jsonNumber(agreement.pearson),
      sampleCount: agreement.sampleCount,
    },
    rows,
    missingSampleIds,
    unscoredSampleIds,
    ...(contaminationWarning === undefined ? {} : { contaminationWarning }),
  };
}
