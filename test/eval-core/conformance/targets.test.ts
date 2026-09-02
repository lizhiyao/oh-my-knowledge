import { describe, expect, it } from 'vitest';
import {
  parseEvaluationReport,
  effectiveAnalysisBundleTrust,
  effectiveDecisionResultTrust,
  effectiveEvaluationBundleTrust,
  effectiveExecutionBundleTrust,
  verifyAnalysisBundle,
  verifyDecisionResult,
  verifyEvaluationBundle,
  verifyExecutionBundle,
  type Sha256Digest,
} from '../../../src/eval-core/contracts/index.js';
import {
  createBuiltinAnalysisSchemaValidators,
  materializeEvaluationReport,
} from '../../../src/eval-core/analysis/index.js';
import {
  runConformanceScenario,
  type ConformanceTarget,
} from './harness.js';
import { ConformanceFaultInjector } from './fault-injector.js';

const targets: ConformanceTarget[] = ['function', 'rag', 'agent'];

describe.each(targets)('Evaluation Core %s target conformance', (target) => {
  it('completes prepare, execute, evaluate, analyze, decide, and report', async () => {
    const result = await runConformanceScenario(target);

    expect(result.execution.executionBundleStatus).toBe('completed');
    expect(result.evaluation.evaluationBundleStatus).toBe('completed');
    expect(result.analysis.analysisBundleStatus).toBe('completed');
    expect(result.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
    });
    expect(result.report.status).toEqual({
      runStatus: 'completed',
      evidenceStatus: 'complete',
      conclusionStatus: 'conclusive',
    });
    expect(result.report.provenance.parentDigests).toEqual([
      result.execution.bundleDigest,
      result.evaluation.bundleDigest,
      result.analysis.bundleDigest,
      result.decision?.decisionDigest,
    ]);
  });

  it('uses the same lifecycle and event protocol without exposing gold to executors', async () => {
    const result = await runConformanceScenario(target, { suffix: `${target}-protocol` });

    expect(result.state).toMatchObject({
      executorRunOpens: result.plan.execution.targets.length,
      executorRunDisposals: result.plan.execution.targets.length,
      trialOpens: 4,
      trialDisposals: 4,
      executorAttempts: 4,
      evaluatorRunOpens: target === 'agent' ? 2 : 1,
      evaluatorRunDisposals: target === 'agent' ? 2 : 1,
      recordOpens: target === 'agent' ? 8 : 4,
      recordDisposals: target === 'agent' ? 8 : 4,
      evaluatorAttempts: target === 'agent' ? 8 : 4,
    });
    expect(result.state.trialContexts.every((context) => (
      !('expected' in context) && !('evaluationContext' in context)
    ))).toBe(true);
    expect(result.events.map((event) => event.sequence)).toEqual(
      result.events.map((_, index) => index),
    );
    expect(result.events.at(-1)?.eventKind).toBe('report.materialized');
  });

  it('revalidates every serialized artifact from sealed parent facts', async () => {
    const result = await runConformanceScenario(target, { suffix: `${target}-import` });
    const execution = JSON.parse(JSON.stringify(result.execution)) as unknown;
    const evaluation = JSON.parse(JSON.stringify(result.evaluation)) as unknown;
    const analysis = JSON.parse(JSON.stringify(result.analysis)) as unknown;
    const report = JSON.parse(JSON.stringify(result.report)) as unknown;
    const validators = createBuiltinAnalysisSchemaValidators();

    const executionSource = verifyExecutionBundle(execution, result.plan, {
      verifiedProvenanceBundleDigests: new Set([
        result.execution.bundleDigest as Sha256Digest,
      ]),
    });
    const evaluationSource = verifyEvaluationBundle(evaluation, result.plan, executionSource, {
      verifiedProvenanceBundleDigests: new Set([
        result.evaluation.bundleDigest as Sha256Digest,
      ]),
      executionSourceTrust: effectiveExecutionBundleTrust(executionSource),
    });
    expect(executionSource.bundle).toEqual(result.execution);
    expect(evaluationSource.bundle).toEqual(result.evaluation);
    const analysisSource = verifyAnalysisBundle(
      analysis,
      result.plan,
      executionSource,
      evaluationSource,
      { schemaValidators: validators },
      {
        verifiedProvenanceBundleDigests: new Set([
          result.analysisSource.bundle.bundleDigest as Sha256Digest,
        ]),
      },
    );
    if (result.decisionSource === undefined) throw new Error('missing Decision source');
    const decisionSource = verifyDecisionResult(
      result.decision,
      result.plan,
      executionSource,
      evaluationSource,
      analysisSource,
      {
        verifiedPolicyExecutionDigests: new Set([
          result.decisionSource.result.decisionDigest as Sha256Digest,
        ]),
      },
    );
    expect(analysisSource.bundle).toEqual(result.analysis);
    expect(decisionSource.result).toEqual(result.decision);
    expect(parseEvaluationReport(
      report,
      result.plan,
      executionSource,
      evaluationSource,
      analysisSource,
      decisionSource,
    )).toEqual(result.report);
  });
});

describe('Evaluation Core provenance conformance', () => {
  it('does not let child attestations upgrade transported parent trust', async () => {
    const result = await runConformanceScenario('function', {
      suffix: 'child-attestation-ceiling',
    });
    const executionSource = verifyExecutionBundle(
      structuredClone(result.execution),
      result.plan,
    );
    const evaluationSource = verifyEvaluationBundle(
      structuredClone(result.evaluation),
      result.plan,
      executionSource,
      {
        verifiedProvenanceBundleDigests: new Set([
          result.evaluation.bundleDigest as Sha256Digest,
        ]),
      },
    );
    const analysisSource = verifyAnalysisBundle(
      structuredClone(result.analysis),
      result.plan,
      executionSource,
      evaluationSource,
      { schemaValidators: createBuiltinAnalysisSchemaValidators() },
      {
        verifiedProvenanceBundleDigests: new Set([
          result.analysis.bundleDigest as Sha256Digest,
        ]),
      },
    );

    expect(effectiveExecutionBundleTrust(executionSource)).toBe('unknown');
    expect(evaluationSource.planVerification).toMatchObject({
      provenanceTrustStatus: 'verified',
      executionSourceTrust: 'unknown',
    });
    expect(effectiveEvaluationBundleTrust(evaluationSource)).toBe('unknown');
    expect(analysisSource.planVerification).toEqual({
      provenanceTrustStatus: 'verified',
      evaluationSourceTrust: 'unknown',
    });
    expect(effectiveAnalysisBundleTrust(analysisSource)).toBe('unknown');
  });

  it('keeps an unattested non-directional Decision parent at unknown trust', async () => {
    const result = await runConformanceScenario('function', {
      suffix: 'transported-decision-trust',
      mutate(_definition, policy) {
        policy.budget.stages.evaluation.maxInvocations = 1;
      },
    });
    if (result.decision === undefined || result.decisionSource === undefined) {
      throw new Error('missing Decision source');
    }
    expect(result.decision.decisionStatus).toBe('not-decided');
    const transported = verifyDecisionResult(
      structuredClone(result.decision),
      result.plan,
      result.executionSource,
      result.evaluationSource,
      result.analysisSource,
    );
    expect(effectiveDecisionResultTrust(transported)).toBe('unknown');

    const transportedReport = materializeEvaluationReport(
      result.plan,
      result.executionSource,
      result.evaluationSource,
      result.analysisSource,
      transported,
      { clock: { timestamp: () => '2026-08-29T00:00:00.000Z' } },
      { reportId: 'report-transported-decision-trust' },
    );
    expect(transportedReport.provenance.trust).toBe('unknown');

    const attested = verifyDecisionResult(
      structuredClone(result.decision),
      result.plan,
      result.executionSource,
      result.evaluationSource,
      result.analysisSource,
      {
        verifiedPolicyExecutionDigests: new Set([
          result.decision.decisionDigest as Sha256Digest,
        ]),
      },
    );
    expect(effectiveDecisionResultTrust(attested)).toBe('declared');
    expect(materializeEvaluationReport(
      result.plan,
      result.executionSource,
      result.evaluationSource,
      result.analysisSource,
      attested,
      { clock: { timestamp: () => '2026-08-29T00:00:00.000Z' } },
      { reportId: 'report-attested-decision-trust' },
    ).provenance.trust).toBe('declared');
  });
});

describe('Target-specific evidence conformance', () => {
  it('evaluates RAG top-K with Recall, Precision, MRR, and NDCG evidence', async () => {
    const result = await runConformanceScenario('rag');
    const observations = result.evaluation.records.flatMap((record) => (
      record.evaluationStatus === 'completed' ? record.observations : []
    ));

    expect(new Set(observations.map((observation) => observation.metricId))).toEqual(new Set([
      'recall-at-k',
      'precision-at-k',
      'mrr',
      'ndcg',
    ]));
    expect(observations.every((observation) => (
      observation.observationStatus === 'observed'
      && observation.valueType === 'numeric'
      && observation.value >= 0
      && observation.value <= 1
    ))).toBe(true);
    expect(result.analysis.records).toHaveLength(4);
  });

  it('evaluates an agent trajectory from output, trace, and gold bindings', async () => {
    const result = await runConformanceScenario('agent', {
      faults: new ConformanceFaultInjector(),
      mutate(_definition, policy) {
        policy.eventDelivery.writerMode = 'required';
        policy.eventDelivery.writerFailureMode = 'fail-run';
      },
    });

    expect(result.state.trialContexts.every((context) => (
      context.protocolId === 'omk.session/v1'
    ))).toBe(true);
    const trajectory = result.state.recordContexts.filter((context) => (
      context.evaluatorId === 'trajectory'
    ));
    const outputOnly = result.state.recordContexts.filter((context) => (
      context.evaluatorId === 'answer-shape'
    ));
    expect(trajectory.every((context) => (
      context.bindings.map((entry) => entry.sourceKind).join(',')
        === 'output,trace,expected'
    ))).toBe(true);
    expect(outputOnly.every((context) => (
      context.bindings.map((entry) => entry.sourceKind).join(',') === 'output'
    ))).toBe(true);
    expect(result.execution.records.every((record) => (
      record.executionStatus === 'completed' && record.trace !== undefined
    ))).toBe(true);
    expect(JSON.stringify(result.execution)).toContain('working');
    expect(JSON.stringify(result.events)).not.toContain('working');
    expect(JSON.stringify(result.state.writtenEvents)).not.toContain('working');
    expect(JSON.stringify(result.report)).not.toContain('working');
  });

  it('keeps the function fixture trace-free', async () => {
    const result = await runConformanceScenario('function');

    expect(result.state.trialContexts.every((context) => (
      context.protocolId === 'omk.invoke/v1'
    ))).toBe(true);
    expect(result.execution.records.every((record) => (
      record.executionStatus === 'completed' && record.trace === undefined
    ))).toBe(true);
  });
});
