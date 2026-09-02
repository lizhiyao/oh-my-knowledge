import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  projectObserveHealthDir, globalObserveHealthDir, resolveObserveHealthDir,
  projectDoctorsDir, globalDoctorsDir, resolveDoctorsDir,
  projectReportsDir, globalReportsDir,
} from '../../../src/evidence/storage/directories.js';
import { OMK_HOME } from '../../../src/evidence/storage/default-dirs.js';
import { writeMeasurementReportBundle } from '../../../src/evidence/storage/report-bundle.js';

function mkTmp(tag: string): string {
  const d = join(tmpdir(), `omk-mdir-${tag}-${Date.now()}-${Math.round(performance.now())}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function writeBundle(rootDir: string, measurementDomain: 'doctor' | 'observe-health', id: string): void {
  writeMeasurementReportBundle({
    rootDir,
    measurementDomain,
    recordId: id,
    reportId: id,
    createdAt: '2026-09-02T00:00:00.000Z',
    report: {},
  });
}

describe('measurement-dirs 项目优先→全局兜底(记录优先)', () => {
  it('project/global getter 路径', () => {
    assert.equal(projectObserveHealthDir('/x'), join('/x', '.omk', 'observe', 'health'));
    assert.equal(projectDoctorsDir('/x'), join('/x', '.omk', 'doctor'));
    assert.equal(projectReportsDir('/x'), join('/x', '.omk', 'eval'));
    // 全局目录从 OMK_HOME 派生(OMK_HOME 可被 env 整体重定向,故不硬编码 .oh-my-knowledge)。
    assert.equal(globalObserveHealthDir(), join(OMK_HOME, 'observe', 'health'));
    assert.equal(globalDoctorsDir(), join(OMK_HOME, 'doctor'));
    assert.equal(globalReportsDir(), join(OMK_HOME, 'eval'));
  });

  it('reports 不给 resolveReportsDir(记录优先在 overlay store 层做,见 report-store)', () => {
    // 故意只暴露 project/global getter:单目录二选一会让目标 id 在另一目录时 get 落空,
    // reports 的项目→全局兜底必须在 store 层(createOverlayReportStore),不在 dir 解析层。
    assert.equal(projectReportsDir(), join(process.cwd(), '.omk', 'eval'));
  });

  it('observe-health:项目有报告→项目;项目空+全局有→全局;都空→项目', () => {
    const proj = mkTmp('h-proj');
    const glob = mkTmp('h-glob');
    try {
      // 都空 → 回项目
      assert.equal(resolveObserveHealthDir(proj, glob), proj, '都空回项目');
      // 仅全局有 → 全局
      writeBundle(glob, 'observe-health', '20260101T000000-a111');
      assert.equal(resolveObserveHealthDir(proj, glob), glob, '项目空+全局有→全局');
      // 项目也有 → 项目优先
      writeBundle(proj, 'observe-health', '20260202T000000-b222');
      assert.equal(resolveObserveHealthDir(proj, glob), proj, '项目有→项目优先');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });

  it('observe-health 忽略旧裸 JSON 且不自动改名', () => {
    const proj = mkTmp('h-suffix');
    const glob = mkTmp('h-suffix-g');
    try {
      const legacyName = '20260101T000000-a111-observe-health.json';
      writeFileSync(join(proj, legacyName), JSON.stringify({
        kind: 'observe-health',
        meta: {},
        bySkill: {},
        overall: {},
      }));
      writeBundle(glob, 'observe-health', '20260101T000000-a111');
      // 项目只有旧裸 JSON → 不算当前报告、也不改用户文件 → 回退全局。
      assert.equal(resolveObserveHealthDir(proj, glob), glob, '后缀不匹配不算报告');
      assert.deepEqual(readdirSync(proj), [legacyName]);
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });

  it('doctors:项目有 report→项目;项目空+全局有→全局;都空→项目', () => {
    const proj = mkTmp('d-proj');
    const glob = mkTmp('d-glob');
    try {
      assert.equal(resolveDoctorsDir(proj, glob), proj, '都空回项目');
      writeBundle(glob, 'doctor', 'some-skill-id');
      assert.equal(resolveDoctorsDir(proj, glob), glob, '项目空+全局有→全局');
      writeBundle(proj, 'doctor', 'another-skill-id');
      assert.equal(resolveDoctorsDir(proj, glob), proj, '项目有→项目优先');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });

  it('目录不存在不抛,返回非空字符串', () => {
    const proj = join(tmpdir(), `omk-mdir-nonexist-${Date.now()}`);
    const out = resolveObserveHealthDir(proj, join(tmpdir(), 'also-nonexist'));
    assert.equal(out, proj, '都不存在 → 回项目');
  });
});
