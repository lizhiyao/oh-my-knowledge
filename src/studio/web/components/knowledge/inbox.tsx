'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Drawer } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateQueue } from '../../../view-models/knowledge/knowledge-candidates';
import { KnowledgeCandidates } from './candidates';
import { requestKnowledge } from './request';
import { resolveKnowledgeWorkspace } from './workspace';

export function KnowledgeInboxSummary({ lang, total, failedToLoad, incomplete }: { lang: Language; total?: number; failedToLoad: boolean; incomplete?: boolean }) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  return <p role="status">{failedToLoad ? t('候选数量暂不可读，重新读取成功后再显示数量。', 'Candidate count unavailable. Reload successfully to see the count.')
    : incomplete ? t('部分提炼记录不可读或来源范围未知，候选清单可能不完整，数量暂无法确认。已读取的候选仍可核对。', 'Some extraction records are unreadable or have an unknown source scope. The candidate list may be incomplete, so counts cannot be confirmed. Loaded candidates can still be reviewed.')
      : total === undefined ? t('正在读取候选数量…', 'Loading candidate count…')
      : t(`共 ${total} 条候选。按来源汇集；候选内容和知识归属仍需核对。`, `${total} candidates grouped by source. Claims and knowledge ownership still need review.`)}</p>;
}

export function KnowledgeInbox({ lang, threadId, projectId, refreshKey = 0, review, onCloseReview, disabled = false }: {
  lang: Language; threadId?: string; projectId?: string; refreshKey?: number; review?: { workspace: string; id: string }; onCloseReview?(): void; disabled?: boolean;
}) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  const [workspace, setWorkspace] = useState(''), [pending, setPending] = useState<number>(), [total, setTotal] = useState<number>();
  const [incomplete, setIncomplete] = useState(false);
  const [open, setOpen] = useState(false), [error, setError] = useState(false), [epoch, setEpoch] = useState(0);
  const [initialId, setInitialId] = useState<string>();
  const [updated, setUpdated] = useState(0);
  function applyQueue(value: KnowledgeCandidateQueue) {
    const partial = value.runs.some(run => run.schemaStatus !== 'current');
    setIncomplete(partial); setTotal(partial ? undefined : value.rows.length);
    setPending(partial ? undefined : value.rows.filter(row => row.choice === null).length); setError(false);
  }
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
    setTotal(undefined); setPending(undefined); setIncomplete(false); setError(false);
    void resolveKnowledgeWorkspace(new URLSearchParams(window.location.search).get('workspace') || '', active.signal).then(async settings => {
      if (active.signal.aborted) return;
      const root = review?.workspace ?? settings.workspace; setWorkspace(root);
      const value = await requestKnowledge<KnowledgeCandidateQueue>('candidates', { operation: 'queue', workspace: root, ...(threadId ? { threadId } : { projectId }) }, active.signal);
      if (!active.signal.aborted) applyQueue(value);
    }).catch(() => { if (!active.signal.aborted) { setError(true); setTotal(undefined); setPending(undefined); } });
    return () => active.abort();
  }, [threadId, projectId, refreshKey, updated, open, review?.workspace]);
  return <><Button disabled={disabled} onClick={() => { setInitialId(undefined); setEpoch(value => value + 1); setOpen(true); }}>
    {t('知识待办', 'Knowledge inbox')}{incomplete ? ` · ${t('数量待确认', 'Count unknown')}` : pending === undefined ? '' : ` · ${pending} ${t('待核对', 'pending')}`}
  </Button>{error && <span role="alert">{t('待办暂不可读', 'Inbox unavailable')}</span>}
    <Drawer title={threadId ? t('这条对话的知识', 'Knowledge from this conversation') : t('来自此项目对话的知识', 'Knowledge from this project’s conversations')}
      open={open} onClose={() => { setOpen(false); onCloseReview?.(); }} size="92vw" destroyOnHidden>
      <KnowledgeInboxSummary lang={lang} total={total} failedToLoad={error} incomplete={incomplete}/>
      {error && <Alert type="warning" title={t('读取失败，可关闭后重新打开。', 'Load failed. Close and open again.')}/>}
      {workspace && <div className="knowledge-inbox-review"><KnowledgeCandidates key={`${epoch}:${workspace}`} lang={lang} initialWorkspace={workspace} initialId={initialId}
        scope={threadId ? { threadId } : { projectId }} embedded onLoaded={applyQueue}/></div>}
    </Drawer></>;
}
