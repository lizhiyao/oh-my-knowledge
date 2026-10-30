'use client';
import Link from 'next/link';
import { KNOWLEDGE_CANDIDATES_PATH } from '../../../http/page-paths';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Modal, Select, Space, Spin } from 'antd';
import type { Language } from '../layout/shell';
import type { SourceSelection } from '../../../../knowledge/sources';
import type { KnowledgeCandidateRun, KnowledgeConversation, KnowledgeConversationDetail, KnowledgeConversationPreview,
  KnowledgeSourceCapture, KnowledgeSourceCatalog, KnowledgeSourcePreview, KnowledgeSourceRef } from '../../../view-models/knowledge/knowledge-candidates';
import { SourceReviewPanel } from './source-review';
import { requestKnowledge } from './request';
import { SourceUpdates } from './source-updates';
import { notifyKnowledgeChange, resolveKnowledgeWorkspace } from './workspace';

type ConversationScope = { threadId: string; turnId?: string };
const scroll = { maxHeight: '28vh', overflow: 'auto', whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const };
function ranges(text: string, lower: number) {
  if (!text.trim()) throw new Error('invalid_range');
  const result = text.split(',').map(part => {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!match) throw new Error('invalid_range');
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < lower || end < start) throw new Error('invalid_range');
    return { start, end };
  });
  if (result.length > 256) throw new Error('invalid_range');
  return result;
}

/** Selected originals, send material and saved bytes have separate scopes. No send authority is inferred here. */
export function SourcePreviewContent({ preview, capture, lang }: { preview: KnowledgeSourcePreview; capture?: KnowledgeSourceCapture; lang: Language }) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  return <section>
    <h3>{t('核对本地读取与捕获范围', 'Review local read and capture scope')}</h3>
    <p>{t('这份预览尚未授权发送模型。捕获只保存选定来源，模型发送在下一步单独确认。', 'This preview does not authorize a model request. Capture saves selected sources; confirm model transmission separately afterward.')}</p>
    <dl><dt>{t('本次预览实际读取', 'Actual preview read')}</dt><dd>{preview.readManifest.totalBytes} bytes</dd>
      <dt>{t('选定原件', 'Selected originals')}</dt><dd>{preview.readManifest.selectedTextBytes} bytes</dd>
      <dt>{t('模型材料草稿', 'Draft model material')}</dt><dd>{preview.sendDraft.materialJsonBytes} bytes · {t('不含最终 system、完整输入及传输封装', 'excludes final system, complete input and transport envelope')}</dd>
      <dt>{t('本次捕获实际写入', 'Actual capture write')}</dt><dd>{capture?.saveManifest.actualWrittenBytes ?? 0} bytes</dd></dl>
    {capture && <p>{t('捕获时重新读取：', 'Reread during capture: ')}{capture.readManifest.totalBytes} bytes · {t('发送权限：未授予', 'Send permission: not granted')}</p>}
    {preview.items.map(item => <section key={item.sourceOrdinal}>
      <h4>{item.resolvedSelection.sourceKind} · {item.resolvedSelection.sourceKind === 'agent_trace' ? item.resolvedSelection.sourceId : `${item.resolvedSelection.projectId} / ${item.resolvedSelection.relativePath}`}</h4>
      <p>{item.material.materialType} · {item.material.attributionBasis} · {item.material.reason}</p>
      <details><summary>{t('固定来源身份与选区', 'Fixed source identity and selection')}</summary><pre style={scroll}>{JSON.stringify(item.resolvedSelection, null, 2)}</pre><code>{item.sourceVersion}</code></details>
      <details><summary>{t('完整选定片段', 'Complete selected excerpts')}</summary>{item.excerpts.map((excerpt, index) => <div key={index}><p>{excerpt.material.materialType} · {excerpt.material.reason}</p><pre style={scroll}>{excerpt.text}</pre></div>)}</details>
      <details><summary>{t('本地保留的原件字节内容', 'Original content retained locally')}</summary><p>{t('原始 trace 信封不作为模型正文输入。', 'Raw trace envelopes are not model content input.')}</p>{item.retainedUnits.map(unit => <pre key={unit.unitId} style={scroll}>{unit.text}</pre>)}</details>
      {item.limitations.map((value, index) => <p key={index}>{value}</p>)}
    </section>)}
    <details><summary>{t('完整模型材料草稿（尚未授权发送）', 'Complete draft model material (not authorized for sending)')}</summary><pre style={scroll}>{preview.sendDraft.json}</pre></details>
    <details><summary>{t('读取、材料草稿与捕获清单', 'Read, draft material and capture manifests')}</summary><pre style={scroll}>{JSON.stringify({ read: preview.readManifest, sendDraft: { ...preview.sendDraft, json: undefined }, save: preview.savePlan, capture: capture?.saveManifest }, null, 2)}</pre></details>
  </section>;
}

export function generationStageLabel(stage: KnowledgeCandidateRun['phases'][number]['stageKind'], lang: Language): string {
  return ({ source_ledger: ['来源清单', 'Source inventory'], body: ['知识正文', 'Knowledge content'],
    source_coverage: ['来源覆盖核对', 'Source coverage'], association: ['实体关联', 'Entity associations'] })[stage][lang === 'zh' ? 0 : 1];
}

/** The immutable journal stage is the whole host request, not a selected-text byte estimate. */
export function PreparedGenerationConfirmation({ run, lang, confirmed, onConfirmed }: {
  run: KnowledgeCandidateRun; lang: Language; confirmed: boolean; onConfirmed(value: boolean): void;
}) {
  const stage = run.preparedStage, t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  if (!stage || run.nextAction !== 'continue_stage') return <Alert type="warning" title={t('没有可发送的已准备阶段；请核对现有日志。', 'No prepared stage is sendable. Inspect the existing journal.')}/>;
  return <section>
    <h3>{stage.stageKind === 'body' ? t('确认正文请求', 'Confirm content request') : stage.stageKind === 'association' ? t('确认实体关联请求', 'Confirm entity association request') : t(`确认${generationStageLabel(stage.stageKind, lang)}请求`, `Confirm ${generationStageLabel(stage.stageKind, lang)} request`)}</h3>
    <p>{t('仅发送下面这个精确阶段。每个阶段单独确认，来源复核决定与模型发送分开。', 'Send only this exact stage. Confirm every stage separately; source review decisions and model dispatch are separate.')}</p>
    <p>{t('发送到：', 'Send to: ')}<strong>{run.executor} / {run.model}</strong> · {stage.stageKind === 'body' || stage.stageKind === 'association' ? t('保存为待核对候选', 'save as pending candidates') : t('保存模型意见，实际决定另行记录', 'save model opinions; record actual decisions separately')}</p>
    <p>{t('完整输入 UTF-8 字节：', 'Complete input UTF-8 bytes: ')}{new TextEncoder().encode(stage.input).length} · system: {new TextEncoder().encode(stage.system).length}</p>
    <details><summary>{t('请求详情', 'Request details')}</summary><p>{run.workflowId} · {run.inputVersion}</p><dl><dt>runId</dt><dd><code>{run.runId}</code></dd><dt>invocationId</dt><dd><code>{stage.invocationId}</code></dd>
      <dt>requestDigest</dt><dd><code>{stage.requestDigest}</code></dd><dt>inputDigest</dt><dd><code>{stage.inputDigest}</code></dd>
      <dt>profile / wire</dt><dd><code>{stage.profileId} / {stage.wireId}</code></dd></dl>
    <pre style={scroll}>{JSON.stringify({ wireSchema: stage.wireSchema, producer: stage.producer }, null, 2)}</pre></details>
    <details><summary>{t('完整 system', 'Complete system')}</summary><pre style={scroll}>{stage.system}</pre></details>
    <details><summary>{t('完整实际模型输入', 'Complete actual model input')}</summary><pre style={scroll}>{stage.input}</pre></details>
    <p>{t('上面展示宿主传给执行器的完整 system、input 与 Schema；执行器或服务商内部上下文及网络封装大小不在此估计。费用以实际报告为准。', 'These are the complete host system, input and schema passed to the executor. Executor/provider internal context and network envelope size are not estimated here. Cost depends on actual reporting.')}</p>
    <Checkbox checked={confirmed} onChange={event => onConfirmed(event.target.checked)}>{t('批准将此精确请求发送到上面显示的执行器／模型。', 'Approve sending this exact request to the executor/model shown above.')}</Checkbox>
  </section>;
}

export function PreparedGenerationDialog({ run, lang, busy, onClose, onSend }: {
  run: KnowledgeCandidateRun; lang: Language; busy: boolean; onClose(): void; onSend(digest: string): void;
}) {
  const [confirmed, setConfirmed] = useState(false), t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  useEffect(() => setConfirmed(false), [run.preparedStage?.requestDigest]);
  return <Modal title={t('核对完整模型请求', 'Review complete model request')} open width={760} onCancel={onClose}
    styles={{ body: { maxHeight: '65vh', overflow: 'auto', overscrollBehavior: 'contain' } }} confirmLoading={busy}
    okText={t('发送此阶段', 'Send this stage')} okButtonProps={{ disabled: !confirmed || !run.preparedStage || run.nextAction !== 'continue_stage' }}
    onOk={() => { if (confirmed && run.preparedStage && run.nextAction === 'continue_stage') onSend(run.preparedStage.requestDigest); }}>
    <PreparedGenerationConfirmation run={run} lang={lang} confirmed={confirmed} onConfirmed={setConfirmed}/>
  </Modal>;
}

/** One source picker serves host-bound file/Git/trace imports and Observe's trusted conversation scope. */
export function SourceExtractionDialog({ source: initialSource, initialMode = 'project_file', initialWorkspace = '', lang, onClose, onFinished, onReview }: {
  source?: ConversationScope; initialMode?: 'conversation' | SourceSelection['sourceKind']; initialWorkspace?: string; lang: Language;
  onClose(): void; onFinished?(workspace: string): void; onReview?(workspace: string, id: string, signal: AbortSignal): Promise<void>;
}) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  const [workspace, setWorkspace] = useState(initialWorkspace), [executor, setExecutor] = useState('codex'), [model, setModel] = useState('');
  const [kind, setKind] = useState(initialSource ? 'conversation' : initialMode), [catalog, setCatalog] = useState<KnowledgeSourceCatalog>({ projects: [], traces: [] });
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'available' | 'failed'>('loading'), [conversationsStatus, setConversationsStatus] = useState<'loading' | 'available' | 'failed'>('loading');
  const [conversations, setConversations] = useState<KnowledgeConversation[]>([]), [conversation, setConversation] = useState<KnowledgeConversationDetail>();
  const [scope, setScope] = useState<ConversationScope | undefined>(initialSource), [messages, setMessages] = useState<KnowledgeConversationPreview['messages']>([]), [selectedMessages, setSelectedMessages] = useState<number[]>([]);
  const [project, setProject] = useState(''), [path, setPath] = useState(''), [revision, setRevision] = useState('HEAD'), [trace, setTrace] = useState(''), [range, setRange] = useState(''), [wholeFile, setWholeFile] = useState(true);
  const [selections, setSelections] = useState<SourceSelection[]>([]), [preview, setPreview] = useState<KnowledgeSourcePreview>(), [capture, setCapture] = useState<KnowledgeSourceCapture>();
  const [refs, setRefs] = useState<KnowledgeSourceRef[]>([]), [run, setRun] = useState<KnowledgeCandidateRun>(), [freshRun, setFreshRun] = useState(false);
  const [phase, setPhase] = useState<'select' | 'preview' | 'captured' | 'prepared' | 'result'>('select'), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const api = <T,>(operation: string, fields: Record<string, unknown>, signal: AbortSignal) => requestKnowledge<T>('candidates', { workspace, operation, ...fields }, signal);
  async function work(action: (signal: AbortSignal) => Promise<void>, native = false) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError('');
    try { await action(controller.signal); }
    catch (cause) {
      if (native) setPhase('result');
      setError(controller.signal.aborted ? t('已请求取消。请检查提炼记录，不要重新派发未知结果。', 'Cancellation requested. Inspect extraction history; do not redispatch an unknown outcome.')
        : cause instanceof Error && cause.message === 'knowledge_conflict' ? t('来源、授权范围或任务有变化，请重新预览或读取现有日志。', 'The source, scope or run changed. Preview again or inspect the existing journal.')
          : t('未能完成。请核对已配置来源、选区、保存位置及模型设置。', 'Could not complete. Check configured sources, selection, destination and model settings.'));
    } finally { if (native && controller.signal.aborted) { setPhase('result'); setConfirmed(false); } if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  async function conversationPreview(next: ConversationScope, signal: AbortSignal, indexes?: number[], root = workspace) {
    const result = await api<KnowledgeConversationPreview>('preview-conversation', { workspace: root, ...next, ...(indexes ? { recordIndexes: indexes } : {}) }, signal);
    if (signal.aborted) return;
    setScope(next); setPreview(result.preview); setCapture(undefined); setRun(undefined); setRefs([]); setPhase('preview'); setConfirmed(false);
    if (!indexes) { setMessages(result.messages); setSelectedMessages([...new Set(result.messages.map(message => message.recordIndex))]); }
  }
  async function readSourceCatalog(signal: AbortSignal) {
    setCatalogStatus('loading');
    try {
      const sources = await requestKnowledge<KnowledgeSourceCatalog>('sources', { operation: 'catalog' }, signal);
      if (signal.aborted) return;
      setCatalog(sources); setProject(sources.projects[0]?.projectId ?? ''); setTrace(sources.traces[0]?.sourceId ?? ''); setCatalogStatus('available');
    } catch { if (!signal.aborted) setCatalogStatus('failed'); }
  }
  async function readConversations(signal: AbortSignal) {
    setConversationsStatus('loading');
    try {
      const list = await api<KnowledgeConversation[]>('conversations', {}, signal);
      if (!signal.aborted) { setConversations(list); setConversationsStatus('available'); }
    } catch { if (!signal.aborted) setConversationsStatus('failed'); }
  }
  useEffect(() => {
    void work(async signal => {
      const settings = await resolveKnowledgeWorkspace(initialWorkspace || new URLSearchParams(window.location.search).get('workspace') || '', signal);
      if (signal.aborted) return;
      setWorkspace(settings.workspace); setExecutor(settings.executor); setModel(settings.model);
      await Promise.all([readSourceCatalog(signal), readConversations(signal)]);
      if (signal.aborted) return;
      if (initialSource) await conversationPreview(initialSource, signal, undefined, settings.workspace);
    });
    return () => active.current?.abort();
  }, []);
  function resetPreview() { setPreview(undefined); setCapture(undefined); setRefs([]); setRun(undefined); setPhase('select'); setConfirmed(false); }
  function addSelection() {
    try {
      let next: SourceSelection;
      if (kind === 'agent_trace') {
        const bound = catalog.traces.find(item => item.sourceId === trace); if (!bound) throw Error();
        next = { sourceKind: 'agent_trace', sourceId: bound.sourceId, traceKind: bound.traceKind, recordRanges: ranges(range, 0).map(({ start, end }) => ({ startRecord: start, endRecord: end })) };
      } else {
        const lineRanges = wholeFile ? null : ranges(range, 1).map(({ start, end }) => ({ startLine: start, endLine: end }));
        if (!project || !path) throw Error();
        next = kind === 'git_blob' ? { sourceKind: 'git_blob', projectId: project, relativePath: path, revision, lineRanges }
          : { sourceKind: 'project_file', projectId: project, relativePath: path, lineRanges };
      }
      resetPreview(); setSelections(current => [...current, next]); setError('');
    } catch { setError(t('请填写已配置的来源与有效选区，例如 1-20,30-40。', 'Choose a configured source and a valid range, for example 1-20,30-40.')); }
  }
  const locked = busy || ['captured', 'prepared', 'result'].includes(phase);
  return <Modal centered title={t('选择来源并提炼知识', 'Choose sources and extract knowledge')} open width={760} onCancel={() => { active.current?.abort(); onClose(); }}
    styles={{ body: { maxHeight: '68vh', overflow: 'auto', overscrollBehavior: 'contain' } }} footer={<Space wrap>
      {busy ? <Button onClick={() => active.current?.abort()}>{t('请求取消', 'Request cancellation')}</Button> : <Button onClick={onClose}>{t('关闭', 'Close')}</Button>}
      {phase === 'preview' && <Button type="primary" disabled={busy || !preview} onClick={() => void work(async signal => {
        const saved = kind === 'conversation' && scope ? await api<KnowledgeSourceCapture>('capture-conversation', { ...scope, recordIndexes: selectedMessages, previewDigest: preview!.previewDigest }, signal)
          : await requestKnowledge<KnowledgeSourceCapture>('sources', { operation: 'capture', workspace, selections: preview!.items.map(item => item.resolvedSelection), previewDigest: preview!.previewDigest }, signal);
        if (signal.aborted) return; setCapture(saved); setRefs(saved.sources.map(({ snapshot }) => ({ snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion }))); setPhase('captured');
      })}>{t('仅捕获选定来源', 'Capture selected sources only')}</Button>}
      {phase === 'captured' && <Button type="primary" disabled={busy || !model.trim()} onClick={() => void work(async signal => {
        const prepared = await api<KnowledgeCandidateRun>('prepare-generation', { sources: refs, executor, model: model.trim(), ...(freshRun ? { runId: crypto.randomUUID() } : {}) }, signal);
        if (signal.aborted) return; setRun(prepared); setConfirmed(false); setPhase(prepared.nextAction === 'continue_stage' && prepared.preparedStage ? 'prepared' : 'result');
      })}>{t('准备并核对完整模型请求', 'Prepare and review complete model request')}</Button>}
      {phase === 'prepared' && <Button type="primary" disabled={busy || !confirmed || !run?.preparedStage} onClick={() => void work(async signal => {
        const stage = run!.preparedStage!;
        const next = await api<KnowledgeCandidateRun>('continue-stage', { id: run!.runId, generation: run!.journalGeneration,
          executor: run!.executor, model: run!.model, confirmedRequestDigest: stage.requestDigest }, signal);
        if (signal.aborted) return; setRun(next); setConfirmed(false); setPhase(next.nextAction === 'continue_stage' && next.preparedStage ? 'prepared' : 'result'); notifyKnowledgeChange(workspace); onFinished?.(workspace);
      }, true)}>{t('发送此阶段请求', 'Send this stage request')}</Button>}
      {phase === 'result' && run?.nextAction === 'prepare_next_stage' && <Button type="primary" disabled={busy} onClick={() => void work(async signal => {
        const prepared = await api<KnowledgeCandidateRun>('prepare-generation', { sources: refs, runId: run.runId, executor: run.executor, model: run.model }, signal);
        if (!signal.aborted) { setRun(prepared); setConfirmed(false); setPhase(prepared.preparedStage ? 'prepared' : 'result'); }
      })}>{t('准备并核对下一阶段', 'Prepare and review the next stage')}</Button>}
    </Space>}>
    <div className="candidate-form">
      {error && <Alert type="error" title={error}/>}{busy && <Spin/>}
      {catalogStatus === 'failed' && <Alert type="warning" title={t('项目和记录来源列表暂不可读', 'Project and trace source list unavailable')}
        description={t('请重试读取列表；读取失败不表示尚未配置来源。', 'Retry the list. A read failure does not mean sources are unconfigured.')}
        action={<Button disabled={busy} onClick={() => void work(readSourceCatalog)}>{t('重新读取项目和记录列表', 'Retry project and trace list')}</Button>}/>}
      {conversationsStatus === 'failed' && <Alert type="warning" title={t('对话列表暂不可读', 'Conversation list unavailable')}
        description={t('项目和已配置记录仍可单独选择；请重试读取对话列表。', 'Project files and configured traces can still be selected. Retry the conversation list.')}
        action={<Button disabled={busy} onClick={() => void work(readConversations)}>{t('重新读取对话列表', 'Retry conversation list')}</Button>}/>}
      <label>{t('来源类型', 'Source type')}<Select aria-label={t('来源类型', 'Source type')} value={kind} disabled={locked || !!initialSource} onChange={value => { setKind(value); resetPreview(); }} options={[
        { value: 'conversation', label: t('已接入对话', 'Connected conversation') }, { value: 'project_file', label: t('项目文件', 'Project file') },
        { value: 'git_blob', label: t('固定 Git 文件', 'Fixed Git file') }, { value: 'agent_trace', label: t('已配置 Agent 原始记录', 'Configured original Agent trace') },
      ]}/></label>
      {kind === 'conversation' ? <>
        <p>{t('选择消息会选中其所在的完整原始记录。同条记录中的工具事件也可能进入模型材料，下面的完整片段预览是本次发送范围。', 'Selecting messages selects their complete original records. Tool events in the same record can enter model material; the complete excerpts below define this transmission scope.')}</p>
        {!initialSource && <label>{t('对话', 'Conversation')}<Select aria-label={t('选择来源对话', 'Choose source conversation')} value={scope?.threadId} disabled={locked} showSearch={{ optionFilterProp: 'label' }} options={conversations.map(item => ({ value: item.threadId, label: item.title }))}
          onChange={threadId => void work(async signal => { resetPreview(); setScope({ threadId }); setConversation(await api('conversation', { threadId }, signal)); })}/></label>}
        {!initialSource && conversation && <label>{t('提炼范围', 'Extraction scope')}<Select aria-label={t('选择轮次', 'Choose turn')} disabled={locked} placeholder={t('选择一轮或整条对话', 'Choose a turn or the whole conversation')}
          options={[{ value: '__all__', label: t('整条对话', 'Whole conversation') }, ...conversation.tasks.map(task => ({ value: task.turnId, label: task.title }))]}
          onChange={turnId => void work(signal => conversationPreview({ threadId: conversation.threadId, ...(turnId === '__all__' ? {} : { turnId }) }, signal))}/></label>}
        {!!messages.length && <details><summary>{t('选定消息', 'Selected messages')}</summary>{messages.map(message => <div key={message.excerptKey}><Checkbox checked={selectedMessages.includes(message.recordIndex)} disabled={locked} onChange={event => {
          setSelectedMessages(current => event.target.checked ? [...new Set([...current, message.recordIndex])] : current.filter(index => index !== message.recordIndex)); setPreview(undefined); setConfirmed(false);
        }}>{message.role} · #{message.recordIndex}</Checkbox><pre style={scroll}>{message.text}</pre></div>)}<Button disabled={locked || !scope || !selectedMessages.length} onClick={() => void work(signal => conversationPreview(scope!, signal, selectedMessages))}>{t('更新本地预览', 'Update local preview')}</Button></details>}
      </> : <>
        {kind === 'agent_trace' ? <label>{t('已配置记录', 'Configured trace')}<Select aria-label={t('已配置记录', 'Configured trace')} value={trace || undefined} disabled={locked} options={catalog.traces.map(item => ({ value: item.sourceId, label: item.title || item.sourceId }))} onChange={setTrace}/></label>
          : <><label>{t('已配置项目', 'Configured project')}<Select aria-label={t('已配置项目', 'Configured project')} value={project || undefined} disabled={locked} options={catalog.projects.map(item => ({ value: item.projectId, label: item.projectId }))} onChange={setProject}/></label>
            <label>{t('项目内相对路径', 'Project relative path')}<Input value={path} disabled={locked} onChange={event => setPath(event.target.value)} placeholder="docs/design.md"/></label>
            {kind === 'git_blob' && <label>{t('Git 提交或分支（预览后固定对象）', 'Git commit or branch (pinned after preview)')}<Input value={revision} disabled={locked} onChange={event => setRevision(event.target.value)}/></label>}
            <Checkbox checked={wholeFile} disabled={locked} onChange={event => setWholeFile(event.target.checked)}>{t('明确选择整份文件', 'Explicitly select the whole file')}</Checkbox></>}
        {(kind === 'agent_trace' || !wholeFile) && <label>{kind === 'agent_trace' ? t('原记录范围（从 0 开始，包含终点）', 'Original record ranges (zero-based, inclusive)') : t('行范围（从 1 开始，包含终点）', 'Line ranges (one-based, inclusive)')}<Input value={range} disabled={locked} onChange={event => setRange(event.target.value)} placeholder={kind === 'agent_trace' ? '0-10,15-20' : '1-20,30-40'}/></label>}
        <Button disabled={locked || selections.length >= 256} onClick={addSelection}>{t('加入本次来源', 'Add to this source batch')}</Button>
        {catalogStatus === 'available' && !catalog.projects.length && !catalog.traces.length && <Empty description={t('宿主尚未配置项目或记录来源。请通过启动配置提供 source scope；浏览器不能提交任意根目录。', 'The host has no configured projects or traces. Supply a source scope at startup; a browser cannot submit arbitrary roots.')}/>}
        {selections.map((selection, index) => <p key={index}>{selection.sourceKind} · {selection.sourceKind === 'agent_trace' ? selection.sourceId : `${selection.projectId}/${selection.relativePath}`} <Button type="text" disabled={locked} onClick={() => { resetPreview(); setSelections(current => current.filter((_, ordinal) => ordinal !== index)); }}>{t('移除', 'Remove')}</Button></p>)}
        <Button disabled={locked || !selections.length || !workspace.trim()} onClick={() => void work(async signal => { const value = await requestKnowledge<KnowledgeSourcePreview>('sources', { operation: 'preview-sources', workspace, selections }, signal); if (!signal.aborted) { setPreview(value); setPhase('preview'); } })}>{t('读取并预览，不保存或发送', 'Read and preview without saving or sending')}</Button>
      </>}
      <label>{t('保存目录', 'Destination folder')}<Input value={workspace} disabled={locked} onChange={event => { setWorkspace(event.target.value); resetPreview(); }}/></label>
      {preview && <SourcePreviewContent preview={preview} capture={capture} lang={lang}/>}
      {['captured', 'prepared', 'result'].includes(phase) && <><p>{t('来源已捕获，尚未由此获得发送授权。', 'Sources are captured; this does not grant send authority.')}</p>
        <label>{t('执行器', 'Executor')}<Select value={executor} disabled={busy || phase !== 'captured'} onChange={setExecutor} options={['codex', 'openai-api'].map(value => ({ value, label: value }))}/></label>
        <label>{t('模型', 'Model')}<Input value={model} disabled={busy || phase !== 'captured'} onChange={event => setModel(event.target.value)}/></label>
        {phase === 'captured' && <details><summary>{t('同一来源的任务复用与新任务', 'Reuse this source set or create an independent run')}</summary><Checkbox checked={freshRun} disabled={busy} onChange={event => setFreshRun(event.target.checked)}>{t('明确新建独立任务；默认会复用同一来源集的既有任务，失败或未知结果不会自动重发。', 'Explicitly create an independent run. By default the same source set reuses its existing run; failed or unknown outcomes are not redispatched.')}</Checkbox></details>}</>}
      {capture && kind !== 'conversation' && capture.sources.map(({ snapshot }) => <SourceUpdates key={`${snapshot.snapshotId}/${snapshot.sourceVersion}`}
        source={{ snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion }} snapshot={snapshot} workspace={workspace} lang={lang} busy={busy} run={work}/>)}
      {phase === 'prepared' && run && <PreparedGenerationConfirmation key={run.preparedStage?.requestDigest} run={run} lang={lang} confirmed={confirmed} onConfirmed={setConfirmed}/>}
      {run && !!run.bodies.length && <><p>{t(`已保存 ${run.bodies.length} 条候选正文，内容仍待核对。`, `${run.bodies.length} candidate bodies are saved and await review.`)}</p>{run.bodies.map(body => onReview ? <Button key={body.knowledgeId} disabled={busy} onClick={() => void work(signal => onReview(workspace, body.knowledgeId, signal))}>{t('核对已保存正文', 'Review saved content')}</Button> : <Link key={body.knowledgeId} href={`${KNOWLEDGE_CANDIDATES_PATH}?${new URLSearchParams({ workspace, id: body.knowledgeId })}`} onClick={onClose}>{t('核对已保存正文', 'Review saved content')}</Link>)}</>}
      {phase === 'result' && run?.coverageRef && <SourceReviewPanel workspace={workspace} ledgerRef={run.ledgerRef} coverageRef={run.coverageRef} lang={lang}
        onProceed={run.nextAction === 'review_source_coverage' ? decision => void work(async signal => {
          const prepared = await api<KnowledgeCandidateRun>('prepare-generation', { sources: refs, runId: run.runId,
            executor: run.executor, model: run.model, sourceCoverageDecisionRef: decision }, signal);
          if (!signal.aborted) { setRun(prepared); setConfirmed(false); setPhase(prepared.preparedStage ? 'prepared' : 'result'); notifyKnowledgeChange(workspace); onFinished?.(workspace); }
        }) : undefined}/>}
      {phase === 'result' && <Alert type={run?.status === 'completed' ? 'info' : 'warning'} title={run?.status === 'completed' ? run.bodies.length ? t('本次任务已结束，请核对候选内容。', 'This run ended. Review the candidate content.') : t('本轮已按实际复核意见结束，没有保存正文。', 'This run ended with an actual review decision; no content was saved.') : run?.nextAction === 'prepare_next_stage' ? t('本阶段已保存；准备下一阶段后，仍需核对完整请求。', 'This stage is saved. Prepare the next stage and inspect its complete request.') : run?.nextAction === 'review_source_coverage' ? t('来源核对已保存，请在下面记录实际决定。', 'Source coverage is saved. Record your actual decision below.') : t('请检查提炼记录；未完成或未知状态不代表可以重新发送。', 'Inspect extraction history. Incomplete or unknown status does not authorize redispatch.')}/>}
    </div>
  </Modal>;
}
