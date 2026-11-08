import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SourceDigestSchema, SourceExcerptSchema, SourceIdentitySchema, SourceNamespaceSchema, SourceRefSchema, TraceOriginSchema, sourceSetPreimage, type SourceSnapshot } from '../sources.js';
import { canonicalJson } from '../store.js';
import { buildSourcePassages, SOURCE_PASSAGE_POLICY, SourcePassagesSchema, sourcePassageText, assertSourcePassageInput } from './source-passages.js';

export const SOURCE_GENERATION_INPUT_VERSION = 'knowledge-source-generation-input/v1' as const;
export const WRITING_DRAFT_INPUT_VERSION = 'knowledge-writing-draft-input/v1' as const;
export const BODY_GENERATION_INPUT_VERSION = 'knowledge-body-generation-input/v5' as const;
export const WORKFLOW_ID = 'knowledge-body-first/v11' as const;
export const SOURCE_IMPORT_RUN_IDENTITY = 'knowledge-source-set-import-run/v6' as const;

/** UUIDv8: reuse only this workflow's default journal, including failed or unknown results. */
export function generationImportRunId(sourceSetId: string): string {
  SourceDigestSchema.parse(sourceSetId);
  const bytes = createHash('sha256').update(canonicalJson({ runIdentityVersion: SOURCE_IMPORT_RUN_IDENTITY, workflowId: WORKFLOW_ID, sourceSetId })).digest().subarray(0, 16);
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

const portableTraceOriginSchema = TraceOriginSchema.omit({ cwd: true });
const portableSourceMetadataInputSchema = SourceRefSchema.extend({
  sourceKind: z.enum(['agent_trace', 'project_file', 'git_blob']),
  identity: z.record(z.string(), z.unknown()), origin: portableTraceOriginSchema.optional(),
}).loose();
export const GenerationSourceMetadataSchema = z.discriminatedUnion('sourceKind', [
  SourceRefSchema.extend({ sourceKind: z.literal('agent_trace'), origin: portableTraceOriginSchema.optional() }),
  SourceRefSchema.extend({ sourceKind: z.enum(['project_file', 'git_blob']), projectId: SourceNamespaceSchema }),
]);

/** Portable source attribution for read-only views. Raw evidence and host paths stay local. */
export function generationSourceMetadata(value: unknown): z.infer<typeof GenerationSourceMetadataSchema> {
  const { snapshotId, sourceVersion, sourceKind, identity, origin } = portableSourceMetadataInputSchema.parse(value);
  const source = SourceIdentitySchema.parse({ ...identity, sourceKind });
  return source.sourceKind === 'agent_trace'
    ? { snapshotId, sourceVersion, sourceKind: source.sourceKind, ...(origin ? { origin } : {}) }
    : { snapshotId, sourceVersion, sourceKind: source.sourceKind, projectId: source.projectId };
}

export function bodySourcePassages(sources: readonly SourceSnapshot[]) {
  const refs = sourceSetPreimage(sources.map(source => ({ snapshotId: source.snapshotId, sourceVersion: source.sourceVersion })));
  if (refs.sources.length !== sources.length) throw new Error('Duplicate body source.');
  const ordered = refs.sources.map(ref => sources.find(source => source.snapshotId === ref.snapshotId && source.sourceVersion === ref.sourceVersion)!);
  const index = buildSourcePassages(ordered.flatMap(source => source.excerpts.map(excerpt => ({ unitKey: excerpt.evidenceRef,
    source: { snapshotId: source.snapshotId, sourceVersion: source.sourceVersion }, text: excerpt.text }))), refs.sources);
  return { ordered, index };
}

/** Full source bytes, with offsets and the immutable passage table retained by the host. */
export function bodyGenerationSources(sources: readonly SourceSnapshot[]) {
  const { ordered, index } = bodySourcePassages(sources);
  return { passagePolicy: SOURCE_PASSAGE_POLICY.policyVersion, passageIndexDigest: index.digest,
    sources: ordered.map(generationSourceInput).map(source => ({ ...source,
      excerpts: source.excerpts.map(({ text, ...excerpt }) => {
        void text; return { ...excerpt, passages: index.passages.get(excerpt.evidenceRef)! };
      }) })) };
}

const bodyPassageInput = z.object({ inputVersion: z.literal(BODY_GENERATION_INPUT_VERSION),
  passagePolicy: z.literal(SOURCE_PASSAGE_POLICY.policyVersion), passageIndexDigest: SourceDigestSchema,
  sources: z.array(z.object({ source: z.object({ snapshotId: z.string().uuid(), sourceVersion: SourceDigestSchema }),
    excerpts: z.array(SourceExcerptSchema.omit({ text: true }).extend({ passages: SourcePassagesSchema })) })) });

/** Journal validation reconstructs the same deterministic table; stored labels are not trusted. */
export function assertBodyGenerationSources(value: unknown): void {
  const input = bodyPassageInput.parse(value);
  const units = input.sources.flatMap(source => source.excerpts.map(excerpt => ({ unitKey: excerpt.evidenceRef,
    source: source.source, text: sourcePassageText(excerpt.passages) })));
  const index = buildSourcePassages(units, input.sources.map(source => source.source));
  assertSourcePassageInput(index, input, input.sources.flatMap(source => source.excerpts.map(excerpt => ({
    unitKey: excerpt.evidenceRef, passages: excerpt.passages }))));
}
