'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Input, Pagination, Space, Spin } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeLibraryCatalog, KnowledgeLibraryDetail } from '../../../view-models/knowledge/knowledge-library';
import { KNOWLEDGE_ENTITIES_PATH } from '../../../http/page-paths';
import { KnowledgeSectionNav } from './section-nav';
import { notifyKnowledgeChange, resolveKnowledgeWorkspace } from './workspace';
import { LibraryEditor, type LibrarySeed } from './library-editor';
import { LibraryObjectDetail, type LibraryFilter } from './library-detail';
import { libraryUrl, requestLibrary } from './library-request';
import { ArtifactAuthoringDialog } from './artifact-authoring';

export function KnowledgeLibrary({ lang, initialWorkspace = '', objectId, revisionId, seed }: {
  lang: Language; initialWorkspace?: string; objectId?: string; revisionId?: string; seed?: LibrarySeed;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [workspace, setWorkspace] = useState(''); const [query, setQuery] = useState(''); const [page, setPage] = useState(1);
  const [catalog, setCatalog] = useState<KnowledgeLibraryCatalog>(); const [detail, setDetail] = useState<KnowledgeLibraryDetail>();
  const [target, setTarget] = useState<{ id: string; revision?: string } | undefined>(objectId ? { id: objectId, revision: revisionId } : undefined);
  const [error, setError] = useState(''); const [detailError, setDetailError] = useState(''); const [loading, setLoading] = useState(true); const [detailLoading, setDetailLoading] = useState(false);
  const [editing, setEditing] = useState(seed ? 'new' : ''); const [refresh, setRefresh] = useState(0);
  const [pane, setPane] = useState<'list' | 'detail'>(objectId ? 'detail' : 'list'); const [filter, setFilter] = useState<LibraryFilter>('retain');
  const [selected, setSelected] = useState<string[]>([]); const [authoring, setAuthoring] = useState<string[]>();
  useEffect(() => {
    const controller = new AbortController();
    void resolveKnowledgeWorkspace(initialWorkspace, controller.signal).then(value => { if (!controller.signal.aborted) setWorkspace(value.workspace); })
      .catch(() => { if (!controller.signal.aborted) { setError(t('知识工作区设置不可读。', 'Knowledge workspace settings unavailable.')); setLoading(false); } });
    return () => controller.abort();
  }, [initialWorkspace]);
  useEffect(() => {
    setTarget(objectId ? { id: objectId, revision: revisionId } : undefined); setPane(objectId ? 'detail' : 'list');
    setEditing(seed ? 'new' : ''); setSelected([]); setFilter('retain');
  }, [objectId, revisionId, seed?.analysisId, seed?.entityId, seed?.revision]);
  useEffect(() => {
    if (!workspace) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void requestLibrary<KnowledgeLibraryCatalog>(workspace, 'list', { query, page }, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setCatalog(value); setPage(value.page); } })
      .catch(() => { if (!controller.signal.aborted) { setCatalog(undefined); setError(t('知识库不可读，请核对组织记录与工作区。不可读记录不会被当作空库。', 'Library unavailable. Check organization records and workspace; unreadable data is not an empty library.')); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspace, query, page, refresh]);
  useEffect(() => {
    setSelected([]);
    if (!workspace || !target) { setDetail(undefined); return; }
    const controller = new AbortController(); setDetail(undefined); setDetailLoading(true); setDetailError('');
    void requestLibrary<KnowledgeLibraryDetail>(workspace, 'show', { id: target.id, revision: target.revision }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDetail(value); })
      .catch(() => { if (!controller.signal.aborted) setDetailError(t('对象或所选修订不可读。请核对保存状态与组织历史。', 'Object or selected revision unavailable. Inspect saved state and organization history.')); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [workspace, target, refresh]);
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === workspace) setRefresh(value => value + 1); };
    window.addEventListener('omk-knowledge-changed', changed); return () => window.removeEventListener('omk-knowledge-changed', changed);
  }, [workspace]);
  function select(id: string, revision?: string) {
    setTarget({ id, revision }); setPane('detail'); setFilter('retain'); setSelected([]);
    window.history.replaceState(null, '', libraryUrl(workspace, id, revision));
  }
  const historical = detail && detail.revision.revisionId !== detail.history.writeHeadRevisionId;
  return <section className="entity-library knowledge-library">
    <KnowledgeSectionNav active="library" lang={lang}/>
    <div className="entity-library-heading"><div><h1>{t('知识库', 'Knowledge library')}</h1><p>{t('围绕实体积累知识，核对条件、来源和变化，再用于后续任务。', 'Accumulate knowledge around entities, review scope, sources and changes, then use it in later tasks.')}</p></div>
      <Space wrap><Button disabled={!workspace || loading} onClick={() => setRefresh(value => value + 1)}>{t('刷新', 'Refresh')}</Button>
        <Button type="primary" disabled={!workspace} onClick={() => setEditing('new')}>{t('从实体建立对象', 'Create from entities')}</Button></Space></div>
    <div className="entity-library-tools"><Input.Search allowClear aria-label={t('搜索知识库对象', 'Search library objects')} placeholder={t('搜索对象名称或简介', 'Search object names or descriptions')} onSearch={value => { setQuery(value); setPage(1); }}/></div>
    {error && <Alert type="error" title={error}/>}
    <Space className="entity-library-pane-switch"><Button onClick={() => setPane('list')}>{t('对象列表', 'Object list')}</Button><Button disabled={!target} onClick={() => setPane('detail')}>{t('对象知识', 'Object knowledge')}</Button></Space>
    <div className="entity-library-columns">
      <div className={`entity-library-list ${pane === 'list' ? 'entity-pane-active' : ''}`}>
        <div className="entity-library-summary">{loading ? <Spin size="small"/> : catalog && t(`${catalog.total} 个匹配对象`, `${catalog.total} matching objects`)}</div>
        <div className="entity-library-scroll">{catalog?.rows.map(row => <button key={row.objectId} className={`entity-library-row ${target?.id === row.objectId ? 'selected' : ''}`} onClick={() => select(row.objectId)}>
          <span className="entity-library-row-title" title={row.label}>{row.label}</span>
          <span className="entity-library-row-meta" title={row.description}>{row.description}</span>
          <span className="entity-library-row-meta">{t(`${row.memberCount} 个来源关联`, `${row.memberCount} source links`)}</span>
        </button>)}
          {!loading && !error && !catalog?.rows.length && <Empty description={t('尚无匹配的知识库对象。先选择来源实体并确认关联。', 'No matching library objects. Select source entities and confirm their links.')}>
            <Link href={`${KNOWLEDGE_ENTITIES_PATH}?${new URLSearchParams({ workspace })}`}>{t('浏览提取的实体', 'Browse extracted entities')}</Link></Empty>}</div>
        {catalog && <Pagination size="small" current={catalog.page} total={catalog.total} pageSize={catalog.pageSize} showSizeChanger={false} onChange={setPage}/>}
      </div>
      <div className={`entity-library-detail ${pane === 'detail' ? 'entity-pane-active' : ''}`}>
        {detail && <Space className="entity-library-detail-actions" wrap>
          <Button disabled={!!historical} onClick={() => setEditing('edit')}>{t('维护对象与来源关联', 'Maintain object and source links')}</Button>
          {historical && <Button onClick={() => select(detail.history.objectId)}>{t('返回当前组织修订', 'Return to current organization')}</Button>}
          <Button type="primary" disabled={!selected.length || !!historical} onClick={() => setAuthoring(selected)}>{t(`生成知识载体（${selected.length} 条）`, `Generate artifact (${selected.length} items)`)}</Button>
          <span className="candidate-help">{t('单次最多选择 100 条保留知识。', 'Select up to 100 retained items per artifact.')}</span></Space>}
        <div className="entity-library-scroll">{detailLoading ? <Spin/> : detailError ? <Alert type="warning" title={detailError}/> : detail
          ? <LibraryObjectDetail detail={detail} workspace={workspace} lang={lang} filter={filter} onFilter={setFilter} selected={selected}
            onSelect={(id, value) => setSelected(previous => value ? [...new Set([...previous, id])].slice(0, 100) : previous.filter(item => item !== id))}
            onRevision={revision => select(detail.history.objectId, revision)}/>
          : <Empty description={t('选择对象，查看其积累的知识。', 'Select an object to read its accumulated knowledge.')}/>}</div>
      </div>
    </div>
    {!!editing && workspace && <LibraryEditor workspace={workspace} lang={lang} detail={editing === 'edit' ? detail : undefined} seed={editing === 'new' ? seed : undefined}
      onClose={() => setEditing('')} onSaved={id => { setEditing(''); select(id); notifyKnowledgeChange(workspace); }}/ >}
    {authoring && <ArtifactAuthoringDialog workspace={workspace} lang={lang} ids={authoring} onClose={() => setAuthoring(undefined)}/ >}
  </section>;
}
