import {
  type AnalysisBundle,
  type AnalysisBundleSource,
  type DecisionResult,
  type DecisionResultSource,
  type EvaluationBundle,
  type EvaluationDefinition,
  type EvaluationEvent,
  type EvaluationReport,
  type ExecutionBundle,
  type ExecutionBundleSource,
  type EvaluationBundleSource,
  type ContentDescriptor,
  type JsonValue,
  type MeasurementPolicy,
  type RuntimeIdentity,
  parseExecutionBundle,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  prepareEvaluationPlan,
  type AnalysisRuntimeRequirement,
  type PreparationRuntime,
  type SealedRunPlan,
} from '../../../src/evaluation-core/compiler/index.js';
import {
  InMemoryRuntimeEventSequencer,
  startExecution,
  type ExecutionClock,
  type ExecutionExecutor,
  type ExecutionCache,
  type ExecutionCacheEntry,
  type ExecutionContentStoreRequest,
  type ExecutorAttemptResult,
  type ExecutorTrialContext,
} from '../../../src/evaluation-core/execution/index.js';
import {
  startEvaluation,
  type EvaluationEvaluator,
  type EvaluationCache,
  type EvaluationCacheEntry,
  type EvaluationContent,
  type EvaluationContentStoreRequest,
  type EvaluatorRecordContext,
} from '../../../src/evaluation-core/evaluation/index.js';
import {
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
  resolveBuiltinAnalysisRuntime,
  startAnalysis,
  startDecision,
  startReportMaterialization,
  type AnalysisDecisionPolicy,
  type AnalysisNodeImplementation,
  type AnalysisRuntimePorts,
} from '../../../src/evaluation-core/analysis/index.js';
import { testRuntime, validDefinition, validPolicy } from '../compiler/fixtures.js';
import { ConformanceFaultInjector } from './fault-injector.js';

export type ConformanceTarget = 'function' | 'rag' | 'agent';

export interface ConformanceState {
  executorRunOpens: number;
  executorRunDisposals: number;
  trialOpens: number;
  trialDisposals: number;
  executorAttempts: number;
  evaluatorRunOpens: number;
  evaluatorRunDisposals: number;
  recordOpens: number;
  recordDisposals: number;
  evaluatorAttempts: number;
  trialContexts: ExecutorTrialContext[];
  recordContexts: EvaluatorRecordContext[];
  writtenEvents: EvaluationEvent[];
}

export interface ConformanceResult {
  plan: SealedRunPlan;
  execution: ExecutionBundle;
  executionSource: ExecutionBundleSource;
  evaluation: EvaluationBundle;
  evaluationSource: EvaluationBundleSource;
  analysis: AnalysisBundle;
  analysisSource: AnalysisBundleSource;
  decision: DecisionResult | undefined;
  decisionSource: DecisionResultSource | undefined;
  report: EvaluationReport;
  events: EvaluationEvent[];
  state: ConformanceState;
}

export interface ConformanceHarnessOptions {
  suffix?: string;
  runId?: string;
  plan?: SealedRunPlan;
  mutate?: (definition: EvaluationDefinition, policy: MeasurementPolicy) => void;
  consumeEvent?: (event: EvaluationEvent) => void | Promise<void>;
  eventConsumption?: 'live' | 'after-result';
  execution?: ExecutionBundle;
  executionSource?: ExecutionBundleSource;
  faults?: ConformanceFaultInjector;
  executionSignal?: AbortSignal;
  evaluationSignal?: AbortSignal;
  artifactStore?: InMemoryConformanceArtifactStore;
  provideContentResolver?: boolean;
  executionCache?: InMemoryConformanceExecutionCache;
  evaluationCache?: InMemoryConformanceEvaluationCache;
  runtimeRegistry?: ConformanceRuntimeRegistry;
}

export class InMemoryConformanceArtifactStore {
  readonly #values = new Map<string, EvaluationContent>();
  readonly #faults?: ConformanceFaultInjector;

  constructor(faults?: ConformanceFaultInjector) {
    this.#faults = faults;
  }

  async put(
    request: Readonly<ExecutionContentStoreRequest | EvaluationContentStoreRequest>,
  ): Promise<ContentDescriptor> {
    await this.#faults?.hit('content-put');
    this.#values.set(request.digest, {
      value: structuredClone(request.value),
      classification: request.classification,
      mediaType: request.mediaType,
    });
    return {
      digest: request.digest,
      mediaType: request.mediaType,
      uri: `memory://conformance/${request.digest.slice(7)}`,
    };
  }

  async resolve(descriptor: Readonly<ContentDescriptor>): Promise<EvaluationContent> {
    await this.#faults?.hit('content-resolve');
    const content = this.#values.get(descriptor.digest);
    if (content === undefined) throw new Error('Conformance content is unavailable.');
    return structuredClone(content);
  }

  tamper(digest: string, content: EvaluationContent): void {
    if (!this.#values.has(digest)) throw new Error('Conformance content is unavailable.');
    this.#values.set(digest, structuredClone(content));
  }
}

export class InMemoryConformanceExecutionCache implements ExecutionCache {
  readonly #entries = new Map<string, ExecutionCacheEntry>();
  readonly #faults?: ConformanceFaultInjector;

  constructor(faults?: ConformanceFaultInjector) {
    this.#faults = faults;
  }

  async get(cacheKeyDigest: ExecutionCacheEntry['cacheKeyDigest']) {
    await this.#faults?.hit('cache-get');
    const entry = this.#entries.get(cacheKeyDigest);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async put(entry: Readonly<ExecutionCacheEntry>): Promise<void> {
    await this.#faults?.hit('cache-put');
    this.#entries.set(entry.cacheKeyDigest, structuredClone(entry));
  }

  get size(): number {
    return this.#entries.size;
  }

  tamperFirst(mutate: (entry: ExecutionCacheEntry) => void): void {
    const entry = this.#entries.values().next().value;
    if (entry === undefined) throw new Error('Conformance Execution cache is empty.');
    mutate(entry);
  }
}

export class InMemoryConformanceEvaluationCache implements EvaluationCache {
  readonly #entries = new Map<string, EvaluationCacheEntry>();
  readonly #faults?: ConformanceFaultInjector;

  constructor(faults?: ConformanceFaultInjector) {
    this.#faults = faults;
  }

  async get(cacheKeyDigest: EvaluationCacheEntry['cacheKeyDigest']) {
    await this.#faults?.hit('cache-get');
    const entry = this.#entries.get(cacheKeyDigest);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async put(entry: Readonly<EvaluationCacheEntry>): Promise<void> {
    await this.#faults?.hit('cache-put');
    this.#entries.set(entry.cacheKeyDigest, structuredClone(entry));
  }

  get size(): number {
    return this.#entries.size;
  }

  tamperFirst(mutate: (entry: EvaluationCacheEntry) => void): void {
    const entry = this.#entries.values().next().value;
    if (entry === undefined) throw new Error('Conformance Evaluation cache is empty.');
    mutate(entry);
  }
}

class DeterministicClock implements ExecutionClock {
  private elapsed = 0;

  monotonicNow(): number {
    return this.elapsed;
  }

  timestamp(): string {
    const value = new Date(Date.UTC(2026, 7, 29) + this.elapsed).toISOString();
    this.elapsed += 1;
    return value;
  }

  async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.elapsed += delayMs;
  }
}

function runtimeIdentity(
  plan: SealedRunPlan,
  runtimeKind: 'executor' | 'evaluator',
  referenceId: string,
): RuntimeIdentity {
  const runtimes = runtimeKind === 'executor'
    ? plan.execution.runtimes
    : plan.evaluation.runtimes;
  const runtime = runtimes.find((candidate) => (
    candidate.runtimeKind === runtimeKind && candidate.referenceId === referenceId
  ));
  if (runtime === undefined) throw new Error(`Missing sealed ${runtimeKind} ${referenceId}.`);
  return structuredClone(runtime.identity) as RuntimeIdentity;
}

function analysisAwareRuntime(
  target: ConformanceTarget,
  executorFingerprint?: string,
  faults?: ConformanceFaultInjector,
): PreparationRuntime {
  const base = testRuntime({
    ...(executorFingerprint !== undefined ? { executorFingerprint } : {}),
    executorProtocols: target === 'agent'
      ? ['omk.session/v1']
      : ['omk.invoke/v1'],
    traceCapability: target === 'agent' ? 'required' : 'unsupported',
    evaluatorValueTypes: target === 'rag' ? ['numeric'] : ['boolean'],
    analysisValueTypes: target === 'rag' ? ['numeric'] : ['boolean'],
  });
  return {
    schemaValidators: new Map([
      ...base.schemaValidators,
      ...createBuiltinAnalysisSchemaValidators(),
    ]),
    async resolveExecutor(requirement) {
      await faults?.hit('resolve-executor');
      return base.resolveExecutor(requirement);
    },
    async resolveEvaluator(requirement) {
      await faults?.hit('resolve-evaluator');
      return base.resolveEvaluator(requirement);
    },
    async resolveAnalysis(requirement: Readonly<AnalysisRuntimeRequirement>) {
      await faults?.hit(requirement.requirementKind === 'decision-policy'
        ? 'resolve-decision'
        : 'resolve-analysis');
      const resolution = resolveBuiltinAnalysisRuntime(requirement);
      if (resolution === undefined) {
        throw new Error(`Unknown built-in runtime ${requirement.implementationId}.`);
      }
      return resolution;
    },
    validateExtension: (request) => base.validateExtension?.(request),
  };
}

function scenarioDefinition(target: ConformanceTarget): EvaluationDefinition {
  const definition = validDefinition();
  definition.dataset.samples = [
    {
      sampleId: 'sample-1',
      input: target === 'rag'
        ? { query: 'evaluation core' }
        : target === 'agent'
          ? { request: 'research evaluation core' }
          : { question: 'first', answerHint: 'A' },
      expected: target === 'rag'
        ? { relevantDocumentIds: ['doc-a', 'doc-c'] }
        : target === 'agent'
          ? { requiredTools: ['search', 'read'] }
          : { answer: 'A' },
      evaluationContext: { rubric: target },
      annotations: { cohort: 'a' },
    },
    {
      sampleId: 'sample-2',
      input: target === 'rag'
        ? { query: 'measurement validity' }
        : target === 'agent'
          ? { request: 'verify measurement validity' }
          : { question: 'second', answerHint: 'B' },
      expected: target === 'rag'
        ? { relevantDocumentIds: ['doc-b'] }
        : target === 'agent'
          ? { requiredTools: ['search'] }
          : { answer: 'B' },
      evaluationContext: { rubric: target },
      annotations: { cohort: 'b' },
    },
  ];
  definition.targets = definition.targets.map((entry) => ({
    ...entry,
    targetKind: target,
    protocolId: target === 'agent' ? 'omk.session/v1' : 'omk.invoke/v1',
  }));

  if (target === 'rag') {
    const metricIds = ['recall-at-k', 'precision-at-k', 'mrr', 'ndcg'];
    definition.evaluators = [{
      evaluatorId: 'retrieval',
      evaluatorKind: 'assertion',
      implementationId: 'retrieval/v1',
      metricIds,
      inputs: [
        { bindingId: 'ranking', sourceKind: 'output', pointer: '/documents' },
        { bindingId: 'gold', sourceKind: 'expected', pointer: '/relevantDocumentIds' },
      ],
    }];
    definition.metrics = metricIds.map((metricId) => ({
      metricId,
      valueType: 'numeric' as const,
      scope: 'sample' as const,
      scale: { min: 0, max: 1 },
      direction: 'higher-is-better' as const,
      missingPolicyId: 'exclude/v1',
    }));
    definition.analysisGraph.nodes = metricIds.map((metricId) => ({
      analysisNodeKind: 'reducer' as const,
      nodeId: `mean-${metricId}`,
      implementationId: 'descriptive.mean/v1',
      inputs: [{ inputKind: 'metric-observations' as const, referenceId: metricId }],
      outputResultId: `${metricId}-mean`,
    }));
    definition.comparisons[0].metricIds = metricIds;
    definition.decisionPolicy = {
      decisionPolicyId: 'retrieval-gate',
      implementationId: 'progress/v1',
      analysisResultIds: ['ndcg-mean'],
      minimumEvidenceStatus: 'complete',
      parameters: { threshold: 0.4 },
    };
  } else if (target === 'agent') {
    definition.evaluators = [
      {
        evaluatorId: 'trajectory',
        evaluatorKind: 'assertion',
        implementationId: 'trajectory/v1',
        metricIds: ['trajectory-valid'],
        inputs: [
          { bindingId: 'answer', sourceKind: 'output', pointer: '/messages' },
          { bindingId: 'tool-calls', sourceKind: 'trace', pointer: '/toolCalls' },
          { bindingId: 'gold', sourceKind: 'expected', pointer: '/requiredTools' },
        ],
      },
      {
        evaluatorId: 'answer-shape',
        evaluatorKind: 'assertion',
        implementationId: 'answer-shape/v1',
        metricIds: ['answer-present'],
        inputs: [
          { bindingId: 'answer', sourceKind: 'output', pointer: '/messages' },
        ],
      },
    ];
    definition.metrics = ['trajectory-valid', 'answer-present'].map((metricId) => ({
      metricId,
      valueType: 'boolean' as const,
      scope: 'sample' as const,
      direction: 'higher-is-better' as const,
      missingPolicyId: 'exclude/v1',
    }));
    definition.analysisGraph.nodes = [{
      analysisNodeKind: 'reducer',
      nodeId: 'trajectory-rate',
      implementationId: 'descriptive.rate/v1',
      inputs: [{ inputKind: 'metric-observations', referenceId: 'trajectory-valid' }],
      outputResultId: 'trajectory-rate',
    }];
    definition.comparisons[0].metricIds = ['trajectory-valid', 'answer-present'];
    definition.decisionPolicy = {
      decisionPolicyId: 'trajectory-gate',
      implementationId: 'progress/v1',
      analysisResultIds: ['trajectory-rate'],
      minimumEvidenceStatus: 'complete',
      parameters: { threshold: 0.4 },
    };
  } else {
    definition.analysisGraph.nodes[0].parameters = {};
    definition.decisionPolicy = {
      ...definition.decisionPolicy!,
      parameters: { threshold: 0.4 },
    };
  }
  return definition;
}

function scenarioPolicy(target: ConformanceTarget): MeasurementPolicy {
  const policy = validPolicy();
  delete policy.execution.timeoutMs;
  delete policy.evaluation.timeoutMs;
  policy.retry.maxAttempts = 1;
  policy.evaluation.retry.maxAttempts = 1;
  policy.evidence.input = 'full';
  policy.evidence.output = 'full';
  policy.evidence.trace = target === 'agent' ? 'full' : 'none';
  policy.evidence.expected = 'full';
  policy.evidence.evidence = 'full';
  return policy;
}

function objectValue(value: JsonValue): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('Expected an object value.');
  }
  return value;
}

function stringArray(value: JsonValue): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError('Expected a string array.');
  }
  return value as string[];
}

function executorOutput(
  target: ConformanceTarget,
  context: ExecutorTrialContext,
): ExecutorAttemptResult {
  const input = objectValue(context.input);
  if (target === 'function') {
    const answer = String(input.answerHint);
    return {
      output: {
        value: { answer: context.targetId === 'control' ? answer : `${answer}-variant` },
        classification: 'public' as const,
      },
    };
  }
  if (target === 'rag') {
    const first = input.query === 'evaluation core'
      ? ['doc-a', 'doc-x', 'doc-c']
      : ['doc-b', 'doc-y', 'doc-z'];
    const documents = context.targetId === 'control'
      ? first
      : [...first].reverse();
    return {
      output: {
        value: { documents },
        classification: 'public' as const,
      },
    };
  }
  const completeToolCalls = input.request === 'research evaluation core'
    ? ['search', 'read']
    : ['search'];
  const toolCalls = context.targetId === 'control'
    ? completeToolCalls
    : completeToolCalls.slice(0, 1);
  return {
    output: {
      value: { messages: [{ role: 'assistant', content: 'done' }] },
      classification: 'public' as const,
    },
    trace: {
      value: {
        messages: [{ role: 'assistant', content: 'working' }],
        toolCalls: toolCalls.map((name) => ({ name, status: 'completed' })),
      },
      classification: 'sensitive' as const,
    },
  };
}

interface ConformanceRunBinding {
  state: ConformanceState;
  faults?: ConformanceFaultInjector;
}

type ConformanceRunBindingResolver = (runId: string) => ConformanceRunBinding;

function makeExecutor(
  target: ConformanceTarget,
  plan: SealedRunPlan,
  resolveRun: ConformanceRunBindingResolver,
): ExecutionExecutor {
  return {
    identity: runtimeIdentity(plan, 'executor', 'control'),
    async openRun(context) {
      const { state, faults } = resolveRun(context.runId);
      await faults?.hit('executor-open-run');
      state.executorRunOpens += 1;
      return {
        async openTrial(context) {
          await faults?.hit('executor-open-trial');
          state.trialOpens += 1;
          state.trialContexts.push(structuredClone(context) as ExecutorTrialContext);
          return {
            async execute() {
              await faults?.hit('executor-execute');
              state.executorAttempts += 1;
              return executorOutput(target, context);
            },
            async dispose() {
              state.trialDisposals += 1;
              await faults?.hit('executor-dispose-trial');
            },
          };
        },
        async dispose() {
          state.executorRunDisposals += 1;
          await faults?.hit('executor-dispose-run');
        },
      };
    },
  };
}

function binding(context: EvaluatorRecordContext, bindingId: string): JsonValue {
  const value = context.bindings.find((entry) => entry.bindingId === bindingId)?.value;
  if (value === undefined) throw new Error(`Missing evaluator binding ${bindingId}.`);
  return value;
}

function ragMetrics(ranking: string[], gold: string[]) {
  const relevant = new Set(gold);
  const hits = ranking.filter((documentId) => relevant.has(documentId));
  const firstRelevant = ranking.findIndex((documentId) => relevant.has(documentId));
  const dcg = ranking.reduce((sum, documentId, index) => (
    sum + (relevant.has(documentId) ? 1 / Math.log2(index + 2) : 0)
  ), 0);
  const idealHits = Math.min(relevant.size, ranking.length);
  const idcg = Array.from({ length: idealHits }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0);
  return {
    'recall-at-k': relevant.size === 0 ? 1 : hits.length / relevant.size,
    'precision-at-k': ranking.length === 0 ? 0 : hits.length / ranking.length,
    mrr: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    ndcg: idcg === 0 ? 1 : dcg / idcg,
  };
}

function makeEvaluator(
  target: ConformanceTarget,
  plan: SealedRunPlan,
  resolveRun: ConformanceRunBindingResolver,
): EvaluationEvaluator {
  const referenceId = target === 'function'
    ? 'exact'
    : target === 'rag'
      ? 'retrieval'
      : 'trajectory';
  return {
    identity: runtimeIdentity(plan, 'evaluator', referenceId),
    async openRun(context) {
      const { state, faults } = resolveRun(context.runId);
      await faults?.hit('evaluator-open-run');
      state.evaluatorRunOpens += 1;
      return {
        async openRecord(context) {
          await faults?.hit('evaluator-open-record');
          state.recordOpens += 1;
          state.recordContexts.push(structuredClone(context) as EvaluatorRecordContext);
          return {
            async evaluate() {
              await faults?.hit('evaluator-evaluate');
              state.evaluatorAttempts += 1;
              if (target === 'function') {
                return {
                  observations: [{
                    metricId: 'correct',
                    observationStatus: 'observed' as const,
                    valueType: 'boolean' as const,
                    value: binding(context, 'actual') === binding(context, 'gold'),
                  }],
                };
              }
              if (target === 'rag') {
                const values = ragMetrics(
                  stringArray(binding(context, 'ranking')),
                  stringArray(binding(context, 'gold')),
                );
                return {
                  observations: Object.entries(values).map(([metricId, value]) => ({
                    metricId,
                    observationStatus: 'observed' as const,
                    valueType: 'numeric' as const,
                    value,
                    evidence: {
                      value: { calculation: metricId },
                      classification: 'public' as const,
                    },
                  })),
                };
              }
              const calls = binding(context, 'tool-calls');
              if (!Array.isArray(calls)) throw new TypeError('Expected tool calls.');
              const calledNames = new Set(calls.map((entry) => {
                const call = objectValue(entry);
                return String(call.name);
              }));
              const required = stringArray(binding(context, 'gold'));
              return {
                observations: [{
                  metricId: 'trajectory-valid',
                  observationStatus: 'observed' as const,
                  valueType: 'boolean' as const,
                  value: required.every((name) => calledNames.has(name)),
                }],
              };
            },
            async dispose() {
              state.recordDisposals += 1;
              await faults?.hit('evaluator-dispose-record');
            },
          };
        },
        async dispose() {
          state.evaluatorRunDisposals += 1;
          await faults?.hit('evaluator-dispose-run');
        },
      };
    },
  };
}

function makeOutputOnlyAgentEvaluator(
  plan: SealedRunPlan,
  resolveRun: ConformanceRunBindingResolver,
): EvaluationEvaluator {
  return {
    identity: runtimeIdentity(plan, 'evaluator', 'answer-shape'),
    async openRun(context) {
      const { state, faults } = resolveRun(context.runId);
      await faults?.hit('evaluator-open-run');
      state.evaluatorRunOpens += 1;
      return {
        async openRecord(context) {
          await faults?.hit('evaluator-open-record');
          state.recordOpens += 1;
          state.recordContexts.push(structuredClone(context) as EvaluatorRecordContext);
          return {
            async evaluate() {
              await faults?.hit('evaluator-evaluate');
              state.evaluatorAttempts += 1;
              const answer = binding(context, 'answer');
              return {
                observations: [{
                  metricId: 'answer-present',
                  observationStatus: 'observed' as const,
                  valueType: 'boolean' as const,
                  value: Array.isArray(answer) && answer.length > 0,
                }],
              };
            },
            async dispose() {
              state.recordDisposals += 1;
              await faults?.hit('evaluator-dispose-record');
            },
          };
        },
        async dispose() {
          state.evaluatorRunDisposals += 1;
          await faults?.hit('evaluator-dispose-run');
        },
      };
    },
  };
}

async function collectEvents(
  events: AsyncIterable<EvaluationEvent>,
  consume?: (event: EvaluationEvent) => void | Promise<void>,
): Promise<EvaluationEvent[]> {
  const values: EvaluationEvent[] = [];
  for await (const event of events) {
    await consume?.(event);
    values.push(event);
  }
  return values;
}

async function settle<T>(
  run: { events: AsyncIterable<EvaluationEvent>; result: Promise<T> },
  consume?: (event: EvaluationEvent) => void | Promise<void>,
  consumption: 'live' | 'after-result' = 'live',
): Promise<{ value: T; events: EvaluationEvent[] }> {
  if (consumption === 'after-result') {
    const value = await run.result;
    return { value, events: await collectEvents(run.events, consume) };
  }
  const events = collectEvents(run.events, consume);
  const value = await run.result;
  return { value, events: await events };
}

function emptyState(): ConformanceState {
  return {
    executorRunOpens: 0,
    executorRunDisposals: 0,
    trialOpens: 0,
    trialDisposals: 0,
    executorAttempts: 0,
    evaluatorRunOpens: 0,
    evaluatorRunDisposals: 0,
    recordOpens: 0,
    recordDisposals: 0,
    evaluatorAttempts: 0,
    trialContexts: [],
    recordContexts: [],
    writtenEvents: [],
  };
}

function makeEvaluatorRegistry(
  target: ConformanceTarget,
  plan: SealedRunPlan,
  resolveRun: ConformanceRunBindingResolver,
): Map<string, EvaluationEvaluator> {
  const evaluatorId = target === 'function'
    ? 'exact/v1'
    : target === 'rag'
      ? 'retrieval/v1'
      : 'trajectory/v1';
  const evaluators = new Map([[evaluatorId, makeEvaluator(target, plan, resolveRun)]]);
  if (target === 'agent') {
    evaluators.set('answer-shape/v1', makeOutputOnlyAgentEvaluator(plan, resolveRun));
  }
  return evaluators;
}

export class ConformanceRuntimeRegistry {
  readonly target: ConformanceTarget;
  readonly planDigest: string;
  readonly executors: ReadonlyMap<string, ExecutionExecutor>;
  readonly evaluators: ReadonlyMap<string, EvaluationEvaluator>;
  readonly eventSequencer = new InMemoryRuntimeEventSequencer();
  readonly executionCache = new InMemoryConformanceExecutionCache();
  readonly evaluationCache = new InMemoryConformanceEvaluationCache();
  readonly artifactStore = new InMemoryConformanceArtifactStore();
  readonly analysisNodes = createBuiltinAnalysisNodes();
  readonly decisionPolicies = createBuiltinDecisionPolicies();
  readonly eventWriter = {
    write: async (event: Readonly<EvaluationEvent>) => {
      const { state, faults } = this.#resolveRun(event.runId);
      state.writtenEvents.push(structuredClone(event) as EvaluationEvent);
      await faults?.hit('event-write');
    },
  };

  readonly #runs = new Map<string, ConformanceRunBinding>();

  constructor(target: ConformanceTarget, plan: SealedRunPlan) {
    this.target = target;
    this.planDigest = plan.digests.runContractDigest;
    const resolveRun = (runId: string) => this.#resolveRun(runId);
    this.executors = new Map([[
      'executor-alias',
      makeExecutor(target, plan, resolveRun),
    ]]);
    this.evaluators = makeEvaluatorRegistry(target, plan, resolveRun);
  }

  attach(
    target: ConformanceTarget,
    plan: SealedRunPlan,
    runId: string,
    binding: ConformanceRunBinding,
  ): () => void {
    if (target !== this.target || plan.digests.runContractDigest !== this.planDigest) {
      throw new TypeError('Conformance Runtime registry does not match the sealed RunPlan.');
    }
    if (this.#runs.has(runId)) {
      throw new TypeError(`Conformance Runtime registry already owns run ${runId}.`);
    }
    this.#runs.set(runId, binding);
    return () => { this.#runs.delete(runId); };
  }

  #resolveRun(runId: string): ConformanceRunBinding {
    const binding = this.#runs.get(runId);
    if (binding === undefined) throw new Error(`Conformance run ${runId} is not attached.`);
    return binding;
  }
}

export async function prepareConformancePlan(
  target: ConformanceTarget,
  mutate?: (definition: EvaluationDefinition, policy: MeasurementPolicy) => void,
  executorFingerprint?: string,
  faults?: ConformanceFaultInjector,
): Promise<SealedRunPlan> {
  const definition = scenarioDefinition(target);
  const policy = scenarioPolicy(target);
  mutate?.(definition, policy);
  return prepareEvaluationPlan(
    definition,
    policy,
    analysisAwareRuntime(target, executorFingerprint, faults),
  );
}

function faultableAnalysisNodes(
  faults?: ConformanceFaultInjector,
): ReadonlyMap<string, AnalysisNodeImplementation> {
  if (faults === undefined) return createBuiltinAnalysisNodes();
  return new Map([...createBuiltinAnalysisNodes()].map(([implementationId, node]) => [
    implementationId,
    {
      identity: node.identity,
      outputSchema: node.outputSchema,
      async openRun(context) {
        await faults.hit('analysis-open-run');
        const run = await node.openRun(context);
        return {
          async execute(executionContext) {
            await faults.hit('analysis-execute');
            return run.execute(executionContext);
          },
          async dispose() {
            await faults.hit('analysis-dispose-run');
            await run.dispose();
          },
        };
      },
    } satisfies AnalysisNodeImplementation,
  ]));
}

function faultableDecisionPolicies(
  faults?: ConformanceFaultInjector,
): ReadonlyMap<string, AnalysisDecisionPolicy> {
  if (faults === undefined) return createBuiltinDecisionPolicies();
  return new Map([...createBuiltinDecisionPolicies()].map(([implementationId, policy]) => [
    implementationId,
    {
      identity: policy.identity,
      async decide(context) {
        await faults.hit('decision-decide');
        return policy.decide(context);
      },
    } satisfies AnalysisDecisionPolicy,
  ]));
}

export async function runConformanceScenario(
  target: ConformanceTarget,
  options: ConformanceHarnessOptions = {},
): Promise<ConformanceResult> {
  const suffix = options.suffix ?? target;
  if (options.plan !== undefined && options.mutate !== undefined) {
    throw new TypeError('A prepared Conformance plan cannot also be mutated.');
  }
  if (options.execution !== undefined && options.executionSource !== undefined) {
    throw new TypeError('Conformance execution artifact and verified source are mutually exclusive.');
  }
  const plan = options.plan ?? await prepareConformancePlan(
    target,
    options.mutate,
    undefined,
    options.faults,
  );
  const state = emptyState();
  const clock = new DeterministicClock();
  const runId = options.runId ?? `conformance-${target}`;
  const localBinding = () => ({ state, faults: options.faults });
  const registry = options.runtimeRegistry;
  const detach = registry?.attach(target, plan, runId, {
    state,
    ...(options.faults === undefined ? {} : { faults: options.faults }),
  });
  const executors = registry?.executors
    ?? new Map([['executor-alias', makeExecutor(target, plan, localBinding)]]);
  const evaluators = registry?.evaluators
    ?? makeEvaluatorRegistry(target, plan, localBinding);
  const eventSequencer = registry?.eventSequencer ?? new InMemoryRuntimeEventSequencer();
  const eventWriter = registry?.eventWriter ?? (options.faults === undefined
    ? undefined
    : {
      write: async (event: Readonly<EvaluationEvent>) => {
        state.writtenEvents.push(structuredClone(event) as EvaluationEvent);
        await options.faults?.hit('event-write');
      },
    });
  const needsArtifactStore = plan.measurementPolicy.evidence.output === 'reference'
    || plan.measurementPolicy.evidence.trace === 'reference'
    || plan.measurementPolicy.evidence.evidence === 'reference';
  const artifactStore = options.artifactStore ?? registry?.artifactStore
    ?? (needsArtifactStore ? new InMemoryConformanceArtifactStore(options.faults) : undefined);
  const executionCache = options.executionCache ?? registry?.executionCache;
  const evaluationCache = options.evaluationCache ?? registry?.evaluationCache;
  const analysisPorts: AnalysisRuntimePorts = {
    analysisNodes: registry?.analysisNodes ?? faultableAnalysisNodes(options.faults),
    schemaValidators: createBuiltinAnalysisSchemaValidators(),
    missingPolicies: createBuiltinMissingPolicies(),
    decisionPolicies: registry?.decisionPolicies ?? faultableDecisionPolicies(options.faults),
    clock,
    eventSequencer,
    ...(eventWriter === undefined ? {} : { eventWriter }),
  };
  const allEvents: EvaluationEvent[] = [];

  try {
    const executionRuntime = options.execution === undefined
        && options.executionSource === undefined
      ? startExecution(plan, {
        executors,
        clock,
        eventSequencer,
        ...(eventWriter === undefined ? {} : { eventWriter }),
        ...(artifactStore === undefined ? {} : { contentStore: artifactStore }),
        ...(executionCache === undefined ? {} : { cache: executionCache }),
      }, {
        runId,
        bundleId: `execution-${suffix}`,
        eventBufferCapacity: 1,
        ...(options.executionSignal === undefined ? {} : { signal: options.executionSignal }),
      })
      : undefined;
    const executionRun = executionRuntime !== undefined
      ? await settle(
        { events: executionRuntime.events, result: executionRuntime.source },
        options.consumeEvent,
        options.eventConsumption,
      )
      : {
        value: options.executionSource
          ?? parseExecutionBundle(options.execution, plan),
        events: [],
      };
    allEvents.push(...executionRun.events);

    const evaluationRuntime = startEvaluation(plan, executionRun.value, {
      evaluators,
      clock,
      eventSequencer,
      ...(eventWriter === undefined ? {} : { eventWriter }),
      ...(artifactStore === undefined || options.provideContentResolver === false
        ? {}
        : { contentResolver: artifactStore }),
      ...(artifactStore === undefined ? {} : { contentStore: artifactStore }),
      ...(evaluationCache === undefined ? {} : { cache: evaluationCache }),
    }, {
      runId,
      bundleId: `evaluation-${suffix}`,
      eventBufferCapacity: 1,
      ...(options.evaluationSignal === undefined ? {} : { signal: options.evaluationSignal }),
    });
    const evaluationRun = await settle(
      { events: evaluationRuntime.events, result: evaluationRuntime.source },
      options.consumeEvent,
      options.eventConsumption,
    );
    allEvents.push(...evaluationRun.events);

    const analysisRuntime = startAnalysis(
      plan,
      executionRun.value,
      evaluationRun.value,
      analysisPorts,
      {
        runId,
        bundleId: `analysis-${suffix}`,
        eventBufferCapacity: 1,
      },
    );
    const analysisRun = await settle(
      { events: analysisRuntime.events, result: analysisRuntime.source },
      options.consumeEvent,
      options.eventConsumption,
    );
    allEvents.push(...analysisRun.events);

    const decisionRuntime = startDecision(
      plan,
      executionRun.value,
      evaluationRun.value,
      analysisRun.value,
      analysisPorts,
      { runId, eventBufferCapacity: 1 },
    );
    const decisionRun = await settle(
      { events: decisionRuntime.events, result: decisionRuntime.source },
      options.consumeEvent,
      options.eventConsumption,
    );
    allEvents.push(...decisionRun.events);

    const reportRun = await settle(startReportMaterialization(
      plan,
      executionRun.value,
      evaluationRun.value,
      analysisRun.value,
      decisionRun.value,
      analysisPorts,
      {
        runId,
        reportId: `report-${suffix}`,
        eventBufferCapacity: 1,
      },
    ), options.consumeEvent, options.eventConsumption);
    allEvents.push(...reportRun.events);

    return {
      plan,
      execution: executionRun.value.bundle,
      executionSource: executionRun.value,
      evaluation: evaluationRun.value.bundle,
      evaluationSource: evaluationRun.value,
      analysis: analysisRun.value.bundle,
      analysisSource: analysisRun.value,
      decision: decisionRun.value?.result,
      decisionSource: decisionRun.value,
      report: reportRun.value,
      events: allEvents,
      state,
    };
  } finally {
    detach?.();
  }
}
