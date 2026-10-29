'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Select, Skeleton, Space } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeLibraryKnowledge, KnowledgeLibraryDetail } from '../../../view-models/knowledge/knowledge-library';
import type { KnowledgeCandidateDetail, KnowledgeGraph, KnowledgeTaskRetrieval } from '../../../view-models/knowledge/knowledge-candidates';
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
import { KnowledgeReader, type KnowledgeReaderEntityTarget, type KnowledgeReaderSelection } from './reader';
import { ArtifactAuthoringDialog } from './artifact-authoring';
import { KnowledgeGraphInspection, KnowledgeGraphView } from './knowledge-graph';
import { AssociationMappingDrawer } from './association-mapping';
import { EntityAnalysisDrawer } from './entity-analysis';
import { KnowledgeTaskSearch } from './task-search';
import { KnowledgeReviewDrawer } from './review-drawer';

export function KnowledgeLibrary({ lang, initialWorkspace = '', objectId, revisionId, knowledgeId, seed, initialView = 'list', initialGraphSelection,
  initialGraphScope = 'current', initialReaderTab = 'body', initialKnowledgeRevision, initialQuery = '', initialChoice = 'all', initialKind = 'all', initialObjects = [],
  initialGraphHistory = false, initialGraphEntity, initialSegmentId, initialMentionId, initialRelationId, initialCatalogRef, initialEvidence, initialReaderSelectionInvalid = false, onTaskFeedback }: {
  lang: Language; initialWorkspace?: string; objectId?: string; revisionId?: string; knowledgeId?: string; seed?: LibrarySeed;
  initialView?: 'list' | 'graph' | 'task'; initialGraphSelection?: string; initialGraphScope?: 'current' | 'filtered'; initialGraphHistory?: boolean;
  onTaskFeedback?(ref: KnowledgeTaskRetrieval['knowledge'][number]['bodyRef'], segmentId: string, query: string): void;
  initialReaderTab?: 'body' | 'evidence' | 'associations' | 'history'; initialKnowledgeRevision?: string;
  initialQuery?: string; initialChoice?: 'all' | 'pending' | 'retain' | 'discard'; initialKind?: 'all' | 'fact' | 'case' | 'method'; initialObjects?: string[];
  initialGraphEntity?: KnowledgeReaderEntityTarget; initialSegmentId?: string; initialMentionId?: string; initialRelationId?: string; initialCatalogRef?: KnowledgeReaderSelection['catalogRef']; initialEvidence?: KnowledgeReaderSelection['evidence']; initialReaderSelectionInvalid?: boolean;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [workspace, setWorkspace] = useState('');
  const [catalog, setCatalog] = useState<KnowledgeLibraryKnowledge>();
  const [object, setObject] = useState(objectId ? { id: objectId, revision: revisionId } : undefined);
  const [objectDetail, setObjectDetail] = useState<KnowledgeLibraryDetail>();
  const [active, setActive] = useState(knowledgeId); const [knowledgeRevision, setKnowledgeRevision] = useState(initialKnowledgeRevision);
  const [detail, setDetail] = useState<KnowledgeCandidateDetail>();
  const [contentReview, setContentReview] = useState<{ detail: KnowledgeCandidateDetail; workspace: string }>();
  const [taskReview, setTaskReview] = useState<{ bodyRef: KnowledgeTaskRetrieval['knowledge'][number]['bodyRef']; segmentId: string; query: string; workspace: string; detail?: KnowledgeCandidateDetail }>();
  const [taskBodyRef, setTaskBodyRef] = useState<KnowledgeTaskRetrieval['knowledge'][number]['bodyRef']>();
  const [query, setQuery] = useState(initialQuery); const [choice, setChoice] = useState<'all' | 'pending' | 'retain' | 'discard'>(initialChoice);
  const [kind, setKind] = useState<'all' | 'fact' | 'case' | 'method'>(initialKind); const [objects, setObjects] = useState<string[]>(initialObjects);
  const [view, setView] = useState(initialView), [graphSelection, setGraphSelection] = useState(initialGraphSelection);
  const [graphScope, setGraphScope] = useState(initialGraphScope), [graphHistory, setGraphHistory] = useState(initialGraphHistory);
  const [graph, setGraph] = useState<KnowledgeGraph>(), [graphLoading, setGraphLoading] = useState(false), [graphError, setGraphError] = useState('');
  const [readerSelection, setReaderSelection] = useState<KnowledgeReaderSelection>(initialReaderSelectionInvalid ? { tab: 'body' }
    : { tab: initialReaderTab, segmentId: initialSegmentId, mentionId: initialMentionId, relationId: initialRelationId, catalogRef: initialCatalogRef, evidence: initialEvidence });
  const [selectionInvalid, setSelectionInvalid] = useState(initialReaderSelectionInvalid);
  const [mapping, setMapping] = useState<{ detail: KnowledgeCandidateDetail; target?: { analysisId: string; entityRevisionId: string } }>();
  const [entityTarget, setEntityTarget] = useState<Omit<KnowledgeReaderEntityTarget, 'entityId'> & { entityId?: string }>();
  const [directory, setDirectory] = useState(initialView === 'task' && !knowledgeId); const [editing, setEditing] = useState(seed ? 'new' : '');
  const [workspaceRetry, setWorkspaceRetry] = useState(0);
  const [refresh, setRefresh] = useState(0); const [loading, setLoading] = useState(true); const [reading, setReading] = useState(false);
  const [error, setError] = useState(''); const [readError, setReadError] = useState('');
  const [selected, setSelected] = useState<string[]>([]); const [authoring, setAuthoring] = useState<string[]>();
  const objectMenu = useRef<HTMLDetailsElement>(null);
  const core = useRef<HTMLElement>(null);
  const visible = catalog ? filterLibraryKnowledge(catalog, { query, choice, knowledgeKind: kind, objects }) : [];
  const currentId = view === 'task' ? active : visible.some(row => row.knowledgeId === active) ? active : visible[0]?.knowledgeId;
  const expectedTaskBody = view === 'task' && taskBodyRef && taskBodyRef.knowledgeId === currentId && taskBodyRef.revisionId === knowledgeRevision ? taskBodyRef : undefined;
  const taskSources = [...new Map<string, { snapshotId: string; sourceVersion: string; title?: string }>((detail?.revision.content.segments.flatMap(segment => segment.evidence) ?? []).map(evidence => {
    const source = detail?.sources.find(value => value.status === 'available' && value.window.snapshotId === evidence.source.snapshotId && value.window.sourceVersion === evidence.source.sourceVersion);
    return [`${evidence.source.snapshotId}/${evidence.source.sourceVersion}`, { ...evidence.source, ...(source?.status === 'available' && source.window.origin?.title ? { title: source.window.origin.title } : {}) }] as const;
  })).values()];
  const graphIds = JSON.stringify(visible.map(row => row.knowledgeId));
  const matchingGraph = catalog && graph && JSON.stringify(graph.scope.knowledgeIds) === graphIds && graph.scope.includeHistory === graphHistory ? graph : undefined;
  useEffect(() => {
    const controller = new AbortController();
    setWorkspace(''); setCatalog(undefined); setDetail(undefined); setTaskBodyRef(undefined); setTaskReview(undefined); setContentReview(undefined); setActive(knowledgeId); setKnowledgeRevision(initialKnowledgeRevision); setGraph(undefined); setMapping(undefined); setEntityTarget(undefined); setError(''); setLoading(true);
    void resolveKnowledgeDirectory(initialWorkspace, controller.signal).then(value => { if (!controller.signal.aborted) setWorkspace(value); })
      .catch(() => { if (!controller.signal.aborted) { setError(t('知识工作区设置不可读，请重试。', 'Knowledge workspace settings unavailable. Retry.')); setLoading(false); } });
    return () => controller.abort();
  }, [initialWorkspace, workspaceRetry]);
  useEffect(() => { setObject(objectId ? { id: objectId, revision: revisionId } : undefined); setActive(knowledgeId); setKnowledgeRevision(initialKnowledgeRevision); setEditing(seed ? 'new' : ''); }, [objectId, revisionId, knowledgeId, initialKnowledgeRevision, seed?.analysisId, seed?.entityId, seed?.revision]);
  useEffect(() => {
    if (!workspace || view !== 'graph' || object || !catalog) return;
    const controller = new AbortController(); setGraphLoading(true); setGraphError('');
    void requestLibraryEntity<KnowledgeGraph>(workspace, 'graph', { knowledgeIds: JSON.parse(graphIds), includeHistory: graphHistory }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setGraph(value); })
      .catch(() => { if (!controller.signal.aborted) { setGraph(undefined); setGraphError(t('图谱未能读取，正文仍可阅读。请重试读取图谱。', 'Could not read the graph. Content remains readable. Retry loading the graph.')); } })
      .finally(() => { if (!controller.signal.aborted) setGraphLoading(false); });
    return () => controller.abort();
  }, [workspace, view, object?.id, !!catalog, graphIds, graphHistory, refresh]);
  useEffect(() => {
    if (graphSelection || !graph || !initialGraphEntity) return;
    const node = graph.nodes.find(node => node.nodeKind === 'entity' && node.analysisId === initialGraphEntity.analysisId
      && node.entityId === initialGraphEntity.entityId && node.entityRevisionId === initialGraphEntity.entityRevisionId);
    if (node) setGraphSelection(node.nodeId);
  }, [graph, graphSelection, initialGraphEntity?.analysisId, initialGraphEntity?.entityId, initialGraphEntity?.entityRevisionId]);
  useEffect(() => {
    if (!workspace) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void requestLibrary<KnowledgeLibraryKnowledge>(workspace, 'knowledge', {}, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setCatalog(value); setSelected(previous => previous.filter(id => value.rows.some(row => row.knowledgeId === id && row.choice === 'retain')));
    }).catch(() => { if (!controller.signal.aborted) { setCatalog(undefined); setError(t('知识库不可读，请核对工作区与组织记录后重试。不可读记录不会被当作空库。', 'Library unavailable. Check workspace and organization records, then retry. Unreadable records are not an empty library.')); } })
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
      .then(value => {
        if (controller.signal.aborted) return;
        if (expectedTaskBody && (value.revision.knowledgeId !== expectedTaskBody.knowledgeId || value.revision.revisionId !== expectedTaskBody.revisionId || value.revision.bodyDigest !== expectedTaskBody.bodyDigest)) throw new Error('Retrieved body identity changed.');
        setDetail(value);
      })
      .catch(() => { if (!controller.signal.aborted) setReadError(t('知识或所选修订不可读，请重试读取。', 'Knowledge or selected revision unavailable. Retry reading.')); })
      .finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [workspace, object, currentId, active, knowledgeRevision, expectedTaskBody?.bodyDigest, refresh]);
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
  function selectKnowledge(id: string, revision?: string, keepGraph = false) {
    if (directory) core.current?.querySelector<HTMLButtonElement>('.knowledge-directory-toggle')?.focus();
    setTaskBodyRef(undefined); setActive(id); setKnowledgeRevision(revision); setDirectory(false); setObject(undefined); setSelectionInvalid(false);
    if (!keepGraph) { setGraphSelection(undefined); setReaderSelection({ tab: 'body' }); }
  }
  function openTaskKnowledge(ref: KnowledgeTaskRetrieval['knowledge'][number]['bodyRef'], selection: KnowledgeReaderSelection) {
    clearFilters(); setTaskBodyRef(ref); setActive(ref.knowledgeId); setKnowledgeRevision(ref.revisionId);
    setObject(undefined); setDirectory(false); setGraphSelection(undefined); setReaderSelection(selection); setSelectionInvalid(false);
  }
  function locate(selection: KnowledgeReaderSelection) { setReaderSelection(selection); setSelectionInvalid(false); }
  useEffect(() => {
    if (!workspace || object) return;
    const params = new URLSearchParams({ workspace });
    if (currentId) params.set('knowledge', currentId);
    if (knowledgeRevision && active === currentId) params.set('revision', knowledgeRevision);
    if (view === 'task') params.set('view', 'task');
    if (view === 'graph') { params.set('view', 'graph'); params.set('scope', graphScope); if (graphSelection) params.set('selection', graphSelection); if (graphHistory) params.set('history', 'true'); }
    if (readerSelection.tab && readerSelection.tab !== 'body') params.set('section', readerSelection.tab);
    if (readerSelection.segmentId) params.set('segment', readerSelection.segmentId);
    if (readerSelection.mentionId) params.set('mention', readerSelection.mentionId);
    if (readerSelection.relationId) params.set('relation', readerSelection.relationId);
    if (readerSelection.catalogRef) params.set('catalog', JSON.stringify(readerSelection.catalogRef));
    if (readerSelection.evidence) {
      const { snapshotId, sourceVersion, evidenceRef, start, end } = readerSelection.evidence;
      params.set('evidence', JSON.stringify({ snapshotId, sourceVersion, evidenceRef, start, end }));
    }
    if (query) params.set('query', query); if (choice !== 'all') params.set('choice', choice); if (kind !== 'all') params.set('kind', kind); if (objects.length) params.set('objects', objects.join(','));
    window.history.replaceState(null, '', `${KNOWLEDGE_LIBRARY_PATH}?${params}`);
  }, [workspace, object?.id, currentId, active, knowledgeRevision, view, graphScope, graphSelection, graphHistory, readerSelection, query, choice, kind, JSON.stringify(objects)]);
  useEffect(() => {
    if (!taskReview || taskReview.detail || !detail || taskReview.workspace !== workspace) return;
    const ref = taskReview.bodyRef;
    if (detail.revision.knowledgeId === ref.knowledgeId && detail.revision.revisionId === ref.revisionId && detail.revision.bodyDigest === ref.bodyDigest) setTaskReview({ ...taskReview, detail: structuredClone(detail) });
  }, [taskReview, detail, workspace]);
  function openMapping(target?: { analysisId: string; entityRevisionId: string }) {
    if (detail) setMapping({ detail: structuredClone(detail), target });
  }
  function readback(saved: KnowledgeCandidateDetail) {
    setMapping(undefined); setDetail(saved); setActive(saved.revision.knowledgeId); setKnowledgeRevision(saved.revision.revisionId);
    locate({ tab: 'associations' });
    const node = graph?.nodes.find(node => node.nodeKind === 'knowledge' && node.bodyRef.knowledgeId === saved.revision.knowledgeId && node.bodyRef.revisionId === saved.revision.revisionId);
    setGraphSelection(node?.nodeId); notifyKnowledgeChange(workspace);
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
    {selectionInvalid && <Alert type="warning" showIcon closable onClose={() => setSelectionInvalid(false)} title={t('未能恢复指定的精确依据。已回到正文；请重新选择段落、提及或来源。', 'The requested exact evidence could not be restored. Content is open; select a segment, mention or source again.')}/>}
    <div className="knowledge-context">
      {object ? <><strong>{t('对象详情', 'Object detail')}</strong><Button onClick={() => { setObject(undefined); clearFilters(); window.history.replaceState(null, '', workspaceHref(KNOWLEDGE_LIBRARY_PATH, workspace)); }}>{t('返回全部知识', 'All knowledge')}</Button></>
        : view === 'task' ? <strong>{t('当前工作区', 'Current workspace')}</strong> : <details ref={objectMenu} className="knowledge-object-filter" onKeyDown={event => { if (event.key === 'Escape' && objectMenu.current) { objectMenu.current.open = false; objectMenu.current.querySelector('summary')?.focus(); } }}>
          <summary>{objects.length ? t(`对象：已选 ${objects.length} 个`, `Objects: ${objects.length} selected`) : t('对象：全部', 'Objects: all')}</summary>
          <div className="knowledge-object-menu"><Button size="small" onClick={() => { setObjects([]); setKnowledgeRevision(undefined); }}>{t('清除对象筛选', 'Clear object filter')}</Button>
            {!catalog?.objects.length && <p>{t('尚无已确认对象；全部知识仍可阅读。', 'No confirmed objects yet; all knowledge remains readable.')}</p>}
            {catalog?.objects.map(item => <label key={item.objectId}><input type="checkbox" checked={objects.includes(item.objectId)} onChange={event => { setObjects(previous => event.target.checked ? [...previous, item.objectId] : previous.filter(id => id !== item.objectId)); setKnowledgeRevision(undefined); }}/>{item.label}</label>)}
            <p>{t('可多选；匹配任一对象，共享知识不重复。全部包含未关联对象的知识。', 'Select any objects; shared knowledge appears once. All includes unassociated knowledge.')}</p>
            <Button size="small" onClick={() => { if (objectMenu.current) { objectMenu.current.open = false; objectMenu.current.querySelector('summary')?.focus(); } }}>{t('完成', 'Done')}</Button></div>
        </details>}
      {!object && <span role="status">{view === 'task' ? t('按正文查找适用知识', 'Find applicable knowledge in content') : loading ? t('正在读取知识…', 'Loading knowledge…') : t(`${visible.length} 条结果 · 全库 ${catalog?.rows.length ?? '—'} 条`, `${visible.length} results · ${catalog?.rows.length ?? '—'} total`)}</span>}
      {!object && <div className="knowledge-view-switch" role="group" aria-label={t('知识浏览方式', 'Knowledge browsing view')}>
        <button type="button" aria-pressed={view === 'list'} onClick={() => { setView('list'); setDirectory(false); }}>{t('目录', 'Directory')}</button>
        <button type="button" aria-pressed={view === 'task'} onClick={() => { setView('task'); setDirectory(true); }}>{t('按任务查找', 'Find for a task')}</button>
        <button type="button" aria-pressed={view === 'graph'} onClick={() => { setView('graph'); setDirectory(true); }}>{t('图谱', 'Graph')}</button>
      </div>}
      <Button className="knowledge-directory-toggle" aria-expanded={directory} onClick={() => setDirectory(value => !value)}>{directory ? t('返回正文', 'Back to content') : object ? t('对象目录', 'Object directory') : view === 'graph' ? t('浏览图谱', 'Browse graph') : view === 'task' ? t('查看检索结果', 'Search results') : t('知识目录', 'Knowledge directory')}</Button>
      {!object && view !== 'task' && <Button disabled={!selected.length || loading || !!error} onClick={() => setAuthoring(selected)}>{t(`生成载体（${selected.length}）`, `Generate artifact (${selected.length})`)}</Button>}
    </div>
    <div className={`knowledge-workbench${!object && view === 'graph' ? ' knowledge-workbench-graph' : !object && view === 'task' ? ' knowledge-workbench-task' : ''}${directory ? ' knowledge-directory-open' : ''}`}>
      <aside className={`knowledge-directory${!object && view === 'graph' ? ' knowledge-graph-directory' : ''}`} aria-busy={!object && view === 'graph' ? graphLoading || loading : undefined} aria-label={object ? t('知识库对象目录', 'Library object directory') : view === 'graph' ? t('知识图谱目录', 'Knowledge graph directory') : view === 'task' ? t('任务检索结果', 'Task retrieval results') : t('知识目录', 'Knowledge directory')}>
        {!object && view !== 'task' && <div className="knowledge-directory-filters"><label>{t('查找知识', 'Find knowledge')}<Input aria-label={t('搜索知识标题或标签', 'Search knowledge titles or tags')} allowClear value={query} onChange={event => { setQuery(event.target.value); setKnowledgeRevision(undefined); }}/></label>
          <div><label>{t('维护状态', 'Maintenance')}<Select aria-label={t('维护状态', 'Maintenance')} value={choice} onChange={value => { setChoice(value); setKnowledgeRevision(undefined); }} options={[{ value: 'all', label: t('全部', 'All') }, { value: 'pending', label: t('待定', 'Pending') }, { value: 'retain', label: t('已保留', 'Retained') }, { value: 'discard', label: t('已舍弃', 'Discarded') }]}/></label>
            <label>{t('知识类型', 'Knowledge type')}<Select aria-label={t('知识类型', 'Knowledge type')} value={kind} onChange={value => { setKind(value); setKnowledgeRevision(undefined); }} options={[{ value: 'all', label: t('全部', 'All') }, { value: 'fact', label: t('事实', 'Fact') }, { value: 'case', label: t('案例', 'Case') }, { value: 'method', label: t('方法', 'Method') }]}/></label></div></div>}
        {!object && view === 'task' ? workspace ? <KnowledgeTaskSearch workspace={workspace} lang={lang} sources={taskSources} onOpen={openTaskKnowledge} onFeedback={(ref, segmentId, query) => { openTaskKnowledge(ref, { tab: 'body', segmentId }); setTaskReview({ bodyRef: ref, segmentId, query, workspace }); onTaskFeedback?.(ref, segmentId, query); }}/> : <div className="knowledge-directory-scroll"><Skeleton active paragraph={{ rows: 3 }}/></div>
          : !object && view === 'graph' ? graphError && !graphLoading && !loading ? <div className="knowledge-directory-scroll"><Alert type="warning" title={graphError} action={<Button onClick={() => setRefresh(value => value + 1)}>{t('重新读取图谱', 'Reload graph')}</Button>}/></div>
            : matchingGraph ? <>{(graphLoading || loading) && <p className="knowledge-network-limitation" role="status">{t('正在刷新图谱，当前显示上次读取的关联。', 'Refreshing graph; showing the last loaded relationships.')}</p>}<KnowledgeGraphView graph={matchingGraph} lang={lang} activeKnowledgeId={currentId} activeRevisionId={active === currentId ? knowledgeRevision : undefined} selectedId={graphSelection} scope={graphScope} includeHistory={graphHistory}
              onScope={setGraphScope} onHistory={setGraphHistory} onSelect={(id, owner) => { setGraphSelection(id); setDirectory(false); if (owner) selectKnowledge(owner.knowledgeId, owner.revisionId, true); }}/></>
              : graphLoading || loading ? <div className="knowledge-directory-scroll"><Skeleton active paragraph={{ rows: 5 }}/></div>
              : <div className="knowledge-directory-scroll"><Empty description={t('读取知识后浏览图谱。', 'Read knowledge to browse the graph.')}/></div>
          : <div className="knowledge-directory-scroll">{loading ? <Skeleton active paragraph={{ rows: 4 }}/> : object ? catalog?.objects.map(item => <button className={`knowledge-directory-row${object.id === item.objectId ? ' selected' : ''}`} type="button" key={item.objectId} onClick={() => selectObject(item.objectId)}><strong>{item.label}</strong></button>)
          : visible.map(row => <div className="knowledge-directory-item" key={row.knowledgeId}>
            <button className={`knowledge-directory-row${currentId === row.knowledgeId ? ' selected' : ''}`} aria-pressed={currentId === row.knowledgeId} type="button" onClick={() => selectKnowledge(row.knowledgeId)}><strong title={row.title}>{row.title}</strong>
              <span>{candidateDecisionLabel(row.choice, lang)}{row.knowledgeKind && <> · {({ fact: t('事实', 'Fact'), case: t('案例', 'Case'), method: t('方法', 'Method') })[row.knowledgeKind]}</>}</span></button>
            {row.choice === 'retain' && <Checkbox aria-label={t(`选择知识：${row.title}`, `Select knowledge: ${row.title}`)} disabled={selected.length >= 100 && !selected.includes(row.knowledgeId)} checked={selected.includes(row.knowledgeId)} onChange={event => setSelected(previous => event.target.checked ? [...previous, row.knowledgeId] : previous.filter(id => id !== row.knowledgeId))}/>}</div>)}
          {!loading && !error && !object && !visible.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('没有匹配的知识。', 'No matching knowledge.')}><Button onClick={clearFilters}>{t('清除全部筛选', 'Clear all filters')}</Button></Empty>}</div>}
        <footer className="knowledge-directory-footer"><span>{t('共享知识保持同一身份与修订。', 'Shared knowledge keeps one identity and revision.')}</span>
          {!object && <Button type="link" disabled={!catalog?.objects.length} onClick={() => { if (catalog?.objects[0]) selectObject(objects[0] ?? catalog.objects[0].objectId); }}>{t('查看对象详情', 'View object details')}</Button>}</footer>
      </aside>
      <div className="knowledge-reader-container">
      {!object && view === 'graph' && matchingGraph && !graphLoading && <KnowledgeGraphInspection graph={matchingGraph} selectedId={graphSelection} detail={detail} loading={reading} workspace={workspace} lang={lang}
        onKnowledge={ref => selectKnowledge(ref.knowledgeId, ref.revisionId, true)} onLocate={locate} onEntity={setEntityTarget} onMapping={openMapping}/>}
      {reading ? <div className="knowledge-reader knowledge-reader-empty"><Skeleton active/></div> : readError ? <div className="knowledge-reader knowledge-reader-empty"><Alert type="warning" title={readError} action={<Button onClick={() => setRefresh(value => value + 1)}>{t('重试读取', 'Retry reading')}</Button>}/></div>
        : object && objectDetail ? <LibraryObjectDetail detail={objectDetail} workspace={workspace} lang={lang}
          onRevision={revision => selectObject(object.id, revision)} onKnowledge={id => { clearFilters(); setObjects([object.id]); selectKnowledge(id); }}
          footer={<><Button disabled={!!historical} onClick={() => setEditing('edit')}>{t('维护对象与来源关联', 'Maintain object and source links')}</Button><Button type="primary" onClick={() => { clearFilters(); setObjects([object.id]); setObject(undefined); }}>{t('按此对象筛选知识', 'Filter knowledge by this object')}</Button></>}/>
          : !object && currentId && detail?.revision.knowledgeId === currentId ? <KnowledgeReader detail={detail} lang={lang} workspace={workspace} selection={readerSelection} onSelectionChange={locate}
            onRevision={revision => { setActive(currentId); setKnowledgeRevision(revision); setSelectionInvalid(false); }} onRetry={() => setRefresh(value => value + 1)}
            onMapAssociations={() => openMapping()} onEntity={setEntityTarget} onReviewContent={() => setContentReview({ detail: structuredClone(detail), workspace })}
            onEntities={detail.derivedAssociations.revision?.catalogRefs.length === 1 ? () => { const ref = detail.derivedAssociations.revision!.catalogRefs[0]; setEntityTarget({ analysisId: ref.analysisId, entityRevisionId: ref.entityRevisionId }); } : undefined}
            header={<div className="knowledge-reader-associations">{catalog?.rows.find(row => row.knowledgeId === currentId)?.objects.length ? catalog.rows.find(row => row.knowledgeId === currentId)!.objects.map(item => <span key={item.objectId}><Button type="link" onClick={() => selectObject(item.objectId)}>{item.label}</Button>{item.associationStatus === 'needs_review' && t('（关联待核对）', ' (association needs review)')}</span>) : t('尚未关联知识库对象', 'Not associated with a library object')}</div>}
            footer={<><span>{t('保留表示愿意维护，效果尚未验证。', 'Retention is a maintenance decision; effectiveness is unverified.')}</span><Link href={workspaceHref(`${KNOWLEDGE_CANDIDATES_PATH}?id=${currentId}&revision=${detail.revision.revisionId}`, workspace)}>{t('进入候选核对', 'Review candidate')}</Link></>}/>
            : <div className="knowledge-reader knowledge-reader-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={error ? t('修复读取问题后继续。', 'Resolve the reading error to continue.') : view === 'task' ? t('输入任务问题，从结果打开正文或依据。', 'Enter a task question, then open content or evidence from the results.') : t('没有匹配知识，请调整筛选或提炼新知识。', 'No matching knowledge. Adjust filters or extract new knowledge.')}>
              {view !== 'task' && <Button onClick={clearFilters}>{t('清除全部筛选', 'Clear all filters')}</Button>}<Link href={workspaceHref(KNOWLEDGE_CANDIDATES_PATH, workspace)}>{t('提炼新知识', 'Extract new knowledge')}</Link></Empty></div>}
      </div>
    </div>
    {!!editing && workspace && <LibraryEditor key={`${workspace}:${editing}:${editing === 'edit' ? object?.id : seed ? `${seed.analysisId}:${seed.entityId}:${seed.revision ?? ''}` : 'new'}`} workspace={workspace} lang={lang} detail={editing === 'edit' ? objectDetail : undefined} seed={editing === 'new' ? seed : undefined} onClose={() => setEditing('')} onSaved={id => { setEditing(''); selectObject(id); notifyKnowledgeChange(workspace); }}/ >}
    {authoring && <ArtifactAuthoringDialog key={workspace} workspace={workspace} lang={lang} ids={authoring} onClose={() => setAuthoring(undefined)}/ >}
    {mapping && <AssociationMappingDrawer key={`${workspace}:${mapping.detail.revision.knowledgeId}:${mapping.detail.revision.revisionId}`} workspace={workspace} detail={mapping.detail} lang={lang}
      initialAnalysisId={mapping.target?.analysisId} initialRevision={mapping.target?.entityRevisionId}
      onClose={needsReadback => { setMapping(undefined); if (needsReadback) setRefresh(value => value + 1); }} onSaved={readback} onReadback={readback}/>}
    {contentReview && contentReview.workspace === workspace && <KnowledgeReviewDrawer key={`${workspace}/${contentReview.detail.revision.revisionId}`} detail={contentReview.detail} workspace={workspace} lang={lang} onClose={() => setContentReview(undefined)}/>}
    {taskReview?.detail && taskReview.workspace === workspace && <KnowledgeReviewDrawer key={`${workspace}/${taskReview.bodyRef.revisionId}/${taskReview.segmentId}`} detail={taskReview.detail} workspace={workspace} lang={lang}
      initialMode="use" segmentId={taskReview.segmentId} query={taskReview.query} onClose={() => setTaskReview(undefined)}/>}

    {entityTarget && <EntityAnalysisDrawer key={`${workspace}:${entityTarget.analysisId}:${entityTarget.entityRevisionId}:${entityTarget.entityId}`} workspace={workspace} analysisId={entityTarget.analysisId}
      initialRevision={entityTarget.entityRevisionId} initialEntityId={entityTarget.entityId} lang={lang} onClose={() => setEntityTarget(undefined)} onSaved={() => notifyKnowledgeChange(workspace)}/>}
  </section>;
}
