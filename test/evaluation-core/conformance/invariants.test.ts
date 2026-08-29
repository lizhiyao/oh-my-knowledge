import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../../../src/evaluation-core/contracts/index.js';
import {
  prepareConformancePlan,
  revalidateConformanceResult,
  runConformanceScenario,
} from './harness.js';
import { ConformanceFaultInjector } from './fault-injector.js';

const stageDigestFields = [
  'executionPlanDigest',
  'evaluationPlanDigest',
  'analysisPlanDigest',
  'decisionPlanDigest',
  'runContractDigest',
] as const;

describe('Evaluation Core cross-stage conformance invariants', () => {
  it('canonicalizes JSON property order and excludes annotations from measurement identity', async () => {
    expect(digestCanonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(
      digestCanonicalJson({ b: { d: 3, c: 2 }, a: 1 }),
    );
    const before = await prepareConformancePlan('function');
    const after = await prepareConformancePlan('function', (definition) => {
      definition.dataset.annotations = { changed: true };
      definition.dataset.samples[0].annotations = { owner: 'another-team' };
    });

    for (const field of stageDigestFields) {
      expect(after.digests[field], field).toBe(before.digests[field]);
    }
    expect(after.digests.datasetRevisionDigest).not.toBe(before.digests.datasetRevisionDigest);
  });

  it('invalidates Gold and evaluator changes only from Evaluation downstream', async () => {
    const baseline = await prepareConformancePlan('function');
    const changedGold = await prepareConformancePlan('function', (definition) => {
      definition.dataset.samples[0].expected = { answer: 'different' };
    });
    const changedEvaluator = await prepareConformancePlan('function', (definition) => {
      definition.evaluators[0].config = { strict: true };
    });

    for (const changed of [changedGold, changedEvaluator]) {
      expect(changed.digests.executionPlanDigest).toBe(
        baseline.digests.executionPlanDigest,
      );
      for (const field of stageDigestFields.slice(1)) {
        expect(changed.digests[field], field).not.toBe(baseline.digests[field]);
      }
    }
  });

  it('invalidates Execution and every downstream stage for an executor fingerprint change', async () => {
    const before = await prepareConformancePlan('function', undefined, 'executor-fingerprint-a');
    const after = await prepareConformancePlan('function', undefined, 'executor-fingerprint-b');

    for (const field of stageDigestFields) {
      expect(after.digests[field], field).not.toBe(before.digests[field]);
    }
  });

  it('caps the full report provenance at the Executor Runtime assurance', async () => {
    const result = await runConformanceScenario('function', {
      suffix: 'unknown-executor-assurance',
      executorAssurance: 'unknown',
    });

    expect(result.execution.records.every((record) => (
      record.executionStatus === 'budget-censored'
        || record.provenance.trust === 'unknown'
    ))).toBe(true);
    expect(result.execution.provenance.trust).toBe('unknown');
    expect(result.executionSource.planVerification.provenanceTrustStatus).toBe('verified');
    expect(result.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
    });
    expect(revalidateConformanceResult(result)).toEqual(result.report);
    expect(result.report.provenance.trust).toBe('unknown');
  });

  it('re-scores changed Gold without invoking the Target again', async () => {
    const baseline = await runConformanceScenario('function', { suffix: 'rescore-source' });
    const rescored = await runConformanceScenario('function', {
      suffix: 'rescore-result',
      executionSource: baseline.executionSource,
      mutate(definition) {
        definition.dataset.samples[0].expected = { answer: 'wrong-a' };
        definition.dataset.samples[1].expected = { answer: 'wrong-b' };
      },
    });

    expect(rescored.state.executorAttempts).toBe(0);
    expect(rescored.execution.bundleDigest).toBe(baseline.execution.bundleDigest);
    expect(rescored.evaluation.bundleDigest).not.toBe(baseline.evaluation.bundleDigest);
    expect(rescored.analysis.bundleDigest).not.toBe(baseline.analysis.bundleDigest);
    expect(rescored.decision?.decisionDigest).not.toBe(baseline.decision?.decisionDigest);
    expect(rescored.report.reportDigest).not.toBe(baseline.report.reportDigest);
    expect(rescored.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'REGRESSION',
    });
  });

  it('does not treat repeated trials as independent resampling units', async () => {
    const result = await runConformanceScenario('function', {
      suffix: 'repeated-trials',
      mutate(definition) {
        definition.experiment.trials = 3;
        definition.experiment.sampling.repeatedMeasures = true;
        definition.analysisGraph.nodes = [{
          analysisNodeKind: 'estimator',
          nodeId: 'bootstrap-correct',
          implementationId: 'bootstrap.mean-percentile/v1',
          inputs: [{ inputKind: 'metric-observations', referenceId: 'correct' }],
          outputResultId: 'correct-interval',
          parameters: { resamples: 64, alpha: 0.1 },
        }];
        definition.decisionPolicy!.analysisResultIds = ['correct-interval'];
      },
    });
    const record = result.analysis.records[0];

    expect(result.execution.records).toHaveLength(12);
    expect(record.analysisStatus).toBe('completed');
    if (record.analysisStatus !== 'completed'
        || record.value === null
        || Array.isArray(record.value)
        || typeof record.value !== 'object') {
      throw new Error('Expected a completed interval result.');
    }
    expect(record.value.unitCount).toBe(2);
  });

  it('uses declared clusters as the end-to-end bootstrap unit', async () => {
    const result = await runConformanceScenario('function', {
      suffix: 'cluster-bootstrap',
      mutate(definition) {
        definition.dataset.samples = [
          ...definition.dataset.samples,
          {
            ...structuredClone(definition.dataset.samples[0]),
            sampleId: 'sample-3',
          },
          {
            ...structuredClone(definition.dataset.samples[1]),
            sampleId: 'sample-4',
          },
        ];
        for (const [index, sample] of definition.dataset.samples.entries()) {
          sample.input = {
            ...(sample.input as Record<string, unknown>),
            cluster: index % 2 === 0 ? 'cluster-a' : 'cluster-b',
          };
        }
        definition.experiment.sampling.experimentalUnit = 'cluster';
        definition.experiment.sampling.clusterKey = '/input/cluster';
        definition.experiment.sampling.resamplingUnit = 'cluster';
        definition.experiment.sampling.estimatorId = 'bootstrap.cluster-percentile/v1';
        delete definition.experiment.sampling.pairingKey;
        definition.analysisGraph.nodes = [{
          analysisNodeKind: 'estimator',
          nodeId: 'cluster-bootstrap-correct',
          implementationId: 'bootstrap.cluster-percentile/v1',
          inputs: [{ inputKind: 'metric-observations', referenceId: 'correct' }],
          outputResultId: 'cluster-correct-interval',
          parameters: { resamples: 64, alpha: 0.1 },
        }];
        definition.decisionPolicy!.analysisResultIds = ['cluster-correct-interval'];
      },
    });
    const record = result.analysis.records[0];

    expect(result.execution.records).toHaveLength(8);
    const clusterIds = new Map(result.execution.records.map((entry) => [
      entry.sampleId,
      entry.samplingUnitIds.clusterId,
    ]));
    expect(new Set(clusterIds.values()).size).toBe(2);
    expect(clusterIds.get('sample-1')).toBe(clusterIds.get('sample-3'));
    expect(clusterIds.get('sample-2')).toBe(clusterIds.get('sample-4'));
    expect(record.analysisStatus).toBe('completed');
    if (record.analysisStatus !== 'completed'
        || record.value === null
        || Array.isArray(record.value)
        || typeof record.value !== 'object') {
      throw new Error('Expected a completed cluster interval result.');
    }
    expect(record.value).toEqual({
      estimate: 0.5,
      lower: 0.5,
      upper: 0.5,
      confidenceLevel: 0.9,
      resamples: 64,
      unitCount: 2,
      method: 'percentile',
    });
    expect(result.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
    });
    expect(revalidateConformanceResult(result)).toEqual(result.report);
  });

  it('preserves a multiple-comparison family through correction and Decision lineage', async () => {
    const result = await runConformanceScenario('function', {
      suffix: 'multiple-comparison-family',
      mutate(definition) {
        definition.comparisons.push({
          ...structuredClone(definition.comparisons[0]),
          comparisonId: 'secondary-comparison',
        });
        definition.analysisGraph.nodes = [
          {
            analysisNodeKind: 'estimator',
            nodeId: 'hypothesis-primary',
            implementationId: 'conformance.hypothesis/v1',
            inputs: [
              { inputKind: 'metric-observations', referenceId: 'correct' },
              {
                inputKind: 'comparison',
                referenceId: 'control-vs-treatment',
                treatmentTargetId: 'treatment',
                metricId: 'correct',
              },
            ],
            outputResultId: 'hypothesis-primary-result',
            parameters: {},
          },
          {
            analysisNodeKind: 'estimator',
            nodeId: 'hypothesis-secondary',
            implementationId: 'conformance.hypothesis/v1',
            inputs: [
              { inputKind: 'metric-observations', referenceId: 'correct' },
              {
                inputKind: 'comparison',
                referenceId: 'secondary-comparison',
                treatmentTargetId: 'treatment',
                metricId: 'correct',
              },
            ],
            outputResultId: 'hypothesis-secondary-result',
            parameters: {},
          },
          {
            analysisNodeKind: 'correction',
            nodeId: 'bonferroni-family',
            implementationId: 'bonferroni/v1',
            inputs: [
              { inputKind: 'analysis-result', referenceId: 'hypothesis-primary-result' },
              { inputKind: 'analysis-result', referenceId: 'hypothesis-secondary-result' },
            ],
            outputResultId: 'corrected-family',
            parameters: { alpha: 0.05 },
          },
        ];
        definition.decisionPolicy = {
          decisionPolicyId: 'family-gate',
          implementationId: 'conformance.family-gate/v1',
          analysisResultIds: ['corrected-family'],
          comparisonFamily: [
            {
              comparisonId: 'control-vs-treatment',
              treatmentTargetId: 'treatment',
              metricId: 'correct',
              analysisResultId: 'hypothesis-primary-result',
              hypothesisId: 'hypothesis-primary',
            },
            {
              comparisonId: 'secondary-comparison',
              treatmentTargetId: 'treatment',
              metricId: 'correct',
              analysisResultId: 'hypothesis-secondary-result',
              hypothesisId: 'hypothesis-secondary',
            },
          ],
          multipleComparisonPolicyId: 'bonferroni/v1',
          minimumEvidenceStatus: 'complete',
          parameters: {},
        };
      },
    });
    const correction = result.analysis.records.find((record) => (
      record.resultId === 'corrected-family'
    ));

    expect(correction).toMatchObject({
      analysisStatus: 'completed',
      value: {
        familySize: 2,
        hypotheses: [
          {
            hypothesisId: 'hypothesis-primary',
            rawPValue: 0.01,
            adjustedPValue: 0.02,
            rejected: true,
          },
          {
            hypothesisId: 'hypothesis-secondary',
            rawPValue: 0.04,
            adjustedPValue: 0.08,
            rejected: false,
          },
        ],
      },
    });
    expect(result.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
      analysisResultIds: ['corrected-family'],
    });
    expect(result.report.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
    });
    expect(revalidateConformanceResult(result)).toEqual(result.report);
  });

  it('censors an entire paired block and supports reversed Comparison roles', async () => {
    const result = await runConformanceScenario('function', {
      suffix: 'paired-budget',
      mutate(definition, policy) {
        definition.comparisons.push({
          comparisonId: 'reverse-comparison',
          controlTargetId: 'treatment',
          treatmentTargetIds: ['control'],
          metricIds: ['correct'],
        });
        definition.experiment.sampling.pairingKey = '/input/question';
        definition.experiment.sampling.resamplingUnit = 'paired-block';
        definition.experiment.sampling.estimatorId = 'bootstrap.paired-difference-percentile/v1';
        definition.experiment.sampling.seedCoupling = 'shared-within-block';
        policy.budget.maxTargetInvocations = 3;
      },
    });

    expect(result.plan.analysis.comparisons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        comparisonId: 'control-vs-treatment',
        controlTargetId: 'control',
        treatmentTargetIds: ['treatment'],
      }),
      expect.objectContaining({
        comparisonId: 'reverse-comparison',
        controlTargetId: 'treatment',
        treatmentTargetIds: ['control'],
      }),
    ]));
    expect(result.execution).toMatchObject({
      executionBundleStatus: 'budget-exhausted',
      coverage: { planned: 4, started: 2, succeeded: 2, budgetCensored: 2 },
    });
    const censored = result.execution.records.filter((record) => (
      record.executionStatus === 'budget-censored'
    ));
    expect(new Set(censored.map((record) => record.schedulingBlockId)).size).toBe(1);
    expect(new Set(censored.map((record) => record.targetId))).toEqual(
      new Set(['control', 'treatment']),
    );
    expect(result.decision?.decisionStatus).toBe('not-decided');
  });

  it('makes an entirely absent live Event consumer irrelevant to measurement results', async () => {
    const fast = await runConformanceScenario('rag', { suffix: 'consumer-speed' });
    const slow = await runConformanceScenario('rag', {
      suffix: 'consumer-speed',
      eventConsumption: 'after-result',
    });

    expect(slow.execution.bundleDigest).toBe(fast.execution.bundleDigest);
    expect(slow.evaluation.bundleDigest).toBe(fast.evaluation.bundleDigest);
    expect(slow.analysis.bundleDigest).toBe(fast.analysis.bundleDigest);
    expect(slow.decision?.decisionDigest).toBe(fast.decision?.decisionDigest);
    expect(slow.report.reportDigest).toBe(fast.report.reportDigest);
  });

  it('keeps Gold markers out of Execution, Events, Report, and errors', async () => {
    const marker = 'gold-secret-must-not-leak';
    const result = await runConformanceScenario('function', {
      suffix: 'gold-isolation',
      faults: new ConformanceFaultInjector(),
      mutate(definition, policy) {
        definition.dataset.samples[0].expected = { answer: marker };
        policy.eventDelivery.writerMode = 'required';
        policy.eventDelivery.writerFailureMode = 'fail-run';
      },
    });

    expect(JSON.stringify(result.execution)).not.toContain(marker);
    expect(JSON.stringify(result.events)).not.toContain(marker);
    expect(JSON.stringify(result.state.writtenEvents)).not.toContain(marker);
    expect(JSON.stringify(result.report)).not.toContain(marker);
  });

  it('prevents partial evidence from producing a directional verdict', async () => {
    const result = await runConformanceScenario('function', {
      suffix: 'partial-evidence',
      mutate(_definition, policy) {
        policy.evaluation.budget.maxEvaluatorInvocations = 1;
      },
    });

    expect(result.report.status.evidenceStatus).toBe('partial');
    expect(result.decision).toMatchObject({
      decisionStatus: 'not-decided',
      reasonCodes: expect.arrayContaining(['decision-evidence-gate-failed']),
    });
  });
});
