import type {
  ConversationIndexViewModel,
  ConversationListItem,
  ConversationTaskItem,
  ExperienceTurnStatus,
  Lang,
} from '../types/index.js';
import { DEFAULT_LANG, e, layout } from './layout.js';
import { brandLogo, icon } from './icons.js';
import { inlineMarkdownText, renderSafeInlineMarkdown } from './inline-markdown.js';

export function renderConversationIndexPage(
  model: ConversationIndexViewModel,
  lang: Lang = DEFAULT_LANG,
): string {
  const zh = lang === 'zh';
  const langQuery = lang === DEFAULT_LANG ? '' : '?lang=en';
  const activeCount = model.unarchivedConversationCount ?? model.conversations.filter((item) => !item.archived).length;
  const archivedCount = model.archivedConversationCount ?? model.conversations.filter((item) => item.archived).length;
  const runningCount = model.conversations.filter((item) => latestOpenTask(item) !== undefined).length;
  const conversations = [...model.conversations].sort((left, right) => (
    Number(latestOpenTask(right) !== undefined) - Number(latestOpenTask(left) !== undefined)
  ));
  const rows = conversations.map((conversation) => renderConversationRow(conversation, lang)).join('');
  const content = model.conversations.length > 0
    ? `<div class="conversation-list" role="list">${rows}</div>`
    : `<div class="empty-state"><strong>${zh ? '还没有可浏览的 Codex 对话' : 'No Codex conversations yet'}</strong><span>${zh ? 'Studio 会直接读取 Codex 的本机会话索引，不需要先运行 observe。' : 'Studio reads the local Codex conversation index directly; observe is not required.'}</span></div>`;

  return layout(zh ? 'Codex 对话' : 'Codex conversations', `
    <main class="conversation-page conversation-index-app">
      <header class="conversation-app-head">
        <a class="conversation-app-brand" href="/${langQuery}">
          <span>${brandLogo(28)}</span><strong>OMK</strong><em>Studio</em>
        </a>
        <nav class="conversation-app-nav" aria-label="${zh ? 'Studio 一级导航' : 'Studio primary navigation'}">
          <a class="is-active" href="/conversations${langQuery}">${zh ? '对话' : 'Conversations'}</a>
          <a href="/knowledge${langQuery}">${zh ? '知识载体' : 'Knowledge'}</a>
        </nav>
      </header>
      <div class="conversation-app-body">
        <section class="conversation-browser" aria-label="${zh ? 'Codex 对话' : 'Codex conversations'}">
          <header class="conversation-toolbar">
            <div class="conversation-browser-title">
              <h1>${zh ? '对话' : 'Conversations'}</h1>
            </div>
            <div class="conversation-toolbar-actions">
              <div class="conversation-filters" role="group" aria-label="${zh ? '对话筛选' : 'Conversation filter'}">
                ${runningCount > 0 ? filterButton('running', zh ? '进行中' : 'Running', runningCount) : ''}
                ${filterButton('all', zh ? '全部' : 'All', model.conversations.length, true)}
                ${filterButton('active', zh ? '未归档' : 'Unarchived', activeCount)}
                ${filterButton('archived', zh ? '已归档' : 'Archived', archivedCount)}
              </div>
              <label class="conversation-search">${icon('search', { size: 16 })}<span class="sr-only">${zh ? '搜索对话' : 'Search conversations'}</span><input type="search" placeholder="${zh ? '搜索标题或工作目录' : 'Search title or workspace'}" data-conversation-search></label>
            </div>
          </header>
          <div class="conversation-columns" aria-hidden="true">
            <span>${zh ? '最近活动' : 'Recent activity'}</span>
            <span>${zh ? '对话' : 'Conversation'}</span>
            <span>${zh ? '工作目录' : 'Workspace'}</span>
            <span>${zh ? '任务' : 'Tasks'}</span>
            <span></span>
          </div>
          <div class="conversation-list-viewport">${content}</div>
          <footer class="conversation-pager">
            <span data-page-range></span>
            <div class="pager-controls">
              <button type="button" data-page-prev aria-label="${zh ? '上一页' : 'Previous page'}" title="${zh ? '上一页' : 'Previous page'}">←</button>
              <span data-page-label></span>
              <button type="button" data-page-next aria-label="${zh ? '下一页' : 'Next page'}" title="${zh ? '下一页' : 'Next page'}">→</button>
            </div>
          </footer>
        </section>
      </div>
    </main>
    <style>${CSS}</style>
    <script>${paginationScript(lang)}</script>
  `, lang);
}

export function renderConversationDetailPage(
  conversation: ConversationListItem,
  lang: Lang = DEFAULT_LANG,
): string {
  const zh = lang === 'zh';
  const langSuffix = lang === DEFAULT_LANG ? '' : '?lang=en';
  const taskRows = conversationTaskEntries(conversation.tasks)
    .map(({ task, ordinal }) => renderTaskRow(task, ordinal, lang))
    .join('');
  return layout(zh ? '对话任务' : 'Conversation tasks', `
    <main class="conversation-page conversation-detail-page">
      <header class="conversation-page-head conversation-detail-head">
        <div>
          <a class="back-link" href="/conversations${langSuffix}">${zh ? '返回对话总览' : 'Back to conversations'}</a>
          <p class="conversation-eyebrow">CODEX · ${e(shortThreadId(conversation.sourceThreadId))}</p>
          <h1>${renderSafeInlineMarkdown(conversation.title)}</h1>
          <div class="detail-meta">
            ${conversation.model ? `<span>${e(conversation.model)}</span>` : ''}
            ${conversation.cwd ? `<span title="${e(conversation.cwd)}">${e(compactPath(conversation.cwd))}</span>` : ''}
            <span>${conversation.turnCount ?? conversation.tasks.length} ${zh ? '次任务' : 'tasks'}</span>
            ${(conversation.toolCallCount ?? 0) > 0 ? `<span>${conversation.toolCallCount} ${zh ? '次工具调用' : 'tool calls'}</span>` : ''}
            ${(conversation.toolFailureCount ?? 0) > 0 ? `<span class="failure-count">${conversation.toolFailureCount} ${zh ? '次失败' : 'failures'}</span>` : ''}
          </div>
        </div>
      </header>
      <section class="task-list" aria-label="${zh ? '任务列表' : 'Task list'}">
        <header class="task-list-head"><span>${zh ? '任务' : 'Task'}</span><span>${zh ? '时间' : 'Time'}</span><span>${zh ? '执行' : 'Execution'}</span><span></span></header>
        ${taskRows || `<div class="empty-state"><strong>${zh ? '没有识别到任务边界' : 'No task boundaries found'}</strong><span>${zh ? '该对话的原始日志可能尚未写入完整的 turn 生命周期。' : 'The raw log may not contain complete turn lifecycle records yet.'}</span></div>`}
      </section>
    </main>
    <style>${CSS}</style>
  `, lang);
}

function renderConversationRow(conversation: ConversationListItem, lang: Lang): string {
  const zh = lang === 'zh';
  const langSuffix = lang === DEFAULT_LANG ? '' : '?lang=en';
  const updated = formatRelativeDate(conversation.endTimestamp, lang);
  const workspace = conversation.cwd ? compactPath(conversation.cwd) : (zh ? '未知工作目录' : 'Unknown workspace');
  const state = conversation.archived ? 'archived' : 'active';
  const openTask = latestOpenTask(conversation);
  const openTaskHref = openTask ? taskTrajectoryHref(openTask, lang) : undefined;
  const detailHref = `/conversations/${encodeURIComponent(conversation.threadId)}${langSuffix}`;
  const searchable = `${conversation.title} ${conversation.preview ?? ''} ${conversation.cwd ?? ''}`.toLocaleLowerCase();
  const context = [
    (conversation.childThreadCount ?? 0) > 0
      ? `${conversation.childThreadCount} ${zh ? '个子任务' : 'child tasks'}`
      : undefined,
    conversation.archived ? (zh ? '已归档' : 'Archived') : undefined,
  ].filter((item): item is string => Boolean(item));
  const taskMetric = conversation.turnCount === undefined
    ? '<span class="index-pending">—</span>'
    : `<span><b>${conversation.turnCount}</b>${zh ? '任务' : 'tasks'}</span>`;
  const activity = openTask
    ? `<strong class="running-label"><i aria-hidden="true"></i>${zh ? '进行中' : 'Running'}</strong><span>${e(updated)} · ${e(conversation.model ?? 'Codex')}</span>`
    : `<strong>${e(updated)}</strong><span>${e(conversation.model ?? 'Codex')}</span>`;
  const liveTaskLink = openTaskHref
    ? `<a class="live-task-link" href="${e(openTaskHref)}" aria-label="${zh ? '查看进行中任务的实时轨迹' : 'View the live trajectory for the running task'}"><i aria-hidden="true"></i>${zh ? '查看实时轨迹' : 'View live'}</a>`
    : '';
  return `<div class="conversation-row${openTask ? ' is-running' : ''}" role="listitem" data-state="${state}" data-running="${openTask ? 'true' : 'false'}" data-search="${e(searchable)}">
    <a class="conversation-row-detail" href="${e(detailHref)}" aria-label="${zh ? '查看对话：' : 'View conversation: '}${e(inlineMarkdownText(conversation.title))}"></a>
    <div class="conversation-activity">${activity}</div>
    <div class="conversation-main">
      <div class="conversation-title">${renderSafeInlineMarkdown(conversation.title, { links: 'text' })}</div>
      ${context.length > 0 ? `<div class="conversation-context">${context.map((item) => `<span>${e(item)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="conversation-workspace" title="${e(conversation.cwd ?? '')}">${e(workspace)}</div>
    <div class="conversation-counts">${taskMetric}${liveTaskLink}</div>
    <span class="row-arrow" aria-hidden="true">${icon('chevron-right', { size: 17 })}</span>
  </div>`;
}

function latestOpenTask(conversation: ConversationListItem): ConversationTaskItem | undefined {
  for (let index = conversation.tasks.length - 1; index >= 0; index -= 1) {
    const task = conversation.tasks[index];
    if (task?.status === 'open') return task;
  }
  return undefined;
}

function conversationTaskEntries(
  tasks: ConversationTaskItem[],
): Array<{ task: ConversationTaskItem; ordinal: number }> {
  return tasks
    .map((task, index) => ({ task, ordinal: index + 1 }))
    .sort((left, right) => (
      Number(right.task.status === 'open') - Number(left.task.status === 'open')
      || left.ordinal - right.ordinal
    ));
}

function renderTaskRow(task: ConversationTaskItem, ordinal: number, lang: Lang): string {
  const zh = lang === 'zh';
  const href = taskTrajectoryHref(task, lang) ?? '#';
  const status = statusLabel(task.status, lang);
  return `<article class="task-row${task.status === 'open' ? ' is-running' : ''}" data-task-status="${e(task.status)}">
    <div class="task-index">${String(ordinal).padStart(2, '0')}</div>
    <div class="task-main"><div class="task-title">${renderSafeInlineMarkdown(task.title, { links: 'text' })}</div><div class="task-context">${task.eventCount} ${zh ? '条原始日志' : 'raw records'}</div></div>
    <div class="task-time"><span>${e(formatTime(task.startTimestamp))}</span><small>${e(formatDuration(task.durationMs, lang))}</small></div>
    <div class="task-execution"><span class="task-status status-${e(task.status)}">${e(status)}</span><small>${task.toolCallCount} ${zh ? '次调用' : 'calls'}${task.toolFailureCount > 0 ? ` · ${task.toolFailureCount} ${zh ? '次失败' : 'failures'}` : ''}</small></div>
    <a class="trajectory-link" href="${e(href)}">${zh ? '查看任务轨迹' : 'View trajectory'} →</a>
  </article>`;
}

function taskTrajectoryHref(task: ConversationTaskItem, lang: Lang): string | undefined {
  if (task.trajectoryHref) return withLang(task.trajectoryHref, lang);
  if (task.experienceSessionId) return observationTrajectoryHref(task, lang);
  return undefined;
}

function observationTrajectoryHref(task: ConversationTaskItem, lang: Lang): string {
  if (!task.experienceSessionId) return '#';
  const params = new URLSearchParams();
  params.set('turnId', task.turnId);
  if (lang !== DEFAULT_LANG) params.set('lang', 'en');
  return `/observe-debugger/${encodeURIComponent(task.experienceSessionId)}?${params.toString()}`;
}

function withLang(path: string, lang: Lang): string {
  if (lang === DEFAULT_LANG) return path;
  return `${path}${path.includes('?') ? '&' : '?'}lang=en`;
}

function filterButton(
  filter: 'running' | 'all' | 'active' | 'archived',
  label: string,
  count: number,
  active: boolean = false,
): string {
  const disabled = count === 0 && !active;
  return `<button type="button" data-view-filter="${filter}" aria-pressed="${active}"${active ? ' class="is-active"' : ''}${disabled ? ' disabled' : ''}><span>${e(label)}</span><b>${count}</b></button>`;
}

function formatTime(timestamp?: string): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRelativeDate(timestamp: string | undefined, lang: Lang): string {
  if (!timestamp) return lang === 'zh' ? '时间未知' : 'Unknown time';
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return timestamp;
  const elapsed = Date.now() - value.getTime();
  if (elapsed >= 0 && elapsed < 60_000) return lang === 'zh' ? '刚刚' : 'Just now';
  if (elapsed >= 0 && elapsed < 3_600_000) return lang === 'zh' ? `${Math.floor(elapsed / 60_000)} 分钟前` : `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed >= 0 && elapsed < 86_400_000) return lang === 'zh' ? `${Math.floor(elapsed / 3_600_000)} 小时前` : `${Math.floor(elapsed / 3_600_000)}h ago`;
  return formatTime(timestamp);
}

function formatDuration(durationMs: number | undefined, lang: Lang): string {
  if (durationMs === undefined) return '—';
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} ${lang === 'zh' ? '秒' : 's'}`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return lang === 'zh' ? `${minutes} 分 ${seconds} 秒` : `${minutes}m ${seconds}s`;
}

function compactPath(value: string): string {
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.length <= 3 ? value : `…/${parts.slice(-3).join('/')}`;
}

function shortThreadId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function statusLabel(status: ExperienceTurnStatus, lang: Lang): string {
  const zh = lang === 'zh';
  const labels: Record<ExperienceTurnStatus, [string, string]> = {
    completed: ['已完成', 'Completed'],
    aborted: ['已中止', 'Aborted'],
    interrupted: ['已打断', 'Interrupted'],
    open: ['进行中', 'Open'],
    unknown: ['未记录结束状态', 'End status not recorded'],
  };
  return labels[status][zh ? 0 : 1];
}

function paginationScript(lang: Lang): string {
  const emptyText = lang === 'zh' ? '没有匹配的对话' : 'No matching conversations';
  return `
(() => {
  const root = document.querySelector('.conversation-index-app');
  const viewport = root?.querySelector('.conversation-list-viewport');
  const list = root?.querySelector('.conversation-list');
  const rows = [...(root?.querySelectorAll('.conversation-row') || [])];
  const viewButtons = [...(root?.querySelectorAll('[data-view-filter]') || [])];
  const search = root?.querySelector('[data-conversation-search]');
  const previous = root?.querySelector('[data-page-prev]');
  const next = root?.querySelector('[data-page-next]');
  const pageLabel = root?.querySelector('[data-page-label]');
  const pageRange = root?.querySelector('[data-page-range]');
  let viewFilter = 'all';
  let page = 0;
  let pageSize = 1;
  let visibleRows = rows;

  const computePageSize = () => {
    pageSize = Math.max(1, Math.floor((viewport?.clientHeight || 68) / 68));
    list?.style.setProperty('--page-size', String(pageSize));
  };

  const renderPage = () => {
    const query = (search?.value || '').trim().toLocaleLowerCase();
    visibleRows = rows.filter((row) => {
      const viewMatch = viewFilter === 'all'
        || (viewFilter === 'running' ? row.dataset.running === 'true' : row.dataset.state === viewFilter);
      const searchMatch = !query || (row.dataset.search || '').includes(query);
      return viewMatch && searchMatch;
    });
    const pageCount = Math.max(1, Math.ceil(visibleRows.length / pageSize));
    page = Math.min(page, pageCount - 1);
    const start = page * pageSize;
    const end = Math.min(start + pageSize, visibleRows.length);
    for (const row of rows) row.hidden = true;
    for (const row of visibleRows.slice(start, end)) row.hidden = false;
    if (pageLabel) pageLabel.textContent = (page + 1) + ' / ' + pageCount;
    if (pageRange) pageRange.textContent = visibleRows.length > 0
      ? (start + 1) + '–' + end + ' / ' + visibleRows.length
      : '${emptyText}';
    if (previous) previous.disabled = page === 0;
    if (next) next.disabled = page >= pageCount - 1;
  };

  for (const button of viewButtons) button.addEventListener('click', () => {
    viewFilter = button.dataset.viewFilter || 'all';
    page = 0;
    for (const item of viewButtons) {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    }
    renderPage();
  });
  search?.addEventListener('input', () => {
    page = 0;
    renderPage();
  });
  previous?.addEventListener('click', () => {
    page = Math.max(0, page - 1);
    renderPage();
  });
  next?.addEventListener('click', () => {
    page += 1;
    renderPage();
  });
  root?.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === 'ArrowLeft' && !previous?.disabled) previous?.click();
    if (event.key === 'ArrowRight' && !next?.disabled) next?.click();
  });

  const resizeObserver = new ResizeObserver(() => {
    computePageSize();
    renderPage();
  });
  if (viewport) resizeObserver.observe(viewport);
  computePageSize();
  renderPage();
})();`;
}

const CSS = `
.conversation-page{width:min(1240px,calc(100% - 48px));margin:0 auto;padding:34px 0 64px}
.conversation-page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:22px}
.conversation-page-head h1{font-size:28px;line-height:1.25;margin:5px 0 8px;letter-spacing:0}.conversation-page-head p:last-child{max-width:820px;color:var(--text-secondary)}
.conversation-eyebrow{font:700 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent);letter-spacing:0}.secondary-link,.back-link,.trajectory-link{color:var(--accent);text-decoration:none;font-weight:650}.secondary-link{padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);white-space:nowrap}.back-link{display:inline-block;margin-bottom:12px;font-size:13px}
.task-list{border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);overflow:hidden}
.conversation-row{position:relative;display:grid;grid-template-columns:132px minmax(320px,1.35fr) minmax(210px,.8fr) 136px 24px;gap:20px;align-items:center;padding:8px 22px;color:inherit;border-bottom:1px solid var(--border);transition:background .14s,color .14s}.conversation-row:last-child{border-bottom:0}.conversation-row:hover{background:#f9faff}.conversation-row:has(.conversation-row-detail:focus-visible){z-index:1;outline:2px solid rgba(79,70,229,.46);outline-offset:-2px}.conversation-row[hidden]{display:none}.conversation-row-detail{position:absolute;inset:0;z-index:1}.conversation-row-detail:focus-visible{outline:0}.conversation-row>*:not(.conversation-row-detail){position:relative;z-index:2;pointer-events:none}
.conversation-activity{display:flex;flex-direction:column;min-width:0}.conversation-activity strong{font-size:12px;font-weight:650;white-space:nowrap}.conversation-activity span{color:var(--text-muted);font:500 11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.running-label{display:flex;align-items:center;gap:6px;color:var(--accent)}.running-label i,.live-task-link i{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px rgba(79,70,229,.1)}
.conversation-main{min-width:0}.conversation-title{display:block;font-size:14px;font-weight:650;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0}.conversation-main:has(.conversation-context) .conversation-title{margin-bottom:4px}.conversation-title code,.task-title code{padding:1px 3px;border-radius:3px;background:var(--bg-elevated);font:600 .92em ui-monospace,SFMono-Regular,Menlo,monospace}.inline-markdown-link{color:var(--accent);text-decoration:underline;text-decoration-color:rgba(79,70,229,.28);text-underline-offset:3px}.inline-markdown-link:hover{text-decoration-color:currentColor}.conversation-meta,.conversation-context,.detail-meta{display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:11px;min-width:0}.conversation-meta span+span:before,.conversation-context span+span:before,.detail-meta span+span:before{content:'·';margin-right:8px}.source-mark{color:var(--accent);font-weight:700}.conversation-workspace{min-width:0;color:var(--text-secondary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conversation-counts{display:flex;flex-direction:column;justify-content:center;align-items:flex-end;gap:2px;color:var(--text-secondary);font-size:11px;white-space:nowrap}.conversation-counts span{display:flex;gap:4px;align-items:baseline}.conversation-counts b{font-size:14px;color:var(--text-primary);font-variant-numeric:tabular-nums}.live-task-link{z-index:3!important;display:flex;align-items:center;gap:6px;color:var(--accent);font-weight:650;text-decoration:none;pointer-events:auto!important}.live-task-link:hover{text-decoration:underline}.failure-count{color:var(--red)!important}.index-pending{color:var(--text-muted)}.row-arrow{display:flex;align-items:center;justify-content:center;color:var(--text-faint);transition:color .14s,transform .14s}.conversation-row:hover .row-arrow{color:var(--accent);transform:translateX(2px)}.empty-state{display:flex;flex-direction:column;gap:4px;padding:36px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);color:var(--text-secondary)}.empty-state strong{color:var(--text-primary)}
.conversation-detail-head{align-items:flex-start}.conversation-detail-head h1{max-width:920px;font-size:24px}.detail-meta{margin-top:10px}.task-list-head,.task-row{display:grid;grid-template-columns:minmax(0,1fr) 140px 160px 150px;gap:18px;align-items:center}.task-list-head{padding:10px 22px 10px 72px;color:var(--text-muted);font-size:12px;background:var(--bg-elevated);border-bottom:1px solid var(--border)}.task-row{position:relative;padding:17px 22px 17px 72px;border-bottom:1px solid var(--border)}.task-row.is-running{background:rgba(79,70,229,.035);box-shadow:inset 3px 0 0 var(--accent)}.task-row:last-child{border-bottom:0}.task-index{position:absolute;left:22px;top:19px;font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-muted)}.task-row.is-running .task-index{color:var(--accent)}.task-main{min-width:0}.task-title{display:block;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:6px}.task-context{color:var(--text-muted);font-size:12px}.task-time,.task-execution{display:flex;flex-direction:column;gap:3px}.task-time small,.task-execution small{color:var(--text-muted)}.task-status{font-weight:650}.status-aborted,.status-interrupted{color:var(--red)}.status-open{color:var(--accent)}.status-unknown{color:var(--yellow)}.status-completed{color:var(--green)}.trajectory-link{text-align:right;font-size:13px;white-space:nowrap}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

html:has(.conversation-index-app),body:has(.conversation-index-app){height:100%;overflow:hidden;scrollbar-gutter:auto}
body:has(.conversation-index-app) .app-bar{display:none}
body:has(.conversation-index-app) .app-main{width:100%;max-width:none;height:100dvh;margin:0;padding:0}
body:has(.conversation-index-app) .footer{display:none}
.conversation-index-app{width:100%;height:100%;margin:0;padding:0;display:grid;grid-template-rows:54px minmax(0,1fr);background:var(--bg-surface);overflow:hidden}
.conversation-app-head{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;min-width:0;border-bottom:1px solid var(--border);background:rgba(255,255,255,.94)}
.conversation-app-brand{height:100%;display:flex;align-items:center;gap:8px;padding:0 22px;color:var(--text-primary);text-decoration:none}.conversation-app-brand:hover{color:var(--text-primary);text-decoration:none}.conversation-app-brand>span{display:flex}.conversation-app-brand strong{font-size:14px;letter-spacing:.01em}.conversation-app-brand em{padding:1px 7px;border:1px solid var(--border);border-radius:4px;color:var(--text-muted);font-size:10px;font-style:normal;font-weight:650;letter-spacing:.03em}
.conversation-app-nav{height:100%;display:flex;align-items:center;gap:2px;padding-left:16px}.conversation-app-nav a{height:100%;display:flex;align-items:center;padding:0 14px;border-bottom:2px solid transparent;color:var(--text-secondary);font-size:13px;font-weight:600;text-decoration:none}.conversation-app-nav a:hover{color:var(--text-primary);text-decoration:none}.conversation-app-nav a.is-active{border-bottom-color:var(--accent);color:var(--text-primary)}
.conversation-app-body{display:block;min-width:0;min-height:0}
.conversation-browser{height:100%;display:grid;grid-template-rows:62px 32px minmax(0,1fr) 42px;min-width:0;min-height:0;background:var(--bg-surface)}.conversation-toolbar{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:0 22px;margin:0}.conversation-browser-title h1{font-size:18px;line-height:1.2;margin:0;font-weight:650;letter-spacing:0}.conversation-toolbar-actions{display:flex;align-items:center;gap:12px;min-width:0}.conversation-filters{display:flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--border);border-radius:6px;background:var(--bg-elevated)}.conversation-filters button{height:28px;padding:0 9px;border:0;border-radius:4px;background:transparent;color:var(--text-secondary);display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}.conversation-filters button:hover{color:var(--text-primary)}.conversation-filters button.is-active{background:var(--bg-surface);color:var(--text-primary);box-shadow:0 1px 3px rgba(31,41,55,.08)}.conversation-filters b{color:var(--text-muted);font-size:10px;font-variant-numeric:tabular-nums}.conversation-filters button:disabled{cursor:default;opacity:.46}.conversation-search{position:relative;width:min(340px,34vw);color:var(--text-muted)}.conversation-search>svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);pointer-events:none}.conversation-search input{display:block;width:100%;height:34px;padding:0 11px 0 34px;border:1px solid var(--border);border-radius:6px;background:var(--bg-elevated);color:var(--text-primary);font:inherit;outline:none}.conversation-search input:focus{border-color:rgba(79,70,229,.48);box-shadow:0 0 0 3px rgba(79,70,229,.07);background:var(--bg-surface)}
.conversation-columns{display:grid;grid-template-columns:132px minmax(320px,1.35fr) minmax(210px,.8fr) 136px 24px;gap:20px;align-items:center;padding:0 22px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:#fafbfe;color:var(--text-muted);font-size:10px;font-weight:650;letter-spacing:.03em}.conversation-list-viewport{min-height:0;overflow:hidden}.conversation-list{height:100%;display:grid;grid-template-rows:repeat(var(--page-size,8),minmax(0,1fr));background:var(--bg-surface);overflow:hidden}.conversation-list-viewport>.empty-state{height:100%;justify-content:center;border:0;border-radius:0;text-align:center}.conversation-pager{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 22px;border-top:1px solid var(--border);background:#fafbfe;color:var(--text-muted);font-size:11px;font-variant-numeric:tabular-nums}.pager-controls{display:flex;align-items:center;gap:8px}.pager-controls>span{min-width:54px;text-align:center;color:var(--text-secondary)}.pager-controls button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid var(--border);border-radius:5px;background:var(--bg-surface);color:var(--text-secondary);font-size:15px;line-height:1}.pager-controls button:hover:not(:disabled){border-color:var(--border-hover);color:var(--accent)}.pager-controls button:disabled{cursor:default;opacity:.3}
@media(max-width:1100px){.conversation-row,.conversation-columns{grid-template-columns:118px minmax(260px,1fr) 124px 24px}.conversation-workspace,.conversation-columns span:nth-child(3){display:none}.conversation-app-brand{padding-left:16px}.conversation-search{width:min(300px,32vw)}}
@media(max-width:820px){.conversation-row,.conversation-columns{grid-template-columns:102px minmax(0,1fr) 112px 20px;gap:12px}.conversation-toolbar-actions{gap:8px}.conversation-filters b{display:none}.conversation-search{width:min(260px,34vw)}}
@media(max-width:720px){.conversation-page:not(.conversation-index-app){width:calc(100% - 24px);padding-top:24px}.conversation-index-app{grid-template-rows:50px minmax(0,1fr)}.conversation-app-brand{padding:0 12px}.conversation-app-brand strong{display:none}.conversation-app-nav{padding-left:2px}.conversation-app-nav a{padding:0 9px}.conversation-browser{grid-template-rows:82px 28px minmax(0,1fr) 40px}.conversation-toolbar{align-items:flex-start;gap:8px;padding:12px}.conversation-browser-title h1{font-size:16px}.conversation-toolbar-actions{align-items:flex-end;flex-direction:column-reverse;gap:6px}.conversation-filters button{height:24px;padding:0 7px}.conversation-search{width:min(250px,66vw)}.conversation-search input{height:30px}.conversation-columns,.conversation-row{grid-template-columns:86px minmax(0,1fr) 20px;gap:10px;padding-left:12px;padding-right:12px}.conversation-activity span{display:none}.conversation-title{font-size:13px}.conversation-context span:nth-child(n+2){display:none}.task-list-head{display:none}.task-row{grid-template-columns:minmax(0,1fr) auto;padding-left:52px}.task-time,.task-execution{display:none}}
`;
