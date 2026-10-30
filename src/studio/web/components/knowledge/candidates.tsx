'use client';
import Link from 'next/link';
import { requestKnowledge } from './request';
import { notifyKnowledgeChange, resolveKnowledgeWorkspace } from './workspace';
import { ArtifactAuthoringDialog } from './artifact-authoring';
import { SourceExtractionDialog, PreparedGenerationDialog, generationStageLabel } from './source-picker';
import { ConversationExtractionDialog } from './conversation-extraction';
import { EntityAnalysisDrawer, EntityAnalysisSummary } from './entity-analysis';
import { KnowledgeRevisionDrawer } from './revision-editor';
import { AssociationMappingDrawer } from './association-mapping';
import { candidateReviewRun, projectCandidateBatch } from '../../../application/knowledge/candidate-review';
import { CandidateDecisionActions, CandidateReviewProgress, CandidateReviewSummary } from './candidate-review';
import { KnowledgeReader } from './reader';
import type { KnowledgeReaderSelection } from './reader';
import { SourceReviewPanel } from './source-review';
import type { KnowledgeBodyRef } from '../../../../knowledge/contracts';
import type { SourceCoverageDecisionRef } from '../../../../knowledge/source-review';
import { KnowledgeReviewDrawer } from './review-drawer';
import { ExtractionQualityPanel, NativeArchiveChecks } from './extraction-quality';
import { KnowledgeStudyInspectionDrawer } from './study-inspection';
import { KnowledgeSectionNav } from './section-nav';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Dropdown, Empty, Input, Modal, Select, Space } from 'antd';
import { type Language } from '../layout/shell';
import { conversationPath } from '../conversation-link';
import { conversationLabel } from '../../../application/display/conversation-label';
import { candidateDecisionLabel, extractionRunStatusLabel, type CandidateChoice } from '../../../application/knowledge/candidate-status';
import type { KnowledgeCandidateDetail, KnowledgeCandidateRow, KnowledgeCandidateRun, KnowledgeCandidateQueue } from '../../../view-models/knowledge/knowledge-candidates';

export function KnowledgeCandidates({ lang, initialWorkspace = '', initialId, initialRevision, initialSegmentId, initialEdit = false, initialReason, scope, embedded = false, onLoaded }: { lang: Language; initialWorkspace?: string; initialId?: string; initialRevision?: string; initialSegmentId?: string; initialEdit?: boolean; initialReason?: string; scope?: { threadId?: string; projectId?: string }; embedded?: boolean; onLoaded?(queue: KnowledgeCandidateQueue): void }) {
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
  const [executor, setExecutor] = useState('codex');
  const [model, setModel] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [preparedSend, setPreparedSend] = useState<{ run: KnowledgeCandidateRun; operation: 'continue-stage'; fields: Record<string, unknown> }>();
  const [sourceReviewTarget, setSourceReviewTarget] = useState<{ workspace: string; run: KnowledgeCandidateRun; bodyRef?: KnowledgeBodyRef }>();
  const [showRuns, setShowRuns] = useState(false);
  const [showStudy, setShowStudy] = useState(false);
  const [entityTarget, setEntityTarget] = useState<{ analysisId: string; revision?: string }>();
  const [runs, setRuns] = useState<KnowledgeCandidateRun[]>([]);
  const [batchRunId, setBatchRunId] = useState<string | null>(null);
  const [previousId, setPreviousId] = useState<string | null>(null);
  const [showBatchSummary, setShowBatchSummary] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [editing, setEditing] = useState(false);
  const [contentReview, setContentReview] = useState<{ detail: KnowledgeCandidateDetail; workspace: string }>();
  const [readerSelection, setReaderSelection] = useState<KnowledgeReaderSelection>({ tab: 'body', segmentId: initialSegmentId });
  const [mapping, setMapping] = useState(false);
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
    if (['maintain', 'revise', 'apply-associations', 'review-associations', 'review-source-coverage', 'resume'].includes(operation)) notifyKnowledgeChange(workspace);
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
    setRows(nextRows); setRuns(nextRuns); setFailedToLoad(false); onLoaded?.({ rows: nextRows, runs: nextRuns });
    if (selectFirst) { setDetail(nextDetail ?? null); setReason('');
      if (scope && first) setBatchRunId(candidateReviewRun(nextRuns, first.knowledgeId)?.runId ?? null);
    }
    return { rows: nextRows, runs: nextRuns };
    } catch (cause) { setFailedToLoad(true); throw cause; }
    finally { setLoading(false); }
  }
  async function open(id: string, revision?: string, root = workspace, activateBatch = false) {
    const next = await api<KnowledgeCandidateDetail>('show', { workspace: root, id, ...(revision ? { revision } : {}) });
    setDetail(next); setReaderSelection({ tab: 'body', ...(id === initialId && revision === initialRevision && initialSegmentId ? { segmentId: initialSegmentId } : {}) }); setReason(''); setShowBatchSummary(false); setNeedsRefresh(false);
    if (activateBatch) { setBatchRunId(candidateReviewRun(runs, id)?.runId ?? null); setPreviousId(null); }
    if (embedded) return;
    const url = new URL(window.location.href); url.searchParams.set('id', id); if (revision) url.searchParams.set('revision', revision); else url.searchParams.delete('revision'); url.searchParams.set('workspace', root); if (id !== initialId || revision !== initialRevision) { for (const key of ['edit', 'segment', 'reason']) url.searchParams.delete(key); } window.history.replaceState(null, '', url);
  }
  function readbackDetail(latest: KnowledgeCandidateDetail) {
    setEditing(false); setMapping(false); setDetail(latest); setNeedsRefresh(false); setError(''); setReason('');
    if (!embedded) {
      const url = new URL(window.location.href); url.searchParams.set('id', latest.revision.knowledgeId);
      url.searchParams.set('revision', latest.revision.revisionId); url.searchParams.set('workspace', workspace); window.history.replaceState(null, '', url);
    }
  }
  function closeRevisionEditor(needsReadback: boolean) {
    setEditing(false); setMapping(false);
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
      if (root) { const current = await refresh(root, true); if (initialId) { await open(initialId, initialRevision, root); if (initialEdit && initialRevision) setEditing(true); if (scope) setBatchRunId(candidateReviewRun(current.runs, initialId)?.runId ?? null); } }
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
    setNotice(run.mode === 'review_sources' ? t('来源核对已保存，仍需记录实际复核决定。', 'Source analysis is saved; an actual review decision is still required.') : run.status === 'completed'
      ? t(`生成完成：${run.bodies.length} 条候选，${run.phases.reduce((sum, phase) => sum + (phase.rejectedCount ?? 0), 0)} 条输出未接纳。`, `Generated ${run.bodies.length} candidates; ${run.phases.reduce((sum, phase) => sum + (phase.rejectedCount ?? 0), 0)} outputs rejected.`)
      : t(`运行状态：${run.status}。请在生成记录中查看或恢复。`, `Run status: ${run.status}. Inspect or resume it in history.`));
    if (run.coverageRef && (run.nextAction === 'review_source_coverage' || run.mode === 'review_sources')) setSourceReviewTarget({ workspace, run });
    await refresh(); if (run.bodies[0]) { await open(run.bodies[0].knowledgeId); setBatchRunId(run.runId); setPreviousId(null); }
  }
  function showPreparedStage(run: KnowledgeCandidateRun) {
    if (run.schemaStatus !== 'current' || run.nextAction !== 'continue_stage' || run.preparedStage?.state !== 'prepared'
      || !run.journalGeneration || !run.executor || !run.model) throw new Error('No prepared stage is sendable.');
    setPreparedSend({ run, operation: 'continue-stage', fields: { id: run.runId, generation: run.journalGeneration, executor: run.executor, model: run.model } });
  }
  async function prepareNextStage(run: KnowledgeCandidateRun) {
    let current = await api<KnowledgeCandidateRun>('inspect', { id: run.runId });
    if (current.nextAction === 'prepare_next_stage' && current.sources?.length && current.executor && current.model) {
      current = await api<KnowledgeCandidateRun>(current.mode === 'review_sources' ? 'prepare-source-review' : 'prepare-generation', {
        runId: current.runId, executor: current.executor, model: current.model,
        sources: current.sources.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion })),
        ...(current.mode === 'review_sources' ? { bodyRefs: current.bodies, ...(current.ledgerRef ? { ledgerRef: current.ledgerRef } : {}) } : {}),
      });
    }
    showPreparedStage(current);
  }
  async function prepareReviewedAssociations(decision: SourceCoverageDecisionRef) {
    if (!sourceReviewTarget || sourceReviewTarget.workspace !== workspace) return;
    const { run, bodyRef } = sourceReviewTarget, target = bodyRef ?? (run.bodies.length === 1 ? run.bodies[0] : undefined);
    const configured = { executor: run.executor ?? executor, model: run.model ?? model };
    const prepared = run.mode === 'generate' && run.nextAction === 'review_source_coverage' && !bodyRef
      ? await api<KnowledgeCandidateRun>('prepare-generation', { ...configured, runId: run.runId,
        sources: run.sources?.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion })), sourceCoverageDecisionRef: decision })
      : target ? await api<KnowledgeCandidateRun>('prepare-rebuild-associations', { ...configured, ...target, sourceCoverageDecisionRef: decision })
        : undefined;
    if (!prepared) throw new Error('Select one exact body before rebuilding associations.');
    setSourceReviewTarget(undefined);
    if (prepared.status === 'completed' && prepared.nextAction === 'none') { await handleRun(prepared); return; }
    showPreparedStage(prepared);
  }
  async function reviewBodySources(bodyRef: KnowledgeBodyRef) {
    const exact = runs.find(run => run.coverageRef && run.bodies.some(body => body.knowledgeId === bodyRef.knowledgeId && body.revisionId === bodyRef.revisionId && body.bodyDigest === bodyRef.bodyDigest));
    if (exact) { setSourceReviewTarget({ workspace, run: exact, bodyRef }); return; }
    const original = runs.find(run => run.sources?.length && run.bodies.some(body => body.knowledgeId === bodyRef.knowledgeId));
    if (!original?.sources?.length) throw new Error('The complete selected source set is unavailable. Select it explicitly before reviewing this body.');
    const prepared = await api<KnowledgeCandidateRun>('prepare-source-review', { sources: original.sources.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion })),
      bodyRefs: [bodyRef], ...(original.ledgerRef ? { ledgerRef: original.ledgerRef } : {}), executor, model });
    showPreparedStage(prepared);
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
          { key: 'import', label: t('导入项目文件或原始记录', 'Import project files or original traces'), disabled: busy || !workspace || embedded },
        ], onClick: ({ key }) => {
          if (key === 'study') setShowStudy(true);
          if (key === 'history') void work(async () => { await refresh(); setShowRuns(true); });
          if (key === 'import') { setShowImport(true); }
        } }}><Button ref={moreControl}>{t('更多', 'More')}</Button></Dropdown>
      </Space></header>
    {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} action={needsRefresh && detail ? <Button disabled={busy} onClick={() => void work(async () => { await continueReview(detail.revision.knowledgeId, detail.revision.revisionId, detail.revision.revisionId === detail.history.writeHeadRevisionId); setError(''); })}>{t('重新读取', 'Reload')}</Button> : undefined}/>}
    {needsRefresh && !error && detail && <Button disabled={busy} onClick={() => void work(() => continueReview(detail.revision.knowledgeId, detail.revision.revisionId, detail.revision.revisionId === detail.history.writeHeadRevisionId))}>{t('重新读取后继续', 'Reload to continue')}</Button>}
    {detail?.origin && !summary && <Link href={`${conversationPath(detail.origin.threadId, detail.origin.turnId)}?${new URLSearchParams({ workspace })}`}>{t('返回原始对话：', 'Back to conversation: ')}{conversationLabel(detail.origin.title, t('系统或附件记录', 'System or attachment record'))}</Link>}
    {notice && <Alert type="info" title={notice} closable onClose={() => setNotice('')}/>}
    {batch && !summary && <CandidateReviewProgress batch={batch} lang={lang} busy={busy} previous={!!previousId && previousId !== detail?.revision.knowledgeId} onPrevious={() => { if (previousId) void work(() => open(previousId)); }} onLibrary={leaveBatch}/>}
    {rows.length > 0 && <Button className="knowledge-directory-toggle" aria-expanded={directory} onClick={() => setDirectory(value => !value)}>{directory ? t('返回正文', 'Back to content') : t('知识目录', 'Knowledge directory')}</Button>}
    {scope && rows.length > 0 && runs.some(run => run.schemaStatus !== 'current') && <Alert type="warning" title={t('部分提炼记录无法确认来源范围，当前候选清单可能不完整。', 'Some extraction records cannot be attributed to a source scope. This candidate list may be incomplete.')}/>}

    {rows.length === 0 && scope ? <ScopedCandidateEmpty lang={lang} loading={loading} busy={busy} failedToLoad={failedToLoad} incompleteHistory={runs.some(run => run.schemaStatus !== 'current')} onRetry={retryCandidates}/> : rows.length === 0 ? <KnowledgeCandidateStart lang={lang} loading={loading} busy={busy} latest={runs[0]} failedToLoad={failedToLoad}
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
      {summary && batch ? <article className="knowledge-reader"><div className="knowledge-reader-scroll"><div className="knowledge-reading"><CandidateReviewSummary batch={batch} lang={lang} workspace={workspace} originHref={originHref} busy={busy} onRevisit={() => { if (previousId || detail) void work(() => open(previousId ?? detail!.revision.knowledgeId)); }} onLibrary={leaveBatch} onGenerate={() => setAuthoringIds(rows.filter(row => row.choice === 'retain' && runs.find(run => run.runId === batchRunId)?.bodies.some(item => item.knowledgeId === row.knowledgeId)).map(row => row.knowledgeId))}/></div></div></article>
        : detail ? <KnowledgeReader detail={detail} lang={lang} busy={busy || needsRefresh} workspace={workspace} selection={readerSelection} onSelectionChange={setReaderSelection} onReviewContent={() => setContentReview({ detail: structuredClone(detail), workspace })}
          onRevision={revision => void work(() => open(detail.revision.knowledgeId, revision))}
          onRetry={() => void work(() => open(detail.revision.knowledgeId, detail.revision.revisionId))}
          onEntities={detail.derivedAssociations.revision?.catalogRefs.length === 1 ? () => { const ref = detail.derivedAssociations.revision!.catalogRefs[0]; setEntityTarget({ analysisId: ref.analysisId, revision: ref.entityRevisionId }); } : undefined}
          onMapAssociations={needsRefresh ? undefined : () => setMapping(true)}
          onReviewAssociations={needsRefresh ? undefined : (choice, reason) => void work(async () => {
            const projection = detail.derivedAssociations.revision;
            if (!projection) return;
            await api('review-associations', { id: detail.revision.knowledgeId, revision: projection.revisionId,
              generation: detail.derivedAssociations.generation, choice, reason });
            await refresh(); await open(detail.revision.knowledgeId, detail.revision.revisionId);
          })}
          onRebuildAssociations={model.trim() && runs.some(run => run.sources?.length && run.bodies.some(body => body.knowledgeId === detail.revision.knowledgeId)) ? () => void work(async () => {
            await reviewBodySources({ knowledgeId: detail.revision.knowledgeId, revisionId: detail.revision.revisionId, bodyDigest: detail.revision.bodyDigest });
          }) : undefined}
          onDeleteSource={snapshot => Modal.confirm({ title: t('删除此来源快照？', 'Delete this source snapshot?'), content: t('共享此来源的候选将无法再查看原文，知识修订仍保留。', 'Candidates sharing this source will lose original text access. Knowledge revisions remain.'), onOk: () => work(async () => { await api('delete-source', { source: snapshot }); await open(detail.revision.knowledgeId, detail.revision.revisionId); }) })}
          tools={<CandidateTags lang={lang} tags={tagsDraft} busy={busy || needsRefresh} onChange={setTagsDraft} onSave={() => void work(saveTags)} changed={JSON.stringify(tagsDraft) !== JSON.stringify(detail.tagging.tags)}/>}
          footer={<>{detail.maintenance?.choice === 'retain' && detail.revision.revisionId === detail.history.writeHeadRevisionId && <Button disabled={busy || needsRefresh} onClick={() => setAuthoringIds([detail.revision.knowledgeId])}>{t('生成知识载体', 'Generate knowledge artifact')}</Button>}
            <CandidateDecisionActions lang={lang} reason={reason} busy={busy} needsRefresh={needsRefresh} choice={decisionChoice} onChoice={setDecisionChoice} onReason={setReason}
              onEdit={() => setEditing(true)} onDecision={choice => void work(() => decide(choice))}/></>}/>
          : <div className="knowledge-reader knowledge-reader-empty"><Empty description={t('没有匹配知识，请调整筛选。', 'No matching knowledge. Adjust the filters.')} image={Empty.PRESENTED_IMAGE_SIMPLE}/></div>}
    </div>}
    {authoringIds && <ArtifactAuthoringDialog key={workspace} workspace={workspace} lang={lang} ids={authoringIds} onClose={() => setAuthoringIds(null)}/>}
    {showStudy && <KnowledgeStudyInspectionDrawer lang={lang} onClose={() => setShowStudy(false)}/>}
    {entityTarget && <EntityAnalysisDrawer key={`${workspace}:${entityTarget.analysisId}:${entityTarget.revision ?? ''}`} workspace={workspace} analysisId={entityTarget.analysisId} initialRevision={entityTarget.revision}
      lang={lang} onClose={() => setEntityTarget(undefined)} onSaved={() => void work(async () => {
        if (detail) { await refresh(); await open(detail.revision.knowledgeId, detail.revision.revisionId); }
      })}/>}

    {showExtraction && <ConversationExtractionDialog initialWorkspace={workspace} lang={lang} onClose={() => setShowExtraction(false)} onFinished={root => {
      void work(async () => {
        const changed = root !== workspace;
        await refresh(root, changed); setWorkspace(root); setWorkspaceDraft(root);
        if (changed) {
          leaveBatch(); setNeedsRefresh(false); setNotice('');
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
      setWorkspace(root); setWorkspaceDraft(root); setQuery(''); setFilter('all'); setError(''); setNotice(''); setShowExtraction(false);
      const url = new URL(window.location.href); url.searchParams.set('workspace', root); url.searchParams.set('id', id); window.history.replaceState(null, '', url);
    }}/>}
    <Drawer title={t('保存位置', 'Save location')} open={showSettings} onClose={() => !busy && setShowSettings(false)} size={560}>
      <div className="candidate-form">{error && <Alert type="error" title={error}/>}<p>{t('这里仅调整本次操作的保存位置。长期默认目录请在侧栏“设置与帮助”中修改；已有数据不会移动。', 'Change the folder for this operation only. Edit global Settings for the long-term default; existing data will not move.')}</p>
        <p className="candidate-help">{t('全局位置：', 'Global location: ')}{defaultWorkspace}</p><Button disabled={busy || !defaultWorkspace} onClick={() => setWorkspaceDraft(defaultWorkspace)}>{t('使用全局位置', 'Use global location')}</Button>
        <label>{t('本地保存目录', 'Local folder')}<Input value={workspaceDraft} disabled={busy} placeholder={t('输入保存目录的完整路径', 'Enter the full folder path')} onChange={(event) => setWorkspaceDraft(event.target.value)}/></label>
        <Button type="primary" loading={busy} disabled={!workspaceDraft.trim()} onClick={() => void work(async () => {
          const root = workspaceDraft.trim();
          await refresh(root, true); leaveBatch(); setNeedsRefresh(false); setWorkspace(root); setNotice(''); setShowSettings(false);
          const url = new URL(window.location.href); url.searchParams.set('workspace', root); url.searchParams.delete('id'); url.searchParams.delete('revision'); window.history.replaceState(null, '', url);
        })}>{t('使用此保存位置', 'Use this location')}</Button>
      </div>
    </Drawer>
    {showImport && <SourceExtractionDialog initialWorkspace={workspace} lang={lang} onClose={() => setShowImport(false)}
      onFinished={root => { notifyKnowledgeChange(root); if (root === workspace) void work(async () => { await refresh(); }); }}/>}
    {preparedSend && <PreparedGenerationDialog run={preparedSend.run} lang={lang} busy={busy} onClose={() => !busy && setPreparedSend(undefined)}
      onSend={confirmedRequestDigest => void work(async () => {
        const result = await api<KnowledgeCandidateRun>(preparedSend.operation, { ...preparedSend.fields, confirmedRequestDigest });
        setPreparedSend(undefined); await handleRun(result); await refresh();
      })}/>}
    {sourceReviewTarget && sourceReviewTarget.workspace === workspace && <Drawer open title={t('来源与正文核对', 'Source and content review')} size={760} onClose={() => !busy && setSourceReviewTarget(undefined)}
      styles={{ body: { overflow: 'auto', overscrollBehavior: 'contain' } }}>
      <SourceReviewPanel workspace={workspace} ledgerRef={sourceReviewTarget.run.ledgerRef} coverageRef={sourceReviewTarget.run.coverageRef} lang={lang}
        onProceed={sourceReviewTarget.run.mode === 'generate' && sourceReviewTarget.run.nextAction === 'review_source_coverage' || sourceReviewTarget.bodyRef || sourceReviewTarget.run.bodies.length === 1
          ? decision => void work(() => prepareReviewedAssociations(decision)) : undefined}/>
    </Drawer>}
    {contentReview && contentReview.workspace === workspace && <KnowledgeReviewDrawer key={`${workspace}/${contentReview.detail.revision.revisionId}`} detail={contentReview.detail} workspace={workspace} lang={lang} onClose={() => setContentReview(undefined)}/>}
    {editing && detail && <KnowledgeRevisionDrawer key={`${workspace}:${detail.revision.knowledgeId}:${detail.revision.revisionId}`} detail={detail} workspace={workspace} lang={lang} initialReason={detail.revision.knowledgeId === initialId && detail.revision.revisionId === initialRevision ? initialReason : undefined}
      onClose={closeRevisionEditor} onReadback={readbackDetail} onSaved={saved => {
        setEditing(false); setDetail(saved); setReason(''); notifyKnowledgeChange(workspace);
        setNotice(t('已保存新修订，需要重新决定保留或舍弃。', 'Saved a new revision. Decide again whether to retain or discard it.'));
        void work(async () => { await refresh(); await open(saved.revision.knowledgeId); });
      }}/>}
    {mapping && detail && <AssociationMappingDrawer key={`${workspace}:${detail.revision.knowledgeId}:${detail.revision.revisionId}`} detail={detail} workspace={workspace} lang={lang}
      onClose={closeRevisionEditor} onReadback={readbackDetail} onSaved={saved => {
        setMapping(false); setDetail(saved); notifyKnowledgeChange(workspace);
        setNotice(t('已保存新的待核对实体映射；正文和保留决定保持原样。', 'Saved new pending entity mappings. Content and retention decisions are unchanged.'));
        void work(async () => { await refresh(); await open(saved.revision.knowledgeId, saved.revision.revisionId); });
      }}/>}
    <Drawer title={t('提炼记录', 'Extraction history')} open={showRuns} onClose={() => setShowRuns(false)} size="min(620px, 100vw)">
      <Button onClick={() => { setShowRuns(false); setShowStudy(true); }}>{t('核对研究证据', 'Inspect study evidence')}</Button>
      <p className="candidate-help">{t('显示当前来源清单、正文、来源核对与关联四阶段流程。旧格式运行会明确标记；旧知识需显式迁入新工作区。', 'Current source inventory, content, coverage and association workflow. Older runs are explicitly marked; old knowledge requires explicit migration to a new workspace.')}</p>
      {showRuns && workspace && <ExtractionQualityPanel workspace={workspace} lang={lang}/>}

      {runs.length ? runs.map((run) => <section className="candidate-statement" key={run.runId}><strong>{extractionRunStatusLabel(run.status, lang)}</strong><p>{run.runId}</p><p>{run.createdAt}</p>{run.schemaStatus === 'current' && <p>{run.bodies.length} {t('条候选', 'candidates')} / {run.phases.reduce((sum, phase) => sum + (phase.rejectedCount ?? 0), 0)} {t('条拒绝输出', 'rejected outputs')}</p>}
        {run.schemaStatus === 'current' && run.nextAction === 'unsupported' && <Alert type="warning" title={t('此任务使用旧生成协议', 'This run uses an older generation protocol')}
          description={t('请使用保留的匹配构建恢复此任务。当前程序保留原件，不重新解释输出或重新派发；已准备好的固定写入意图仍可恢复。', 'Recover this run with the preserved matching build. Originals are retained without reinterpreting output or redispatching. Already prepared write intents remain recoverable.')}/>}
        <ExtractionInvocationSummary run={run} lang={lang}/>{['continue_stage', 'prepare_next_stage'].includes(run.nextAction) && <Button disabled={busy} onClick={() => void work(() => prepareNextStage(run))}>
          {run.preparedStage ? t('核对并发送已准备阶段', 'Review and send prepared stage') : t('准备并核对下一阶段', 'Prepare and review next stage')}</Button>}
        {(run.ledgerRef || run.coverageRef) && <Button disabled={busy} onClick={() => setSourceReviewTarget({ workspace, run })}>{t('核对来源清单与遗漏', 'Review source inventory and omissions')}</Button>}
        <EntityAnalysisSummary run={run} lang={lang} disabled={busy} onOpen={analysisId => { setShowRuns(false); setEntityTarget({ analysisId }); }}/>
        {run.bodies.length > 0 && <Button disabled={busy} onClick={() => void work(async () => { const current = await refresh(); const batch = projectCandidateBatch(run, current.rows); await open(batch?.rows.find(row => row.choice === null)?.knowledgeId ?? run.bodies[0]!.knowledgeId); setBatchRunId(run.runId); setPreviousId(null); setShowRuns(false); })}>{t('核对本批候选', 'Review this batch')}</Button>}<Button disabled={busy || !['active'].includes(run.status) || run.nextAction === 'unsupported'} onClick={() => void work(async () => { await handleRun(await api('resume', { id: run.runId })); setRuns(await api('runs')); })}>{t('恢复归档或保存', 'Resume archiving or saving')}</Button></section>) : <Empty/>}
    </Drawer>
  </section>;
}

/** Native phase records are diagnostics, independent of content acceptance. */
function ExtractionInvocationSummary({ run, lang }: { run: KnowledgeCandidateRun; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  return <details className="candidate-help extraction-invocation"><summary>{t('执行记录', 'Execution records')}</summary>
    {run.schemaStatus === 'unsupported' ? <p>{t('旧格式运行，保留原件；当前流程不会恢复或重发它。', 'Older run format retained. The current workflow does not resume or redispatch it.')}</p>
      : run.schemaStatus === 'unavailable' ? <p>{run.unavailableReason === 'project_membership_unavailable'
        ? t('对话的项目归属暂不可确认；保留运行诊断，当前候选范围与数量不能据此判为零。', 'Conversation project membership is unavailable. Run diagnostics remain visible; this does not establish zero candidates in the requested scope.')
        : run.unavailableReason === 'invalid_source_metadata'
        ? t('冻结来源归因元数据不可读，无法确认此运行是否属于当前来源范围；其中候选未计入当前队列。', 'Frozen source attribution metadata is unreadable, so this run cannot be attributed to the current source scope. Its candidates are excluded from this queue.')
        : t('提炼日志损坏或不可读，无法确认结果及来源范围。原件仍保留，请检查保存位置。', 'The extraction journal is invalid or unreadable. Its result and source scope cannot be confirmed. Original files are retained; check the save location.')}</p>
        : <>{run.sourceMetadataStatus === 'frozen_input' && <p>{t('来源归因取自冻结请求，不表示来源当前可读。', 'Source attribution comes from the frozen request and does not establish current source availability.')}</p>}
          {run.sourceMetadataStatus === 'unknown' && <p>{t('来源归因元数据未知。', 'Source attribution metadata is unknown.')}</p>}
          {run.phases.map(phase => <div key={phase.invocationId}>
        <p>{generationStageLabel(phase.stageKind, lang)} · {phase.state}</p>
        <p>{phase.issues.join('；')}</p><code>{phase.profileId} · {phase.promptVersion}</code>
      </div>)}<NativeArchiveChecks checks={run.archiveChecks} verification={run.archiveVerification} lang={lang}/></>}
    <p>{t('恢复只处理已有原件，不重新调用模型。保存成功不代表内容已经核对。', 'Resume processes existing outcomes without calling models again. Saving does not establish reviewed content.')}</p>
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
export function ScopedCandidateEmpty({ lang, loading, busy, failedToLoad, incompleteHistory, onRetry }: {
  lang: Language; loading: boolean; busy: boolean; failedToLoad: boolean; incompleteHistory?: boolean; onRetry(): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  if (loading) return <p role="status">{t('正在读取此来源范围的候选…', 'Loading candidates in this source scope…')}</p>;
  if (failedToLoad) return <div role="status"><p>{t('暂时无法读取此来源范围的候选。请检查保存位置，再重新读取；读取失败不表示没有候选。', 'Could not load candidates in this source scope. Check the save location and retry; a failed read does not mean there are no candidates.')}</p><Button disabled={busy} onClick={onRetry}>{t('重新读取候选', 'Reload candidates')}</Button></div>;
  if (incompleteHistory) return <div role="status"><p>{t('部分提炼记录不可读或版本不受支持，无法确认是否属于此来源范围；当前候选清单可能不完整。', 'Some extraction records are unreadable or unsupported, so their source scope cannot be confirmed. This candidate list may be incomplete.')}</p><Button disabled={busy} onClick={onRetry}>{t('重新读取候选', 'Reload candidates')}</Button></div>;
  return <Empty description={t('此来源范围没有候选。回到对话手动选择来源，并逐阶段核对请求。', 'No candidates in this source scope. Select sources manually in a conversation and confirm each stage separately.')}/>;
}

export function KnowledgeCandidateStart({ lang, loading, busy, latest, failedToLoad, onChoose, onHistory, onRetry, onEntities }: {
  lang: Language; loading: boolean; busy: boolean;
  latest?: KnowledgeCandidateRun; failedToLoad?: boolean; onChoose(): void; onHistory(): void; onRetry?(): void; onEntities?(id: string): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const emptyResult = latest?.mode !== 'review_sources' && latest?.status === 'completed' && latest.bodies.length === 0;
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
          <p>{emptyResult ? (latest.phases.some(phase => (phase.rejectedCount ?? 0) > 0) ? t('部分输出未通过引用或格式校验，详情见提炼记录。', 'Some output failed citation or format checks. See the extraction history.') : t('可以换一份包含具体事实、纠正或处理结果的记录再试。', 'Try a record with concrete facts, corrections, or outcomes.')) : t('查看提炼记录，了解结果或继续未完成的保存。', 'Inspect the extraction history for results or unfinished saves.')}</p>
          <ExtractionInvocationSummary run={latest} lang={lang}/>
          {onEntities && <EntityAnalysisSummary run={latest} lang={lang} disabled={busy} onOpen={onEntities}/>}
          <Button type="link" disabled={busy} onClick={onHistory}>{t('查看提炼记录', 'View extraction history')}</Button>
        </> : <p>{t('尚无当前四阶段提炼记录。请选择来源开始；旧运行保留为历史记录。', 'No current four-stage runs. Select sources to begin; older runs remain historical records.')}</p>}
      </div>
    </aside>
  </div>;
}
