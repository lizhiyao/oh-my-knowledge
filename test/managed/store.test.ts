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
  hashArtifactSource,
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
      evidence: [{ reportId: 'r1', contentHash: 'aaaaaaaaaaaa', recordedAt: '2026-06-06T00:00:00.000Z' }],
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

  it('deriveManagedState:漂移/缺失→stale,同 hash 无证据→installed,匹配证据→measurable', () => {
    const record = makeRecord({ contentHash: 'aaaaaaaaaaaa' });
    assert.equal(deriveManagedState({ record, currentContentHash: 'bbbbbbbbbbbb' }).label, 'stale');
    assert.equal(deriveManagedState({ record, currentContentHash: undefined }).label, 'stale');
    assert.equal(deriveManagedState({ record, currentContentHash: 'aaaaaaaaaaaa' }).label, 'installed');
    assert.equal(deriveManagedState({ record, currentContentHash: 'aaaaaaaaaaaa', hasSamplesOrDoctorPass: true }).label, 'measurable');
    const withEvidence = makeRecord({
      contentHash: 'aaaaaaaaaaaa',
      evidence: [{ reportId: 'r1', contentHash: 'aaaaaaaaaaaa', recordedAt: 't' }],
    });
    assert.equal(deriveManagedState({ record: withEvidence, currentContentHash: 'aaaaaaaaaaaa' }).label, 'measurable');
  });

  it('deriveManagedState:旧内容的 evidence 不算当前证据,新内容不被读成 measurable(#203 不变量)', () => {
    // 先有 review 的证据(测的是旧内容 aaaa),后把同名 review 重装到新内容 cccc。
    const record = makeRecord({
      contentHash: 'cccccccccccc',
      evidence: [{ reportId: 'r1', contentHash: 'aaaaaaaaaaaa', recordedAt: 't' }],
    });
    // 当前文件就是新内容 cccc:不漂移,但旧证据 hash 不匹配 → 不能算 measurable。
    const state = deriveManagedState({ record, currentContentHash: 'cccccccccccc' });
    assert.equal(state.hasEvidence, false, '旧 hash 的 evidence 不算当前证据');
    assert.equal(state.label, 'installed', '新内容不能凭旧证据被读成 measurable');
  });

  it('hashArtifactSource:目录-skill 覆盖资产改动,文件-skill 跟内容走(P2)', () => {
    const root = join(dir, 'review');
    mkdirSync(join(root, 'references'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), '# review\n');
    writeFileSync(join(root, 'references', 'cmd.md'), 'asset v1\n');
    const h1 = hashArtifactSource(root, true);
    writeFileSync(join(root, 'references', 'cmd.md'), 'asset v2\n'); // 只改资产,不动 SKILL.md
    const h2 = hashArtifactSource(root, true);
    assert.notEqual(h1, h2, '资产改动必须改变目录树 hash');

    const file = join(dir, 'notes.md');
    writeFileSync(file, 'body v1\n');
    const f1 = hashArtifactSource(file, false);
    writeFileSync(file, 'body v2\n');
    assert.notEqual(f1, hashArtifactSource(file, false), '文件-skill hash 随内容变');
  });

  it('hashArtifactSource:忽略 .omk / evolve 等非分发产物,只补样本不算 artifact 漂移(P2)', () => {
    const root = join(dir, 'sk');
    mkdirSync(join(root, 'references'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), '# sk\n');
    writeFileSync(join(root, 'references', 'a.md'), 'asset\n');
    const base = hashArtifactSource(root, true);
    mkdirSync(join(root, '.omk'), { recursive: true });
    writeFileSync(join(root, '.omk', 'samples.json'), '[]\n');
    mkdirSync(join(root, 'evolve'), { recursive: true });
    writeFileSync(join(root, 'evolve', 'sk.r1.md'), 'cand\n');
    assert.equal(hashArtifactSource(root, true), base, '.omk / evolve 不该计入 artifact hash');
  });

  it('hashArtifactSource:仅源根第一层 evolve 排除,嵌套 references/evolve 是合法资产计入 hash', () => {
    const root = join(dir, 'sk2');
    mkdirSync(join(root, 'references', 'evolve'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), '# sk2\n');
    writeFileSync(join(root, 'references', 'evolve', 'guide.md'), 'v1\n');
    const h1 = hashArtifactSource(root, true);
    writeFileSync(join(root, 'references', 'evolve', 'guide.md'), 'v2\n');
    assert.notEqual(hashArtifactSource(root, true), h1, '嵌套 references/evolve 资产改动应改变 hash');
    const before = hashArtifactSource(root, true);
    mkdirSync(join(root, 'evolve'), { recursive: true });
    writeFileSync(join(root, 'evolve', 'cand.md'), 'x\n');
    assert.equal(hashArtifactSource(root, true), before, '仅源根第一层 evolve 排除');
  });

  it('坏元素的记录(evidence:[null] / distribution 缺 path)被 load 丢弃,不让消费方崩', () => {
    const store = managedDir(dir);
    const id = managedRecordId('skill', 'review');
    mkdirSync(store, { recursive: true });
    writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), evidence: [null] }));
    assert.equal(loadManagedRecord(store, id), null, 'evidence:[null] 应被判脏');
    writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), distribution: [{ label: 'x', contentHash: 'h', copiedAt: 't' }] }));
    assert.equal(loadManagedRecord(store, id), null, 'distribution 缺 path 应被判脏');
  });

  it('mergeManagedRecord:尾斜杠等价路径按归一化去重,不重复登记同一目标', () => {
    const prev = makeRecord({ distribution: [{ label: 'C', path: '/p/x', contentHash: 'a', copiedAt: 't' }] });
    const next = makeRecord({ distribution: [{ label: 'C', path: '/p/x/', contentHash: 'b', copiedAt: 't2' }] });
    assert.equal(mergeManagedRecord(prev, next).distribution.length, 1, '/p/x 与 /p/x/ 视为同一目标');
  });
});
