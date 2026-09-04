import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  EvaluationConfigurationError,
  EvaluationEventConsumptionError,
  checkExecutor,
  evaluate,
  type Clock,
  type Executor,
} from '../../src/eval-runtime/index.js';
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createInvokeExecutorIdentity,
  createJsonExecutorAdapter,
  createMeasurementPolicy,
  createPairedComparisonDefinition,
  createRubricJudgeKit,
  createRuntimeIdentity,
  runEvaluation,
} from '../../src/eval-runtime/advanced.js';

type Input = { prompt: string };
type Config = { answers: Record<string, string> };

function executor(
  execute?: Executor<Input, Config, string>['execute'],
): Executor<Input, Config, string> {
  return {
    executorId: 'test.answer-executor/v1',
    version: '1.0.0',
    schemas: {
      input: z.object({ prompt: z.string() }).strict(),
      config: z.object({ answers: z.record(z.string(), z.string()) }).strict(),
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
    fingerprintFacets: { deploymentRevision: 'test-one' },
    execute: execute ?? (async ({ input, config, signal }) => {
      signal.throwIfAborted();
      return { output: config.answers[input.prompt] };
    }),
  };
}

const control = {
  variantId: 'prompt-v1',
  artifact: {
    name: 'baseline',
    kind: 'baseline',
    source: 'baseline',
    content: null,
  },
  config: { answers: { one: 'A', two: 'wrong' } },
} as const;

const treatment = {
  variantId: 'prompt-v2',
  artifact: {
    name: 'candidate',
    kind: 'prompt',
    source: 'inline',
    content: 'Answer exactly.',
  },
  runtimeContext: { values: { model: 'test-model' } },
  config: { answers: { one: 'A', two: 'B' } },
} as const;

const fixedClock: Clock = {
  monotonicNow: () => 0,
  timestamp: () => '2026-09-04T00:00:00.000Z',
  sleep: () => Promise.resolve(),
};

const manualArtifactSchema = z.object({
  name: z.string(),
  kind: z.enum(['baseline', 'skill', 'prompt', 'agent', 'workflow']),
  source: z.enum(['baseline', 'variant-name', 'file-path', 'git', 'inline', 'custom']),
  content: z.string().nullable(),
}).strict();

function manualExecutorIdentity(declaration: Executor<Input, Config, string>) {
  return createInvokeExecutorIdentity({
    implementationId: declaration.executorId,
    version: declaration.version,
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'optional', providerCost: { reporting: 'optional' } },
    fingerprintFacets: {
      facade: {
        version: 'omk.eval-runtime.evaluate/v1',
        outputClassification: 'public',
        traceClassification: 'public',
      },
      host: { deploymentRevision: 'test-one' },
    },
  });
}

function variantEnvelope(variant: typeof control | typeof treatment) {
  return {
    schemaVersion: 'omk.eval-runtime.variant-config/v1' as const,
    artifact: variant.artifact,
    ...('runtimeContext' in variant ? { runtimeContext: variant.runtimeContext } : {}),
    executorConfig: variant.config,
  };
}

function manualExecutorPort(declaration: Executor<Input, Config, string>) {
  const envelopeSchema = z.object({
    schemaVersion: z.literal('omk.eval-runtime.variant-config/v1'),
    artifact: manualArtifactSchema,
    runtimeContext: z.object({ values: z.json().optional(), cwd: z.string().optional() })
      .strict().optional(),
    executorConfig: z.object({ answers: z.record(z.string(), z.string()) }).strict(),
  }).strict();
  return createJsonExecutorAdapter({
    identity: manualExecutorIdentity(declaration),
    inputParser: declaration.schemas.input,
    targetConfigParser: {
      parse: (value) => z.json().parse(envelopeSchema.parse(value)),
    },
    outputParser: declaration.schemas.output,
    outputClassification: 'public',
    async invoke(invocation) {
      const targetConfig = envelopeSchema.parse(invocation.targetConfig);
      const role = invocation.targetId === control.variantId ? 'control' : 'treatment';
      const output = await declaration.execute({
        input: invocation.input,
        artifact: targetConfig.artifact,
        ...(targetConfig.runtimeContext === undefined
          ? {}
          : { runtimeContext: targetConfig.runtimeContext }),
        config: targetConfig.executorConfig,
        ...(invocation.executionContext === undefined
          ? {}
          : { executionContext: invocation.executionContext }),
        sampleId: invocation.sampleId,
        variantId: invocation.targetId,
        experimentRole: role,
        trialIndex: invocation.trialIndex,
        ...(invocation.trialSeed === undefined ? {} : { trialSeed: invocation.trialSeed }),
        attemptNumber: invocation.attemptNumber,
        signal: invocation.signal,
      });
      return typeof output.errorCode === 'string'
        ? { invocationStatus: 'failed', errorCode: output.errorCode, usage: output.usage }
        : { invocationStatus: 'completed', output: output.output, usage: output.usage };
    },
  });
}

describe('canonical eval-runtime API', () => {
  it('evaluates control and treatment with ordinary OMK terms', async () => {
    const seen: Array<{
      variantId: string;
      experimentRole: string;
      artifactName: string;
      model?: string;
    }> = [];
    const result = await evaluate({
      executor: executor(async (invocation) => {
        seen.push({
          variantId: invocation.variantId,
          experimentRole: invocation.experimentRole,
          artifactName: invocation.artifact.name,
          model: (invocation.runtimeContext?.values as { model?: string } | undefined)?.model,
        });
        return { output: invocation.config.answers[invocation.input.prompt] };
      }),
      dataset: {
        datasetId: 'answers',
        samples: [
          { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
          { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
        ],
      },
      control,
      treatment,
      evaluator: { evaluatorKind: 'exact-match' },
      experiment: { seed: 'fixed-seed', bootstrap: { resamples: 100 } },
      policy: { maxConcurrency: 2 },
      runId: 'canonical-evaluate',
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.analysis.records[0]).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 0.5 },
    });
    expect(result.definition.decisionPolicy?.implementationId).toBe('progress/v2');
    expect(result.artifacts.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'NOISE',
      reasonCodes: ['interval-overlaps-decision-boundary'],
    });
    expect(new Set(seen.map((item) => `${item.experimentRole}:${item.variantId}`))).toEqual(
      new Set(['control:prompt-v1', 'treatment:prompt-v2']),
    );
    expect(seen.filter((item) => item.experimentRole === 'treatment')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactName: 'candidate', model: 'test-model' }),
      ]),
    );
  });

  it('is canonically equivalent to exact-match manual assembly', async () => {
    const declaration = executor();
    const shared = {
      dataset: {
        datasetId: 'equivalent-answers',
        samples: [
          { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
          { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
        ],
      },
      control,
      treatment,
      experiment: { trials: 2, seed: 'equivalence-seed', bootstrap: { resamples: 100 } },
      policy: { maxConcurrency: 2 },
      runId: 'equivalent-exact-match',
    } as const;
    const facade = await evaluate({
      executor: declaration,
      ...shared,
      evaluator: { evaluatorKind: 'exact-match' },
      clock: fixedClock,
    });

    const definition = createExactMatchDefinition({
      datasetId: shared.dataset.datasetId,
      samples: shared.dataset.samples,
      control: {
        targetId: control.variantId,
        targetKind: control.artifact.kind,
        executorId: declaration.executorId,
        config: variantEnvelope(control),
      },
      treatment: {
        targetId: treatment.variantId,
        targetKind: treatment.artifact.kind,
        executorId: declaration.executorId,
        config: variantEnvelope(treatment),
      },
      seed: shared.experiment.seed,
      trials: shared.experiment.trials,
      bootstrap: shared.experiment.bootstrap,
    });
    const resolvedPolicy = createMeasurementPolicy(shared.policy);
    const manual = await runEvaluation({
      runtime: createEvaluationRuntime({
        executors: [{
          implementationId: declaration.executorId,
          createPort: () => manualExecutorPort(declaration),
        }],
        evaluators: [{ port: createExactMatchEvaluator() }],
        clock: fixedClock,
      }),
      definition,
      policy: resolvedPolicy,
      runId: shared.runId,
    });

    const {
      definition: compiledDefinition,
      policy: compiledPolicy,
      ...facadeRunResult
    } = facade;
    expect(compiledDefinition).toEqual(definition);
    expect(compiledPolicy).toEqual(resolvedPolicy);
    expect(facadeRunResult).toEqual(manual);
    expect(facade.status).toBe('completed');
    if (facade.status !== 'completed') return;
    expect(facade.artifacts.execution.records).toHaveLength(8);
    expect(facade.artifacts.evaluation.records).toHaveLength(8);
    expect(new Set(facade.artifacts.execution.records.map((record) => record.trialIndex)))
      .toEqual(new Set([0, 1]));
  });

  it('is canonically equivalent to Rubric Judge manual assembly', async () => {
    const prompts: Array<{ promptId: string; promptHash: string }> = [];
    const declaration = executor();
    const dataset = {
        datasetId: 'rubric-answers',
        samples: [{ sampleId: 'one', input: { prompt: 'one' }, expected: 'A' }],
      } as const;
    const rubric = {
      criterionId: 'correctness',
      prompt: 'Judge correctness.',
      rubric: '5 is correct; 1 is incorrect.',
    } as const;
    const invoke = async (request: Readonly<{ promptId: string; promptHash: string }>) => {
      prompts.push({ promptId: request.promptId, promptHash: request.promptHash });
      return {
        invocationStatus: 'completed' as const,
        output: '{"score":5,"reason":"correct"}',
      };
    };
    const evaluator = {
      evaluatorKind: 'rubric-judge' as const,
      evaluatorId: 'correctness-judge',
      metricId: 'correctness-score',
      model: 'judge-model',
      rubric,
      judge: {
        judgeId: 'test.judge/v1',
        version: '1.0.0',
        providerCost: { reporting: 'optional' as const },
        invoke,
      },
    };
    const facade = await evaluate({
      executor: declaration,
      dataset,
      control,
      treatment,
      evaluator,
      experiment: { trials: 2, seed: 'rubric-seed', bootstrap: { resamples: 100 } },
      policy: {},
      runId: 'rubric-evaluate',
      clock: fixedClock,
    });

    const judgeIdentity = createRuntimeIdentity({
      implementationId: evaluator.judge.judgeId,
      version: evaluator.judge.version,
      capabilities: {
        invocationKind: 'llm-judge',
        cancellation: 'cooperative',
        providerCost: evaluator.judge.providerCost,
      },
      fingerprintFacets: { facade: 'omk.eval-runtime.rubric-judge/v1' },
    });
    const kit = createRubricJudgeKit({
      evaluatorId: evaluator.evaluatorId,
      metricId: evaluator.metricId,
      model: evaluator.model,
      invocation: {
        identity: judgeIdentity,
        providerCost: evaluator.judge.providerCost,
        invoke,
      },
    });
    const definition = createPairedComparisonDefinition({
      datasetId: dataset.datasetId,
      samples: dataset.samples.map((sample) => ({
        ...sample,
        evaluationContext: kit.createEvaluationContext(kit.createCriterion(rubric)),
      })),
      control: {
        targetId: control.variantId,
        targetKind: control.artifact.kind,
        executorId: declaration.executorId,
        config: variantEnvelope(control),
      },
      treatment: {
        targetId: treatment.variantId,
        targetKind: treatment.artifact.kind,
        executorId: declaration.executorId,
        config: variantEnvelope(treatment),
      },
      evaluator: kit.evaluatorDefinition,
      metric: kit.metricDefinition,
      trials: 2,
      seed: 'rubric-seed',
      bootstrap: { resamples: 100 },
    });
    const resolvedPolicy = createMeasurementPolicy();
    const manual = await runEvaluation({
      runtime: createEvaluationRuntime({
        executors: [{
          implementationId: declaration.executorId,
          createPort: () => manualExecutorPort(declaration),
        }],
        evaluators: [kit.evaluatorRegistration],
        clock: fixedClock,
      }),
      definition,
      policy: resolvedPolicy,
      runId: 'rubric-evaluate',
    });

    const {
      definition: compiledDefinition,
      policy: compiledPolicy,
      ...facadeRunResult
    } = facade;
    expect(compiledDefinition).toEqual(definition);
    expect(compiledPolicy).toEqual(resolvedPolicy);
    expect(facadeRunResult).toEqual(manual);
    expect(facade.status).toBe('completed');
    if (facade.status !== 'completed') return;
    expect(facade.artifacts.execution.records).toHaveLength(4);
    expect(facade.artifacts.evaluation.records).toHaveLength(4);
    expect(new Set(facade.artifacts.execution.records.map((record) => record.trialIndex)))
      .toEqual(new Set([0, 1]));
    expect(prompts).toHaveLength(8);
    expect(new Set(prompts.map((prompt) => `${prompt.promptId}:${prompt.promptHash}`)).size).toBe(1);
  });

  it('preserves Executor trace, usage, and classification declarations end to end', async () => {
    const declaration: Executor<
      string,
      undefined,
      { answer: string },
      { steps: string[] }
    > = {
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
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            providerCost: { amount: 0.001, currency: 'USD', reportedByProvider: true },
          },
        };
      },
    };
    const input = {
      executor: declaration,
      dataset: {
        datasetId: 'telemetry',
        samples: [{ sampleId: 'one', input: 'question', expected: { answer: 'ok' } }],
      },
      control: {
        variantId: 'control',
        artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null },
      },
      treatment: {
        variantId: 'treatment',
        artifact: { name: 'candidate', kind: 'prompt', source: 'inline', content: 'Answer.' },
      },
      evaluator: { evaluatorKind: 'exact-match' },
      experiment: { seed: 'telemetry-seed', bootstrap: { resamples: 100 } },
      policy: {},
      runId: 'telemetry-evaluate',
      clock: fixedClock,
    } as const;

    const result = await evaluate(input);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records).toHaveLength(2);
    expect(result.artifacts.execution.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        executionStatus: 'completed',
        output: expect.objectContaining({ classification: 'public', value: { answer: 'ok' } }),
        trace: expect.objectContaining({ classification: 'sensitive', value: { steps: ['done'] } }),
        usage: expect.objectContaining({
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          providerCost: {
            amount: 0.001,
            currency: 'USD',
            reportedByProvider: true,
          },
        }),
      }),
    ]));

    const missingTrace = await evaluate({
      ...input,
      executor: {
        ...declaration,
        async execute() {
          return {
            output: { answer: 'ok' },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      },
      runId: 'telemetry-missing-trace',
    });
    expect(missingTrace.status).toBe('completed');
    if (missingTrace.status !== 'completed') return;
    expect(missingTrace.artifacts.execution.records).toHaveLength(2);
    expect(missingTrace.artifacts.execution.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        executionStatus: 'failed',
        error: expect.objectContaining({ code: 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION' }),
      }),
    ]));
  });

  it('rejects transformed config before execution under the same identity', async () => {
    let invocations = 0;
    const original = executor(async () => {
      invocations += 1;
      return { output: 'unreachable' };
    });
    const declaration = {
      ...original,
      schemas: {
        ...original.schemas,
        config: z.object({ answers: z.record(z.string(), z.string()) })
          .transform((value) => ({ answers: { ...value.answers, injected: 'changed' } })),
      },
    };

    await expect(evaluate({
      executor: declaration,
      dataset: {
        datasetId: 'answers',
        samples: [{ sampleId: 'one', input: { prompt: 'one' }, expected: 'A' }],
      },
      control,
      treatment,
      evaluator: { evaluatorKind: 'exact-match' },
      experiment: { seed: 'fixed-seed' },
      policy: {},
      runId: 'transformed-config',
    })).rejects.toMatchObject({
      name: 'EvaluationConfigurationError',
      code: 'EVAL_RUNTIME_VARIANT_INVALID',
    } satisfies Partial<EvaluationConfigurationError>);
    expect(invocations).toBe(0);
  });

  it('captures variant config and Executor callbacks before asynchronous execution', async () => {
    const declaration = executor();
    const mutableTreatment = structuredClone(treatment) as {
      variantId: string;
      artifact: typeof treatment.artifact;
      runtimeContext: { values: { model: string } };
      config: Config;
    };
    const pending = evaluate({
      executor: declaration,
      dataset: {
        datasetId: 'captured-input',
        samples: [{ sampleId: 'one', input: { prompt: 'one' }, expected: 'A' }],
      },
      control,
      treatment: mutableTreatment,
      evaluator: { evaluatorKind: 'exact-match' },
      experiment: { seed: 'captured-input-seed', bootstrap: { resamples: 100 } },
      policy: {},
      runId: 'captured-input',
    });
    mutableTreatment.config.answers.one = 'mutated';
    (declaration as { execute: Executor<Input, Config, string>['execute'] }).execute = async () => ({
      output: 'mutated',
    });

    const result = await pending;
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records.filter((record) => (
      record.targetId === treatment.variantId
      && record.executionStatus === 'completed'
      && record.output?.contentKind === 'inline'
      && record.output.value === 'A'
    ))).toHaveLength(1);
  });

  it('captures Judge identity facets and method receiver before asynchronous execution', async () => {
    const seenRevisions: string[] = [];
    const mutableJudge = {
      judgeId: 'test.mutable-judge/v1',
      version: '1.0.0',
      providerCost: { reporting: 'optional' as const },
      fingerprintFacets: { deploymentRevision: 'judge-one' },
      async invoke(this: {
        fingerprintFacets?: { deploymentRevision?: string };
      }) {
        seenRevisions.push(this.fingerprintFacets?.deploymentRevision ?? 'missing');
        return {
          invocationStatus: 'completed' as const,
          output: '{"score":5,"reason":"correct"}',
        };
      },
    };
    const pending = evaluate({
      executor: executor(),
      dataset: {
        datasetId: 'captured-judge',
        samples: [{ sampleId: 'one', input: { prompt: 'one' }, expected: 'A' }],
      },
      control,
      treatment,
      evaluator: {
        evaluatorKind: 'rubric-judge',
        evaluatorId: 'captured-judge',
        metricId: 'captured-score',
        model: 'judge-model',
        judge: mutableJudge,
        rubric: {
          criterionId: 'correctness',
          prompt: 'Judge correctness.',
          rubric: '5 is correct; 1 is incorrect.',
        },
      },
      experiment: { seed: 'captured-judge-seed', bootstrap: { resamples: 100 } },
      policy: {},
      runId: 'captured-judge',
    });
    mutableJudge.fingerprintFacets.deploymentRevision = 'mutated';
    mutableJudge.invoke = async () => {
      throw new Error('must retain the captured Judge method');
    };

    const result = await pending;
    expect(result.status).toBe('completed');
    expect(seenRevisions).toEqual(['judge-one', 'judge-one']);
  });

  it('rejects ambiguous roles and invalid baseline artifacts with stable redacted errors', async () => {
    const common = {
      executor: executor(),
      dataset: {
        datasetId: 'invalid-variants',
        samples: [{ sampleId: 'one', input: { prompt: 'one' }, expected: 'A' }],
      },
      evaluator: { evaluatorKind: 'exact-match' as const },
      experiment: { seed: 'invalid-variant-seed' },
      policy: {},
      runId: 'invalid-variants',
    };
    await expect(evaluate({
      ...common,
      control,
      treatment: { ...treatment, variantId: control.variantId },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });

    const privatePayload = 'must-not-appear-in-error';
    let failure: unknown;
    try {
      await evaluate({
        ...common,
        control: {
          ...control,
          artifact: { ...control.artifact, content: privatePayload },
        },
        treatment,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });
    expect(String(failure)).not.toContain(privatePayload);
  });

  it('checks an Executor through real success, failure, cancellation, and cleanup', async () => {
    const result = await checkExecutor({
      executor: executor(async ({ input, config, signal }) => {
        if (input.prompt === 'failure') return { errorCode: 'expected-failure' };
        if (input.prompt === 'cancellation') {
          await new Promise((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        }
        return { output: config.answers[input.prompt] };
      }),
      variant: treatment,
      success: { input: { prompt: 'one' }, expected: 'A' },
      failure: { input: { prompt: 'failure' }, expectedErrorCode: 'expected-failure' },
      cancellation: { input: { prompt: 'cancellation' } },
    });

    expect(result.conformant, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.every((check) => check.checkStatus === 'passed')).toBe(true);
  });

  it('forwards cancellation through evaluate and removes the external listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    controller.abort(new Error('cancel before start'));

    const result = await evaluate({
      executor: executor(),
      dataset: {
        datasetId: 'cancelled-evaluate',
        samples: [{ sampleId: 'one', input: { prompt: 'one' }, expected: 'A' }],
      },
      control,
      treatment,
      evaluator: { evaluatorKind: 'exact-match' },
      experiment: { seed: 'cancelled-evaluate-seed' },
      policy: {},
      runId: 'cancelled-evaluate',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(result.definition.experiment.seed).toBe('cancelled-evaluate-seed');
    expect(result.policy.execution.maxConcurrency).toBeGreaterThan(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('returns a typed terminal result but redacts an event observer failure', async () => {
    const privateValue = 'private-observer-payload';
    let caught: unknown;
    try {
      await evaluate({
        executor: executor(),
        dataset: {
          datasetId: 'observer-failure',
          samples: [{ sampleId: 'one', input: { prompt: 'one' }, expected: 'A' }],
        },
        control,
        treatment,
        evaluator: { evaluatorKind: 'exact-match' },
        experiment: { seed: 'observer-failure-seed' },
        policy: {},
        runId: 'observer-failure',
        onEvent() {
          throw { privateValue };
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EvaluationEventConsumptionError);
    if (!(caught instanceof EvaluationEventConsumptionError)) return;
    expect(caught.code).toBe('EVAL_RUNTIME_EVENT_OBSERVER_FAILED');
    expect(caught.runResult?.status).toBe('completed');
    expect(caught.runResult?.definition.dataset.datasetId).toBe('observer-failure');
    expect(caught.runResult?.policy.execution.maxConcurrency).toBeGreaterThan(0);
    expect((caught as unknown as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(caught)).not.toContain(privateValue);
  });

  it('keeps structured Executor failures stable and provider-private throws redacted', async () => {
    const privateMessage = 'provider-private-executor-message';
    const result = await evaluate({
      executor: executor(async ({ experimentRole, input, config }) => {
        if (experimentRole === 'treatment') return { errorCode: 'host-capacity-exhausted' };
        if (input.prompt === 'two') throw new Error(privateMessage);
        return { output: config.answers[input.prompt] };
      }),
      dataset: {
        datasetId: 'executor-failures',
        samples: [
          { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
          { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
        ],
      },
      control,
      treatment,
      evaluator: { evaluatorKind: 'exact-match' },
      experiment: { seed: 'executor-failure-seed' },
      policy: {},
      runId: 'executor-failures',
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const failures = result.artifacts.execution.records.filter(
      (record) => record.executionStatus === 'failed',
    );
    expect(failures.map((record) => record.error.code)).toEqual(expect.arrayContaining([
      'EVAL_RUNTIME_EXECUTOR_FAILED',
      'host-capacity-exhausted',
    ]));
    expect(JSON.stringify(result)).not.toContain(privateMessage);
  });

  it('maps schema mismatches to stable redacted Core execution failures', async () => {
    const privateOutput = { answer: 'must-not-be-persisted' };
    const result = await evaluate({
      executor: executor(async () => ({ output: privateOutput as never })),
      dataset: {
        datasetId: 'schema-mismatch',
        samples: [{ sampleId: 'one', input: { prompt: 'one' }, expected: 'A' }],
      },
      control,
      treatment,
      evaluator: { evaluatorKind: 'exact-match', metricId: 'schema-safe-correct' },
      experiment: { seed: 'schema-mismatch-seed' },
      policy: {},
      runId: 'schema-mismatch',
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.evaluators[0].metricIds).toEqual(['schema-safe-correct']);
    expect(result.artifacts.execution.records).toHaveLength(2);
    expect(result.artifacts.execution.records.every((record) => (
      record.executionStatus === 'failed'
      && record.error.code === 'EVAL_RUNTIME_EXECUTOR_OUTPUT_INVALID'
    ))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateOutput.answer);
  });

  it('rejects artifact/runtime-context confusion and invalid evaluator declarations', async () => {
    const common = {
      executor: executor(),
      dataset: {
        datasetId: 'invalid-boundaries',
        samples: [{ sampleId: 'one', input: { prompt: 'one' }, expected: 'A' }],
      },
      control,
      treatment,
      experiment: { seed: 'invalid-boundaries-seed' },
      policy: {},
      runId: 'invalid-boundaries',
    } as const;

    await expect(evaluate({
      ...common,
      treatment: {
        ...treatment,
        runtimeContext: { artifact: treatment.artifact },
      } as never,
      evaluator: { evaluatorKind: 'exact-match' },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });

    await expect(evaluate({
      ...common,
      evaluator: {
        evaluatorKind: 'rubric-judge',
        evaluatorId: 'invalid-judge',
        metricId: '',
        model: 'judge-model',
        judge: {
          judgeId: 'invalid-judge/v1',
          version: '1.0.0',
          providerCost: { reporting: 'optional' },
          async invoke() {
            return { invocationStatus: 'completed', output: '{}' };
          },
        },
        rubric: { criterionId: 'criterion', prompt: 'Prompt.', rubric: 'Rubric.' },
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });
  });
});
