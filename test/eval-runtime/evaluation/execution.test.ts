import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { EvaluationConfigurationError, checkExecutor, evaluate, executeEvaluation, scoreExecutedEvaluation, type Executor, type Variant } from "../../../src/eval-runtime/index.js";
import { type Config, type Input, comparisonAnalysis, controlSpec, countedScoreInput, executor, fixedClock, pairedInput, treatmentSpec, variant } from '../fixtures/evaluation.js';

describe('canonical eval-runtime execution', () => {
it('executes a declaration without scoring it and scores the handle without a new Target call', async () => {
    let targetInvocations = 0;
    const scoreCalls = vi.fn();
    const declaration = executor(async ({ input, config, signal }) => {
      targetInvocations += 1;
      signal.throwIfAborted();
      return { output: config.answers[input.prompt] };
    });
    const input = countedScoreInput(declaration, scoreCalls);

    const executed = await executeEvaluation(input, {
      runId: 'staged-execute',
      clock: fixedClock,
    });

    expect(targetInvocations).toBe(4);
    expect(scoreCalls).not.toHaveBeenCalled();
    expect(executed.bundleOrigin).toBe('runtime');
    expect(executed.runId).toBe('staged-execute');
    expect(executed.bundle.executionBundleStatus).toBe('completed');
    expect(executed.executionPlanDigest).toBe(executed.bundle.executionPlanDigest);
    expect(executed.executionInputDigest).toBe(executed.bundle.executionInputDigest);
    expect(executed.bundle.records).toHaveLength(4);
    scoreCalls.mockClear();

    const result = await scoreExecutedEvaluation(input, executed, { clock: fixedClock });

    expect(targetInvocations).toBe(4);
    expect(scoreCalls).toHaveBeenCalledTimes(4);
    expect(result.status).toBe('completed');
    expect(result.runId).not.toBe(executed.runId);
    expect(result.artifacts?.execution).toBe(executed.bundle);
  });

it('keeps the chained execute and score end state identical to one evaluate call', async () => {
    const scoreCalls = vi.fn();
    const input = countedScoreInput(executor(), scoreCalls);
    const direct = await evaluate(input, { runId: 'staged-equivalence', clock: fixedClock });
    const executed = await executeEvaluation(input, {
      runId: 'staged-equivalence',
      clock: fixedClock,
    });
    const chained = await scoreExecutedEvaluation(input, executed, {
      runId: 'staged-equivalence',
      clock: fixedClock,
    });

    expect(chained.status).toBe('completed');
    expect(chained).toEqual(direct);
  });

it('re-scores one execution handle against changed Gold without invoking the Target again', async () => {
    let targetInvocations = 0;
    const declaration = executor(async ({ input, config, signal }) => {
      targetInvocations += 1;
      signal.throwIfAborted();
      return { output: config.answers[input.prompt] };
    });
    const input = pairedInput(declaration);
    const executed = await executeEvaluation(input, {
      runId: 'staged-gold-source',
      clock: fixedClock,
    });
    expect(targetInvocations).toBe(4);

    const original = await scoreExecutedEvaluation(input, executed, {
      clock: fixedClock,
    });
    const changed = pairedInput(declaration);
    changed.dataset.samples[0].expected = 'wrong';
    const rescored = await scoreExecutedEvaluation(changed, executed, {
      clock: fixedClock,
    });

    expect(targetInvocations).toBe(4);
    expect(original.status).toBe('completed');
    expect(rescored.status).toBe('completed');
    expect(rescored.artifacts?.execution).toBe(executed.bundle);
    expect(rescored.artifacts?.evaluation?.bundleDigest)
      .not.toBe(original.artifacts?.evaluation?.bundleDigest);
    // Hosts index Runs by an immutable runId, so two scoring versions must not collide on it.
    expect(rescored.runId).not.toBe(original.runId);
  });

it('rejects a scoring declaration whose execution stage changed before any Target call', async () => {
    let targetInvocations = 0;
    const declaration = executor(async ({ input, config, signal }) => {
      targetInvocations += 1;
      signal.throwIfAborted();
      return { output: config.answers[input.prompt] };
    });
    const executed = await executeEvaluation(pairedInput(declaration), {
      runId: 'staged-mismatch-source',
      clock: fixedClock,
    });
    expect(targetInvocations).toBe(4);

    const incompatible = pairedInput(declaration);
    incompatible.variants = [
      variant(declaration, controlSpec),
      variant(declaration, { ...treatmentSpec, config: { answers: { one: 'A', two: 'A' } } }),
    ];
    let mismatchError: unknown;
    try {
      await scoreExecutedEvaluation(incompatible, executed, {
        runId: 'staged-mismatch-scored',
        clock: fixedClock,
      });
    } catch (caught) {
      mismatchError = caught;
    }

    expect(mismatchError).toMatchObject({
      code: 'EVAL_RUNTIME_REUSE_INVALID',
      message: 'ExecutedEvaluation 与新声明的可复用阶段不一致。',
    });
    expect((mismatchError as EvaluationConfigurationError).cause).toBeUndefined();
    expect(targetInvocations).toBe(4);
  });

it('rejects forged or cloned execution handles', async () => {
    const input = pairedInput();
    const executed = await executeEvaluation(input, { runId: 'staged-forged-source' });

    await expect(scoreExecutedEvaluation(input, structuredClone(executed), {
      runId: 'staged-forged-cloned',
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_REUSE_INVALID' });
    await expect(scoreExecutedEvaluation(input, {
      ...structuredClone(executed),
      bundleOrigin: 'runtime',
    } as never, { runId: 'staged-forged-object' })).rejects.toMatchObject({
      code: 'EVAL_RUNTIME_REUSE_INVALID',
    });
  });

it('keeps a cancelled execution as a value that later scoring resolves without a Target call', async () => {
    let targetInvocations = 0;
    const declaration = executor(async ({ input, config, signal }) => {
      targetInvocations += 1;
      signal.throwIfAborted();
      return { output: config.answers[input.prompt] };
    });
    const input = pairedInput(declaration);
    const controller = new AbortController();
    controller.abort(new Error('caller cancellation'));

    const executed = await executeEvaluation(input, {
      runId: 'staged-cancel-source',
      clock: fixedClock,
      signal: controller.signal,
    });

    expect(targetInvocations).toBe(0);
    expect(executed.bundle.executionBundleStatus).toBe('cancelled');

    const result = await scoreExecutedEvaluation(input, executed, {
      clock: fixedClock,
      signal: controller.signal,
    });

    expect(targetInvocations).toBe(0);
    expect(result.status).toBe('cancelled');
    expect(result.report?.status.runStatus).toBe('cancelled');
  });

it('preserves Executor trace, usage, and required-telemetry failures end to end', async () => {
    const declaration: Executor<string, undefined, { answer: string; }, { steps: string[]; }> = {
      executorId: 'test.telemetry-executor/v1',
      version: '1.0.0',
      schemas: {
        input: z.string(),
        output: z.object({ answer: z.string() }).strict(),
        trace: z.object({ steps: z.array(z.string()) }).strict(),
      },
      outputClassification: 'public',
      traceClassification: 'sensitive',
      capabilities: {
        determinism: 'deterministic',
        cancellation: 'cooperative',
        concurrency: { safety: 'parallel-safe' },
        seedControl: 'unsupported',
        telemetry: {
          trace: 'required',
          usage: 'required',
          providerCost: { reporting: 'optional' },
        },
      },
      async execute() {
        return {
          output: { answer: 'ok' },
          trace: { steps: ['done'] },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const makeVariant = (
      variantId: string,
      artifact: Variant<string, undefined, { answer: string; }>['artifact'],
      boundExecutor = declaration,
    ): Variant<string, undefined, { answer: string; }, { steps: string[]; }> => ({
      variantId,
      artifact,
      execution: { executor: boundExecutor },
    });
    const input = {
      dataset: {
        datasetId: 'telemetry',
        samples: [{ sampleId: 'one', input: 'question', expected: { answer: 'ok' } }],
      },
      variants: [makeVariant('only', {
        name: 'candidate', kind: 'prompt', source: 'inline', content: 'Answer.',
      })],
      evaluators: [{ evaluatorKind: 'exact-match' as const }],
      comparisons: [],
      analyses: [{
        analysisId: 'only-correct',
        analysisKind: 'quality-interval' as const,
        statistic: 'mean' as const,
        variantId: 'only',
        metricId: 'correct',
        confidence: {
          method: 'percentile-bootstrap' as const,
          level: 0.95,
          resamples: 100,
        },
      }],
      experiment: { seed: 'telemetry-seed', sampling: { samplingKind: 'solo' as const } },
      policy: {},
    };

    const result = await evaluate(input, {
      runId: 'telemetry-evaluate',
      clock: fixedClock,
    });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'completed',
      output: { classification: 'public', value: { answer: 'ok' } },
      trace: { classification: 'sensitive', value: { steps: ['done'] } },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    const missingTraceExecutor: typeof declaration = {
      ...declaration,
      async execute() {
        return {
          output: { answer: 'ok' },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const missingTrace = await evaluate({
      ...input,
      variants: [makeVariant('only', input.variants[0].artifact, missingTraceExecutor)]
    }, {
      runId: 'telemetry-missing-trace',
      clock: fixedClock
    });
    expect(missingTrace.status).toBe('completed');
    if (missingTrace.status !== 'completed') return;
    expect(missingTrace.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION' },
    });
  });

it('captures mutable Variant config and Executor callbacks before asynchronous execution', async () => {
    const declaration = executor();
    const mutable = structuredClone(treatmentSpec) as {
      variantId: string;
      artifact: typeof treatmentSpec.artifact;
      runtimeContext: { values: { model: string; }; };
      config: Config;
    };
    const pending = evaluate({
      ...pairedInput(declaration),
      variants: [variant(declaration, controlSpec), variant(declaration, mutable)]
    }, {
      clock: fixedClock
    });
    mutable.config.answers.one = 'mutated';
    (declaration as { execute: Executor<Input, Config, string>['execute']; }).execute = async () => ({
      output: 'mutated',
    });

    const result = await pending;
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records.filter((record) => (
      record.targetId === treatmentSpec.variantId
      && record.executionStatus === 'completed'
      && record.output?.contentKind === 'inline'
      && record.output.value === 'A'
    ))).toHaveLength(1);
  });

it('keeps structured Executor failures stable and provider-private throws redacted', async () => {
    const privateMessage = 'provider-private-executor-message';
    const declaration = executor(async ({ variantId, input, config }) => {
      if (variantId === treatmentSpec.variantId) return { errorCode: 'host-capacity-exhausted' };
      if (input.prompt === 'two') throw new Error(privateMessage);
      return { output: config.answers[input.prompt] };
    });
    const result = await evaluate({ ...pairedInput(declaration), decision: undefined });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.artifacts === undefined) return;
    const failures = result.artifacts.execution.records.filter(
      (record) => record.executionStatus === 'failed',
    );
    expect(failures.map((record) => record.error.code)).toEqual(expect.arrayContaining([
      'EVAL_RUNTIME_EXECUTOR_FAILED', 'host-capacity-exhausted',
    ]));
    expect(JSON.stringify(result)).not.toContain(privateMessage);
  });

it('maps output schema mismatches to stable redacted execution failures', async () => {
    const privateOutput = { answer: 'must-not-be-persisted' };
    const declaration = executor(async () => ({ output: privateOutput as never }));
    const result = await evaluate({
      ...pairedInput(declaration),
      evaluators: [{ evaluatorKind: 'exact-match', metricId: 'schema-safe-correct' }],
      comparisons: [{
        comparisonId: 'baseline-vs-candidate',
        controlVariantId: 'prompt-v1', treatmentVariantIds: ['prompt-v2'],
        metricIds: ['schema-safe-correct'],
      }],
      analyses: comparisonAnalysis('schema-safe-correct'),
      decision: undefined
    }, {
      runId: 'schema-mismatch'
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.artifacts === undefined) return;
    expect(result.artifacts.execution.records.every((record) => (
      record.executionStatus === 'failed'
      && record.error.code === 'EVAL_RUNTIME_EXECUTOR_OUTPUT_INVALID'
    ))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateOutput.answer);
  });

it('checks a Variant-bound Executor through real success, failure, and cancellation', async () => {
    const declaration = executor(async ({ input, config, signal }) => {
      if (input.prompt === 'failure') return { errorCode: 'expected-failure' };
      if (input.prompt === 'cancellation') {
        await new Promise((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }
      return { output: config.answers[input.prompt] };
    });
    const result = await checkExecutor({
      variant: variant(declaration, treatmentSpec),
      success: { input: { prompt: 'one' }, expected: 'A' },
      failure: { input: { prompt: 'failure' }, expectedErrorCode: 'expected-failure' },
      cancellation: { input: { prompt: 'cancellation' } },
    });

    expect(result.conformant, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.every((check) => check.checkStatus === 'passed')).toBe(true);
  });
});
