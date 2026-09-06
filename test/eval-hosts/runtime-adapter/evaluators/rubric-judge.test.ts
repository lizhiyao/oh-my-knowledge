import { describe, expect, it } from 'vitest';
import type {
  EvaluationDefinition,
  JsonValue,
  MeasurementPolicy,
  RuntimeIdentity,
  UsageRecord,
} from '../../../../src/eval-core/contracts/index.js';
import {
  RuntimeIdentitySchema,
  digestCanonicalJson,
} from '../../../../src/eval-core/contracts/index.js';
import {
  prepareEvaluationPlan,
  type PreparationRuntime,
} from '../../../../src/eval-core/compiler/index.js';
import {
  executeRunPlanSource,
  InMemoryRuntimeEventSequencer,
  type ExecutionClock,
  type ExecutionExecutor,
} from '../../../../src/eval-core/execution/index.js';
import {
  evaluateExecutionBundle,
  type EvaluationCache,
  type EvaluationCacheEntry,
} from '../../../../src/eval-core/evaluation/index.js';
import {
  createRubricJudgeEvaluatorBindingFactory,
} from '../../../../src/eval-hosts/runtime-adapter/evaluators/rubric-judge.js';
import {
  createRubricJudgeEvaluatorIdentity,
  createRubricJudgeEvaluatorImplementation,
  captureLlmJudgeInvocationPort,
  rubricJudgeInstrument,
  rubricJudgeInstrumentId,
  RUBRIC_JUDGE_BINDINGS,
  RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
  RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
  type OmkLlmJudgeInvocationPort,
  type OmkLlmJudgeInvocationRequest,
  type OmkLlmJudgeInvocationResult,
  type RubricJudgeTracePolicy,
} from '../../../../src/eval-hosts/runtime-adapter/index.js';
import {
  createSameProcessEvaluatorAdapter,
} from '../../../../src/eval-runtime/adapters/same-process.js';
import {
  buildJudgePrompt,
  getJudgePromptHash,
  JUDGE_SYSTEM_PROMPT,
} from '../../../../src/eval-runtime/judges/rubric-prompt.js';
import { buildJudgeTraceSummary } from '../../../../src/eval-runtime/judges/trace-summary.js';
import { testRuntime, validDefinition, validPolicy } from '../../../eval-core/compiler/fixtures.js';

const PROVIDER_IMPLEMENTATION_ID = 'test.rubric-provider/v1';
const METRIC_ID = 'rubric-score';

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

function providerIdentity(revision = 1): RuntimeIdentity {
  return RuntimeIdentitySchema.parse({
    implementationId: PROVIDER_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      provider: PROVIDER_IMPLEMENTATION_ID,
      revision,
    }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'verified',
    capabilities: { invocation: 'single-call', cancellation: 'cooperative' },
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  });
}

function invocationPort(
  handler: InvocationHandler,
  reporting: 'unsupported' | 'optional' | 'required' = 'optional',
  identity: RuntimeIdentity = providerIdentity(),
): OmkLlmJudgeInvocationPort {
  return Object.freeze({
    identity,
    providerCost: { reporting },
    invoke: handler,
  });
}

function evaluatorConfig(input: {
  lengthDebias: boolean;
  tracePolicy: RubricJudgeTracePolicy;
  model?: string;
}): JsonValue {
  const instrument = rubricJudgeInstrument(input);
  return {
    evaluator: {
      classification: 'public',
      value: instrument as unknown as JsonValue,
    },
    runtime: {
      executorId: PROVIDER_IMPLEMENTATION_ID,
      model: input.model ?? 'judge-model',
      effort: 'low',
      promptVariant: instrument.promptId,
    },
  } as JsonValue;
}

function definition(input: {
  lengthDebias?: boolean;
  tracePolicy?: RubricJudgeTracePolicy;
} = {}): EvaluationDefinition {
  const lengthDebias = input.lengthDebias ?? true;
  const tracePolicy = input.tracePolicy ?? 'none';
  const value = validDefinition();
  value.dataset.samples[0].evaluationContext = {
    rubricJudge: {
      schemaVersion: RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
      criterionId: 'correctness',
      prompt: 'Answer the question.',
      rubric: 'The answer must be correct and concise.',
    },
  };
  const instrument = rubricJudgeInstrument({ lengthDebias, tracePolicy });
  value.evaluators = [{
    evaluatorId: 'rubric-judge',
    evaluatorKind: 'llm-rubric',
    implementationId: RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
    measurement: {
      instrumentId: rubricJudgeInstrumentId(instrument),
      ensembleMemberId: 'provider-member',
      replicateGroupId: 'rubric-primary',
      replicateIndex: 0,
    },
    metricIds: [METRIC_ID],
    inputs: [
      { bindingId: RUBRIC_JUDGE_BINDINGS.actual, sourceKind: 'output', pointer: '/answer' },
      {
        bindingId: RUBRIC_JUDGE_BINDINGS.criterion,
        sourceKind: 'evaluation-context',
        pointer: '/rubricJudge',
      },
      ...(tracePolicy === 'source-neutral' ? [{
        bindingId: RUBRIC_JUDGE_BINDINGS.trace,
        sourceKind: 'trace' as const,
        pointer: '',
      }] : []),
    ],
    config: evaluatorConfig({ lengthDebias, tracePolicy }),
  }];
  value.metrics = [{
    metricId: METRIC_ID,
    valueType: 'numeric',
    scope: 'sample',
    scale: { min: 1, max: 5 },
    direction: 'higher-is-better',
    missingPolicyId: 'exclude/v1',
  }];
  value.analysisGraph.nodes = [{
    analysisNodeKind: 'reducer',
    nodeId: 'rubric-mean',
    implementationId: 'descriptive.mean/v1',
    inputs: [{ inputKind: 'metric-observations', referenceId: METRIC_ID }],
    outputResultId: 'rubric-mean',
  }];
  value.comparisons[0].metricIds = [METRIC_ID];
  value.decisionPolicy = {
    decisionPolicyId: 'release-gate',
    implementationId: 'progress/v1',
    analysisResultIds: ['rubric-mean'],
    minimumEvidenceStatus: 'complete',
    parameters: { threshold: 0 },
  };
  return value;
}

function policy(input: {
  timeout?: boolean;
  evaluationInvocations?: number;
  retryProviderFailure?: boolean;
  tracePolicy?: RubricJudgeTracePolicy;
} = {}): MeasurementPolicy {
  const value = validPolicy();
  value.retry.maxAttempts = 1;
  delete value.execution.timeoutMs;
  value.evaluation.retry.maxAttempts = 1;
  value.evaluation.retry.retryableErrorCodes = [];
  if (input.retryProviderFailure === true) {
    value.evaluation.retry.maxAttempts = 2;
    value.evaluation.retry.retryableErrorCodes = ['judge-provider-failure'];
    value.evaluation.retry.backoff = { backoffKind: 'none', initialDelayMs: 0 };
  }
  if (input.timeout === true) value.evaluation.timeoutMs = 1;
  else delete value.evaluation.timeoutMs;
  value.evidence.trace = input.tracePolicy === 'source-neutral' ? 'full' : 'none';
  value.evidence.evidence = 'full';
  value.evidence.maximumClassification = 'gold';
  if (input.evaluationInvocations !== undefined) {
    value.budget.stages.evaluation.maxInvocations = input.evaluationInvocations;
  }
  return value;
}

function evaluatorIdentity(
  input: {
    lengthDebias: boolean;
    tracePolicy: RubricJudgeTracePolicy;
    model?: string;
  },
  port: OmkLlmJudgeInvocationPort,
): RuntimeIdentity {
  const config = evaluatorConfig(input) as unknown as {
    evaluator: { value: ReturnType<typeof rubricJudgeInstrument> };
    runtime: {
      executorId: string;
      model: string;
      effort: 'low';
      promptVariant: string;
    };
  };
  return createRubricJudgeEvaluatorIdentity({
    instrument: config.evaluator.value,
    runtime: config.runtime,
    invocation: port,
  });
}

function preparationRuntime(identity: RuntimeIdentity): PreparationRuntime {
  const base = testRuntime({
    traceCapability: 'optional',
    analysisValueTypes: ['numeric'],
  });
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
  tracePolicy: RubricJudgeTracePolicy,
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
                ...(tracePolicy === 'source-neutral' ? {
                  trace: {
                    value: {
                      schemaVersion: 'omk.source-neutral-trace/v2',
                      turns: [{ role: 'assistant', content: 'Used search and answered.' }],
                      toolCalls: [{
                        tool: 'search',
                        input: { query: 'Q' },
                        output: 'A',
                        success: true,
                        status: 'success',
                        statusSource: 'runtime',
                      }],
                      numTurns: 1,
                      fullNumTurns: 1,
                      numSubAgents: 0,
                    },
                    classification: 'sensitive' as const,
                  },
                } : {}),
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
  handler: InvocationHandler;
  lengthDebias?: boolean;
  tracePolicy?: RubricJudgeTracePolicy;
  policy?: MeasurementPolicy;
  clock?: TestClock;
  signal?: AbortSignal;
  reporting?: 'unsupported' | 'optional' | 'required';
  cache?: EvaluationCache;
}) {
  const lengthDebias = input.lengthDebias ?? true;
  const tracePolicy = input.tracePolicy ?? 'none';
  const provider = invocationPort(input.handler, input.reporting);
  const identity = evaluatorIdentity({ lengthDebias, tracePolicy }, provider);
  const sealed = await prepareEvaluationPlan(
    definition({ lengthDebias, tracePolicy }),
    input.policy ?? policy({ tracePolicy }),
    preparationRuntime(identity),
  );
  const clock = input.clock ?? new TestClock();
  const eventSequencer = new InMemoryRuntimeEventSequencer();
  const execution = await executeRunPlanSource(sealed, {
    executorsByTargetId: new Map(sealed.execution.targets.map((target) => [
      target.targetId,
      executor(sealed, tracePolicy),
    ])),
    clock,
    eventSequencer,
  }, { runId: 'rubric-judge-run', bundleId: 'rubric-judge-execution' });
  const evaluator = createSameProcessEvaluatorAdapter({
    identity,
    sessionIsolationKey: 'rubric-judge-session',
    resourceLeases: {
      forRun: () => ({
        bindingId: 'rubric-judge-binding',
        consumerKind: 'evaluator',
        resourcesByResourceId: new Map(),
      }),
    },
    implementation: createRubricJudgeEvaluatorImplementation(provider),
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
    evaluatorsByEvaluatorId: new Map([['rubric-judge', instrumentedEvaluator]]),
    clock,
    eventSequencer,
    ...(input.cache === undefined ? {} : { cache: input.cache }),
  }, {
    runId: 'rubric-judge-run',
    bundleId: 'rubric-judge-evaluation',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return { sealed, evaluation, lifecycle };
}

function completedObservations(result: Awaited<ReturnType<typeof runCore>>) {
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

describe('provider-neutral rubric raw-reading Evaluator', () => {
  it.each([
    [true, 'rubric-judge-debias-on', getJudgePromptHash(true), 'v5-cot-toolargs-fmt-len'],
    [false, 'rubric-judge-debias-off', getJudgePromptHash(false), 'v5-cot-toolargs-fmt'],
  ] as const)('uses the frozen lengthDebias=%s instrument', async (
    lengthDebias,
    promptId,
    promptHash,
    promptVersion,
  ) => {
    const requests: OmkLlmJudgeInvocationRequest[] = [];
    const result = await runCore({
      lengthDebias,
      handler: async (request) => {
        requests.push(request);
        return {
          invocationStatus: 'completed',
          output: '{"reasoning":"checked rubric","score":4,"reason":"valid reading"}',
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
    expect(requests[0].prompt).toContain(`template ${promptVersion}`);
    expect(requests[0].prompt).toContain('The answer must be correct and concise.');
    expect(requests[0].system).toBe(JUDGE_SYSTEM_PROMPT);
    expect(requests[0].prompt).toBe(buildJudgePrompt(
      'Answer the question.',
      'The answer must be correct and concise.',
      'Actual answer',
      null,
      lengthDebias,
    ));
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
    for (const observation of completedObservations(result)) {
      expect(observation).toMatchObject({
        metricId: METRIC_ID,
        observationStatus: 'observed',
        valueType: 'numeric',
        value: 4,
        evidence: {
          classification: 'gold',
          contentKind: 'inline',
          value: {
            criterionId: 'correctness',
            promptId,
            promptHash,
            lengthDebias,
            tracePolicy: 'none',
            score: 4,
            reason: 'valid reading',
            reasoning: 'checked rubric',
          },
        },
      });
    }
  });

  it('adds only canonical source-neutral trace and keeps the highest input classification', async () => {
    const requests: OmkLlmJudgeInvocationRequest[] = [];
    const result = await runCore({
      tracePolicy: 'source-neutral',
      handler: async (request) => {
        requests.push(request);
        return {
          invocationStatus: 'completed',
          output: '{"score":5,"reason":"trace supports answer"}',
        };
      },
    });
    expect(requests[0].prompt).toContain('## Agent 执行过程');
    expect(requests[0].prompt).toContain('search(1)');
    expect(requests[0].prompt).toContain('Used search and answered.');
    const expectedTrace = buildJudgeTraceSummary(
      [{ role: 'assistant', content: 'Used search and answered.' }],
      [{
        tool: 'search',
        input: { query: 'Q' },
        output: 'A',
        success: true,
        status: 'success',
        statusSource: 'runtime',
      }],
    );
    expect(requests[0].prompt).toBe(buildJudgePrompt(
      'Answer the question.',
      'The answer must be correct and concise.',
      'Actual answer',
      expectedTrace,
      true,
    ));
    expect(completedObservations(result)).toEqual([
      expect.objectContaining({
        value: 5,
        evidence: expect.objectContaining({ classification: 'gold' }),
      }),
      expect.objectContaining({
        value: 5,
        evidence: expect.objectContaining({ classification: 'gold' }),
      }),
    ]);
  });

  it.each([
    ['plain text', 'judge-response-non-json'],
    ['prefix {bad json} suffix', 'judge-response-malformed-json'],
    ['prefix {"score":4,"reason":"embedded"} suffix', 'judge-response-malformed-json'],
    ['{"score":"4","reason":"wrong type"}', 'judge-score-malformed'],
    ['{"score":4.5,"reason":"fractional"}', 'judge-score-malformed'],
    ['{"score":0,"reason":"out of range"}', 'judge-score-out-of-range'],
    ['{"score":6,"reason":"out of range"}', 'judge-score-out-of-range'],
    ['{"score":4}', 'judge-reason-missing'],
    ['{"score":4,"reason":"  "}', 'judge-reason-missing'],
  ])('returns invalid, not a zero reading, for %s', async (output, reasonCode) => {
    const result = await runCore({
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

  it('records provider failure separately, redacts provider details, and retains known usage', async () => {
    const result = await runCore({
      handler: async () => ({
        invocationStatus: 'failed',
        reasonCode: 'provider-overloaded',
        usage: {
          ...COMPLETE_USAGE,
          details: { rawProviderError: 'secret-provider-message' },
        },
      }),
    });
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

  it('keeps unknown provider usage and cost absent', async () => {
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

  it('delegates retry exclusively to sealed Core policy', async () => {
    let calls = 0;
    const result = await runCore({
      handler: async () => {
        calls += 1;
        return calls <= 2
          ? { invocationStatus: 'failed', reasonCode: 'provider-unavailable' }
          : { invocationStatus: 'completed', output: '{"score":5,"reason":"recovered"}' };
      },
      policy: policy({ retryProviderFailure: true }),
    });
    expect(calls).toBe(4);
    for (const record of result.evaluation.records) {
      expect(record).toMatchObject({
        evaluationStatus: 'completed',
        observations: [expect.objectContaining({ value: 5 })],
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
          invocationStatus: 'completed',
          output: '{"score":5,"reason":"cacheable"}',
        };
      },
      policy: cachedPolicy,
      cache,
    };
    const first = await runCore(request);
    expect(calls).toBe(2);
    expect(first.evaluation.records.every((record) => (
      record.evaluationStatus === 'completed' && record.cache.cacheStatus === 'miss'
    ))).toBe(true);

    const second = await runCore(request);
    expect(calls).toBe(2);
    expect(second.evaluation.records.every((record) => (
      record.evaluationStatus === 'completed'
      && record.cache.cacheStatus === 'transparent-hit'
    ))).toBe(true);
  });

  it('lets Core own timeout and cooperative provider cancellation', async () => {
    let cancellations = 0;
    const result = await runCore({
      handler: async (request) => new Promise<OmkLlmJudgeInvocationResult>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          cancellations += 1;
          reject(request.signal.reason);
        }, { once: true });
      }),
      policy: policy({ timeout: true }),
      clock: new TestClock(true),
    });
    expect(cancellations).toBe(2);
    expect(result.evaluation.records.every((record) => (
      record.evaluationStatus === 'failed'
      && record.error.code === 'timeout'
    ))).toBe(true);
  });

  it('lets Core own cancellation without converting it into provider failure', async () => {
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
      signal: controller.signal,
    });
    expect(cancellations).toBeGreaterThan(0);
    expect(result.evaluation.evaluationBundleStatus).toBe('cancelled');
    expect(result.evaluation.records.every((record) => (
      record.evaluationStatus === 'cancelled'
    ))).toBe(true);
  });

  it('lets Core censor unstarted coordinates at the sealed evaluation budget', async () => {
    let calls = 0;
    const result = await runCore({
      handler: async () => {
        calls += 1;
        return {
          invocationStatus: 'completed',
          output: '{"score":5,"reason":"valid"}',
        };
      },
      policy: policy({ evaluationInvocations: 1 }),
    });
    expect(calls).toBe(1);
    expect(result.evaluation.evaluationBundleStatus).toBe('budget-exhausted');
    expect(result.evaluation.coverage).toMatchObject({ planned: 2, completed: 1, notStarted: 1 });
  });

  it('fingerprints prompt variant, trace policy, model, and provider Runtime identity', () => {
    const handler: InvocationHandler = async () => ({
      invocationStatus: 'completed',
      output: '{"score":5,"reason":"valid"}',
    });
    const basePort = invocationPort(handler);
    const base = evaluatorIdentity({ lengthDebias: true, tracePolicy: 'none' }, basePort);
    const identities = [
      evaluatorIdentity({ lengthDebias: false, tracePolicy: 'none' }, basePort),
      evaluatorIdentity({ lengthDebias: true, tracePolicy: 'source-neutral' }, basePort),
      evaluatorIdentity({ lengthDebias: true, tracePolicy: 'none', model: 'other' }, basePort),
      evaluatorIdentity(
        { lengthDebias: true, tracePolicy: 'none' },
        invocationPort(handler, 'optional', providerIdentity(2)),
      ),
    ];
    for (const identity of identities) expect(identity.fingerprint).not.toBe(base.fingerprint);
  });

  it('preserves opaque provider provenance through evaluator composition', () => {
    const opaqueProvider = RuntimeIdentitySchema.parse({
      implementationId: PROVIDER_IMPLEMENTATION_ID,
      fingerprint: digestCanonicalJson({ provider: PROVIDER_IMPLEMENTATION_ID, opaque: true }),
      fingerprintBasis: 'opaque',
      assuranceLevel: 'unknown',
      capabilities: { invocation: 'single-call' },
      implementationManifest: {
        coverageKind: 'fingerprint-plus-facets',
        facets: [{
          facetId: 'provider.deployment',
          value: { coverage: 'remote-opaque' },
        }],
      },
    });
    const identity = evaluatorIdentity(
      { lengthDebias: true, tracePolicy: 'none' },
      invocationPort(async () => ({
        invocationStatus: 'completed',
        output: '{"score":5,"reason":"valid"}',
      }), 'optional', opaqueProvider),
    );

    expect(identity.fingerprintBasis).toBe('opaque');
    expect(identity.assuranceLevel).toBe('unknown');
  });

  it('captures the provider method and receiver identity against later mutation', async () => {
    const initialIdentity = providerIdentity(1);
    let originalCalls = 0;
    const mutablePort: {
      identity: RuntimeIdentity;
      providerCost: { reporting: 'optional' };
      invoke: OmkLlmJudgeInvocationPort['invoke'];
    } = {
      identity: initialIdentity,
      providerCost: { reporting: 'optional' as const },
      async invoke(this: OmkLlmJudgeInvocationPort) {
        originalCalls += 1;
        expect(this.identity).toEqual(initialIdentity);
        return {
          invocationStatus: 'completed' as const,
          output: '{"score":5,"reason":"captured"}',
        };
      },
    };
    const captured = captureLlmJudgeInvocationPort(mutablePort);
    mutablePort.identity = providerIdentity(2);
    mutablePort.invoke = async () => ({
      invocationStatus: 'failed' as const,
      reasonCode: 'mutated-method',
    });
    const result = await captured.invoke({
      executorId: PROVIDER_IMPLEMENTATION_ID,
      model: 'judge-model',
      system: 'system',
      prompt: 'prompt',
      promptId: 'rubric-judge-debias-on',
      promptHash: getJudgePromptHash(true),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ invocationStatus: 'completed' });
    expect(originalCalls).toBe(1);
    expect(captured.identity).toEqual(initialIdentity);
  });

  it('builds a host factory with sealed qualification and shared provider boundary', async () => {
    const definitionValue = definition();
    const provider = invocationPort(async () => ({
      invocationStatus: 'completed',
      output: '{"score":5,"reason":"valid"}',
    }));
    const factory = createRubricJudgeEvaluatorBindingFactory(async () => ({
      port: provider,
      preflightDeclarations: [{
        preflightKind: 'connectivity',
        preflightDisposition: 'check',
        checkId: 'judge-connectivity',
        run: () => undefined,
      }],
    }));
    const resolved = await factory({
      sessionIsolationKey: 'rubric-judge-factory-session',
      binding: {
        runtimeKind: 'evaluator',
        bindingId: 'rubric-judge-binding',
        evaluatorId: 'rubric-judge',
        implementationId: RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
        measurement: definitionValue.evaluators[0].measurement,
        configDigest: digestCanonicalJson(definitionValue.evaluators[0].config as JsonValue),
        resourceLeaseRequirements: [],
        qualification: {
          executorId: PROVIDER_IMPLEMENTATION_ID,
          model: 'judge-model',
          effort: 'low',
          promptVariant: 'rubric-judge-debias-on',
          resourceIntegrity: 'digest-before-use',
        },
      },
      evaluator: definitionValue.evaluators[0],
      resourceLeases: {
        forRun: () => ({
          bindingId: 'rubric-judge-binding',
          consumerKind: 'evaluator',
          resourcesByResourceId: new Map(),
        }),
      },
    });
    expect(resolved.port.identity).toEqual(evaluatorIdentity({
      lengthDebias: true,
      tracePolicy: 'none',
    }, provider));
    expect(resolved.preflightDeclarations).toEqual([
      expect.objectContaining({ checkId: 'judge-connectivity', preflightDisposition: 'check' }),
    ]);
  });
});
