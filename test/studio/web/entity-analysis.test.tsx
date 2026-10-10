import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EntityAnalysisContext, EntityAnalysisEditor, EntityAnalysisSummary } from '../../../src/studio/web/components/knowledge/entity-analysis.js';
import { EntityKnowledgeRoles } from '../../../src/studio/web/components/knowledge/apply-entities.js';
import { EntityLibraryDetail } from '../../../src/studio/web/components/knowledge/entities.js';
import { KnowledgeCandidateStart } from '../../../src/studio/web/components/knowledge/candidates.js';
import type { KnowledgeCandidateRun, KnowledgeEntityAnalysisDetail } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
import { draft } from '../../knowledge/fixtures.js';

const revision = { revisionId: 'revision-1', revisedAt: '2026-10-08T00:00:00Z', revisedBy: { actorKind: 'agent' as const, actorId: 'fixture', executionRef: 'run' }, revisionReason: '等待核对', limitations: ['仅所选消息'],
  entities: [{ entityId: 'project', label: 'Alpha <script>alert(1)</script>', description: '本次项目', qualifiers: ['测试环境'], identityStatus: 'proposed' as const, possibleEntityIds: [], uncertainties: [], referentKind: 'object' as const, componentRef: null, collection: null },
    { entityId: 'unknown', label: '这个项目', description: '不能确定的对象', qualifiers: [], identityStatus: 'unresolved' as const, possibleEntityIds: ['project'], uncertainties: ['无法从窗口确定'], referentKind: 'object' as const, componentRef: null, collection: null }],
  mentions: [{ mentionId: 'mention-1', entityId: 'project', selection: { evidenceRef: 'record-1', start: 0, end: 5, quote: 'Alpha' }, basis: 'explicit' as const, rationale: '项目名称' }] };
const detail: KnowledgeEntityAnalysisDetail = { revision, history: { storeKind: 'entity-analysis-history', schemaVersion: 2,
  analysisId: 'analysis', snapshotId: 'snapshot', sourceVersion: `sha256:${'a'.repeat(64)}`, generation: 1, writeHeadRevisionId: revision.revisionId, revisions: [revision],
  receipts: [{ requestId: 'request', commandDigest: 'digest', committedGeneration: 1, revisionId: revision.revisionId }] },
  source: { status: 'available', excerpts: [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta', recordIndex: 0, eventKind: 'message', role: 'user' }], limitations: ['仅所选消息'] } };
const run: KnowledgeCandidateRun = { runId: 'analysis', status: 'completed', committed: [], rejections: [],
  entityAnalysis: { analysisId: 'analysis', revisionId: 'revision-1', entityCount: 2, mentionCount: 1, unresolvedCount: 1, rejectedCount: 0 } };

describe('entity analysis user views', () => {
  it('offers entity inspection with zero knowledge candidates and describes counts without asserting semantic accuracy', () => {
    const html = renderToStaticMarkup(createElement(EntityAnalysisSummary, { run, lang: 'zh', onOpen() {} }));
    expect(html).toContain('2 个对象，1 处提及，1 个身份待确定'); expect(html).toContain('结构接纳'); expect(html).toContain('核对实体与指代');
    const start = renderToStaticMarkup(createElement(KnowledgeCandidateStart, { latest: run, lang: 'zh', loading: false, busy: false, onChoose() {}, onHistory() {}, onEntities() {} }));
    expect(start).toContain('返回 0 条候选'); expect(start).toContain('核对实体与指代');
    expect(renderToStaticMarkup(createElement(EntityAnalysisSummary, { run: { ...run, entityAnalysis: undefined }, lang: 'zh', onOpen() {} }))).toBe('');
  });
  it('shows provenance and unavailable source limits in both languages', () => {
    for (const lang of ['zh', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(EntityAnalysisContext, { detail: { ...detail, source: { status: 'unavailable', reason: 'deleted', detail: 'Snapshot deleted.' } }, lang }));
      expect(html).toContain(lang === 'zh' ? '不能重新核对或纠正' : 'rechecking and corrections are unavailable');
      expect(html).toContain('2026-10-08 00:00:00 UTC'); expect(html).toContain('等待核对'); expect(html).toContain('仅所选消息');
    }
  });
  it('renders inspectable entity details, assignment rationale and correction controls while escaping external text', () => {
    const html = renderToStaticMarkup(createElement(EntityAnalysisEditor, { detail, draft: { entities: revision.entities, mentions: revision.mentions }, editable: true, lang: 'zh', onChange() {} }));
    expect(html).toContain('新增对象／拆分对象'); expect(html).toContain('删除误识别提及'); expect(html).toContain('这一处对应哪个对象'); expect(html).toContain('对应依据');
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain('项目名称');
    const readonly = renderToStaticMarkup(createElement(EntityAnalysisEditor, { detail, draft: { entities: revision.entities, mentions: revision.mentions }, editable: false, lang: 'en', onChange() {} }));
    expect(readonly).toMatch(/<button[^>]*disabled=""[^>]*><span>Add or split an entity/);
  });
  it('offers membership correction and source navigation while requiring explicit unlinking before destructive edits', () => {
    const entities = structuredClone(revision.entities);
    entities[1].possibleEntityIds = [];
    const linked = { ...entities[0], referentKind: 'collection' as const, collection: { memberEntityIds: ['unknown'],
      completeness: 'complete' as const, mentionIds: ['mention-1'], rationale: '<script>source</script>' } };
    for (const lang of ['zh', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(EntityAnalysisEditor, { detail,
        draft: { entities: [linked, entities[1]], mentions: revision.mentions }, editable: true, lang, onChange() {} }));
      expect(html).toContain(lang === 'zh' ? '成员完整性' : 'Membership completeness');
      expect(html).toContain(lang === 'zh' ? '已知成员' : 'Known members');
      expect(html).toContain(lang === 'zh' ? '定位依据：' : 'Locate evidence: ');
      expect(html).toContain('&lt;script&gt;source&lt;/script&gt;'); expect(html).not.toContain('<script>');
      // Removing the owner removes its own link; other entities are never rewritten.
      expect(html).not.toMatch(lang === 'zh' ? /<button[^>]*disabled=""[^>]*><span>删除此对象及其提及/ : /<button[^>]*disabled=""[^>]*><span>Remove this entity and its mentions/);
      expect(html).toMatch(lang === 'zh' ? /<button[^>]*disabled=""[^>]*><span>删除误识别提及/ : /<button[^>]*disabled=""[^>]*><span>Remove false mention/);
      const member = renderToStaticMarkup(createElement(EntityAnalysisEditor, { detail,
        draft: { entities: [linked, entities[1]], mentions: revision.mentions }, initialEntityId: 'unknown', editable: true, lang, onChange() {} }));
      expect(member).toContain(lang === 'zh' ? '请先核对这些对象' : 'correct these entities');
      expect(member).toMatch(lang === 'zh' ? /<button[^>]*disabled=""[^>]*><span>删除此对象及其提及/ : /<button[^>]*disabled=""[^>]*><span>Remove this entity and its mentions/);
    }
  });
  it('shows component and collection links at the selected revision, exact evidence and unknown membership in both languages', () => {
    const component = { ...revision.entities[0], referentKind: 'component' as const };
    const instance = { ...component, entityId: 'instance', label: '测试部署', referentKind: 'instance' as const,
      componentRef: { entityId: 'project', mentionIds: ['instance-mention'], rationale: '这是组件在测试中的实例' } };
    const group = { ...component, entityId: 'group', label: '它们', referentKind: 'collection' as const,
      collection: { memberEntityIds: ['project', 'instance'], completeness: 'partial' as const, mentionIds: ['group-mention'], rationale: '指向二者，还可能有其他成员' }, uncertainties: ['窗口未列全成员'] };
    const value = { ...detail, revision: { ...revision, entities: [component, instance, group], mentions: [...revision.mentions,
      { ...revision.mentions[0], mentionId: 'instance-mention', entityId: 'instance', selection: { evidenceRef: 'record-1', start: 9, end: 13, quote: 'Beta' } },
      { ...revision.mentions[0], mentionId: 'group-mention', entityId: 'group', selection: { evidenceRef: 'record-1', start: 14, end: 16, quote: '它们' } }] },
      source: { status: 'available' as const, excerpts: [{ evidenceRef: 'record-1', recordIndex: 0, eventKind: 'message', text: 'Alpha 使用 Beta；它们' }], limitations: [] },
      entity: group, mentionChecks: [], knowledge: [], knowledgeStatus: 'available' as const };
    for (const lang of ['zh', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(EntityLibraryDetail, { detail: value, workspace: '/space <script>', lang, onRevision() {} }));
      expect(html).toContain(lang === 'zh' ? '仅部分成员已知' : 'Partial membership');
      expect(html).toContain(lang === 'zh' ? '不会自动归属每个成员' : 'not automatically attributed');
      expect(html).toContain('<mark>它们</mark>'); expect(html).toContain('revision=revision-1'); expect(html).toContain('entity=instance');
      expect(html).toContain('窗口未列全成员'); expect(html).not.toContain('<script>');
      const componentView = renderToStaticMarkup(createElement(EntityLibraryDetail, { detail: { ...value, entity: component }, workspace: '/space', lang, onRevision() {} }));
      expect(componentView).toContain(lang === 'zh' ? '关联的实例／版本' : 'Linked instances / versions');
      expect(componentView).toContain(lang === 'zh' ? '所属集合' : 'Member of collections');
      const instanceView = renderToStaticMarkup(createElement(EntityLibraryDetail, { detail: { ...value, entity: instance }, workspace: '/space', lang, onRevision() {} }));
      expect(instanceView).toContain(lang === 'zh' ? '关联组件' : 'Linked component'); expect(instanceView).toContain('<mark>Beta</mark>');
      expect(instanceView).toContain('这是组件在测试中的实例');
      const unknown = { ...group, collection: { ...group.collection, completeness: 'unknown' as const, memberEntityIds: [] } };
      const unknownView = renderToStaticMarkup(createElement(EntityLibraryDetail, { detail: { ...value, entity: unknown }, workspace: '/space', lang, onRevision() {} }));
      expect(unknownView).toContain(lang === 'zh' ? '尚不能确定成员' : 'Members cannot be determined');
      const readonly = renderToStaticMarkup(createElement(EntityAnalysisEditor, { detail: { ...value, source: { status: 'unavailable', reason: 'deleted', detail: 'deleted' } },
        draft: value.revision, initialEntityId: 'instance', editable: false, lang, onChange() {} }));
      expect(readonly).toContain(lang === 'zh' ? '移除组件关联' : 'Remove component link');
      expect(readonly).toMatch(lang === 'zh' ? /<button[^>]*disabled=""[^>]*><span>定位依据：/ : /<button[^>]*disabled=""[^>]*><span>Locate evidence:/);
    }
  });
  it('requires explicit replacement roles after removal rather than choosing the first remaining entity', () => {
    const knowledge = { revision: { content: draft().content } };
    const html = renderToStaticMarkup(createElement(EntityKnowledgeRoles, { detail: knowledge, analysis: detail,
      roles: [{ statementId: 'usage', subjectId: '', objectId: '' }], disabled: false, lang: 'zh', onChange() {} }));
    expect(html).toContain('明确选择主体'); expect(html).toContain('原对象已被移除'); expect(html).toContain('系统不会替你任选一个');
  });
  it('shows highlighted source spans, actual knowledge roles and older bindings without asserting verification', () => {
    const value = { ...detail, entity: revision.entities[0], knowledgeStatus: 'available' as const, mentionChecks: [{ mentionId: 'mention-1', positionStatus: 'matched' as const }],
      knowledge: [{ knowledgeId: 'knowledge', revisionId: 'knowledge-revision', title: '项目使用工具', entityRevisionId: 'old-revision', currentEntityRevision: false, choice: 'retain' as const,
        roles: [{ statementId: 'statement', role: 'subject' as const, relation: '使用' }] }] };
    const html = renderToStaticMarkup(createElement(EntityLibraryDetail, { detail: value, workspace: '/workspace space', lang: 'zh', onRevision() {} }));
    expect(html).toContain('<mark>Alpha</mark>'); expect(html).toContain('提出对应，待核对');
    expect(html).toContain('主体 · 使用'); expect(html).toContain('仍绑定实体旧修订'); expect(html).toContain('不等于语义已验证');
    expect(html).toContain('revision=old-revision'); expect(html).toContain('workspace=%2Fworkspace+space');
    expect(html.indexOf('本次项目')).toBeLessThan(html.indexOf('原文提及'));
    expect(html.indexOf('原文提及')).toBeLessThan(html.indexOf('关联知识'));
    expect(html.indexOf('关联知识')).toBeLessThan(html.indexOf('<details><summary>身份层次与关联</summary>'));
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    const unavailable = renderToStaticMarkup(createElement(EntityLibraryDetail, { detail: { ...value, mentionChecks: [{ mentionId: 'mention-1', positionStatus: 'unavailable' }], source: { status: 'unavailable', reason: 'deleted', detail: 'deleted' } }, workspace: '/workspace', lang: 'en', onRevision() {} }));
    expect(unavailable).toContain('Source snapshot unavailable'); expect(unavailable).not.toContain('<mark>');
    const unknown = renderToStaticMarkup(createElement(EntityLibraryDetail, { detail: { ...value, knowledge: [], knowledgeStatus: 'unavailable' }, workspace: '/workspace', lang: 'zh', onRevision() {} }));
    expect(unknown).toContain('无法判断是否存在关联'); expect(unknown).not.toContain('没有当前知识修订');
  });
});
