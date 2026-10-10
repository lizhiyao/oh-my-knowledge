import { z } from 'zod';
import { ENTITY_CHECK_VERSION, reviewMentions, reviewSpan, type EntityReviewCase } from './entity-review-corpus.js';

// Consumer projections: production admission remains the sole structural validator.
export interface EntityReviewAdmission {
  analysis: {
    entities: { entityId: string; referentKind: string; identityStatus: string; possibleEntityIds: string[];
      componentRef: { entityId: string } | null; collection: { memberEntityIds: string[]; completeness: string } | null }[];
    mentions: { mentionId: string; entityId: string; selection: { evidenceRef: string; start: number; end: number } }[];
    rejected: unknown[];
  };
  accepted: { proposalId: string; draft: { content: { statements: { statementId: string; subject: { entityId: string };
    object?: { entityId: string }; relation: string; modality: string; polarity: string }[] }; evidence: { evidenceLinkId: string; statementIds: string[] }[] };
    citations: { evidenceLinkId: string; selection: { evidenceRef: string; start: number; end: number } }[] }[];
  rejected: unknown[];
}
const sameSpan = (a: { evidenceRef: string; start: number; end: number }, b: typeof a) =>
  a.evidenceRef === b.evidenceRef && a.start === b.start && a.end === b.end;
const covers = (a: { evidenceRef: string; start: number; end: number }, b: typeof a) =>
  a.evidenceRef === b.evidenceRef && a.start <= b.start && a.end >= b.end;
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

export function checkEntityReview(sample: EntityReviewCase, checked: EntityReviewAdmission) {
  const mentions = reviewMentions(sample).map(gold => {
    const exact = checked.analysis.mentions.filter(mention => gold.spans.some(span => sameSpan(mention.selection, span)));
    return { mentionKey: gold.mentionKey, entity: gold.entity, status: exact.length === 1 ? 'matched' : exact.length ? 'ambiguous' : 'missing',
      entityId: exact.length === 1 ? exact[0].entityId : null,
      boundaryCandidates: checked.analysis.mentions.filter(mention => gold.spans.some(span => covers(mention.selection, span))
        && !gold.spans.some(span => sameSpan(mention.selection, span))).map(mention => mention.mentionId) };
  });
  const groups = sample.entities.map(gold => {
    const members = mentions.filter(mention => mention.entity === gold.entityKey);
    const ids = [...new Set(members.flatMap(mention => mention.entityId ? [mention.entityId] : []))];
    return { entity: gold.entityKey, entityId: members.every(mention => mention.entityId) && ids.length === 1 ? ids[0] : null };
  });
  const mapped = (key: string) => groups.find(group => group.entity === key)?.entityId ?? null;
  const identityPairs = mentions.flatMap((left, index) => mentions.slice(index + 1).map(right => {
    const expected = left.entity === right.entity ? 'same' : 'different';
    return { left: left.mentionKey, right: right.mentionKey, expected,
      status: !left.entityId || !right.entityId ? 'not_evaluable'
        : (left.entityId === right.entityId) === (expected === 'same') ? 'matched' : expected === 'same' ? 'wrong_split' : 'wrong_merge' };
  }));
  const identities = sample.entities.map(gold => {
    const observed = checked.analysis.entities.find(entity => entity.entityId === mapped(gold.entityKey));
    if (!observed) return { entity: gold.entityKey, status: 'not_evaluable', problems: [] as string[] };
    const problems: string[] = [];
    if (!gold.referentKinds.includes(observed.referentKind as typeof gold.referentKinds[number])) problems.push('referent_kind');
    if (observed.identityStatus !== gold.identityStatus) problems.push('identity_status');
    const possible = gold.possibleEntities.map(mapped);
    const component = gold.component ? mapped(gold.component) : null;
    const members = gold.collection?.members.map(mapped) ?? [];
    const referencesMissing = possible.some(value => !value) || (gold.component && !component) || members.some(value => !value);
    if (!referencesMissing) {
      if (!sameSet(observed.possibleEntityIds, possible as string[])) problems.push('candidate_identities');
      if ((observed.componentRef?.entityId ?? null) !== component) problems.push('component');
      if (!!observed.collection !== !!gold.collection || (gold.collection && (!sameSet(observed.collection?.memberEntityIds ?? [], members as string[])
        || observed.collection?.completeness !== gold.collection.completeness))) problems.push('membership');
    }
    return { entity: gold.entityKey, status: problems.length ? 'mismatched' : referencesMissing ? 'not_evaluable' : 'matched', problems };
  });
  const roles = sample.roles.map(gold => {
    const anchor = reviewSpan(sample, gold.messageIndex, gold.anchor);
    const statements = checked.accepted.flatMap(proposal => proposal.draft.content.statements.flatMap(statement => {
      const links = proposal.draft.evidence.filter(link => link.statementIds.includes(statement.statementId));
      if (!proposal.citations.some(citation => links.some(link => link.evidenceLinkId === citation.evidenceLinkId) && covers(citation.selection, anchor))) return [];
      return [{ proposalId: proposal.proposalId, statementId: statement.statementId, subject: statement.subject.entityId,
        object: statement.object?.entityId ?? null, relation: statement.relation, modality: statement.modality, polarity: statement.polarity }];
    }));
    const subject = mapped(gold.subject); const object = gold.object ? mapped(gold.object) : null;
    // Endpoints and provenance provide candidates, never a keyword-based semantic verdict.
    const matched = statements.some(value => value.subject === subject && value.object === object);
    const reverse = !!subject && !!object && subject !== object && statements.some(value => value.subject === object && value.object === subject);
    return { roleKey: gold.roleKey, endpointStatus: !subject || (gold.object && !object) ? 'not_evaluable'
      : matched ? 'endpoints_matched' : reverse ? 'direction_conflict_needs_review' : statements.length ? 'needs_review' : 'not_observed',
    observed: statements, semanticReview: 'pending' };
  });
  const matched = mentions.filter(mention => mention.status === 'matched').length;
  return { checkVersion: ENTITY_CHECK_VERSION, criticalMentions: mentions,
    criticalMentionRecall: { matched, total: mentions.length, value: matched / mentions.length },
    precision: null, f1: null, annotationScope: 'critical_mentions', identityPairs, identities, roles,
    unexpectedKnowledge: sample.knowledgePolicy === 'none' && !!checked.accepted.length,
    unmatchedMentionsNeedReview: checked.analysis.mentions.filter(mention => !reviewMentions(sample).some(gold => gold.spans.some(span => sameSpan(mention.selection, span)))).map(mention => mention.mentionId),
    semanticReview: 'pending' };
}

export type ReviewOutcome = ReturnType<typeof reviewCapturedOutput>;
/** A Zod rejection of the response envelope is structural, not a JSON parse failure. */
export function reviewCapturedOutput(sample: EntityReviewCase, output: string,
  admit: (response: unknown) => EntityReviewAdmission) {
  let response: unknown;
  try { response = JSON.parse(output); } catch (error) {
    return { captureStatus: 'parse_failure' as const, failure: String(error), structuralRejections: [] as unknown[], checks: null };
  }
  let checked: EntityReviewAdmission;
  try { checked = admit(response); } catch (error) {
    if (!(error instanceof z.ZodError)) throw error; // Internal checker defects must stop the run.
    return { captureStatus: 'captured' as const, failure: null, structuralRejections: [{ component: 'envelope', issues: error.issues }], checks: null };
  }
  return { captureStatus: 'captured' as const, failure: null,
    structuralRejections: [...checked.analysis.rejected, ...checked.rejected], checks: checkEntityReview(sample, checked), checked };
}
