import type { KnowledgeDraft } from '../../src/knowledge/contracts.js';
import type { ExtractionProposal } from '../../src/observability/knowledge-extraction/proposals.js';
import type { WindowExtractionModel } from '../../src/observability/knowledge-extraction/window-proposals.js';

export function draft(): KnowledgeDraft {
  return {
    title: '项目 Alpha 使用工具 Beta',
    entities: [
      { entityId: 'project', label: 'Alpha', description: '本次日志中的项目' },
      { entityId: 'tool', label: 'Beta', description: '本次操作中的工具' },
    ],
    content: {
      statements: [{
        statementId: 'usage', subject: { entityId: 'project' }, object: { entityId: 'tool' },
        relation: '使用', modality: 'descriptive', polarity: 'positive',
        context: {
          scenario: '日志记录的一次任务', conditions: [], exceptions: [], unknowns: ['未记录版本'],
          occurredDuring: { timeKind: 'unknown', reason: '原文没有时间' },
          validDuring: { timeKind: 'unknown', reason: '未来适用范围尚未验证' },
        },
      }],
      organization: { knowledgeKind: 'fact' },
    },
    evidence: [{
      evidenceLinkId: 'link', evidenceRef: 'record-1', statementIds: ['usage'],
      relation: 'background', basis: 'inference', interpretation: '根据本次日志提出，待人工核对',
    }],
  };
}


export function proposal(): ExtractionProposal {
  const selection = { evidenceRef: 'record-1', start: 0, end: 5, quote: 'Alpha' };
  return {
    proposalId: 'candidate-1', draft: draft(),
    mentions: [
      { mentionId: 'm1', entityId: 'project', selection, basis: 'explicit', rationale: '项目名' },
      { mentionId: 'm2', entityId: 'tool', selection: { ...selection, start: 9, end: 13, quote: 'Beta' }, basis: 'explicit', rationale: '工具名' },
    ],
    citations: [{ evidenceLinkId: 'link', selection: { ...selection, end: 13, quote: 'Alpha 使用 Beta' } }],
    reuseRationale: '后续处理本项目的工具问题时参考', identityUncertainties: [],
  };
}


export function modelWindow(): WindowExtractionModel {
  const candidate = proposal();
  const quoteOnly = ({ evidenceRef, quote }: ExtractionProposal['citations'][number]['selection']) => ({ evidenceRef, quote });
  const { entities, ...content } = candidate.draft;
  return { responseKind: 'knowledge-extraction', schemaVersion: 4,
    entities: entities.map(entity => ({ ...entity, qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [],
      referentKind: 'object', componentRef: null, collection: null })),
    mentions: candidate.mentions.map(mention => ({ ...mention, selection: quoteOnly(mention.selection) })),
    proposals: [{ proposalId: candidate.proposalId, draft: content, entityIds: entities.map(entity => entity.entityId),
      mentionIds: candidate.mentions.map(mention => mention.mentionId), citations: candidate.citations.map(citation => ({ ...citation, selection: quoteOnly(citation.selection) })),
      reuseRationale: candidate.reuseRationale, identityUncertainties: candidate.identityUncertainties }],
  };
}

/** Distinct component, instance and collective identity in one immutable source window. */
export function identityWindow(): WindowExtractionModel {
  const packet = modelWindow();
  packet.entities[0].referentKind = 'component';
  packet.entities[1].referentKind = 'instance';
  packet.entities[1].componentRef = { entityId: 'project', mentionIds: ['m2'], rationale: '原文描述所属组件' };
  packet.entities.push({ ...packet.entities[0], entityId: 'group', label: '它们', description: '原文共同指代的两个对象',
    referentKind: 'collection', collection: { memberEntityIds: ['project', 'tool'], completeness: 'complete',
      mentionIds: ['m3'], rationale: '原文明示共同指代' } });
  packet.mentions.push({ mentionId: 'm3', entityId: 'group', basis: 'inference', rationale: '复数指代',
    selection: { evidenceRef: 'record-1', quote: '它们' } });
  return packet;
}
