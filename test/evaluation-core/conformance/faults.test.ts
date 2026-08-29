import { describe, expect, it } from 'vitest';
import { ConformanceFaultInjector, deferredGate } from './fault-injector.js';
import { runConformanceScenario } from './harness.js';

describe('Evaluation Core conformance fault matrix', () => {
  it.each([
    'resolve-executor',
    'resolve-evaluator',
    'resolve-analysis',
  ] as const)('contains and sanitizes %s failures during preparation', async (boundary) => {
    const marker = 'provider-secret-must-not-leak';
    const faults = new ConformanceFaultInjector().fail(boundary, marker);

    await expect(runConformanceScenario('function', { faults })).rejects.not.toThrow(marker);
    expect(faults.count(boundary)).toBe(1);
  });

  it('materializes honest partial downstream artifacts after one Executor failure', async () => {
    const faults = new ConformanceFaultInjector().fail('executor-execute');
    const result = await runConformanceScenario('function', {
      suffix: 'executor-fault',
      faults,
    });

    expect(result.execution.coverage).toMatchObject({ failed: 1, succeeded: 3 });
    expect(result.execution.records.find((record) => (
      record.executionStatus === 'failed'
    ))).toMatchObject({
      error: { code: 'executor-error', stage: 'execution' },
    });
    expect(result.report.status.evidenceStatus).toBe('unresolvable');
    expect(result.decision?.decisionStatus).toBe('not-decided');
    expect(result.state.trialDisposals).toBe(4);
    expect(result.state.executorRunDisposals).toBe(1);
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
    const faults = new ConformanceFaultInjector().at('event-write', async () => {
      entered.release();
      await release.promise;
    });
    const running = runConformanceScenario('function', {
      suffix: 'slow-writer',
      faults,
      mutate(_definition, policy) {
        policy.eventDelivery.writerMode = 'required';
        policy.eventDelivery.writerFailureMode = 'fail-run';
      },
    });

    await entered.promise;
    release.release();
    const result = await running;
    expect(result.report.status.runStatus).toBe('completed');
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
    const controller = new AbortController();
    const cancellingFaults = new ConformanceFaultInjector().at('executor-execute', () => {
      controller.abort('cancel only this run');
    });
    const [cancelled, completed] = await Promise.all([
      runConformanceScenario('agent', {
        suffix: 'concurrent-cancelled',
        faults: cancellingFaults,
        executionSignal: controller.signal,
        mutate(_definition, policy) { policy.execution.maxConcurrency = 1; },
      }),
      runConformanceScenario('agent', { suffix: 'concurrent-completed' }),
    ]);

    expect(cancelled.execution.executionBundleStatus).toBe('cancelled');
    expect(completed.execution.executionBundleStatus).toBe('completed');
    expect(completed.state).toMatchObject({
      executorRunDisposals: 1,
      evaluatorRunDisposals: 2,
    });
    expect(cancelled.events[0]?.sequence).toBe(0);
    expect(completed.events[0]?.sequence).toBe(0);
    expect(new Set(completed.events.map((event) => event.runId))).toEqual(
      new Set(['conformance-agent']),
    );
  });

  it.each([
    'executor-dispose-trial',
    'executor-dispose-run',
    'evaluator-dispose-record',
    'evaluator-dispose-run',
    'analysis-dispose-run',
  ] as const)('observes and contains lifecycle boundary %s', async (boundary) => {
    const faults = new ConformanceFaultInjector().fail(boundary);
    const result = await runConformanceScenario('function', { faults });

    expect(faults.count(boundary)).toBeGreaterThan(0);
    expect(['completed', 'failed']).toContain(result.report.status.runStatus);
    expect(JSON.stringify(result)).not.toContain('Injected failure');
  });
});
