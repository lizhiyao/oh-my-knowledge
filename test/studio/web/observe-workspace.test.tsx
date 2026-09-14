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
  expect(html).toContain('/observe/conversations/thread%2Fa?lang=zh');
  expect(html).not.toContain('查看最近轨迹');
});

it('opens a reader with in-place extraction and retains project navigation', () => {
  const html = renderToStaticMarkup(createElement(ObserveWorkspace, { lang: 'zh', page: { pageKind: 'conversation', model: item, navigation: index, revision: 'test' } }));
  expect(html).toContain('对话内容'); expect(html).toContain('正在读取对话');
  expect(html).toContain('提炼知识'); expect(html).toContain('已提炼知识');
  expect(html).toContain('Example project'); expect(html).not.toContain('<table');
});
