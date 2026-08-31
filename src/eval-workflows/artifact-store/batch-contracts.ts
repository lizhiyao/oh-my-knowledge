import { z } from 'zod';
import {
  EvaluationStatusSchema,
  IdentifierSchema,
  Sha256DigestSchema,
  TimestampSchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  parseWireDocument,
} from '../../evaluation-core/contracts/index.js';

export const CORE_BATCH_MANIFEST_SCHEMA_VERSION =
  'omk.core-batch-manifest/v1' as const;

export const CORE_BATCH_MANIFEST_FILE = 'manifest.json' as const;

export const CoreBatchChildReferenceSchema = z.object({
  batchItemKind: z.literal('core-run'),
  itemId: IdentifierSchema,
  ordinal: z.number().int().nonnegative(),
  locator: z.object({
    locatorKind: z.literal('core-run'),
    runId: IdentifierSchema,
  }).strict(),
  reportId: IdentifierSchema,
  runContractDigest: Sha256DigestSchema,
  reportDigest: Sha256DigestSchema,
  artifactSetDigest: Sha256DigestSchema,
  status: EvaluationStatusSchema,
  maximumCapturedClassification: z.enum([
    'public',
    'sensitive',
    'secret',
    'gold',
  ]),
}).strict();

export const CoreBatchManifestSchema = z.object({
  schemaVersion: z.literal(CORE_BATCH_MANIFEST_SCHEMA_VERSION),
  batchManifestKind: z.literal('evaluation-core-child-runs'),
  batchId: IdentifierSchema,
  createdAt: TimestampSchema,
  children: z.array(CoreBatchChildReferenceSchema).min(1),
  batchManifestDigest: Sha256DigestSchema,
}).strict();

export type CoreBatchChildReference = z.infer<typeof CoreBatchChildReferenceSchema>;
export type CoreBatchManifest = z.infer<typeof CoreBatchManifestSchema>;

export const SaveCoreBatchRequestSchema = z.object({
  batchId: IdentifierSchema,
  createdAt: TimestampSchema,
  children: z.array(z.object({
    itemId: IdentifierSchema,
    runId: IdentifierSchema,
  }).strict()).min(1),
}).strict();

type ParsedSaveCoreBatchRequest = z.infer<typeof SaveCoreBatchRequestSchema>;
export type SaveCoreBatchRequest = Readonly<
  Omit<ParsedSaveCoreBatchRequest, 'children'> & {
    readonly children: readonly Readonly<ParsedSaveCoreBatchRequest['children'][number]>[];
  }
>;

export interface CoreBatchIndexCard {
  readonly batchId: string;
  readonly createdAt: string;
  readonly childCount: number;
  readonly batchManifestDigest: string;
}

export interface StoredCoreBatch {
  readonly manifest: CoreBatchManifest;
}

export interface CoreBatchArtifactStore {
  save(request: Readonly<SaveCoreBatchRequest>): Promise<StoredCoreBatch>;
  get(batchId: string): Promise<StoredCoreBatch | undefined>;
  list(): Promise<CoreBatchIndexCard[]>;
  exists(batchId: string): Promise<boolean>;
}

function assertCanonicalChildren(children: readonly CoreBatchChildReference[]): void {
  if (children.some((child, ordinal) => child.ordinal !== ordinal)
      || new Set(children.map((child) => child.itemId)).size !== children.length
      || new Set(children.map((child) => child.locator.runId)).size !== children.length) {
    throw new TypeError(
      'Core batch children require canonical ordinals and unique item and run identities.',
    );
  }
}

export function parseCoreBatchManifestDocument(value: unknown): CoreBatchManifest {
  const manifest = parseWireDocument(CoreBatchManifestSchema, value);
  assertCanonicalChildren(manifest.children);
  const { batchManifestDigest, ...payload } = manifest;
  if (digestCanonicalJson(payload) !== batchManifestDigest) {
    throw new TypeError('Core batch manifest digest does not match its payload.');
  }
  return deepFreezeCanonicalJson(manifest);
}

export function materializeCoreBatchManifest(
  input: Omit<CoreBatchManifest, 'batchManifestDigest'>,
): CoreBatchManifest {
  return parseCoreBatchManifestDocument({
    ...input,
    batchManifestDigest: digestCanonicalJson(input),
  });
}

export function projectCoreBatchIndexCard(
  manifest: CoreBatchManifest,
): CoreBatchIndexCard {
  return deepFreezeCanonicalJson({
    batchId: manifest.batchId,
    createdAt: manifest.createdAt,
    childCount: manifest.children.length,
    batchManifestDigest: manifest.batchManifestDigest,
  });
}
