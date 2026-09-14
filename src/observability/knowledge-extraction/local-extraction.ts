import type { EvidenceWindow } from './evidence.js';
import type { ExtractionProposal } from './proposals.js';

export const LOCAL_EXTRACTION_VERSION = 'knowledge-local-rules-v1' as const;

/** A deterministic excerpt selector, not a semantic model or an instruction runner. */
export function extractLocalProposals(excerpts: EvidenceWindow['excerpts']): ExtractionProposal[] {
  const proposals: ExtractionProposal[] = [];
  for (const excerpt of excerpts) {
    if (excerpt.role !== 'user' && excerpt.role !== 'assistant') continue;
    let fence: string | undefined;
    for (const match of excerpt.text.matchAll(/[^\r\n]+/g)) {
      const line = match[0];
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        continue;
      }
      if (fence) continue;
      const entry = /^\s*(?:[-*]\s+|\d+[.)]\s+)?(?:经验|规则|方法|教训|Lesson|Rule|Method)\s*[:：]\s*(\S.*)$/i.exec(line);
      if (!entry) continue;
      const quote = entry[1].trimEnd();
      if (quote.length > 4096) continue;
      const start = match.index + line.indexOf(entry[1]);
      const selection = { evidenceRef: excerpt.evidenceRef, start, end: start + quote.length, quote };
      const proposalId = `local-${proposals.length + 1}`;
      proposals.push({
        proposalId,
        draft: {
          title: quote.slice(0, 120),
          entities: [{ entityId: 'entry', label: '原文条目', description: '本条引用文本；尚未识别其中的业务实体。' }],
          content: {
            statements: [{
              statementId: 'assertion', subject: { entityId: 'entry' },
              relation: quote, modality: 'descriptive', polarity: 'positive',
              context: {
                scenario: '选定日志中明确标注的经验、规则或方法；仅摘录来源说法。',
                conditions: [], exceptions: [],
                unknowns: ['未做语义归纳、实体消歧或真伪判断；适用条件、例外及复用价值须结合原文人工核对。'],
                occurredDuring: { timeKind: 'unknown', reason: '消息时间不能证明陈述中的事件发生时间。' },
                validDuring: { timeKind: 'unknown', reason: '规则提取不能确定适用时间。' },
              },
            }],
            organization: { knowledgeKind: 'fact' },
          },
          evidence: [{ evidenceLinkId: 'source', evidenceRef: excerpt.evidenceRef, statementIds: ['assertion'],
            relation: 'background', basis: 'source_assertion', interpretation: '逐字摘录，未确认条目正确或可推广。' }],
        },
        mentions: [{ mentionId: 'entry', entityId: 'entry', selection, basis: 'explicit', rationale: '只绑定这一处原文条目，不推断或合并业务实体。' }],
        citations: [{ evidenceLinkId: 'source', selection }],
        reuseRationale: '原文明确标注为经验、规则或方法，可作为人工筛选复用知识的起点；不保证复用价值。',
        identityUncertainties: ['业务实体及别名尚未消解。'],
      });
      if (proposals.length === 12) return proposals;
    }
  }
  return proposals;
}
