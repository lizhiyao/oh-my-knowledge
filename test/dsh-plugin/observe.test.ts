import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { apply } from '../../src/dsh-plugin/index.js';
import {
  createDshConversationCatalog,
  dshTraceIngestionSummary,
  listDshObserveCandidates,
  readDshObservedGroup,
  type DshPersistenceSnapshotLike,
  type DshSessionInspectionLike,
  type DshSessionPersistenceLike,
} from '../../src/dsh-plugin/observe.js';
import {
  adaptDshSession,
  DshTraceUnsupportedEventError,
  type DshSessionEventLike,
  type DshSessionHeaderLike,
} from '../../src/dsh-plugin/trace-adapter.js';

const BASE_TIME = Date.UTC(2026, 7, 24, 8, 0, 0);

function header(
  id: string,
  overrides: Partial<DshSessionHeaderLike> = {},
): DshSessionHeaderLike {
  return {
    version: 0,
    id,
    createdAt: BASE_TIME,
    cwd: '/workspace/demo',
    delegationDepth: 0,
    ...overrides,
  };
}

function event(
  seq: number,
  type: string,
  data: unknown,
  overrides: Partial<DshSessionEventLike> = {},
): DshSessionEventLike {
  return {
    type,
    seq,
    time: BASE_TIME + seq * 100,
    data,
    ...overrides,
  };
}

function completedEvents(prompt = '检查任务轨迹'): DshSessionEventLike[] {
  return [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'step/start', { turn: 1, step: 1 }),
    event(2, 'user/message', {
      id: 'user-1',
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }),
    event(3, 'request/context', {
      provider: 'deepseek',
      model: 'deepseek-v4',
      contextWindow: 128_000,
    }),
    event(4, 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'read',
      arguments: '{"path":"README.md"}',
    }),
    event(5, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'README content' }],
          isError: false,
        }],
      },
    }),
    event(6, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', text: '任务已完成' },
    }),
    event(7, 'assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4' },
        content: [
          { type: 'reasoning', text: '可见的推理摘要' },
          { type: 'text', text: '任务已完成' },
        ],
      },
      usage: { inputTokens: 20, outputTokens: 8 },
    }),
    event(8, 'step/end', { turn: 1, step: 1 }),
    event(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
}

function completedEventsAfterSeed(
  seedPrompt = '父任务历史',
  activePrompt = '执行子任务',
): DshSessionEventLike[] {
  return [
    ...completedEvents(seedPrompt),
    event(10, 'session/end-seed', {}),
    event(11, 'turn/start', { turn: 2 }),
    event(12, 'step/start', { turn: 2, step: 1 }),
    event(13, 'user/message', {
      id: 'user-2',
      role: 'user',
      content: [{ type: 'text', text: activePrompt }],
      source: { kind: 'user' },
    }),
    event(14, 'request/context', {
      provider: 'deepseek',
      model: 'deepseek-v4',
      contextWindow: 128_000,
    }),
    event(15, 'assistant/message', {
      turn: 2,
      step: 1,
      message: {
        id: 'assistant-2',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4' },
        content: [{ type: 'text', text: '子任务已完成' }],
      },
      usage: { inputTokens: 2, outputTokens: 1 },
    }),
    event(16, 'step/end', { turn: 2, step: 1 }),
    event(17, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ];
}

class FakePersistence implements DshSessionPersistenceLike {
  listCalls = 0;

  constructor(
    readonly inspections: Map<string, DshSessionInspectionLike>,
    private readonly mutateRevisionOnce = false,
  ) {}

  async listSnapshots(): Promise<readonly DshPersistenceSnapshotLike[]> {
    this.listCalls += 1;
    return Array.from(this.inspections.values()).map((inspection) => ({
      header: inspection.meta,
      revision: this.mutateRevisionOnce && this.listCalls === 1
        ? `stale:${inspection.meta.id}`
        : `stable:${inspection.meta.id}`,
    }));
  }

  async inspect(id: string): Promise<DshSessionInspectionLike> {
    const inspection = this.inspections.get(id);
    if (!inspection) throw new Error(`missing ${id}`);
    return inspection;
  }
}

class DetachedLogicalPersistence implements DshSessionPersistenceLike {
  listCalls = 0;

  constructor(readonly inspections: Map<string, DshSessionInspectionLike>) {}

  async listSnapshots(): Promise<readonly DshPersistenceSnapshotLike[]> {
    this.listCalls += 1;
    return Array.from(this.inspections.values()).reverse().map((inspection) => ({
      header: structuredClone(inspection.meta),
      revision: `detached:${inspection.meta.id}`,
    }));
  }

  async inspect(id: string): Promise<DshSessionInspectionLike> {
    const inspection = this.inspections.get(id);
    if (!inspection) throw new Error(`missing ${id}`);
    return structuredClone(inspection);
  }
}

class ContinuouslyChangingPersistence extends FakePersistence {
  override async listSnapshots(): Promise<readonly DshPersistenceSnapshotLike[]> {
    this.listCalls += 1;
    return Array.from(this.inspections.values()).map((inspection) => ({
      header: inspection.meta,
      revision: `changing:${this.listCalls}:${inspection.meta.id}`,
    }));
  }
}

function persistenceWithGroup(mutateRevisionOnce = false): FakePersistence {
  const root = header('root-session');
  const child = header('child-session', {
    parentSession: 'root-session',
    origin: 'subagent',
    delegationDepth: 1,
    createdAt: BASE_TIME + 250,
  });
  return new FakePersistence(new Map([
    ['root-session', { meta: root, events: completedEvents() }],
    ['child-session', { meta: child, events: completedEvents('子任务') }],
  ]), mutateRevisionOnce);
}

describe('DSH Trace IR adapter', () => {
  it('preserves durable messages, runtime facts, tools, usage, terminal status, and lineage', () => {
    const result = adaptDshSession(header('child', {
      parentSession: 'root',
      origin: 'subagent',
      delegationDepth: 1,
    }), [
      ...completedEvents(),
      event(10, 'plugin/telemetry-note', { note: 'safe to skip' }, { ignorable: true }),
    ], { rootRunId: 'root', role: 'subagent' });

    assert.equal(result.session.sourceKind, 'dsh');
    assert.equal(result.session.rootRunId, 'root');
    assert.equal(result.session.parentRunId, 'root');
    assert.equal(result.session.role, 'subagent');
    assert.equal(result.session.sourceMetadata?.provider, 'deepseek');
    assert.equal(result.session.sourceMetadata?.model, 'deepseek-v4');
    assert.equal(result.integrity.status, 'completed');
    assert.equal(result.integrity.complete, true);
    assert.equal(result.integrity.unknownEventCount, 1);
    assert.equal(result.integrity.ignoredChunkCount, 1);
    const user = result.session.events.find((item) => item.eventKind === 'message' && item.role === 'user');
    assert.equal(user?.eventKind, 'message');
    if (user?.eventKind === 'message') assert.equal(user.origin, 'human');
    const call = result.session.events.find((item) => item.eventKind === 'tool_call');
    assert.deepEqual(call?.input, { path: 'README.md' });
    const toolResult = result.session.events.find((item) => item.eventKind === 'tool_result');
    assert.equal(toolResult?.status, 'success');
    const usage = result.session.events.find((item) => item.eventKind === 'usage');
    assert.equal(usage?.inputTokens, 20);
    assert.equal(usage?.cacheReadTokens, undefined);
    assert.ok(result.session.events.some((item) => item.eventKind === 'model_activity'));
  });

  it('maps every terminal outcome without claiming unknown reasons are complete', () => {
    const cases = [
      {
        reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'stopped' } },
        status: 'aborted',
        phase: 'turn_aborted',
        complete: true,
      },
      {
        reason: { kind: 'interrupted' },
        status: 'interrupted',
        phase: 'turn_interrupted',
        complete: true,
      },
      {
        reason: { kind: 'error', error: { message: 'provider failed', code: 'UNKNOWN' } },
        status: 'failed',
        phase: 'turn_failed',
        complete: true,
      },
      {
        reason: { kind: 'future-terminal' },
        status: 'unknown',
        phase: 'turn_ended_unknown',
        complete: false,
      },
    ] as const;

    cases.forEach((item, index) => {
      const result = adaptDshSession(header(`terminal-${index}`), [
        event(0, 'turn/start', { turn: 1 }),
        event(1, 'turn/end', { turn: 1, reason: item.reason }),
      ]);
      const terminal = result.session.events.find((candidate) => (
        candidate.eventKind === 'lifecycle' && candidate.sourceType === 'turn/end'
      ));
      assert.equal(result.integrity.status, item.status, item.reason.kind);
      assert.equal(result.integrity.complete, item.complete, item.reason.kind);
      assert.equal(terminal?.eventKind, 'lifecycle');
      if (terminal?.eventKind === 'lifecycle') assert.equal(terminal.phase, item.phase, item.reason.kind);
    });
  });

  it('preserves an observed tool failure without making the matched trace incomplete', () => {
    const events = completedEvents();
    events[5] = event(5, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'permission denied' }],
          isError: true,
        }],
      },
      error: { name: 'PermissionError', code: 'DENIED' },
    });
    const result = adaptDshSession(header('tool-failure'), events);
    const toolResult = result.session.events.find((item) => item.eventKind === 'tool_result');
    assert.equal(toolResult?.status, 'failure');
    assert.equal(result.integrity.unmatchedToolCallCount, 0);
    assert.equal(result.integrity.unmatchedToolResultCount, 0);
    assert.equal(result.integrity.complete, true);
  });

  it('does not project inherited seed records as child task activity', () => {
    const result = adaptDshSession(header('seeded-child', {
      parentSession: 'root',
      origin: 'subagent',
      delegationDepth: 1,
      seedLength: 10,
      createdAt: BASE_TIME + 1_000,
    }), completedEventsAfterSeed(), { rootRunId: 'root', role: 'subagent' });

    const messages = result.session.events
      .filter((item) => item.eventKind === 'message')
      .map((item) => item.text);
    assert.deepEqual(messages, ['执行子任务', '子任务已完成']);
    assert.equal(result.session.events.some((item) => item.eventKind === 'tool_call'), false);
    assert.deepEqual(
      result.session.events.filter((item) => item.eventKind === 'usage').map((item) => item.inputTokens),
      [2],
    );
    assert.equal(result.session.events.some((item) => item.sourceIndex > 0 && item.sourceIndex <= 10), false);
    assert.equal(result.integrity.status, 'completed');
    assert.equal(result.integrity.complete, true);
  });

  it('keeps an ordinary fork standalone outside subagent grouping semantics', () => {
    const result = adaptDshSession(header('ordinary-fork', {
      parentSession: 'source-session',
      seedLength: 0,
    }), completedEvents());
    assert.equal(result.session.rootRunId, 'ordinary-fork');
    assert.equal(result.session.parentRunId, undefined);
    assert.equal(result.session.role, 'main');
  });

  it('distinguishes runtime, skill-context, and synthetic user-role messages', () => {
    const result = adaptDshSession(header('origins'), [
      event(0, 'user/message', { content: [{ type: 'text', text: 'runtime' }], source: { kind: 'agent-instructions' } }),
      event(1, 'user/message', { content: [{ type: 'text', text: 'skill' }], source: { kind: 'skill-invocation', name: 'review' } }),
      event(2, 'user/message', { content: [{ type: 'text', text: 'synthetic' }], source: { kind: 'cron' } }),
    ]);
    const origins = result.session.events
      .filter((item) => item.eventKind === 'message')
      .map((item) => item.origin);
    assert.deepEqual(origins, ['runtime', 'skill-context', 'synthetic']);
  });

  it('refuses unknown required events and sequence gaps', () => {
    assert.throws(
      () => adaptDshSession(header('required'), [event(0, 'plugin/required', {})]),
      DshTraceUnsupportedEventError,
    );
    assert.throws(
      () => adaptDshSession(header('gap'), [event(1, 'turn/start', { turn: 1 })]),
      /seq 不连续/,
    );
    assert.throws(
      () => adaptDshSession(header('required-seed', { seedLength: 1 }), [event(0, 'plugin/required', {})]),
      DshTraceUnsupportedEventError,
    );
  });

  it('rejects malformed envelopes, event payloads, and seed metadata', () => {
    const cases: Array<{ name: string; run: () => unknown; expected: RegExp }> = [
      {
        name: 'negative timestamp',
        run: () => adaptDshSession(header('negative-time'), [
          event(0, 'turn/start', { turn: 1 }, { time: -1 }),
        ]),
        expected: /time 非法/u,
      },
      {
        name: 'empty event type',
        run: () => adaptDshSession(header('empty-type'), [event(0, ' ', {})]),
        expected: /type 为空/u,
      },
      {
        name: 'missing turn id',
        run: () => adaptDshSession(header('missing-turn'), [event(0, 'turn/start', {})]),
        expected: /缺少 turn/u,
      },
      {
        name: 'seed beyond log',
        run: () => adaptDshSession(header('bad-seed', { seedLength: 2 }), [
          event(0, 'session/end-seed', {}),
        ]),
        expected: /seedLength 非法/u,
      },
    ];
    cases.forEach((item) => assert.throws(item.run, item.expected, item.name));
  });

  it('does not represent open turns or missing tool results as complete', () => {
    const result = adaptDshSession(header('partial'), [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'step/start', { turn: 1, step: 1 }),
      event(2, 'tool/call', { turn: 1, step: 1, callId: 'pending', name: 'read', arguments: '{}' }),
    ]);
    assert.equal(result.integrity.complete, false);
    assert.equal(result.integrity.status, 'open');
    assert.equal(result.integrity.openTurnCount, 1);
    assert.equal(result.integrity.openStepCount, 1);
    assert.equal(result.integrity.unmatchedToolCallCount, 1);
  });
});

describe('DSH persistence observation', () => {
  it('retries a changing revision and maps root plus descendants through one logical seam', async () => {
    const persistence = persistenceWithGroup(true);
    const group = await readDshObservedGroup(persistence, 'child-session');
    assert.ok(persistence.listCalls >= 4);
    assert.equal(group.rootSessionId, 'root-session');
    assert.equal(group.traces.length, 2);
    assert.deepEqual(group.traces.map((item) => item.session.role), ['main', 'subagent']);
  });

  it('rejects a group whose revision never stabilizes within the bounded retry budget', async () => {
    const source = persistenceWithGroup();
    const persistence = new ContinuouslyChangingPersistence(source.inspections);
    await assert.rejects(
      readDshObservedGroup(persistence, 'root-session'),
      /3 次一致快照均失败/u,
    );
    assert.equal(persistence.listCalls, 6);
  });

  it('depends only on the logical seam across differently behaved persistence implementations', async () => {
    const referencePersistence = persistenceWithGroup();
    const detachedPersistence = new DetachedLogicalPersistence(referencePersistence.inspections);
    const reference = await readDshObservedGroup(referencePersistence, 'root-session');
    const detached = await readDshObservedGroup(detachedPersistence, 'root-session');
    assert.deepEqual(
      reference.traces.map((item) => item.session),
      detached.traces.map((item) => item.session),
    );
    assert.deepEqual(
      reference.inspections,
      detached.inspections,
    );
  });

  it('counts consolidated assistant chunks as parsed logical records', async () => {
    const group = await readDshObservedGroup(persistenceWithGroup(), 'root-session');
    const ingestion = dshTraceIngestionSummary(group);
    assert.equal(ingestion.parsedRecordCount, ingestion.sourceRecordCount);
    assert.equal(ingestion.ignoredValueCount, 0);
    assert.ok(group.traces.every((item) => item.integrity.ignoredChunkCount === 1));
  });

  it('lists terminal roots and excludes the current command session', async () => {
    const current = header('current-session', { createdAt: BASE_TIME + 10_000 });
    const persistence = persistenceWithGroup();
    persistence.inspections.set('current-session', { meta: current, events: completedEvents('当前命令') });
    const rows = await listDshObserveCandidates(persistence, { excludeSessionId: 'current-session' });
    assert.deepEqual(rows.map((item) => item.sessionId), ['root-session']);
  });

  it('lists every supported terminal status and excludes unknown terminal reasons', async () => {
    const reasons = [
      { id: 'completed', reason: { kind: 'completed' }, status: 'completed' },
      {
        id: 'failed',
        reason: { kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } },
        status: 'failed',
      },
      {
        id: 'aborted',
        reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'stopped' } },
        status: 'aborted',
      },
      { id: 'interrupted', reason: { kind: 'interrupted' }, status: 'interrupted' },
      { id: 'unknown', reason: { kind: 'future-terminal' }, status: 'unknown' },
    ] as const;
    const persistence = new FakePersistence(new Map(reasons.map((item, index) => [
      item.id,
      {
        meta: header(item.id, { createdAt: BASE_TIME + index * 1_000 }),
        events: [
          event(0, 'turn/start', { turn: 1 }),
          event(1, 'turn/end', { turn: 1, reason: item.reason }),
        ],
      },
    ])));

    const rows = await listDshObserveCandidates(persistence);
    assert.deepEqual(rows.map((item) => ({ id: item.sessionId, status: item.status })), [
      { id: 'interrupted', status: 'interrupted' },
      { id: 'aborted', status: 'aborted' },
      { id: 'failed', status: 'failed' },
      { id: 'completed', status: 'completed' },
    ]);
  });

  it('does not list a root while one descendant trace is incomplete', async () => {
    const persistence = persistenceWithGroup();
    const child = persistence.inspections.get('child-session');
    assert.ok(child);
    persistence.inspections.set('child-session', {
      meta: child.meta,
      events: [event(0, 'turn/start', { turn: 1 })],
    });
    assert.deepEqual(await listDshObserveCandidates(persistence), []);
  });

  it('keeps ordinary forks independent while grouping their own durable subagents', async () => {
    const persistence = persistenceWithGroup();
    persistence.inspections.set('fork-session', {
      meta: header('fork-session', {
        parentSession: 'root-session',
        createdAt: BASE_TIME + 20_000,
      }),
      events: completedEvents('普通 fork 任务'),
    });
    persistence.inspections.set('fork-child', {
      meta: header('fork-child', {
        parentSession: 'fork-session',
        origin: 'subagent',
        delegationDepth: 1,
        createdAt: BASE_TIME + 20_250,
      }),
      events: completedEvents('fork 子任务'),
    });

    const rootGroup = await readDshObservedGroup(persistence, 'root-session');
    assert.deepEqual(rootGroup.traces.map((item) => item.session.runId), [
      'root-session',
      'child-session',
    ]);
    const forkGroup = await readDshObservedGroup(persistence, 'fork-child');
    assert.equal(forkGroup.rootSessionId, 'fork-session');
    assert.deepEqual(forkGroup.traces.map((item) => item.session.runId), [
      'fork-session',
      'fork-child',
    ]);
    assert.deepEqual(forkGroup.traces.map((item) => item.session.role), ['main', 'subagent']);

    const candidates = await listDshObserveCandidates(persistence);
    assert.deepEqual(candidates.map((item) => item.sessionId), ['fork-session', 'root-session']);
  });

  it('feeds the existing source-neutral Studio catalog', async () => {
    const group = await readDshObservedGroup(persistenceWithGroup(), 'root-session');
    const catalog = createDshConversationCatalog();
    const target = catalog.upsert(group);
    const index = await catalog.listConversations();
    const trajectory = await catalog.loadTaskTrajectory(target.threadId, target.turnId);
    assert.equal(index.conversations[0]?.sourceKind, 'dsh');
    assert.equal(index.conversations[0]?.childThreadCount, 1);
    assert.equal(trajectory?.session.sourceKind, 'dsh');
    assert.ok(trajectory?.session.fullSessionTimeline.some((item) => item.traceRole === 'subagent'));
    assert.equal(trajectory?.sourceRecords.status, 'available');
  });
});

describe('DSH /omk observe command', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it('lists sessions, imports one, and returns a live Studio trajectory URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-dsh-observe-'));
    const persistence = persistenceWithGroup();
    let handler: ((invocation: Record<string, unknown>) => Promise<{ kind: string; text?: string }>) | undefined;
    const dispose = apply({
      commands: {
        register(definition: { handler: typeof handler }) {
          handler = definition.handler;
          return () => undefined;
        },
      },
      get(name: 'sessionPersistence') {
        return name === 'sessionPersistence' ? persistence : undefined;
      },
    } as never);
    cleanups.push(() => {
      dispose();
      rmSync(dir, { recursive: true, force: true });
    });
    assert.ok(handler);
    const invocation = {
      agent: {
        id: 'command-session',
        session: { id: 'command-session', header: { cwd: dir }, events: [] },
      },
      signal: new AbortController().signal,
    };
    const listed = await handler({ ...invocation, rawInput: 'observe' });
    assert.equal(listed.kind, 'success');
    assert.match(listed.text ?? '', /root-session/);
    const observed = await handler({ ...invocation, rawInput: 'observe root-session' });
    assert.equal(observed.kind, 'success', observed.text);
    const reportsDir = join(dir, '.omk', 'observe', 'inbox', 'reports');
    assert.equal(existsSync(join(dir, '.omk', 'layout.json')), true);
    assert.equal(readdirSync(reportsDir).some((file) => file.endsWith('.report.json')), true);
    const url = /任务轨迹：(http:\/\/[^\s]+)/u.exec(observed.text ?? '')?.[1];
    assert.ok(url);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /检查任务轨迹/);
  });
});
