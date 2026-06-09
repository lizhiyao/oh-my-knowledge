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
  deriveManagedState,
} from '../../src/managed/store.js';
import type { ManagedArtifactRecord, ManagedDecision } from '../../src/types/index.js';

function makeRecord(over: Partial<ManagedArtifactRecord> = {}): ManagedArtifactRecord {
  return {
    recordKind: 'managed-artifact',
    schemaVersion: 2,
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
    assert.equal(rec.schemaVersion, 2);
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

    write({ evidence: [{ reportId: 'r', contentHash: 'h', recordedAt: 't', comparability: { cliVersion: 1 } }] });
    assert.equal(loadManagedRecord(store, id), null, 'evidence.comparability.cliVersion 非 string 判脏');

    // comparability 的可选 marker 同样收窄(否则任意类型脏值穿过 validator 进 list --json / 未来 promote)。
    write({ evidence: [{ reportId: 'r', contentHash: 'h', recordedAt: 't', comparability: { cliVersion: '0.35.0', judgePromptHash: { nested: true } } }] });
    assert.equal(loadManagedRecord(store, id), null, 'comparability.judgePromptHash 非 string 判脏');

    write({ evidence: [{ reportId: 'r', contentHash: 'h', recordedAt: 't', comparability: { cliVersion: '0.35.0', debiasMode: 42 } }] });
    assert.equal(loadManagedRecord(store, id), null, 'comparability.debiasMode 非数组判脏');

    write({ evidence: [{ reportId: 'r', contentHash: 'h', recordedAt: 't', comparability: { cliVersion: '0.35.0', debiasMode: ['length', 'evil'] } }] });
    assert.equal(loadManagedRecord(store, id), null, 'comparability.debiasMode 含非法枚举值判脏');

    // 合法记录仍放行(含完整 evidence bundle + 合法 comparability marker,确认没把合法值误伤)。
    write({ evidence: [{ reportId: 'r', contentHash: 'aaaaaaaaaaaa', recordedAt: 't', verdict: 'PROGRESS', comparability: { cliVersion: '0.35.0', judgePromptHash: 'abc123', debiasMode: ['length', 'position'] } }] });
    assert.ok(loadManagedRecord(store, id), '合法记录正常加载');
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

  // --- promote 决定 ---
  const promoteDecision = (over: Partial<ManagedDecision> = {}): ManagedDecision => ({
    decisionKind: 'promote', actor: 'tester', decidedAt: '2026-06-08T00:00:00.000Z', contentHash: 'aaaaaaaaaaaa', reportId: 'r1', ...over,
  });

  it('appendManagedDecision:append-only 追加,记录不存在返 null', () => {
    const store = managedDir(dir);
    assert.equal(appendManagedDecision(store, 'nope', promoteDecision()), null, '未纳管 → null');
    const written = upsertManagedRecord(store, makeRecord());
    const merged = appendManagedDecision(store, written.id, promoteDecision());
    assert.equal(merged?.decisions.length, 1);
    assert.equal(merged?.decisions[0].decisionKind, 'promote');
    assert.deepEqual(loadManagedRecord(store, written.id)?.decisions[0].reportId, 'r1', '落盘可读回');
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
      evidence: [{ reportId: 'r1', contentHash: 'aaaaaaaaaaaa', recordedAt: 't', verdict: 'PROGRESS' }],
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

  it('validator:promote 决定的 contentHash/reportId/override 脏值被判脏丢弃', () => {
    const store = managedDir(dir);
    const id = managedRecordId('skill', 'review');
    mkdirSync(store, { recursive: true });
    // override 非 {verdict:string} → 脏。
    writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), decisions: [{ decisionKind: 'promote', actor: 'x', decidedAt: 't', override: { verdict: 123 } }] }));
    assert.equal(loadManagedRecord(store, id), null, 'override.verdict 非 string 应判脏');
    // contentHash 非 string → 脏。
    writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), decisions: [{ decisionKind: 'promote', actor: 'x', decidedAt: 't', contentHash: 42 }] }));
    assert.equal(loadManagedRecord(store, id), null, 'decision.contentHash 非 string 应判脏');
    // 合法 promote 决定 → 读回。
    writeFileSync(recordPath(store, id), JSON.stringify({ ...makeRecord({ id }), decisions: [promoteDecision()] }));
    assert.equal(loadManagedRecord(store, id)?.decisions[0].decisionKind, 'promote', '合法决定应读回');
  });
});
