'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Button, Empty, Input, Pagination, Space } from 'antd';
import type { ObservePage } from '../../../http/observe-page';
import type { ConversationListItem } from '../../../../observability/view-models/conversation';
import type { ConversationReaderPage } from '../../../view-models/conversation-reader';
import type { Language } from '../layout/shell';
import { ActivityNotice, Status, useActivity } from './activity';
import { ExtractedKnowledge } from './extracted-knowledge';

export function conversationLabel(value: string): string {
  return value.replace(/&#(?:x20|32);/gi, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(issues|pull)\/(\d+)/g, (_, type, number) => `${type === 'pull' ? 'PR' : 'Issue'} #${number}`)
    .replace(/\*\*/g, '').trim();
}
const running = (item: ConversationListItem) => item.tasks.some(task => task.status === 'open');
const projectId = (item: ConversationListItem) => item.project?.projectId ?? item.cwd ?? 'unassigned';
const projectName = (item: ConversationListItem, zh: boolean) => item.project?.name ?? item.cwd?.split('/').filter(Boolean).at(-1) ?? (zh ? '未归属项目' : 'Unassigned');
const time = (value?: string) => value ? value.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC') : '—';
const href = (id: string, lang: Language) => `/observe/conversations/${encodeURIComponent(id)}?lang=${lang}`;

export function ObserveWorkspace({ page, lang }: { page: Exclude<ObservePage, { pageKind: 'trajectory' }>; lang: Language }) {
  const zh = lang === 'zh'; const router = useRouter();
  const t = (cn: string, en: string) => zh ? cn : en;
  const selected = page.pageKind === 'conversation' ? page.model : undefined;
  const index = page.pageKind === 'index' ? page.model : page.navigation;
  const [view, setView] = useState('recent');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(1);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const activity = useActivity(selected ? `/api/conversations/${encodeURIComponent(selected.threadId)}/activity` : '/api/conversations/activity', page.revision);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setView(params.get('view') || 'recent'); setCurrent(1);
    try {
      if (selected) localStorage.setItem('omk.observe.lastConversation', selected.threadId);
      else if (!params.has('view')) {
        const last = localStorage.getItem('omk.observe.lastConversation');
        if (last && index.conversations.some(item => item.threadId === last)) router.replace(href(last, lang));
      }
    } catch { /* Navigation still works when browser storage is disabled. */ }
  }, [selected?.threadId, page.pageKind, router, lang]);
  function choose(next: string) {
    setNavigationOpen(false); setCurrent(1);
    if (selected) router.push(`/observe?${new URLSearchParams({ view: next, lang })}`);
    else { setView(next); window.history.replaceState(null, '', `/observe?${new URLSearchParams({ view: next, lang })}`); }
  }
  const groups = new Map<string, ConversationListItem[]>();
  for (const item of index.conversations) { const id = projectId(item); groups.set(id, [...(groups.get(id) ?? []), item]); }
  const matches = (item: ConversationListItem) => `${conversationLabel(item.title)} ${item.cwd ?? ''} ${item.project?.name ?? ''}`.toLowerCase().includes(query.toLowerCase());
  const rows = index.conversations.filter(item => matches(item) && (view === 'recent' || (view === 'running' ? running(item) : projectId(item) === view)));
  const visiblePage = Math.min(current, Math.max(1, Math.ceil(rows.length / 20)));
  const group = groups.get(view);
  const heading = view === 'recent' ? t('最近会话', 'Recent conversations') : view === 'running' ? t('进行中的会话', 'Running conversations') : group?.[0] ? projectName(group[0], zh) : t('项目', 'Project');
  return <div className={`observe-workbench${navigationOpen ? ' navigation-open' : ''}`}>
    <aside className="observe-sidebar" aria-label={t('项目与会话', 'Projects and conversations')}>
      <Input allowClear aria-label={t('搜索项目或会话', 'Search projects or conversations')} placeholder={t('搜索项目或会话', 'Search projects or conversations')} value={query} onChange={event => { setQuery(event.target.value); setCurrent(1); }}/>
      <nav className="observe-global-views"><button className={!selected && view === 'recent' ? 'selected' : ''} onClick={() => choose('recent')}>{t('最近会话', 'Recent conversations')}<span>{index.conversations.length}</span></button><button className={!selected && view === 'running' ? 'selected' : ''} onClick={() => choose('running')}>{t('进行中', 'Running')}<span>{index.conversations.filter(running).length}</span></button></nav>
      <div className="observe-projects"><h2>{t('项目', 'Projects')}</h2>{[...groups].map(([id, items]) => {
        const visible = items.filter(matches); if (!visible.length) return null;
        const name = projectName(items[0], zh);
        const shown = visible.slice(0, 12);
        if (selected && visible.some(item => item.threadId === selected.threadId) && !shown.some(item => item.threadId === selected.threadId)) shown.push(selected);
        return <details key={id} open={selected ? projectId(selected) === id : view === id}>
          <summary><span title={items[0].project?.directory ?? items[0].cwd}>{name}</span><span>{items.length}</span></summary>
          <button className="observe-project-overview" onClick={() => choose(id)}>{t('查看项目会话', 'View project conversations')}</button>
          {shown.map(item => <Link key={item.threadId} className={`observe-session-link${item.threadId === selected?.threadId ? ' selected' : ''}`} title={conversationLabel(item.title)} href={href(item.threadId, lang)}><span>{running(item) && <i className="studio-running-dot"/>}{conversationLabel(item.title)}</span><small>{item.archived ? t('已归档', 'Archived') : item.model ?? item.sourceKind}</small></Link>)}
          {visible.length > 12 && <button className="observe-project-overview" onClick={() => choose(id)}>{t(`查看全部 ${visible.length} 个会话`, `View all ${visible.length} conversations`)}</button>}
        </details>;
      })}{query && !index.conversations.some(matches) && <p>{t('没有匹配的项目或会话', 'No matching projects or conversations')}</p>}</div>
      <Link className="observe-health-entry" href={`/observe/health?lang=${lang}`}>{t('Skill 健康度', 'Skill health')}</Link>
    </aside>
    <main className="observe-workspace-main">
      <div className="observe-workspace-tools"><Button className="observe-navigation-toggle" size="small" onClick={() => setNavigationOpen(value => !value)}>{t('项目与会话', 'Projects and conversations')}</Button><ActivityNotice activity={activity} lang={lang}/></div>
      {selected ? <ConversationReader key={selected.threadId} item={selected} revision={page.revision} lang={lang}/> : <>
        <header className="observe-project-header"><h1>{heading}</h1><p>{t(`${rows.length} 个会话`, `${rows.length} conversations`)}{group ? ` · ${t('同一项目的工作记录', 'Work recorded in this project')}` : ` · ${t('打开会话，阅读工作过程', 'Open a conversation to read the work')}`}</p></header>
        <div className="observe-session-list">{rows.slice((visiblePage - 1) * 20, visiblePage * 20).map(item => <Link className="observe-session-row" key={item.threadId} href={href(item.threadId, lang)}>
          <div><strong title={conversationLabel(item.title)}>{conversationLabel(item.title)}</strong><p>{item.tasks.at(-1) ? `${t('最近请求：', 'Latest request: ')}${conversationLabel(item.tasks.at(-1)!.title)}` : t('打开后读取会话内容', 'Open to read this conversation')}</p><small title={item.cwd}>{projectName(item, zh)} · {item.model ?? item.sourceKind}{item.archived ? ` · ${t('已归档', 'Archived')}` : ''}</small></div>
          <div className="observe-session-meta">{running(item) && <span className="conversation-running"><i className="studio-running-dot"/>{t('进行中', 'Running')}</span>}<time title={time(item.endTimestamp ?? item.startTimestamp)}>{(item.endTimestamp ?? item.startTimestamp)?.slice(5, 16).replace('T', ' ') ?? '—'}</time>{(item.toolFailureCount ?? 0) > 0 && <small title={t('曾发生工具报错，不代表最终工作失败。', 'Tool errors were observed; this does not determine the final outcome.')}>{t(`${item.toolFailureCount} 次工具报错`, `${item.toolFailureCount} tool errors`)}</small>}</div>
        </Link>)}{!rows.length && <Empty description={t('暂无匹配的会话。已有运行记录会自动出现在这里。', 'No matching conversations. Existing runtime records appear here automatically.')}/>}</div>
        <Pagination current={visiblePage} total={rows.length} pageSize={20} showSizeChanger={false} onChange={setCurrent}/>
      </>}
    </main>
  </div>;
}

function ConversationReader({ item, revision, lang }: { item: ConversationListItem; revision: string; lang: Language }) {
  const zh = lang === 'zh'; const t = (cn: string, en: string) => zh ? cn : en;
  const [page, setPage] = useState(1); const [data, setData] = useState<ConversationReaderPage>(); const [failed, setFailed] = useState(false); const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const active = new AbortController(); setFailed(false);
    fetch(`/api/conversations/${encodeURIComponent(item.threadId)}/messages?offset=${(page - 1) * 5}&limit=5`, { signal: active.signal, cache: 'no-store' })
      .then(response => { if (!response.ok) throw new Error('unavailable'); return response.json(); })
      .then(value => { if (!active.signal.aborted) setData(value); }).catch(() => { if (!active.signal.aborted) setFailed(true); });
    return () => active.abort();
  }, [item.threadId, page, revision, attempt]);
  return <>
    <header className="observe-reader-header"><div><p title={item.cwd}>{projectName(item, zh)}</p><h1 title={conversationLabel(item.title)}>{conversationLabel(item.title)}</h1><small>{item.model ?? item.sourceKind} · {t(`${item.turnCount ?? item.tasks.length} 轮对话`, `${item.turnCount ?? item.tasks.length} turns`)} · {t('最近轮次优先', 'Latest turns first')}</small></div><ExtractedKnowledge threadId={item.threadId} lang={lang}/></header>
    <div className="observe-conversation-reader" aria-label={t('对话内容', 'Conversation content')}>
      {failed ? <Alert type="error" title={t('暂时无法读取对话', 'Cannot read this conversation')} action={<Button onClick={() => setAttempt(value => value + 1)}>{t('重试', 'Retry')}</Button>}/> : !data ? <p role="status">{t('正在读取对话…', 'Reading conversation…')}</p> : data.turns.length ? data.turns.map(({ task, messages, unavailable }) => <article key={task.turnId} className="observe-reading-turn">
        <header><Space><Status status={task.status} lang={lang}/><time>{time(task.startTimestamp)}</time></Space><Link href={`/observe/conversations/${encodeURIComponent(item.threadId)}/tasks/${encodeURIComponent(task.sourceTurnId ?? task.turnId)}?lang=${lang}`}>{t('查看执行详情', 'Execution details')}</Link></header>
        {unavailable ? <Alert type="warning" title={t('这一轮的消息暂不可读，可查看执行详情。', 'Messages in this turn are unavailable. Open execution details.')}/> : messages.length ? messages.map((message, i) => <section className={`observe-reading-message ${message.role === 'user' ? 'human' : 'assistant'}`} key={i}>
          <strong>{message.role === 'user' ? t('你', 'You') : t('助手', 'Assistant')}</strong>
          {message.text.length > 1000 ? <details><summary>{message.text.slice(0, 400)}… <span>{t('展开全文', 'Read more')}</span></summary><div className="observe-message-text">{message.text}</div></details> : <div className="observe-message-text">{message.text}</div>}
        </section>) : <p>{t('这一轮没有对话消息。', 'No conversation messages in this turn.')}</p>}
        {task.toolCallCount > 0 && <details className="observe-tool-summary"><summary>{t(`${task.toolCallCount} 次工具调用`, `${task.toolCallCount} tool calls`)}{task.toolFailureCount > 0 ? ` · ${t(`${task.toolFailureCount} 次报错`, `${task.toolFailureCount} errors`)}` : ''}</summary><p>{t('调用记录、知识访问和原始依据可在执行详情中查看。报错不等于最终工作失败。', 'Open execution details for calls, knowledge access and raw evidence. Errors do not determine the final outcome.')}</p></details>}
      </article>) : <Empty description={t('没有可读取的对话轮次', 'No conversation turns available')}/>}
    </div>
    <Pagination current={page} total={data?.total ?? item.tasks.length} pageSize={5} showSizeChanger={false} onChange={value => { setData(undefined); setPage(value); }}/>
  </>;
}
