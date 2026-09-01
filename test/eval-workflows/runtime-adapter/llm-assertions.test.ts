import { describe, expect, it } from 'vitest';
import type {
  EvaluationDefinition,
  JsonValue,
  MeasurementPolicy,
  RuntimeIdentity,
  UsageRecord,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  RuntimeIdentitySchema,
  digestCanonicalJson,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  prepareEvaluationPlan,
  type PreparationRuntime,
} from '../../../src/evaluation-core/compiler/index.js';
import {
  executeRunPlanSource,
  InMemoryRuntimeEventSequencer,
  type ExecutionClock,
  type ExecutionExecutor,
} from '../../../src/evaluation-core/execution/index.js';
import {
  evaluateExecutionBundle,
  type EvaluationCache,
  type EvaluationCacheEntry,
} from '../../../src/evaluation-core/evaluation/index.js';
import {
  createLlmAssertionEvaluatorBindingFactory,
  createLlmAssertionEvaluatorIdentity,
  createLlmAssertionEvaluatorImplementation,
  createSameProcessEvaluatorAdapter,
  llmAssertionInstrument,
  LLM_ASSERTION_BINDINGS,
  LLM_ASSERTION_CONTEXT_SCHEMA_VERSION,
  LLM_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
  type LlmAssertionType,
  type OmkLlmJudgeInvocationPort,
  type OmkLlmJudgeInvocationRequest,
  type OmkLlmJudgeInvocationResult,
} from '../../../src/eval-workflows/runtime-adapter/index.js';
import {
  getRagJudgePromptHash,
  getSemanticPromptHash,
} from '../../../src/shared/llm-prompts/judge-prompts.js';
import { testRuntime, validDefinition, validPolicy } from '../../evaluation-core/compiler/fixtures.js';

const PROVIDER_IMPLEMENTATION_ID = 'test.llm-provider/v1';
const METRIC_ID = 'llm-assertion-pass';

type InvocationHandler = (
  request: Readonly<OmkLlmJudgeInvocationRequest>,
) => Promise<OmkLlmJudgeInvocationResult>;

class TestClock implements ExecutionClock {
  #now = 0;
  readonly #timeoutImmediately: boolean;

  constructor(timeoutImmediately = false) {
    this.#timeoutImmediately = timeoutImmediately;
  }

  monotonicNow(): number {
    const value = this.#now;
    this.#now += 1;
    return value;
  }

  timestamp(): string {
    return '2026-08-31T00:00:00.000Z';
  }

  async sleep(_delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    if (this.#timeoutImmediately) return;
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
}

class MemoryEvaluationCache implements EvaluationCache {
  readonly #entries = new Map<string, EvaluationCacheEntry>();

  async get(cacheKeyDigest: string): Promise<EvaluationCacheEntry | undefined> {
    const entry = this.#entries.get(cacheKeyDigest);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async put(entry: Readonly<EvaluationCacheEntry>): Promise<void> {
    this.#entries.set(entry.cacheKeyDigest, structuredClone(entry));
  }
}

function providerIdentity(): RuntimeIdentity {
  return RuntimeIdentitySchema.parse({
    implementationId: PROVIDER_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({ provider: PROVIDER_IMPLEMENTATION_ID, version: 1 }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'verified',
    capabilities: { invocation: 'single-call', cancellation: 'cooperative' },
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  });
}

function invocationPort(
  handler: InvocationHandler,
  reporting: 'unsupported' | 'optional' | 'required' = 'optional',
): OmkLlmJudgeInvocationPort {
  return Object.freeze({
    identity: providerIdentity(),
    providerCost: { reporting },
    invoke: handler,
  });
}

function criterion(
  assertionType: LlmAssertionType,
  threshold = 3,
  negated = false,
): JsonValue {
  let source: Record<string, JsonValue>;
  if (assertionType === 'faithfulness') {
    source = { context: 'The answer is grounded in this context.' };
  } else if (assertionType === 'answer_relevancy') {
    source = { question: 'What is the answer?' };
  } else {
    source = { reference: 'Expected answer' };
  }
  return {
    schemaVersion: LLM_ASSERTION_CONTEXT_SCHEMA_VERSION,
    criterionId: `${assertionType.replaceAll('_', '-')}-criterion`,
    assertionType,
    threshold,
    weight: 1,
    negated,
    ...source,
  };
}

function evaluatorConfig(assertionType: LlmAssertionType): JsonValue {
  const instrument = llmAssertionInstrument(assertionType);
  return {
    evaluator: {
      classification: 'public',
      value: instrument as unknown as JsonValue,
    },
    runtime: {
      executorId: PROVIDER_IMPLEMENTATION_ID,
      model: 'judge-model',
      effort: 'low',
      promptVariant: instrument.promptId,
    },
  } as JsonValue;
}

function definition(
  assertionType: LlmAssertionType,
  negated = false,
): EvaluationDefinition {
  const value = validDefinition();
  value.dataset.samples[0].evaluationContext = {
    llmAssertion: criterion(assertionType, 3, negated),
  };
  value.evaluators = [{
    evaluatorId: 'llm-assertion',
    evaluatorKind: assertionType,
    implementationId: LLM_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
    measurement: {
      instrumentId: llmAssertionInstrument(assertionType).promptId,
      ensembleMemberId: 'provider-member',
      replicateGroupId: `${assertionType.replaceAll('_', '-')}-primary`,
      replicateIndex: 0,
    },
    metricIds: [METRIC_ID],
    inputs: [
      { bindingId: LLM_ASSERTION_BINDINGS.actual, sourceKind: 'output', pointer: '/answer' },
      {
        bindingId: LLM_ASSERTION_BINDINGS.criterion,
        sourceKind: 'evaluation-context',
        pointer: '/llmAssertion',
      },
    ],
    config: evaluatorConfig(assertionType),
  }];
  value.metrics = [{
    metricId: METRIC_ID,
    valueType: 'boolean',
    scope: 'sample',
    direction: 'higher-is-better',
    missingPolicyId: 'exclude/v1',
  }];
  value.analysisGraph.nodes = [{
    analysisNodeKind: 'reducer',
    nodeId: 'llm-assertion-rate',
    implementationId: 'descriptive.rate/v1',
    inputs: [{ inputKind: 'metric-observations', referenceId: METRIC_ID }],
    outputResultId: 'llm-assertion-rate',
  }];
  value.comparisons[0].metricIds = [METRIC_ID];
  value.decisionPolicy = {
    decisionPolicyId: 'release-gate',
    implementationId: 'progress/v1',
    analysisResultIds: ['llm-assertion-rate'],
    minimumEvidenceStatus: 'complete',
    parameters: { threshold: 0 },
  };
  return value;
}

function policy(input: {
  timeout?: boolean;
  evaluationInvocations?: number;
  retryProviderFailure?: boolean;
} = {}): MeasurementPolicy {
  const value = validPolicy();
  value.retry.maxAttempts = 1;
  delete value.execution.timeoutMs;
  value.evaluation.retry.maxAttempts = 1;
  value.evaluation.retry.retryableErrorCodes = [];
  if (input.retryProviderFailure === true) {
    value.evaluation.retry.maxAttempts = 2;
    value.evaluation.retry.retryableErrorCodes = ['judge-provider-failure'];
    value.evaluation.retry.backoff = {
      backoffKind: 'none',
      initialDelayMs: 0,
    };
  }
  if (input.timeout === true) value.evaluation.timeoutMs = 1;
  else delete value.evaluation.timeoutMs;
  value.evidence.trace = 'none';
  value.evidence.evidence = 'full';
  value.evidence.maximumClassification = 'gold';
  if (input.evaluationInvocations !== undefined) {
    value.budget.stages.evaluation.maxInvocations = input.evaluationInvocations;
  }
  return value;
}

function evaluatorIdentity(
  assertionType: LlmAssertionType,
  port: OmkLlmJudgeInvocationPort,
): RuntimeIdentity {
  const config = evaluatorConfig(assertionType) as unknown as {
    evaluator: { value: ReturnType<typeof llmAssertionInstrument> };
    runtime: {
      executorId: string;
      model: string;
      effort: 'low';
      promptVariant: string;
    };
  };
  return createLlmAssertionEvaluatorIdentity({
    instrument: config.evaluator.value,
    runtime: config.runtime,
    invocation: port,
  });
}

function preparationRuntime(identity: RuntimeIdentity): PreparationRuntime {
  const base = testRuntime();
  return {
    ...base,
    resolveEvaluator() {
      return { identity, satisfiesVersionConstraint: true };
    },
  };
}

function runtimeIdentity(
  plan: Awaited<ReturnType<typeof prepareEvaluationPlan>>,
  runtimeKind: 'executor' | 'evaluator',
  referenceId: string,
): RuntimeIdentity {
  const stage = runtimeKind === 'executor' ? plan.execution : plan.evaluation;
  const runtime = stage.runtimes.find((candidate) => (
    candidate.runtimeKind === runtimeKind && candidate.referenceId === referenceId
  ));
  if (runtime === undefined) throw new Error(`Missing ${runtimeKind} runtime ${referenceId}`);
  return RuntimeIdentitySchema.parse(structuredClone(runtime.identity));
}

function executor(
  plan: Awaited<ReturnType<typeof prepareEvaluationPlan>>,
): ExecutionExecutor {
  return {
    identity: runtimeIdentity(plan, 'executor', 'control'),
    async openRun() {
      return {
        async openTrial() {
          return {
            async execute() {
              return {
                output: {
                  value: { answer: 'Actual answer' },
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

async function runCore(input: {
  assertionType?: LlmAssertionType;
  negated?: boolean;
  handler: InvocationHandler;
  policy?: MeasurementPolicy;
  clock?: TestClock;
  signal?: AbortSignal;
  reporting?: 'unsupported' | 'optional' | 'required';
  cache?: EvaluationCache;
}) {
  const assertionType = input.assertionType ?? 'semantic_similarity';
  const provider = invocationPort(input.handler, input.reporting);
  const identity = evaluatorIdentity(assertionType, provider);
  const sealed = await prepareEvaluationPlan(
    definition(assertionType, input.negated ?? false),
    input.policy ?? policy(),
    preparationRuntime(identity),
  );
  const clock = input.clock ?? new TestClock();
  const eventSequencer = new InMemoryRuntimeEventSequencer();
  const execution = await executeRunPlanSource(sealed, {
    executorsByTargetId: new Map(sealed.execution.targets.map((target) => [
      target.targetId,
      executor(sealed),
    ])),
    clock,
    eventSequencer,
  }, { runId: 'llm-assertion-run', bundleId: 'llm-assertion-execution' });
  const evaluator = createSameProcessEvaluatorAdapter({
    identity,
    sessionIsolationKey: 'llm-assertion-session',
    resourceLeases: {
      forRun: () => ({
        bindingId: 'llm-assertion-binding',
        consumerKind: 'evaluator',
        resourcesByResourceId: new Map(),
      }),
    },
    implementation: createLlmAssertionEvaluatorImplementation(provider),
  });
  const lifecycle = { runDisposals: 0, recordDisposals: 0 };
  const instrumentedEvaluator = {
    identity: evaluator.identity,
    async openRun(context: Parameters<typeof evaluator.openRun>[0]) {
      const run = await evaluator.openRun(context);
      return {
        async openRecord(recordContext: Parameters<typeof run.openRecord>[0]) {
          const record = await run.openRecord(recordContext);
          return {
            evaluate: record.evaluate.bind(record),
            async dispose() {
              lifecycle.recordDisposals += 1;
              await record.dispose();
            },
          };
        },
        async dispose() {
          lifecycle.runDisposals += 1;
          await run.dispose();
        },
      };
    },
  };
  const evaluation = await evaluateExecutionBundle(sealed, execution, {
    evaluatorsByEvaluatorId: new Map([['llm-assertion', instrumentedEvaluator]]),
    clock,
    eventSequencer,
    ...(input.cache === undefined ? {} : { cache: input.cache }),
  }, {
    runId: 'llm-assertion-run',
    bundleId: 'llm-assertion-evaluation',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return { sealed, execution, evaluation, provider, lifecycle };
}

function completedObservations(
  result: Awaited<ReturnType<typeof runCore>>,
) {
  return result.evaluation.records.flatMap((record) => (
    record.evaluationStatus === 'completed' ? record.observations : []
  ));
}

const COMPLETE_USAGE: UsageRecord = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  providerCost: { amount: 0.001, currency: 'USD', reportedByProvider: true },
};

describe('provider-neutral LLM assertion Evaluator', () => {
  it.each([
    ['semantic_similarity', 'semantic-similarity', getSemanticPromptHash()],
    ['faithfulness', 'rag-faithfulness', getRagJudgePromptHash('faithfulness')],
    ['answer_relevancy', 'rag-answer-relevancy', getRagJudgePromptHash('answer_relevancy')],
    ['context_recall', 'rag-context-recall', getRagJudgePromptHash('context_recall')],
  ] as const)('uses the frozen %s instrument without copying its prompt', async (
    assertionType,
    promptId,
    promptHash,
  ) => {
    const requests: OmkLlmJudgeInvocationRequest[] = [];
    const result = await runCore({
      assertionType,
      handler: async (request) => {
        requests.push(request);
        return {
          invocationStatus: 'completed',
          output: '{"score":4,"reason":"valid reading"}',
          usage: COMPLETE_USAGE,
        };
      },
    });
    expect(requests).toHaveLength(2);
    expect(result.lifecycle).toEqual({ runDisposals: 1, recordDisposals: 2 });
    expect(requests[0]).toMatchObject({
      executorId: PROVIDER_IMPLEMENTATION_ID,
      model: 'judge-model',
      effort: 'low',
      promptId,
      promptHash,
    });
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
    expect(completedObservations(result)).toHaveLength(2);
    for (const observation of completedObservations(result)) {
      expect(observation).toMatchObject({
        metricId: METRIC_ID,
        observationStatus: 'observed',
        valueType: 'boolean',
        value: true,
        evidence: {
          classification: 'gold',
          contentKind: 'inline',
          value: {
            assertionType,
            promptId,
            promptHash,
            score: 4,
            rawPassed: true,
            reason: 'valid reading',
            weight: 1,
            negated: false,
            layer: 'fact',
          },
        },
      });
    }
    for (const record of result.evaluation.records) {
      if (record.evaluationStatus !== 'completed') continue;
      expect(record.usage).toMatchObject(COMPLETE_USAGE);
    }
  });

  it('keeps a valid below-threshold reading as observed false', async () => {
    const result = await runCore({
      handler: async () => ({
        invocationStatus: 'completed',
        output: '{"score":2,"reason":"content differs"}',
      }),
    });
    expect(completedObservations(result)).toEqual([
      expect.objectContaining({ observationStatus: 'observed', value: false }),
      expect.objectContaining({ observationStatus: 'observed', value: false }),
    ]);
  });

  it.each([
    'semantic_similarity',
    'faithfulness',
    'answer_relevancy',
    'context_recall',
  ] as const)('applies negation only after a valid %s reading', async (assertionType) => {
    const rawPass = await runCore({
      assertionType,
      negated: true,
      handler: async () => ({
        invocationStatus: 'completed',
        output: '{"score":5,"reason":"valid pass"}',
      }),
    });
    expect(completedObservations(rawPass)).toEqual([
      expect.objectContaining({
        observationStatus: 'observed',
        value: false,
        evidence: expect.objectContaining({
          value: expect.objectContaining({ negated: true, rawPassed: true }),
        }),
      }),
      expect.objectContaining({
        observationStatus: 'observed',
        value: false,
        evidence: expect.objectContaining({
          value: expect.objectContaining({ negated: true, rawPassed: true }),
        }),
      }),
    ]);

    const rawFail = await runCore({
      assertionType,
      negated: true,
      handler: async () => ({
        invocationStatus: 'completed',
        output: '{"score":2,"reason":"valid fail"}',
      }),
    });
    expect(completedObservations(rawFail)).toEqual([
      expect.objectContaining({
        observationStatus: 'observed',
        value: true,
        evidence: expect.objectContaining({
          value: expect.objectContaining({ negated: true, rawPassed: false }),
        }),
      }),
      expect.objectContaining({
        observationStatus: 'observed',
        value: true,
        evidence: expect.objectContaining({
          value: expect.objectContaining({ negated: true, rawPassed: false }),
        }),
      }),
    ]);
  });

  it('seals negation into the EvaluationPlan identity', async () => {
    const provider = invocationPort(async () => ({
      invocationStatus: 'completed',
      output: '{"score":5,"reason":"valid"}',
    }));
    const identity = evaluatorIdentity('semantic_similarity', provider);
    const positive = await prepareEvaluationPlan(
      definition('semantic_similarity', false),
      policy(),
      preparationRuntime(identity),
    );
    const negated = await prepareEvaluationPlan(
      definition('semantic_similarity', true),
      policy(),
      preparationRuntime(identity),
    );
    expect(positive.evaluation.evaluationPlanDigest)
      .not.toBe(negated.evaluation.evaluationPlanDigest);
  });

  it.each([
    ['plain text', 'judge-response-non-json'],
    ['prefix {bad json} suffix', 'judge-response-malformed-json'],
    ['{"score":"4","reason":"wrong type"}', 'judge-score-malformed'],
    ['{"score":6,"reason":"out of range"}', 'judge-score-out-of-range'],
    ['{"score":4}', 'judge-reason-missing'],
  ])('returns invalid, not false, for %s even when negated', async (output, reasonCode) => {
    const result = await runCore({
      negated: true,
      handler: async () => ({ invocationStatus: 'completed', output }),
    });
    expect(completedObservations(result)).toEqual([
      expect.objectContaining({ observationStatus: 'invalid', reasonCode }),
      expect.objectContaining({ observationStatus: 'invalid', reasonCode }),
    ]);
    expect(completedObservations(result).some((observation) => (
      observation.observationStatus === 'observed'
    ))).toBe(false);
  });

  it('does not invert provider failure, redacts raw errors, and retains known usage', async () => {
    const result = await runCore({
      negated: true,
      handler: async () => ({
        invocationStatus: 'failed',
        reasonCode: 'provider-overloaded',
        usage: {
          ...COMPLETE_USAGE,
          details: { rawProviderError: 'secret-provider-message' },
        },
      }),
    });
    expect(result.evaluation.records).toHaveLength(2);
    for (const record of result.evaluation.records) {
      expect(record).toMatchObject({
        evaluationStatus: 'failed',
        error: {
          code: 'judge-provider-failure',
          stage: 'evaluation',
          message: 'Evaluator reported a structured failure.',
        },
        usage: COMPLETE_USAGE,
      });
      expect(JSON.stringify(record)).not.toContain('provider-overloaded');
      expect(JSON.stringify(record)).not.toContain('secret-provider-message');
    }
  });

  it('keeps unknown provider usage and cost absent rather than writing zero', async () => {
    const result = await runCore({
      handler: async () => ({
        invocationStatus: 'completed',
        output: '{"score":5,"reason":"valid"}',
      }),
      reporting: 'unsupported',
    });
    for (const record of result.evaluation.records) {
      if (record.evaluationStatus !== 'completed') continue;
      expect(record.usage).toBeUndefined();
      expect(record.attempts[0].usage).toBeUndefined();
    }
  });

  it('delegates retry exclusively to the sealed Core retry policy', async () => {
    let calls = 0;
    const result = await runCore({
      handler: async () => {
        calls += 1;
        return calls <= 2
          ? { invocationStatus: 'failed', reasonCode: 'provider-unavailable' }
          : {
              invocationStatus: 'completed',
              output: '{"score":5,"reason":"recovered"}',
            };
      },
      policy: policy({ retryProviderFailure: true }),
    });
    expect(calls).toBe(4);
    for (const record of result.evaluation.records) {
      expect(record).toMatchObject({
        evaluationStatus: 'completed',
        observations: [expect.objectContaining({
          observationStatus: 'observed',
          value: true,
        })],
      });
      if (record.evaluationStatus !== 'completed') continue;
      expect(record.attempts.map((attempt) => attempt.attemptStatus)).toEqual([
        'failed',
        'completed',
      ]);
    }
  });

  it('replays only through the sealed Core evaluation cache', async () => {
    const cache = new MemoryEvaluationCache();
    const cachedPolicy = policy();
    cachedPolicy.cache.evaluationMode = 'reuse';
    let calls = 0;
    const request = {
      handler: async (): Promise<OmkLlmJudgeInvocationResult> => {
        calls += 1;
        return {
          invocationStatus: 'completed' as const,
          output: '{"score":5,"reason":"cacheable"}',
        };
      },
      policy: cachedPolicy,
      cache,
    };
    const first = await runCore(request);
    expect(calls).toBe(2);
    expect(first.evaluation.records.every((record) => (
      record.evaluationStatus === 'completed'
      && record.cache.cacheStatus === 'miss'
    ))).toBe(true);

    const second = await runCore(request);
    expect(calls).toBe(2);
    expect(second.evaluation.records.every((record) => (
      record.evaluationStatus === 'completed'
      && record.cache.cacheStatus === 'transparent-hit'
    ))).toBe(true);
  });

  it('keeps negated timeout failed and waits for cooperative provider cancellation', async () => {
    let cancellations = 0;
    const result = await runCore({
      handler: async (request) => new Promise<OmkLlmJudgeInvocationResult>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          cancellations += 1;
          reject(request.signal.reason);
        }, { once: true });
      }),
      negated: true,
      policy: policy({ timeout: true }),
      clock: new TestClock(true),
    });
    expect(cancellations).toBe(2);
    for (const record of result.evaluation.records) {
      expect(record).toMatchObject({
        evaluationStatus: 'failed',
        error: { code: 'timeout', stage: 'evaluation' },
      });
    }
  });

  it('keeps negated cancellation cancelled instead of turning it into a pass', async () => {
    const controller = new AbortController();
    let cancellations = 0;
    const result = await runCore({
      handler: async (request) => {
        controller.abort(new Error('cancel run'));
        return new Promise<OmkLlmJudgeInvocationResult>((_resolve, reject) => {
          if (request.signal.aborted) {
            cancellations += 1;
            reject(request.signal.reason);
          } else {
            request.signal.addEventListener('abort', () => {
              cancellations += 1;
              reject(request.signal.reason);
            }, { once: true });
          }
        });
      },
      negated: true,
      signal: controller.signal,
    });
    expect(cancellations).toBeGreaterThan(0);
    expect(result.evaluation.evaluationBundleStatus).toBe('cancelled');
    expect(result.evaluation.records.every((record) => (
      record.evaluationStatus === 'cancelled'
    ))).toBe(true);
  });

  it('keeps negated budget censoring as unstarted evidence', async () => {
    let calls = 0;
    const result = await runCore({
      handler: async () => {
        calls += 1;
        return {
          invocationStatus: 'completed',
          output: '{"score":5,"reason":"valid"}',
        };
      },
      negated: true,
      policy: policy({ evaluationInvocations: 1 }),
    });
    expect(calls).toBe(1);
    expect(result.evaluation.evaluationBundleStatus).toBe('budget-exhausted');
    expect(result.evaluation.coverage).toMatchObject({
      planned: 2,
      completed: 1,
      notStarted: 1,
    });
  });

  it('cannot lower observed content score by adding an infrastructure failure', async () => {
    let calls = 0;
    const result = await runCore({
      handler: async () => {
        calls += 1;
        return calls === 1
          ? {
              invocationStatus: 'completed',
              output: '{"score":5,"reason":"valid"}',
            }
          : {
              invocationStatus: 'failed',
              reasonCode: 'provider-unavailable',
            };
      },
    });
    const observed = completedObservations(result).filter((observation) => (
      observation.observationStatus === 'observed'
    ));
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ value: true });
    expect(result.evaluation.records.some((record) => (
      record.evaluationStatus === 'completed'
    ))).toBe(true);
    expect(result.evaluation.records.some((record) => (
      record.evaluationStatus === 'failed'
      && record.error.code === 'judge-provider-failure'
    ))).toBe(true);
  });

  it('builds a production host factory with sealed qualification and prompt identity', async () => {
    const definitionValue = definition('semantic_similarity');
    const provider = invocationPort(async () => ({
      invocationStatus: 'completed',
      output: '{"score":5,"reason":"valid"}',
    }));
    const factory = createLlmAssertionEvaluatorBindingFactory(async () => ({
      port: provider,
      preflightDeclarations: [{
        preflightKind: 'connectivity',
        preflightDisposition: 'check',
        checkId: 'judge-connectivity',
        run: () => undefined,
      }],
    }));
    const resolved = await factory({
      sessionIsolationKey: 'llm-assertion-factory-session',
      binding: {
        runtimeKind: 'evaluator',
        bindingId: 'llm-assertion-binding',
        evaluatorId: 'llm-assertion',
        implementationId: LLM_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
        measurement: definitionValue.evaluators[0].measurement,
        configDigest: digestCanonicalJson(definitionValue.evaluators[0].config as JsonValue),
        resourceLeaseRequirements: [],
        qualification: {
          executorId: PROVIDER_IMPLEMENTATION_ID,
          model: 'judge-model',
          effort: 'low',
          promptVariant: 'semantic-similarity',
          resourceIntegrity: 'digest-before-use',
        },
      },
      evaluator: definitionValue.evaluators[0],
      resourceLeases: {
        forRun: () => ({
          bindingId: 'llm-assertion-binding',
          consumerKind: 'evaluator',
          resourcesByResourceId: new Map(),
        }),
      },
    });
    expect(resolved.port.identity).toEqual(evaluatorIdentity('semantic_similarity', provider));
    expect(resolved.preflightDeclarations).toEqual([
      expect.objectContaining({ checkId: 'judge-connectivity', preflightDisposition: 'check' }),
    ]);
  });
});
