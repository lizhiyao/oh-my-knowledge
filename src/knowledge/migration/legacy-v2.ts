/** One-off v2 migration parser. Never imported by the current knowledge reader. */
import { z } from 'zod';
import { canonicalJson } from '../store.js';
import type { KnowledgeDraft as BodyDraft } from '../contracts.js';

const text = z.string().min(1).max(32_768).refine((value) => value.trim().length > 0);
const id = z.string().min(1).max(256);
const ids = z.array(id).max(256);
const timestamp = z.iso.datetime({ offset: true });
const bound = z.discriminatedUnion('boundKind', [
  z.strictObject({ boundKind: z.literal('known'), at: timestamp }),
  z.strictObject({ boundKind: z.literal('unbounded') }),
  z.strictObject({ boundKind: z.literal('unknown'), reason: text }),
]);

const KnowledgeTimeSchema = z.discriminatedUnion('timeKind', [
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
const KnowledgeContentSchema = z.strictObject({
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

const KnowledgeEvidenceLinkSchema = z.strictObject({
  evidenceLinkId: id, evidenceRef: id, statementIds: ids.min(1),
  relation: z.enum(['supports', 'opposes', 'background']),
  basis: z.enum(['direct_observation', 'source_assertion', 'inference']),
  interpretation: text,
});

/** Content shared by generated proposals and human edits; no lifecycle authority. */
const KnowledgeDraftSchema = z.strictObject({
  title: text,
  content: KnowledgeContentSchema,
  entities: z.array(z.strictObject({ entityId: id, label: text, description: text })).min(1).max(256),
  evidence: z.array(KnowledgeEvidenceLinkSchema).min(1).max(512),
});
type KnowledgeDraft = z.infer<typeof KnowledgeDraftSchema>;

const KnowledgeActorSchema = z.discriminatedUnion('actorKind', [
  z.strictObject({ actorKind: z.literal('human'), actorId: id }),
  z.strictObject({ actorKind: z.literal('agent'), actorId: id, executionRef: id }),
]);
const revisionRef = z.strictObject({ knowledgeId: id, revisionId: id });
const KnowledgeRevisionSchema = KnowledgeDraftSchema.extend({
  knowledgeId: id, revisionId: id, parentRevision: revisionRef.optional(),
  observationRefs: ids,
  derivations: z.array(z.strictObject({
    relation: z.enum(['derived_from', 'split_from', 'merged_from', 'replaces']),
    source: revisionRef, reason: text,
  })).max(256),
  createdAt: timestamp, createdBy: KnowledgeActorSchema,
  revisedAt: timestamp, revisedBy: KnowledgeActorSchema, revisionReason: text,
});

/** Positions use zero-based UTF-16 offsets into the exact registered excerpt. */
const EvidenceSelectionSchema = z.strictObject({
  evidenceRef: id, start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: text,
});
const EntityMentionSchema = z.strictObject({
  mentionId: id, entityId: id, selection: EvidenceSelectionSchema,
  basis: z.enum(['explicit', 'inference']), rationale: text,
});

const storeId = z.string().min(1).max(256);
const GroundingSchema = z.strictObject({
  revisionId: storeId,
  mentions: z.array(EntityMentionSchema).min(1).max(512),
  citations: z.array(z.strictObject({ evidenceLinkId: storeId, selection: EvidenceSelectionSchema })).min(1).max(512),
  sourceBindings: z.array(z.strictObject({ snapshotId: z.string().uuid(), sourceVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/), evidenceRefs: z.array(storeId).min(1) })).min(1),
  reuseRationale: z.string().min(1).max(4096),
  identityUncertainties: z.array(z.string().min(1).max(4096)).max(64),
  entityAnalysisRef: z.strictObject({ analysisId: z.string().uuid(), revisionId: z.string().uuid() }).optional(),
});
type KnowledgeGrounding = z.infer<typeof GroundingSchema>;
const MaintenanceSchema = z.strictObject({
  revisionId: storeId, choice: z.enum(['retain', 'discard']),
  actor: KnowledgeActorSchema, at: z.iso.datetime({ offset: true }), reason: z.string().min(1).max(4096),
});
const KnowledgeEnvelopeSchema = z.strictObject({
  storeKind: z.literal('knowledge-item-history'), schemaVersion: z.literal(2),
  namespace: storeId, knowledgeId: storeId, generation: z.number().int().positive(), writeHeadRevisionId: storeId,
  revisions: z.array(KnowledgeRevisionSchema).min(1),
  grounding: z.array(GroundingSchema).min(1),
  maintenance: z.array(MaintenanceSchema),
  receipts: z.array(z.strictObject({ requestId: storeId, commandDigest: z.string(), committedGeneration: z.number().int().positive(), revisionId: storeId })).min(1),
});
type KnowledgeEnvelope = z.infer<typeof KnowledgeEnvelopeSchema>;
interface KnowledgeValidationProblem {
  code: 'invalid_structure' | 'duplicate_id' | 'unknown_entity' | 'unknown_statement'
    | 'unknown_evidence' | 'uncovered_statement' | 'invalid_organization' | 'quote_mismatch';
  path: string;
}

/** Checks reference integrity only. Matching evidence never proves a claim true. */
function validateKnowledgeDraft(
  input: unknown,
  registeredEvidence: ReadonlySet<string>,
): { accepted: true; draft: KnowledgeDraft } | { accepted: false; problems: KnowledgeValidationProblem[] } {
  const parsed = KnowledgeDraftSchema.safeParse(input);
  if (!parsed.success) return {
    accepted: false,
    problems: parsed.error.issues.map((issue) => ({ code: 'invalid_structure', path: issue.path.join('.') })),
  };
  const draft = parsed.data;
  const problems: KnowledgeValidationProblem[] = [];
  const add = (code: KnowledgeValidationProblem['code'], path: string): void => { problems.push({ code, path }); };
  const unique = (values: string[], path: string): Set<string> => {
    const result = new Set(values);
    if (result.size !== values.length) add('duplicate_id', path);
    return result;
  };
  const entities = unique(draft.entities.map((entity) => entity.entityId), 'entities');
  const statements = unique(draft.content.statements.map((statement) => statement.statementId), 'content.statements');
  unique(draft.evidence.map((link) => link.evidenceLinkId), 'evidence');
  for (const [index, statement] of draft.content.statements.entries()) {
    for (const role of ['subject', 'object'] as const) {
      if (statement[role] && !entities.has(statement[role].entityId)) add('unknown_entity', `content.statements.${index}.${role}`);
    }
  }
  const covered = new Set<string>();
  for (const [index, link] of draft.evidence.entries()) {
    if (!registeredEvidence.has(link.evidenceRef)) add('unknown_evidence', `evidence.${index}.evidenceRef`);
    unique(link.statementIds, `evidence.${index}.statementIds`);
    for (const statementId of link.statementIds) {
      if (!statements.has(statementId)) add('unknown_statement', `evidence.${index}.statementIds`);
      covered.add(statementId);
    }
  }
  for (const statementId of statements) {
    if (!covered.has(statementId)) add('uncovered_statement', `content.statements.${statementId}`);
  }
  const organization = draft.content.organization;
  const groups = organization.knowledgeKind === 'case'
    ? [organization.actionStatementIds, organization.outcomeStatementIds]
    : organization.knowledgeKind === 'method' ? [organization.instructionStatementIds] : [];
  if (organization.knowledgeKind === 'case' && groups.every((group) => group.length === 0)) {
    add('invalid_organization', 'content.organization');
  }
  for (const group of groups) {
    unique(group, 'content.organization');
    for (const statementId of group) {
      const statement = draft.content.statements.find((item) => item.statementId === statementId);
      if (!statement) add('unknown_statement', 'content.organization');
      else if (organization.knowledgeKind === 'case' && statement.modality !== 'descriptive') {
        add('invalid_organization', 'content.organization');
      }
    }
  }
  return problems.length ? { accepted: false, problems } : { accepted: true, draft };
}

/** Structural grounding closure shared by model-output validation and persisted revisions.
 * Exact quote validation additionally needs the registered source excerpts.
 */
function validateGroundingReferences(draft: KnowledgeDraft,
  grounding: Pick<KnowledgeGrounding, 'mentions' | 'citations'>,
  registeredEvidence: ReadonlySet<string>): string[] {
  const reasons: string[] = [];
  const entities = new Set(draft.entities.map((entity) => entity.entityId));
  const mentioned = new Set<string>();
  const mentionIds = new Set<string>();
  for (const mention of grounding.mentions) {
    if (mentionIds.has(mention.mentionId)) reasons.push('duplicate_mention');
    mentionIds.add(mention.mentionId);
    if (!entities.has(mention.entityId)) reasons.push('unknown_mention_entity');
    mentioned.add(mention.entityId);
    if (!registeredEvidence.has(mention.selection.evidenceRef)) reasons.push('unknown_mention_evidence');
  }
  for (const entityId of entities) if (!mentioned.has(entityId)) reasons.push('entity_without_mention');
  const citedLinks = new Set<string>();
  for (const citation of grounding.citations) {
    const link = draft.evidence.find((entry) => entry.evidenceLinkId === citation.evidenceLinkId);
    if (!link || link.evidenceRef !== citation.selection.evidenceRef) reasons.push('citation_link_mismatch');
    citedLinks.add(citation.evidenceLinkId);
    if (!registeredEvidence.has(citation.selection.evidenceRef)) reasons.push('unknown_citation_evidence');
  }
  for (const link of draft.evidence) if (!citedLinks.has(link.evidenceLinkId)) reasons.push('link_without_citation');
  return reasons;
}

function validateKnowledgeHistory(entry: KnowledgeEnvelope): void {
  if (entry.generation !== entry.receipts.length
    || entry.writeHeadRevisionId !== entry.revisions.at(-1)!.revisionId
    || new Set(entry.receipts.map((r) => r.requestId)).size !== entry.receipts.length
    || entry.grounding.length !== entry.revisions.length) throw new Error('Invalid knowledge history.');
  const seen = new Set<string>();
  for (const [index, revision] of entry.revisions.entries()) {
    const previous = entry.revisions[index - 1];
    if (revision.knowledgeId !== entry.knowledgeId || seen.has(revision.revisionId)
      || (previous ? revision.parentRevision?.knowledgeId !== entry.knowledgeId || revision.parentRevision?.revisionId !== previous.revisionId : revision.parentRevision !== undefined)
      || canonicalJson(revision.createdBy) !== canonicalJson(entry.revisions[0].createdBy)
      || revision.createdAt !== entry.revisions[0].createdAt
      || Date.parse(revision.revisedAt) < Date.parse(revision.createdAt)) throw new Error('Invalid revision lineage.');
    if (!previous && (revision.createdAt !== revision.revisedAt
      || canonicalJson(revision.createdBy) !== canonicalJson(revision.revisedBy))) throw new Error('Invalid initial revision authorship.');
    seen.add(revision.revisionId);
    const grounding = entry.grounding[index];
    const draft = { title: revision.title, content: revision.content, entities: revision.entities, evidence: revision.evidence };
    const sourceRefs = grounding.sourceBindings.flatMap((source) => source.evidenceRefs);
    const registeredEvidence = new Set(sourceRefs);
    if (registeredEvidence.size !== sourceRefs.length
      || grounding.revisionId !== revision.revisionId
      || !validateKnowledgeDraft(draft, registeredEvidence).accepted
      || validateGroundingReferences(draft, grounding, registeredEvidence).length) throw new Error('Invalid revision references.');
  }
  for (const [index, receipt] of entry.receipts.entries()) {
    if (receipt.committedGeneration !== index + 1 || !seen.has(receipt.revisionId)) throw new Error('Invalid knowledge receipt.');
  }
  if (entry.maintenance.some((choice) => !seen.has(choice.revisionId))) throw new Error('Unknown maintenance target.');
}

export type LegacyKnowledgeEnvelope = KnowledgeEnvelope;
export function parseLegacyKnowledgeEnvelope(input: unknown): LegacyKnowledgeEnvelope {
  const envelope = KnowledgeEnvelopeSchema.parse(input);
  validateKnowledgeHistory(envelope);
  return envelope;
}
/** Mechanical projection retains the old typed claim verbatim; it is not re-extraction or semantic acceptance. */
export function legacyRevisionToBodyDraft(envelope: LegacyKnowledgeEnvelope, revisionId: string): BodyDraft {
  const revision = envelope.revisions.find(item => item.revisionId === revisionId);
  const grounding = envelope.grounding.find(item => item.revisionId === revisionId);
  if (!revision || !grounding) throw new Error('Unknown legacy revision.');
  const entities = new Map(revision.entities.map(item => [item.entityId, item]));
  return {
    title: revision.title,
    reuseRationale: grounding.reuseRationale,
    content: {
      organization: { knowledgeKind: revision.content.organization.knowledgeKind },
      segments: revision.content.statements.map(statement => ({
        segmentId: statement.statementId,
        text: [
          '迁移的旧结构化命题；尚未重新复核。',
          `主体：${JSON.stringify(entities.get(statement.subject.entityId))}`,
          `关系：${statement.relation}`,
          ...(statement.object ? [`对象：${JSON.stringify(entities.get(statement.object.entityId))}`] : []),
          `旧模态：${statement.modality}；旧极性：${statement.polarity}。`,
          `原直接上下文与时间：${JSON.stringify(statement.context)}`,
          `原组织信息：${JSON.stringify(revision.content.organization)}`,
          ...(grounding.identityUncertainties.length ? [`原修订的身份不确定性（本段仍适用，尚未确认）：${JSON.stringify(grounding.identityUncertainties)}`] : []),
        ].join('\n'),
        evidence: revision.evidence.filter(link => link.statementIds.includes(statement.statementId)).flatMap(link =>
          grounding.citations.filter(citation => citation.evidenceLinkId === link.evidenceLinkId).map(citation => {
            const sources = grounding.sourceBindings.filter(source => source.evidenceRefs.includes(link.evidenceRef));
            if (sources.length !== 1) throw new Error('Ambiguous legacy source binding.');
            return { source: { snapshotId: sources[0].snapshotId, sourceVersion: sources[0].sourceVersion },
              selection: citation.selection, basis: link.basis,
              interpretation: `旧证据关系：${link.relation}。${link.interpretation}` };
          })),
      })),
    },
  };
}
