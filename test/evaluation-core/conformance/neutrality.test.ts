import { describe, expect, it } from 'vitest';
import type { EvaluationRecord } from '../../../src/evaluation-core/contracts/index.js';
import { ConformanceFaultInjector } from './fault-injector.js';
import {
  InMemoryConformanceEvaluationCache,
  prepareConformancePlan,
  runConformanceScenario,
  type ConformanceResult,
} from './harness.js';

const TARGET_KIND_ALIASES = [
  'function',
  'service',
  'model',
  'rag',
  'agent',
  'workflow',
  'future-target-7f3d',
] as const;

const EVALUATOR_KIND_ALIASES = [
  'assertion',
  'structured-scorer',
  'llm-judge',
] as const;

const EVALUATOR_USAGE = {
  inputTokens: 3,
  outputTokens: 2,
  totalTokens: 5,
  details: { source: 'deterministic-test-double' },
} as const;

function evaluationRecordProjection(record: EvaluationRecord) {
  if (record.evaluationStatus !== 'completed') {
    return {
      targetId: record.targetId,
      sampleId: record.sampleId,
      trialIndex: record.trialIndex,
      evaluatorId: record.evaluatorId,
      evaluationStatus: record.evaluationStatus,
      errorCode: 'error' in record ? record.error?.code : undefined,
    };
  }
  return {
    targetId: record.targetId,
    sampleId: record.sampleId,
    trialIndex: record.trialIndex,
    evaluatorId: record.evaluatorId,
    evaluationStatus: record.evaluationStatus,
    observations: record.observations.map(({ observationId: _observationId, ...observation }) => (
      observation
    )),
    usage: record.usage,
    attemptStatuses: record.attempts.map((attempt) => attempt.attemptStatus),
  };
}

function orchestrationSignature(result: ConformanceResult) {
  return {
    protocols: result.plan.execution.targets.map((target) => target.protocolId),
    executorRuntimes: result.plan.execution.runtimes
      .filter((runtime) => runtime.runtimeKind === 'executor')
      .map((runtime) => ({
        referenceId: runtime.referenceId,
        identity: runtime.identity,
      })),
    lifecycle: {
      executorRunOpens: result.state.executorRunOpens,
      executorRunDisposals: result.state.executorRunDisposals,
      trialOpens: result.state.trialOpens,
      trialDisposals: result.state.trialDisposals,
      executorAttempts: result.state.executorAttempts,
      evaluatorRunOpens: result.state.evaluatorRunOpens,
      evaluatorRunDisposals: result.state.evaluatorRunDisposals,
      recordOpens: result.state.recordOpens,
      recordDisposals: result.state.recordDisposals,
      evaluatorAttempts: result.state.evaluatorAttempts,
    },
    trialViews: result.state.trialContexts.map((context) => ({
      targetId: context.targetId,
      protocolId: context.protocolId,
      input: context.input,
      executionContext: context.executionContext,
      targetConfig: context.targetConfig,
      trialIndex: context.trialIndex,
      samplingUnitIds: context.samplingUnitIds,
    })),
    evaluatorViews: result.state.recordContexts.map((context) => ({
      targetId: context.targetId,
      sampleId: context.sampleId,
      trialIndex: context.trialIndex,
      evaluatorId: context.evaluatorId,
      evaluatorConfig: context.evaluatorConfig,
      bindings: context.bindings,
      metrics: context.metrics,
    })),
    execution: {
      status: result.execution.executionBundleStatus,
      coverage: result.execution.coverage,
      records: result.execution.records.map((record) => ({
        targetId: record.targetId,
        sampleId: record.sampleId,
        trialIndex: record.trialIndex,
        executionStatus: record.executionStatus,
        output: record.executionStatus === 'completed' ? record.output : undefined,
        trace: record.executionStatus === 'completed' ? record.trace : undefined,
        attemptStatuses: record.executionStatus === 'budget-censored'
          ? []
          : record.attempts.map((attempt) => attempt.attemptStatus),
      })),
    },
    evaluation: {
      status: result.evaluation.evaluationBundleStatus,
      coverage: result.evaluation.coverage,
      records: result.evaluation.records.map(evaluationRecordProjection),
    },
    decision: result.decision === undefined ? undefined : {
      status: result.decision.decisionStatus,
      verdict: result.decision.decisionStatus === 'decided'
        ? result.decision.verdict
        : undefined,
    },
    reportStatus: result.report.status,
    eventProtocol: result.events.map((event) => ({
      eventKind: event.eventKind,
      subjectKind: event.subject.subjectKind,
    })),
  };
}

describe('Evaluation Core Target／Evaluator neutrality conformance', () => {
  it('keeps orchestration invariant across descriptive targetKind aliases', async () => {
    const results = await Promise.all(TARGET_KIND_ALIASES.map(async (targetKind) => (
      runConformanceScenario('function', {
        suffix: `target-kind-${targetKind}`,
        mutate(definition) {
          definition.targets = definition.targets.map((target) => ({
            ...target,
            targetKind,
          }));
        },
      })
    )));
    const baseline = orchestrationSignature(results[0]);

    for (const [index, result] of results.entries()) {
      expect(result.plan.execution.targets.map((target) => target.targetKind)).toEqual([
        TARGET_KIND_ALIASES[index],
        TARGET_KIND_ALIASES[index],
      ]);
      expect(orchestrationSignature(result)).toEqual(baseline);
    }
  });

  it('uses one lifecycle, binding, usage, cache, and teardown contract for Evaluator kinds', async () => {
    const results = await Promise.all(EVALUATOR_KIND_ALIASES.map(async (evaluatorKind) => {
      const cache = new InMemoryConformanceEvaluationCache();
      const plan = await prepareConformancePlan('function', (definition, policy) => {
        definition.evaluators = definition.evaluators.map((evaluator) => ({
          ...evaluator,
          evaluatorKind,
        }));
        policy.cache.evaluationMode = 'reuse';
      });
      const source = await runConformanceScenario('function', {
        plan,
        runId: `evaluator-${evaluatorKind}-source`,
        suffix: `evaluator-${evaluatorKind}-source`,
        evaluationCache: new InMemoryConformanceEvaluationCache(),
        evaluatorUsage: EVALUATOR_USAGE,
      });
      const first = await runConformanceScenario('function', {
        plan,
        runId: `evaluator-${evaluatorKind}-first`,
        suffix: `evaluator-${evaluatorKind}-first`,
        execution: source.execution,
        evaluationCache: cache,
        evaluatorUsage: EVALUATOR_USAGE,
      });
      const replay = await runConformanceScenario('function', {
        plan,
        runId: `evaluator-${evaluatorKind}-replay`,
        suffix: `evaluator-${evaluatorKind}-replay`,
        execution: source.execution,
        evaluationCache: cache,
        evaluatorUsage: EVALUATOR_USAGE,
      });
      return { evaluatorKind, first, replay };
    }));
    const baseline = orchestrationSignature(results[0].first);

    for (const { evaluatorKind, first, replay } of results) {
      expect(first.plan.evaluation.evaluators.map((evaluator) => evaluator.evaluatorKind)).toEqual([
        evaluatorKind,
      ]);
      expect(orchestrationSignature(first)).toEqual(baseline);
      expect(first.state).toMatchObject({
        evaluatorRunOpens: 1,
        evaluatorRunDisposals: 1,
        recordOpens: 4,
        recordDisposals: 4,
        evaluatorAttempts: 4,
      });
      expect(first.state.recordContexts.every((context) => (
        context.bindings.map((binding) => binding.sourceKind).sort().join(',')
          === 'expected,output'
      ))).toBe(true);
      expect(first.evaluation.records.every((record) => (
        record.evaluationStatus === 'completed'
        && record.usage?.totalTokens === EVALUATOR_USAGE.totalTokens
        && record.attempts[0]?.usage?.totalTokens === EVALUATOR_USAGE.totalTokens
      ))).toBe(true);
      expect(replay.state).toMatchObject({
        evaluatorRunOpens: 0,
        evaluatorRunDisposals: 0,
        recordOpens: 0,
        recordDisposals: 0,
        evaluatorAttempts: 0,
      });
      expect(replay.evaluation.records.every((record) => (
        record.evaluationStatus === 'completed'
        && record.cache.cacheStatus === 'transparent-hit'
        && record.provenance.provenanceKind === 'replay'
      ))).toBe(true);
    }
  });

  it('contains Evaluator failures identically without a provider-specific path', async () => {
    const results = await Promise.all(EVALUATOR_KIND_ALIASES.map(async (evaluatorKind) => {
      const marker = `provider-secret-${evaluatorKind}`;
      const faults = new ConformanceFaultInjector().fail('evaluator-evaluate', marker);
      const result = await runConformanceScenario('function', {
        suffix: `evaluator-${evaluatorKind}-failure`,
        faults,
        evaluatorUsage: EVALUATOR_USAGE,
        mutate(definition) {
          definition.evaluators = definition.evaluators.map((evaluator) => ({
            ...evaluator,
            evaluatorKind,
          }));
        },
      });
      return { evaluatorKind, marker, faults, result };
    }));

    for (const { evaluatorKind, marker, faults, result } of results) {
      expect(result.plan.evaluation.evaluators[0].evaluatorKind).toBe(evaluatorKind);
      expect(result.evaluation.coverage).toMatchObject({ failed: 1, completed: 3 });
      expect(result.evaluation.records.find((record) => (
        record.evaluationStatus === 'failed'
      ))).toMatchObject({
        error: { code: 'evaluator-error', stage: 'evaluation' },
      });
      expect(result.state).toMatchObject({
        recordDisposals: 4,
        evaluatorRunDisposals: 1,
      });
      expect(faults.count('evaluator-evaluate')).toBe(4);
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });
});
