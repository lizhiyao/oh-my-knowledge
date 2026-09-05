import { z } from 'zod';
import {
  IdentifierSchema,
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
} from '../contracts/index.js';
import type {
  SeriesAnalysisNodeContext,
  SeriesAnalysisNodeRuntime,
  SeriesAnalysisNodeOutput,
} from './runtime.js';

export const RUN_STABILITY_IMPLEMENTATION_ID = 'descriptive.run-stability/v1';
export const RUN_STABILITY_SCHEMA_VERSION = 'omk.series.run-stability-table/v1';

const RunStabilityParametersSchema = z.object({
  sourceAnalysisResultId: IdentifierSchema,
  projection: z.enum(['scalar', 'interval-estimate']),
  coverageMode: z.literal('complete-plan'),
}).strict();

const FiniteNumberSchema = z.number().finite();

function descriptiveStatistics(values: readonly number[]): Readonly<{
  mean: number;
  sampleVariance: number;
  sampleStandardDeviation: number;
  minimum: number;
  maximum: number;
  range: number;
}> | undefined {
  const canonicalNumber = (value: number) => (Object.is(value, -0) ? 0 : value);
  const mean = values.reduce((sum, current) => sum + current, 0) / values.length;
  const sampleVariance = values.reduce(
    (sum, current) => sum + (current - mean) ** 2,
    0,
  ) / (values.length - 1);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const statistics = {
    mean: canonicalNumber(mean),
    sampleVariance: canonicalNumber(sampleVariance),
    sampleStandardDeviation: canonicalNumber(Math.sqrt(sampleVariance)),
    minimum: canonicalNumber(minimum),
    maximum: canonicalNumber(maximum),
    range: canonicalNumber(maximum - minimum),
  };
  return Object.values(statistics).every(Number.isFinite) ? statistics : undefined;
}

export const RunStabilityValueSchema = z.object({
  schemaVersion: z.literal(RUN_STABILITY_SCHEMA_VERSION),
  sourceAnalysisResultId: IdentifierSchema,
  projection: z.enum(['scalar', 'interval-estimate']),
  experimentalUnit: z.literal('run'),
  members: z.array(z.object({
    memberId: IdentifierSchema,
    replicateIndex: z.number().int().nonnegative(),
    sourceRecordDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    value: FiniteNumberSchema,
  }).strict()).min(2),
  runCount: z.number().int().min(2),
  mean: FiniteNumberSchema,
  sampleVariance: FiniteNumberSchema.nonnegative(),
  sampleStandardDeviation: FiniteNumberSchema.nonnegative(),
  minimum: FiniteNumberSchema,
  maximum: FiniteNumberSchema,
  range: FiniteNumberSchema.nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.runCount !== value.members.length) {
    context.addIssue({
      code: 'custom',
      path: ['runCount'],
      message: 'Run count must equal the number of member values.',
    });
  }
  const memberIds = value.members.map((member) => member.memberId);
  const replicateIndexes = value.members.map((member) => member.replicateIndex);
  const canonicalOrder = value.members.every((member, index) => {
    const previous = value.members[index - 1];
    return previous === undefined || previous.replicateIndex < member.replicateIndex;
  });
  if (new Set(memberIds).size !== memberIds.length
      || new Set(replicateIndexes).size !== replicateIndexes.length
      || !canonicalOrder) {
    context.addIssue({
      code: 'custom',
      path: ['members'],
      message: 'Run stability members must have unique identities in canonical replicate order.',
    });
  }
  const values = value.members.map((member) => member.value);
  const expected = descriptiveStatistics(values);
  if (expected === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['members'],
      message: 'Run stability statistics must remain finite.',
    });
    return;
  }
  for (const [key, calculated] of Object.entries(expected)) {
    if (!Object.is(value[key as keyof typeof expected], calculated)) {
      context.addIssue({
        code: 'custom',
        path: [key],
        message: `Run stability ${key} must be exactly recomputable from member values.`,
      });
    }
  }
});

export type RunStabilityValue = z.infer<typeof RunStabilityValueSchema>;

const RunStabilityEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: RunStabilityValueSchema,
}).strict();

const RUN_STABILITY_JSON_SCHEMA = {
  ...(z.toJSONSchema(RunStabilityEnvelopeSchema, {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    cycles: 'ref',
    reused: 'ref',
  }) as unknown as Record<string, JsonValue>),
  'x-omk-invariants': [
    'members are unique and use ascending replicate order',
    'runCount equals members.length and is at least two',
    'mean, Bessel-corrected sample variance, standard deviation, minimum, maximum, and range are exactly recomputable from member values',
    'all reported statistics are finite',
  ],
};

const RUN_STABILITY_OUTPUT_SCHEMA: SchemaIdentity = deepFreezeCanonicalJson({
  schemaVersion: RUN_STABILITY_SCHEMA_VERSION,
  schemaUri: 'urn:omk:series:run-stability-table:v1',
  schemaDigest: digestCanonicalJson(RUN_STABILITY_JSON_SCHEMA),
});

const RUN_STABILITY_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: RUN_STABILITY_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: RUN_STABILITY_IMPLEMENTATION_ID,
      algorithm: 'mean-bessel-corrected-sample-variance-standard-deviation-range',
      version: 1,
      outputSchemaDigest: RUN_STABILITY_OUTPUT_SCHEMA.schemaDigest,
    }),
    // A builtin can seal its release identity, but cannot attest that the
    // executing package bytes match that declaration without a host verifier.
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: {
      experimentalUnit: 'run',
      inferenceKind: 'descriptive-only',
      minimumMembers: 2,
    },
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

function projectedValue(
  record: Readonly<{
    resultType: string;
    value: JsonValue;
  }>,
  projection: 'scalar' | 'interval-estimate',
): number | undefined {
  if (projection === 'scalar') {
    return record.resultType === 'scalar'
        && typeof record.value === 'number'
        && Number.isFinite(record.value)
      ? record.value
      : undefined;
  }
  if (record.resultType !== 'interval'
      || record.value === null
      || Array.isArray(record.value)
      || typeof record.value !== 'object') return undefined;
  const estimate = (record.value as Record<string, JsonValue>).estimate;
  return typeof estimate === 'number' && Number.isFinite(estimate) ? estimate : undefined;
}

export function createRunStabilityRuntime(): SeriesAnalysisNodeRuntime {
  return Object.freeze({
    identity: RUN_STABILITY_IDENTITY,
    outputSchema: RUN_STABILITY_OUTPUT_SCHEMA,
    async openRun() {
      return Object.freeze({
        async analyze(
          context: Readonly<SeriesAnalysisNodeContext>,
        ): Promise<SeriesAnalysisNodeOutput> {
          const parameters = RunStabilityParametersSchema.parse(context.node.parameters);
          const [input] = context.inputs;
          if (context.inputs.length !== 1
              || input?.seriesInputKind !== 'members'
              || input.referenceId !== context.plan.definition.seriesId) {
            return {
              analysisStatus: 'inconclusive',
              reasonCodes: ['series-stability-input-contract-invalid'],
            };
          }
          if (input.members.length !== context.coverage.planned
              || context.coverage.comparable !== context.coverage.planned) {
            return {
              analysisStatus: 'inconclusive',
              reasonCodes: ['series-stability-complete-coverage-required'],
            };
          }
          const members = input.members.flatMap((member) => {
            const record = member.sources.analysis.bundle.records.find((candidate) => (
              candidate.resultId === parameters.sourceAnalysisResultId
            ));
            if (record?.analysisStatus !== 'completed') return [];
            const value = projectedValue(record, parameters.projection);
            if (value === undefined) return [];
            return [{
              memberId: member.reference.memberId,
              replicateIndex: member.reference.replicateIndex,
              sourceRecordDigest: record.recordDigest,
              value,
            }];
          }).sort((left, right) => left.replicateIndex - right.replicateIndex);
          if (members.length !== input.members.length || members.length < 2) {
            return {
              analysisStatus: 'inconclusive',
              reasonCodes: ['series-source-analysis-evidence-incomplete'],
            };
          }
          const values = members.map((member) => member.value);
          const statistics = descriptiveStatistics(values);
          if (statistics === undefined) {
            return {
              analysisStatus: 'inconclusive',
              reasonCodes: ['series-stability-statistic-non-finite'],
            };
          }
          return {
            analysisStatus: 'completed',
            resultType: 'table',
            value: RunStabilityValueSchema.parse({
              schemaVersion: RUN_STABILITY_SCHEMA_VERSION,
              sourceAnalysisResultId: parameters.sourceAnalysisResultId,
              projection: parameters.projection,
              experimentalUnit: 'run',
              members,
              runCount: members.length,
              ...statistics,
            }),
          };
        },
        dispose() {},
      });
    },
  });
}

export function createRunStabilitySchemaValidators(): ReadonlyMap<string, CoreSchemaValidator> {
  const validator: CoreSchemaValidator = Object.freeze({
    schema: RUN_STABILITY_OUTPUT_SCHEMA,
    parse(value: unknown) {
      return RunStabilityEnvelopeSchema.parse(value) as JsonValue;
    },
  });
  return new Map([[schemaIdentityKey(RUN_STABILITY_OUTPUT_SCHEMA), validator]]);
}
