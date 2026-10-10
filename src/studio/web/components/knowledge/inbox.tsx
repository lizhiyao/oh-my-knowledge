'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Drawer } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateQueue } from '../../../view-models/knowledge/knowledge-candidates';
import { KnowledgeCandidates } from './candidates';
import { resolveKnowledgeWorkspace } from './workspace';

export function KnowledgeInbox({ lang, threadId, projectId, refreshKey = 0, review, onCloseReview, disabled = false }: {
  lang: Language; threadId?: string; projectId?: string; refreshKey?: number; review?: { workspace: string; id: string }; onCloseReview?(): void; disabled?: boolean;
}) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  const [workspace, setWorkspace] = useState(''), [pending, setPending] = useState<number>(), [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false), [error, setError] = useState(false), [epoch, setEpoch] = useState(0);
  const [initialId, setInitialId] = useState<string>();
  const [updated, setUpdated] = useState(0);
  useEffect(() => {
    const refresh = (event: Event) => { if ((event as CustomEvent).detail === workspace) setUpdated(value => value + 1); };
    window.addEventListener('omk-knowledge-changed', refresh);
    return () => window.removeEventListener('omk-knowledge-changed', refresh);
  }, [workspace]);
  useEffect(() => {
    if (review) { setWorkspace(review.workspace); setInitialId(review.id); setEpoch(value => value + 1); setOpen(true); }
  }, [review]);
  useEffect(() => {
    const active = new AbortController();
    void resolveKnowledgeWorkspace(new URLSearchParams(window.location.search).get('workspace') || '', active.signal).then(async settings => {
      if (active.signal.aborted) return;
      const root = review?.workspace ?? settings.workspace; setWorkspace(root);
      const response = await fetch('/api/knowledge/candidates', { method: 'POST', signal: active.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'queue', workspace: root, ...(threadId ? { threadId } : { projectId }) }) });
      if (!response.ok) throw new Error('unavailable');
      const value = await response.json() as KnowledgeCandidateQueue;
      if (!active.signal.aborted) { setPending(value.rows.filter(row => row.choice === null).length); setTotal(value.rows.length); setError(false); }
    }).catch(() => { if (!active.signal.aborted) setError(true); });
    return () => active.abort();
  }, [threadId, projectId, refreshKey, updated, open, review?.workspace]);
  return <><Button disabled={disabled} onClick={() => { setInitialId(undefined); setEpoch(value => value + 1); setOpen(true); }}>
    {t('知识待办', 'Knowledge inbox')}{pending === undefined ? '' : ` · ${pending} ${t('待核对', 'pending')}`}
  </Button>{error && <span role="alert">{t('待办暂不可读', 'Inbox unavailable')}</span>}
    <Drawer title={threadId ? t('这条对话的知识', 'Knowledge from this conversation') : t('来自此项目对话的知识', 'Knowledge from this project’s conversations')}
      open={open} onClose={() => { setOpen(false); onCloseReview?.(); }} size="92vw" destroyOnHidden>
      <p>{t(`共 ${total} 条候选。按来源汇集；候选内容和知识归属仍需核对。`, `${total} candidates grouped by source. Claims and knowledge ownership still need review.`)}</p>
      {error && <Alert type="warning" title={t('读取失败，可关闭后重新打开。', 'Load failed. Close and open again.')}/>}
      {workspace && <div className="knowledge-inbox-review"><KnowledgeCandidates key={`${epoch}:${workspace}`} lang={lang} initialWorkspace={workspace} initialId={initialId}
        scope={threadId ? { threadId } : { projectId }} embedded/></div>}
    </Drawer></>;
}
