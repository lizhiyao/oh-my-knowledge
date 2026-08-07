import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  resolveTaskWindow,
} from '../../src/observability/task-window.js';
import { reconstructExperienceTurns } from '../../src/observability/turn-index.js';
import type {
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
} from '../../src/types/index.js';

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

  it('keeps the complete normalized task while bounding only the semantic projection', () => {
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
    assert.deepEqual(resolved.semanticEvents.map((event) => event.id), [
      'event-0',
      'event-1',
      'event-2',
      'event-3',
      'event-4',
      'event-5',
      'event-16',
      'event-17',
      'event-18',
      'event-19',
    ]);
    assert.equal(resolved.scope.truncated, true);
  });
});
