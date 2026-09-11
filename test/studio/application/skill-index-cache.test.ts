/**
 * 有界多目录 keyed cache 行为验收（issue #836 2.5）：
 * 目录组合交替不抖动、容量上限与 LRU 淘汰、内容变化指纹失效、命中返回克隆。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { buildSkillIndex, createSkillIndexCache } from '../../../src/studio/application/index.js';
import type { SkillIndex } from '../../../src/studio/view-models/index.js';
import { writeMeasurementReportBundle } from '../../../src/evidence/storage/report-bundle.js';
import type { DoctorReport } from '../../../src/knowledge-artifacts/doctor/contracts.js';

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeDoctor(rootDir: string, recordId: string, skillName: string): void {
  const report: DoctorReport = {
    kind: 'doctor',
    schemaVersion: '3.0.0',
    id: `report-${recordId}`,
    timestamp: '2026-09-10T00:00:00Z',
    cliVersion: 'test',
    cwd: rootDir,
    executorName: 'script',
    model: 'test',
    outcome: 'passed',
    totals: { pass: 1, warn: 0, fail: 0 },
    ruleStats: { pass: 1, warn: 0, fail: 0, skipped: 0, total: 1 },
    skills: [{
      skillName,
      skillPath: join(rootDir, skillName),
      status: 'pass',
      results: [{ ruleId: 'fixture', severity: 'info', labelKey: 'fixture', status: 'pass', message: 'ok', durationMs: 0 }],
    }],
  };
  writeMeasurementReportBundle({
    rootDir,
    measurementDomain: 'doctor',
    recordId,
    reportId: report.id,
    createdAt: report.timestamp,
    report,
  });
}

function skillNames(index: SkillIndex): string[] {
  return index.entries.map((entry) => entry.skillName).sort();
}

describe('createSkillIndexCache', () => {
  it('rejects non-positive or fractional capacity', () => {
    for (const capacity of [0, -1, 1.5]) {
      assert.throws(() => createSkillIndexCache(capacity), RangeError);
    }
  });

  it('evicts the least recently used entry beyond capacity', () => {
    const empty = tempRoot('omk-cache-empty-');
    const probe = buildSkillIndex(empty, empty, empty);
    const cache = createSkillIndexCache(2);
    cache.set('a', { fingerprint: 'fa', result: probe });
    cache.set('b', { fingerprint: 'fb', result: probe });
    assert.equal(cache.get('a')?.fingerprint, 'fa');
    cache.set('c', { fingerprint: 'fc', result: probe });
    assert.equal(cache.get('b'), undefined, 'b 最久未用被淘汰');
    assert.equal(cache.get('a')?.fingerprint, 'fa');
    assert.equal(cache.get('c')?.fingerprint, 'fc');
    cache.clear();
    assert.equal(cache.get('a'), undefined);
  });
});

describe('buildSkillIndex keyed cache', () => {
  it('keeps independent entries per directory set: A→B→A does not thrash', () => {
    const dirA = tempRoot('omk-cache-a-');
    const dirB = tempRoot('omk-cache-b-');
    const obs = tempRoot('omk-cache-obs-');
    writeDoctor(dirA, 'r1', 'alpha');
    writeDoctor(dirB, 'r2', 'beta');
    const cache = createSkillIndexCache();

    assert.deepEqual(skillNames(buildSkillIndex(dirA, dirA, obs, { cache })), ['alpha']);
    assert.deepEqual(skillNames(buildSkillIndex(dirB, dirB, obs, { cache })), ['beta']);
    const again = buildSkillIndex(dirA, dirA, obs, { cache });
    assert.deepEqual(skillNames(again), ['alpha'], '目录组合 A 的条目未被 B 顶掉');
  });

  it('revalidates content fingerprint: new report invalidates the entry', () => {
    const dir = tempRoot('omk-cache-c-');
    const obs = tempRoot('omk-cache-obs2-');
    writeDoctor(dir, 'r1', 'alpha');
    const cache = createSkillIndexCache();
    assert.deepEqual(skillNames(buildSkillIndex(dir, dir, obs, { cache })), ['alpha']);
    writeDoctor(dir, 'r2', 'beta');
    assert.deepEqual(skillNames(buildSkillIndex(dir, dir, obs, { cache })), ['alpha', 'beta'], '内容变化后重建');
  });

  it('returns clones: mutating a cached result never corrupts the cache', () => {
    const dir = tempRoot('omk-cache-d-');
    const obs = tempRoot('omk-cache-obs3-');
    writeDoctor(dir, 'r1', 'alpha');
    const cache = createSkillIndexCache();
    const first = buildSkillIndex(dir, dir, obs, { cache });
    const second = buildSkillIndex(dir, dir, obs, { cache });
    assert.notEqual(first, second, '命中返回新引用');
    second.entries.length = 0;
    second.summary.totalSkills = 99;
    const third = buildSkillIndex(dir, dir, obs, { cache });
    assert.deepEqual(skillNames(third), ['alpha'], '调用方改返回值不污染缓存');
    assert.equal(third.summary.totalSkills, 1);
  });
});
