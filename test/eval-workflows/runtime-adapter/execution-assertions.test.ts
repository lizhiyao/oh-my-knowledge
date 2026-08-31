import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_FACTS_SCHEMA_VERSION,
  ExecutionFactsSchema,
  RuntimeIdentitySchema,
  digestCanonicalJson,
  type ExecutionFacts,
  type JsonValue,
  type RuntimeIdentity,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  evaluateExecutionBundle,
  type EvaluationCache,
  type EvaluationCacheEntry,
  type EvaluationClock,
  type EvaluationEvaluator,
  type EvaluatorBindingValue,
} from '../../../src/evaluation-core/evaluation/index.js';
import {
  prepareEvaluationPlan,
  type PreparationRuntime,
} from '../../../src/evaluation-core/compiler/index.js';
import {
  executeRunPlanSource,
  InMemoryRuntimeEventSequencer,
  type ExecutionExecutor,
} from '../../../src/evaluation-core/execution/index.js';
import {
  createBuiltinOmkScoringBindingFactories,
  createExecutionAssertionEvaluatorImplementation,
  createSameProcessEvaluatorAdapter,
  EXECUTION_ASSERTION_BINDINGS,
  EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION,
  EXECUTION_ASSERTION_EVALUATOR_IDENTITY,
  EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
  SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
  SourceNeutralTraceSchema,
  type SourceNeutralTrace,
} from '../../../src/eval-workflows/runtime-adapter/index.js';
import {
  EXECUTION_AWARE_SYNC_ASSERTION_TYPE_NAMES,
  OUTPUT_ONLY_SYNC_ASSERTION_TYPE_NAMES,
  deterministicAssertionInputSourceKinds,
} from '../../../src/shared/assertions/deterministic.js';
import type { Assertion } from '../../../src/types/index.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
} from '../../evaluation-core/compiler/fixtures.js';

interface ScoringFixture {
  deterministicAssertions: {
    output: string;
    assertions: Assertion[];
    expected: { details: JsonValue[] };
  };
}

const scoringFixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../fixtures/evaluation-core/scoring-equivalence-v1.json',
  import.meta.url,
)), 'utf8')) as ScoringFixture;

const FACTS = ExecutionFactsSchema.parse({
  schemaVersion: EXECUTION_FACTS_SCHEMA_VERSION,
  sourceRecordDigest: digestCanonicalJson({ record: 'execution-assertion' }),
  coordinate: { trialIndex: 0 },
  terminal: { executionStatus: 'completed' },
  attemptCount: 1,
  retryCount: 0,
  attempts: [{
    attemptNumber: 1,
    attemptStatus: 'completed',
    activeDurationMs: { reportingStatus: 'reported', value: 80 },
    usageReportingStatus: 'reported',
    providerCostReportingStatus: 'reported',
  }],
  timing: {
    activeDurationMs: { reportingStatus: 'reported', value: 80 },
    wallClockDurationMs: { reportingStatus: 'reported', value: 120 },
  },
  usage: {
    usageRecordStatus: 'complete',
    inputTokens: { reportingStatus: 'reported', value: 10 },
    outputTokens: { reportingStatus: 'reported', value: 4 },
    totalTokens: { reportingStatus: 'reported', value: 14 },
    providerCost: {
      reportingStatus: 'reported',
      amount: 0.02,
      currency: 'USD',
      reportedByProvider: true,
    },
  },
  cacheStatus: 'not-used',
  content: {
    output: { captureStatus: 'inline', classification: 'secret' },
    trace: { captureStatus: 'inline', classification: 'sensitive' },
  },
  sourceProvenance: { provenanceKind: 'native', effectiveTrust: 'verified' },
});

const TRACE = SourceNeutralTraceSchema.parse({
  schemaVersion: SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
  turns: [{ role: 'assistant', content: 'first' }, { role: 'assistant', content: 'second' }],
  toolCalls: [{
    tool: 'Read',
    input: { path: '/fixture' },
    output: 'fixture value',
    status: 'success',
    statusSource: 'runtime',
    success: true,
  }],
  numTurns: 1,
  fullNumTurns: 9,
  numSubAgents: 2,
  mockStats: { hits: 2, misses: 1, perMock: { 'Read:1': 2 } },
});

function criterion(metricId: string, assertion: Assertion): JsonValue {
  return {
    criterionId: metricId,
    metricId,
    assertion: structuredClone(assertion) as unknown as JsonValue,
  };
}

function contextBinding(
  criteria: readonly JsonValue[],
  sourceKinds?: readonly ('output' | 'execution-facts' | 'trace')[],
): EvaluatorBindingValue {
  const inferred = criteria.length === 0
    ? sourceKinds
    : deterministicAssertionInputSourceKinds(
        (criteria[0] as unknown as { assertion: Assertion }).assertion,
      );
  if (inferred === undefined) throw new Error('Empty criteria require an explicit source signature.');
  return {
    bindingId: EXECUTION_ASSERTION_BINDINGS.criteria,
    sourceKind: 'evaluation-context',
    value: {
      schemaVersion: EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION,
      sourceKinds: [...inferred],
      criteria: [...criteria],
    },
    classification: 'public',
  };
}

function factsBinding(
  facts: ExecutionFacts = FACTS,
  classification: EvaluatorBindingValue['classification'] = 'secret',
): EvaluatorBindingValue {
  return {
    bindingId: EXECUTION_ASSERTION_BINDINGS.facts,
    sourceKind: 'execution-facts',
    value: facts as unknown as JsonValue,
    classification,
    mediaType: 'application/vnd.omk.execution-facts+json',
  };
}

function traceBinding(
  trace: SourceNeutralTrace = TRACE,
  classification: EvaluatorBindingValue['classification'] = 'sensitive',
): EvaluatorBindingValue {
  return {
    bindingId: EXECUTION_ASSERTION_BINDINGS.trace,
    sourceKind: 'trace',
    value: trace as JsonValue,
    classification,
    mediaType: 'application/vnd.omk.source-neutral-trace+json',
  };
}

function outputBinding(
  output = 'hello execution core',
  classification: EvaluatorBindingValue['classification'] = 'gold',
): EvaluatorBindingValue {
  return {
    bindingId: EXECUTION_ASSERTION_BINDINGS.actual,
    sourceKind: 'output',
    value: output,
    classification,
  };
}

async function evaluateDirect(
  criteria: readonly JsonValue[],
  bindings: readonly EvaluatorBindingValue[],
  options: { signal?: AbortSignal; extraMetricIds?: readonly string[] } = {},
) {
  const implementation = createExecutionAssertionEvaluatorImplementation();
  const run = {
    runId: 'execution-assertion-run',
    evaluationPlanDigest: digestCanonicalJson({ plan: 'execution-assertion' }),
  };
  const scope = {
    sessionIsolationKey: 'execution-assertion-session',
    runIsolationKey: digestCanonicalJson({ run: 'execution-assertion' }),
    operationIsolationKey: digestCanonicalJson({ operation: 'execution-assertion' }),
  };
  const resources = {
    bindingId: 'execution-assertions-binding',
    consumerKind: 'evaluator' as const,
    resourcesByResourceId: new Map(),
  };
  const metricIds = [
    ...criteria.map((value) => (value as { metricId: string }).metricId),
    ...(options.extraMetricIds ?? []),
  ];
  const record = {
    targetId: 'control',
    sampleId: 'sample-1',
    trialIndex: 0,
    trialId: digestCanonicalJson({ trial: 'execution-assertion' }),
    evaluatorId: 'execution-assertions',
    measurement: {
      instrumentId: 'omk-execution-assertions',
      ensembleMemberId: 'deterministic-local',
      replicateGroupId: 'deterministic-primary',
      replicateIndex: 0,
    },
    evaluationId: digestCanonicalJson({ evaluation: 'execution-assertion' }),
    bindings,
    metrics: metricIds.map((metricId) => ({
      metricId,
      valueType: 'boolean' as const,
      scope: 'sample' as const,
      direction: 'higher-is-better' as const,
      missingPolicyId: 'exclude/v1',
    })),
  };
  const runState = await implementation.openRun({ run, scope, resources });
  const recordState = await implementation.openRecord({
    run,
    runState,
    record,
    scope,
    resources,
  });
  return implementation.evaluate({
    run,
    runState,
    record,
    recordState,
    attempt: {
      attemptId: digestCanonicalJson({ attempt: 'execution-assertion' }),
      attemptNumber: 1,
      signal: options.signal ?? new AbortController().signal,
    },
    scope,
    resources,
  });
}

class DeterministicClock implements EvaluationClock {
  #now = 0;

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
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
}

class MemoryEvaluationCache implements EvaluationCache {
  readonly entries = new Map<string, EvaluationCacheEntry>();
  hits = 0;
  puts = 0;

  async get(cacheKeyDigest: string): Promise<EvaluationCacheEntry | undefined> {
    const entry = this.entries.get(cacheKeyDigest);
    if (entry !== undefined) this.hits += 1;
    return entry;
  }

  async put(entry: Readonly<EvaluationCacheEntry>): Promise<void> {
    this.puts += 1;
    this.entries.set(entry.cacheKeyDigest, structuredClone(entry));
  }
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
  if (runtime === undefined) throw new Error(`Missing runtime ${referenceId}`);
  return RuntimeIdentitySchema.parse(structuredClone(runtime.identity));
}

async function runFactsCore(cache: EvaluationCache) {
  const criteria = [criterion('cost', { type: 'cost_max', value: 0.03 })];
  const definition = validDefinition();
  definition.targets = [definition.targets[0]];
  definition.experiment.randomizationSlots = definition.experiment.randomizationSlots.filter(
    (slot) => slot.targetId === definition.targets[0].targetId,
  );
  definition.dataset.samples[0].evaluationContext = {
    executionAssertions: {
      schemaVersion: EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION,
      sourceKinds: ['execution-facts'],
      criteria,
    },
  };
  definition.evaluators = [{
    evaluatorId: 'execution-assertions',
    evaluatorKind: 'assertion',
    implementationId: EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
    measurement: {
      instrumentId: 'omk-execution-assertions',
      ensembleMemberId: 'deterministic-local',
      replicateGroupId: 'deterministic-primary',
      replicateIndex: 0,
    },
    metricIds: ['cost'],
    inputs: [{
      bindingId: EXECUTION_ASSERTION_BINDINGS.facts,
      sourceKind: 'execution-facts',
      pointer: '',
    }, {
      bindingId: EXECUTION_ASSERTION_BINDINGS.criteria,
      sourceKind: 'evaluation-context',
      pointer: '/executionAssertions',
    }],
  }];
  definition.metrics = [{
    metricId: 'cost',
    valueType: 'boolean',
    scope: 'sample',
    direction: 'higher-is-better',
    missingPolicyId: 'exclude/v1',
  }];
  definition.comparisons = [];
  definition.analysisGraph.nodes = [{
    analysisNodeKind: 'reducer',
    nodeId: 'cost-rate',
    implementationId: 'descriptive.rate/v1',
    inputs: [{ inputKind: 'metric-observations', referenceId: 'cost' }],
    outputResultId: 'cost-rate',
  }];
  definition.decisionPolicy = {
    decisionPolicyId: 'release-gate',
    implementationId: 'progress/v1',
    analysisResultIds: ['cost-rate'],
    minimumEvidenceStatus: 'complete',
    parameters: { threshold: 0 },
  };
  const policy = validPolicy();
  policy.retry.maxAttempts = 1;
  policy.evaluation.retry.maxAttempts = 1;
  policy.cache.evaluationMode = 'reuse';
  policy.evidence.evidence = 'full';
  policy.evidence.trace = 'none';
  policy.evidence.maximumClassification = 'gold';
  const baseRuntime = testRuntime({
    executorProviderCost: { reporting: 'optional' },
  });
  const preparationRuntime: PreparationRuntime = {
    ...baseRuntime,
    resolveEvaluator() {
      return {
        identity: EXECUTION_ASSERTION_EVALUATOR_IDENTITY,
        satisfiesVersionConstraint: true,
      };
    },
  };
  const plan = await prepareEvaluationPlan(definition, policy, preparationRuntime);
  const clock = new DeterministicClock();
  const eventSequencer = new InMemoryRuntimeEventSequencer();
  const executor: ExecutionExecutor = {
    identity: runtimeIdentity(plan, 'executor', definition.targets[0].targetId),
    async openRun() {
      return {
        async openTrial() {
          return {
            async execute() {
              return {
                output: { value: 'answer', classification: 'secret' as const },
                usage: {
                  inputTokens: 10,
                  outputTokens: 4,
                  totalTokens: 14,
                  providerCost: {
                    amount: 0.02,
                    currency: 'USD',
                    reportedByProvider: true as const,
                  },
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
  const execution = await executeRunPlanSource(plan, {
    executorsByTargetId: new Map([[definition.targets[0].targetId, executor]]),
    clock,
    eventSequencer,
  }, { runId: 'execution-assertion-run', bundleId: 'execution-assertion-source' });
  let evaluations = 0;
  const port = createSameProcessEvaluatorAdapter({
    identity: EXECUTION_ASSERTION_EVALUATOR_IDENTITY,
    sessionIsolationKey: 'execution-assertion-session',
    resourceLeases: {
      forRun: () => ({
        bindingId: 'execution-assertions-binding',
        consumerKind: 'evaluator',
        resourcesByResourceId: new Map(),
      }),
    },
    implementation: createExecutionAssertionEvaluatorImplementation(),
  });
  const instrumented: EvaluationEvaluator = {
    identity: port.identity,
    async openRun(runContext) {
      const run = await port.openRun(runContext);
      return {
        async openRecord(recordContext) {
          const record = await run.openRecord(recordContext);
          return {
            async evaluate(attempt) {
              evaluations += 1;
              return record.evaluate(attempt);
            },
            dispose: () => record.dispose(),
          };
        },
        dispose: () => run.dispose(),
      };
    },
  };
  const evaluate = (runId: string, bundleId: string) => evaluateExecutionBundle(plan, execution, {
    evaluatorsByEvaluatorId: new Map([['execution-assertions', instrumented]]),
    clock,
    eventSequencer,
    cache,
  }, { runId, bundleId });
  return { evaluate, getEvaluations: () => evaluations };
}

describe('execution-aware deterministic assertion Evaluator', () => {
  it('materializes Core-owned facts and replays only a source-bound evaluation cache entry', async () => {
    const cache = new MemoryEvaluationCache();
    const runtime = await runFactsCore(cache);
    const first = await runtime.evaluate('facts-first-run', 'facts-first-bundle');
    const second = await runtime.evaluate('facts-second-run', 'facts-second-bundle');
    expect(first.records[0]).toMatchObject({
      evaluationStatus: 'completed',
      observations: [{ observationStatus: 'observed', value: true }],
    });
    expect(second.records[0]).toMatchObject({
      evaluationStatus: 'completed',
      cache: { cacheStatus: 'transparent-hit' },
      observations: [{ observationStatus: 'observed', value: true }],
    });
    expect(runtime.getEvaluations()).toBe(1);
    expect(cache.puts).toBe(1);
    expect(cache.hits).toBe(1);
  });

  it('infers the recursive least-authority dependency union', () => {
    expect(deterministicAssertionInputSourceKinds({ type: 'cost_max', value: 1 })).toEqual([
      'execution-facts',
    ]);
    expect(deterministicAssertionInputSourceKinds({ type: 'turns_max', value: 1 })).toEqual([
      'trace',
    ]);
    expect(deterministicAssertionInputSourceKinds({
      type: 'assert-set',
      mode: 'all',
      children: [
        { type: 'contains', value: 'hello' },
        { type: 'latency_max', value: 200 },
        { type: 'tools_called', values: ['Read'] },
      ],
    })).toEqual(['output', 'execution-facts', 'trace']);
    for (const type of OUTPUT_ONLY_SYNC_ASSERTION_TYPE_NAMES.filter(
      (candidate) => candidate !== 'assert-set',
    )) {
      expect(deterministicAssertionInputSourceKinds({ type } as Assertion)).toEqual(['output']);
    }
    for (const type of EXECUTION_AWARE_SYNC_ASSERTION_TYPE_NAMES) {
      expect(deterministicAssertionInputSourceKinds({ type } as Assertion)).toEqual(
        ['cost_max', 'latency_max'].includes(type) ? ['execution-facts'] : ['trace'],
      );
    }
  });

  it('uses reported aggregate cost and trial wall-clock latency from execution facts', async () => {
    const criteria = [
      criterion('cost', { type: 'cost_max', value: 0.03 }),
      criterion('latency', { type: 'latency_max', value: 100 }),
    ];
    const result = await evaluateDirect(criteria, [contextBinding(criteria), factsBinding()]);
    expect(result.observations.map((value) => ({
      metricId: value.metricId,
      status: value.observationStatus,
      observed: value.observationStatus === 'observed' ? value.value : undefined,
    }))).toEqual([
      { metricId: 'cost', status: 'observed', observed: true },
      { metricId: 'latency', status: 'observed', observed: false },
    ]);
    expect(result.observations[0].evidence?.classification).toBe('secret');
  });

  it('emits missing observations for unavailable or non-USD cost instead of treating it as zero', async () => {
    const criteria = [criterion('cost', { type: 'cost_max', value: 0.03 })];
    const unreported = ExecutionFactsSchema.parse({
      ...FACTS,
      attempts: FACTS.attempts.map((attempt) => ({
        ...attempt,
        usageReportingStatus: 'unreported',
        providerCostReportingStatus: 'unreported',
      })),
      usage: {
        usageRecordStatus: 'absent',
        inputTokens: { reportingStatus: 'unreported' },
        outputTokens: { reportingStatus: 'unreported' },
        totalTokens: { reportingStatus: 'unreported' },
        providerCost: { reportingStatus: 'unreported' },
      },
    });
    const unavailable = await evaluateDirect(criteria, [
      contextBinding(criteria),
      factsBinding(unreported),
    ]);
    expect(unavailable.observations).toEqual([{
      metricId: 'cost',
      observationStatus: 'missing',
      valueType: 'boolean',
      reasonCode: 'provider-cost-unavailable',
    }]);

    const eur = ExecutionFactsSchema.parse({
      ...FACTS,
      usage: {
        ...FACTS.usage,
        providerCost: {
          reportingStatus: 'reported',
          amount: 0.02,
          currency: 'EUR',
          reportedByProvider: true,
        },
      },
    });
    const unsupported = await evaluateDirect(criteria, [contextBinding(criteria), factsBinding(eur)]);
    expect(unsupported.observations[0]).toMatchObject({
      observationStatus: 'missing',
      reasonCode: 'provider-cost-currency-unsupported',
    });
  });

  it('keeps partial and mixed-currency retries missing while using complete retry aggregate cost', async () => {
    const criteria = [criterion('cost', { type: 'cost_max', value: 0.03 })];
    const attempts = [{
      attemptNumber: 1,
      attemptStatus: 'failed' as const,
      activeDurationMs: { reportingStatus: 'reported' as const, value: 80 },
      usageReportingStatus: 'reported' as const,
      providerCostReportingStatus: 'reported' as const,
    }, {
      attemptNumber: 2,
      attemptStatus: 'completed' as const,
      activeDurationMs: { reportingStatus: 'reported' as const, value: 90 },
      usageReportingStatus: 'reported' as const,
      providerCostReportingStatus: 'reported' as const,
    }];
    const base = {
      ...FACTS,
      attemptCount: 2,
      retryCount: 1,
      attempts,
      timing: {
        activeDurationMs: { reportingStatus: 'reported' as const, value: 170 },
        wallClockDurationMs: { reportingStatus: 'reported' as const, value: 220 },
      },
    };
    const complete = ExecutionFactsSchema.parse({
      ...base,
      usage: {
        ...FACTS.usage,
        providerCost: {
          reportingStatus: 'reported',
          amount: 0.04,
          currency: 'USD',
          reportedByProvider: true,
        },
      },
    });
    const completeResult = await evaluateDirect(criteria, [
      contextBinding(criteria),
      factsBinding(complete),
    ]);
    expect(completeResult.observations[0]).toMatchObject({
      observationStatus: 'observed',
      value: false,
    });

    const partial = ExecutionFactsSchema.parse({
      ...base,
      attempts: [attempts[0], {
        ...attempts[1],
        usageReportingStatus: 'unreported',
        providerCostReportingStatus: 'unreported',
      }],
      usage: {
        usageRecordStatus: 'partial',
        inputTokens: { reportingStatus: 'partial', value: 10, reportedAttemptCount: 1 },
        outputTokens: { reportingStatus: 'partial', value: 4, reportedAttemptCount: 1 },
        totalTokens: { reportingStatus: 'partial', value: 14, reportedAttemptCount: 1 },
        providerCost: { reportingStatus: 'partial', reportedAttemptCount: 1 },
      },
    });
    const partialResult = await evaluateDirect(criteria, [
      contextBinding(criteria),
      factsBinding(partial),
    ]);
    expect(partialResult.observations[0]).toMatchObject({
      observationStatus: 'missing',
      reasonCode: 'provider-cost-unavailable',
    });

    const mixed = ExecutionFactsSchema.parse({
      ...base,
      usage: {
        ...FACTS.usage,
        providerCost: { reportingStatus: 'mixed-currency', currencies: ['EUR', 'USD'] },
      },
    });
    const mixedResult = await evaluateDirect(criteria, [
      contextBinding(criteria),
      factsBinding(mixed),
    ]);
    expect(mixedResult.observations[0]).toMatchObject({
      observationStatus: 'missing',
      reasonCode: 'provider-cost-unavailable',
    });
  });

  it('uses independent numTurns and source-neutral tool/mock facts', async () => {
    expect(SourceNeutralTraceSchema.safeParse({
      ...TRACE,
      schemaVersion: 'omk.source-neutral-trace/v1',
    }).success).toBe(false);
    expect(SourceNeutralTraceSchema.safeParse({
      ...TRACE,
      mockStats: { hits: 1, misses: 0, perMock: { 'Read:0': 1 } },
    }).success).toBe(false);
    const criteria = [
      criterion('turns', { type: 'turns_max', value: 1 }),
      criterion('called', { type: 'tools_called', values: ['Read'] }),
      criterion('not-called', { type: 'tools_not_called', values: ['Bash'] }),
      criterion('count-max', { type: 'tools_count_max', value: 1 }),
      criterion('count-min', { type: 'tools_count_min', value: 1 }),
      criterion('tool-output', { type: 'tool_output_contains', value: 'Read:fixture' }),
      criterion('tool-input', { type: 'tool_input_contains', value: 'Read:fixture' }),
      criterion('tool-input-not', { type: 'tool_input_not_contains', value: 'Read:missing' }),
      criterion('mock', { type: 'mock_hit', value: 'Read:1', threshold: 2 }),
    ];
    const result = await evaluateDirect(criteria, [contextBinding(criteria), traceBinding()]);
    expect(result.observations.map((value) => (
      value.observationStatus === 'observed' ? value.value : value.reasonCode
    ))).toEqual([true, true, true, true, true, true, true, true, true]);

    const withoutMocks = SourceNeutralTraceSchema.parse({
      ...TRACE,
      mockStats: undefined,
    });
    const mockOnly = [criterion('mock', { type: 'mock_hit', value: 'Read:1' })];
    const missing = await evaluateDirect(mockOnly, [
      contextBinding(mockOnly),
      traceBinding(withoutMocks),
    ]);
    expect(missing.observations[0]).toMatchObject({
      observationStatus: 'missing',
      reasonCode: 'mock-stats-unavailable',
    });

    const emptyTrace = SourceNeutralTraceSchema.parse({
      ...TRACE,
      turns: [],
      toolCalls: [],
      numTurns: 0,
      fullNumTurns: 0,
      numSubAgents: 0,
      mockStats: undefined,
    });
    const emptyCriteria = [
      criterion('not-called', { type: 'tools_not_called', values: ['Read'] }),
      criterion('count-max', { type: 'tools_count_max', value: 0 }),
      criterion('count-min', { type: 'tools_count_min', value: 1 }),
    ];
    const emptyResult = await evaluateDirect(emptyCriteria, [
      contextBinding(emptyCriteria),
      traceBinding(emptyTrace),
    ]);
    expect(emptyResult.observations.map((value) => (
      value.observationStatus === 'observed' ? value.value : value.reasonCode
    ))).toEqual([true, true, false]);
  });

  it('evaluates nested mixed assertions with the exact dependency union', async () => {
    const mixed = scoringFixture.deterministicAssertions.assertions[4];
    const fixtureTrace = SourceNeutralTraceSchema.parse({
      ...TRACE,
      toolCalls: [{
        tool: 'Bash',
        input: { command: 'true' },
        output: '',
        status: 'success',
        statusSource: 'runtime',
        success: true,
      }],
    });
    const criteria = [criterion('mixed', mixed)];
    const result = await evaluateDirect(criteria, [
      contextBinding(criteria),
      outputBinding(scoringFixture.deterministicAssertions.output),
      traceBinding(fixtureTrace),
    ], { extraMetricIds: ['not-applicable'] });
    expect(result.observations[0]).toMatchObject({
      metricId: 'mixed',
      observationStatus: 'observed',
      value: true,
      evidence: {
        classification: 'gold',
        value: { detail: scoringFixture.deterministicAssertions.expected.details[4] },
      },
    });
    expect(result.observations[1]).toMatchObject({
      metricId: 'not-applicable',
      observationStatus: 'missing',
      reasonCode: 'criterion-not-applicable',
    });
  });

  it('rejects mixed dependency groups and excess-authority bindings', async () => {
    const mixedSignatures = [
      criterion('cost', { type: 'cost_max', value: 1 }),
      criterion('turns', { type: 'turns_max', value: 1 }),
    ];
    await expect(evaluateDirect(mixedSignatures, [
      contextBinding(mixedSignatures),
      factsBinding(),
      traceBinding(),
    ])).rejects.toMatchObject({
      evaluationError: { code: 'omk-execution-assertion-dependency-mixed' },
    });

    const factsOnly = [criterion('cost', { type: 'cost_max', value: 1 })];
    await expect(evaluateDirect(factsOnly, [
      contextBinding(factsOnly),
      factsBinding(),
      traceBinding(),
    ])).rejects.toMatchObject({
      evaluationError: { code: 'omk-execution-assertion-binding-invalid' },
    });
  });

  it('preserves the run-plan dependency signature when a sample has no applicable criteria', async () => {
    const result = await evaluateDirect([], [
      contextBinding([], ['trace']),
      traceBinding(),
    ], { extraMetricIds: ['not-applicable'] });
    expect(result.observations).toEqual([{
      metricId: 'not-applicable',
      observationStatus: 'missing',
      valueType: 'boolean',
      reasonCode: 'criterion-not-applicable',
    }]);
  });

  it('fails closed on malformed trace and cooperates with cancellation', async () => {
    const criteria = [criterion('turns', { type: 'turns_max', value: 1 })];
    await expect(evaluateDirect(criteria, [contextBinding(criteria), {
      ...traceBinding(),
      value: { ...TRACE, numTurns: undefined } as unknown as JsonValue,
    }])).rejects.toMatchObject({
      evaluationError: { code: 'omk-execution-assertion-trace-invalid' },
    });

    const controller = new AbortController();
    const reason = new Error('cancel execution assertion');
    controller.abort(reason);
    await expect(evaluateDirect(criteria, [contextBinding(criteria), traceBinding()], {
      signal: controller.signal,
    })).rejects.toBe(reason);
  });

  it('registers a production factory with a fingerprint-complete identity', async () => {
    const factory = createBuiltinOmkScoringBindingFactories()
      .evaluatorsByImplementationId.get(EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID);
    expect(factory).toBeDefined();
    const resolved = await factory!({
      sessionIsolationKey: 'factory-session',
      binding: {
        runtimeKind: 'evaluator',
        bindingId: 'execution-assertions-binding',
        evaluatorId: 'execution-assertions',
        implementationId: EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
        measurement: {
          instrumentId: 'omk-execution-assertions',
          ensembleMemberId: 'deterministic-local',
          replicateGroupId: 'deterministic-primary',
          replicateIndex: 0,
        },
        resourceLeaseRequirements: [],
      },
      evaluator: {
        evaluatorId: 'execution-assertions',
        evaluatorKind: 'assertion',
        implementationId: EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
        measurement: {
          instrumentId: 'omk-execution-assertions',
          ensembleMemberId: 'deterministic-local',
          replicateGroupId: 'deterministic-primary',
          replicateIndex: 0,
        },
        metricIds: ['cost'],
        inputs: [
          { bindingId: EXECUTION_ASSERTION_BINDINGS.facts, sourceKind: 'execution-facts', pointer: '' },
          { bindingId: EXECUTION_ASSERTION_BINDINGS.criteria, sourceKind: 'evaluation-context', pointer: '/criteria' },
        ],
      },
      resourceLeases: {
        forRun: () => ({
          bindingId: 'execution-assertions-binding',
          consumerKind: 'evaluator',
          resourcesByResourceId: new Map(),
        }),
      },
    });
    expect(resolved.port.identity).toEqual(EXECUTION_ASSERTION_EVALUATOR_IDENTITY);
    expect(resolved.port.identity.implementationManifest).toEqual({
      coverageKind: 'fingerprint-complete',
    });
    expect(resolved.preflightDeclarations).toEqual([
      expect.objectContaining({ preflightKind: 'credential', preflightDisposition: 'not-required' }),
      expect.objectContaining({ preflightKind: 'connectivity', preflightDisposition: 'not-required' }),
    ]);
  });
});
