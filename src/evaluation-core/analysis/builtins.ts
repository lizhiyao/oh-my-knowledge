import {
  digestCanonicalJson,
  type AnalysisOutputSchemaValidator,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
  type Sha256Digest,
} from '../contracts/index.js';
import type {
  AnalysisRuntimeRequirement,
  RuntimeResolution,
} from '../compiler/index.js';
import type {
  AnalysisDecisionPolicy,
  AnalysisMetricRow,
  AnalysisNodeExecutionContext,
  AnalysisNodeExecutionResult,
  AnalysisNodeImplementation,
  AnalysisNodeInput,
  AnalysisNodeRun,
  DecisionPolicyContext,
  DecisionPolicyOutput,
} from './types.js';

const SCALAR_SCHEMA: JsonValue = {
  type: 'number',
};

const INTERVAL_SCHEMA: JsonValue = {
  type: 'object',
  required: ['estimate', 'lower', 'upper', 'confidenceLevel', 'resamples', 'unitCount', 'method'],
  properties: {
    estimate: { type: 'number' },
    lower: { type: 'number' },
    upper: { type: 'number' },
    confidenceLevel: { type: 'number' },
    resamples: { type: 'integer' },
    unitCount: { type: 'integer' },
    method: { const: 'percentile' },
  },
  additionalProperties: false,
};

const HYPOTHESIS_INPUT_SCHEMA: JsonValue = {
  type: 'object',
  required: ['hypotheses'],
  properties: {
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        required: ['hypothesisId', 'pValue'],
        properties: {
          hypothesisId: { type: 'string', minLength: 1 },
          pValue: { type: 'number', minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const HYPOTHESIS_TABLE_SCHEMA: JsonValue = {
  type: 'object',
  required: ['familySize', 'alpha', 'hypotheses'],
  properties: {
    familySize: { type: 'integer', minimum: 1 },
    alpha: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
    hypotheses: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['hypothesisId', 'rawPValue', 'adjustedPValue', 'rejected'],
        properties: {
          hypothesisId: { type: 'string', minLength: 1 },
          rawPValue: { type: 'number', minimum: 0, maximum: 1 },
          adjustedPValue: { type: 'number', minimum: 0, maximum: 1 },
          rejected: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

function schemaIdentity(
  schemaVersion: string,
  schemaUri: string,
  schema: JsonValue,
): SchemaIdentity {
  return {
    schemaVersion,
    schemaUri,
    schemaDigest: digestCanonicalJson(schema),
  };
}

export const BUILTIN_SCALAR_RESULT_SCHEMA = schemaIdentity(
  'omk.analysis-result.scalar-number/v1',
  'urn:omk:analysis-result:scalar-number:v1',
  SCALAR_SCHEMA,
);

export const BUILTIN_INTERVAL_RESULT_SCHEMA = schemaIdentity(
  'omk.analysis-result.percentile-interval/v1',
  'urn:omk:analysis-result:percentile-interval:v1',
  INTERVAL_SCHEMA,
);

export const BUILTIN_HYPOTHESIS_TABLE_SCHEMA = schemaIdentity(
  'omk.analysis-result.hypothesis-table/v1',
  'urn:omk:analysis-result:hypothesis-table:v1',
  HYPOTHESIS_TABLE_SCHEMA,
);

export const BUILTIN_HYPOTHESIS_INPUT_SCHEMA = schemaIdentity(
  'omk.analysis-result.hypothesis-input/v1',
  'urn:omk:analysis-result:hypothesis-input:v1',
  HYPOTHESIS_INPUT_SCHEMA,
);

function runtimeIdentity(
  implementationId: string,
  capabilities: JsonValue,
): RuntimeIdentity {
  const version = '1.0.0';
  return {
    implementationId,
    version,
    fingerprint: digestCanonicalJson({
      implementationId,
      version,
      capabilities,
    }),
    // A builtin can declare its release identity, but it cannot independently
    // attest that the executing code matches that declaration.
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities,
  };
}

function nodeCapabilities(input: {
  analysisNodeKind: 'reducer' | 'estimator' | 'correction';
  valueTypes?: Array<'numeric' | 'boolean'>;
  missingPolicyIds?: string[];
  analysisResultSchemaUris?: string[];
  comparison?: boolean;
  outputSchema: SchemaIdentity;
  sampling?: {
    experimentalUnits: Array<'sample' | 'run' | 'cluster'>;
    repeatedMeasures: boolean[];
    resamplingUnits: Array<'sample' | 'paired-block' | 'cluster' | 'run'>;
  };
}): JsonValue {
  const inputDomains: JsonValue[] = [];
  if (input.valueTypes !== undefined) {
    inputDomains.push({
      inputKind: 'metric-observations',
      valueTypes: input.valueTypes,
      ...(input.missingPolicyIds !== undefined
        ? { missingPolicyIds: input.missingPolicyIds }
        : {}),
    });
  }
  if (input.analysisResultSchemaUris !== undefined) {
    inputDomains.push({
      inputKind: 'analysis-result',
      schemaUris: input.analysisResultSchemaUris,
    });
  }
  if (input.comparison === true) inputDomains.push({ inputKind: 'comparison' });
  return {
    capabilityKind: 'analysis-node',
    analysisNodeKinds: [input.analysisNodeKind],
    inputDomains,
    outputSchema: input.outputSchema,
    ...(input.valueTypes !== undefined ? {
      metricInputCardinality: { min: 1, max: 1 },
    } : {}),
    ...(input.sampling !== undefined ? { sampling: input.sampling } : {}),
    schemas: [],
  };
}

const EXCLUDE_CAPABILITIES: JsonValue = {
  capabilityKind: 'missing-policy',
  valueTypes: ['boolean', 'categorical', 'numeric', 'ranking', 'text'],
  schemas: [],
};

const DECISION_CAPABILITIES: JsonValue = {
  capabilityKind: 'decision-policy',
  analysisResultSchemaUris: [
    BUILTIN_HYPOTHESIS_TABLE_SCHEMA.schemaUri,
    BUILTIN_INTERVAL_RESULT_SCHEMA.schemaUri,
    BUILTIN_SCALAR_RESULT_SCHEMA.schemaUri,
  ].sort(),
  multipleComparisonPolicyIds: ['bonferroni/v1'],
  schemas: [],
};

interface BuiltinDefinition {
  identity: RuntimeIdentity;
  outputSchema: SchemaIdentity;
  execute(context: Readonly<AnalysisNodeExecutionContext>): AnalysisNodeExecutionResult;
  validateOutput(value: JsonValue): boolean;
}

function parameters(context: AnalysisNodeExecutionContext): Record<string, JsonValue> {
  const value = context.node.parameters;
  return value !== null && value !== undefined && !Array.isArray(value)
    && typeof value === 'object'
    ? value as Record<string, JsonValue>
    : {};
}

function metricInputs(context: AnalysisNodeExecutionContext): Array<Extract<
  AnalysisNodeInput,
  { inputKind: 'metric-observations' }
>> {
  return context.inputs.filter((input): input is Extract<
    AnalysisNodeInput,
    { inputKind: 'metric-observations' }
  > => input.inputKind === 'metric-observations');
}

function observedRows(context: AnalysisNodeExecutionContext): AnalysisMetricRow[] {
  const inputs = metricInputs(context);
  if (inputs.length !== 1) {
    throw new TypeError('Built-in Analysis implementations require exactly one Metric input.');
  }
  return inputs.flatMap((input) => input.rows.filter(
    (row) => row.rowStatus === 'observed',
  ));
}

function numericValue(row: AnalysisMetricRow): number {
  if (row.rowStatus !== 'observed') throw new TypeError('Expected observed row.');
  if (typeof row.value === 'number' && Number.isFinite(row.value)) return row.value;
  if (typeof row.value === 'boolean') return row.value ? 1 : 0;
  throw new TypeError('Expected numeric or boolean observation.');
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new TypeError('Mean requires at least one value.');
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function quantile(sortedValues: readonly number[], probability: number): number {
  if (sortedValues.length === 0) throw new TypeError('Quantile requires values.');
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new TypeError('Quantile probability must be in [0, 1].');
  }
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const weight = position - lowerIndex;
  return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
}

function parameterNumber(
  context: AnalysisNodeExecutionContext,
  name: string,
  fallback: number,
): number {
  const value = parameters(context)[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parameterInteger(
  context: AnalysisNodeExecutionContext,
  name: string,
  fallback: number,
): number {
  const value = parameterNumber(context, name, fallback);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer.`);
  return value;
}

function incomplete(reasonCode: string): AnalysisNodeExecutionResult {
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

function passedAssumption(assumptionId: string): AnalysisNodeExecutionResult['assumptionChecks'] {
  return [{ assumptionId, checkStatus: 'passed' }];
}

function executeMean(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
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

function executeRate(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
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

function executeQuantile(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
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

function deterministicIndex(
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

function bootstrapSeed(context: AnalysisNodeExecutionContext): Sha256Digest {
  const comparisonIds = context.inputs
    .filter((input): input is Extract<AnalysisNodeInput, { inputKind: 'comparison' }> => (
      input.inputKind === 'comparison'
    ))
    .map((input) => input.comparison.comparisonId)
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

interface BootstrapUnit {
  value: number;
  stratumId?: string;
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
  const estimates: number[] = [];
  for (let replicate = 0; replicate < resamples; replicate += 1) {
    const sample: number[] = [];
    let drawOffset = 0;
    for (const [stratumId, members] of [...strata.entries()].sort()) {
      const stratumSeed = digestCanonicalJson({
        derivation: 'omk.analysis-bootstrap-stratum-seed/v1',
        seed,
        stratumId,
      });
      for (let draw = 0; draw < members.length; draw += 1) {
        sample.push(members[
          deterministicIndex(stratumSeed, replicate, drawOffset + draw, members.length)
        ].value);
      }
      drawOffset += members.length;
    }
    estimates.push(mean(sample));
  }
  estimates.sort((left, right) => left - right);
  return {
    analysisStatus: 'completed',
    resultType: 'interval',
    value: {
      estimate: mean(units.map((unit) => unit.value)),
      lower: quantile(estimates, alpha / 2),
      upper: quantile(estimates, 1 - alpha / 2),
      confidenceLevel: 1 - alpha,
      resamples,
      unitCount: units.length,
      method: 'percentile',
    },
    assumptionChecks: passedAssumption('sufficient-resampling-units'),
  };
}

function groupRows(
  rows: readonly AnalysisMetricRow[],
  key: (row: AnalysisMetricRow) => string | undefined,
): Map<string, AnalysisMetricRow[]> {
  const groups = new Map<string, AnalysisMetricRow[]>();
  for (const row of rows) {
    const groupId = key(row);
    if (groupId === undefined) continue;
    const group = groups.get(groupId) ?? [];
    group.push(row);
    groups.set(groupId, group);
  }
  return groups;
}

function groupUnit(group: readonly AnalysisMetricRow[]): BootstrapUnit {
  const strata = new Set(group.map((row) => row.samplingUnitIds.stratumId));
  if (strata.size > 1) throw new TypeError('One resampling unit cannot cross strata.');
  const stratumId = group[0]?.samplingUnitIds.stratumId;
  return {
    value: mean(group.map(numericValue)),
    ...(stratumId !== undefined ? { stratumId } : {}),
  };
}

function executeMeanBootstrap(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
  const rows = observedRows(context);
  const unitKind = context.sampling.resamplingUnit;
  const groups = groupRows(rows, (row) => {
    if (unitKind === 'sample') return row.sampleId;
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

function executeClusterBootstrap(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
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

function executePairedBootstrap(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
  const comparisonInput = context.inputs.find((input) => input.inputKind === 'comparison');
  if (comparisonInput?.inputKind !== 'comparison') {
    throw new TypeError('Paired bootstrap requires a Comparison input.');
  }
  if (comparisonInput.comparison.treatmentTargetIds.length !== 1) {
    return incomplete('analysis-paired-bootstrap-requires-one-treatment');
  }
  const metricInput = metricInputs(context)[0];
  if (comparisonInput.comparison.metricIds.length !== 1
      || metricInput === undefined
      || comparisonInput.comparison.metricIds[0] !== metricInput.referenceId) {
    return incomplete('analysis-paired-bootstrap-requires-one-matching-metric');
  }
  const controlId = comparisonInput.comparison.controlTargetId;
  const treatmentId = comparisonInput.comparison.treatmentTargetIds[0];
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

interface Hypothesis {
  hypothesisId: string;
  pValue: number;
}

function hypotheses(context: AnalysisNodeExecutionContext): Hypothesis[] {
  const result: Hypothesis[] = [];
  for (const input of context.inputs) {
    if (input.inputKind !== 'analysis-result') continue;
    const value = input.record.value;
    if (value === null || Array.isArray(value) || typeof value !== 'object') continue;
    const entries = (value as Record<string, JsonValue>).hypotheses;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry === null || Array.isArray(entry) || typeof entry !== 'object') continue;
      const hypothesisId = (entry as Record<string, JsonValue>).hypothesisId;
      const pValue = (entry as Record<string, JsonValue>).pValue;
      if (typeof hypothesisId === 'string'
          && typeof pValue === 'number'
          && Number.isFinite(pValue)
          && pValue >= 0
          && pValue <= 1) {
        result.push({ hypothesisId, pValue });
      }
    }
  }
  return result;
}

function executeBonferroni(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
  const raw = hypotheses(context);
  if (raw.length === 0) return incomplete('analysis-no-valid-hypotheses');
  if (new Set(raw.map((entry) => entry.hypothesisId)).size !== raw.length) {
    return incomplete('analysis-duplicate-hypothesis-id');
  }
  const alpha = parameterNumber(context, 'alpha', 0.05);
  if (alpha <= 0 || alpha >= 1) throw new TypeError('alpha must be in (0, 1).');
  const familySize = raw.length;
  return {
    analysisStatus: 'completed',
    resultType: 'table',
    value: {
      familySize,
      alpha,
      hypotheses: raw.sort((left, right) => (
        left.hypothesisId < right.hypothesisId
          ? -1
          : left.hypothesisId > right.hypothesisId ? 1 : 0
      )).map((entry) => ({
        hypothesisId: entry.hypothesisId,
        rawPValue: entry.pValue,
        adjustedPValue: Math.min(1, entry.pValue * familySize),
        rejected: entry.pValue <= alpha / familySize,
      })),
    },
    assumptionChecks: passedAssumption('valid-hypothesis-family'),
  };
}

function isFiniteNumber(value: JsonValue): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInterval(value: JsonValue): boolean {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false;
  const object = value as Record<string, JsonValue>;
  return isFiniteNumber(object.estimate)
    && isFiniteNumber(object.lower)
    && isFiniteNumber(object.upper)
    && isFiniteNumber(object.confidenceLevel)
    && Number.isSafeInteger(object.resamples)
    && Number.isSafeInteger(object.unitCount)
    && object.method === 'percentile';
}

function isHypothesisTable(value: JsonValue): boolean {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false;
  const object = value as Record<string, JsonValue>;
  if (!Number.isSafeInteger(object.familySize)
    || typeof object.familySize !== 'number'
    || object.familySize < 1
    || !isFiniteNumber(object.alpha)
    || (object.alpha as number) <= 0
    || (object.alpha as number) >= 1
    || !Array.isArray(object.hypotheses)
    || object.hypotheses.length !== object.familySize) return false;
  const identifiers = new Set<string>();
  return object.hypotheses.every((entry) => {
    if (entry === null || Array.isArray(entry) || typeof entry !== 'object') return false;
    const item = entry as Record<string, JsonValue>;
    if (typeof item.hypothesisId !== 'string'
        || item.hypothesisId.length === 0
        || identifiers.has(item.hypothesisId)
        || !isFiniteNumber(item.rawPValue)
        || !isFiniteNumber(item.adjustedPValue)
        || (item.rawPValue as number) < 0
        || (item.rawPValue as number) > 1
        || (item.adjustedPValue as number) < 0
        || (item.adjustedPValue as number) > 1
        || typeof item.rejected !== 'boolean') return false;
    identifiers.add(item.hypothesisId);
    return true;
  });
}

const BUILTIN_DEFINITIONS = new Map<string, BuiltinDefinition>();

function register(
  implementationId: string,
  capabilities: JsonValue,
  outputSchema: SchemaIdentity,
  execute: BuiltinDefinition['execute'],
  validateOutput: BuiltinDefinition['validateOutput'],
): void {
  BUILTIN_DEFINITIONS.set(implementationId, {
    identity: runtimeIdentity(implementationId, capabilities),
    outputSchema,
    execute,
    validateOutput,
  });
}

register(
  'descriptive.mean/v1',
  nodeCapabilities({
    analysisNodeKind: 'reducer',
    valueTypes: ['numeric'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_SCALAR_RESULT_SCHEMA,
  }),
  BUILTIN_SCALAR_RESULT_SCHEMA,
  executeMean,
  isFiniteNumber,
);
register(
  'descriptive.rate/v1',
  nodeCapabilities({
    analysisNodeKind: 'reducer',
    valueTypes: ['boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_SCALAR_RESULT_SCHEMA,
  }),
  BUILTIN_SCALAR_RESULT_SCHEMA,
  executeRate,
  isFiniteNumber,
);
register(
  'descriptive.quantile/v1',
  nodeCapabilities({
    analysisNodeKind: 'reducer',
    valueTypes: ['numeric'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_SCALAR_RESULT_SCHEMA,
  }),
  BUILTIN_SCALAR_RESULT_SCHEMA,
  executeQuantile,
  isFiniteNumber,
);
register(
  'bootstrap.mean-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    sampling: {
      experimentalUnits: ['sample', 'run'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['sample', 'run'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  executeMeanBootstrap,
  isInterval,
);
register(
  'bootstrap.paired-difference-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    comparison: true,
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    sampling: {
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['paired-block'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  executePairedBootstrap,
  isInterval,
);
register(
  'bootstrap.cluster-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    sampling: {
      experimentalUnits: ['cluster'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['cluster'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  executeClusterBootstrap,
  isInterval,
);
register(
  'bonferroni/v1',
  nodeCapabilities({
    analysisNodeKind: 'correction',
    analysisResultSchemaUris: [BUILTIN_HYPOTHESIS_INPUT_SCHEMA.schemaUri],
    outputSchema: BUILTIN_HYPOTHESIS_TABLE_SCHEMA,
  }),
  BUILTIN_HYPOTHESIS_TABLE_SCHEMA,
  executeBonferroni,
  isHypothesisTable,
);

class BuiltinNodeImplementation implements AnalysisNodeImplementation {
  readonly identity: RuntimeIdentity;
  readonly outputSchema: SchemaIdentity;
  readonly #definition: BuiltinDefinition;

  constructor(definition: BuiltinDefinition) {
    this.#definition = definition;
    this.identity = definition.identity;
    this.outputSchema = definition.outputSchema;
  }

  async openRun(): Promise<AnalysisNodeRun> {
    return {
      execute: async (context) => this.#definition.execute(context),
      dispose: () => undefined,
    };
  }
}

class BuiltinOutputValidator implements AnalysisOutputSchemaValidator {
  readonly schema: SchemaIdentity;
  readonly #validate: (value: JsonValue) => boolean;

  constructor(definition: BuiltinDefinition) {
    this.schema = definition.outputSchema;
    this.#validate = definition.validateOutput;
  }

  validate(value: JsonValue): boolean {
    return this.#validate(value);
  }
}

export const BUILTIN_EXCLUDE_MISSING_POLICY = {
  identity: runtimeIdentity('exclude/v1', EXCLUDE_CAPABILITIES),
  decide: () => 'exclude' as const,
};

function scalarEffect(context: DecisionPolicyContext): number | undefined {
  for (const result of context.results) {
    if (typeof result.value === 'number' && Number.isFinite(result.value)) return result.value;
    if (result.value !== null && !Array.isArray(result.value)
        && typeof result.value === 'object') {
      const value = (result.value as Record<string, JsonValue>).estimate;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
  }
  return undefined;
}

export const BUILTIN_PROGRESS_DECISION_POLICY: AnalysisDecisionPolicy = {
  identity: runtimeIdentity('progress/v1', DECISION_CAPABILITIES),
  decide: async (context): Promise<DecisionPolicyOutput> => {
    const effect = scalarEffect(context);
    if (effect === undefined) {
      return { decisionStatus: 'not-decided', reasonCodes: ['decision-effect-unavailable'] };
    }
    const policyParameters = context.policy.parameters;
    const object = policyParameters !== null && policyParameters !== undefined
      && !Array.isArray(policyParameters) && typeof policyParameters === 'object'
      ? policyParameters as Record<string, JsonValue>
      : {};
    const threshold = typeof object.threshold === 'number' ? object.threshold : 0;
    const equivalence = typeof object.equivalence === 'number' ? object.equivalence : 0;
    if (effect > threshold + equivalence) {
      return { decisionStatus: 'decided', verdict: 'PROGRESS' };
    }
    if (effect < threshold - equivalence) {
      return { decisionStatus: 'decided', verdict: 'REGRESSION' };
    }
    return { decisionStatus: 'decided', verdict: 'NOISE' };
  },
};

export function createBuiltinAnalysisNodes(): ReadonlyMap<string, AnalysisNodeImplementation> {
  return new Map([...BUILTIN_DEFINITIONS.entries()].map(([implementationId, definition]) => [
    implementationId,
    new BuiltinNodeImplementation(definition),
  ]));
}

export function createBuiltinAnalysisOutputValidators(): ReadonlyMap<
  string,
  AnalysisOutputSchemaValidator
> {
  const validators = new Map<string, AnalysisOutputSchemaValidator>();
  for (const definition of BUILTIN_DEFINITIONS.values()) {
    const key = definition.outputSchema.schemaDigest;
    if (!validators.has(key)) validators.set(key, new BuiltinOutputValidator(definition));
  }
  return validators;
}

export function createBuiltinMissingPolicies() {
  return new Map([['exclude/v1', BUILTIN_EXCLUDE_MISSING_POLICY]]);
}

export function createBuiltinDecisionPolicies() {
  return new Map([['progress/v1', BUILTIN_PROGRESS_DECISION_POLICY]]);
}

export function resolveBuiltinAnalysisRuntime(
  requirement: Readonly<AnalysisRuntimeRequirement>,
): RuntimeResolution | undefined {
  if (requirement.requirementKind === 'missing-policy') {
    if (requirement.implementationId !== 'exclude/v1') return undefined;
    return {
      identity: BUILTIN_EXCLUDE_MISSING_POLICY.identity,
      satisfiesVersionConstraint: true,
    };
  }
  if (requirement.requirementKind === 'decision-policy') {
    if (requirement.implementationId !== 'progress/v1') return undefined;
    return {
      identity: BUILTIN_PROGRESS_DECISION_POLICY.identity,
      satisfiesVersionConstraint: true,
    };
  }
  const definition = BUILTIN_DEFINITIONS.get(requirement.implementationId);
  if (definition === undefined) return undefined;
  return { identity: definition.identity, satisfiesVersionConstraint: true };
}
