import type { CarrierKnowledgeRef, CarrierKnowledgeReview, CarrierKnowledgeCheck } from './library-contracts.js';
import { renderCarrierKnowledge, type CarrierKnowledge } from './knowledge-content.js';

interface ReviewKnowledge extends CarrierKnowledge { choice: 'retain' | 'discard' | null; sourceAvailable: boolean }

/** Compare exact incorporated revisions with current knowledge, without changing either snapshot. */
export function reviewCarrierKnowledge(refs: CarrierKnowledgeRef[], read: (id: string, revisionId?: string) => ReviewKnowledge, lang: 'zh' | 'en', checkedAt: string, includeContent = true): CarrierKnowledgeReview {
  const checks: CarrierKnowledgeCheck[] = refs.map(ref => {
    const safeRead = (revisionId?: string) => { try { return read(ref.knowledgeId, revisionId); } catch { return null; } };
    const current = safeRead(), incorporated = current?.revision.revisionId === ref.revisionId ? current : safeRead(ref.revisionId);
    const reasons: CarrierKnowledgeCheck['reasons'] = [];
    if (!incorporated) reasons.push('incorporated_unavailable');
    if (!current) reasons.push('current_unavailable');
    if (current && current.revision.revisionId !== ref.revisionId) reasons.push('revision_changed');
    if (current && current.choice !== 'retain') reasons.push('not_retained');
    if (incorporated && !incorporated.sourceAvailable || current && !current.sourceAvailable) reasons.push('source_unavailable');
    const changedFields: CarrierKnowledgeCheck['changedFields'] = [];
    if (incorporated && current) {
      const grounding = (item: ReviewKnowledge) => ({ sourceBindings: item.grounding.sourceBindings, citations: item.grounding.citations, entityAnalysisRef: item.grounding.entityAnalysisRef, reuseRationale: item.grounding.reuseRationale, identityUncertainties: item.grounding.identityUncertainties });
      const pairs = { title: [incorporated.revision.title, current.revision.title], statements: [incorporated.revision.content.statements, current.revision.content.statements], organization: [incorporated.revision.content.organization, current.revision.content.organization], entities: [incorporated.revision.entities, current.revision.entities], evidence: [incorporated.revision.evidence, current.revision.evidence], grounding: [grounding(incorporated), grounding(current)] };
      for (const field of Object.keys(pairs) as CarrierKnowledgeCheck['changedFields']) if (JSON.stringify(pairs[field][0]) !== JSON.stringify(pairs[field][1])) changedFields.push(field);
    }
    return { knowledgeId: ref.knowledgeId, title: current?.revision.title ?? incorporated?.revision.title ?? ref.knowledgeId,
      incorporatedRevisionId: ref.revisionId, currentRevisionId: current?.revision.revisionId ?? null, currentChoice: current?.choice ?? null, reasons, changedFields,
      incorporatedContent: includeContent && reasons.length && incorporated ? renderCarrierKnowledge([incorporated], lang) : null,
      currentContent: includeContent && reasons.length && current ? renderCarrierKnowledge([current], lang) : null };
  });
  return { checkedAt, referenceCount: checks.length, needsReviewCount: checks.filter(check => check.reasons.length).length,
    unavailableCount: checks.filter(check => check.reasons.some(reason => reason.endsWith('unavailable'))).length, checks };
}
