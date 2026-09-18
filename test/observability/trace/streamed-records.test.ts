import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTraceCorpus } from '../../../src/observability/trace/index.js';
import { parseCodexSessionFile } from '../../../src/observability/trace/adapters/codex/trace.js';
import { openStreamedJsonlRecords } from '../../../src/observability/trace/streamed-records.js';

/**
 * 惰性记录视图必须与整档解析产出同一份结果：这两条用例是「只换记录来源、不换映射语义」的
 * 证明，而不只是跑通流水线。
 */

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface CodexLine {
  payload?: unknown;
  raw?: string;
}

function codexLog(lines: CodexLine[]): string {
  const out: string[] = [
    JSON.stringify({
      timestamp: '2026-07-25T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'cx-stream', session_id: 'cx-stream', cwd: '/repo', model_provider: 'openai' },
    }),
  ];
  let minute = 1;
  for (const line of lines) {
    if (line.raw !== undefined) {
      out.push(line.raw);
      continue;
    }
    out.push(JSON.stringify({
      timestamp: `2026-07-25T00:${String(minute % 60).padStart(2, '0')}:00.000Z`,
      type: 'response_item',
      payload: line.payload,
    }));
    minute += 1;
  }
  return `${out.join('\n')}\n`;
}

function transcriptLines(): CodexLine[] {
  const lines: CodexLine[] = [];
  for (let index = 0; index < 700; index += 1) {
    // 单条正文约 26 KB：整份日志因此越过惰性视图的启用阈值，而记录数仍然很小。
    lines.push({ payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: `进度 ${index} ${'内容'.repeat(4_300)}` }] } });
    if (index % 7 === 0) {
      lines.push({ payload: { type: 'function_call', call_id: `call-${index}`, name: 'shell', arguments: `{"command":"step ${index}"}` } });
      lines.push({ payload: { type: 'function_call_output', call_id: `call-${index}`, output: 'ok' } });
    }
    if (index % 11 === 0) {
      lines.push({ payload: { type: 'reasoning', id: `rs-${index}`, summary: [{ type: 'summary_text', text: '再想一层' }] } });
    }
  }
  return lines;
}

function eagerRecords(filePath: string): unknown[] {
  return readFileSync(filePath, 'utf8').split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    });
}

/** 跨记录归属的样本：视图写在输出之前、一次调用扇出多个子集视图、同组退出码不一致、以及归属不到的一条。 */
function crossPassRecords(): unknown[] {
  const base = 1_700_000_000_000;
  const stamp = (offset: number) => new Date(base + offset).toISOString();
  const call = (callId: string, commands: string[], offset: number) => ({
    timestamp: stamp(offset),
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      call_id: callId,
      id: `ctc-${callId}`,
      name: 'exec',
      input: commands.map((command) => `await tools.exec_command(${JSON.stringify({ cmd: command })});`).join('\n'),
    },
  });
  const output = (callId: string, offset: number) => ({
    timestamp: stamp(offset),
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: callId, output: 'ok' },
  });
  const view = (id: string, commands: string[], offset: number, durationMs: number, exitCode?: number) => ({
    timestamp: stamp(offset + durationMs),
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      started_at_ms: base + offset,
      completed_at_ms: base + offset + durationMs,
      item: {
        type: 'CommandExecution',
        id,
        parsed_cmd: commands.map((command) => ({ type: 'command', cmd: command })),
        ...(exitCode === undefined ? {} : { exit_code: exitCode }),
        status: 'completed',
      },
    },
  });
  return [
    {
      timestamp: stamp(0),
      type: 'session_meta',
      payload: { id: 'cx-passes', session_id: 'cx-passes', cwd: '/repo', model_provider: 'openai' },
    },
    call('call-single', ['pwd'], 1_000),
    view('exec-single', ['pwd'], 2_000, 400, 0),
    output('call-single', 3_000),
    call('call-fanout', ['ls -la', 'git status'], 4_000),
    output('call-fanout', 5_000),
    view('exec-fanout-1', ['ls -la'], 6_000, 300, 0),
    view('exec-fanout-2', ['git status'], 7_000, 200, 2),
    view('exec-stray', ['curl example.invalid'], 8_000, 100, 7),
  ];
}

describe('streamed trace records', () => {
  it('大文件走惰性记录视图时，与整档解析产出完全相同的会话', () => {
    const dir = tempDir('omk-streamed-equiv-');
    const path = join(dir, 'rollout-cx-stream.jsonl');
    writeFileSync(path, codexLog(transcriptLines()));
    assert.ok(readFileSync(path).length > 16 * 1024 * 1024, '用例前提：必须达到惰性视图的启用阈值');

    const streamed = loadTraceCorpus(path);
    const eager = parseCodexSessionFile(path, eagerRecords(path));

    assert.equal(streamed.sessions.length, 1);
    assert.deepEqual(streamed.sessions[0], eager, '记录来源改变不得影响任何事件、身份或归属');
    assert.ok(eager.events.length > 900, `用例前提：会话要有足够事件量（实际 ${eager.events.length}）`);
    assert.equal(streamed.ingestion.sourceRecordCount, eagerRecords(path).length);
    assert.equal(
      streamed.ingestion.unknownEventCount,
      eager.events.filter((event) => event.eventKind === 'unknown').length,
    );
  });

  it('惰性视图每次访问重新解析，跨遍归属仍与整档解析逐事件相同', () => {
    const dir = tempDir('omk-streamed-passes-');
    const path = join(dir, 'rollout-cx-passes.jsonl');
    writeFileSync(path, `${crossPassRecords().map((record) => JSON.stringify(record)).join('\n')}\n`);

    const eager = parseCodexSessionFile(path, eagerRecords(path));
    const attributed = eager.events.filter(
      (event) => event.eventKind === 'tool_result' && event.exitCode !== undefined,
    );
    assert.ok(attributed.length >= 1, '用例前提：样本要真的产生跨记录归属');
    assert.ok(
      eager.events.some((event) => event.eventKind === 'tool_result' && event.exitCode === undefined
        && event.durationMs !== undefined),
      '用例前提：样本要真的有「时长可聚合但退出码不一致」的组',
    );
    assert.ok(
      eager.events.some((event) => event.eventKind === 'unknown'),
      '用例前提：样本要真的留下归属不到的证据',
    );

    const view = openStreamedJsonlRecords<unknown>(path);
    try {
      assert.notEqual(view.values[2], view.values[2], '用例前提：记录对象不常驻，同一序号两次访问不是同一对象');
      assert.deepEqual(parseCodexSessionFile(path, view.values), eager, '记录来源改变不得改变任何归属与执行属性');
    } finally {
      view.close();
    }
  });

  it('惰性视图的解析结果计数不靠整档预解析也保持同一口径', () => {
    const dir = tempDir('omk-streamed-stats-');
    const path = join(dir, 'rollout-cx-stats.jsonl');
    writeFileSync(path, codexLog([
      ...transcriptLines().slice(0, 60),
      { raw: '{"type":"response_item","payload":{' },
      { raw: '[1,2,3]' },
      { raw: '   ' },
    ]));

    const stats = loadTraceCorpus(path).ingestion;
    // 1 条 session_meta ＋ 60 条正文 ＋ 1 条畸形 ＋ 1 条非对象；纯空白行不计数。
    assert.equal(stats.sourceRecordCount, 63);
    assert.equal(stats.malformedRecordCount, 1);
    assert.equal(stats.ignoredValueCount, 1);
    assert.equal(stats.parsedRecordCount, 61);
  });
});
