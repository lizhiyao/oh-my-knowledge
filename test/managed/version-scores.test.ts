/**
 * buildVersionScores 单测:逐版证据 + 报告 composite/CI 拼成版本曲线点。覆盖读不到 / 匹配不到变体 / 无
 * composite 的跳过、按 contentHash 去重(留 recordedAt 最新)、可比性标记(与当前内容那版的评委+样本签名一致才可比)。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildVersionScores, type ReportScoreView } from '../../src/managed/version-scores.js';
import type { ManagedArtifactRecord, ManagedEvidenceRef } from '../../src/types/index.js';

function ev(over: Partial<ManagedEvidenceRef> & Pick<ManagedEvidenceRef, 'reportId' | 'contentHash' | 'recordedAt'>): ManagedEvidenceRef {
  return { verdict: 'PROGRESS', comparability: { cliVersion: '0.39.0', judgePromptHash: 'JUDGE_A' }, sampleCoverage: { count: 6, hash: 'S1' }, ...over };
}

function rec(evidence: ManagedEvidenceRef[], contentHash = 'hV2'): ManagedArtifactRecord {
  return {
    recordKind: 'managed-artifact', schemaVersion: 2, id: 'id', name: 'review', kind: 'skill',
    source: { sourceKind: 'git', locator: 'git:HEAD:review', ref: 'HEAD', isDirectorySkill: true },
    contentHash, installedAt: '2026-06-01T00:00:00.000Z', distribution: [], evidence, decisions: [],
  };
}

// 报告:variant 'cand' 的 artifactHash = 该版 contentHash,summary 带 avgCompositeScore + bootstrapCI。
function report(contentHash: string, composite: number, ci: [number, number]): ReportScoreView {
  return { meta: { artifactHashes: { cand: contentHash } }, summary: { cand: { avgCompositeScore: composite, bootstrapCI: { low: ci[0], high: ci[1] } } } };
}

describe('buildVersionScores', () => {
  it('多版 → 按时间从旧到新的点,带 composite + CI', () => {
    const r = rec([
      ev({ reportId: 'r0', contentHash: 'hV0', recordedAt: '2026-06-02T00:00:00.000Z', verdict: 'NOISE' }),
      ev({ reportId: 'r2', contentHash: 'hV2', recordedAt: '2026-06-04T00:00:00.000Z', verdict: 'PROGRESS' }),
      ev({ reportId: 'r1', contentHash: 'hV1', recordedAt: '2026-06-03T00:00:00.000Z', verdict: 'CAUTIOUS' }),
    ], 'hV2');
    const reports = new Map<string, ReportScoreView | null>([
      ['r0', report('hV0', 3.1, [2.8, 3.4])],
      ['r1', report('hV1', 3.6, [3.3, 3.9])],
      ['r2', report('hV2', 4.0, [3.7, 4.3])],
    ]);
    const pts = buildVersionScores(r, reports);
    assert.deepEqual(pts.map((p) => p.contentHash), ['hV0', 'hV1', 'hV2']);
    assert.deepEqual(pts.map((p) => p.composite), [3.1, 3.6, 4.0]);
    assert.deepEqual(pts[2], { contentHash: 'hV2', recordedAt: '2026-06-04T00:00:00.000Z', composite: 4.0, ciLow: 3.7, ciHigh: 4.3, verdict: 'PROGRESS', comparable: true });
    assert.ok(pts.every((p) => p.comparable), '同评委同样本 → 全可比');
  });

  it('报告读不到 / 匹配不到变体 / 无 composite → 跳过该点', () => {
    const r = rec([
      ev({ reportId: 'gone', contentHash: 'hV0', recordedAt: '2026-06-02T00:00:00.000Z' }),    // 报告 null
      ev({ reportId: 'nomatch', contentHash: 'hV1', recordedAt: '2026-06-03T00:00:00.000Z' }), // hash 对不上变体
      ev({ reportId: 'nocomp', contentHash: 'hV2', recordedAt: '2026-06-04T00:00:00.000Z' }),  // 无 composite
      ev({ reportId: 'ok', contentHash: 'hV3', recordedAt: '2026-06-05T00:00:00.000Z' }),
    ], 'hV3');
    const reports = new Map<string, ReportScoreView | null>([
      ['gone', null],
      ['nomatch', report('OTHER', 3.0, [2.5, 3.5])],
      ['nocomp', { meta: { artifactHashes: { cand: 'hV2' } }, summary: { cand: {} } }],
      ['ok', report('hV3', 4.2, [4.0, 4.4])],
    ]);
    const pts = buildVersionScores(r, reports);
    assert.deepEqual(pts.map((p) => p.contentHash), ['hV3']);
  });

  it('一版多条证据 → 留 recordedAt 最新那条', () => {
    const r = rec([
      ev({ reportId: 'old', contentHash: 'hV0', recordedAt: '2026-06-02T00:00:00.000Z' }),
      ev({ reportId: 'new', contentHash: 'hV0', recordedAt: '2026-06-06T00:00:00.000Z' }),
    ], 'hV0');
    const reports = new Map<string, ReportScoreView | null>([
      ['old', report('hV0', 3.0, [2.7, 3.3])],
      ['new', report('hV0', 3.9, [3.6, 4.2])],
    ]);
    const pts = buildVersionScores(r, reports);
    assert.equal(pts.length, 1);
    assert.equal(pts[0].composite, 3.9);
    assert.equal(pts[0].recordedAt, '2026-06-06T00:00:00.000Z');
  });

  it('换过评委 / 改过样本集 → 与当前版不可比(comparable=false)', () => {
    const r = rec([
      ev({ reportId: 'r0', contentHash: 'hV0', recordedAt: '2026-06-02T00:00:00.000Z', comparability: { cliVersion: '0.38.0', judgePromptHash: 'JUDGE_OLD' } }),
      ev({ reportId: 'r1', contentHash: 'hV1', recordedAt: '2026-06-03T00:00:00.000Z', sampleCoverage: { count: 8, hash: 'S2' } }),
      ev({ reportId: 'r2', contentHash: 'hV2', recordedAt: '2026-06-04T00:00:00.000Z' }),
    ], 'hV2');
    const reports = new Map<string, ReportScoreView | null>([
      ['r0', report('hV0', 3.1, [2.8, 3.4])],
      ['r1', report('hV1', 3.6, [3.3, 3.9])],
      ['r2', report('hV2', 4.0, [3.7, 4.3])],
    ]);
    const byHash = Object.fromEntries(buildVersionScores(r, reports).map((p) => [p.contentHash, p.comparable]));
    assert.equal(byHash['hV0'], false, '换过评委 → 不可比');
    assert.equal(byHash['hV1'], false, '改过样本集 → 不可比');
    assert.equal(byHash['hV2'], true, '当前版 = 基线 → 可比');
  });

  it('基线 / 历史证据都缺评委或样本指纹 → unknown 不隐式判为可比(全不可比)', () => {
    // 早于 evidence bundle 完整落盘的旧记录:既无 judgePromptHash 也无 sampleCoverage → 无从核对同口径。
    // spec §6.1 unknown 既不放行也不拦截 → 曲线必须标 comparable=false(空心点 / 虚线),不糊成可直接读的趋势。
    const r = rec([
      ev({ reportId: 'r0', contentHash: 'hV0', recordedAt: '2026-06-02T00:00:00.000Z', comparability: { cliVersion: '0.30.0' }, sampleCoverage: undefined }),
      ev({ reportId: 'r1', contentHash: 'hV1', recordedAt: '2026-06-03T00:00:00.000Z', comparability: { cliVersion: '0.30.0' }, sampleCoverage: undefined }),
    ], 'hV1');
    const reports = new Map<string, ReportScoreView | null>([
      ['r0', report('hV0', 3.1, [2.8, 3.4])],
      ['r1', report('hV1', 3.6, [3.3, 3.9])],
    ]);
    const pts = buildVersionScores(r, reports);
    assert.equal(pts.length, 2, '点照常画出,只是不可比');
    assert.ok(pts.every((p) => !p.comparable), '缺指纹 → 全不可比,不能因签名同为空串而判全可比');
  });

  it('只缺样本指纹(评委仍在) → 仍 unknown 不可比', () => {
    const r = rec([
      ev({ reportId: 'r0', contentHash: 'hV0', recordedAt: '2026-06-02T00:00:00.000Z', sampleCoverage: undefined }),
      ev({ reportId: 'r1', contentHash: 'hV1', recordedAt: '2026-06-03T00:00:00.000Z' }),
    ], 'hV1');
    const reports = new Map<string, ReportScoreView | null>([
      ['r0', report('hV0', 3.1, [2.8, 3.4])],
      ['r1', report('hV1', 3.6, [3.3, 3.9])],
    ]);
    const byHash = Object.fromEntries(buildVersionScores(r, reports).map((p) => [p.contentHash, p.comparable]));
    assert.equal(byHash['hV0'], false, '缺样本指纹 → 无从核对 → 不可比');
    assert.equal(byHash['hV1'], true, '基线两指纹齐全 → 与自身可比');
  });

  it('无可画点 → 空数组', () => {
    assert.deepEqual(buildVersionScores(rec([]), new Map()), []);
  });
});
