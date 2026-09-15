'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, Modal, Select, Space, Spin } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateRun, KnowledgeCandidateSource } from '../../../view-models/knowledge/knowledge-candidates';
import { KNOWLEDGE_CANDIDATES_PATH } from '../../../http/page-paths';
import { resolveKnowledgeWorkspace } from '../knowledge/workspace';

type Preview = { origin: NonNullable<KnowledgeCandidateSource['origin']>; sourceVersion: string; messages: KnowledgeCandidateSource['excerpts'] };
const titleText = (text: string) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

/** A local confirmation on the observed conversation; execution stays in the shared application. */
export function ExtractConversation({ threadId, turnId, lang, onFinished }: { threadId: string; turnId?: string; lang: Language; onFinished(): void }) {
  const zh = lang === 'zh';
  const t = (cn: string, en: string) => zh ? cn : en;
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<'loading' | 'confirm' | 'generating' | 'result'>('loading');
  const [preview, setPreview] = useState<Preview>();
  const [selected, setSelected] = useState<number[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [executor, setExecutor] = useState('codex');
  const [model, setModel] = useState('');
  const [adjust, setAdjust] = useState(false);
  const [error, setError] = useState('');
  const [run, setRun] = useState<KnowledgeCandidateRun>();
  const [titles, setTitles] = useState<Record<string, string>>({});
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function api<T>(operation: string, fields: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    const response = await fetch('/api/knowledge/candidates', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, ...fields }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value as T;
  }
  function explain(cause: unknown) {
    return cause instanceof Error && cause.message === 'knowledge_conflict'
      ? t('会话内容有更新，请重新读取后确认。', 'The conversation changed. Reload and confirm again.')
      : cause instanceof Error && cause.message === 'knowledge_capacity_exceeded'
        ? t('这段会话超出提炼上限，请进入某一轮详情后提炼。', 'This conversation exceeds the limit. Extract from one turn’s detail instead.')
        : t('未能完成。请检查来源是否可读、保存目录及模型配置，然后重试。', 'Could not complete. Check source availability, the folder and model configuration, then retry.');
  }
  async function prepare() {
    if (controller.current) return;
    const active = new AbortController(); controller.current = active;
    setOpen(true); setStage('loading'); setError(''); setPreview(undefined); setRun(undefined); setTitles({});
    try {
      const settings = await resolveKnowledgeWorkspace(new URLSearchParams(window.location.search).get('workspace') || '', active.signal);
      const value = await api<Preview>('preview-conversation', { threadId, ...(turnId ? { turnId } : {}) }, active.signal);
      if (active.signal.aborted) return;
      setWorkspace(settings.workspace); setExecutor(settings.executor); setModel(settings.model); setAdjust(!settings.model.trim());
      setPreview(value); setSelected([...new Set(value.messages.map(message => message.recordIndex))]); setStage('confirm');
    } catch (cause) { if (!active.signal.aborted) setError(explain(cause)); }
    finally { if (controller.current === active) controller.current = null; }
  }
  async function generate() {
    if (!preview || controller.current) return;
    const active = new AbortController(); controller.current = active; setError(''); setStage('generating');
    try {
      const source = await api<KnowledgeCandidateSource>('capture-conversation', { workspace, threadId, ...(turnId ? { turnId } : {}), sourceVersion: preview.sourceVersion, recordIndexes: selected }, active.signal);
      const result = await api<KnowledgeCandidateRun>('generate', { workspace, snapshot: source.snapshotId, executor, model: model.trim(), runId: crypto.randomUUID() }, active.signal);
      if (active.signal.aborted) return;
      setRun(result); setStage('result'); onFinished();
      // Titles are a convenience; a failed read must not turn a completed generation into a retry.
      const entries = await Promise.all(result.committed.map(async item => {
        try { const detail = await api<{ revision: { title: string } }>('show', { workspace, id: item.knowledgeId }, active.signal); return [item.knowledgeId, detail.revision.title]; }
        catch { return [item.knowledgeId, t('查看候选知识', 'Review candidate')]; }
      }));
      if (!active.signal.aborted) setTitles(Object.fromEntries(entries));
    } catch (cause) {
      setStage('result');
      setError(active.signal.aborted ? t('已请求取消。已保存的结果可在“已提炼知识”中查看。', 'Cancellation requested. Check Extracted knowledge for saved results.') : explain(cause));
      onFinished();
    } finally { if (controller.current === active) controller.current = null; }
  }
  const link = (id: string) => `${KNOWLEDGE_CANDIDATES_PATH}?${new URLSearchParams({ workspace, id, lang })}`;
  const scope = turnId ? t('当前这一轮', 'This turn') : t('当前会话', 'This conversation');
  return <><Button type="primary" onClick={() => void prepare()}>{t('提炼知识', 'Extract knowledge')}</Button>
    <Modal centered title={t('提炼知识', 'Extract knowledge')} open={open} width={640} closable={stage !== 'generating'} mask={{ closable: false }}
      onCancel={() => { controller.current?.abort(); setOpen(false); }}
      footer={stage === 'confirm' ? <Space><Button onClick={() => setOpen(false)}>{t('取消', 'Cancel')}</Button><Button type="primary" disabled={!selected.length || !workspace.trim() || !model.trim()} onClick={() => void generate()}>{t('开始提炼', 'Start extraction')}</Button></Space>
        : stage === 'generating' ? <Button onClick={() => controller.current?.abort()}>{t('取消提炼', 'Cancel extraction')}</Button>
          : <Button onClick={() => setOpen(false)}>{t('关闭', 'Close')}</Button>}>
      <div className="conversation-extract-confirm">
        {error && <Alert type="error" title={error} action={stage === 'loading' || stage === 'result' ? <Button onClick={() => void prepare()}>{t('重新读取', 'Reload')}</Button> : undefined}/>}
        {stage === 'loading' && !error && <Spin tip={t('正在读取当前对话…', 'Reading this conversation…')}><div style={{ height: 80 }}/></Spin>}
        {stage === 'confirm' && preview && <>
          <p className="conversation-extract-scope"><strong>{scope}</strong> · {t(`已选 ${selected.length} 条消息`, `${selected.length} messages selected`)}</p>
          <p className="conversation-extract-title" title={titleText(preview.origin.title)}>{titleText(preview.origin.title)}</p>
          <p>{t('将这些消息交给模型，提炼可复用的事实、方法和经验。', 'Send these messages to the model to extract reusable facts, methods and lessons.')}</p>
          <details className="conversation-extract-options"><summary>{t('查看／调整消息', 'View or adjust messages')}</summary>
            <Space><Button size="small" onClick={() => setSelected([...new Set(preview.messages.map(message => message.recordIndex))])}>{t('全选', 'Select all')}</Button><Button size="small" onClick={() => setSelected([])}>{t('清空', 'Clear')}</Button></Space>
            <div className="conversation-extract-messages">{preview.messages.map(message => <div className="conversation-extract-message" key={message.evidenceRef}>
              <Checkbox checked={selected.includes(message.recordIndex)} onChange={event => setSelected(values => event.target.checked ? [...new Set([...values, message.recordIndex])] : values.filter(value => value !== message.recordIndex))}>{message.role === 'user' ? t('你', 'You') : t('助手', 'Assistant')}</Checkbox>
              <details><summary>{message.text.slice(0, 140)}{message.text.length > 140 ? '…' : ''}</summary><pre>{message.text}</pre></details>
            </div>)}</div>
          </details>
          <div className="conversation-extract-destination"><span>{t('模型', 'Model')}</span><strong>{executor} / {model || t('尚未设置', 'Not set')}</strong><span>{t('保存到', 'Save to')}</span><span title={workspace}>{workspace}</span></div>
          <details className="conversation-extract-options" open={adjust} onToggle={event => setAdjust(event.currentTarget.open)}><summary>{t('调整本次配置', 'Adjust for this extraction')}</summary><div className="candidate-form">
            <label>{t('调用方式', 'Provider')}<Select style={{ width: '100%' }} value={executor} onChange={value => { setExecutor(value); setModel(''); }} options={['codex', 'openai-api', 'anthropic-api'].map(value => ({ value, label: value }))}/></label>
            <label>{t('模型', 'Model')}<Input value={model} onChange={event => setModel(event.target.value)}/></label>
            <label>{t('保存目录', 'Folder')}<Input value={workspace} onChange={event => setWorkspace(event.target.value)}/></label>
          </div></details>
        </>}
        {stage === 'generating' && <div className="conversation-extract-progress"><Spin/><p>{t('正在提炼知识…', 'Extracting knowledge…')}</p><p>{t('完成后将在这里显示候选结果。', 'Candidate results will appear here when ready.')}</p></div>}
        {stage === 'result' && run && <><Alert type={run.status === 'completed' ? 'success' : 'warning'} title={run.status === 'completed' ? t(`提炼完成，${run.committed.length} 条候选知识`, `Completed: ${run.committed.length} candidates`) : t('提炼未完成，请查看提炼记录。', 'Extraction incomplete. Check extraction history.')}/>
          {run.status === 'completed' && !run.committed.length && <p>{t('这次没有找到可保存的知识，可以换一段包含明确事实或处理结果的对话。', 'No knowledge was found to save. Try a conversation with explicit facts or outcomes.')}</p>}
          {run.rejections.length > 0 && <p>{t(`${run.rejections.length} 条输出未通过引用或格式校验。`, `${run.rejections.length} outputs failed citation or format validation.`)}</p>}
          {run.committed.map(item => <p key={item.knowledgeId}><Link href={link(item.knowledgeId)}>{titles[item.knowledgeId] || t('查看候选知识', 'Review candidate')}</Link></p>)}
        </>}
      </div>
    </Modal></>;
}
