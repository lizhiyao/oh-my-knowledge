import { describe, it, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTraceCorpus } from '../../../src/observability/trace/index.js';
import { parseCodexSessionFile } from '../../../src/observability/trace/adapters/codex/trace.js';
import { CODEX_RECORD_SCHEMA } from '../../../src/observability/trace/codex-record-schema.js';
import { openStreamedJsonlRecords } from '../../../src/observability/trace/streamed-records.js';

/**
 * 装配视图与整档解析产出逐字相同，因此「路由有没有被走到」无法用行为断言抓到——把阈值写错
 * （例如误改成 >2 GiB）会让内存悄悄退回整档常驻而全部用例照绿。这里透传真实实现，只留一个调用
 * 计数用于断言阈值确实生效。
 */
/** 一条记录被「装配」一次＝读层把该行字节解成对象一次。数它就是数整档被走过的趟数。 */
const recordReads = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../../src/observability/trace/jsonl-record-schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/observability/trace/jsonl-record-schema.js')>();
  return {
    ...actual,
    assembleRecord: vi.fn((...args: Parameters<typeof actual.assembleRecord>) => {
      recordReads.count += 1;
      return actual.assembleRecord(...args);
    }),
  };
});

vi.mock('../../../src/observability/trace/streamed-records.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/observability/trace/streamed-records.js')>();
  return {
    ...actual,
    openStreamedJsonlRecords: vi.fn((filePath: string, schema) => {
      const view = actual.openStreamedJsonlRecords(filePath, schema);
      // 建立索引不装配记录；归零之后每次装配都是读取层真的取用了那条记录。
      recordReads.count = 0;
      return view;
    }),
  };
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

    const view = openStreamedJsonlRecords<unknown>(path, CODEX_RECORD_SCHEMA);
    try {
      // 用例前提：这份样本同时走到两条取用路径——装配分支的记录取用即命中投影（同一个对象，
      // 后续整档遍历不再回文件），没进装配分支的记录整条解析、用完即弃（等值但不是同一个对象）。
      const cached = view.values.some((record, index) => record !== undefined && view.values[index] === record);
      const ephemeral = view.values.some((record, index) => record !== undefined && view.values[index] !== record);
      assert.ok(cached, '用例前提：要有按声明装配并留在投影里的记录');
      assert.ok(ephemeral, '用例前提：要有整条解析、用完即弃的记录（否则大记录会被投影常驻拖回 2 倍内存）');
      assert.deepEqual(
        [...view.values].filter(Boolean).map((record) => Object.keys(record).sort()),
        [...view.values].filter(Boolean).map((record) => Object.keys(record).sort()),
        '重复取用必须给出同样的读面，否则多趟遍历的归属会随第几趟而变',
      );
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

  it('装配过的记录不再重读：判定与映射共用同一份投影', () => {
    const dir = tempDir('omk-streamed-detect-');
    const path = join(dir, 'rollout-cx-detect.jsonl');
    writeFileSync(path, codexLog(transcriptLines()));
    assert.ok(readFileSync(path).length > 16 * 1024 * 1024, '用例前提：必须真的走装配视图');

    let records = 0;
    const counting = openStreamedJsonlRecords<unknown>(path, CODEX_RECORD_SCHEMA);
    try {
      records = counting.stats().sourceRecordCount;
    } finally {
      counting.close();
    }
    assert.ok(records > 0, '用例前提：样本要有可装配的记录');
    const wholeLoad = countRecordReads(() => loadTraceCorpus(path));
    // 一趟装配是这条读取层的成本下界：判定先取用的记录留在投影里给映射复用，之后 13 趟整档遍历读的是
    // 内存。退回「每次访问重读重解析」时这个数按整档遍历的趟数翻倍（改前实测约 13 趟），所以这条断言
    // 同时挡住两件事：读取层退回逐次解析，以及判定退回逐格式各扫一遍。
    // 只对装配分支成立——没进分支表的记录（大输出、重复视图那族）故意用完即弃，它们留在投影里
    // 会把峰值顶回文件大小的两倍，实测见 #974 判据②。
    assert.ok(
      wholeLoad <= records * 1.2,
      `一份会话把记录装配了 ${(wholeLoad / records).toFixed(1)} 趟，阈值 1.2 趟：`
        + '记录应当装配一次、由后续遍历共用同一份投影',
    );
    assert.ok(wholeLoad >= records, '用例前提：判定这一趟要看到每条记录，否则三档计数口径会漏');
  });

  it('建立索引期间失败时不留下已打开的 fd', () => {
    const dir = tempDir('omk-streamed-fd-');
    // 目录的 fd 能打开，随后按文件读会失败——这正是「open 成功、索引期间抛错」的形状。
    // 一轮采集要开上千家日志，这里漏一个 fd 就会先把进程推到 EMFILE，而不是报清晰的错。
    const before = openFdCount();
    assert.throws(() => openStreamedJsonlRecords(dir, CODEX_RECORD_SCHEMA));
    assert.equal(openFdCount(), before, '索引期间抛错必须把已经打开的 fd 还掉');
  });
});

/** 当前进程打开着的 fd 数量（macOS 与 Linux 都提供 /dev/fd）。 */
function openFdCount(): number {
  return readdirSync('/dev/fd').filter((name) => /^\d+$/.test(name)).length;
}

/** 在 `run` 期间数「记录被取用」的次数；建索引的块读已在视图打开后归零，故差值就是趟数。 */
function countRecordReads(run: () => unknown): number {
  recordReads.count = 0;
  try {
    run();
    return recordReads.count;
  } finally {
    recordReads.count = 0;
  }
}
