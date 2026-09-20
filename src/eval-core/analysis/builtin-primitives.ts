/**
 * 内建分析的行与度量原语：取参数、取度量输入、数值化、均值／分位数、缺证判定与确定性下标。
 */
import { arithmeticMean, linearQuantile } from './bootstrap-kernel.js';
import {
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
  type Sha256Digest,
} from '../contracts/index.js';
import type {
  AnalysisMetricRow,
  AnalysisNodeExecutionContext,
  AnalysisNodeExecutionResult,
  AnalysisNodeInput,
} from './types.js';

export interface BuiltinDefinition {
  identity: RuntimeIdentity;
  outputSchema: SchemaIdentity;
  parameterSchema: SchemaIdentity;
  execute(context: Readonly<AnalysisNodeExecutionContext>): AnalysisNodeExecutionResult;
}


export function parameters(context: AnalysisNodeExecutionContext): Record<string, JsonValue> {
  const value = context.node.parameters;
  return value !== null && value !== undefined && !Array.isArray(value)
    && typeof value === 'object'
    ? value as Record<string, JsonValue>
    : {};
}


export function metricInputs(context: AnalysisNodeExecutionContext): Array<Extract<
  AnalysisNodeInput,
  { inputKind: 'metric-observations' }
>> {
  return context.inputs.filter((input): input is Extract<
    AnalysisNodeInput,
    { inputKind: 'metric-observations' }
  > => input.inputKind === 'metric-observations');
}


export function observedRows(context: AnalysisNodeExecutionContext): AnalysisMetricRow[] {
  const inputs = metricInputs(context);
  if (inputs.length !== 1) {
    throw new TypeError('Built-in Analysis implementations require exactly one Metric input.');
  }
  return inputs.flatMap((input) => input.rows.filter(
    (row) => row.rowStatus === 'observed',
  ));
}


export function numericValue(row: AnalysisMetricRow): number {
  if (row.rowStatus !== 'observed') throw new TypeError('Expected observed row.');
  if (typeof row.value === 'number' && Number.isFinite(row.value)) return row.value;
  if (typeof row.value === 'boolean') return row.value ? 1 : 0;
  throw new TypeError('Expected numeric or boolean observation.');
}


export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new TypeError('Mean requires at least one value.');
  return arithmeticMean(values);
}


export function quantile(sortedValues: readonly number[], probability: number): number {
  if (sortedValues.length === 0) throw new TypeError('Quantile requires values.');
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new TypeError('Quantile probability must be in [0, 1].');
  }
  return linearQuantile(sortedValues, probability);
}


export function parameterNumber(
  context: AnalysisNodeExecutionContext,
  name: string,
  fallback: number,
): number {
  const value = parameters(context)[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}


export function parameterInteger(
  context: AnalysisNodeExecutionContext,
  name: string,
  fallback: number,
): number {
  const value = parameterNumber(context, name, fallback);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer.`);
  return value;
}


export function incomplete(reasonCode: string): AnalysisNodeExecutionResult {
  return {
    analysisStatus: 'inconclusive',
    reasonCodes: [reasonCode],
    assumptionChecks: [{
      assumptionId: 'sufficient-units',
      checkStatus: 'failed',
      reasonCode,
    }],
  };
}


export function passedAssumption(assumptionId: string): AnalysisNodeExecutionResult['assumptionChecks'] {
  return [{ assumptionId, checkStatus: 'passed' }];
}


export function executeMean(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
  const rows = observedRows(context);
  if (rows.length === 0) return incomplete('analysis-no-observed-values');
  return {
    analysisStatus: 'completed',
    resultType: 'scalar',
    value: mean(rows.map(numericValue)),
    includedRowIds: rows.map((row) => row.rowId),
    comparableRowIds: rows.map((row) => row.rowId),
    assumptionChecks: passedAssumption('non-empty-observations'),
  };
}


export function executeRate(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
  const rows = observedRows(context);
  if (rows.length === 0) return incomplete('analysis-no-observed-values');
  if (rows.some((row) => row.rowStatus !== 'observed' || typeof row.value !== 'boolean')) {
    throw new TypeError('Rate reducer requires boolean observations.');
  }
  return {
    analysisStatus: 'completed',
    resultType: 'scalar',
    value: mean(rows.map(numericValue)),
    includedRowIds: rows.map((row) => row.rowId),
    comparableRowIds: rows.map((row) => row.rowId),
    assumptionChecks: passedAssumption('non-empty-observations'),
  };
}


export function executeQuantile(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
  const rows = observedRows(context);
  if (rows.length === 0) return incomplete('analysis-no-observed-values');
  const probability = parameterNumber(context, 'probability', 0.5);
  const values = rows.map(numericValue).sort((left, right) => left - right);
  return {
    analysisStatus: 'completed',
    resultType: 'scalar',
    value: quantile(values, probability),
    includedRowIds: rows.map((row) => row.rowId),
    comparableRowIds: rows.map((row) => row.rowId),
    assumptionChecks: passedAssumption('non-empty-observations'),
  };
}


export function deterministicIndex(
  seed: Sha256Digest,
  replicateIndex: number,
  drawIndex: number,
  size: number,
): number {
  const digest = digestCanonicalJson({
    derivation: 'omk.analysis-bootstrap-draw/v1',
    seed,
    replicateIndex,
    drawIndex,
  });
  return Number.parseInt(digest.slice(7, 19), 16) % size;
}


export // Core bootstrap.* /v1 seals plan/node-specific SHA draws. The product
// omk.bootstrap-family-table profile intentionally retains its Mulberry32 stream;
// replacing this derivation with that stream changes the versioned estimator.
// Cross-profile vectors: test/eval-core/conformance/statistics.test.ts.
function bootstrapSeed(context: AnalysisNodeExecutionContext): Sha256Digest {
  const comparisonIds = context.inputs
    .filter((input): input is Extract<AnalysisNodeInput, { inputKind: 'comparison' }> => (
      input.inputKind === 'comparison'
    ))
    .map((input) => input.contrast.comparisonId)
    .sort();
  return digestCanonicalJson({
    derivation: 'omk.analysis-bootstrap-seed/v1',
    rootSeed: context.rootSeed,
    analysisPlanDigest: context.analysisPlanDigest,
    nodeId: context.node.nodeId,
    implementationId: context.node.implementationId,
    comparisonIds,
  });
}


export interface BootstrapUnit {
  value: number;
  clusterId?: string;
  stratumId?: string;
}


export function groupRows<T>(
  rows: readonly T[],
  key: (row: T) => string | undefined,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const groupId = key(row);
    if (groupId === undefined) continue;
    const group = groups.get(groupId) ?? [];
    group.push(row);
    groups.set(groupId, group);
  }
  return groups;
}


export function groupUnit(group: readonly AnalysisMetricRow[]): BootstrapUnit {
  const strata = new Set(group.map((row) => row.samplingUnitIds.stratumId));
  if (strata.size > 1) throw new TypeError('One resampling unit cannot cross strata.');
  const stratumId = group[0]?.samplingUnitIds.stratumId;
  return {
    value: mean(group.map(numericValue)),
    ...(stratumId !== undefined ? { stratumId } : {}),
  };
}

