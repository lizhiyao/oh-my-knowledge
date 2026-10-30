import { createHash } from 'node:crypto';
import { SourceDigestSchema, type SourceSnapshot } from '../sources.js';
import { canonicalJson } from '../store.js';

export const SOURCE_GENERATION_INPUT_VERSION = 'knowledge-source-generation-input/v1' as const;
export const SOURCE_IMPORT_RUN_IDENTITY = 'knowledge-source-set-import-run/v1' as const;

/** UUIDv8: a workspace's default import reuses its journal, including failed or unknown results. */
export function generationImportRunId(sourceSetId: string): string {
  SourceDigestSchema.parse(sourceSetId);
  const bytes = createHash('sha256').update(canonicalJson({ runIdentityVersion: SOURCE_IMPORT_RUN_IDENTITY, sourceSetId })).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Selected evidence and portable attribution only. Raw envelopes, host paths and capture time remain local. */
export function generationSourceInput(snapshot: SourceSnapshot, sourceOrdinal: number) {
  const origin = snapshot.sourceKind === 'agent_trace' ? snapshot.origin : undefined;
  return { sourceKey: `s${sourceOrdinal}`, source: {
    snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion, sourceKind: snapshot.sourceKind,
    identity: snapshot.identity, selection: snapshot.selection, material: snapshot.material, provenance: snapshot.provenance,
    ...(origin ? { origin: { threadId: origin.threadId, ...(origin.turnId === undefined ? {} : { turnId: origin.turnId }), title: origin.title } } : {}),
  }, excerpts: snapshot.excerpts, limitations: snapshot.limitations };
}
