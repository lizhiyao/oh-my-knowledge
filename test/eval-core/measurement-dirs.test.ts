import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  projectObserveHealthDir, globalObserveHealthDir, resolveObserveHealthDir,
  projectDoctorsDir, globalDoctorsDir, resolveDoctorsDir,
  projectReportsDir, globalReportsDir,
} from '../../src/eval-core/measurement-dirs.js';
import { OMK_HOME } from '../../src/eval-core/default-dirs.js';

function mkTmp(tag: string): string {
  const d = join(tmpdir(), `omk-mdir-${tag}-${Date.now()}-${Math.round(performance.now())}`);
  mkdirSync(d, { recursive: true });
  return d;
}

describe('measurement-dirs 项目优先→全局兜底(记录优先)', () => {
  it('project/global getter 路径', () => {
    assert.equal(projectObserveHealthDir('/x'), join('/x', '.omk', 'observe-health'));
    assert.equal(projectDoctorsDir('/x'), join('/x', '.omk', 'doctors'));
    assert.equal(projectReportsDir('/x'), join('/x', '.omk', 'reports'));
    // 全局目录从 OMK_HOME 派生(OMK_HOME 可被 env 整体重定向,故不硬编码 .oh-my-knowledge)。
    assert.equal(globalObserveHealthDir(), join(OMK_HOME, 'observe-health'));
    assert.equal(globalDoctorsDir(), join(OMK_HOME, 'doctors'));
    assert.equal(globalReportsDir(), join(OMK_HOME, 'reports'));
  });

  it('reports 不给 resolveReportsDir(记录优先在 overlay store 层做,见 report-store)', () => {
    // 故意只暴露 project/global getter:单目录二选一会让目标 id 在另一目录时 get 落空,
    // reports 的项目→全局兜底必须在 store 层(createOverlayReportStore),不在 dir 解析层。
    assert.equal(projectReportsDir(), join(process.cwd(), '.omk', 'reports'));
  });

  it('observe-health:项目有报告→项目;项目空+全局有→全局;都空→项目', () => {
    const proj = mkTmp('h-proj');
    const glob = mkTmp('h-glob');
    try {
      // 都空 → 回项目
      assert.equal(resolveObserveHealthDir(proj, glob), proj, '都空回项目');
      // 仅全局有 → 全局
      writeFileSync(join(glob, '2026-01-01T00-00-00-observe-health.json'), '{}');
      assert.equal(resolveObserveHealthDir(proj, glob), glob, '项目空+全局有→全局');
      // 项目也有 → 项目优先
      writeFileSync(join(proj, '2026-02-02T00-00-00-observe-health.json'), '{}');
      assert.equal(resolveObserveHealthDir(proj, glob), proj, '项目有→项目优先');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });

  it('observe-health 记录优先按后缀:无关 .json 不算报告', () => {
    const proj = mkTmp('h-suffix');
    const glob = mkTmp('h-suffix-g');
    try {
      writeFileSync(join(proj, 'random.json'), '{}'); // 非 -observe-health.json
      writeFileSync(join(glob, '2026-01-01T00-00-00-observe-health.json'), '{}');
      // 项目只有无关 .json → 不算有报告 → 回退全局
      assert.equal(resolveObserveHealthDir(proj, glob), glob, '后缀不匹配不算报告');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });

  it('doctors:项目有任意 .json→项目;项目空+全局有→全局;都空→项目', () => {
    const proj = mkTmp('d-proj');
    const glob = mkTmp('d-glob');
    try {
      assert.equal(resolveDoctorsDir(proj, glob), proj, '都空回项目');
      writeFileSync(join(glob, 'some-skill-id.json'), '{}');
      assert.equal(resolveDoctorsDir(proj, glob), glob, '项目空+全局有→全局');
      writeFileSync(join(proj, 'another-skill-id.json'), '{}');
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
