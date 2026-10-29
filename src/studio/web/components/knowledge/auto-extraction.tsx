'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Space } from 'antd';
import type { Language } from '../layout/shell';
import type { AutoExtractionPreview, AutoExtractionStatus } from '../../../view-models/knowledge/knowledge-candidates';
import { requestKnowledge } from './request';
import { resolveKnowledgeWorkspace } from './workspace';

/** Opening a preview does not grant permission or call a model. */
export function AutoExtractConversation({ threadId, lang, onChanged }: { threadId: string; lang: Language; onChanged?(): void }) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  const [state, setState] = useState<AutoExtractionStatus | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [workspace, setWorkspace] = useState(''), [executor, setExecutor] = useState('codex'), [model, setModel] = useState('');
  const [limit, setLimit] = useState(5), [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<AutoExtractionPreview>();
  const controller = useRef<AbortController | null>(null);
  const statusRevision = useRef<{ scope: string; etag: string | null } | null>(null);
  const statusEpoch = useRef(0);
  const changed = useRef(onChanged); changed.current = onChanged;
  async function readStatus(root: string, signal: AbortSignal) {
    const epoch = statusEpoch.current;
    let etag: string | null = null;
    const next = await requestKnowledge<AutoExtractionStatus | null>('auto-extraction', { operation: 'status', workspace: root, threadId }, signal, metadata => { etag = metadata.etag; });
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
    interrupted: t('已中断，需重新开启', 'Interrupted; enable again'), capacity: t('已达容量上限', 'Capacity reached'), permission_upgrade_required: t('提炼流程已更新，请先迁移到独立新工作区', 'Extraction workflow changed; migrate to a separate workspace first') })[state.reason] : '';
  return <><Space wrap><Button type={state?.enabled ? 'default' : 'primary'} disabled={!settingsReady} onClick={() => {
    if (state?.enabled) void work(async signal => { setState(await api('stop', { workspace, threadId }, signal)); });
    else { setOpen(true); setPreview(undefined); setConfirmed(false); void work(async signal => { setPreview(await api('preview', { threadId }, signal)); }); }
  }} loading={busy}>{state?.enabled ? t('停止自动提炼', 'Stop auto extraction') : t('开启自动提炼', 'Enable auto extraction')}</Button>
    {state && <span className="auto-extraction-status" role="status">{reason} · {'callsUsed' in state ? `${state.callsUsed}／${state.maxCalls}` : ''}{state.enabled && 'notBefore' in state && state.notBefore && ` · ${t('服务端冷却至', 'Server cooldown until')} ${state.notBefore}`}</span>}</Space>
    {!open && error && <span role="alert">{error}</span>}
    <Modal className="auto-extraction-confirmation" styles={{ body: { maxHeight: '65vh', overflow: 'auto', overscrollBehavior: 'contain' } }} title={t('确认这条对话的自动提炼', 'Confirm auto extraction for this conversation')} open={open} width={720}
      onCancel={() => { controller.current?.abort(); setOpen(false); }}
      okText={t('批准并开启', 'Approve and enable')} cancelText={t('取消', 'Cancel')} confirmLoading={busy && preview !== undefined}
      okButtonProps={{ disabled: !preview || !confirmed || !workspace.trim() || !model.trim() || state?.schemaStatus === 'unsupported' }}
      onOk={() => void work(async signal => {
        const next = await api<AutoExtractionStatus>('enable', { workspace: workspace.trim(), threadId, token: preview!.token, executor, model: model.trim(), maxCalls: limit, workflowId: 'knowledge-body-first/v2' }, signal);
        setState(next); setOpen(false); onChanged?.();
      })}>
      {state?.schemaStatus === 'unsupported' && <Alert type="warning" title={t('当前工作区使用旧提炼流程。请先显式迁移到独立新工作区，再填写迁移后的目录并重新授权；不会在原目录升级权限或恢复旧调用。', 'This workspace uses an older extraction workflow. Explicitly migrate to a separate workspace, then enter the migrated folder and grant fresh permission. Permissions are not upgraded in place and old calls are not resumed.')}/>}
      <p>{t('本次授权仅限此对话，24 小时内、且 Studio 服务运行时有效。可以随时停止；重启后需要重新开启。', 'Permission covers only this conversation for 24 hours while Studio runs. Stop anytime; enable again after restart.')}</p>
      <p>{t('先处理最近 3 个已结束轮次，之后每次最多处理 3 个新增已结束轮次，并带上前 2 轮上下文。记录稳定 30 秒后开始；不会读取整条历史来判断所有纠正。', 'Start with the latest 3 finished turns, then process up to 3 new finished turns with 2 preceding turns of context. Wait 30 seconds for stable records; this does not reconcile the entire history.')}</p>
      <label>{t('候选保存目录', 'Candidate folder')}<Input value={workspace} disabled={busy} onChange={event => { setWorkspace(event.target.value); setConfirmed(false); }}/></label>
      <Space wrap><label>{t('发送到执行器', 'Send to executor')}<Select value={executor} disabled={busy} onChange={value => { setExecutor(value); setConfirmed(false); }} options={['codex', 'openai-api'].map(value => ({ value, label: value }))}/></label>
        <label>{t('模型', 'Model')}<Input value={model} disabled={busy} onChange={event => { setModel(event.target.value); setConfirmed(false); }}/></label>
        <label>{t('本次授权最多 OMK 调用次数', 'Maximum OMK invocations for this conversation permission')}<InputNumber aria-label={t('本次授权最多 OMK 调用次数', 'Maximum OMK invocations for this conversation permission')} min={1} max={20} value={limit} disabled={busy} onChange={value => { setLimit(value ?? 5); setConfirmed(false); }}/></label></Space>
      <p>{t('每个窗口先生成并保存完整知识正文，再关联实体，最多调用模型两次；两次各占用一次额度。关联阶段还会发送已保存正文。发送内容包括选定消息、对话标题、轮次、时间／序号和限制。宿主路径不发送；消息正文中已有的路径会随正文发送。费用以执行器实际报告为准。', 'Each window first generates and saves complete content, then associates entities, using up to two model calls. Each call consumes one allowance. The association phase also sends saved content. Selected messages, conversation title, turn, timestamps/indexes and limitations are sent. Host paths are excluded; paths already in messages remain in those messages. Cost depends on executor reporting.')}</p>
      {preview && <details><summary>{t(`核对初始发送内容：${preview.turnCount} 轮、${preview.messages.length} 条消息`, `Review initial content: ${preview.turnCount} turns, ${preview.messages.length} messages`)}</summary>
        <h3>{preview.title}</h3>{preview.messages.map(message => <pre key={message.evidenceRef}>{message.role} · {message.timestamp ?? '—'} · #{message.recordIndex}{'\n'}{message.text}</pre>)}{preview.limitations.map(value => <p key={value}>{value}</p>)}</details>}
      <Checkbox checked={confirmed} disabled={busy || !preview} onChange={event => setConfirmed(event.target.checked)}>{t('批准上述初始窗口与本对话后续窗口按当前显示的两阶段流程和调用总额度发送到所选执行器／模型。输出仍为候选，保留与保存载体由我决定。', 'Approve sending the initial and future windows of this conversation to the selected executor/model using the displayed two-phase workflow and total call allowance. Outputs remain candidates; I decide what to retain and save as an artifact.')}</Checkbox>
      {error && <Alert type="error" title={error}/>}
    </Modal></>;
}
