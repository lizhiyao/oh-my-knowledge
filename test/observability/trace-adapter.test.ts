import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  loadCcSessions,
  loadTraceCorpus,
  segmentBySkill,
  segmentsToAnalysisEntries,
  tracesToAnalysisEntries,
  normalizeSkillName,
  type TraceSession,
} from '../../src/observability/trace-adapter.js';
import {
  buildObservationExperienceReport,
  compactObservationExperienceReport,
  normalizeObservationExperienceReport,
  projectTraceSessionTimeline,
} from '../../src/observability/experience.js';
import { isInstalledSkillAssetPath } from '../../src/observability/trace-attribution.js';
import { reconstructExperienceTurns } from '../../src/observability/turn-index.js';

// ---------- Helpers ----------

function jsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

function businessActionTag(name: string, text: string): string {
  const tag = ['ai', 'ma-cmd'].join('');
  return `<${tag} name="${name}">${text}</${tag}>`;
}

function businessChannel(): string {
  return ['ai', 'ma'].join('');
}

describe('source-neutral skill asset paths', () => {
  it('recognizes supported installation roots without provider-specific inbox logic', () => {
    const paths = [
      '/home/me/.agents/skills/audit/examples/schema.md',
      '/home/me/.claude/skills/audit/examples/schema.md',
      '/home/me/.codex/skills/audit/examples/schema.md',
      '/home/me/.codex/skills/.system/audit/examples/schema.md',
      '/home/me/.codex/plugins/cache/vendor/plugin/skills/audit/examples/schema.md',
      '/home/me/.openclaw/workspace-main/skills/audit/examples/schema.md',
      'C:\\Users\\me\\.codex\\skills\\audit\\examples\\schema.md',
    ];
    for (const path of paths) {
      assert.equal(isInstalledSkillAssetPath(path, 'audit'), true, path);
    }
    assert.equal(isInstalledSkillAssetPath('/repo/examples/skills/audit/schema.md', 'audit'), false);
    assert.equal(isInstalledSkillAssetPath('/home/me/.codex/skills/other/schema.md', 'audit'), false);
  });
});

function asstRec(uuid: string, content: unknown[], opts: { sessionId?: string; timestamp?: string; cwd?: string } = {}): object {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    sessionId: opts.sessionId ?? 's1',
    timestamp: opts.timestamp ?? '2026-04-19T10:00:00.000Z',
    cwd: opts.cwd ?? '/tmp/p',
    gitBranch: 'main',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-7',
      content,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}

function userRec(uuid: string, content: unknown, opts: { sessionId?: string; timestamp?: string } = {}): object {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: opts.sessionId ?? 's1',
    timestamp: opts.timestamp ?? '2026-04-19T10:00:00.000Z',
    message: { role: 'user', content },
  };
}

function writeSession(dir: string, name: string, records: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, jsonl(records));
  return path;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omk-obs-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- Load ----------

describe('loadCcSessions', () => {
  it('skip malformed lines, does not crash', () => {
    const path = writeSession(tmpDir, 'broken.jsonl', [{ type: 'permission-mode', sessionId: 's1' }]);
    writeFileSync(path, 'not-json-line\n' + jsonl([{ type: 'permission-mode', sessionId: 's1' }]));
    const sessions = loadCcSessions(path);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].runId, 's1');
  });

  it('ignores valid JSON primitives and does not synthesize empty sessions', () => {
    const path = join(tmpDir, 'non-records.jsonl');
    writeFileSync(path, 'null\n\"text\"\n[]\n{broken');
    assert.deepEqual(loadCcSessions(path), []);
  });

  it('reports malformed, ignored and unrecognized input instead of dropping it silently', () => {
    const path = join(tmpDir, 'mixed-input.jsonl');
    writeFileSync(path, [
      '{broken',
      'null',
      '[]',
      JSON.stringify({ type: 'future-record', sessionId: 's1' }),
    ].join('\n'));

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions.length, 1);
    assert.equal(corpus.sessions[0].sourceKind, 'unknown');
    assert.deepEqual(corpus.ingestion, {
      fileCount: 1,
      sourceRecordCount: 4,
      parsedRecordCount: 1,
      malformedRecordCount: 1,
      ignoredValueCount: 2,
      unknownEventCount: 1,
      filteredSessionCount: 0,
    });
    assert.equal(corpus.sessions[0].events[0].sourceIndex, 3);
  });

  it('streams JSONL without corrupting multi-byte UTF-8 across read chunks', () => {
    const text = '你'.repeat(30_000);
    const path = writeSession(tmpDir, 'chunked-utf8.jsonl', [{
      type: 'future-record',
      sessionId: 'chunked-utf8',
      payload: text,
    }]);

    const corpus = loadTraceCorpus(path);
    const [event] = corpus.sessions[0].events;
    assert.equal(event.eventKind, 'unknown');
    assert.equal(
      event.eventKind === 'unknown'
        ? (event.raw as { payload?: unknown }).payload
        : undefined,
      text,
    );
  });

  it('rejects an oversized complete JSONL record even when it ends with a newline', () => {
    const path = join(tmpDir, 'oversized-complete-record.jsonl');
    writeFileSync(path, `${'x'.repeat(32 * 1024 * 1024 + 1)}\n`);
    assert.throws(
      () => loadCcSessions(path),
      /trace JSONL 单条记录超过 33554432 字符上限/,
    );
  });

  it('recognizes Claude metadata-only traces without reporting known records as unknown', () => {
    const path = writeSession(tmpDir, 'claude-metadata.jsonl', [
      { type: 'mode', mode: 'normal', sessionId: 'claude-meta' },
      { type: 'permission-mode', permissionMode: 'default', sessionId: 'claude-meta' },
      { type: 'queue-operation', operation: 'enqueue', content: '/model', sessionId: 'claude-meta' },
      { type: 'file-history-snapshot', snapshot: {}, sessionId: 'claude-meta' },
    ]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions.length, 1);
    assert.equal(corpus.sessions[0].sourceKind, 'claude');
    assert.equal(corpus.sessions[0].runId, 'claude-meta');
    assert.deepEqual(corpus.sessions[0].events, []);
    assert.equal(corpus.ingestion.unknownEventCount, 0);
  });

  it('does not identify a generic system JSONL record as Claude without source identity', () => {
    const path = writeSession(tmpDir, 'generic-system.jsonl', [
      { type: 'system', message: 'service started', timestamp: '2026-04-19T10:00:00.000Z' },
    ]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions[0].sourceKind, 'unknown');
    assert.equal(corpus.sessions[0].events[0].eventKind, 'unknown');
    assert.equal(corpus.ingestion.unknownEventCount, 1);
  });

  it('maps Claude system evidence into source-neutral runtime and lifecycle events', () => {
    const path = writeSession(tmpDir, 'claude-system.jsonl', [
      userRec('u1', '检查配置', { sessionId: 'claude-system' }),
      {
        type: 'system',
        subtype: 'api_error',
        uuid: 'system-error',
        sessionId: 'claude-system',
        timestamp: '2026-04-19T10:00:01.000Z',
        error: { formatted: 'Unable to connect to API' },
      },
      {
        type: 'system',
        subtype: 'turn_duration',
        uuid: 'turn-duration',
        sessionId: 'claude-system',
        timestamp: '2026-04-19T10:00:02.000Z',
        durationMs: 1234,
      },
    ]);

    const corpus = loadTraceCorpus(path);
    const [runtime, lifecycle] = corpus.sessions[0].events.slice(1);
    assert.equal(runtime.eventKind, 'message');
    assert.equal(runtime.eventKind === 'message' ? runtime.role : undefined, 'system');
    assert.equal(runtime.eventKind === 'message' ? runtime.text : undefined, 'Unable to connect to API');
    assert.equal(lifecycle.eventKind, 'lifecycle');
    assert.equal(lifecycle.eventKind === 'lifecycle' ? lifecycle.phase : undefined, 'turn_completed');
    assert.equal(lifecycle.eventKind === 'lifecycle' ? lifecycle.durationMs : undefined, 1234);
    assert.equal(corpus.ingestion.unknownEventCount, 0);
  });

  it('does not report OpenClaw model metadata as unknown behavior', () => {
    const path = writeSession(tmpDir, 'openclaw-metadata.jsonl', [
      { type: 'session', id: 'openclaw-meta', timestamp: '2026-05-12T00:00:00.000Z' },
      { type: 'model_change', provider: 'openai', modelId: 'gpt-test' },
      {
        type: 'custom',
        customType: 'model-snapshot',
        data: { provider: 'openai', modelId: 'gpt-test', modelApi: 'responses' },
      },
      {
        type: 'message',
        id: 'u1',
        timestamp: '2026-05-12T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '检查配置' }] },
      },
    ]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions[0].sourceKind, 'openclaw');
    assert.equal(corpus.sessions[0].sourceMetadata?.model, 'gpt-test');
    assert.equal(corpus.sessions[0].events.some((event) => event.eventKind === 'unknown'), false);
    assert.equal(corpus.ingestion.unknownEventCount, 0);
  });

  it('fails closed when a discovered trace input cannot be read', () => {
    const brokenPath = join(tmpDir, 'broken.jsonl');
    symlinkSync(join(tmpDir, 'missing-target.jsonl'), brokenPath);
    assert.throws(
      () => loadTraceCorpus(tmpDir),
      (error: unknown) =>
        error instanceof Error
        && error.message === `无法读取 trace 输入项：${brokenPath}`,
    );
  });

  it('does not recurse forever or ingest a trace twice through directory symlink cycles', () => {
    const nested = join(tmpDir, 'nested');
    mkdirSync(nested);
    writeSession(nested, 'one.jsonl', [{ type: 'permission-mode', sessionId: 'one' }]);
    symlinkSync(tmpDir, join(nested, 'cycle'));

    const corpus = loadTraceCorpus(tmpDir);
    assert.equal(corpus.sessions.length, 1);
    assert.equal(corpus.sessions[0].runId, 'one');
    assert.equal(corpus.ingestion.fileCount, 1);
  });

  it('does not follow discovered trace symlinks outside the requested root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'omk-trace-outside-'));
    try {
      writeSession(outside, 'outside.jsonl', [{
        type: 'permission-mode',
        sessionId: 'outside',
      }]);
      symlinkSync(outside, join(tmpDir, 'outside-link'));
      writeSession(tmpDir, 'inside.jsonl', [{
        type: 'permission-mode',
        sessionId: 'inside',
      }]);

      const corpus = loadTraceCorpus(tmpDir);
      assert.deepEqual(corpus.sessions.map((session) => session.runId), ['inside']);
      assert.equal(corpus.ingestion.fileCount, 1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('accounts for filtered Codex guardian sessions', () => {
    const path = writeSession(tmpDir, 'guardian.jsonl', [{
      timestamp: '2026-07-25T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'guardian-1',
        source: { subagent: 'guardian' },
      },
    }]);

    const corpus = loadTraceCorpus(path);
    assert.deepEqual(corpus.sessions, []);
    assert.equal(corpus.ingestion.fileCount, 1);
    assert.equal(corpus.ingestion.parsedRecordCount, 1);
    assert.equal(corpus.ingestion.filteredSessionCount, 1);
  });

  it('recognizes a truncated Codex rollout without session_meta', () => {
    const path = writeSession(tmpDir, 'truncated-codex.jsonl', [{
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '继续检查。' }],
      },
    }]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions.length, 1);
    assert.equal(corpus.sessions[0].sourceKind, 'codex');
    assert.equal(corpus.sessions[0].runId, 'truncated-codex');
    assert.equal(corpus.sessions[0].entrypoint, undefined);
    assert.equal(
      corpus.sessions[0].events.some((event) =>
        event.eventKind === 'message' && event.role === 'user'
      ),
      true,
    );
  });

  it('keeps Codex user-message provenance while removing attachment envelopes from display text', () => {
    const rawText = [
      '# Files mentioned by the user:',
      '',
      '## screenshot.png: /private/tmp/screenshot.png',
      '',
      '## My request:',
      '为什么插件不可用？',
      '',
      '<image name=[Image #1] path="/private/tmp/screenshot.png">',
      '[image]',
      '</image>',
    ].join('\n');
    const path = writeSession(tmpDir, 'codex-attachment-envelope.jsonl', [{
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: rawText }],
      },
    }]);

    const corpus = loadTraceCorpus(path);
    const message = corpus.sessions[0].events.find((event) => event.eventKind === 'message');
    assert.equal(message?.eventKind, 'message');
    assert.equal(message?.eventKind === 'message' ? message.text : undefined, rawText);
    assert.equal(
      message?.eventKind === 'message' ? message.displayText : undefined,
      '为什么插件不可用？',
    );
    assert.deepEqual(
      message?.eventKind === 'message' ? message.attachments : undefined,
      [{ attachmentKind: 'image', name: 'screenshot.png' }],
    );
  });

  it('deduplicates mirrored Codex attachment messages by their semantic request', () => {
    const envelope = [
      '# Files mentioned by the user:',
      '',
      '## timeline.png: /private/tmp/timeline.png',
      '',
      '## My request:',
      '优化任务轨迹中的附件展示',
    ].join('\n');
    const path = writeSession(tmpDir, 'codex-attachment-mirror.jsonl', [
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: envelope },
            { type: 'input_text', text: '<image name="[Image #1]" path="/private/tmp/timeline.png">' },
            { type: 'input_image', image_url: 'data:image/png;base64,redacted' },
            { type: 'input_text', text: '</image>' },
          ],
        },
      },
      {
        timestamp: '2026-07-25T00:00:01.100Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: envelope },
      },
    ]);

    const [session] = loadCcSessions(path);
    const messages = session.events.filter((event) => event.eventKind === 'message');
    assert.equal(messages.length, 1);
    const [message] = messages;
    assert.equal(message?.eventKind, 'message');
    assert.equal(message?.eventKind === 'message' ? message.displayText : undefined, '优化任务轨迹中的附件展示');
    assert.deepEqual(
      message?.eventKind === 'message' ? message.attachments : undefined,
      [{ attachmentKind: 'image', name: 'timeline.png' }],
    );
  });

  it('keeps ambient browser state out of human-facing Codex task text', () => {
    const ambientContext = '<in-app-browser-context source="ambient-ui-state">\nCurrent URL: http://127.0.0.1:7799/\n</in-app-browser-context>';
    const humanText = '这个显示需要优化';
    const path = writeSession(tmpDir, 'codex-ambient-browser-context.jsonl', [
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: ambientContext }],
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `${ambientContext}\n\n${humanText}` }],
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const messages = session.events.filter((event) => event.eventKind === 'message');
    assert.deepEqual(messages.map((event) => ({
      origin: event.origin,
      displayText: event.displayText,
    })), [
      { origin: 'runtime', displayText: undefined },
      { origin: 'human', displayText: humanText },
    ]);
    assert.match(messages[1]?.eventKind === 'message' ? messages[1].text : '', /in-app-browser-context/);
  });

  it('does not classify an arbitrary payload-bearing JSONL record as Codex', () => {
    const path = writeSession(tmpDir, 'not-codex.jsonl', [{
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'response_item',
      payload: { applicationEvent: 'custom' },
    }]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions[0].sourceKind, 'unknown');
    assert.equal(corpus.sessions[0].events[0].eventKind, 'unknown');
  });

  it('fails closed when one JSONL file ambiguously matches multiple source adapters', () => {
    const path = writeSession(tmpDir, 'ambiguous-source.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-part' },
      },
      userRec('claude-part', '继续检查。', { sessionId: 'claude-part' }),
    ]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions.length, 1);
    assert.equal(corpus.sessions[0].sourceKind, 'unknown');
    assert.equal(corpus.sessions[0].events.length, 2);
    assert.equal(
      corpus.sessions[0].events.every((event) => event.eventKind === 'unknown'),
      true,
    );
    assert.equal(corpus.ingestion.unknownEventCount, 2);
  });

  it('projects Codex reasoning visibility while keeping other protocol metadata transparent', () => {
    const path = writeSession(tmpDir, 'known-codex-metadata.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'known-codex-metadata' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'reasoning', summary: [], encrypted_content: 'opaque-ciphertext-secret' },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'agent_reasoning', text: 'summary' },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: { type: 'thread_settings_applied', thread_settings: {} },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'world_state',
        payload: { full: true, state: {} },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'compacted',
        payload: { replacement_history: [] },
      },
      {
        timestamp: '2026-07-25T00:00:06.000Z',
        type: 'event_msg',
        payload: { type: 'context_compacted' },
      },
      {
        timestamp: '2026-07-25T00:00:07.000Z',
        type: 'event_msg',
        payload: { type: 'thread_goal_updated', goal: {} },
      },
      {
        timestamp: '2026-07-25T00:00:08.000Z',
        type: 'event_msg',
        payload: { type: 'web_search_end', call_id: 'web-1' },
      },
      {
        timestamp: '2026-07-25T00:00:09.000Z',
        type: 'event_msg',
        payload: { type: 'image_generation_end', call_id: 'image-1' },
      },
    ]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions.length, 1);
    assert.equal(corpus.sessions[0].events.length, 6);
    assert.deepEqual(corpus.sessions[0].events.map((event) => event.eventKind), [
      'model_activity',
      'model_activity',
      'runtime_context',
      'context_compaction',
      'context_compaction',
      'runtime_context',
    ]);
    const [opaque, plaintext, settings, compacted, contextCompacted, goal] = corpus.sessions[0].events;
    assert.equal(opaque?.eventKind === 'model_activity' ? opaque.contentVisibility : undefined, 'opaque');
    assert.equal(opaque?.eventKind === 'model_activity' ? opaque.text : undefined, undefined);
    assert.equal(plaintext?.eventKind === 'model_activity' ? plaintext.contentVisibility : undefined, 'plaintext');
    assert.equal(plaintext?.eventKind === 'model_activity' ? plaintext.text : undefined, 'summary');
    assert.equal(settings?.eventKind === 'runtime_context' ? settings.runtimeKind : undefined, 'settings');
    assert.equal(compacted?.eventKind === 'context_compaction' ? compacted.replacementItemCount : undefined, 0);
    assert.equal(contextCompacted?.eventKind, 'context_compaction');
    assert.equal(goal?.eventKind === 'runtime_context' ? goal.runtimeKind : undefined, 'goal');
    assert.doesNotMatch(JSON.stringify(corpus.sessions[0].events), /encrypted_content|opaque-ciphertext-secret/);
    assert.equal(corpus.ingestion.unknownEventCount, 0);
    assert.equal(corpus.ingestion.parsedRecordCount, 10);
  });

  it('normalizes nested Codex settings, goals, and cooperating-agent activity', () => {
    const path = writeSession(tmpDir, 'codex-runtime-context.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-runtime-context',
          originator: 'codex_desktop',
          cli_version: '0.128.0',
          model_provider: 'openai',
          base_instructions: { text: 'Base runtime instructions' },
          memory_mode: 'enabled',
          history_mode: 'legacy',
          context_window: { window_id: 'window-1' },
          dynamic_tools: [
            { namespace: 'codex_app', name: 'read_thread_terminal' },
            { name: 'exec_command' },
          ],
        },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-1',
          cwd: '/repo',
          workspace_roots: ['/repo', '/shared'],
          model: 'gpt-5.4',
          effort: 'high',
          personality: 'pragmatic',
          approval_policy: 'on-request',
          approvals_reviewer: 'user',
          permission_profile: { type: 'managed' },
          collaboration_mode: { mode: 'default' },
          realtime_active: false,
          multi_agent_mode: 'enabled',
          multi_agent_version: '2',
          user_instructions: 'Project instructions',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'thread_settings_applied',
          thread_settings: {
            model: 'gpt-5.4-mini',
            model_provider_id: 'openai',
            service_tier: 'priority',
            reasoning_effort: 'medium',
            reasoning_summary: 'auto',
            personality: 'concise',
            cwd: '/repo/changed',
            approval_policy: 'never',
            approvals_reviewer: 'auto_review',
            permission_profile: { type: 'managed' },
            collaboration_mode: { mode: 'plan' },
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'thread_goal_updated',
          goal: { objective: 'Ship the debugger', status: 'in_progress' },
        },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          event_id: 'activity-1',
          agent_thread_id: 'agent-1',
          agent_path: 'reviewer',
          kind: 'started',
        },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'agent_message',
          id: 'agent-message-1',
          author: 'reviewer',
          recipient: 'main',
          content: [{ type: 'output_text', text: 'Review completed' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-agent' },
        },
      },
      {
        timestamp: '2026-07-25T00:00:06.000Z',
        type: 'inter_agent_communication_metadata',
        payload: { trigger_turn: true },
      },
    ]);

    const corpus = loadTraceCorpus(path);
    const sessionContext = corpus.sessions[0].events.find((event) =>
      event.eventKind === 'runtime_context' && event.runtimeKind === 'session_context');
    assert.ok(sessionContext?.eventKind === 'runtime_context');
    assert.equal(sessionContext.runtimeName, 'codex_desktop');
    assert.equal(sessionContext.runtimeVersion, '0.128.0');
    assert.equal(sessionContext.memoryMode, 'enabled');
    assert.equal(sessionContext.historyMode, 'legacy');
    assert.equal(sessionContext.contextWindowId, 'window-1');
    assert.equal(sessionContext.instructions, 'Base runtime instructions');
    assert.deepEqual(sessionContext.availableTools, [
      'codex_app.read_thread_terminal',
      'exec_command',
    ]);

    const executionContext = corpus.sessions[0].events.find((event) =>
      event.eventKind === 'runtime_context' && event.runtimeKind === 'execution_context');
    assert.ok(executionContext?.eventKind === 'runtime_context');
    assert.equal(executionContext.reasoningEffort, 'high');
    assert.equal(executionContext.instructions, 'Project instructions');
    assert.equal(executionContext.realtimeActive, false);
    assert.equal(executionContext.permissionProfile, 'managed');

    const settings = corpus.sessions[0].events.find((event) =>
      event.eventKind === 'runtime_context' && event.runtimeKind === 'settings');
    assert.ok(settings?.eventKind === 'runtime_context');
    assert.equal(settings.model, 'gpt-5.4-mini');
    assert.equal(settings.modelProvider, 'openai');
    assert.equal(settings.serviceTier, 'priority');
    assert.equal(settings.approvalPolicy, 'never');
    assert.equal(settings.collaborationMode, 'plan');
    assert.equal(settings.permissionProfile, 'managed');

    const goal = corpus.sessions[0].events.find((event) =>
      event.eventKind === 'runtime_context' && event.runtimeKind === 'goal');
    assert.ok(goal?.eventKind === 'runtime_context');
    assert.equal(goal.goal, 'Ship the debugger');
    assert.equal(goal.goalStatus, 'in_progress');

    const activities = corpus.sessions[0].events.filter((event) => event.eventKind === 'agent_activity');
    assert.equal(activities.length, 2);
    assert.deepEqual(activities.map((event) => event.eventKind === 'agent_activity'
      ? [event.activityKind, event.activity, event.text, event.turnId]
      : []), [
      ['status', 'started', undefined, 'turn-1'],
      ['communication', undefined, 'Review completed', 'turn-agent'],
    ]);
    assert.equal(corpus.ingestion.unknownEventCount, 0);
  });

  it('extracts every supported Codex reasoning plaintext shape and deduplicates mirrored summaries', () => {
    const path = writeSession(tmpDir, 'codex-reasoning-plaintext.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-reasoning-plaintext' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'agent_reasoning', text: 'First summary' },
      },
      {
        timestamp: '2026-07-25T00:00:01.004Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'First summary' }, 'Second summary'],
          encrypted_content: 'ciphertext',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'reasoning', summary: [], content: [{ type: 'text', text: 'Visible content' }] },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'reasoning', text: 'Visible text' },
      },
    ]);

    const events = loadTraceCorpus(path).sessions[0].events;
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((event) => event.eventKind === 'model_activity' ? event.contentSource : undefined), [
      'summary',
      'content',
      'text',
    ]);
    assert.deepEqual(events.map((event) => event.eventKind === 'model_activity' ? event.text : undefined), [
      'First summary\n\nSecond summary',
      'Visible content',
      'Visible text',
    ]);
    assert.doesNotMatch(JSON.stringify(events), /ciphertext/);
  });

  it('uses patch_apply_end as the authoritative apply_patch result', () => {
    const path = writeSession(tmpDir, 'codex-patch-outcome.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-patch-outcome' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'patch-1',
          name: 'apply_patch',
          input: '*** Begin Patch',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'patch_apply_end',
          call_id: 'patch-1',
          success: false,
          status: 'failed',
          stderr: 'patch failed',
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'patch-1',
          output: 'Success. Updated the following files:',
        },
      },
    ]);

    const corpus = loadTraceCorpus(path);
    const result = corpus.sessions[0].events.find((event) => event.eventKind === 'tool_result');
    assert.equal(result?.eventKind, 'tool_result');
    if (result?.eventKind !== 'tool_result') assert.fail('expected tool result');
    assert.equal(result.status, 'failure');
    assert.equal(result.statusSource, 'runtime');
    assert.equal(corpus.ingestion.unknownEventCount, 0);
  });

  it('treats a completed Codex exec envelope as success despite failure-shaped source text', () => {
    const path = writeSession(tmpDir, 'codex-exec-completed.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-exec-completed' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'exec-1',
          name: 'exec',
          input: 'const result = await tools.exec_command({"cmd":"rg status src"});',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'exec-1',
          output: 'Script completed\nOutput:\nstatus: failure is a source field',
        },
      },
    ]);

    const corpus = loadTraceCorpus(path);
    const result = corpus.sessions[0].events.find((event) => event.eventKind === 'tool_result');
    assert.equal(result?.eventKind, 'tool_result');
    if (result?.eventKind !== 'tool_result') assert.fail('expected tool result');
    assert.equal(result.status, 'success');
    assert.equal(result.statusSource, 'inferred');
  });

  it('recovers a complete apply_patch pair from a truncated patch_apply_end', () => {
    const path = writeSession(tmpDir, 'codex-truncated-patch.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-truncated-patch' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'patch_apply_end',
          call_id: 'patch-1',
          success: true,
          status: 'completed',
          stdout: 'Success. Updated the following files:',
        },
      },
    ]);

    const corpus = loadTraceCorpus(path);
    const events = corpus.sessions[0].events;
    assert.equal(events.filter((event) => event.eventKind === 'tool_call').length, 1);
    const result = events.find((event) => event.eventKind === 'tool_result');
    assert.equal(result?.eventKind, 'tool_result');
    if (result?.eventKind !== 'tool_result') assert.fail('expected tool result');
    assert.equal(result.status, 'success');
    assert.equal(result.statusSource, 'runtime');
    assert.equal(corpus.ingestion.unknownEventCount, 0);
  });

  it('recognizes Codex rate-limit-only token snapshots without inventing usage', () => {
    const path = writeSession(tmpDir, 'codex-rate-limit-snapshot.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-rate-limit-snapshot' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: null,
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 8, window_minutes: 300 },
          },
        },
      },
    ]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions[0].events.length, 0);
    assert.equal(corpus.ingestion.unknownEventCount, 0);
  });

  it('still reports genuinely unknown Codex protocol additions', () => {
    const path = writeSession(tmpDir, 'unknown-codex-event.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'unknown-codex-event' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'future_protocol_event' },
      },
    ]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions[0].events[0].eventKind, 'unknown');
    assert.equal(corpus.ingestion.unknownEventCount, 1);
  });

  it('loads multiple JSONL from directory', () => {
    writeSession(tmpDir, 'a.jsonl', [{ type: 'permission-mode', sessionId: 'sa' }]);
    writeSession(tmpDir, 'b.jsonl', [{ type: 'permission-mode', sessionId: 'sb' }]);
    const sessions = loadCcSessions(tmpDir);
    assert.equal(sessions.length, 2);
    const ids = sessions.map((s) => s.runId).sort();
    assert.deepEqual(ids, ['sa', 'sb']);
  });

  it('groups subagents JSONL under the parent session folder', () => {
    const sessionDir = join(tmpDir, 'sessionA');
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    writeSession(sessionDir, 'main.jsonl', [
      userRec('u-main', '<command-name>/main-skill</command-name>', { sessionId: 'sessionA', timestamp: '2026-05-01T00:00:00.000Z' }),
      asstRec('a-main', [{ type: 'tool_use', id: 'task1', name: 'Task', input: { prompt: 'delegate' } }], { sessionId: 'sessionA', timestamp: '2026-05-01T00:00:01.000Z' }),
    ]);
    writeSession(subagentsDir, 'x1.jsonl', [
      userRec('u-x1', '<command-name>/child-skill</command-name>', { sessionId: 'child-1', timestamp: '2026-05-01T00:00:02.000Z' }),
      asstRec('a-x1', [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: '/tmp/a.md' } }], { sessionId: 'child-1', timestamp: '2026-05-01T00:00:03.000Z' }),
    ]);

    const sessions = loadCcSessions(sessionDir).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    assert.equal(sessions.length, 2);
    assert.deepEqual(new Set(sessions.map((session) => session.rootRunId)), new Set(['sessionA']));
    assert.deepEqual(sessions.map((session) => session.role).sort(), ['main', 'subagent']);

    const { segments } = tracesToAnalysisEntries(sessionDir);
    const child = segments.find((segment) => segment.skillName === 'child-skill');
    assert.ok(child);
    assert.equal(child.sessionId, 'sessionA');
    assert.equal(child.traceSessionId, 'child-1');
    assert.equal(child.traceRole, 'subagent');
    assert.ok(child.sourceTrace?.endsWith('subagents/x1.jsonl'));

    const experience = buildObservationExperienceReport({
      sessions,
      segments: sessions.flatMap((session) => segmentBySkill(session)),
      items: [],
      generatedAt: '2026-05-01T00:00:04.000Z',
    });
    const reversedExperience = buildObservationExperienceReport({
      sessions: [...sessions].reverse(),
      segments: [...sessions].reverse().flatMap((session) => segmentBySkill(session)),
      items: [],
      generatedAt: '2026-05-01T00:00:04.000Z',
    });
    assert.deepEqual(
      reversedExperience.storyContexts,
      experience.storyContexts,
      'canonical session stories must not depend on skill traversal order',
    );
    assert.equal(experience.storyContexts[0].goalSlices.length, 2);
    assert.ok(experience.sessions.every((session) =>
      session.sessionStory?.goalSliceCount === experience.storyContexts[0].goalSlices.length
    ));
    const compact = compactObservationExperienceReport(experience);
    const branch = compact.traceTimelines[0].tree.branches[0];
    assert.ok(branch);
    const wrongBranchTrace = structuredClone(compact);
    wrongBranchTrace.traceTimelines[0].tree.branches[0].sourceTrace = '/wrong/trace.jsonl';
    assert.equal(normalizeObservationExperienceReport(wrongBranchTrace), null);
    const danglingBranchAttachment = structuredClone(compact);
    danglingBranchAttachment.traceTimelines[0].tree.branches[0].attachTo = {
      sourceTrace: compact.traceTimelines[0].tree.main[0].sourceTrace,
      toolUseId: 'missing-tool-use',
    };
    assert.equal(normalizeObservationExperienceReport(danglingBranchAttachment), null);
    const mismatchedDispatch = structuredClone(compact);
    mismatchedDispatch.storyContexts[0].subagentDispatches[0].eventCount += 1;
    assert.equal(normalizeObservationExperienceReport(mismatchedDispatch), null);

    const duplicateTimelineStore = structuredClone(compact);
    const alternateTimelineId = `${duplicateTimelineStore.traceTimelines[0].id}:duplicate`;
    duplicateTimelineStore.traceTimelines.push({
      ...structuredClone(duplicateTimelineStore.traceTimelines[0]),
      id: alternateTimelineId,
    });
    const alternateTimelineSession = duplicateTimelineStore.sessions[1];
    assert.ok(alternateTimelineSession);
    alternateTimelineSession.timelineRef = alternateTimelineId;
    for (const invocationId of alternateTimelineSession.invocationIds) {
      const invocation = duplicateTimelineStore.invocations.find(
        (candidate) => candidate.id === invocationId,
      );
      assert.ok(invocation);
      invocation.timelineRef = alternateTimelineId;
    }
    assert.equal(normalizeObservationExperienceReport(duplicateTimelineStore), null);

    const duplicateStoryStore = structuredClone(compact);
    const alternateStoryId = `${duplicateStoryStore.storyContexts[0].id}:duplicate`;
    duplicateStoryStore.storyContexts.push({
      ...structuredClone(duplicateStoryStore.storyContexts[0]),
      id: alternateStoryId,
    });
    const alternateStorySession = duplicateStoryStore.sessions[1];
    assert.ok(alternateStorySession?.sessionStory);
    alternateStorySession.sessionStory.contextRef = alternateStoryId;
    assert.equal(normalizeObservationExperienceReport(duplicateStoryStore), null);
  });

  it('loads agent markdown logs', () => {
    const path = join(tmpDir, 'agent.log');
    writeFileSync(path, `---
## [2026/04/09 16:22:55] 对话记录 (SDK)
**工作目录**: /tmp/agent
**会话 ID**: oc-1
**请求 ID**: r1

### 用户输入
请优先调用 design-coding-create-template skill 处理。

### AI 回复
我会先处理当前模板。
`);
    const sessions = loadCcSessions(path);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].runId, 'oc-1');
    assert.equal(sessions[0].cwd, '/tmp/agent');
    assert.equal(sessions[0].startTimestamp, undefined);
    assert.ok(sessions[0].events.every((event) => event.timestamp === undefined));
    const segs = segmentBySkill(sessions[0]);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'design-coding-create-template');
    assert.equal(segs[0].attribution?.source, 'command-name');
  });

  it('normalizes markdown wall-clock timestamps only when an offset is explicit', () => {
    const path = join(tmpDir, 'agent-with-offset.log');
    writeFileSync(path, `---
## [2026/04/09 16:22:55 +08:00] 对话记录 (SDK)
**会话 ID**: offset-session
**请求 ID**: r1

### 用户输入
请调用 audit skill。

### AI 回复
完成。
`);
    const [session] = loadCcSessions(path);
    assert.ok(session);
    assert.equal(session.startTimestamp, '2026-04-09T08:22:55.000Z');
    assert.ok(session.events.every((event) => event.timestamp === '2026-04-09T08:22:55.000Z'));
  });

  it('does not synthesize wall-clock time for malformed markdown timestamps', () => {
    const path = join(tmpDir, 'invalid-time.log');
    writeFileSync(path, `---
## [not-a-timestamp] 对话记录 (SDK)
**会话 ID**: invalid-time
**请求 ID**: r1

### 用户输入
请调用 audit skill。

### AI 回复
完成。
`);
    const [session] = loadCcSessions(path);
    assert.ok(session);
    assert.equal(session.startTimestamp, undefined);
    assert.ok(session.events.every((event) => event.timestamp === undefined));
    const first = segmentBySkill(session);
    const second = segmentBySkill(session);
    assert.deepEqual(
      first.map((segment) => [segment.startTimestamp, segment.endTimestamp]),
      second.map((segment) => [segment.startTimestamp, segment.endTimestamp]),
    );
    assert.deepEqual(
      first.map((segment) => [segment.startTimestamp, segment.endTimestamp]),
      [['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z']],
    );
    assert.equal(first[0].timestampObserved, false);
  });

  it('does not borrow a prior segment or session timestamp for untimestamped events', () => {
    const path = join(tmpDir, 'partial-time.jsonl');
    writeFileSync(path, jsonl([
      {
        type: 'user',
        uuid: 'u0',
        parentUuid: null,
        sessionId: 'partial-time',
        timestamp: '2026-07-25T00:00:00.000Z',
        message: { role: 'user', content: '先讨论别的问题。' },
      },
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: 'u0',
        sessionId: 'partial-time',
        message: { role: 'user', content: '<command-name>/audit</command-name>\n检查实现。' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 'partial-time',
        message: { role: 'assistant', content: [{ type: 'text', text: '检查完成。' }] },
      },
    ]));

    const [session] = loadCcSessions(path);
    assert.equal(session.startTimestamp, '2026-07-25T00:00:00.000Z');
    const segments = segmentBySkill(session);
    assert.equal(segments.length, 2);
    assert.equal(segments[1].skillName, 'audit');
    assert.equal(segments[1].timestampObserved, false);
    assert.equal(segments[1].startTimestamp, '1970-01-01T00:00:00.000Z');
  });

  it('loads OpenClaw JSONL and adapts toolCall/toolResult records', () => {
    const path = join(tmpDir, 'openclaw.jsonl');
    writeFileSync(path, jsonl([
      { type: 'session', version: 3, id: 'oc-1', timestamp: '2026-05-12T00:00:00.000Z', cwd: '/tmp/example/.openclaw/workspace' },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `Conversation info (untrusted metadata):\n\`\`\`json\n{"channel":"${businessChannel()}","sender":"示例用户","sender_id":"example-sender"}\n\`\`\`\n\n帮我写一个 PRD\n${businessActionTag('prd-create', '请生成 PRD')}` }],
        },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-05-12T00:00:02.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-5.5',
          provider: 'openai-codex',
          content: [
            { type: 'toolCall', id: 'call-read-skill', name: 'read', arguments: { path: '/tmp/example/.openclaw/workspace/skills/prd-create/SKILL.md' } },
          ],
          usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0 },
        },
      },
      {
        type: 'message',
        id: 'tr1',
        parentId: 'a1',
        timestamp: '2026-05-12T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-read-skill',
          toolName: 'read',
          content: [{ type: 'text', text: '# PRD Creation Skill' }],
          isError: false,
        },
      },
    ]));

    const sessions = loadCcSessions(path);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].runId, 'oc-1');
    assert.equal(sessions[0].sourceKind, 'openclaw');
    assert.equal(sessions[0].entrypoint, 'openclaw');
    assert.equal(sessions[0].cwd, '/tmp/example/.openclaw/workspace');
    assert.deepEqual(sessions[0].sourceMetadata, {
      channel: businessChannel(),
      sender: '示例用户',
      senderId: 'example-sender',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      businessActions: ['prd-create'],
    });
    const segs = segmentBySkill(sessions[0]);
    const skill = segs.find((seg) => seg.skillName === 'prd-create');
    assert.ok(skill);
    assert.equal(skill.sourceKind, 'openclaw');
    assert.equal(skill.attribution?.source, 'business-action');
    assert.equal(skill.attribution?.commandName, 'prd-create');
    const sourceTool = sessions[0].events.find((event) =>
      event.eventKind === 'tool_call' && event.callId === 'call-read-skill',
    );
    assert.ok(sourceTool?.eventKind === 'tool_call');
    assert.equal(sourceTool.tool.name, 'Read');
    assert.equal(sourceTool.tool.sourceName, 'read');
    assert.equal(skill.toolCalls[0].tool, 'Read');
    assert.equal((skill.toolCalls[0].input as { file_path?: string }).file_path, '/tmp/example/.openclaw/workspace/skills/prd-create/SKILL.md');
    assert.equal(skill.toolCalls[0].success, true);
    assert.equal(skill.metrics.inputTokens, 10);
    assert.equal(skill.metrics.cacheReadTokens, 3);
  });

  it('keeps Claude tool results unknown without explicit status', () => {
    const path = writeSession(tmpDir, 'claude-unknown-tool-result.jsonl', [
      asstRec('a1', [{
        type: 'tool_use',
        id: 'read-audit',
        name: 'Read',
        input: { file_path: '/repo/.agents/skills/audit/SKILL.md' },
      }]),
      userRec('u1', [{
        type: 'tool_result',
        tool_use_id: 'read-audit',
        content: '# audit',
      }]),
    ]);

    const [session] = loadCcSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'unknown');
    assert.equal(result.statusSource, 'unknown');
    const [segment] = segmentBySkill(session);
    assert.equal(segment.metrics.numToolFailures, 0);
    assert.equal(segment.metrics.numToolUnknown, 1);
  });

  it('normalizes Claude MCP calls into the shared provider identity', () => {
    const path = writeSession(tmpDir, 'claude-mcp-tool.jsonl', [
      asstRec('a1', [{
        type: 'tool_use',
        id: 'github-readme',
        name: 'mcp__github__fetch_file',
        input: { path: 'README.md' },
      }]),
      userRec('u1', [{
        type: 'tool_result',
        tool_use_id: 'github-readme',
        content: '# omk',
        is_error: false,
      }]),
    ]);

    const [session] = loadCcSessions(path);
    const call = session.events.find((event) =>
      event.eventKind === 'tool_call' && event.callId === 'github-readme',
    );
    assert.ok(call?.eventKind === 'tool_call');
    assert.equal(call.tool.name, 'github.fetch_file');
    assert.equal(call.tool.sourceName, 'mcp__github__fetch_file');
    assert.equal(call.tool.namespace, 'mcp__github');
    assert.equal(call.tool.provider, 'github');
    const [toolCall] = segmentBySkill(session)[0].toolCalls;
    assert.equal(toolCall.tool, 'github.fetch_file');
    assert.equal(toolCall.sourceTool, 'mcp__github__fetch_file');
    assert.equal(toolCall.toolProvider, 'github');
  });

  it('loads Codex rollout JSONL with skill attribution, tools, tokens, and parent task metadata', () => {
    const path = join(tmpDir, 'rollout-codex.jsonl');
    writeFileSync(path, jsonl([
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-child',
          session_id: 'codex-parent',
          parent_thread_id: 'codex-parent',
          cwd: '/repo-codex',
          originator: 'Codex Desktop',
          thread_source: 'subagent',
          model_provider: 'openai',
          git: { branch: 'main' },
        },
      },
      {
        timestamp: '2026-07-25T00:00:00.100Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', cwd: '/repo-codex', model: 'gpt-codex-test' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'user-1',
          role: 'user',
          content: [{ type: 'input_text', text: '审计收入字段。' }],
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'call-item-read',
          call_id: 'call-read',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: "sed -n '1,220p' .agents/skills/audit/SKILL.md",
            workdir: '/repo-codex',
          }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-read',
          output: '# Audit Skill',
        },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'call-item-search',
          call_id: 'call-search',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: 'rg revenue_schema src',
            workdir: '/repo-codex',
          }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:06.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-search',
          output: 'Process exited with code 1\nFinal output:\nNo matches found',
        },
      },
      {
        timestamp: '2026-07-25T00:00:07.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 40,
              cache_write_input_tokens: 2,
              output_tokens: 15,
            },
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:08.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'assistant-1',
          role: 'assistant',
          content: [{ type: 'output_text', text: '没有找到该字段。' }],
        },
      },
      {
        timestamp: '2026-07-25T00:00:09.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1' },
      },
    ]));

    const [session] = loadCcSessions(path);
    assert.equal(session.runId, 'codex-child');
    assert.equal(session.rootRunId, 'codex-parent');
    assert.equal(session.role, 'subagent');
    assert.equal(session.sourceKind, 'codex');
    assert.equal(session.entrypoint, 'codex-desktop');
    assert.equal(session.cwd, '/repo-codex');
    assert.equal(session.gitBranch, 'main');
    assert.deepEqual(session.sourceMetadata, {
      provider: 'openai',
      model: 'gpt-codex-test',
      modelApi: 'codex',
    });

    const segments = segmentBySkill(session);
    const audit = segments.find((segment) => segment.skillName === 'audit');
    assert.ok(audit);
    assert.equal(audit.attribution?.source, 'read-skill-md');
    assert.equal(audit.sourceKind, 'codex');
    assert.equal(audit.toolCalls.length, 2);
    assert.deepEqual(audit.toolCalls.map((tool) => tool.tool), ['Bash', 'Bash']);
    assert.equal((audit.toolCalls[0].input as { command?: string }).command?.includes('.agents/skills/audit/SKILL.md'), true);
    assert.match(String(audit.toolCalls[1].output), /No matches found/);
    assert.equal(audit.toolCalls[1].success, false);
    assert.equal(audit.metrics.numToolFailures, 1);
    assert.equal(audit.metrics.inputTokens, 78);
    assert.equal(audit.metrics.outputTokens, 15);
    assert.equal(audit.metrics.cacheReadTokens, 40);
    assert.equal(audit.metrics.cacheCreationTokens, 2);
    assert.equal(
      audit.metrics.inputTokens
        + audit.metrics.outputTokens
        + audit.metrics.cacheReadTokens
        + audit.metrics.cacheCreationTokens,
      135,
    );
  });

  it('deduplicates only matching Codex event messages and preserves unmatched protocol records', () => {
    const path = writeSession(tmpDir, 'codex-hybrid-messages.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-hybrid', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'response-user',
          role: 'user',
          content: [{ type: 'input_text', text: 'same user message' }],
        },
      },
      {
        timestamp: '2026-07-25T00:00:01.500Z',
        type: 'session_meta',
        payload: { id: 'codex-hybrid', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'same user message' },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'event-only user message' },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'same assistant message' },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'response-assistant',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'same assistant message' }],
        },
      },
      {
        timestamp: '2026-07-25T00:00:06.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'event-only assistant message' },
      },
      {
        timestamp: '2026-07-25T00:00:07.100Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'repeated-user-first-turn',
          role: 'user',
          content: [{ type: 'input_text', text: 'repeat this intentionally' }],
        },
      },
      {
        timestamp: '2026-07-25T00:00:07.200Z',
        type: 'event_msg',
        payload: { type: 'task_complete' },
      },
      {
        timestamp: '2026-07-25T00:00:07.300Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'repeat this intentionally' },
      },
      {
        timestamp: '2026-07-25T00:00:07.400Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'developer-context',
          role: 'developer',
          content: [{ type: 'input_text', text: 'runtime policy' }],
        },
      },
      {
        timestamp: '2026-07-25T00:00:08.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'read-audit',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'cat .agents/skills/audit/SKILL.md' }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:09.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'read-audit',
          output: 'Process exited with code 0\nFinal output:\n# audit',
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    assert.equal(session.events.some((event) => (
      event.sourceType.startsWith('session_meta:')
      && event.eventKind === 'runtime_context'
      && event.runtimeKind === 'session_context'
    )), true);
    const messages = session.events.filter((event) => event.eventKind === 'message');
    assert.deepEqual(
      messages.map((event) => [event.role, event.origin, event.text]),
      [
        ['user', 'human', 'same user message'],
        ['user', 'human', 'event-only user message'],
        ['assistant', 'synthetic', 'same assistant message'],
        ['assistant', 'synthetic', 'event-only assistant message'],
        ['user', 'human', 'repeat this intentionally'],
        ['user', 'human', 'repeat this intentionally'],
        ['system', 'runtime', 'runtime policy'],
      ],
    );

    const experience = buildObservationExperienceReport({
      sessions: [session],
      segments: segmentBySkill(session),
      items: [],
      generatedAt: '2026-07-25T00:00:10.000Z',
    });
    assert.ok(experience.sessions[0].timelinePreview.some((event) =>
      event.kind === 'runtime_context'
      && event.label === 'system context'
      && event.fullText === 'runtime policy'));
    assert.equal(experience.sessions[0].evidenceChain.runtimeContextCount > 0, true);
    assert.equal(experience.sessions[0].evidenceChain.userMessageCount, 1);
  });

  it('preserves distinct Codex runtime entrypoints', () => {
    const cases = [
      ['Codex Desktop', 'codex-desktop'],
      ['codex_sdk_ts', 'codex-sdk'],
      ['codex_vscode', 'codex-vscode'],
      ['codex-tui', 'codex-cli'],
      ['codex_exec', 'codex-cli'],
      ['claudian', 'claudian'],
      ['other integration', 'codex-other-integration'],
    ] as const;

    for (const [originator, expected] of cases) {
      const path = writeSession(tmpDir, `codex-entrypoint-${expected}-${originator}.jsonl`, [{
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: `codex-entrypoint-${originator}`,
          cwd: '/repo',
          originator,
          model_provider: 'openai',
        },
      }]);
      assert.equal(loadCcSessions(path)[0].entrypoint, expected);
    }
  });

  it('infers Codex success only from explicit runtime wrapper evidence', () => {
    const records: unknown[] = [{
      timestamp: '2026-07-25T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-explicit-success', cwd: '/repo', model_provider: 'openai' },
    }];
    const outputs = [
      ['bash-ok', 'exec_command', 'Process exited with code 0\nFinal output:\nok'],
      ['edit-ok', 'apply_patch', 'Exit code: 0\nSuccess. Updated the following files:\nM src/a.ts'],
      ['exec-ok', 'exec', 'Script completed\nWall time 1.0 seconds\nOutput:\nok'],
      ['image-ok', 'view_image', '[image]'],
      ['ambiguous', 'custom_tool', 'request returned data'],
      ['failed', 'exec_command', 'Process exited with code 2\nFinal output:\nerror'],
    ] as const;
    outputs.forEach(([callId, name, output], index) => {
      records.push({
        timestamp: `2026-07-25T00:00:${String(index * 2 + 1).padStart(2, '0')}.000Z`,
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: callId,
          name,
          arguments: '{}',
        },
      }, {
        timestamp: `2026-07-25T00:00:${String(index * 2 + 2).padStart(2, '0')}.000Z`,
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: callId,
          output,
        },
      });
    });
    const path = writeSession(tmpDir, 'codex-explicit-success.jsonl', records);

    const [session] = loadCcSessions(path);
    const results = session.events.filter((event) => event.eventKind === 'tool_result');
    assert.deepEqual(
      results.map((result) => [result.callId, result.status, result.statusSource]),
      [
        ['bash-ok', 'success', 'inferred'],
        ['edit-ok', 'success', 'inferred'],
        ['exec-ok', 'success', 'inferred'],
        ['image-ok', 'success', 'inferred'],
        ['ambiguous', 'unknown', 'unknown'],
        ['failed', 'failure', 'inferred'],
      ],
    );
  });

  it('recognizes source.subagent metadata even when legacy Codex records omit thread_source', () => {
    const path = writeSession(tmpDir, 'codex-review-subagent.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-review',
          cwd: '/repo',
          model_provider: 'openai',
          source: { subagent: 'review' },
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    assert.equal(session.role, 'subagent');
    assert.equal(session.rootRunId, 'codex-review');
    assert.equal(session.label, 'subagent/codex-review');
  });

  it('normalizes Codex turn_aborted as an interrupted session signal', () => {
    const path = join(tmpDir, 'rollout-codex-aborted.jsonl');
    writeFileSync(path, jsonl([
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-aborted',
          cwd: '/repo-codex',
          originator: 'Codex Desktop',
          model_provider: 'openai',
        },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '审计配置。' }],
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'read-skill',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'cat .agents/skills/audit/SKILL.md' }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'read-skill', output: '# Audit Skill' },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'turn_aborted',
          turn_id: 'turn-1',
          reason: 'interrupted',
          completed_at: '2026-07-25T00:00:04.000Z',
          duration_ms: 3500,
        },
      },
    ]));

    const [session] = loadCcSessions(path);
    const interrupted = session.events.find((event) =>
      event.eventKind === 'lifecycle' && event.phase === 'turn_aborted') as
      | { eventKind: string; phase: string; reason?: string; durationMs?: number; timestamp?: string; turnId?: string }
      | undefined;
    assert.equal(interrupted?.eventKind, 'lifecycle');
    assert.equal(interrupted?.phase, 'turn_aborted');
    assert.equal(interrupted?.timestamp, '2026-07-25T00:00:04.000Z');
    assert.equal(interrupted?.turnId, 'turn-1');
    assert.equal(interrupted?.reason, 'interrupted');
    assert.equal(interrupted?.durationMs, 3500);

    const segments = segmentBySkill(session);
    const experience = buildObservationExperienceReport({
      sessions: [session],
      segments,
      items: [],
      generatedAt: '2026-07-25T00:00:05.000Z',
    });
    assert.equal(experience.sessions[0].indicators.sessionInterruptedCount, 1);
    assert.equal(
      experience.sessions[0].ruleFindings.some((finding) => finding.code === 'session_interrupted_seen'),
      true,
    );
  });

  it('preserves Codex turn_interrupted as a terminal Trace IR event', () => {
    const path = writeSession(tmpDir, 'rollout-codex-interrupted.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-interrupted',
          cwd: '/repo-codex',
          originator: 'Codex Desktop',
          model_provider: 'openai',
        },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: '执行长任务。' },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'turn_interrupted',
          turn_id: 'turn-1',
          reason: 'user_cancelled',
          duration_ms: 3000,
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const interrupted = session.events.find((event) =>
      event.eventKind === 'lifecycle' && event.phase === 'turn_interrupted');
    assert.ok(interrupted && interrupted.eventKind === 'lifecycle');
    assert.equal(interrupted.turnId, 'turn-1');
    assert.equal(interrupted.reason, 'user_cancelled');
    assert.equal(interrupted.durationMs, 3000);
    assert.equal(session.events.some((event) => event.eventKind === 'unknown'
      && event.sourceType === 'event_msg:turn_interrupted'), false);

    const turns = reconstructExperienceTurns(projectTraceSessionTimeline(session));
    assert.equal(turns[0]?.status, 'interrupted');
  });

  it('handles Codex desktop exec calls, duplicate token snapshots, and per-turn models', () => {
    const path = join(tmpDir, 'rollout-codex-desktop.jsonl');
    writeFileSync(path, jsonl([
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-desktop',
          session_id: 'codex-desktop',
          cwd: '/repo-codex',
          originator: 'Codex Desktop',
          model_provider: 'openai',
        },
      },
      {
        timestamp: '2026-07-25T00:00:00.100Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model: 'gpt-5.5' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'read-alpha',
          name: 'exec',
          input: 'const result = await tools.exec_command({"cmd": "sed -n \'1,200p\' .agents/skills/alpha/SKILL.md"});',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'read-alpha', output: '# Alpha Skill' },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 100, output_tokens: 10 },
            total_token_usage: { input_tokens: 100, output_tokens: 10 },
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.100Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 100, output_tokens: 10 },
            total_token_usage: { input_tokens: 100, output_tokens: 10 },
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-2', model: 'gpt-5.6-sol' },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'read-beta',
          name: 'exec',
          input: "const result = await tools.exec_command({'cmd': 'cat .agents/skills/beta/SKILL.md'});",
        },
      },
      {
        timestamp: '2026-07-25T00:00:06.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'read-beta', output: '# Beta Skill' },
      },
      {
        timestamp: '2026-07-25T00:00:07.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 80, output_tokens: 8 },
            total_token_usage: { input_tokens: 180, output_tokens: 18 },
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:08.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'post-review',
          name: 'exec',
          input: [
            'const body = `Example only: tools.exec_command({cmd:"cat .agents/skills/phantom-skill/SKILL.md"})`;',
            'const cmd = "gh api repos/example/project/pulls/1/comments";',
            'await tools.exec_command({cmd});',
          ].join('\n'),
        },
      },
      {
        timestamp: '2026-07-25T00:00:09.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'post-review', output: '{"ok":true}' },
      },
      {
        timestamp: '2026-07-25T00:00:10.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'run-test',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: 'node -e "console.log(\'cat .agents/skills/phantom-bash/SKILL.md\')"',
          }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:11.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'run-test', output: 'ok' },
      },
      {
        timestamp: '2026-07-25T00:00:12.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'read-example',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: "sed -n '1,200p' examples/agent-eval/skills/fixture/SKILL.md",
          }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:13.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'read-example', output: '# Fixture under review' },
      },
    ]));

    const [session] = loadCcSessions(path);
    assert.equal(session.sourceMetadata?.model, 'gpt-5.5, gpt-5.6-sol');

    const segments = segmentBySkill(session);
    const alpha = segments.find((segment) => segment.skillName === 'alpha');
    const beta = segments.find((segment) => segment.skillName === 'beta');
    assert.ok(alpha);
    assert.ok(beta);
    assert.equal(alpha.attribution?.source, 'read-skill-md');
    assert.equal(alpha.toolCalls[0].tool, 'Bash');
    assert.equal(alpha.toolCalls[0].sourceTool, 'exec');
    assert.deepEqual(alpha.toolCalls[0].input, {
      input: 'const result = await tools.exec_command({"cmd": "sed -n \'1,200p\' .agents/skills/alpha/SKILL.md"});',
      command: "sed -n '1,200p' .agents/skills/alpha/SKILL.md",
      commands: ["sed -n '1,200p' .agents/skills/alpha/SKILL.md"],
    });
    assert.equal(alpha.metrics.inputTokens, 100);
    assert.equal(alpha.metrics.outputTokens, 10);
    assert.equal(alpha.sourceMetadata?.model, 'gpt-5.5');
    assert.equal(beta.metrics.inputTokens, 80);
    assert.equal(beta.metrics.outputTokens, 8);
    assert.equal(beta.sourceMetadata?.model, 'gpt-5.6-sol');
    assert.equal(segments.some((segment) => segment.skillName === 'phantom-skill'), false);
    assert.equal(segments.some((segment) => segment.skillName === 'phantom-bash'), false);
    assert.equal(segments.some((segment) => segment.skillName === 'fixture'), false);

    const experience = buildObservationExperienceReport({
      sessions: [session],
      segments,
      items: [],
      generatedAt: '2026-07-25T00:00:08.000Z',
    });
    assert.equal(
      experience.invocations.find((invocation) => invocation.skillName === 'alpha')?.sourceMetadata?.model,
      'gpt-5.5',
    );
    assert.equal(
      experience.invocations.find((invocation) => invocation.skillName === 'beta')?.sourceMetadata?.model,
      'gpt-5.6-sol',
    );
  });

  it('does not let malformed Codex token deltas suppress a later valid snapshot', () => {
    const path = join(tmpDir, 'rollout-codex-malformed-token-delta.jsonl');
    const totalUsage = { input_tokens: 100, output_tokens: 10 };
    writeFileSync(path, jsonl([
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-malformed-token-delta',
          cwd: '/repo-codex',
          originator: 'Codex Desktop',
          model_provider: 'openai',
        },
      },
      {
        timestamp: '2026-07-25T00:00:00.100Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model: 'gpt-codex-test' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'read-audit',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'cat .agents/skills/audit/SKILL.md' }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: '100', output_tokens: 10 },
            total_token_usage: totalUsage,
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 100, output_tokens: 10 },
            total_token_usage: totalUsage,
          },
        },
      },
    ]));

    const [session] = loadCcSessions(path);
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 1);
    const [segment] = segmentBySkill(session);
    assert.equal(segment.metrics.inputTokens, 100);
    assert.equal(segment.metrics.outputTokens, 10);
  });

  it('keeps an MCP provider in the tool identity when no end event is available', () => {
    const path = join(tmpDir, 'rollout-codex-mcp-name-only.jsonl');
    writeFileSync(path, jsonl([
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-mcp-name-only',
          cwd: '/repo-codex',
          originator: 'Codex Desktop',
          model_provider: 'openai',
        },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'mcp-call',
          name: 'mcp__github__fetch_file',
          arguments: JSON.stringify({ path: 'README.md' }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'mcp-call',
          output: 'contents',
        },
      },
    ]));

    const [session] = loadCcSessions(path);
    const call = session.events.find((event) => event.eventKind === 'tool_call');
    assert.equal(call?.eventKind, 'tool_call');
    if (call?.eventKind !== 'tool_call') assert.fail('missing tool call');
    assert.equal(call.tool.name, 'github.fetch_file');
    assert.equal(call.tool.provider, 'github');
    assert.equal(call.tool.namespace, 'mcp__github');
  });

  it('preserves modern Codex tool events without retaining large payloads', () => {
    const path = join(tmpDir, 'rollout-codex-modern-tools.jsonl');
    writeFileSync(path, jsonl([
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-modern-tools',
          cwd: '/repo-codex',
          originator: 'Codex Desktop',
          model_provider: 'openai',
        },
      },
      {
        timestamp: '2026-07-25T00:00:00.100Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model: 'gpt-codex-test' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'read-skill',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'cat .agents/skills/audit/SKILL.md' }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'read-skill', output: '# Audit' },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'web_search_call',
          id: 'web-1',
          status: 'failed',
          action: { type: 'search', query: 'revenue schema' },
        },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'tool_search_call',
          id: 'tool-search-item',
          call_id: 'tool-search-1',
          status: 'completed',
          arguments: { query: 'database tools' },
        },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'tool_search_output',
          call_id: 'tool-search-1',
          status: 'completed',
          execution: 'client',
          tools: [{
            type: 'namespace',
            name: 'database',
            description: 'must not be retained',
            tools: [{ type: 'function', name: 'query', description: 'large schema omitted' }],
          }],
        },
      },
      {
        timestamp: '2026-07-25T00:00:06.000Z',
        type: 'response_item',
        payload: {
          type: 'image_generation_call',
          id: 'image-1',
          status: 'generating',
          revised_prompt: 'Draw an evaluation chart',
          result: 'base64-image-payload',
        },
      },
    ]));

    const [session] = loadCcSessions(path);
    const audit = segmentBySkill(session).find((segment) => segment.skillName === 'audit');
    assert.ok(audit);
    assert.deepEqual(
      audit.toolCalls.map((tool) => tool.tool),
      ['Bash', 'WebSearch', 'tool_search', 'image_generation'],
    );
    assert.equal(audit.metrics.numToolCalls, 4);
    assert.equal(audit.metrics.numToolFailures, 1);
    assert.equal(audit.toolCalls.find((tool) => tool.tool === 'WebSearch')?.success, false);
    assert.equal(audit.toolCalls.find((tool) => tool.tool === 'WebSearch')?.statusSource, 'runtime');
    const toolSearchOutput = String(audit.toolCalls.find((tool) => tool.tool === 'tool_search')?.output);
    assert.match(toolSearchOutput, /"database"/);
    assert.doesNotMatch(toolSearchOutput, /must not be retained|large schema omitted/);
    const imageOutput = String(audit.toolCalls.find((tool) => tool.tool === 'image_generation')?.output);
    assert.match(imageOutput, /"resultBytes":20/);
    assert.doesNotMatch(imageOutput, /base64-image-payload/);
    assert.equal(audit.toolCalls.find((tool) => tool.tool === 'image_generation')?.status, 'success');
    assert.equal(audit.toolCalls.find((tool) => tool.tool === 'image_generation')?.statusSource, 'inferred');
  });

  it('uses Codex web completion events to resolve otherwise statusless tool output', () => {
    const path = writeSession(tmpDir, 'codex-web-completion.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-web-completion' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'web-1',
          namespace: 'web',
          name: 'run',
          arguments: '{"search_query":[{"q":"example"}]}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'web_search_end', call_id: 'web-1', results: [] },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'web-1', output: 'No results.' },
      },
    ]);

    const [toolCall] = segmentBySkill(loadCcSessions(path)[0])[0].toolCalls;
    assert.equal(toolCall.tool, 'web.run');
    assert.equal(toolCall.status, 'success');
    assert.equal(toolCall.statusSource, 'inferred');
  });

  it('excludes Codex guardian rollouts from observation sessions', () => {
    const path = join(tmpDir, 'rollout-codex-guardian.jsonl');
    writeFileSync(path, jsonl([
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-guardian',
          parent_thread_id: 'codex-parent',
          cwd: '/repo-codex',
          originator: 'Codex Desktop',
          thread_source: 'subagent',
          source: { subagent: { other: 'guardian' } },
          model_provider: 'openai',
        },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Assess a planned tool call.' }],
        },
      },
    ]));

    assert.deepEqual(loadCcSessions(path), []);
  });

  it('groups nested Codex subagents under the root logical session', () => {
    writeSession(tmpDir, 'rollout-main.jsonl', [{
      timestamp: '2026-07-25T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'codex-parent',
        session_id: 'codex-parent',
        cwd: '/repo-codex',
        originator: 'Codex Desktop',
        model_provider: 'openai',
      },
    }]);
    writeSession(tmpDir, 'rollout-child.jsonl', [{
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'session_meta',
      payload: {
        id: 'codex-child',
        session_id: 'codex-parent',
        parent_thread_id: 'codex-parent',
        cwd: '/repo-codex',
        originator: 'Codex Desktop',
        thread_source: 'subagent',
        model_provider: 'openai',
      },
    }]);
    writeSession(tmpDir, 'rollout-grandchild.jsonl', [{
      timestamp: '2026-07-25T00:00:02.000Z',
      type: 'session_meta',
      payload: {
        id: 'codex-grandchild',
        session_id: 'codex-parent',
        parent_thread_id: 'codex-child',
        cwd: '/repo-codex',
        originator: 'Codex Desktop',
        thread_source: 'subagent',
        model_provider: 'openai',
      },
    }]);

    const sessions = loadCcSessions(tmpDir).sort((a, b) => a.runId.localeCompare(b.runId));
    assert.equal(sessions.length, 3);
    assert.deepEqual(sessions.map((session) => session.role), ['subagent', 'subagent', 'main']);
    assert.deepEqual(new Set(sessions.map((session) => session.rootRunId)), new Set(['codex-parent']));
    assert.deepEqual(new Set(sessions.map((session) => session.groupPath)), new Set(['codex:codex-parent']));
  });

  it('isolates parent links when a source reuses the referenced run id', () => {
    for (const name of ['first', 'second']) {
      writeSession(tmpDir, `rollout-duplicate-parent-${name}.jsonl`, [{
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'duplicate-parent',
          cwd: `/repo-${name}`,
          originator: 'Codex Desktop',
          model_provider: 'openai',
        },
      }]);
    }
    writeSession(tmpDir, 'rollout-ambiguous-child.jsonl', [{
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'session_meta',
      payload: {
        id: 'ambiguous-child',
        parent_thread_id: 'duplicate-parent',
        cwd: '/repo-child',
        originator: 'Codex Desktop',
        thread_source: 'subagent',
        model_provider: 'openai',
      },
    }]);

    const sessions = loadCcSessions(tmpDir);
    assert.equal(sessions.length, 3);
    assert.equal(new Set(sessions.map((session) => session.groupPath)).size, 3);
    assert.equal(
      sessions.find((session) => session.runId === 'ambiguous-child')?.rootRunId,
      'ambiguous-child',
    );
  });

  it('isolates cyclic parent links instead of inventing a logical root', () => {
    writeSession(tmpDir, 'rollout-cycle-a.jsonl', [{
      timestamp: '2026-07-25T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'cycle-a',
        parent_thread_id: 'cycle-b',
        cwd: '/repo',
        originator: 'Codex Desktop',
        thread_source: 'subagent',
        model_provider: 'openai',
      },
    }]);
    writeSession(tmpDir, 'rollout-cycle-b.jsonl', [{
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'session_meta',
      payload: {
        id: 'cycle-b',
        parent_thread_id: 'cycle-a',
        cwd: '/repo',
        originator: 'Codex Desktop',
        thread_source: 'subagent',
        model_provider: 'openai',
      },
    }]);

    const sessions = loadCcSessions(tmpDir).sort((a, b) => a.runId.localeCompare(b.runId));
    assert.deepEqual(sessions.map((session) => session.rootRunId), ['cycle-a', 'cycle-b']);
    assert.equal(new Set(sessions.map((session) => session.groupPath)).size, 2);
  });

  it('keeps OpenClaw business action labels and splits by SKILL.md reads', () => {
    const path = join(tmpDir, 'openclaw-multi-action.jsonl');
    writeFileSync(path, jsonl([
      { type: 'session', version: 3, id: 'oc-actions', timestamp: '2026-05-12T00:00:00.000Z', cwd: '/tmp/example/.openclaw/workspace' },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `帮我写示例页面需求\n${businessActionTag('生成文档', '请根据以上需求生成需求文档。')}\n${businessActionTag('生成页面', '请根据以上需求生成可交互页面。')}` }],
        },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-05-12T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'read-prd', name: 'read', arguments: { path: '/tmp/example/.openclaw/workspace/skills/prd-create/SKILL.md' } },
          ],
        },
      },
      {
        type: 'message',
        id: 'tr1',
        parentId: 'a1',
        timestamp: '2026-05-12T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'read-prd',
          toolName: 'read',
          content: [{ type: 'text', text: '# PRD Creation Skill' }],
          isError: false,
        },
      },
      {
        type: 'message',
        id: 'a2',
        parentId: 'tr1',
        timestamp: '2026-05-12T00:00:04.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'read-demo', name: 'read', arguments: { path: '/tmp/example/.openclaw/workspace/skills/demo-create/SKILL.md' } },
          ],
        },
      },
      {
        type: 'message',
        id: 'tr2',
        parentId: 'a2',
        timestamp: '2026-05-12T00:00:05.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'read-demo',
          toolName: 'read',
          content: [{ type: 'text', text: '# Demo Creation Skill' }],
          isError: false,
        },
      },
    ]));

    const [session] = loadCcSessions(path);
    assert.deepEqual(session.sourceMetadata?.businessActions, ['生成文档', '生成页面']);
    const segs = segmentBySkill(session);
    assert.deepEqual(segs.filter((seg) => seg.skillName !== 'general').map((seg) => seg.skillName), ['prd-create', 'demo-create']);
    assert.equal(segs.some((seg) => seg.skillName === '生成文档' || seg.skillName === '生成页面'), false);
    assert.equal(segs.find((seg) => seg.skillName === 'prd-create')?.attribution?.source, 'read-skill-md');
    assert.equal(segs.find((seg) => seg.skillName === 'demo-create')?.attribution?.source, 'read-skill-md');
  });

  it('attributes OpenClaw cron script executions to the skill directory', () => {
    const path = join(tmpDir, 'openclaw-cron-script.jsonl');
    writeFileSync(path, jsonl([
      { type: 'session', version: 3, id: 'oc-cron', timestamp: '2026-05-12T00:00:00.000Z', cwd: '/tmp/example/.openclaw/workspace-main' },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[cron:6596 task-poller] 请执行任务拉取：bash /tmp/example/.openclaw/workspace-main/skills/task-poller/scripts/run-poller.sh /tmp/example/.openclaw/workspace-main' }],
        },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-05-12T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'run-poller', name: 'exec', arguments: { command: 'bash /tmp/example/.openclaw/workspace-main/skills/task-poller/scripts/run-poller.sh /tmp/example/.openclaw/workspace-main', timeout: 120 } },
          ],
        },
      },
      {
        type: 'message',
        id: 'tr1',
        parentId: 'a1',
        timestamp: '2026-05-12T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'run-poller',
          toolName: 'exec',
          content: [{ type: 'text', text: 'done' }],
          isError: false,
        },
      },
    ]));

    const [session] = loadCcSessions(path);
    const segs = segmentBySkill(session);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'task-poller');
    assert.equal(segs[0].attribution?.source, 'skill-script');
    assert.equal(segs[0].toolCalls[0].tool, 'Bash');
    assert.equal((segs[0].toolCalls[0].input as { command?: string }).command?.includes('/skills/task-poller/scripts/run-poller.sh'), true);
  });

  it('attributes OpenClaw script paths after punctuation boundaries', () => {
    const path = join(tmpDir, 'openclaw-script-punctuation.jsonl');
    writeFileSync(path, jsonl([
      { type: 'session', version: 3, id: 'oc-cron-punctuation', timestamp: '2026-05-12T00:00:00.000Z', cwd: '/tmp/example/.openclaw/workspace-main' },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'cron command:cmd:/tmp/example/.openclaw/workspace-main/skills/task-poller/scripts/run-poller.sh' }],
        },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-05-12T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'run-poller', name: 'exec', arguments: { command: '(/tmp/example/.openclaw/workspace-main/skills/task-poller/scripts/run-poller.sh)', timeout: 120 } },
          ],
        },
      },
    ]));

    const [session] = loadCcSessions(path);
    const segs = segmentBySkill(session);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'task-poller');
    assert.equal(segs[0].attribution?.source, 'skill-script');

    const wrappedPath = join(tmpDir, 'openclaw-script-wrapped.jsonl');
    writeFileSync(wrappedPath, jsonl([
      { type: 'session', version: 3, id: 'oc-cron-wrapped', timestamp: '2026-05-12T00:01:00.000Z', cwd: '/tmp/example/.openclaw/workspace-main' },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-05-12T00:01:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'run scheduled task' }],
        },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-05-12T00:01:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'run-poller', name: 'exec', arguments: { command: '(/tmp/example/.openclaw/workspace-main/skills/task-poller/scripts/run-poller.sh)', timeout: 120 } },
          ],
        },
      },
    ]));

    const [wrappedSession] = loadCcSessions(wrappedPath);
    const wrappedSegs = segmentBySkill(wrappedSession);
    assert.equal(wrappedSegs.length, 2);
    assert.equal(wrappedSegs[1].skillName, 'task-poller');
    assert.equal(wrappedSegs[1].attribution?.source, 'skill-script');
  });

  it('loads each markdown log block as its own session', () => {
    const path = join(tmpDir, 'agent.log');
    writeFileSync(path, `---
## [2026/04/09 16:22:55] 对话记录 (SDK)
**工作目录**: /repo-a
**会话 ID**: shared-session
**请求 ID**: r-a

### 用户输入
请优先调用 audit skill 处理。

### AI 回复
审计完成。
---
## [2026/04/09 16:25:55] 对话记录 (SDK)
**工作目录**: /repo-b
**会话 ID**: shared-session
**请求 ID**: r-b

### 用户输入
请优先调用 polish skill 处理。

### AI 回复
润色完成。
`);
    const sessions = loadCcSessions(path);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].runId, 'shared-session');
    assert.equal(sessions[0].cwd, '/repo-a');
    assert.equal(sessions[1].runId, 'shared-session');
    assert.equal(sessions[1].cwd, '/repo-b');
    assert.equal(new Set(sessions.map((session) => session.traceId)).size, 2);
    assert.ok(sessions.every((session) => /^trace:[a-f0-9]{32}$/.test(session.traceId)));

    const segs = sessions.flatMap(segmentBySkill).sort((a, b) => a.skillName.localeCompare(b.skillName));
    assert.deepEqual(segs.map((seg) => [seg.skillName, seg.sessionId, seg.cwd]), [
      ['audit', 'shared-session', '/repo-a'],
      ['polish', 'shared-session', '/repo-b'],
    ]);

    const experience = buildObservationExperienceReport({
      sessions,
      segments: segs,
      items: [],
      generatedAt: '2026-04-09T09:00:00.000Z',
    });
    const invocations = experience.invocations.sort((a, b) => a.skillName.localeCompare(b.skillName));
    assert.deepEqual(
      invocations.map((invocation) => [
        invocation.skillName,
        invocation.sessionId,
        invocation.cwd,
        invocation.timeline.find((event) => event.kind === 'user_message')?.snippet,
      ]),
      [
        ['audit', 'shared-session', '/repo-a', '请优先调用 audit skill 处理。'],
        ['polish', 'shared-session', '/repo-b', '请优先调用 polish skill 处理。'],
      ],
    );
    assert.equal(new Set(invocations.map((invocation) => invocation.sessionGroupKey)).size, 2);
    assert.equal(new Set(invocations.map((invocation) => invocation.id)).size, 2);
    const timelineEventIds = experience.traceTimelines.flatMap((timeline) =>
      [
        ...timeline.tree.main,
        ...timeline.tree.branches.flatMap((branch) => branch.events),
      ].map((event) => event.id)
    );
    assert.equal(new Set(timelineEventIds).size, timelineEventIds.length);
  });

  it('keeps markdown trace identities stable when unrelated blocks are inserted', () => {
    const path = join(tmpDir, 'stable-agent.log');
    const block = (requestId: string, text: string): string => `---
## [2026/04/09 16:22:55 +08:00] 对话记录 (SDK)
**会话 ID**: shared-session
**请求 ID**: ${requestId}

### 用户输入
${text}

### AI 回复
done
`;
    writeFileSync(path, `${block('r-a', 'A')}${block('r-b', 'B')}`);
    const before = new Map(loadCcSessions(path).map((session) => [session.label, session.traceId]));

    writeFileSync(path, `${block('r-new', 'new')}${block('r-a', 'A')}${block('r-b', 'B')}`);
    const after = new Map(loadCcSessions(path).map((session) => [session.label, session.traceId]));

    assert.equal(after.get('stable-agent.log#r-a'), before.get('stable-agent.log#r-a'));
    assert.equal(after.get('stable-agent.log#r-b'), before.get('stable-agent.log#r-b'));
  });

  it('canonicalizes relative and absolute source paths into the same trace identity', () => {
    const path = writeSession(tmpDir, 'canonical-path.jsonl', [
      { type: 'permission-mode', sessionId: 'canonical-run' },
    ]);
    const absolute = loadCcSessions(path)[0];
    const relativePath = relative(process.cwd(), path);
    const fromRelative = loadCcSessions(relativePath)[0];

    assert.equal(fromRelative.traceId, absolute.traceId);
  });

  it('keeps observation attribution physical when markdown blocks reuse session ids and timestamps', () => {
    const path = join(tmpDir, 'same-session-observations.log');
    writeFileSync(path, `---
## [2026/04/09 16:22:55] 对话记录 (SDK)
**工作目录**: /repo
**会话 ID**: shared-session
**请求 ID**: r-a

### 用户输入
不对，请优先调用 audit skill 处理。

### AI 回复
【知识缺口】缺少字段 A。
---
## [2026/04/09 16:22:55] 对话记录 (SDK)
**工作目录**: /repo
**会话 ID**: shared-session
**请求 ID**: r-a

### 用户输入
不对，请优先调用 audit skill 处理。

### AI 回复
【知识缺口】缺少字段 B。
`);

    const { sessions, segments } = tracesToAnalysisEntries(path);
    const report = buildObservationExperienceReport({
      sessions,
      segments,
      items: [],
      generatedAt: '2026-04-09T09:00:00.000Z',
    });
    assert.equal(new Set(sessions.map((session) => session.traceId)).size, 2);
    assert.equal(new Set(report.invocations.map((invocation) => invocation.sessionGroupKey)).size, 2);
    assert.equal(
      new Set(report.invocations.flatMap((invocation) =>
        invocation.problemPatterns.flatMap((pattern) => pattern.recentSessionIds)
      )).size,
      2,
    );
    for (const invocation of report.invocations) {
      assert.ok(invocation.traceId);
      assert.equal(
        report.goalSlices.find((slice) => slice.id === invocation.goalSliceId)?.traceId,
        invocation.traceId,
      );
      assert.ok(invocation.timeline.every((event) => event.traceId === invocation.traceId));
      assert.ok(invocation.evidenceRefs.every((ref) => ref.traceId === invocation.traceId));
      assert.ok(invocation.problemPatterns.every((pattern) =>
        pattern.evidenceRefs.every((ref) => ref.traceId === invocation.traceId)
      ));
    }
    assert.ok(report.sessions.every((session) =>
      session.sessionStory?.episodes?.every((episode) =>
        episode.skillSegments.every((segment) =>
          segment.messageRanges?.every((range) => typeof range.traceId === 'string') ?? true
        )
      ) ?? true
    ));
    assert.ok(normalizeObservationExperienceReport(
      compactObservationExperienceReport(structuredClone(report)),
    ));
  });
});

// ---------- Source-neutral Trace IR ----------

describe('source-neutral Trace IR', () => {
  it('preserves MCP identity and uses authoritative runtime failure status', () => {
    const path = writeSession(tmpDir, 'codex-mcp.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'mcp-call-1',
          name: 'mcp__codex_apps__github',
          arguments: JSON.stringify({ owner: 'openai', repo: 'codex' }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'mcp-call-1',
          output: 'request completed',
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-call-1',
          invocation: { server: 'github', tool: 'fetch_file' },
          result: {
            Ok: {
              isError: true,
              content: [{ type: 'text', text: 'request denied' }],
            },
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'mcp-call-2',
          name: 'mcp__codex_apps__github',
          arguments: JSON.stringify({ query: 'issues' }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-call-2',
          invocation: { server: 'github', tool: 'search_issues' },
          result: {
            Ok: {
              isError: false,
              content: [{ type: 'text', text: '2 issues' }],
            },
          },
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const call = session.events.find((event) => event.eventKind === 'tool_call' && event.callId === 'mcp-call-1');
    const result = session.events.find((event) => event.eventKind === 'tool_result' && event.callId === 'mcp-call-1');
    assert.ok(call?.eventKind === 'tool_call');
    assert.equal(call.tool.name, 'github.fetch_file');
    assert.equal(call.tool.namespace, 'mcp__codex_apps');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'failure');
    assert.equal(result.statusSource, 'runtime');
    const synthesized = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'mcp-call-2',
    );
    assert.ok(synthesized?.eventKind === 'tool_result');
    assert.equal(synthesized.status, 'success');
    assert.equal(synthesized.output, '2 issues');

    const [segment] = segmentBySkill(session);
    const failedCall = segment.toolCalls.find((toolCall) => toolCall.toolUseId === 'mcp-call-1');
    assert.equal(failedCall?.tool, 'github.fetch_file');
    assert.equal(failedCall?.success, false);
    assert.equal(segment.metrics.numToolFailures, 1);
  });

  it('pairs reused Codex MCP call ids by occurrence', () => {
    const path = writeSession(tmpDir, 'codex-mcp-reused-call-id.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-reused', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'reused-call',
          name: 'mcp__server__placeholder',
          arguments: '{}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'reused-call',
          invocation: { server: 'server', tool: 'first' },
          result: { Ok: { content: [{ type: 'text', text: 'first output' }] } },
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'reused-call' },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'reused-call',
          name: 'mcp__server__placeholder',
          arguments: '{}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'reused-call',
          invocation: { server: 'server', tool: 'second' },
          result: { Err: 'second output' },
        },
      },
      {
        timestamp: '2026-07-25T00:00:06.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'reused-call' },
      },
    ]);

    const [session] = loadCcSessions(path);
    const [segment] = segmentBySkill(session);
    const calls = session.events.filter((event) => event.eventKind === 'tool_call');
    const results = session.events.filter((event) => event.eventKind === 'tool_result');
    assert.equal(new Set(calls.map((event) => event.callInstanceId)).size, 2);
    assert.deepEqual(
      results.map((event) => event.callInstanceId),
      calls.map((event) => event.callInstanceId),
    );
    assert.deepEqual(
      segment.toolCalls.map((call) => [call.tool, call.output, call.status]),
      [
        ['server.first', 'first output', 'success'],
        ['server.second', 'second output', 'failure'],
      ],
    );
  });

  it('maps Codex MCP result.Err to an authoritative failure', () => {
    const path = writeSession(tmpDir, 'codex-mcp-err.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-err', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'mcp-call-err',
          name: 'mcp__codex_apps__github',
          arguments: '{}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-call-err',
          invocation: { server: 'github', tool: 'fetch_file' },
          result: { Err: { message: 'connector unavailable' } },
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'mcp-call-err',
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'failure');
    assert.equal(result.statusSource, 'runtime');
    assert.match(result.output, /connector unavailable/);
  });

  it('falls back to function output status when MCP end has no outcome field', () => {
    const path = writeSession(tmpDir, 'codex-mcp-output-status.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-output-status', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'mcp-output-status',
          name: 'mcp__codex_apps__github',
          arguments: '{}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'mcp-output-status',
          status: 'completed',
          output: 'done',
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-output-status',
          invocation: { server: 'github', tool: 'fetch_file' },
          result: { Ok: { content: [{ type: 'text', text: 'done' }] } },
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'mcp-output-status',
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'success');
    assert.equal(result.statusSource, 'runtime');
  });

  it('pairs standalone Codex MCP end events with a source-neutral tool call', () => {
    const path = writeSession(tmpDir, 'codex-mcp-standalone.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-standalone', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          id: 'mcp-end-record-1',
          call_id: 'exec-runtime-call',
          invocation: {
            server: 'node_repl',
            tool: 'js',
            arguments: { code: 'return 1' },
          },
          result: {
            Ok: {
              isError: false,
              content: [{ type: 'text', text: 'done' }],
            },
          },
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const call = session.events.find((event) =>
      event.eventKind === 'tool_call' && event.callId === 'exec-runtime-call',
    );
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'exec-runtime-call',
    );
    assert.ok(call?.eventKind === 'tool_call');
    assert.equal(call.tool.name, 'node_repl.js');
    assert.equal(call.tool.provider, 'node_repl');
    assert.deepEqual(call.input, { code: 'return 1' });
    assert.equal(call.sourceEventId, 'mcp-end-record-1');
    assert.equal(call.sourceType, 'event_msg:mcp_tool_call_end');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'success');
    assert.equal(result.sourceEventId, 'mcp-end-record-1');

    const [segment] = segmentBySkill(session);
    assert.equal(segment.toolCalls[0].tool, 'node_repl.js');
    assert.equal(segment.toolCalls[0].status, 'success');
  });

  it('treats a standalone Codex MCP Ok result as authoritative success without an isError flag', () => {
    const path = writeSession(tmpDir, 'codex-mcp-ok-without-flag.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-ok-without-flag', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-ok-call',
          invocation: { server: 'github', tool: 'fetch_file' },
          result: {
            Ok: {
              content: [{ type: 'text', text: 'done' }],
            },
          },
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'mcp-ok-call',
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'success');
    assert.equal(result.statusSource, 'runtime');
  });

  it('keeps an explicit Codex MCP cancellation even when is_error is false', () => {
    const path = writeSession(tmpDir, 'codex-mcp-cancelled.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-cancelled', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-cancelled-call',
          status: 'cancelled',
          is_error: false,
          invocation: {
            server: 'github',
            tool: 'fetch_file',
            arguments: { path: 'README.md' },
          },
          output: 'cancelled by user',
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'mcp-cancelled-call'
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'cancelled');
    assert.equal(result.statusSource, 'runtime');
  });

  it('uses Codex call namespace when an MCP end event is absent', () => {
    const path = writeSession(tmpDir, 'codex-mcp-namespace-only.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-namespace-only', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc-node-read-skill',
          call_id: 'node-read-skill',
          name: 'js',
          namespace: 'mcp__node_repl',
          arguments: JSON.stringify({
            code: 'await tools.exec_command({cmd: "cat /home/user/.codex/plugins/cache/openai-bundled/chrome/1/skills/control-chrome/SKILL.md"});',
          }),
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const call = session.events.find((event) =>
      event.eventKind === 'tool_call' && event.callId === 'node-read-skill',
    );
    assert.ok(call?.eventKind === 'tool_call');
    assert.equal(call.sourceEventId, 'fc-node-read-skill');
    assert.equal(call.tool.name, 'node_repl.js');
    assert.equal(call.tool.namespace, 'mcp__node_repl');
    assert.equal(call.tool.provider, 'node_repl');

    const [segment] = segmentBySkill(session);
    assert.equal(segment.skillName, 'control-chrome');
    assert.equal(segment.attribution?.source, 'read-skill-md');
  });

  it('attributes skill scripts executed through Codex node_repl code', () => {
    const path = writeSession(tmpDir, 'codex-node-skill-script.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-node-skill-script', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'node-run-skill',
          name: 'js',
          namespace: 'mcp__node_repl',
          arguments: JSON.stringify({
            code: 'await import("/home/user/.codex/plugins/cache/openai-bundled/chrome/1/skills/control-chrome/scripts/browser-client.mjs");',
          }),
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const [segment] = segmentBySkill(session);
    assert.equal(segment.skillName, 'control-chrome');
    assert.equal(segment.attribution?.source, 'skill-script');
  });

  it('does not treat repository fixture scripts as active skill evidence', () => {
    const path = writeSession(tmpDir, 'codex-repository-skill-script.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-repository-skill-script', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'node-run-fixture',
          name: 'js',
          namespace: 'mcp__node_repl',
          arguments: JSON.stringify({
            code: 'await import("/repo/examples/agent-eval/skills/fixture/scripts/run.mjs");',
          }),
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const [segment] = segmentBySkill(session);
    assert.equal(segment.skillName, 'general');
    assert.equal(segment.attribution?.source, 'general');
  });

  it('keeps Codex tool results unknown when the protocol provides no outcome evidence', () => {
    const path = writeSession(tmpDir, 'codex-tool-unknown.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-tool-unknown', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'plain-call',
          name: 'custom_tool',
          arguments: '{"query":"status"}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'plain-call',
          output: 'completed',
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'plain-call',
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'unknown');
    assert.equal(result.statusSource, 'unknown');

    const [segment] = segmentBySkill(session);
    assert.equal(segment.toolCalls[0].status, 'unknown');
    assert.equal(segment.metrics.numToolFailures, 0);
    assert.equal(segment.metrics.numToolUnknown, 1);
  });

  it('keeps an explicit Codex unknown status authoritative over output text', () => {
    const path = writeSession(tmpDir, 'codex-tool-explicit-unknown.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-tool-explicit-unknown', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'plain-call',
          name: 'custom_tool',
          arguments: '{"query":"status"}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'plain-call',
          status: 'unknown',
          output: 'Error: terminal status was not reported',
        },
      },
    ]);

    const [session] = loadCcSessions(path);
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'plain-call',
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'unknown');
    assert.equal(result.statusSource, 'runtime');

    const [segment] = segmentBySkill(session);
    assert.equal(segment.metrics.numToolFailures, 0);
    assert.equal(segment.metrics.numToolUnknown, 1);
  });

  it('classifies Codex instructions as runtime context instead of human turns', () => {
    const path = writeSession(tmpDir, 'codex-runtime-context.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-runtime-context', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '# AGENTS.md instructions for /repo\n<INSTRUCTIONS>...</INSTRUCTIONS>' },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '<environment_context><cwd>/repo</cwd></environment_context>' },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '请检查这个实现。' },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: '检查完成。' },
      },
    ]);

    const [session] = loadCcSessions(path);
    const userOrigins = session.events.flatMap((event) =>
      event.eventKind === 'message' && event.role === 'user' ? [event.origin] : [],
    );
    assert.deepEqual(userOrigins, ['runtime', 'runtime', 'human']);
    const [segment] = segmentBySkill(session);
    assert.equal(segment.metrics.numTurns, 1);
    assert.deepEqual(segment.turns.map((turn) => turn.role), ['user', 'assistant']);
  });

  it('recognizes Codex system skills from the installed .system layout', () => {
    const path = writeSession(tmpDir, 'codex-system-skill.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-system-skill', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'read-system-skill',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: 'sed -n \'1,220p\' /home/user/.codex/skills/.system/skill-creator/SKILL.md',
          }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'read-system-skill', output: '# Skill Creator' },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'run-system-skill',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: 'node /home/user/.codex/skills/.system/skill-creator/scripts/validate.js',
          }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'run-system-skill', output: 'valid' },
      },
    ]);

    const [session] = loadCcSessions(path);
    const segments = segmentBySkill(session);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].skillName, 'skill-creator');
    assert.equal(segments[0].toolCalls.length, 2);
  });

  it('keeps sample ids unique across a root run and child run', () => {
    const main = {
      sessionId: 'root',
      sessionGroupId: 'root',
      sourcePath: '/trace/main.jsonl',
      records: [asstRec('a-main', [{ type: 'text', text: 'main' }], { sessionId: 'root' })],
    };
    const child = {
      sessionId: 'child',
      sessionGroupId: 'root',
      sourcePath: '/trace/subagents/child.jsonl',
      records: [asstRec('a-child', [{ type: 'text', text: 'child' }], { sessionId: 'child' })],
    };
    const entries = segmentsToAnalysisEntries([
      ...segmentBySkill(main),
      ...segmentBySkill(child),
    ]);
    assert.equal(new Set(entries.map((entry) => entry.sampleId)).size, 2);
  });

  it('keeps record ranges local to each physical trace in grouped timelines', () => {
    writeSession(tmpDir, 'main.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'root-run', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: '<command-name>/audit</command-name>\n检查主线。',
        },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: '主线完成。' },
      },
    ]);
    writeSession(tmpDir, 'child.jsonl', [
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'session_meta',
        payload: {
          id: 'child-run',
          parent_thread_id: 'root-run',
          thread_source: 'subagent',
          source: { subagent: 'review' },
          cwd: '/repo',
          model_provider: 'openai',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.100Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: '<command-name>/audit</command-name>\n检查子链路。',
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: '子链路完成。' },
      },
    ]);

    const sessions = loadCcSessions(tmpDir);
    const segments = sessions.flatMap((session) => segmentBySkill(session));
    const report = buildObservationExperienceReport({
      sessions,
      segments,
      items: [],
      generatedAt: '2026-07-25T00:05:00.000Z',
    });

    assert.equal(report.sessions.length, 1);
    const scope = report.sessions[0].timelineScope;
    assert.equal(scope.segmentRecordRanges.length, 2);
    assert.equal(scope.sessionRecordRanges.length, 2);
    assert.deepEqual(
      scope.sessionRecordRanges.map((range) => [range.traceId, range.startRecordIndex, range.endRecordIndex]),
      sessions
        .map((session) => [session.traceId, 0, 2] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
    );
    assert.equal(
      scope.segmentEventCount,
      new Set(report.invocations.flatMap((invocation) => invocation.timelineEventIds ?? [])).size,
    );
    assert.equal(scope.omittedBeforeCount, 0);
    assert.equal(scope.omittedAfterCount, 0);
    const dispatch = report.sessions[0].sessionStory?.subagentDispatches[0];
    assert.ok(dispatch);
    assert.equal(dispatch.childSessionId, 'child-run');
    assert.equal(dispatch.traceId, sessions.find((session) => session.runId === 'child-run')?.traceId);
    const childEdges = report.sessions[0].sessionStory?.episodes
      ?.flatMap((episode) => episode.orchestrationEdges)
      .filter((edge) => edge.childSessionId === 'child-run');
    assert.equal(childEdges?.length, 1);
    assert.equal(childEdges?.[0].edgeKind, 'external_child_session');
    const auditSegment = report.sessions[0].sessionStory?.episodes
      ?.flatMap((episode) => episode.skillSegments)
      .find((segment) => segment.skillName === 'audit');
    assert.ok(auditSegment);
    assert.equal(childEdges?.[0].parentSkillSegmentId, auditSegment.id);
    assert.equal(childEdges?.[0].executorSkillSegmentId, undefined);
    assert.ok(normalizeObservationExperienceReport(
      compactObservationExperienceReport(report),
    ));
  });

  it('uses the full invocation timeline for metrics beyond the 240-event preview', () => {
    const records: unknown[] = [{
      timestamp: '2026-07-25T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-long', cwd: '/repo', model_provider: 'openai' },
    }, {
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: '<command-name>/audit</command-name>\n<command-message>audit</command-message>\n请检查实现。',
      },
    }];
    for (let index = 0; index < 250; index += 1) {
      records.push({
        timestamp: `2026-07-25T00:${String(Math.floor((index + 2) / 60)).padStart(2, '0')}:${String((index + 2) % 60).padStart(2, '0')}.000Z`,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: `进度 ${index}` },
      });
    }
    records.push({
      timestamp: '2026-07-25T00:05:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: '不对，请重新检查最后的结论。' },
    });
    records.push({
      timestamp: '2026-07-25T00:05:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: '已修正并交付。' },
    });
    const path = writeSession(tmpDir, 'codex-long.jsonl', records);
    const [session] = loadCcSessions(path);
    const segments = segmentBySkill(session);
    const experience = buildObservationExperienceReport({
      sessions: [session],
      segments,
      items: [],
      generatedAt: '2026-07-25T00:06:00.000Z',
    });
    const invocation = experience.invocations[0];
    assert.ok(invocation.timeline.length > 240);
    assert.equal(invocation.indicators.userMessageCount, 2);
    assert.ok(invocation.indicators.userCorrectionCount >= 1);

    const compact = compactObservationExperienceReport(experience);
    assert.equal(compact.schemaVersion, 3);
    assert.equal(compact.traceTimelines.length, 1);
    assert.equal(compact.storyContexts.length, 1);
    assert.equal(typeof compact.sessions[0].sourceSessionDurationMs, 'number');
    assert.equal('timeline' in compact.invocations[0], false);
    assert.equal('timelinePreview' in compact.sessions[0], false);
    assert.equal('fullSessionTimeline' in compact.sessions[0], false);
    assert.equal('timelineTree' in compact.sessions[0], false);
    assert.equal('goalSlices' in compact.sessions[0].sessionStory!, false);
    assert.equal('episodes' in compact.sessions[0].sessionStory!, false);
    assert.equal(compact.sessions[0].reviewerReport?.sessionStoryRef, 'session');
    assert.equal('sessionStory' in compact.sessions[0].reviewerReport!, false);
    const serialized = JSON.stringify(compact);
    assert.ok(serialized.length < JSON.stringify(experience).length);

    const hydrated = normalizeObservationExperienceReport(JSON.parse(serialized));
    assert.ok(hydrated);
    assert.deepEqual(
      hydrated.invocations[0].timeline.map((event) => event.id),
      invocation.timeline.map((event) => event.id),
    );
    assert.equal(
      hydrated.sessions[0].fullSessionTimeline.length,
      experience.sessions[0].fullSessionTimeline.length,
    );
    assert.equal(
      hydrated.sessions[0].sessionStory?.episodes?.length,
      experience.sessions[0].sessionStory?.episodes?.length,
    );
    assert.equal(
      hydrated.sessions[0].reviewerReport?.sessionStory,
      hydrated.sessions[0].sessionStory,
    );

    const missingStore = JSON.parse(serialized);
    delete missingStore.storyContexts;
    assert.equal(normalizeObservationExperienceReport(missingStore), null);
    const brokenReference = JSON.parse(serialized);
    brokenReference.invocations[0].timelineEventIds[0] = 'missing-event';
    assert.equal(normalizeObservationExperienceReport(brokenReference), null);
    const malformedBranch = JSON.parse(serialized);
    malformedBranch.traceTimelines[0].tree.branches = [{ id: 'broken' }];
    assert.equal(normalizeObservationExperienceReport(malformedBranch), null);
    const missingInvocationRefs = JSON.parse(serialized);
    delete missingInvocationRefs.sessions[0].invocationIds;
    assert.equal(normalizeObservationExperienceReport(missingInvocationRefs), null);
    const danglingInvocation = JSON.parse(serialized);
    danglingInvocation.sessions[0].invocationIds = ['missing-invocation'];
    assert.equal(normalizeObservationExperienceReport(danglingInvocation), null);
    const duplicateInvocation = JSON.parse(serialized);
    duplicateInvocation.invocations.push({ ...duplicateInvocation.invocations[0] });
    duplicateInvocation.meta.invocationCount += 1;
    assert.equal(normalizeObservationExperienceReport(duplicateInvocation), null);
    const unreferencedInvocation = JSON.parse(serialized);
    unreferencedInvocation.invocations.push({
      ...unreferencedInvocation.invocations[0],
      id: 'unreferenced-invocation',
    });
    unreferencedInvocation.meta.invocationCount += 1;
    assert.equal(normalizeObservationExperienceReport(unreferencedInvocation), null);
    const duplicatedSessionRef = JSON.parse(serialized);
    duplicatedSessionRef.sessions[0].invocationIds.push(
      duplicatedSessionRef.sessions[0].invocationIds[0],
    );
    assert.equal(normalizeObservationExperienceReport(duplicatedSessionRef), null);
    const orphanTimeline = JSON.parse(serialized);
    orphanTimeline.traceTimelines.push({
      ...orphanTimeline.traceTimelines[0],
      id: 'orphan-timeline',
    });
    assert.equal(normalizeObservationExperienceReport(orphanTimeline), null);
    const wrongStoryGroup = JSON.parse(serialized);
    wrongStoryGroup.storyContexts[0].sessionGroupKey = 'wrong-group';
    assert.equal(normalizeObservationExperienceReport(wrongStoryGroup), null);
    const inconsistentMeta = JSON.parse(serialized);
    inconsistentMeta.meta.sessionCount += 1;
    assert.equal(normalizeObservationExperienceReport(inconsistentMeta), null);
    const invalidGeneratedAt = JSON.parse(serialized);
    invalidGeneratedAt.generatedAt = 'not-a-timestamp';
    assert.equal(normalizeObservationExperienceReport(invalidGeneratedAt), null);
    const invertedInvocationRange = JSON.parse(serialized);
    invertedInvocationRange.invocations[0].startTimestamp = '2026-07-25T00:07:00.000Z';
    assert.equal(normalizeObservationExperienceReport(invertedInvocationRange), null);
    const invalidTimelineTimestamp = JSON.parse(serialized);
    invalidTimelineTimestamp.traceTimelines[0].tree.main[0].timestamp = 'not-a-timestamp';
    assert.equal(normalizeObservationExperienceReport(invalidTimelineTimestamp), null);
    const inconsistentSourceDuration = JSON.parse(serialized);
    inconsistentSourceDuration.sessions[0].sourceSessionDurationMs += 1;
    assert.equal(normalizeObservationExperienceReport(inconsistentSourceDuration), null);
    const invertedEpisodeRange = JSON.parse(serialized);
    invertedEpisodeRange.storyContexts[0].episodes[0].startTimestamp = '2026-07-25T00:07:00.000Z';
    assert.equal(normalizeObservationExperienceReport(invertedEpisodeRange), null);
    const malformedMetrics = JSON.parse(serialized);
    malformedMetrics.invocations[0].metrics.numToolUnknown = 2;
    malformedMetrics.invocations[0].metrics.numToolCalls = 1;
    assert.equal(normalizeObservationExperienceReport(malformedMetrics), null);
    const mismatchedInvocationOutcome = JSON.parse(serialized);
    mismatchedInvocationOutcome.invocations[0].indicators.toolUnknownCount += 1;
    assert.equal(normalizeObservationExperienceReport(mismatchedInvocationOutcome), null);
    const mismatchedToolDistribution = JSON.parse(serialized);
    mismatchedToolDistribution.invocations[0].toolCounts.fake = 1;
    assert.equal(normalizeObservationExperienceReport(mismatchedToolDistribution), null);
    const malformedIndicators = JSON.parse(serialized);
    malformedIndicators.sessions[0].indicators.toolFailureCount = -1;
    assert.equal(normalizeObservationExperienceReport(malformedIndicators), null);
    const mismatchedSessionOutcome = JSON.parse(serialized);
    mismatchedSessionOutcome.sessions[0].indicators.toolUnknownCount += 1;
    assert.equal(normalizeObservationExperienceReport(mismatchedSessionOutcome), null);
    const mismatchedSessionIndicator = JSON.parse(serialized);
    mismatchedSessionIndicator.sessions[0].indicators.userMessageCount += 1;
    assert.equal(normalizeObservationExperienceReport(mismatchedSessionIndicator), null);
    const mismatchedPriorityScore = JSON.parse(serialized);
    mismatchedPriorityScore.sessions[0].reviewPriorityScore += 1;
    assert.equal(normalizeObservationExperienceReport(mismatchedPriorityScore), null);
    const mismatchedGoalSlice = JSON.parse(serialized);
    mismatchedGoalSlice.goalSlices[0].skillName = 'another-skill';
    assert.equal(normalizeObservationExperienceReport(mismatchedGoalSlice), null);
    const malformedTimelineScope = JSON.parse(serialized);
    malformedTimelineScope.sessions[0].timelineScope.fullSessionEventCount = -1;
    assert.equal(normalizeObservationExperienceReport(malformedTimelineScope), null);
    const inconsistentTimelineScope = JSON.parse(serialized);
    inconsistentTimelineScope.sessions[0].timelineScope.fullSessionEventCount += 1;
    assert.equal(normalizeObservationExperienceReport(inconsistentTimelineScope), null);
    const inconsistentOmittedCount = JSON.parse(serialized);
    inconsistentOmittedCount.sessions[0].timelineScope.omittedAfterCount += 1;
    assert.equal(normalizeObservationExperienceReport(inconsistentOmittedCount), null);
    const inconsistentTruncation = JSON.parse(serialized);
    inconsistentTruncation.sessions[0].timelineScope.truncated =
      !inconsistentTruncation.sessions[0].timelineScope.truncated;
    assert.equal(normalizeObservationExperienceReport(inconsistentTruncation), null);
    const invertedScopeRange = JSON.parse(serialized);
    invertedScopeRange.sessions[0].timelineScope.sessionRecordRanges[0].startRecordIndex =
      invertedScopeRange.sessions[0].timelineScope.sessionRecordRanges[0].endRecordIndex + 1;
    assert.equal(normalizeObservationExperienceReport(invertedScopeRange), null);
    const wrongTimelineSession = JSON.parse(serialized);
    wrongTimelineSession.traceTimelines[0].sessionId = 'wrong-session';
    wrongTimelineSession.traceTimelines[0].tree.sessionId = 'wrong-session';
    assert.equal(normalizeObservationExperienceReport(wrongTimelineSession), null);
    const inconsistentSkillSummary = JSON.parse(serialized);
    inconsistentSkillSummary.skills[0].invocationCount += 1;
    assert.equal(normalizeObservationExperienceReport(inconsistentSkillSummary), null);
    const mismatchedSkillIndicators = JSON.parse(serialized);
    mismatchedSkillIndicators.skills[0].indicators.toolUnknownCount += 1;
    assert.equal(normalizeObservationExperienceReport(mismatchedSkillIndicators), null);
    const mismatchedReviewerMetrics = JSON.parse(serialized);
    mismatchedReviewerMetrics.sessions[0].reviewerReport.oneLookMetrics.toolUnknownCount += 1;
    assert.equal(normalizeObservationExperienceReport(mismatchedReviewerMetrics), null);
    const mismatchedReviewerDelivery = JSON.parse(serialized);
    mismatchedReviewerDelivery.sessions[0].reviewerReport.oneLookMetrics.assistantDeliverySignalCount += 1;
    assert.equal(normalizeObservationExperienceReport(mismatchedReviewerDelivery), null);
    const mismatchedStoryGoalCount = JSON.parse(serialized);
    mismatchedStoryGoalCount.sessions[0].sessionStory.goalSliceCount += 1;
    assert.equal(normalizeObservationExperienceReport(mismatchedStoryGoalCount), null);
    const danglingStoryInvocation = JSON.parse(serialized);
    danglingStoryInvocation.sessions[0].sessionStory.skillLinks[0].invocationIds = ['missing-invocation'];
    assert.equal(normalizeObservationExperienceReport(danglingStoryInvocation), null);
    const danglingStoryGraphEdge = JSON.parse(serialized);
    danglingStoryGraphEdge.sessions[0].sessionStory.graph.edges[0].toId = 'missing-node';
    assert.equal(normalizeObservationExperienceReport(danglingStoryGraphEdge), null);
    const danglingEpisodeEdge = JSON.parse(serialized);
    const episode = danglingEpisodeEdge.storyContexts[0].episodes[0];
    episode.orchestrationEdges.push({
      id: 'dangling-episode-edge',
      episodeId: episode.id,
      edgeKind: 'internal_skill',
      parentSkillSegmentId: 'missing-segment',
      executorSkillSegmentId: episode.skillSegments[0].id,
      status: 'started',
      evidenceRefs: [],
    });
    assert.equal(normalizeObservationExperienceReport(danglingEpisodeEdge), null);
    const danglingFeedbackAttribution = JSON.parse(serialized);
    danglingFeedbackAttribution.storyContexts[0].episodes[0]
      .feedbackSignals[0].attributions[0].skillSegmentId = 'missing-segment';
    assert.equal(normalizeObservationExperienceReport(danglingFeedbackAttribution), null);
    const danglingEpisodeGoal = JSON.parse(serialized);
    danglingEpisodeGoal.storyContexts[0].episodes[0]
      .goalEvidenceRefs[0].goalSliceId = 'missing-goal-slice';
    assert.equal(normalizeObservationExperienceReport(danglingEpisodeGoal), null);

    const additiveV3 = JSON.parse(serialized);
    for (const session of additiveV3.sessions) {
      delete session.threadId;
      delete session.sourceThreadId;
      delete session.turns;
    }
    const normalizedAdditiveV3 = normalizeObservationExperienceReport(additiveV3);
    assert.ok(normalizedAdditiveV3);
    assert.ok(normalizedAdditiveV3.sessions.every((session) => session.threadId.length > 0));
    assert.ok(normalizedAdditiveV3.sessions.every((session) => session.sourceThreadId.length > 0));
    assert.deepEqual(
      normalizedAdditiveV3.sessions.map((session) => session.turns.length),
      experience.sessions.map((session) => session.turns.length),
    );

    const legacy = JSON.parse(JSON.stringify(experience));
    legacy.schemaVersion = 2;
    delete legacy.traceTimelines;
    delete legacy.storyContexts;
    for (const goalSlice of legacy.goalSlices) {
      delete goalSlice.traceId;
      delete goalSlice.timestampObserved;
    }
    for (const legacyInvocation of legacy.invocations) {
      delete legacyInvocation.traceId;
      delete legacyInvocation.timestampObserved;
      delete legacyInvocation.timelineRef;
      delete legacyInvocation.timelineEventIds;
      delete legacyInvocation.metrics.numToolCancelled;
      delete legacyInvocation.metrics.numToolUnknown;
      delete legacyInvocation.indicators.toolCancelledCount;
      delete legacyInvocation.indicators.toolUnknownCount;
    }
    for (const legacySession of legacy.sessions) {
      const scope = legacySession.timelineScope;
      const firstRange = (ranges: Array<{ startRecordIndex: number }>) =>
        ranges.length > 0 ? ranges[0].startRecordIndex : undefined;
      const lastRange = (ranges: Array<{ endRecordIndex: number }>) =>
        ranges.length > 0 ? ranges[ranges.length - 1].endRecordIndex : undefined;
      legacySession.timelineScope = {
        mode: 'skill_segment_window',
        segmentStartRecordIndex: firstRange(scope.segmentRecordRanges),
        segmentEndRecordIndex: lastRange(scope.segmentRecordRanges),
        previewStartRecordIndex: firstRange(scope.previewRecordRanges),
        previewEndRecordIndex: lastRange(scope.previewRecordRanges),
        sessionStartRecordIndex: firstRange(scope.sessionRecordRanges) ?? 0,
        sessionEndRecordIndex: lastRange(scope.sessionRecordRanges) ?? 0,
        previewEventCount: scope.previewEventCount,
        fullSessionEventCount: scope.fullSessionEventCount,
        truncated: scope.truncated,
        omittedBeforeCount: scope.omittedBeforeCount,
        omittedAfterCount: scope.omittedAfterCount,
      };
      delete legacySession.timestampedInvocationCount;
      delete legacySession.timestampCoverage;
      delete legacySession.threadId;
      delete legacySession.sourceThreadId;
      delete legacySession.turns;
      delete legacySession.timelineRef;
      delete legacySession.timelinePreviewEventIds;
      delete legacySession.indicators.toolCancelledCount;
      delete legacySession.indicators.toolUnknownCount;
      if (legacySession.reviewerReport) {
        delete legacySession.reviewerReport.oneLookMetrics.toolCancelledCount;
        delete legacySession.reviewerReport.oneLookMetrics.toolUnknownCount;
      }
    }
    for (const legacySkill of legacy.skills) {
      delete legacySkill.timestampedInvocationCount;
      delete legacySkill.timestampCoverage;
      delete legacySkill.indicators.toolCancelledCount;
      delete legacySkill.indicators.toolUnknownCount;
    }
    const migrated = normalizeObservationExperienceReport(legacy);
    assert.ok(migrated);
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.traceTimelines.length, 1);
    assert.equal(migrated.invocations[0].timeline.length, invocation.timeline.length);

    const legacyMalformedMetrics = JSON.parse(JSON.stringify(legacy));
    legacyMalformedMetrics.invocations[0].metrics = null;
    assert.equal(normalizeObservationExperienceReport(legacyMalformedMetrics), null);
    const legacyDanglingInvocation = JSON.parse(JSON.stringify(legacy));
    legacyDanglingInvocation.sessions[0].invocationIds = ['missing-invocation'];
    assert.equal(normalizeObservationExperienceReport(legacyDanglingInvocation), null);
    const legacyMalformedSkill = JSON.parse(JSON.stringify(legacy));
    delete legacyMalformedSkill.skills[0].toolCounts;
    assert.equal(normalizeObservationExperienceReport(legacyMalformedSkill), null);
    const legacyMalformedScope = JSON.parse(JSON.stringify(legacy));
    legacyMalformedScope.sessions[0].timelineScope.sessionStartRecordIndex =
      legacyMalformedScope.sessions[0].timelineScope.sessionEndRecordIndex + 1;
    assert.equal(normalizeObservationExperienceReport(legacyMalformedScope), null);
  });
});

// ---------- Segment by skill ----------

describe('segmentBySkill', () => {
  it('no skill signal → single "general" segment', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [{ type: 'text', text: 'hello' }]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'general');
  });

  it('slash-command signal cuts new segment', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [{ type: 'text', text: 'hi' }]),
        userRec('u1', '<command-name>/audit</command-name>\n<command-message>audit</command-message>'),
        asstRec('a2', [
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x.md' } },
        ]),
        userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].skillName, 'general');
    assert.equal(segs[1].skillName, 'audit');
    assert.equal(segs[1].attribution?.source, 'command-name');
    assert.equal(segs[1].attribution?.commandName, '/audit');
    assert.equal(segs[1].turns.some((turn) => turn.content.includes('<command-message>')), false);
    assert.equal(segs[1].toolCalls.length, 1);
    assert.equal(segs[1].toolCalls[0].tool, 'Read');
  });

  it('keeps segmentation and event-level model attribution source-neutral', () => {
    const makeSession = (sourceKind: TraceSession['sourceKind']): TraceSession => ({
      runId: `run-${sourceKind}`,
      rootRunId: `run-${sourceKind}`,
      traceId: `trace-${sourceKind}`,
      groupPath: '/repo',
      role: 'standalone',
      label: sourceKind,
      sourcePath: `/repo/${sourceKind}.jsonl`,
      sourceKind,
      sourceMetadata: { provider: 'example-provider', model: 'session-model' },
      events: [
        {
          eventKind: 'message',
          eventId: `${sourceKind}:user`,
          sourceIndex: 0,
          sourceType: 'message',
          timestamp: '2026-07-25T00:00:00.000Z',
          role: 'user',
          origin: 'human',
          text: '<command-name>/audit</command-name>',
        },
        {
          eventKind: 'tool_call',
          eventId: `${sourceKind}:read`,
          sourceIndex: 1,
          sourceType: 'tool_call',
          timestamp: '2026-07-25T00:00:01.000Z',
          callId: `${sourceKind}:read`,
          tool: { name: 'Read' },
          input: { file_path: '/repo/.agents/skills/reference/SKILL.md' },
          model: 'turn-model',
        },
        {
          eventKind: 'tool_result',
          eventId: `${sourceKind}:result`,
          sourceIndex: 2,
          sourceType: 'tool_result',
          timestamp: '2026-07-25T00:00:02.000Z',
          callId: `${sourceKind}:read`,
          output: '# Reference',
          status: 'success',
          statusSource: 'runtime',
        },
      ],
    });

    const summaries = (['claude', 'codex', 'dsh', 'openclaw', 'unknown'] as const).map((sourceKind) => {
      const segments = segmentBySkill(makeSession(sourceKind));
      return {
        skills: segments.map((segment) => segment.skillName),
        models: segments.map((segment) => segment.sourceMetadata?.model),
      };
    });

    assert.deepEqual(summaries, summaries.map(() => ({
      skills: ['audit'],
      models: ['turn-model'],
    })));
  });

  it('derives segment bounds from source evidence instead of trusting record order', () => {
    const session: TraceSession = {
      runId: 'out-of-order-time',
      rootRunId: 'out-of-order-time',
      traceId: 'out-of-order-time',
      groupPath: '/repo',
      role: 'standalone',
      label: 'out-of-order-time',
      sourcePath: '/repo/out-of-order-time.jsonl',
      sourceKind: 'unknown',
      startTimestamp: '2026-07-25T00:00:05.000Z',
      events: [
        {
          eventKind: 'message',
          eventId: 'earlier',
          sourceIndex: 0,
          sourceType: 'message',
          timestamp: '2026-07-25T00:00:01.000Z',
          role: 'assistant',
          origin: 'synthetic',
          text: 'start',
        },
        {
          eventKind: 'message',
          eventId: 'later',
          sourceIndex: 1,
          sourceType: 'message',
          timestamp: '2026-07-25T00:00:09.000Z',
          role: 'assistant',
          origin: 'synthetic',
          text: 'end',
        },
      ],
    };

    const [segment] = segmentBySkill(session);
    assert.equal(segment.startTimestamp, '2026-07-25T00:00:01.000Z');
    assert.equal(segment.endTimestamp, '2026-07-25T00:00:09.000Z');
    assert.equal(segment.metrics.durationMs, 8_000);
  });

  it('normalizes mixed timezone offsets before deriving segment bounds', () => {
    const [segment] = segmentBySkill({
      sessionId: 'mixed-offsets',
      sourcePath: '/repo/mixed-offsets.jsonl',
      records: [
        asstRec('later', [{ type: 'text', text: 'later' }], {
          timestamp: '2026-07-25T08:00:09.000+08:00',
        }),
        asstRec('earlier', [{ type: 'text', text: 'earlier' }], {
          timestamp: '2026-07-25T00:00:01.000Z',
        }),
      ],
    });

    assert.equal(segment.startTimestamp, '2026-07-25T00:00:01.000Z');
    assert.equal(segment.endTimestamp, '2026-07-25T00:00:09.000Z');
    assert.equal(segment.metrics.durationMs, 8_000);
  });

  it('derives loaded session bounds from all timestamp evidence', () => {
    const path = writeSession(tmpDir, 'out-of-order-session.jsonl', [
      asstRec('later', [{ type: 'text', text: 'later' }], {
        sessionId: 'out-of-order-session',
        timestamp: '2026-07-25T08:00:09.000+08:00',
      }),
      asstRec('earlier', [{ type: 'text', text: 'earlier' }], {
        sessionId: 'out-of-order-session',
        timestamp: '2026-07-25T00:00:01.000Z',
      }),
    ]);

    const [session] = loadCcSessions(path);
    assert.equal(session.startTimestamp, '2026-07-25T00:00:01.000Z');
    assert.equal(session.endTimestamp, '2026-07-25T00:00:09.000Z');
  });

  it('Skill tool_use signal cuts new segment', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [{ type: 'tool_use', id: 'tu0', name: 'Skill', input: { skill: 'wiki', args: 'publish' } }]),
        userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu0', content: 'done' }]),
        asstRec('a2', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x.md' } }]),
        userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'content' }]),
      ],
    };
    const segs = segmentBySkill(s);
    // Skill tool_use 本身也归属 wiki 段, 因为信号触发即切段, 该条 tool_use 进入新段
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'wiki');
  });

  it('multiple skills in one session → multiple segments', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        userRec('u1', '<command-name>/audit</command-name>'),
        asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
        userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
        userRec('u3', '<command-name>/polish</command-name>'),
        asstRec('a2', [{ type: 'tool_use', id: 'tu2', name: 'Grep', input: {} }]),
        userRec('u4', [{ type: 'tool_result', tool_use_id: 'tu2', content: 'y' }]),
      ],
    };
    const segs = segmentBySkill(s);
    const skills = segs.map((seg) => seg.skillName);
    assert.ok(skills.includes('audit'));
    assert.ok(skills.includes('polish'));
    const audit = segs.find((seg) => seg.skillName === 'audit')!;
    const polish = segs.find((seg) => seg.skillName === 'polish')!;
    assert.equal(audit.toolCalls[0].tool, 'Read');
    assert.equal(polish.toolCalls[0].tool, 'Grep');
  });

  it('is_error=true → ToolCallInfo.success=false + numToolFailures++', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'foo' } }]),
        userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'err', is_error: true }]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].toolCalls[0].success, false);
    assert.equal(segs[0].metrics.numToolFailures, 1);
  });

  it('keeps cancelled tool results separate from failures and success-rate evidence', () => {
    const session: TraceSession = {
      runId: 'cancelled-run',
      rootRunId: 'cancelled-run',
      traceId: 'cancelled-run',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'cancelled-run',
      sourcePath: '/tmp/cancelled.jsonl',
      sourceKind: 'codex',
      events: [
        {
          eventKind: 'tool_call',
          eventId: 'call',
          sourceIndex: 0,
          sourceType: 'response_item:function_call',
          callId: 'c1',
          tool: { name: 'Grep' },
          input: { pattern: 'needle' },
        },
        {
          eventKind: 'tool_result',
          eventId: 'result',
          sourceIndex: 1,
          sourceType: 'response_item:function_call_output',
          callId: 'c1',
          output: '',
          status: 'cancelled',
          statusSource: 'runtime',
        },
      ],
    };

    const [segment] = segmentBySkill(session);
    assert.equal(segment.toolCalls[0].status, 'cancelled');
    assert.equal(segment.metrics.numToolFailures, 0);
    assert.equal(segment.metrics.numToolCancelled, 1);
    assert.equal(segment.metrics.numToolUnknown, 0);
    const result = segmentsToAnalysisEntries([segment])[0].variants.general;
    assert.equal(result.numToolFailures, 0);
    assert.equal(result.numToolCancelled, 1);
    assert.equal(result.numToolUnknown, 0);
    assert.equal(result.toolSuccessRate, undefined);
  });

  it('orphan tool_use (no matching result) stays unknown without inflating failures', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [{ type: 'tool_use', id: 'tu-orphan', name: 'Read', input: {} }]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs[0].toolCalls[0].success, false);
    assert.equal(segs[0].toolCalls[0].status, 'unknown');
    assert.equal(segs[0].metrics.numToolFailures, 0);
    assert.equal(segs[0].metrics.numToolUnknown, 1);
    const result = segmentsToAnalysisEntries(segs)[0].variants.general;
    assert.equal(result.numToolUnknown, 1);
    assert.equal(result.toolSuccessRate, undefined);
  });

  it('keeps assistant text and Skill tool use from one source record in the same segment', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [
          { type: 'text', text: 'I will inspect it.' },
          {
            type: 'tool_use',
            id: 'tu-skill',
            name: 'Skill',
            input: { skill: 'demo' },
          },
        ]),
      ],
    };

    const segs = segmentBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'demo');
    assert.equal(segs[0].turns[0]?.content, 'I will inspect it.');
    assert.equal(segs[0].turns[0]?.toolCalls?.[0]?.tool, 'Skill');
  });

  it('coalesces source-neutral tool-before-text events from one record into one turn', () => {
    const session = {
      runId: 'ir-order',
      rootRunId: 'ir-order',
      traceId: 'ir-order',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'ir-order',
      sourcePath: '/tmp/ir-order.jsonl',
      sourceKind: 'unknown',
      events: [
        {
          eventKind: 'tool_call',
          eventId: 'call',
          sourceIndex: 0,
          sourceType: 'custom',
          callId: 'call-1',
          tool: { name: 'Skill' },
          input: { skill: 'demo' },
        },
        {
          eventKind: 'message',
          eventId: 'message',
          sourceIndex: 0,
          sourceType: 'custom',
          role: 'assistant',
          origin: 'synthetic',
          text: 'I will inspect it.',
        },
      ],
    } satisfies TraceSession;

    const [segment] = segmentBySkill(session);
    assert.equal(segment.metrics.numTurns, 1);
    assert.equal(segment.turns[0]?.content, 'I will inspect it.');
    assert.equal(segment.turns[0]?.toolCalls?.[0]?.tool, 'Skill');
  });

  it('correlates same-record tool results independently of adapter event order', () => {
    const session = {
      runId: 'ir-result-first',
      rootRunId: 'ir-result-first',
      traceId: 'ir-result-first',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'ir-result-first',
      sourcePath: '/tmp/ir-result-first.jsonl',
      sourceKind: 'unknown',
      events: [
        {
          eventKind: 'tool_result',
          eventId: 'result',
          sourceIndex: 0,
          sourceType: 'custom',
          callId: 'call-1',
          output: 'done',
          status: 'success',
          statusSource: 'runtime',
        },
        {
          eventKind: 'tool_call',
          eventId: 'call',
          sourceIndex: 0,
          sourceType: 'custom',
          callId: 'call-1',
          tool: { name: 'Skill' },
          input: { skill: 'demo' },
        },
      ],
    } satisfies TraceSession;

    const [segment] = segmentBySkill(session);
    assert.equal(segment.toolCalls[0].status, 'success');
    assert.equal(segment.toolCalls[0].output, 'done');
    assert.equal(segment.metrics.numToolUnknown, 0);
  });

  it('correlates reused call ids in FIFO order without dropping an invocation', () => {
    const session = {
      runId: 'ir-reused-call-id',
      rootRunId: 'ir-reused-call-id',
      traceId: 'ir-reused-call-id',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'ir-reused-call-id',
      sourcePath: '/tmp/ir-reused-call-id.jsonl',
      sourceKind: 'unknown',
      events: [
        {
          eventKind: 'tool_call',
          eventId: 'call-1',
          sourceIndex: 0,
          sourceType: 'custom',
          callId: 'reused',
          tool: { name: 'Read' },
          input: { file_path: '/first' },
        },
        {
          eventKind: 'tool_call',
          eventId: 'call-2',
          sourceIndex: 1,
          sourceType: 'custom',
          callId: 'reused',
          tool: { name: 'Read' },
          input: { file_path: '/second' },
        },
        {
          eventKind: 'tool_result',
          eventId: 'result-1',
          sourceIndex: 2,
          sourceType: 'custom',
          callId: 'reused',
          output: 'first result',
          status: 'success',
          statusSource: 'runtime',
        },
        {
          eventKind: 'tool_result',
          eventId: 'result-2',
          sourceIndex: 3,
          sourceType: 'custom',
          callId: 'reused',
          output: 'second result',
          status: 'failure',
          statusSource: 'runtime',
        },
      ],
    } satisfies TraceSession;

    const [segment] = segmentBySkill(session);
    assert.deepEqual(
      segment.toolCalls.map((call) => [call.input, call.output, call.status]),
      [
        [{ file_path: '/first' }, 'first result', 'success'],
        [{ file_path: '/second' }, 'second result', 'failure'],
      ],
    );
    assert.equal(segment.metrics.numToolFailures, 1);
    assert.equal(segment.metrics.numToolUnknown, 0);
    assert.deepEqual(
      segment.toolCalls.map((call) => call.callInstanceId),
      ['call-1', 'call-2'],
    );
  });

  it('keeps reused call ids isolated across skill boundaries', () => {
    const session = {
      runId: 'ir-reused-call-id-across-skills',
      rootRunId: 'ir-reused-call-id-across-skills',
      traceId: 'ir-reused-call-id-across-skills',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'ir-reused-call-id-across-skills',
      sourcePath: '/tmp/ir-reused-call-id-across-skills.jsonl',
      sourceKind: 'unknown',
      events: [
        {
          eventKind: 'message',
          eventId: 'alpha-command',
          sourceIndex: 0,
          sourceType: 'custom',
          role: 'user',
          origin: 'human',
          text: '<command-name>/alpha</command-name>\nRun alpha.',
        },
        {
          eventKind: 'tool_call',
          eventId: 'alpha-call',
          sourceIndex: 1,
          sourceType: 'custom',
          callId: 'reused',
          tool: { name: 'Read' },
          input: { file_path: '/alpha' },
        },
        {
          eventKind: 'message',
          eventId: 'beta-command',
          sourceIndex: 2,
          sourceType: 'custom',
          role: 'user',
          origin: 'human',
          text: '<command-name>/beta</command-name>\nRun beta.',
        },
        {
          eventKind: 'tool_result',
          eventId: 'alpha-result',
          sourceIndex: 3,
          sourceType: 'custom',
          callId: 'reused',
          output: 'alpha failed',
          status: 'failure',
          statusSource: 'runtime',
        },
        {
          eventKind: 'tool_call',
          eventId: 'beta-call',
          sourceIndex: 4,
          sourceType: 'custom',
          callId: 'reused',
          tool: { name: 'Read' },
          input: { file_path: '/beta' },
        },
        {
          eventKind: 'tool_result',
          eventId: 'beta-result',
          sourceIndex: 5,
          sourceType: 'custom',
          callId: 'reused',
          output: 'beta passed',
          status: 'success',
          statusSource: 'runtime',
        },
      ],
    } satisfies TraceSession;

    const segments = segmentBySkill(session);
    const report = buildObservationExperienceReport({
      sessions: [session],
      segments,
      items: [],
      generatedAt: '2026-07-25T00:00:00.000Z',
    });
    const alpha = report.invocations.find((invocation) => invocation.skillName === 'alpha');
    const beta = report.invocations.find((invocation) => invocation.skillName === 'beta');

    assert.ok(alpha);
    assert.ok(beta);
    assert.equal(alpha.indicators.toolFailureCount, 1);
    assert.equal(beta.indicators.toolFailureCount, 0);
    assert.equal(
      segments.find((segment) => segment.skillName === 'alpha')?.toolCalls[0].callInstanceId,
      'alpha-call',
    );
    assert.equal(
      segments.find((segment) => segment.skillName === 'beta')?.toolCalls[0].callInstanceId,
      'beta-call',
    );
    assert.ok(alpha.timeline.some((event) =>
      event.kind === 'tool_result' && event.callInstanceId === 'alpha-call'
    ));
    assert.ok(normalizeObservationExperienceReport(
      compactObservationExperienceReport(report),
    ));
  });

  it('preserves human messages as user turns instead of tool results', () => {
    const [segment] = segmentBySkill({
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        userRec('u1', '<command-name>/audit</command-name>\nPlease inspect this.'),
        asstRec('a1', [{ type: 'text', text: 'Done.' }]),
      ],
    });

    assert.deepEqual(
      segment.turns.map((turn) => [turn.role, turn.content]),
      [
        ['user', 'Please inspect this.'],
        ['assistant', 'Done.'],
      ],
    );
    assert.equal(segment.metrics.numTurns, 1);
  });

  it('keeps a late tool result on its originating call without overlapping skill record ranges', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        userRec('u0', '<command-name>/audit</command-name>'),
        asstRec('a1', [{ type: 'tool_use', id: 'tu-late', name: 'Read', input: {} }]),
        userRec('u1', '<command-name>/review</command-name>'),
        userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu-late', content: 'done' }]),
        asstRec('a2', [{ type: 'text', text: 'review done' }]),
      ],
    };

    const [audit, review] = segmentBySkill(s);
    assert.equal(audit.skillName, 'audit');
    assert.equal(audit.toolCalls[0].output, 'done');
    assert.equal(audit.endRecordIndex, 1);
    assert.equal(review.skillName, 'review');
    assert.equal(review.startRecordIndex, 2);
    assert.equal(review.endRecordIndex, 4);
  });

  it('Read .claude/skills/<name>/SKILL.md signal cuts new segment (signal 3 fallback)', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/home/user/project/.claude/skills/review/SKILL.md' } }]),
        userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'skill body' }]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'review');
  });

  it('recognizes Codex plugin-cache skills but ignores repository skill fixtures', () => {
    const installed = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [{
          type: 'tool_use',
          id: 'tu1',
          name: 'Read',
          input: {
            file_path: '/home/user/.codex/plugins/cache/openai-bundled/browser/1.0.0/skills/control-browser/SKILL.md',
          },
        }]),
      ],
    };
    const fixture = {
      sessionId: 's2',
      sourcePath: '/t',
      records: [
        asstRec('a2', [{
          type: 'tool_use',
          id: 'tu2',
          name: 'Read',
          input: {
            file_path: '/repo/examples/agent-eval/skills/strict-reader/SKILL.md',
          },
        }], { sessionId: 's2' }),
      ],
    };

    assert.equal(segmentBySkill(installed)[0].skillName, 'control-browser');
    assert.equal(segmentBySkill(fixture)[0].skillName, 'general');
  });

  it('signal 1 (Skill tool_use) wins over signal 3 (Read SKILL.md) when both present', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [
          { type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'audit' } },
          { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '.claude/skills/other/SKILL.md' } },
        ]),
        userRec('u1', [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'x' },
          { type: 'tool_result', tool_use_id: 'tu2', content: 'y' },
        ]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'audit');
  });

  it('signal 2 (slash command) wins over signal 3 (Read SKILL.md)', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        userRec('u1', '<command-name>/polish</command-name>'),
        asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '.claude/skills/other/SKILL.md' } }]),
        userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'polish');
  });

  it('repeated Read of same SKILL.md does not cut multiple segments', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '.claude/skills/review/SKILL.md' } }]),
        userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
        asstRec('a2', [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '.claude/skills/review/SKILL.md' } }]),
        userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu2', content: 'y' }]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'review');
  });

  it('Read non-SKILL.md file does not trigger signal 3', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '.claude/skills/review/references/cmds.md' } }]),
        userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'general');
  });

  it('CC builtin command (/clear, /model, /exit) is NOT treated as skill', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        userRec('u1', '<command-name>/clear</command-name>'),
        asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
        userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'general', '/clear 是 cc 内置命令, 不切段');
  });

  it('does not leak Claude builtin command names into source-neutral skill identity', () => {
    assert.equal(normalizeSkillName('doctor'), 'doctor');
    const [codexSegment] = segmentBySkill({
      sessionId: 'codex-doctor',
      sourcePath: '/tmp/codex-doctor.jsonl',
      sourceKind: 'codex',
      records: [
        userRec('u1', '<command-name>/doctor</command-name>\nRun the skill.'),
        asstRec('a1', [{ type: 'text', text: 'Done.' }]),
      ],
    });
    assert.equal(codexSegment.skillName, 'doctor');

    const [explicitSkillSegment] = segmentBySkill({
      sessionId: 'claude-doctor-skill',
      sourcePath: '/tmp/claude-doctor.jsonl',
      sourceKind: 'claude',
      records: [
        asstRec('a1', [{
          type: 'tool_use',
          id: 'doctor-call',
          name: 'Skill',
          input: { skill: 'doctor' },
        }]),
      ],
    });
    assert.equal(explicitSkillSegment.skillName, 'doctor');
  });

  it('rejects unsafe or non-slug skill identities at the attribution boundary', () => {
    for (const command of ['__proto__', 'constructor', '../audit', 'audit/child']) {
      const [segment] = segmentBySkill({
        sessionId: `unsafe-${command}`,
        sourcePath: '/tmp/unsafe.jsonl',
        records: [
          userRec('u1', `<command-name>/${command}</command-name>\nInspect this.`),
          asstRec('a1', [{ type: 'text', text: 'Done.' }]),
        ],
      });
      assert.equal(segment.skillName, 'general');
    }
  });

  it('plugin-prefixed skill name keeps source metadata (pbakaus/impeccable:audit → audit from plugin)', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'pbakaus/impeccable:audit' } }]),
        userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]),
        asstRec('a2', [{ type: 'tool_use', id: 'tu2', name: 'Skill', input: { skill: 'impeccable:audit' } }]),
        userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }]),
      ],
    };
    const segs = segmentBySkill(s);
    // skillName 仍归一化为 audit, 但 plugin 来源不同, 需要保留成两段。
    assert.equal(segs.length, 2);
    assert.equal(segs[0].skillName, 'audit');
    assert.equal(segs[0].attribution?.rawSkillRef, 'pbakaus/impeccable:audit');
    assert.equal(segs[0].attribution?.pluginName, 'pbakaus/impeccable');
    assert.equal(segs[1].skillName, 'audit');
    assert.equal(segs[1].attribution?.rawSkillRef, 'impeccable:audit');
    assert.equal(segs[1].attribution?.pluginName, 'impeccable');
  });

  it('plugin slash command keeps source metadata and command name', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        userRec('u1', '<command-name>/code-security:secure-coding</command-name>\n<command-message>code-security:secure-coding</command-message>'),
        asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'secure-coding');
    assert.equal(segs[0].attribution?.source, 'command-name');
    assert.equal(segs[0].attribution?.rawSkillRef, 'code-security:secure-coding');
    assert.equal(segs[0].attribution?.pluginName, 'code-security');
    assert.equal(segs[0].attribution?.commandName, '/code-security:secure-coding');
  });

  it('repeated same-skill signal does not create spurious empty segments', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        userRec('u1', '<command-name>/audit</command-name>'),
        userRec('u2', '<command-name>/audit</command-name>'),  // 重复,不应切段
        asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
        userRec('u3', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'audit');
  });

  it('token usage accumulates into segment metrics', () => {
    const first = asstRec('a1', [{ type: 'text', text: 'a' }]) as {
      message: { usage: { cache_read_input_tokens: number } };
    };
    first.message.usage.cache_read_input_tokens = 7;
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        first,
        asstRec('a2', [{ type: 'text', text: 'b' }]),
      ],
    };
    const segs = segmentBySkill(s);
    // 每条 asstRec 默认 input=10 output=20 → 累加 2 次
    assert.equal(segs[0].metrics.inputTokens, 20);
    assert.equal(segs[0].metrics.outputTokens, 40);
    assert.equal(segs[0].metrics.cacheReadTokens, 7);
    assert.equal(segs[0].metrics.tokenUsageObserved, true);
  });

  it('fails closed when aggregated segment token usage exceeds a safe integer', () => {
    const session: TraceSession = {
      runId: 'overflow',
      rootRunId: 'overflow',
      traceId: 'trace-overflow',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'overflow',
      sourcePath: '/tmp/overflow.jsonl',
      sourceKind: 'codex',
      events: [
        {
          eventKind: 'message',
          eventId: 'answer',
          sourceIndex: 0,
          sourceType: 'message',
          role: 'assistant',
          origin: 'runtime',
          text: 'done',
        },
        {
          eventKind: 'usage',
          eventId: 'usage-1',
          sourceIndex: 0,
          sourceType: 'usage',
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        {
          eventKind: 'usage',
          eventId: 'usage-2',
          sourceIndex: 1,
          sourceType: 'usage',
          inputTokens: 1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    };

    const [segment] = segmentBySkill(session);
    assert.equal(segment.metrics.inputTokens, 0);
    assert.equal(segment.metrics.tokenUsageObserved, false);
    const projected = segmentsToAnalysisEntries([segment])[0].variants.general;
    assert.equal(projected.totalTokens, 0);
    assert.equal(projected.tokenUsageReportedByExecutor, false);
  });
});

// ---------- Segments → ResultEntries ----------

describe('segmentsToAnalysisEntries', () => {
  it('each segment → one AnalysisEntry with skill as variant key', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        userRec('u1', '<command-name>/audit</command-name>'),
        asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
        userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
      ],
    };
    const segs = segmentBySkill(s);
    const entries = segmentsToAnalysisEntries(segs);
    assert.equal(entries.length, 1);
    assert.match(entries[0].sampleId, /^trace:[a-f0-9]{32}$/);
    assert.ok('audit' in entries[0].variants);
    assert.equal(entries[0].variants.audit.toolCalls?.length, 1);
    assert.equal(entries[0].variants.audit.numToolCalls, 1);
    assert.deepEqual(entries[0].variants.audit.toolDistribution, { Read: 1 });
  });

  it('projects repeated tool calls as call-count distribution', () => {
    const [segment] = segmentBySkill({
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [
          { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tu2', name: 'Read', input: {} },
        ]),
      ],
    });
    const result = segmentsToAnalysisEntries([segment])[0].variants.general;
    assert.deepEqual(result.toolNames, ['Read']);
    assert.deepEqual(result.toolDistribution, { Read: 2 });
  });

  it('rounds projected tool success rates to the persisted report contract', () => {
    const [segment] = segmentBySkill({
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [
          { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tu2', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tu3', name: 'Read', input: {} },
        ]),
        userRec('u2', [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'tu2', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'tu3', content: 'failed', is_error: true },
        ]),
      ],
    });
    segment.metrics.numToolFailures = 1;
    segment.metrics.numToolUnknown = 0;
    segment.metrics.numToolCancelled = 0;
    segment.toolCalls[0].status = 'success';
    segment.toolCalls[0].statusSource = 'runtime';
    segment.toolCalls[0].success = true;
    segment.toolCalls[1].status = 'success';
    segment.toolCalls[1].statusSource = 'runtime';
    segment.toolCalls[1].success = true;
    segment.toolCalls[2].status = 'failure';
    segment.toolCalls[2].statusSource = 'runtime';
    segment.toolCalls[2].success = false;

    const result = segmentsToAnalysisEntries([segment])[0].variants.general;
    assert.equal(result.toolSuccessRate, 0.67);
  });

  it('bounds persisted trace payloads without mutating the source segment', () => {
    const longOutput = `start-${'x'.repeat(1500)}`;
    const longTurn = `question-${'y'.repeat(2500)}`;
    const [segment] = segmentBySkill({
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        userRec('u1', longTurn),
        asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
        userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: longOutput }]),
      ],
    });

    const result = segmentsToAnalysisEntries([segment])[0].variants.general;
    assert.equal(result.turns?.[0].content.length, 2001);
    assert.equal(String(result.toolCalls?.[0].output).length, 1001);
    assert.equal(segment.turns[0].content, longTurn);
    assert.equal(segment.toolCalls[0].output, longOutput);
  });

  it('anchors sample identity to the physical segment start instead of its mutable ordinal', () => {
    const [segment] = segmentBySkill({
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        userRec('u1', '<command-name>/audit</command-name>'),
        asstRec('a1', [{ type: 'text', text: 'done' }]),
      ],
    });
    const original = segmentsToAnalysisEntries([segment])[0].sampleId;
    const shiftedOrdinal = segmentsToAnalysisEntries([{
      ...segment,
      segmentIndex: segment.segmentIndex + 3,
      endRecordIndex: (segment.endRecordIndex ?? 0) + 20,
    }])[0].sampleId;
    const changedBoundary = segmentsToAnalysisEntries([{
      ...segment,
      startRecordIndex: (segment.startRecordIndex ?? 0) + 1,
    }])[0].sampleId;
    const changedSkill = segmentsToAnalysisEntries([{
      ...segment,
      skillName: 'other',
    }])[0].sampleId;

    assert.equal(shiftedOrdinal, original);
    assert.notEqual(changedBoundary, original);
    assert.notEqual(changedSkill, original);
  });

  it('includes cache token buckets in the projected total', () => {
    const first = asstRec('a1', [{ type: 'text', text: 'a' }]) as {
      message: {
        usage: {
          cache_read_input_tokens: number;
          cache_creation_input_tokens: number;
        };
      };
    };
    first.message.usage.cache_read_input_tokens = 7;
    first.message.usage.cache_creation_input_tokens = 5;

    const [segment] = segmentBySkill({
      sessionId: 's1',
      sourcePath: '/t',
      records: [first],
    });
    const result = segmentsToAnalysisEntries([segment])[0].variants.general;

    assert.equal(result.totalTokens, 42);
    assert.equal(result.tokenUsageReportedByExecutor, undefined);
  });
});

describe('tracesToAnalysisEntries (end-to-end)', () => {
  it('loads dir, segments, converts to entries', () => {
    writeSession(tmpDir, 'x.jsonl', [
      { type: 'permission-mode', sessionId: 'sx' },
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }], { sessionId: 'sx' }),
      userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }], { sessionId: 'sx' }),
    ]);
    const { entries, sessions, segments } = tracesToAnalysisEntries(tmpDir);
    assert.equal(sessions.length, 1);
    assert.equal(segments.length, 1);
    assert.equal(entries.length, 1);
    assert.equal(segments[0].skillName, 'general');
  });
});
