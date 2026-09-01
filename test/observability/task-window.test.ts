import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  resolveTaskWindow,
} from '../../src/observability/conversation/task-window.js';
import { reconstructExperienceTurns } from '../../src/observability/conversation/turn-index.js';
import type {
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
} from '../../src/observability/contracts/experience.js';

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

function session(
  events: ExperienceTimelineEvent[],
  attributedEventIds: string[],
): ExperienceSessionSummary {
  return {
    threadId: 'thread-1',
    sourceThreadId: 'session-1',
    attributedEventIds,
    turns: reconstructExperienceTurns(events),
    fullSessionTimeline: events,
    timelinePreview: events.slice(0, 240),
    timelinePreviewEventIds: events.slice(0, 240).map((event) => event.id),
    timelineScope: {
      mode: 'skill_segment_window',
      segmentEventCount: attributedEventIds.length,
      previewEventCount: Math.min(240, attributedEventIds.length),
      fullSessionEventCount: events.length,
      segmentRecordRanges: [],
      previewRecordRanges: [],
      sessionRecordRanges: [],
      truncated: events.length > 240,
      omittedBeforeCount: 0,
      omittedAfterCount: 0,
    },
  } as unknown as ExperienceSessionSummary;
}

describe('source-neutral task window', () => {
  it('selects one explicit turn by turnId without consulting Skill attribution', () => {
    const events = [
      timelineEvent('old-start', 1, 'lifecycle', { turnId: 'turn-old', label: 'turn_started' }),
      timelineEvent('old-user', 2, 'user_message', { turnId: 'turn-old', role: 'user' }),
      timelineEvent('old-end', 3, 'lifecycle', { turnId: 'turn-old', label: 'turn_completed' }),
      timelineEvent('current-start', 4, 'lifecycle', { turnId: 'turn-current', label: 'turn_started' }),
      timelineEvent('current-user', 5, 'user_message', { turnId: 'turn-current', role: 'user' }),
      timelineEvent('current-tool', 6, 'tool_use', { turnId: 'turn-current', toolUseId: 'call-1' }),
      timelineEvent('current-result', 7, 'tool_result', { turnId: 'turn-current', toolUseId: 'call-1' }),
      timelineEvent('current-end', 8, 'lifecycle', { turnId: 'turn-current', label: 'turn_completed' }),
      timelineEvent('next-settings', 9, 'runtime_context', { runtimeKind: 'settings' }),
      timelineEvent('next-start', 10, 'lifecycle', { turnId: 'turn-next', label: 'turn_started' }),
    ];

    const resolved = resolveTaskWindow(
      session(events, ['old-user']),
      'turn-current',
    );

    assert.equal(resolved.scope.basis, 'turn_id');
    assert.equal(resolved.scope.turnId, 'turn-current');
    assert.deepEqual(resolved.events.map((event) => event.id), [
      'current-start',
      'current-user',
      'current-tool',
      'current-result',
      'current-end',
    ]);
  });

  it('associates only an explicit next-turn correction with the selected task', () => {
    const events = [
      timelineEvent('current-start', 1, 'lifecycle', { turnId: 'turn-current', label: 'turn_started' }),
      timelineEvent('current-user', 2, 'user_message', {
        turnId: 'turn-current', role: 'user', fullText: '先实现第一版。',
      }),
      timelineEvent('current-answer', 3, 'assistant_message', {
        turnId: 'turn-current', role: 'assistant', fullText: '已经完成。',
      }),
      timelineEvent('current-end', 4, 'lifecycle', { turnId: 'turn-current', label: 'turn_completed' }),
      timelineEvent('next-start', 5, 'lifecycle', { turnId: 'turn-next', label: 'turn_started' }),
      timelineEvent('next-user', 6, 'user_message', {
        turnId: 'turn-next', role: 'user', fullText: '不对，应该保留原来的交互。',
      }),
    ];

    const resolved = resolveTaskWindow(session(events, []), 'turn-current');

    assert.deepEqual(resolved.events.map((event) => event.id), [
      'current-start',
      'current-user',
      'current-answer',
      'current-end',
    ]);
    assert.deepEqual(resolved.relatedEvents.map((event) => event.id), ['next-user']);
  });

  it('does not treat an unrelated next task as correction evidence', () => {
    const events = [
      timelineEvent('current-user', 1, 'user_message', { role: 'user', fullText: '完成当前任务。' }),
      timelineEvent('current-answer', 2, 'assistant_message', { role: 'assistant', fullText: '已完成。' }),
      timelineEvent('next-user', 3, 'user_message', { role: 'user', fullText: '接下来看看文档。' }),
    ];
    const input = session(events, []);

    const resolved = resolveTaskWindow(input, input.turns[0]!.turnId);

    assert.deepEqual(resolved.relatedEvents, []);
  });

  it('does not treat broad correction keywords in a new task as follow-up evidence', () => {
    const events = [
      timelineEvent('current-user', 1, 'user_message', { role: 'user', fullText: '完成当前任务。' }),
      timelineEvent('current-answer', 2, 'assistant_message', { role: 'assistant', fullText: '已完成。' }),
      timelineEvent('next-user', 3, 'user_message', { role: 'user', fullText: '改成检查另一个模块。' }),
    ];
    const input = session(events, []);

    const resolved = resolveTaskWindow(input, input.turns[0]!.turnId);

    assert.deepEqual(resolved.relatedEvents, []);
  });

  it('finds follow-up corrections only on the selected task trace', () => {
    const events = [
      timelineEvent('a-current-user', 1, 'user_message', {
        traceId: 'trace-a', sourceTrace: '/a.jsonl', turnId: 'turn-a-current', role: 'user',
        timestamp: '2026-08-06T00:00:00.000Z', fullText: '完成 A。',
      }),
      timelineEvent('a-current-answer', 2, 'assistant_message', {
        traceId: 'trace-a', sourceTrace: '/a.jsonl', turnId: 'turn-a-current', role: 'assistant',
        timestamp: '2026-08-06T00:00:01.000Z', fullText: 'A 已完成。',
      }),
      timelineEvent('b-user', 3, 'user_message', {
        traceId: 'trace-b', sourceTrace: '/b.jsonl', turnId: 'turn-b', role: 'user',
        timestamp: '2026-08-06T00:00:02.000Z', fullText: '不对，B 应该重做。',
      }),
      timelineEvent('a-next-user', 4, 'user_message', {
        traceId: 'trace-a', sourceTrace: '/a.jsonl', turnId: 'turn-a-next', role: 'user',
        timestamp: '2026-08-06T00:00:03.000Z', fullText: '不对，A 应该保留原来的交互。',
      }),
    ];
    const input = session(events, []);

    const resolved = resolveTaskWindow(input, 'turn-a-current');

    assert.deepEqual(resolved.relatedEvents.map((event) => event.id), ['a-next-user']);
  });

  it('keeps interleaved traces out of each other task windows', () => {
    const events = [
      timelineEvent('a-start', 1, 'lifecycle', {
        traceId: 'trace-a', sourceTrace: '/a.jsonl', turnId: 'turn-a', label: 'turn_started',
        timestamp: '2026-08-06T00:00:00.000Z',
      }),
      timelineEvent('b-start', 1, 'lifecycle', {
        traceId: 'trace-b', sourceTrace: '/b.jsonl', turnId: 'turn-b', label: 'turn_started',
        timestamp: '2026-08-06T00:00:00.050Z',
      }),
      timelineEvent('a-user', 2, 'user_message', {
        traceId: 'trace-a', sourceTrace: '/a.jsonl', turnId: 'turn-a', role: 'user',
        timestamp: '2026-08-06T00:00:00.100Z',
      }),
      timelineEvent('b-user', 2, 'user_message', {
        traceId: 'trace-b', sourceTrace: '/b.jsonl', turnId: 'turn-b', role: 'user',
        timestamp: '2026-08-06T00:00:00.150Z',
      }),
      timelineEvent('a-end', 3, 'lifecycle', {
        traceId: 'trace-a', sourceTrace: '/a.jsonl', turnId: 'turn-a', label: 'turn_completed',
        timestamp: '2026-08-06T00:00:00.200Z',
      }),
      timelineEvent('b-end', 3, 'lifecycle', {
        traceId: 'trace-b', sourceTrace: '/b.jsonl', turnId: 'turn-b', label: 'turn_completed',
        timestamp: '2026-08-06T00:00:00.250Z',
      }),
    ];

    const turns = reconstructExperienceTurns(events);
    const turnA = turns.find((turn) => turn.sourceTurnId === 'turn-a');
    const turnB = turns.find((turn) => turn.sourceTurnId === 'turn-b');

    assert.deepEqual(turnA?.eventIds, ['a-start', 'a-user', 'a-end']);
    assert.deepEqual(turnB?.eventIds, ['b-start', 'b-user', 'b-end']);
  });

  it('uses lifecycle boundaries when a source exposes turns without turn ids', () => {
    const events = [
      timelineEvent('old-start', 1, 'lifecycle', { label: 'turn_started' }),
      timelineEvent('old-user', 2, 'user_message', { role: 'user' }),
      timelineEvent('old-end', 3, 'lifecycle', { label: 'turn_completed' }),
      timelineEvent('current-start', 4, 'lifecycle', { label: 'turn_started' }),
      timelineEvent('current-user', 5, 'user_message', { role: 'user' }),
      timelineEvent('current-tool', 6, 'tool_use'),
      timelineEvent('current-end', 7, 'lifecycle', { label: 'turn_aborted' }),
    ];

    const input = session(events, ['current-tool']);
    const resolved = resolveTaskWindow(input, input.turns[1]!.turnId);

    assert.equal(resolved.scope.basis, 'turn_lifecycle');
    assert.deepEqual(resolved.events.map((event) => event.id), [
      'current-start',
      'current-user',
      'current-tool',
      'current-end',
    ]);
  });

  it('uses user-message boundaries only when the source has no turn lifecycle', () => {
    const events = [
      timelineEvent('old-user', 1, 'user_message', { role: 'user' }),
      timelineEvent('old-answer', 2, 'assistant_message', { role: 'assistant' }),
      timelineEvent('task-context', 3, 'runtime_context'),
      timelineEvent('current-user', 4, 'user_message', { role: 'user' }),
      timelineEvent('current-tool', 5, 'tool_use'),
      timelineEvent('current-answer', 6, 'assistant_message', { role: 'assistant' }),
    ];

    const input = session(events, ['current-tool']);
    const resolved = resolveTaskWindow(input, input.turns[1]!.turnId);

    assert.equal(resolved.scope.basis, 'user_message');
    assert.deepEqual(resolved.events.map((event) => event.id), [
      'task-context',
      'current-user',
      'current-tool',
      'current-answer',
    ]);
  });

  it('uses the adapter-projected snippet for a task title while retaining raw text', () => {
    const events = [
      timelineEvent('user', 1, 'user_message', {
        role: 'user',
        snippet: '为什么插件不可用？',
        fullText: '# Files mentioned by the user:\n\n## My request for Codex:\n为什么插件不可用？',
      }),
      timelineEvent('answer', 2, 'assistant_message', { role: 'assistant' }),
    ];

    const [turn] = reconstructExperienceTurns(events);

    assert.equal(turn?.title, '为什么插件不可用？');
    assert.equal(events[0]?.fullText?.startsWith('# Files mentioned'), true);
  });

  it('does not use a Skill segment as a task boundary when no task boundary is observable', () => {
    const events = [timelineEvent('skill-tool', 1, 'tool_use')];

    const resolved = resolveTaskWindow(session(events, ['skill-tool']), 'missing-turn');

    assert.equal(resolved.scope.basis, 'unresolved');
    assert.deepEqual(resolved.events, []);
  });

  it('does not fall back to user messages when a native turn boundary is present but incomplete', () => {
    const events = [
      timelineEvent('current-user', 1, 'user_message', { role: 'user' }),
      timelineEvent('current-tool', 2, 'tool_use'),
      timelineEvent('orphan-terminal', 3, 'lifecycle', { label: 'turn_completed' }),
    ];

    const input = session(events, ['current-tool']);
    const resolved = resolveTaskWindow(input, input.turns[0]?.turnId ?? 'missing-turn');

    assert.equal(resolved.scope.basis, 'unresolved');
    assert.deepEqual(resolved.events, []);
  });

  it('keeps the complete normalized task while spreading the bounded semantic projection', () => {
    const events = Array.from({ length: 20 }, (_, index) => timelineEvent(
      `event-${index}`,
      index,
      index === 0 ? 'user_message' : 'assistant_message',
      { role: index === 0 ? 'user' : 'assistant' },
    ));

    const input = session(events, events.map((event) => event.id));
    const resolved = resolveTaskWindow(input, input.turns[0]!.turnId, 10);

    assert.equal(resolved.events.length, 20);
    assert.equal(resolved.semanticEvents.length, 10);
    const semanticIds = resolved.semanticEvents.map((event) => event.id);
    assert.equal(semanticIds[0], 'event-0');
    assert.equal(semanticIds.at(-1), 'event-19');
    assert.ok(semanticIds.some((id) => Number(id.split('-')[1]) >= 7 && Number(id.split('-')[1]) <= 12));
    assert.equal(resolved.scope.truncated, true);
  });

  it('retains a failed tool exchange in the middle of a long task', () => {
    const events = Array.from({ length: 40 }, (_, index) => timelineEvent(
      `event-${index}`,
      index,
      index === 0 ? 'user_message' : index === 39 ? 'assistant_message' : 'model_activity',
      { role: index === 0 ? 'user' : index === 39 ? 'assistant' : 'other' },
    ));
    events[19] = timelineEvent('failed-call', 19, 'tool_use', {
      callInstanceId: 'call-failed',
      toolName: 'Bash',
    });
    events[20] = timelineEvent('failed-result', 20, 'tool_result', {
      callInstanceId: 'call-failed',
      toolName: 'Bash',
      toolStatus: 'failure',
      isError: true,
    });

    const input = session(events, []);
    const resolved = resolveTaskWindow(input, input.turns[0]!.turnId, 8);
    const semanticIds = resolved.semanticEvents.map((event) => event.id);

    assert.ok(semanticIds.includes('failed-call'));
    assert.ok(semanticIds.includes('failed-result'));
    assert.ok(semanticIds.includes('event-0'));
    assert.ok(semanticIds.includes('event-39'));
  });

  it('retains an unmatched tool call as the current state of a bounded open task', () => {
    const events = Array.from({ length: 30 }, (_, index) => timelineEvent(
      `event-${index}`,
      index,
      index === 0 ? 'lifecycle' : index === 1 ? 'user_message' : 'model_activity',
      index === 0
        ? { turnId: 'turn-open', label: 'turn_started' }
        : index === 1
          ? { turnId: 'turn-open', role: 'user' }
          : { turnId: 'turn-open', role: 'other' },
    ));
    events[29] = timelineEvent('pending-call', 29, 'tool_use', {
      turnId: 'turn-open',
      callInstanceId: 'call-pending',
      toolName: 'Bash',
    });

    const input = session(events, []);
    const resolved = resolveTaskWindow(input, 'turn-open', 3);

    assert.equal(input.turns[0]?.status, 'open');
    assert.deepEqual(resolved.semanticEvents.map((event) => event.id), [
      'event-0',
      'event-1',
      'pending-call',
    ]);
  });

  it('retains the latest unmatched call when an open task has several pending calls', () => {
    const events = [
      timelineEvent('task-start', 0, 'lifecycle', { turnId: 'turn-open', label: 'turn_started' }),
      timelineEvent('user', 1, 'user_message', { turnId: 'turn-open', role: 'user' }),
      timelineEvent('pending-old', 2, 'tool_use', {
        turnId: 'turn-open', callInstanceId: 'call-old', toolName: 'Bash',
      }),
      timelineEvent('pending-latest', 3, 'tool_use', {
        turnId: 'turn-open', callInstanceId: 'call-latest', toolName: 'Bash',
      }),
    ];
    const input = session(events, []);

    const resolved = resolveTaskWindow(input, 'turn-open', 3);

    assert.deepEqual(resolved.semanticEvents.map((event) => event.id), [
      'task-start',
      'user',
      'pending-latest',
    ]);
  });

  it('preserves the request and final answer when the semantic limit is extremely small', () => {
    const events = [
      timelineEvent('task-start', 0, 'lifecycle', { label: 'turn_started' }),
      timelineEvent('user', 1, 'user_message', { role: 'user' }),
      timelineEvent('failed-result', 2, 'tool_result', { toolStatus: 'failure', isError: true }),
      timelineEvent('assistant', 3, 'assistant_message', { role: 'assistant' }),
      timelineEvent('task-end', 4, 'lifecycle', { label: 'turn_completed' }),
    ];
    const input = session(events, []);

    const resolved = resolveTaskWindow(input, input.turns[0]!.turnId, 2);

    assert.deepEqual(resolved.semanticEvents.map((event) => event.id), ['user', 'assistant']);
  });
});
