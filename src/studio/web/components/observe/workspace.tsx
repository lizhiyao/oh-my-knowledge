'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Empty, Input, Pagination } from 'antd';
import type { ObservePage } from '../../../http/pages/observe-page';
import { OBSERVE_INDEX_PATH } from '../../../http/page-paths';
import type { ConversationListItem } from '../../../../observability/view-models/conversation';
import { type Language } from '../layout/shell';
import { ActivityNotice, useActivity } from './activity';
import { ConversationReader } from './reader';
import { StudioUtilities } from '../layout/utilities';
import { displayTime } from '../../../application/display/format';
import { INDEPENDENT_LIMIT, LIST_PAGE_SIZE, PROJECT_LIMIT, PROJECT_SESSION_LIMIT, keepSelectedVisible, listPage, visibleProjectIds } from '../../../application/conversations/sidebar-window';
import type { ProjectWindow } from '../../../application/conversations/sidebar-window';
import { listEmptyState } from '../../../application/conversations/list-states';
import type { ListEmptyState } from '../../../application/conversations/list-states';
import { conversationHref } from '../conversation-link';

function conversationLabel(value: string): string {
  return value.replace(/&#(?:x20|32);/gi, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(issues|pull)\/(\d+)/g, (_, type, number) => `${type === 'pull' ? 'PR' : 'Issue'} #${number}`)
    .replace(/\*\*/g, '').trim();
}
const running = (item: ConversationListItem) => item.tasks.some(task => task.status === 'open');
const hasProject = (item: ConversationListItem) => Boolean(item.project || item.cwd);
const projectId = (item: ConversationListItem) => item.project?.projectId ?? item.cwd ?? 'unassigned';
const projectName = (item: ConversationListItem, zh: boolean) => item.project?.name ?? item.cwd?.split('/').filter(Boolean).at(-1) ?? (zh ? '未归属项目' : 'Unassigned');

export function ObserveWorkspace({ page, lang }: { page: Exclude<ObservePage, { pageKind: 'trajectory' }>; lang: Language }) {
  const zh = lang === 'zh'; const router = useRouter();
  const t = (cn: string, en: string) => zh ? cn : en;
  const selected = page.pageKind === 'conversation' ? page.model : undefined;
  const index = page.pageKind === 'index' ? page.model : page.navigation;
  const [view, setView] = useState('recent');
  const [query, setQuery] = useState('');
  const [allProjects, setAllProjects] = useState(false);
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
        if (last && index.conversations.some(item => item.threadId === last)) router.replace(conversationHref(last, lang));
      }
    } catch { /* Navigation still works when browser storage is disabled. */ }
  }, [selected?.threadId, page.pageKind, router, lang]);
  function choose(next: string) {
    setNavigationOpen(false); setCurrent(1);
    const target = `${OBSERVE_INDEX_PATH}?${new URLSearchParams({ view: next, lang })}`;
    if (selected) router.push(target);
    else { setView(next); window.history.replaceState(null, '', target); }
  }
  const groups = new Map<string, ConversationListItem[]>();
  for (const item of index.conversations.filter(hasProject)) { const id = projectId(item); groups.set(id, [...(groups.get(id) ?? []), item]); }
  const matches = (item: ConversationListItem) => `${conversationLabel(item.title)} ${item.cwd ?? ''} ${item.project?.name ?? ''}`.toLowerCase().includes(query.toLowerCase());
  const independent = index.conversations.filter(item => !hasProject(item) && matches(item));
  const shownIndependent = keepSelectedVisible(independent.slice(0, INDEPENDENT_LIMIT), independent, selected);
  const hiddenIndependent = independent.length - shownIndependent.length;
  const rows = index.conversations.filter(item => matches(item) && (view === 'recent' || (view === 'running' ? running(item) : projectId(item) === view)));
  const listed = listPage(rows, current);
  const group = groups.get(view);
  const heading = view === 'recent' ? t('全部对话', 'All conversations') : view === 'running' ? t('进行中的对话', 'Running conversations') : group?.[0] ? projectName(group[0], zh) : t('项目', 'Project');
  const projectWindow: ProjectWindow = { all: allProjects, searching: Boolean(query), selectedId: selected ? projectId(selected) : undefined, activeId: view };
  const projectIds = visibleProjectIds([...groups.keys()], projectWindow);
  /* 四种空的下一步各不相同，合成一句「暂无匹配的会话」等于把判断推回给用户。 */
  const emptyState: ListEmptyState = listEmptyState({ searching: Boolean(query), view, viewExists: groups.has(view) });
  const emptyCopy: Record<ListEmptyState, { description: string; action?: string }> = {
    'no-match': { description: t('没有匹配的会话。搜索只匹配标题、路径与项目名，不检索消息正文。', 'No matching conversations. Search matches titles, paths and project names, not message bodies.'), action: t('清空搜索', 'Clear the search') },
    'no-running': { description: t('当前没有进行中的会话。已结束的工作记录仍在全部对话里。', 'Nothing is running right now. Finished work is still in All conversations.'), action: t('查看全部对话', 'View all conversations') },
    'unknown-project': { description: t('找不到这个项目，它可能已被移动或清理。', 'This project cannot be found; it may have been moved or cleaned up.'), action: t('查看全部对话', 'View all conversations') },
    'no-data': { description: t('暂无会话记录。Agent 运行后记录会自动出现在这里，使用说明见“设置与帮助”。', 'No conversations yet. Records appear automatically once an agent has run; see “Settings and help” for guidance.') },
  };
  function clearSearch() { setQuery(''); setCurrent(1); }
  return <div className={`observe-workbench${navigationOpen ? ' navigation-open' : ''}`}>
    <aside className="observe-sidebar" aria-label={t('项目与会话', 'Projects and conversations')}>
      <Input allowClear aria-label={t('搜索项目或会话', 'Search projects or conversations')} placeholder={t('搜索项目或会话', 'Search projects or conversations')} value={query} onChange={event => { setQuery(event.target.value); setCurrent(1); }}/>
      <div className="observe-sidebar-scroll">
      <div className="observe-projects" aria-label={t('项目', 'Projects')}><h2>{t('项目', 'Projects')}</h2>{projectIds.map(id => {
        const items = groups.get(id) ?? [];
        const visible = items.filter(matches); if (!visible.length) return null;
        const name = projectName(items[0], zh);
        const shown = keepSelectedVisible(visible.slice(0, PROJECT_SESSION_LIMIT), visible, selected);
        const directory = items[0].project?.directory ?? items[0].cwd;
        return <details key={id} open={selected ? projectId(selected) === id : view === id}>
          <summary><span title={directory ? `${name}\n${directory}` : name}>{name}</span><span title={t(`${visible.length} 个会话`, `${visible.length} conversations`)}>{visible.length}</span></summary>
          <button className="observe-project-overview" onClick={() => choose(id)}>{t('查看项目会话', 'View project conversations')}</button>
          {shown.map(item => { const meta = item.archived ? t('已归档', 'Archived') : item.model ?? item.sourceKind; return <Link key={item.threadId} onClick={() => setNavigationOpen(false)} className={`observe-session-link${item.threadId === selected?.threadId ? ' selected' : ''}`} title={conversationLabel(item.title)} href={conversationHref(item.threadId, lang)}><span>{running(item) && <i className="studio-running-dot"/>}{conversationLabel(item.title)}</span><small title={meta}>{meta}</small></Link>; })}
          {visible.length > PROJECT_SESSION_LIMIT && <button className="observe-project-overview" onClick={() => choose(id)}>{t(`查看全部 ${visible.length} 个会话`, `View all ${visible.length} conversations`)}</button>}
        </details>;
      })}{query && !index.conversations.some(matches) && <>
        <p className="observe-sidebar-empty">{t('没有匹配的项目或会话。搜索只匹配标题、路径与项目名，不检索消息正文。', 'No matching projects or conversations. Search matches titles, paths and project names, not message bodies.')}</p>
        <button className="observe-sidebar-link" onClick={clearSearch}>{t('清空搜索', 'Clear the search')}</button>
      </>}</div>
      {groups.size > PROJECT_LIMIT && !query && <button className="observe-sidebar-link" onClick={() => setAllProjects(value => !value)}>{allProjects ? t('收起项目', 'Show fewer projects') : t('查看全部项目', 'View all projects')}</button>}
      <section className="observe-recents" aria-label={t('独立对话', 'Standalone conversations')}>
        <header><h2>{t('独立对话', 'Standalone conversations')}</h2></header>
        <div className="observe-recent-links">{shownIndependent.map(item => <Link key={item.threadId} onClick={() => setNavigationOpen(false)} className={`observe-session-link${item.threadId === selected?.threadId ? ' selected' : ''}`} title={conversationLabel(item.title)} href={conversationHref(item.threadId, lang)}><span>{running(item) && <i className="studio-running-dot"/>}{conversationLabel(item.title)}</span></Link>)}</div>
        {hiddenIndependent > 0 && <button className="observe-sidebar-link" onClick={() => choose('recent')}>{t(`还有 ${hiddenIndependent} 个独立对话，在全部对话中查看`, `${hiddenIndependent} more standalone conversations in All conversations`)}</button>}
        {!independent.length && <p className="observe-sidebar-empty">{query ? t('没有匹配的独立对话。', 'No matching standalone conversations.') : t('暂无独立对话。有项目归属的会话显示在上方项目下。', 'No standalone conversations yet. Conversations that belong to a project are listed under Projects above.')}</p>}
      </section>
      <button className="observe-sidebar-link" onClick={() => choose('recent')}>{t('查看全部对话', 'View all conversations')}</button>
      <button className="observe-sidebar-link" aria-pressed={view === 'running'} onClick={() => choose(view === 'running' ? 'recent' : 'running')}>{t('进行中的对话', 'Running conversations')}</button>
      </div>
      <StudioUtilities lang={lang}/>
    </aside>
    <main className="observe-workspace-main">
      <div className="observe-workspace-tools"><Button className="observe-navigation-toggle" size="small" onClick={() => setNavigationOpen(value => !value)}>{t('项目与会话', 'Projects and conversations')}</Button><ActivityNotice activity={activity} lang={lang}/></div>
      {selected ? <ConversationReader key={selected.threadId} item={selected} revision={page.revision} lang={lang} title={conversationLabel(selected.title)} project={projectName(selected, zh)}/> : <>
        <header className="observe-project-header"><h1>{heading}</h1><p>{t(`${rows.length} 个会话`, `${rows.length} conversations`)}{group ? ` · ${t('同一项目的工作记录', 'Work recorded in this project')}` : ` · ${t('打开会话，阅读工作过程', 'Open a conversation to read the work')}`}</p></header>
        <div className="observe-session-list">{listed.rows.map(item => {
          const label = conversationLabel(item.title);
          const lastTask = item.tasks.at(-1);
          const latest = lastTask ? conversationLabel(lastTask.title) : undefined;
          return <Link className="observe-session-row" key={item.threadId} href={conversationHref(item.threadId, lang)}>
          <div><strong title={label}>{label}</strong><p title={latest}>{latest ? `${t('最近请求：', 'Latest request: ')}${latest}` : t('打开后读取会话内容', 'Open to read this conversation')}</p><small title={item.cwd}>{projectName(item, zh)} · {item.model ?? item.sourceKind}{item.archived ? ` · ${t('已归档', 'Archived')}` : ''}</small></div>
          <div className="observe-session-meta">{running(item) && <span className="conversation-running"><i className="studio-running-dot"/>{t('进行中', 'Running')}</span>}<time title={displayTime(item.endTimestamp ?? item.startTimestamp)}>{displayTime(item.endTimestamp ?? item.startTimestamp, 'minute')}</time>{(item.toolFailureCount ?? 0) > 0 && <small title={t('曾发生工具报错，不代表最终工作失败。', 'Tool errors were observed; this does not determine the final outcome.')}>{t(`${item.toolFailureCount} 次工具报错`, `${item.toolFailureCount} tool errors`)}</small>}</div>
        </Link>;
        })}{!rows.length && <Empty description={emptyCopy[emptyState].description}>
          {emptyCopy[emptyState].action ? <Button onClick={() => { if (emptyState === 'no-match') clearSearch(); else choose('recent'); }}>{emptyCopy[emptyState].action}</Button> : null}
        </Empty>}</div>
        <Pagination current={listed.page} total={rows.length} pageSize={LIST_PAGE_SIZE} showSizeChanger={false} onChange={setCurrent}/>
      </>}
    </main>
  </div>;
}
