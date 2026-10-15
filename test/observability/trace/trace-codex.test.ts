import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTraceSessions, loadTraceCorpus, segmentTraceBySkill } from '../../../src/observability/trace/index.js';
import { buildObservationExperienceReport, projectTraceSessionTimeline } from '../../../src/observability/experience.js';
import { reconstructExperienceTurns } from '../../../src/observability/conversation/turn-index.js';
import { jsonl, writeSession, traceFixture } from '../../helpers/trace-fixtures.js';

const fixture = traceFixture();

describe('codex trace loading', () => {
  it('accounts for filtered Codex guardian sessions', () => {
    const path = writeSession(fixture.directory, 'guardian.jsonl', [{
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
    const path = writeSession(fixture.directory, 'truncated-codex.jsonl', [{
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
    const path = writeSession(fixture.directory, 'codex-attachment-envelope.jsonl', [{
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
    const path = writeSession(fixture.directory, 'codex-attachment-mirror.jsonl', [
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

    const [session] = loadTraceSessions(path);
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
    const path = writeSession(fixture.directory, 'codex-ambient-browser-context.jsonl', [
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

    const [session] = loadTraceSessions(path);
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
    const path = writeSession(fixture.directory, 'not-codex.jsonl', [{
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'response_item',
      payload: { applicationEvent: 'custom' },
    }]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions[0].sourceKind, 'unknown');
    assert.equal(corpus.sessions[0].events[0].eventKind, 'unknown');
  });

  it('projects Codex reasoning visibility while keeping other protocol metadata transparent', () => {
    const path = writeSession(fixture.directory, 'known-codex-metadata.jsonl', [
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
    const path = writeSession(fixture.directory, 'codex-runtime-context.jsonl', [
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
    const path = writeSession(fixture.directory, 'codex-reasoning-plaintext.jsonl', [
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

  it('treats a completed Codex exec envelope as success despite failure-shaped source text', () => {
    const path = writeSession(fixture.directory, 'codex-exec-completed.jsonl', [
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

  it('recognizes Codex rate-limit-only token snapshots without inventing usage', () => {
    const path = writeSession(fixture.directory, 'codex-rate-limit-snapshot.jsonl', [
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
    const path = writeSession(fixture.directory, 'unknown-codex-event.jsonl', [
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

  it('loads Codex rollout JSONL with skill attribution, tools, tokens, and parent task metadata', () => {
    const path = join(fixture.directory, 'rollout-codex.jsonl');
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

    const [session] = loadTraceSessions(path);
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

    const segments = segmentTraceBySkill(session);
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
    const path = writeSession(fixture.directory, 'codex-hybrid-messages.jsonl', [
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

    const [session] = loadTraceSessions(path);
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
      segments: segmentTraceBySkill(session),
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
      const path = writeSession(fixture.directory, `codex-entrypoint-${expected}-${originator}.jsonl`, [{
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: `codex-entrypoint-${originator}`,
          cwd: '/repo',
          originator,
          model_provider: 'openai',
        },
      }]);
      assert.equal(loadTraceSessions(path)[0].entrypoint, expected);
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
    const path = writeSession(fixture.directory, 'codex-explicit-success.jsonl', records);

    const [session] = loadTraceSessions(path);
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
    const path = writeSession(fixture.directory, 'codex-review-subagent.jsonl', [
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

    const [session] = loadTraceSessions(path);
    assert.equal(session.role, 'subagent');
    assert.equal(session.rootRunId, 'codex-review');
    assert.equal(session.label, 'subagent/codex-review');
  });

  it('normalizes Codex turn_aborted as an interrupted session signal', () => {
    const path = join(fixture.directory, 'rollout-codex-aborted.jsonl');
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

    const [session] = loadTraceSessions(path);
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

    const segments = segmentTraceBySkill(session);
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
    const path = writeSession(fixture.directory, 'rollout-codex-interrupted.jsonl', [
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

    const [session] = loadTraceSessions(path);
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
    const path = join(fixture.directory, 'rollout-codex-desktop.jsonl');
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

    const [session] = loadTraceSessions(path);
    assert.equal(session.sourceMetadata?.model, 'gpt-5.5, gpt-5.6-sol');

    const segments = segmentTraceBySkill(session);
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
    const path = join(fixture.directory, 'rollout-codex-malformed-token-delta.jsonl');
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

    const [session] = loadTraceSessions(path);
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 1);
    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.metrics.inputTokens, 100);
    assert.equal(segment.metrics.outputTokens, 10);
  });

  it('keeps an MCP provider in the tool identity when no end event is available', () => {
    const path = join(fixture.directory, 'rollout-codex-mcp-name-only.jsonl');
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

    const [session] = loadTraceSessions(path);
    const call = session.events.find((event) => event.eventKind === 'tool_call');
    assert.equal(call?.eventKind, 'tool_call');
    if (call?.eventKind !== 'tool_call') assert.fail('missing tool call');
    assert.equal(call.tool.name, 'github.fetch_file');
    assert.equal(call.tool.provider, 'github');
    assert.equal(call.tool.namespace, 'mcp__github');
  });

  it('preserves modern Codex tool events without retaining large payloads', () => {
    const path = join(fixture.directory, 'rollout-codex-modern-tools.jsonl');
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

    const [session] = loadTraceSessions(path);
    const audit = segmentTraceBySkill(session).find((segment) => segment.skillName === 'audit');
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
    const path = writeSession(fixture.directory, 'codex-web-completion.jsonl', [
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

    const [toolCall] = segmentTraceBySkill(loadTraceSessions(path)[0])[0].toolCalls;
    assert.equal(toolCall.tool, 'web.run');
    assert.equal(toolCall.status, 'success');
    assert.equal(toolCall.statusSource, 'inferred');
  });

  it('excludes Codex guardian rollouts from observation sessions', () => {
    const path = join(fixture.directory, 'rollout-codex-guardian.jsonl');
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

    assert.deepEqual(loadTraceSessions(path), []);
  });

  it('groups nested Codex subagents under the root logical session', () => {
    writeSession(fixture.directory, 'rollout-main.jsonl', [{
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
    writeSession(fixture.directory, 'rollout-child.jsonl', [{
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
    writeSession(fixture.directory, 'rollout-grandchild.jsonl', [{
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

    const sessions = loadTraceSessions(fixture.directory).sort((a, b) => a.runId.localeCompare(b.runId));
    assert.equal(sessions.length, 3);
    assert.deepEqual(sessions.map((session) => session.role), ['subagent', 'subagent', 'main']);
    assert.deepEqual(new Set(sessions.map((session) => session.rootRunId)), new Set(['codex-parent']));
    assert.deepEqual(new Set(sessions.map((session) => session.groupPath)), new Set(['codex:codex-parent']));
  });
});
