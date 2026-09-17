/**
 * claude-trace builder 的控制组：证明结构推导不是空转。
 * 每条用例钉住一处关键判断，helper 里对应逻辑被改掉时至少一条必须变红：
 * - parentUuid 自动挂链被吞        → 第 1 条红
 * - 显式 parentUuid／null 被忽略   → 第 2 条红
 * - timestamp 递增／覆盖被吞       → 第 3 条红
 * - is_error 映射或回链 id 被吞    → 第 4 条红
 * - event() 透传被骨架覆盖         → 第 5 条红
 * - sessionId 没进每条记录         → 第 6 条红
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { claudeTrace, loadClaudeTraceFixture } from './claude-trace.js';

describe('claudeTrace builder 控制组', () => {
  it('线性链：parentUuid 自动挂上一个事件，uuid 按角色前缀递增', () => {
    const records = claudeTrace('s1')
      .userCommand('audit', 'Find revenue schema')
      .assistantToolUse('t1', 'Grep', { pattern: 'revenue_schema' })
      .userToolResult('t1', 'No matches found')
      .build();
    assert.deepEqual(
      records.map((r) => [r.type, r.uuid, r.parentUuid]),
      [
        ['user', 'u1', null],
        ['assistant', 'a1', 'u1'],
        ['user', 'u2', 'a1'],
      ],
    );
    assert.equal(records[0].message && (records[0].message as { content: string }).content,
      '<command-name>/audit</command-name>\nFind revenue schema');
  });

  it('分叉与孤儿：显式 parentUuid 优先于自动挂链', () => {
    const records = claudeTrace('s1')
      .userText('root')
      .assistantText('branch-a', { parentUuid: 'u1' })
      .assistantText('branch-b', { parentUuid: 'u1' })
      .userText('detached', { parentUuid: null })
      .build();
    assert.deepEqual(records.map((r) => r.parentUuid), [null, 'u1', 'u1', null]);
  });

  it('timestamp 从 startAt 逐秒递增，显式覆盖生效', () => {
    const records = claudeTrace('s1', { startAt: '2026-05-10T00:00:00.000Z' })
      .userText('a')
      .userText('b', { timestamp: '2026-05-10T00:00:10.000Z' })
      .userText('c')
      .build();
    assert.deepEqual(records.map((r) => r.timestamp), [
      '2026-05-10T00:00:00.000Z',
      '2026-05-10T00:00:10.000Z',
      '2026-05-10T00:00:02.000Z',
    ]);
  });

  it('tool_result 映射 is_error 并保留回链 id，多块合并成一条', () => {
    const records = claudeTrace('s1')
      .assistantToolUses([
        { id: 't1', name: 'Grep', input: { pattern: 'a' } },
        { id: 't2', name: 'Read', input: { file_path: '/b' } },
        { id: 't3', name: 'Bash', input: { command: 'ls' } },
      ])
      .userToolResults([
        { toolUseId: 't1', content: 'miss', isError: false },
        { toolUseId: 't2', content: 'boom', isError: true },
        { toolUseId: 't3', content: 'opaque' },
      ])
      .build();
    const toolUse = records[0].message as { content: Array<Record<string, unknown>> };
    assert.deepEqual(toolUse.content.map((b) => [b.type, b.id, b.name]), [
      ['tool_use', 't1', 'Grep'],
      ['tool_use', 't2', 'Read'],
      ['tool_use', 't3', 'Bash'],
    ]);
    const toolResult = records[1].message as { content: Array<Record<string, unknown>> };
    // isError 三态：显式 false／true 写字段；不传则不写（缺省解析是被测变体）。
    assert.deepEqual(toolResult.content.map((b) => [b.tool_use_id, b.is_error]), [
      ['t1', false],
      ['t2', true],
      ['t3', undefined],
    ]);
    assert.equal('is_error' in toolResult.content[2], false);
  });

  it('event() 透传畸形形态（type=user 配 role=assistant），自带字段不被骨架覆盖', () => {
    const records = claudeTrace('s1')
      .userText('before')
      .event({
        type: 'user',
        uuid: 'u4',
        message: { role: 'assistant', content: [{ type: 'text', text: '已发送进展' }] },
        entrypoint: 'cli',
      })
      .assistantText('after')
      .build();
    assert.deepEqual(records[1], {
      type: 'user',
      uuid: 'u4',
      parentUuid: 'u1',
      sessionId: 's1',
      timestamp: '2026-05-01T00:00:01.000Z',
      cwd: '/repo-a',
      entrypoint: 'cli',
      message: { role: 'assistant', content: [{ type: 'text', text: '已发送进展' }] },
    });
    // event() 的自带 uuid 进入链：下一个事件挂到 u4。
    assert.equal(records[2].parentUuid, 'u4');
  });

  it('event() 的链外事件（无 uuid）不补 uuid/cwd，也不打断挂链', () => {
    const records = claudeTrace('s1')
      .userText('before')
      .event({ type: 'system', message: '[assistant turn failed]' })
      .assistantText('after')
      .build();
    assert.deepEqual(records[1], {
      type: 'system',
      message: '[assistant turn failed]',
      sessionId: 's1',
      timestamp: '2026-05-01T00:00:01.000Z',
    });
    assert.equal(records[2].parentUuid, 'u1', '链外事件不更新链尾');
  });

  it('每条记录都带 sessionId，且能被 loadClaudeTraceFixture 装成 TraceSession', () => {
    const records = claudeTrace('s-pairing')
      .userCommand('audit', 'Inspect it.')
      .assistantText('Done.')
      .build();
    assert.ok(records.every((r) => r.sessionId === 's-pairing'));
    const session = loadClaudeTraceFixture(records, 's-pairing');
    assert.equal(session.runId, 's-pairing');
    assert.ok(session.events.length >= 2);
  });
});
