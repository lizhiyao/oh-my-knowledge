import { z } from 'zod';
import {
  canonicalizeJson,
  digestCanonicalJson,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type CoreSchemaValidationContext,
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

const FiniteNumberSchema = z.number().finite();
const ProbabilitySchema = FiniteNumberSchema.min(0).max(1);
const StrictEmptyParametersSchema = z.object({}).strict();
const QuantileParametersSchema = z.object({
  probability: ProbabilitySchema.default(0.5),
}).strict();
const BootstrapParametersSchema = z.object({
  resamples: z.number().int().positive().safe().default(1_000),
  alpha: FiniteNumberSchema.gt(0).lt(1).default(0.05),
}).strict();
const MeasurementReplicateSchema = z.object({
  evaluatorId: z.string().min(1).max(256),
  instrumentId: z.string().min(1).max(256),
  replicateIndex: z.number().int().nonnegative().safe(),
}).strict();
const MeasurementMemberBaseSchema = z.object({
  ensembleMemberId: z.string().min(1).max(256),
  replicates: z.array(MeasurementReplicateSchema).min(1),
}).strict();
const MeasurementAggregationSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('mean'),
    missing: z.literal('require-complete'),
    replicateGroupId: z.string().min(1).max(256),
    members: z.array(MeasurementMemberBaseSchema).min(1),
  }).strict(),
  z.object({
    method: z.literal('weighted-mean'),
    missing: z.literal('require-complete'),
    replicateGroupId: z.string().min(1).max(256),
    members: z.array(MeasurementMemberBaseSchema.extend({
      weight: FiniteNumberSchema.positive(),
    }).strict()).min(1),
  }).strict(),
]).superRefine((aggregation, context) => {
  const memberIds = aggregation.members.map((member) => member.ensembleMemberId);
  if (new Set(memberIds).size !== memberIds.length) {
    context.addIssue({ code: 'custom', path: ['members'], message: 'Member IDs must be unique' });
  }
  if (canonicalizeJson(memberIds) !== canonicalizeJson([...memberIds].sort())) {
    context.addIssue({
      code: 'custom',
      path: ['members'],
      message: 'Members must be ordered by ensembleMemberId',
    });
  }
  const evaluatorIds: string[] = [];
  const instrumentIds = new Set<string>();
  for (const [memberIndex, member] of aggregation.members.entries()) {
    const indexes = member.replicates.map((replicate) => replicate.replicateIndex);
    if (new Set(indexes).size !== indexes.length
        || indexes.some((value, index) => value !== index)) {
      context.addIssue({
        code: 'custom',
        path: ['members', memberIndex, 'replicates'],
        message: 'Replicate indexes must be unique and contiguous from zero',
      });
    }
    for (const replicate of member.replicates) {
      evaluatorIds.push(replicate.evaluatorId);
      instrumentIds.add(replicate.instrumentId);
    }
  }
  if (new Set(evaluatorIds).size !== evaluatorIds.length) {
    context.addIssue({ code: 'custom', path: ['members'], message: 'Evaluator IDs must be unique' });
  }
  if (instrumentIds.size !== 1) {
    context.addIssue({ code: 'custom', path: ['members'], message: 'One panel must use one instrument' });
  }
  if (aggregation.method === 'weighted-mean') {
    const total = aggregation.members.reduce((sum, member) => sum + member.weight, 0);
    if (Math.abs(total - 1) > 1e-12) {
      context.addIssue({ code: 'custom', path: ['members'], message: 'Member weights must sum to one' });
    }
  }
});
const HierarchicalBootstrapParametersSchema = z.object({
  resamples: z.number().int().positive().safe().default(1_000),
  alpha: FiniteNumberSchema.gt(0).lt(1).default(0.05),
  measurementAggregation: MeasurementAggregationSchema,
}).strict();
const BonferroniParametersSchema = z.object({
  alpha: FiniteNumberSchema.gt(0).lt(1).default(0.05),
}).strict();
const ProgressParametersSchema = z.object({
  threshold: FiniteNumberSchema.default(0),
  equivalence: FiniteNumberSchema.nonnegative().default(0),
}).strict();

const ScalarEnvelopeSchema = z.object({
  resultType: z.literal('scalar'),
  value: FiniteNumberSchema,
}).strict();
const IntervalEnvelopeSchema = z.object({
  resultType: z.literal('interval'),
  value: z.object({
    estimate: FiniteNumberSchema,
    lower: FiniteNumberSchema,
    upper: FiniteNumberSchema,
    confidenceLevel: FiniteNumberSchema.gt(0).lt(1),
    resamples: z.number().int().positive().safe(),
    unitCount: z.number().int().positive().safe(),
    method: z.literal('percentile'),
  }).strict(),
}).strict().superRefine((envelope, context) => {
  if (envelope.value.lower > envelope.value.upper) {
    context.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'Interval bounds must satisfy lower <= upper',
    });
  }
});
const HypothesisInputEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: z.object({
    hypotheses: z.array(z.object({
      hypothesisId: z.string().min(1),
      pValue: ProbabilitySchema,
    }).strict()).min(1),
  }).strict(),
}).strict();
const HypothesisTableEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: z.object({
    familySize: z.number().int().positive().safe(),
    alpha: FiniteNumberSchema.gt(0).lt(1),
    hypotheses: z.array(z.object({
      hypothesisId: z.string().min(1),
      rawPValue: ProbabilitySchema,
      adjustedPValue: ProbabilitySchema,
      rejected: z.boolean(),
    }).strict()).min(1),
  }).strict(),
}).strict().superRefine((envelope, context) => {
  const { familySize, alpha, hypotheses } = envelope.value;
  if (familySize !== hypotheses.length) {
    context.addIssue({ code: 'custom', path: ['value', 'familySize'], message: 'familySize mismatch' });
  }
  const ids = hypotheses.map((entry) => entry.hypothesisId);
  if (new Set(ids).size !== ids.length || canonicalizeJson(ids) !== canonicalizeJson([...ids].sort())) {
    context.addIssue({ code: 'custom', path: ['value', 'hypotheses'], message: 'IDs must be unique and canonical' });
  }
  for (const [index, entry] of hypotheses.entries()) {
    if (entry.adjustedPValue !== Math.min(1, entry.rawPValue * familySize)
        || entry.rejected !== (entry.rawPValue <= alpha / familySize)) {
      context.addIssue({ code: 'custom', path: ['value', 'hypotheses', index], message: 'Bonferroni invariant mismatch' });
    }
  }
});

function jsonSchema(schema: z.ZodType, invariants?: readonly string[]): JsonValue {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    cycles: 'ref',
    reused: 'ref',
  }) as unknown as Record<string, JsonValue>;
  const plain = { ...generated };
  return invariants === undefined ? plain : { ...plain, 'x-omk-invariants': [...invariants] };
}

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
  jsonSchema(ScalarEnvelopeSchema),
);

export const BUILTIN_INTERVAL_RESULT_SCHEMA = schemaIdentity(
  'omk.analysis-result.percentile-interval/v1',
  'urn:omk:analysis-result:percentile-interval:v1',
  jsonSchema(IntervalEnvelopeSchema, [
    'lower<=upper',
    'resamples equals the sealed node parameter resamples',
    'confidenceLevel equals 1 minus the sealed node parameter alpha',
    'unitCount equals the Core-derived count of included resampling units',
  ]),
);

export const BUILTIN_HYPOTHESIS_TABLE_SCHEMA = schemaIdentity(
  'omk.analysis-result.hypothesis-table/v1',
  'urn:omk:analysis-result:hypothesis-table:v1',
  jsonSchema(HypothesisTableEnvelopeSchema, [
    'familySize equals hypotheses.length',
    'hypothesisId values are unique and lexicographically sorted',
    'adjustedPValue=min(1,rawPValue*familySize)',
    'rejected=(rawPValue<=alpha/familySize)',
    'alpha equals the sealed node parameter alpha',
  ]),
);

export const BUILTIN_HYPOTHESIS_INPUT_SCHEMA = schemaIdentity(
  'omk.analysis-result.hypothesis-input/v1',
  'urn:omk:analysis-result:hypothesis-input:v1',
  jsonSchema(HypothesisInputEnvelopeSchema),
);

const EMPTY_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.empty/v1', 'urn:omk:parameters:empty:v1', jsonSchema(StrictEmptyParametersSchema),
);
const QUANTILE_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.quantile/v1', 'urn:omk:parameters:quantile:v1', jsonSchema(QuantileParametersSchema),
);
const BOOTSTRAP_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.bootstrap/v1', 'urn:omk:parameters:bootstrap:v1', jsonSchema(BootstrapParametersSchema),
);
const HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.hierarchical-measurement-bootstrap/v1',
  'urn:omk:parameters:hierarchical-measurement-bootstrap:v1',
  jsonSchema(HierarchicalBootstrapParametersSchema, [
    'replicate indexes are unique and contiguous from zero within each member',
    'evaluator IDs and member IDs are unique, with members and replicates canonically ordered',
    'all panel coordinates use one instrument and one replicate group',
    'weighted-mean member weights are positive and sum to one',
    'a target/sample/trial contributes only when every sealed coordinate is observed',
  ]),
);
const BONFERRONI_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.bonferroni/v1', 'urn:omk:parameters:bonferroni:v1', jsonSchema(BonferroniParametersSchema),
);
const PROGRESS_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.progress/v1', 'urn:omk:parameters:progress:v1', jsonSchema(ProgressParametersSchema),
);

function runtimeIdentity(
  implementationId: string,
  capabilities: JsonValue,
  fingerprintFacets?: JsonValue,
): RuntimeIdentity {
  const version = '1.0.0';
  return {
    implementationId,
    version,
    fingerprint: digestCanonicalJson({
      implementationId,
      version,
      capabilities,
      ...(fingerprintFacets === undefined ? {} : { fingerprintFacets }),
    }),
    // A builtin can declare its release identity, but it cannot independently
    // attest that the executing code matches that declaration.
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  };
}

function nodeCapabilities(input: {
  analysisNodeKind: 'reducer' | 'estimator' | 'correction';
  valueTypes?: Array<'numeric' | 'boolean'>;
  missingPolicyIds?: string[];
  analysisResultSchemaUris?: string[];
  comparison?: boolean;
  outputSchema: SchemaIdentity;
  parameterSchema: SchemaIdentity;
  sampling?: {
    assignmentKinds: Array<'complete-block' | 'independent-groups'>;
    experimentalUnits: Array<'sample' | 'run' | 'cluster'>;
    repeatedMeasures: boolean[];
    resamplingUnits: Array<'sample' | 'paired-block' | 'cluster' | 'run'>;
  };
}): JsonValue {
  const inputDomains: JsonValue[] = [];
  if (input.valueTypes !== undefined) {
    inputDomains.push({
      inputKind: 'metric-observations',
      valueTypes: [...input.valueTypes].sort(),
      ...(input.missingPolicyIds !== undefined
        ? { missingPolicyIds: [...input.missingPolicyIds].sort() }
        : {}),
    });
  }
  if (input.analysisResultSchemaUris !== undefined) {
    inputDomains.push({
      inputKind: 'analysis-result',
      schemaUris: [...input.analysisResultSchemaUris].sort(),
    });
  }
  if (input.comparison === true) inputDomains.push({ inputKind: 'comparison' });
  inputDomains.sort((left, right) => {
    const leftCanonical = canonicalizeJson(left);
    const rightCanonical = canonicalizeJson(right);
    return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
  });
  return {
    capabilityKind: 'analysis-node',
    analysisNodeKinds: [input.analysisNodeKind],
    inputDomains,
    outputSchema: input.outputSchema,
    parameterSchema: input.parameterSchema,
    inputCardinalities: {
      metricObservations: input.valueTypes !== undefined ? { min: 1, max: 1 } : { min: 0, max: 0 },
      analysisResults: input.analysisResultSchemaUris !== undefined ? { min: 1 } : { min: 0, max: 0 },
      comparisons: input.comparison === true ? { min: 1, max: 1 } : { min: 0, max: 0 },
    },
    ...(input.sampling !== undefined ? {
      sampling: {
        assignmentKinds: [...input.sampling.assignmentKinds].sort(),
        experimentalUnits: [...input.sampling.experimentalUnits].sort(),
        repeatedMeasures: [...input.sampling.repeatedMeasures].sort(
          (left, right) => Number(left) - Number(right),
        ),
        resamplingUnits: [...input.sampling.resamplingUnits].sort(),
      },
    } : {}),
    schemas: [],
  };
}

const EXCLUDE_CAPABILITIES: JsonValue = {
  capabilityKind: 'missing-policy',
  valueTypes: ['boolean', 'categorical', 'numeric', 'ranking', 'text'],
  schemas: [],
};

const PROGRESS_V1_DECISION_CAPABILITIES: JsonValue = {
  capabilityKind: 'decision-policy',
  analysisResultSchemaUris: [
    BUILTIN_INTERVAL_RESULT_SCHEMA.schemaUri,
    BUILTIN_SCALAR_RESULT_SCHEMA.schemaUri,
  ].sort(),
  multipleComparisonPolicyIds: [],
  parameterSchema: PROGRESS_PARAMETERS_SCHEMA,
  schemas: [],
};

const PROGRESS_V2_DECISION_CAPABILITIES: JsonValue = {
  capabilityKind: 'decision-policy',
  analysisResultSchemaUris: [BUILTIN_INTERVAL_RESULT_SCHEMA.schemaUri],
  multipleComparisonPolicyIds: [],
  parameterSchema: PROGRESS_PARAMETERS_SCHEMA,
  schemas: [],
};

const PROGRESS_V1_DECISION_FINGERPRINT_FACETS: JsonValue = {
  decisionOutputContract: 'decided-verdict-with-reason-codes/v1',
  reasonRules: {
    progress: 'effect-above-progress-threshold',
    regression: 'effect-below-regression-threshold',
    noise: 'effect-within-equivalence-band',
    notDecided: 'decision-effect-unavailable',
  },
};

const PROGRESS_V2_DECISION_FINGERPRINT_FACETS: JsonValue = {
  decisionOutputContract: 'interval-bounded-verdict-with-reason-codes/v2',
  directionRule: 'confidence-interval-must-exclude-threshold-plus-equivalence-band',
  reasonRules: {
    progress: 'interval-above-progress-boundary',
    regression: 'interval-below-regression-boundary',
    noise: 'interval-overlaps-decision-boundary',
    notDecided: 'decision-interval-unavailable',
  },
};

interface BuiltinDefinition {
  identity: RuntimeIdentity;
  outputSchema: SchemaIdentity;
  parameterSchema: SchemaIdentity;
  execute(context: Readonly<AnalysisNodeExecutionContext>): AnalysisNodeExecutionResult;
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

interface BootstrapUnit {
  value: number;
  stratumId?: string;
}

type MeasurementAggregation = z.infer<typeof MeasurementAggregationSchema>;

interface AggregatedMeasurementUnit extends BootstrapUnit {
  targetId: string;
  sampleId: string;
  pairingBlockId?: string;
  rowIds: Sha256Digest[];
}

function metricInput(context: AnalysisNodeExecutionContext): Extract<
  AnalysisNodeInput,
  { inputKind: 'metric-observations' }
> {
  const inputs = metricInputs(context);
  if (inputs.length !== 1) {
    throw new TypeError('Built-in Analysis implementations require exactly one Metric input.');
  }
  return inputs[0];
}

function singleOptionalCoordinate<T>(
  rows: readonly T[],
  select: (row: T) => string | undefined,
  label: string,
): string | undefined {
  const values = new Set(rows.map(select));
  if (values.size > 1) throw new TypeError(`One measurement unit cannot cross ${label}.`);
  return select(rows[0]);
}

function aggregateMeasurementUnits(
  context: AnalysisNodeExecutionContext,
): AggregatedMeasurementUnit[] {
  const input = metricInput(context);
  const aggregation = MeasurementAggregationSchema.parse(
    parameters(context).measurementAggregation,
  ) as MeasurementAggregation;
  const expected = new Map<string, Readonly<{
    ensembleMemberId: string;
    instrumentId: string;
    replicateIndex: number;
  }>>();
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
  const trials = groupRows(input.rows, (row) => canonicalizeJson([
    row.targetId,
    row.sampleId,
    row.trialIndex,
  ]));
  const completeTrials: Array<AggregatedMeasurementUnit & { trialIndex: number }> = [];
  for (const rows of trials.values()) {
    const byEvaluator = new Map<string, AnalysisMetricRow>();
    for (const row of rows) {
      if (byEvaluator.has(row.evaluatorId)) {
        throw new TypeError('Measurement trial contains a duplicate evaluator coordinate.');
      }
      byEvaluator.set(row.evaluatorId, row);
    }
    if (byEvaluator.size !== expected.size
        || [...expected.keys()].some((evaluatorId) => !byEvaluator.has(evaluatorId))) {
      throw new TypeError('Measurement trial is missing a sealed evaluator coordinate.');
    }
    if (rows.some((row) => row.rowStatus !== 'observed')) continue;
    const memberValues = aggregation.members.map((member) => {
      const values = member.replicates.map((replicate) => numericValue(
        byEvaluator.get(replicate.evaluatorId)!,
      ));
      return {
        value: mean(values),
        weight: 'weight' in member ? member.weight : 1,
      };
    });
    const value = aggregation.method === 'weighted-mean'
      ? memberValues.reduce((sum, member) => sum + member.value * member.weight, 0)
      : mean(memberValues.map((member) => member.value));
    completeTrials.push({
      targetId: rows[0].targetId,
      sampleId: rows[0].sampleId,
      trialIndex: rows[0].trialIndex,
      value,
      rowIds: rows.map((row) => row.rowId),
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
      ...(stratumId === undefined ? {} : { stratumId }),
      ...(pairingBlockId === undefined ? {} : { pairingBlockId }),
    };
  });
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

function groupRows<T>(
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

function executeHierarchicalMeanBootstrap(
  context: AnalysisNodeExecutionContext,
): AnalysisNodeExecutionResult {
  const units = aggregateMeasurementUnits(context);
  const interval = percentileInterval(context, units);
  return interval.analysisStatus === 'completed' ? {
    ...interval,
    includedRowIds: units.flatMap((unit) => unit.rowIds),
    comparableRowIds: units.flatMap((unit) => unit.rowIds),
  } : interval;
}

function executeHierarchicalPairedBootstrap(
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

function bootstrapArmStratumMean(
  seed: Sha256Digest,
  armId: string,
  stratumId: string,
  replicate: number,
  members: readonly BootstrapUnit[],
): number {
  const stratumSeed = digestCanonicalJson({
    derivation: 'omk.analysis-unpaired-bootstrap-arm-stratum-seed/v1',
    seed,
    armId,
    stratumId,
  });
  return mean(Array.from({ length: members.length }, (_, draw) => (
    members[deterministicIndex(stratumSeed, replicate, draw, members.length)].value
  )));
}

function executeUnpairedBootstrapWithUnits(
  context: AnalysisNodeExecutionContext,
  units: readonly AggregatedMeasurementUnit[],
  plannedRows: readonly AnalysisMetricRow[],
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
  const metricInput = metricInputs(context)[0];
  if (metricInput === undefined || comparisonInput.contrast.metricId !== metricInput.referenceId) {
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
  const estimates = Array.from({ length: resamples }, (_, replicate) => weightedDifference(
    (armId, stratumId, units) => bootstrapArmStratumMean(
      seed,
      armId,
      stratumId,
      replicate,
      units,
    ),
  )).sort((left, right) => left - right);
  const includedRowIds = [...controlUnits, ...treatmentUnits].flatMap((unit) => unit.rowIds);
  return {
    analysisStatus: 'completed',
    resultType: 'interval',
    value: {
      estimate: weightedDifference((_armId, _stratumId, units) => (
        mean(units.map((unit) => unit.value))
      )),
      lower: quantile(estimates, alpha / 2),
      upper: quantile(estimates, 1 - alpha / 2),
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

function executeUnpairedBootstrap(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
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

function executeHierarchicalUnpairedBootstrap(
  context: AnalysisNodeExecutionContext,
): AnalysisNodeExecutionResult {
  const input = metricInput(context);
  return executeUnpairedBootstrapWithUnits(
    context,
    aggregateMeasurementUnits(context),
    input.rows,
  );
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

const BUILTIN_DEFINITIONS = new Map<string, BuiltinDefinition>();

function register(
  implementationId: string,
  capabilities: JsonValue,
  outputSchema: SchemaIdentity,
  parameterSchema: SchemaIdentity,
  execute: BuiltinDefinition['execute'],
): void {
  BUILTIN_DEFINITIONS.set(implementationId, {
    identity: runtimeIdentity(implementationId, capabilities),
    outputSchema,
    parameterSchema,
    execute,
  });
}

register(
  'descriptive.mean/v1',
  nodeCapabilities({
    analysisNodeKind: 'reducer',
    valueTypes: ['numeric'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_SCALAR_RESULT_SCHEMA,
    parameterSchema: EMPTY_PARAMETERS_SCHEMA,
  }),
  BUILTIN_SCALAR_RESULT_SCHEMA,
  EMPTY_PARAMETERS_SCHEMA,
  executeMean,
);
register(
  'descriptive.rate/v1',
  nodeCapabilities({
    analysisNodeKind: 'reducer',
    valueTypes: ['boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_SCALAR_RESULT_SCHEMA,
    parameterSchema: EMPTY_PARAMETERS_SCHEMA,
  }),
  BUILTIN_SCALAR_RESULT_SCHEMA,
  EMPTY_PARAMETERS_SCHEMA,
  executeRate,
);
register(
  'descriptive.quantile/v1',
  nodeCapabilities({
    analysisNodeKind: 'reducer',
    valueTypes: ['numeric'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_SCALAR_RESULT_SCHEMA,
    parameterSchema: QUANTILE_PARAMETERS_SCHEMA,
  }),
  BUILTIN_SCALAR_RESULT_SCHEMA,
  QUANTILE_PARAMETERS_SCHEMA,
  executeQuantile,
);
register(
  'bootstrap.mean-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block'],
      experimentalUnits: ['sample', 'run'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['sample', 'run'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BOOTSTRAP_PARAMETERS_SCHEMA,
  executeMeanBootstrap,
);
register(
  'bootstrap.paired-difference-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    comparison: true,
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['paired-block'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BOOTSTRAP_PARAMETERS_SCHEMA,
  executePairedBootstrap,
);
register(
  'bootstrap.unpaired-difference-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    comparison: true,
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['independent-groups'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['sample'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BOOTSTRAP_PARAMETERS_SCHEMA,
  executeUnpairedBootstrap,
);
register(
  'bootstrap.hierarchical-mean-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['sample'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
  executeHierarchicalMeanBootstrap,
);
register(
  'bootstrap.hierarchical-paired-difference-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    comparison: true,
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['paired-block'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
  executeHierarchicalPairedBootstrap,
);
register(
  'bootstrap.hierarchical-unpaired-difference-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    comparison: true,
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['independent-groups'],
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['sample'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
  executeHierarchicalUnpairedBootstrap,
);
register(
  'bootstrap.cluster-percentile/v1',
  nodeCapabilities({
    analysisNodeKind: 'estimator',
    valueTypes: ['numeric', 'boolean'],
    missingPolicyIds: ['exclude/v1'],
    outputSchema: BUILTIN_INTERVAL_RESULT_SCHEMA,
    parameterSchema: BOOTSTRAP_PARAMETERS_SCHEMA,
    sampling: {
      assignmentKinds: ['complete-block'],
      experimentalUnits: ['cluster'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['cluster'],
    },
  }),
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BOOTSTRAP_PARAMETERS_SCHEMA,
  executeClusterBootstrap,
);
register(
  'bonferroni/v1',
  nodeCapabilities({
    analysisNodeKind: 'correction',
    analysisResultSchemaUris: [BUILTIN_HYPOTHESIS_INPUT_SCHEMA.schemaUri],
    outputSchema: BUILTIN_HYPOTHESIS_TABLE_SCHEMA,
    parameterSchema: BONFERRONI_PARAMETERS_SCHEMA,
  }),
  BUILTIN_HYPOTHESIS_TABLE_SCHEMA,
  BONFERRONI_PARAMETERS_SCHEMA,
  executeBonferroni,
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

class BuiltinSchemaValidator implements CoreSchemaValidator {
  readonly schema: SchemaIdentity;
  readonly #zod: z.ZodType;
  readonly #validateContext?: (
    value: JsonValue,
    context?: Readonly<CoreSchemaValidationContext>,
  ) => void;

  constructor(
    schema: SchemaIdentity,
    zodSchema: z.ZodType,
    validateContext?: (
      value: JsonValue,
      context?: Readonly<CoreSchemaValidationContext>,
    ) => void,
  ) {
    this.schema = schema;
    this.#zod = zodSchema;
    this.#validateContext = validateContext;
  }

  parse(value: unknown, context?: Readonly<CoreSchemaValidationContext>): JsonValue {
    const parsed = this.#zod.parse(value) as JsonValue;
    this.#validateContext?.(parsed, context);
    return parsed;
  }
}

function requireAnalysisOutputContext(
  context: Readonly<CoreSchemaValidationContext> | undefined,
): Readonly<CoreSchemaValidationContext> {
  if (context?.validationKind !== 'analysis-output') {
    throw new TypeError('Analysis output validation requires sealed node parameters.');
  }
  return context;
}

function validateIntervalContext(
  value: JsonValue,
  context?: Readonly<CoreSchemaValidationContext>,
): void {
  const rawParameters = requireAnalysisOutputContext(context).parameters;
  const sealed = rawParameters !== null && typeof rawParameters === 'object'
    && !Array.isArray(rawParameters) && 'measurementAggregation' in rawParameters
    ? HierarchicalBootstrapParametersSchema.parse(rawParameters)
    : BootstrapParametersSchema.parse(rawParameters);
  const envelope = IntervalEnvelopeSchema.parse(value);
  if (envelope.value.resamples !== sealed.resamples
      || envelope.value.confidenceLevel !== 1 - sealed.alpha
      || envelope.value.unitCount !== context?.inputFacts.resamplingUnitCount) {
    throw new TypeError('Interval metadata does not match the sealed Analysis facts.');
  }
}

function validateBonferroniContext(
  value: JsonValue,
  context?: Readonly<CoreSchemaValidationContext>,
): void {
  const sealed = BonferroniParametersSchema.parse(requireAnalysisOutputContext(context).parameters);
  const envelope = HypothesisTableEnvelopeSchema.parse(value);
  if (envelope.value.alpha !== sealed.alpha) {
    throw new TypeError('Bonferroni alpha does not match the sealed node parameters.');
  }
}

export const BUILTIN_EXCLUDE_MISSING_POLICY = {
  identity: runtimeIdentity('exclude/v1', EXCLUDE_CAPABILITIES),
  decide: () => 'exclude' as const,
};

function selectedDecisionResult(
  context: DecisionPolicyContext,
): DecisionPolicyContext['results'][number] | undefined {
  const resultId = context.contrasts.length === 1
    ? context.contrasts[0].analysisResultId
    : context.contrasts.length === 0 && context.results.length === 1
      ? context.results[0].resultId
      : undefined;
  return resultId === undefined
    ? undefined
    : context.results.find((candidate) => candidate.resultId === resultId);
}

function scalarEffect(context: DecisionPolicyContext): number | undefined {
  const result = selectedDecisionResult(context);
  if (result === undefined) return undefined;
  if (typeof result.value === 'number' && Number.isFinite(result.value)) return result.value;
  if (result.value !== null && !Array.isArray(result.value)
      && typeof result.value === 'object') {
    const value = (result.value as Record<string, JsonValue>).estimate;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function intervalEffect(
  context: DecisionPolicyContext,
): Readonly<{ estimate: number; lower: number; upper: number }> | undefined {
  const result = selectedDecisionResult(context);
  if (result === undefined) return undefined;
  const parsed = IntervalEnvelopeSchema.safeParse({
    resultType: result.resultType,
    value: result.value,
  });
  return parsed.success ? parsed.data.value : undefined;
}

function progressParameters(context: DecisionPolicyContext): {
  threshold: number;
  equivalence: number;
} {
  const policyParameters = context.policy.parameters;
  const object = policyParameters !== null && policyParameters !== undefined
    && !Array.isArray(policyParameters) && typeof policyParameters === 'object'
    ? policyParameters as Record<string, JsonValue>
    : {};
  return {
    threshold: typeof object.threshold === 'number' ? object.threshold : 0,
    equivalence: typeof object.equivalence === 'number' ? object.equivalence : 0,
  };
}

export const BUILTIN_PROGRESS_DECISION_POLICY: AnalysisDecisionPolicy = {
  identity: runtimeIdentity(
    'progress/v1',
    PROGRESS_V1_DECISION_CAPABILITIES,
    PROGRESS_V1_DECISION_FINGERPRINT_FACETS,
  ),
  decide: async (context): Promise<DecisionPolicyOutput> => {
    const effect = scalarEffect(context);
    if (effect === undefined) {
      return { decisionStatus: 'not-decided', reasonCodes: ['decision-effect-unavailable'] };
    }
    const { threshold, equivalence } = progressParameters(context);
    if (effect > threshold + equivalence) {
      return {
        decisionStatus: 'decided',
        verdict: 'PROGRESS',
        reasonCodes: ['effect-above-progress-threshold'],
      };
    }
    if (effect < threshold - equivalence) {
      return {
        decisionStatus: 'decided',
        verdict: 'REGRESSION',
        reasonCodes: ['effect-below-regression-threshold'],
      };
    }
    return {
      decisionStatus: 'decided',
      verdict: 'NOISE',
      reasonCodes: ['effect-within-equivalence-band'],
    };
  },
};

export const BUILTIN_INTERVAL_PROGRESS_DECISION_POLICY: AnalysisDecisionPolicy = {
  identity: runtimeIdentity(
    'progress/v2',
    PROGRESS_V2_DECISION_CAPABILITIES,
    PROGRESS_V2_DECISION_FINGERPRINT_FACETS,
  ),
  decide: async (context): Promise<DecisionPolicyOutput> => {
    const interval = intervalEffect(context);
    if (interval === undefined) {
      return { decisionStatus: 'not-decided', reasonCodes: ['decision-interval-unavailable'] };
    }
    const { threshold, equivalence } = progressParameters(context);
    if (interval.lower > threshold + equivalence) {
      return {
        decisionStatus: 'decided',
        verdict: 'PROGRESS',
        reasonCodes: ['interval-above-progress-boundary'],
      };
    }
    if (interval.upper < threshold - equivalence) {
      return {
        decisionStatus: 'decided',
        verdict: 'REGRESSION',
        reasonCodes: ['interval-below-regression-boundary'],
      };
    }
    return {
      decisionStatus: 'decided',
      verdict: 'NOISE',
      reasonCodes: ['interval-overlaps-decision-boundary'],
    };
  },
};

export function createBuiltinAnalysisNodes(): ReadonlyMap<string, AnalysisNodeImplementation> {
  return new Map([...BUILTIN_DEFINITIONS.entries()].map(([implementationId, definition]) => [
    implementationId,
    new BuiltinNodeImplementation(definition),
  ]));
}

export function createBuiltinAnalysisSchemaValidators(): ReadonlyMap<string, CoreSchemaValidator> {
  const validators = new Map<string, CoreSchemaValidator>();
  const entries: Array<[
    SchemaIdentity,
    z.ZodType,
    ((value: JsonValue, context?: Readonly<CoreSchemaValidationContext>) => void)?,
  ]> = [
    [BUILTIN_SCALAR_RESULT_SCHEMA, ScalarEnvelopeSchema],
    [BUILTIN_INTERVAL_RESULT_SCHEMA, IntervalEnvelopeSchema, validateIntervalContext],
    [BUILTIN_HYPOTHESIS_INPUT_SCHEMA, HypothesisInputEnvelopeSchema],
    [BUILTIN_HYPOTHESIS_TABLE_SCHEMA, HypothesisTableEnvelopeSchema, validateBonferroniContext],
    [EMPTY_PARAMETERS_SCHEMA, StrictEmptyParametersSchema],
    [QUANTILE_PARAMETERS_SCHEMA, QuantileParametersSchema],
    [BOOTSTRAP_PARAMETERS_SCHEMA, BootstrapParametersSchema],
    [HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA, HierarchicalBootstrapParametersSchema],
    [BONFERRONI_PARAMETERS_SCHEMA, BonferroniParametersSchema],
    [PROGRESS_PARAMETERS_SCHEMA, ProgressParametersSchema],
  ];
  for (const [schema, zodSchema, validateContext] of entries) {
    validators.set(
      schemaIdentityKey(schema),
      new BuiltinSchemaValidator(schema, zodSchema, validateContext),
    );
  }
  return validators;
}

export function createBuiltinMissingPolicies() {
  return new Map([['exclude/v1', BUILTIN_EXCLUDE_MISSING_POLICY]]);
}

export function createBuiltinDecisionPolicies() {
  return new Map([
    ['progress/v1', BUILTIN_PROGRESS_DECISION_POLICY],
    ['progress/v2', BUILTIN_INTERVAL_PROGRESS_DECISION_POLICY],
  ]);
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
    const policy = requirement.implementationId === 'progress/v1'
      ? BUILTIN_PROGRESS_DECISION_POLICY
      : requirement.implementationId === 'progress/v2'
        ? BUILTIN_INTERVAL_PROGRESS_DECISION_POLICY
        : undefined;
    if (policy === undefined) return undefined;
    return {
      identity: policy.identity,
      satisfiesVersionConstraint: true,
    };
  }
  const definition = BUILTIN_DEFINITIONS.get(requirement.implementationId);
  if (definition === undefined) return undefined;
  return { identity: definition.identity, satisfiesVersionConstraint: true };
}
