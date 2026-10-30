import { z } from 'zod';
import { KnowledgeActorSchema, KnowledgeBodyRefSchema, type KnowledgeActor } from './contracts.js';
import { SourceDigestSchema, SourceRefSchema } from './sources.js';

const id = z.string().min(1).max(256).refine(value => !!value.trim());
const uuid = z.string().uuid();
const text = z.string().min(1).max(32_768).refine(value => !!value.trim());
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
const reason = z.string().min(1).max(4096).refine(value => !!value.trim());
const strings = z.array(id).max(4096);
export const SourceReviewActorSchema = KnowledgeActorSchema.superRefine((actor, ctx) => {
  if (!actor.actorId.trim() || actor.actorKind === 'agent' && !actor.executionRef.trim()) ctx.addIssue({ code: 'custom', message: 'A trusted actual source review actor is required.' });
});
export const SourceReviewUnitKindSchema = z.enum(['source_metadata', 'excerpt_text']);
export const SourceReviewManifestSchema = z.strictObject({
  inputVersion: z.literal('knowledge-source-generation-input/v2'), sourceSetId: SourceDigestSchema, sourceInputDigest: SourceDigestSchema,
  sources: z.array(z.strictObject({ sourceKey: id, sourceRef: SourceRefSchema, snapshotDigest: SourceDigestSchema })).min(1).max(256),
  units: z.array(z.strictObject({ unitKey: id, sourceKey: id, unitKind: SourceReviewUnitKindSchema, evidenceRef: id.nullable(),
    utf16Length: count, textDigest: SourceDigestSchema, fieldPaths: strings })).min(1).max(100_256),
});
export type SourceReviewManifest = z.infer<typeof SourceReviewManifestSchema>;
/** A metadata quote locates host-delivered metadata text; it is never an excerpt quote. */
export const SourceReviewEvidenceSchema = z.strictObject({ unitKey: id, unitKind: SourceReviewUnitKindSchema,
  start: count, end: count, quote: text }).refine(value => value.end > value.start && value.quote.length === value.end - value.start, 'Invalid UTF-16 source review quote.');
const evidence = z.array(SourceReviewEvidenceSchema).max(256);
const disposition = z.enum(['retain', 'exclude', 'pending']);
export const SourceLedgerDataSchema = z.strictObject({
  manifest: SourceReviewManifestSchema,
  unitDispositions: z.array(z.strictObject({ unitKey: id, disposition, reason, itemIds: strings })).min(1).max(100_256),
  items: z.array(z.strictObject({ itemId: id, statement: text, disposition, reason, equivalentItemIds: strings, evidence,
    facets: z.array(z.strictObject({ facetId: id, statement: text, epistemicStatus: z.enum(['stated', 'explicit_unknown', 'not_stated', 'uncertain']), evidence })).max(4096) })).max(4096),
  limitations: z.array(reason).max(256),
});
export type SourceLedgerData = z.infer<typeof SourceLedgerDataSchema>;
/** Portable custody identity only; the extraction host resolves and verifies the original archive. */
export const SourceReviewModelOriginalSchema = z.strictObject({ runId: uuid, invocationId: uuid, requestDigest: SourceDigestSchema,
  archiveRef: id, archiveDigest: SourceDigestSchema, outputDigest: SourceDigestSchema });
const revision = { revisionId: uuid, parentRevisionId: uuid.nullable(), digest: SourceDigestSchema,
  modelOriginal: SourceReviewModelOriginalSchema, revisedAt: timestamp, revisedBy: SourceReviewActorSchema };
export const SourceLedgerRevisionSchema = z.strictObject({ ...revision, data: SourceLedgerDataSchema });
export const SourceLedgerRefSchema = z.strictObject({ ledgerId: uuid, revisionId: uuid, digest: SourceDigestSchema });
export type SourceLedgerRef = z.infer<typeof SourceLedgerRefSchema>;
export const SourceCoverageRefSchema = z.strictObject({ coverageId: uuid, revisionId: uuid, digest: SourceDigestSchema });
export type SourceCoverageRef = z.infer<typeof SourceCoverageRefSchema>;
export const SourceCoverageTargetSchema = z.discriminatedUnion('targetKind', [
  z.strictObject({ targetKind: z.literal('source_unit'), unitKey: id }),
  z.strictObject({ targetKind: z.literal('ledger_item'), itemId: id }),
  z.strictObject({ targetKind: z.literal('ledger_facet'), itemId: id, facetId: id }),
  z.strictObject({ targetKind: z.literal('body_segment'), bodyRef: KnowledgeBodyRefSchema, segmentId: id }),
]);
export const SourceReviewBodyEvidenceSchema = z.strictObject({ bodyRef: KnowledgeBodyRefSchema, segmentId: id,
  start: count, end: count, quote: text }).refine(value => value.end > value.start && value.quote.length === value.end - value.start, 'Invalid UTF-16 body review quote.');
export const SourceCoverageDataSchema = z.strictObject({
  manifest: SourceReviewManifestSchema, ledgerRef: SourceLedgerRefSchema, bodyRefs: z.array(KnowledgeBodyRefSchema).max(256),
  checks: z.array(z.strictObject({ checkId: id, target: SourceCoverageTargetSchema,
    coverageTarget: z.enum(['knowledge_meaning', 'preserved_source_declared_unknown', 'preserved_bounded_input_limitation', 'factual_value']),
    status: z.enum(['covered', 'partial', 'omitted', 'contradicted', 'not_retained', 'unassessable']),
    factualValue: z.enum(['known', 'unknown', 'not_applicable']), reason, sourceEvidence: evidence,
    bodyEvidence: z.array(SourceReviewBodyEvidenceSchema).max(256),
    boundedInput: z.strictObject({ sourceInputDigest: SourceDigestSchema, unitKeys: strings.min(1), inspectedFields: strings.min(1), scope: reason }).nullable(),
  })).min(1).max(100_256),
  findings: z.array(z.strictObject({ findingId: id, findingKind: z.enum(['ledger_omission', 'ledger_error', 'body_unsupported', 'body_omission', 'scope_error', 'other']),
    reason, sourceEvidence: evidence, bodyEvidence: z.array(SourceReviewBodyEvidenceSchema).max(256) })).max(4096),
  limitations: z.array(reason).max(256),
});
export type SourceCoverageData = z.infer<typeof SourceCoverageDataSchema>;
export const SourceCoverageRevisionSchema = z.strictObject({ ...revision, data: SourceCoverageDataSchema });
const binding = { coverageRef: SourceCoverageRefSchema, sourceSetId: SourceDigestSchema, ledgerRef: SourceLedgerRefSchema,
  bodyRefs: z.array(KnowledgeBodyRefSchema).max(256) };
export const SourceCoverageDecisionSchema = z.strictObject({ ...binding, decisionKind: z.enum(['proceed_with_limits', 'needs_revision', 'stop']), reason,
  limitations: z.array(reason).min(1).max(256),
  dispositions: z.array(z.strictObject({ unresolvedId: z.string().min(1).max(512), disposition: z.enum(['accepted_limit', 'resolved', 'blocks']), reason })).max(100_256),
  supersedesEventIds: z.array(uuid).max(4096),
});
export const SourceCoverageDecisionRefSchema = z.strictObject({ ...binding, eventId: uuid });
export type SourceCoverageDecisionRef = z.infer<typeof SourceCoverageDecisionRefSchema>;
const identity = { requestId: uuid, expectedGeneration: count, expectedHeadEventId: uuid.nullable() };
const ledgerAppend = { commandKind: z.literal('append_analysis'), ledgerId: uuid, revision: SourceLedgerRevisionSchema };
const coverageAppend = { commandKind: z.literal('append_analysis'), coverageId: uuid, revision: SourceCoverageRevisionSchema };
export const SourceLedgerWriteSchema = z.strictObject({ ...identity, ...ledgerAppend });
export const SourceCoverageWriteSchema = z.discriminatedUnion('commandKind', [
  z.strictObject({ ...identity, ...coverageAppend }),
  z.strictObject({ ...identity, commandKind: z.literal('record_decision'), coverageId: uuid, decision: SourceCoverageDecisionSchema }),
  z.strictObject({ ...identity, commandKind: z.literal('revoke_decision'), coverageId: uuid, targetEventId: uuid, reason }),
]);
const event = { eventId: uuid, parentEventId: uuid.nullable(), actor: SourceReviewActorSchema, at: timestamp };
export const SourceLedgerEventSchema = z.strictObject({ ...event, eventKind: z.literal('analysis'), revision: SourceLedgerRevisionSchema });
export const SourceCoverageEventSchema = z.discriminatedUnion('eventKind', [
  z.strictObject({ ...event, eventKind: z.literal('analysis'), revision: SourceCoverageRevisionSchema }),
  z.strictObject({ ...event, eventKind: z.literal('decision'), decision: SourceCoverageDecisionSchema }),
  z.strictObject({ ...event, eventKind: z.literal('revocation'), targetEventId: uuid, reason }),
]);
export const SourceReviewReceiptSchema = z.strictObject({ requestId: uuid, commandDigest: SourceDigestSchema, committedGeneration: count.min(1), eventId: uuid });
const history = { schemaVersion: z.literal(1), namespace: id, generation: count.min(1), writeHeadEventId: uuid,
  receipts: z.array(SourceReviewReceiptSchema).min(1).max(4096) };
export const SourceLedgerEnvelopeSchema = z.strictObject({ ...history, storeKind: z.literal('knowledge-source-ledger-history'), ledgerId: uuid,
  events: z.array(SourceLedgerEventSchema).min(1).max(4096) });
export const SourceCoverageEnvelopeSchema = z.strictObject({ ...history, storeKind: z.literal('knowledge-source-coverage-history'), coverageId: uuid,
  events: z.array(SourceCoverageEventSchema).min(1).max(4096) });
export type SourceLedgerRevision = z.infer<typeof SourceLedgerRevisionSchema>;
export type SourceCoverageRevision = z.infer<typeof SourceCoverageRevisionSchema>;
export type SourceLedgerWrite = z.infer<typeof SourceLedgerWriteSchema>;
export type SourceCoverageWrite = z.infer<typeof SourceCoverageWriteSchema>;
export type SourceLedgerEnvelope = z.infer<typeof SourceLedgerEnvelopeSchema>;
export type SourceCoverageEnvelope = z.infer<typeof SourceCoverageEnvelopeSchema>;
export type SourceReviewReceipt = z.infer<typeof SourceReviewReceiptSchema>;
export interface SourceLedgerStore {
  read(ledgerId: string): SourceLedgerEnvelope | undefined;
  write(command: SourceLedgerWrite, actor: KnowledgeActor, at: string, validate: () => void): SourceReviewReceipt;
}
export interface SourceCoverageStore {
  read(coverageId: string): SourceCoverageEnvelope | undefined;
  write(command: SourceCoverageWrite, actor: KnowledgeActor, at: string, validate: () => void): SourceReviewReceipt;
}
