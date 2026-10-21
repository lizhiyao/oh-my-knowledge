'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Space } from 'antd';
import type { Language } from '../layout/shell';
import type { AutoExtractionPreview, AutoExtractionState } from '../../../view-models/knowledge/knowledge-candidates';
import { requestKnowledge } from './request';
import { resolveKnowledgeWorkspace } from './workspace';
import { GenerationPolicyFields } from './generation-policy-fields';
import type { ExtractionGenerationPolicy } from '../../../../knowledge/extraction/generation-policy';

/** Opening a preview does not grant permission or call a model. */
export function AutoExtractConversation({ threadId, lang, onChanged }: { threadId: string; lang: Language; onChanged?(): void }) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  const [state, setState] = useState<AutoExtractionState | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [workspace, setWorkspace] = useState(''), [executor, setExecutor] = useState('codex'), [model, setModel] = useState('');
  const [limit, setLimit] = useState(5), [confirmed, setConfirmed] = useState(false);
  const [policy, setPolicy] = useState<ExtractionGenerationPolicy>();
  const [preview, setPreview] = useState<AutoExtractionPreview>();
  const controller = useRef<AbortController | null>(null);
  const statusRevision = useRef<{ scope: string; etag: string | null } | null>(null);
  const statusEpoch = useRef(0);
  const changed = useRef(onChanged); changed.current = onChanged;
  async function readStatus(root: string, signal: AbortSignal) {
    const epoch = statusEpoch.current;
    let etag: string | null = null;
    const next = await requestKnowledge<AutoExtractionState | null>('auto-extraction', { operation: 'status', workspace: root, threadId }, signal, metadata => { etag = metadata.etag; });
    if (signal.aborted || controller.current || epoch !== statusEpoch.current) return;
    const scope = JSON.stringify([root, threadId]), previous = statusRevision.current;
    statusRevision.current = { scope, etag }; setState(next);
    // Refresh once on initialization (queue/token race), on actual changes, or when metadata is unavailable.
    if (!previous || previous.scope !== scope || !etag || previous.etag !== etag) changed.current?.();
  }
  async function api<T>(operation: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return requestKnowledge<T>('auto-extraction', { operation, ...fields }, signal);
  }
  useEffect(() => {
    const active = new AbortController();
    setSettingsReady(false); setConfirmed(false); setOpen(false); setPreview(undefined); setState(null); statusRevision.current = null;
    void resolveKnowledgeWorkspace(new URLSearchParams(window.location.search).get('workspace') || '', active.signal)
      .then(async settings => {
        if (active.signal.aborted) return;
        setWorkspace(settings.workspace); setExecutor(settings.executor); setModel(settings.model);
        await readStatus(settings.workspace, active.signal);
      }).catch(() => { if (!active.signal.aborted) setError(t('自动提炼状态暂不可读。', 'Automation status unavailable.')); })
      .finally(() => { if (!active.signal.aborted) setSettingsReady(true); });
    return () => { active.abort(); controller.current?.abort(); };
  }, [threadId]);
  useEffect(() => {
    if (!settingsReady || !workspace) return;
    const active = new AbortController();
    let polling = false;
    const timer = setInterval(() => {
      if (active.signal.aborted || polling || controller.current) return; polling = true;
      const epoch = statusEpoch.current;
      void readStatus(workspace, active.signal).catch(() => {
        if (!active.signal.aborted && !controller.current && epoch === statusEpoch.current) setError(t('状态更新失败，请重新读取。', 'Status update failed. Reload.'));
      }).finally(() => { polling = false; });
    }, 5000);
    return () => { clearInterval(timer); active.abort(); };
  }, [settingsReady, workspace, threadId]);
  async function work(action: (signal: AbortSignal) => Promise<void>) {
    if (controller.current) return;
    const active = new AbortController(); controller.current = active; statusEpoch.current++; setBusy(true); setError('');
    try { await action(active.signal); }
    catch (cause) { if (!active.signal.aborted) setError(cause instanceof Error && cause.message === 'knowledge_conflict'
      ? t('来源或运行状态有变化，请关闭后重新预览。', 'Source or run state changed. Close and preview again.')
      : t('未能完成，请检查来源、保存目录及模型配置后重试。', 'Could not complete. Check source, folder and model configuration.')); }
    finally { statusEpoch.current++; controller.current = null; setBusy(false); }
  }
  const reason = state ? ({ waiting: t('等待新轮次', 'Waiting for turns'), generating: t('正在提炼', 'Extracting'), stopped: t('已停止', 'Stopped'),
    quota: t('额度已用完', 'Call limit reached'), expired: t('授权已到期', 'Permission expired'), failed: t('失败，已停止', 'Failed; stopped'),
    interrupted: t('已中断，需重新开启', 'Interrupted; enable again'), capacity: t('已达容量上限', 'Capacity reached') })[state.reason] : '';
  return <><Space wrap><Button type={state?.enabled ? 'default' : 'primary'} disabled={!settingsReady} onClick={() => {
    if (state?.enabled) void work(async signal => { setState(await api('stop', { workspace, threadId }, signal)); });
    else { setOpen(true); setPreview(undefined); setConfirmed(false); void work(async signal => { setPreview(await api('preview', { threadId }, signal)); }); }
  }} loading={busy}>{state?.enabled ? t('停止自动提炼', 'Stop auto extraction') : t('开启自动提炼', 'Enable auto extraction')}</Button>
    {state && <span className="auto-extraction-status" role="status">{reason} · {state.callsUsed}／{state.maxCalls}{state.policy?.policyId === 'knowledge-generation-bounded/v1' && ` · ${t('已预约 token', 'Reserved tokens')} ${state.tokensReserved ?? 0}／${state.policy.maxTotalTokens}`}{state.enabled && state.notBefore && ` · ${t('服务端冷却至', 'Server cooldown until')} ${state.notBefore}`}</span>}</Space>
    {!open && error && <span role="alert">{error}</span>}
    <Modal className="auto-extraction-confirmation" styles={{ body: { maxHeight: '65vh', overflow: 'auto', overscrollBehavior: 'contain' } }} title={t('确认这条对话的自动提炼', 'Confirm auto extraction for this conversation')} open={open} width={720}
      onCancel={() => { controller.current?.abort(); setOpen(false); }}
      okText={t('批准并开启', 'Approve and enable')} cancelText={t('取消', 'Cancel')} confirmLoading={busy && preview !== undefined}
      okButtonProps={{ disabled: !preview || !confirmed || !workspace.trim() || !model.trim() }}
      onOk={() => void work(async signal => {
        const next = await api<AutoExtractionState>('enable', { workspace: workspace.trim(), threadId, token: preview!.token, executor, model: model.trim(), maxCalls: limit, ...(policy ? { policy } : {}) }, signal);
        setState(next); setOpen(false); onChanged?.();
      })}>
      <p>{t('本次授权仅限此对话，24 小时内、且 Studio 服务运行时有效。可以随时停止；重启后需要重新开启。', 'Permission covers only this conversation for 24 hours while Studio runs. Stop anytime; enable again after restart.')}</p>
      <p>{t('先处理最近 3 个已结束轮次，之后每次最多处理 3 个新增已结束轮次，并带上前 2 轮上下文。记录稳定 30 秒后开始；不会读取整条历史来判断所有纠正。', 'Start with the latest 3 finished turns, then process up to 3 new finished turns with 2 preceding turns of context. Wait 30 seconds for stable records; this does not reconcile the entire history.')}</p>
      <label>{t('候选保存目录', 'Candidate folder')}<Input value={workspace} disabled={busy} onChange={event => { setWorkspace(event.target.value); setConfirmed(false); }}/></label>
      <Space wrap><label>{t('发送到执行器', 'Send to executor')}<Select value={executor} disabled={busy} onChange={value => { setExecutor(value); setConfirmed(false); }} options={['codex', 'openai-api'].map(value => ({ value, label: value }))}/></label>
        <label>{t('模型', 'Model')}<Input value={model} disabled={busy} onChange={event => { setModel(event.target.value); setConfirmed(false); }}/></label>
        <label>{t('本次授权最多 OMK 调用次数', 'Maximum OMK invocations for this conversation permission')}<InputNumber aria-label={t('本次授权最多 OMK 调用次数', 'Maximum OMK invocations for this conversation permission')} min={1} max={20} value={limit} disabled={busy} onChange={value => { setLimit(value ?? 5); setConfirmed(false); }}/></label></Space>
      <GenerationPolicyFields lang={lang} value={policy} scope="conversation" disabled={busy} onChange={value => { setPolicy(value); setConfirmed(false); }}/>
      <p>{t('每次初始调用、重试和校验重问均占用上述授权总次数。美元费用及 provider 内部请求数未知；次数和 token 预约不是美元预算。派发前全额预约，即使中断后未实际发送或用量未知也不返还；默认单次政策不会重试。只发送窗口消息、时间／序号及限制、提取 Schema／提示词和政策允许的校验反馈；原始路径留在本机。', 'Every initial invocation, retry and validation reask consumes this conversation-wide call allowance. USD cost and internal provider request counts are unknown; invocation and token reservations are not a dollar budget. Reservations are charged before dispatch and never refunded, including interruptions before sending or unknown usage. The default single-invocation policy never retries. Only window messages, timestamps/indexes, limitations, extraction schema/prompt and policy-approved validation feedback are sent; raw paths stay local.')}</p>
      {preview && <details><summary>{t(`核对初始发送内容：${preview.turnCount} 轮、${preview.messages.length} 条消息`, `Review initial content: ${preview.turnCount} turns, ${preview.messages.length} messages`)}</summary>
        <h3>{preview.title}</h3>{preview.messages.map(message => <pre key={message.evidenceRef}>{message.role} · {message.timestamp ?? '—'} · #{message.recordIndex}{'\n'}{message.text}</pre>)}{preview.limitations.map(value => <p key={value}>{value}</p>)}</details>}
      <Checkbox checked={confirmed} disabled={busy || !preview} onChange={event => setConfirmed(event.target.checked)}>{t('批准上述初始窗口与本对话后续窗口按当前显示的调用、重问和预算上限发送到所选执行器／模型。输出仍为候选，保留与保存载体由我决定。', 'Approve sending the initial and future windows of this conversation to the selected executor/model within the displayed invocation, reask and budget limits. Outputs remain candidates; I decide what to retain and save as an artifact.')}</Checkbox>
      {error && <Alert type="error" title={error}/>}
    </Modal></>;
}
