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
  appendManagedDecision,
  appendManagedObservation,
  rebaselineManagedContentHash,
  deriveManagedState,
  deriveProductionGap,
  isProductionGapObservation,
  isCurrentlyPromoted,
} from '../../src/managed/store.js';
import type { ManagedArtifactRecord, ManagedDecision, ManagedObservation } from '../../src/managed/contracts.js';
import { coreManagedEvidence } from '../helpers/core-managed-evidence.js';

const GAP0 = { failed_search: 0, explicit_marker: 0, hedging: 0, repeated_failure: 0 };
const TEST_AT = '2026-06-10T00:00:00.000Z';
function makeObs(over: Partial<ManagedObservation> = {}): ManagedObservation {
  return {
    observationKind: 'production-health', reportId: 'obs-1', observedAt: '2026-06-10T00:00:00.000Z',
    gapRate: 0, weightedGapRate: 0, confidence: 'high', healthBand: 'green', segmentCount: 20, gapByType: GAP0, ...over,
  };
}

function makeRecord(over: Partial<ManagedArtifactRecord> = {}): ManagedArtifactRecord {
  return {
    recordKind: 'managed-artifact',
    schemaVersion: 3,
    id: managedRecordId('skill', 'review'),
    name: 'review',
    kind: 'skill',
    source: { sourceKind: 'file', locator: '/abs/review', isDirectorySkill: true },
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
      source: { sourceKind: 'file', locator: '/abs/review', isDirectorySkill: true },
      contentHash: 'aaaaaaaaaaaa',
      installedAt: '2026-06-06T00:00:00.000Z',
      distribution: [],
    });
    assert.equal(rec.recordKind, 'managed-artifact');
    assert.equal(rec.schemaVersion, 3);
    assert.equal(rec.id, managedRecordId('skill', 'review'));
    assert.deepEqual(rec.evidence, []);
    assert.deepEqual(rec.decisions, []);
  });

  it('rebaselineManagedContentHash:把基线重锚到新哈,保留 evidence/decisions', () => {
    const store = managedDir(dir);
    upsertManagedRecord(store, makeRecord({
      evidence: [coreManagedEvidence('aaaaaaaaaaaa', { reportId: 'r1', recordedAt: '2026-06-06T00:00:00.000Z' })],
      decisions: [{ decisionKind: 'promote', actor: 't', decidedAt: '2026-06-07T00:00:00.000Z', contentHash: 'aaaaaaaaaaaa' }],
    }));
    const merged = rebaselineManagedContentHash(store, managedRecordId('skill', 'review'), 'cccccccccccc');
    assert.equal(merged?.contentHash, 'cccccccccccc', 'contentHash 重锚到新哈');
    assert.equal(merged?.evidence.length, 1, 'evidence 原样保留(旧哈条目变历史)');
    assert.equal(merged?.decisions.length, 1, 'decisions 原样保留');
    // 落盘后重读一致。
    const reloaded = loadManagedRecord(store, managedRecordId('skill', 'review'));
    assert.equal(reloaded?.contentHash, 'cccccccccccc');
    assert.ok(!readdirSync(store).some((f) => f.includes('.tmp.')), '不残留 tmp');
    assert.ok(!readdirSync(store).some((f) => f.endsWith('.lock')), '不残留 record lock');
  });

  it('rebaselineManagedContentHash:已是该哈 → no-op 原样返回', () => {
    const store = managedDir(dir);
    upsertManagedRecord(store, makeRecord());
    const merged = rebaselineManagedContentHash(store, managedRecordId('skill', 'review'), 'aaaaaaaaaaaa');
    assert.equal(merged?.contentHash, 'aaaaaaaaaaaa');
  });

  it('rebaselineManagedContentHash:记录不存在 → null', () => {
    const store = managedDir(dir);
    assert.equal(rebaselineManagedContentHash(store, 'nope', 'cccccccccccc'), null);
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
      evidence: [coreManagedEvidence('aaaaaaaaaaaa', { reportId: 'r1', recordedAt: '2026-06-06T00:00:00.000Z' })],
      decisions: [{ decisionKind: 'promote', actor: 'me', decidedAt: '2026-06-06T00:00:00.000Z' }],
      distribution: [{ label: 'Claude Code', path: '/p/claude', contentHash: 'aaaaaaaaaaaa', copiedAt: TEST_AT }],
    });
    const next = makeRecord({
      installedAt: '2026-07-01T00:00:00.000Z',
      evidence: [],
      decisions: [],
      distribution: [
        { label: 'Claude Code', path: '/p/claude', contentHash: 'bbbbbbbbbbbb', copiedAt: TEST_AT },
        { label: 'Codex/AGENTS', path: '/p/codex', contentHash: 'bbbbbbbbbbbb', copiedAt: TEST_AT },
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

  it('迁移边界:v1 记录(无 sourceKind)/ v2 缺 sourceKind 都判脏丢弃', () => {
    const store = managedDir(dir);
    const id = managedRecordId('skill', 'review');
    mkdirSync(store, { recursive: true });
    // #211 的 v1 记录:schemaVersion 1,source 无 sourceKind —— 去兼容直接丢弃。
    const v1: Record<string, unknown> = { ...makeRecord({ id }), schemaVersion: 1, source: { locator: '/abs/review', isDirectorySkill: true } };
    writeFileSync(recordPath(store, id), JSON.stringify(v1));
    assert.equal(loadManagedRecord(store, id), null, 'schemaVersion 1 应被迁移边界拒绝');
    // v2 但 source 缺新必填的 sourceKind:同样判脏。
    const noSk: Record<string, unknown> = { ...makeRecord({ id }), source: { locator: '/abs/review', isDirectorySkill: true } };
    writeFileSync(recordPath(store, id), JSON.stringify(noSk));
    assert.equal(loadManagedRecord(store, id), null, 'source 缺 sourceKind 应判脏');
  });

  it('validator 收窄运行时类型:畸形记录判脏丢弃(防下游 omk list 等崩溃)', () => {
    const store = managedDir(dir);
    const id = managedRecordId('skill', 'review');
    mkdirSync(store, { recursive: true });
    const write = (over: Record<string, unknown>) => writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), ...over }));

    // source.url 是对象(非 string)—— 旧 validator 只查 locator/sourceKind 是 string 会放行,
    // 随后 omk list 的 sourceLabel ?? url 变对象、dispWidth(对象) 抛 TypeError。
    write({ source: { sourceKind: 'git', locator: 'git:HEAD:x', url: {}, isDirectorySkill: true } });
    assert.equal(loadManagedRecord(store, id), null, 'source.url 非 string 判脏');

    write({ source: { sourceKind: 'evil', locator: '/abs/x', isDirectorySkill: true } });
    assert.equal(loadManagedRecord(store, id), null, 'sourceKind 非 file|git 判脏');

    // file 源不得携带 git-only 的 url / ref —— 否则 list 的 sourceLabel 显示假 url、掩盖真实被读的 locator。
    write({ source: { sourceKind: 'file', locator: '/abs/private.md', url: 'https://example.com/safe.git', isDirectorySkill: false } });
    assert.equal(loadManagedRecord(store, id), null, 'file 源带 url 判脏(防假 sourceLabel 掩盖真实读取路径)');

    write({ source: { sourceKind: 'file', locator: '/abs/private.md', ref: 'deadbeef', isDirectorySkill: false } });
    assert.equal(loadManagedRecord(store, id), null, 'file 源带 ref 判脏');

    write({ source: { sourceKind: 'file', locator: '/abs/x' } });
    assert.equal(loadManagedRecord(store, id), null, 'isDirectorySkill 缺失判脏');

    write({ source: { sourceKind: 'file', locator: '/abs/x', isDirectorySkill: 'yes' } });
    assert.equal(loadManagedRecord(store, id), null, 'isDirectorySkill 非 boolean 判脏');

    write({ kind: 'baseline' });
    assert.equal(loadManagedRecord(store, id), null, 'kind 非可安装 ArtifactKind 判脏');

    write({ schemaVersion: 2 });
    assert.equal(loadManagedRecord(store, id), null, 'v2 旧受管 schema 不迁移');

    write({ evidence: [{ reportId: 'r', contentHash: 'h', recordedAt: TEST_AT }] });
    assert.equal(loadManagedRecord(store, id), null, '非 Core 证据判脏');

    write({ evidence: [{ ...coreManagedEvidence('aaaaaaaaaaaa'), reportDigest: 'not-a-digest' }] });
    assert.equal(loadManagedRecord(store, id), null, 'Core digest 形态错误判脏');

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
      evidence: [coreManagedEvidence('aaaaaaaaaaaa', { reportId: 'r1', recordedAt: TEST_AT })],
    });
    assert.equal(deriveManagedState({ record: withEvidence, currentContentHash: 'aaaaaaaaaaaa' }).label, 'measurable');
    const withInsufficientEvidence = makeRecord({
      contentHash: 'aaaaaaaaaaaa',
      evidence: [coreManagedEvidence('aaaaaaaaaaaa', {
        reportId: 'r-insufficient',
        evidenceReadiness: 'insufficient',
      })],
    });
    assert.deepEqual(
      deriveManagedState({
        record: withInsufficientEvidence,
        currentContentHash: 'aaaaaaaaaaaa',
      }),
      { label: 'installed', drifted: false, hasEvidence: false },
    );
    const withMeasurementEvidence = makeRecord({
      contentHash: 'aaaaaaaaaaaa',
      evidence: [coreManagedEvidence('aaaaaaaaaaaa', {
        reportId: 'r-measurement',
        evidenceReadiness: 'measurement-only',
      })],
    });
    assert.equal(deriveManagedState({
      record: withMeasurementEvidence,
      currentContentHash: 'aaaaaaaaaaaa',
    }).label, 'measurable');
  });

  it('deriveManagedState:旧内容的 evidence 不算当前证据,新内容不被读成 measurable(#203 不变量)', () => {
    // 先有 review 的证据(测的是旧内容 aaaa),后把同名 review 重装到新内容 cccc。
    const record = makeRecord({
      contentHash: 'cccccccccccc',
      evidence: [coreManagedEvidence('aaaaaaaaaaaa', { reportId: 'r1', recordedAt: TEST_AT })],
    });
    // 当前文件就是新内容 cccc:不漂移,但旧证据 hash 不匹配 → 不能算 measurable。
    const state = deriveManagedState({ record, currentContentHash: 'cccccccccccc' });
    assert.equal(state.hasEvidence, false, '旧 hash 的 evidence 不算当前证据');
    assert.equal(state.label, 'installed', '新内容不能凭旧证据被读成 measurable');
  });

  it('坏元素的记录(evidence:[null] / distribution 缺 path)被 load 丢弃,不让消费方崩', () => {
    const store = managedDir(dir);
    const id = managedRecordId('skill', 'review');
    mkdirSync(store, { recursive: true });
    writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), evidence: [null] }));
    assert.equal(loadManagedRecord(store, id), null, 'evidence:[null] 应被判脏');
    writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), distribution: [{ label: 'x', contentHash: 'h', copiedAt: TEST_AT }] }));
    assert.equal(loadManagedRecord(store, id), null, 'distribution 缺 path 应被判脏');
  });

  it('mergeManagedRecord:尾斜杠等价路径按归一化去重,不重复登记同一目标', () => {
    const prev = makeRecord({ distribution: [{ label: 'C', path: '/p/x', contentHash: 'a', copiedAt: TEST_AT }] });
    const next = makeRecord({ distribution: [{ label: 'C', path: '/p/x/', contentHash: 'b', copiedAt: '2026-06-11T00:00:00.000Z' }] });
    assert.equal(mergeManagedRecord(prev, next).distribution.length, 1, '/p/x 与 /p/x/ 视为同一目标');
  });

  // --- promote 决定 ---
  const promoteDecision = (over: Partial<ManagedDecision> = {}): ManagedDecision => ({
    decisionKind: 'promote', actor: 'tester', decidedAt: '2026-06-08T00:00:00.000Z', contentHash: 'aaaaaaaaaaaa', runId: 'r1', ...over,
  });

  it('appendManagedDecision:append-only 追加,记录不存在返 null', () => {
    const store = managedDir(dir);
    assert.equal(appendManagedDecision(store, 'nope', promoteDecision()), null, '未纳管 → null');
    const written = upsertManagedRecord(store, makeRecord());
    const merged = appendManagedDecision(store, written.id, promoteDecision());
    assert.equal(merged?.decisions.length, 1);
    assert.equal(merged?.decisions[0].decisionKind, 'promote');
    assert.deepEqual(loadManagedRecord(store, written.id)?.decisions[0].runId, 'r1', '落盘可读回');
  });

  it('appendManagedDecision:当前内容已 promote 同 kind → 幂等不重复追加', () => {
    const store = managedDir(dir);
    const written = upsertManagedRecord(store, makeRecord());
    appendManagedDecision(store, written.id, promoteDecision());
    const again = appendManagedDecision(store, written.id, promoteDecision({ decidedAt: '2026-06-09T00:00:00.000Z' }));
    assert.equal(again?.decisions.length, 1, '同 contentHash 的 promote 不堆第二条');
  });

  it('appendManagedDecision:换内容(contentHash 变)后再 promote 追加新决定(版本史)', () => {
    const store = managedDir(dir);
    const written = upsertManagedRecord(store, makeRecord());
    appendManagedDecision(store, written.id, promoteDecision({ contentHash: 'aaaaaaaaaaaa' }));
    const second = appendManagedDecision(store, written.id, promoteDecision({ contentHash: 'bbbbbbbbbbbb' }));
    assert.equal(second?.decisions.length, 2, '不同内容各记一条');
  });

  it('upsert(install 重装)保留已有 decisions,不被 next 的空 decisions 覆盖', () => {
    const store = managedDir(dir);
    const written = upsertManagedRecord(store, makeRecord());
    appendManagedDecision(store, written.id, promoteDecision());
    const reinstalled = upsertManagedRecord(store, makeRecord({ contentHash: 'aaaaaaaaaaaa' }));
    assert.equal(reinstalled.decisions.length, 1, 'install 不抹掉 promote 历史');
  });

  it('deriveManagedState:当前内容有 promote 决定 → promoted(高于 measurable)', () => {
    const record = makeRecord({
      contentHash: 'aaaaaaaaaaaa',
      evidence: [coreManagedEvidence('aaaaaaaaaaaa', { reportId: 'r1', recordedAt: TEST_AT })],
      decisions: [promoteDecision({ contentHash: 'aaaaaaaaaaaa' })],
    });
    assert.equal(deriveManagedState({ record, currentContentHash: 'aaaaaaaaaaaa' }).label, 'promoted');
  });

  it('deriveManagedState:drift 优先于 promoted;旧内容的 promote 决定不冒充当前', () => {
    // 当前内容 cccc,但 promote 决定锚的是旧内容 aaaa。
    const record = makeRecord({
      contentHash: 'cccccccccccc',
      decisions: [promoteDecision({ contentHash: 'aaaaaaaaaaaa' })],
    });
    // 源也漂了(当前盘是 dddd)→ stale 优先。
    assert.equal(deriveManagedState({ record, currentContentHash: 'dddddddddddd' }).label, 'stale');
    // 源不漂(盘上就是 cccc),但 promote 决定是旧内容的 → 不算 promoted,落回 installed。
    assert.equal(deriveManagedState({ record, currentContentHash: 'cccccccccccc' }).label, 'installed');
  });

  // --- rollback 决定(promote 的反操作,决定流 latest-wins)---
  const rollbackDecision = (over: Partial<ManagedDecision> = {}): ManagedDecision => ({
    decisionKind: 'rollback', actor: 'tester', decidedAt: '2026-06-09T00:00:00.000Z', contentHash: 'aaaaaaaaaaaa', ...over,
  });

  it('isCurrentlyPromoted:promote→rollback→撤销;rollback→promote→恢复(取当前内容最近一条)', () => {
    const base = makeRecord({ contentHash: 'aaaaaaaaaaaa' });
    assert.equal(isCurrentlyPromoted(base), false, '无决定 → 未 promoted');
    const promoted = makeRecord({ contentHash: 'aaaaaaaaaaaa', decisions: [promoteDecision({ decidedAt: '2026-06-08T00:00:00.000Z' })] });
    assert.equal(isCurrentlyPromoted(promoted), true);
    const rolledBack = makeRecord({ contentHash: 'aaaaaaaaaaaa', decisions: [promoteDecision({ decidedAt: '2026-06-08T00:00:00.000Z' }), rollbackDecision({ decidedAt: '2026-06-09T00:00:00.000Z' })] });
    assert.equal(isCurrentlyPromoted(rolledBack), false, 'rollback 后 → 撤销');
    const rePromoted = makeRecord({ contentHash: 'aaaaaaaaaaaa', decisions: [promoteDecision({ decidedAt: '2026-06-08T00:00:00.000Z' }), rollbackDecision({ decidedAt: '2026-06-09T00:00:00.000Z' }), promoteDecision({ decidedAt: '2026-06-10T00:00:00.000Z' })] });
    assert.equal(isCurrentlyPromoted(rePromoted), true, '再 promote → 恢复');
  });

  it('isCurrentlyPromoted:只看当前内容,旧内容的 rollback 不影响新内容', () => {
    const record = makeRecord({ contentHash: 'bbbbbbbbbbbb', decisions: [promoteDecision({ contentHash: 'aaaaaaaaaaaa' }), rollbackDecision({ contentHash: 'aaaaaaaaaaaa' })] });
    assert.equal(isCurrentlyPromoted(record), false, '当前内容 bbbb 无任何决定 → 未 promoted');
  });

  it('deriveManagedState:当前内容最近一条是 rollback → 落回 measurable(不是 promoted)', () => {
    const record = makeRecord({
      contentHash: 'aaaaaaaaaaaa',
      evidence: [coreManagedEvidence('aaaaaaaaaaaa', { reportId: 'r1', recordedAt: TEST_AT })],
      decisions: [promoteDecision({ decidedAt: '2026-06-08T00:00:00.000Z' }), rollbackDecision({ decidedAt: '2026-06-09T00:00:00.000Z' })],
    });
    assert.equal(deriveManagedState({ record, currentContentHash: 'aaaaaaaaaaaa' }).label, 'measurable', 'rollback 后有当前证据 → measurable');
  });

  it('appendManagedDecision:promote→rollback→promote 各自改变态 → 三条都落盘(非去重)', () => {
    const store = managedDir(dir);
    const written = upsertManagedRecord(store, makeRecord({ contentHash: 'aaaaaaaaaaaa' }));
    appendManagedDecision(store, written.id, promoteDecision({ decidedAt: '2026-06-08T00:00:00.000Z' }));
    appendManagedDecision(store, written.id, rollbackDecision({ decidedAt: '2026-06-09T00:00:00.000Z' }));
    const third = appendManagedDecision(store, written.id, promoteDecision({ decidedAt: '2026-06-10T00:00:00.000Z' }));
    assert.equal(third?.decisions.length, 3, 'promote/rollback 真实切换都记，版本史完整');
    assert.equal(isCurrentlyPromoted(third!), true, '末态 promoted');
  });

  it('appendManagedDecision:已 promoted 再 promote、已撤销再 rollback 都幂等不堆', () => {
    const store = managedDir(dir);
    const written = upsertManagedRecord(store, makeRecord({ contentHash: 'aaaaaaaaaaaa' }));
    appendManagedDecision(store, written.id, promoteDecision({ decidedAt: '2026-06-08T00:00:00.000Z' }));
    const dupPromote = appendManagedDecision(store, written.id, promoteDecision({ decidedAt: '2026-06-08T12:00:00.000Z' }));
    assert.equal(dupPromote?.decisions.length, 1, '已 promoted 再 promote 不堆');
    appendManagedDecision(store, written.id, rollbackDecision({ decidedAt: '2026-06-09T00:00:00.000Z' }));
    const dupRollback = appendManagedDecision(store, written.id, rollbackDecision({ decidedAt: '2026-06-09T12:00:00.000Z' }));
    assert.equal(dupRollback?.decisions.length, 2, '已撤销再 rollback 不堆');
    assert.equal(isCurrentlyPromoted(dupRollback!), false);
  });

  it('重复决定也先校验 payload，幂等分支不能掩盖畸形决定', () => {
    const store = managedDir(dir);
    const written = upsertManagedRecord(store, makeRecord({ contentHash: 'aaaaaaaaaaaa' }));
    appendManagedDecision(store, written.id, promoteDecision());
    assert.throws(
      () => appendManagedDecision(store, written.id, promoteDecision({ actor: '' })),
      /invalid managed decision/,
    );
    assert.equal(loadManagedRecord(store, written.id)?.decisions.length, 1);
  });

  it('validator:promote 决定的 contentHash/reportId/override 脏值被判脏丢弃', () => {
    const store = managedDir(dir);
    const id = managedRecordId('skill', 'review');
    mkdirSync(store, { recursive: true });
    // override 非 {verdict:string} → 脏。
    writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), decisions: [{ decisionKind: 'promote', actor: 'x', decidedAt: TEST_AT, override: { verdict: 123 } }] }));
    assert.equal(loadManagedRecord(store, id), null, 'override.verdict 非 string 应判脏');
    // override.overriddenBlocks 非 string[] → 脏。
    writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), decisions: [{ decisionKind: 'promote', actor: 'x', decidedAt: TEST_AT, override: { verdict: 'NOISE', overriddenBlocks: [1, 2] } }] }));
    assert.equal(loadManagedRecord(store, id), null, 'overriddenBlocks 非 string[] 应判脏');
    // contentHash 非 string → 脏。
    writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), decisions: [{ decisionKind: 'promote', actor: 'x', decidedAt: TEST_AT, contentHash: 42 }] }));
    assert.equal(loadManagedRecord(store, id), null, 'decision.contentHash 非 string 应判脏');
    // 合法 promote 决定 → 读回。
    writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), decisions: [promoteDecision()] }));
    assert.equal(loadManagedRecord(store, id)?.decisions[0].decisionKind, 'promote', '合法决定应读回');
  });
});

describe('managed store — observations(#235)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omk-obs-store-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('appendManagedObservation:追加/初始化/按 reportId 去重/缺记录→null', () => {
    const store = managedDir(dir);
    const id = managedRecordId('skill', 'review');
    assert.equal(appendManagedObservation(store, id, makeObs()), null, '记录不存在 → null(管理是 install opt-in)');
    upsertManagedRecord(store, makeRecord({ id }));
    const r1 = appendManagedObservation(store, id, makeObs({ reportId: 'a' }));
    assert.equal(r1!.observations?.length, 1, '首条初始化 observations');
    const r2 = appendManagedObservation(store, id, makeObs({ reportId: 'a' }));
    assert.equal(r2!.observations?.length, 1, '同 reportId 去重 no-op');
    const r3 = appendManagedObservation(store, id, makeObs({ reportId: 'b' }));
    assert.equal(r3!.observations?.length, 2, '异 reportId 追加');
  });

  it('validator:畸形观测判脏丢整条;合法 / 缺省放行(back-compat)', () => {
    const store = managedDir(dir);
    const id = managedRecordId('skill', 'review');
    mkdirSync(store, { recursive: true });
    const write = (obs: unknown) => writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), observations: obs }));

    write([{ ...makeObs(), observationKind: 'bogus' }]);
    assert.equal(loadManagedRecord(store, id), null, 'observationKind 非 production-health 判脏');
    write([{ ...makeObs(), healthBand: 'purple' }]);
    assert.equal(loadManagedRecord(store, id), null, 'healthBand 非法枚举判脏');
    write([{ ...makeObs(), confidence: 42 }]);
    assert.equal(loadManagedRecord(store, id), null, 'confidence 非法判脏');
    write([{ ...makeObs(), gapByType: { failed_search: 'x', explicit_marker: 0, hedging: 0, repeated_failure: 0 } }]);
    assert.equal(loadManagedRecord(store, id), null, 'gapByType 含非 number 判脏');
    write('not-an-array');
    assert.equal(loadManagedRecord(store, id), null, 'observations 非数组判脏');

    write([makeObs({ healthBand: 'red', confidence: 'high', gapRate: 0.4, weightedGapRate: 0.4 })]);
    assert.ok(loadManagedRecord(store, id), '合法观测读回');
    // 缺省(旧记录无 observations)仍合法。
    writeFileSync(recordPath(store, id), JSON.stringify(makeRecord({ id })));
    assert.ok(loadManagedRecord(store, id), 'observations 缺省 back-compat');
  });

  it('mergeManagedRecord / 重装 upsert 保留 prev.observations', () => {
    const store = managedDir(dir);
    const id = managedRecordId('skill', 'review');
    upsertManagedRecord(store, makeRecord({ id }));
    appendManagedObservation(store, id, makeObs({ reportId: 'a' }));
    // 重装(install 只写事实、next 无 observations)不应丢历史观测。
    upsertManagedRecord(store, makeRecord({ id, contentHash: 'bbbbbbbbbbbb' }));
    assert.equal(loadManagedRecord(store, id)!.observations?.length, 1, '重装保留 observations');
  });

  it('重复 reportId 也先校验 payload，幂等分支不能掩盖畸形观测', () => {
    const store = managedDir(dir);
    const id = managedRecordId('skill', 'review');
    upsertManagedRecord(store, makeRecord({ id }));
    appendManagedObservation(store, id, makeObs());
    assert.throws(
      () => appendManagedObservation(store, id, makeObs({ observedAt: 'not-a-timestamp' })),
      /invalid managed observation/,
    );
    assert.equal(loadManagedRecord(store, id)?.observations?.length, 1);
  });

  it('isProductionGapObservation:red 且够力才确诊;underpowered / yellow / green 不算', () => {
    assert.equal(isProductionGapObservation(makeObs({ healthBand: 'red', confidence: 'high' })), true);
    assert.equal(isProductionGapObservation(makeObs({ healthBand: 'red', confidence: 'underpowered' })), false);
    assert.equal(isProductionGapObservation(makeObs({ healthBand: 'yellow', confidence: 'high' })), false);
    assert.equal(isProductionGapObservation(makeObs({ healthBand: 'green', confidence: 'high' })), false);
  });

  it('deriveProductionGap:无观测→none;red+够力→gap;underpowered→underpowered;latest-wins', () => {
    assert.equal(deriveProductionGap(makeRecord()).marker, 'none', '无观测');
    assert.equal(deriveProductionGap(makeRecord({ observations: [makeObs({ healthBand: 'red', confidence: 'high', weightedGapRate: 0.4 })] })).marker, 'gap');
    assert.equal(deriveProductionGap(makeRecord({ observations: [makeObs({ healthBand: 'red', confidence: 'underpowered' })] })).marker, 'underpowered');
    // 两条:最新一条 green → none(就算更早那条是 red)。
    const m = deriveProductionGap(makeRecord({ observations: [
      makeObs({ reportId: 'old', observedAt: '2026-06-08T00:00:00.000Z', healthBand: 'red', confidence: 'high', weightedGapRate: 0.4 }),
      makeObs({ reportId: 'new', observedAt: '2026-06-12T00:00:00.000Z', healthBand: 'green' }),
    ] }));
    assert.equal(m.marker, 'none', 'latest-wins:最新 green');
    assert.equal(m.latest!.reportId, 'new');
  });

  it('无版本闸门:观测早于当前内容证据也照常 surface(版本无关信号,不按源码版归因)', () => {
    // 当前内容 B 的证据在 2026-06-20,而观测窗口结束在 2026-06-05(早于)。observe 量的是线上部署版,
    // 记录无可靠「源码版↔部署版」时间锚,故不做版本闸门 —— 按 latest-wins 照常 surface(防回归:有人若
    // 重新加闸门,这条会红)。源码 bump 后旧观测仍有效(旧副本还部署着),闸门会错误压掉它。
    const rec = makeRecord({
      contentHash: 'bbbbbbbbbbbb',
      evidence: [coreManagedEvidence('bbbbbbbbbbbb', { reportId: 'evB', recordedAt: '2026-06-20T00:00:00.000Z' })],
      observations: [makeObs({ observedAt: '2026-06-05T00:00:00.000Z', healthBand: 'red', confidence: 'high', weightedGapRate: 0.4 })],
    });
    assert.equal(deriveProductionGap(rec).marker, 'gap');
  });

  it('承重不变量:有 red 观测但 contentHash 匹配 → 仍 measurable,绝不 stale', () => {
    const rec = makeRecord({
      evidence: [coreManagedEvidence('aaaaaaaaaaaa', { reportId: 'e' })],
      observations: [makeObs({ observedAt: '2026-06-12T00:00:00.000Z', healthBand: 'red', confidence: 'high', weightedGapRate: 0.4 })],
    });
    // 生产盲区是 marker,不进生命周期:当前 hash 匹配 → measurable(观测不翻 stale)。
    const d = deriveManagedState({ record: rec, currentContentHash: 'aaaaaaaaaaaa' });
    assert.equal(d.label, 'measurable');
    assert.equal(d.drifted, false);
    // 同一记录的生产盲区 marker 独立亮起。
    assert.equal(deriveProductionGap(rec).marker, 'gap');
  });
});
