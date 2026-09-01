/**
 * 机器级总览验收(doctor / observe-health 域):buildSkillIndex 把别项目的 doctor/observe 卡片合并进 skill 索引;
 * doctor 历史 prune 删正文时连带删卡片,杜绝「被 prune 的报告经卡片复活」。全程隔离 OMK_ARTIFACT_INDEX_DIR。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSkillIndex, _resetSkillIndexCache } from '../../../src/studio/application/index.js';
import {
  indexDoctorWrite as writeDoctorIndex,
  indexObserveWrite as writeObserveIndex,
  listDoctorCards,
} from '../../../src/measurement-artifacts/discovery-index.js';
import { reportFileName } from '../../../src/measurement-artifacts/file-names.js';
import { pruneDoctorHistory } from '../../../src/cli/commands/doctor.js';
import type { DoctorReport } from '../../../src/doctor/contracts.js';

type DoctorCardInput = Parameters<typeof writeDoctorIndex>[0];
type ObserveSource = Parameters<typeof writeObserveIndex>[0];

function indexDoctorWrite(card: DoctorCardInput, outputDir: string): void {
  const results = [
    ...Array.from({ length: card.passCount }, (_, index) => ({
      ruleId: `pass-${index}`,
      severity: 'warn' as const,
      labelKey: 'test',
      status: 'pass' as const,
      message: 'ok',
      durationMs: 1,
    })),
    ...Array.from({ length: card.warnCount }, (_, index) => ({
      ruleId: `warn-${index}`,
      severity: 'warn' as const,
      labelKey: 'test',
      status: 'warn' as const,
      message: 'warning',
      durationMs: 1,
    })),
    ...Array.from({ length: card.failCount }, (_, index) => ({
      ruleId: `fail-${index}`,
      severity: card.status === 'fail' ? 'fatal' as const : 'warn' as const,
      labelKey: 'test',
      status: 'fail' as const,
      message: 'failure',
      durationMs: 1,
    })),
  ];
  const report: DoctorReport = {
    kind: 'doctor',
    schemaVersion: '3.0.0',
    id: card.reportId,
    timestamp: card.timestamp,
    cliVersion: 'test',
    cwd: outputDir,
    executorName: 'script',
    model: 'test-model',
    outcome: card.status === 'fail' ? 'failed' : card.status === 'warn' ? 'warnings_only' : 'passed',
    skills: [{
      skillName: card.skillName,
      skillPath: join(outputDir, card.skillName),
      status: card.status,
      results,
    }],
    totals: {
      pass: card.status === 'pass' ? 1 : 0,
      warn: card.status === 'warn' ? 1 : 0,
      fail: card.status === 'fail' ? 1 : 0,
    },
    ruleStats: {
      pass: card.passCount,
      warn: card.warnCount,
      fail: card.failCount,
      skipped: 0,
      total: card.passCount + card.warnCount + card.failCount,
    },
  };
  writeFileSync(card.path, JSON.stringify(report));
  writeDoctorIndex(card, outputDir);
}

function indexObserveWrite(
  source: ObserveSource,
  sourcePath: string,
  outputDir: string,
  id: string,
): void {
  const bySkill = Object.fromEntries(Object.entries(source.bySkill).map(([skillName, health]) => {
    const toolCallCount = health.toolCallCount ?? 0;
    const toolUnknownCount = health.toolUnknownCount ?? 0;
    const toolResolvedCount = health.toolResolvedCount ?? toolCallCount - toolUnknownCount;
    const toolCancelledCount = health.toolCancelledCount ?? 0;
    const comparable = toolResolvedCount - toolCancelledCount;
    const toolFailureCount = health.toolFailureCount
      ?? Math.round(health.toolFailureRate * comparable);
    const weightedGapRate = health.gap?.weightedGapRate ?? 0;
    const softSignalCount = Math.round(weightedGapRate * health.segmentCount / 0.5);
    const signals = Array.from({ length: softSignalCount }, (_, index) => ({
      sampleId: `${skillName}-${index}`,
      type: 'explicit_marker' as const,
      context: 'test',
      weight: 0.5,
    }));
    return [skillName, {
      skillName,
      segmentCount: health.segmentCount,
      toolCallCount,
      toolResolvedCount,
      toolCancelledCount,
      toolUnknownCount,
      toolFailureCount,
      toolFailureRate: comparable > 0
        ? Number((toolFailureCount / comparable).toFixed(4))
        : 0,
      stability: health.stability ?? 'stable',
      confidence: health.confidence ?? 'high',
      gap: {
        variant: skillName,
        sampleCount: health.segmentCount,
        samplesWithGap: signals.length,
        gapRate: health.segmentCount > 0
          ? Number((signals.length / health.segmentCount).toFixed(4))
          : 0,
        weightedGapRate: health.segmentCount > 0
          ? Number((signals.length * 0.5 / health.segmentCount).toFixed(4))
          : 0,
        signals,
        byType: {
          failed_search: 0,
          explicit_marker: signals.length,
          hedging: 0,
          repeated_failure: 0,
        },
      },
    }];
  }));
  const skills = Object.values(bySkill);
  const segmentCount = skills.reduce((sum, health) => sum + health.segmentCount, 0);
  const toolCallCount = skills.reduce((sum, health) => sum + health.toolCallCount, 0);
  const toolResolvedCount = skills.reduce((sum, health) => sum + health.toolResolvedCount, 0);
  const toolCancelledCount = skills.reduce((sum, health) => sum + health.toolCancelledCount, 0);
  const toolUnknownCount = skills.reduce((sum, health) => sum + health.toolUnknownCount, 0);
  const toolFailureCount = skills.reduce((sum, health) => sum + health.toolFailureCount, 0);
  const comparable = toolResolvedCount - toolCancelledCount;
  const samplesWithGap = skills.reduce((sum, health) => sum + health.gap.samplesWithGap, 0);
  const weightedGapTotal = skills.reduce(
    (sum, health) => sum + health.gap.weightedGapRate * health.segmentCount,
    0,
  );
  const report = {
    kind: 'observe-health' as const,
    meta: {
      tracePath: '/test/trace.jsonl',
      kbPath: null,
      sessionCount: source.meta.sessionCount,
      segmentCount,
      messageCount: segmentCount,
      timestampedSegmentCount: segmentCount,
      timestampCoverage: segmentCount > 0 ? 1 : 1,
      excludedUntimestampedSegmentCount: 0,
      toolCallCount,
      toolResolvedCount,
      toolCancelledCount,
      toolUnknownCount,
      toolOutcomeCoverage: toolCallCount > 0
        ? Number((toolResolvedCount / toolCallCount).toFixed(4))
        : 1,
      toolFailureRate: comparable > 0
        ? Number((toolFailureCount / comparable).toFixed(4))
        : 0,
      timeRange: {
        from: segmentCount > 0 ? source.meta.generatedAt : '',
        to: segmentCount > 0 ? source.meta.generatedAt : '',
      },
      generatedAt: source.meta.generatedAt,
    },
    bySkill,
    overall: {
      gapRate: segmentCount > 0
        ? Number((samplesWithGap / segmentCount).toFixed(4))
        : 0,
      weightedGapRate: segmentCount > 0
        ? Number((weightedGapTotal / segmentCount).toFixed(4))
        : 0,
      healthBand: source.overall.healthBand,
      confidence: source.overall.confidence ?? 'high',
    },
  };
  writeFileSync(sourcePath, JSON.stringify(report));
  writeObserveIndex(report, sourcePath, outputDir, id);
}

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
    // 卡片真身(悬空过滤要求 card.path 存在;buildSkillIndex 合并只读卡片本身,真身内容随意)。
    writeFileSync(join(proj, reportFileName('foo-20260614-1-aa11')), '{}');
    writeFileSync(join(proj, reportFileName('o-20260614-aa11')), '{}');
    indexDoctorWrite({
      id: 'foo-20260614-1-aa11', path: join(proj, reportFileName('foo-20260614-1-aa11')), skillName: 'foo',
      reportId: 'doctor-20260614-1-aa11', timestamp: '2026-06-14T00:00:00Z', status: 'pass', passCount: 2, warnCount: 0, failCount: 0,
    }, proj);
    indexObserveWrite({
      meta: { generatedAt: '2026-06-14T01:00:00Z', sessionCount: 3, segmentCount: 30 },
      overall: { healthBand: 'green', confidence: 'high' },
      bySkill: { bar: { toolFailureRate: 0.0, segmentCount: 30, confidence: 'high', gap: { weightedGapRate: 0.1 } } },
    }, join(proj, reportFileName('o-20260614-aa11')), proj, 'o-20260614-aa11');

    const idx = buildSkillIndex(emptyAnalyses, emptyDoctors, emptyObs, { includeObserveCards: true, includeDoctorCards: true });
    const names = idx.entries.map((e) => e.skillName).sort();
    assert.ok(names.includes('foo'), 'doctor 卡片的 skill 进索引');
    assert.ok(names.includes('bar'), 'observe 卡片的 skill 进索引');
    const foo = idx.entries.find((e) => e.skillName === 'foo')!;
    assert.equal(foo.doctor?.reportId, 'doctor-20260614-1-aa11');
    const bar = idx.entries.find((e) => e.skillName === 'bar')!;
    assert.equal(bar.observe?.analysisId, 'o-20260614-aa11');
  });

  it('observe 卡片保留未知工具结果状态，但不把不可测当成健康告警', () => {
    const path = join(proj, reportFileName('o-unknown'));
    writeFileSync(path, '{}');
    indexObserveWrite({
      meta: { generatedAt: '2026-06-14T01:00:00Z', sessionCount: 3, segmentCount: 30 },
      overall: { healthBand: 'yellow', confidence: 'high' },
      bySkill: {
        uncertain: {
          toolFailureRate: 0,
          toolCallCount: 5,
          toolResolvedCount: 0,
          toolUnknownCount: 5,
          segmentCount: 30,
          confidence: 'high',
          stability: 'unknown',
          gap: { weightedGapRate: 0 },
        },
      },
    }, path, proj, 'o-unknown');

    const idx = buildSkillIndex(emptyAnalyses, emptyDoctors, emptyObs, {
      includeObserveCards: true,
      includeDoctorCards: false,
    });
    const uncertain = idx.entries.find((entry) => entry.skillName === 'uncertain')!;
    assert.equal(uncertain.observe?.stability, 'unknown');
    assert.equal(uncertain.observe?.toolCallCount, 5);
    assert.equal(uncertain.observe?.toolResolvedCount, 0);
    assert.equal(uncertain.observe?.toolUnknownCount, 5);
    assert.equal(uncertain.observe?.healthBand, 'green');
    assert.equal(uncertain.band, 'gray', '工具结果全未知时不能把不可测误判成健康或告警');
    assert.equal(idx.summary.yellow, 0);
    assert.equal(idx.summary.gray, 1);
  });

  it('可判定工具结果不足时把 observe 总览保留为未充分测量', () => {
    const path = join(proj, reportFileName('o-partial-outcomes'));
    writeFileSync(path, '{}');
    indexObserveWrite({
      meta: { generatedAt: '2026-06-14T01:00:00Z', sessionCount: 3, segmentCount: 30 },
      overall: { healthBand: 'green', confidence: 'high' },
      bySkill: {
        partial: {
          toolFailureRate: 0,
          toolCallCount: 5,
          toolResolvedCount: 4,
          toolUnknownCount: 1,
          segmentCount: 30,
          confidence: 'high',
          stability: 'stable',
          gap: { weightedGapRate: 0 },
        },
      },
    }, path, proj, 'o-partial-outcomes');

    const idx = buildSkillIndex(emptyAnalyses, emptyDoctors, emptyObs, {
      includeObserveCards: true,
      includeDoctorCards: false,
    });
    const partial = idx.entries.find((entry) => entry.skillName === 'partial')!;
    assert.equal(partial.observe?.healthBand, 'green');
    assert.equal(partial.band, 'gray');
  });

  it('少量可判定结果不足以把高失败率标成红色或黄色', () => {
    const path = join(proj, reportFileName('o-underpowered-failures'));
    writeFileSync(path, '{}');
    indexObserveWrite({
      meta: { generatedAt: '2026-06-14T01:00:00Z', sessionCount: 20, segmentCount: 20 },
      overall: { healthBand: 'yellow', confidence: 'high' },
      bySkill: {
        sparse: {
          toolFailureRate: 1,
          toolCallCount: 100,
          toolResolvedCount: 1,
          toolUnknownCount: 99,
          segmentCount: 20,
          confidence: 'high',
          stability: 'very-unstable',
          gap: { weightedGapRate: 0 },
        },
      },
    }, path, proj, 'o-underpowered-failures');

    const idx = buildSkillIndex(emptyAnalyses, emptyDoctors, emptyObs, {
      includeObserveCards: true,
      includeDoctorCards: false,
    });
    const sparse = idx.entries.find((entry) => entry.skillName === 'sparse')!;
    assert.equal(sparse.observe?.healthBand, 'green');
    assert.equal(sparse.observe?.stability, 'unstable');
    assert.equal(sparse.band, 'gray');
  });

  it('极少未知结果不污染高覆盖率 observe 的健康色带', () => {
    const path = join(proj, reportFileName('o-high-outcome-coverage'));
    writeFileSync(path, '{}');
    indexObserveWrite({
      meta: { generatedAt: '2026-06-14T01:00:00Z', sessionCount: 30, segmentCount: 30 },
      overall: { healthBand: 'green', confidence: 'high' },
      bySkill: {
        covered: {
          toolFailureRate: 0,
          toolCallCount: 1_000,
          toolResolvedCount: 999,
          toolUnknownCount: 1,
          segmentCount: 30,
          confidence: 'high',
          stability: 'stable',
          gap: { weightedGapRate: 0 },
        },
      },
    }, path, proj, 'o-high-outcome-coverage');

    const idx = buildSkillIndex(emptyAnalyses, emptyDoctors, emptyObs, {
      includeObserveCards: true,
      includeDoctorCards: false,
    });
    const covered = idx.entries.find((entry) => entry.skillName === 'covered')!;
    assert.equal(covered.observe?.healthBand, 'green');
    assert.equal(covered.band, 'green');
  });

  it('悬空卡片(真身从未存在)不进 buildSkillIndex:include=true 也不展示', () => {
    // 卡片在、真身不在(项目被移走/手动 rm)→ 机器级合并不应展示。
    writeDoctorIndex({ id: 'gone-1-zz', path: join(proj, reportFileName('gone-1-zz')), skillName: 'gone-skill', reportId: 'doctor-1-zz',
      timestamp: '2026-06-14T00:00:00Z', status: 'pass', passCount: 1, warnCount: 0, failCount: 0 }, proj);
    writeObserveIndex({ meta: { generatedAt: '2026-06-14T01:00:00Z', sessionCount: 1, segmentCount: 10 },
      overall: { healthBand: 'green', confidence: 'high' },
      bySkill: { 'gone-obs': { toolFailureRate: 0, segmentCount: 10, confidence: 'high', gap: { weightedGapRate: 0 } } },
    }, join(proj, reportFileName('gone-observe')), proj, 'gone-observe'); // 真身均不写
    const idx = buildSkillIndex(emptyAnalyses, emptyDoctors, emptyObs, { includeObserveCards: true, includeDoctorCards: true });
    assert.deepEqual(idx.entries.map((e) => e.skillName), [], '悬空卡片(真身不在)不进 skill 索引');
  });

  it('悬空检测穿透 buildSkillIndex 缓存:先 build 可见、仅删真身(卡片目录不变、不 reset 缓存)→ 再 build 应消失', () => {
    writeFileSync(join(proj, reportFileName('fd')), '{}');
    writeFileSync(join(proj, reportFileName('fo')), '{}');
    indexDoctorWrite({ id: 'fd', path: join(proj, reportFileName('fd')), skillName: 'cf', reportId: 'doctor-cf-1',
      timestamp: '2026-06-14T00:00:00Z', status: 'pass', passCount: 1, warnCount: 0, failCount: 0 }, proj);
    indexObserveWrite({ meta: { generatedAt: '2026-06-14T01:00:00Z', sessionCount: 1, segmentCount: 10 },
      overall: { healthBand: 'green', confidence: 'high' },
      bySkill: { co: { toolFailureRate: 0, segmentCount: 10, confidence: 'high', gap: { weightedGapRate: 0 } } },
    }, join(proj, reportFileName('fo')), proj, 'fo');
    const opts = { includeObserveCards: true, includeDoctorCards: true };
    let idx = buildSkillIndex(emptyAnalyses, emptyDoctors, emptyObs, opts);
    assert.deepEqual(idx.entries.map((e) => e.skillName).sort(), ['cf', 'co'], 'build1 可见(进模块缓存)');
    rmSync(join(proj, reportFileName('fd')), { force: true }); // 仅删真身,不动卡片目录、不 _resetSkillIndexCache
    rmSync(join(proj, reportFileName('fo')), { force: true });
    idx = buildSkillIndex(emptyAnalyses, emptyDoctors, emptyObs, opts);
    assert.deepEqual(idx.entries.map((e) => e.skillName), [], '真身没了 → 真身 sentinel 进 fingerprint、缓存失效,悬空不展示');
  });

  it('固定目录模式(include 默认 false):索引里有别项目卡片但 buildSkillIndex 不合并 → skill 索引为空', () => {
    // 模拟 --analyses-dir/--doctors-dir/--global 逃生舱:有卡片(别项目),但 live 目录空且不开 include。
    indexDoctorWrite({ id: 'x-1-aa', path: join(proj, reportFileName('x')), skillName: 'x', reportId: 'doctor-1-aa',
      timestamp: '2026-06-14T00:00:00Z', status: 'pass', passCount: 1, warnCount: 0, failCount: 0 }, proj);
    indexObserveWrite({ meta: { generatedAt: '2026-06-14T01:00:00Z', sessionCount: 1, segmentCount: 10 },
      overall: { healthBand: 'green', confidence: 'high' },
      bySkill: { y: { toolFailureRate: 0, segmentCount: 10, confidence: 'high', gap: { weightedGapRate: 0 } } },
    }, join(proj, reportFileName('y')), proj, 'y');
    // 不传 include 标志(默认 false)→ 固定目录语义,卡片一律不合并。
    const idx = buildSkillIndex(emptyAnalyses, emptyDoctors, emptyObs);
    assert.deepEqual(idx.entries.map((e) => e.skillName), [], '固定目录模式下别项目卡片不进 skill 索引');
  });

  it('同项目 live 正文 + 同 id 卡片 → dedup,live 盖卡片(不双计;机器级总览的 no-double-count 核心不变量)', () => {
    // doctor:live 正文(results 非空)写进 doctorsDir + 同 stem 卡片(本项目 persist 时既写正文又写卡片的稳态)。
    const dStem = 'd-rd';
    const liveDoctor: DoctorReport = {
      kind: 'doctor', schemaVersion: '3.0.0', id: 'rd', timestamp: '2026-06-14T00:00:00Z', cliVersion: 't', cwd: '/x',
      executorName: 'claude', model: 'm', outcome: 'passed',
      skills: [{ skillName: 'd', skillPath: '/x/d', status: 'pass',
        results: [{ ruleId: 'r1', severity: 'warn', labelKey: 'k', status: 'pass', message: 'ok', durationMs: 1 }] }],
      totals: { pass: 1, warn: 0, fail: 0 }, ruleStats: { pass: 1, warn: 0, fail: 0, skipped: 0, total: 1 },
    };
    writeFileSync(join(emptyDoctors, reportFileName(dStem)), JSON.stringify(liveDoctor));
    indexDoctorWrite({ id: dStem, path: join(emptyDoctors, reportFileName(dStem)), skillName: 'd', reportId: 'rd',
      timestamp: '2026-06-14T00:00:00Z', status: 'pass', passCount: 1, warnCount: 0, failCount: 0 }, emptyDoctors);

    // observe:live 正文(bySkill.o 带 signals)写进 analysesDir + 同 id 卡片。
    const oid = 'oid';
    const liveObs = {
      kind: 'observe-health',
      meta: { tracePath: '/t', kbPath: null, sessionCount: 1, segmentCount: 10, messageCount: 5, toolCallCount: 3,
        toolFailureRate: 0, timeRange: { from: 'a', to: 'b' }, generatedAt: '2026-06-14T00:00:00Z' },
      bySkill: { o: { skillName: 'o', segmentCount: 10, toolCallCount: 3, toolFailureCount: 0, toolFailureRate: 0,
        stability: 'stable' as const, confidence: 'high' as const, gap: { gapRate: 0, weightedGapRate: 0, signals: [{ h: 1 }] } } },
      overall: { gapRate: 0, weightedGapRate: 0, healthBand: 'green' as const, confidence: 'high' as const },
    };
    writeFileSync(join(emptyAnalyses, reportFileName(oid)), JSON.stringify(liveObs));
    indexObserveWrite(liveObs, join(emptyAnalyses, reportFileName(oid)), emptyAnalyses, oid);

    const idx = buildSkillIndex(emptyAnalyses, emptyDoctors, emptyObs, { includeObserveCards: true, includeDoctorCards: true });
    const d = idx.entries.find((e) => e.skillName === 'd')!;
    assert.equal(d.doctorHistory.length, 1, 'doctor 同 reportId 的 live+卡片 dedup 为 1 条,不双计');
    assert.ok((d.doctor?.results.length ?? 0) > 0, 'live 盖卡片:取含 results 的 live 那份,非卡片空壳');
    const o = idx.entries.find((e) => e.skillName === 'o')!;
    assert.equal(o.observeHistory.length, 1, 'observe 同 analysisId 的 live+卡片 dedup 为 1 条,不双计');
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
      writeFileSync(join(emptyDoctors, reportFileName(stem)), JSON.stringify(singleSkillReport(rid, ts)));
      indexDoctorWrite({ id: stem, path: join(emptyDoctors, reportFileName(stem)), skillName: 'p', reportId: rid, timestamp: ts,
        status: 'pass', passCount: 0, warnCount: 0, failCount: 0 }, emptyDoctors);
    }
    assert.equal(listDoctorCards().length, 2, '两张卡片');

    pruneDoctorHistory(emptyDoctors, 'p', 1); // 只留最新 1 份 → 删 p-r1 正文 + 卡片

    assert.deepEqual(listDoctorCards().map((c) => c.id), ['p-r2'], '老卡片随正文一起删');
    const idx = buildSkillIndex(emptyAnalyses, emptyDoctors, emptyObs, { includeObserveCards: true, includeDoctorCards: true });
    const p = idx.entries.find((e) => e.skillName === 'p')!;
    assert.equal(p.doctorHistory.length, 1, '历史只剩 1 份,被 prune 的没经卡片复活');
    assert.equal(p.doctor?.reportId, 'r2');
  });
});
