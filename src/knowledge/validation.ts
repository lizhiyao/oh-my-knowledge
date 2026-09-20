import {
  KnowledgeDraftSchema,
  type EvidenceExcerpt, type EvidenceSelection, type KnowledgeDraft,
} from './contracts.js';
import type { KnowledgeGrounding } from './store.js';

export interface KnowledgeValidationProblem {
  code: 'invalid_structure' | 'duplicate_id' | 'unknown_entity' | 'unknown_statement'
    | 'unknown_evidence' | 'uncovered_statement' | 'invalid_organization' | 'quote_mismatch';
  path: string;
}

/** Checks reference integrity only. Matching evidence never proves a claim true. */
export function validateKnowledgeDraft(
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

export function validateEvidenceSelection(
  selection: EvidenceSelection,
  excerpts: readonly EvidenceExcerpt[],
): KnowledgeValidationProblem[] {
  const matches = excerpts.filter((excerpt) => excerpt.evidenceRef === selection.evidenceRef);
  if (matches.length !== 1) return [{ code: 'unknown_evidence', path: selection.evidenceRef }];
  const source = matches[0].text;
  if (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)
    || selection.start < 0 || selection.end <= selection.start || selection.end > source.length
    || !selection.quote || source.slice(selection.start, selection.end) !== selection.quote) {
    return [{ code: 'quote_mismatch', path: selection.evidenceRef }];
  }
  return [];
}

/** Structural grounding closure shared by model validation and persisted revisions.
 * Exact quote validation additionally needs the registered source excerpts.
 */
export function validateGroundingReferences(draft: KnowledgeDraft,
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
