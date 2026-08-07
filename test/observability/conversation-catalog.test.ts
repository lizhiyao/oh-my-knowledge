import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'vitest';
import {
  buildCodexRolloutIndex,
  extendCodexRolloutIndex,
  isCurrentCodexRolloutIndex,
  isReusableCodexRolloutIndex,
  normalizeCodexRolloutIndex,
  readCodexTaskRecords,
  synchronizeCurrentCodexRolloutIndex,
} from '../../src/observability/codex-conversation-index.js';
import { createCodexConversationCatalog } from '../../src/observability/conversation-catalog.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Codex conversation catalog', () => {
  it('indexes adjacent native turns without leaking records across boundaries', () => {
    const root = temporaryRoot();
    const rolloutPath = join(root, 'rollout-main.jsonl');
    writeFileSync(rolloutPath, rollout('main-thread'));

    const index = buildCodexRolloutIndex(rolloutPath, 'main-thread');
    assert.equal(index.tasks.length, 2);
    assert.deepEqual(index.tasks.map((task) => ({
      turnId: task.turnId,
      title: task.title,
      sourceRecordCount: task.sourceRecordCount,
    })), [
      { turnId: 'turn-a', title: '第一项任务', sourceRecordCount: 5 },
      { turnId: 'turn-b', title: '第二项任务', sourceRecordCount: 3 },
    ]);
    assert.equal(index.tasks[0]!.endOffset, index.tasks[1]!.startOffset);

    const first = readCodexTaskRecords(index, index.tasks[0]!);
    assert.equal(first.lines.length, 5);
    assert.ok(first.lines.some((line) => line.text.includes('turn-a')));
    assert.ok(first.lines.every((line) => !line.text.includes('turn-b')));
  });

  it('prefers the native user message over injected user-role context', () => {
    const root = temporaryRoot();
    const rolloutPath = join(root, 'rollout-injected-context.jsonl');
    const records = [
      { timestamp: '2026-08-06T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } },
      { timestamp: '2026-08-06T00:00:00.050Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<in-app-browser-context source="ambient-ui-state">\nCurrent URL: http://127.0.0.1:7799/\n</in-app-browser-context>' }] } },
      { timestamp: '2026-08-06T00:00:00.100Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\nInjected context' }] } },
      { timestamp: '2026-08-06T00:00:00.200Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '用户真正发送的任务' }] } },
      { timestamp: '2026-08-06T00:00:00.300Z', type: 'event_msg', payload: { type: 'user_message', message: '<in-app-browser-context source="ambient-ui-state">\nCurrent URL: http://127.0.0.1:7799/\n</in-app-browser-context>\n\n用户真正发送的任务' } },
      { timestamp: '2026-08-06T00:00:00.400Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a' } },
    ];
    writeFileSync(rolloutPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const index = buildCodexRolloutIndex(rolloutPath, 'main-thread');
    assert.equal(index.tasks[0]?.title, '用户真正发送的任务');
  });

  it('does not keep a superseded task running when its terminal event is missing', () => {
    const root = temporaryRoot();
    const rolloutPath = join(root, 'rollout-missing-terminal.jsonl');
    const records = [
      { timestamp: '2026-08-06T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-stale' } },
      { timestamp: '2026-08-06T00:00:00.100Z', type: 'event_msg', payload: { type: 'user_message', message: '缺少结束事件的任务' } },
      { timestamp: '2026-08-06T00:01:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-current' } },
      { timestamp: '2026-08-06T00:01:00.100Z', type: 'event_msg', payload: { type: 'user_message', message: '后续任务' } },
    ];
    writeFileSync(rolloutPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const index = buildCodexRolloutIndex(rolloutPath, 'main-thread');

    assert.equal(index.tasks[0]?.status, 'unknown');
    assert.equal(index.tasks[0]?.endTimestamp, '2026-08-06T00:01:00.000Z');
    assert.equal(index.tasks[1]?.status, 'open');

    const migrated = normalizeCodexRolloutIndex({
      ...index,
      tasks: index.tasks.map((task, taskIndex) => taskIndex === 0
        ? { ...task, status: 'open', endTimestamp: undefined }
        : task),
    });
    assert.equal(migrated.tasks[0]?.status, 'unknown');
    assert.equal(migrated.tasks[0]?.endTimestamp, '2026-08-06T00:01:00.000Z');
  });

  it('keeps an internally consistent prefix index reusable while a rollout grows', () => {
    const root = temporaryRoot();
    const rolloutPath = join(root, 'rollout-growing.jsonl');
    writeFileSync(rolloutPath, rollout('main-thread'));
    const index = buildCodexRolloutIndex(rolloutPath, 'main-thread');

    appendFileSync(rolloutPath, `${JSON.stringify({
      timestamp: '2026-08-06T00:02:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-c' },
    })}\n`);

    assert.equal(isCurrentCodexRolloutIndex(index, rolloutPath), false);
    assert.equal(isReusableCodexRolloutIndex(index, rolloutPath), true);
  });

  it('synchronizes a reusable prefix before serving a current index', () => {
    const root = temporaryRoot();
    const rolloutPath = join(root, 'rollout-current.jsonl');
    writeFileSync(rolloutPath, rollout('main-thread'));
    const prefix = buildCodexRolloutIndex(rolloutPath, 'main-thread');

    appendFileSync(rolloutPath, `${JSON.stringify({
      timestamp: '2026-08-06T00:02:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-c' },
    })}\n${JSON.stringify({
      timestamp: '2026-08-06T00:02:00.100Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '后台扫描期间追加的任务' },
    })}\n`);

    const current = synchronizeCurrentCodexRolloutIndex(rolloutPath, 'main-thread', prefix);
    assert.equal(isCurrentCodexRolloutIndex(current, rolloutPath), true);
    assert.equal(current.tasks.at(-1)?.turnId, 'turn-c');
    assert.equal(current.tasks.at(-1)?.title, '后台扫描期间追加的任务');
  });

  it('rejects a current-looking prefix from another source thread', () => {
    const root = temporaryRoot();
    const rolloutPath = join(root, 'rollout-thread-boundary.jsonl');
    writeFileSync(rolloutPath, rollout('main-thread'));
    const foreign = buildCodexRolloutIndex(rolloutPath, 'foreign-thread');

    const current = synchronizeCurrentCodexRolloutIndex(rolloutPath, 'main-thread', foreign);

    assert.equal(current.sourceThreadId, 'main-thread');
  });

  it('extends a growing rollout from the cached byte boundary', () => {
    const root = temporaryRoot();
    const rolloutPath = join(root, 'rollout-incremental.jsonl');
    const initial = [
      { timestamp: '2026-08-06T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } },
      { timestamp: '2026-08-06T00:00:00.100Z', type: 'event_msg', payload: { type: 'user_message', message: '增量任务' } },
    ];
    writeFileSync(rolloutPath, `${initial.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const prefix = buildCodexRolloutIndex(rolloutPath, 'main-thread');

    const appended = [
      { timestamp: '2026-08-06T00:00:00.200Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-a', name: 'exec_command', input: '{}' } },
      { timestamp: '2026-08-06T00:00:00.300Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a' } },
      { timestamp: '2026-08-06T00:01:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-b' } },
      { timestamp: '2026-08-06T00:01:00.100Z', type: 'event_msg', payload: { type: 'user_message', message: '下一项任务' } },
    ];
    appendFileSync(rolloutPath, `${appended.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const extended = extendCodexRolloutIndex(rolloutPath, 'main-thread', prefix);
    const rebuilt = buildCodexRolloutIndex(rolloutPath, 'main-thread');
    assert.deepEqual(extended, rebuilt);
    assert.equal(extended.tasks[0]?.status, 'completed');
    assert.equal(extended.tasks[0]?.toolCallCount, 1);
    assert.equal(extended.tasks[1]?.status, 'open');
  });

  it('does not commit an incomplete JSONL tail before the record is finished', () => {
    const root = temporaryRoot();
    const rolloutPath = join(root, 'rollout-partial-tail.jsonl');
    const started = JSON.stringify({
      timestamp: '2026-08-06T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-a' },
    });
    const user = JSON.stringify({
      timestamp: '2026-08-06T00:00:00.100Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '增量标题' },
    });
    const splitAt = Math.floor(user.length / 2);
    writeFileSync(rolloutPath, `${started}\n${user.slice(0, splitAt)}`);

    const prefix = buildCodexRolloutIndex(rolloutPath, 'main-thread');
    assert.equal(prefix.sourceRecordCount, 1);
    assert.equal(prefix.malformedRecordCount, 0);
    assert.ok(prefix.indexedSize < prefix.sourceSize);

    appendFileSync(rolloutPath, `${user.slice(splitAt)}\n`);
    const extended = extendCodexRolloutIndex(rolloutPath, 'main-thread', prefix);
    const rebuilt = buildCodexRolloutIndex(rolloutPath, 'main-thread');

    assert.deepEqual(extended, rebuilt);
    assert.equal(extended.sourceRecordCount, 2);
    assert.equal(extended.malformedRecordCount, 0);
    assert.equal(extended.tasks[0]?.title, '增量标题');
  });

  it('keeps line positions stable when a complete EOF record later receives its delimiter', () => {
    const root = temporaryRoot();
    const rolloutPath = join(root, 'rollout-complete-tail.jsonl');
    const started = JSON.stringify({
      timestamp: '2026-08-06T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-a' },
    });
    const user = JSON.stringify({
      timestamp: '2026-08-06T00:00:00.100Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '追加后的标题' },
    });
    writeFileSync(rolloutPath, started);

    const prefix = buildCodexRolloutIndex(rolloutPath, 'main-thread');
    assert.equal(prefix.sourceRecordCount, 1);
    assert.equal(prefix.indexedLineCount, 1);
    assert.equal(prefix.indexedEndsWithNewline, false);

    appendFileSync(rolloutPath, `\n${user}\n`);
    const extended = extendCodexRolloutIndex(rolloutPath, 'main-thread', prefix);
    const rebuilt = buildCodexRolloutIndex(rolloutPath, 'main-thread');

    assert.deepEqual(extended, rebuilt);
    assert.equal(extended.indexedLineCount, 2);
    assert.equal(extended.indexedEndsWithNewline, true);
    assert.equal(extended.tasks[0]?.endLine, 1);
  });

  it('keeps task byte ranges stable when only the missing EOF delimiter is appended', () => {
    const root = temporaryRoot();
    const rolloutPath = join(root, 'rollout-delimiter-only.jsonl');
    const started = JSON.stringify({
      timestamp: '2026-08-06T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-a' },
    });
    writeFileSync(rolloutPath, started);

    const prefix = buildCodexRolloutIndex(rolloutPath, 'main-thread');
    appendFileSync(rolloutPath, '\n');
    const extended = extendCodexRolloutIndex(rolloutPath, 'main-thread', prefix);
    const rebuilt = buildCodexRolloutIndex(rolloutPath, 'main-thread');

    assert.deepEqual(extended, rebuilt);
    assert.equal(extended.tasks[0]?.endOffset, extended.sourceSize);
  });

  it('keeps a terminal EOF task adjacent to the next appended task', () => {
    const root = temporaryRoot();
    const rolloutPath = join(root, 'rollout-terminal-tail.jsonl');
    const started = JSON.stringify({
      timestamp: '2026-08-06T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-a' },
    });
    const completed = JSON.stringify({
      timestamp: '2026-08-06T00:00:00.100Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-a' },
    });
    const nextStarted = JSON.stringify({
      timestamp: '2026-08-06T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-b' },
    });
    writeFileSync(rolloutPath, `${started}\n${completed}`);

    const prefix = buildCodexRolloutIndex(rolloutPath, 'main-thread');
    appendFileSync(rolloutPath, `\n${nextStarted}\n`);
    const extended = extendCodexRolloutIndex(rolloutPath, 'main-thread', prefix);
    const rebuilt = buildCodexRolloutIndex(rolloutPath, 'main-thread');

    assert.deepEqual(extended, rebuilt);
    assert.equal(extended.tasks[0]?.endOffset, extended.tasks[1]?.startOffset);
  });

  it('lists main conversations, groups child agents, and drills into native tasks', async () => {
    const root = temporaryRoot();
    const codexHome = join(root, '.codex');
    const sessionsDir = join(codexHome, 'sessions');
    const cacheDir = join(root, 'cache');
    mkdirSync(sessionsDir, { recursive: true });
    const mainRollout = join(sessionsDir, 'rollout-main.jsonl');
    const legacyRollout = join(sessionsDir, 'rollout-legacy.jsonl');
    const childRollout = join(sessionsDir, 'rollout-child.jsonl');
    writeFileSync(mainRollout, rollout('main-thread'));
    writeFileSync(legacyRollout, rollout('legacy-thread'));
    writeFileSync(childRollout, rollout('child-thread'));
    createStateDatabase(codexHome, [
      thread('main-thread', mainRollout, 'user', '{"app":"codex"}', '主对话', 3_000),
      thread('legacy-thread', legacyRollout, null, '{"cli":{}}', '历史主对话', 2_000),
      thread('child-thread', childRollout, null, '{"subagent":{"role":"review"}}', '子 Agent', 1_000),
    ], [['main-thread', 'child-thread']]);

    const catalog = createCodexConversationCatalog({ codexHome, cacheDir, useBackgroundProcess: false });
    const overview = await catalog.listConversations();
    assert.deepEqual(overview.conversations.map((item) => item.threadId), ['main-thread', 'legacy-thread']);
    assert.equal(overview.conversations[0]!.childThreadCount, 1);
    assert.equal(overview.unarchivedConversationCount, 2);
    assert.equal(overview.archivedConversationCount, 0);
    assert.equal(overview.workspaceCount, 1);

    const conversation = await catalog.getConversation('main-thread');
    assert.equal(conversation?.turnCount, 2);
    assert.deepEqual(conversation?.tasks.map((task) => task.turnId), ['turn-a', 'turn-b']);
    assert.match(conversation?.tasks[0]?.trajectoryHref ?? '', /\/conversations\/main-thread\/tasks\/turn-a$/u);

    appendFileSync(mainRollout, `${JSON.stringify({
      timestamp: '2026-08-06T00:02:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-c' },
    })}\n${JSON.stringify({
      timestamp: '2026-08-06T00:02:00.100Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '刚开始的任务' },
    })}\n`);
    const refreshedOverview = await catalog.listConversations();
    assert.equal(refreshedOverview.conversations[0]?.tasks.at(-1)?.turnId, 'turn-c');
    assert.equal(refreshedOverview.conversations[0]?.tasks.at(-1)?.status, 'open');

    const refreshedConversation = await catalog.getConversation('main-thread');
    assert.equal(refreshedConversation?.tasks.at(-1)?.turnId, 'turn-c');
    assert.equal(refreshedConversation?.tasks.at(-1)?.status, 'open');

    const trajectory = await catalog.loadTaskTrajectory('main-thread', 'turn-a');
    assert.equal(trajectory?.session.threadId, 'main-thread');
    assert.ok(trajectory?.session.turns.some((turn) => turn.sourceTurnId === 'turn-a'));
    assert.ok(trajectory?.session.fullSessionTimeline.some((event) => event.kind === 'user_message'));
    assert.equal(trajectory?.sourceRecords.recordCount, 5);
  });

  it('streams fresh snapshots while an indexed Codex task is still open', async () => {
    const root = temporaryRoot();
    const codexHome = join(root, '.codex');
    const sessionsDir = join(codexHome, 'sessions');
    const cacheDir = join(root, 'cache');
    mkdirSync(sessionsDir, { recursive: true });
    const rolloutPath = join(sessionsDir, 'rollout-live.jsonl');
    const initialRecords = [
      { timestamp: '2026-08-06T00:00:00.000Z', type: 'session_meta', payload: { id: 'live-thread', session_id: 'live-thread', cwd: '/repo', originator: 'Codex Desktop' } },
      { timestamp: '2026-08-06T00:00:00.100Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live' } },
      { timestamp: '2026-08-06T00:00:00.200Z', type: 'event_msg', payload: { type: 'user_message', message: '实时任务' } },
    ];
    writeFileSync(rolloutPath, `${initialRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);
    createStateDatabase(codexHome, [
      thread('live-thread', rolloutPath, 'user', '{"app":"codex"}', '实时对话', 3_000),
    ], []);

    const catalog = createCodexConversationCatalog({
      codexHome,
      cacheDir,
      useBackgroundProcess: false,
      livePollIntervalMs: 10,
    });
    assert.ok(catalog.observeTaskTrajectory);
    const snapshots: Array<{ revision: string; status: string; records: number }> = [];
    const unsubscribe = await catalog.observeTaskTrajectory(
      'live-thread',
      'turn-live',
      {
        next: (trajectory) => snapshots.push({
          revision: trajectory.revision,
          status: trajectory.status,
          records: trajectory.ingestion.sourceRecordCount,
        }),
      },
    );
    assert.equal(snapshots[0]?.status, 'open');

    appendFileSync(rolloutPath, `${JSON.stringify({
      timestamp: '2026-08-06T00:00:00.300Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'live-call', name: 'exec_command', input: '{"cmd":"pwd"}' },
    })}\n`);
    await waitFor(() => snapshots.length >= 2);
    assert.equal(snapshots.at(-1)?.status, 'open');
    assert.ok((snapshots.at(-1)?.records ?? 0) > (snapshots[0]?.records ?? 0));

    appendFileSync(rolloutPath, `${JSON.stringify({
      timestamp: '2026-08-06T00:00:00.400Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-live', last_agent_message: '完成' },
    })}\n`);
    await waitFor(() => snapshots.at(-1)?.status === 'completed');
    assert.notEqual(snapshots[0]?.revision, snapshots.at(-1)?.revision);
    unsubscribe();
  });

  it('closes a live subscription when an unchanged rollout ages out', async () => {
    const root = temporaryRoot();
    const codexHome = join(root, '.codex');
    const sessionsDir = join(codexHome, 'sessions');
    const cacheDir = join(root, 'cache');
    mkdirSync(sessionsDir, { recursive: true });
    const rolloutPath = join(sessionsDir, 'rollout-silent.jsonl');
    const records = [
      { timestamp: '2026-08-06T00:00:00.000Z', type: 'session_meta', payload: { id: 'silent-thread', cwd: '/repo' } },
      { timestamp: '2026-08-06T00:00:00.100Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-silent' } },
      { timestamp: '2026-08-06T00:00:00.200Z', type: 'event_msg', payload: { type: 'user_message', message: '静默中断的任务' } },
    ];
    writeFileSync(rolloutPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    createStateDatabase(codexHome, [
      thread('silent-thread', rolloutPath, 'user', '{"app":"codex"}', '静默任务', 1_000),
    ], []);
    let now = statSync(rolloutPath).mtimeMs;
    let completed = 0;
    const statuses: string[] = [];
    const catalog = createCodexConversationCatalog({
      codexHome,
      cacheDir,
      useBackgroundProcess: false,
      livePollIntervalMs: 10,
      liveActivityWindowMs: 100,
      now: () => now,
    });
    assert.ok(catalog.observeTaskTrajectory);
    const unsubscribe = await catalog.observeTaskTrajectory('silent-thread', 'turn-silent', {
      next: (trajectory) => statuses.push(trajectory.status),
      complete: () => { completed += 1; },
    });
    assert.deepEqual(statuses, ['open']);

    now += 101;
    await waitFor(() => statuses.at(-1) === 'unknown' && completed === 1);

    assert.deepEqual(statuses, ['open', 'unknown']);
    unsubscribe();
  });

  it('reports a stale final task without terminal evidence as unknown', async () => {
    const root = temporaryRoot();
    const codexHome = join(root, '.codex');
    const sessionsDir = join(codexHome, 'sessions');
    const cacheDir = join(root, 'cache');
    mkdirSync(sessionsDir, { recursive: true });
    const rolloutPath = join(sessionsDir, 'rollout-stale.jsonl');
    const records = [
      { timestamp: '2026-08-06T00:00:00.000Z', type: 'session_meta', payload: { id: 'stale-thread', cwd: '/repo' } },
      { timestamp: '2026-08-06T00:00:00.100Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-stale' } },
      { timestamp: '2026-08-06T00:00:00.200Z', type: 'event_msg', payload: { type: 'user_message', message: '未记录结束状态' } },
    ];
    writeFileSync(rolloutPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    utimesSync(rolloutPath, new Date(1_000), new Date(1_000));
    createStateDatabase(codexHome, [
      thread('stale-thread', rolloutPath, 'user', '{"app":"codex"}', '历史对话', 1_000),
    ], []);

    const catalog = createCodexConversationCatalog({
      codexHome,
      cacheDir,
      useBackgroundProcess: false,
      liveActivityWindowMs: 1_000,
      now: () => 10_000,
    });
    const conversation = await catalog.getConversation('stale-thread');
    const trajectory = await catalog.loadTaskTrajectory('stale-thread', 'turn-stale');

    assert.equal(conversation?.tasks[0]?.status, 'unknown');
    assert.equal(trajectory?.status, 'unknown');
  });
});

interface ThreadFixture {
  id: string;
  rolloutPath: string;
  threadSource: string | null;
  source: string;
  title: string;
  updatedAtMs: number;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'omk-conversation-catalog-'));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('timed out waiting for live trajectory');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function rollout(threadId: string): string {
  const records = [
    { timestamp: '2026-08-06T00:00:00.000Z', type: 'session_meta', payload: { id: threadId, session_id: threadId, cwd: '/repo', originator: 'Codex Desktop', model_provider: 'openai' } },
    { timestamp: '2026-08-06T00:00:00.100Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } },
    { timestamp: '2026-08-06T00:00:00.200Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一项任务' }] } },
    { timestamp: '2026-08-06T00:00:00.300Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-a', name: 'exec_command', input: '{"cmd":"pwd"}' } },
    { timestamp: '2026-08-06T00:00:00.400Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-a', output: '/repo' } },
    { timestamp: '2026-08-06T00:00:00.500Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a', last_agent_message: '完成第一项任务' } },
    { timestamp: '2026-08-06T00:01:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-b' } },
    { timestamp: '2026-08-06T00:01:00.100Z', type: 'event_msg', payload: { type: 'user_message', message: '第二项任务' } },
    { timestamp: '2026-08-06T00:01:00.200Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-b', last_agent_message: '完成第二项任务' } },
  ];
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function thread(
  id: string,
  rolloutPath: string,
  threadSource: string | null,
  source: string,
  title: string,
  updatedAtMs: number,
): ThreadFixture {
  return { id, rolloutPath, threadSource, source, title, updatedAtMs };
}

function createStateDatabase(
  codexHome: string,
  threads: ThreadFixture[],
  edges: Array<[string, string]>,
): void {
  mkdirSync(codexHome, { recursive: true });
  const database = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  database.exec(`
    create table threads (
      id text primary key,
      rollout_path text not null,
      created_at integer,
      updated_at integer,
      created_at_ms integer,
      updated_at_ms integer,
      source text,
      thread_source text,
      cwd text,
      title text,
      preview text,
      first_user_message text,
      archived integer,
      tokens_used integer,
      model text,
      reasoning_effort text,
      recency_at integer
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null
    );
  `);
  const insertThread = database.prepare(`
    insert into threads (
      id, rollout_path, created_at_ms, updated_at_ms, source, thread_source,
      cwd, title, preview, first_user_message, archived, tokens_used, model,
      reasoning_effort, recency_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of threads) {
    insertThread.run(
      item.id,
      item.rolloutPath,
      item.updatedAtMs - 100,
      item.updatedAtMs,
      item.source,
      item.threadSource,
      '/repo',
      item.title,
      item.title,
      item.title,
      0,
      100,
      'gpt-test',
      'medium',
      item.updatedAtMs,
    );
  }
  const insertEdge = database.prepare('insert into thread_spawn_edges (parent_thread_id, child_thread_id) values (?, ?)');
  for (const [parent, child] of edges) insertEdge.run(parent, child);
  database.close();
}
