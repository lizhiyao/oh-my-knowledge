import type { KnowledgeDraft } from '../../src/knowledge/contracts.js';
import type { ExtractionProposal } from '../../src/observability/knowledge-extraction/proposals.js';

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

