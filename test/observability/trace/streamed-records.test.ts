import { describe, it, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTraceCorpus } from '../../../src/observability/trace/index.js';
import { parseCodexSessionFile } from '../../../src/observability/trace/adapters/codex/trace.js';
import { openStreamedJsonlRecords } from '../../../src/observability/trace/streamed-records.js';

/**
 * 惰性视图与整档解析产出逐字相同，因此「路由有没有被走到」无法用行为断言抓到——把阈值写错
 * （例如误改成 >2 GiB）会让内存悄悄退回 2.7 倍而全部用例照绿。这里透传真实实现，只留一个调用
 * 计数用于断言阈值确实生效。
 */
vi.mock('../../../src/observability/trace/streamed-records.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/observability/trace/streamed-records.js')>();
  return { ...actual, openStreamedJsonlRecords: vi.fn(actual.openStreamedJsonlRecords) };
});

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

  it('惰性视图里畸形与非对象记录只是空洞，计数与整档解析同一口径', () => {
    const dir = tempDir('omk-streamed-stats-');
    const path = join(dir, 'rollout-cx-stats.jsonl');
    writeFileSync(path, codexLog([
      ...transcriptLines(),
      { raw: '{"type":"response_item","payload":{' },
      { raw: '[1,2,3]' },
      { raw: '   ' },
      // VT／FF 独占整行：整档路径按 `String.prototype.trim` 判空跳过，惰性路径也必须跳过。
      // 少认一种空白，这一行就会被索引并计入畸形记录，两条路的三档计数就此分叉。
      { raw: '\x0b' },
      { raw: '\x0c' },
    ]));
    assert.ok(readFileSync(path).length > 16 * 1024 * 1024, '用例前提：必须真的走惰性视图');

    // 谓词与适配器都可能拿到带空洞的记录数组：整档路径把畸形行挡在数组外，惰性路径留空洞。
    // 少一处判空就会让一整份大会话日志变成解析失败，所以这里既比会话内容，也比三档计数。
    const streamed = loadTraceCorpus(path);
    // 整档路径交给适配器的是与源行号对齐、含空洞的数组，这里逐字复刻同一份输入。
    const eager = parseCodexSessionFile(path, eagerRecords(path));
    assert.equal(streamed.sessions.length, 1);
    assert.deepEqual(streamed.sessions[0], eager);
    const stats = streamed.ingestion;
    // session_meta 1 条 ＋ transcriptLines() 的 964 条正文／调用／结果／推理 ＋ 1 条畸形 ＋ 1 条非对象；纯空白行不计数。
    assert.equal(stats.sourceRecordCount, 967);
    assert.equal(stats.malformedRecordCount, 1);
    assert.equal(stats.ignoredValueCount, 1);
    assert.equal(stats.parsedRecordCount, 965);
  });

  it('达到索引阈值的文件才交给惰性视图，阈值写错会被这条抓住', () => {
    const dir = tempDir('omk-streamed-threshold-');
    const opened = vi.mocked(openStreamedJsonlRecords);

    const big = join(dir, 'rollout-cx-big.jsonl');
    writeFileSync(big, codexLog(transcriptLines()));
    assert.ok(readFileSync(big).length > 16 * 1024 * 1024, '用例前提：必须达到启用阈值');
    opened.mockClear();
    loadTraceCorpus(big);
    assert.ok(opened.mock.calls.length >= 1, '超过阈值的会话日志必须走惰性视图，否则内存退回整档常驻');

    const small = join(dir, 'rollout-cx-small.jsonl');
    writeFileSync(small, codexLog(transcriptLines().slice(0, 3)));
    assert.ok(readFileSync(small).length < 16 * 1024 * 1024, '用例前提：必须低于启用阈值');
    opened.mockClear();
    const parsed = loadTraceCorpus(small);
    assert.equal(opened.mock.calls.length, 0, '未达阈值不该开惰性视图：小文件没有常驻问题，却要付重解析成本');
    assert.equal(parsed.sessions.length, 1);
  });

  it('格式判定只多走一趟记录，不再为每个格式各自重扫整档', () => {
    const dir = tempDir('omk-streamed-detect-');
    const path = join(dir, 'rollout-cx-detect.jsonl');
    writeFileSync(path, codexLog(transcriptLines()));
    assert.ok(readFileSync(path).length > 16 * 1024 * 1024, '用例前提：必须真的走惰性视图');

    // 惰性视图每次访问都重新解析，所以「判定走了几趟整档」可以直接数 JSON.parse 的次数。
    // 同一份文件的映射开销是固定的：两次计数之差就是格式判定的开销——只判结果相同的那条用例
    // 抓不到「六趟变一趟」，只比 wall 又会被机器负载淹没。
    const mappingOnly = countParses(() => {
      const view = openStreamedJsonlRecords<unknown>(path);
      try {
        parseCodexSessionFile(path, view.values);
      } finally {
        view.close();
      }
    });
    const wholeLoad = countParses(() => loadTraceCorpus(path));
    const view = openStreamedJsonlRecords<unknown>(path);
    let records = 0;
    try {
      records = view.stats().sourceRecordCount;
    } finally {
      view.close();
    }
    const detected = wholeLoad - mappingOnly;
    // 合并后判定实测正好一趟整档记录（把阈值收到 1 趟也过）；留到 2 趟的余量，但远低于把
    // 引擎退回「逐格式各扫一遍」时的 6 趟——那条断言只有成本差，结果与合并后完全相同。
    assert.ok(
      detected > 0 && detected <= records * 2,
      `格式判定额外解析了 ${(detected / records).toFixed(1)} 趟整档记录，阈值 2 趟：`
        + '判定退回逐格式各扫一遍时，大文件档的 wall 会重新被判定主导',
    );
  });

  it('建立索引期间失败时不留下已打开的 fd', () => {
    const dir = tempDir('omk-streamed-fd-');
    // 目录的 fd 能打开，随后按文件读会失败——这正是「open 成功、索引期间抛错」的形状。
    // 一轮采集要开上千家日志，这里漏一个 fd 就会先把进程推到 EMFILE，而不是报清晰的错。
    const before = openFdCount();
    assert.throws(() => openStreamedJsonlRecords(dir));
    assert.equal(openFdCount(), before, '索引期间抛错必须把已经打开的 fd 还掉');
  });
});

/** 当前进程打开着的 fd 数量（macOS 与 Linux 都提供 /dev/fd）。 */
function openFdCount(): number {
  return readdirSync('/dev/fd').filter((name) => /^\d+$/.test(name)).length;
}

/** 在 `run` 期间数 `JSON.parse` 的调用次数；无论成功与否都把全局实现还原。 */
function countParses(run: () => unknown): number {
  const realParse = JSON.parse;
  let count = 0;
  JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    count += 1;
    return realParse(text, reviver);
  }) as typeof JSON.parse;
  try {
    run();
  } finally {
    JSON.parse = realParse;
  }
  return count;
}
