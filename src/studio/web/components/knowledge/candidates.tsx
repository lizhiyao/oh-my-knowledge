'use client';
import Link from 'next/link';
import { requestKnowledge } from './request';
import { notifyKnowledgeChange, resolveKnowledgeWorkspace } from './workspace';
import { ArtifactAuthoringDialog } from './artifact-authoring';
import { ConversationExtractionDialog } from './conversation-extraction';
import { GenerationPolicyFields } from './generation-policy-fields';
import { EntityAnalysisDrawer, EntityAnalysisSummary } from './entity-analysis';
import { ApplyEntitiesDialog } from './apply-entities';
import { KnowledgeRevisionDrawer } from './revision-editor';
import { candidateReviewRun, projectCandidateBatch } from '../../../application/knowledge/candidate-review';
import { CandidateDecisionActions, CandidateReviewProgress, CandidateReviewSummary } from './candidate-review';
import { KnowledgeReader } from './reader';
import { ExtractionQualityPanel } from './extraction-quality';
import { KnowledgeStudyInspectionDrawer } from './study-inspection';
import { KnowledgeSectionNav } from './section-nav';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Dropdown, Empty, Input, InputNumber, Modal, Select, Space } from 'antd';
import { type Language } from '../layout/shell';
import { conversationPath } from '../conversation-link';
import { conversationLabel } from '../../../application/display/conversation-label';
import { candidateDecisionLabel, extractionRunStatusLabel, type CandidateChoice } from '../../../application/knowledge/candidate-status';
import type { KnowledgeCandidateDetail, KnowledgeCandidateRow, KnowledgeCandidateRun, KnowledgeCandidateSource, KnowledgeCandidateQueue } from '../../../view-models/knowledge/knowledge-candidates';
import type { ExtractionGenerationPolicy } from '../../../../observability/application';

export function KnowledgeCandidates({ lang, initialWorkspace = '', initialId, initialRevision, scope, embedded = false, onLoaded }: { lang: Language; initialWorkspace?: string; initialId?: string; initialRevision?: string; scope?: { threadId?: string; projectId?: string }; embedded?: boolean; onLoaded?(rows: KnowledgeCandidateRow[]): void }) {
  const zh = lang === 'zh';
  const t = (cn: string, en: string) => zh ? cn : en;
  const [authoringIds, setAuthoringIds] = useState<string[] | null>(null);
  const [showExtraction, setShowExtraction] = useState(false);
  const chooseConversation = () => setShowExtraction(true);
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [defaultWorkspace, setDefaultWorkspace] = useState('');
  const [workspaceDraft, setWorkspaceDraft] = useState(initialWorkspace);
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | 'fact' | 'case' | 'method'>('all');
  const [filter, setFilter] = useState<'all' | 'pending' | 'retain' | 'discard'>(scope ? 'pending' : 'all');
  const [rows, setRows] = useState<KnowledgeCandidateRow[]>([]);
  const [detail, setDetail] = useState<KnowledgeCandidateDetail | null>(null);
  const [source, setSource] = useState('');
  const [start, setStart] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const [executor, setExecutor] = useState('codex');
  const [model, setModel] = useState('');
  const [policy, setPolicy] = useState<ExtractionGenerationPolicy>();
  const [snapshot, setSnapshot] = useState<KnowledgeCandidateSource | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [showStudy, setShowStudy] = useState(false);
  const [entityTarget, setEntityTarget] = useState<{ analysisId: string; revision?: string }>();
  const [applyingEntities, setApplyingEntities] = useState(false);
  const [runs, setRuns] = useState<KnowledgeCandidateRun[]>([]);
  const [batchRunId, setBatchRunId] = useState<string | null>(null);
  const [previousId, setPreviousId] = useState<string | null>(null);
  const [showBatchSummary, setShowBatchSummary] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const [decisionChoice, setDecisionChoice] = useState<'retain' | 'discard' | null>(null);
  const [tagsDraft, setTagsDraft] = useState<string[]>([]);
  const [directory, setDirectory] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const moreControl = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
  const studyWasOpen = useRef(false);
  useEffect(() => {
    if (studyWasOpen.current && !showStudy) moreControl.current?.focus();
    studyWasOpen.current = showStudy;
  }, [showStudy]);
  useEffect(() => { setTagsDraft(detail?.tagging.tags ?? []); setDecisionChoice(null); }, [detail]);
  async function api<T>(operation: string, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const data = await requestKnowledge<T>('candidates', { workspace, operation, ...fields }, signal ?? controller.current?.signal);
    if (['maintain', 'revise', 'apply-entities', 'resume'].includes(operation)) notifyKnowledgeChange(workspace);
    return data as T;
  }
  async function work(action: () => Promise<void>) {
    if (controller.current) return;
    const active = new AbortController(); controller.current = active; setBusy(true); setError('');
    try { await action(); } catch (cause) {
      if (active.signal.aborted) setNotice(t('已取消请求。可在生成记录中查看结果。', 'Request cancelled. Inspect generation history for its final state.'));
      else setError(cause instanceof Error && cause.message === 'knowledge_conflict'
        ? t('内容已被其他操作更新，请重新打开后再处理。', 'Content changed. Reopen it before editing.')
        : cause instanceof Error && cause.message === 'knowledge_storage_unsupported'
          ? t('此操作遇到不支持的数据格式。请核对保存位置；不会自动迁移或改写原文件。', 'This operation encountered an unsupported data format. Check the save location; original files are not automatically migrated or rewritten.')
        : cause instanceof Error && cause.message === 'knowledge_workspace_busy'
          ? t('知识目录正在写入，请稍后重试。', 'The knowledge directory is being written. Try again shortly.')
        : cause instanceof Error && cause.message === 'knowledge_tags_invalid'
          ? t('标签格式不正确。使用中文、字母、数字、下划线、连字符或 /，不含空格；每个最多 80 字符，也不能只有数字。', 'Invalid tags. Use letters, numbers, underscores, hyphens or / without spaces; up to 80 characters each, and not only numbers.')
        : cause instanceof Error && cause.message === 'knowledge_capacity_exceeded'
          ? t('超出保存或输入上限，请缩小记录范围或删除不再需要的来源快照。', 'Capacity exceeded. Narrow the selection or delete unneeded snapshots.')
          : t('操作未完成。请检查路径、输入格式和执行器配置；生成详情可通过 CLI 查看。', 'Operation failed. Check paths, input format, and executor settings; use CLI for generation details.'));
    } finally { controller.current = null; setBusy(false); setLoading(false); }
  }
  async function refresh(root = workspace, selectFirst = false) {
    setLoading(true);
    try {
    const { rows: nextRows, runs: nextRuns } = scope ? await api<KnowledgeCandidateQueue>('queue', { workspace: root, ...scope }) : await Promise.all([
      api<KnowledgeCandidateRow[]>('list', { workspace: root }),
      api<KnowledgeCandidateRun[]>('runs', { workspace: root }),
    ]).then(([rows, runs]) => ({ rows, runs }));
    const first = scope ? nextRows.find(row => row.choice === null) ?? nextRows[0] : nextRows[0];
    const nextDetail = selectFirst && first
      ? await api<KnowledgeCandidateDetail>('show', { workspace: root, id: first.knowledgeId }) : undefined;
    setRows(nextRows); setRuns(nextRuns); setFailedToLoad(false); onLoaded?.(nextRows);
    if (selectFirst) { setDetail(nextDetail ?? null); setReason('');
      if (scope && first) setBatchRunId(candidateReviewRun(nextRuns, first.knowledgeId)?.runId ?? null);
    }
    return { rows: nextRows, runs: nextRuns };
    } catch (cause) { setFailedToLoad(true); throw cause; }
    finally { setLoading(false); }
  }
  async function open(id: string, revision?: string, root = workspace, activateBatch = false) {
    const next = await api<KnowledgeCandidateDetail>('show', { workspace: root, id, ...(revision ? { revision } : {}) });
    setDetail(next); setReason(''); setShowBatchSummary(false); setNeedsRefresh(false);
    if (activateBatch) { setBatchRunId(candidateReviewRun(runs, id)?.runId ?? null); setPreviousId(null); }
    if (embedded) return;
    const url = new URL(window.location.href); url.searchParams.set('id', id); if (revision) url.searchParams.set('revision', revision); else url.searchParams.delete('revision'); url.searchParams.set('workspace', root); window.history.replaceState(null, '', url);
  }
  function readbackDetail(latest: KnowledgeCandidateDetail) {
    setEditing(false); setApplyingEntities(false); setDetail(latest); setNeedsRefresh(false); setError(''); setReason('');
    if (!embedded) {
      const url = new URL(window.location.href); url.searchParams.set('id', latest.revision.knowledgeId);
      url.searchParams.set('revision', latest.revision.revisionId); url.searchParams.set('workspace', workspace); window.history.replaceState(null, '', url);
    }
  }
  function closeRevisionEditor(needsReadback: boolean) {
    setEditing(false); setApplyingEntities(false);
    if (needsReadback) {
      setNeedsRefresh(true);
      setError(t('草稿已关闭。先重新读取知识及修订历史，再开始新的修订；不会重发先前保存。', 'Draft closed. Reload knowledge and revision history before starting a new revision; the previous save will not be resent.'));
    }
  }
  async function initializeWorkspace() {
    setLoading(true);
    try {
      const { workspace: root, defaultWorkspace: fallback, executor: provider, model: defaultModel } = await resolveKnowledgeWorkspace(initialWorkspace, controller.current?.signal);
      setDefaultWorkspace(fallback); setWorkspace(root); setWorkspaceDraft(root);
      setExecutor(provider); setModel(defaultModel);
      if (root) { const current = await refresh(root, true); if (initialId) { await open(initialId, initialRevision, root); if (scope) setBatchRunId(candidateReviewRun(current.runs, initialId)?.runId ?? null); } }
    } catch (cause) { setFailedToLoad(true); throw cause; }
    finally { setLoading(false); }
  }
  const retryCandidates = () => void work(async () => { if (defaultWorkspace) await refresh(workspace, true); else await initializeWorkspace(); });
  useEffect(() => {
    void work(initializeWorkspace);
    return () => controller.current?.abort();
    // Initial workspace comes from the explicit page URL; subsequent changes use Open.
  }, []);
  async function handleRun(run: KnowledgeCandidateRun) {
    setNotice(run.status === 'completed'
      ? t(`生成完成：${run.committed.length} 条候选，${run.rejections.length} 条输出未接纳。`, `Generated ${run.committed.length} candidates; ${run.rejections.length} outputs rejected.`)
      : t(`运行状态：${run.status}。请在生成记录中查看或恢复。`, `Run status: ${run.status}. Inspect or resume it in history.`));
    await refresh(); if (run.committed[0]) { await open(run.committed[0].knowledgeId); setBatchRunId(run.runId); setPreviousId(null); }
  }
  function leaveBatch() {
    setBatchRunId(null); setPreviousId(null); setShowBatchSummary(false); setQuery(''); setFilter('all');
    if (embedded) return;
    const url = new URL(window.location.href); url.searchParams.delete('id'); url.searchParams.delete('revision'); window.history.replaceState(null, '', url);
  }
  async function continueReview(id: string, revision?: string, advance = true) {
    const current = await refresh();
    const nextBatch = projectCandidateBatch(current.runs.find(run => run.runId === batchRunId), current.rows, id);
    // A new revision is undecided even when its predecessor was already handled.
    const currentPending = current.rows.find(row => row.knowledgeId === id)?.choice === null;
    const target = advance && !currentPending ? nextBatch?.nextId : undefined;
    await open(target ?? id, advance ? undefined : revision);
    if (advance && nextBatch?.complete) {
      const nextPending = scope && current.rows.find(row => row.choice === null && row.knowledgeId !== id);
      if (nextPending) { await open(nextPending.knowledgeId); setBatchRunId(candidateReviewRun(current.runs, nextPending.knowledgeId)?.runId ?? null); }
      else setShowBatchSummary(true);
    }
  }
  async function decide(choice: 'retain' | 'discard') {
    if (!detail || needsRefresh || !reason.trim()) return;
    const id = detail.revision.knowledgeId;
    const revision = detail.revision.revisionId;
    const latest = revision === detail.history.writeHeadRevisionId;
    await api('maintain', { id, revision, generation: detail.history.generation, choice, reason: reason.trim() });
    setPreviousId(id);
    setNotice(choice === 'retain' ? t('已记录保留决定与理由。', 'Recorded your decision to retain, with the reason.')
      : t('已记录舍弃决定与理由；该修订仍在历史中。', 'Recorded your decision to discard, with the reason; the revision stays in its history.'));
    try { await continueReview(id, latest ? undefined : revision, latest); }
    catch {
      setNeedsRefresh(true);
      setError(t('决定已保存，但未能读取最新进度。重新读取后再继续。', 'Your decision was saved, but progress could not be loaded. Reload before continuing.'));
    }
  }
  async function saveTags() {
    if (!detail || needsRefresh) return;
    const id = detail.revision.knowledgeId;
    await api('tag', { id, generation: detail.tagging.generation, tags: tagsDraft });
    try {
      await refresh(); await open(id, detail.revision.revisionId);
      setNotice(t('标签已保存，知识内容和保留决定保持原样。', 'Tags saved. Knowledge content and retention decisions are unchanged.'));
    } catch {
      setNeedsRefresh(true);
      setError(t('标签已保存，但未能读取最新结果。重新读取后再继续。', 'Tags were saved, but the result could not be loaded. Reload before continuing.'));
    }
  }
  const batch = projectCandidateBatch(runs.find(run => run.runId === batchRunId), rows, detail?.revision.knowledgeId);
  const summary = showBatchSummary && batch?.complete;
  const visibleRows = batch ? batch.rows : rows.filter(row => candidateMatches(row, filter, query) && (kind === 'all' || row.knowledgeKind === kind));
  useEffect(() => {
    if (busy || error || needsRefresh || batch || !rows.length) return;
    if (detail && visibleRows.some(row => row.knowledgeId === detail.revision.knowledgeId)) return;
    if (visibleRows[0]) void work(() => open(visibleRows[0].knowledgeId));
    else setDetail(null);
  }, [busy, error, needsRefresh, batchRunId, query, filter, kind, rows, detail?.revision.knowledgeId]);
  const originHref = detail?.origin ? `${conversationPath(detail.origin.threadId, detail.origin.turnId)}?${new URLSearchParams({ workspace })}` : undefined;
  return <section className="knowledge-candidates knowledge-core">
    {!embedded && <KnowledgeSectionNav active="candidates" lang={lang}/>}
    <header className="candidate-heading"><div><h1>{scope ? t('知识待办', 'Knowledge inbox') : t('候选核对', 'Candidate review')}</h1></div>
      <Space wrap>{!embedded && <Button disabled={busy} onClick={() => { setWorkspaceDraft(workspace); setShowSettings(true); }}>{t('保存位置', 'Save location')}</Button>}
        {!embedded && rows.length > 0 && <Button type="primary" disabled={busy} onClick={chooseConversation}>{t('提炼新知识', 'Extract new knowledge')}</Button>}
        {busy && <Button onClick={() => controller.current?.abort()}>{t('取消', 'Cancel')}</Button>}
        <Dropdown trigger={['click']} menu={{ items: [
          { key: 'study', label: t('核对研究证据', 'Inspect study evidence') },
          { key: 'history', label: t('提炼记录', 'Extraction history'), disabled: busy || !workspace },
          { key: 'import', label: t('导入日志文件', 'Import a log file'), disabled: busy || !workspace || embedded },
        ], onClick: ({ key }) => {
          if (key === 'study') setShowStudy(true);
          if (key === 'history') void work(async () => { await refresh(); setShowRuns(true); });
          if (key === 'import') { setSnapshot(null); setPolicy(undefined); setShowImport(true); }
        } }}><Button ref={moreControl}>{t('更多', 'More')}</Button></Dropdown>
      </Space></header>
    {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} action={needsRefresh && detail ? <Button disabled={busy} onClick={() => void work(async () => { await continueReview(detail.revision.knowledgeId, detail.revision.revisionId, detail.revision.revisionId === detail.history.writeHeadRevisionId); setError(''); })}>{t('重新读取', 'Reload')}</Button> : undefined}/>}
    {needsRefresh && !error && detail && <Button disabled={busy} onClick={() => void work(() => continueReview(detail.revision.knowledgeId, detail.revision.revisionId, detail.revision.revisionId === detail.history.writeHeadRevisionId))}>{t('重新读取后继续', 'Reload to continue')}</Button>}
    {detail?.origin && !summary && <Link href={`${conversationPath(detail.origin.threadId, detail.origin.turnId)}?${new URLSearchParams({ workspace })}`}>{t('返回原始对话：', 'Back to conversation: ')}{conversationLabel(detail.origin.title, t('系统或附件记录', 'System or attachment record'))}</Link>}
    {notice && <Alert type="info" title={notice} closable onClose={() => setNotice('')}/>}
    {batch && !summary && <CandidateReviewProgress batch={batch} lang={lang} busy={busy} previous={!!previousId && previousId !== detail?.revision.knowledgeId} onPrevious={() => { if (previousId) void work(() => open(previousId)); }} onLibrary={leaveBatch}/>}
    {rows.length > 0 && <Button className="knowledge-directory-toggle" aria-expanded={directory} onClick={() => setDirectory(value => !value)}>{directory ? t('返回正文', 'Back to content') : t('知识目录', 'Knowledge directory')}</Button>}

    {rows.length === 0 && scope ? <ScopedCandidateEmpty lang={lang} loading={loading} busy={busy} failedToLoad={failedToLoad} onRetry={retryCandidates}/> : rows.length === 0 ? <KnowledgeCandidateStart lang={lang} loading={loading} busy={busy} latest={runs[0]} failedToLoad={failedToLoad}
      onChoose={chooseConversation} onHistory={() => setShowRuns(true)} onRetry={retryCandidates} onEntities={analysisId => setEntityTarget({ analysisId })}/>
      : <div className={`knowledge-workbench candidate-columns${directory ? ' knowledge-directory-open' : ''}`}>
      <aside className="knowledge-directory candidate-list" aria-label={t('候选知识', 'Candidate knowledge')}>
    {rows.length > 0 && !batch && <div className="knowledge-directory-filters candidate-library-tools">
      <Input allowClear aria-label={t('搜索标题或标签', 'Search titles or tags')} placeholder={t('搜索标题或标签；tag:排障 精确筛选标签', 'Search titles or tags; tag:debugging filters by tag')} value={query} onChange={event => { setQuery(event.target.value); setDetail(null); }}/>
      <Select aria-label={t('按处理状态筛选', 'Filter by decision')} value={filter} onChange={value => { setFilter(value); setDetail(null); }} options={[
        { value: 'all', label: t(`全部 ${rows.length}`, `All ${rows.length}`) },
        { value: 'pending', label: t(`待处理 ${rows.filter(row => row.choice === null).length}`, `Undecided ${rows.filter(row => row.choice === null).length}`) },
        { value: 'retain', label: t(`已保留 ${rows.filter(row => row.choice === 'retain').length}`, `Retained ${rows.filter(row => row.choice === 'retain').length}`) },
        { value: 'discard', label: t(`已舍弃 ${rows.filter(row => row.choice === 'discard').length}`, `Discarded ${rows.filter(row => row.choice === 'discard').length}`) },
      ]}/>
      <Select aria-label={t('知识类型', 'Knowledge type')} value={kind} onChange={value => { setKind(value); setDetail(null); }} options={[{ value: 'all', label: t('全部类型', 'All types') }, { value: 'fact', label: t('事实', 'Fact') }, { value: 'case', label: t('案例', 'Case') }, { value: 'method', label: t('方法', 'Method') }]}/>
    </div>}
<div className="knowledge-directory-scroll">
        {visibleRows.length ? visibleRows.map((row) => <button key={row.knowledgeId} disabled={busy} className={`knowledge-directory-row${detail?.revision.knowledgeId === row.knowledgeId ? ' selected' : ''}`} onClick={event => { if (directory) event.currentTarget.closest('.knowledge-core')?.querySelector<HTMLButtonElement>('.knowledge-directory-toggle')?.focus(); setDirectory(false); void work(() => open(row.knowledgeId)); }}>
          <strong title={row.title}>{row.title}</strong><CandidateRowStatus choice={row.choice} lang={lang}/></button>) : <Empty description={t('没有匹配的知识，请调整搜索或处理状态。', 'No matching knowledge. Adjust the search or decision filter.')} image={Empty.PRESENTED_IMAGE_SIMPLE}/>}
      </div><footer className="knowledge-directory-footer" role="status">{t(`${visibleRows.length} 条结果`, `${visibleRows.length} results`)}</footer></aside>
      {summary && batch ? <article className="knowledge-reader"><div className="knowledge-reader-scroll"><div className="knowledge-reading"><CandidateReviewSummary batch={batch} lang={lang} workspace={workspace} originHref={originHref} busy={busy} onRevisit={() => { if (previousId || detail) void work(() => open(previousId ?? detail!.revision.knowledgeId)); }} onLibrary={leaveBatch} onGenerate={() => setAuthoringIds(rows.filter(row => row.choice === 'retain' && runs.find(run => run.runId === batchRunId)?.committed.some(item => item.knowledgeId === row.knowledgeId)).map(row => row.knowledgeId))}/></div></div></article>
        : detail ? <KnowledgeReader detail={detail} lang={lang} busy={busy || needsRefresh}
          onRevision={revision => void work(() => open(detail.revision.knowledgeId, revision))}
          onRetry={() => void work(() => open(detail.revision.knowledgeId, detail.revision.revisionId))}
          onEntities={() => { if (detail.grounding.entityAnalysisRef) setEntityTarget({ analysisId: detail.grounding.entityAnalysisRef.analysisId, revision: detail.grounding.entityAnalysisRef.revisionId }); }}
          onApplyEntities={needsRefresh ? undefined : () => setApplyingEntities(true)}
          onDeleteSource={snapshot => Modal.confirm({ title: t('删除此来源快照？', 'Delete this source snapshot?'), content: t('共享此来源的候选将无法再查看原文，知识修订仍保留。', 'Candidates sharing this source will lose original text access. Knowledge revisions remain.'), onOk: () => work(async () => { await api('delete-source', { snapshot }); await open(detail.revision.knowledgeId, detail.revision.revisionId); }) })}
          tools={<CandidateTags lang={lang} tags={tagsDraft} busy={busy || needsRefresh} onChange={setTagsDraft} onSave={() => void work(saveTags)} changed={JSON.stringify(tagsDraft) !== JSON.stringify(detail.tagging.tags)}/>}
          footer={<>{detail.maintenance?.choice === 'retain' && detail.revision.revisionId === detail.history.writeHeadRevisionId && <Button disabled={busy || needsRefresh} onClick={() => setAuthoringIds([detail.revision.knowledgeId])}>{t('生成知识载体', 'Generate knowledge artifact')}</Button>}
            <CandidateDecisionActions lang={lang} reason={reason} busy={busy} needsRefresh={needsRefresh} choice={decisionChoice} onChoice={setDecisionChoice} onReason={setReason}
              onEdit={() => setEditing(true)} onDecision={choice => void work(() => decide(choice))}/></>}/>
          : <div className="knowledge-reader knowledge-reader-empty"><Empty description={t('没有匹配知识，请调整筛选。', 'No matching knowledge. Adjust the filters.')} image={Empty.PRESENTED_IMAGE_SIMPLE}/></div>}
    </div>}
    {authoringIds && <ArtifactAuthoringDialog key={workspace} workspace={workspace} lang={lang} ids={authoringIds} onClose={() => setAuthoringIds(null)}/>}
    {showStudy && <KnowledgeStudyInspectionDrawer lang={lang} onClose={() => setShowStudy(false)}/>}
    {entityTarget && <EntityAnalysisDrawer key={`${workspace}:${entityTarget.analysisId}:${entityTarget.revision ?? ''}`} workspace={workspace} analysisId={entityTarget.analysisId} initialRevision={entityTarget.revision}
      lang={lang} onClose={() => setEntityTarget(undefined)}/>}
    {applyingEntities && detail && <ApplyEntitiesDialog key={`${workspace}:${detail.revision.revisionId}`} detail={detail} workspace={workspace} lang={lang} onClose={closeRevisionEditor} onReadback={readbackDetail} onSaved={saved => {
      notifyKnowledgeChange(workspace); setApplyingEntities(false); setDetail(saved); setReason(''); setNeedsRefresh(false);
      setNotice(t('已保存绑定实体新修订的知识。请重新核对并决定保留或舍弃。', 'Saved knowledge bound to the new entity revision. Review it and make a new retention decision.'));
      void work(async () => { await refresh(); await open(saved.revision.knowledgeId); });
    }}/>}
    {showExtraction && <ConversationExtractionDialog initialWorkspace={workspace} lang={lang} onClose={() => setShowExtraction(false)} onFinished={root => {
      void work(async () => {
        const changed = root !== workspace;
        await refresh(root, changed); setWorkspace(root); setWorkspaceDraft(root);
        if (changed) {
          leaveBatch(); setNeedsRefresh(false); setSnapshot(null); setNotice('');
          const url = new URL(window.location.href); url.searchParams.set('workspace', root); url.searchParams.delete('id'); url.searchParams.delete('revision'); window.history.replaceState(null, '', url);
        }
      });
    }} onReview={async (root, id, signal) => {
      const [nextRows, nextRuns, nextDetail] = await Promise.all([
        api<KnowledgeCandidateRow[]>('list', { workspace: root }, signal), api<KnowledgeCandidateRun[]>('runs', { workspace: root }, signal),
        api<KnowledgeCandidateDetail>('show', { workspace: root, id }, signal),
      ]);
      if (signal.aborted) return;
      setRows(nextRows); setRuns(nextRuns); setDetail(nextDetail); setReason('');
      setBatchRunId(candidateReviewRun(nextRuns, id)?.runId ?? null); setPreviousId(null); setShowBatchSummary(false); setNeedsRefresh(false);
      setWorkspace(root); setWorkspaceDraft(root); setQuery(''); setFilter('all'); setSnapshot(null); setError(''); setNotice(''); setShowExtraction(false);
      const url = new URL(window.location.href); url.searchParams.set('workspace', root); url.searchParams.set('id', id); window.history.replaceState(null, '', url);
    }}/>}
    <Drawer title={t('保存位置', 'Save location')} open={showSettings} onClose={() => !busy && setShowSettings(false)} size={560}>
      <div className="candidate-form">{error && <Alert type="error" title={error}/>}<p>{t('这里仅调整本次操作的保存位置。长期默认目录请在侧栏“设置与帮助”中修改；已有数据不会移动。', 'Change the folder for this operation only. Edit global Settings for the long-term default; existing data will not move.')}</p>
        <p className="candidate-help">{t('全局位置：', 'Global location: ')}{defaultWorkspace}</p><Button disabled={busy || !defaultWorkspace} onClick={() => setWorkspaceDraft(defaultWorkspace)}>{t('使用全局位置', 'Use global location')}</Button>
        <label>{t('本地保存目录', 'Local folder')}<Input value={workspaceDraft} disabled={busy} placeholder={t('输入保存目录的完整路径', 'Enter the full folder path')} onChange={(event) => setWorkspaceDraft(event.target.value)}/></label>
        <Button type="primary" loading={busy} disabled={!workspaceDraft.trim()} onClick={() => void work(async () => {
          const root = workspaceDraft.trim();
          await refresh(root, true); leaveBatch(); setNeedsRefresh(false); setWorkspace(root); setSnapshot(null); setNotice(''); setShowSettings(false);
          const url = new URL(window.location.href); url.searchParams.set('workspace', root); url.searchParams.delete('id'); url.searchParams.delete('revision'); window.history.replaceState(null, '', url);
        })}>{t('使用此保存位置', 'Use this location')}</Button>
      </div>
    </Drawer>
    <Drawer title={snapshot ? t('确认提炼内容与模型', 'Confirm content and model') : t('导入日志文件', 'Import a log file')} open={showImport} onClose={() => !busy && setShowImport(false)} size={560}>
      <div className="candidate-form">{error && <Alert type="error" title={error}/>}{!snapshot && <p>{t('选择包含项目事实、你的纠正，或问题处理经过的记录。先在本地预览，再决定是否交给模型提炼。', 'Choose a record containing project facts, your corrections, or a problem and its resolution. Preview it locally before sending it to a model.')}</p>}
        {!snapshot?.origin && <><label>{t('工作记录文件（Codex JSONL）', 'Work log file (Codex JSONL)')}<Input placeholder="/.../rollout-….jsonl" value={source} disabled={busy} onChange={(event) => { setSource(event.target.value); setSnapshot(null); }}/></label>
        <p className="candidate-help">{t('粘贴这台电脑上日志文件的完整路径。默认读取整份文件，可在下方缩小范围。', 'Paste the full path to a log file on this computer. Read the entire file or narrow the range below.')}</p>
        <details><summary>{t('只选部分记录（可选）', 'Select a record range (optional)')}</summary><Space wrap><label>{t('起始记录（从零开始）', 'First record (zero-based)')}<InputNumber min={0} value={start} disabled={busy} onChange={(value) => { setStart(value); setSnapshot(null); }}/></label><label>{t('结束记录（包含）', 'Last record (inclusive)')}<InputNumber min={0} value={end} disabled={busy} onChange={(value) => { setEnd(value); setSnapshot(null); }}/></label></Space></details>
        <Button loading={busy} disabled={!source.trim()} onClick={() => void work(async () => { setSnapshot(await api('capture', { source, ...(start === null ? {} : { startRecord: start }), ...(end === null ? {} : { endRecord: end }) })); })}>{t('读取并预览', 'Read and preview')}</Button></>}
        {snapshot && <><section>{snapshot.origin && <p>{t('来源会话：', 'Source session: ')}{snapshot.origin.title}</p>}<h3 className="candidate-form-heading">{t('核对将要提炼的内容', 'Review the selected content')}</h3>
          <p className="candidate-help">{t('以下内容已在本地读取，尚未发送给模型。', 'This content was read locally and has not been sent to a model.')}</p>
          <pre className="candidate-source-preview">{snapshot.excerpts.map((entry) => `[${entry.role ?? entry.eventKind}] ${entry.text}`).join('\n\n')}</pre>
        </section><h3 className="candidate-form-heading">{t('选择用于提炼的模型', 'Choose a model for extraction')}</h3>
        <label>{t('调用方式', 'Provider')}<Select style={{ width: '100%' }} value={executor} disabled={busy} onChange={value => { setExecutor(value); setModel(''); }} options={['codex', 'openai-api'].map((value) => ({ value, label: value }))}/></label>
        <label>{t('模型（明确配置）', 'Model (explicit configuration)')}<Input value={model} disabled={busy} onChange={(event) => setModel(event.target.value)}/></label>
        <GenerationPolicyFields lang={lang} value={policy} presentation="summary"/>
        <details className="conversation-extract-options"><summary>{t('调整调用与预算上限', 'Adjust invocation and budget limits')}</summary><GenerationPolicyFields lang={lang} value={policy} onChange={setPolicy} disabled={busy} presentation="fields"/></details>
        <Alert type="info" title={t(`将发送 ${snapshot.excerpts.length} 个选定片段给 ${executor} / ${model || '—'}。`, `Send ${snapshot.excerpts.length} selected excerpts to ${executor} / ${model || '—'}.`)} description={`${snapshot.sourcePath} · ${snapshot.startRecord}–${snapshot.endRecord}`}/>
          {snapshot.limitations.map((item, index) => <Alert type="warning" key={index} title={item}/>)}
          <p>{t('仅处理选定输入；不会自动修改 AGENTS.md 或 skill。模型费用以执行器实际报告为准。', 'Only selected input is processed. No automatic AGENTS.md or skill edits. Cost depends on executor reporting.')}</p>
          <Button type="primary" loading={busy} disabled={!model.trim() || snapshot.excerpts.length === 0} onClick={() => void work(async () => { const run = await api<KnowledgeCandidateRun>('generate', { snapshot: snapshot.snapshotId, executor, model, runId: crypto.randomUUID(), ...(policy ? { policy } : {}) }); setShowImport(false); await handleRun(run); })}>{t('开始提炼', 'Start extraction')}</Button></>}
      </div>
    </Drawer>
    {editing && detail && <KnowledgeRevisionDrawer key={`${workspace}:${detail.revision.knowledgeId}:${detail.revision.revisionId}`} detail={detail} workspace={workspace} lang={lang}
      onClose={closeRevisionEditor} onReadback={readbackDetail} onSaved={saved => {
        setEditing(false); setDetail(saved); setReason(''); notifyKnowledgeChange(workspace);
        setNotice(t('已保存新修订，需要重新决定保留或舍弃。', 'Saved a new revision. Decide again whether to retain or discard it.'));
        void work(async () => { await refresh(); await open(saved.revision.knowledgeId); });
      }}/>}
    <Drawer title={t('提炼记录', 'Extraction history')} open={showRuns} onClose={() => setShowRuns(false)} size="min(620px, 100vw)">
      <Button onClick={() => { setShowRuns(false); setShowStudy(true); }}>{t('核对研究证据', 'Inspect study evidence')}</Button>
      <p className="candidate-help">{t('仅显示当前 v5 运行。旧 runs/ 记录不在此读取，已有来源、实体 v2 与知识 v2 仍可在同一目录使用。', 'Only current v5 runs are shown. Former runs/ records are not read here; existing sources, entity v2 and knowledge v2 remain usable in this workspace.')}</p>
      {showRuns && workspace && <ExtractionQualityPanel workspace={workspace} lang={lang}/>}

      {runs.length ? runs.map((run) => <section className="candidate-statement" key={run.runId}><strong>{extractionRunStatusLabel(run.status, lang)}</strong><p>{run.runId}</p><p>{run.startedAt}</p><p>{run.committed.length} {t('条候选', 'candidates')} / {run.rejections.length} {t('条拒绝输出', 'rejected outputs')}</p>
        <ExtractionInvocationSummary invocation={run.invocation} lang={lang}/>
        <EntityAnalysisSummary run={run} lang={lang} disabled={busy} onOpen={analysisId => { setShowRuns(false); setEntityTarget({ analysisId }); }}/>
        {run.committed.length > 0 && <Button disabled={busy} onClick={() => void work(async () => { const current = await refresh(); const batch = projectCandidateBatch(run, current.rows); await open(batch?.rows.find(row => row.choice === null)?.knowledgeId ?? run.committed[0]!.knowledgeId); setBatchRunId(run.runId); setPreviousId(null); setShowRuns(false); })}>{t('核对本批候选', 'Review this batch')}</Button>}<Button disabled={busy || !['prepared', 'generating', 'cancelled', 'failed'].includes(run.status)} onClick={() => void work(async () => { await handleRun(await api('resume', { id: run.runId })); setRuns(await api('runs')); })}>{t('恢复归档或保存', 'Resume archiving or saving')}</Button></section>) : <Empty/>}
    </Drawer>
  </section>;
}

/** Present the safe domain summary without loading raw outcomes or interpreting usage. */
function ExtractionInvocationSummary({ invocation, lang }: { invocation: KnowledgeCandidateRun['invocation']; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  return <details className="candidate-help extraction-invocation">
    <summary>{t('结果证据归档：', 'Outcome evidence archive: ')}{invocation.archiveStatus === 'recorded' ? t('已记录', 'Recorded') : t('待归档', 'Pending')}
      {invocation.failureKind !== null && <> · {t('失败类别：', 'Failure category: ')}{invocation.failureKind}</>}</summary>
    <p>{invocation.policyId === 'knowledge-generation-single/v1'
      ? t(`本运行限 ${invocation.limits.maxInvocations} 次 OMK 调用；不自动重试或 fallback。`, `This run permits ${invocation.limits.maxInvocations} OMK invocation; no automatic retry or fallback.`)
      : t(`本运行最多 ${invocation.limits.maxInvocations} 次 OMK 调用，含最多 ${invocation.limits.maxReasks} 次校验重问；不使用 fallback。`, `This run permits up to ${invocation.limits.maxInvocations} OMK invocations, including up to ${invocation.limits.maxReasks} validation reasks; no fallback.`)}</p>
    <p>{t('已记录 OMK 调用尝试：', 'Recorded OMK invocation attempts: ')}{invocation.attemptCount}</p>
    <p>{invocation.budget.maxTotalTokens === undefined
      ? t('未启用 token 预约预算。', 'No token reservation budget is enabled.')
      : t(`token 预约已用 ${invocation.budget.reservedTokens}／总额 ${invocation.budget.maxTotalTokens}；已预约额度不返还。`, `Token reservation used ${invocation.budget.reservedTokens} / total ${invocation.budget.maxTotalTokens}; reservations are not refunded.`)}</p>
    {invocation.policyId === 'knowledge-generation-bounded/v1'
      ? <p>{t('观测 token 用量：', 'Observed token usage: ')}{invocation.budget.observedTokens ?? t('未知', 'Unknown')} · {t('用量未知调用：', 'Invocations with unknown usage: ')}{invocation.budget.unknownAttempts}</p>
      : <p>{t('未启用预约核算；原生用量见运行详情。', 'Reservation accounting is not enabled; inspect the run details for native usage.')}</p>}
    <p>{t('策略：', 'Policy: ')}<code>{invocation.policyId}</code> · {t('输出模式：', 'Output mode: ')}<code>{invocation.outputMode}</code></p>
    <p>{t('结构线协议：', 'Structural wire: ')}{invocation.wireId === null ? t('未使用', 'Not used') : <code>{invocation.wireId}</code>}</p>
    <p>{invocation.archiveStatus === 'pending'
      ? t('待归档不能证明请求未发送或费用为零；恢复不会再次调用模型。', 'Pending archival does not prove the request was unsent or cost zero; resume never calls the model again.')
      : t('已记录归档引用，不代表当前归档完整性已校验，也不代表内容已通过接纳或质量验证；恢复时会校验归档，不会再次调用模型。', 'Recorded archive references do not verify current archive integrity, admission or quality; resume validates the archive and never calls the model again.')}</p>
  </details>;
}

export function candidateMatches(row: Pick<KnowledgeCandidateRow, 'title' | 'choice' | 'tags'>, filter: 'all' | 'pending' | 'retain' | 'discard', query: string): boolean {
  const search = query.trim().toLowerCase();
  const tagQuery = search.startsWith('tag:') ? search.slice(4).replace(/^#/, '') : undefined;
  const matches = tagQuery !== undefined ? !!tagQuery && (row.tags ?? []).some(tag => tag.toLowerCase() === tagQuery || tag.toLowerCase().startsWith(`${tagQuery}/`))
    : row.title.toLowerCase().includes(search) || (row.tags ?? []).some(tag => tag.toLowerCase().includes(search));
  return matches && (filter === 'all' || (filter === 'pending' ? row.choice === null : row.choice === filter));
}

export function CandidateTags({ lang, tags, busy, changed, onChange, onSave }: {
  lang: Language; tags: string[]; busy: boolean; changed: boolean; onChange(tags: string[]): void; onSave(): void;
}) {
  const zh = lang === 'zh';
  return <div className="candidate-form">
    <label>{zh ? '主题标签' : 'Topic tags'}<Select mode="tags" aria-label={zh ? '主题标签' : 'Topic tags'} value={tags} disabled={busy} maxCount={32} maxTagCount="responsive"
      onChange={onChange} placeholder={zh ? '例如：排障/证据判断、Taro' : 'For example: debugging/evidence, Taro'}/></label>
    <p className="candidate-help">{zh ? '使用中文、字母、数字、下划线、连字符或 /，不含空格；最多 32 个。标签用于组织与检索，不表示知识已验证。' : 'Use letters, numbers, underscores, hyphens or /, without spaces; up to 32 tags. Tags organize knowledge and do not verify it.'}</p>
    <Button disabled={busy || !changed} onClick={onSave}>{zh ? '保存标签' : 'Save tags'}</Button>
  </div>;
}

/** 列表行只报用户做过的决定；恒定的复核维度在详情头说明一次，不逐行重复。 */
export function CandidateRowStatus({ choice, lang }: { choice: CandidateChoice; lang: Language }) {
  return <span>{candidateDecisionLabel(choice, lang)}</span>;
}

/** 决定必须留下理由，理由就要看得见：标签只报维护决定，已做决定时回显理由、决定人与时间。 */
export function ScopedCandidateEmpty({ lang, loading, busy, failedToLoad, onRetry }: {
  lang: Language; loading: boolean; busy: boolean; failedToLoad: boolean; onRetry(): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  if (loading) return <p role="status">{t('正在读取此来源范围的候选…', 'Loading candidates in this source scope…')}</p>;
  if (failedToLoad) return <div role="status"><p>{t('暂时无法读取此来源范围的候选。请检查保存位置，再重新读取；读取失败不表示没有候选。', 'Could not load candidates in this source scope. Check the save location and retry; a failed read does not mean there are no candidates.')}</p><Button disabled={busy} onClick={onRetry}>{t('重新读取候选', 'Reload candidates')}</Button></div>;
  return <Empty description={t('此来源范围没有候选。回到对话开启自动提炼，或手动选择消息提炼。', 'No candidates in this source scope. Enable auto extraction in a conversation or extract selected messages manually.')}/>;
}

export function KnowledgeCandidateStart({ lang, loading, busy, latest, failedToLoad, onChoose, onHistory, onRetry, onEntities }: {
  lang: Language; loading: boolean; busy: boolean;
  latest?: KnowledgeCandidateRun; failedToLoad?: boolean; onChoose(): void; onHistory(): void; onRetry?(): void; onEntities?(id: string): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const emptyResult = latest?.status === 'completed' && latest.committed.length === 0;
  return <div className="candidate-start">
    <div className="candidate-start-main">
      <h2>{t('选一段工作记录，找出值得复用的经验', 'Find reusable knowledge in a work log')}</h2>
      <p className="candidate-start-intro">{t('OMK 帮你整理其中的项目事实、解决方法和经验。你核对原文，决定哪些值得留下。', 'OMK proposes project facts, methods, and lessons. Compare them with the original text and choose what to keep.')}</p>
      <div className="candidate-start-action"><Button type="primary" size="large" disabled={busy} onClick={onChoose}>{t('从对话选择', 'Choose a conversation')}</Button>
        <span>{t('先预览内容，再确认发送给模型。', 'Preview the content before confirming a model request.')}</span>
      </div>
      <ol className="candidate-steps">
        <li><strong>{t('选择记录', 'Choose a record')}</strong><span>{t('在这里选择对话和轮次，或阅读对话时点击提炼这轮。', 'Choose a conversation and turn here, or click Extract this turn while reading.')}</span></li>
        <li><strong>{t('预览并提炼', 'Preview and extract')}</strong><span>{t('确认内容和模型，生成待核对的知识。', 'Confirm the content and model to propose knowledge.')}</span></li>
        <li><strong>{t('核对并保留', 'Review and keep')}</strong><span>{t('对照原文，保留、修改或舍弃。', 'Check the original text, then keep, edit, or discard.')}</span></li>
      </ol>
      <p className="candidate-help">{t('保留后可随时重读；不会自动改写你的 AGENTS.md 或 skill。', 'Reopen saved knowledge any time. Your AGENTS.md and skills are not changed automatically.')}</p>
    </div>
    <aside className="candidate-start-side">
      <h3>{t('什么记录适合提炼？', 'What makes a useful record?')}</h3>
      <ul><li>{t('项目的明确事实与约束', 'Explicit project facts and constraints')}</li><li>{t('你对助手做出的具体纠正', 'A specific correction you gave the assistant')}</li><li>{t('问题处理经过，以及成功或失败的结果', 'How a problem was handled and what happened')}</li></ul>
      <div className="candidate-last-run" role="status">
        {loading ? <p>{t('正在读取提炼记录…', 'Loading extraction history…')}</p> : failedToLoad ? <><p>{t('暂时无法读取已有记录。请检查保存位置，再重新读取；读取失败不表示没有候选。', 'Could not load existing records. Check the save location and retry; a failed read does not mean there are no candidates.')}</p>{onRetry && <Button disabled={busy} onClick={onRetry}>{t('重新读取候选', 'Reload candidates')}</Button>}</> : latest ? <>
          <strong>{emptyResult ? t('上次提炼完成，返回 0 条候选', 'Last extraction completed with 0 candidates') : t(`上次提炼：${extractionRunStatusLabel(latest.status, lang)}`, `Last extraction: ${extractionRunStatusLabel(latest.status, lang)}`)}</strong>
          <p>{emptyResult ? (latest.rejections.length ? t('部分输出未通过引用或格式校验，详情见提炼记录。', 'Some output failed citation or format checks. See the extraction history.') : t('可以换一份包含具体事实、纠正或处理结果的记录再试。', 'Try a record with concrete facts, corrections, or outcomes.')) : t('查看提炼记录，了解结果或继续未完成的保存。', 'Inspect the extraction history for results or unfinished saves.')}</p>
          <ExtractionInvocationSummary invocation={latest.invocation} lang={lang}/>
          {onEntities && <EntityAnalysisSummary run={latest} lang={lang} disabled={busy} onOpen={onEntities}/>}
          <Button type="link" disabled={busy} onClick={onHistory}>{t('查看提炼记录', 'View extraction history')}</Button>
        </> : <p>{t('尚无当前 v5 提炼记录；旧 runs/ 记录不在此读取。从左侧选择工作记录开始。', 'No current v5 extraction records; former runs/ records are not read here. Choose a work log to begin.')}</p>}
      </div>
    </aside>
  </div>;
}
