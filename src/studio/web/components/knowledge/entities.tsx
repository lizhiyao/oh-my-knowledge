'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Input, Pagination, Select, Space, Spin, Tag } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeEntityCatalog, KnowledgeEntityLibraryDetail } from '../../../view-models/knowledge/knowledge-candidates';
import { KNOWLEDGE_CANDIDATES_PATH, KNOWLEDGE_ENTITIES_PATH, OBSERVE_INDEX_PATH } from '../../../http/page-paths';
import { conversationPath } from '../conversation-link';
import { displayTime } from '../../../application/display/format';
import { KnowledgeSectionNav } from './section-nav';
import { EntityAnalysisDrawer } from './entity-analysis';
import { EntityRelations, referentLabel } from './entity-relations';
import { notifyKnowledgeChange, resolveKnowledgeWorkspace } from './workspace';

type Target = { analysisId: string; entityId: string; revision?: string };
function entityUrl(workspace: string, target: Target) {
  const params = new URLSearchParams({ workspace, analysis: target.analysisId, entity: target.entityId });
  if (target.revision) params.set('revision', target.revision);
  return `${KNOWLEDGE_ENTITIES_PATH}?${params}`;
}
async function request<T>(workspace: string, operation: string, fields: object, signal: AbortSignal): Promise<T> {
  const response = await fetch('/api/knowledge/candidates', { method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace, operation, ...fields }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
}
export function KnowledgeEntities({ lang, initialWorkspace = '', initialAnalysisId, initialEntityId, initialRevision, threadId }: {
  lang: Language; initialWorkspace?: string; initialAnalysisId?: string; initialEntityId?: string; initialRevision?: string; threadId?: string;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [workspace, setWorkspace] = useState(''); const [error, setError] = useState('');
  const [catalog, setCatalog] = useState<KnowledgeEntityCatalog>(); const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<KnowledgeEntityLibraryDetail>(); const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false); const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState<Target | undefined>(initialAnalysisId && initialEntityId
    ? { analysisId: initialAnalysisId, entityId: initialEntityId, revision: initialRevision } : undefined);
  const [query, setQuery] = useState(''); const [identityStatus, setIdentityStatus] = useState<'all' | 'proposed' | 'unresolved'>('all');
  const [sourceStatus, setSourceStatus] = useState<'all' | 'available' | 'unavailable'>('all'); const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0); const [pane, setPane] = useState<'list' | 'detail'>(target ? 'detail' : 'list');
  useEffect(() => {
    const next = initialAnalysisId && initialEntityId ? { analysisId: initialAnalysisId, entityId: initialEntityId, revision: initialRevision } : undefined;
    setTarget(next); setPane(next ? 'detail' : 'list'); setPage(1);
  }, [initialAnalysisId, initialEntityId, initialRevision, threadId]);
  useEffect(() => {
    const controller = new AbortController();
    void resolveKnowledgeWorkspace(initialWorkspace, controller.signal).then(value => setWorkspace(value.workspace))
      .catch(() => { if (!controller.signal.aborted) { setError(t('未能读取知识工作区设置。', 'Could not read knowledge workspace settings.')); setLoading(false); } });
    return () => controller.abort();
  }, [initialWorkspace]);
  useEffect(() => {
    if (!workspace) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void request<KnowledgeEntityCatalog>(workspace, 'entity-catalog', { ...(query.trim() ? { query: query.trim() } : {}), identityStatus, sourceStatus, page,
      ...(initialAnalysisId ? { analysisId: initialAnalysisId } : {}), ...(threadId ? { threadId } : {}) }, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setCatalog(value); setPage(value.page); } })
      .catch(() => { if (!controller.signal.aborted) { setCatalog(undefined); setError(t('实体列表未能读取。请核对工作区和当前格式；容量超限时缩小工作区。', 'Could not read entities. Check the workspace, current formats, and catalog capacity.')); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspace, query, identityStatus, sourceStatus, page, refresh, initialAnalysisId, threadId]);
  useEffect(() => {
    if (!workspace || !target) return;
    const controller = new AbortController(); setDetail(undefined); setDetailError(''); setDetailLoading(true);
    void request<KnowledgeEntityLibraryDetail>(workspace, 'entity-detail', { analysisId: target.analysisId, entityId: target.entityId,
      ...(target.revision ? { revision: target.revision } : {}) }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDetail(value); })
      .catch(() => { if (!controller.signal.aborted) setDetailError(t('此实体在所选修订中不可读，可能已被移除。仍可打开分析历史核对。', 'Entity unavailable in this revision; it may have been removed. Inspect the analysis history.')); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [workspace, target, refresh]);
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === workspace) setRefresh(value => value + 1); };
    window.addEventListener('omk-knowledge-changed', changed); return () => window.removeEventListener('omk-knowledge-changed', changed);
  }, [workspace]);
  function select(row: KnowledgeEntityCatalog['rows'][number]) {
    const value = { analysisId: row.analysisId, entityId: row.entityId }; setTarget(value); setPane('detail');
    window.history.replaceState(null, '', entityUrl(workspace, value));
  }
  return <section className="entity-library">
    <KnowledgeSectionNav active="entities" lang={lang}/>
    <div className="entity-library-heading"><div><h1>{t('实体', 'Entities')}</h1><p>{t('找到知识谈论的对象，核对原文、身份歧义与知识关联。', 'Find the entities knowledge concerns; inspect source, ambiguity, and linked knowledge.')}</p></div>
      <Button onClick={() => setRefresh(value => value + 1)} disabled={loading}>{t('刷新', 'Refresh')}</Button></div>
    <p className="candidate-help">{t('身份仅在各自来源窗口内对应；名称相同的结果保持分开。提出对应仍需核对。', 'Identities belong to their source windows. Same-name results stay separate; proposed assignments still need review.')}</p>
    {(initialAnalysisId || threadId) && <Link href={`${KNOWLEDGE_ENTITIES_PATH}?${new URLSearchParams({ workspace })}`}>{t('查看工作区全部实体', 'View all workspace entities')}</Link>}
    <div className="entity-library-tools"><Input.Search allowClear aria-label={t('搜索实体', 'Search entities')} placeholder={t('名称、原文提及、限定条件或来源', 'Name, source mention, qualifiers, or conversation')} onSearch={value => { setQuery(value); setPage(1); }}/>
      <Select aria-label={t('身份筛选', 'Identity filter')} value={identityStatus} onChange={value => { setIdentityStatus(value); setPage(1); }} options={[
        { value: 'all', label: t('全部身份', 'All identities') }, { value: 'proposed', label: t('提出对应', 'Proposed') }, { value: 'unresolved', label: t('身份有歧义', 'Unresolved') }]}/>
      <Select aria-label={t('来源筛选', 'Source filter')} value={sourceStatus} onChange={value => { setSourceStatus(value); setPage(1); }} options={[
        { value: 'all', label: t('全部来源', 'All sources') }, { value: 'available', label: t('原文可用', 'Source available') }, { value: 'unavailable', label: t('原文不可用', 'Source unavailable') }]}/></div>
    {error && <Alert type="error" showIcon title={error}/>}
    {!!catalog?.unavailableAnalyses && <Alert type="warning" title={t(`${catalog.unavailableAnalyses} 份实体分析不可读，未纳入结果；可读结果不代表整个工作区。`, `${catalog.unavailableAnalyses} unreadable analyses excluded; readable results do not cover the whole workspace.`)}/>}
    {catalog?.knowledgeStatus === 'unavailable' && <Alert type="warning" title={t('关联知识不可读，数量未知。', 'Linked knowledge unavailable; counts are unknown.')}/>}
    <Space className="entity-library-pane-switch"><Button onClick={() => setPane('list')}>{t('实体列表', 'Entity list')}</Button><Button disabled={!target} onClick={() => setPane('detail')}>{t('实体详情', 'Entity details')}</Button></Space>
    <div className="entity-library-columns">
      <div className={`entity-library-list ${pane === 'list' ? 'entity-pane-active' : ''}`}>
        <div className="entity-library-summary">{catalog && t(`${catalog.total} 个匹配对象 · 工作区 ${catalog.analysisCount} 份分析`, `${catalog.total} matching entities · ${catalog.analysisCount} workspace analyses`)} {loading && <Spin size="small"/>}</div>
        <div className="entity-library-scroll">{catalog?.rows.map(row => <button className={`entity-library-row ${target?.analysisId === row.analysisId && target.entityId === row.entityId ? 'selected' : ''}`} key={`${row.analysisId}:${row.entityId}`} onClick={() => select(row)}>
          <span className="entity-library-row-title" title={row.label}>{row.label}</span><Tag>{row.identityStatus === 'unresolved' ? t('身份有歧义', 'Unresolved') : t('提出对应', 'Proposed')}</Tag>
          <span className="entity-library-row-meta" title={[...row.qualifiers, row.origin?.title ?? ''].join(' · ')}>{referentLabel(row.referentKind, lang)} · {row.qualifiers.join(' / ') || row.description}</span>
          <span className="entity-library-row-meta">{row.origin?.title || t('导入来源', 'Imported source')} · {row.mentionCount} {t('处提及', 'mentions')} · {row.knowledgeCount ?? '—'} {t('条知识', 'knowledge items')}{row.sourceStatus === 'unavailable' ? ` · ${t('原文不可用', 'Source unavailable')}` : ''}</span>
        </button>)}
          {!loading && !error && !catalog?.rows.length && <Empty description={t('没有匹配的实体。更改筛选，或先从对话提炼。', 'No matching entities. Change filters or extract from a conversation.')}><Link href={OBSERVE_INDEX_PATH}>{t('浏览对话', 'Browse conversations')}</Link></Empty>}</div>
        {catalog && <Pagination size="small" current={catalog.page} total={catalog.total} pageSize={catalog.pageSize} showSizeChanger={false} onChange={setPage}/>}
      </div>
      <div className={`entity-library-detail ${pane === 'detail' ? 'entity-pane-active' : ''}`}>
        {target && <div className="entity-library-detail-actions"><Button disabled={detailLoading} onClick={() => setEditing(true)}>{t('核对／纠正实体与指代', 'Inspect / correct entities and references')}</Button></div>}
        <div className="entity-library-scroll">{detailLoading ? <Spin/> : detailError ? <Alert type="warning" title={detailError}/>
          : detail ? <EntityLibraryDetail detail={detail} workspace={workspace} lang={lang} onRevision={revision => {
            if (target) { const value = { ...target, revision }; setTarget(value); window.history.replaceState(null, '', entityUrl(workspace, value)); }
          }}/>
            : <Empty description={t('选择一个实体，查看原文与关联知识。', 'Choose an entity to inspect its source and linked knowledge.')}/>}</div>
      </div>
    </div>
    {editing && target && <EntityAnalysisDrawer workspace={workspace} analysisId={target.analysisId} initialRevision={target.revision} initialEntityId={target.entityId} lang={lang}
      onClose={() => setEditing(false)} onSaved={() => {
        const value = { analysisId: target.analysisId, entityId: target.entityId };
        setTarget(value); window.history.replaceState(null, '', entityUrl(workspace, value)); notifyKnowledgeChange(workspace);
      }}/ >}
  </section>;
}

export function EntityLibraryDetail({ detail, workspace, lang, onRevision }: {
  detail: KnowledgeEntityLibraryDetail; workspace: string; lang: Language; onRevision(revision: string): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const { entity, revision, history } = detail;
  const mentions = revision.mentions.filter(mention => mention.entityId === entity.entityId);
  const excerpts = detail.source.status === 'available' ? detail.source.excerpts : [];
  return <article className="entity-library-article"><h2>{entity.label}</h2>
    <Tag>{entity.identityStatus === 'unresolved' ? t('身份有歧义', 'Unresolved') : t('提出对应，待核对', 'Proposed assignment, needs review')}</Tag>
    <p>{entity.description}</p><p>{entity.qualifiers.join(' · ') || t('未给出进一步的对象限定。', 'No further entity qualifiers provided.')}</p>
    {entity.uncertainties.map((value, index) => <Alert key={index} type="warning" title={value}/>)}
    {!!entity.possibleEntityIds.length && <p>{t('可能对应：', 'Possible identities: ')}{entity.possibleEntityIds.map(id => {
      const value = revision.entities.find(value => value.entityId === id)!;
      return <Link className="entity-possible-link" key={id} href={entityUrl(workspace, { analysisId: history.analysisId, entityId: id, revision: revision.revisionId })}>{value.label} {value.qualifiers.join(' / ')}</Link>;
    })}</p>}
    <label className="entity-history-label">{t('实体修订', 'Entity revision')}<Select value={revision.revisionId} onChange={onRevision}
      options={history.revisions.map((value, index) => ({ value: value.revisionId, label: `${index + 1} · ${displayTime(value.revisedAt)} · ${value.revisionReason}` }))}/></label>
    {revision.revisionId !== history.writeHeadRevisionId && <Alert type="info" title={t('正在查看历史修订。', 'Viewing a historical revision.')}/>}
    <p className="candidate-help">{displayTime(revision.revisedAt)} · {revision.revisedBy.actorId} · {revision.revisionReason}</p>
    {detail.origin && <p><Link href={conversationPath(detail.origin.threadId)}>{detail.origin.title || t('来源对话', 'Source conversation')}</Link></p>}
    <h3>{t('原文提及', 'Source mentions')}</h3>
    {detail.source.status === 'unavailable' && <Alert type="warning" title={t('原文快照不可用。以下仅为已保存的提及，无法重新核对或纠正。', 'Source snapshot unavailable. These are saved mentions; rechecking and corrections are unavailable.')}/>}
    {revision.limitations.map((value, index) => <p className="candidate-help" key={index}>{value}</p>)}
    {mentions.map(mention => {
      const excerpt = excerpts.find(value => value.evidenceRef === mention.selection.evidenceRef);
      const { start, end, quote } = mention.selection;
      const matches = detail.mentionChecks.some(check => check.mentionId === mention.mentionId && check.positionStatus === 'matched');
      return <section className="entity-mention" key={mention.mentionId}><p><Tag>{mention.basis === 'explicit' ? t('明确提及', 'Explicit mention') : t('推断对应', 'Inferred assignment')}</Tag><q>{quote}</q></p>
        <p>{mention.rationale}</p>
        {excerpt && <><p className="candidate-help">{t('来源消息', 'Source message')} {excerpt.recordIndex} · {excerpt.role ?? excerpt.eventKind}{excerpt.timestamp ? ` · ${displayTime(excerpt.timestamp)}` : ''}</p>
          {!matches && <Alert type="warning" title={t('保存的提及与当前快照位置不匹配，不能当作已核对。', 'Saved mention does not match this snapshot span; it is not verified.')}/ >}
          <details onToggle={event => {
            if (!event.currentTarget.open) return;
            const pre = event.currentTarget.querySelector('pre'); const mark = pre?.querySelector('mark');
            if (pre && mark) pre.scrollTop += mark.getBoundingClientRect().top - pre.getBoundingClientRect().top - pre.clientHeight / 2;
          }}><summary>{t('展开原文', 'Show original message')}</summary><pre>{matches ? <>{excerpt.text.slice(0, start)}<mark>{quote}</mark>{excerpt.text.slice(end)}</> : excerpt.text}</pre></details></>}
      </section>;
    })}
    <h3>{t('关联知识', 'Linked knowledge')}</h3>
    {detail.knowledgeStatus === 'unavailable' ? <Alert type="warning" title={t('关联知识不可读，无法判断是否存在关联。', 'Linked knowledge unavailable; associations are unknown.')}/>
      : !detail.knowledge.length ? <p>{t('没有当前知识修订引用此实体。实体提取可以独立于知识提炼存在。', 'No current knowledge revision references this entity. Entity extraction can exist without knowledge proposals.')}</p>
        : detail.knowledge.map(link => <section className="entity-mention" key={link.knowledgeId}>
          <Link href={`${KNOWLEDGE_CANDIDATES_PATH}?${new URLSearchParams({ workspace, id: link.knowledgeId, revision: link.revisionId })}`}>{link.title}</Link>
          <p>{link.roles.map(role => `${t(role.role === 'subject' ? '主体' : '对象', role.role)} · ${role.relation}`).join('；')}</p>
          {!link.currentEntityRevision && <Alert type="info" title={t('此知识仍绑定实体旧修订。打开知识后明确应用新修订，不会自动改写。', 'This knowledge still binds an older entity revision. Apply the new revision explicitly from knowledge.')}/>}
          <Link href={entityUrl(workspace, { analysisId: history.analysisId, entityId: entity.entityId, revision: link.entityRevisionId })}>{t('查看知识绑定的实体修订', 'Inspect the entity revision bound by knowledge')}</Link>
          <p className="candidate-help">{link.choice === 'retain' ? t('已保留；不等于语义已验证。', 'Retained; semantic validity is not verified.') : link.choice === 'discard' ? t('已舍弃；历史关联仍保留。', 'Discarded; its historical association remains.') : t('等待处理；不等于语义已验证。', 'Pending; semantic validity is not verified.')}</p>
        </section>)}
    <details><summary>{t('身份层次与关联', 'Referent level and links')}</summary>
      <EntityRelations detail={detail} entity={entity} workspace={workspace} lang={lang}/>
    </details>
  </article>;
}
