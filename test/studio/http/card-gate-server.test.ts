/**
 * 卡片合并 include 开关的 server 级回归(CR #253 P2):
 * 固定 analyses/doctors 目录(逃生舱,include 默认 false)时,即便索引里有别项目卡片,
 * /api/observe-health 与 /api/skills 都必须为空 —— --global / --analyses-dir / --doctors-dir 只看该目录;
 * 开 include(机器级默认模式)时才合并卡片。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReportServer } from '../../../src/studio/http/report-server.js';
import { indexDoctorWrite, indexObserveWrite } from '../../../src/evidence/storage/discovery-index.js';
import { writeMeasurementReportBundle } from '../../../src/evidence/storage/report-bundle.js';

function reportFileName(id: string): string {
  return join(id, 'report.json');
}

interface Srv { stop(): Promise<void> }

describe('卡片合并 include 开关(server 级)', () => {
  let idxRoot: string; let emptyReports: string; let emptyAnalyses: string; let emptyDoctors: string;
  let emptyObs: string; let emptyJobs: string; let emptyManaged: string; let proj: string;
  let origEnv: string | undefined;
  const dirs: string[] = [];

  beforeEach(() => {
    origEnv = process.env.OMK_ARTIFACT_INDEX_DIR;
    idxRoot = mkdtempSync(join(tmpdir(), 'omk-cg-idx-'));
    process.env.OMK_ARTIFACT_INDEX_DIR = idxRoot;
    [emptyReports, emptyAnalyses, emptyDoctors, emptyObs, emptyJobs, emptyManaged, proj] =
      ['rp', 'an', 'dr', 'ob', 'jb', 'mg', 'pj'].map((t) => mkdtempSync(join(tmpdir(), `omk-cg-${t}-`)));
    dirs.push(idxRoot, emptyReports, emptyAnalyses, emptyDoctors, emptyObs, emptyJobs, emptyManaged, proj);
    // 别项目卡片各一张(live 目录扫不到,只能靠卡片发现);真身写出来,免得被悬空过滤掉。
    writeMeasurementReportBundle({
      rootDir: proj,
      measurementDomain: 'doctor',
      recordId: 'cg-1-aa',
      reportId: 'doctor-cg-1-aa',
      createdAt: '2026-06-14T00:00:00Z',
      report: {},
    });
    indexDoctorWrite({ id: 'cg-1-aa', path: join(proj, reportFileName('cg-1-aa')), skillName: 'cg-skill', reportId: 'doctor-cg-1-aa',
      timestamp: '2026-06-14T00:00:00Z', status: 'pass', passCount: 1, warnCount: 0, failCount: 0 }, proj);
    const obsReport = { kind: 'observe-health',
      meta: { tracePath: '/t', kbPath: null, sessionCount: 1, segmentCount: 10, messageCount: 5, toolCallCount: 3,
        toolFailureRate: 0, timeRange: { from: '2026-06-14T00:00:00Z', to: '2026-06-14T01:00:00Z' }, generatedAt: '2026-06-14T01:00:00Z' },
      bySkill: { 'cg-skill': { skillName: 'cg-skill', segmentCount: 10, toolCallCount: 3, toolFailureCount: 0,
        toolFailureRate: 0, stability: 'stable', confidence: 'low', gap: { gapRate: 0, weightedGapRate: 0, signals: [] } } },
      overall: { gapRate: 0, weightedGapRate: 0, healthBand: 'green', confidence: 'low' } };
    // 同时写「真身文件」(供 loadAnalysis 按 card.path 回源,如 skill-trend 详情)+ 卡片。
    writeMeasurementReportBundle({
      rootDir: proj,
      measurementDomain: 'observe-health',
      recordId: 'cg-observe',
      reportId: 'cg-observe',
      createdAt: '2026-06-14T01:00:00Z',
      report: obsReport,
    });
    indexObserveWrite(obsReport as never, join(proj, reportFileName('cg-observe')), proj, 'cg-observe');
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.OMK_ARTIFACT_INDEX_DIR;
    else process.env.OMK_ARTIFACT_INDEX_DIR = origEnv;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function mkServer(include: boolean): Promise<{ url: string; srv: Srv }> {
    const srv = createReportServer({
      port: 0, analysesDir: emptyAnalyses, doctorsDir: emptyDoctors,
      observationsDir: emptyObs, managedDir: emptyManaged,
      includeObserveCards: include, includeDoctorCards: include,
    });
    return srv.start().then((url) => ({ url, srv }));
  }

  it('include=false(固定目录/逃生舱):有别项目卡片但 /api/observe-health 与 /api/skills 为空', async () => {
    const { url, srv } = await mkServer(false);
    try {
      const oh = await (await fetch(`${url}/api/observe-health`)).json();
      assert.deepEqual(oh, [], '固定目录不合 observe 卡片');
      const sk = await (await fetch(`${url}/api/skills`)).json();
      assert.deepEqual(sk.entries.map((e: { skillName: string }) => e.skillName), [], '固定目录不合 doctor/observe 卡片进 skill 索引');
    } finally { await srv.stop(); }
  });

  it('include=true(机器级默认):同样的卡片下 /api/observe-health 与 /api/skills 看到别项目产物', async () => {
    const { url, srv } = await mkServer(true);
    try {
      const oh = await (await fetch(`${url}/api/observe-health`)).json();
      assert.deepEqual(oh.map((x: { id: string }) => x.id), ['cg-observe'], '机器级模式合 observe 卡片');
      const sk = await (await fetch(`${url}/api/skills`)).json();
      assert.ok(sk.entries.some((e: { skillName: string }) => e.skillName === 'cg-skill'), '机器级模式卡片 skill 进索引');
    } finally { await srv.stop(); }
  });

  it('include=true 且 live analyses 目录不存在:/api/observe-health 与 /api/skill-trend 仍合并卡片(不早退)', async () => {
    // 默认机器级模式下当前项目还没 .omk/observe/health、全局也空 → 传给 server 的是不存在的目录。
    const missing = join(emptyAnalyses, 'does-not-exist');
    const srv = createReportServer({
      port: 0, analysesDir: missing, doctorsDir: emptyDoctors,
      observationsDir: emptyObs, managedDir: emptyManaged,
      includeObserveCards: true, includeDoctorCards: true,
    });
    const url = await srv.start();
    try {
      const oh = await (await fetch(`${url}/api/observe-health`)).json();
      assert.deepEqual(oh.map((x: { id: string }) => x.id), ['cg-observe'], 'live 目录不存在也不早退,仍合 observe 卡片');
      const trend = await (await fetch(`${url}/api/skill-trend/cg-skill`)).json();
      assert.ok(trend.points.length >= 1, 'skill-trend 也依赖 listAnalyses,同样合并卡片(按 card.path 回源真身)');
    } finally { await srv.stop(); }
  });
});
