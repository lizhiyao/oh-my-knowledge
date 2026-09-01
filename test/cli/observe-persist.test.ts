/**
 * persistObserveHealthReport 验收:id / 文件名加随机段,根治「同秒两次 observe 直接覆盖、数据丢失」的 bug;
 * 落盘后写 observe 索引卡片。隔离 OMK_ARTIFACT_INDEX_DIR,不碰真实 home。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { persistObserveHealthReport } from '../../src/cli/commands/observe/index.js';
import { listObserveCards } from '../../src/measurement-artifacts/discovery-index.js';
import { isReportFileName } from '../../src/measurement-artifacts/file-names.js';
import type { SkillHealthReport } from '../../src/observability/skill-health-analyzer.js';

function mkReport(): SkillHealthReport {
  return {
    kind: 'observe-health',
    meta: { tracePath: '/t', kbPath: null, sessionCount: 0, segmentCount: 0, messageCount: 0,
      toolCallCount: 0, toolFailureRate: 0.0, timeRange: { from: '', to: '' }, generatedAt: '2026-06-14T00:00:00Z' },
    bySkill: {},
    overall: { gapRate: 0, weightedGapRate: 0, healthBand: 'green', confidence: 'underpowered' },
  };
}

describe('persistObserveHealthReport', () => {
  let outDir: string; let indexRoot: string; let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.OMK_ARTIFACT_INDEX_DIR;
    outDir = mkdtempSync(join(tmpdir(), 'omk-obp-out-'));
    indexRoot = mkdtempSync(join(tmpdir(), 'omk-obp-idx-'));
    process.env.OMK_ARTIFACT_INDEX_DIR = indexRoot;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.OMK_ARTIFACT_INDEX_DIR;
    else process.env.OMK_ARTIFACT_INDEX_DIR = origEnv;
    for (const d of [outDir, indexRoot]) rmSync(d, { recursive: true, force: true });
  });

  it('同秒两次落盘 → 两个不同文件 / id,不覆盖(修数据丢失 bug)', () => {
    const a = persistObserveHealthReport(mkReport(), outDir);
    const b = persistObserveHealthReport(mkReport(), outDir);
    assert.notEqual(a.id, b.id, '两次 id 不同(随机段)');
    assert.notEqual(a.jsonPath, b.jsonPath);
    assert.equal(readdirSync(outDir).filter(isReportFileName).length, 2, '两份都在,无覆盖');
  });

  it('文件名使用 .report.json 后缀,目录承载 observe-health 域', () => {
    const { id, jsonPath } = persistObserveHealthReport(mkReport(), outDir);
    assert.match(id, /^\d{8}T\d{6}-[a-z0-9]{4}$/);
    assert.ok(jsonPath.endsWith(`${id}.report.json`));
  });

  it('落盘后写 observe 索引卡片(非全局目录)', () => {
    const { id } = persistObserveHealthReport(mkReport(), outDir);
    assert.deepEqual(listObserveCards().map((c) => c.id), [id]);
  });
});
