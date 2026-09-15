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

const context = z.strictObject({
  scenario: text,
  conditions: z.array(text).max(64),
  exceptions: z.array(text).max(64),
  unknowns: z.array(text).max(64),
  occurredDuring: KnowledgeTimeSchema,
  validDuring: KnowledgeTimeSchema,
});
const entityRef = z.strictObject({ entityId: id });
export const KnowledgeContentSchema = z.strictObject({
  statements: z.array(z.strictObject({
    statementId: id,
    subject: entityRef,
    relation: text,
    object: entityRef.optional(),
    modality: z.enum(['descriptive', 'normative', 'capability', 'permission']),
    polarity: z.enum(['positive', 'negative']),
    context,
  })).min(1).max(256),
  organization: z.discriminatedUnion('knowledgeKind', [
    z.strictObject({ knowledgeKind: z.literal('fact') }),
    z.strictObject({
      knowledgeKind: z.literal('case'), situation: text,
      actionStatementIds: ids, outcomeStatementIds: ids, gaps: z.array(text).max(64),
    }),
    z.strictObject({ knowledgeKind: z.literal('method'), purpose: text, instructionStatementIds: ids.min(1) }),
  ]),
});

export const KnowledgeEvidenceLinkSchema = z.strictObject({
  evidenceLinkId: id, evidenceRef: id, statementIds: ids.min(1),
  relation: z.enum(['supports', 'opposes', 'background']),
  basis: z.enum(['direct_observation', 'source_assertion', 'inference']),
  interpretation: text,
});

/** Content shared by generated proposals and human edits; no lifecycle authority. */
export const KnowledgeDraftSchema = z.strictObject({
  title: text,
  content: KnowledgeContentSchema,
  entities: z.array(z.strictObject({ entityId: id, label: text, description: text })).min(1).max(256),
  evidence: z.array(KnowledgeEvidenceLinkSchema).min(1).max(512),
});
export type KnowledgeDraft = z.infer<typeof KnowledgeDraftSchema>;

export const KnowledgeActorSchema = z.discriminatedUnion('actorKind', [
  z.strictObject({ actorKind: z.literal('human'), actorId: id }),
  z.strictObject({ actorKind: z.literal('agent'), actorId: id, executionRef: id }),
]);
const revisionRef = z.strictObject({ knowledgeId: id, revisionId: id });
export const KnowledgeRevisionSchema = KnowledgeDraftSchema.extend({
  knowledgeId: id, revisionId: id, parentRevision: revisionRef.optional(),
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

/** Positions use zero-based UTF-16 offsets into the exact registered excerpt. */
export const EvidenceSelectionSchema = z.strictObject({
  evidenceRef: id, start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: text,
});
export type EvidenceSelection = z.infer<typeof EvidenceSelectionSchema>;
export interface EvidenceExcerpt {
  evidenceRef: string;
  text: string;
}

export const EntityMentionSchema = z.strictObject({
  mentionId: id, entityId: id, selection: EvidenceSelectionSchema,
  basis: z.enum(['explicit', 'inference']), rationale: text,
});
export type EntityMention = z.infer<typeof EntityMentionSchema>;
