import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTraceSessions, loadTraceCorpus, segmentTraceBySkill } from '../../../src/observability/trace/index.js';
import { jsonl, businessActionTag, businessChannel, writeSession, traceFixture } from '../../helpers/trace-fixtures.js';

const fixture = traceFixture();

describe('openclaw trace loading', () => {
  it('does not report OpenClaw model metadata as unknown behavior', () => {
    const path = writeSession(fixture.directory, 'openclaw-metadata.jsonl', [
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

  it('loads OpenClaw JSONL and adapts toolCall/toolResult records', () => {
    const path = join(fixture.directory, 'openclaw.jsonl');
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

    const sessions = loadTraceSessions(path);
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
    const segs = segmentTraceBySkill(sessions[0]);
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

  it('keeps OpenClaw business action labels and splits by SKILL.md reads', () => {
    const path = join(fixture.directory, 'openclaw-multi-action.jsonl');
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

    const [session] = loadTraceSessions(path);
    assert.deepEqual(session.sourceMetadata?.businessActions, ['生成文档', '生成页面']);
    const segs = segmentTraceBySkill(session);
    assert.deepEqual(segs.filter((seg) => seg.skillName !== 'general').map((seg) => seg.skillName), ['prd-create', 'demo-create']);
    assert.equal(segs.some((seg) => seg.skillName === '生成文档' || seg.skillName === '生成页面'), false);
    assert.equal(segs.find((seg) => seg.skillName === 'prd-create')?.attribution?.source, 'read-skill-md');
    assert.equal(segs.find((seg) => seg.skillName === 'demo-create')?.attribution?.source, 'read-skill-md');
  });

  it('attributes OpenClaw cron script executions to the skill directory', () => {
    const path = join(fixture.directory, 'openclaw-cron-script.jsonl');
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

    const [session] = loadTraceSessions(path);
    const segs = segmentTraceBySkill(session);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'task-poller');
    assert.equal(segs[0].attribution?.source, 'skill-script');
    assert.equal(segs[0].toolCalls[0].tool, 'Bash');
    assert.equal((segs[0].toolCalls[0].input as { command?: string }).command?.includes('/skills/task-poller/scripts/run-poller.sh'), true);
  });

  it('attributes OpenClaw script paths after punctuation boundaries', () => {
    const path = join(fixture.directory, 'openclaw-script-punctuation.jsonl');
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

    const [session] = loadTraceSessions(path);
    const segs = segmentTraceBySkill(session);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'task-poller');
    assert.equal(segs[0].attribution?.source, 'skill-script');

    const wrappedPath = join(fixture.directory, 'openclaw-script-wrapped.jsonl');
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

    const [wrappedSession] = loadTraceSessions(wrappedPath);
    const wrappedSegs = segmentTraceBySkill(wrappedSession);
    assert.equal(wrappedSegs.length, 2);
    assert.equal(wrappedSegs[1].skillName, 'task-poller');
    assert.equal(wrappedSegs[1].attribution?.source, 'skill-script');
  });
});
