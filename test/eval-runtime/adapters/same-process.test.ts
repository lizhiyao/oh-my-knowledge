import { describe, expect, it, vi } from 'vitest';
import {
  EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
  type Sha256Digest,
} from '../../../src/eval-core/contracts/index.js';
import type {
  EvaluatorRecordContext,
  EvaluatorRunContext,
} from '../../../src/eval-core/evaluation/index.js';
import type {
  ExecutorRunContext,
  ExecutorTrialContext,
} from '../../../src/eval-core/execution/index.js';
import {
  createSameProcessEvaluatorAdapter,
  createSameProcessExecutorAdapter,
} from '../../../src/eval-runtime/adapters/same-process.js';
import {
  type OmkBindingResourceLease,
  type OmkBindingResourceLeaseAccess,
} from '../../../src/eval-hosts/runtime-adapter/resource-leases/types.js';
import {
  type SameProcessOperationScope,
} from '../../../src/eval-hosts/runtime-adapter/index.js';

function digest(value: JsonValue): Sha256Digest {
  return digestCanonicalJson(value);
}

function schema(name: string): SchemaIdentity {
  return {
    schemaVersion: `test.omk.${name}/v1`,
    schemaUri: `urn:test:omk:${name}:v1`,
    schemaDigest: digest({ name }),
  };
}

function executorIdentity(implementationId = 'test.omk.same-process-executor/v1'): RuntimeIdentity {
  const capabilities = {
    schemaVersion: EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
    protocols: [{
      protocolId: 'omk.invoke/v1' as const,
      inputSchema: schema('invoke-input'),
      outputSchema: schema('invoke-output'),
      execution: {
        concurrency: { safety: 'parallel-safe' as const },
        cancellation: 'cooperative' as const,
        state: {
          resourceLifecycle: 'per-run' as const,
          trialState: 'stateless' as const,
        },
        seedControl: 'optional' as const,
        determinism: 'deterministic' as const,
        features: {
          systemInstructions: 'unsupported' as const,
          workspace: [],
          mcp: [],
          mockInterception: [],
          toolPolicies: ['runtime-default' as const],
          skillDiscovery: ['runtime-default' as const],
          sandboxIds: [],
        },
        telemetry: {
          trace: 'optional' as const,
          usage: 'optional' as const,
        },
      },
    }],
  };
  return {
    implementationId,
    version: '1.0.0',
    fingerprint: digest({ implementationId, capabilities }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'verified',
    capabilities,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  };
}

function evaluatorIdentity(): RuntimeIdentity {
  const implementationId = 'test.omk.same-process-evaluator/v1';
  const capabilities: JsonValue = {
    inputSourceKinds: ['output', 'expected'],
    metricValueTypes: ['boolean'],
    schemas: [],
  };
  return {
    implementationId,
    version: '1.0.0',
    fingerprint: digest({ implementationId, capabilities }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'verified',
    capabilities,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  };
}

function resourceAccess(
  bindingId: string,
  consumerKind: 'executor' | 'evaluator',
  calls: string[] = [],
): OmkBindingResourceLeaseAccess {
  return {
    forRun(runId): OmkBindingResourceLease {
      calls.push(`${bindingId}:${runId}`);
      return Object.freeze({
        bindingId,
        consumerKind,
        resourcesByResourceId: new Map(),
      });
    },
  };
}

function executorRun(runId = 'run-a'): ExecutorRunContext {
  return {
    runId,
    executionPlanDigest: digest({ runId, stage: 'execution' }),
  };
}

function executorTrial(trialLabel = 'trial-a'): ExecutorTrialContext {
  return {
    signal: new AbortController().signal,
    sampleId: 'sample-a',
    targetId: 'target-a',
    executionCoordinateDigest: digest({ trialLabel, coordinate: 0 }),
    executionControl: {
      workspace: { workspaceMode: 'not-required' },
      tools: { toolPolicyKind: 'runtime-default' },
      mcp: { mcpMode: 'not-required' },
      mockInterception: { mockInterceptionMode: 'not-required' },
    },
    protocolId: 'omk.invoke/v1',
    input: { prompt: 'hello' },
    targetConfig: { runtime: { model: 'test-model' } },
    trialIndex: 0,
    trialId: digest({ trialLabel }),
    schedulingBlockId: digest({ trialLabel, block: 0 }),
    samplingUnitIds: {},
    trialSeed: digest({ trialLabel, seed: 0 }),
  };
}

function evaluatorRun(runId = 'run-a'): EvaluatorRunContext {
  return {
    runId,
    evaluationPlanDigest: digest({ runId, stage: 'evaluation' }),
  };
}

function evaluatorRecord(recordLabel = 'record-a'): EvaluatorRecordContext {
  return {
    targetId: 'target-a',
    sampleId: 'sample-a',
    trialIndex: 0,
    trialId: digest({ recordLabel, trial: 0 }),
    evaluatorId: 'exact',
    measurement: {
      instrumentId: 'test.omk.exact/v1',
      ensembleMemberId: 'local',
      replicateGroupId: 'primary',
      replicateIndex: 0,
    },
    evaluationId: digest({ recordLabel }),
    bindings: [{
      bindingId: 'actual',
      sourceKind: 'output',
      value: { answer: 'A' },
      classification: 'public',
    }, {
      bindingId: 'expected',
      sourceKind: 'expected',
      value: { answer: 'A' },
      classification: 'gold',
    }],
    metrics: [{
      metricId: 'correct',
      valueType: 'boolean',
      scope: 'sample',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    }],
  };
}

describe('same-process Runtime adapters', () => {
  it('forwards the native Executor signal and sealed contexts without retries or usage synthesis', async () => {
    const leaseCalls: string[] = [];
    const callbackOrder: string[] = [];
    let capturedSignal: AbortSignal | undefined;
    let capturedScope: SameProcessOperationScope | undefined;
    const identity = executorIdentity();
    const port = createSameProcessExecutorAdapter({
      identity,
      sessionIsolationKey: 'binding-scope-a',
      resourceLeases: resourceAccess('executor-a', 'executor', leaseCalls),
      implementation: {
        openRun({ run, resources }) {
          callbackOrder.push(`run.open:${run.runId}:${resources.bindingId}`);
          return { opened: run.runId };
        },
        openTrial({ trial, runState, scope }) {
          callbackOrder.push(`trial.open:${runState.opened}:${trial.targetId}`);
          capturedScope = scope;
          return { seed: trial.trialSeed };
        },
        async execute({ attempt, trial, trialState, scope }) {
          callbackOrder.push(`execute:${attempt.attemptNumber}`);
          capturedSignal = attempt.signal;
          expect(trialState.seed).toBe(trial.trialSeed);
          expect(scope).toBe(capturedScope);
          return {
            output: { value: { echoed: trial.input }, classification: 'public' },
          };
        },
        disposeTrial({ run }) { callbackOrder.push(`trial.dispose:${run.runId}`); },
        disposeRun({ run }) { callbackOrder.push(`run.dispose:${run.runId}`); },
      },
    });
    const runContext = executorRun();
    const trialContext = executorTrial();
    const run = await port.openRun(runContext);
    const trial = await run.openTrial(trialContext);
    const controller = new AbortController();
    const result = await trial.execute({
      attemptId: digest({ attempt: 1 }),
      attemptNumber: 1,
      signal: controller.signal,
    });

    expect(capturedSignal).toBe(controller.signal);
    expect(capturedScope?.sessionIsolationKey).toBe('binding-scope-a');
    expect(capturedScope?.runIsolationKey).not.toBe(capturedScope?.operationIsolationKey);
    expect(result).not.toHaveProperty('usage');
    expect(leaseCalls).toEqual(['executor-a:run-a']);
    await trial.dispose();
    await trial.dispose();
    await run.dispose();
    await run.dispose();
    expect(callbackOrder).toEqual([
      'run.open:run-a:executor-a',
      'trial.open:run-a:target-a',
      'execute:1',
      'trial.dispose:run-a',
      'run.dispose:run-a',
    ]);
  });

  it('lets cooperative Executor cancellation reach and settle the underlying call', async () => {
    const executeCalls = vi.fn();
    let observedSignal: AbortSignal | undefined;
    const port = createSameProcessExecutorAdapter({
      identity: executorIdentity(),
      sessionIsolationKey: 'binding-scope-a',
      resourceLeases: resourceAccess('executor-a', 'executor'),
      implementation: {
        openRun() { return {}; },
        openTrial() { return {}; },
        async execute({ attempt }) {
          executeCalls();
          observedSignal = attempt.signal;
          await new Promise<never>((_resolve, reject) => {
            if (attempt.signal.aborted) reject(attempt.signal.reason);
            else attempt.signal.addEventListener(
              'abort',
              () => reject(attempt.signal.reason),
              { once: true },
            );
          });
          throw new Error('unreachable');
        },
        disposeTrial() {},
        disposeRun() {},
      },
    });
    const run = await port.openRun(executorRun());
    const trial = await run.openTrial(executorTrial());
    const controller = new AbortController();
    const cause = new Error('stop underlying work');
    const executing = trial.execute({
      attemptId: digest({ attempt: 'cancel' }),
      attemptNumber: 1,
      signal: controller.signal,
    });
    controller.abort(cause);

    await expect(executing).rejects.toBe(cause);
    expect(observedSignal).toBe(controller.signal);
    expect(executeCalls).toHaveBeenCalledTimes(1);
    await trial.dispose();
    await run.dispose();
  });

  it('isolates concurrent runs and binding instances with derived scope keys', async () => {
    const scopes: Array<{ bindingId: string; runId: string; scope: SameProcessOperationScope }> = [];
    const implementation = {
      openRun: ({ run }: { run: Readonly<ExecutorRunContext> }) => ({ runId: run.runId }),
      openTrial: ({ scope, resources, runState }: {
        scope: SameProcessOperationScope;
        resources: OmkBindingResourceLease;
        runState: { runId: string };
      }) => {
        scopes.push({ bindingId: resources.bindingId, runId: runState.runId, scope });
        return {};
      },
      async execute() { return {}; },
      disposeTrial() {},
      disposeRun() {},
    };
    const first = createSameProcessExecutorAdapter({
      identity: executorIdentity(),
      sessionIsolationKey: 'binding-scope-a',
      resourceLeases: resourceAccess('executor-a', 'executor'),
      implementation,
    });
    const second = createSameProcessExecutorAdapter({
      identity: executorIdentity(),
      sessionIsolationKey: 'binding-scope-b',
      resourceLeases: resourceAccess('executor-b', 'executor'),
      implementation,
    });
    const [runA, runB, runC] = await Promise.all([
      first.openRun(executorRun('run-a')),
      first.openRun(executorRun('run-b')),
      second.openRun(executorRun('run-a')),
    ]);
    const [trialA, trialB, trialC] = await Promise.all([
      runA.openTrial(executorTrial('trial-a')),
      runB.openTrial(executorTrial('trial-a')),
      runC.openTrial(executorTrial('trial-a')),
    ]);

    expect(new Set(scopes.map((entry) => entry.scope.runIsolationKey)).size).toBe(3);
    expect(new Set(scopes.map((entry) => entry.scope.operationIsolationKey)).size).toBe(3);
    expect(scopes.map(({ bindingId, runId }) => `${bindingId}:${runId}`).sort()).toEqual([
      'executor-a:run-a',
      'executor-a:run-b',
      'executor-b:run-a',
    ]);
    await Promise.all([trialA.dispose(), trialB.dispose(), trialC.dispose()]);
    await Promise.all([runA.dispose(), runB.dispose(), runC.dispose()]);
  });

  it('releases a failed openRun reservation and captures an immutable identity snapshot', async () => {
    const sourceIdentity = executorIdentity();
    let calls = 0;
    const leaseResolver = resourceAccess('executor-a', 'executor') as {
      forRun(runId: string): OmkBindingResourceLease;
    };
    const implementation = {
      openRun() {
        calls += 1;
        if (calls === 1) throw new Error('open failed');
        return {};
      },
      openTrial() { return {}; },
      async execute() { return {}; },
      disposeTrial() {},
      disposeRun() {},
    };
    const port = createSameProcessExecutorAdapter({
      identity: sourceIdentity,
      sessionIsolationKey: 'binding-scope-a',
      resourceLeases: leaseResolver,
      implementation,
    });
    sourceIdentity.implementationId = 'test.omk.mutated/v1';
    implementation.openRun = () => { throw new Error('mutated implementation'); };
    leaseResolver.forRun = () => { throw new Error('mutated lease resolver'); };

    await expect(port.openRun(executorRun())).rejects.toThrow('open failed');
    const reopened = await port.openRun(executorRun());
    expect(port.identity.implementationId).toBe('test.omk.same-process-executor/v1');
    expect(Object.isFrozen(port.identity)).toBe(true);
    expect(calls).toBe(2);
    await reopened.dispose();
  });

  it('closes Executor lifecycle boundaries without releasing a live trial reservation', async () => {
    let trialDisposals = 0;
    let runDisposals = 0;
    const port = createSameProcessExecutorAdapter({
      identity: executorIdentity(),
      sessionIsolationKey: 'binding-scope-a',
      resourceLeases: resourceAccess('executor-a', 'executor'),
      implementation: {
        openRun() { return {}; },
        openTrial() { return {}; },
        async execute() { return {}; },
        disposeTrial() { trialDisposals += 1; },
        disposeRun() { runDisposals += 1; },
      },
    });
    const run = await port.openRun(executorRun());
    const trial = await run.openTrial(executorTrial());
    await expect(run.openTrial(executorTrial())).rejects.toThrow('already owns trial');
    const disposingRun = run.dispose();

    await expect(run.openTrial(executorTrial('trial-b'))).rejects.toThrow('already disposed');
    await expect(trial.execute({
      attemptId: digest({ attempt: 'after-run-dispose' }),
      attemptNumber: 1,
      signal: new AbortController().signal,
    })).rejects.toThrow('already disposed');
    await expect(port.openRun(executorRun())).rejects.toThrow('already owns run');
    await disposingRun;

    const disposingTrial = trial.dispose();
    await expect(trial.execute({
      attemptId: digest({ attempt: 'during-trial-dispose' }),
      attemptNumber: 1,
      signal: new AbortController().signal,
    })).rejects.toThrow('already disposed');
    await disposingTrial;
    const reopened = await port.openRun(executorRun());
    await reopened.dispose();
    expect(trialDisposals).toBe(1);
    expect(runDisposals).toBe(2);
  });

  it('releases a disposed run when an in-flight trial open subsequently fails', async () => {
    let rejectTrial: ((error: Error) => void) | undefined;
    const port = createSameProcessExecutorAdapter({
      identity: executorIdentity(),
      sessionIsolationKey: 'binding-scope-a',
      resourceLeases: resourceAccess('executor-a', 'executor'),
      implementation: {
        openRun() { return {}; },
        openTrial() {
          return new Promise<never>((_resolve, reject) => { rejectTrial = reject; });
        },
        async execute() { return {}; },
        disposeTrial() {},
        disposeRun() {},
      },
    });
    const run = await port.openRun(executorRun());
    const opening = expect(run.openTrial(executorTrial())).rejects.toThrow('trial failed');
    await run.dispose();
    await expect(port.openRun(executorRun())).rejects.toThrow('already owns run');
    rejectTrial?.(new Error('trial failed'));
    await opening;

    const reopened = await port.openRun(executorRun());
    await reopened.dispose();
  });

  it('waits for an in-flight Executor attempt before disposing its trial state', async () => {
    let releaseExecution: (() => void) | undefined;
    let executionStarted = false;
    let trialDisposed = false;
    const port = createSameProcessExecutorAdapter({
      identity: executorIdentity(),
      sessionIsolationKey: 'binding-scope-a',
      resourceLeases: resourceAccess('executor-a', 'executor'),
      implementation: {
        openRun() { return {}; },
        openTrial() { return {}; },
        async execute() {
          executionStarted = true;
          await new Promise<void>((resolve) => { releaseExecution = resolve; });
          return {};
        },
        disposeTrial() { trialDisposed = true; },
        disposeRun() {},
      },
    });
    const run = await port.openRun(executorRun());
    const trial = await run.openTrial(executorTrial());
    const execution = trial.execute({
      attemptId: digest({ attempt: 'in-flight' }),
      attemptNumber: 1,
      signal: new AbortController().signal,
    });
    await expect.poll(() => executionStarted).toBe(true);
    const disposal = trial.dispose();
    await Promise.resolve();
    expect(trialDisposed).toBe(false);
    releaseExecution?.();
    await execution;
    await disposal;
    expect(trialDisposed).toBe(true);
    await run.dispose();
  });

  it('forwards Evaluator records and signal without manufacturing usage or scores', async () => {
    const callbacks: string[] = [];
    let observedSignal: AbortSignal | undefined;
    const port = createSameProcessEvaluatorAdapter({
      identity: evaluatorIdentity(),
      sessionIsolationKey: 'evaluator-scope-a',
      resourceLeases: resourceAccess('evaluator-a', 'evaluator'),
      implementation: {
        openRun({ run }) {
          callbacks.push(`run.open:${run.runId}`);
          return { runId: run.runId };
        },
        openRecord({ record }) {
          callbacks.push(`record.open:${record.evaluationId}`);
          return { actual: record.bindings[0]?.value };
        },
        async evaluate({ record, recordState, attempt }) {
          observedSignal = attempt.signal;
          const expected = record.bindings.find((binding) => (
            binding.bindingId === 'expected'
          ))?.value;
          return {
            observations: [{
              metricId: 'correct',
              observationStatus: 'observed',
              valueType: 'boolean',
              value: JSON.stringify(recordState.actual) === JSON.stringify(expected),
            }],
          };
        },
        disposeRecord() { callbacks.push('record.dispose'); },
        disposeRun() { callbacks.push('run.dispose'); },
      },
    });
    const run = await port.openRun(evaluatorRun());
    const record = await run.openRecord(evaluatorRecord());
    const controller = new AbortController();
    const result = await record.evaluate({
      attemptId: digest({ evaluatorAttempt: 1 }),
      attemptNumber: 1,
      signal: controller.signal,
    });

    expect(observedSignal).toBe(controller.signal);
    expect(result.observations).toEqual([expect.objectContaining({ value: true })]);
    expect(result).not.toHaveProperty('usage');
    await record.dispose();
    await record.dispose();
    await run.dispose();
    await run.dispose();
    expect(callbacks).toEqual([
      'run.open:run-a',
      `record.open:${evaluatorRecord().evaluationId}`,
      'record.dispose',
      'run.dispose',
    ]);
  });

  it('waits for an in-flight Evaluator attempt before disposing its record state', async () => {
    let releaseEvaluation: (() => void) | undefined;
    let evaluationStarted = false;
    let recordDisposed = false;
    const port = createSameProcessEvaluatorAdapter({
      identity: evaluatorIdentity(),
      sessionIsolationKey: 'evaluator-scope-a',
      resourceLeases: resourceAccess('evaluator-a', 'evaluator'),
      implementation: {
        openRun() { return {}; },
        openRecord() { return {}; },
        async evaluate() {
          evaluationStarted = true;
          await new Promise<void>((resolve) => { releaseEvaluation = resolve; });
          return { observations: [] };
        },
        disposeRecord() { recordDisposed = true; },
        disposeRun() {},
      },
    });
    const run = await port.openRun(evaluatorRun());
    const record = await run.openRecord(evaluatorRecord());
    const evaluation = record.evaluate({
      attemptId: digest({ attempt: 'in-flight' }),
      attemptNumber: 1,
      signal: new AbortController().signal,
    });
    await expect.poll(() => evaluationStarted).toBe(true);
    const disposal = record.dispose();
    await Promise.resolve();
    expect(recordDisposed).toBe(false);
    releaseEvaluation?.();
    await evaluation;
    await disposal;
    expect(recordDisposed).toBe(true);
    await run.dispose();
  });

  it('closes Evaluator lifecycle boundaries and releases failed record opens', async () => {
    let recordOpenCalls = 0;
    const port = createSameProcessEvaluatorAdapter({
      identity: evaluatorIdentity(),
      sessionIsolationKey: 'evaluator-scope-a',
      resourceLeases: resourceAccess('evaluator-a', 'evaluator'),
      implementation: {
        openRun() { return {}; },
        openRecord() {
          recordOpenCalls += 1;
          if (recordOpenCalls === 1) throw new Error('record open failed');
          return {};
        },
        async evaluate() { return { observations: [] }; },
        disposeRecord() {},
        disposeRun() {},
      },
    });
    const run = await port.openRun(evaluatorRun());
    await expect(run.openRecord(evaluatorRecord())).rejects.toThrow('record open failed');
    const record = await run.openRecord(evaluatorRecord());
    await expect(run.openRecord(evaluatorRecord())).rejects.toThrow('already owns record');
    await record.dispose();
    await run.dispose();

    await expect(run.openRecord(evaluatorRecord('record-b'))).rejects.toThrow('already disposed');
    await expect(record.evaluate({
      attemptId: digest({ attempt: 'after-record-dispose' }),
      attemptNumber: 1,
      signal: new AbortController().signal,
    })).rejects.toThrow('already disposed');
    expect(recordOpenCalls).toBe(2);
  });

  it('fails invalid adapter configuration before resolving any run lease', () => {
    const leaseCalls: string[] = [];
    const invalidIdentity = { ...executorIdentity(), fingerprint: '' };
    expect(() => createSameProcessExecutorAdapter({
      identity: invalidIdentity,
      sessionIsolationKey: 'binding-scope-a',
      resourceLeases: resourceAccess('executor-a', 'executor', leaseCalls),
      implementation: {
        openRun() { return {}; },
        openTrial() { return {}; },
        async execute() { return {}; },
        disposeTrial() {},
        disposeRun() {},
      },
    })).toThrow();
    expect(() => createSameProcessExecutorAdapter({
      identity: executorIdentity(),
      sessionIsolationKey: '   ',
      resourceLeases: resourceAccess('executor-a', 'executor', leaseCalls),
      implementation: {
        openRun() { return {}; },
        openTrial() { return {}; },
        async execute() { return {}; },
        disposeTrial() {},
        disposeRun() {},
      },
    })).toThrow('non-empty sessionIsolationKey');
    expect(() => createSameProcessExecutorAdapter({
      identity: executorIdentity(),
      sessionIsolationKey: 'binding-scope-a',
      resourceLeases: resourceAccess('executor-a', 'executor', leaseCalls),
      implementation: {
        openRun() { return {}; },
        openTrial() { return {}; },
        execute: undefined,
        disposeTrial() {},
        disposeRun() {},
      },
    } as never)).toThrow('every lifecycle callback');
    expect(leaseCalls).toEqual([]);
  });
});
