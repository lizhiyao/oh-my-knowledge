import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { describe, it } from 'vitest';
import {
  detectJsonlTraceSource,
  loadTraceCorpus,
  type CcRecord,
} from '../../../src/observability/trace/source.js';
import { countUnknownEventDispositions } from '../../../src/observability/trace/unknown-disposition.js';
import type { TraceEvent, TraceSession } from '../../../src/observability/trace/trace-ir.js';
import { dshSessionHeaderEvidence } from '../../../src/observability/trace/adapters/dsh/trace.js';

/**
 * 夹具是真机磁盘形状的复刻（字段名与嵌套层一致，内容全是编造的），因此这些断言在 CI 上
 * 也能跑——真机那 10 份会话只能算验收，不能当回归防线。
 */
const RECORDS: Record<string, unknown>[] = [
  { type: 'session', version: 0, id: 'session-abc', createdAt: 1780000000000, cwd: '/repo', delegationDepth: 0, agentPreset: 'standard' },
  { type: 'session/title', seq: 1, time: 1780000001000, data: { title: '修一个采集缺口', source: { kind: 'user' }, messageSeqs: [3] } },
  { type: 'user/message', seq: 2, time: 1780000002000, surfaceOp: 'append', data: { id: 'msg_u1', role: 'user', content: [{ type: 'text', text: '帮我看下这个缺口' }], source: { kind: 'user' } } },
  { type: 'user/message', seq: 3, time: 1780000003000, data: { id: 'msg_u2', role: 'user', content: [{ type: 'text', text: '技能目录快照' }], source: { kind: 'skill-catalog' } } },
  { type: 'user/message', seq: 4, time: 1780000004000, data: { id: 'msg_u3', role: 'user', content: [{ type: 'text', text: '插件注入的上下文' }], source: { kind: 'plugin' } } },
  {
    type: 'assistant/message', seq: 5, time: 1780000005000,
    data: {
      turn: 0, step: 0,
      message: {
        id: 'msg_a1', role: 'assistant',
        source: { kind: 'model', model: 'fixture-model', provider: 'fixture' },
        content: [
          { type: 'reasoning', text: '先定位读取入口' },
          { type: 'text', text: '我来看看采集入口' },
          { type: 'tool-call', id: 'call_1', name: 'read_file', args: '{"path":"a.ts"}' },
        ],
        usage: { inputTokens: 120, outputTokens: 34, cacheReadTokens: 8, reasoningTokens: 5 },
      },
    },
  },
  { type: 'tool/call', seq: 6, time: 1780000006000, data: { turn: 0, step: 0, callId: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' } },
  { type: 'tool/result', seq: 7, time: 1780000007000, data: { turn: 0, step: 0, message: { id: 'msg_r1', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ENOENT: a.ts' }], isError: true }] } } },
  { type: 'tool/call', seq: 8, time: 1780000008000, data: { turn: 0, step: 1, callId: 'call_2', name: 'write_file', arguments: '{"path":"b.ts"}' } },
  { type: 'tool/result', seq: 9, time: 1780000009000, data: { turn: 0, step: 1, message: { id: 'msg_r2', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_2', content: 'written' }] } } },
  { type: 'turn/start', seq: 10, time: 1780000010000, data: { turn: 0 } },
  { type: 'step/end', seq: 11, time: 1780000011000, data: { turn: 0, step: 1 } },
  { type: 'reasoning-chunks', seq0: 12, time0: 1780000012000, data: { turn: 0, step: 0, index: 0, texts: ['先定位读取入口'], dt: [1] } },
  { type: 'assistant/chunk', seq: 13, time: 1780000013000, data: { turn: 0, step: 0, chunk: { type: 'finish', index: 0 } } },
  { type: 'text-chunks', seq0: 14, time0: 1780000014000, data: { turn: 0, step: 0, index: 0, texts: ['我来看看采集入口'], dt: [2] } },
  { type: 'tool-call-chunks', seq0: 15, time0: 1780000015000, data: { turn: 0, step: 0, id: 'call_1', name: 'read_file', args: ['{"path"'], dt: [1] } },
  { type: 'sandbox/mode', seq: 16, time: 1780000016000, data: { mode: 'workspace-write', source: 'user' } },
  { seq: 17, time: 1780000017000, data: { note: '没有 type 字段的记录' } },
];

function parse() {
  const detected = detectJsonlTraceSource('/repo/x/session.jsonl', RECORDS as CcRecord[]);
  assert.ok(detected, 'DSH 记录必须被唯一归因');
  return detected.session;
}

function byKind<K extends TraceEvent['eventKind']>(session: TraceSession, kind: K) {
  return session.events.filter(
    (event): event is Extract<TraceEvent, { eventKind: K }> => event.eventKind === kind,
  );
}

describe('DSH 磁盘会话映射', () => {
  it('归因 dsh，并带上会话身份、cwd 与标题', () => {
    const session = parse();
    assert.equal(session.sourceKind, 'dsh');
    assert.equal(session.runId, 'session-abc');
    assert.equal(session.cwd, '/repo');
    assert.equal(session.label, '修一个采集缺口', '标题优先于文件名');
  });

  it('只有 source.kind=user 的用户消息算真人，其余算注入', () => {
    const messages = byKind(parse(), 'message').filter((event) => event.role === 'user');
    assert.deepEqual(
      messages.map((event) => `${event.origin}:${event.text}`),
      ['human:帮我看下这个缺口', 'skill-context:技能目录快照', 'runtime:插件注入的上下文'],
    );
  });

  it('推理块落成 model_activity，正文只取 text 块；usage 落独立事件', () => {
    const session = parse();
    const assistant = byKind(session, 'message').find((event) => event.role === 'assistant');
    assert.equal(assistant?.text, '我来看看采集入口');
    assert.equal(assistant?.model, 'fixture-model');
    const reasoning = byKind(session, 'model_activity');
    assert.equal(reasoning.length, 1);
    assert.equal(reasoning[0].text, '先定位读取入口');
    const usage = byKind(session, 'usage');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].inputTokens, 120);
    assert.equal(usage[0].reasoningTokens, 5);
  });

  it('工具结果按 toolCallId 归属，状态取宿主自报的 isError', () => {
    const session = parse();
    const results = byKind(session, 'tool_result');
    assert.deepEqual(
      results.map((event) => `${event.callId}:${event.status}:${event.statusSource}`),
      ['call_1:failure:runtime', 'call_2:success:runtime'],
    );
    const calls = byKind(session, 'tool_call');
    assert.deepEqual(calls.map((event) => event.input), [{ path: 'a.ts' }, { path: 'b.ts' }]);
    // 配对成功时两侧共享同一个实例身份；配对失败会退回各自的 eventId，可被报告区分出来。
    assert.equal(
      results.filter((event) => calls.some((call) => call.callInstanceId === event.callInstanceId)).length,
      2,
    );
  });

  it('增量投递族判为重复视图，已识别未定口径的族进待映射，无 type 的记录才算真缺口', () => {
    const session = parse();
    const counts = countUnknownEventDispositions(session);
    assert.equal(counts.duplicateView, 4, '四个增量族各一条');
    assert.equal(counts.unmappedEvidence, 1, 'sandbox/mode 已识别但没口径');
    assert.equal(counts.unsupported, 1, '只有读不出族名的才算缺口');
    assert.equal(
      byKind(session, 'unknown').some((event) => event.recordFamily === 'session'),
      false,
      '会话头已消费成身份，不再计一条待映射',
    );
  });

  it('压缩链路：每帧一条记录的 .zstd 解出来与明文同一场会话', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-dsh-zstd-'));
    try {
      const plain = RECORDS.map((record) => `${JSON.stringify(record)}\n`).join('');
      const frames = Buffer.concat(
        RECORDS.map((record) => zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'))),
      );
      assert.ok(frames.length < Buffer.byteLength(plain), '夹具确实压过');
      const compressedPath = join(dir, 'session.jsonl.zstd');
      writeFileSync(compressedPath, frames);

      const corpus = loadTraceCorpus(compressedPath);
      assert.equal(corpus.sessions.length, 1);
      assert.equal(corpus.sessions[0].sourceKind, 'dsh');
      assert.equal(corpus.sessions[0].runId, 'session-abc');
      assert.equal(corpus.sessions[0].events.length, parse().events.length, '明文与压缩解出同一场会话');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不把别的宿主的 session 头认成 DSH', () => {
    assert.equal(dshSessionHeaderEvidence({ type: 'session', id: 'openclaw-ish' }), false);
    assert.equal(dshSessionHeaderEvidence(RECORDS[0]), true);
  });
});
