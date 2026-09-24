'use client';
import Link from 'next/link';
import { ExtractConversation } from './extract-conversation';
import { resolveKnowledgeWorkspace } from '../knowledge/workspace';
import { candidateDecisionLabel, extractionRunStatusLabel, type CandidateChoice } from '../../../application/knowledge/candidate-status';
import { KNOWLEDGE_CANDIDATES_PATH } from '../../../http/page-paths';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Empty, Input } from 'antd';
import type { Language } from '../layout/shell';
type Related = { runId: string; status: string; startedAt?: string; committed: { knowledgeId: string; title: string; choice: CandidateChoice }[] };
export function ExtractedKnowledge({ threadId, turnId, lang }: { threadId: string; turnId?: string; lang: Language }) {
  const zh = lang === 'zh';
  const [workspace, setWorkspace] = useState('');
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<Related[]>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { const active = new AbortController();
    resolveKnowledgeWorkspace(new URLSearchParams(window.location.search).get('workspace') || '', active.signal).then(({ workspace: root }) => { if (!active.signal.aborted) { setWorkspace(root); } }).catch(() => { if (!active.signal.aborted) setError(true); });
    return () => active.abort();
  }, []);
  const params = new URLSearchParams({ ...(workspace ? { workspace } : {}), lang });
  async function load() {
    controller.current?.abort(); const active = new AbortController(); controller.current = active;
    setBusy(true); setError(false);
    try {
      const response = await fetch('/api/knowledge/candidates', { method: 'POST', signal: active.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'related', workspace, threadId }) });
      if (!response.ok) throw new Error('unavailable');
      const value = await response.json(); if (!active.signal.aborted) setRuns(value);
    } catch { if (!active.signal.aborted) setError(true); } finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  return <><div className="conversation-knowledge-actions"><ExtractConversation threadId={threadId} turnId={turnId} lang={lang} onFinished={() => { if (open && workspace) void load(); }}/><Button type="text" onClick={() => { setOpen(true); if (workspace) void load(); }}>{zh ? '已提炼知识' : 'Extracted knowledge'}</Button></div>
    <Drawer title={zh ? '这条对话的提炼记录' : 'Extractions from this conversation'} open={open} onClose={() => setOpen(false)} size={560}>
      <p>{zh ? '查看所选知识目录中，这条对话的提炼结果。' : 'Show this conversation’s extraction results in the selected knowledge folder.'}</p>
      <Input disabled={busy} aria-label={zh ? '知识保存目录' : 'Knowledge folder'} value={workspace} onChange={event => { setWorkspace(event.target.value); setRuns([]); }}/>
      <Button disabled={!workspace.trim()} loading={busy} onClick={() => void load()}>{zh ? '读取记录' : 'Load history'}</Button>
      {error && <Alert type="error" title={zh ? '无法读取，请检查保存目录。' : 'Could not load history. Check the folder.'}/>}
      {!busy && !error && runs.length === 0 && <Empty description={zh ? '当前目录尚无这条对话的提炼记录。' : 'No extractions for this conversation in this folder.'}/>}
      {runs.map(run => <section key={run.runId} className="candidate-statement"><p>{extractionRunStatusLabel(run.status, lang)} · {run.startedAt}</p><p>{zh ? '候选数量：' : 'Candidates: '}{run.committed.length}</p>{run.committed.map(item => { const link = new URLSearchParams(params); link.set('id', item.knowledgeId); return <p key={item.knowledgeId}><Link href={`${KNOWLEDGE_CANDIDATES_PATH}?${link}`}>{item.title}</Link> · {candidateDecisionLabel(item.choice, lang)}</p>; })}</section>)}
    </Drawer></>;
}
