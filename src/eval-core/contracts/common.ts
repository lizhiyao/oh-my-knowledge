import { z } from 'zod';
import { canonicalizeJson, JsonValueSchema, type JsonValue } from './json.js';

export const NonEmptyStringSchema = z.string().min(1);
export const IdentifierSchema = z.string().min(1).max(256);
export const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const UriSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9+.-]*:/);
export const TimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
);
export const JsonPointerSchema = z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/);

export const SchemaIdentitySchema = z.object({
  schemaVersion: NonEmptyStringSchema,
  schemaUri: UriSchema,
  schemaDigest: Sha256DigestSchema,
}).strict();

export interface CoreSchemaValidationContext {
  readonly validationKind: 'analysis-output';
  readonly parameters: unknown;
  readonly inputFacts: {
    readonly resamplingUnitCount: number;
    readonly analysisResultInputs?: readonly {
      readonly referenceId: string;
      readonly resultType: 'scalar' | 'interval' | 'distribution' | 'table' | 'matrix' | 'curve';
      readonly value: JsonValue;
    }[];
  };
}

export interface CoreSchemaValidator {
  readonly schema: SchemaIdentity;
  parse(value: unknown, context?: Readonly<CoreSchemaValidationContext>): JsonValue;
}

export function schemaIdentityKey(identity: SchemaIdentity): string {
  return canonicalizeJson(identity);
}

export const ExtensionEntrySchema = z.object({
  schemaUri: UriSchema,
  schemaDigest: Sha256DigestSchema,
  data: JsonValueSchema,
}).strict();

export const ExtensionsSchema = z.record(
  UriSchema,
  ExtensionEntrySchema,
);

export const RuntimeImplementationFacetSchema = z.object({
  facetId: IdentifierSchema,
  value: JsonValueSchema,
}).strict();

export const RuntimeImplementationManifestSchema = z.discriminatedUnion('coverageKind', [
  z.object({
    coverageKind: z.literal('fingerprint-complete'),
  }).strict(),
  z.object({
    coverageKind: z.literal('fingerprint-plus-facets'),
    facets: z.array(RuntimeImplementationFacetSchema).min(1),
  }).strict(),
]).superRefine((manifest, context) => {
  if (manifest.coverageKind === 'fingerprint-complete') return;
  const facetIds = manifest.facets.map((facet) => facet.facetId);
  const canonicalFacetIds = [...new Set(facetIds)].sort();
  if (canonicalizeJson(facetIds) !== canonicalizeJson(canonicalFacetIds)) {
    context.addIssue({
      code: 'custom',
      path: ['facets'],
      message: 'Runtime implementation facets must be unique and canonical by facetId',
    });
  }
});

export const RuntimeProvenanceFacetsSchema = z.object({
  observation: z.object({
    observerId: IdentifierSchema.optional(),
    observedAt: TimestampSchema.optional(),
  }).strict().optional(),
  attestation: z.object({
    attestationDigest: Sha256DigestSchema,
    attestorId: IdentifierSchema.optional(),
  }).strict().optional(),
}).strict();

export const RuntimeIdentitySchema = z.object({
  implementationId: IdentifierSchema,
  version: NonEmptyStringSchema.optional(),
  fingerprint: NonEmptyStringSchema,
  fingerprintBasis: z.enum([
    'content-derived',
    'environment-derived',
    'self-reported',
    'opaque',
  ]),
  assuranceLevel: z.enum(['verified', 'declared', 'unknown']),
  capabilities: JsonValueSchema,
  implementationManifest: RuntimeImplementationManifestSchema,
  provenanceFacets: RuntimeProvenanceFacetsSchema.optional(),
}).strict();

export const ProvenanceSchema = z.object({
  provenanceKind: z.enum(['native', 'imported', 'replay', 'derived']),
  trust: z.enum(['verified', 'declared', 'untrusted', 'unknown']),
  sourceId: NonEmptyStringSchema.optional(),
  parentDigests: z.array(Sha256DigestSchema),
  facets: JsonValueSchema.optional(),
}).strict();

export const CacheProvenanceSchema = z.object({
  cacheStatus: z.enum(['not-used', 'miss', 'replay', 'transparent-hit']),
  cacheKeyDigest: Sha256DigestSchema.optional(),
  sourceRecordDigest: Sha256DigestSchema.optional(),
}).strict();

export const ContentDescriptorSchema = z.object({
  mediaType: NonEmptyStringSchema,
  digest: Sha256DigestSchema,
  size: z.number().int().nonnegative().optional(),
  uri: UriSchema.optional(),
}).strict();

export const ContentClassificationSchema = z.enum([
  'public',
  'sensitive',
  'secret',
  'gold',
]);

export const CapturedContentSchema = z.discriminatedUnion('contentKind', [
  z.object({
    contentKind: z.literal('inline'),
    classification: ContentClassificationSchema,
    value: JsonValueSchema,
  }).strict(),
  z.object({
    contentKind: z.literal('descriptor'),
    classification: ContentClassificationSchema,
    descriptor: ContentDescriptorSchema,
  }).strict(),
  z.object({
    contentKind: z.literal('digest-only'),
    classification: ContentClassificationSchema,
    digest: Sha256DigestSchema,
  }).strict(),
]);

export const ReplayabilitySchema = z.enum([
  'self-contained',
  'resolvable',
  'summary-only',
]);

export interface EvaluationError {
  code: string;
  stage: 'configuration' | 'infrastructure' | 'execution' | 'evaluation' | 'analysis' | 'internal';
  message: string;
  details?: JsonValue;
  causes?: EvaluationError[];
}

export const EvaluationErrorSchema: z.ZodType<EvaluationError> = z.lazy(() => z.object({
  code: IdentifierSchema,
  stage: z.enum([
    'configuration',
    'infrastructure',
    'execution',
    'evaluation',
    'analysis',
    'internal',
  ]),
  message: NonEmptyStringSchema,
  details: JsonValueSchema.optional(),
  causes: z.array(EvaluationErrorSchema).optional(),
}).strict());

export type SchemaIdentity = z.infer<typeof SchemaIdentitySchema>;
export type ExtensionEntry = z.infer<typeof ExtensionEntrySchema>;
export type Extensions = z.infer<typeof ExtensionsSchema>;
export type RuntimeImplementationFacet = z.infer<typeof RuntimeImplementationFacetSchema>;
export type RuntimeImplementationManifest = z.infer<typeof RuntimeImplementationManifestSchema>;
export type RuntimeProvenanceFacets = z.infer<typeof RuntimeProvenanceFacetsSchema>;
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type CacheProvenance = z.infer<typeof CacheProvenanceSchema>;
export type ContentDescriptor = z.infer<typeof ContentDescriptorSchema>;
export type CapturedContent = z.infer<typeof CapturedContentSchema>;
export type Replayability = z.infer<typeof ReplayabilitySchema>;
