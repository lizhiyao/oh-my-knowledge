import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCcSessions,
  segmentBySkill,
  segmentsToResultEntries,
  ccTracesToResultEntries,
} from '../../src/observability/trace-adapter.js';
import { buildObservationExperienceReport } from '../../src/observability/experience.js';

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
    assert.equal(sessions[0].sessionId, 's1');
  });

  it('loads multiple JSONL from directory', () => {
    writeSession(tmpDir, 'a.jsonl', [{ type: 'permission-mode', sessionId: 'sa' }]);
    writeSession(tmpDir, 'b.jsonl', [{ type: 'permission-mode', sessionId: 'sb' }]);
    const sessions = loadCcSessions(tmpDir);
    assert.equal(sessions.length, 2);
    const ids = sessions.map((s) => s.sessionId).sort();
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
    assert.deepEqual(new Set(sessions.map((session) => session.sessionGroupId)), new Set(['sessionA']));
    assert.deepEqual(sessions.map((session) => session.traceRole).sort(), ['main', 'subagent']);

    const { segments } = ccTracesToResultEntries(sessionDir);
    const child = segments.find((segment) => segment.skillName === 'child-skill');
    assert.ok(child);
    assert.equal(child.sessionId, 'sessionA');
    assert.equal(child.traceSessionId, 'child-1');
    assert.equal(child.traceRole, 'subagent');
    assert.ok(child.sourceTrace?.endsWith('subagents/x1.jsonl'));
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
    assert.equal(sessions[0].sessionId, 'oc-1');
    assert.equal(sessions[0].cwd, '/tmp/agent');
    const segs = segmentBySkill(sessions[0]);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'design-coding-create-template');
    assert.equal(segs[0].attribution?.source, 'command-name');
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
    assert.equal(sessions[0].sessionId, 'oc-1');
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
    assert.equal(skill.toolCalls[0].tool, 'Read');
    assert.equal((skill.toolCalls[0].input as { file_path?: string }).file_path, '/tmp/example/.openclaw/workspace/skills/prd-create/SKILL.md');
    assert.equal(skill.toolCalls[0].success, true);
    assert.equal(skill.metrics.inputTokens, 10);
    assert.equal(skill.metrics.cacheReadTokens, 3);
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
    assert.equal(session.sessionId, 'codex-child');
    assert.equal(session.sessionGroupId, 'codex-parent');
    assert.equal(session.traceRole, 'subagent');
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
    assert.equal(audit.metrics.inputTokens, 120);
    assert.equal(audit.metrics.outputTokens, 15);
    assert.equal(audit.metrics.cacheReadTokens, 40);
    assert.equal(audit.metrics.cacheCreationTokens, 2);
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
          input: 'const result = await tools.exec_command({cmd: "sed -n \'1,200p\' .agents/skills/alpha/SKILL.md"});',
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
          input: 'const result = await tools.exec_command({cmd: "cat .agents/skills/beta/SKILL.md"});',
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
    ]));

    const [session] = loadCcSessions(path);
    assert.equal(session.sourceMetadata?.model, 'gpt-5.5, gpt-5.6-sol');

    const segments = segmentBySkill(session);
    const alpha = segments.find((segment) => segment.skillName === 'alpha');
    const beta = segments.find((segment) => segment.skillName === 'beta');
    assert.ok(alpha);
    assert.ok(beta);
    assert.equal(alpha.attribution?.source, 'read-skill-md');
    assert.equal(alpha.toolCalls[0].tool, 'exec');
    assert.equal(alpha.metrics.inputTokens, 100);
    assert.equal(alpha.metrics.outputTokens, 10);
    assert.equal(alpha.sourceMetadata?.model, 'gpt-5.5');
    assert.equal(beta.metrics.inputTokens, 80);
    assert.equal(beta.metrics.outputTokens, 8);
    assert.equal(beta.sourceMetadata?.model, 'gpt-5.6-sol');

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

  it('groups Codex main and child rollouts into one logical session', () => {
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

    const sessions = loadCcSessions(tmpDir).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map((session) => session.traceRole), ['subagent', 'main']);
    assert.deepEqual(new Set(sessions.map((session) => session.sessionGroupId)), new Set(['codex-parent']));
    assert.deepEqual(new Set(sessions.map((session) => session.sessionGroupPath)), new Set(['codex:codex-parent']));
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
**会话 ID**: s-a
**请求 ID**: r-a

### 用户输入
请优先调用 audit skill 处理。

### AI 回复
审计完成。
---
## [2026/04/09 16:25:55] 对话记录 (SDK)
**工作目录**: /repo-b
**会话 ID**: s-b
**请求 ID**: r-b

### 用户输入
请优先调用 polish skill 处理。

### AI 回复
润色完成。
`);
    const sessions = loadCcSessions(path).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].sessionId, 's-a');
    assert.equal(sessions[0].cwd, '/repo-a');
    assert.equal(sessions[1].sessionId, 's-b');
    assert.equal(sessions[1].cwd, '/repo-b');

    const segs = sessions.flatMap(segmentBySkill).sort((a, b) => a.skillName.localeCompare(b.skillName));
    assert.deepEqual(segs.map((seg) => [seg.skillName, seg.sessionId, seg.cwd]), [
      ['audit', 's-a', '/repo-a'],
      ['polish', 's-b', '/repo-b'],
    ]);
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

  it('orphan tool_use (no matching result) → stays success=true, does not crash', () => {
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [{ type: 'tool_use', id: 'tu-orphan', name: 'Read', input: {} }]),
      ],
    };
    const segs = segmentBySkill(s);
    assert.equal(segs[0].toolCalls[0].success, true);
    assert.equal(segs[0].metrics.numToolFailures, 0);
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
    const s = {
      sessionId: 's1',
      sourcePath: '/t',
      records: [
        asstRec('a1', [{ type: 'text', text: 'a' }]),
        asstRec('a2', [{ type: 'text', text: 'b' }]),
      ],
    };
    const segs = segmentBySkill(s);
    // 每条 asstRec 默认 input=10 output=20 → 累加 2 次
    assert.equal(segs[0].metrics.inputTokens, 20);
    assert.equal(segs[0].metrics.outputTokens, 40);
  });
});

// ---------- Segments → ResultEntries ----------

describe('segmentsToResultEntries', () => {
  it('each segment → one ResultEntry with skill as variant key', () => {
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
    const entries = segmentsToResultEntries(segs);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sample_id, 's1:0');
    assert.ok('audit' in entries[0].variants);
    assert.equal(entries[0].variants.audit.toolCalls?.length, 1);
    assert.equal(entries[0].variants.audit.numToolCalls, 1);
  });
});

describe('ccTracesToResultEntries (end-to-end)', () => {
  it('loads dir, segments, converts to entries', () => {
    writeSession(tmpDir, 'x.jsonl', [
      { type: 'permission-mode', sessionId: 'sx' },
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }], { sessionId: 'sx' }),
      userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }], { sessionId: 'sx' }),
    ]);
    const { entries, sessions, segments } = ccTracesToResultEntries(tmpDir);
    assert.equal(sessions.length, 1);
    assert.equal(segments.length, 1);
    assert.equal(entries.length, 1);
    assert.equal(segments[0].skillName, 'general');
  });
});
