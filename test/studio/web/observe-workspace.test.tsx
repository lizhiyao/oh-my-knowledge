import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ObserveWorkspace } from '../../../src/studio/web/components/observe/workspace.js';
import type { ConversationListItem } from '../../../src/observability/view-models/conversation.js';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));
const item: ConversationListItem = {
  threadId: 'thread/a', sourceThreadId: 'thread/a', sourceKind: 'codex',
  title: '[https://github.com/example/repo/issues/375](https://github.com/example/repo/issues/375) <script>bad</script>',
  project: { projectId: 'project', name: 'Example project', directory: '/example/project' },
  relatedSkillNames: [], tasks: [],
};
const index = { conversations: [item], totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 };

it('presents projects and readable conversation links without raw Markdown or task-table navigation', () => {
  const html = renderToStaticMarkup(createElement(ObserveWorkspace, { lang: 'zh', page: { pageKind: 'index', model: index, revision: 'test' } }));
  expect(html).toContain('项目与对话'); expect(html).toContain('Example project');
  expect(html).toContain('Issue #375'); expect(html).not.toContain('[https://');
  expect(html).not.toContain('<script>bad'); expect(html).toContain('&lt;script&gt;bad');
  // 语言不进地址：站内深链一律不带 lang，渲染语言由本机设置决定。
  expect(html).toContain('/observe/conversations/thread%2Fa"');
  expect(html).not.toContain('查看最近轨迹');
  expect(html).toContain('aria-label="独立对话"');
  expect(html).toContain('aria-label="项目"');
  expect(html).toContain('查看全部对话');
  const sidebar = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
  expect(sidebar).toContain('设置与帮助');
  expect(sidebar).toContain('observe-sidebar-scroll');
  expect(html).not.toContain('Skill 健康度');
  expect(html).not.toContain('本地工作区');
});

it('opens a reader with in-place extraction and retains project navigation', () => {
  const html = renderToStaticMarkup(createElement(ObserveWorkspace, { lang: 'zh', page: { pageKind: 'conversation', model: item, navigation: index, revision: 'test' } }));
  expect(html).toContain('对话内容'); expect(html).toContain('正在读取对话');
  expect(html).toContain('提炼知识'); expect(html).toContain('已提炼知识');
  expect(html).toContain('Example project'); expect(html).not.toContain('<table');
  expect(html).not.toContain('ant-pagination');
  expect(html).not.toContain('最近轮次优先');
  expect(html).not.toContain('href="/agents"');
  expect(sidebarOf(html)).toContain('aria-current="page"');
  const header = html.slice(html.indexOf('class="observe-reader-header"'), html.indexOf('class="observe-conversation-reader"'));
  expect(header.indexOf('<h1')).toBeLessThan(header.indexOf('Example project'));
  expect(header).toContain('observe-reader-meta');
});


it('工具报错计数带自己的强调类，与同层的来源标注区分开', () => {
  const failed = { ...item, toolFailureCount: 3 };
  const html = renderToStaticMarkup(createElement(ObserveWorkspace, { lang: 'zh', page: { pageKind: 'index', model: { ...index, conversations: [failed] }, revision: 'test' } }));
  expect(html).toContain('<small class="observe-session-error" title="曾发生工具报错，不代表最终工作失败。">3 次工具报错</small>');
});


it('separates standalone conversations from project conversations while keeping all in the overview', () => {
  const standalone = { ...item, threadId: 'standalone', title: 'Standalone example', project: undefined };
  const directory = { ...item, threadId: 'directory', title: 'Directory example', project: undefined, cwd: '/example/directory' };
  for (const lang of ['zh', 'en'] as const) {
    const html = renderToStaticMarkup(createElement(ObserveWorkspace, { lang, page: { pageKind: 'index', model: { ...index, conversations: [item, directory, standalone] }, revision: 'test' } }));
    const sidebar = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
    const projects = sidebar.slice(sidebar.indexOf('class="observe-projects"'), sidebar.indexOf('<section'));
    const independent = sidebar.slice(sidebar.indexOf('<section'), sidebar.indexOf('</section>'));
    expect(projects).not.toContain('Standalone example');
    expect(projects).toContain('Directory example');
    expect(independent).toContain('Standalone example');
    expect(independent).not.toContain('Directory example');
    expect(independent).not.toContain('Issue #375');
    expect(sidebar.match(/href="\/observe\/conversations\/thread%2Fa/g)).toHaveLength(1);
    const overview = html.slice(html.indexOf('class="observe-workspace-main"'));
    for (const title of ['Standalone example', 'Directory example', 'Issue #375']) expect(overview).toContain(title);
  }
});

const conversation = (threadId: string, extra: Partial<ConversationListItem> = {}): ConversationListItem => ({
  threadId, sourceThreadId: threadId, sourceKind: 'codex', title: threadId, relatedSkillNames: [], tasks: [], ...extra,
});
const renderIndex = (conversations: ConversationListItem[], lang: 'zh' | 'en' = 'zh'): string => renderToStaticMarkup(createElement(ObserveWorkspace, {
  lang,
  page: { pageKind: 'index', model: { conversations, totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 }, revision: 'test' },
}));
const sidebarOf = (html: string): string => html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));

it('长标题与长路径单行省略后，完整内容仍可通过提示取得', () => {
  const longTitle = 'A'.repeat(120);
  const name = 'N'.repeat(80);
  const longModel = 'M'.repeat(60);
  const html = renderIndex([conversation('thread/long', {
    title: longTitle,
    model: longModel,
    project: { projectId: 'p', name, directory: '/very/long/project/directory' },
    cwd: '/very/long/working/directory',
    tasks: [{ title: 'latest request text' } as ConversationListItem['tasks'][number]],
  })]);
  expect(html).toContain(`<strong title="${longTitle}">`);
  expect(html).toContain('<p title="latest request text">最近请求：latest request text</p>');
  expect(html).toContain('<small title="/very/long/working/directory">');
  // 项目名的提示同时给出完整名称与完整目录：只给目录时，被省略掉的名称就没有别的读法。
  const summary = html.slice(html.indexOf('<summary'), html.indexOf('</summary>'));
  expect(summary).toContain(`title="${name}\n/very/long/project/directory"`);
  expect(summary).toContain('<span title="1 个对话">1</span>');
  // 侧栏会话的归档／来源小字与列表页同类小字同一口径：单行省略，完整值走提示。
  expect(sidebarOf(html)).toContain(`<small title="${longModel}">${longModel}</small>`);
});

it('独立对话超出侧栏视野时给出可达入口，不静默丢掉较早的对话', () => {
  const conversations = Array.from({ length: 18 }, (_, index) => conversation(`solo-${index}`, { title: `独立 ${index}` }));
  const sidebar = sidebarOf(renderIndex(conversations));
  expect(sidebar).toContain('还有 3 个独立对话，在全部对话中查看');
  expect(sidebar.match(/observe-session-link/g)).toHaveLength(15);
  expect(sidebarOf(renderIndex(conversations, 'en'))).toContain('3 more standalone conversations in All conversations');
});

it('项目超出侧栏视野时保留展开入口，较早的项目不会彻底失联', () => {
  const conversations = Array.from({ length: 8 }, (_, index) => conversation(`t-${index}`, {
    title: `会话 ${index}`, project: { projectId: `p-${index}`, name: `项目 ${index}`, directory: `/p/${index}` },
  }));
  const sidebar = sidebarOf(renderIndex(conversations));
  expect(sidebar).toContain('查看全部项目');
  expect(sidebar).toContain('项目 5');
  expect(sidebar).not.toContain('项目 6');
});

it('项目内会话超出视野时给出该项目全部会话的入口', () => {
  const conversations = Array.from({ length: 13 }, (_, index) => conversation(`t-${index}`, {
    title: `会话 ${index}`, project: { projectId: 'p', name: '同一个项目', directory: '/p' },
  }));
  expect(sidebarOf(renderIndex(conversations))).toContain('查看全部 13 个对话');
});

it('完全没有记录时说明记录从哪里来，而不是只说一句暂无', () => {
  const html = renderIndex([]);
  expect(html).toContain('暂无对话记录。了解如何接入本机 Agent 的会话，或检查日志采集情况。');
  expect(html).toMatch(/href="\/agents#connection-guide">如何接入会话<\/a>/);
  expect(sidebarOf(html)).toContain('有项目归属的对话显示在上方项目下。');
  expect(sidebarOf(html)).toContain('>暂无</span>');
});

it('进行中的入口与标题使用同一个名字', () => {
  const html = renderIndex([item]);
  expect(html).toContain('进行中的对话');
  expect(html).not.toContain('进行中的会话');
});

it('来源与采集只在列表提供辅助入口，侧栏无常驻二级导航', () => {
  const html = renderIndex([item]);
  expect(html).toMatch(/href="\/agents">来源与采集<\/a>/);
  expect(sidebarOf(html)).not.toContain('href="/agents"');
});
