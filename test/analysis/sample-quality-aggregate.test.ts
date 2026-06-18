import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildSampleQualityAggregate, analyzeResults } from '../../src/analysis/report-diagnostics.js';
import type { Report, Sample } from '../../src/types/index.js';

describe('buildSampleQualityAggregate', () => {
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

describe('analyzeResults — sampleQuality wiring', () => {
  function emptyReport(): Report {
    return {
      kind: 'evaluation',
      id: 'r',
      meta: {
        variants: ['v1', 'v2'], model: 'm', judgeModels: [{ executor: 'claude', model: 'j' }], executor: 'claude',
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

describe('buildRepresentativeness', () => {
  const mk = (sample_id: string, difficulty: Sample['difficulty'], capability: string[], construct?: string): Sample =>
    ({ sample_id, prompt: 'p', difficulty, capability, ...(construct ? { construct } : {}) });

  it('空 sample → 全 0,无 dominant', () => {
    const rep = buildSampleQualityAggregate([]).representativeness!;
    assert.equal(rep.capabilityCount, 0);
    assert.equal(rep.capabilityConcentration, 0);
    assert.equal(rep.difficultyConcentration, 0);
    assert.equal(rep.dominantDifficulty, undefined);
    assert.equal(rep.dominantCapability, undefined);
  });

  it('难度集中度 = dominant 已声明桶占比（unspecified 不计入分母）', () => {
    // 7 easy / 2 medium / 1 hard + 2 未声明 → 已声明 10,dominant easy = 0.7。
    const samples: Sample[] = [
      ...Array.from({ length: 7 }, (_, i) => mk(`e${i}`, 'easy', ['a'])),
      ...Array.from({ length: 2 }, (_, i) => mk(`m${i}`, 'medium', ['a'])),
      mk('h0', 'hard', ['a']),
      { sample_id: 'u0', prompt: 'p', capability: ['a'] },
      { sample_id: 'u1', prompt: 'p', capability: ['a'] },
    ];
    const rep = buildSampleQualityAggregate(samples).representativeness!;
    assert.equal(rep.dominantDifficulty, 'easy');
    assert.equal(Number(rep.difficultyConcentration.toFixed(2)), 0.7);
  });

  it('能力集中度 = dominant 标签占全部标签的比例,capabilityCount = 去重后数量', () => {
    const samples: Sample[] = [
      ...Array.from({ length: 8 }, (_, i) => mk(`x${i}`, 'easy', ['common'])),
      ...Array.from({ length: 2 }, (_, i) => mk(`y${i}`, 'easy', ['rare'])),
    ];
    const rep = buildSampleQualityAggregate(samples).representativeness!;
    assert.equal(rep.capabilityCount, 2);
    assert.equal(rep.dominantCapability, 'common');
    assert.equal(Number(rep.capabilityConcentration.toFixed(2)), 0.8);
  });

  it('construct 集中度排除 unspecified', () => {
    const samples: Sample[] = [
      mk('a', 'easy', ['c'], 'necessity'),
      mk('b', 'easy', ['c'], 'necessity'),
      mk('c', 'easy', ['c']), // 无 construct → unspecified,不进分母
    ];
    const rep = buildSampleQualityAggregate(samples).representativeness!;
    assert.equal(rep.dominantConstruct, 'necessity');
    assert.equal(rep.constructConcentration, 1); // 2/2 declared
  });
});
