'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Empty, Input } from 'antd';
import type { Language } from '../layout/shell';
type Related = { runId: string; status: string; startedAt?: string; committed: { knowledgeId: string; title: string; choice: string | null }[] };
export function ExtractedKnowledge({ threadId, turnId, lang }: { threadId: string; turnId?: string; lang: Language }) {
  const zh = lang === 'zh';
  const [workspace, setWorkspace] = useState('');
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<Related[]>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { const root = new URLSearchParams(window.location.search).get('workspace') || window.localStorage.getItem('omk.knowledge.workspace') || ''; setWorkspace(root); if (root) window.localStorage.setItem('omk.knowledge.workspace', root); }, []);
  const params = new URLSearchParams({ ...(workspace ? { workspace } : {}), ...(zh ? {} : { lang: 'en' }) });
  const extraction = new URLSearchParams(params); extraction.set('thread', threadId); if (turnId) extraction.set('turn', turnId);
  async function load() {
    controller.current?.abort(); const active = new AbortController(); controller.current = active;
    setBusy(true); setError(false);
    try {
      const response = await fetch('/api/knowledge/candidates', { method: 'POST', signal: active.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'related', workspace, threadId }) });
      if (!response.ok) throw new Error('unavailable');
      const value = await response.json(); if (!active.signal.aborted) setRuns(value);
    } catch { if (!active.signal.aborted) setError(true); } finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  return <><Button type="primary" href={`/knowledge/candidates?${extraction}`}>{zh ? '提炼知识' : 'Extract knowledge'}</Button><Button onClick={() => { setOpen(true); if (workspace) void load(); }}>{zh ? '已提炼知识' : 'Extracted knowledge'}</Button>
    <Drawer title={zh ? '这个会话的提炼记录' : 'Extractions from this conversation'} open={open} onClose={() => setOpen(false)} width={560}>
      <p>{zh ? '查看所选知识目录中，这个会话的提炼结果。' : 'Show this conversation’s extraction results in the selected knowledge folder.'}</p>
      <Input disabled={busy} aria-label={zh ? '知识保存目录' : 'Knowledge folder'} value={workspace} onChange={event => { setWorkspace(event.target.value); setRuns([]); }}/>
      <Button disabled={!workspace.trim()} loading={busy} onClick={() => void load()}>{zh ? '读取记录' : 'Load history'}</Button>
      {error && <Alert type="error" title={zh ? '无法读取，请检查保存目录。' : 'Could not load history. Check the folder.'}/>}
      {!busy && !error && runs.length === 0 && <Empty description={zh ? '当前目录尚无这个会话的提炼记录。' : 'No extractions for this conversation in this folder.'}/>}
      {runs.map(run => <section key={run.runId} className="candidate-statement"><p>{({ completed: zh ? '提炼完成' : 'Completed', failed: zh ? '提炼失败' : 'Failed', cancelled: zh ? '已取消' : 'Cancelled', generating: zh ? '提炼中' : 'Extracting', prepared: zh ? '待完成保存' : 'Ready to save' } as Record<string, string>)[run.status] ?? run.status} · {run.startedAt}</p><p>{zh ? '候选数量：' : 'Candidates: '}{run.committed.length}</p>{run.committed.map(item => { const link = new URLSearchParams(params); link.set('id', item.knowledgeId); return <p key={item.knowledgeId}><a href={`/knowledge/candidates?${link}`}>{item.title}</a> · {item.choice === 'retain' ? (zh ? '已保留' : 'Retained') : item.choice === 'discard' ? (zh ? '已舍弃' : 'Discarded') : (zh ? '待核对' : 'Awaiting review')}</p>; })}</section>)}
    </Drawer></>;
}
