import { z } from 'zod';
import {
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type RuntimeIdentity,
  type SchemaIdentity,
} from '../../evaluation-core/contracts/index.js';
import type {
  SeriesAnalysisNodeContext,
  SeriesAnalysisNodeRuntime,
} from '../../evaluation-core/series/index.js';
import { parseCompositeTableValue } from './analysis/composite-table.js';

export const OMK_SERIES_VARIANCE_IMPLEMENTATION_ID = 'omk.series.variance/v1';
export const OMK_SERIES_VARIANCE_SCHEMA_VERSION = 'omk.series.variance-table/v1';

const ValueSchema = z.object({
  schemaVersion: z.literal(OMK_SERIES_VARIANCE_SCHEMA_VERSION),
  members: z.array(z.object({
    memberId: z.string().min(1),
    replicateIndex: z.number().int().nonnegative(),
    meanComposite: z.number().finite(),
  }).strict()).min(2),
  grandMean: z.number().finite(),
  sampleVariance: z.number().finite().nonnegative(),
}).strict();

const OUTPUT_SCHEMA: SchemaIdentity = {
  schemaVersion: OMK_SERIES_VARIANCE_SCHEMA_VERSION,
  schemaUri: 'urn:omk:series:variance-table:v1',
  schemaDigest: digestCanonicalJson({
    schemaVersion: OMK_SERIES_VARIANCE_SCHEMA_VERSION,
    experimentalUnit: 'run',
    statistic: 'unbiased-sample-variance-of-run-mean-composite',
  }),
};

const IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
  implementationId: OMK_SERIES_VARIANCE_IMPLEMENTATION_ID,
  version: '1.0.0',
  fingerprint: digestCanonicalJson({
    implementationId: OMK_SERIES_VARIANCE_IMPLEMENTATION_ID,
    algorithm: 'unbiased-sample-variance-of-run-mean-composite',
    version: 1,
  }),
  fingerprintBasis: 'content-derived',
  assuranceLevel: 'verified',
  capabilities: { experimentalUnit: 'run', minimumMembers: 2 },
  implementationManifest: { coverageKind: 'fingerprint-complete' },
}));

export function createOmkSeriesVarianceRuntime(): SeriesAnalysisNodeRuntime {
  return Object.freeze({
    identity: IDENTITY,
    outputSchema: OUTPUT_SCHEMA,
    async analyze(context: Readonly<SeriesAnalysisNodeContext>) {
      const values: Array<{
        memberId: string;
        replicateIndex: number;
        meanComposite: number;
      }> = context.members.flatMap((member) => {
        const treatment = member.plan.execution.targets.find(
          (target) => target.targetKind === 'treatment',
        );
        const record = member.sources.analysis.bundle.records.find((candidate) => (
          candidate.analysisStatus === 'completed'
            && candidate.outputSchema.schemaVersion === 'omk.composite-table/v1'
        ));
        if (treatment === undefined || record?.analysisStatus !== 'completed') return [];
        const table = parseCompositeTableValue(record.value);
        const scores = table.groups.flatMap((group) => (
          group.targetId === treatment.targetId && group.aggregate.aggregateStatus === 'observed'
            ? [group.aggregate.score]
            : []
        ));
        if (scores.length === 0) return [];
        return [{
          memberId: member.reference.memberId,
          replicateIndex: member.reference.replicateIndex,
          meanComposite: scores.reduce((sum, score) => sum + score, 0) / scores.length,
        }];
      });
      if (values.length !== context.plan.definition.members.length || values.length < 2) return {
        analysisStatus: 'inconclusive' as const,
        reasonCodes: ['series-run-mean-evidence-incomplete'],
      };
      const grandMean = values.reduce((sum, member) => sum + member.meanComposite, 0) / values.length;
      const sampleVariance = values.reduce((sum, member) => (
        sum + (member.meanComposite - grandMean) ** 2
      ), 0) / (values.length - 1);
      return {
        analysisStatus: 'completed' as const,
        resultType: 'table' as const,
        value: ValueSchema.parse({
          schemaVersion: OMK_SERIES_VARIANCE_SCHEMA_VERSION,
          members: values,
          grandMean,
          sampleVariance,
        }),
      };
    },
  });
}

export function createOmkSeriesVarianceSchemaValidators(): ReadonlyMap<string, CoreSchemaValidator> {
  const validator: CoreSchemaValidator = {
    schema: OUTPUT_SCHEMA,
    parse(value: unknown) {
      return ValueSchema.parse(value);
    },
  };
  return new Map([[schemaIdentityKey(OUTPUT_SCHEMA), validator]]);
}
