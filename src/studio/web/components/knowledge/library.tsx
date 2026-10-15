'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Select, Skeleton, Space } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeLibraryKnowledge, KnowledgeLibraryDetail } from '../../../view-models/knowledge/knowledge-library';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import { KNOWLEDGE_CANDIDATES_PATH, KNOWLEDGE_INDEX_PATH, KNOWLEDGE_LIBRARY_PATH } from '../../../http/page-paths';
import { workspaceHref } from '../layout/workspace-link';
import { filterLibraryKnowledge } from '../../../application/knowledge/library-view';
import { candidateDecisionLabel } from '../../../application/knowledge/candidate-status';
import { KnowledgeSectionNav } from './section-nav';
import { notifyKnowledgeChange, resolveKnowledgeDirectory } from './workspace';
import { LibraryEditor } from './library-editor';
import type { LibrarySeed } from './library-source';
import { LibraryObjectDetail } from './library-detail';
import { libraryUrl, requestLibrary, requestLibraryEntity } from './library-request';
import { KnowledgeReader } from './reader';
import { ArtifactAuthoringDialog } from './artifact-authoring';

export function KnowledgeLibrary({ lang, initialWorkspace = '', objectId, revisionId, knowledgeId, seed }: {
  lang: Language; initialWorkspace?: string; objectId?: string; revisionId?: string; knowledgeId?: string; seed?: LibrarySeed;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [workspace, setWorkspace] = useState('');
  const [catalog, setCatalog] = useState<KnowledgeLibraryKnowledge>();
  const [object, setObject] = useState(objectId ? { id: objectId, revision: revisionId } : undefined);
  const [objectDetail, setObjectDetail] = useState<KnowledgeLibraryDetail>();
  const [active, setActive] = useState(knowledgeId); const [knowledgeRevision, setKnowledgeRevision] = useState<string>();
  const [detail, setDetail] = useState<KnowledgeCandidateDetail>();
  const [query, setQuery] = useState(''); const [choice, setChoice] = useState<'all' | 'pending' | 'retain' | 'discard'>('all');
  const [kind, setKind] = useState<'all' | 'fact' | 'case' | 'method'>('all'); const [objects, setObjects] = useState<string[]>([]);
  const [directory, setDirectory] = useState(false); const [editing, setEditing] = useState(seed ? 'new' : '');
  const [workspaceRetry, setWorkspaceRetry] = useState(0);
  const [refresh, setRefresh] = useState(0); const [loading, setLoading] = useState(true); const [reading, setReading] = useState(false);
  const [error, setError] = useState(''); const [readError, setReadError] = useState('');
  const [selected, setSelected] = useState<string[]>([]); const [authoring, setAuthoring] = useState<string[]>();
  const objectMenu = useRef<HTMLDetailsElement>(null);
  const core = useRef<HTMLElement>(null);
  const visible = catalog ? filterLibraryKnowledge(catalog, { query, choice, knowledgeKind: kind, objects }) : [];
  const currentId = visible.some(row => row.knowledgeId === active) ? active : visible[0]?.knowledgeId;
  useEffect(() => {
    const controller = new AbortController();
    setWorkspace(''); setCatalog(undefined); setDetail(undefined); setError(''); setLoading(true);
    void resolveKnowledgeDirectory(initialWorkspace, controller.signal).then(value => { if (!controller.signal.aborted) setWorkspace(value); })
      .catch(() => { if (!controller.signal.aborted) { setError(t('知识工作区设置不可读，请重试。', 'Knowledge workspace settings unavailable. Retry.')); setLoading(false); } });
    return () => controller.abort();
  }, [initialWorkspace, workspaceRetry]);
  useEffect(() => { setObject(objectId ? { id: objectId, revision: revisionId } : undefined); setActive(knowledgeId); setKnowledgeRevision(undefined); setEditing(seed ? 'new' : ''); }, [objectId, revisionId, knowledgeId, seed?.analysisId, seed?.entityId, seed?.revision]);
  useEffect(() => {
    if (!workspace) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void requestLibrary<KnowledgeLibraryKnowledge>(workspace, 'knowledge', {}, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setCatalog(value); setSelected(previous => previous.filter(id => value.rows.some(row => row.knowledgeId === id && row.choice === 'retain')));
    }).catch(() => { if (!controller.signal.aborted) { setCatalog(undefined); setDetail(undefined); setError(t('知识库不可读，请核对工作区与组织记录后重试。不可读记录不会被当作空库。', 'Library unavailable. Check workspace and organization records, then retry. Unreadable records are not an empty library.')); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspace, refresh]);
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === workspace) setRefresh(value => value + 1); };
    window.addEventListener('omk-knowledge-changed', changed); return () => window.removeEventListener('omk-knowledge-changed', changed);
  }, [workspace]);
  useEffect(() => {
    if (object || !currentId || !workspace) { setDetail(undefined); if (!object) { setReading(false); setReadError(''); } return; }
    const controller = new AbortController(); setDetail(undefined); setReading(true); setReadError('');
    void requestLibraryEntity<KnowledgeCandidateDetail>(workspace, 'show', { id: currentId, ...(active === currentId && knowledgeRevision ? { revision: knowledgeRevision } : {}) }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDetail(value); })
      .catch(() => { if (!controller.signal.aborted) setReadError(t('知识或所选修订不可读，请重试读取。', 'Knowledge or selected revision unavailable. Retry reading.')); })
      .finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [workspace, object, currentId, active, knowledgeRevision, refresh]);
  useEffect(() => {
    if (!object || !workspace) { setObjectDetail(undefined); return; }
    const controller = new AbortController(); setObjectDetail(undefined); setReading(true); setReadError('');
    void requestLibrary<KnowledgeLibraryDetail>(workspace, 'show', { id: object.id, revision: object.revision }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setObjectDetail(value); })
      .catch(() => { if (!controller.signal.aborted) setReadError(t('对象或组织修订不可读，请重试读取。', 'Object or organization revision unavailable. Retry reading.')); })
      .finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [workspace, object, refresh]);
  function clearFilters() { setQuery(''); setChoice('all'); setKind('all'); setObjects([]); setKnowledgeRevision(undefined); }
  function selectKnowledge(id: string) {
    if (directory) core.current?.querySelector<HTMLButtonElement>('.knowledge-directory-toggle')?.focus();
    setActive(id); setKnowledgeRevision(undefined); setDirectory(false); setObject(undefined);
    window.history.replaceState(null, '', workspaceHref(`${KNOWLEDGE_LIBRARY_PATH}?knowledge=${encodeURIComponent(id)}`, workspace));
  }
  function selectObject(id: string, revision?: string) {
    if (directory) core.current?.querySelector<HTMLButtonElement>('.knowledge-directory-toggle')?.focus();
    setObject({ id, revision }); setDirectory(false); window.history.replaceState(null, '', libraryUrl(workspace, id, revision));
  }
  const historical = objectDetail && objectDetail.revision.revisionId !== objectDetail.history.writeHeadRevisionId;
  return <section ref={core} className="knowledge-library knowledge-core">
    <KnowledgeSectionNav active="library" lang={lang}/>
    <header className="knowledge-page-heading"><h1>{t('知识库', 'Knowledge library')}</h1><Space wrap>
      <Button disabled={!workspace || loading} onClick={() => setRefresh(value => value + 1)}>{t('刷新', 'Refresh')}</Button>
      <Button disabled={!workspace} onClick={() => setEditing('new')}>{t('从实体建立对象', 'Create from entities')}</Button>
      <Link href={workspaceHref(KNOWLEDGE_INDEX_PATH, workspace)}>{t('查看载体', 'View artifacts')}</Link></Space></header>
    <p className="candidate-help knowledge-workspace" title={workspace}>{t('知识目录：', 'Knowledge directory: ')}{workspace || t('尚未读取', 'Not yet read')}</p>
    {error && <Alert type="error" title={error} action={<Button disabled={loading} onClick={() => workspace ? setRefresh(value => value + 1) : setWorkspaceRetry(value => value + 1)}>{t('重新读取', 'Reload')}</Button>}/>}
    <div className="knowledge-context">
      {object ? <><strong>{t('对象详情', 'Object detail')}</strong><Button onClick={() => { setObject(undefined); clearFilters(); window.history.replaceState(null, '', workspaceHref(KNOWLEDGE_LIBRARY_PATH, workspace)); }}>{t('返回全部知识', 'All knowledge')}</Button></>
        : <details ref={objectMenu} className="knowledge-object-filter" onKeyDown={event => { if (event.key === 'Escape' && objectMenu.current) { objectMenu.current.open = false; objectMenu.current.querySelector('summary')?.focus(); } }}>
          <summary>{objects.length ? t(`对象：已选 ${objects.length} 个`, `Objects: ${objects.length} selected`) : t('对象：全部', 'Objects: all')}</summary>
          <div className="knowledge-object-menu"><Button size="small" onClick={() => { setObjects([]); setKnowledgeRevision(undefined); }}>{t('清除对象筛选', 'Clear object filter')}</Button>
            {!catalog?.objects.length && <p>{t('尚无已确认对象；全部知识仍可阅读。', 'No confirmed objects yet; all knowledge remains readable.')}</p>}
            {catalog?.objects.map(item => <label key={item.objectId}><input type="checkbox" checked={objects.includes(item.objectId)} onChange={event => { setObjects(previous => event.target.checked ? [...previous, item.objectId] : previous.filter(id => id !== item.objectId)); setKnowledgeRevision(undefined); }}/>{item.label}</label>)}
            <p>{t('可多选；匹配任一对象，共享知识不重复。全部包含未关联对象的知识。', 'Select any objects; shared knowledge appears once. All includes unassociated knowledge.')}</p>
            <Button size="small" onClick={() => { if (objectMenu.current) { objectMenu.current.open = false; objectMenu.current.querySelector('summary')?.focus(); } }}>{t('完成', 'Done')}</Button></div>
        </details>}
      {!object && <span role="status">{loading ? t('正在读取知识…', 'Loading knowledge…') : t(`${visible.length} 条结果 · 全库 ${catalog?.rows.length ?? '—'} 条`, `${visible.length} results · ${catalog?.rows.length ?? '—'} total`)}</span>}
      <Button className="knowledge-directory-toggle" aria-expanded={directory} onClick={() => setDirectory(value => !value)}>{directory ? t('返回正文', 'Back to content') : object ? t('对象目录', 'Object directory') : t('知识目录', 'Knowledge directory')}</Button>
      {!object && <Button disabled={!selected.length || loading || !!error} onClick={() => setAuthoring(selected)}>{t(`生成载体（${selected.length}）`, `Generate artifact (${selected.length})`)}</Button>}
    </div>
    <div className={`knowledge-workbench${directory ? ' knowledge-directory-open' : ''}`}>
      <aside className="knowledge-directory" aria-label={object ? t('知识库对象目录', 'Library object directory') : t('知识目录', 'Knowledge directory')}>
        {!object && <div className="knowledge-directory-filters"><label>{t('查找知识', 'Find knowledge')}<Input aria-label={t('搜索知识标题或标签', 'Search knowledge titles or tags')} allowClear value={query} onChange={event => { setQuery(event.target.value); setKnowledgeRevision(undefined); }}/></label>
          <div><label>{t('维护状态', 'Maintenance')}<Select aria-label={t('维护状态', 'Maintenance')} value={choice} onChange={value => { setChoice(value); setKnowledgeRevision(undefined); }} options={[{ value: 'all', label: t('全部', 'All') }, { value: 'pending', label: t('待定', 'Pending') }, { value: 'retain', label: t('已保留', 'Retained') }, { value: 'discard', label: t('已舍弃', 'Discarded') }]}/></label>
            <label>{t('知识类型', 'Knowledge type')}<Select aria-label={t('知识类型', 'Knowledge type')} value={kind} onChange={value => { setKind(value); setKnowledgeRevision(undefined); }} options={[{ value: 'all', label: t('全部', 'All') }, { value: 'fact', label: t('事实', 'Fact') }, { value: 'case', label: t('案例', 'Case') }, { value: 'method', label: t('方法', 'Method') }]}/></label></div></div>}
        <div className="knowledge-directory-scroll">{loading ? <Skeleton active paragraph={{ rows: 4 }}/> : object ? catalog?.objects.map(item => <button className={`knowledge-directory-row${object.id === item.objectId ? ' selected' : ''}`} type="button" key={item.objectId} onClick={() => selectObject(item.objectId)}><strong>{item.label}</strong></button>)
          : visible.map(row => <div className="knowledge-directory-item" key={row.knowledgeId}>
            <button className={`knowledge-directory-row${currentId === row.knowledgeId ? ' selected' : ''}`} aria-pressed={currentId === row.knowledgeId} type="button" onClick={() => selectKnowledge(row.knowledgeId)}><strong title={row.title}>{row.title}</strong>
              <span>{candidateDecisionLabel(row.choice, lang)} · {({ fact: t('事实', 'Fact'), case: t('案例', 'Case'), method: t('方法', 'Method') })[row.knowledgeKind]}</span></button>
            {row.choice === 'retain' && <Checkbox aria-label={t(`选择知识：${row.title}`, `Select knowledge: ${row.title}`)} disabled={selected.length >= 100 && !selected.includes(row.knowledgeId)} checked={selected.includes(row.knowledgeId)} onChange={event => setSelected(previous => event.target.checked ? [...previous, row.knowledgeId] : previous.filter(id => id !== row.knowledgeId))}/>}</div>)}
          {!loading && !error && !object && !visible.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('没有匹配的知识。', 'No matching knowledge.')}><Button onClick={clearFilters}>{t('清除全部筛选', 'Clear all filters')}</Button></Empty>}</div>
        <footer className="knowledge-directory-footer"><span>{t('共享知识保持同一身份与修订。', 'Shared knowledge keeps one identity and revision.')}</span>
          {!object && <Button type="link" disabled={!catalog?.objects.length} onClick={() => { if (catalog?.objects[0]) selectObject(objects[0] ?? catalog.objects[0].objectId); }}>{t('查看对象详情', 'View object details')}</Button>}</footer>
      </aside>
      {reading ? <div className="knowledge-reader knowledge-reader-empty"><Skeleton active/></div> : readError ? <div className="knowledge-reader knowledge-reader-empty"><Alert type="warning" title={readError} action={<Button onClick={() => setRefresh(value => value + 1)}>{t('重试读取', 'Retry reading')}</Button>}/></div>
        : object && objectDetail ? <LibraryObjectDetail detail={objectDetail} workspace={workspace} lang={lang}
          onRevision={revision => selectObject(object.id, revision)} onKnowledge={id => { clearFilters(); setObjects([object.id]); selectKnowledge(id); }}
          footer={<><Button disabled={!!historical} onClick={() => setEditing('edit')}>{t('维护对象与来源关联', 'Maintain object and source links')}</Button><Button type="primary" onClick={() => { clearFilters(); setObjects([object.id]); setObject(undefined); }}>{t('按此对象筛选知识', 'Filter knowledge by this object')}</Button></>}/>
          : !object && currentId && detail?.revision.knowledgeId === currentId ? <KnowledgeReader detail={detail} lang={lang} onRevision={revision => { setActive(currentId); setKnowledgeRevision(revision); }} onRetry={() => setRefresh(value => value + 1)}
            header={<div className="knowledge-reader-associations">{catalog?.rows.find(row => row.knowledgeId === currentId)?.objects.length ? catalog.rows.find(row => row.knowledgeId === currentId)!.objects.map(item => <span key={item.objectId}><Button type="link" onClick={() => selectObject(item.objectId)}>{item.label}</Button>{item.associationStatus === 'needs_review' && t('（关联待核对）', ' (association needs review)')}</span>) : t('尚未关联知识库对象', 'Not associated with a library object')}</div>}
            footer={<><span>{t('保留表示愿意维护，效果尚未验证。', 'Retention is a maintenance decision; effectiveness is unverified.')}</span><Link href={workspaceHref(`${KNOWLEDGE_CANDIDATES_PATH}?id=${currentId}&revision=${detail.revision.revisionId}`, workspace)}>{t('进入候选核对', 'Review candidate')}</Link></>}/>
            : <div className="knowledge-reader knowledge-reader-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={error ? t('修复读取问题后继续。', 'Resolve the reading error to continue.') : t('没有匹配知识，请调整筛选或提炼新知识。', 'No matching knowledge. Adjust filters or extract new knowledge.')}>
              <Button onClick={clearFilters}>{t('清除全部筛选', 'Clear all filters')}</Button><Link href={workspaceHref(KNOWLEDGE_CANDIDATES_PATH, workspace)}>{t('提炼新知识', 'Extract new knowledge')}</Link></Empty></div>}
    </div>
    {!!editing && workspace && <LibraryEditor key={`${workspace}:${editing}:${editing === 'edit' ? object?.id : seed ? `${seed.analysisId}:${seed.entityId}:${seed.revision ?? ''}` : 'new'}`} workspace={workspace} lang={lang} detail={editing === 'edit' ? objectDetail : undefined} seed={editing === 'new' ? seed : undefined} onClose={() => setEditing('')} onSaved={id => { setEditing(''); selectObject(id); notifyKnowledgeChange(workspace); }}/ >}
    {authoring && <ArtifactAuthoringDialog key={workspace} workspace={workspace} lang={lang} ids={authoring} onClose={() => setAuthoring(undefined)}/ >}
  </section>;
}
