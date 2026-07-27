/**
 * 产物发现索引(report 域)写侧验收:项目写落卡片、全局写跳过、卡片投影、删除幂等、防御式跳过。
 * 全程把 OMK_ARTIFACT_INDEX_DIR 指到 per-test temp 目录,不碰真实 ~/.oh-my-knowledge/state。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  indexReportWrite, listReportCards, removeReportCard, shouldIndexReport, artifactIndexDir,
} from '../../src/eval-core/artifact-index.js';
import { reportFileName } from '../../src/eval-core/artifact-file-names.js';
import { globalReportsDir } from '../../src/eval-core/measurement-dirs.js';
import type { ReportDocument } from '../../src/types/index.js';

function makeEvalReport(id: string, variant = 'v1', hash = 'h1'): Record<string, unknown> {
  return {
    kind: 'evaluation',
    id,
    meta: {
      timestamp: '2026-06-14T00:00:00Z',
      variants: [variant],
      artifactHashes: { [variant]: hash },
      model: 'test-model',
      executor: 'script',
      sampleCount: 1,
      taskCount: 1,
      totalCostUSD: 0,
      cliVersion: 'test',
      nodeVersion: process.version,
      judgeModels: [{ executor: 'script', model: 'test-judge' }],
    },
    summary: {
      [variant]: {
        totalSamples: 1,
        successCount: 1,
        errorCount: 0,
        errorRate: 0,
        avgDurationMs: 0,
        avgInputTokens: 0,
        avgOutputTokens: 0,
        avgTotalTokens: 0,
        totalCostUSD: 0,
        totalExecCostUSD: 0,
        totalJudgeCostUSD: 0,
        avgCostPerSample: 0,
        avgNumTurns: 1,
      },
    },
    results: [{
      sample_id: 's1',
      variants: {
        [variant]: {
          ok: true,
          durationMs: 0,
          durationApiMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          execCostUSD: 0,
          judgeCostUSD: 0,
          costUSD: 0,
          numTurns: 1,
          outputPreview: 'ok',
        },
      },
    }],
  };
}

describe('artifact-index 写侧(report 域)', () => {
  let indexRoot: string;
  let projDir: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.OMK_ARTIFACT_INDEX_DIR;
    indexRoot = mkdtempSync(join(tmpdir(), 'omk-ai-idx-'));
    projDir = mkdtempSync(join(tmpdir(), 'omk-ai-proj-'));
    process.env.OMK_ARTIFACT_INDEX_DIR = indexRoot;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.OMK_ARTIFACT_INDEX_DIR;
    else process.env.OMK_ARTIFACT_INDEX_DIR = origEnv;
    rmSync(indexRoot, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  it('项目写 → 落卡片(无 results),含 id/path/kind/meta/summary', () => {
    const filePath = join(projDir, reportFileName('r1'));
    indexReportWrite(makeEvalReport('r1') as never, filePath, projDir);
    const cards = listReportCards();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, 'r1');
    assert.equal(cards[0].path, filePath);
    assert.equal(cards[0].domain, 'report');
    assert.equal(cards[0].kind, 'evaluation');
    assert.ok(cards[0].summary?.v1, '卡片含 summary');
    assert.ok(!('results' in cards[0]), '卡片不含 results 重体');
  });

  it('全局写 → 不落卡片(shouldIndexReport false,全局靠 live-scan 覆盖)', () => {
    assert.equal(shouldIndexReport(globalReportsDir()), false);
    indexReportWrite(makeEvalReport('rg') as never, join(globalReportsDir(), reportFileName('rg')), globalReportsDir());
    assert.equal(listReportCards().length, 0);
  });

  it('卡片只保存发现信息，不伪装成完整 ReportDocument', () => {
    indexReportWrite(makeEvalReport('r2') as never, join(projDir, reportFileName('r2')), projDir);
    const card = listReportCards()[0];
    assert.equal(card.kind, 'evaluation');
    assert.ok(!('results' in card));
  });

  it('removeReportCard:删卡片幂等', () => {
    indexReportWrite(makeEvalReport('r3') as never, join(projDir, reportFileName('r3')), projDir);
    assert.equal(removeReportCard('r3'), true);
    assert.equal(listReportCards().length, 0);
    assert.equal(removeReportCard('r3'), false, '再删返回 false(幂等)');
  });

  it('非完整报告(无 canonical kind)防御式跳过,不落卡片', () => {
    indexReportWrite(
      { id: 'bare' } as unknown as ReportDocument,
      join(projDir, reportFileName('bare')),
      projDir,
    );
    assert.equal(listReportCards().length, 0);
  });

  it('坏 kind 卡片(拼错 / doctor)读侧跳过,不污染机器级 list', () => {
    indexReportWrite(makeEvalReport('good') as never, join(projDir, reportFileName('good')), projDir);
    // 直接写一张 kind 不在白名单的卡片(绕过写侧 guard,模拟脏文件 / 别域误落本目录)
    const dir = artifactIndexDir('report');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({
      domain: 'report', id: 'bad', path: join(projDir, 'bad.json'), kind: 'doctor', meta: { timestamp: '2026-06-14T00:00:00Z' },
    }));
    assert.deepEqual(listReportCards().map((c) => c.id), ['good'], '只收白名单 kind,坏卡片跳过');
  });
});
