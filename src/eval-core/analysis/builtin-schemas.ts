/**
 * 内建分析节点的参数与结果 schema：zod 定义、JSON Schema 身份，以及五个 BUILTIN_*_SCHEMA 标识。
 */
import { z } from 'zod';
import {
  canonicalizeJson,
  bonferroniMarginalConfidenceLevel,
  digestCanonicalJson,
  type JsonValue,
  type SchemaIdentity,
} from '../contracts/index.js';

export const FiniteNumberSchema = z.number().finite();

export const ProbabilitySchema = FiniteNumberSchema.min(0).max(1);

export const StrictEmptyParametersSchema = z.object({}).strict();

export const QuantileParametersSchema = z.object({
  probability: ProbabilitySchema.default(0.5),
}).strict();

export const BootstrapParametersSchema = z.object({
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

export const MeasurementAggregationSchema = z.discriminatedUnion('method', [
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

export const HierarchicalBootstrapParametersSchema = z.object({
  resamples: z.number().int().positive().safe().default(1_000),
  alpha: FiniteNumberSchema.gt(0).lt(1).default(0.05),
  measurementAggregation: MeasurementAggregationSchema,
}).strict();

export const HierarchicalReducerParametersSchema = z.object({
  measurementAggregation: MeasurementAggregationSchema,
}).strict();

export const HierarchicalQuantileParametersSchema = z.object({
  probability: ProbabilitySchema,
  measurementAggregation: MeasurementAggregationSchema,
}).strict();

const CompositeComponentSchema = z.object({
  metricId: z.string().min(1).max(256),
  weight: FiniteNumberSchema.positive(),
  measurementAggregation: MeasurementAggregationSchema.optional(),
}).strict();

export const CompositeBootstrapParametersSchema = z.object({
  compositeMetricId: z.string().min(1).max(256),
  components: z.array(CompositeComponentSchema).min(2),
  aggregation: z.object({
    method: z.literal('weighted-mean'),
    missing: z.literal('require-complete'),
  }).strict(),
  resamples: z.number().int().positive().safe().default(1_000),
  alpha: FiniteNumberSchema.gt(0).lt(1).default(0.05),
}).strict().superRefine((parameters, context) => {
  const metricIds = parameters.components.map((component) => component.metricId);
  if (new Set(metricIds).size !== metricIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['components'],
      message: 'Composite component Metric IDs must be unique',
    });
  }
  if (metricIds.includes(parameters.compositeMetricId)) {
    context.addIssue({
      code: 'custom',
      path: ['compositeMetricId'],
      message: 'Composite Metric cannot also be a source component',
    });
  }
  const total = parameters.components.reduce((sum, component) => sum + component.weight, 0);
  if (total !== 1) {
    context.addIssue({
      code: 'custom',
      path: ['components'],
      message: 'Composite component weights must sum to one',
    });
  }
});

export const BonferroniParametersSchema = z.object({
  alpha: FiniteNumberSchema.gt(0).lt(1).default(0.05),
}).strict();

export const SimultaneousIntervalFamilyParametersSchema = z.object({
  familyConfidenceLevel: FiniteNumberSchema.gt(0).lt(1),
  resamples: z.number().int().positive().safe(),
}).strict();

export const ProgressParametersSchema = z.object({
  threshold: FiniteNumberSchema.default(0),
  equivalence: FiniteNumberSchema.nonnegative().default(0),
}).strict();

const FamilyReleaseCriterionSchema = z.object({
  analysisResultId: z.string().min(1).max(256),
  minimumEffect: FiniteNumberSchema.optional(),
  maximumEffect: FiniteNumberSchema.optional(),
}).strict().superRefine((criterion, context) => {
  if (criterion.minimumEffect === undefined && criterion.maximumEffect === undefined) {
    context.addIssue({
      code: 'custom',
      path: [],
      message: 'A family release criterion requires at least one effect boundary',
    });
  }
  if (criterion.minimumEffect !== undefined
      && criterion.maximumEffect !== undefined
      && criterion.minimumEffect > criterion.maximumEffect) {
    context.addIssue({
      code: 'custom',
      path: ['minimumEffect'],
      message: 'minimumEffect must not exceed maximumEffect',
    });
  }
});

export const FamilyReleaseParametersSchema = z.object({
  rule: z.literal('all'),
  criteria: z.array(FamilyReleaseCriterionSchema).min(2),
}).strict().superRefine((parameters, context) => {
  const resultIds = parameters.criteria.map((criterion) => criterion.analysisResultId);
  if (new Set(resultIds).size !== resultIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['criteria'],
      message: 'Family release criteria must be unique',
    });
  }
});


export const ScalarEnvelopeSchema = z.object({
  resultType: z.literal('scalar'),
  value: FiniteNumberSchema,
}).strict();

const PercentileIntervalValueSchema = z.object({
  estimate: FiniteNumberSchema,
  lower: FiniteNumberSchema,
  upper: FiniteNumberSchema,
  confidenceLevel: FiniteNumberSchema.gt(0).lt(1),
  resamples: z.number().int().positive().safe(),
  unitCount: z.number().int().positive().safe(),
  method: z.literal('percentile'),
}).strict();

export const IntervalEnvelopeSchema = z.object({
  resultType: z.literal('interval'),
  value: PercentileIntervalValueSchema,
}).strict().superRefine((envelope, context) => {
  if (envelope.value.lower > envelope.value.upper) {
    context.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'Interval bounds must satisfy lower <= upper',
    });
  }
});

export const SimultaneousIntervalFamilyEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: z.object({
    adjustmentMethod: z.literal('bonferroni'),
    familyConfidenceLevel: FiniteNumberSchema.gt(0).lt(1),
    marginalConfidenceLevel: FiniteNumberSchema.gt(0).lt(1),
    familySize: z.number().int().min(2).safe(),
    resamples: z.number().int().positive().safe(),
    members: z.array(z.object({
      analysisResultId: z.string().min(1).max(256),
      interval: PercentileIntervalValueSchema,
    }).strict()).min(2),
  }).strict(),
}).strict().superRefine((envelope, context) => {
  const { value } = envelope;
  const memberIds = value.members.map((member) => member.analysisResultId);
  if (value.familySize !== value.members.length) {
    context.addIssue({ code: 'custom', path: ['value', 'familySize'], message: 'familySize mismatch' });
  }
  if (new Set(memberIds).size !== memberIds.length
      || canonicalizeJson(memberIds) !== canonicalizeJson([...memberIds].sort())) {
    context.addIssue({
      code: 'custom',
      path: ['value', 'members'],
      message: 'Member IDs must be unique and canonical',
    });
  }
  const expectedConfidence = bonferroniMarginalConfidenceLevel(
    value.familyConfidenceLevel,
    value.familySize,
  );
  if (value.marginalConfidenceLevel !== expectedConfidence
      || value.members.some((member) => (
        member.interval.confidenceLevel !== expectedConfidence
        || member.interval.resamples !== value.resamples
      ))) {
    context.addIssue({
      code: 'custom',
      path: ['value', 'members'],
      message: 'Member interval metadata does not match the Bonferroni family',
    });
  }
});

export function jsonSchema(schema: z.ZodType, invariants?: readonly string[]): JsonValue {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    cycles: 'ref',
    reused: 'ref',
  }) as unknown as Record<string, JsonValue>;
  const plain = { ...generated };
  return invariants === undefined ? plain : { ...plain, 'x-omk-invariants': [...invariants] };
}


export function schemaIdentity(
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


export const BUILTIN_SIMULTANEOUS_INTERVAL_FAMILY_RESULT_SCHEMA = schemaIdentity(
  'omk.analysis-result.simultaneous-interval-family/v1',
  'urn:omk:analysis-result:simultaneous-interval-family:v1',
  jsonSchema(SimultaneousIntervalFamilyEnvelopeSchema, [
    'familySize equals members.length and is at least two',
    'analysisResultId values are unique and lexicographically sorted',
    'marginalConfidenceLevel equals 1 - (1 - familyConfidenceLevel) / familySize',
    'every member interval confidence and resamples match the sealed family parameters',
    'every member interval is identical to its referenced Core Analysis result',
  ]),
);


export const EMPTY_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.empty/v1', 'urn:omk:parameters:empty:v1', jsonSchema(StrictEmptyParametersSchema),
);

export const QUANTILE_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.quantile/v1', 'urn:omk:parameters:quantile:v1', jsonSchema(QuantileParametersSchema),
);

export const BOOTSTRAP_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.bootstrap/v1', 'urn:omk:parameters:bootstrap:v1', jsonSchema(BootstrapParametersSchema),
);

export const HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA = schemaIdentity(
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

export const HIERARCHICAL_REDUCER_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.hierarchical-measurement-reducer/v1',
  'urn:omk:parameters:hierarchical-measurement-reducer:v1',
  jsonSchema(HierarchicalReducerParametersSchema),
);

export const HIERARCHICAL_QUANTILE_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.hierarchical-measurement-quantile/v1',
  'urn:omk:parameters:hierarchical-measurement-quantile:v1',
  jsonSchema(HierarchicalQuantileParametersSchema),
);

export const COMPOSITE_BOOTSTRAP_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.composite-bootstrap/v1',
  'urn:omk:parameters:composite-bootstrap:v1',
  jsonSchema(CompositeBootstrapParametersSchema, [
    'components contain at least two unique Metric IDs in lexicographic order',
    'component weights are positive and sum to one',
    'the composite Metric is not a source component',
    'each target/sample/trial contributes only when every component coordinate is observed',
    'component utilities are combined before repeated-measure and resampling aggregation',
  ]),
);

export const BONFERRONI_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.bonferroni/v1', 'urn:omk:parameters:bonferroni:v1', jsonSchema(BonferroniParametersSchema),
);

export const SIMULTANEOUS_INTERVAL_FAMILY_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.simultaneous-interval-family/v1',
  'urn:omk:parameters:simultaneous-interval-family:v1',
  jsonSchema(SimultaneousIntervalFamilyParametersSchema, [
    'familyConfidenceLevel is the simultaneous coverage target',
    'member alpha equals (1 - familyConfidenceLevel) divided by the sealed input count',
  ]),
);

export const PROGRESS_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.progress/v1', 'urn:omk:parameters:progress:v1', jsonSchema(ProgressParametersSchema),
);

export const FAMILY_RELEASE_PARAMETERS_SCHEMA = schemaIdentity(
  'omk.parameters.family-release/v1',
  'urn:omk:parameters:family-release:v1',
  jsonSchema(FamilyReleaseParametersSchema, [
    'rule is explicitly all',
    'criteria are unique and sealed in canonical analysisResultId order',
    'every criterion declares at least one finite effect boundary',
    'minimumEffect is less than or equal to maximumEffect when both are present',
  ]),
);

