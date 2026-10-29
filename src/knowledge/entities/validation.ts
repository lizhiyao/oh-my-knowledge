import type { EntityAnalysisDraft } from './contracts.js';
import { canonicalJson } from '../store.js';
import { entityIdentityProblems, entityIdentityReferenceProblems } from './identity.js';
import type { EvidenceExcerpt, EvidenceSelection } from '../contracts.js';
import { validateEvidenceSelection } from '../validation.js';

function adjacentIdentifierText(source: string, index: number, step: 1 | -1): boolean {
  for (; index >= 0 && index < source.length; index += step) {
    if (/[A-Za-z0-9]/.test(source[index])) return true;
    if (!/[_$]/.test(source[index])) return false;
  }
  return false;
}

type MentionExcerpt = EvidenceExcerpt & { eventKind?: string };

function escapedToolUrlBoundary(selection: EvidenceSelection, excerpt: MentionExcerpt): boolean {
  // Some tool returns retain a serialized separator instead of an actual tab/newline.
  // Recognize only one literal backslash before a complete HTTP(S)-shaped mention;
  // doubled or longer backslashes stay conservative, without interpreting JSON escapes.
  return excerpt.eventKind === 'tool_result'
    && /^https?:\/\/[^/?#\s"'<>]+(?:[/?#][^\s"'<>]*)?$/iu.test(selection.quote)
    && ['\\t', '\\n', '\\r'].includes(excerpt.text.slice(selection.start - 2, selection.start))
    && excerpt.text[selection.start - 3] !== '\\';
}

/** Reject an ASCII identifier fragment, without treating lexical boundaries as semantic verification. */
export function validateEntityMentionSelection(selection: EvidenceSelection, excerpts: readonly MentionExcerpt[]): string[] {
  const problems = validateEvidenceSelection(selection, excerpts).map(problem => problem.code);
  if (problems.length) return problems;
  const excerpt = excerpts.find(excerpt => excerpt.evidenceRef === selection.evidenceRef)!;
  const source = excerpt.text;
  // Underscores/dollar signs alone can be markup; an adjacent identifier must contain a letter or digit.
  const cutsStart = /^[A-Za-z0-9_$]/.test(selection.quote)
    && adjacentIdentifierText(source, selection.start - 1, -1) && !escapedToolUrlBoundary(selection, excerpt);
  const cutsEnd = /[A-Za-z0-9_$]$/.test(selection.quote)
    && adjacentIdentifierText(source, selection.end, 1);
  return cutsStart || cutsEnd ? ['mention_identifier_fragment'] : [];
}

/** Reference closure is structural admission, never semantic identity verification. */
export function validateEntityAnalysis(draft: EntityAnalysisDraft): string[] {
  const problems: string[] = [];
  const ids = new Set(draft.entities.map(entity => entity.entityId));
  if (ids.size !== draft.entities.length) problems.push('duplicate_entity');
  const mentions = new Set(draft.mentions.map(mention => mention.mentionId));
  if (mentions.size !== draft.mentions.length) problems.push('duplicate_mention');
  const positions = new Set<string>();
  const byId = new Map(draft.entities.map(entity => [entity.entityId, entity]));
  for (const mention of draft.mentions) {
    if (!ids.has(mention.entityId)) problems.push('unknown_entity');
    if (mention.selection.start >= mention.selection.end
      || mention.selection.end - mention.selection.start !== mention.selection.quote.length) problems.push('invalid_selection');
    const position = canonicalJson([mention.selection.evidenceRef, mention.selection.start, mention.selection.end]);
    if (positions.has(position)) problems.push('duplicate_mention_position');
    positions.add(position);
  }
  for (const entity of draft.entities) {
    problems.push(...entityIdentityProblems(entity), ...entityIdentityReferenceProblems(entity, byId, draft.mentions));
    if (!draft.mentions.some(mention => mention.entityId === entity.entityId)) problems.push('entity_without_mention');
    if (new Set(entity.possibleEntityIds).size !== entity.possibleEntityIds.length) problems.push('duplicate_possible_entity');
    for (const target of entity.possibleEntityIds) {
      if (!ids.has(target) || target === entity.entityId) problems.push('unknown_possible_entity');
      else if (draft.entities.find(candidate => candidate.entityId === target)?.identityStatus !== 'proposed') problems.push('unresolved_possible_entity');
    }
  }
  return [...new Set(problems)];
}
