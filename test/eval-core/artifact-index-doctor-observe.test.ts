/**
 * 产物发现索引 doctor / observe-health 两域写侧验收:项目写落卡片(剥重体)、全局写跳过、卡片投影、删除幂等。
 * 全程把 OMK_ARTIFACT_INDEX_DIR 指到 per-test temp,不碰真实 ~/.oh-my-knowledge/state。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  indexDoctorWrite, listDoctorCards, cardToDoctorSnapshot, removeDoctorCard,
  indexObserveWrite, listObserveCards, removeObserveCard, artifactIndexDir,
} from '../../src/eval-core/artifact-index.js';
import { globalDoctorsDir, globalObserveHealthDir } from '../../src/eval-core/measurement-dirs.js';

describe('artifact-index 写侧(doctor 域)', () => {
  let indexRoot: string;
  let projDir: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.OMK_ARTIFACT_INDEX_DIR;
    indexRoot = mkdtempSync(join(tmpdir(), 'omk-ai-didx-'));
    projDir = mkdtempSync(join(tmpdir(), 'omk-ai-dproj-'));
    process.env.OMK_ARTIFACT_INDEX_DIR = indexRoot;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.OMK_ARTIFACT_INDEX_DIR;
    else process.env.OMK_ARTIFACT_INDEX_DIR = origEnv;
    rmSync(indexRoot, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  function doctorCard(id = 'sk-doctor-20260614-1-ab12', skillName = 'sk') {
    return { id, path: join(projDir, `${id}.json`), skillName, reportId: 'doctor-20260614-1-ab12',
      timestamp: '2026-06-14T00:00:00Z', status: 'pass' as const, passCount: 3, warnCount: 0, failCount: 0 };
  }

  it('项目写 → 落卡片(带 skillName/reportId/计数,无 results)', () => {
    indexDoctorWrite(doctorCard(), projDir);
    const cards = listDoctorCards();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].skillName, 'sk');
    assert.equal(cards[0].reportId, 'doctor-20260614-1-ab12');
    assert.equal(cards[0].passCount, 3);
    assert.ok(!('results' in cards[0]), '卡片不含逐规则 results 重体');
  });

  it('全局写 → 不落卡片(shouldIndexDir false)', () => {
    indexDoctorWrite(doctorCard(), globalDoctorsDir());
    assert.equal(listDoctorCards().length, 0);
  });

  it('cardToDoctorSnapshot:卡片 → SkillDoctorSnapshot(results:[])', () => {
    indexDoctorWrite(doctorCard(), projDir);
    const { skillName, snap } = cardToDoctorSnapshot(listDoctorCards()[0]);
    assert.equal(skillName, 'sk');
    assert.equal(snap.reportId, 'doctor-20260614-1-ab12');
    assert.equal(snap.passCount, 3);
    assert.deepEqual(snap.results, []);
  });

  it('removeDoctorCard 幂等', () => {
    indexDoctorWrite(doctorCard('sk-r3'), projDir);
    assert.equal(removeDoctorCard('sk-r3'), true);
    assert.equal(listDoctorCards().length, 0);
    assert.equal(removeDoctorCard('sk-r3'), false, '再删返回 false');
  });

  it('坏 domain 卡片读侧跳过', () => {
    const dir = artifactIndexDir('doctor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ domain: 'report', id: 'bad' }));
    indexDoctorWrite(doctorCard('sk-good'), projDir);
    assert.deepEqual(listDoctorCards().map((c) => c.id), ['sk-good']);
  });
});

describe('artifact-index 写侧(observe-health 域)', () => {
  let indexRoot: string;
  let projDir: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.OMK_ARTIFACT_INDEX_DIR;
    indexRoot = mkdtempSync(join(tmpdir(), 'omk-ai-oidx-'));
    projDir = mkdtempSync(join(tmpdir(), 'omk-ai-oproj-'));
    process.env.OMK_ARTIFACT_INDEX_DIR = indexRoot;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.OMK_ARTIFACT_INDEX_DIR;
    else process.env.OMK_ARTIFACT_INDEX_DIR = origEnv;
    rmSync(indexRoot, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  // 结构子集 + 故意塞一个重体 signals 数组,验证卡片把它剥掉。
  function observeReport() {
    return {
      meta: { generatedAt: '2026-06-14T00:00:00Z', sessionCount: 5, segmentCount: 40 },
      overall: { healthBand: 'green' as const, confidence: 'high' as const },
      bySkill: {
        sk: { toolFailureRate: 0.1, segmentCount: 40, confidence: 'high' as const,
          gap: { weightedGapRate: 0.2, signals: new Array(100).fill({ heavy: true }) } },
      },
    };
  }

  it('项目写 → 落卡片(meta+overall+per-skill 标量,剥掉 gap.signals 重体)', () => {
    indexObserveWrite(observeReport(), join(projDir, 'a-observe-health.json'), projDir, 'a-observe-health');
    const cards = listObserveCards();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].overall.healthBand, 'green');
    assert.equal(cards[0].bySkill.sk.toolFailureRate, 0.1);
    assert.equal(cards[0].bySkill.sk.gap?.weightedGapRate, 0.2);
    assert.ok(!('signals' in (cards[0].bySkill.sk.gap ?? {})), '卡片剥掉 gap.signals 重体');
  });

  it('全局写 → 不落卡片', () => {
    indexObserveWrite(observeReport(), join(globalObserveHealthDir(), 'g.json'), globalObserveHealthDir(), 'g');
    assert.equal(listObserveCards().length, 0);
  });

  it('removeObserveCard 幂等', () => {
    indexObserveWrite(observeReport(), join(projDir, 'x-observe-health.json'), projDir, 'x-observe-health');
    assert.equal(removeObserveCard('x-observe-health'), true);
    assert.equal(listObserveCards().length, 0);
    assert.equal(removeObserveCard('x-observe-health'), false);
  });
});
