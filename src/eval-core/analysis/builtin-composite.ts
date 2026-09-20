/**
 * 内建分析的复合族：复合输入的失败原因、效用、覆盖假设与单元构建。
 */
import { z } from 'zod';
import {
  canonicalizeJson,
  type JsonValue,
} from '../contracts/index.js';
import type {
  AnalysisMetricRow,
  AnalysisNodeExecutionContext,
  AnalysisNodeExecutionResult,
  AnalysisNodeInput,
} from './types.js';
import type {
  AggregatedMeasurementTrial,
  AggregatedMeasurementUnit,
  MeasurementAggregation,
} from './builtin-aggregation.js';
import {
  aggregateMeasurementTrials,
  averageMeasurementTrials,
  singleOptionalCoordinate,
} from './builtin-aggregation.js';
import {
  metricInputs,
} from './builtin-primitives.js';
import {
  CompositeBootstrapParametersSchema,
} from './builtin-schemas.js';

export type CompositeBootstrapParameters = z.infer<typeof CompositeBootstrapParametersSchema>;


interface CompositeCoverage {
  unitKind: 'target-sample-trial';
  planned: number;
  complete: number;
  missing: number;
}


export type CompositeUnitBuild = {
  units: AggregatedMeasurementUnit[];
  plannedRows: AnalysisMetricRow[];
  coverage: CompositeCoverage;
  parameters: CompositeBootstrapParameters;
} | {
  result: AnalysisNodeExecutionResult;
};


function compositeFailure(
  reasonCode: string,
  coverage: CompositeCoverage,
  details?: JsonValue,
): AnalysisNodeExecutionResult {
  return {
    analysisStatus: 'inconclusive',
    reasonCodes: [reasonCode],
    includedRowIds: [],
    comparableRowIds: [],
    assumptionChecks: [{
      assumptionId: 'composite-source-domain',
      checkStatus: 'failed',
      reasonCode,
      ...(details === undefined ? {} : { details }),
    }, {
      assumptionId: 'composite-require-complete',
      checkStatus: 'not-evaluated',
      reasonCode,
      details: {
        unitKind: coverage.unitKind,
        planned: coverage.planned,
        complete: coverage.complete,
        missing: coverage.missing,
      },
    }],
  };
}


function compositeInputFailureReason(
  input: Extract<AnalysisNodeInput, { inputKind: 'metric-observations' }>,
): string | undefined {
  const metric = input.metric;
  if (metric.scope !== 'sample'
      || metric.missingPolicyId !== 'exclude/v1'
      || (metric.direction !== 'higher-is-better'
        && metric.direction !== 'lower-is-better')) {
    return 'analysis-composite-metric-contract-unsupported';
  }
  if (metric.valueType === 'numeric') {
    const min = metric.scale?.min;
    const max = metric.scale?.max;
    if (typeof min !== 'number' || !Number.isFinite(min)
        || typeof max !== 'number' || !Number.isFinite(max) || min >= max) {
      return 'analysis-composite-numeric-scale-invalid';
    }
    for (const row of input.rows) {
      if (row.rowStatus !== 'observed') continue;
      if (typeof row.value !== 'number' || !Number.isFinite(row.value)) {
        return 'analysis-composite-value-type-invalid';
      }
      if (row.value < min || row.value > max) {
        return 'analysis-composite-value-outside-scale';
      }
    }
    return undefined;
  }
  if (metric.valueType === 'boolean') {
    return input.rows.some((row) => row.rowStatus === 'observed' && typeof row.value !== 'boolean')
      ? 'analysis-composite-value-type-invalid'
      : undefined;
  }
  return 'analysis-composite-metric-contract-unsupported';
}


function compositeUtility(
  input: Extract<AnalysisNodeInput, { inputKind: 'metric-observations' }>,
  value: number,
): number {
  const metric = input.metric;
  let normalized: number;
  if (metric.valueType === 'boolean') {
    if (value < 0 || value > 1) {
      throw new TypeError('Aggregated boolean Metric value must remain in [0, 1].');
    }
    normalized = value;
  } else if (metric.valueType === 'numeric') {
    const min = metric.scale?.min;
    const max = metric.scale?.max;
    if (typeof min !== 'number' || typeof max !== 'number' || min >= max
        || value < min || value > max) {
      throw new TypeError('Aggregated numeric Metric value differs from its sealed scale.');
    }
    normalized = (value - min) / (max - min);
  } else {
    throw new TypeError('Composite utility supports only boolean and numeric Metrics.');
  }
  return metric.direction === 'lower-is-better' ? 1 - normalized : normalized;
}


function compositeCoverageAssumption(
  coverage: CompositeCoverage,
): NonNullable<AnalysisNodeExecutionResult['assumptionChecks']>[number] {
  return {
    assumptionId: 'composite-require-complete',
    checkStatus: 'passed',
    details: {
      unitKind: coverage.unitKind,
      planned: coverage.planned,
      complete: coverage.complete,
      missing: coverage.missing,
    },
  };
}


export function buildCompositeUnits(context: AnalysisNodeExecutionContext): CompositeUnitBuild {
  const sealed = CompositeBootstrapParametersSchema.parse(
    context.node.parameters ?? {},
  ) as CompositeBootstrapParameters;
  const inputs = metricInputs(context);
  if (inputs.length !== sealed.components.length) {
    throw new TypeError('Composite Analysis requires exactly its sealed component Metric inputs.');
  }
  const inputsByMetric = new Map(inputs.map((input) => [input.referenceId, input]));
  if (inputsByMetric.size !== inputs.length
      || sealed.components.some((component) => !inputsByMetric.has(component.metricId))) {
    throw new TypeError('Composite Analysis inputs differ from its sealed components.');
  }
  const plannedRows = inputs.flatMap((input) => input.rows);
  const plannedCoordinates = new Set<string>();
  for (const row of plannedRows) {
    plannedCoordinates.add(canonicalizeJson([
      row.targetId,
      row.sampleId,
      row.trialIndex,
    ]));
  }
  const completeTrialsByMetric = new Map<string, Map<string, AggregatedMeasurementTrial>>();
  for (const component of sealed.components) {
    const input = inputsByMetric.get(component.metricId)!;
    const reasonCode = compositeInputFailureReason(input);
    if (reasonCode !== undefined) {
      return {
        result: compositeFailure(reasonCode, {
          unitKind: 'target-sample-trial',
          planned: plannedCoordinates.size,
          complete: 0,
          missing: plannedCoordinates.size,
        }, { metricId: component.metricId }),
      };
    }
    const aggregation = component.measurementAggregation === undefined
      ? undefined
      : component.measurementAggregation as MeasurementAggregation;
    const trials = aggregateMeasurementTrials(input, aggregation);
    completeTrialsByMetric.set(component.metricId, new Map(trials.map((trial) => [
      canonicalizeJson([trial.targetId, trial.sampleId, trial.trialIndex]),
      trial,
    ])));
  }
  const completeCompositeTrials: AggregatedMeasurementTrial[] = [];
  for (const coordinate of [...plannedCoordinates].sort()) {
    const componentTrials = sealed.components.map((component) => (
      completeTrialsByMetric.get(component.metricId)?.get(coordinate)
    ));
    if (componentTrials.some((trial) => trial === undefined)) continue;
    const complete = componentTrials as AggregatedMeasurementTrial[];
    const targetId = complete[0].targetId;
    const sampleId = complete[0].sampleId;
    const trialIndex = complete[0].trialIndex;
    if (complete.some((trial) => trial.targetId !== targetId
      || trial.sampleId !== sampleId || trial.trialIndex !== trialIndex)) {
      throw new TypeError('Composite coordinate crosses target, sample, or trial identity.');
    }
    if (new Set(complete.map((trial) => trial.trialId)).size !== 1) {
      throw new TypeError('Composite coordinate crosses trial identity.');
    }
    const trialId = complete[0].trialId;
    const clusterId = singleOptionalCoordinate(complete, (trial) => trial.clusterId, 'clusters');
    const stratumId = singleOptionalCoordinate(complete, (trial) => trial.stratumId, 'strata');
    const pairingBlockId = singleOptionalCoordinate(
      complete,
      (trial) => trial.pairingBlockId,
      'pairing blocks',
    );
    const value = sealed.components.reduce((sum, component, index) => (
      sum + component.weight * compositeUtility(
        inputsByMetric.get(component.metricId)!,
        complete[index].value,
      )
    ), 0);
    if (value < 0 || value > 1) {
      throw new TypeError('Composite utility must remain within its sealed [0, 1] range.');
    }
    completeCompositeTrials.push({
      targetId,
      sampleId,
      trialIndex,
      trialId,
      value,
      rowIds: complete.flatMap((trial) => trial.rowIds),
      ...(clusterId === undefined ? {} : { clusterId }),
      ...(stratumId === undefined ? {} : { stratumId }),
      ...(pairingBlockId === undefined ? {} : { pairingBlockId }),
    });
  }
  const coverage: CompositeCoverage = {
    unitKind: 'target-sample-trial',
    planned: plannedCoordinates.size,
    complete: completeCompositeTrials.length,
    missing: plannedCoordinates.size - completeCompositeTrials.length,
  };
  return {
    units: averageMeasurementTrials(completeCompositeTrials),
    plannedRows,
    coverage,
    parameters: sealed,
  };
}


export function withCompositeEvidence(
  result: AnalysisNodeExecutionResult,
  units: readonly AggregatedMeasurementUnit[],
  coverage: CompositeCoverage,
): AnalysisNodeExecutionResult {
  const coverageCheck = compositeCoverageAssumption(coverage);
  const rowIds = units.flatMap((unit) => unit.rowIds);
  if (result.analysisStatus !== 'completed') {
    return {
      ...result,
      includedRowIds: result.includedRowIds ?? rowIds,
      comparableRowIds: result.comparableRowIds ?? result.includedRowIds ?? rowIds,
      assumptionChecks: [...(result.assumptionChecks ?? []), coverageCheck],
    };
  }
  return {
    ...result,
    includedRowIds: result.includedRowIds ?? rowIds,
    comparableRowIds: result.comparableRowIds ?? result.includedRowIds ?? rowIds,
    assumptionChecks: [...(result.assumptionChecks ?? []), coverageCheck],
  };
}

