import { z } from 'zod';
import { KnowledgeActorSchema } from '../contracts.js';

const id = z.string().uuid();
const text = z.string().trim().min(1).max(4096);
/** A confirmed organization link, never a replacement for the extracted entity. */
export const LibraryMemberSchema = z.strictObject({
  analysisId: id, entityId: id, entityRevisionId: id,
  mentionIds: z.array(id).min(1).max(64), rationale: text,
});
export type LibraryMember = z.infer<typeof LibraryMemberSchema>;
export const LibraryDraftSchema = z.strictObject({
  label: text.max(256), description: text,
  referentKind: z.enum(['object', 'component', 'instance', 'version', 'collection', 'plan', 'activity']),
  members: z.array(LibraryMemberSchema).max(256),
}).superRefine((draft, ctx) => {
  const keys = draft.members.map(member => `${member.analysisId}:${member.entityId}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Duplicate library member.' });
  for (const member of draft.members) {
    if (new Set(member.mentionIds).size !== member.mentionIds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate member evidence.' });
  }
});
export type LibraryDraft = z.infer<typeof LibraryDraftSchema>;
export const LibraryRevisionSchema = z.strictObject({
  revisionId: id, parentRevisionId: id.optional(), draft: LibraryDraftSchema,
  revisedAt: z.iso.datetime({ offset: true }), revisedBy: KnowledgeActorSchema, reason: text,
});
export const LibraryEnvelopeSchema = z.strictObject({
  storeKind: z.literal('knowledge-library-object-history'), schemaVersion: z.literal(1),
  objectId: id, generation: z.number().int().positive(), writeHeadRevisionId: id,
  revisions: z.array(LibraryRevisionSchema).min(1).max(256),
  receipts: z.array(z.strictObject({ requestId: id, commandDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    committedGeneration: z.number().int().positive(), revisionId: id })).min(1).max(256),
});
export type LibraryEnvelope = z.infer<typeof LibraryEnvelopeSchema>;
export const LibraryWriteSchema = z.strictObject({
  requestId: id, objectId: id, expectedGeneration: z.number().int().nonnegative(), expectedHeadRevisionId: id.nullable(),
  revision: LibraryRevisionSchema,
});
export type LibraryWrite = z.infer<typeof LibraryWriteSchema>;
export interface LibraryStore {
  list(): LibraryEnvelope[];
  read(objectId: string): LibraryEnvelope;
  /** Validation runs under the workspace lock, before an atomic publication. */
  write(command: LibraryWrite, validate: (existing: LibraryEnvelope | undefined, all: LibraryEnvelope[]) => void): LibraryEnvelope;
}
export const memberKey = (member: Pick<LibraryMember, 'analysisId' | 'entityId'>): string => `${member.analysisId}:${member.entityId}`;
