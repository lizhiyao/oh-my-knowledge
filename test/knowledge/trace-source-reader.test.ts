import { createHash } from 'node:crypto';
import { appendFileSync, fstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTraceSource, TRACE_SOURCE_MAX_READ_BYTES, TraceSourceReadError,
  type TraceSourceReadContext } from '../../src/knowledge/adapters/trace-source-reader.js';
import type { SourceSelection } from '../../src/knowledge/sources.js';

const readFault = vi.hoisted(() => ({ afterRead: undefined as ((fd: number) => void) | undefined }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null) {
    const count = fs.readSync(fd, buffer, offset, length, position), hook = readFault.afterRead;
    readFault.afterRead = undefined; hook?.(fd); return count;
  } };
});
const roots: string[] = [];
afterEach(() => { readFault.afterRead = undefined; vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function temp() { const root = mkdtempSync(join(tmpdir(), 'omk-trace-reader-')); roots.push(root); return root; }
function put(bytes: string | Uint8Array) { const path = join(temp(), 'source.unrecognized-extension'); writeFileSync(path, bytes); return path; }
type TraceSelection = Extract<SourceSelection, { sourceKind: 'agent_trace' }>;
const selection = (recordRanges = [{ startRecord: 0, endRecord: 0 }], traceKind = 'codex'): TraceSelection => ({
  sourceKind: 'agent_trace', sourceId: 'thread:authored', traceKind, recordRanges,
});
const origin = { threadId: 'original-thread', turnId: 'original-turn', title: '原始对话标题', cwd: '/private/local/project' };
const fileContext = (approvedPath: string): TraceSourceReadContext => ({ sourceId: 'thread:authored', traceKind: 'codex',
  source: { sourceType: 'file', approvedPath }, origin });
const codex = (text: string, role = 'user', timestamp = '2026-10-29T12:34:56.000Z') => JSON.stringify({
  type: 'response_item', timestamp, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});
function recordsContext(records: { recordIndex: number; raw: string }[], traceKind = 'codex'): TraceSourceReadContext {
  return { sourceId: 'thread:authored', traceKind, source: { sourceType: 'records', records }, origin };
}

describe('exact host-bound trace source reading', () => {
  it('retains BOM, CRLF, astral text, original nonempty record indexes and host byte ranges across disjoint selection', () => {
    const first = `\uFEFF  ${codex('甲😀\r\n原文')}  \r\n`, middle = `${codex('omitted')}\r\n`, last = ` ${codex('最后', 'assistant')}`;
    const bytes = Buffer.from(`${first}\r\n${middle}${last}`), path = put(bytes);
    const result = readTraceSource(selection([{ startRecord: 2, endRecord: 2 }, { startRecord: 0, endRecord: 0 }, { startRecord: 0, endRecord: 0 }]), fileContext(path));
    expect(result.resolvedSelection.recordRanges).toEqual([{ startRecord: 0, endRecord: 0 }, { startRecord: 2, endRecord: 2 }]);
    expect(result.projection.rawUnits.map(unit => ({ text: unit.text, digest: unit.rawByteDigest, bytes: unit.rawByteLength, coordinate: unit.coordinate }))).toEqual([
      { text: first, digest: sha(first), bytes: Buffer.byteLength(first), coordinate: { coordinateKind: 'trace_record', recordIndex: 0 } },
      { text: last, digest: sha(last), bytes: Buffer.byteLength(last), coordinate: { coordinateKind: 'trace_record', recordIndex: 2 } },
    ]);
    expect(result.readManifest).toEqual({ contentBytes: bytes.length, metadataBytes: 0, totalBytes: bytes.length,
      selectedTextBytes: Buffer.byteLength(first + last), selectedRawRanges: [
        { recordIndex: 0, startByte: 0, endByte: Buffer.byteLength(first) },
        { recordIndex: 2, startByte: Buffer.byteLength(first + '\r\n' + middle), endByte: bytes.length },
      ] });
    expect(result.projection.excerpts.map(excerpt => ({ text: excerpt.text, coordinate: excerpt.coordinate }))).toEqual([
      { text: '甲😀\r\n原文', coordinate: { coordinateKind: 'trace_event', recordIndex: 0, eventOrdinal: 0, eventKind: 'message', role: 'user', timestamp: '2026-10-29T12:34:56.000Z' } },
      { text: '最后', coordinate: { coordinateKind: 'trace_event', recordIndex: 2, eventOrdinal: 0, eventKind: 'message', role: 'assistant', timestamp: '2026-10-29T12:34:56.000Z' } },
    ]);
    expect(result.projection.provenance.times).toEqual([{ timeKind: 'message', at: '2026-10-29T12:34:56.000Z', basis: 'source_declared' }]);
    expect(result.projection.origin).toEqual({ threadId: origin.threadId, turnId: origin.turnId, title: origin.title });
    expect(JSON.stringify(result.projection)).not.toContain(path);
    expect(JSON.stringify(result.projection)).not.toContain(origin.cwd);
    expect(readFileSync(path)).toEqual(bytes); expect(readdirSync(join(path, '..'))).toEqual(['source.unrecognized-extension']);
  });

  it('keeps versions stable across absolute paths/cwd and ignores unselected trailing records, while binding exact selected bytes and origin', () => {
    const raw = `${codex('same')}\n`, one = put(raw), two = put(`${raw}${codex('unselected')}\n`);
    const baseline = readTraceSource(selection(), fileContext(one));
    const copy = readTraceSource(selection(), { ...fileContext(two), origin: { ...origin, cwd: '/elsewhere' } });
    expect(copy.projection).toEqual(baseline.projection); expect(copy.sourceVersion).toBe(baseline.sourceVersion);
    expect(readTraceSource(selection(), { ...fileContext(one), origin: { ...origin, title: 'updated' } }).sourceVersion).not.toBe(baseline.sourceVersion);
    expect(readTraceSource(selection(), { ...fileContext(one), origin: { ...origin, turnId: 'other' } }).sourceVersion).not.toBe(baseline.sourceVersion);
    writeFileSync(two, raw.replace('\n', '\r\n'));
    const changed = readTraceSource(selection(), fileContext(two));
    expect(changed.projection.excerpts).toEqual(baseline.projection.excerpts); expect(changed.sourceVersion).not.toBe(baseline.sourceVersion);
  });

  it('retains supplied original sparse indexes without inventing terminators, gaps or raw file offsets', () => {
    const records = [{ recordIndex: 17, raw: codex('first') }, { recordIndex: 23, raw: `${codex('second')}\r\n` }];
    const result = readTraceSource(selection([{ startRecord: 23, endRecord: 23 }, { startRecord: 17, endRecord: 17 }]), recordsContext(records));
    expect(result.projection.rawUnits.map(unit => unit.text)).toEqual(records.map(record => record.raw));
    expect(result.projection.excerpts.map(excerpt => excerpt.coordinate.coordinateKind === 'trace_event' ? excerpt.coordinate.recordIndex : undefined)).toEqual([17, 23]);
    expect(result.readManifest.selectedRawRanges).toBeNull();
    expect(result.readManifest.totalBytes).toBe(Buffer.byteLength(records.map(record => record.raw).join('')));
    expect(result.projection.limitations.some(text => text.includes('missing line terminators'))).toBe(true);
    expect(() => readTraceSource(selection([{ startRecord: 17, endRecord: 23 }]), recordsContext(records))).toThrow('unavailable original records');
  });

  it.each(['claude', 'qoder'] as const)('uses the shared %s format parser and preserves source-declared message roles', traceKind => {
    const raw = JSON.stringify({ type: 'user', uuid: 'source-id', sessionId: 'session-id', timestamp: '2026-10-29T12:34:56.000Z',
      message: { role: 'user', content: 'source words' }, ...(traceKind === 'qoder' ? { origin: { kind: 'human' }, isSidechain: false,
        userType: 'external', entrypoint: 'cli', version: '1.1.47', requestSetId: 'qoder-request' } : {}) });
    const result = readTraceSource(selection(undefined, traceKind), recordsContext([{ recordIndex: 0, raw }], traceKind));
    expect(result.projection.identity.traceKind).toBe(traceKind);
    expect(result.projection.excerpts).toEqual([expect.objectContaining({ text: 'source words', coordinate: expect.objectContaining({ role: 'user' }) })]);
    expect(result.projection.provenance.attributions).toEqual([{ role: 'producer', name: traceKind, basis: 'host_observed' }]);
  });

  it('retains malformed records and compaction raw bytes without using summaries as replacement source', () => {
    const records = [{ recordIndex: 0, raw: codex('real source') }, { recordIndex: 1, raw: ' {malformed\r\n' },
      { recordIndex: 2, raw: JSON.stringify({ type: 'compacted', payload: { message: 'must not become recovered source', summary: 'summary only' } }) }];
    const result = readTraceSource(selection([{ startRecord: 0, endRecord: 2 }]), recordsContext(records));
    expect(result.projection.rawUnits.map(unit => unit.text)).toEqual(records.map(record => record.raw));
    expect(result.projection.excerpts.map(excerpt => excerpt.text)).toEqual(['real source']);
    expect(result.projection.limitations.some(text => text.includes('malformed'))).toBe(true);
    expect(result.projection.limitations.some(text => text.includes('compaction'))).toBe(true);
  });

  it('preserves non-object JSON before and between healthy Claude records without feeding it to the object parser', () => {
    const message = (text: string) => JSON.stringify({ type: 'user', sessionId: 'claude', message: { role: 'user', content: text } });
    const records = ['42', message('first'), 'null', 'true', '"plain text"', '[]', message('last')]
      .map((raw, recordIndex) => ({ raw, recordIndex }));
    const result = readTraceSource(selection([{ startRecord: 0, endRecord: records.length - 1 }], 'claude'), recordsContext(records, 'claude'));
    expect(result.projection.rawUnits.map(unit => unit.text)).toEqual(records.map(record => record.raw));
    expect(result.projection.excerpts.map(excerpt => ({ text: excerpt.text, recordIndex: excerpt.coordinate.coordinateKind === 'trace_event' ? excerpt.coordinate.recordIndex : undefined })))
      .toEqual([{ text: 'first', recordIndex: 1 }, { text: 'last', recordIndex: 6 }]);
    expect(result.projection.limitations).toContain('5 non-object JSON original records are retained as raw evidence without invented events.');
  });

  it('distinguishes discussion, invocation and source-reported result without claiming tests executed', () => {
    const records = [codex('test code says success'), JSON.stringify({ type: 'response_item', timestamp: '2026-10-29T12:35:56.000Z',
      payload: { type: 'function_call', call_id: 'call1', name: 'exec_command', arguments: '{"cmd":"test"}' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-10-29T12:36:56.000Z', payload: { type: 'function_call_output', call_id: 'call1', output: 'reported exit 0' } })]
      .map((raw, recordIndex) => ({ raw, recordIndex }));
    const result = readTraceSource(selection([{ startRecord: 0, endRecord: 2 }]), recordsContext(records));
    expect(result.projection.material.materialType).toBe('unknown');
    expect(result.projection.excerpts.map(excerpt => excerpt.material.materialType)).toEqual(['discussion', 'unknown', 'execution_record']);
    expect(result.projection.provenance.times).toContainEqual({ timeKind: 'source_declared', at: '2026-10-29T12:36:56.000Z', basis: 'source_declared' });
    const declared = readTraceSource(selection([{ startRecord: 0, endRecord: 2 }]), { ...recordsContext(records),
      material: { materialType: 'test_expectation', attributionBasis: 'host_declared', reason: 'Host selected a discussion of test expectations, not an execution verification.' } });
    expect(declared.sourceVersion).not.toBe(result.sourceVersion);
  });

  it('rejects missing ranges, unknown/ambiguous formats, binding mismatch and invalid supplied raw text', () => {
    const path = put(codex('original')), context = fileContext(path);
    for (const ranges of [[], [{ startRecord: 1, endRecord: 1 }], [{ startRecord: 1, endRecord: 0 }], [{ startRecord: -1, endRecord: 0 }]]) {
      expect(() => readTraceSource(selection(ranges), context)).toThrow(TraceSourceReadError);
    }
    expect(() => readTraceSource({ ...selection(), sourceId: 'other' }, context)).toThrow('trusted host');
    expect(() => readTraceSource(selection(undefined, 'claude'), { ...context, traceKind: 'claude' })).toThrow('declared supported');
    expect(() => readTraceSource(selection(), recordsContext([{ recordIndex: 0, raw: '{"unknown":true}' }]))).toThrow('declared supported');
    const mixed = [{ recordIndex: 0, raw: codex('codex') }, { recordIndex: 1, raw: JSON.stringify({ type: 'user', sessionId: 'claude', message: { content: 'ambiguous' } }) }];
    expect(() => readTraceSource(selection([{ startRecord: 0, endRecord: 1 }]), recordsContext(mixed))).toThrow('uniquely');
    for (const records of [[{ recordIndex: 0, raw: '\ud800' }], [{ recordIndex: 0, raw: ' ' }],
      [{ recordIndex: 0, raw: codex('one') }, { recordIndex: 0, raw: codex('duplicate') }]]) {
      expect(() => readTraceSource(selection(), recordsContext(records))).toThrow(TraceSourceReadError);
    }
    expect(() => readTraceSource({ ...selection(), path } as TraceSelection, context)).toThrow(TraceSourceReadError);
  });

  it('bounds actual scanning at 16 MiB while supporting a selected prefix of a larger regular trace file', () => {
    const path = put(`${codex('prefix')}\n`); truncateSync(path, TRACE_SOURCE_MAX_READ_BYTES + 1);
    const prefix = readTraceSource(selection(), fileContext(path));
    expect(prefix.projection.excerpts[0].text).toBe('prefix'); expect(prefix.readManifest.contentBytes).toBe(64 * 1024);
    expect(prefix.readManifest.selectedTextBytes).toBe(Buffer.byteLength(`${codex('prefix')}\n`));
    expect(() => readTraceSource(selection([{ startRecord: 1, endRecord: 1 }]), fileContext(path))).toThrow('16 MiB actual-read');
    expect(() => readTraceSource(selection(), recordsContext([{ recordIndex: 0, raw: codex('x'.repeat(TRACE_SOURCE_MAX_READ_BYTES)) }]))).toThrow('16 MiB');
  });

  it('rejects links, nonregular/missing sources and invalid UTF-8 without filename-based format fallback', () => {
    const directory = temp(), target = put(codex('not followed')), link = join(directory, 'link'); symlinkSync(target, link);
    for (const path of [directory, link]) expect(() => readTraceSource(selection(), fileContext(path))).toThrow(TraceSourceReadError);
    expect(() => readTraceSource(selection(), fileContext(join(directory, 'missing')))).toThrow(expect.objectContaining({ reason: 'missing' }));
    const invalid = put(Buffer.from([0xff, 10])); expect(() => readTraceSource(selection(), fileContext(invalid))).toThrow('valid UTF-8');
    const unknown = put('{"text":"not a supported trace"}\n'); expect(() => readTraceSource(selection(), fileContext(unknown))).toThrow('declared supported');
    expect(() => readTraceSource(selection(), fileContext('relative'))).toThrow('absolute trace file');
  });

  it.each(['change', 'abort'] as const)('closes the descriptor after %s during reading and leaves the original source available', failure => {
    const raw = `${codex('source')}\n`, path = put(raw), cancellation = new AbortController(); let descriptor: number | undefined;
    readFault.afterRead = fd => { descriptor = fd;
      if (failure === 'change') appendFileSync(path, codex('later')); else cancellation.abort(new Error('authored cancellation'));
    };
    expect(() => readTraceSource(selection(), { ...fileContext(path), signal: cancellation.signal })).toThrow(failure === 'change'
      ? expect.objectContaining({ reason: 'version_mismatch' }) : 'authored cancellation');
    expect(descriptor).toBeTypeOf('number'); expect(() => fstatSync(descriptor!)).toThrow(expect.objectContaining({ code: 'EBADF' }));
    expect(readTraceSource(selection(), fileContext(path)).projection.excerpts[0].text).toBe('source');
    expect(readdirSync(join(path, '..'))).toEqual(['source.unrecognized-extension']);
  });

  it('retains all original event times when the portable provenance index reaches its bounded capacity', () => {
    const records = Array.from({ length: 257 }, (_, recordIndex) => ({ recordIndex,
      raw: codex(`message${recordIndex}`, 'user', new Date(Date.UTC(2026, 9, 29, 0, 0, recordIndex)).toISOString()) }));
    const result = readTraceSource(selection([{ startRecord: 0, endRecord: 256 }]), recordsContext(records));
    expect(result.projection.provenance.times).toHaveLength(256); expect(result.projection.excerpts).toHaveLength(257);
    expect(result.projection.excerpts[256].coordinate).toMatchObject({ timestamp: '2026-10-29T00:04:16.000Z' });
    expect(result.projection.limitations.some(text => text.includes('bounded to 256'))).toBe(true);
  });
});
