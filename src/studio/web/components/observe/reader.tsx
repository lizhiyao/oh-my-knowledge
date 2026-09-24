'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Alert, Button, Empty } from 'antd';
import type { ConversationListItem } from '../../../../observability/view-models/conversation';
import type { ConversationReaderPage } from '../../../view-models/conversations/conversation-reader';
import { type Language } from '../layout/shell';
import { displayTime } from '../../../application/display/format';
import { FOLLOW_THRESHOLD, HISTORY_THRESHOLD, READER_PAGE_LIMIT, isFollowing, mergeTurns, readingAnchor, resolveAnchorTop, shouldLoadOlder, turnsChanged } from '../../../application/conversations/reader-viewport';
import type { ReadingAnchor, ReadingFrame } from '../../../application/conversations/reader-viewport';
import { failureAction, readerState, turnFallback } from '../../../application/conversations/reader-states';
import type { ReaderState } from '../../../application/conversations/reader-states';
import { conversationPath } from '../conversation-link';
import { Status } from './activity';
import { ExtractedKnowledge } from './extracted-knowledge';

type Turn = ConversationReaderPage['turns'][number];

/**
 * 空状态与单轮退路单独成组件：这两段文字与链接只有在 fetch 落地之后才会出现，
 * 整组件的静态渲染永远停在「正在读取对话…」，拆出来才能让渲染测试断言用户真正读到的字。
 */
export function ReaderEmptyState({ lang, onRetry }: { lang: Language; onRetry: () => void }) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  return <Empty description={t('没有可读取的对话轮次。来源可能尚未写入，或记录已不可读。', 'No conversation turns available. The source may not have been written yet, or its records are unreadable.')}>
    <Button onClick={onRetry}>{t('重新读取', 'Read again')}</Button>
  </Empty>;
}

export function ReaderTurnBody({ turn, threadId, lang }: { turn: Turn; threadId: string; lang: Language }) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  const { messages } = turn;
  const fallback = turnFallback(turn);
  const href = conversationPath(threadId, turn.task.sourceTurnId ?? turn.task.turnId);
  if (fallback === 'unreadable') return <Alert type="warning" title={t('这一轮的原始记录读不出来，其余轮次仍可阅读。', 'The raw record for this turn is unreadable. Other turns remain readable.')} action={<Link href={href}>{t('查看执行详情', 'Execution details')}</Link>}/>;
  // Only collapse a complete leading context envelope; quoted/code examples and
  // incomplete records remain ordinary message text. Original evidence is untouched.
  const displayed = messages.flatMap(message => {
    const context = message.role === 'user' && message.text.match(/^(<environment_context>[\s\S]*?<\/environment_context>)(?=\s|$)/);
    if (!context) return [message];
    const remainder = message.text.slice(context[0].length);
    return [{ role: 'context', text: context[1] }, ...(remainder.trim() ? [{ ...message, text: remainder }] : [])];
  });
  const groups: { role: string; messages: { role: string; text: string }[] }[] = [];
  for (const message of displayed) {
    const previous = groups.at(-1);
    // Group presentation only; parse each original message independently.
    if (message.role === 'assistant' && previous?.role === 'assistant') previous.messages.push(message);
    else groups.push({ role: message.role, messages: [message] });
  }
  if (fallback === 'messages') return <>{groups.map((group, index) => group.role === 'context' ? <details className="observe-context" key={index}><summary>{t('环境上下文', 'Environment context')}</summary><pre tabIndex={0}>{group.messages[0].text}</pre></details> : <section className={`observe-reading-message ${group.role === 'user' ? 'human' : 'assistant'}`} key={index}><strong>{group.role === 'user' ? t('你', 'You') : t('助手', 'Assistant')}</strong>{group.messages.map((message, messageIndex) => <div className="observe-message-text" key={messageIndex}><Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => href ? <Link href={href} prefetch={false}>{children}</Link> : <span>{children}</span>,
    // Source images remain explicit links: reading a trace must not contact remote image hosts.
    img: ({ src, alt }) => typeof src === 'string' && src ? <Link href={src} prefetch={false}>{alt || t('图片', 'Image')}</Link> : <span>{alt}</span>,
    table: ({ children }) => <div className="observe-message-table" tabIndex={0} role="region" aria-label={t('对话中的表格', 'Conversation table')}><table>{children}</table></div>,
    pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
  }}>{message.text}</Markdown></div>)}</section>)}</>;
  return <p>{t('这一轮没有对话消息。', 'No conversation messages in this turn.')}</p>;
}

/** Keep the full timestamp accessible when consecutive turns share a date and zone. */
export function ReaderTurnFooter({ turn, previousTimestamp, threadId, lang }: { turn: Turn; previousTimestamp?: string; threadId: string; lang: Language }) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  const { task } = turn;
  const timestamp = task.startTimestamp;
  const parts = (value?: string) => value?.match(/^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/);
  const date = parts(timestamp); const previous = parts(previousTimestamp);
  const sameDay = date && previous && date[1] === previous[1] && date[2] === previous[2];
  const fullTime = displayTime(timestamp);
  return <footer className="observe-turn-footer">
    <div className="observe-turn-meta">
      {task.status === 'completed' ? <span>{lang === 'zh' ? '已完成' : 'completed'}</span> : <Status status={task.status} lang={lang}/>}
      <time dateTime={timestamp} title={fullTime} aria-label={fullTime}>{displayTime(timestamp, sameDay ? 'clock' : 'full')}</time>
    </div>
    {task.toolCallCount > 0 && <details className="observe-tool-summary"><summary>{t(`${task.toolCallCount} 次工具调用`, `${task.toolCallCount} tool calls`)}{task.toolFailureCount > 0 ? ` · ${t(`${task.toolFailureCount} 次报错`, `${task.toolFailureCount} errors`)}` : ''}</summary><p>{t('调用记录、知识访问和原始依据可在执行详情中查看。报错不等于最终工作失败。', 'Open execution details for calls, knowledge access and raw evidence. Errors do not determine the final outcome.')}</p></details>}
    <Link href={conversationPath(threadId, task.sourceTurnId ?? task.turnId)}>{lang === 'zh' ? '执行详情' : 'Execution details'}</Link>
  </footer>;
}

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
  const scroll = useRef<ReadingAnchor | null>(null);
  const lastMode = useRef<'older' | 'latest'>('latest');

  const load = useCallback(async (mode: 'older' | 'latest') => {
    if (request.current) { if (mode === 'latest') pendingRefresh.current = true; return; }
    const controller = new AbortController(); request.current = controller; lastMode.current = mode;
    setBusy(true); setFailed(false);
    const existing = current.current;
    try {
      const fetchPage = async (params: Record<string, string>) => {
        const response = await fetch(`/api/conversations/${encodeURIComponent(item.threadId)}/messages?${new URLSearchParams({ limit: String(READER_PAGE_LIMIT), ...params })}`, { signal: controller.signal, cache: 'no-store' });
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
      const next = mergeTurns(existing, incoming, mode);
      if (mode === 'older' || !existing.length) setHasOlder(older);
      if (turnsChanged(next, existing)) {
        const element = pane.current;
        scroll.current = readingAnchor(mode, element ? { scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, clientHeight: element.clientHeight } : null, follow.current);
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
    element.scrollTop = resolveAnchorTop(target, element.scrollHeight);
  }, [turns]);
  function latest() {
    follow.current = true; setNewMessages(false);
    if (pane.current) pane.current.scrollTop = pane.current.scrollHeight;
  }
  const state: ReaderState = readerState({ loaded, failed, turnCount: turns.length });
  return <>
    <header className="observe-reader-header"><div><h1 title={title}>{title}</h1><div className="observe-reader-meta"><span title={item.cwd ? `${project}\n${item.cwd}` : project}>{project}</span><span title={item.model ?? item.sourceKind}>{item.model ?? item.sourceKind}</span><span>{t(`${item.turnCount ?? item.tasks.length} 轮对话`, `${item.turnCount ?? item.tasks.length} turns`)}</span></div></div><ExtractedKnowledge threadId={item.threadId} lang={lang}/></header>
    <div className="observe-conversation-reader" ref={pane} aria-label={t('对话内容', 'Conversation content')} onScroll={() => {
      const element = pane.current; if (!element) return;
      const frame: ReadingFrame = { scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, clientHeight: element.clientHeight };
      follow.current = isFollowing(frame, FOLLOW_THRESHOLD);
      if (follow.current) setNewMessages(false);
      if (shouldLoadOlder(frame, { hasOlder, busy: request.current !== null, failed }, HISTORY_THRESHOLD)) void load('older');
    }}>
      {hasOlder && <div className="observe-history-control"><Button type="text" loading={busy && lastMode.current === 'older'} onClick={() => void load('older')}>{t('加载更早的对话', 'Load earlier conversation')}</Button></div>}
      {failed && <Alert type="error" title={t('暂时无法读取更多对话，已加载内容仍可查看。', 'Cannot load more conversation. Loaded messages remain available.')} action={<Button onClick={() => { if (resetRequired) { current.current = []; follow.current = true; setResetRequired(false); void load('latest'); } else void load(lastMode.current); }}>{failureAction(resetRequired) === 'reload' ? t('重新读取对话', 'Reload conversation') : t('重试', 'Retry')}</Button>}/>}
      {state === 'loading' ? <p role="status">{t('正在读取对话…', 'Reading conversation…')}</p> : state === 'empty' ? <ReaderEmptyState lang={lang} onRetry={() => void load('latest')}/> : turns.map((turn, index) => { const { task } = turn; return <article key={task.turnId} data-turn-id={task.turnId} className="observe-reading-turn">
        <ReaderTurnBody turn={turn} threadId={item.threadId} lang={lang}/>
        <ReaderTurnFooter turn={turn} previousTimestamp={turns[index - 1]?.task.startTimestamp} threadId={item.threadId} lang={lang}/>
      </article>; })}
    </div>
    {newMessages && <div className="observe-new-messages"><Button type="primary" onClick={latest}>{t('有新消息 · 查看最新', 'New messages · Jump to latest')}</Button></div>}
  </>;
}
