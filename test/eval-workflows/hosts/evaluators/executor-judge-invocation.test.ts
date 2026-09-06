import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../../../src/executors/contracts/result.js';
import type { ExecutorFn } from '../../../../src/executors/contracts/ports.js';
import type { ExecutorRuntimeFingerprint } from '../../../../src/executors/contracts/runtime.js';
import * as executors from '../../../../src/executors/index.js';
import * as fingerprints from '../../../../src/executors/core/runtime-fingerprint.js';
import * as application from '../../../../src/eval-workflows/hosts/application.js';
import * as registered from '../../../../src/eval-workflows/hosts/composition/registered-runtime.js';
import { createNodeProductionComposition } from '../../../../src/eval-workflows/hosts/composition/node-runtime.js';
import { createJudgeProviderRuntimeIdentity } from '../../../../src/eval-workflows/hosts/composition/judge-provider-identity.js';
import * as adapter from '../../../../src/eval-workflows/hosts/evaluators/executor-judge-invocation.js';
import type { OmkLlmJudgeInvocationRequest, OmkLlmJudgeInvocationResolver } from '../../../../src/eval-workflows/hosts/evaluators/llm-judge-invocation.js';
import type { CliEvaluationCompileResult } from '../../../../src/eval-workflows/input-compilation/index.js';
import * as dshExecutor from '../../../../src/dsh-plugin/host-executor.js';
import { runDshCoreEvaluation } from '../../../../src/dsh-plugin/core-command.js';

afterEach(() => vi.restoreAllMocks());

function result(patch: Partial<ExecResult> = {}): ExecResult {
  return {
    ok: true, output: 'judge output', durationMs: 1, durationApiMs: 1,
    inputTokens: 3, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUSD: 0.02, stopReason: 'completed', numTurns: 1,
    ...patch,
  };
}

function runtime(executor: string): ExecutorRuntimeFingerprint {
  return {
    executor, model: 'judge-model', runtimeKind: 'api', fingerprint: 'test-provider-v1',
    capabilities: { systemPrompt: 'native', costUSD: 'reported', trace: 'none', skillIsolation: 'none' },
  };
}

function request(signal = new AbortController().signal): OmkLlmJudgeInvocationRequest {
  return {
    executorId: 'fixture', model: 'judge-model', system: 'system bytes\n', prompt: 'prompt bytes\n',
    promptId: 'fixture-prompt', promptHash: 'fixture-hash', effort: 'high', signal,
  };
}

const identity = createJudgeProviderRuntimeIdentity({
  executorId: 'fixture', model: 'judge-model', executorRuntime: runtime('fixture'),
});
const measured = {
  inputTokens: 3, outputTokens: 5, totalTokens: 8,
  providerCost: { amount: 0.02, currency: 'USD', reportedByProvider: true },
};

describe('executor-backed judge invocation conversion', () => {
  it('forwards exactly one call without changing prompt bytes, effort or signal', async () => {
    const executor = vi.fn<ExecutorFn>().mockResolvedValue(result());
    const port = adapter.createExecutorJudgeInvocationPort(executor, identity);
    const input = request();
    expect(port.identity).toBe(identity);
    expect(port.providerCost).toEqual({ reporting: 'optional' });
    expect(Object.isFrozen(port)).toBe(true);
    await expect(port.invoke(input)).resolves.toEqual({
      invocationStatus: 'completed', output: 'judge output', usage: measured,
    });
    expect(executor).toHaveBeenCalledExactlyOnceWith({
      model: input.model, system: input.system, prompt: input.prompt,
      effort: input.effort, abortSignal: input.signal,
    });
  });

  it.each([
    { ok: true, output: '', completed: true },
    { ok: true, output: null, completed: false },
    { ok: false, output: null, completed: false },
    { ok: false, output: 'untrusted failed output', completed: false },
  ])('classifies ok=$ok, output=$output without discarding measured usage', async ({ ok, output, completed }) => {
    const executor = vi.fn<ExecutorFn>().mockResolvedValue(result({ ok, output, error: 'private provider error' }));
    await expect(adapter.createExecutorJudgeInvocationPort(executor, identity).invoke(request()))
      .resolves.toEqual(completed
        ? { invocationStatus: 'completed', output, usage: measured }
        : { invocationStatus: 'failed', reasonCode: 'provider-invocation-failed', usage: measured });
  });

  it.each([
    { tokens: undefined, cost: undefined },
    { tokens: true, cost: true },
    { tokens: false, cost: true },
    { tokens: true, cost: false },
    { tokens: false, cost: false },
  ])('keeps independently unreported telemetry absent: tokens=$tokens, cost=$cost', async ({ tokens, cost }) => {
    const executor = vi.fn<ExecutorFn>().mockResolvedValue(result({
      tokenUsageReportedByExecutor: tokens, costReportedByExecutor: cost,
    }));
    const usage = {
      ...(tokens === false ? {} : { inputTokens: 3, outputTokens: 5, totalTokens: 8 }),
      ...(cost === false ? {} : { providerCost: measured.providerCost }),
    };
    await expect(adapter.createExecutorJudgeInvocationPort(executor, identity).invoke(request()))
      .resolves.toEqual({
        invocationStatus: 'completed', output: 'judge output',
        ...(tokens === false && cost === false ? {} : { usage }),
      });
  });

  it('retains an explicitly reported zero rather than treating it as missing', async () => {
    const executor = vi.fn<ExecutorFn>().mockResolvedValue(result({
      inputTokens: 0, outputTokens: 0, costUSD: 0,
      tokenUsageReportedByExecutor: true, costReportedByExecutor: true,
    }));
    await expect(adapter.createExecutorJudgeInvocationPort(executor, identity).invoke(request()))
      .resolves.toMatchObject({ usage: {
        inputTokens: 0, outputTokens: 0, totalTokens: 0,
        providerCost: { amount: 0, currency: 'USD', reportedByProvider: true },
      } });
  });

  it.each([
    { aborted: false, throws: false }, { aborted: false, throws: true },
    { aborted: true, throws: false }, { aborted: true, throws: true },
  ])('redacts failure details and preserves cancellation: aborted=$aborted, throws=$throws', async ({ aborted, throws }) => {
    const controller = new AbortController();
    const executor = vi.fn<ExecutorFn>().mockImplementation(async () => {
      if (aborted) controller.abort('private cancellation reason');
      if (throws) throw new Error('private provider error');
      return result({ ok: false, output: null, error: 'private provider error' });
    });
    await expect(adapter.createExecutorJudgeInvocationPort(executor, identity).invoke(request(controller.signal)))
      .resolves.toEqual({
        invocationStatus: 'failed',
        reasonCode: aborted ? 'provider-invocation-cancelled' : 'provider-invocation-failed',
        ...(throws ? {} : { usage: measured }),
      });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('leaves completed-response cancellation races to the calling Runtime policy', async () => {
    const controller = new AbortController();
    const executor = vi.fn<ExecutorFn>().mockImplementation(async () => {
      controller.abort();
      return result();
    });
    await expect(adapter.createExecutorJudgeInvocationPort(executor, identity).invoke(request(controller.signal)))
      .resolves.toEqual({ invocationStatus: 'completed', output: 'judge output', usage: measured });
  });
});

function context(executorId: string): Parameters<OmkLlmJudgeInvocationResolver>[0] {
  // Host wiring consumes qualification only; Core binding validation has its own matrix.
  return { binding: { qualification: {
    executorId, model: 'judge-model', deploymentRevision: 'deployment-a',
  } } } as Parameters<OmkLlmJudgeInvocationResolver>[0];
}

describe('host judge invocation wiring', () => {
  it('lets Node select the executor and fingerprint while sharing the invocation port', async () => {
    const stop = new Error('composition captured');
    const compose = vi.spyOn(registered, 'createRegisteredEvaluationComposition').mockImplementation(() => { throw stop; });
    const executor = vi.fn<ExecutorFn>().mockResolvedValue(result());
    const create = vi.spyOn(executors, 'createExecutor').mockReturnValue(executor);
    const fingerprint = vi.spyOn(fingerprints, 'resolveExecutorRuntimeFingerprint').mockReturnValue(runtime('codex'));
    const shared = vi.spyOn(adapter, 'createExecutorJudgeInvocationPort');
    const environment = {};
    await expect(createNodeProductionComposition({
      // Intercept the assembly seam before preparation or filesystem side effects.
      compiled: { runtimeBinding: { bindings: [] } } as unknown as CliEvaluationCompileResult,
      projectRoot: tmpdir(), outputDirectory: join(tmpdir(), 'unused-reports'),
      resourceLeaseRoot: join(tmpdir(), 'unused-leases'),
      capabilities: {
        environment, classifiedEnvironment: {},
        async resolveExecutable() { throw new Error('unused target executor'); },
        requiredCredential() { throw new Error('unused credential'); },
      },
    })).rejects.toBe(stop);
    const resolve = compose.mock.calls[0]![0].resolveJudgeInvocation!;
    const binding = await resolve(context('codex'));
    expect(create).toHaveBeenCalledWith('codex');
    expect(fingerprint).toHaveBeenCalledWith('codex', 'judge-model', { env: environment }, executor);
    expect(shared).toHaveBeenCalledWith(executor, binding.port.identity);
    expect(binding.port).toBe(shared.mock.results[0]!.value);
    expect(binding.preflightDeclarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'provider-validates-credential' }),
    ]));
    await binding.port.invoke(request());
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('lets DSH inherit the host executor and identity without entering Node composition', async () => {
    const stop = new Error('application captured');
    const createApplication = vi.spyOn(application, 'createHostedEvaluationApplication').mockImplementation(() => { throw stop; });
    const executor = Object.assign(vi.fn<ExecutorFn>().mockResolvedValue(result()), {
      runtimeFingerprint: vi.fn(() => runtime('dsh-host')),
    });
    const create = vi.spyOn(dshExecutor, 'createDshHostExecutor').mockReturnValue(executor);
    const shared = vi.spyOn(adapter, 'createExecutorJudgeInvocationPort');
    const nodeExecutor = vi.spyOn(executors, 'createExecutor');
    const host = {} as dshExecutor.DshHostContextLike;
    const parentAgent = { options: { model: 'judge-model' } } as dshExecutor.DshAgentLike;
    await expect(runDshCoreEvaluation({
      host, parentAgent, signal: new AbortController().signal, projectRoot: tmpdir(),
      config: { samples: 'samples.json', variants: [
        { name: 'control', role: 'control', artifact: 'baseline' },
        { name: 'treatment', role: 'treatment', artifact: 'fixture-skill' },
      ] },
    })).rejects.toBe(stop);
    const resolve = createApplication.mock.calls[0]![0].resolveJudgeInvocation!;
    const binding = await resolve(context('dsh-host'));
    expect(create).toHaveBeenCalledWith(host, { parentAgent });
    expect(executor.runtimeFingerprint).toHaveBeenCalledWith('judge-model');
    expect(shared).toHaveBeenCalledWith(executor, binding.port.identity);
    expect(binding.port).toBe(shared.mock.results[0]!.value);
    expect(binding.preflightDeclarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'host-session-owns-credential' }),
    ]));
    await binding.port.invoke(request());
    expect(executor).toHaveBeenCalledTimes(1);
    expect(nodeExecutor).not.toHaveBeenCalled();
  });
});
