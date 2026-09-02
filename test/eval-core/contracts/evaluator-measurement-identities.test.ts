import { describe, expect, it } from 'vitest';
import {
  countAnalysisResamplingUnits,
  deriveEvaluationId,
  digestCanonicalJson,
} from '../../../src/eval-core/contracts/index.js';

describe('Evaluator measurement identities', () => {
  it('separates evaluator replicate identity from retry identity', () => {
    const evaluationPlanDigest = digestCanonicalJson({ plan: 'evaluation' });
    const trialId = digestCanonicalJson({ trial: 1 });
    const base = {
      evaluationPlanDigest,
      trialId,
      evaluatorId: 'judge',
      measurement: {
        instrumentId: 'rubric-v1',
        ensembleMemberId: 'judge-model-a',
        replicateGroupId: 'judge-self-consistency',
        replicateIndex: 0,
      },
    };

    expect(deriveEvaluationId({
      ...base,
      measurement: { ...base.measurement, replicateIndex: 1 },
    })).not.toBe(deriveEvaluationId(base));
  });

  it('does not count evaluator replicates or ensemble members as independent samples or runs', () => {
    const rows = [
      { targetId: 'target', sampleId: 'sample', samplingUnitIds: {} },
      { targetId: 'target', sampleId: 'sample', samplingUnitIds: {} },
      { targetId: 'target', sampleId: 'sample', samplingUnitIds: {} },
    ];

    expect(countAnalysisResamplingUnits('sample', rows)).toBe(1);
    expect(countAnalysisResamplingUnits('run', rows)).toBe(1);
  });
});
