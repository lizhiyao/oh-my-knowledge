import {
  z,
} from 'zod';
import {
  JsonValueSchema,
  IdentifierSchema,
  JsonPointerSchema,
} from '../../eval-core/contracts/index.js';
import {
  MeasurementPolicyBuilderInputSchema,
} from '../builders/policy.js';

export const ARTIFACT_KINDS = ['baseline', 'skill', 'prompt', 'agent', 'workflow'] as const;

export const ARTIFACT_SOURCES = [
  'baseline',
  'variant-name',
  'file-path',
  'git',
  'inline',
  'custom',
] as const;

export const VARIANT_CONFIG_SCHEMA_VERSION = 'omk.eval-runtime.variant-config/v3' as const;

export const MAX_RUBRIC_PANEL_COORDINATES = 1_000;

export const ContentValueSchema = z.object({
  value: JsonValueSchema,
  classification: z.enum(['public', 'sensitive', 'secret', 'gold']),
  mediaType: z.string().min(1).optional(),
}).strict();

export const ArtifactSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(ARTIFACT_KINDS),
  source: z.enum(ARTIFACT_SOURCES),
  content: z.string().nullable(),
  contentHash: z.string().min(1).optional(),
  locator: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  resolvedCommit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  metadata: JsonValueSchema.optional(),
}).strict().superRefine((artifact, context) => {
  if (artifact.kind === 'baseline' && (artifact.source !== 'baseline' || artifact.content !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'baseline artifact must use baseline source and null content.',
    });
  }
  if (artifact.kind !== 'baseline' && artifact.source === 'baseline') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only a baseline artifact may use baseline source.',
    });
  }
});

export const RuntimeContextSchema = z.object({
  values: JsonValueSchema.optional(),
}).strict();

export const RetrievalEvaluatorInputSchema = z.object({
  evaluatorKind: z.literal('retrieval'),
  evaluatorId: IdentifierSchema,
  cutoff: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ranking: z.object({
    source: z.enum(['output', 'trace']),
    pointer: JsonPointerSchema,
  }).strict(),
  relevantDocumentIdsPointer: JsonPointerSchema,
  metricIds: z.object({
    recallAtK: IdentifierSchema,
    precisionAtK: IdentifierSchema,
    reciprocalRankAtK: IdentifierSchema,
    ndcgAtK: IdentifierSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const ids = Object.values(value.metricIds);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: 'custom',
      path: ['metricIds'],
      message: 'Retrieval Metric IDs must be unique',
    });
  }
});

export const ToolTrajectoryEvaluatorInputSchema = z.object({
  evaluatorKind: z.literal('tool-trajectory'),
  evaluatorId: IdentifierSchema,
  metricId: IdentifierSchema,
  tracePointer: JsonPointerSchema,
  expectedToolNamesPointer: JsonPointerSchema,
  match: z.enum([
    'exact-order',
    'same-tools',
    'contains-in-order',
    'contains-any-order',
  ]),
}).strict();

const SamplingDesignInputSchema = z.discriminatedUnion('samplingKind', [
  z.object({
    samplingKind: z.literal('solo'),
    clusterKey: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/).optional(),
    stratumKey: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/).optional(),
  }).strict(),
  z.object({
    samplingKind: z.literal('paired'),
    pairingKey: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/).optional(),
    stratumKey: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/).optional(),
    seedCoupling: z.enum([
      'shared-within-block',
      'independent-by-target',
      'uncontrolled',
    ]).optional(),
  }).strict(),
  z.object({
    samplingKind: z.literal('independent'),
    allocations: z.array(z.object({
      variantId: IdentifierSchema,
      weight: z.number().finite().positive(),
    }).strict()).min(2),
    stratumKey: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/).optional(),
    minimumSamplesPerVariant: z.number().int().min(2),
    minimumSamplesPerVariantPerStratum: z.number().int().positive(),
  }).strict(),
]);

export const ExperimentSchema = z.object({
  seed: z.string().min(1),
  trials: z.number().int().positive().optional(),
  sampling: SamplingDesignInputSchema,
  scheduling: z.object({
    schedulingKind: z.enum(['sequential', 'interleaved', 'randomized-block']),
    blockSize: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();

export const CohortFilterInputSchema = z.object({
  includeCohortIds: z.array(IdentifierSchema).min(1).optional(),
  excludeCohortIds: z.array(IdentifierSchema).min(1).optional(),
}).strict().refine((filter) => (
  filter.includeCohortIds !== undefined || filter.excludeCohortIds !== undefined
));

const ComparisonFamilyMemberInputSchema = z.object({
  analysisId: IdentifierSchema,
  comparisonId: IdentifierSchema,
  treatmentVariantId: IdentifierSchema,
  metricId: IdentifierSchema,
}).strict();

const CompositeComponentInputSchema = z.object({
  metricId: IdentifierSchema,
  weight: z.number().finite().positive(),
}).strict();

const CompositeAggregationInputSchema = z.object({
  method: z.literal('weighted-mean'),
  missing: z.literal('require-complete'),
}).strict();

const CompositeRequestFieldsSchema = z.object({
  compositeMetricId: IdentifierSchema,
  components: z.array(CompositeComponentInputSchema).min(2),
  aggregation: CompositeAggregationInputSchema,
  confidence: z.object({
    method: z.literal('percentile-bootstrap'),
    level: z.number().gt(0).lt(1),
    resamples: z.number().int().positive(),
  }).strict(),
  cohortFilter: CohortFilterInputSchema.optional(),
}).strict();

export const AnalysesInputSchema = z.array(z.discriminatedUnion('analysisKind', [
    z.object({
      analysisId: IdentifierSchema,
      analysisKind: z.literal('summary'),
      statistic: z.enum(['mean', 'rate', 'quantile']),
      variantId: IdentifierSchema,
      metricId: IdentifierSchema,
      probability: z.number().min(0).max(1).optional(),
      cohortFilter: CohortFilterInputSchema.optional(),
    }).strict(),
    z.object({
      analysisId: IdentifierSchema,
      analysisKind: z.literal('quality-interval'),
      statistic: z.literal('mean'),
      variantId: IdentifierSchema,
      metricId: IdentifierSchema,
      confidence: z.object({
        method: z.literal('percentile-bootstrap'),
        level: z.number().gt(0).lt(1),
        resamples: z.number().int().positive(),
      }).strict(),
      cohortFilter: CohortFilterInputSchema.optional(),
    }).strict(),
    z.object({
      analysisId: IdentifierSchema,
      analysisKind: z.literal('comparison-interval'),
      statistic: z.literal('mean-difference'),
      comparisonId: IdentifierSchema,
      treatmentVariantId: IdentifierSchema,
      metricId: IdentifierSchema,
      confidence: z.object({
        method: z.literal('percentile-bootstrap'),
        level: z.number().gt(0).lt(1),
        resamples: z.number().int().positive(),
      }).strict(),
      cohortFilter: CohortFilterInputSchema.optional(),
    }).strict(),
    z.object({
      analysisId: IdentifierSchema,
      analysisKind: z.literal('comparison-family'),
      statistic: z.literal('mean-difference'),
      members: z.array(ComparisonFamilyMemberInputSchema).min(2),
      confidence: z.object({
        method: z.literal('bonferroni-percentile-bootstrap'),
        level: z.number().gt(0).lt(1),
        resamples: z.number().int().positive(),
      }).strict(),
      cohortFilter: CohortFilterInputSchema.optional(),
    }).strict(),
    CompositeRequestFieldsSchema.extend({
      analysisId: IdentifierSchema,
      analysisKind: z.literal('composite-quality-interval'),
      variantId: IdentifierSchema,
    }).strict(),
    CompositeRequestFieldsSchema.extend({
      analysisId: IdentifierSchema,
      analysisKind: z.literal('composite-comparison-interval'),
      comparisonId: IdentifierSchema,
      treatmentVariantId: IdentifierSchema,
    }).strict(),
  ]));

export const ComparisonInputSchema = z.object({
  comparisonId: IdentifierSchema,
  controlVariantId: IdentifierSchema,
  treatmentVariantIds: z.array(IdentifierSchema).min(1),
  metricIds: z.array(IdentifierSchema).min(1),
}).strict();

const FamilyDecisionCriterionInputSchema = z.object({
  analysisId: IdentifierSchema,
  minimumEffect: z.number().finite().optional(),
  maximumEffect: z.number().finite().optional(),
}).strict().superRefine((criterion, context) => {
  if (criterion.minimumEffect === undefined && criterion.maximumEffect === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'A comparison-family decision criterion requires an effect boundary',
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

export const DecisionInputSchema = z.union([
  z.object({
    decisionKind: z.literal('analysis'),
    analysisId: IdentifierSchema,
    threshold: z.number().finite().optional(),
    equivalence: z.number().finite().nonnegative().optional(),
    minimumEvidenceStatus: z.enum(['complete', 'partial', 'unresolvable']).optional(),
  }).strict(),
  z.object({
    decisionKind: z.literal('comparison-family'),
    analysisId: IdentifierSchema,
    rule: z.literal('all'),
    criteria: z.array(FamilyDecisionCriterionInputSchema).min(2),
    minimumEvidenceStatus: z.enum(['complete', 'partial', 'unresolvable']).optional(),
  }).strict(),
]);

export const PolicyInputSchema = MeasurementPolicyBuilderInputSchema.omit({ eventDelivery: true });

export const VariantConfigEnvelopeSchema = z.object({
  schemaVersion: z.literal(VARIANT_CONFIG_SCHEMA_VERSION),
  artifact: ArtifactSchema,
  runtimeContext: RuntimeContextSchema.optional(),
  executorConfig: JsonValueSchema.optional(),
}).strict();
