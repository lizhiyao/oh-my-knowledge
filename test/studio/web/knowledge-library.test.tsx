import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LibraryObjectDetail } from '../../../src/studio/web/components/knowledge/library-detail.js';
import type { KnowledgeLibraryDetail } from '../../../src/studio/view-models/knowledge/knowledge-library.js';
import { draft } from '../../knowledge/fixtures.js';

function detail(): KnowledgeLibraryDetail {
  const knowledge = draft(); const member = { analysisId: 'analysis', entityId: 'project', entityRevisionId: 'entity-revision', mentionIds: ['mention'], rationale: '两个窗口说明同一项目' };
  const revision = { revisionId: 'organization-revision', draft: { label: 'Alpha <script>', description: '用户维护简介', referentKind: 'object' as const, members: [member] },
    revisedAt: '2026-10-12T00:00:00Z', revisedBy: { actorKind: 'human' as const, actorId: 'reviewer' }, reason: '核对关联' };
  return { history: { storeKind: 'knowledge-library-object-history', schemaVersion: 1, objectId: 'object', generation: 1,
    writeHeadRevisionId: revision.revisionId, revisions: [revision], receipts: [] }, revision,
    members: [{ ...member, status: 'available', entity: { ...knowledge.entities[0], label: 'Alpha <script>', qualifiers: ['仅本项目'], identityStatus: 'proposed',
      possibleEntityIds: [], uncertainties: [], referentKind: 'object', componentRef: null, collection: null }, current: false, sourceStatus: 'unavailable',
      evidence: [{ mentionId: 'mention', quote: 'Alpha', basis: 'explicit', rationale: '原文项目名称', positionStatus: 'unavailable' }],
      origin: { threadId: 'thread', title: '来源对话' } }],
    knowledge: [{ knowledgeId: 'knowledge', revisionId: 'knowledge-revision', title: '来源中关于 Alpha 的说法 <script>', choice: 'retain', associationStatus: 'matched',
      content: knowledge.content, entities: knowledge.entities, tags: ['排障'], revisedAt: '2026-10-12T00:00:00Z', revisionCount: 2,
      evidence: [{ basis: 'source_assertion', relation: 'supports', interpretation: '仅来源自述', statementIds: ['usage'] }], sourceStatus: 'unavailable',
      roles: [{ statementId: 'usage', role: 'subject' }], bindings: [{ ...member, confirmedEntityRevisionId: member.entityRevisionId, matchesRevision: true }] }],
    relatedEntities: [{ analysisId: 'analysis', entityId: 'tool', entityRevisionId: 'entity-revision', label: 'Beta', object: { objectId: 'other-object', label: '工具 Beta' } }],
    knowledgeStatus: 'available', counts: { retained: 1, pending: 0, discarded: 0, needsReview: 0 } };
}
const render = (value: KnowledgeLibraryDetail, lang: 'zh' | 'en', initialTab: 'knowledge' | 'sources' | 'history' = 'knowledge') => renderToStaticMarkup(createElement(LibraryObjectDetail, {
  detail: value, workspace: '/workspace <script>', lang, initialTab, onKnowledge() {}, onRevision() {},
}));

describe('knowledge library object views', () => {
  it('keeps object detail separate from canonical knowledge with exact source and related-object links', () => {
    for (const lang of ['zh', 'en'] as const) {
      const html = render(detail(), lang);
      expect(html).toContain(lang === 'zh' ? '相关知识' : 'Related knowledge');
      expect(html).toContain('来源中关于 Alpha 的说法 &lt;script&gt;');
      expect(html).toContain('object=other-object');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('选择知识：');
      const sources = render(detail(), lang, 'sources');
      expect(sources).toContain('href="/observe/conversations/thread?workspace=%2Fworkspace+%3Cscript%3E"');
      expect(sources).toContain('entity=project'); expect(sources).toContain('revision=entity-revision');
      expect(sources).toContain(lang === 'zh' ? '实体已有新修订' : 'Entity has a new revision');
      expect(sources).toContain(lang === 'zh' ? '原文不可用' : 'Source unavailable');
      expect(sources).toContain('原文项目名称');
    }
  });
  it('distinguishes organizational history and unresolved identity from knowledge truth', () => {
    const value = detail(); value.history.writeHeadRevisionId = 'newer';
    expect(render(value, 'zh')).toContain('不是过去时点的完整知识快照');
    value.knowledge[0].associationStatus = 'needs_review';
    expect(render(value, 'zh')).toContain('组织确认不一致');
    expect(render(value, 'en', 'history')).toContain('do not overwrite knowledge');
  });
  it('keeps unavailable knowledge distinct from a genuinely empty object', () => {
    const value = detail(); value.knowledgeStatus = 'unavailable'; value.knowledge = [];
    value.counts = { retained: null, pending: null, discarded: null, needsReview: null };
    const html = render(value, 'zh'); expect(html).toContain('数量未知'); expect(html).not.toContain('尚无关联知识');
    value.knowledgeStatus = 'available';
    expect(render(value, 'en')).toContain('No associated knowledge');
  });
});
