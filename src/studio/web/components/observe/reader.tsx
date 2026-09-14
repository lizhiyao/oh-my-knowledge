'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Alert, Button, Empty, Space } from 'antd';
import type { ConversationListItem } from '../../../../observability/view-models/conversation';
import type { ConversationReaderPage } from '../../../view-models/conversation-reader';
import type { Language } from '../layout/shell';
import { Status } from './activity';
import { ExtractedKnowledge } from './extracted-knowledge';

type Turn = ConversationReaderPage['turns'][number];
const time = (value?: string) => value?.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC') ?? '—';

/** Cursors identify turns, so appending new turns cannot shift the history window. */
export function ConversationReader({ item, revision, lang, title, project }: { item: ConversationListItem; revision: string; lang: Language; title: string; project: string }) {
  const zh = lang === 'zh'; const t = (cn: string, en: string) => zh ? cn : en;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [resetRequired, setResetRequired] = useState(false);
  const [newMessages, setNewMessages] = useState(false);
  const [retry, setRetry] = useState(0);
  const pane = useRef<HTMLDivElement>(null);
  const current = useRef<Turn[]>([]);
  const follow = useRef(true);
  const request = useRef<AbortController | null>(null);
  const pendingRefresh = useRef(false);
  const mounted = useRef(true);
  const scroll = useRef<{ bottom: true } | { height: number; top: number } | null>(null);
  const lastMode = useRef<'older' | 'latest'>('latest');

  const load = useCallback(async (mode: 'older' | 'latest') => {
    if (request.current) { if (mode === 'latest') pendingRefresh.current = true; return; }
    const controller = new AbortController(); request.current = controller; lastMode.current = mode;
    setBusy(true); setFailed(false);
    const existing = current.current;
    try {
      const fetchPage = async (params: Record<string, string>) => {
        const response = await fetch(`/api/conversations/${encodeURIComponent(item.threadId)}/messages?${new URLSearchParams({ limit: '5', ...params })}`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(response.status === 409 ? 'cursor' : 'unavailable');
        return await response.json() as ConversationReaderPage;
      };
      let page = await fetchPage(mode === 'older' && existing.length ? { before: existing[0].task.turnId } : existing.length ? { after: existing.at(-1)!.task.turnId } : {});
      const incoming = [...page.turns].reverse();
      const older = page.hasOlder;
      // Catch up every missing turn, including more than one batch after a hidden tab resumes.
      while (mode === 'latest' && page.hasNewer && page.turns.length) {
        page = await fetchPage({ after: page.turns[0].task.turnId, offset: '1' });
        incoming.push(...[...page.turns].reverse());
      }
      if (controller.signal.aborted) return;
      const merged = new Map<string, Turn>();
      for (const turn of mode === 'older' ? [...incoming, ...existing] : [...existing, ...incoming]) merged.set(turn.task.turnId, turn);
      const next = [...merged.values()];
      const changed = JSON.stringify(next) !== JSON.stringify(existing);
      if (mode === 'older' || !existing.length) setHasOlder(older);
      if (changed) {
        const element = pane.current;
        scroll.current = mode === 'older' && element ? { height: element.scrollHeight, top: element.scrollTop } : follow.current ? { bottom: true } : null;
        if (mode === 'latest' && existing.length && !follow.current) setNewMessages(true);
        current.current = next; setTurns(next);
      }
      setLoaded(true);
    } catch (error) { if (!controller.signal.aborted) { setFailed(true); setResetRequired(error instanceof Error && error.message === 'cursor'); } }
    finally {
      if (request.current === controller) request.current = null;
      if (mounted.current) {
        setBusy(false);
        if (pendingRefresh.current) { pendingRefresh.current = false; setRetry(value => value + 1); }
      }
    }
  }, [item.threadId]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => { void load('latest'); }, [revision, retry, load]);
  useLayoutEffect(() => {
    const element = pane.current; const target = scroll.current; scroll.current = null;
    if (!element || !target) return;
    element.scrollTop = 'bottom' in target ? element.scrollHeight : target.top + element.scrollHeight - target.height;
  }, [turns]);
  function latest() {
    follow.current = true; setNewMessages(false);
    if (pane.current) pane.current.scrollTop = pane.current.scrollHeight;
  }
  return <>
    <header className="observe-reader-header"><div><p title={item.cwd}>{project}</p><h1 title={title}>{title}</h1><small>{item.model ?? item.sourceKind} · {t(`${item.turnCount ?? item.tasks.length} 轮对话`, `${item.turnCount ?? item.tasks.length} turns`)}</small></div><ExtractedKnowledge threadId={item.threadId} lang={lang}/></header>
    <div className="observe-conversation-reader" ref={pane} aria-label={t('对话内容', 'Conversation content')} onScroll={() => {
      const element = pane.current; if (!element) return;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      if (follow.current) setNewMessages(false);
      if (element.scrollTop < 80 && hasOlder && !request.current && !failed) void load('older');
    }}>
      {hasOlder && <div className="observe-history-control"><Button type="text" loading={busy && lastMode.current === 'older'} onClick={() => void load('older')}>{t('加载更早的对话', 'Load earlier conversation')}</Button></div>}
      {failed && <Alert type="error" title={t('暂时无法读取更多对话，已加载内容仍可查看。', 'Cannot load more conversation. Loaded messages remain available.')} action={<Button onClick={() => { if (resetRequired) { current.current = []; follow.current = true; setResetRequired(false); void load('latest'); } else void load(lastMode.current); }}>{resetRequired ? t('重新读取会话', 'Reload conversation') : t('重试', 'Retry')}</Button>}/>}
      {!loaded && !failed ? <p role="status">{t('正在读取对话…', 'Reading conversation…')}</p> : !turns.length && !failed ? <Empty description={t('没有可读取的对话轮次', 'No conversation turns available')}/> : turns.map(({ task, messages, unavailable }) => <article key={task.turnId} data-turn-id={task.turnId} className="observe-reading-turn">
        <header><Space><Status status={task.status} lang={lang}/><time>{time(task.startTimestamp)}</time></Space><Link href={`/observe/conversations/${encodeURIComponent(item.threadId)}/tasks/${encodeURIComponent(task.sourceTurnId ?? task.turnId)}?lang=${lang}`}>{t('查看执行详情', 'Execution details')}</Link></header>
        {unavailable ? <Alert type="warning" title={t('这一轮的消息暂不可读，可查看执行详情。', 'Messages in this turn are unavailable. Open execution details.')}/> : messages.length ? messages.map((message, i) => <section className={`observe-reading-message ${message.role === 'user' ? 'human' : 'assistant'}`} key={i}><strong>{message.role === 'user' ? t('你', 'You') : t('助手', 'Assistant')}</strong><div className="observe-message-text">{message.text}</div></section>) : <p>{t('这一轮没有对话消息。', 'No conversation messages in this turn.')}</p>}
        {task.toolCallCount > 0 && <details className="observe-tool-summary"><summary>{t(`${task.toolCallCount} 次工具调用`, `${task.toolCallCount} tool calls`)}{task.toolFailureCount > 0 ? ` · ${t(`${task.toolFailureCount} 次报错`, `${task.toolFailureCount} errors`)}` : ''}</summary><p>{t('调用记录、知识访问和原始依据可在执行详情中查看。报错不等于最终工作失败。', 'Open execution details for calls, knowledge access and raw evidence. Errors do not determine the final outcome.')}</p></details>}
      </article>)}
    </div>
    {newMessages && <div className="observe-new-messages"><Button type="primary" onClick={latest}>{t('有新消息 · 查看最新', 'New messages · Jump to latest')}</Button></div>}
  </>;
}
