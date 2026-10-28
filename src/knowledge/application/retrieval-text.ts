import type { KnowledgeRetrievalResult } from './retrieval.js';

export const KNOWLEDGE_RETRIEVAL_TEXT_VIEW_ID = 'knowledge-body-text/v1' as const;
export const KNOWLEDGE_RETRIEVAL_TEXT_PACKING_ID = 'knowledge-body-text-packing/v1' as const;
const field = (value: unknown) => JSON.stringify(value);

/** A derived reading view. The CLI adds its one final LF; stored segment text is never rewritten. */
export function formatKnowledgeRetrievalText(result: KnowledgeRetrievalResult): string {
  const lines = [
    `viewKind: ${KNOWLEDGE_RETRIEVAL_TEXT_VIEW_ID}`,
    `packingPolicyId: ${KNOWLEDGE_RETRIEVAL_TEXT_PACKING_ID}`,
    `rankingPolicyId: ${result.rankingPolicyId}`,
    '派生正文视图；pending／retain 均不证明内容为真。segmentIndex 按保存顺序显示，从 0 开始。',
    'quoteDisplay: omitted（引文未显示；沿用相同 --workspace，用相同查询 retrieve --format json 或 show --id <knowledgeId> --revision <revisionId> --json 精确读回完整 evidence。）',
    `omitted: oversizedSegments=${result.omitted.oversizedSegments}, budgetSegments=${result.omitted.budgetSegments}`,
  ];
  if (result.scopeDiagnostics) lines.push(`scopeDiagnostics: ${field(result.scopeDiagnostics)}`);
  result.knowledge.forEach((knowledge, knowledgeIndex) => {
    const { bodyRef } = knowledge;
    lines.push('', `knowledgeId: ${field(bodyRef.knowledgeId)}`, `revisionId: ${field(bodyRef.revisionId)}`,
      `bodyDigest: ${bodyRef.bodyDigest}`, `generation: ${knowledge.generation}`, `title: ${field(knowledge.title)}`,
      `choice: ${knowledge.choice ?? 'pending'}; reviewStatus: ${knowledge.reviewStatus}`,
      `segments: ${knowledge.segmentScope.returned}/${knowledge.segmentScope.total}`,
      `derivedAssociations: ${knowledge.derivedAssociations.status}; reviewStatus: ${knowledge.derivedAssociations.reviewStatus}`);
    const items = result.items.filter(item => item.knowledge === knowledgeIndex).sort((a, b) => a.segmentIndex - b.segmentIndex);
    for (const item of items) {
      lines.push('', `segmentIndex: ${item.segmentIndex}; segmentId: ${field(item.segment.segmentId)}`, '正文：', item.segment.text, '依据定位（quote 未显示）：');
      item.segment.evidence.forEach((evidence, evidenceIndex) => {
        const check = item.evidenceChecks.find(check => check.evidenceIndex === evidenceIndex)!;
        const source = result.sources[check.source];
        const sourceStatus = source.status === 'available' ? `available; sourceKind=${source.sourceKind}` : `unavailable; reason=${field(source.reason)}`;
        lines.push(`evidenceIndex=${evidenceIndex}; snapshotId=${field(evidence.source.snapshotId)}; sourceVersion=${evidence.source.sourceVersion}; sourceStatus=${sourceStatus}`,
          `evidenceRef=${field(evidence.selection.evidenceRef)}; utf16=[${evidence.selection.start},${evidence.selection.end}); basis=${evidence.basis}; positionStatus=${check.positionStatus}`,
          `interpretation=${evidence.interpretation === undefined ? 'absent' : field(evidence.interpretation)}`);
      });
    }
  });
  lines.push('', `endView: ${KNOWLEDGE_RETRIEVAL_TEXT_VIEW_ID}`);
  return lines.join('\n');
}
