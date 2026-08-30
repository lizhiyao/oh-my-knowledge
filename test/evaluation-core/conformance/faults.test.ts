import { describe, expect, it } from 'vitest';
import { AnalysisPortFailure } from '../../../src/evaluation-core/analysis/index.js';
import { ConformanceFaultInjector, deferredGate } from './fault-injector.js';
import {
  ConformanceRuntimeRegistry,
  prepareConformancePlan,
  runConformanceScenario,
} from './harness.js';

describe('Evaluation Core conformance fault matrix', () => {
  it.each([
    'resolve-executor',
    'resolve-evaluator',
    'resolve-analysis',
    'resolve-decision',
  ] as const)('contains and sanitizes %s failures during preparation', async (boundary) => {
    const marker = 'provider-secret-must-not-leak';
    const faults = new ConformanceFaultInjector().fail(boundary, marker);

    await expect(runConformanceScenario('function', { faults })).rejects.not.toThrow(marker);
    expect(faults.count(boundary)).toBeGreaterThanOrEqual(1);
  });

  it.each([
    'executor-open-run',
    'executor-open-trial',
  ] as const)('fails closed when %s cannot establish a resource', async (boundary) => {
    const marker = `${boundary}-secret`;
    const faults = new ConformanceFaultInjector().fail(boundary, marker);
    const result = await runConformanceScenario('function', {
      suffix: boundary,
      faults,
    });

    expect(result.execution).toMatchObject({
      executionBundleStatus: 'failed',
      terminationReasonCode: 'executor-resource-open-failed',
      coverage: { started: 0, succeeded: 0, failed: 0, notStarted: 4 },
    });
    expect(result.report.status.evidenceStatus).toBe('unresolvable');
    expect(result.decision?.decisionStatus).toBe('not-decided');
    expect(faults.count(boundary)).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it.each([
    'evaluator-open-run',
    'evaluator-open-record',
  ] as const)('materializes a partial report when %s fails', async (boundary) => {
    const marker = `${boundary}-secret`;
    const faults = new ConformanceFaultInjector().fail(boundary, marker);
    const result = await runConformanceScenario('function', {
      suffix: boundary,
      faults,
    });

    expect(result.execution.executionBundleStatus).toBe('completed');
    expect(result.evaluation).toMatchObject({
      evaluationBundleStatus: 'failed',
      terminationReasonCode: 'evaluator-resource-open-failed',
    });
    expect(result.report.status.evidenceStatus).toBe('partial');
    expect(result.decision?.decisionStatus).toBe('not-decided');
    expect(faults.count(boundary)).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('contains AnalysisNode open failure before Decision materialization', async () => {
    const faults = new ConformanceFaultInjector().fail('analysis-open-run');
    const result = await runConformanceScenario('function', {
      suffix: 'analysis-open-run',
      faults,
    });

    expect(result.analysis).toMatchObject({
      analysisBundleStatus: 'failed',
      records: [{
        analysisStatus: 'failed',
        error: { code: 'analysis-runtime-failed', stage: 'analysis' },
      }],
    });
    expect(result.decision?.decisionStatus).toBe('not-decided');
    expect(faults.count('analysis-open-run')).toBe(1);
  });

  it.each([
    {
      name: 'sanitizes structured Analysis failures',
      failure: new AnalysisPortFailure({
        code: 'analysis-provider-failed',
        stage: 'analysis',
        message: 'analysis-provider-secret',
      }),
      expectedCode: 'analysis-provider-failed',
    },
    {
      name: 'contains malformed structured Analysis failures',
      failure: new AnalysisPortFailure({} as never),
      expectedCode: 'analysis-error-invalid',
    },
  ])('$name', async ({ failure, expectedCode }) => {
    const faults = new ConformanceFaultInjector().at('analysis-open-run', () => {
      throw failure;
    });
    const result = await runConformanceScenario('function', {
      suffix: expectedCode,
      faults,
    });

    expect(result.analysis).toMatchObject({
      analysisBundleStatus: 'failed',
      records: [{
        analysisStatus: 'failed',
        error: { code: expectedCode },
      }],
    });
    expect(JSON.stringify(result)).not.toContain('analysis-provider-secret');
    expect(result.decision?.decisionStatus).toBe('not-decided');
  });

  it('materializes honest partial downstream artifacts after one Executor failure', async () => {
    const faults = new ConformanceFaultInjector().fail('executor-execute');
    const result = await runConformanceScenario('function', {
      suffix: 'executor-fault',
      faults,
      mutate(_definition, policy) { policy.failure.failureMode = 'continue'; },
    });

    expect(result.execution.executionBundleStatus).toBe('completed');
    expect(result.execution.coverage).toMatchObject({ failed: 1, succeeded: 3 });
    expect(result.execution.records.find((record) => (
      record.executionStatus === 'failed'
    ))).toMatchObject({
      error: { code: 'executor-error', stage: 'execution' },
    });
    expect(result.report.status.evidenceStatus).toBe('unresolvable');
    expect(result.decision?.decisionStatus).toBe('not-decided');
    expect(result.state.trialDisposals).toBe(4);
    expect(result.state.executorRunDisposals).toBe(result.plan.execution.targets.length);
  });

  it.each([
    ['fail-fast', 1, 'failure-policy-fail-fast'],
    ['failure-threshold', 2, 'failure-policy-threshold'],
  ] as const)(
    'stops future admission according to %s without fabricating attempts',
    async (failureMode, failureCount, reason) => {
      const faults = new ConformanceFaultInjector();
      for (let occurrence = 1; occurrence <= failureCount; occurrence += 1) {
        faults.fail('executor-execute', undefined, occurrence);
      }
      const result = await runConformanceScenario('function', {
        suffix: failureMode,
        faults,
        mutate(_definition, policy) {
          policy.execution.maxConcurrency = 1;
          policy.failure = failureMode === 'fail-fast'
            ? { failureMode }
            : { failureMode, maxFailures: 1 };
        },
      });

      expect(result.execution).toMatchObject({
        executionBundleStatus: 'failed',
        terminationReasonCode: reason,
        coverage: {
          started: failureCount,
          failed: failureCount,
          notStarted: 4 - failureCount,
        },
      });
      expect(result.execution.records.reduce((count, record) => (
        count + (record.executionStatus === 'budget-censored' ? 0 : record.attempts.length)
      ), 0)).toBe(failureCount);
      expect(faults.count('executor-execute')).toBe(failureCount);
      expect(result.state.trialDisposals).toBe(failureCount);
      expect(result.decision?.decisionStatus).toBe('not-decided');
    },
  );

  it('materializes cancellation before admission without opening Runtime resources', async () => {
    const controller = new AbortController();
    controller.abort('cancel while queued');
    const result = await runConformanceScenario('function', {
      suffix: 'queued-cancellation',
      executionSignal: controller.signal,
    });

    expect(result.execution).toMatchObject({
      executionBundleStatus: 'cancelled',
      terminationReasonCode: 'external-cancellation',
      coverage: { started: 0, notStarted: 4 },
    });
    expect(result.state).toMatchObject({
      executorRunOpens: 0,
      trialOpens: 0,
      executorAttempts: 0,
    });
    expect(result.decision?.decisionStatus).toBe('not-decided');
  });

  it('keeps stage-boundary cancellation separate from completed Execution facts', async () => {
    const source = await runConformanceScenario('function', {
      suffix: 'evaluation-cancellation-source',
    });
    const controller = new AbortController();
    controller.abort('cancel before evaluation admission');
    const result = await runConformanceScenario('function', {
      suffix: 'evaluation-cancellation',
      execution: source.execution,
      evaluationSignal: controller.signal,
    });

    expect(result.execution.bundleDigest).toBe(source.execution.bundleDigest);
    expect(result.evaluation).toMatchObject({
      evaluationBundleStatus: 'cancelled',
      terminationReasonCode: 'external-cancellation',
      coverage: { started: 0, notStarted: 4 },
    });
    expect(result.state.evaluatorRunOpens).toBe(0);
    expect(result.decision?.decisionStatus).toBe('not-decided');
  });

  it('keeps cancellation authoritative when it arrives during trial disposal', async () => {
    const controller = new AbortController();
    const faults = new ConformanceFaultInjector().at('executor-dispose-trial', () => {
      controller.abort('cancel during dispose');
    });
    const result = await runConformanceScenario('function', {
      suffix: 'dispose-cancellation',
      faults,
      executionSignal: controller.signal,
      mutate(_definition, policy) { policy.execution.maxConcurrency = 1; },
    });

    expect(result.execution).toMatchObject({
      executionBundleStatus: 'cancelled',
      terminationReasonCode: 'external-cancellation',
      coverage: { started: 1, succeeded: 1, notStarted: 3 },
    });
    expect(result.state).toMatchObject({
      executorAttempts: 1,
      trialDisposals: 1,
      executorRunDisposals: 1,
    });
    expect(result.decision?.decisionStatus).toBe('not-decided');
  });

  it('keeps a committed terminal result authoritative over a simultaneous late abort', async () => {
    const controller = new AbortController();
    const result = await runConformanceScenario('function', {
      suffix: 'terminal-cancellation-race',
      executionSignal: controller.signal,
      consumeEvent(event) {
        if (event.eventKind === 'execution.run.completed') {
          controller.abort('abort at the terminal event');
        }
      },
    });

    expect(controller.signal.aborted).toBe(true);
    expect(result.execution).toMatchObject({
      executionBundleStatus: 'completed',
      coverage: { succeeded: 4, cancelled: 0, notStarted: 0 },
    });
    expect(result.report.status.runStatus).toBe('completed');
  });

  it('contains Evaluator failure without converting it into a quality verdict', async () => {
    const faults = new ConformanceFaultInjector().fail('evaluator-evaluate');
    const result = await runConformanceScenario('function', {
      suffix: 'evaluator-fault',
      faults,
    });

    expect(result.evaluation.coverage).toMatchObject({ failed: 1, completed: 3 });
    expect(result.evaluation.records.find((record) => (
      record.evaluationStatus === 'failed'
    ))).toMatchObject({
      error: { code: 'evaluator-error', stage: 'evaluation' },
    });
    expect(result.decision?.decisionStatus).toBe('not-decided');
    expect(result.state.recordDisposals).toBe(4);
    expect(result.state.evaluatorRunDisposals).toBe(1);
  });

  it.each([
    ['fail-fast', 1, 'evaluation-failure-policy-fail-fast'],
    ['failure-threshold', 2, 'evaluation-failure-policy-threshold'],
  ] as const)(
    'applies Evaluation %s before admitting later records',
    async (failureMode, failureCount, reason) => {
      const faults = new ConformanceFaultInjector();
      for (let occurrence = 1; occurrence <= failureCount; occurrence += 1) {
        faults.fail('evaluator-evaluate', undefined, occurrence);
      }
      const result = await runConformanceScenario('function', {
        suffix: `evaluation-${failureMode}`,
        faults,
        mutate(_definition, policy) {
          policy.evaluation.maxConcurrency = 1;
          policy.failure = failureMode === 'fail-fast'
            ? { failureMode }
            : { failureMode, maxFailures: 1 };
        },
      });

      expect(result.evaluation).toMatchObject({
        evaluationBundleStatus: 'failed',
        terminationReasonCode: reason,
        coverage: {
          started: failureCount,
          failed: failureCount,
          notStarted: 4 - failureCount,
        },
      });
      expect(result.state.recordDisposals).toBe(failureCount);
      expect(faults.count('evaluator-evaluate')).toBe(failureCount);
      expect(result.decision?.decisionStatus).toBe('not-decided');
    },
  );

  it('contains AnalysisNode and DecisionPolicy failures at their stage boundaries', async () => {
    const analysis = await runConformanceScenario('function', {
      suffix: 'analysis-fault',
      faults: new ConformanceFaultInjector().fail('analysis-execute'),
    });
    expect(analysis.analysis).toMatchObject({
      analysisBundleStatus: 'failed',
      records: [{
        analysisStatus: 'failed',
        error: { code: 'analysis-runtime-failed', stage: 'analysis' },
      }],
    });
    expect(analysis.decision?.decisionStatus).toBe('not-decided');

    const decision = await runConformanceScenario('function', {
      suffix: 'decision-fault',
      faults: new ConformanceFaultInjector().fail('decision-decide'),
    });
    expect(decision.decision).toMatchObject({
      decisionStatus: 'failed',
      error: { code: 'decision-runtime-failed', stage: 'analysis' },
    });
    expect(decision.report.status.conclusionStatus).toBe('inconclusive');
  });

  it('waits for a slow required EventWriter without using wall-clock timing', async () => {
    const entered = deferredGate();
    const release = deferredGate();
    let writerReleased = false;
    const faults = new ConformanceFaultInjector().at('event-write', async () => {
      entered.release();
      await release.promise;
      writerReleased = true;
    }).at('executor-execute', () => {
      if (!writerReleased) throw new Error('Target started before the required writer settled.');
    });
    const running = runConformanceScenario('function', {
      suffix: 'slow-writer',
      faults,
      mutate(_definition, policy) {
        policy.eventDelivery.writerMode = 'required';
        policy.eventDelivery.writerFailureMode = 'fail-run';
      },
    });
    let settled = false;
    void running.then(() => { settled = true; });

    await entered.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(faults.count('executor-execute')).toBe(0);
    release.release();
    const result = await running;
    expect(result.report.status.runStatus).toBe('completed');
    expect(result.execution.coverage).toMatchObject({ failed: 0, succeeded: 4 });
    expect(faults.count('event-write')).toBeGreaterThan(0);
  });

  it('turns a required EventWriter failure into a structured terminal state', async () => {
    const faults = new ConformanceFaultInjector().fail('event-write');
    const result = await runConformanceScenario('function', {
      suffix: 'writer-fault',
      faults,
      mutate(_definition, policy) {
        policy.eventDelivery.writerMode = 'required';
        policy.eventDelivery.writerFailureMode = 'fail-run';
      },
    });

    expect(result.execution).toMatchObject({
      executionBundleStatus: 'failed',
      terminationReasonCode: 'event-writer-failed',
    });
    expect(JSON.stringify(result.events)).not.toContain('Injected failure');
  });

  it('isolates cancellation, event sequences, and teardown across concurrent Runs', async () => {
    const plan = await prepareConformancePlan('agent', (_definition, policy) => {
      policy.execution.maxConcurrency = 1;
      policy.cache.executionMode = 'transparent-deterministic';
      policy.cache.evaluationMode = 'reuse';
      policy.eventDelivery.writerMode = 'required';
      policy.eventDelivery.writerFailureMode = 'fail-run';
    });
    const registry = new ConformanceRuntimeRegistry('agent', plan);
    const controller = new AbortController();
    const cancelledEntered = deferredGate();
    const completedEntered = deferredGate();
    const cancellingFaults = new ConformanceFaultInjector().at('executor-execute', async () => {
      cancelledEntered.release();
      await completedEntered.promise;
      controller.abort('cancel only this run');
    });
    const completedFaults = new ConformanceFaultInjector().at('executor-execute', async () => {
      completedEntered.release();
      await cancelledEntered.promise;
    });
    const [cancelled, completed] = await Promise.all([
      runConformanceScenario('agent', {
        plan,
        runtimeRegistry: registry,
        runId: 'conformance-agent-cancelled',
        suffix: 'concurrent-cancelled',
        faults: cancellingFaults,
        executionSignal: controller.signal,
      }),
      runConformanceScenario('agent', {
        plan,
        runtimeRegistry: registry,
        runId: 'conformance-agent-completed',
        suffix: 'concurrent-completed',
        faults: completedFaults,
      }),
    ]);

    expect(cancelled.execution.executionBundleStatus).toBe('cancelled');
    expect(completed.execution.executionBundleStatus).toBe('completed');
    expect(cancelled.state).toMatchObject({
      executorRunOpens: 1,
      executorRunDisposals: 1,
      trialOpens: 1,
      trialDisposals: 1,
      evaluatorRunOpens: 0,
      evaluatorRunDisposals: 0,
    });
    expect(completed.state).toMatchObject({
      executorRunOpens: completed.plan.execution.targets.length,
      executorRunDisposals: completed.plan.execution.targets.length,
      trialOpens: 4,
      trialDisposals: 4,
      evaluatorRunOpens: 2,
      evaluatorRunDisposals: 2,
      recordOpens: 8,
      recordDisposals: 8,
    });
    expect(cancelled.events[0]?.sequence).toBe(0);
    expect(completed.events[0]?.sequence).toBe(0);
    expect(new Set(cancelled.events.map((event) => event.runId))).toEqual(
      new Set(['conformance-agent-cancelled']),
    );
    expect(new Set(completed.events.map((event) => event.runId))).toEqual(
      new Set(['conformance-agent-completed']),
    );
    expect(new Set(cancelled.state.writtenEvents.map((event) => event.runId))).toEqual(
      new Set(['conformance-agent-cancelled']),
    );
    expect(new Set(completed.state.writtenEvents.map((event) => event.runId))).toEqual(
      new Set(['conformance-agent-completed']),
    );
    expect(registry.executionCache.size).toBe(4);
    expect(registry.evaluationCache.size).toBe(8);

    const executionReplay = await runConformanceScenario('agent', {
      plan,
      runtimeRegistry: registry,
      runId: 'conformance-agent-execution-replay',
      suffix: 'concurrent-execution-replay',
    });
    expect(executionReplay.state.executorAttempts).toBe(0);
    expect(executionReplay.execution.records.every((record) => (
      record.executionStatus === 'completed'
      && record.cache.cacheStatus === 'transparent-hit'
    ))).toBe(true);

    const replay = await runConformanceScenario('agent', {
      plan,
      runtimeRegistry: registry,
      runId: 'conformance-agent-replay',
      suffix: 'concurrent-replay',
      executionSource: completed.executionSource,
    });
    expect(replay.state).toMatchObject({
      executorAttempts: 0,
      evaluatorAttempts: 0,
      executorRunOpens: 0,
      evaluatorRunOpens: 0,
    });
    expect(replay.execution.bundleDigest).toBe(completed.execution.bundleDigest);
    expect(replay.evaluation.records.every((record) => (
      record.evaluationStatus === 'completed'
      && record.cache.cacheStatus === 'transparent-hit'
    ))).toBe(true);
  });

  it.each([
    ['executor-dispose-trial', 'execution', 'executor-trial-dispose-failed'],
    ['executor-dispose-run', 'execution', 'executor-run-dispose-failed'],
    ['evaluator-dispose-record', 'evaluation', 'evaluator-record-dispose-failed'],
    ['evaluator-dispose-run', 'evaluation', 'evaluator-run-dispose-failed'],
    ['analysis-dispose-run', 'analysis', 'analysis-node-dispose-failed'],
  ] as const)(
    'contains lifecycle boundary %s with an exact structured terminal',
    async (boundary, stage, reason) => {
      const faults = new ConformanceFaultInjector().fail(boundary);
      const result = await runConformanceScenario('function', { faults });

      expect(faults.count(boundary)).toBeGreaterThan(0);
      if (stage === 'execution') {
        expect(result.execution).toMatchObject({
          executionBundleStatus: 'failed',
          terminationReasonCode: reason,
        });
        expect(result.state.executorRunDisposals).toBe(result.plan.execution.targets.length);
        expect(result.state.trialDisposals).toBeGreaterThan(0);
      } else if (stage === 'evaluation') {
        expect(result.evaluation).toMatchObject({
          evaluationBundleStatus: 'failed',
          terminationReasonCode: reason,
        });
        expect(result.state.evaluatorRunDisposals).toBe(1);
        expect(result.state.recordDisposals).toBeGreaterThan(0);
      } else {
        expect(result.analysis).toMatchObject({
          analysisBundleStatus: 'failed',
          terminationReasonCode: reason,
          records: [{
            analysisStatus: 'failed',
            error: { code: reason, stage: 'infrastructure' },
          }],
        });
      }
      expect(result.report.status.runStatus).toBe('failed');
      expect(result.decision?.decisionStatus).toBe('not-decided');
      expect(JSON.stringify(result)).not.toContain('Injected failure');
    },
  );
});
