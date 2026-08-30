import { describe, expect, it } from 'vitest';
import {
  createEvaluationEngine,
  type EvaluationEngineRuntime,
  type EvaluationEvent,
  type EvaluationRun,
  type EvaluationRunResult,
  type Evaluator,
  type Executor,
  type RuntimeIdentity,
} from '../../../src/index.js';
import {
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
  resolveBuiltinAnalysisRuntime,
} from '../../../src/evaluation-core/analysis/index.js';
import type { SealedRunPlan } from '../../../src/evaluation-core/compiler/index.js';
import { validDefinition, validPolicy, testRuntime } from '../compiler/fixtures.js';

class DeterministicClock {
  #elapsed = 0;

  monotonicNow(): number {
    return this.#elapsed;
  }

  timestamp(): string {
    const timestamp = new Date(Date.UTC(2026, 7, 30) + this.#elapsed).toISOString();
    this.#elapsed += 1;
    return timestamp;
  }

  async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.#elapsed += delayMs;
  }
}

function runtimeIdentity(
  plan: SealedRunPlan,
  runtimeKind: 'executor' | 'evaluator',
  referenceId: string,
) {
  const runtimes = runtimeKind === 'executor'
    ? plan.execution.runtimes
    : plan.evaluation.runtimes;
  const runtime = runtimes.find((candidate) => (
    candidate.runtimeKind === runtimeKind && candidate.referenceId === referenceId
  ));
  if (runtime === undefined) throw new Error(`Missing ${runtimeKind} ${referenceId}.`);
  return structuredClone(runtime.identity) as RuntimeIdentity;
}

function makeExecutor(plan: SealedRunPlan): Executor {
  return {
    identity: runtimeIdentity(plan, 'executor', 'control'),
    async openRun() {
      return {
        async openTrial(context) {
          return {
            async execute(attempt) {
              if (attempt.signal.aborted) throw attempt.signal.reason;
              const input = context.input as { answerHint: string };
              return {
                output: {
                  value: { answer: input.answerHint ?? 'A' },
                  classification: 'public' as const,
                },
              };
            },
            dispose() {},
          };
        },
        dispose() {},
      };
    },
  };
}

function makeEvaluator(plan: SealedRunPlan): Evaluator {
  return {
    identity: runtimeIdentity(plan, 'evaluator', 'exact'),
    async openRun() {
      return {
        async openRecord(context) {
          return {
            async evaluate(attempt) {
              if (attempt.signal.aborted) throw attempt.signal.reason;
              const actual = context.bindings.find((binding) => binding.bindingId === 'actual');
              const gold = context.bindings.find((binding) => binding.bindingId === 'gold');
              return {
                observations: [{
                  metricId: 'correct',
                  observationStatus: 'observed' as const,
                  valueType: 'boolean' as const,
                  value: actual?.value === gold?.value,
                }],
              };
            },
            dispose() {},
          };
        },
        dispose() {},
      };
    },
  };
}

async function createRuntime(): Promise<{
  runtime: EvaluationEngineRuntime;
  definition: ReturnType<typeof validDefinition>;
  policy: ReturnType<typeof validPolicy>;
}> {
  const definition = validDefinition();
  definition.analysisGraph.nodes[0].parameters = {};
  const policy = validPolicy();
  policy.retry.maxAttempts = 1;
  policy.evaluation.retry.maxAttempts = 1;
  policy.evidence.trace = 'none';
  const base = testRuntime();
  const schemaValidators = new Map([
    ...base.schemaValidators,
    ...createBuiltinAnalysisSchemaValidators(),
  ]);
  const preparation = {
    resolveExecutor: base.resolveExecutor,
    resolveEvaluator: base.resolveEvaluator,
    resolveAnalysis(requirement: Parameters<typeof resolveBuiltinAnalysisRuntime>[0]) {
      const resolution = resolveBuiltinAnalysisRuntime(requirement);
      if (resolution === undefined) throw new Error('Missing built-in Analysis Runtime.');
      return resolution;
    },
  };
  const plan = await (await import('../../../src/evaluation-core/compiler/index.js'))
    .prepareEvaluationPlan(definition, policy, { ...preparation, schemaValidators });
  return {
    definition,
    policy,
    runtime: {
      preparation,
      executors: new Map([['executor-alias', makeExecutor(plan)]]),
      evaluators: new Map([['exact/v1', makeEvaluator(plan)]]),
      clock: new DeterministicClock(),
      schemaValidators,
      analysisNodes: createBuiltinAnalysisNodes(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
    },
  };
}

async function consume(run: {
  events: AsyncIterable<EvaluationEvent>;
  result: Promise<EvaluationRunResult>;
}) {
  const events: EvaluationEvent[] = [];
  const consuming = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  const result = await run.result;
  await consuming;
  return { events, result };
}

describe('embedded Evaluation Engine', () => {
  it('enforces one Run invocation budget across Execution and Evaluation', async () => {
    const fixture = await createRuntime();
    fixture.policy.budget.run.maxInvocations = 3;
    delete fixture.policy.execution.timeoutMs;
    delete fixture.policy.evaluation.timeoutMs;
    fixture.definition.dataset.samples[0].input = { answerHint: 'A' };
    const result = await createEvaluationEngine(fixture.runtime).start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-shared-budget',
    }).result;

    if (result.status === 'failed') throw new Error('Expected materialized partial artifacts.');
    const executionEntries = result.artifacts.execution.budgetSummary.entries;
    const finalEntries = result.artifacts.evaluation.budgetSummary.entries;
    expect(executionEntries).toHaveLength(2);
    expect(finalEntries).toHaveLength(3);
    expect(result.status).toBe('budget-exhausted');
    expect(finalEntries.slice(0, executionEntries.length)).toEqual(executionEntries);
    expect(result.report.budgetSummary).toEqual(result.artifacts.evaluation.budgetSummary);
    expect(result.artifacts.evaluation).toMatchObject({
      evaluationBundleStatus: 'budget-exhausted',
      coverage: { started: 1, notStarted: 1 },
    });
  });

  it('runs an in-memory multi-target evaluation through the public façade', async () => {
    const fixture = await createRuntime();
    const engine = createEvaluationEngine(fixture.runtime);
    const { events, result } = await consume(engine.start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-completed',
      annotations: { owner: 'host' },
      eventBufferCapacity: 128,
    }));

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected a completed result.');
    expect(result.report.annotations).toEqual({ owner: 'host' });
    expect(result.artifacts.execution.records).toHaveLength(2);
    expect(result.artifacts.evaluation.records).toHaveLength(2);
    expect(events.length).toBeGreaterThan(10);
    expect(events.every((event) => event.runId === 'embedded-completed')).toBe(true);
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index),
    );
    expect(events.at(-1)?.eventKind).toBe('report.materialized');
  });

  it('returns structured configuration failures without rejecting result', async () => {
    const fixture = await createRuntime();
    const definition = structuredClone(fixture.definition);
    definition.targets[0].executorId = 'missing-executor';
    const result = await createEvaluationEngine(fixture.runtime).start(definition, {
      policy: fixture.policy,
      runId: 'embedded-invalid',
    }).result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected a failed result.');
    expect(result.error.stage).toBe('configuration');
    expect(result.error.code).toBe('EXECUTION_RUNTIME_EXECUTOR_MISSING');
    expect(result.report).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'returns a structured failure for eventBufferCapacity %s',
    async (eventBufferCapacity) => {
      const fixture = await createRuntime();
      const engine = createEvaluationEngine(fixture.runtime);
      let run: EvaluationRun | undefined;

      expect(() => {
        run = engine.start(fixture.definition, {
          policy: fixture.policy,
          runId: `embedded-invalid-capacity-${eventBufferCapacity}`,
          eventBufferCapacity,
        });
      }).not.toThrow();
      if (run === undefined) throw new Error('Expected an EvaluationRun.');

      const { events, result } = await consume(run);
      expect(events).toEqual([]);
      expect(result).toMatchObject({
        status: 'failed',
        error: {
          code: 'EVALUATION_ENGINE_EVENT_BUFFER_CAPACITY_INVALID',
          stage: 'configuration',
        },
      });
    },
  );

  it('uses the structured failure channel for invalid prepared-run options', async () => {
    const fixture = await createRuntime();
    const engine = createEvaluationEngine(fixture.runtime);
    const prepared = await engine.prepare(fixture.definition, fixture.policy);
    const runId = 'embedded-prepared-invalid-capacity';
    const invalid = await consume(prepared.start({
      runId,
      eventBufferCapacity: 0,
    }));

    expect(invalid.events).toEqual([]);
    expect(invalid.result).toMatchObject({
      status: 'failed',
      error: {
        code: 'EVALUATION_ENGINE_EVENT_BUFFER_CAPACITY_INVALID',
        stage: 'configuration',
      },
    });
    expect((await consume(prepared.start({ runId }))).result.status).toBe('completed');
  });

  it('rejects concurrent duplicate runIds and permits reuse after termination', async () => {
    const fixture = await createRuntime();
    const engine = createEvaluationEngine(fixture.runtime);
    const prepared = await engine.prepare(fixture.definition, fixture.policy);
    const runId = 'embedded-active-run';
    const first = prepared.start({ runId });
    const duplicate = engine.start(fixture.definition, {
      policy: fixture.policy,
      runId,
    });

    const duplicateOutcome = await consume(duplicate);
    expect(duplicateOutcome.events).toEqual([]);
    expect(duplicateOutcome.result).toMatchObject({
      status: 'failed',
      error: {
        code: 'EVALUATION_ENGINE_RUN_ID_ACTIVE',
        stage: 'configuration',
      },
    });
    expect((await consume(first)).result.status).toBe('completed');
    expect((await consume(engine.start(fixture.definition, {
      policy: fixture.policy,
      runId,
    }))).result.status).toBe('completed');
  });

  it('releases runId ownership after preparation failure', async () => {
    const fixture = await createRuntime();
    const engine = createEvaluationEngine(fixture.runtime);
    const invalidDefinition = structuredClone(fixture.definition);
    invalidDefinition.targets = [];
    const runId = 'embedded-preparation-failure';

    const failed = await consume(engine.start(invalidDefinition, {
      policy: fixture.policy,
      runId,
    }));
    expect(failed.result.status).toBe('failed');
    expect((await consume(engine.start(fixture.definition, {
      policy: fixture.policy,
      runId,
    }))).result.status).toBe('completed');
  });

  it('preserves completed upstream evidence when a later stage cannot start', async () => {
    const fixture = await createRuntime();
    const runtime = { ...fixture.runtime, evaluators: new Map() };
    const result = await createEvaluationEngine(runtime).start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-partial-failure',
    }).result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected a failed result.');
    expect(result.error.code).toBe('EVALUATION_RUNTIME_EVALUATOR_MISSING');
    expect(result.artifacts?.execution?.executionBundleStatus).toBe('completed');
    expect(result.artifacts?.evaluation).toBeUndefined();
    expect(result.report).toBeUndefined();
  });

  it('isolates concurrent cancellation, events, and evidence', async () => {
    const fixture = await createRuntime();
    const engine = createEvaluationEngine(fixture.runtime);
    const cancelled = new AbortController();
    cancelled.abort(new Error('host cancellation'));
    const left = consume(engine.start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-cancelled',
      signal: cancelled.signal,
      eventBufferCapacity: 128,
    }));
    const right = consume(engine.start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-independent',
      eventBufferCapacity: 128,
    }));

    const [cancelledResult, completedResult] = await Promise.all([left, right]);
    expect(cancelledResult.result.status).toBe('cancelled');
    expect(completedResult.result.status).toBe('completed');
    expect(cancelledResult.events.every((event) => (
      event.runId === 'embedded-cancelled'
    ))).toBe(true);
    expect(completedResult.events.every((event) => (
      event.runId === 'embedded-independent'
    ))).toBe(true);
    expect(cancelledResult.events[0]?.sequence).toBe(0);
    expect(completedResult.events[0]?.sequence).toBe(0);
    expect((await consume(engine.start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-cancelled',
    }))).result.status).toBe('completed');
  });
});
