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

// ---------- Helpers ----------

function jsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
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
