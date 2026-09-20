import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { reconstructExperienceTurns } from '../../src/observability/conversation/turn-index.js';
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

describe('reconstructExperienceTurns turn summaries', () => {
  it('maps terminal lifecycle labels to user-visible turn status', () => {
    const cases: Array<[string, string]> = [
      ['turn_completed', 'completed'],
      ['turn_failed', 'failed'],
      ['turn_aborted', 'aborted'],
      ['turn_interrupted', 'interrupted'],
    ];
    for (const [label, expected] of cases) {
      const events = [
        timelineEvent(`${label}-start`, 1, 'lifecycle', { turnId: `t-${label}`, label: 'turn_started' }),
        timelineEvent(`${label}-end`, 2, 'lifecycle', { turnId: `t-${label}`, label }),
      ];
      const [turn] = reconstructExperienceTurns(events);
      assert.equal(turn?.status, expected, label);
    }
  });

  it('keeps an unknown-ended turn open while a turn without any start stays unknown', () => {
    const startedThenUnknown = reconstructExperienceTurns([
      timelineEvent('start', 1, 'lifecycle', { turnId: 't-eu', label: 'turn_started' }),
      timelineEvent('end', 2, 'lifecycle', { turnId: 't-eu', label: 'turn_ended_unknown' }),
    ]);
    assert.equal(startedThenUnknown[0]?.status, 'open',
      'turn_ended_unknown 不冒充失败：已开始、结局未知的任务仍是 open');

    const unknownOnly = reconstructExperienceTurns([
      timelineEvent('end', 1, 'lifecycle', { turnId: 't-eu-only', label: 'turn_ended_unknown' }),
    ]);
    assert.equal(unknownOnly[0]?.status, 'unknown');
  });

  it('marks a turn open when it started but never terminated', () => {
    const events = [
      timelineEvent('start', 1, 'lifecycle', { turnId: 't-open', label: 'turn_started' }),
      timelineEvent('user', 2, 'user_message', { turnId: 't-open', role: 'user' }),
    ];
    const [turn] = reconstructExperienceTurns(events);
    assert.equal(turn?.status, 'open');
  });

  it('prefers completed over failed when a trace carries contradictory terminal labels', () => {
    const events = [
      timelineEvent('start', 1, 'lifecycle', { turnId: 't-mixed', label: 'turn_started' }),
      timelineEvent('failed', 2, 'lifecycle', { turnId: 't-mixed', label: 'turn_failed' }),
      timelineEvent('completed', 3, 'lifecycle', { turnId: 't-mixed', label: 'turn_completed' }),
    ];
    const [turn] = reconstructExperienceTurns(events);
    assert.equal(turn?.status, 'completed');
  });

  it('counts human messages, assistant messages, tool calls and tool failures separately', () => {
    const events = [
      timelineEvent('user', 1, 'user_message', { turnId: 't-count', role: 'user' }),
      timelineEvent('tool-role-user', 2, 'user_message', { turnId: 't-count', role: 'tool' }),
      timelineEvent('assistant', 3, 'assistant_message', { turnId: 't-count', role: 'assistant' }),
      timelineEvent('call-ok', 4, 'tool_use', { turnId: 't-count', toolUseId: 'c1' }),
      timelineEvent('result-ok', 5, 'tool_result', { turnId: 't-count', toolUseId: 'c1', toolStatus: 'success' }),
      timelineEvent('call-fail', 6, 'tool_use', { turnId: 't-count', toolUseId: 'c2' }),
      timelineEvent('result-fail', 7, 'tool_result', { turnId: 't-count', toolUseId: 'c2', toolStatus: 'failure' }),
      timelineEvent('result-error', 8, 'tool_result', { turnId: 't-count', toolUseId: 'c3', isError: true }),
    ];
    const [turn] = reconstructExperienceTurns(events);
    assert.equal(turn?.userMessageCount, 1, 'role=tool 的 user_message 不算人类消息');
    assert.equal(turn?.assistantMessageCount, 1);
    assert.equal(turn?.toolCallCount, 2);
    assert.equal(turn?.toolFailureCount, 2, 'toolStatus=failure 与 isError 都计失败');
  });

  it('derives a deterministic synthetic turn id independent of input ordering', () => {
    const events = [
      timelineEvent('user', 1, 'user_message', { role: 'user' }),
      timelineEvent('assistant', 2, 'assistant_message', { role: 'assistant' }),
    ];
    const [forward] = reconstructExperienceTurns(events);
    const [reversed] = reconstructExperienceTurns([...events].reverse());
    assert.ok(forward?.turnId.startsWith('turn:'));
    assert.equal(forward?.turnId, reversed?.turnId, '同一任务窗口的稳定 id 不随输入顺序漂移');
    assert.equal(forward?.sourceTurnId, undefined);
  });

  it('uses the first and last timestamped events as the task time range', () => {
    const events = [
      timelineEvent('untimed-head', 1, 'lifecycle', { turnId: 't-time', label: 'turn_started' }),
      timelineEvent('user', 2, 'user_message', {
        turnId: 't-time', role: 'user', timestamp: '2026-08-06T00:00:01.000Z',
      }),
      timelineEvent('assistant', 3, 'assistant_message', {
        turnId: 't-time', role: 'assistant', timestamp: '2026-08-06T00:00:05.000Z',
      }),
      timelineEvent('untimed-tail', 4, 'lifecycle', { turnId: 't-time', label: 'turn_completed' }),
    ];
    const [turn] = reconstructExperienceTurns(events);
    assert.equal(turn?.startTimestamp, '2026-08-06T00:00:01.000Z');
    assert.equal(turn?.endTimestamp, '2026-08-06T00:00:05.000Z');
  });

  it('falls back to the assistant text and then to 未命名任务 for the task title', () => {
    const assistantOnly = reconstructExperienceTurns([
      timelineEvent('user', 1, 'user_message', { turnId: 't-title', role: 'user' }),
      timelineEvent('assistant', 2, 'assistant_message', {
        turnId: 't-title', role: 'assistant', fullText: '回答正文',
      }),
    ]);
    assert.equal(assistantOnly[0]?.title, '回答正文', '用户消息无可用文本时退回助手文本');

    const noText = reconstructExperienceTurns([
      timelineEvent('tool', 1, 'tool_use', { turnId: 't-quiet' }),
    ]);
    assert.equal(noText[0]?.title, '未命名任务');
  });

  it('keeps the same source turn id on different traces as two separate tasks', () => {
    const events = [
      timelineEvent('a-user', 1, 'user_message', {
        traceId: 'trace-a', sourceTrace: '/a.jsonl', turnId: 'shared', role: 'user',
        timestamp: '2026-08-06T00:00:00.000Z',
      }),
      timelineEvent('b-user', 2, 'user_message', {
        traceId: 'trace-b', sourceTrace: '/b.jsonl', turnId: 'shared', role: 'user',
        timestamp: '2026-08-06T00:00:01.000Z',
      }),
    ];
    const turns = reconstructExperienceTurns(events);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((turn) => turn.traceId).sort(), ['trace-a', 'trace-b']);
    for (const turn of turns) {
      assert.equal(turn.eventIds.length, 1, '同 turnId 的跨 trace 事件不得合并进同一任务');
    }
  });

  it('treats tool-role user messages as neither boundaries nor human messages', () => {
    const events = [
      timelineEvent('tool-role-user', 1, 'user_message', { role: 'tool' }),
      timelineEvent('assistant', 2, 'assistant_message', { role: 'assistant' }),
    ];
    assert.deepEqual(reconstructExperienceTurns(events), []);
  });
});
