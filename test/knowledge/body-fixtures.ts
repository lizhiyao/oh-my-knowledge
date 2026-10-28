import type { KnowledgeDraft } from '../../src/knowledge/contracts.js';
import type { KnowledgeWrite } from '../../src/knowledge/store.js';
import { knowledgeBodyDigest } from '../../src/knowledge/adapters/body-digest.js';
export const bodyActor = { actorKind: 'human' as const, actorId: 'local-user' };
export const bodyAt = '2026-09-14T00:00:00Z';
export function bodyDraft(): KnowledgeDraft {
  return { title: '限定范围内的来源报告', reuseRationale: '后续同类任务可据此核对，尚未独立验证。', content: {
    segments: [{ segmentId: 's1', text: '报告者称在选定测试环境中采用 Alpha；版本和事实发生时间未知，不能推广到其他环境。', evidence: [{
      source: { snapshotId: 'b4165dab-60b1-4f34-a9ea-e73bfa32c35d', sourceVersion: `sha256:${'a'.repeat(64)}` },
      selection: { evidenceRef: 'record-1', start: 0, end: 5, quote: 'Alpha' }, basis: 'source_assertion',
    }] }], organization: { knowledgeKind: 'fact' },
  } };
}
export function bodyWrite(): Extract<KnowledgeWrite, { commandKind: 'append_revision' }> {
  const draft = bodyDraft();
  return { commandKind: 'append_revision', requestId: 'request-1', knowledgeId: 'knowledge-1', expectedGeneration: 0, expectedHeadRevisionId: null,
    revision: { ...draft, knowledgeId: 'knowledge-1', revisionId: 'revision-1', bodyDigest: knowledgeBodyDigest(draft),
      observationRefs: [], derivations: [], createdAt: bodyAt, revisedAt: bodyAt, createdBy: bodyActor, revisedBy: bodyActor, revisionReason: '首次正文保存' } };
}
