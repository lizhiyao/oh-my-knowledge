/**
 * 内建分析的 Bootstrap 执行器：百分位区间、分组，以及 mean／cluster／paired 在平面、分层与复合三档下的实现。
 */
import { bootstrapDistribution, percentileBounds, type BootstrapGroup } from './bootstrap-kernel.js';
import {
  canonicalizeJson,
  digestCanonicalJson,
  type Sha256Digest,
} from '../contracts/index.js';
import type {
  AnalysisMetricRow,
  AnalysisNodeExecutionContext,
  AnalysisNodeExecutionResult,
  AnalysisNodeInput,
} from './types.js';
import type {
  AggregatedMeasurementUnit,
} from './builtin-aggregation.js';
import type {
  CompositeUnitBuild,
} from './builtin-composite.js';
import type {
  BootstrapUnit,
} from './builtin-primitives.js';
import {
  aggregateMeasurementUnits,
  metricInput,
  singleOptionalCoordinate,
} from './builtin-aggregation.js';
import {
  buildCompositeUnits,
  withCompositeEvidence,
} from './builtin-composite.js';
import {
  bootstrapSeed,
  deterministicIndex,
  groupRows,
  groupUnit,
  incomplete,
  mean,
  metricInputs,
  numericValue,
  observedRows,
  parameterInteger,
  parameterNumber,
  passedAssumption,
  quantile,
} from './builtin-primitives.js';

function hierarchicalScalarResult(
  context: AnalysisNodeExecutionContext,
  statistic: (values: readonly number[]) => number,
): AnalysisNodeExecutionResult {
  const units = aggregateMeasurementUnits(context);
  if (units.length === 0) return incomplete('analysis-no-observed-values');
  return {
    analysisStatus: 'completed',
    resultType: 'scalar',
    value: statistic(units.map((unit) => unit.value)),
    includedRowIds: units.flatMap((unit) => unit.rowIds),
    comparableRowIds: units.flatMap((unit) => unit.rowIds),
    assumptionChecks: passedAssumption('complete-measurement-units'),
  };
}


export function executeHierarchicalMean(context: AnalysisNodeExecutionContext) {
  return hierarchicalScalarResult(context, mean);
}


export function executeHierarchicalRate(context: AnalysisNodeExecutionContext) {
  return hierarchicalScalarResult(context, mean);
}


export function executeHierarchicalQuantile(context: AnalysisNodeExecutionContext) {
  const probability = parameterNumber(context, 'probability', 0.5);
  return hierarchicalScalarResult(
    context,
    (values) => quantile([...values].sort((left, right) => left - right), probability),
  );
}


function percentileInterval(
  context: AnalysisNodeExecutionContext,
  units: readonly BootstrapUnit[],
): AnalysisNodeExecutionResult {
  const resamples = parameterInteger(context, 'resamples', 1_000);
  const alpha = parameterNumber(context, 'alpha', 0.05);
  if (resamples < 1 || alpha <= 0 || alpha >= 1) {
    throw new TypeError('Bootstrap requires positive resamples and alpha in (0, 1).');
  }
  if (units.length < 2) return incomplete('analysis-insufficient-resampling-units');
  const seed = bootstrapSeed(context);
  const strata = new Map<string, BootstrapUnit[]>();
  for (const unit of units) {
    const stratumId = unit.stratumId ?? 'omk:unstratified';
    const members = strata.get(stratumId) ?? [];
    members.push(unit);
    strata.set(stratumId, members);
  }
  let drawOffset = 0;
  const groups: BootstrapGroup[] = [...strata.entries()].sort().map(([stratumId, members]) => {
    const stratumSeed = digestCanonicalJson({
      derivation: 'omk.analysis-bootstrap-stratum-seed/v1',
      seed,
      stratumId,
    });
    const offset = drawOffset;
    drawOffset += members.length;
    return {
      values: members.map((member) => member.value),
      indexFor: (replicate, draw) => deterministicIndex(
        stratumSeed, replicate, offset + draw, members.length,
      ),
    };
  });
  const estimates = bootstrapDistribution(groups, resamples, (samples) => mean(samples.flat()));
  const bounds = percentileBounds(estimates, alpha);
  return {
    analysisStatus: 'completed',
    resultType: 'interval',
    value: {
      estimate: mean(units.map((unit) => unit.value)),
      lower: bounds.lower,
      upper: bounds.upper,
      confidenceLevel: 1 - alpha,
      resamples,
      unitCount: units.length,
      method: 'percentile',
    },
    assumptionChecks: passedAssumption('sufficient-resampling-units'),
  };
}


export function executeMeanBootstrap(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
  const rows = observedRows(context);
  const unitKind = context.sampling.resamplingUnit;
  const groups = groupRows(rows, (row) => {
    if (unitKind === 'sample') return row.sampleId;
    if (unitKind === 'paired-block') return row.samplingUnitIds.pairingBlockId;
    if (unitKind === 'run') return 'run';
    return undefined;
  });
  const interval = percentileInterval(
    context,
    [...groups.values()].map(groupUnit),
  );
  return interval.analysisStatus === 'completed' ? {
    ...interval,
    includedRowIds: [...groups.values()].flat().map((row) => row.rowId),
    comparableRowIds: [...groups.values()].flat().map((row) => row.rowId),
  } : interval;
}


export function executeClusterBootstrap(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
  const rows = observedRows(context);
  const groups = groupRows(rows, (row) => row.samplingUnitIds.clusterId);
  const interval = percentileInterval(
    context,
    [...groups.values()].map(groupUnit),
  );
  return interval.analysisStatus === 'completed' ? {
    ...interval,
    includedRowIds: [...groups.values()].flat().map((row) => row.rowId),
    comparableRowIds: [...groups.values()].flat().map((row) => row.rowId),
  } : interval;
}


export function executePairedBootstrap(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
  const comparisonInputs = context.inputs.filter(
    (input): input is Extract<AnalysisNodeInput, { inputKind: 'comparison' }> => (
      input.inputKind === 'comparison'
    ),
  );
  if (comparisonInputs.length !== 1) {
    throw new TypeError('Paired bootstrap requires exactly one Comparison contrast.');
  }
  const comparisonInput = comparisonInputs[0];
  const metricInput = metricInputs(context)[0];
  if (metricInput === undefined || comparisonInput.contrast.metricId !== metricInput.referenceId) {
    return incomplete('analysis-paired-bootstrap-requires-one-matching-metric');
  }
  const controlId = comparisonInput.contrast.controlTargetId;
  const treatmentId = comparisonInput.contrast.treatmentTargetId;
  const rows = observedRows(context);
  const groups = groupRows(rows, (row) => row.samplingUnitIds.pairingBlockId);
  const differences: BootstrapUnit[] = [];
  const includedRows: AnalysisMetricRow[] = [];
  for (const group of groups.values()) {
    const control = group.filter((row) => row.targetId === controlId);
    const treatment = group.filter((row) => row.targetId === treatmentId);
    if (control.length === 0 || treatment.length === 0) continue;
    const strata = new Set(group.map((row) => row.samplingUnitIds.stratumId));
    if (strata.size > 1) throw new TypeError('One pairing unit cannot cross strata.');
    const stratumId = group[0]?.samplingUnitIds.stratumId;
    differences.push({
      value: mean(treatment.map(numericValue)) - mean(control.map(numericValue)),
      ...(stratumId !== undefined ? { stratumId } : {}),
    });
    includedRows.push(...control, ...treatment);
  }
  const interval = percentileInterval(context, differences);
  return interval.analysisStatus === 'completed' ? {
    ...interval,
    includedRowIds: includedRows.map((row) => row.rowId),
    comparableRowIds: includedRows.map((row) => row.rowId),
  } : interval;
}


export function executeHierarchicalMeanBootstrap(
  context: AnalysisNodeExecutionContext,
): AnalysisNodeExecutionResult {
  const units = aggregateMeasurementUnits(context);
  let bootstrapUnits: readonly BootstrapUnit[] = units;
  if (context.sampling.resamplingUnit === 'paired-block') {
    if (units.some((unit) => unit.pairingBlockId === undefined)) {
      return incomplete('analysis-pairing-membership-missing');
    }
    bootstrapUnits = [...groupRows(units, (unit) => unit.pairingBlockId).values()].map(
      (members) => {
        const stratumId = singleOptionalCoordinate(members, (member) => member.stratumId, 'strata');
        return {
          value: mean(members.map((member) => member.value)),
          ...(stratumId === undefined ? {} : { stratumId }),
        };
      },
    );
  }
  const interval = percentileInterval(context, bootstrapUnits);
  return interval.analysisStatus === 'completed' ? {
    ...interval,
    includedRowIds: units.flatMap((unit) => unit.rowIds),
    comparableRowIds: units.flatMap((unit) => unit.rowIds),
  } : interval;
}


export function executeHierarchicalClusterBootstrap(
  context: AnalysisNodeExecutionContext,
): AnalysisNodeExecutionResult {
  const units = aggregateMeasurementUnits(context);
  const groups = new Map<string, AggregatedMeasurementUnit[]>();
  for (const unit of units) {
    if (unit.clusterId === undefined) return incomplete('analysis-cluster-membership-missing');
    groups.set(unit.clusterId, [...(groups.get(unit.clusterId) ?? []), unit]);
  }
  const clusterUnits = [...groups.values()].map((members) => {
    const stratumId = singleOptionalCoordinate(members, (member) => member.stratumId, 'strata');
    return {
      value: mean(members.map((member) => member.value)),
      ...(stratumId === undefined ? {} : { stratumId }),
    };
  });
  const interval = percentileInterval(context, clusterUnits);
  return interval.analysisStatus === 'completed' ? {
    ...interval,
    includedRowIds: units.flatMap((unit) => unit.rowIds),
    comparableRowIds: units.flatMap((unit) => unit.rowIds),
  } : interval;
}


export function executeHierarchicalPairedBootstrap(
  context: AnalysisNodeExecutionContext,
): AnalysisNodeExecutionResult {
  const comparisonInputs = context.inputs.filter(
    (input): input is Extract<AnalysisNodeInput, { inputKind: 'comparison' }> => (
      input.inputKind === 'comparison'
    ),
  );
  if (comparisonInputs.length !== 1) {
    throw new TypeError('Hierarchical paired bootstrap requires exactly one Comparison contrast.');
  }
  const comparisonInput = comparisonInputs[0];
  const input = metricInput(context);
  if (comparisonInput.contrast.metricId !== input.referenceId) {
    return incomplete('analysis-paired-bootstrap-requires-one-matching-metric');
  }
  const controlId = comparisonInput.contrast.controlTargetId;
  const treatmentId = comparisonInput.contrast.treatmentTargetId;
  const units = aggregateMeasurementUnits(context);
  const groups = groupRows(units, (unit) => unit.pairingBlockId);
  const differences: BootstrapUnit[] = [];
  const includedUnits: AggregatedMeasurementUnit[] = [];
  for (const group of groups.values()) {
    const control = group.filter((unit) => unit.targetId === controlId);
    const treatment = group.filter((unit) => unit.targetId === treatmentId);
    if (control.length === 0 || treatment.length === 0) continue;
    const stratumId = singleOptionalCoordinate(group, (unit) => unit.stratumId, 'strata');
    differences.push({
      value: mean(treatment.map((unit) => unit.value))
        - mean(control.map((unit) => unit.value)),
      ...(stratumId === undefined ? {} : { stratumId }),
    });
    includedUnits.push(...control, ...treatment);
  }
  const interval = percentileInterval(context, differences);
  return interval.analysisStatus === 'completed' ? {
    ...interval,
    includedRowIds: includedUnits.flatMap((unit) => unit.rowIds),
    comparableRowIds: includedUnits.flatMap((unit) => unit.rowIds),
  } : interval;
}


function compositeBuildOrResult(context: AnalysisNodeExecutionContext): Exclude<
  CompositeUnitBuild,
  { result: AnalysisNodeExecutionResult }
> | AnalysisNodeExecutionResult {
  const built = buildCompositeUnits(context);
  return 'result' in built ? built.result : built;
}


export function executeCompositeMeanBootstrap(
  context: AnalysisNodeExecutionContext,
): AnalysisNodeExecutionResult {
  const built = compositeBuildOrResult(context);
  if ('analysisStatus' in built) return built;
  let bootstrapUnits: readonly BootstrapUnit[] = built.units;
  if (context.sampling.resamplingUnit === 'paired-block') {
    if (built.units.some((unit) => unit.pairingBlockId === undefined)) {
      return withCompositeEvidence(
        incomplete('analysis-pairing-membership-missing'),
        built.units,
        built.coverage,
      );
    }
    bootstrapUnits = [...groupRows(built.units, (unit) => unit.pairingBlockId).values()].map(
      (members) => {
        const stratumId = singleOptionalCoordinate(members, (member) => member.stratumId, 'strata');
        return {
          value: mean(members.map((member) => member.value)),
          ...(stratumId === undefined ? {} : { stratumId }),
        };
      },
    );
  } else if (context.sampling.resamplingUnit !== 'sample') {
    return withCompositeEvidence(
      incomplete('analysis-composite-resampling-unit-unsupported'),
      built.units,
      built.coverage,
    );
  }
  return withCompositeEvidence(
    percentileInterval(context, bootstrapUnits),
    built.units,
    built.coverage,
  );
}


export function executeCompositeClusterBootstrap(
  context: AnalysisNodeExecutionContext,
): AnalysisNodeExecutionResult {
  const built = compositeBuildOrResult(context);
  if ('analysisStatus' in built) return built;
  const groups = new Map<string, AggregatedMeasurementUnit[]>();
  for (const unit of built.units) {
    if (unit.clusterId === undefined) {
      return withCompositeEvidence(
        incomplete('analysis-cluster-membership-missing'),
        built.units,
        built.coverage,
      );
    }
    groups.set(unit.clusterId, [...(groups.get(unit.clusterId) ?? []), unit]);
  }
  const clusterUnits = [...groups.values()].map((members) => {
    const stratumId = singleOptionalCoordinate(members, (member) => member.stratumId, 'strata');
    return {
      value: mean(members.map((member) => member.value)),
      ...(stratumId === undefined ? {} : { stratumId }),
    };
  });
  return withCompositeEvidence(
    percentileInterval(context, clusterUnits),
    built.units,
    built.coverage,
  );
}


export function executeCompositePairedBootstrap(
  context: AnalysisNodeExecutionContext,
): AnalysisNodeExecutionResult {
  const built = compositeBuildOrResult(context);
  if ('analysisStatus' in built) return built;
  const comparisonInputs = context.inputs.filter(
    (input): input is Extract<AnalysisNodeInput, { inputKind: 'comparison' }> => (
      input.inputKind === 'comparison'
    ),
  );
  if (comparisonInputs.length !== 1) {
    throw new TypeError('Composite paired bootstrap requires exactly one Comparison contrast.');
  }
  const comparison = comparisonInputs[0].contrast;
  if (comparison.metricId !== built.parameters.compositeMetricId) {
    return withCompositeEvidence(
      incomplete('analysis-composite-comparison-metric-mismatch'),
      built.units,
      built.coverage,
    );
  }
  if (built.units.some((unit) => unit.pairingBlockId === undefined)) {
    return withCompositeEvidence(
      incomplete('analysis-pairing-membership-missing'),
      built.units,
      built.coverage,
    );
  }
  const differences: BootstrapUnit[] = [];
  const includedUnits: AggregatedMeasurementUnit[] = [];
  for (const group of groupRows(built.units, (unit) => unit.pairingBlockId).values()) {
    const control = group.filter((unit) => unit.targetId === comparison.controlTargetId);
    const treatment = group.filter((unit) => unit.targetId === comparison.treatmentTargetId);
    if (control.length === 0 || treatment.length === 0) continue;
    const stratumId = singleOptionalCoordinate(group, (unit) => unit.stratumId, 'strata');
    differences.push({
      value: mean(treatment.map((unit) => unit.value))
        - mean(control.map((unit) => unit.value)),
      ...(stratumId === undefined ? {} : { stratumId }),
    });
    includedUnits.push(...control, ...treatment);
  }
  const interval = percentileInterval(context, differences);
  return withCompositeEvidence(
    interval.analysisStatus === 'completed' ? {
      ...interval,
      includedRowIds: includedUnits.flatMap((unit) => unit.rowIds),
      comparableRowIds: includedUnits.flatMap((unit) => unit.rowIds),
    } : interval,
    includedUnits,
    built.coverage,
  );
}


function bootstrapArmStratumGroup(
  seed: Sha256Digest,
  armId: string,
  stratumId: string,
  members: readonly BootstrapUnit[],
): BootstrapGroup {
  const stratumSeed = digestCanonicalJson({
    derivation: 'omk.analysis-unpaired-bootstrap-arm-stratum-seed/v1',
    seed,
    armId,
    stratumId,
  });
  return {
    values: members.map((member) => member.value),
    indexFor: (replicate, draw) => deterministicIndex(stratumSeed, replicate, draw, members.length),
  };
}


function executeUnpairedBootstrapWithUnits(
  context: AnalysisNodeExecutionContext,
  units: readonly AggregatedMeasurementUnit[],
  plannedRows: readonly AnalysisMetricRow[],
  expectedMetricId?: string,
): AnalysisNodeExecutionResult {
  const comparisonInputs = context.inputs.filter(
    (input): input is Extract<AnalysisNodeInput, { inputKind: 'comparison' }> => (
      input.inputKind === 'comparison'
    ),
  );
  if (comparisonInputs.length !== 1) {
    throw new TypeError('Unpaired bootstrap requires exactly one Comparison contrast.');
  }
  const comparisonInput = comparisonInputs[0];
  const metricId = expectedMetricId ?? metricInputs(context)[0]?.referenceId;
  if (metricId === undefined || comparisonInput.contrast.metricId !== metricId) {
    return incomplete('analysis-unpaired-bootstrap-requires-one-matching-metric');
  }
  const controlId = comparisonInput.contrast.controlTargetId;
  const treatmentId = comparisonInput.contrast.treatmentTargetId;
  const controlUnits = units.filter((unit) => unit.targetId === controlId);
  const treatmentUnits = units.filter((unit) => unit.targetId === treatmentId);
  const controlSampleIds = new Set(controlUnits.map((unit) => unit.sampleId));
  if (treatmentUnits.some((unit) => controlSampleIds.has(unit.sampleId))) {
    return incomplete('analysis-unpaired-bootstrap-overlapping-units');
  }
  if (controlUnits.length < 2 || treatmentUnits.length < 2) {
    return incomplete('analysis-insufficient-resampling-units-per-arm');
  }
  const controlStrata = new Set(controlUnits.map((unit) => unit.stratumId ?? 'omk:unstratified'));
  const treatmentStrata = new Set(
    treatmentUnits.map((unit) => unit.stratumId ?? 'omk:unstratified'),
  );
  if (controlStrata.size !== treatmentStrata.size
      || [...controlStrata].some((stratumId) => !treatmentStrata.has(stratumId))) {
    return incomplete('analysis-unpaired-bootstrap-strata-not-shared');
  }
  const controlByStratum = new Map<string, BootstrapUnit[]>();
  const treatmentByStratum = new Map<string, BootstrapUnit[]>();
  for (const unit of controlUnits) {
    const stratumId = unit.stratumId ?? 'omk:unstratified';
    controlByStratum.set(stratumId, [...(controlByStratum.get(stratumId) ?? []), unit]);
  }
  for (const unit of treatmentUnits) {
    const stratumId = unit.stratumId ?? 'omk:unstratified';
    treatmentByStratum.set(stratumId, [...(treatmentByStratum.get(stratumId) ?? []), unit]);
  }
  const plannedStratumBySample = new Map<string, string>();
  for (const row of plannedRows) {
    const stratumId = row.samplingUnitIds.stratumId ?? 'omk:unstratified';
    const existing = plannedStratumBySample.get(row.sampleId);
    if (existing !== undefined && existing !== stratumId) {
      throw new TypeError('One experimental unit cannot cross planned strata.');
    }
    plannedStratumBySample.set(row.sampleId, stratumId);
  }
  const plannedCountByStratum = new Map<string, number>();
  for (const stratumId of plannedStratumBySample.values()) {
    plannedCountByStratum.set(stratumId, (plannedCountByStratum.get(stratumId) ?? 0) + 1);
  }
  const plannedUnitCount = plannedStratumBySample.size;
  const strata = [...controlStrata].sort().map((stratumId) => ({
    stratumId,
    control: controlByStratum.get(stratumId) ?? [],
    treatment: treatmentByStratum.get(stratumId) ?? [],
    plannedCount: plannedCountByStratum.get(stratumId) ?? 0,
  }));
  if (plannedUnitCount === 0
      || strata.some((stratum) => stratum.plannedCount === 0)
      || [...plannedCountByStratum.keys()].some((stratumId) => !controlStrata.has(stratumId))) {
    return incomplete('analysis-unpaired-bootstrap-planned-strata-not-observed');
  }
  const weightedDifference = (
    estimate: (armId: string, stratumId: string, units: readonly BootstrapUnit[]) => number,
  ): number => strata.reduce((sum, stratum) => {
    const weight = stratum.plannedCount / plannedUnitCount;
    return sum + weight * (
      estimate(treatmentId, stratum.stratumId, stratum.treatment)
        - estimate(controlId, stratum.stratumId, stratum.control)
    );
  }, 0);
  const resamples = parameterInteger(context, 'resamples', 1_000);
  const alpha = parameterNumber(context, 'alpha', 0.05);
  if (resamples < 1 || alpha <= 0 || alpha >= 1) {
    throw new TypeError('Bootstrap requires positive resamples and alpha in (0, 1).');
  }
  const seed = bootstrapSeed(context);
  // Keep the historical treatment-then-control order within each sorted stratum.
  const groups = strata.flatMap((stratum) => [
    bootstrapArmStratumGroup(seed, treatmentId, stratum.stratumId, stratum.treatment),
    bootstrapArmStratumGroup(seed, controlId, stratum.stratumId, stratum.control),
  ]);
  const estimates = bootstrapDistribution(groups, resamples, (samples) => (
    strata.reduce((sum, stratum, index) => sum + (stratum.plannedCount / plannedUnitCount)
      * (mean(samples[index * 2]) - mean(samples[index * 2 + 1])), 0)
  ));
  const bounds = percentileBounds(estimates, alpha);
  const includedRowIds = [...controlUnits, ...treatmentUnits].flatMap((unit) => unit.rowIds);
  return {
    analysisStatus: 'completed',
    resultType: 'interval',
    value: {
      estimate: weightedDifference((_armId, _stratumId, units) => (
        mean(units.map((unit) => unit.value))
      )),
      lower: bounds.lower,
      upper: bounds.upper,
      confidenceLevel: 1 - alpha,
      resamples,
      unitCount: controlUnits.length + treatmentUnits.length,
      method: 'percentile',
    },
    includedRowIds,
    comparableRowIds: includedRowIds,
    assumptionChecks: passedAssumption('independent-non-overlapping-samples'),
  };
}


export function executeCompositeUnpairedBootstrap(
  context: AnalysisNodeExecutionContext,
): AnalysisNodeExecutionResult {
  const built = compositeBuildOrResult(context);
  if ('analysisStatus' in built) return built;
  return withCompositeEvidence(
    executeUnpairedBootstrapWithUnits(
      context,
      built.units,
      built.plannedRows,
      built.parameters.compositeMetricId,
    ),
    built.units,
    built.coverage,
  );
}


export function executeUnpairedBootstrap(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
  const input = metricInput(context);
  const rows = observedRows(context);
  const units = [...groupRows(rows, (row) => canonicalizeJson([
    row.targetId,
    row.sampleId,
  ])).values()].map((group): AggregatedMeasurementUnit => {
    const unit = groupUnit(group);
    return {
      targetId: group[0].targetId,
      sampleId: group[0].sampleId,
      value: unit.value,
      rowIds: group.map((row) => row.rowId),
      ...(unit.stratumId === undefined ? {} : { stratumId: unit.stratumId }),
    };
  });
  return executeUnpairedBootstrapWithUnits(context, units, input.rows);
}


export function executeHierarchicalUnpairedBootstrap(
  context: AnalysisNodeExecutionContext,
): AnalysisNodeExecutionResult {
  const input = metricInput(context);
  return executeUnpairedBootstrapWithUnits(
    context,
    aggregateMeasurementUnits(context),
    input.rows,
  );
}

