import { describe, expect, it } from "vitest";
import { evaluate, type CustomEvaluator, type RubricJudgeEvaluator } from "../../../src/eval-runtime/index.js";
import { type JsonValue } from "../../../src/eval-core/contracts/index.js";
import { controlSpec, executor, fixedClock, numericCustomEvaluator, pairedInput, stableFacadeId, treatmentSpec } from '../fixtures/evaluation.js';

describe('canonical eval-runtime comparison-families', () => {
it('preregisters a Bonferroni simultaneous interval family without inventing p-values', async () => {
    const input = pairedInput();
    const length = numericCustomEvaluator('family-length', ({ bindings }) => ({
      resultKind: 'completed',
      results: [{ metricId: 'family-length-score', resultKind: 'score', value: bindings.actual.length }],
    }));
    const family = {
      analysisId: 'release-family',
      analysisKind: 'comparison-family' as const,
      statistic: 'mean-difference' as const,
      members: [{
        analysisId: 'length-difference',
        comparisonId: 'baseline-vs-candidate',
        treatmentVariantId: treatmentSpec.variantId,
        metricId: 'family-length-score',
      }, {
        analysisId: 'correct-difference',
        comparisonId: 'baseline-vs-candidate',
        treatmentVariantId: treatmentSpec.variantId,
        metricId: 'correct',
      }] as const,
      confidence: {
        method: 'bonferroni-percentile-bootstrap' as const,
        level: 0.95,
        resamples: 64,
      },
    };
    const result = await evaluate({
      ...input,
      evaluators: [...input.evaluators, length],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['correct', 'family-length-score'],
      }],
      analyses: [family],
      decision: {
        decisionKind: 'comparison-family',
        analysisId: 'release-family',
        rule: 'all',
        criteria: [{
          analysisId: 'length-difference',
          minimumEffect: -100,
          maximumEffect: 100,
        }, {
          analysisId: 'correct-difference',
          minimumEffect: -100,
          maximumEffect: 100,
        }],
      }
    }, {
      runId: 'simultaneous-family',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.analysisGraph.nodes).toHaveLength(3);
    expect(result.definition.analysisGraph).toEqual({
      analysisMode: 'preregistered',
      nodes: [{
        analysisNodeKind: 'estimator',
        nodeId: stableFacadeId('node', { analysisId: 'correct-difference' }),
        implementationId: 'bootstrap.paired-difference-percentile/v1',
        inputs: [{
          inputKind: 'metric-observations',
          referenceId: 'correct',
        }, {
          inputKind: 'comparison',
          referenceId: 'baseline-vs-candidate',
          treatmentTargetId: 'prompt-v2',
          metricId: 'correct',
        }],
        outputResultId: 'correct-difference',
        parameters: { alpha: 0.025, resamples: 64 },
      }, {
        analysisNodeKind: 'estimator',
        nodeId: stableFacadeId('node', { analysisId: 'length-difference' }),
        implementationId: 'bootstrap.paired-difference-percentile/v1',
        inputs: [{
          inputKind: 'metric-observations',
          referenceId: 'family-length-score',
        }, {
          inputKind: 'comparison',
          referenceId: 'baseline-vs-candidate',
          treatmentTargetId: 'prompt-v2',
          metricId: 'family-length-score',
        }],
        outputResultId: 'length-difference',
        parameters: { alpha: 0.025, resamples: 64 },
      }, {
        analysisNodeKind: 'correction',
        nodeId: stableFacadeId('node', { analysisId: 'release-family' }),
        implementationId: 'simultaneous-intervals.bonferroni/v1',
        inputs: [{
          inputKind: 'analysis-result',
          referenceId: 'correct-difference',
        }, {
          inputKind: 'analysis-result',
          referenceId: 'length-difference',
        }],
        outputResultId: 'release-family',
        parameters: { familyConfidenceLevel: 0.95, resamples: 64 },
      }].sort((left, right) => (
        left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0
      )),
    });
    const memberNodes = result.definition.analysisGraph.nodes.filter(
      (node) => node.analysisNodeKind === 'estimator',
    );
    expect(memberNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outputResultId: 'correct-difference',
          implementationId: 'bootstrap.paired-difference-percentile/v1',
          parameters: expect.objectContaining({ alpha: 0.025, resamples: 64 }),
        }),
        expect.objectContaining({
          outputResultId: 'length-difference',
          implementationId: 'bootstrap.paired-difference-percentile/v1',
          parameters: expect.objectContaining({ alpha: 0.025, resamples: 64 }),
        }),
      ]),
    );
    expect(result.definition.analysisGraph.nodes.find(
      (node) => node.outputResultId === 'release-family',
    )).toMatchObject({
      analysisNodeKind: 'correction',
      implementationId: 'simultaneous-intervals.bonferroni/v1',
      inputs: [
        { inputKind: 'analysis-result', referenceId: 'correct-difference' },
        { inputKind: 'analysis-result', referenceId: 'length-difference' },
      ],
      outputResultId: 'release-family',
      parameters: { familyConfidenceLevel: 0.95, resamples: 64 },
    });
    expect(result.definition.decisionPolicy).toEqual({
      decisionPolicyId: stableFacadeId('decision', {
        decisionKind: 'comparison-family',
        resultId: 'release-family',
      }),
      implementationId: 'release-family/v1',
      analysisResultIds: ['release-family'],
      comparisonFamily: [{
        comparisonId: 'baseline-vs-candidate',
        treatmentTargetId: 'prompt-v2',
        metricId: 'correct',
        analysisResultId: 'correct-difference',
      }, {
        comparisonId: 'baseline-vs-candidate',
        treatmentTargetId: 'prompt-v2',
        metricId: 'family-length-score',
        analysisResultId: 'length-difference',
      }],
      comparisonFamilyResultId: 'release-family',
      multipleComparisonPolicyId: 'simultaneous-intervals.bonferroni/v1',
      minimumEvidenceStatus: 'complete',
      parameters: {
        rule: 'all',
        criteria: [{
          analysisResultId: 'correct-difference',
          minimumEffect: -100,
          maximumEffect: 100,
        }, {
          analysisResultId: 'length-difference',
          minimumEffect: -100,
          maximumEffect: 100,
        }],
      },
    });
    expect(result.analysisResults['correct-difference']).toMatchObject({
      analysisStatus: 'completed',
      value: { confidenceLevel: 0.975, resamples: 64, unitCount: 2 },
    });
    expect(result.analysisResults['release-family']).toMatchObject({
      analysisStatus: 'completed',
      resultType: 'table',
      value: {
        adjustmentMethod: 'bonferroni',
        familyConfidenceLevel: 0.95,
        marginalConfidenceLevel: 0.975,
        familySize: 2,
        resamples: 64,
        members: [
          { analysisResultId: 'correct-difference' },
          { analysisResultId: 'length-difference' },
        ],
      },
    });
    const familyRecord = result.analysisResults['release-family'];
    if (familyRecord?.analysisStatus !== 'completed') throw new Error('missing family result');
    const familyMembers = (familyRecord.value as {
      members: Array<{ analysisResultId: string; interval: JsonValue; }>;
    }).members;
    for (const member of familyMembers) {
      const memberRecord = result.analysisResults[member.analysisResultId];
      if (memberRecord?.analysisStatus !== 'completed') throw new Error('missing member result');
      expect(member.interval).toEqual(memberRecord.value);
    }
    expect(result.artifacts.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'RELEASE',
      reasonCodes: ['all-family-criteria-acceptable'],
    });
    expect(result.report.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'RELEASE',
    });

    const reversed = await evaluate({
      ...input,
      evaluators: [...input.evaluators, length],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['correct', 'family-length-score'],
      }],
      analyses: [{
        ...family,
        members: [family.members[1], family.members[0]],
      }],
      decision: {
        decisionKind: 'comparison-family',
        analysisId: 'release-family',
        rule: 'all',
        criteria: [{
          analysisId: 'correct-difference',
          minimumEffect: -100,
          maximumEffect: 100,
        }, {
          analysisId: 'length-difference',
          minimumEffect: -100,
          maximumEffect: 100,
        }],
      }
    }, {
      runId: 'simultaneous-family',
      clock: fixedClock
    });
    expect(reversed.definition).toEqual(result.definition);
  });

it('uses independent arm resampling for every member of an independent family', async () => {
    const input = pairedInput();
    const length = numericCustomEvaluator('independent-family-length', ({ bindings }) => ({
      resultKind: 'completed',
      results: [{
        metricId: 'independent-family-length-score',
        resultKind: 'score',
        value: bindings.actual.length,
      }],
    }));
    const result = await evaluate({
      ...input,
      dataset: {
        datasetId: 'independent-family',
        samples: Array.from({ length: 8 }, (_, index) => ({
          sampleId: `sample-${index + 1}`,
          input: { prompt: index % 2 === 0 ? 'one' : 'two' },
          expected: index % 2 === 0 ? 'A' : 'B',
        })),
      },
      evaluators: [...input.evaluators, length],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['correct', 'independent-family-length-score'],
      }],
      analyses: [{
        analysisId: 'independent-release-family',
        analysisKind: 'comparison-family',
        statistic: 'mean-difference',
        members: [{
          analysisId: 'independent-correct',
          comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'correct',
        }, {
          analysisId: 'independent-length',
          comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'independent-family-length-score',
        }],
        confidence: {
          method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 32,
        },
      }],
      experiment: {
        seed: 'independent-family-seed',
        sampling: {
          samplingKind: 'independent',
          allocations: [
            { variantId: controlSpec.variantId, weight: 1 },
            { variantId: treatmentSpec.variantId, weight: 1 },
          ],
          minimumSamplesPerVariant: 2,
          minimumSamplesPerVariantPerStratum: 1,
        },
      },
      decision: undefined
    }, {
      runId: 'independent-family',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.analysisGraph.nodes.filter(
      (node) => node.analysisNodeKind === 'estimator',
    ).every(
      (node) => node.implementationId === 'bootstrap.unpaired-difference-percentile/v1',
    )).toBe(true);
    expect(result.analysisResults['independent-release-family']).toMatchObject({
      analysisStatus: 'completed',
      value: { familyConfidenceLevel: 0.95, marginalConfidenceLevel: 0.975 },
    });
  });

it('keeps evaluator panel replicates inside the hierarchical family member', async () => {
    const input = pairedInput();
    const judge = {
      judgeId: 'test.family-panel/v1',
      version: '1.0.0',
      providerCost: { reporting: 'optional' as const },
      async invoke() {
        return { invocationStatus: 'completed' as const, output: '{"scores":[{"metricId":"family-quality","score":4,"reason":"ok"}]}' };
      },
    };
    const panel = {
      evaluatorKind: 'rubric-judge',
      evaluatorId: 'family-panel',
      rubrics: [{ metricId: 'family-quality',  criterionId: 'quality', prompt: 'Judge quality.', rubric: '5 is best.'  }],

      judges: [
        { memberId: 'judge-a', model: 'judge-a', judge, replicateCount: 2 },
        { memberId: 'judge-b', model: 'judge-b', judge, replicateCount: 1 },
      ],
      aggregation: { method: 'mean', missing: 'require-complete' },
    } satisfies RubricJudgeEvaluator;
    const result = await evaluate({
      ...input,
      evaluators: [...input.evaluators, panel],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['correct', 'family-quality'],
      }],
      analyses: [{
        analysisId: 'panel-release-family',
        analysisKind: 'comparison-family',
        statistic: 'mean-difference',
        members: [{
          analysisId: 'panel-correct',
          comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'correct',
        }, {
          analysisId: 'panel-quality',
          comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'family-quality',
        }],
        confidence: {
          method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 32,
        },
      }],
      experiment: { seed: 'panel-family-seed', trials: 2, sampling: { samplingKind: 'paired' } },
      decision: undefined
    }, {
      runId: 'panel-family',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.analysisGraph.nodes.find(
      (node) => node.outputResultId === 'panel-correct',
    )?.implementationId).toBe('bootstrap.paired-difference-percentile/v1');
    expect(result.definition.analysisGraph.nodes.find(
      (node) => node.outputResultId === 'panel-quality',
    )?.implementationId).toBe('bootstrap.hierarchical-paired-difference-percentile/v1');
    expect(result.analysisResults['panel-quality']).toMatchObject({
      analysisStatus: 'completed',
      value: { unitCount: 2, confidenceLevel: 0.975 },
    });
    expect(result.analysisResults['panel-release-family']).toMatchObject({
      analysisStatus: 'completed',
      value: { familySize: 2 },
    });
  });

it('does not publish a simultaneous family when one member is inconclusive', async () => {
    const input = pairedInput();
    const incomplete = numericCustomEvaluator(
      'incomplete-family',
      ({ sampleId, bindings }) => sampleId === 'two'
        ? {
          resultKind: 'completed',
          results: [{ metricId: 'incomplete-family-score', resultKind: 'missing', reasonCode: 'not-available' }],
        }
        : {
          resultKind: 'completed',
          results: [{ metricId: 'incomplete-family-score', resultKind: 'score', value: bindings.actual.length }],
        },
    );
    const result = await evaluate({
      ...input,
      evaluators: [...input.evaluators, incomplete],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['correct', 'incomplete-family-score'],
      }],
      analyses: [{
        analysisId: 'incomplete-release-family',
        analysisKind: 'comparison-family',
        statistic: 'mean-difference',
        members: [{
          analysisId: 'complete-member',
          comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'correct',
        }, {
          analysisId: 'incomplete-member',
          comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'incomplete-family-score',
        }],
        confidence: {
          method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 32,
        },
      }],
      decision: {
        decisionKind: 'comparison-family',
        analysisId: 'incomplete-release-family',
        rule: 'all',
        criteria: [{
          analysisId: 'complete-member',
          minimumEffect: -100,
          maximumEffect: 100,
        }, {
          analysisId: 'incomplete-member',
          minimumEffect: -100,
          maximumEffect: 100,
        }],
      }
    }, {
      runId: 'incomplete-family',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.analysisResults['complete-member']).toMatchObject({
      analysisStatus: 'completed',
    });
    expect(result.analysisResults['incomplete-member']).toMatchObject({
      analysisStatus: 'inconclusive',
    });
    expect(result.analysisResults['incomplete-release-family']).toMatchObject({
      analysisStatus: 'not-evaluated',
      reasonCodes: ['analysis-parent-not-completed'],
    });
    expect(result.artifacts.decision).toMatchObject({
      decisionStatus: 'not-decided',
      reasonCodes: expect.arrayContaining([
        'decision-analysis-result-unavailable',
        'decision-evidence-gate-failed',
      ]),
    });
  });

it('seals one stable Variant assignment per sample for independent comparisons', async () => {
    const calls: Array<{ sampleId: string; variantId: string; trialIndex: number; }> = [];
    const declaration = executor(async (invocation) => {
      calls.push({
        sampleId: invocation.sampleId,
        variantId: invocation.variantId,
        trialIndex: invocation.trialIndex,
      });
      return { output: invocation.config.answers[invocation.input.prompt] };
    });
    const input = pairedInput(declaration);
    const baseLength = numericCustomEvaluator('independent-length', ({ bindings }) => ({
      resultKind: 'completed',
      results: [{ metricId: 'independent-length-score', resultKind: 'score', value: bindings.actual.length }],
    }));
    const length: CustomEvaluator<{ actual: string }> = {
      ...baseLength,
      metrics: [{
        metricId: 'independent-length-score',
        valueType: 'numeric',
        scale: { min: 0, max: 5 },
        direction: 'lower-is-better',
        missingPolicyId: 'exclude/v1',
      }],
    };
    const result = await evaluate({
      ...input,
      dataset: {
        datasetId: 'independent-answers',
        samples: Array.from({ length: 6 }, (_, index) => ({
          sampleId: `sample-${index + 1}`,
          input: { prompt: index % 2 === 0 ? 'one' : 'two' },
          expected: index % 2 === 0 ? 'A' : 'B',
        })),
      },
      comparisons: [{
        ...input.comparisons[0],
      }],
      evaluators: [...input.evaluators, length],
      experiment: {
        seed: 'independent-seed',
        trials: 2,
        sampling: {
          samplingKind: 'independent',
          allocations: [
            { variantId: controlSpec.variantId, weight: 1 },
            { variantId: treatmentSpec.variantId, weight: 1 },
          ],
          minimumSamplesPerVariant: 2,
          minimumSamplesPerVariantPerStratum: 1,
        },
      },
      analyses: [...input.analyses, {
        analysisId: 'candidate-independent-quality',
        analysisKind: 'quality-interval',
        statistic: 'mean',
        variantId: treatmentSpec.variantId,
        metricId: 'correct',
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }, {
        analysisId: 'independent-overall-difference',
        analysisKind: 'composite-comparison-interval',
        compositeMetricId: 'independent-overall-quality',
        comparisonId: 'baseline-vs-candidate',
        treatmentVariantId: treatmentSpec.variantId,
        components: [{ metricId: 'correct', weight: 0.5 }, {
          metricId: 'independent-length-score', weight: 0.5,
        }],
        aggregation: { method: 'weighted-mean', missing: 'require-complete' },
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }],
      decision: undefined
    }, {
      runId: 'independent-assignment',
      clock: fixedClock
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.experiment.assignment).toMatchObject({
      assignmentKind: 'independent-groups',
      algorithmId: 'assignment.stratified-fixed-quota/v1',
      minimumUnitsPerTarget: 2,
      minimumUnitsPerTargetPerStratum: 1,
    });
    expect(result.definition.experiment.sampling).toMatchObject({
      estimatorId: 'bootstrap.unpaired-difference-percentile/v1',
      resamplingUnit: 'sample',
      seedCoupling: 'independent-by-target',
    });
    expect(result.artifacts.execution.records).toHaveLength(12);
    expect(calls).toHaveLength(12);
    const variantsBySample = new Map<string, Set<string>>();
    for (const call of calls) {
      const variants = variantsBySample.get(call.sampleId) ?? new Set<string>();
      variants.add(call.variantId);
      variantsBySample.set(call.sampleId, variants);
    }
    expect([...variantsBySample.values()].every((variants) => variants.size === 1)).toBe(true);
    expect([...new Set(calls.filter((call) => call.trialIndex === 0).map((call) => call.variantId))])
      .toHaveLength(2);
    expect(calls.filter((call) => call.variantId === controlSpec.variantId)).toHaveLength(6);
    expect(calls.filter((call) => call.variantId === treatmentSpec.variantId)).toHaveLength(6);
    expect(result.artifacts.analysis.records[0]).toMatchObject({ analysisStatus: 'completed' });
    expect(result.analysisResults['candidate-independent-quality']).toMatchObject({
      analysisStatus: 'completed',
      value: { unitCount: 3 },
    });
    expect(result.definition.analysisGraph.nodes.find(
      (node) => node.outputResultId === 'independent-overall-difference',
    )?.implementationId).toBe('bootstrap.composite-unpaired-difference-percentile/v2');
    expect(result.analysisResults['independent-overall-difference']).toMatchObject({
      analysisStatus: 'completed',
      value: { unitCount: 6 },
      coverage: { included: 24, comparable: 24 },
    });
  });
});
