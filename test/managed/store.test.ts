/**
 * 受管记录 per-record 文件存储的单测。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  managedDir,
  recordPath,
  managedRecordId,
  buildManagedArtifactRecord,
  loadManagedRecord,
  loadAllManagedRecords,
  mergeManagedRecord,
  upsertManagedRecord,
  deriveManagedState,
} from '../../src/managed/store.js';
import type { ManagedArtifactRecord } from '../../src/types/index.js';

function makeRecord(over: Partial<ManagedArtifactRecord> = {}): ManagedArtifactRecord {
  return {
    recordKind: 'managed-artifact',
    schemaVersion: 1,
    id: managedRecordId('skill', 'review'),
    name: 'review',
    kind: 'skill',
    source: { locator: '/abs/review/SKILL.md', isDirectorySkill: true },
    contentHash: 'aaaaaaaaaaaa',
    installedAt: '2026-06-06T00:00:00.000Z',
    distribution: [{ label: 'Claude Code', path: '/home/.claude/skills/review', contentHash: 'aaaaaaaaaaaa', copiedAt: '2026-06-06T00:00:00.000Z' }],
    evidence: [],
    decisions: [],
    ...over,
  };
}

describe('managed store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omk-managed-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('managedRecordId 仅取决于 (kind, name),与源路径无关', () => {
    assert.equal(managedRecordId('skill', 'review'), managedRecordId('skill', 'review'));
    assert.notEqual(managedRecordId('skill', 'review'), managedRecordId('prompt', 'review'));
    assert.notEqual(managedRecordId('skill', 'review'), managedRecordId('skill', 'rewrite'));
  });

  it('buildManagedArtifactRecord 统一盖戳 recordKind/schemaVersion/空 evidence+decisions', () => {
    const rec = buildManagedArtifactRecord({
      name: 'review',
      kind: 'skill',
      source: { locator: '/abs/review/SKILL.md', isDirectorySkill: true },
      contentHash: 'aaaaaaaaaaaa',
      installedAt: '2026-06-06T00:00:00.000Z',
      distribution: [],
    });
    assert.equal(rec.recordKind, 'managed-artifact');
    assert.equal(rec.schemaVersion, 1);
    assert.equal(rec.id, managedRecordId('skill', 'review'));
    assert.deepEqual(rec.evidence, []);
    assert.deepEqual(rec.decisions, []);
  });

  it('upsert 写一个文件,再次 upsert 同 id 不新增文件', () => {
    const store = managedDir(dir);
    upsertManagedRecord(store, makeRecord());
    upsertManagedRecord(store, makeRecord({ contentHash: 'bbbbbbbbbbbb' }));
    const files = readdirSync(store).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    assert.ok(!readdirSync(store).some((f) => f.includes('.tmp.')), '不应残留 tmp 文件');
  });

  it('mergeManagedRecord:distribution 按 path 去重,evidence/decisions 保留旧值', () => {
    const prev = makeRecord({
      evidence: [{ reportId: 'r1', recordedAt: '2026-06-06T00:00:00.000Z' }],
      decisions: [{ decisionKind: 'promote', actor: 'me', decidedAt: '2026-06-06T00:00:00.000Z' }],
      distribution: [{ label: 'Claude Code', path: '/p/claude', contentHash: 'aaaaaaaaaaaa', copiedAt: 't0' }],
    });
    const next = makeRecord({
      installedAt: '2026-07-01T00:00:00.000Z',
      evidence: [],
      decisions: [],
      distribution: [
        { label: 'Claude Code', path: '/p/claude', contentHash: 'bbbbbbbbbbbb', copiedAt: 't1' },
        { label: 'Codex/AGENTS', path: '/p/codex', contentHash: 'bbbbbbbbbbbb', copiedAt: 't1' },
      ],
    });
    const merged = mergeManagedRecord(prev, next);
    assert.equal(merged.installedAt, prev.installedAt, 'installedAt 保留首次');
    assert.equal(merged.evidence.length, 1, 'evidence 保留');
    assert.equal(merged.decisions.length, 1, 'decisions 保留');
    assert.equal(merged.distribution.length, 2, '同 path 去重后两条');
    assert.equal(merged.distribution.find((t) => t.path === '/p/claude')?.contentHash, 'bbbbbbbbbbbb', '同 path 用新值');
  });

  it('mergeManagedRecord(null, next) === next', () => {
    const next = makeRecord();
    assert.deepEqual(mergeManagedRecord(null, next), next);
  });

  it('loadManagedRecord:缺失→null,损坏→null,错 recordKind→null', () => {
    const store = managedDir(dir);
    const id = managedRecordId('skill', 'review');
    assert.equal(loadManagedRecord(store, id), null);
    mkdirSync(store, { recursive: true });
    writeFileSync(recordPath(store, id), '{ not json');
    assert.equal(loadManagedRecord(store, id), null);
    writeFileSync(recordPath(store, id), JSON.stringify({ recordKind: 'something-else', schemaVersion: 1 }));
    assert.equal(loadManagedRecord(store, id), null);
    upsertManagedRecord(store, makeRecord());
    assert.ok(loadManagedRecord(store, id));
  });

  it('loadAllManagedRecords:跳过损坏文件,只收合法记录', () => {
    const store = managedDir(dir);
    upsertManagedRecord(store, makeRecord());
    writeFileSync(join(store, 'broken.json'), '{ bad');
    writeFileSync(join(store, 'notrecord.json'), JSON.stringify({ recordKind: 'x' }));
    const all = loadAllManagedRecords(store);
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'review');
  });

  it('round-trip:upsert 后能读回同一记录', () => {
    const store = managedDir(dir);
    const written = upsertManagedRecord(store, makeRecord());
    assert.deepEqual(loadManagedRecord(store, written.id), written);
    assert.ok(existsSync(recordPath(store, written.id)));
  });

  it('deriveManagedState:漂移/缺失→stale,同 hash 无证据→installed,有证据→measurable', () => {
    const record = makeRecord({ contentHash: 'aaaaaaaaaaaa' });
    assert.equal(deriveManagedState({ record, currentContentHash: 'bbbbbbbbbbbb' }).label, 'stale');
    assert.equal(deriveManagedState({ record, currentContentHash: undefined }).label, 'stale');
    assert.equal(deriveManagedState({ record, currentContentHash: 'aaaaaaaaaaaa' }).label, 'installed');
    assert.equal(deriveManagedState({ record, currentContentHash: 'aaaaaaaaaaaa', hasSamplesOrDoctorPass: true }).label, 'measurable');
    const withEvidence = makeRecord({ contentHash: 'aaaaaaaaaaaa', evidence: [{ reportId: 'r1', recordedAt: 't' }] });
    assert.equal(deriveManagedState({ record: withEvidence, currentContentHash: 'aaaaaaaaaaaa' }).label, 'measurable');
  });
});
