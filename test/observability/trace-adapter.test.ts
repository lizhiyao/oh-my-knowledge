import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

  it('plugin-prefixed skill name is normalized (pbakaus/impeccable:audit → audit)', () => {
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
    // 归一化后两个都是 "audit", 相邻同名不切段 → 1 段
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'audit');
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
