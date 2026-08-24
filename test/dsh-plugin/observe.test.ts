import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { apply } from '../../src/dsh-plugin/index.js';
import {
  createDshConversationCatalog,
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
    event(6, 'assistant/message', {
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
    event(7, 'step/end', { turn: 1, step: 1 }),
    event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
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
      event(9, 'plugin/telemetry-note', { note: 'safe to skip' }, { ignorable: true }),
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

  it('returns equivalent Trace IR for backend implementations exposing the same logical events', async () => {
    const jsonl = await readDshObservedGroup(persistenceWithGroup(), 'root-session');
    const sqlite = await readDshObservedGroup(persistenceWithGroup(), 'root-session');
    assert.deepEqual(jsonl.traces.map((item) => item.session), sqlite.traces.map((item) => item.session));
  });

  it('lists terminal roots and excludes the current command session', async () => {
    const current = header('current-session', { createdAt: BASE_TIME + 10_000 });
    const persistence = persistenceWithGroup();
    persistence.inspections.set('current-session', { meta: current, events: completedEvents('当前命令') });
    const rows = await listDshObserveCandidates(persistence, { excludeSessionId: 'current-session' });
    assert.deepEqual(rows.map((item) => item.sessionId), ['root-session']);
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
    assert.equal(observed.kind, 'success');
    const url = /任务轨迹：(http:\/\/[^\s]+)/u.exec(observed.text ?? '')?.[1];
    assert.ok(url);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /检查任务轨迹/);
  });
});
