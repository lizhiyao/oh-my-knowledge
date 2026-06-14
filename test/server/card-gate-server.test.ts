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
import { createReportServer } from '../../src/server/report-server.js';
import { indexDoctorWrite, indexObserveWrite } from '../../src/eval-core/artifact-index.js';

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
    // 别项目卡片各一张(live 目录扫不到,只能靠卡片发现)。
    indexDoctorWrite({ id: 'cg-doctor-1-aa', path: join(proj, 'cg.json'), skillName: 'cg-skill', reportId: 'doctor-cg-1-aa',
      timestamp: '2026-06-14T00:00:00Z', status: 'pass', passCount: 1, warnCount: 0, failCount: 0 }, proj);
    indexObserveWrite({ meta: { generatedAt: '2026-06-14T01:00:00Z', sessionCount: 1, segmentCount: 10 },
      overall: { healthBand: 'green', confidence: 'high' },
      bySkill: { 'cg-skill': { toolFailureRate: 0, segmentCount: 10, confidence: 'high', gap: { weightedGapRate: 0 } } },
    } as never, join(proj, 'cg-observe-health.json'), proj, 'cg-observe-health');
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.OMK_ARTIFACT_INDEX_DIR;
    else process.env.OMK_ARTIFACT_INDEX_DIR = origEnv;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function mkServer(include: boolean): Promise<{ url: string; srv: Srv }> {
    const srv = createReportServer({
      port: 0, reportsDir: emptyReports, analysesDir: emptyAnalyses, doctorsDir: emptyDoctors,
      observationsDir: emptyObs, jobsDir: emptyJobs, managedDir: emptyManaged,
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
      assert.deepEqual(oh.map((x: { id: string }) => x.id), ['cg-observe-health'], '机器级模式合 observe 卡片');
      const sk = await (await fetch(`${url}/api/skills`)).json();
      assert.ok(sk.entries.some((e: { skillName: string }) => e.skillName === 'cg-skill'), '机器级模式卡片 skill 进索引');
    } finally { await srv.stop(); }
  });
});
