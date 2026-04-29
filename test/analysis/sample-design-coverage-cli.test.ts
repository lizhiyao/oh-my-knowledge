import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderSampleDesignCoverage } from '../../src/analysis/sample-design-coverage-cli.js';
import type { Sample, SampleQualityAggregate } from '../../src/types/index.js';

// UltraReview follow-up #7: cover the renderer, not just E2E.

describe('renderSampleDesignCoverage', () => {
  it('renders empty string when no samples and no aggregate', () => {
    assert.equal(renderSampleDesignCoverage(undefined, undefined, 'zh'), '');
    assert.equal(renderSampleDesignCoverage([], undefined, 'zh'), '');
  });

  it('renders empty string when aggregate has zero samples', () => {
    const aggregate: SampleQualityAggregate = {
      capabilityCoverage: {},
      difficultyDistribution: { easy: 0, medium: 0, hard: 0, unspecified: 0 },
      constructDistribution: {},
      provenanceBreakdown: {},
      avgRubricLength: 0,
      sampleCountWithCapability: 0,
      sampleCountWithDifficulty: 0,
      sampleCountWithConstruct: 0,
      sampleCountWithProvenance: 0,
    };
    assert.equal(renderSampleDesignCoverage(undefined, aggregate, 'zh'), '');
  });

  it('renders coverage block with capability counts when fresh samples provided', () => {
    const samples: Sample[] = [
      { sample_id: 's1', prompt: 'p', capability: ['api-selection'], difficulty: 'easy', construct: 'necessity', provenance: 'human' },
      { sample_id: 's2', prompt: 'p', capability: ['api-selection', 'error-diagnosis'], difficulty: 'medium', construct: 'necessity', provenance: 'human' },
    ];
    const out = renderSampleDesignCoverage(samples, undefined, 'zh');
    assert.match(out, /用例设计覆盖度/);
    assert.match(out, /apiselection \(2\)/);
    assert.match(out, /errordiagnosis \(1\)/);
    assert.match(out, /easy \(1\)/);
    assert.match(out, /medium \(1\)/);
    assert.match(out, /necessity \(2\)/);
    assert.match(out, /human \(2\)/);
    assert.match(out, /\[2\/2 声明 = 100%\]/);
  });

  it('falls back to report.analysis.sampleQuality when no fresh samples', () => {
    const aggregate: SampleQualityAggregate = {
      capabilityCoverage: { core: 5, rare: 1 },
      difficultyDistribution: { easy: 2, medium: 3, hard: 1, unspecified: 0 },
      constructDistribution: { necessity: 6 },
      provenanceBreakdown: { human: 6 },
      avgRubricLength: 50,
      sampleCountWithCapability: 6,
      sampleCountWithDifficulty: 6,
      sampleCountWithConstruct: 6,
      sampleCountWithProvenance: 6,
    };
    const out = renderSampleDesignCoverage(undefined, aggregate, 'zh');
    assert.match(out, /core \(5\)/);
    assert.match(out, /easy \(2\)/);
    assert.match(out, /avgRubric:.*50/);
  });

  it('shows unspecified hint when no metadata declared on any sample', () => {
    const samples: Sample[] = [
      { sample_id: 's1', prompt: 'p' },
      { sample_id: 's2', prompt: 'p' },
    ];
    const out = renderSampleDesignCoverage(samples, undefined, 'zh');
    // hint about empty metadata
    assert.match(out, /未声明任何 capability/);
  });

  it('English locale returns english strings', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', difficulty: 'easy' }];
    const out = renderSampleDesignCoverage(samples, undefined, 'en');
    assert.match(out, /Sample design coverage/);
    assert.match(out, /easy \(1\)/);
  });
});
