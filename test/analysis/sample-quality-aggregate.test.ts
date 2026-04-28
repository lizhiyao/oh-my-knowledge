import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildSampleQualityAggregate, analyzeResults } from '../../src/analysis/report-diagnostics.js';
import type { Report, Sample } from '../../src/types/index.js';

describe('buildSampleQualityAggregate (v0.22)', () => {
  it('空 sample 数组返回零值', () => {
    const agg = buildSampleQualityAggregate([]);
    assert.deepEqual(agg.capabilityCoverage, {});
    assert.equal(agg.difficultyDistribution.unspecified, 0);
    assert.equal(agg.avgRubricLength, 0);
    assert.equal(agg.sampleCountWithCapability, 0);
  });

  it('正确分桶 capability / difficulty / construct / provenance', () => {
    const samples: Sample[] = [
      { sample_id: 's1', prompt: 'p', capability: ['api-selection', 'error-diagnosis'], difficulty: 'easy', construct: 'necessity', provenance: 'human' },
      { sample_id: 's2', prompt: 'p', capability: ['api-selection'], difficulty: 'medium', construct: 'necessity', provenance: 'human' },
      { sample_id: 's3', prompt: 'p', capability: ['fallback'], difficulty: 'hard', construct: 'quality', provenance: 'llm-generated' },
    ];
    const agg = buildSampleQualityAggregate(samples);
    // capability counts
    assert.equal(agg.capabilityCoverage.apiselection, 2);
    assert.equal(agg.capabilityCoverage.errordiagnosis, 1);
    assert.equal(agg.capabilityCoverage.fallback, 1);
    // difficulty distribution
    assert.equal(agg.difficultyDistribution.easy, 1);
    assert.equal(agg.difficultyDistribution.medium, 1);
    assert.equal(agg.difficultyDistribution.hard, 1);
    assert.equal(agg.difficultyDistribution.unspecified, 0);
    // construct
    assert.equal(agg.constructDistribution.necessity, 2);
    assert.equal(agg.constructDistribution.quality, 1);
    // provenance
    assert.equal(agg.provenanceBreakdown.human, 2);
    assert.equal(agg.provenanceBreakdown['llm-generated'], 1);
    // counts
    assert.equal(agg.sampleCountWithCapability, 3);
    assert.equal(agg.sampleCountWithDifficulty, 3);
    assert.equal(agg.sampleCountWithConstruct, 3);
    assert.equal(agg.sampleCountWithProvenance, 3);
  });

  it('缺字段视为 unspecified 写进 distribution map', () => {
    const samples: Sample[] = [
      { sample_id: 's1', prompt: 'p' },
      { sample_id: 's2', prompt: 'p', difficulty: 'medium' },
    ];
    const agg = buildSampleQualityAggregate(samples);
    assert.equal(agg.difficultyDistribution.unspecified, 1);
    assert.equal(agg.difficultyDistribution.medium, 1);
    assert.equal(agg.constructDistribution.unspecified, 2);
    assert.equal(agg.provenanceBreakdown.unspecified, 2);
    assert.equal(agg.sampleCountWithCapability, 0);
    assert.equal(agg.sampleCountWithDifficulty, 1);
  });

  it('capability 大小写不敏感 + 短横线/驼峰/下划线归一', () => {
    const samples: Sample[] = [
      { sample_id: 's1', prompt: 'p', capability: ['api-selection'] },
      { sample_id: 's2', prompt: 'p', capability: ['apiSelection'] },
      { sample_id: 's3', prompt: 'p', capability: ['API_Selection'] },
      { sample_id: 's4', prompt: 'p', capability: ['api selection'] },
    ];
    const agg = buildSampleQualityAggregate(samples);
    // 4 个不同写法都归到同一个 normalized key
    assert.equal(Object.keys(agg.capabilityCoverage).length, 1);
    assert.equal(agg.capabilityCoverage.apiselection, 4);
  });

  it('同 sample 内 capability 重复声明只计 1', () => {
    const samples: Sample[] = [
      { sample_id: 's1', prompt: 'p', capability: ['api-selection', 'apiSelection'] }, // 同 sample 内归一后是 1 个
    ];
    const agg = buildSampleQualityAggregate(samples);
    assert.equal(agg.capabilityCoverage.apiselection, 1);
  });

  it('avgRubricLength 只统计 rubric 存在的 sample', () => {
    const samples: Sample[] = [
      { sample_id: 's1', prompt: 'p', rubric: '一二三四五六七八九十' }, // 10 chars
      { sample_id: 's2', prompt: 'p', rubric: '甲乙丙丁戊' }, // 5 chars
      { sample_id: 's3', prompt: 'p' }, // no rubric, not counted
    ];
    const agg = buildSampleQualityAggregate(samples);
    // avg = (10+5) / 2 = 7.5 → round(7.5) = 8
    assert.equal(agg.avgRubricLength, 8);
  });
});

describe('analyzeResults — sampleQuality wiring (v0.22)', () => {
  function emptyReport(): Report {
    return {
      id: 'r',
      meta: {
        variants: ['v1', 'v2'], model: 'm', judgeModel: 'j', executor: 'claude',
        sampleCount: 0, taskCount: 0, totalCostUSD: 0,
        timestamp: '2026-04-25T00:00:00Z', cliVersion: 'test', nodeVersion: 'test',
        artifactHashes: {},
      },
      summary: {},
      results: [],
    };
  }

  it('analyzeResults(report, { samples }) 把 sampleQuality 挂到 analysis', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', difficulty: 'easy' }];
    const result = analyzeResults(emptyReport(), { samples });
    assert.ok(result.sampleQuality);
    assert.equal(result.sampleQuality!.difficultyDistribution.easy, 1);
  });

  it('analyzeResults(report) 不传 samples 时不挂 sampleQuality(老 caller 兼容)', () => {
    const result = analyzeResults(emptyReport());
    assert.equal(result.sampleQuality, undefined);
  });

  it('analyzeResults 即使在 results.length===0 / variants<2 时也算 sampleQuality(纯元数据,跟 result 无关)', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', construct: 'capability' }];
    const result = analyzeResults(emptyReport(), { samples });
    assert.ok(result.sampleQuality);
    assert.equal(result.sampleQuality!.constructDistribution.capability, 1);
  });
});
