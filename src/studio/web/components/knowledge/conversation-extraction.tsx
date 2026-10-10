'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Modal, Select, Space, Spin } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateRun, KnowledgeCandidateSource, KnowledgeConversation, KnowledgeConversationDetail, KnowledgeConversationPreview } from '../../../view-models/knowledge/knowledge-candidates';
import { KNOWLEDGE_CANDIDATES_PATH } from '../../../http/page-paths';
import { notifyKnowledgeChange, resolveKnowledgeWorkspace } from './workspace';
import { conversationLabel } from '../../../application/display/conversation-label';
import { EntityAnalysisDrawer, EntityAnalysisSummary } from './entity-analysis';

type Scope = { threadId: string; turnId?: string };

/** The reading action selects its own turn; opening the dialog never calls a model. */
export function ExtractConversation({ threadId, turnId, lang, onFinished, onReview, disabled = false, small = false }: Scope & {
  lang: Language; onFinished?(workspace: string): void; onReview?(workspace: string, id: string, signal: AbortSignal): Promise<void>; disabled?: boolean; small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <><Button type={small ? 'text' : 'primary'} size={small ? 'small' : 'middle'} disabled={disabled} onClick={() => setOpen(true)}>
    {turnId ? (lang === 'zh' ? '提炼这轮' : 'Extract this turn') : (lang === 'zh' ? '提炼整条对话' : 'Extract conversation')}
  </Button>{open && <ConversationExtractionDialog source={{ threadId, ...(turnId ? { turnId } : {}) }} lang={lang} onClose={() => setOpen(false)} onFinished={onFinished} onReview={onReview ? async (workspace, id, signal) => { await onReview(workspace, id, signal); onFinished?.(workspace); setOpen(false); } : undefined}/>}</>;
}

/** Both Observe and Knowledge use one local preview and one explicit model confirmation. */
export function ConversationExtractionDialog({ source: initialSource, initialWorkspace = '', lang, onClose, onFinished, onReview }: {
  source?: Scope; initialWorkspace?: string; lang: Language; onClose(): void; onFinished?(workspace: string): void;
  onReview?(workspace: string, id: string, signal: AbortSignal): Promise<void>;
}) {
  const router = useRouter();
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  const [stage, setStage] = useState<'loading' | 'select' | 'confirm' | 'generating' | 'result'>('loading');
  const [source, setSource] = useState(initialSource);
  const [conversations, setConversations] = useState<KnowledgeConversation[]>([]);
  const [conversation, setConversation] = useState<KnowledgeConversationDetail>();
  const [conversationId, setConversationId] = useState('');
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [preview, setPreview] = useState<KnowledgeConversationPreview>();
  const [selected, setSelected] = useState<number[]>([]);
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [executor, setExecutor] = useState('codex');
  const [model, setModel] = useState('');
  const [adjust, setAdjust] = useState(false);
  const [error, setError] = useState('');
  const [run, setRun] = useState<KnowledgeCandidateRun>();
  const [entityId, setEntityId] = useState<string>();
  const initialized = useRef(false);
  const mounted = useRef(true);
  const [reviewing, setReviewing] = useState(false);
  const controller = useRef<AbortController | null>(null);
  async function api<T>(operation: string, fields: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    const response = await fetch('/api/knowledge/candidates', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, ...fields }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value as T;
  }
  function explain(cause: unknown) {
    return cause instanceof Error && cause.message === 'knowledge_conflict'
      ? t('对话内容有更新，请重新读取后确认。', 'The conversation changed. Reload and confirm again.')
      : cause instanceof Error && cause.message === 'knowledge_capacity_exceeded'
        ? t('这段对话超出提炼上限，请选择其中一轮。', 'This conversation exceeds the limit. Choose one turn.')
        : t('未能完成。请检查来源是否可读、保存目录及模型配置，然后重试。', 'Could not complete. Check source availability, the folder and model configuration, then retry.');
  }
  function request() {
    controller.current?.abort();
    const active = new AbortController(); controller.current = active; setError('');
    return active;
  }
  function acceptPreview(value: KnowledgeConversationPreview) {
    setPreview(value); setSelected([...new Set(value.messages.map(message => message.recordIndex))]); setStage('confirm');
  }
  async function initialize() {
    const active = request(); setStage('loading');
    try {
      const settings = await resolveKnowledgeWorkspace(initialWorkspace || new URLSearchParams(window.location.search).get('workspace') || '', active.signal);
      if (active.signal.aborted) return;
      setWorkspace(settings.workspace); setExecutor(settings.executor); setModel(settings.model); setAdjust(!settings.model.trim() || !settings.workspace.trim());
      if (initialSource) {
        const value = await api<KnowledgeConversationPreview>('preview-conversation', initialSource, active.signal);
        if (!active.signal.aborted) acceptPreview(value);
      } else {
        const value = await api<KnowledgeConversation[]>('conversations', {}, active.signal);
        if (!active.signal.aborted) { setConversations(value); setStage('select'); }
      }
      if (!active.signal.aborted) initialized.current = true;
    } catch (cause) { if (!active.signal.aborted) setError(explain(cause)); }
    finally { if (controller.current === active) controller.current = null; }
  }
  useEffect(() => { mounted.current = true; void initialize(); return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  async function chooseConversation(threadId: string) {
    const active = request(); setConversationId(threadId); setConversation(undefined); setSource(undefined); setLoadingConversation(true);
    try {
      const value = await api<KnowledgeConversationDetail>('conversation', { threadId }, active.signal);
      if (!active.signal.aborted) setConversation(value);
    } catch (cause) { if (!active.signal.aborted) setError(explain(cause)); }
    finally { if (controller.current === active) { controller.current = null; setLoadingConversation(false); } }
  }
  async function prepare(next: Scope) {
    const active = request(); setSource(next); setPreview(undefined); setRun(undefined); setStage('loading');
    try {
      const value = await api<KnowledgeConversationPreview>('preview-conversation', next, active.signal);
      if (!active.signal.aborted) acceptPreview(value);
    } catch (cause) { if (!active.signal.aborted) setError(explain(cause)); }
    finally { if (controller.current === active) controller.current = null; }
  }
  async function reviewCandidate(id: string, signal: AbortSignal) {
    setReviewing(true);
    try {
      if (onReview) await onReview(workspace.trim(), id, signal);
      else { router.push(candidateLink(id)); onClose(); }
    } catch {
      if (mounted.current && !signal.aborted) setError(t('候选已保存，暂时无法打开核对界面。请重试打开候选，无需重新提炼。', 'Candidates are saved, but the review could not open. Retry opening a candidate without extracting again.'));
    } finally { if (mounted.current) setReviewing(false); }
  }
  async function openSaved(id: string) {
    if (controller.current) return;
    const active = request();
    await reviewCandidate(id, active.signal);
    if (controller.current === active) controller.current = null;
  }
  async function generate() {
    if (!source || !preview || controller.current) return;
    const active = request(); setStage('generating');
    try {
      const captured = await api<KnowledgeCandidateSource>('capture-conversation', { workspace: workspace.trim(), ...source, sourceVersion: preview.sourceVersion, recordIndexes: selected }, active.signal);
      const result = await api<KnowledgeCandidateRun>('generate', { workspace: workspace.trim(), snapshot: captured.snapshotId, executor, model: model.trim(), runId: crypto.randomUUID() }, active.signal);
      if (active.signal.aborted) return;
      setRun(result); setStage('result'); notifyKnowledgeChange(workspace.trim());
      if (result.status === 'completed' && result.committed[0]) {
        if (!onReview) onFinished?.(workspace.trim());
        await reviewCandidate(result.committed[0].knowledgeId, active.signal);
      } else onFinished?.(workspace.trim());
    } catch (cause) {
      if (!mounted.current) return;
      if (!active.signal.aborted) setError(explain(cause));
      else setError(t('已请求取消。已保存的结果可在“知识待办”或“提炼记录”中查看。', 'Cancellation requested. Check Knowledge inbox or Extraction history for saved results.'));
      setStage('result'); onFinished?.(workspace.trim());
    } finally { if (controller.current === active) controller.current = null; }
  }
  const candidateLink = (id: string) => `${KNOWLEDGE_CANDIDATES_PATH}?${new URLSearchParams({ workspace: workspace.trim(), id })}`;
  const retry = () => !initialized.current ? initialize() : source ? prepare(source) : conversationId ? chooseConversation(conversationId) : initialize();
  return <><Modal centered title={t('提炼知识', 'Extract knowledge')} open width={640} closable={stage !== 'generating'} mask={{ closable: false }} onCancel={onClose}
    footer={stage === 'confirm' ? <Space><Button onClick={onClose}>{t('取消', 'Cancel')}</Button><Button type="primary" disabled={!selected.length || !workspace.trim() || !model.trim()} onClick={() => void generate()}>{t('开始提炼', 'Start extraction')}</Button></Space>
      : stage === 'generating' ? <Button onClick={() => controller.current?.abort()}>{t('取消提炼', 'Cancel extraction')}</Button>
        : <Button onClick={onClose}>{t('关闭', 'Close')}</Button>}>
    <div className="conversation-extract-confirm">
      {error && <Alert type="error" title={error} action={!run?.committed.length ? <Button onClick={() => void retry()}>{t('重新读取', 'Reload')}</Button> : undefined}/>}
      {stage === 'loading' && !error && <Spin tip={t('正在读取来源…', 'Reading source…')}><div style={{ height: 80 }}/></Spin>}
      {!initialSource && stage !== 'select' && stage !== 'generating' && <Button type="text" onClick={() => { controller.current?.abort(); controller.current = null; setError(''); setSource(undefined); setPreview(undefined); setRun(undefined); setStage('select'); }}>{t('重新选择来源', 'Choose another source')}</Button>}
      {stage === 'select' && <ConversationExtractionPicker conversations={conversations} conversation={conversation} conversationId={conversationId} loading={loadingConversation} lang={lang}
        onConversation={id => void chooseConversation(id)} onScope={next => void prepare(next)}/>}
      {stage === 'confirm' && preview && <ConversationExtractionConfirmation preview={preview} turnId={source?.turnId} selected={selected} onSelected={setSelected}
        workspace={workspace} onWorkspace={setWorkspace} executor={executor} onExecutor={value => { setExecutor(value); setModel(''); setAdjust(true); }} model={model} onModel={setModel} adjust={adjust} onAdjust={setAdjust} lang={lang}/>}
      {stage === 'generating' && <div className="conversation-extract-progress"><Spin/><p>{t('正在提炼知识…', 'Extracting knowledge…')}</p><p>{t('完成后直接进入候选核对。', 'Review candidates as soon as extraction completes.')}</p></div>}
      {stage === 'result' && run && <><Alert type={run.status === 'completed' ? 'success' : 'warning'} title={run.status === 'completed' ? t(`提炼完成，${run.committed.length} 条候选知识`, `Completed: ${run.committed.length} candidates`) : t('提炼未完成，请查看提炼记录。', 'Extraction incomplete. Check extraction history.')}/>
        {run.status === 'completed' && !run.committed.length && <p>{run.entityAnalysis ? t('本次返回零条知识候选，实体分析已独立保存，可按需核对。', 'This extraction returned zero knowledge candidates. Its independent entity analysis is saved and available for inspection.') : t('本次返回零条知识候选，请查看提炼记录中的接纳结果。', 'This extraction returned zero knowledge candidates. Check the admission results in extraction history.')}</p>}
        <EntityAnalysisSummary run={run} lang={lang} onOpen={setEntityId}/>
        {run.rejections.length > 0 && <p>{t(`${run.rejections.length} 条输出未通过引用或格式校验。`, `${run.rejections.length} outputs failed citation or format validation.`)}</p>}
        {run.committed.map(item => <p key={item.knowledgeId}>{onReview ? <Button type="link" loading={reviewing} onClick={() => void openSaved(item.knowledgeId)}>{t('核对已保存的候选', 'Review saved candidate')}</Button> : <Link href={candidateLink(item.knowledgeId)}>{t('核对已保存的候选', 'Review saved candidate')}</Link>}</p>)}
      </>}
    </div>
  </Modal>{entityId && <EntityAnalysisDrawer workspace={workspace.trim()} analysisId={entityId} lang={lang} onClose={() => setEntityId(undefined)}/>}</>;
}

export function ConversationExtractionPicker({ conversations, conversation, conversationId, loading, lang, onConversation, onScope }: {
  conversations: KnowledgeConversation[]; conversation?: KnowledgeConversationDetail; conversationId: string; loading: boolean; lang: Language;
  onConversation(id: string): void; onScope(source: Scope): void;
}) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  const tasks = [...new Map(conversation?.tasks.map(task => [task.turnId, task])).values()];
  return <div className="candidate-form">
    <p>{t('选择对话，再选择要提炼的一轮。内容只在本地读取，确认后才发送给模型。', 'Choose a conversation and a turn. Read locally first; send to a model only after confirmation.')}</p>
    {conversations.length ? <label>{t('对话', 'Conversation')}<Select aria-label={t('选择来源对话', 'Choose source conversation')} showSearch={{ optionFilterProp: 'label' }} style={{ width: '100%' }} value={conversationId || undefined}
      placeholder={t('搜索对话标题', 'Search conversation titles')} onChange={onConversation} options={conversations.map(item => ({ value: item.threadId, label: `${conversationLabel(item.title, t('未命名对话', 'Untitled conversation'))}${item.cwd ? ` · ${item.cwd.split('/').filter(Boolean).at(-1)}` : ''}` }))}/></label>
      : <Empty description={t('没有可选择的本机对话。可在“更多”中导入日志文件。', 'No local conversations available. Import a log file from More.')}/>}
    {loading && <Spin tip={t('正在读取轮次…', 'Reading turns…')}><div style={{ height: 40 }}/></Spin>}
    {conversation && (tasks.length ? <>
      <label>{t('提炼范围', 'Extraction scope')}<Select aria-label={t('选择要提炼的一轮', 'Choose a turn to extract')} showSearch={{ optionFilterProp: 'label' }} style={{ width: '100%' }} placeholder={t('选择这一轮的请求与回复', 'Choose a request and its replies')}
        onChange={turnId => onScope({ threadId: conversation.threadId, turnId })} options={tasks.map((task, index) => ({ value: task.turnId, label: t(`第 ${index + 1} 轮 · ${conversationLabel(task.title, '未命名轮次')}`, `Turn ${index + 1} · ${conversationLabel(task.title, 'Untitled turn')}`) })).reverse()}/></label>
      <Button type="text" onClick={() => onScope({ threadId: conversation.threadId })}>{t('改为提炼整条对话', 'Extract the entire conversation instead')}</Button>
    </> : <Empty description={t('这条对话没有可选择的轮次，请换一条。', 'No turns available. Choose another conversation.')}/>)}
  </div>;
}

export function ConversationExtractionConfirmation({ preview, turnId, selected, onSelected, workspace, onWorkspace, executor, onExecutor, model, onModel, adjust, onAdjust, lang }: {
  preview: KnowledgeConversationPreview; turnId?: string; selected: number[]; onSelected(value: number[] | ((current: number[]) => number[])): void;
  workspace: string; onWorkspace(value: string): void; executor: string; onExecutor(value: string): void; model: string; onModel(value: string): void;
  adjust: boolean; onAdjust(value: boolean): void; lang: Language;
}) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  return <>
    <p className="conversation-extract-scope"><strong>{turnId ? t('当前这一轮', 'This turn') : t('整条对话', 'Entire conversation')}</strong> · {t(`已选 ${selected.length} 条消息`, `${selected.length} messages selected`)}</p>
    <p className="conversation-extract-title" title={conversationLabel(preview.origin.title, t('系统或附件记录', 'System or attachment record'))}>{conversationLabel(preview.origin.title, t('系统或附件记录', 'System or attachment record'))}</p>
    <p>{t('将这些消息交给模型，提炼可复用的事实、方法和经验。', 'Send these messages to the model to extract reusable facts, methods and lessons.')}</p>
    <details className="conversation-extract-options"><summary>{t('查看／调整消息', 'View or adjust messages')}</summary>
      <Space><Button size="small" onClick={() => onSelected([...new Set(preview.messages.map(message => message.recordIndex))])}>{t('全选', 'Select all')}</Button><Button size="small" onClick={() => onSelected([])}>{t('清空', 'Clear')}</Button></Space>
      <div className="conversation-extract-messages">{preview.messages.map(message => <div className="conversation-extract-message" key={message.evidenceRef}>
        <Checkbox checked={selected.includes(message.recordIndex)} onChange={event => onSelected(values => event.target.checked ? [...new Set([...values, message.recordIndex])] : values.filter(value => value !== message.recordIndex))}>{message.role === 'user' ? t('你', 'You') : t('助手', 'Assistant')}</Checkbox>
        <details><summary>{message.text.slice(0, 140)}{message.text.length > 140 ? '…' : ''}</summary><pre>{message.text}</pre></details>
      </div>)}</div>
    </details>
    <div className="conversation-extract-destination"><span>{t('模型', 'Model')}</span><strong>{executor} / {model || t('尚未设置', 'Not set')}</strong><span>{t('保存到', 'Save to')}</span><span title={workspace}>{workspace}</span></div>
    <details className="conversation-extract-options" open={adjust} onToggle={event => onAdjust(event.currentTarget.open)}><summary>{t('调整本次配置', 'Adjust for this extraction')}</summary><div className="candidate-form">
      <label>{t('调用方式', 'Provider')}<Select style={{ width: '100%' }} value={executor} onChange={onExecutor} options={['codex', 'openai-api', 'anthropic-api'].map(value => ({ value, label: value }))}/></label>
      <label>{t('模型', 'Model')}<Input value={model} onChange={event => onModel(event.target.value)}/></label>
      <label>{t('保存目录', 'Folder')}<Input value={workspace} onChange={event => onWorkspace(event.target.value)}/></label>
    </div></details>
  </>;
}
