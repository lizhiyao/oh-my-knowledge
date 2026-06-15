/**
 * eval → managed evidence 写入单测(#221:install→eval→measurable 端到端闭环)。
 *
 * 集成用例刻意**非 fixture**:记录的 contentHash 与 report 的 artifactHash 都取自同一处真实
 * `hashArtifactSource`(install 与 eval 共用的指纹口径),以此证明 #214/#218 的"指纹统一 → 证据可绑"
 * 真的成立 —— 不是手搓一条匹配的 evidence。LLM 驱动的那条腿由既有 eval e2e 覆盖,此处只锁住
 * 「report 落地成 evidence、deriveManagedState 命中 measurable」这段纯逻辑。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  managedRecordId,
  buildManagedArtifactRecord,
  upsertManagedRecord,
  loadManagedRecord,
  appendManagedEvidence,
  deriveManagedState,
} from '../../src/managed/store.js';
import { buildEvidenceRef, recordEvalEvidence } from '../../src/managed/evidence.js';
import { hashArtifactSource } from '../../src/inputs/content-hash.js';
import type { EvaluationReport } from '../../src/types/index.js';

/** 造一份只含 evidence 写入所需字段的 report;其余字段不影响本模块。 */
function makeReport(over: {
  id?: string;
  variants?: string[];
  artifactHashes?: Record<string, string>;
  sampleHashes?: Record<string, string>;
  cliVersion?: string;
  judgePromptHash?: string;
  debiasMode?: Array<'length' | 'position'>;
  gitInfo?: { commit: string; commitShort: string; branch: string; dirty: boolean } | null;
} = {}): EvaluationReport {
  return {
    kind: 'evaluation',
    id: over.id ?? 'report-abc',
    meta: {
      variants: over.variants ?? ['baseline', 'review'],
      artifactHashes: over.artifactHashes ?? { baseline: 'no-skill', review: 'aaaaaaaaaaaa' },
      cliVersion: over.cliVersion ?? '0.34.0',
      sampleHashes: over.sampleHashes ?? { s1: 'h1', s2: 'h2' },
      ...(over.judgePromptHash ? { judgePromptHash: over.judgePromptHash } : {}),
      ...(over.debiasMode ? { debiasMode: over.debiasMode } : {}),
      ...(over.gitInfo !== undefined ? { gitInfo: over.gitInfo } : {}),
    },
    summary: {},
    results: [],
  } as unknown as EvaluationReport;
}

const CLEAN_GIT = { commit: 'abc1234567890def', commitShort: 'abc1234', branch: 'main', dirty: false };
const LOCAL_GIT_SOURCE = { sourceKind: 'git', locator: 'git:HEAD:skills/review', ref: 'HEAD', isDirectorySkill: true } as const;
const REMOTE_GIT_SOURCE = { sourceKind: 'git', locator: 'git+https://x/r@abc:review', url: 'https://x/r', ref: 'abc', isDirectorySkill: true } as const;
const FILE_SOURCE = { sourceKind: 'file', locator: '/abs/skills/review.md', isDirectorySkill: false } as const;

describe('managed evidence — buildEvidenceRef', () => {
  it('装齐 §5 mandatory 四项(reportId / contentHash / verdict / sampleCoverage / comparability)', () => {
    const report = makeReport({ judgePromptHash: 'jph123', debiasMode: ['length'] });
    const ref = buildEvidenceRef(report, 'review', 'PROGRESS', '2026-06-08T00:00:00.000Z');
    assert.ok(ref);
    assert.equal(ref!.reportId, 'report-abc');
    assert.equal(ref!.contentHash, 'aaaaaaaaaaaa');
    assert.equal(ref!.verdict, 'PROGRESS');
    assert.equal(ref!.sampleCoverage?.count, 2);
    assert.ok(ref!.sampleCoverage?.hash);
    assert.equal(ref!.comparability?.cliVersion, '0.34.0');
    assert.equal(ref!.comparability?.judgePromptHash, 'jph123');
    assert.deepEqual(ref!.comparability?.debiasMode, ['length']);
  });

  it('baseline / no-skill / 缺 hash 的变体 → null(不产证据)', () => {
    const report = makeReport();
    assert.equal(buildEvidenceRef(report, 'baseline', 'SOLO', 'now'), null, 'no-skill 哨兵跳过');
    assert.equal(buildEvidenceRef(report, 'nonexistent', 'SOLO', 'now'), null, '无 hash 跳过');
  });

  it('sampleCoverage 与样本顺序无关(同一集合 ⇒ 同 hash)', () => {
    const a = buildEvidenceRef(makeReport({ sampleHashes: { s1: 'h1', s2: 'h2' } }), 'review', 'PROGRESS', 'now');
    const b = buildEvidenceRef(makeReport({ sampleHashes: { s2: 'h2', s1: 'h1' } }), 'review', 'PROGRESS', 'now');
    assert.equal(a!.sampleCoverage!.hash, b!.sampleCoverage!.hash);
  });
});

describe('managed evidence — gitCommit 还原坐标(#234/#236)', () => {
  it('本地 git 源 + 干净工作树 → 记 full SHA 当还原指针', () => {
    const ref = buildEvidenceRef(makeReport({ gitInfo: CLEAN_GIT }), 'review', 'PROGRESS', 'now', LOCAL_GIT_SOURCE);
    assert.equal(ref!.gitCommit, 'abc1234567890def');
  });

  it('远端 git 源 → 不记(还原是重装 pinned source.ref,非 cwd checkout)', () => {
    const ref = buildEvidenceRef(makeReport({ gitInfo: CLEAN_GIT }), 'review', 'PROGRESS', 'now', REMOTE_GIT_SOURCE);
    assert.equal(ref!.gitCommit, undefined);
  });

  it('file 源 → 不记(无 git 坐标可还原)', () => {
    const ref = buildEvidenceRef(makeReport({ gitInfo: CLEAN_GIT }), 'review', 'PROGRESS', 'now', FILE_SOURCE);
    assert.equal(ref!.gitCommit, undefined);
  });

  it('工作树 dirty → 不记(被测字节含未提交改动,无确切 checkout 目标;evolve 写回未提交即属此类)', () => {
    const ref = buildEvidenceRef(makeReport({ gitInfo: { ...CLEAN_GIT, dirty: true } }), 'review', 'PROGRESS', 'now', LOCAL_GIT_SOURCE);
    assert.equal(ref!.gitCommit, undefined);
  });

  it('报告无 gitInfo / 未传 source → 不记(旧报告 / 直接测 report 的调用照旧)', () => {
    assert.equal(buildEvidenceRef(makeReport({ gitInfo: null }), 'review', 'PROGRESS', 'now', LOCAL_GIT_SOURCE)!.gitCommit, undefined);
    assert.equal(buildEvidenceRef(makeReport({ gitInfo: CLEAN_GIT }), 'review', 'PROGRESS', 'now')!.gitCommit, undefined);
  });

  it('commit 非 SHA 形态 → 不记(写时即校验,不写一个重载会被自己剥掉的非规整值)', () => {
    const ref = buildEvidenceRef(makeReport({ gitInfo: { ...CLEAN_GIT, commit: 'not-a-sha' } }), 'review', 'PROGRESS', 'now', LOCAL_GIT_SOURCE);
    assert.equal(ref!.gitCommit, undefined);
  });
});

describe('managed evidence — appendManagedEvidence', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omk-ev-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedRecord(contentHash = 'aaaaaaaaaaaa') {
    const rec = buildManagedArtifactRecord({
      name: 'review',
      kind: 'skill',
      source: { sourceKind: 'file', locator: '/abs/review', isDirectorySkill: true },
      contentHash,
      installedAt: '2026-06-06T00:00:00.000Z',
      distribution: [{ label: 'Claude Code', path: '/x/review', contentHash, copiedAt: '2026-06-06T00:00:00.000Z' }],
    });
    upsertManagedRecord(dir, rec);
    return rec;
  }

  it('记录不存在 → 返回 null(eval 绝不为未纳管 skill 凭空建记录)', () => {
    const out = appendManagedEvidence(dir, managedRecordId('skill', 'ghost'), {
      reportId: 'r1', contentHash: 'aaaaaaaaaaaa', recordedAt: 'now',
    });
    assert.equal(out, null);
  });

  it('append-only:写一条进 evidence[]', () => {
    const rec = seedRecord();
    const out = appendManagedEvidence(dir, rec.id, { reportId: 'r1', contentHash: 'aaaaaaaaaaaa', recordedAt: 'now' });
    assert.equal(out!.evidence.length, 1);
    assert.equal(loadManagedRecord(dir, rec.id)!.evidence.length, 1, '落盘可读回');
  });

  it('按 (reportId, contentHash) 去重:同一份 eval 重跑不堆重复', () => {
    const rec = seedRecord();
    appendManagedEvidence(dir, rec.id, { reportId: 'r1', contentHash: 'aaaaaaaaaaaa', recordedAt: 'now' });
    appendManagedEvidence(dir, rec.id, { reportId: 'r1', contentHash: 'aaaaaaaaaaaa', recordedAt: 'later' });
    assert.equal(loadManagedRecord(dir, rec.id)!.evidence.length, 1);
  });
});

describe('managed evidence — recordEvalEvidence(install→eval→measurable 闭环)', () => {
  let projectDir: string;
  let skillDir: string;
  let managed: string;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'omk-proj-'));
    managed = join(projectDir, '.omk', 'managed');
    skillDir = join(projectDir, 'review');
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# review\n');
    writeFileSync(join(skillDir, 'references', 'rules.md'), 'rule v1\n');
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function install(contentHash: string) {
    const rec = buildManagedArtifactRecord({
      name: 'review',
      kind: 'skill',
      source: { sourceKind: 'file', locator: skillDir, isDirectorySkill: true },
      contentHash,
      installedAt: '2026-06-06T00:00:00.000Z',
      distribution: [{ label: 'Claude Code', path: '/x/review', contentHash, copiedAt: '2026-06-06T00:00:00.000Z' }],
    });
    return upsertManagedRecord(managed, rec);
  }

  it('真实指纹相等 → evidence 绑定 → deriveManagedState = measurable', () => {
    // install 与 eval 同取真实整树哈(同一口径)—— 这正是 #214 指纹统一要保证的。
    const realHash = hashArtifactSource(skillDir, true);
    install(realHash);
    const report = makeReport({ variants: ['baseline', 'review'], artifactHashes: { baseline: 'no-skill', review: realHash } });

    const written = recordEvalEvidence(report, 'PROGRESS', '2026-06-08T00:00:00.000Z', { dir: managed });
    assert.equal(written.length, 1, '匹配到一条受管记录');
    assert.equal(written[0].name, 'review');
    assert.equal(written[0].bound, true, '指纹同空间 → 绑定当前版本');

    const rec = loadManagedRecord(managed, managedRecordId('skill', 'review'))!;
    assert.equal(rec.evidence.length, 1);
    assert.equal(rec.evidence[0].contentHash, realHash);
    const state = deriveManagedState({ record: rec, currentContentHash: realHash });
    assert.equal(state.label, 'measurable', '端到端命中 measurable(#214 验收第 3 条)');
    assert.equal(state.hasEvidence, true);
  });

  it('eval 测的是旧内容(hash 不等)→ 证据留存但 unbound,不冒充 measurable', () => {
    const installedHash = hashArtifactSource(skillDir, true);
    install(installedHash);
    const report = makeReport({ variants: ['baseline', 'review'], artifactHashes: { baseline: 'no-skill', review: 'staleoldhash0' } });

    const written = recordEvalEvidence(report, 'PROGRESS', 'now', { dir: managed });
    assert.equal(written[0].bound, false, '指纹不等 → 不绑当前版本');
    const rec = loadManagedRecord(managed, managedRecordId('skill', 'review'))!;
    assert.equal(rec.evidence.length, 1, '证据仍留存(供回滚 / 版本史)');
    const state = deriveManagedState({ record: rec, currentContentHash: installedHash });
    assert.equal(state.label, 'installed', '旧内容证据不让当前版本显得已测');
  });

  it('本地 git:受管记录名 review、报告 variant 键是整串 git:HEAD:skills/review,哈相等 → 按 contentHash 绑定', () => {
    const realHash = hashArtifactSource(skillDir, true);
    install(realHash);
    // install 受管记录名是短名 review,eval 报告里 variant 键保留整串表达式 —— 名字对不上,但指纹同空间。
    const report = makeReport({
      variants: ['baseline', 'git:HEAD:skills/review'],
      artifactHashes: { baseline: 'no-skill', 'git:HEAD:skills/review': realHash },
    });
    const written = recordEvalEvidence(report, 'PROGRESS', 'now', { dir: managed });
    assert.equal(written.length, 1, '按 contentHash 连接,不靠 variant 名');
    assert.equal(written[0].name, 'review', 'CLI 提示用受管记录名而非 git 表达式');
    assert.equal(written[0].bound, true);
    const rec = loadManagedRecord(managed, managedRecordId('skill', 'review'))!;
    assert.equal(deriveManagedState({ record: rec, currentContentHash: realHash }).label, 'measurable');
  });

  it('远端 git:eval.yaml 自定义别名 candidate,install 记录名 review,哈相等 → 绑定', () => {
    const realHash = hashArtifactSource(skillDir, true);
    install(realHash);
    const report = makeReport({
      variants: ['baseline', 'candidate'],
      artifactHashes: { baseline: 'no-skill', candidate: realHash },
    });
    const written = recordEvalEvidence(report, 'PROGRESS', 'now', { dir: managed });
    assert.equal(written.length, 1, '别名与记录名不同也能按指纹绑定');
    assert.equal(written[0].bound, true);
  });

  it('blind 模式:variants 被盲化为 A/B 但 artifactHashes 保留真实键,仍按哈绑定', () => {
    const realHash = hashArtifactSource(skillDir, true);
    install(realHash);
    // applyBlindMode 盲化 variants 列表,但不动 artifactHashes 的键面与哈值。
    const report = makeReport({
      variants: ['A', 'B'],
      artifactHashes: { baseline: 'no-skill', review: realHash },
    });
    const written = recordEvalEvidence(report, 'PROGRESS', 'now', { dir: managed });
    assert.equal(written.length, 1, '盲化不影响 contentHash 连接');
    assert.equal(written[0].bound, true);
  });

  it('两条记录同 contentHash、report 只测其中一个 → 只有被测的那条得到 evidence(纯 hash 唯一性闸门)', () => {
    const realHash = hashArtifactSource(skillDir, true);
    install(realHash); // review,hash = realHash
    // lint 与 review 当前内容完全相同(同模板复制 / 刚装)→ 同 contentHash。
    const lint = buildManagedArtifactRecord({
      name: 'lint',
      kind: 'skill',
      source: { sourceKind: 'file', locator: join(projectDir, 'lint'), isDirectorySkill: true },
      contentHash: realHash,
      installedAt: '2026-06-06T00:00:00.000Z',
      distribution: [{ label: 'Claude Code', path: '/x/lint', contentHash: realHash, copiedAt: '2026-06-06T00:00:00.000Z' }],
    });
    upsertManagedRecord(managed, lint);
    // report 只测 review。
    const report = makeReport({ variants: ['baseline', 'review'], artifactHashes: { baseline: 'no-skill', review: realHash } });

    const written = recordEvalEvidence(report, 'PROGRESS', 'now', { dir: managed });
    assert.deepEqual(written.map((w) => w.name).sort(), ['review'], '只有被测的 review 写入');
    const lintRec = loadManagedRecord(managed, managedRecordId('skill', 'lint'))!;
    assert.equal(lintRec.evidence.length, 0, '没测的 lint 不被写入');
    assert.equal(deriveManagedState({ record: lintRec, currentContentHash: realHash }).label, 'installed', 'lint 不该被同哈推成 measurable');
  });

  it('撞哈但 variantConfigs 结构化源身份可消歧 → 只绑对的那条', () => {
    const realHash = hashArtifactSource(skillDir, true);
    // review / lint 同内容(同哈),但各自 git 身份不同。
    for (const [name, locator] of [['review', 'git+https://x/r.git@sha1:review'], ['lint', 'git+https://x/r.git@sha1:lint']] as const) {
      upsertManagedRecord(managed, buildManagedArtifactRecord({
        name,
        kind: 'skill',
        source: { sourceKind: 'git', locator, ref: 'sha1', url: 'https://x/r.git', isDirectorySkill: true },
        contentHash: realHash,
        installedAt: '2026-06-06T00:00:00.000Z',
        distribution: [{ label: 'Claude Code', path: `/x/${name}`, contentHash: realHash, copiedAt: '2026-06-06T00:00:00.000Z' }],
      }));
    }
    // eval 用别名 candidate 测的是 review 那个 git 身份。
    const report = makeReport({ variants: ['baseline', 'candidate'], artifactHashes: { baseline: 'no-skill', candidate: realHash } });
    report.meta.variantConfigs = [
      { variant: 'candidate', artifactKind: 'skill', artifactSource: 'git', executionStrategy: 'skill-injection', experimentType: 'ab', experimentRole: 'treatment', hasArtifactContent: true, cwd: null, locator: 'git+https://x/r.git@sha1:review', ref: 'sha1' },
    ] as unknown as EvaluationReport['meta']['variantConfigs'];

    const written = recordEvalEvidence(report, 'PROGRESS', 'now', { dir: managed });
    assert.deepEqual(written.map((w) => w.name).sort(), ['review'], '结构化身份只绑 review,不波及同哈的 lint');
    assert.equal(written.find((w) => w.name === 'review')!.bound, true);
  });

  it('本地 git 撞哈:install locator git:<ref>:<spec> 与 eval cfg.locator=<spec>+cfg.ref 口径不同也能归一化绑定', () => {
    const realHash = hashArtifactSource(skillDir, true);
    // 两条本地 git 记录、同内容(同哈)、各自完整身份串口径 git:<ref>:<spec>。
    for (const spec of ['skills/review', 'skills/lint']) {
      const name = spec.split('/')[1];
      upsertManagedRecord(managed, buildManagedArtifactRecord({
        name,
        kind: 'skill',
        source: { sourceKind: 'git', locator: `git:HEAD:${spec}`, ref: 'HEAD', isDirectorySkill: true },
        contentHash: realHash,
        installedAt: '2026-06-06T00:00:00.000Z',
        distribution: [{ label: 'Claude Code', path: `/x/${name}`, contentHash: realHash, copiedAt: '2026-06-06T00:00:00.000Z' }],
      }));
    }
    // eval 报告:variant 键是整串表达式,但 variantConfig 落 eval 实际口径 —— locator=repo 内 spec、ref 另存。
    const report = makeReport({ variants: ['baseline', 'git:HEAD:skills/review'], artifactHashes: { baseline: 'no-skill', 'git:HEAD:skills/review': realHash } });
    report.meta.variantConfigs = [
      { variant: 'git:HEAD:skills/review', artifactKind: 'skill', artifactSource: 'git', executionStrategy: 'skill-injection', experimentType: 'ab', experimentRole: 'treatment', hasArtifactContent: true, cwd: null, locator: 'skills/review', ref: 'HEAD' },
    ] as unknown as EvaluationReport['meta']['variantConfigs'];

    const written = recordEvalEvidence(report, 'PROGRESS', 'now', { dir: managed });
    assert.deepEqual(written.map((w) => w.name).sort(), ['review'], '归一化后只绑被测的 review,撞哈的 lint 不写');
    assert.equal(written.find((w) => w.name === 'review')!.bound, true);
    assert.equal(loadManagedRecord(managed, managedRecordId('skill', 'lint'))!.evidence.length, 0);
  });

  it('无任何受管记录 → 静默 no-op(非管理用户零副作用)', () => {
    const report = makeReport({ artifactHashes: { baseline: 'no-skill', review: 'aaaaaaaaaaaa' } });
    const written = recordEvalEvidence(report, 'PROGRESS', 'now', { dir: managed });
    assert.deepEqual(written, []);
  });
});
