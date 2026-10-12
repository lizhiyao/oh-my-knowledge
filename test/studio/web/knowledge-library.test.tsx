import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LibraryKnowledgeItem, LibraryObjectDetail } from '../../../src/studio/web/components/knowledge/library-detail.js';
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
const render = (value: KnowledgeLibraryDetail, lang: 'zh' | 'en', filter: 'retain' | 'pending' | 'needs_review' = 'retain') => renderToStaticMarkup(createElement(LibraryObjectDetail, {
  detail: value, workspace: '/workspace <script>', lang, filter, onFilter() {}, selected: [], onSelect() {}, onRevision() {},
}));

describe('knowledge library user views', () => {
  it('shows claims, conditions, sources and revision links in both languages without asserting verified truth', () => {
    for (const lang of ['zh', 'en'] as const) {
      const html = render(detail(), lang);
      expect(html).toContain(lang === 'zh' ? '积累的知识' : 'Accumulated knowledge');
      expect(html).toContain(lang === 'zh' ? '来源中的说法' : 'Source assertion');
      expect(html).toContain(lang === 'zh' ? '不代表真实性已验证' : 'do not verify truth');
      expect(html).toContain(lang === 'zh' ? '未记录额外条件，不代表普遍适用' : 'not universally applicable');
      expect(html).toContain('未记录版本'); expect(html).toContain('未来适用范围尚未验证');
      expect(html).toContain('id=knowledge'); expect(html).toContain('revision=knowledge-revision'); expect(html).toContain('object=other-object');
      expect(html).toContain('href="/observe/conversations/thread?workspace=%2Fworkspace+%3Cscript%3E"');
      expect(html).toContain('entity=project'); expect(html).toContain('revision=entity-revision');
      expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
      expect(html).toContain(lang === 'zh' ? '实体已有新修订' : 'Entity has a new revision');
      expect(html).toContain(lang === 'zh' ? '原文不可用' : 'Source unavailable');
    }
  });
  it('separates historical organization from current knowledge and prevents artifact selection from history or mismatched links', () => {
    const value = detail(); value.history.writeHeadRevisionId = 'newer';
    const historical = render(value, 'zh'); expect(historical).toContain('不是过去时点的完整知识快照'); expect(historical).not.toContain('选择知识：');
    value.history.writeHeadRevisionId = value.revision.revisionId; value.knowledge[0].associationStatus = 'needs_review';
    expect(render(value, 'zh')).toContain('尚无已保留知识');
    const html = render(value, 'zh', 'needs_review'); expect(html).toContain('组织确认不一致'); expect(html).not.toContain('选择知识：');
  });
  it('distinguishes unavailable knowledge and unknown counts from an empty retained collection', () => {
    const value = detail(); value.knowledgeStatus = 'unavailable'; value.knowledge = [];
    value.counts = { retained: null, pending: null, discarded: null, needsReview: null };
    const html = render(value, 'zh'); expect(html).toContain('数量未知'); expect(html).toContain('已保留 —'); expect(html).not.toContain('尚无已保留知识');
    value.knowledgeStatus = 'available'; value.counts = { retained: 0, pending: 0, discarded: 0, needsReview: 0 };
    expect(render(value, 'en')).toContain('No retained knowledge');
  });
  it('keeps negative claims, method instructions, evidence classification and selection limits visible', () => {
    const item = detail().knowledge[0]; item.content.statements[0].polarity = 'negative';
    item.content.organization = { knowledgeKind: 'method', purpose: '保留适用条件', instructionStatementIds: ['usage'] };
    const html = renderToStaticMarkup(createElement(LibraryKnowledgeItem, { item, workspace: '/space', lang: 'zh', selectable: true, selected: false, selectionFull: true, onSelect() {} }));
    expect(html).toContain('否定主张'); expect(html).toContain('方法步骤'); expect(html).toContain('方法目的'); expect(html).toContain('来源中的说法');
    expect(html).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*disabled="")[^>]*>/);
  });
});
