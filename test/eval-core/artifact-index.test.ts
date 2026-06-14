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
  indexReportWrite, listReportCards, cardToReportDocument, removeReportCard, shouldIndexReport, artifactIndexDir,
} from '../../src/eval-core/artifact-index.js';
import { globalReportsDir } from '../../src/eval-core/measurement-dirs.js';

function makeEvalReport(id: string, variant = 'v1', hash = 'h1'): Record<string, unknown> {
  return {
    kind: 'evaluation',
    id,
    meta: { timestamp: '2026-06-14T00:00:00Z', variants: [variant], artifactHashes: { [variant]: hash } },
    summary: { [variant]: { totalSamples: 3, successCount: 2, errorCount: 1 } },
    results: [{ sample_id: 's1', variants: {} }],
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
    const filePath = join(projDir, 'r1.json');
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
    indexReportWrite(makeEvalReport('rg') as never, join(globalReportsDir(), 'rg.json'), globalReportsDir());
    assert.equal(listReportCards().length, 0);
  });

  it('cardToReportDocument:卡片 → results:[] 文档(供 list/trend 消费)', () => {
    indexReportWrite(makeEvalReport('r2') as never, join(projDir, 'r2.json'), projDir);
    const doc = cardToReportDocument(listReportCards()[0]);
    assert.equal(doc.kind, 'evaluation');
    assert.deepEqual(doc.kind === 'evaluation' ? doc.results : null, []);
  });

  it('removeReportCard:删卡片幂等', () => {
    indexReportWrite(makeEvalReport('r3') as never, join(projDir, 'r3.json'), projDir);
    assert.equal(removeReportCard('r3'), true);
    assert.equal(listReportCards().length, 0);
    assert.equal(removeReportCard('r3'), false, '再删返回 false(幂等)');
  });

  it('非完整报告(无 canonical kind)防御式跳过,不落卡片', () => {
    indexReportWrite({ id: 'bare' }, join(projDir, 'bare.json'), projDir);
    assert.equal(listReportCards().length, 0);
  });

  it('坏 kind 卡片(拼错 / doctor)读侧跳过,不污染机器级 list', () => {
    indexReportWrite(makeEvalReport('good') as never, join(projDir, 'good.json'), projDir);
    // 直接写一张 kind 不在白名单的卡片(绕过写侧 guard,模拟脏文件 / 别域误落本目录)
    const dir = artifactIndexDir('report');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({
      domain: 'report', id: 'bad', path: join(projDir, 'bad.json'), kind: 'doctor', meta: { timestamp: '2026-06-14T00:00:00Z' },
    }));
    assert.deepEqual(listReportCards().map((c) => c.id), ['good'], '只收白名单 kind,坏卡片跳过');
  });
});
