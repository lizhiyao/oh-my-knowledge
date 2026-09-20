/**
 * 内建分析的度量聚合：trial 与 unit 两级的聚合与平均。
 */
import { z } from 'zod';
import {
  canonicalizeJson,
  type Sha256Digest,
} from '../contracts/index.js';
import type {
  AnalysisMetricRow,
  AnalysisNodeExecutionContext,
  AnalysisNodeInput,
} from './types.js';
import type {
  BootstrapUnit,
} from './builtin-primitives.js';
import {
  groupRows,
  mean,
  metricInputs,
  numericValue,
  parameters,
} from './builtin-primitives.js';
import {
  MeasurementAggregationSchema,
} from './builtin-schemas.js';

export type MeasurementAggregation = z.infer<typeof MeasurementAggregationSchema>;


export interface AggregatedMeasurementUnit extends BootstrapUnit {
  targetId: string;
  sampleId: string;
  pairingBlockId?: string;
  rowIds: Sha256Digest[];
}


export interface AggregatedMeasurementTrial extends AggregatedMeasurementUnit {
  trialIndex: number;
  trialId: Sha256Digest;
}


export function metricInput(context: AnalysisNodeExecutionContext): Extract<
  AnalysisNodeInput,
  { inputKind: 'metric-observations' }
> {
  const inputs = metricInputs(context);
  if (inputs.length !== 1) {
    throw new TypeError('Built-in Analysis implementations require exactly one Metric input.');
  }
  return inputs[0];
}


export function singleOptionalCoordinate<T>(
  rows: readonly T[],
  select: (row: T) => string | undefined,
  label: string,
): string | undefined {
  const values = new Set(rows.map(select));
  if (values.size > 1) throw new TypeError(`One measurement unit cannot cross ${label}.`);
  return select(rows[0]);
}


export function aggregateMeasurementTrials(
  input: Extract<AnalysisNodeInput, { inputKind: 'metric-observations' }>,
  aggregation: MeasurementAggregation | undefined,
): AggregatedMeasurementTrial[] {
  if (input.metric.metricId !== input.referenceId
      || input.rows.some((row) => row.metricId !== input.referenceId)) {
    throw new TypeError('Metric input identity differs from its measurement rows.');
  }
  const expected = new Map<string, Readonly<{
    ensembleMemberId: string;
    instrumentId: string;
    replicateIndex: number;
  }>>();
  if (aggregation !== undefined) {
    for (const member of aggregation.members) {
      for (const replicate of member.replicates) {
        expected.set(replicate.evaluatorId, {
          ensembleMemberId: member.ensembleMemberId,
          instrumentId: replicate.instrumentId,
          replicateIndex: replicate.replicateIndex,
        });
      }
    }
    for (const row of input.rows) {
      const coordinate = expected.get(row.evaluatorId);
      if (coordinate === undefined
          || row.measurement.instrumentId !== coordinate.instrumentId
          || row.measurement.ensembleMemberId !== coordinate.ensembleMemberId
          || row.measurement.replicateGroupId !== aggregation.replicateGroupId
          || row.measurement.replicateIndex !== coordinate.replicateIndex) {
        throw new TypeError('Measurement row differs from the sealed panel coordinates.');
      }
    }
  }
  const trials = groupRows(input.rows, (row) => canonicalizeJson([
    row.targetId,
    row.sampleId,
    row.trialIndex,
  ]));
  const completeTrials: AggregatedMeasurementTrial[] = [];
  for (const rows of trials.values()) {
    if (new Set(rows.map((row) => row.trialId)).size !== 1) {
      throw new TypeError('One measurement trial cannot cross trial identity.');
    }
    const byEvaluator = new Map<string, AnalysisMetricRow>();
    for (const row of rows) {
      if (byEvaluator.has(row.evaluatorId)) {
        throw new TypeError('Measurement trial contains a duplicate evaluator coordinate.');
      }
      byEvaluator.set(row.evaluatorId, row);
    }
    if (aggregation === undefined) {
      if (rows.length !== 1) {
        throw new TypeError('A non-panel Metric trial requires exactly one evaluator coordinate.');
      }
    } else if (byEvaluator.size !== expected.size
      || [...expected.keys()].some((evaluatorId) => !byEvaluator.has(evaluatorId))) {
      throw new TypeError('Measurement trial is missing a sealed evaluator coordinate.');
    }
    if (rows.some((row) => row.rowStatus !== 'observed')) continue;
    const value = aggregation === undefined
      ? numericValue(rows[0])
      : (() => {
        const memberValues = aggregation.members.map((member) => {
          const values = member.replicates.map((replicate) => numericValue(
            byEvaluator.get(replicate.evaluatorId)!,
          ));
          return {
            value: mean(values),
            weight: 'weight' in member ? member.weight : 1,
          };
        });
        return aggregation.method === 'weighted-mean'
          ? memberValues.reduce((sum, member) => sum + member.value * member.weight, 0)
          : mean(memberValues.map((member) => member.value));
      })();
    completeTrials.push({
      targetId: rows[0].targetId,
      sampleId: rows[0].sampleId,
      trialIndex: rows[0].trialIndex,
      trialId: rows[0].trialId,
      value,
      rowIds: rows.map((row) => row.rowId),
      ...(singleOptionalCoordinate(
        rows,
        (row) => row.samplingUnitIds.clusterId,
        'clusters',
      ) === undefined ? {} : {
        clusterId: rows[0].samplingUnitIds.clusterId,
      }),
      ...(singleOptionalCoordinate(
        rows,
        (row) => row.samplingUnitIds.stratumId,
        'strata',
      ) === undefined ? {} : {
        stratumId: rows[0].samplingUnitIds.stratumId,
      }),
      ...(singleOptionalCoordinate(
        rows,
        (row) => row.samplingUnitIds.pairingBlockId,
        'pairing blocks',
      ) === undefined ? {} : {
        pairingBlockId: rows[0].samplingUnitIds.pairingBlockId,
      }),
    });
  }
  return completeTrials;
}


export function averageMeasurementTrials(
  completeTrials: readonly AggregatedMeasurementTrial[],
): AggregatedMeasurementUnit[] {
  return [...groupRows(completeTrials, (trial) => (
    canonicalizeJson([trial.targetId, trial.sampleId])
  )).values()].map((group) => {
    const trialsForSample = group;
    const targetId = trialsForSample[0].targetId;
    const sampleId = trialsForSample[0].sampleId;
    if (trialsForSample.some((trial) => (
      trial.targetId !== targetId || trial.sampleId !== sampleId
    ))) {
      throw new TypeError('One sample measurement unit cannot cross target or sample identity.');
    }
    const stratumId = singleOptionalCoordinate(
      trialsForSample,
      (trial) => trial.stratumId,
      'strata',
    );
    const clusterId = singleOptionalCoordinate(
      trialsForSample,
      (trial) => trial.clusterId,
      'clusters',
    );
    const pairingBlockId = singleOptionalCoordinate(
      trialsForSample,
      (trial) => trial.pairingBlockId,
      'pairing blocks',
    );
    return {
      targetId,
      sampleId,
      value: mean(trialsForSample.map((trial) => trial.value)),
      rowIds: trialsForSample.flatMap((trial) => trial.rowIds),
      ...(clusterId === undefined ? {} : { clusterId }),
      ...(stratumId === undefined ? {} : { stratumId }),
      ...(pairingBlockId === undefined ? {} : { pairingBlockId }),
    };
  });
}


export function aggregateMeasurementUnits(
  context: AnalysisNodeExecutionContext,
): AggregatedMeasurementUnit[] {
  const aggregation = MeasurementAggregationSchema.parse(
    parameters(context).measurementAggregation,
  ) as MeasurementAggregation;
  return averageMeasurementTrials(aggregateMeasurementTrials(metricInput(context), aggregation));
}

