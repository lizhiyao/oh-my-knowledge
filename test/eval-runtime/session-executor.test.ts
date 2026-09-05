import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  checkExecutor,
  evaluate,
  prepareEvaluation,
  type Clock,
  type ExecutorResult,
  type SessionExecutor,
} from '../../src/eval-runtime/index.js';
import { EvaluationDefinitionSchema } from '../../src/eval-core/contracts/index.js';
import { createSessionExecutorIdentity } from '../../src/eval-runtime/identity.js';

type SessionInput = {
  readonly mode: 'success' | 'retry' | 'failure' | 'cancel';
};

type SessionConfig = {
  readonly answer: string;
};

interface SeenSession {
  readonly runId: string;
  readonly trialId: string;
  readonly sampleId: string;
  readonly variantId: string;
  readonly context: unknown;
  readonly attempts: Array<Readonly<{ attemptId: string; attemptNumber: number }>>;
  closes: number;
}

const fixedClock: Clock = {
  monotonicNow: () => 0,
  timestamp: () => '2026-09-05T00:00:00.000Z',
  sleep: () => Promise.resolve(),
};

function sessionExecutor(
  seen: SeenSession[],
  overrides: Readonly<{
    open?: SessionExecutor<SessionInput, SessionConfig, string>['openSession'];
  }> = {},
): SessionExecutor<SessionInput, SessionConfig, string> {
  const declaration: SessionExecutor<SessionInput, SessionConfig, string> = {
    protocol: 'session',
    executorId: 'test.session-agent/v1',
    version: '1.0.0',
    schemas: {
      input: z.object({ mode: z.enum(['success', 'retry', 'failure', 'cancel']) }).strict(),
      config: z.object({ answer: z.string() }).strict(),
      output: z.string(),
    },
    outputClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    fingerprintFacets: { revision: 'session-one' },
    async openSession(context) {
      const observation: SeenSession = {
        runId: context.runId,
        trialId: context.trialId,
        sampleId: context.sampleId,
        variantId: context.variantId,
        context: structuredClone(context),
        attempts: [],
        closes: 0,
      };
      seen.push(observation);
      return {
        async execute(attempt): Promise<ExecutorResult<string>> {
          observation.attempts.push({
            attemptId: attempt.attemptId,
            attemptNumber: attempt.attemptNumber,
          });
          if (context.input.mode === 'retry' && attempt.attemptNumber === 1) {
            return { errorCode: 'temporary-session-failure' };
          }
          if (context.input.mode === 'failure') return { errorCode: 'expected-session-failure' };
          if (context.input.mode === 'cancel') {
            return new Promise((_resolve, reject) => {
              if (attempt.signal.aborted) {
                reject(attempt.signal.reason);
                return;
              }
              attempt.signal.addEventListener(
                'abort',
                () => reject(attempt.signal.reason),
                { once: true },
              );
            });
          }
          return { output: context.config.answer };
        },
        close() {
          observation.closes += 1;
        },
      };
    },
  };
  return overrides.open === undefined
    ? declaration
    : { ...declaration, openSession: overrides.open };
}

function evaluationInput(
  executor: SessionExecutor<SessionInput, SessionConfig, string>,
  mode: SessionInput['mode'] = 'success',
) {
  return {
    dataset: {
      datasetId: 'session-agent',
      samples: [{
        sampleId: 'session-sample',
        input: { mode },
        expected: 'gold-answer',
        evaluationContext: { privateJudgeContext: 'gold-only' },
      }],
    },
    variants: [{
      variantId: 'agent-v1',
      artifact: {
        name: 'agent-v1', kind: 'agent', source: 'inline', content: 'Use a session.',
      },
      execution: { executor, config: { answer: 'done' } },
    }],
    evaluators: [{ evaluatorKind: 'exact-match' }],
    comparisons: [],
    analyses: [{
      analysisId: 'session-correct-rate',
      analysisKind: 'summary',
      statistic: 'rate',
      variantId: 'agent-v1',
      metricId: 'correct',
    }],
    experiment: { seed: 'session-seed', sampling: { samplingKind: 'solo' } },
    policy: {},
  } as const;
}

describe('canonical session Executor', () => {
  it('seals the session protocol and isolates every trial while preserving retry state', async () => {
    const seen: SeenSession[] = [];
    const declaration = sessionExecutor(seen);
    const base = evaluationInput(declaration, 'retry');
    const input = {
      ...base,
      dataset: {
        ...base.dataset,
        samples: [base.dataset.samples[0]!, {
          sampleId: 'session-sample-two',
          input: { mode: 'retry' },
          expected: 'done',
        }],
      },
      experiment: {
        seed: 'session-retry-seed',
        trials: 2,
        sampling: { samplingKind: 'solo' as const },
      },
      policy: {
        execution: {
          retry: {
            maxAttempts: 2,
            retryableErrorCodes: ['temporary-session-failure'],
            backoff: { backoffKind: 'none' as const },
          },
        },
      },
    };
    const prepared = await prepareEvaluation(input);
    const target = prepared.definition.targets[0]!;
    const runtime = prepared.resolvedRuntimes.find((entry) => entry.runtimeKind === 'executor');

    expect(target.protocolId).toBe('omk.session/v1');
    expect(runtime?.identity.capabilities).toMatchObject({
      protocols: [{
        protocolId: 'omk.session/v1',
        execution: { state: { resourceLifecycle: 'per-run', trialState: 'isolated' } },
      }],
    });
    const result = await prepared.run({ runId: 'session-retry-run', clock: fixedClock });

    expect(result.status).toBe('completed');
    expect(result.artifacts?.execution?.records).toHaveLength(4);
    expect(result.artifacts?.execution?.records.every((record) => (
      record.executionStatus === 'completed' && record.attempts.length === 2
    ))).toBe(true);
    expect(seen).toHaveLength(4);
    expect(new Set(seen.map((session) => session.trialId)).size).toBe(4);
    expect(seen.every((session) => session.runId === 'session-retry-run')).toBe(true);
    expect(seen.every((session) => session.closes === 1)).toBe(true);
    expect(seen.every((session) => (
      session.attempts.map((attempt) => attempt.attemptNumber).join(',') === '1,2'
      && new Set(session.attempts.map((attempt) => attempt.attemptId)).size === 2
    ))).toBe(true);
    expect(JSON.stringify(seen.map((session) => session.context))).not.toContain('gold-answer');
    expect(JSON.stringify(seen.map((session) => session.context))).not.toContain('gold-only');
  });

  it('opens a fresh session for each run of one sealed Plan', async () => {
    const seen: SeenSession[] = [];
    const prepared = await prepareEvaluation(evaluationInput(sessionExecutor(seen)));
    const first = await prepared.run({ runId: 'session-run-one', clock: fixedClock });
    const second = await prepared.run({ runId: 'session-run-two', clock: fixedClock });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    expect(seen.map((session) => session.runId)).toEqual(['session-run-one', 'session-run-two']);
    expect(seen[0]?.trialId).toBe(seen[1]?.trialId);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.every((session) => session.closes === 1)).toBe(true);
  });

  it('rejects one session object reused across runs', async () => {
    let closes = 0;
    const sharedSession = {
      execute: async () => ({ output: 'done' as const }),
      close: () => { closes += 1; },
    };
    const declaration = sessionExecutor([], {
      open: async () => sharedSession,
    });
    const prepared = await prepareEvaluation(evaluationInput(declaration));
    const first = await prepared.run({ runId: 'session-reuse-one', clock: fixedClock });
    const second = await prepared.run({ runId: 'session-reuse-two', clock: fixedClock });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('failed');
    expect(second.artifacts?.execution?.terminationReasonCode)
      .toBe('executor-resource-open-failed');
    expect(closes).toBe(1);
  });

  it('cancels an in-flight session attempt and closes the session once', async () => {
    const seen: SeenSession[] = [];
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const attemptStarted = new Promise<void>((resolve) => { started = resolve; });
    const base = sessionExecutor(seen);
    const declaration: SessionExecutor<SessionInput, SessionConfig, string> = {
      ...base,
      async openSession(context) {
        const session = await base.openSession(context);
        return {
          ...session,
          async execute(attempt) {
            started?.();
            return session.execute(attempt);
          },
        };
      },
    };
    const running = evaluate(evaluationInput(declaration, 'cancel'), {
      runId: 'session-cancel-run',
      signal: controller.signal,
    });
    await attemptStarted;
    controller.abort('test-cancel');
    const result = await running;

    expect(result.status).toBe('cancelled');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ closes: 1 });
  });

  it('applies the Core attempt timeout and closes the session after settlement', async () => {
    const seen: SeenSession[] = [];
    const base = evaluationInput(sessionExecutor(seen), 'cancel');
    const result = await evaluate({
      ...base,
      policy: { execution: { timeoutMs: 1 } },
    }, { runId: 'session-timeout-run', clock: fixedClock });
    const record = result.artifacts?.execution?.records[0];

    expect(result.status).toBe('completed');
    expect(record).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'timeout', stage: 'infrastructure' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ closes: 1 });
  });

  it('fails closed when opening or closing the session lifecycle fails', async () => {
    const openFailure = sessionExecutor([], {
      open: async () => { throw new Error('private-open-detail'); },
    });
    const openResult = await evaluate(evaluationInput(openFailure), {
      runId: 'session-open-failure', clock: fixedClock,
    });
    expect(openResult.status).toBe('failed');
    expect(openResult.artifacts?.execution?.terminationReasonCode)
      .toBe('executor-resource-open-failed');
    expect(JSON.stringify(openResult)).not.toContain('private-open-detail');

    const closeFailure = sessionExecutor([], {
      open: async () => ({
        execute: async () => ({ output: 'done' }),
        close: () => { throw new Error('private-close-detail'); },
      }),
    });
    const closeResult = await evaluate(evaluationInput(closeFailure), {
      runId: 'session-close-failure', clock: fixedClock,
    });
    expect(closeResult.status).toBe('failed');
    expect(closeResult.artifacts?.execution?.terminationReasonCode)
      .toBe('executor-trial-dispose-failed');
    expect(JSON.stringify(closeResult)).not.toContain('private-close-detail');
  });

  it('closes the session when execute throws and redacts the host error', async () => {
    const seen: SeenSession[] = [];
    const base = sessionExecutor(seen);
    const declaration = sessionExecutor([], {
      open: async (context) => {
        const session = await base.openSession(context);
        return {
          execute: async () => { throw new Error('private-execute-detail'); },
          close: session.close,
        };
      },
    });
    const result = await evaluate(evaluationInput(declaration), {
      runId: 'session-execute-failure', clock: fixedClock,
    });

    expect(result.status).toBe('completed');
    expect(result.artifacts?.execution?.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_FAILED', stage: 'execution' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ closes: 1 });
    expect(JSON.stringify(result)).not.toContain('private-execute-detail');
  });

  it('uses the same output and telemetry contract as invoke Executors', async () => {
    const declaration = sessionExecutor([], {
      open: async () => ({
        execute: async () => ({ output: 42 } as never),
        close: () => undefined,
      }),
    });
    const result = await evaluate(evaluationInput(declaration), {
      runId: 'session-invalid-output', clock: fixedClock,
    });
    const record = result.artifacts?.execution?.records[0];

    expect(record).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_OUTPUT_INVALID', stage: 'execution' },
    });
    expect(record).not.toHaveProperty('output');

    const telemetryDeclaration: SessionExecutor<SessionInput, SessionConfig, string> = {
      ...sessionExecutor([]),
      capabilities: {
        determinism: 'deterministic',
        cancellation: 'cooperative',
        concurrency: { safety: 'parallel-safe' },
        seedControl: 'unsupported',
        telemetry: { trace: 'unsupported', usage: 'optional' },
      },
      openSession: async () => ({
        execute: async () => ({ output: 'done', trace: { private: true } }),
        close: () => undefined,
      }),
    };
    const telemetryResult = await evaluate(evaluationInput(telemetryDeclaration), {
      runId: 'session-invalid-telemetry', clock: fixedClock,
    });

    expect(telemetryResult.artifacts?.execution?.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION', stage: 'execution' },
    });
  });

  it('is canonical across declaration key order and explicit Core assembly', async () => {
    const firstExecutor = sessionExecutor([]);
    const secondBase = sessionExecutor([]);
    const secondExecutor: SessionExecutor<SessionInput, SessionConfig, string> = {
      openSession: secondBase.openSession,
      fingerprintFacets: { revision: 'session-one' },
      capabilities: secondBase.capabilities,
      outputClassification: 'public',
      schemas: secondBase.schemas,
      version: '1.0.0',
      executorId: 'test.session-agent/v1',
      protocol: 'session',
    };
    const first = await prepareEvaluation(evaluationInput(firstExecutor));
    const second = await prepareEvaluation(evaluationInput(secondExecutor));
    const target = first.definition.targets[0]!;
    const manual = EvaluationDefinitionSchema.parse({
      ...first.definition,
      targets: [{
        targetId: 'agent-v1',
        targetKind: 'agent',
        protocolId: 'omk.session/v1',
        executorId: 'test.session-agent/v1',
        executionRequirements: {
          systemInstructions: 'not-required',
          workspace: 'not-required',
          mcp: 'not-required',
          mockInterception: 'not-required',
          toolPolicy: 'runtime-default',
          skillDiscovery: 'runtime-default',
        },
        executionControls: {
          defaults: {
            workspace: { workspaceMode: 'not-required' },
            tools: { toolPolicyKind: 'runtime-default' },
            mcp: { mcpMode: 'not-required' },
          },
          sampleOverrides: [],
        },
        config: {
          schemaVersion: 'omk.eval-runtime.variant-config/v3',
          artifact: {
            name: 'agent-v1', kind: 'agent', source: 'inline', content: 'Use a session.',
          },
          executorConfig: { answer: 'done' },
        },
      }],
    });
    const identity = createSessionExecutorIdentity({
      implementationId: 'test.session-agent/v1',
      version: '1.0.0',
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      telemetry: {
        trace: 'unsupported',
        usage: 'optional',
        providerCost: { reporting: 'optional' },
      },
      fingerprintFacets: {
        facade: {
          version: 'omk.eval-runtime.evaluate/v3',
          outputClassification: 'public',
          traceClassification: 'public',
        },
        host: { revision: 'session-one' },
      },
    });
    const runtime = first.resolvedRuntimes.find((entry) => entry.runtimeKind === 'executor');

    expect(second.definition).toEqual(first.definition);
    expect(second.planDigest).toBe(first.planDigest);
    expect(manual.targets[0]).toEqual(target);
    expect(runtime?.identity).toEqual(identity);
    const [left, right] = await Promise.all([
      first.run({ runId: 'session-equivalence', clock: fixedClock }),
      second.run({ runId: 'session-equivalence', clock: fixedClock }),
    ]);
    expect(right.artifacts).toEqual(left.artifacts);
  });

  it('is certified by the existing checkExecutor entry point', async () => {
    const result = await checkExecutor({
      variant: {
        variantId: 'session-agent',
        artifact: {
          name: 'session-agent', kind: 'agent', source: 'inline', content: 'Agent.',
        },
        execution: {
          executor: sessionExecutor([]),
          config: { answer: 'done' },
        },
      },
      success: { input: { mode: 'success' }, expected: 'done' },
      failure: { input: { mode: 'failure' }, expectedErrorCode: 'expected-session-failure' },
      cancellation: { input: { mode: 'cancel' } },
      runId: 'session-conformance',
    });

    expect(result.conformant).toBe(true);
    expect(result.checks.every((check) => check.checkStatus === 'passed')).toBe(true);
  });
});
