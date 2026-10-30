import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceCaptureService, SOURCE_CAPTURE_MAX_SOURCES, SOURCE_CAPTURE_READ_RESERVATION_BYTES,
  type SourceCapturePorts, type SourceCaptureReading } from '../../src/knowledge/application/source-capture.js';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';
import { readProjectSource, readResolvedProjectSource } from '../../src/knowledge/adapters/project-source-reader.js';
import { readTraceSource, type TraceSourceReadContext } from '../../src/knowledge/adapters/trace-source-reader.js';
import type { SourceSelection } from '../../src/knowledge/sources.js';

const roots: string[] = [];
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const file = (relativePath = 'a.txt'): Extract<SourceSelection, { sourceKind: 'project_file' }> => ({ sourceKind: 'project_file', projectId: 'project', relativePath, lineRanges: null });
const traceSelection: Extract<SourceSelection, { sourceKind: 'agent_trace' }> = { sourceKind: 'agent_trace', sourceId: 'thread:1', traceKind: 'codex', recordRanges: [{ startRecord: 17, endRecord: 17 }] };
function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'omk-source-capture-')); roots.push(workspace);
  const projectRoot = join(workspace, 'project'), sources = join(workspace, 'sources'); mkdirSync(projectRoot);
  mkdirSync(join(workspace, 'empty-hooks')); mkdirSync(join(workspace, 'empty-template'));
  vi.stubEnv('HOME', join(workspace, 'unused-home')); let revision = 'host-scope:1';
  const store = new FileSourceStore(sources, workspace), captureBatch = vi.fn(store.captureBatch.bind(store));
  const project = { projectId: 'project', approvedRoot: projectRoot };
  const raw = `\ufeff ${JSON.stringify({ type: 'response_item', timestamp: '2026-10-29T12:34:56.000Z', privateMetadata: 'RAW_ONLY_SECRET',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '讨论原文😀' }] } })}\r\n`;
  const trace: TraceSourceReadContext = { sourceId: traceSelection.sourceId, traceKind: traceSelection.traceKind,
    source: { sourceType: 'records', records: [{ recordIndex: 17, raw }] }, origin: { threadId: 'thread', turnId: 'turn', title: '原始标题', cwd: '/host/private/root' } };
  const ports: SourceCapturePorts = { currentScopeRevision: () => revision, store: { captureBatch },
    read: vi.fn((selection, signal) => selection.sourceKind === 'agent_trace' ? readTraceSource(selection, { ...trace, signal }) : readProjectSource(selection, { ...project, signal })),
    readResolved: vi.fn((selection, signal) => selection.sourceKind === 'agent_trace' ? readTraceSource(selection, { ...trace, signal }) : readResolvedProjectSource(selection, { ...project, signal })) };
  return { workspace, projectRoot, sources, store, ports, captureBatch, trace, raw,
    setRevision: (value: string) => { revision = value; }, service: new SourceCaptureService(ports),
    put: (path: string, text: string) => { writeFileSync(join(projectRoot, path), text); } };
}
function git(root: string, args: string[], workspace: string) {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Authored Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', `core.hooksPath=${join(workspace, 'empty-hooks')}`, '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8',
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(workspace, 'no-global-config'), GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_DATE: '2026-10-29T12:34:56+08:00', GIT_COMMITTER_DATE: '2026-10-29T12:35:56+08:00' } }).trim();
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('bounded source preview, confirmation and capture', () => {
  it('previews literal retained and model-selected text with separate actual-read, send-draft and zero-write manifests', () => {
    const host = setup(); host.put('a.txt', '\ufeff甲\r\n😀');
    const preview = host.service.preview([file(), traceSelection]);
    expect(existsSync(host.sources)).toBe(false); expect(host.captureBatch).not.toHaveBeenCalled();
    expect(preview.items[0].retainedUnits[0].text).toBe('\ufeff甲\r\n😀');
    expect(preview.items[1].retainedUnits[0].text).toBe(host.raw);
    expect(preview.items[1].excerpts[0]).toMatchObject({ text: '讨论原文😀', material: { materialType: 'discussion', attributionBasis: 'source_structure' } });
    expect(preview.readManifest.items[1].actual.selectedRawRanges).toBeNull();
    expect(preview.readManifest.totalBytes).toBe(Buffer.byteLength('\ufeff甲\r\n😀') + Buffer.byteLength(host.raw));
    expect(preview.savePlan).toMatchObject({ actualSnapshotsWritten: 0, actualWrittenBytes: 0 });
    expect(preview.sendDraft.authorization).toBe('not_granted'); expect(preview.sendDraft.json).not.toContain('RAW_ONLY_SECRET');
    expect(preview.sendDraft.json).not.toContain('/host/private/root'); expect(preview.sendDraft.json).not.toContain('rawUnits');
    expect(preview.sendDraft.json).toContain('讨论原文😀'); expect(preview.sendDraft.materialDigest).toBe(sha(preview.sendDraft.json));
    expect(preview.sendDraft.materialJsonBytes).toBe(Buffer.byteLength(preview.sendDraft.json));
    expect(preview.sendDraft.neutralMetadataJsonBytes + preview.sendDraft.excerpts.reduce((sum, excerpt) => sum + excerpt.textJsonBytes, 0)).toBe(preview.sendDraft.materialJsonBytes);
    expect(Object.isFrozen(preview.items[0].retainedUnits[0])).toBe(true);
    expect(existsSync(join(host.workspace, 'unused-home'))).toBe(false);
  });

  it('revalidates the entire batch before store publication and reports actual store bytes without granting model send', () => {
    const host = setup(); host.put('a.txt', 'first'); host.put('b.txt', 'second');
    const preview = host.service.preview([file(), file('b.txt')]), captured = host.service.capture(preview);
    expect(host.ports.readResolved).toHaveBeenCalledTimes(2); expect(host.captureBatch).toHaveBeenCalledTimes(1);
    expect(captured.sources).toHaveLength(2); expect(captured.sendAuthorization).toBe('not_granted');
    const actualBytes = readdirSync(host.sources).reduce((sum, name) => sum + readFileSync(join(host.sources, name)).length, 0);
    expect(captured.saveManifest.actualWrittenBytes).toBe(actualBytes);
    const retry = host.service.capture(preview);
    expect(retry.sources.map(source => source.snapshot.snapshotId)).toEqual(captured.sources.map(source => source.snapshot.snapshotId));
    expect(retry.sources.every(source => source.reused)).toBe(true); expect(retry.saveManifest.actualWrittenBytes).toBe(0);
  });

  it.each(['changed', 'missing'])('rejects a %s second source before saving any batch prefix', failure => {
    const host = setup(); host.put('a.txt', 'first'); host.put('b.txt', 'second');
    const preview = host.service.preview([file(), file('b.txt')]);
    if (failure === 'changed') host.put('b.txt', 'changed'); else unlinkSync(join(host.projectRoot, 'b.txt'));
    expect(() => host.service.capture(preview)).toThrow(); expect(host.captureBatch).not.toHaveBeenCalled(); expect(existsSync(host.sources)).toBe(false);
  });

  it('rejects mismatched preview references and replaced previews without allowing payloads to grant host bindings', () => {
    const host = setup(); host.put('a.txt', 'content');
    const first = host.service.preview([file()]);
    expect(() => host.service.capture({ ...first, previewDigest: sha('forged') })).toThrow('exact active preview');
    expect(() => host.service.capture({ ...first, previewId: 'other' })).toThrow('exact active preview');
    const second = host.service.preview([file()]); expect(second.previewDigest).toBe(first.previewDigest); expect(second.previewId).not.toBe(first.previewId);
    expect(() => host.service.capture(first)).toThrow('exact active preview');
    expect(() => host.service.preview([{ ...file(), approvedRoot: '/another/root' } as SourceSelection])).toThrow();
    expect(host.captureBatch).not.toHaveBeenCalled();
  });

  it('rejects revoked host scope both after a preview and during a read, before any save', () => {
    const host = setup(); host.put('a.txt', 'content'); const preview = host.service.preview([file()]); host.setRevision('host-scope:revoked');
    expect(() => host.service.capture(preview)).toThrow('scope changed or was revoked');
    const second = setup(); second.put('a.txt', 'content'); const read = second.ports.read;
    second.ports.read = vi.fn((...args: Parameters<SourceCapturePorts['read']>) => { const result = read(...args); second.setRevision('revoked-during-read'); return result; });
    expect(() => second.service.preview([file()])).toThrow('scope changed or was revoked');
    expect(second.captureBatch).not.toHaveBeenCalled(); expect(host.captureBatch).not.toHaveBeenCalled();
    const third = setup(); third.put('a.txt', 'content'); const confirmation = third.service.preview([file()]), reread = third.ports.readResolved;
    third.ports.readResolved = vi.fn((...args: Parameters<SourceCapturePorts['readResolved']>) => { const result = reread(...args); third.setRevision('revoked-during-revalidation'); return result; });
    expect(() => third.service.capture(confirmation)).toThrow('scope changed or was revoked'); expect(third.captureBatch).not.toHaveBeenCalled();
  });

  it('reconstructs the same semantic digest across local IDs and actual read-count differences', () => {
    const host = setup(); host.put('a.txt', 'stable'); const first = host.service.preview([file()]);
    const reread = host.ports.readResolved;
    // Authored port observation: an additional neutral diagnostic read changes actual counters, not selected material.
    host.ports.readResolved = vi.fn((...args: Parameters<SourceCapturePorts['readResolved']>) => { const reading = reread(...args); return { ...reading,
      readManifest: { ...reading.readManifest, metadataBytes: reading.readManifest.metadataBytes + 7, totalBytes: reading.readManifest.totalBytes + 7 } }; });
    const rebuilt = new SourceCaptureService(host.ports), second = rebuilt.previewResolved(first.items.map(item => item.resolvedSelection), { expectedDigest: first.previewDigest });
    expect(second.previewDigest).toBe(first.previewDigest); expect(second.previewId).not.toBe(first.previewId);
    expect(second.readManifest.totalBytes).toBe(first.readManifest.totalBytes + 7);
    const captured = rebuilt.capture(second); expect(captured.readManifest.totalBytes).toBe(first.readManifest.totalBytes + 7);
    expect(() => rebuilt.previewResolved(second.items.map(item => item.resolvedSelection), { expectedDigest: sha('wrong') })).toThrow('differs from the confirmed');
  });

  it('rereads fixed Git objects after a moving branch advances and supports fixed-selection CLI reconstruction', () => {
    const host = setup(); git(host.projectRoot, ['init', '-q', '-b', 'main', `--template=${join(host.workspace, 'empty-template')}`], host.workspace);
    host.put('a.txt', 'old committed source'); git(host.projectRoot, ['add', '--all'], host.workspace); git(host.projectRoot, ['commit', '-qm', 'authored first'], host.workspace);
    const selection: SourceSelection = { sourceKind: 'git_blob', projectId: 'project', relativePath: 'a.txt', revision: 'main', lineRanges: null };
    const preview = host.service.preview([selection]);
    host.put('a.txt', 'new committed source'); git(host.projectRoot, ['add', '--all'], host.workspace); git(host.projectRoot, ['commit', '-qm', 'authored second'], host.workspace);
    const captured = host.service.capture(preview); expect(captured.sources[0].snapshot.rawUnits[0].text).toBe('old committed source');
    const reconstructed = new SourceCaptureService(host.ports).previewResolved(preview.items.map(item => item.resolvedSelection), { expectedDigest: preview.previewDigest });
    expect(reconstructed.previewDigest).toBe(preview.previewDigest);
    expect(host.service.preview([selection]).previewDigest).not.toBe(preview.previewDigest);
  });

  it('binds the explicit after-deletion choice into the preview and leaves the deleted reference unavailable', () => {
    const host = setup(); host.put('a.txt', 'content'); const first = host.service.capture(host.service.preview([file()]));
    const old = first.sources[0].snapshot; host.store.delete(old.snapshotId);
    const rejected = host.service.preview([file()]); expect(() => host.service.capture(rejected)).toThrow('explicit after-deletion');
    const permitted = host.service.preview([file()], { afterDeletion: 'new_snapshot' }); expect(permitted.previewDigest).not.toBe(rejected.previewDigest);
    expect(() => host.service.capture(rejected)).toThrow('exact active preview');
    const next = host.service.capture(permitted); expect(next.sources[0].snapshot.snapshotId).not.toBe(old.snapshotId);
    expect(host.store.read(old.snapshotId)).toMatchObject({ reason: 'deleted' }); expect(next.sendAuthorization).toBe('not_granted');
  });

  it('preflights source counts, serialized selectors, selected bytes and preview expansion without formal writes', () => {
    const host = setup();
    expect(() => host.service.preview(Array.from({ length: SOURCE_CAPTURE_MAX_SOURCES + 1 }, () => file()))).toThrow('capacity');
    expect(() => host.service.preview([{ ...file(), relativePath: 'p'.repeat(3 * 1024 * 1024) }])).toThrow('capacity');
    expect(host.ports.read).not.toHaveBeenCalled();
    host.put('a.txt', 'X'.repeat(5 * 1024 * 1024)); expect(() => host.service.preview([file()])).toThrow('capacity');
    host.put('a.txt', '\\'.repeat(3 * 1024 * 1024)); expect(() => host.service.preview([file()])).toThrow('capacity');
    expect(host.captureBatch).not.toHaveBeenCalled(); expect(existsSync(host.sources)).toBe(false);
  });

  it('reserves the next bounded read before starting it rather than allowing 256 sources to exceed the read budget', () => {
    const host = setup(); for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) host.put(name, 'x');
    const read = host.ports.read; host.ports.read = vi.fn((...args: Parameters<SourceCapturePorts['read']>): SourceCaptureReading => ({ ...read(...args),
      readManifest: { contentBytes: 16 * 1024 * 1024, metadataBytes: 1024 * 1024, totalBytes: SOURCE_CAPTURE_READ_RESERVATION_BYTES, selectedTextBytes: 1 } }));
    expect(() => host.service.preview(['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(file))).toThrow('capacity');
    expect(host.ports.read).toHaveBeenCalledTimes(3); expect(host.captureBatch).not.toHaveBeenCalled();
  });

  it('checks reader identity, actual accounting and exact material hashes before accepting a preview', () => {
    const host = setup(); host.put('a.txt', 'content'); const read = host.ports.read;
    host.ports.read = vi.fn((...args: Parameters<SourceCapturePorts['read']>) => ({ ...read(...args), sourceVersion: sha('forged') }));
    expect(() => host.service.preview([file()])).toThrow('Source version');
    host.ports.read = vi.fn((...args: Parameters<SourceCapturePorts['read']>) => { const reading = read(...args); return { ...reading, readManifest: { ...reading.readManifest, totalBytes: 0 } }; });
    expect(() => host.service.preview([file()])).toThrow('actual-read manifest');
    host.ports.read = vi.fn((...args: Parameters<SourceCapturePorts['read']>) => { const reading = read(...args); return { ...reading, resolvedSelection: { ...reading.resolvedSelection, projectId: 'other' } }; });
    expect(() => host.service.preview([file()])).toThrow('resolved selection'); expect(host.captureBatch).not.toHaveBeenCalled();
  });

  it('aborts before reading or publishing and never converts capture into an execution or model call', () => {
    const host = setup(); host.put('a.txt', 'content'); const aborted = new AbortController(); aborted.abort();
    expect(() => host.service.preview([file()], { signal: aborted.signal })).toThrow(); expect(host.ports.read).not.toHaveBeenCalled();
    const preview = host.service.preview([file()]); expect(() => host.service.capture(preview, { signal: aborted.signal })).toThrow();
    expect(host.captureBatch).not.toHaveBeenCalled(); expect(existsSync(host.sources)).toBe(false);
  });
});
