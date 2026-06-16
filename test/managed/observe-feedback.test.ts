/**
 * observe → managed 反哺写入单测(#235)。setup 仿 evidence.test.ts:seed 受管记录 → 调 recordObserveHealth →
 * 断言返回清单 + 盘上 observations。覆盖:按 name 匹配并 append、未纳管不建记录、按 reportId 去重、kind 过滤
 * (同名 prompt 不接 observe 信号)、isProductionGap 判定(red 且够力才 true)。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildManagedArtifactRecord, upsertManagedRecord, loadManagedRecord, managedRecordId } from '../../src/managed/store.js';
import { recordObserveHealth, type ObservedSkillHealthView } from '../../src/managed/observe-feedback.js';
import type { ArtifactKind } from '../../src/types/index.js';

const GAP0 = { failed_search: 0, explicit_marker: 0, hedging: 0, repeated_failure: 0 };

function skillView(over: Partial<ObservedSkillHealthView> & { skillName: string }): ObservedSkillHealthView {
  return { segmentCount: 20, gapRate: 0, weightedGapRate: 0, confidence: 'high', healthBand: 'green', gapByType: GAP0, ...over };
}

describe('managed observe-feedback — recordObserveHealth', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omk-obs-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function seed(name: string, kind: ArtifactKind = 'skill'): void {
    upsertManagedRecord(dir, buildManagedArtifactRecord({
      name, kind,
      source: { sourceKind: 'file', locator: `/abs/${name}.md`, isDirectorySkill: false },
      contentHash: `hash-${name}`, installedAt: '2026-06-01T00:00:00.000Z', distribution: [],
    }));
  }

  function run(skills: ObservedSkillHealthView[], reportId = 'obs-1', observedAt = '2026-06-10T00:00:00.000Z') {
    return recordObserveHealth({ reportId, observedAt, skills }, { dir });
  }

  it('按 name 匹配 → 追加观测;red 且够力 → isProductionGap', () => {
    seed('review');
    const written = run([skillView({
      skillName: 'review', weightedGapRate: 0.4, gapRate: 0.4, healthBand: 'red',
      gapByType: { failed_search: 3, explicit_marker: 1, hedging: 0, repeated_failure: 0 },
    })]);
    assert.equal(written.length, 1);
    assert.equal(written[0].name, 'review');
    assert.equal(written[0].isProductionGap, true);
    const rec = loadManagedRecord(dir, managedRecordId('skill', 'review'));
    assert.equal(rec!.observations?.length, 1);
    assert.equal(rec!.observations![0].observationKind, 'production-health');
    assert.equal(rec!.observations![0].healthBand, 'red');
    assert.equal(rec!.observations![0].reportId, 'obs-1');
  });

  it('green + high → 记录但非 gap', () => {
    seed('review');
    const written = run([skillView({ skillName: 'review' })]);
    assert.equal(written.length, 1);
    assert.equal(written[0].isProductionGap, false);
    assert.equal(loadManagedRecord(dir, managedRecordId('skill', 'review'))!.observations?.length, 1, '非 gap 也照常记录');
  });

  it('red 但 underpowered → 非 gap(数据不足不算确诊盲区)', () => {
    seed('review');
    const written = run([skillView({ skillName: 'review', healthBand: 'red', weightedGapRate: 0.5, confidence: 'underpowered', segmentCount: 2 })]);
    assert.equal(written[0].isProductionGap, false);
  });

  it('未纳管 skill → 不建记录、返回空', () => {
    const written = run([skillView({ skillName: 'never-installed', healthBand: 'red', weightedGapRate: 0.4 })]);
    assert.deepEqual(written, []);
    assert.equal(loadManagedRecord(dir, managedRecordId('skill', 'never-installed')), null);
  });

  it('按 reportId 去重:同报告重跑→1,不同报告→2', () => {
    seed('review');
    run([skillView({ skillName: 'review' })], 'obs-1');
    run([skillView({ skillName: 'review' })], 'obs-1'); // 同 id → no-op
    assert.equal(loadManagedRecord(dir, managedRecordId('skill', 'review'))!.observations?.length, 1);
    run([skillView({ skillName: 'review' })], 'obs-2'); // 新窗口 → 追加
    assert.equal(loadManagedRecord(dir, managedRecordId('skill', 'review'))!.observations?.length, 2);
  });

  it('kind 过滤:同名 prompt 不接 observe 信号(observe 测的是 skill)', () => {
    seed('review', 'prompt');
    const written = run([skillView({ skillName: 'review', healthBand: 'red', weightedGapRate: 0.4 })]);
    assert.deepEqual(written, [], 'prompt 记录不匹配');
    assert.equal(loadManagedRecord(dir, managedRecordId('prompt', 'review'))!.observations, undefined);
  });

  it('同名一 skill 一 prompt → 只写 skill', () => {
    seed('review', 'skill');
    seed('review', 'prompt');
    const written = run([skillView({ skillName: 'review', healthBand: 'red', weightedGapRate: 0.4 })]);
    assert.equal(written.length, 1);
    assert.equal(written[0].recordId, managedRecordId('skill', 'review'));
    assert.equal(loadManagedRecord(dir, managedRecordId('skill', 'review'))!.observations?.length, 1);
    assert.equal(loadManagedRecord(dir, managedRecordId('prompt', 'review'))!.observations, undefined);
  });

  it('无被观测 skill → 空', () => {
    seed('review');
    assert.deepEqual(run([]), []);
  });
});
