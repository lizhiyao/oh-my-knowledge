/**
 * 机器级总览验收(doctor / observe-health 域):buildSkillIndex 把别项目的 doctor/observe 卡片合并进 skill 索引;
 * doctor 历史 prune 删正文时连带删卡片,杜绝「被 prune 的报告经卡片复活」。全程隔离 OMK_ARTIFACT_INDEX_DIR。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSkillIndex, _resetSkillIndexCache } from '../../src/server/skill-index.js';
import { indexDoctorWrite, indexObserveWrite, listDoctorCards } from '../../src/eval-core/artifact-index.js';
import { pruneDoctorHistory } from '../../src/cli/commands/doctor.js';
import type { DoctorReport } from '../../src/types/index.js';

describe('机器级 doctor/observe 卡片合并进 buildSkillIndex', () => {
  let indexRoot: string; let proj: string; let emptyAnalyses: string; let emptyDoctors: string; let emptyObs: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.OMK_ARTIFACT_INDEX_DIR;
    indexRoot = mkdtempSync(join(tmpdir(), 'omk-xp-idx-'));
    process.env.OMK_ARTIFACT_INDEX_DIR = indexRoot;
    proj = mkdtempSync(join(tmpdir(), 'omk-xp-proj-'));
    emptyAnalyses = mkdtempSync(join(tmpdir(), 'omk-xp-an-'));
    emptyDoctors = mkdtempSync(join(tmpdir(), 'omk-xp-dr-'));
    emptyObs = mkdtempSync(join(tmpdir(), 'omk-xp-obs-'));
    _resetSkillIndexCache();
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.OMK_ARTIFACT_INDEX_DIR;
    else process.env.OMK_ARTIFACT_INDEX_DIR = origEnv;
    for (const d of [indexRoot, proj, emptyAnalyses, emptyDoctors, emptyObs]) rmSync(d, { recursive: true, force: true });
    _resetSkillIndexCache();
  });

  it('别项目 doctor 卡片 + observe 卡片 → buildSkillIndex 看到对应 skill', () => {
    indexDoctorWrite({
      id: 'foo-doctor-20260614-1-aa11', path: join(proj, 'foo-doctor-20260614-1-aa11.json'), skillName: 'foo',
      reportId: 'doctor-20260614-1-aa11', timestamp: '2026-06-14T00:00:00Z', status: 'pass', passCount: 2, warnCount: 0, failCount: 0,
    }, proj);
    indexObserveWrite({
      meta: { generatedAt: '2026-06-14T01:00:00Z', sessionCount: 3, segmentCount: 30 },
      overall: { healthBand: 'green', confidence: 'high' },
      bySkill: { bar: { toolFailureRate: 0.0, segmentCount: 30, confidence: 'high', gap: { weightedGapRate: 0.1 } } },
    }, join(proj, 'o-observe-health.json'), proj, 'o-observe-health');

    const idx = buildSkillIndex([], emptyAnalyses, emptyDoctors, emptyObs);
    const names = idx.entries.map((e) => e.skillName).sort();
    assert.ok(names.includes('foo'), 'doctor 卡片的 skill 进索引');
    assert.ok(names.includes('bar'), 'observe 卡片的 skill 进索引');
    const foo = idx.entries.find((e) => e.skillName === 'foo')!;
    assert.equal(foo.doctor?.reportId, 'doctor-20260614-1-aa11');
    const bar = idx.entries.find((e) => e.skillName === 'bar')!;
    assert.equal(bar.observe?.analysisId, 'o-observe-health');
  });

  it('doctor prune 删正文连带删卡片 → 被 prune 的报告不经卡片复活', () => {
    function singleSkillReport(id: string, ts: string): DoctorReport {
      return {
        kind: 'doctor', schemaVersion: '3.0.0', id, timestamp: ts, cliVersion: 't', cwd: '/x',
        executorName: 'claude', model: 'm', outcome: 'passed',
        skills: [{ skillName: 'p', skillPath: '/x/p', status: 'pass', results: [] }],
        totals: { pass: 1, warn: 0, fail: 0 }, ruleStats: { pass: 0, warn: 0, fail: 0, skipped: 0, total: 0 },
      } as DoctorReport;
    }
    // 两份同 skill 的 per-skill 报告(老 t1 / 新 t2)+ 各自卡片(id=文件 stem)。
    for (const [stem, rid, ts] of [['p-r1', 'r1', '2026-06-01T00:00:00Z'], ['p-r2', 'r2', '2026-06-14T00:00:00Z']] as const) {
      writeFileSync(join(emptyDoctors, `${stem}.json`), JSON.stringify(singleSkillReport(rid, ts)));
      indexDoctorWrite({ id: stem, path: join(emptyDoctors, `${stem}.json`), skillName: 'p', reportId: rid, timestamp: ts,
        status: 'pass', passCount: 0, warnCount: 0, failCount: 0 }, emptyDoctors);
    }
    assert.equal(listDoctorCards().length, 2, '两张卡片');

    pruneDoctorHistory(emptyDoctors, 'p', 1); // 只留最新 1 份 → 删 p-r1 正文 + 卡片

    assert.deepEqual(listDoctorCards().map((c) => c.id), ['p-r2'], '老卡片随正文一起删');
    const idx = buildSkillIndex([], emptyAnalyses, emptyDoctors, emptyObs);
    const p = idx.entries.find((e) => e.skillName === 'p')!;
    assert.equal(p.doctorHistory.length, 1, '历史只剩 1 份,被 prune 的没经卡片复活');
    assert.equal(p.doctor?.reportId, 'r2');
  });
});
