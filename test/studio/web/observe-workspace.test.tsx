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
  expect(html).toContain('项目与会话'); expect(html).toContain('Example project');
  expect(html).toContain('Issue #375'); expect(html).not.toContain('[https://');
  expect(html).not.toContain('<script>bad'); expect(html).toContain('&lt;script&gt;bad');
  // 静态链接显式带当前语言：裸地址的语言由本机全局设置决定，省略参数等于把本次选择交回偏好。
  expect(html).toContain('/observe/conversations/thread%2Fa?lang=zh"');
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
