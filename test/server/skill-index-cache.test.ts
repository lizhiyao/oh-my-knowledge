/**
 * skill-index 缓存 — PR #95 review P2-4 回归测试。
 *
 * buildSkillIndex 现在跨调用缓存 result,用 reports + 两个 dir 的 mtime + 文件数算
 * fingerprint。三类变化都必须 invalidate:
 *   1. reports 数组改变(新 run / 新 timestamp)
 *   2. doctorsDir / analysesDir 内容变化(加 / 删 doctor / observe 报告)
 *   3. dir mtime(操作系统级 ls 变化)
 *
 * 本测试只验证 1(纯输入级 — 不需要写盘),2 由 mtime 变化等价覆盖。
 */
import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillIndex, _resetSkillIndexCache } from '../../src/server/skill-index.js';
import type { EvaluationReport } from '../../src/types/index.js';

function mkReport(id: string, ts: string, variant: string): EvaluationReport {
  return {
    kind: 'evaluation',
    id,
    meta: {
      variants: ['baseline', variant],
      model: 'sonnet',
      executor: 'claude',
      sampleCount: 1,
      taskCount: 1,
      totalCostUSD: 0,
      timestamp: ts,
      cliVersion: '0.0.0-test',
      nodeVersion: process.version,
      artifactHashes: {},
      judgeModels: [],
    },
    summary: { [variant]: { totalSamples: 1, successCount: 1, errorCount: 0, avgCompositeScore: 4.0 } },
    results: [{ sample_id: 's001', variants: { [variant]: { ok: true } } }],
  } as unknown as EvaluationReport;
}

describe('buildSkillIndex 模块级缓存', () => {
  let analysesDir: string;
  let doctorsDir: string;

  beforeEach(() => {
    _resetSkillIndexCache();
    analysesDir = mkdtempSync(join(tmpdir(), 'omk-analyses-'));
    doctorsDir = mkdtempSync(join(tmpdir(), 'omk-doctors-'));
  });

  it('reports 不变 + dir 不变时复用缓存(命中返回同一对象引用)', () => {
    const reports = [mkReport('r1', '2026-05-11T00:00:00Z', 'foo')];
    const idx1 = buildSkillIndex(reports, analysesDir, doctorsDir);
    const idx2 = buildSkillIndex(reports, analysesDir, doctorsDir);
    // 同一对象引用即命中(否则会是新构造的 idx)
    assert.equal(idx2, idx1);
    rmSync(analysesDir, { recursive: true, force: true });
    rmSync(doctorsDir, { recursive: true, force: true });
  });

  it('reports 数组变化时 invalidate 缓存(返回新对象)', () => {
    const r1 = mkReport('r1', '2026-05-11T00:00:00Z', 'foo');
    const r2 = mkReport('r2', '2026-05-11T01:00:00Z', 'bar');
    const idx1 = buildSkillIndex([r1], analysesDir, doctorsDir);
    const idx2 = buildSkillIndex([r1, r2], analysesDir, doctorsDir);
    assert.notEqual(idx2, idx1);
    assert.equal(idx2.entries.length, 2);
    rmSync(analysesDir, { recursive: true, force: true });
    rmSync(doctorsDir, { recursive: true, force: true });
  });

  it('_resetSkillIndexCache 后强制重算', () => {
    const reports = [mkReport('r1', '2026-05-11T00:00:00Z', 'foo')];
    const idx1 = buildSkillIndex(reports, analysesDir, doctorsDir);
    _resetSkillIndexCache();
    const idx2 = buildSkillIndex(reports, analysesDir, doctorsDir);
    assert.notEqual(idx2, idx1);
    rmSync(analysesDir, { recursive: true, force: true });
    rmSync(doctorsDir, { recursive: true, force: true });
  });
});
