import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  renderConversationDetailPage,
  renderConversationIndexPage,
} from '../../src/renderer/conversation-renderer.js';
import type {
  ConversationIndexViewModel,
  ConversationListItem,
  ExperienceTurnStatus,
} from '../../src/types/index.js';

function conversation(
  threadId: string,
  title: string,
  status: ExperienceTurnStatus,
): ConversationListItem {
  return {
    threadId,
    sourceThreadId: threadId,
    sourceKind: 'codex',
    title,
    model: 'gpt-test',
    archived: false,
    endTimestamp: status === 'open' ? '2026-08-06T10:01:00.000Z' : '2026-08-06T10:02:00.000Z',
    turnCount: 1,
    toolCallCount: 0,
    toolFailureCount: 0,
    relatedSkillNames: [],
    tasks: [{
      turnId: `${threadId}-turn`,
      trajectoryHref: `/conversations/${threadId}/tasks/${threadId}-turn`,
      title,
      status,
      eventCount: 2,
      toolCallCount: 0,
      toolFailureCount: 0,
      relatedSkillNames: [],
    }],
  };
}

describe('conversation overview renderer', () => {
  it('surfaces running conversations and links directly to their live trajectory', () => {
    const completed = conversation('completed-thread', '已完成对话', 'completed');
    const running = conversation('running-thread', '进行中对话', 'open');
    const model: ConversationIndexViewModel = {
      conversations: [completed, running],
      totalTurnCount: 2,
      totalToolCallCount: 0,
      totalToolFailureCount: 0,
      unarchivedConversationCount: 2,
      archivedConversationCount: 0,
    };

    const html = renderConversationIndexPage(model, 'zh');

    assert.ok(html.includes('data-view-filter="running"'));
    assert.match(html, /data-activity-revision="[a-f0-9]{24}"/u);
    assert.ok(html.includes("fetch('/api/conversations/activity'"));
    assert.ok(html.includes('data-running="true"'));
    assert.ok(html.includes('查看实时轨迹'));
    assert.ok(html.includes('href="/conversations/running-thread/tasks/running-thread-turn"'));
    assert.ok(html.indexOf('进行中对话') < html.indexOf('已完成对话'));
    assert.ok(!html.includes('<a class="conversation-row"'));
  });

  it('renders conversation link syntax as readable inline content', () => {
    const linked = conversation(
      'linked-thread',
      '[GitHub issue](https://github.com/example/repo/issues/1)',
      'completed',
    );
    const html = renderConversationIndexPage({
      conversations: [linked],
      totalTurnCount: 1,
      totalToolCallCount: 0,
      totalToolFailureCount: 0,
    }, 'zh');

    assert.ok(html.includes('<div class="conversation-title">GitHub issue</div>'));
    assert.ok(!html.includes('[GitHub issue]'));
  });

  it('does not count tasks with an unrecorded end state as running', () => {
    const unknown = conversation('unknown-thread', '未记录结束的对话', 'unknown');
    const html = renderConversationIndexPage({
      conversations: [unknown],
      totalTurnCount: 1,
      totalToolCallCount: 0,
      totalToolFailureCount: 0,
    }, 'zh');

    assert.ok(!html.includes('data-view-filter="running"'));
    assert.ok(html.includes('data-running="false"'));
    assert.ok(!html.includes('查看实时轨迹'));
  });
});

describe('conversation detail renderer', () => {
  it('surfaces open tasks first while preserving their chronological ordinals', () => {
    const model = conversation('thread', '对话', 'completed');
    const firstTask = { ...model.tasks[0], turnId: 'first', title: '最早任务' };
    const runningTask = {
      ...model.tasks[0],
      turnId: 'running',
      title: '当前任务',
      status: 'open' as const,
    };
    const latestTask = { ...model.tasks[0], turnId: 'latest', title: '最近历史任务' };
    model.tasks = [firstTask, runningTask, latestTask];
    model.turnCount = model.tasks.length;

    const html = renderConversationDetailPage(model, 'zh');

    assert.ok(html.indexOf('当前任务') < html.indexOf('最早任务'));
    assert.ok(html.indexOf('最早任务') < html.indexOf('最近历史任务'));
    assert.ok(html.includes('class="task-row is-running" data-task-status="open"'));
    assert.ok(html.includes('<div class="task-index">02</div>'));
  });

  it('describes unknown terminal evidence without implying the task is still running', () => {
    const model = conversation('thread', '对话', 'unknown');

    const html = renderConversationDetailPage(model, 'zh');

    assert.ok(html.includes('未记录结束状态'));
    assert.ok(html.includes('data-task-status="unknown"'));
    assert.ok(!html.includes('class="task-row is-running"'));
  });
});
