import type { KnowledgeRetrievalResult } from './retrieval.js';

export const KNOWLEDGE_RETRIEVAL_TEXT_VIEW_ID = 'knowledge-body-text/v2' as const;
export const KNOWLEDGE_RETRIEVAL_TEXT_PACKING_ID = 'knowledge-body-text-packing/v2' as const;
const field = (value: unknown) => JSON.stringify(value);

/** A derived reading view. The CLI adds its one final LF; stored segment text is never rewritten. */
export function formatKnowledgeRetrievalText(result: KnowledgeRetrievalResult): string {
  const interpretations = new Map<string, number>();
  for (const item of result.items) for (const evidence of item.segment.evidence) {
    if (evidence.interpretation !== undefined && !interpretations.has(evidence.interpretation)) {
      interpretations.set(evidence.interpretation, interpretations.size);
    }
  }
  const lines = [
    `viewKind: ${KNOWLEDGE_RETRIEVAL_TEXT_VIEW_ID}`,
    `packingPolicyId: ${KNOWLEDGE_RETRIEVAL_TEXT_PACKING_ID}`,
    `rankingPolicyId: ${result.rankingPolicyId}`,
    '派生正文视图；pending／retain 与定位匹配均不证明内容为真。segmentIndex 从 0 开始。独立复核请用 review-status 读取精确 bodyRef。',
    'quoteDisplay: omitted（完整引文、evidenceRef、UTF-16 定位沿用相同 --workspace，用 show --id <knowledgeId> --revision <revisionId> --json 按 segmentId／evidenceIndex 精确读回。）',
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
      lines.push('', `segmentIndex: ${item.segmentIndex}; segmentId: ${field(item.segment.segmentId)}`, '正文：', item.segment.text, '依据（source／interpretation 为本视图下表索引；quote 未显示）：');
      item.segment.evidence.forEach((evidence, evidenceIndex) => {
        const check = item.evidenceChecks.find(check => check.evidenceIndex === evidenceIndex)!;
        lines.push(`evidenceIndex=${evidenceIndex}; source=S${check.source}; basis=${evidence.basis}; positionStatus=${check.positionStatus}; interpretation=${evidence.interpretation === undefined ? 'absent' : `I${interpretations.get(evidence.interpretation)}`}`);
      });
    }
  });
  lines.push('', 'sources:');
  result.sources.forEach((source, index) => {
    const status = source.status === 'available' ? `available; sourceKind=${source.sourceKind}` : `unavailable; reason=${field(source.reason)}`;
    lines.push(`S${index}: snapshotId=${field(source.snapshotId)}; sourceVersion=${source.sourceVersion}; sourceStatus=${status}`);
  });
  lines.push('', 'interpretations:');
  for (const [interpretation, index] of interpretations) lines.push(`I${index}: ${field(interpretation)}`);
  lines.push('', `endView: ${KNOWLEDGE_RETRIEVAL_TEXT_VIEW_ID}`);
  return lines.join('\n');
}
