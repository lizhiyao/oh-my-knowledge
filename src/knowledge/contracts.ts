import { z } from 'zod';

const text = z.string().min(1).max(32_768).refine((value) => value.trim().length > 0);
const id = z.string().min(1).max(256);
const ids = z.array(id).max(256);
const timestamp = z.iso.datetime({ offset: true });
const bound = z.discriminatedUnion('boundKind', [
  z.strictObject({ boundKind: z.literal('known'), at: timestamp }),
  z.strictObject({ boundKind: z.literal('unbounded') }),
  z.strictObject({ boundKind: z.literal('unknown'), reason: text }),
]);

export const KnowledgeTimeSchema = z.discriminatedUnion('timeKind', [
  z.strictObject({ timeKind: z.literal('unknown'), reason: text }),
  z.strictObject({ timeKind: z.literal('not_applicable'), reason: text }),
  z.strictObject({ timeKind: z.literal('instant'), at: timestamp }),
  z.strictObject({ timeKind: z.literal('interval'), start: bound, end: bound }),
]).superRefine((value, ctx) => {
  if (value.timeKind === 'interval' && value.start.boundKind === 'known'
    && value.end.boundKind === 'known' && Date.parse(value.start.at) >= Date.parse(value.end.at)) {
    ctx.addIssue({ code: 'custom', message: 'Interval start must precede end.' });
  }
});

/** Positions use zero-based UTF-16 offsets into the exact registered excerpt. */
export const EvidenceSelectionSchema = z.strictObject({
  evidenceRef: id, start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: text,
});
export type EvidenceSelection = z.infer<typeof EvidenceSelectionSchema>;
export interface EvidenceExcerpt { evidenceRef: string; text: string }
export const KnowledgeBodyEvidenceSchema = z.strictObject({
  source: z.strictObject({ snapshotId: z.string().uuid(), sourceVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
  selection: EvidenceSelectionSchema,
  basis: z.enum(['source_assertion', 'direct_observation', 'inference']),
  interpretation: text.optional(),
});
export type KnowledgeBodyEvidence = z.infer<typeof KnowledgeBodyEvidenceSchema>;
/** Each segment is a complete independently consumable unit. Titles and evidence never complete its meaning. */
export const KnowledgeContentSchema = z.strictObject({
  segments: z.array(z.strictObject({
    segmentId: id,
    text: z.string().min(1).refine(value => value.trim().length > 0),
    evidence: z.array(KnowledgeBodyEvidenceSchema).min(1),
  })).min(1),
  organization: z.strictObject({ knowledgeKind: z.enum(['fact', 'case', 'method']) }).optional(),
});
export const KnowledgeDraftSchema = z.strictObject({
  title: text, content: KnowledgeContentSchema, reuseRationale: text,
});
export type KnowledgeDraft = z.infer<typeof KnowledgeDraftSchema>;
export const KnowledgeBodyRefSchema = z.strictObject({
  knowledgeId: id, revisionId: id, bodyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type KnowledgeBodyRef = z.infer<typeof KnowledgeBodyRefSchema>;

export const KnowledgeActorSchema = z.discriminatedUnion('actorKind', [
  z.strictObject({ actorKind: z.literal('human'), actorId: id }),
  z.strictObject({ actorKind: z.literal('agent'), actorId: id, executionRef: id }),
]);
const revisionRef = z.strictObject({ knowledgeId: id, revisionId: id });
export const KnowledgeRevisionSchema = KnowledgeDraftSchema.extend({
  knowledgeId: id, revisionId: id, bodyDigest: KnowledgeBodyRefSchema.shape.bodyDigest, parentRevision: revisionRef.optional(),
  observationRefs: ids,
  derivations: z.array(z.strictObject({
    relation: z.enum(['derived_from', 'split_from', 'merged_from', 'replaces']),
    source: revisionRef, reason: text,
  })).max(256),
  createdAt: timestamp, createdBy: KnowledgeActorSchema,
  revisedAt: timestamp, revisedBy: KnowledgeActorSchema, revisionReason: text,
});
export type KnowledgeRevision = z.infer<typeof KnowledgeRevisionSchema>;
export type KnowledgeActor = z.infer<typeof KnowledgeActorSchema>;

export const EntityMentionSchema = z.strictObject({
  mentionId: id, entityId: id, selection: EvidenceSelectionSchema,
  basis: z.enum(['explicit', 'inference']), rationale: text,
});
export type EntityMention = z.infer<typeof EntityMentionSchema>;
