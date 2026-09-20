import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { projectTaskSemanticEvents } from '../../src/observability/conversation/task-semantic-projection.js';
import type { ExperienceTimelineEvent } from '../../src/observability/contracts/experience.js';

function timelineEvent(
  id: string,
  order: number,
  kind: ExperienceTimelineEvent['kind'],
  overrides: Partial<ExperienceTimelineEvent> = {},
): ExperienceTimelineEvent {
  return {
    id,
    kind,
    order,
    sourceTrace: '/trace.jsonl',
    traceId: 'trace-main',
    sessionId: 'session-1',
    messageIndex: order,
    ...overrides,
  };
}

describe('projectTaskSemanticEvents', () => {
  it('returns nothing for a non-positive limit or an empty task', () => {
    const events = [timelineEvent('user', 0, 'user_message', { role: 'user' })];
    assert.deepEqual(projectTaskSemanticEvents(events, 0), []);
    assert.deepEqual(projectTaskSemanticEvents(events, -3), []);
    assert.deepEqual(projectTaskSemanticEvents([], 10), []);
  });

  it('returns the task untouched when it already fits the limit', () => {
    const events = [
      timelineEvent('user', 0, 'user_message', { role: 'user' }),
      timelineEvent('assistant', 1, 'assistant_message', { role: 'assistant' }),
    ];
    assert.equal(projectTaskSemanticEvents(events, 2), events, '未截断时不复制、不重排');
    assert.equal(projectTaskSemanticEvents(events, 5), events);
  });

  it('keeps the projection a chronologically ordered subset within the limit', () => {
    const events = Array.from({ length: 12 }, (_, index) => timelineEvent(
      `event-${index}`,
      index,
      index === 0 ? 'user_message' : index === 11 ? 'assistant_message' : 'model_activity',
      {
        role: index === 0 ? 'user' : index === 11 ? 'assistant' : 'other',
        contentVisibility: index === 11 ? undefined : 'plaintext',
      },
    ));
    const projected = projectTaskSemanticEvents(events, 5);
    assert.ok(projected.length <= 5);
    const inputIds = new Set(events.map((event) => event.id));
    assert.ok(projected.every((event) => inputIds.has(event.id)), '投影只能挑选、不能编造事件');
    const orders = projected.map((event) => event.order);
    assert.deepEqual(orders, [...orders].sort((left, right) => left - right), '投影保持时间序');
    assert.equal(projected[0]?.id, 'event-0', '用户请求必须保留');
    assert.equal(projected.at(-1)?.id, 'event-11', '最终回答必须保留');
  });

  it('never separates a tool call from its correlated result', () => {
    const events = [
      timelineEvent('user', 0, 'user_message', { role: 'user' }),
      timelineEvent('call-1', 1, 'tool_use', { callInstanceId: 'c1', toolName: 'Bash' }),
      timelineEvent('result-1', 2, 'tool_result', { callInstanceId: 'c1', toolName: 'Bash' }),
      timelineEvent('call-2', 3, 'tool_use', { callInstanceId: 'c2', toolName: 'Bash' }),
      timelineEvent('result-2', 4, 'tool_result', { callInstanceId: 'c2', toolName: 'Bash' }),
      timelineEvent('assistant', 5, 'assistant_message', { role: 'assistant' }),
    ];
    for (let limit = 2; limit <= 5; limit += 1) {
      const projected = projectTaskSemanticEvents(events, limit);
      const ids = new Set(projected.map((event) => event.id));
      assert.equal(ids.has('call-1'), ids.has('result-1'), `limit=${limit}: call-1 与 result-1 不得拆开`);
      assert.equal(ids.has('call-2'), ids.has('result-2'), `limit=${limit}: call-2 与 result-2 不得拆开`);
      assert.ok(ids.has('user') && ids.has('assistant'), `limit=${limit}: 端点必须保留`);
    }
  });

  it('retains a failed tool result even when its call is missing from the window', () => {
    const events = [
      timelineEvent('user', 0, 'user_message', { role: 'user' }),
      ...Array.from({ length: 6 }, (_, index) => timelineEvent(
        `pad-${index}`, index + 1, 'model_activity', { role: 'other', contentVisibility: 'plaintext' },
      )),
      timelineEvent('orphan-failure', 7, 'tool_result', { toolStatus: 'failure', isError: true }),
      timelineEvent('assistant', 8, 'assistant_message', { role: 'assistant' }),
    ];
    const projected = projectTaskSemanticEvents(events, 3);
    assert.deepEqual(projected.map((event) => event.id), ['user', 'orphan-failure', 'assistant']);
  });

  it('keeps an unmatched pending tool call only when preservePendingToolCalls is set', () => {
    const events = [
      timelineEvent('user', 0, 'user_message', { role: 'user' }),
      ...Array.from({ length: 5 }, (_, index) => timelineEvent(
        `heartbeat-${index}`, index + 1, 'lifecycle', { label: 'heartbeat' },
      )),
      timelineEvent('pending-call', 6, 'tool_use', { callInstanceId: 'c-pending', toolName: 'Bash' }),
      timelineEvent('assistant', 7, 'assistant_message', { role: 'assistant' }),
    ];
    const preserved = projectTaskSemanticEvents(events, 3, { preservePendingToolCalls: true });
    assert.deepEqual(preserved.map((event) => event.id), ['user', 'pending-call', 'assistant']);

    const relaxed = projectTaskSemanticEvents(events, 3);
    assert.ok(!relaxed.some((event) => event.id === 'pending-call'),
      '未声明保留时，未决调用与其它普通事件公平竞争容量');
    assert.ok(relaxed.some((event) => event.id === 'user'));
    assert.ok(relaxed.some((event) => event.id === 'assistant'));
  });

  it('drops usage-only runtime context before any narrative event', () => {
    const events = [
      timelineEvent('user', 0, 'user_message', { role: 'user' }),
      timelineEvent('usage', 1, 'runtime_context', { runtimeKind: 'usage' }),
      timelineEvent('assistant', 2, 'assistant_message', { role: 'assistant' }),
    ];
    const projected = projectTaskSemanticEvents(events, 2);
    assert.deepEqual(projected.map((event) => event.id), ['user', 'assistant']);
  });
});
