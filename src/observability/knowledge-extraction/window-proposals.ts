import { z } from 'zod';
import { KnowledgeDraftSchema, type EvidenceExcerpt } from '../../knowledge/contracts.js';
import { admitEntities, EntityModelMentionSchema, EntityModelSchema, locateQuote, QuoteLocatorSchema, type AdmittedEntityAnalysis } from './entities.js';
import { checkExtractionResponse, extractionResponseChecker, type CheckedProposals, type ExtractionProposal } from './proposals.js';

const id = z.string().min(1).max(256);
const windowProposal = z.strictObject({
  proposalId: id, draft: KnowledgeDraftSchema.omit({ entities: true }),
  entityIds: z.array(id).min(1).max(256), mentionIds: z.array(id).min(1).max(512),
  citations: z.array(z.strictObject({ evidenceLinkId: id, selection: QuoteLocatorSchema })).min(1).max(512),
  reuseRationale: z.string().min(1).max(4096), identityUncertainties: z.array(z.string().min(1).max(4096)).max(64),
});
export const WindowExtractionModelSchema = z.strictObject({
  responseKind: z.literal('knowledge-extraction'), schemaVersion: z.literal(3),
  entities: z.array(EntityModelSchema).max(256), mentions: z.array(EntityModelMentionSchema).max(512),
  proposals: z.array(windowProposal).max(12),
});
export type WindowExtractionModel = z.infer<typeof WindowExtractionModelSchema>;
const rawResponse = WindowExtractionModelSchema.extend({
  entities: z.array(z.unknown()).max(256), mentions: z.array(z.unknown()).max(512), proposals: z.array(z.unknown()).max(12),
});
export interface CheckedWindowProposals extends CheckedProposals { analysis: AdmittedEntityAnalysis }

export function generatedExtractionResponseChecker(version: string) {
  return version === 'knowledge-extraction-v3' ? checkWindowExtractionResponse : extractionResponseChecker(version);
}

export function checkWindowExtractionResponse(input: unknown, excerpts: readonly EvidenceExcerpt[]): CheckedWindowProposals {
  const response = rawResponse.parse(input);
  const analysis = admitEntities(response.entities, response.mentions, excerpts);
  const entityById = new Map(analysis.entities.map(entity => [entity.entityId, entity]));
  const mentionById = new Map(analysis.mentions.map(mention => [mention.mentionId, mention]));
  const counts = new Map<string, number>();
  for (const candidate of response.proposals) {
    const parsed = id.safeParse(candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>).proposalId : undefined);
    if (parsed.success) counts.set(parsed.data, (counts.get(parsed.data) ?? 0) + 1);
  }
  const accepted: ExtractionProposal[] = []; const rejected: CheckedProposals['rejected'] = [];
  for (const [index, raw] of response.proposals.entries()) {
    const parsed = windowProposal.safeParse(raw);
    if (!parsed.success) { rejected.push({ index, reasons: parsed.error.issues.map(issue => `invalid_structure:${issue.path.join('.')}`) }); continue; }
    const candidate = parsed.data; const reasons: string[] = [];
    if (counts.get(candidate.proposalId) !== 1) reasons.push('duplicate_proposal');
    if (new Set(candidate.entityIds).size !== candidate.entityIds.length) reasons.push('duplicate_entity_reference');
    if (new Set(candidate.mentionIds).size !== candidate.mentionIds.length) reasons.push('duplicate_mention_reference');
    const entities = candidate.entityIds.flatMap(entityId => {
      const entity = entityById.get(entityId);
      if (!entity) { reasons.push('unknown_entity_analysis_reference'); return []; }
      return [{ entityId, label: entity.label, description: entity.description }];
    });
    const mentions = candidate.mentionIds.flatMap(mentionId => {
      const mention = mentionById.get(mentionId);
      if (!mention) { reasons.push('unknown_mention_analysis_reference'); return []; }
      return [mention];
    });
    const citations = candidate.citations.flatMap(citation => {
      const selection = locateQuote(citation.selection, excerpts);
      if (typeof selection === 'string') { reasons.push(`citation:${selection}`); return []; }
      return [{ ...citation, selection }];
    });
    if (reasons.length) { rejected.push({ index, reasons: [...new Set(reasons)] }); continue; }
    const uncertainties = [...new Set([...candidate.identityUncertainties,
      ...candidate.entityIds.flatMap(entityId => entityById.get(entityId)!.uncertainties)])];
    const checked = checkExtractionResponse({ proposals: [{ proposalId: candidate.proposalId,
      draft: { ...candidate.draft, entities }, mentions, citations,
      reuseRationale: candidate.reuseRationale, identityUncertainties: uncertainties }] }, excerpts);
    if (checked.rejected.length) rejected.push({ index, reasons: checked.rejected.flatMap(value => value.reasons) });
    else accepted.push(...checked.accepted);
  }
  return { analysis, accepted, rejected };
}
