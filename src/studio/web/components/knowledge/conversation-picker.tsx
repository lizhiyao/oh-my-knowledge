'use client';
import { useEffect, useState } from 'react';
import { Button, Checkbox, Empty, Select } from 'antd';
import type { KnowledgeCandidateSource } from '../../../view-models/knowledge-candidates';
import type { Language } from '../layout/shell';

type Conversation = { threadId: string; title: string; cwd?: string };
type Task = { turnId: string; title: string };
type Preview = { sourceVersion: string; origin: NonNullable<KnowledgeCandidateSource['origin']>; messages: KnowledgeCandidateSource['excerpts'] };
export function ConversationPicker({ lang, initialThread, initialTurn, workspace, busy, api, work, onCaptured }: {
  lang: Language; initialThread?: string; initialTurn?: string; workspace: string; busy: boolean;
  api<T>(operation: string, fields?: Record<string, unknown>): Promise<T>;
  work(action: () => Promise<void>): Promise<void>; onCaptured(source: KnowledgeCandidateSource): void;
}) {
  const zh = lang === 'zh';
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [thread, setThread] = useState(initialThread);
  const [turn, setTurn] = useState(initialTurn);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [preview, setPreview] = useState<Preview>();
  const [selected, setSelected] = useState<number[]>([]);
  async function loadThread(id: string, taskId?: string) {
    setThread(id); setTurn(taskId); setPreview(undefined); setSelected([]); setTasks([]);
    const detail = await api<Conversation & { tasks: Task[] }>('conversation', { threadId: id });
    setTasks(detail.tasks);
    if (taskId) setPreview(await api<Preview>('preview-conversation', { threadId: id, turnId: taskId }));
  }
  useEffect(() => { void work(async () => {
    setConversations(await api<Conversation[]>('conversations'));
    if (initialThread) await loadThread(initialThread, initialTurn);
  }); }, []);
  return <div className="candidate-form">
    <p>{zh ? '选择会话和任务，再勾选要提炼的消息。只会发送你选中的消息。' : 'Choose a conversation and task, then select messages. Only selected messages will be sent.'}</p>
    <label>{zh ? '会话' : 'Conversation'}<Select showSearch optionFilterProp="label" disabled={busy} value={thread} style={{ width: '100%' }} options={conversations.map(item => ({ value: item.threadId, label: item.title }))} onChange={id => void work(() => loadThread(id))}/></label>
    <label>{zh ? '任务' : 'Task'}<Select showSearch optionFilterProp="label" disabled={busy || !thread} value={turn} style={{ width: '100%' }} options={tasks.map(item => ({ value: item.turnId, label: item.title }))} onChange={id => void work(async () => { setTurn(id); setPreview(undefined); setSelected([]); setPreview(await api<Preview>('preview-conversation', { threadId: thread, turnId: id })); })}/></label>
    {preview && <><p className="candidate-help">{preview.origin.cwd}</p><p>{zh ? '尚未发送给模型。可选择多条消息；未选消息不会作为上下文自动加入。' : 'Nothing has been sent to a model. Unselected messages are not added as context.'}</p>
      {preview.messages.length ? <div className="conversation-message-selection">{preview.messages.map(message => <label key={message.evidenceRef} className="conversation-select-message"><Checkbox disabled={busy} checked={selected.includes(message.recordIndex)} onChange={event => setSelected(values => event.target.checked ? [...new Set([...values, message.recordIndex])] : values.filter(value => value !== message.recordIndex))}/><span><strong>{message.role === 'user' ? (zh ? '你' : 'You') : (zh ? '助手' : 'Assistant')}</strong><pre>{message.text}</pre></span></label>)}</div> : <Empty description={zh ? '这个任务没有可提炼的对话消息。请选择其他任务。' : 'No conversation messages in this task. Choose another task.'}/>}
      <Button type="primary" disabled={busy || !workspace.trim() || selected.length === 0} onClick={() => void work(async () => onCaptured(await api<KnowledgeCandidateSource>('capture-conversation', { threadId: thread, turnId: turn, sourceVersion: preview.sourceVersion, recordIndexes: selected })))}>{zh ? `预览并提炼（已选 ${selected.length} 条）` : `Preview and extract (${selected.length} selected)`}</Button>
      {!workspace.trim() && <p>{zh ? '请先通过“保存位置”选择知识保存目录。' : 'Choose a knowledge folder with Save location first.'}</p>}
    </>}
  </div>;
}
