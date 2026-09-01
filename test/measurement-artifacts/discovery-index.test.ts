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
  indexDoctorWrite, listDoctorCards, removeDoctorCard,
  indexObserveWrite, listObserveCards, removeObserveCard, artifactIndexDir,
} from '../../src/measurement-artifacts/discovery-index.js';
import { reportFileName } from '../../src/measurement-artifacts/file-names.js';
import { globalDoctorsDir, globalObserveHealthDir } from '../../src/measurement-artifacts/directories.js';

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

  function doctorCard(id = 'sk-20260614-1-ab12', skillName = 'sk') {
    return { id, path: join(projDir, reportFileName(id)), skillName, reportId: 'doctor-20260614-1-ab12',
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

  it('坏 status / 缺计数字段的卡片读侧从严跳过(不让 undefined/NaN 当可信输入)', () => {
    const dir = artifactIndexDir('doctor');
    mkdirSync(dir, { recursive: true });
    // 坏 status
    writeFileSync(join(dir, 'b1.json'), JSON.stringify({ domain: 'doctor', id: 'b1', path: '/x', skillName: 's',
      reportId: 'r', timestamp: 't', status: 'bogus', passCount: 0, warnCount: 0, failCount: 0 }));
    // 缺计数字段
    writeFileSync(join(dir, 'b2.json'), JSON.stringify({ domain: 'doctor', id: 'b2', path: '/x', skillName: 's',
      reportId: 'r', timestamp: 't', status: 'pass' }));
    indexDoctorWrite(doctorCard('sk-ok'), projDir);
    assert.deepEqual(listDoctorCards().map((c) => c.id), ['sk-ok'], '只收字段齐全且枚举合法的卡片');
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
        sk: { toolFailureRate: 0.1111, toolFailureCount: 1, toolCallCount: 10, toolResolvedCount: 9, toolUnknownCount: 1,
          segmentCount: 40, confidence: 'high' as const, stability: 'stable' as const,
          gap: { weightedGapRate: 0.2, signals: new Array(100).fill({ heavy: true }) } },
      },
    };
  }

  it('项目写 → 落卡片(meta+overall+per-skill 标量,剥掉 gap.signals 重体)', () => {
    indexObserveWrite(observeReport(), join(projDir, reportFileName('a')), projDir, 'a');
    const cards = listObserveCards();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].overall.healthBand, 'green');
    assert.equal(cards[0].bySkill.sk.toolFailureRate, 0.1111);
    assert.equal(cards[0].bySkill.sk.toolFailureCount, 1);
    assert.equal(cards[0].bySkill.sk.toolCallCount, 10);
    assert.equal(cards[0].bySkill.sk.toolResolvedCount, 9);
    assert.equal(cards[0].bySkill.sk.toolUnknownCount, 1);
    assert.equal(cards[0].bySkill.sk.stability, 'stable');
    assert.equal(cards[0].bySkill.sk.gap?.weightedGapRate, 0.2);
    assert.ok(!('signals' in (cards[0].bySkill.sk.gap ?? {})), '卡片剥掉 gap.signals 重体');
  });

  it('全局写 → 不落卡片', () => {
    indexObserveWrite(observeReport(), join(globalObserveHealthDir(), reportFileName('g')), globalObserveHealthDir(), 'g');
    assert.equal(listObserveCards().length, 0);
  });

  it('removeObserveCard 幂等', () => {
    indexObserveWrite(observeReport(), join(projDir, reportFileName('x')), projDir, 'x');
    assert.equal(removeObserveCard('x'), true);
    assert.equal(listObserveCards().length, 0);
    assert.equal(removeObserveCard('x'), false);
  });

  it('坏 healthBand / 非数标量的卡片读侧从严跳过', () => {
    const dir = artifactIndexDir('observe-health');
    mkdirSync(dir, { recursive: true });
    // 坏 overall.healthBand
    writeFileSync(join(dir, 'b1.json'), JSON.stringify({ domain: 'observe-health', id: 'b1', path: '/x',
      meta: { generatedAt: 't', sessionCount: 1, segmentCount: 1 }, overall: { healthBand: 'purple' }, bySkill: {} }));
    // 坏 per-skill 标量(toolFailureRate 非数)
    writeFileSync(join(dir, 'b2.json'), JSON.stringify({ domain: 'observe-health', id: 'b2', path: '/x',
      meta: { generatedAt: 't', sessionCount: 1, segmentCount: 1 }, overall: { healthBand: 'green' },
      bySkill: { s: { toolFailureRate: 'nope', segmentCount: 1 } } }));
    // 坏 gap.weightedGapRate(非数 → 会流进 gapRate / 阈值判定)
    writeFileSync(join(dir, 'b3.json'), JSON.stringify({ domain: 'observe-health', id: 'b3', path: '/x',
      meta: { generatedAt: 't', sessionCount: 1, segmentCount: 1 }, overall: { healthBand: 'green' },
      bySkill: { s: { toolFailureRate: 0, segmentCount: 1, gap: { weightedGapRate: 'nan' } } } }));
    // 越界 rate / 负计数 / 结果分母不守恒都会制造伪统计，必须拒绝。
    writeFileSync(join(dir, 'b4.json'), JSON.stringify({ domain: 'observe-health', id: 'b4', path: '/x',
      meta: { generatedAt: 't', sessionCount: 1, segmentCount: 1 }, overall: { healthBand: 'green' },
      bySkill: { s: { toolFailureRate: 1.2, segmentCount: 1 } } }));
    writeFileSync(join(dir, 'b5.json'), JSON.stringify({ domain: 'observe-health', id: 'b5', path: '/x',
      meta: { generatedAt: 't', sessionCount: 1, segmentCount: 1 }, overall: { healthBand: 'green' },
      bySkill: { s: { toolFailureRate: 0, toolCallCount: -1, segmentCount: 1 } } }));
    writeFileSync(join(dir, 'b6.json'), JSON.stringify({ domain: 'observe-health', id: 'b6', path: '/x',
      meta: { generatedAt: 't', sessionCount: 1, segmentCount: 1 }, overall: { healthBand: 'green' },
      bySkill: { s: { toolFailureRate: 0, toolCallCount: 2, toolResolvedCount: 2, toolUnknownCount: 1, segmentCount: 1 } } }));
    writeFileSync(join(dir, 'b7.json'), JSON.stringify({ domain: 'observe-health', id: 'b7', path: '/x',
      meta: { generatedAt: 't', sessionCount: 1, segmentCount: 1 }, overall: { healthBand: 'green' },
      bySkill: { s: { toolFailureRate: 0, toolResolvedCount: 1, segmentCount: 1 } } }));
    writeFileSync(join(dir, 'b8.json'), JSON.stringify({ domain: 'observe-health', id: 'b8', path: '/x',
      meta: { generatedAt: 't', sessionCount: 1, segmentCount: 1 }, overall: { healthBand: 'green' },
      bySkill: { s: { toolFailureRate: 0, toolFailureCount: 1, toolCallCount: 2, toolResolvedCount: 2, segmentCount: 1 } } }));
    writeFileSync(join(dir, 'b9.json'), JSON.stringify({ domain: 'observe-health', id: 'b9', path: '/x',
      meta: { generatedAt: 't', sessionCount: 1, segmentCount: 2 }, overall: { healthBand: 'green' },
      bySkill: { s: { toolFailureRate: 0, segmentCount: 1 } } }));
    indexObserveWrite(observeReport(), join(projDir, reportFileName('ok')), projDir, 'ok');
    assert.deepEqual(listObserveCards().map((c) => c.id), ['ok'], '只收枚举、计数、比率和结果分母均合法的卡片');
  });
});
