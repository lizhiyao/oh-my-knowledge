import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { FileSourceStore, SOURCE_SNAPSHOT_MAX_BYTES, SOURCE_STORAGE_MAX_BYTES, SOURCE_STORAGE_MAX_FILES,
  SourceStoreError } from '../../src/knowledge/adapters/source-store.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { WORKSPACE_LOCK_FILE } from '../../src/evidence/storage/knowledge-workspace.js';
import type { SourceProjection, SourceSnapshot } from '../../src/knowledge/sources.js';

const fault = vi.hoisted(() => ({ tempWrite: false, tempWriteCountdown: undefined as number | undefined, afterLink: false, denied: false,
  afterPublished: undefined as (() => void) | undefined,
  afterRead: undefined as (() => void) | undefined, descriptors: new Set<number>() }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) {
      if (fault.denied && String(args[0]).endsWith('.json')) throw Object.assign(new Error('authored permission failure'), { code: 'EACCES' });
      const fd = fs.openSync(...args); fault.descriptors.add(fd); return fd;
    },
    closeSync(fd: number) { fault.descriptors.delete(fd); fs.closeSync(fd); },
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null) {
      const count = fs.readSync(fd, buffer, offset, length, position), hook = fault.afterRead; fault.afterRead = undefined; hook?.(); return count;
    },
    writeFileSync(...args: Parameters<typeof fs.writeFileSync>) {
      fs.writeFileSync(...args);
      if (fault.tempWrite && String(args[0]).endsWith('.tmp')) { fault.tempWrite = false; throw new Error('authored write interruption'); }
      if (fault.tempWriteCountdown !== undefined && String(args[0]).endsWith('.tmp') && --fault.tempWriteCountdown === 0) {
        fault.tempWriteCountdown = undefined; throw new Error('authored later batch write interruption');
      }
    },
    linkSync(...args: Parameters<typeof fs.linkSync>) {
      fs.linkSync(...args);
      const afterPublished = fault.afterPublished; fault.afterPublished = undefined; afterPublished?.();
      if (fault.afterLink) { fault.afterLink = false; throw new Error('authored publication acknowledgement interruption'); }
    },
  };
});
const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'omk-source-store-')); roots.push(path); return path; };
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const material = { materialType: 'unknown' as const, attributionBasis: 'unknown' as const, reason: 'Authored storage fixture; no claim of execution.' };
function file(text = '\ufeffA\r\n😀'): Extract<SourceProjection, { sourceKind: 'project_file' }> {
  const lines = text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
  const coordinate = { coordinateKind: 'file_range' as const, relativePath: 'docs/input.txt', startLine: 1, endLine: lines,
    startByte: 0, endByte: Buffer.byteLength(text) };
  return { sourceKind: 'project_file', projectionVersion: 'knowledge-window-v3', identity: { projectId: 'authored-project', relativePath: coordinate.relativePath },
    selection: { lineRanges: lines ? [{ startLine: 1, endLine: lines }] : [] }, contentVersion: sha(text), material,
    provenance: { attributions: [], times: [] }, limitations: [],
    rawUnits: lines ? [{ unitId: 0, coordinate, text, rawByteDigest: sha(text), rawByteLength: Buffer.byteLength(text) }] : [],
    excerpts: lines ? [{ unitId: 0, coordinate, text, material }] : [] };
}
function trace(): Extract<SourceProjection, { sourceKind: 'agent_trace' }> {
  const text = '{"message":"hello"}';
  return { sourceKind: 'agent_trace', projectionVersion: 'knowledge-window-v3', identity: { sourceId: 'codex:authored-thread', traceKind: 'codex' },
    selection: { recordRanges: [{ startRecord: 2, endRecord: 2 }] }, contentVersion: sha(text), material,
    origin: { threadId: 'thread', turnId: 'turn', title: 'Authored original title', cwd: '/first/host' },
    provenance: { attributions: [], times: [] }, limitations: [],
    rawUnits: [{ unitId: 0, text, rawByteLength: Buffer.byteLength(text), rawByteDigest: sha(text), coordinate: { coordinateKind: 'trace_record', recordIndex: 2 } }],
    excerpts: [{ unitId: 0, text: 'hello', material, coordinate: { coordinateKind: 'trace_event', recordIndex: 2, eventOrdinal: 0, eventKind: 'message' } }] };
}
function setup() {
  const workspace = temp(), root = join(workspace, 'sources'); vi.stubEnv('HOME', join(workspace, 'unused-home'));
  return { workspace, root, store: new FileSourceStore(root, workspace) };
}
function rewrite(path: string, change: (value: SourceSnapshot & { storeKind: string; schemaVersion: number; snapshotDigest: string }) => void, rehash = false) {
  const value = JSON.parse(readFileSync(path, 'utf8')); change(value);
  if (rehash) { const snapshot = Object.fromEntries(Object.entries(value).filter(([key]) => !['storeKind', 'schemaVersion', 'snapshotDigest'].includes(key))); value.snapshotDigest = sha(canonicalJson(snapshot)); }
  writeFileSync(path, JSON.stringify(value, null, 2));
}
afterEach(() => {
  fault.tempWrite = false; fault.tempWriteCountdown = undefined; fault.afterLink = false; fault.denied = false; fault.afterRead = undefined; fault.afterPublished = undefined;
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  const descriptors = fault.descriptors.size;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  expect(descriptors).toBe(0);
});

describe('current Source3 file storage', () => {
  it('deduplicates existing and repeated batch versions, reports exact new envelope bytes and preserves immutable capture time', () => {
    const { root, store } = setup(); vi.useFakeTimers(); vi.setSystemTime('2026-10-30T00:00:00Z');
    const first = store.capture(file()), path = join(root, `${first.snapshot.snapshotId}.json`), original = readFileSync(path);
    vi.setSystemTime('2026-11-01T00:00:00Z'); const second = store.capture(file());
    expect(first.reused).toBe(false); expect(second).toEqual({ snapshot: first.snapshot, reused: true });
    expect(readFileSync(path)).toEqual(original); expect(readdirSync(root)).toEqual([`${first.snapshot.snapshotId}.json`]);
    expect(store.read(first.snapshot.snapshotId, first.snapshot.sourceVersion)).toEqual({ status: 'available', snapshot: first.snapshot });
    expect(first.snapshot.rawUnits[0].text).toBe('\ufeffA\r\n😀');
    expect(first.snapshot.excerpts[0].evidenceRef).toBe(`${first.snapshot.snapshotId}:0`);
    expect(store.read(first.snapshot.snapshotId, sha('wrong'))).toMatchObject({ status: 'unavailable', reason: 'version_mismatch' });
    const batch = store.captureBatch([file(), file('new source'), file('new source')]);
    expect(batch.sources.map(source => source.reused)).toEqual([true, false, true]);
    expect(batch.sources[0].snapshot).toEqual(first.snapshot);
    expect(batch.sources[1].snapshot).toEqual(batch.sources[2].snapshot);
    const secondPath = join(root, `${batch.sources[1].snapshot.snapshotId}.json`);
    expect(batch.writtenBytes).toBe(readFileSync(secondPath).length);
    expect(store.captureBatch([file(), file('new source')])).toEqual({
      sources: [{ snapshot: first.snapshot, reused: true }, { snapshot: batch.sources[1].snapshot, reused: true }], writtenBytes: 0 });
    expect(readFileSync(path)).toEqual(original); expect(readdirSync(root)).toHaveLength(2);
    expect(existsSync(join(root, '../unused-home'))).toBe(false);
  });

  it('changes version for each portable original trace field while reusing host-only cwd changes', () => {
    const { store } = setup(), original = trace(), first = store.capture(original);
    expect(store.capture({ ...original, origin: { ...original.origin!, cwd: '/second/host' } })).toEqual({ snapshot: first.snapshot, reused: true });
    for (const origin of [{ ...original.origin!, threadId: 'other-thread' }, { ...original.origin!, turnId: 'other-turn' }, { ...original.origin!, title: 'Other original title' }]) {
      const changed = store.capture({ ...original, origin });
      expect(changed.reused).toBe(false); expect(changed.snapshot.sourceVersion).not.toBe(first.snapshot.sourceVersion);
    }
  });

  it('normalizes optional undefined fields to JSON absence and rejects non-JSON data before writing', () => {
    const { root, store } = setup(), projection = trace();
    const first = store.capture({ ...projection, origin: { ...projection.origin!, turnId: undefined, cwd: undefined } });
    expect(first.snapshot).not.toHaveProperty('origin.turnId'); expect(first.snapshot).not.toHaveProperty('origin.cwd');
    const origin = { threadId: projection.origin!.threadId, title: projection.origin!.title };
    expect(store.capture({ ...projection, origin }).snapshot.snapshotId).toBe(first.snapshot.snapshotId);
    const cyclic = { ...file(), extra: {} }; cyclic.extra = cyclic;
    expect(() => store.capture(cyclic)).toThrow(SourceStoreError);
    expect(() => store.capture({ ...file(), limitations: [undefined] } as unknown as SourceProjection)).toThrow(SourceStoreError);
    const accessor = { ...file() }; Object.defineProperty(accessor, 'material', { enumerable: true, get: () => { throw new Error('getter must not run'); } });
    expect(() => store.capture(accessor)).toThrow('accessor'); expect(readdirSync(root)).toHaveLength(1);
    const existing = readdirSync(root), invalid = file('invalid'); invalid.rawUnits[0].rawByteDigest = sha('not its bytes');
    expect(() => store.captureBatch([file('valid earlier item'), invalid])).toThrow('raw-unit digest');
    expect(() => store.captureBatch([file('valid earlier item'), cyclic])).toThrow(SourceStoreError);
    expect(() => store.captureBatch([])).toThrow('one and 256'); expect(readdirSync(root)).toEqual(existing);
  });

  it('detects full snapshot, raw unit and stable source version tampering rather than reusing corrupt entries', () => {
    const { root, store } = setup(), captured = store.capture(file('X')), path = join(root, `${captured.snapshot.snapshotId}.json`), original = readFileSync(path);
    rewrite(path, value => { value.capturedAt = '2026-11-01T00:00:00Z'; });
    expect(store.read(captured.snapshot.snapshotId)).toMatchObject({ reason: 'corrupt' });
    expect(() => store.capture(file('X'))).toThrow(SourceStoreError); writeFileSync(path, original);
    rewrite(path, value => { value.rawUnits[0].text = 'Y'; value.excerpts[0].text = 'Y'; }, true);
    expect(store.read(captured.snapshot.snapshotId)).toMatchObject({ reason: 'corrupt' }); writeFileSync(path, original);
    rewrite(path, value => { value.sourceVersion = sha('wrong preimage'); }, true);
    expect(store.read(captured.snapshot.snapshotId)).toMatchObject({ reason: 'corrupt' }); writeFileSync(path, original);
    const invalid = file('X'); invalid.rawUnits[0].rawByteDigest = sha('wrong raw bytes');
    expect(() => store.capture(invalid)).toThrow('raw-unit digest');
  });

  it('replaces deleted source content with a verified marker and requires explicit new-reference creation', () => {
    const { root, store } = setup(), first = store.capture(file('private source body')), id = first.snapshot.snapshotId, path = join(root, `${id}.json`);
    expect(() => store.delete(id, sha('wrong'))).toThrow('bound source version');
    fault.tempWrite = true; expect(() => store.delete(id)).toThrow(SourceStoreError);
    expect(store.read(id)).toMatchObject({ status: 'available' }); expect(readdirSync(root)).toEqual([`${id}.json`]);
    store.delete(id, first.snapshot.sourceVersion); const marker = readFileSync(path);
    expect(marker.toString()).not.toContain('private source body');
    expect(Object.keys(JSON.parse(marker.toString())).sort()).toEqual(['deleted', 'markerDigest', 'projectionVersion', 'schemaVersion', 'snapshotId', 'sourceVersion', 'storeKind'].sort());
    expect(store.read(id, first.snapshot.sourceVersion)).toMatchObject({ reason: 'deleted' });
    store.delete(id); expect(readFileSync(path)).toEqual(marker);
    expect(() => store.capture(file('private source body'))).toThrow('explicit after-deletion');
    expect(() => store.captureBatch([file('must not publish'), file('private source body')])).toThrow('explicit after-deletion');
    expect(readdirSync(root)).toEqual([`${id}.json`]);
    const afterDeletion = store.captureBatch([file('private source body'), file('private source body')], { afterDeletion: 'new_snapshot' });
    const next = afterDeletion.sources[0];
    expect(afterDeletion.sources.map(source => source.reused)).toEqual([false, true]);
    expect(afterDeletion.writtenBytes).toBe(readFileSync(join(root, `${next.snapshot.snapshotId}.json`)).length);
    expect(next.reused).toBe(false); expect(next.snapshot.snapshotId).not.toBe(id); expect(next.snapshot.sourceVersion).toBe(first.snapshot.sourceVersion);
    expect(store.read(id)).toMatchObject({ reason: 'deleted' }); expect(readFileSync(path)).toEqual(marker);
    expect(store.capture(file('private source body')).snapshot.snapshotId).toBe(next.snapshot.snapshotId);
    rewrite(path, value => { value.sourceVersion = sha('changed marker'); });
    expect(store.read(id)).toMatchObject({ reason: 'corrupt' });
  });

  it('reports legacy schemas as unsupported and never treats them or malformed files as an empty healthy store', () => {
    for (const projectionVersion of ['knowledge-window-v1', 'knowledge-window-v2']) {
      const { root, store } = setup(), id = randomUUID(); mkdirSync(root);
      writeFileSync(join(root, `${id}.json`), JSON.stringify({ snapshotId: id, projectionVersion, records: [] }));
      expect(store.read(id)).toMatchObject({ reason: 'unsupported' }); expect(() => store.capture(file())).toThrow('unsupported');
    }
    const { root, store } = setup(); mkdirSync(root); writeFileSync(join(root, `${randomUUID()}.json`), '{');
    expect(() => store.capture(file())).toThrow(SourceStoreError);
  });

  it('does not create directories when reading missing sources and rejects roots or source links outside the explicit workspace', () => {
    const parent = temp(), workspace = join(parent, 'new-workspace'), root = join(workspace, 'sources'), store = new FileSourceStore(root, workspace);
    expect(store.read(randomUUID())).toMatchObject({ reason: 'missing' }); expect(existsSync(workspace)).toBe(false);
    expect(() => new FileSourceStore('relative', parent)).toThrow('absolute');
    expect(() => new FileSourceStore(temp(), workspace)).toThrow('inside');
    const setupResult = setup(), captured = setupResult.store.capture(file()), path = join(setupResult.root, `${captured.snapshot.snapshotId}.json`);
    const outside = join(parent, 'outside.json'); writeFileSync(outside, readFileSync(path)); rmSync(path); symlinkSync(outside, path);
    expect(setupResult.store.read(captured.snapshot.snapshotId)).toMatchObject({ reason: 'corrupt' });
    expect(() => setupResult.store.capture(file())).toThrow(SourceStoreError);
  });

  it('preflights repeated JSON expansion and all storage limits without allocating an oversized serialized snapshot', () => {
    const { root, store } = setup();
    expect(() => store.capture(file('X'.repeat(9 * 1024 * 1024)))).toThrow('capacity'); expect(existsSync(root)).toBe(false);
    const amplified = file('X'); amplified.excerpts = Array.from({ length: 900 }, () => ({ ...amplified.excerpts[0], material: { ...material, reason: 'R'.repeat(32_768) } }));
    expect(() => store.capture(amplified)).toThrow('capacity'); expect(existsSync(root)).toBe(false);
    mkdirSync(root); const oversized = join(root, `${randomUUID()}.json`); writeFileSync(oversized, ''); truncateSync(oversized, SOURCE_SNAPSHOT_MAX_BYTES + 1);
    expect(store.read(basename(oversized, '.json'))).toMatchObject({ reason: 'corrupt', detail: expect.stringContaining('capacity') });
    expect(() => store.capture(file())).toThrow('capacity'); rmSync(oversized);
    const probe = setup(), sample = probe.store.capture(file('A'));
    const envelopeBytes = readFileSync(join(probe.root, `${sample.snapshot.snapshotId}.json`)).length;
    let remaining = SOURCE_STORAGE_MAX_BYTES - 2 * envelopeBytes + 1; const padding: string[] = [];
    while (remaining) {
      const path = join(root, `${randomUUID()}.json.${process.pid}.${randomUUID()}.tmp`), bytes = Math.min(remaining, SOURCE_SNAPSHOT_MAX_BYTES);
      writeFileSync(path, ''); truncateSync(path, bytes); padding.push(path); remaining -= bytes;
    }
    const before = readdirSync(root).sort();
    expect(() => store.captureBatch([file('A'), file('B')])).toThrow('capacity'); expect(readdirSync(root).sort()).toEqual(before);
    const finalPadding = padding.at(-1)!; truncateSync(finalPadding, readFileSync(finalPadding).length - 1);
    const exactBytes = store.captureBatch([file('A'), file('B'), file('A')]);
    expect(exactBytes.writtenBytes).toBe(2 * envelopeBytes); expect(exactBytes.sources.map(source => source.reused)).toEqual([false, false, true]);
    expect(store.captureBatch([file('B'), file('A')]).writtenBytes).toBe(0);
    rmSync(root, { recursive: true }); mkdirSync(root);
    for (let index = 0; index < SOURCE_STORAGE_MAX_FILES - 1; index++) writeFileSync(join(root, `${randomUUID()}.json.${process.pid}.${randomUUID()}.tmp`), '{}');
    expect(() => store.captureBatch([file('A'), file('B')])).toThrow('capacity'); expect(readdirSync(root)).toHaveLength(SOURCE_STORAGE_MAX_FILES - 1);
    const exactFiles = store.captureBatch([file('A'), file('A')]);
    expect(exactFiles.sources.map(source => source.reused)).toEqual([false, true]); expect(readdirSync(root)).toHaveLength(SOURCE_STORAGE_MAX_FILES);
    expect(store.captureBatch([file('A')]).writtenBytes).toBe(0);
    writeFileSync(join(root, `${randomUUID()}.json.${process.pid}.${randomUUID()}.tmp`), '{}');
    expect(() => store.capture(file())).toThrow('capacity');
  });

  it.each(['exit-after-publication', 'kill-before-publication'])('reuses a healthy snapshot while retaining real-process atomic orphans after %s', mode => {
    const { workspace, root, store } = setup(), first = store.capture(file()), path = join(root, `${first.snapshot.snapshotId}.json`), original = readFileSync(path);
    const source = readFileSync(new URL('../../src/shared/atomic-json.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
    if (mode === 'exit-after-publication') rmSync(path);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [path, mode, moduleUrl, payload] = process.argv.slice(1), originalLink = fs.linkSync;
      fs.linkSync = (source, target) => {
        if (mode === 'kill-before-publication') process.kill(process.pid, 'SIGKILL');
        originalLink(source, target);
        process.exit(74);
      };
      syncBuiltinESMExports();
      const { createJsonFileAtomic } = await import(moduleUrl);
      createJsonFileAtomic(path, JSON.parse(payload));
    `, path, mode, moduleUrl, original.toString()], { cwd: workspace, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 5000 });
    expect(result.error).toBeUndefined();
    if (mode === 'exit-after-publication') expect(result.status).toBe(74);
    else expect(result.signal).toBe('SIGKILL');
    const names = readdirSync(root), orphan = names.find(name => name.endsWith('.tmp'));
    expect(names).toHaveLength(2); expect(orphan).toMatch(new RegExp(`^${first.snapshot.snapshotId}\\.json\\.${result.pid}\\.`));
    const orphanPath = join(root, orphan!), retained = readFileSync(orphanPath);
    expect(store.capture(file())).toEqual({ snapshot: first.snapshot, reused: true });
    expect(readFileSync(path)).toEqual(original); expect(readFileSync(orphanPath)).toEqual(retained); expect(readdirSync(root).sort()).toEqual(names.sort());
    const oversized = join(root, `${randomUUID()}.json.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(oversized, ''); truncateSync(oversized, SOURCE_SNAPSHOT_MAX_BYTES + 1);
    expect(() => store.capture(file())).toThrow('capacity'); expect(readFileSync(path)).toEqual(original);
  });

  it('does not ignore arbitrary files that merely resemble an atomic temporary name', () => {
    const { root, store } = setup(); store.capture(file());
    for (const name of [`${randomUUID()}.json.0.${randomUUID()}.tmp`, `${randomUUID()}.json.01.${randomUUID()}.tmp`, `${randomUUID()}.json.${process.pid}.not-a-uuid.tmp`]) {
      const path = join(root, name); writeFileSync(path, '{}');
      expect(() => store.capture(file())).toThrow('Unexpected entry'); rmSync(path);
    }
  });

  it.each(['workspace', 'source'])('reports a live %s lock as retryable busy while preserving healthy reads and identical-operation retries', scope => {
    const { workspace, root, store } = setup(), first = store.capture(file()), path = join(root, `${first.snapshot.snapshotId}.json`), original = readFileSync(path);
    const lock = scope === 'workspace' ? join(workspace, WORKSPACE_LOCK_FILE) : join(root, '.write.lock');
    const owner = JSON.stringify({ owner: randomUUID(), pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() });
    writeFileSync(lock, owner);
    const blocked = (operation: () => unknown) => {
      // Keep the production guard and live-owner check; advance only its deadline instead of waiting five seconds per assertion.
      let now = -6000;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += 6000);
      try { operation(); throw new Error('Expected the live owner to block this write.'); }
      catch (error) { expect(error).toBeInstanceOf(SourceStoreError); expect(error).toMatchObject({ code: 'busy', retryable: true }); }
      finally { clock.mockRestore(); }
    };
    blocked(() => store.captureBatch([file(), file('new version')])); blocked(() => store.delete(first.snapshot.snapshotId, first.snapshot.sourceVersion));
    expect(readFileSync(lock, 'utf8')).toBe(owner); expect(readFileSync(path)).toEqual(original);
    expect(store.read(first.snapshot.snapshotId)).toEqual({ status: 'available', snapshot: first.snapshot });
    rmSync(lock); expect(store.capture(file())).toEqual({ snapshot: first.snapshot, reused: true });
    store.delete(first.snapshot.snapshotId, first.snapshot.sourceVersion); expect(store.read(first.snapshot.snapshotId)).toMatchObject({ reason: 'deleted' });
    expect(new SourceStoreError('corrupt', 'Invalid snapshot.').retryable).toBe(false);
  });

  it('cleans locks, descriptors and atomic temporaries after interruption and reuses publication after uncertain acknowledgement', () => {
    const { workspace, root, store } = setup(); fault.tempWrite = true;
    expect(() => store.capture(file())).toThrow(SourceStoreError); expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(workspace)).toEqual(['sources']); fault.afterLink = true;
    expect(() => store.capture(file())).toThrow(SourceStoreError);
    expect(readdirSync(root)).toHaveLength(1); expect(readdirSync(root)[0]).toMatch(/\.json$/u);
    const recovered = store.capture(file()); expect(recovered.reused).toBe(true); expect(readdirSync(root)).toHaveLength(1);
    const path = join(root, `${recovered.snapshot.snapshotId}.json`);
    fault.afterRead = () => truncateSync(path, 0);
    expect(store.read(recovered.snapshot.snapshotId)).toMatchObject({ reason: 'corrupt' }); expect(fault.descriptors.size).toBe(0);
    const fresh = setup(), controller = new AbortController(); controller.abort();
    expect(() => fresh.store.capture(file(), { signal: controller.signal })).toThrow(); expect(existsSync(fresh.root)).toBe(false);
  });

  it.each(['io', 'abort'] as const)('retries the healthy committed prefix after a later batch %s interruption without a second execution ledger', mode => {
    const { workspace, root, store } = setup(), controller = new AbortController();
    if (mode === 'io') fault.tempWriteCountdown = 2;
    else fault.afterPublished = () => controller.abort(new Error('authored batch cancellation'));
    expect(() => store.captureBatch([file('A'), file('B'), file('A')], { signal: controller.signal })).toThrow(mode === 'io'
      ? SourceStoreError : 'authored batch cancellation');
    const names = readdirSync(root); expect(names).toHaveLength(1); expect(names[0]).toMatch(/\.json$/u);
    expect(readdirSync(workspace)).toEqual(['sources']); expect(fault.descriptors.size).toBe(0);
    const path = join(root, names[0]), original = readFileSync(path), first = JSON.parse(original.toString());
    expect(store.read(first.snapshotId)).toMatchObject({ status: 'available', snapshot: { sourceVersion: first.sourceVersion } });
    const retried = store.captureBatch([file('A'), file('B'), file('A')]);
    expect(retried.sources.map(source => source.reused)).toEqual([true, false, true]);
    expect(retried.sources[0].snapshot.snapshotId).toBe(first.snapshotId);
    expect(retried.sources[2].snapshot.snapshotId).toBe(first.snapshotId);
    expect(retried.writtenBytes).toBe(readFileSync(join(root, `${retried.sources[1].snapshot.snapshotId}.json`)).length);
    expect(readFileSync(path)).toEqual(original); expect(readdirSync(root)).toHaveLength(2);
  });

  it('reports permission failures explicitly for reads, capture scans and deletion', () => {
    const { store } = setup(), captured = store.capture(file()); fault.denied = true;
    expect(store.read(captured.snapshot.snapshotId)).toMatchObject({ reason: 'permission_denied' });
    expect(() => store.capture(file())).toThrow('permission'); expect(() => store.delete(captured.snapshot.snapshotId)).toThrow('permission');
  });
});
