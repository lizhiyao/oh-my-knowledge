import {
  EVALUATION_EVENT_SCHEMA_VERSION,
  EXECUTION_BUNDLE_SCHEMA_VERSION,
  CompletedExecutionRecordSchema,
  ContentClassificationSchema,
  ContentDescriptorSchema,
  EvaluationErrorSchema,
  EvaluationEventSchema,
  IdentifierSchema,
  UsageRecordSchema,
  canonicalizeJson,
  deriveAttemptId,
  digestArtifactPayload,
  digestCanonicalJson,
  parseExecutionBundle,
  parseWireDocument,
  type CacheProvenance,
  type CapturedContent,
  type EvaluationError,
  type EvaluationEvent,
  type ExecutionAttempt,
  type ExecutionBundle,
  type ExecutionRecord,
  type JsonValue,
  type PlannedExecutionCoordinate,
  type RuntimeIdentity,
  type Sha256Digest,
  type UsageRecord,
} from '../contracts/index.js';
import {
  ExecutorCapabilitiesSchema,
  type ProtocolManifest,
  type SealedRunPlan,
} from '../compiler/index.js';
import { deepFreeze, snapshotJson } from '../compiler/immutability.js';
import { BoundedEventStream } from './event-stream.js';
import { abortError, Semaphore } from './semaphore.js';
import { deriveExecutionSchedule, type ExecutionSchedulingBlock } from './scheduler.js';
import {
  ExecutionPortFailure,
  ExecutionRuntimeConfigurationError,
  type ExecutionCacheEntry,
  type ExecutionClock,
  type ExecutionContent,
  type ExecutionEventKind,
  type ExecutionEventSubjectKind,
  type ExecutionExecutor,
  type ExecutionExecutorRun,
  type ExecutionExecutorTrial,
  type ExecutionRun,
  type ExecutionRunOptions,
  type ExecutionRuntimePorts,
  type ExecutorAttemptResult,
  type ExecutorTrialContext,
} from './types.js';

type ActiveExecutionRecord = Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>;
type CompletedExecutionRecord = Extract<ExecutionRecord, { executionStatus: 'completed' }>;

interface TargetRuntimeBinding {
  target: SealedRunPlan['execution']['targets'][number];
  executor: ExecutionExecutor;
  runtime: RuntimeIdentity;
  protocol: ProtocolManifest;
  semaphore: Semaphore;
}

interface PreparedRuntime {
  bindings: ReadonlyMap<string, TargetRuntimeBinding>;
  globalSemaphore: Semaphore;
}

type StopKind = 'cancelled' | 'budget-exhausted' | 'failed';

interface StopState {
  stopKind?: StopKind;
  reason?: string;
  error?: EvaluationError;
}

interface PreparedCoordinate {
  coordinate: PlannedExecutionCoordinate;
  cached?: CompletedExecutionRecord;
  reservedInvocation: boolean;
}

interface PreparedBlock {
  block: ExecutionSchedulingBlock;
  coordinates: PreparedCoordinate[];
}

interface CoordinateResult {
  record?: ActiveExecutionRecord;
  cacheEntry?: ExecutionCacheEntry;
  failed: boolean;
}

interface InFlightAttempt {
  attemptId: Sha256Digest;
  attemptNumber: number;
  startedAt: string;
  startedMonotonic: number;
}

const CLASSIFICATION_LEVEL = {
  public: 0,
  sensitive: 1,
  secret: 2,
  gold: 3,
} as const;

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRecords(left: ExecutionRecord, right: ExecutionRecord): number {
  return compareStrings(left.targetId, right.targetId)
    || compareStrings(left.sampleId, right.sampleId)
    || left.trialIndex - right.trialIndex;
}

function coordinateKey(coordinate: { trialId: string }): string {
  return coordinate.trialId;
}

function configurationError(code: string, message: string): never {
  throw new ExecutionRuntimeConfigurationError(code, message);
}

function validateOptions(options: ExecutionRunOptions): void {
  const runId = IdentifierSchema.safeParse(options.runId);
  const bundleId = IdentifierSchema.safeParse(options.bundleId);
  if (!runId.success || !bundleId.success) {
    configurationError(
      'EXECUTION_RUNTIME_IDENTIFIER_INVALID',
      'runId and bundleId must be valid Evaluation Core identifiers.',
    );
  }
  if (options.eventBufferCapacity !== undefined
      && (!Number.isSafeInteger(options.eventBufferCapacity)
        || options.eventBufferCapacity < 1)) {
    configurationError(
      'EXECUTION_RUNTIME_EVENT_BUFFER_INVALID',
      'eventBufferCapacity must be a positive safe integer.',
    );
  }
}

function resolvedRuntimeByTarget(plan: SealedRunPlan): Map<string, RuntimeIdentity> {
  const result = new Map<string, RuntimeIdentity>();
  for (const runtime of plan.execution.runtimes) {
    if (runtime.runtimeKind !== 'executor') continue;
    if (result.has(runtime.referenceId)) {
      configurationError(
        'EXECUTION_RUNTIME_BINDING_INVALID',
        `ExecutionPlan contains duplicate Runtime binding for ${runtime.referenceId}.`,
      );
    }
    result.set(runtime.referenceId, runtime.identity as RuntimeIdentity);
  }
  return result;
}

function protocolForTarget(
  targetId: string,
  protocolId: string,
  runtime: RuntimeIdentity,
): ProtocolManifest {
  const capabilities = ExecutorCapabilitiesSchema.safeParse(runtime.capabilities);
  if (!capabilities.success) {
    configurationError(
      'EXECUTION_RUNTIME_CAPABILITY_INVALID',
      `Sealed Runtime capabilities for ${targetId} are invalid.`,
    );
  }
  const protocol = capabilities.data.protocols.find(
    (candidate) => candidate.protocolId === protocolId,
  );
  if (protocol === undefined) {
    configurationError(
      'EXECUTION_RUNTIME_CAPABILITY_INVALID',
      `Sealed Runtime for ${targetId} does not contain its protocol manifest.`,
    );
  }
  return protocol;
}

function prepareRuntime(
  plan: SealedRunPlan,
  ports: ExecutionRuntimePorts,
  options: ExecutionRunOptions,
): PreparedRuntime {
  validateOptions(options);
  const cacheMode = plan.execution.policy.executionCacheMode;
  if (cacheMode !== 'disabled' && ports.cache === undefined) {
    configurationError(
      'EXECUTION_RUNTIME_CACHE_REQUIRED',
      `Execution cache mode ${cacheMode} requires an injected cache port.`,
    );
  }
  const evidence = plan.measurementPolicy.evidence;
  if ((evidence.output === 'reference' || evidence.trace === 'reference')
      && ports.contentStore === undefined) {
    configurationError(
      'EXECUTION_RUNTIME_CONTENT_STORE_REQUIRED',
      'Reference evidence capture requires an injected ContentStore.',
    );
  }
  const delivery = plan.measurementPolicy.eventDelivery;
  if (delivery.writerMode === 'required' && ports.eventWriter === undefined) {
    configurationError(
      'EXECUTION_RUNTIME_EVENT_WRITER_REQUIRED',
      'Required EventWriter mode needs an injected EventWriter.',
    );
  }

  const expectedRuntimes = resolvedRuntimeByTarget(plan);
  const executorLimits = new Map<string, number>();
  const partialBindings: Array<{
    target: SealedRunPlan['execution']['targets'][number];
    executor: ExecutionExecutor;
    runtime: RuntimeIdentity;
    protocol: ProtocolManifest;
  }> = [];
  for (const target of plan.execution.targets) {
    const executor = ports.executors.get(target.executorId);
    if (executor === undefined) {
      configurationError(
        'EXECUTION_RUNTIME_EXECUTOR_MISSING',
        `No Executor is registered for ${target.executorId}.`,
      );
    }
    const expectedRuntime = expectedRuntimes.get(target.targetId);
    if (expectedRuntime === undefined
        || canonicalizeJson(executor.identity) !== canonicalizeJson(expectedRuntime)) {
      configurationError(
        'EXECUTION_RUNTIME_IDENTITY_MISMATCH',
        `Executor identity for ${target.targetId} differs from the sealed ExecutionPlan.`,
      );
    }
    const protocol = protocolForTarget(target.targetId, target.protocolId, expectedRuntime);
    const capabilityLimit = protocol.execution.concurrency.safety === 'serialized'
      ? 1
      : (protocol.execution.concurrency.maxInFlight
        ?? plan.execution.policy.execution.maxConcurrency);
    const currentLimit = executorLimits.get(target.executorId);
    executorLimits.set(
      target.executorId,
      currentLimit === undefined ? capabilityLimit : Math.min(currentLimit, capabilityLimit),
    );
    partialBindings.push({ target, executor, runtime: expectedRuntime, protocol });
  }
  const semaphores = new Map(
    [...executorLimits].map(([executorId, limit]) => [executorId, new Semaphore(limit)]),
  );
  return {
    bindings: new Map(partialBindings.map((binding) => [binding.target.targetId, {
      ...binding,
      semaphore: semaphores.get(binding.target.executorId) as Semaphore,
    }])),
    globalSemaphore: new Semaphore(plan.execution.policy.execution.maxConcurrency),
  };
}

function safeError(error: unknown): EvaluationError {
  if (error instanceof ExecutionPortFailure) {
    const parsed = EvaluationErrorSchema.safeParse(error.evaluationError);
    if (!parsed.success) {
      return {
        code: 'executor-error-invalid',
        stage: 'infrastructure',
        message: 'Executor returned an invalid structured failure.',
      };
    }
    return {
      code: parsed.data.code,
      stage: parsed.data.stage,
      message: 'Executor reported a structured failure.',
    };
  }
  return {
    code: error instanceof Error && error.name === 'AbortError'
      ? 'cancelled'
      : 'executor-error',
    stage: error instanceof Error && error.name === 'AbortError'
      ? 'infrastructure'
      : 'execution',
    message: error instanceof Error && error.name === 'AbortError'
      ? 'Execution was cancelled.'
      : 'Executor failed without a structured EvaluationError.',
  };
}

function durationMs(started: number, completed: number): number {
  return Math.max(0, completed - started);
}

function aggregateUsage(
  attempts: readonly (UsageRecord | undefined)[],
): UsageRecord | undefined {
  const reported = attempts.filter((usage): usage is UsageRecord => usage !== undefined);
  if (reported.length === 0) return undefined;
  if (attempts.length === 1) return snapshotJson(reported[0]);
  const costs = reported.flatMap((usage) => (
    usage.providerCost === undefined ? [] : [usage.providerCost]
  ));
  const currencies = new Set(costs.map((cost) => cost.currency));
  const providerCost = costs.length === attempts.length && currencies.size === 1
    ? {
      amount: costs.reduce((sum, cost) => sum + cost.amount, 0),
      currency: costs[0].currency,
      reportedByProvider: true as const,
    }
    : undefined;
  return {
    ...(reported.some((usage) => usage.inputTokens !== undefined)
      ? { inputTokens: reported.reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0) }
      : {}),
    ...(reported.some((usage) => usage.outputTokens !== undefined)
      ? { outputTokens: reported.reduce((sum, usage) => sum + (usage.outputTokens ?? 0), 0) }
      : {}),
    ...(reported.some((usage) => usage.totalTokens !== undefined)
      ? { totalTokens: reported.reduce((sum, usage) => sum + (usage.totalTokens ?? 0), 0) }
      : {}),
    ...(providerCost !== undefined ? { providerCost } : {}),
    details: {
      aggregationKind: 'omk.execution-usage-summary/v1',
      attemptCount: attempts.length,
      reportedAttemptCount: reported.length,
      providerCostAggregation: costs.length === 0
        ? 'unreported'
        : costs.length !== attempts.length
          ? 'partial'
          : currencies.size === 1
            ? 'summed'
            : 'mixed-currency',
    },
  };
}

class BudgetTracker {
  readonly #maxInvocations?: number;
  readonly #maxProviderCost?: { amount: number; currency: string };
  #invocations = 0;
  #reserved = 0;
  #providerCost = 0;

  constructor(plan: SealedRunPlan) {
    this.#maxInvocations = plan.execution.policy.budget.maxTargetInvocations;
    this.#maxProviderCost = plan.execution.policy.budget.maxProviderCost;
  }

  reserveInitial(count: number): boolean {
    if (this.#maxInvocations !== undefined
        && this.#invocations + this.#reserved + count > this.#maxInvocations) return false;
    this.#reserved += count;
    return true;
  }

  consumeReserved(): void {
    if (this.#reserved < 1) throw new Error('Missing invocation reservation');
    this.#reserved -= 1;
    this.#invocations += 1;
  }

  releaseReserved(): void {
    if (this.#reserved > 0) this.#reserved -= 1;
  }

  recordUsage(usage: UsageRecord | undefined): EvaluationError | undefined {
    if (this.#maxProviderCost === undefined) return undefined;
    const cost = usage?.providerCost;
    if (cost === undefined) {
      return {
        code: 'provider-cost-unreported',
        stage: 'infrastructure',
        message: 'Provider cost budget requires every invocation to report provider cost.',
      };
    }
    if (cost.currency !== this.#maxProviderCost.currency) {
      return {
        code: 'provider-cost-currency-mismatch',
        stage: 'infrastructure',
        message: 'Provider-reported cost currency differs from the sealed budget currency.',
      };
    }
    this.#providerCost += cost.amount;
    return undefined;
  }

  get providerCostExhausted(): boolean {
    return this.#maxProviderCost !== undefined
      && this.#providerCost >= this.#maxProviderCost.amount;
  }
}

class RunSessions {
  readonly #options: ExecutionRunOptions;
  readonly #plan: SealedRunPlan;
  readonly #sessions = new Map<string, Promise<ExecutionExecutorRun>>();

  constructor(
    plan: SealedRunPlan,
    options: ExecutionRunOptions,
  ) {
    this.#plan = plan;
    this.#options = options;
  }

  get(executorId: string, executor: ExecutionExecutor): Promise<ExecutionExecutorRun> {
    const current = this.#sessions.get(executorId);
    if (current !== undefined) return current;
    const context = deepFreeze(snapshotJson({
      runId: this.#options.runId,
      executionPlanDigest: this.#plan.execution.executionPlanDigest as Sha256Digest,
    }));
    const session = Promise.resolve(executor.openRun(context));
    this.#sessions.set(executorId, session);
    return session;
  }

  async dispose(): Promise<EvaluationError[]> {
    const errors: EvaluationError[] = [];
    for (const sessionPromise of this.#sessions.values()) {
      try {
        const session = await sessionPromise;
        await session.dispose();
      } catch {
        errors.push({
          code: 'executor-run-dispose-failed',
          stage: 'infrastructure',
          message: 'Executor run resource disposal failed.',
        });
      }
    }
    return errors;
  }
}

class EventEmitter {
  readonly #plan: SealedRunPlan;
  readonly #ports: ExecutionRuntimePorts;
  readonly #options: ExecutionRunOptions;
  readonly #stream: BoundedEventStream;
  readonly #onFatal: (reason: string, error: EvaluationError) => void;
  #sequence = 0;
  #writerEnabled: boolean;
  #deliveryTail: Promise<void> = Promise.resolve();

  constructor(
    plan: SealedRunPlan,
    ports: ExecutionRuntimePorts,
    options: ExecutionRunOptions,
    stream: BoundedEventStream,
    onFatal: (reason: string, error: EvaluationError) => void,
  ) {
    this.#plan = plan;
    this.#ports = ports;
    this.#options = options;
    this.#stream = stream;
    this.#onFatal = onFatal;
    this.#writerEnabled = plan.measurementPolicy.eventDelivery.writerMode !== 'disabled'
      && ports.eventWriter !== undefined;
  }

  async emit(
    eventKind: ExecutionEventKind,
    subjectKind: ExecutionEventSubjectKind,
    subjectId: string,
    data: JsonValue,
  ): Promise<boolean> {
    const sequence = this.#sequence;
    this.#sequence += 1;
    const event = deepFreeze(parseWireDocument(EvaluationEventSchema, {
      schemaVersion: EVALUATION_EVENT_SCHEMA_VERSION,
      eventId: digestCanonicalJson({
        derivation: 'omk.evaluation-event-id/v1',
        runId: this.#options.runId,
        sequence,
      }),
      sequence,
      runId: this.#options.runId,
      eventKind,
      time: this.#ports.clock.timestamp(),
      subject: { subjectKind, subjectId },
      data,
    }));
    const delivery = this.#deliveryTail.then(() => this.#deliver(event));
    this.#deliveryTail = delivery.then(() => undefined, () => undefined);
    return delivery;
  }

  async #deliver(event: EvaluationEvent): Promise<boolean> {
    if (this.#writerEnabled) {
      try {
        await this.#ports.eventWriter?.write(event);
      } catch {
        this.#writerEnabled = false;
        if (this.#plan.measurementPolicy.eventDelivery.writerFailureMode === 'fail-run') {
          this.#onFatal('event-writer-failed', {
            code: 'event-writer-failed',
            stage: 'infrastructure',
            message: 'Required EventWriter delivery failed.',
          });
          return false;
        }
      }
    }
    this.#stream.push(event);
    return true;
  }

  close(): void {
    this.#stream.close();
  }
}

function linkAbortSignal(parent: AbortSignal | undefined, controller: AbortController): () => void {
  if (parent === undefined) return () => undefined;
  if (parent.aborted) {
    controller.abort(parent.reason);
    return () => undefined;
  }
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return () => parent.removeEventListener('abort', onAbort);
}

async function executeWithTimeout(
  trial: ExecutionExecutorTrial,
  attemptId: Sha256Digest,
  attemptNumber: number,
  parentSignal: AbortSignal,
  timeoutMs: number | undefined,
  clock: ExecutionClock,
): Promise<{ result?: ExecutorAttemptResult; error?: unknown; timedOut: boolean }> {
  const controller = new AbortController();
  const unlink = linkAbortSignal(parentSignal, controller);
  const timerController = new AbortController();
  let timedOut = false;
  const timer = timeoutMs === undefined
    ? undefined
    : clock.sleep(timeoutMs, timerController.signal).then(() => {
      timedOut = true;
      controller.abort('timeout');
    }).catch(() => undefined);
  try {
    const result = await trial.execute(Object.freeze({
      attemptId,
      attemptNumber,
      signal: controller.signal,
    }));
    return { result, timedOut };
  } catch (error) {
    return { error, timedOut };
  } finally {
    unlink();
    timerController.abort();
    await timer;
  }
}

function cacheKey(plan: SealedRunPlan, coordinate: PlannedExecutionCoordinate): Sha256Digest {
  return digestCanonicalJson({
    derivation: 'omk.execution-cache-key/v1',
    executionPlanDigest: plan.execution.executionPlanDigest,
    trialId: coordinate.trialId,
  });
}

function assertCachedRecord(
  entry: ExecutionCacheEntry,
  key: Sha256Digest,
  coordinate: PlannedExecutionCoordinate,
  runtime: RuntimeIdentity,
): CompletedExecutionRecord {
  const record = parseWireDocument(CompletedExecutionRecordSchema, entry.record);
  if (entry.cacheKeyDigest !== key
      || entry.sourceRecordDigest !== digestCanonicalJson(record)
      || record.targetId !== coordinate.targetId
      || record.sampleId !== coordinate.sampleId
      || record.trialIndex !== coordinate.trialIndex
      || record.trialId !== coordinate.trialId
      || record.trialSeed !== coordinate.trialSeed
      || record.schedulingBlockId !== coordinate.schedulingBlockId
      || canonicalizeJson(record.samplingUnitIds)
        !== canonicalizeJson(coordinate.samplingUnitIds)
      || canonicalizeJson(record.runtime) !== canonicalizeJson(runtime)) {
    throw new ExecutionRuntimeConfigurationError(
      'EXECUTION_RUNTIME_CACHE_ENTRY_INVALID',
      'Execution cache returned a record incompatible with the sealed coordinate.',
    );
  }
  return record;
}

function replayRecord(
  entry: ExecutionCacheEntry,
  sourceRecord: CompletedExecutionRecord,
  cacheStatus: 'replay' | 'transparent-hit',
): CompletedExecutionRecord {
  return {
    ...snapshotJson(sourceRecord),
    cache: {
      cacheStatus,
      cacheKeyDigest: entry.cacheKeyDigest,
      sourceRecordDigest: entry.sourceRecordDigest,
    },
    provenance: {
      provenanceKind: 'replay',
      trust: entry.record.provenance.trust,
      sourceId: entry.record.trialId,
      parentDigests: [entry.sourceRecordDigest],
    },
  };
}

async function captureContent(
  content: ExecutionContent | undefined,
  mode: 'full' | 'reference' | 'digest' | 'none',
  maximumClassification: keyof typeof CLASSIFICATION_LEVEL,
  ports: ExecutionRuntimePorts,
): Promise<CapturedContent | undefined> {
  if (content === undefined || mode === 'none') return undefined;
  const classification = ContentClassificationSchema.parse(content.classification);
  if (CLASSIFICATION_LEVEL[classification]
      > CLASSIFICATION_LEVEL[maximumClassification]) return undefined;
  const value = snapshotJson(content.value);
  const digest = digestCanonicalJson(value);
  if (mode === 'full') {
    return { contentKind: 'inline', classification, value };
  }
  if (mode === 'digest') {
    return { contentKind: 'digest-only', classification, digest };
  }
  const mediaType = content.mediaType ?? 'application/json';
  const descriptor = await ports.contentStore?.put({
    value,
    classification,
    mediaType,
    digest,
  });
  const parsedDescriptor = ContentDescriptorSchema.safeParse(descriptor);
  if (!parsedDescriptor.success || parsedDescriptor.data.digest !== digest) {
    throw new ExecutionRuntimeConfigurationError(
      'EXECUTION_RUNTIME_CONTENT_STORE_INVALID',
      'ContentStore returned a missing or mismatched descriptor.',
    );
  }
  return {
    contentKind: 'descriptor',
    classification,
    descriptor: snapshotJson(parsedDescriptor.data),
  };
}

function validatedUsage(usage: UsageRecord | undefined): UsageRecord | undefined {
  return usage === undefined ? undefined : parseWireDocument(UsageRecordSchema, usage);
}

function cacheProvenance(
  mode: SealedRunPlan['execution']['policy']['executionCacheMode'],
  key: Sha256Digest,
): CacheProvenance {
  return mode === 'disabled'
    ? { cacheStatus: 'not-used' }
    : { cacheStatus: 'miss', cacheKeyDigest: key };
}

function attemptError(
  outcome: Awaited<ReturnType<typeof executeWithTimeout>>,
  runSignal: AbortSignal,
): { status: 'failed' | 'cancelled'; error: EvaluationError; usage?: UsageRecord } {
  const usage = outcome.result?.usage ?? (outcome.error instanceof ExecutionPortFailure
    ? outcome.error.usage
    : undefined);
  if (outcome.timedOut) {
    return {
      status: 'failed',
      error: {
        code: 'timeout',
        stage: 'infrastructure',
        message: 'Executor attempt exceeded the sealed timeout.',
      },
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  if (runSignal.aborted) {
    return {
      status: 'cancelled',
      error: {
        code: 'cancelled',
        stage: 'infrastructure',
        message: 'Execution was cancelled.',
      },
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  return {
    status: 'failed',
    error: safeError(outcome.error),
    ...(usage !== undefined ? { usage } : {}),
  };
}

function trialContext(
  plan: SealedRunPlan,
  binding: TargetRuntimeBinding,
  coordinate: PlannedExecutionCoordinate,
): ExecutorTrialContext {
  const sample = plan.execution.samples.find(
    (candidate) => candidate.sampleId === coordinate.sampleId,
  );
  if (sample === undefined) throw new Error('Planned sample disappeared');
  const controlled = plan.execution.experiment.sampling.seedCoupling !== 'uncontrolled';
  return deepFreeze(snapshotJson({
    targetId: coordinate.targetId,
    protocolId: binding.target.protocolId,
    input: sample.input,
    ...(sample.executionContext !== undefined
      ? { executionContext: sample.executionContext }
      : {}),
    ...(binding.target.config !== undefined ? { targetConfig: binding.target.config } : {}),
    trialIndex: coordinate.trialIndex,
    trialId: coordinate.trialId,
    schedulingBlockId: coordinate.schedulingBlockId,
    samplingUnitIds: coordinate.samplingUnitIds,
    ...(controlled ? { trialSeed: coordinate.trialSeed } : {}),
  })) as ExecutorTrialContext;
}

async function executeCoordinate(
  plan: SealedRunPlan,
  ports: ExecutionRuntimePorts,
  options: ExecutionRunOptions,
  prepared: PreparedRuntime,
  sessions: RunSessions,
  events: EventEmitter,
  budget: BudgetTracker,
  coordinate: PreparedCoordinate,
  runSignal: AbortSignal,
  setStop: (kind: StopKind, reason: string, error?: EvaluationError) => void,
): Promise<CoordinateResult> {
  if (coordinate.cached !== undefined) {
    await events.emit('execution.cache.hit', 'trial', coordinate.coordinate.trialId, {
      trialId: coordinate.coordinate.trialId,
      cacheStatus: coordinate.cached.cache.cacheStatus,
    });
    return { record: coordinate.cached, failed: false };
  }
  const binding = prepared.bindings.get(coordinate.coordinate.targetId);
  if (binding === undefined) throw new Error('Target binding disappeared');
  const releaseGlobal = await prepared.globalSemaphore.acquire(runSignal).catch(() => undefined);
  if (releaseGlobal === undefined) {
    if (coordinate.reservedInvocation) budget.releaseReserved();
    return { failed: false };
  }
  const releaseRuntime = await binding.semaphore.acquire(runSignal).catch(() => undefined);
  if (releaseRuntime === undefined) {
    releaseGlobal();
    if (coordinate.reservedInvocation) budget.releaseReserved();
    return { failed: false };
  }

  const attempts: ExecutionAttempt[] = [];
  const attemptUsages: Array<UsageRecord | undefined> = [];
  let trial: ExecutionExecutorTrial | undefined;
  let inFlightAttempt: InFlightAttempt | undefined;
  const trialStartedAt = ports.clock.timestamp();
  const trialStartedMonotonic = ports.clock.monotonicNow();
  let output: CapturedContent | undefined;
  let trace: CapturedContent | undefined;
  let terminalError: EvaluationError | undefined;
  let terminalStatus: 'completed' | 'failed' | 'cancelled' = 'failed';
  let initialReservationPending = coordinate.reservedInvocation;
  let cacheEligible = true;
  const key = cacheKey(plan, coordinate.coordinate);
  try {
    const trialEventDelivered = await events.emit(
      'execution.trial.started',
      'trial',
      coordinate.coordinate.trialId,
      {
      targetId: coordinate.coordinate.targetId,
      sampleId: coordinate.coordinate.sampleId,
      trialIndex: coordinate.coordinate.trialIndex,
      schedulingBlockId: coordinate.coordinate.schedulingBlockId,
      },
    );
    if (!trialEventDelivered || runSignal.aborted) return { failed: false };
    const runSession = await sessions.get(binding.target.executorId, binding.executor);
    trial = await runSession.openTrial(trialContext(plan, binding, coordinate.coordinate));
    const retryPolicy = plan.execution.policy.retry;
    for (let attemptNumber = 1; attemptNumber <= retryPolicy.maxAttempts; attemptNumber += 1) {
      if (attemptNumber > 1) {
        if (!budget.reserveInitial(1)) {
          setStop('budget-exhausted', 'target-invocation-budget-exhausted');
          break;
        }
        initialReservationPending = true;
      }
      const attemptId = deriveAttemptId({
        trialId: coordinate.coordinate.trialId,
        attemptNumber,
      });
      const startedAt = ports.clock.timestamp();
      const startedMonotonic = ports.clock.monotonicNow();
      const attemptEventDelivered = await events.emit('execution.attempt.started', 'attempt', attemptId, {
        trialId: coordinate.coordinate.trialId,
        attemptNumber,
      });
      if (!attemptEventDelivered || runSignal.aborted) break;
      if (initialReservationPending) {
        budget.consumeReserved();
        initialReservationPending = false;
      }
      inFlightAttempt = {
        attemptId,
        attemptNumber,
        startedAt,
        startedMonotonic,
      };
      const outcome = runSignal.aborted
        ? { error: abortError(), timedOut: false }
        : await executeWithTimeout(
          trial,
          attemptId,
          attemptNumber,
          runSignal,
          plan.execution.policy.execution.timeoutMs,
          ports.clock,
        );
      const completedAt = ports.clock.timestamp();
      const completedMonotonic = ports.clock.monotonicNow();
      if (outcome.result !== undefined && !outcome.timedOut && !runSignal.aborted) {
        snapshotJson(outcome.result);
        const attemptUsage = validatedUsage(outcome.result.usage);
        attemptUsages.push(attemptUsage);
        const costError = budget.recordUsage(attemptUsage);
        if (costError !== undefined) {
          cacheEligible = false;
          setStop('failed', costError.code, costError);
        }
        attempts.push({
          attemptId,
          attemptNumber,
          attemptStatus: 'completed',
          timing: {
            startedAt,
            completedAt,
            durationMs: durationMs(startedMonotonic, completedMonotonic),
          },
          ...(attemptUsage !== undefined ? { usage: attemptUsage } : {}),
        });
        inFlightAttempt = undefined;
        terminalStatus = 'completed';
        try {
          output = await captureContent(
            outcome.result.output,
            plan.measurementPolicy.evidence.output,
            plan.measurementPolicy.evidence.maximumClassification,
            ports,
          );
          trace = await captureContent(
            outcome.result.trace,
            plan.measurementPolicy.evidence.trace,
            plan.measurementPolicy.evidence.maximumClassification,
            ports,
          );
        } catch {
          cacheEligible = false;
          setStop('failed', 'content-materialization-failed', {
            code: 'content-materialization-failed',
            stage: 'infrastructure',
            message: 'Execution content could not be materialized under the sealed policy.',
          });
        }
        await events.emit('execution.attempt.completed', 'attempt', attemptId, {
          trialId: coordinate.coordinate.trialId,
          attemptNumber,
          attemptStatus: 'completed',
        });
        break;
      }

      const failure = attemptError(outcome, runSignal);
      const attemptUsage = validatedUsage(failure.usage);
      attemptUsages.push(attemptUsage);
      const costError = budget.recordUsage(attemptUsage);
      if (costError !== undefined) {
        cacheEligible = false;
        setStop('failed', costError.code, costError);
      }
      terminalError = failure.error;
      terminalStatus = failure.status;
      attempts.push(failure.status === 'cancelled'
        ? {
          attemptId,
          attemptNumber,
          attemptStatus: 'cancelled',
          timing: {
            startedAt,
            completedAt,
            durationMs: durationMs(startedMonotonic, completedMonotonic),
          },
          error: failure.error,
          ...(attemptUsage !== undefined ? { usage: attemptUsage } : {}),
        }
        : {
          attemptId,
          attemptNumber,
          attemptStatus: 'failed',
          timing: {
            startedAt,
            completedAt,
            durationMs: durationMs(startedMonotonic, completedMonotonic),
          },
          error: failure.error,
          ...(attemptUsage !== undefined ? { usage: attemptUsage } : {}),
        });
      inFlightAttempt = undefined;
      await events.emit('execution.attempt.completed', 'attempt', attemptId, {
        trialId: coordinate.coordinate.trialId,
        attemptNumber,
        attemptStatus: failure.status,
        errorCode: failure.error.code,
      });
      if (failure.status === 'cancelled'
          || !retryPolicy.retryableErrorCodes.includes(failure.error.code)
          || attemptNumber === retryPolicy.maxAttempts) break;
      const delay = retryPolicy.backoff.backoffKind === 'none'
        ? 0
        : retryPolicy.backoff.backoffKind === 'fixed'
          ? retryPolicy.backoff.initialDelayMs
          : Math.min(
            retryPolicy.backoff.initialDelayMs * (2 ** (attemptNumber - 1)),
            retryPolicy.backoff.maxDelayMs ?? Number.MAX_SAFE_INTEGER,
          );
      await events.emit('execution.retry.scheduled', 'trial', coordinate.coordinate.trialId, {
        attemptNumber: attemptNumber + 1,
        delayMs: delay,
        errorCode: failure.error.code,
      });
      if (delay > 0) {
        try {
          await ports.clock.sleep(delay, runSignal);
        } catch {
          break;
        }
      }
    }
  } catch (error) {
    if (inFlightAttempt !== undefined) {
      const evaluationError: EvaluationError = {
        code: 'executor-result-invalid',
        stage: 'infrastructure',
        message: 'Executor returned a result that could not be materialized safely.',
      };
      attempts.push({
        attemptId: inFlightAttempt.attemptId,
        attemptNumber: inFlightAttempt.attemptNumber,
        attemptStatus: 'failed',
        timing: {
          startedAt: inFlightAttempt.startedAt,
          completedAt: ports.clock.timestamp(),
          durationMs: durationMs(
            inFlightAttempt.startedMonotonic,
            ports.clock.monotonicNow(),
          ),
        },
        error: evaluationError,
      });
      attemptUsages.push(undefined);
      inFlightAttempt = undefined;
      terminalError = evaluationError;
      terminalStatus = 'failed';
      cacheEligible = false;
      setStop('failed', evaluationError.code, evaluationError);
    } else if (attempts.length === 0) {
      const evaluationError = safeError(error);
      cacheEligible = false;
      setStop('failed', 'executor-resource-open-failed', {
        code: 'executor-resource-open-failed',
        stage: 'infrastructure',
        message: 'Executor run or trial resource could not be opened.',
        causes: [evaluationError],
      });
    } else {
      cacheEligible = false;
      setStop('failed', 'execution-runtime-internal-failed', {
        code: 'execution-runtime-internal-failed',
        stage: 'internal',
        message: 'Execution runtime failed after recording an attempt.',
      });
    }
  } finally {
    if (initialReservationPending) budget.releaseReserved();
    if (trial !== undefined) {
      try {
        await trial.dispose();
      } catch {
        cacheEligible = false;
        setStop('failed', 'executor-trial-dispose-failed', {
          code: 'executor-trial-dispose-failed',
          stage: 'infrastructure',
          message: 'Executor trial resource disposal failed.',
        });
      }
    }
    releaseRuntime();
    releaseGlobal();
  }

  if (attempts.length === 0) return { failed: false };

  const usage = aggregateUsage(attemptUsages);
  const completedAt = ports.clock.timestamp();
  const recordBase = {
    ...coordinate.coordinate,
    runtime: snapshotJson(binding.runtime),
    provenance: {
      provenanceKind: 'native' as const,
      trust: 'verified' as const,
      parentDigests: [plan.execution.executionPlanDigest],
    },
    attempts,
    timing: {
      startedAt: trialStartedAt,
      completedAt,
      durationMs: durationMs(trialStartedMonotonic, ports.clock.monotonicNow()),
    },
    ...(usage !== undefined ? { usage } : {}),
    ...(trace !== undefined ? { trace } : {}),
    cache: cacheProvenance(plan.execution.policy.executionCacheMode, key),
  };
  const record: ActiveExecutionRecord = terminalStatus === 'completed'
    ? {
      ...recordBase,
      executionStatus: 'completed',
      ...(output !== undefined ? { output } : {}),
    }
    : terminalStatus === 'cancelled'
      ? {
        ...recordBase,
        executionStatus: 'cancelled',
        ...(terminalError !== undefined ? { error: terminalError } : {}),
      }
      : {
        ...recordBase,
        executionStatus: 'failed',
        error: terminalError ?? {
          code: 'execution-failed',
          stage: 'execution',
          message: 'Execution failed without a terminal error.',
        },
      };

  const cacheEntry = record.executionStatus === 'completed'
      && cacheEligible
      && plan.execution.policy.executionCacheMode === 'transparent-deterministic'
    ? {
      cacheKeyDigest: key,
      sourceRecordDigest: digestCanonicalJson(record),
      record: snapshotJson(record),
    } satisfies ExecutionCacheEntry
    : undefined;
  await events.emit('execution.trial.completed', 'trial', coordinate.coordinate.trialId, {
    targetId: coordinate.coordinate.targetId,
    sampleId: coordinate.coordinate.sampleId,
    trialIndex: coordinate.coordinate.trialIndex,
    executionStatus: record.executionStatus,
  });
  return {
    record,
    ...(cacheEntry !== undefined ? { cacheEntry } : {}),
    failed: record.executionStatus === 'failed',
  };
}

async function prepareBlock(
  plan: SealedRunPlan,
  ports: ExecutionRuntimePorts,
  prepared: PreparedRuntime,
  events: EventEmitter,
  budget: BudgetTracker,
  block: ExecutionSchedulingBlock,
  setStop: (kind: StopKind, reason: string, error?: EvaluationError) => void,
): Promise<PreparedBlock | undefined> {
  const mode = plan.execution.policy.executionCacheMode;
  const coordinates: PreparedCoordinate[] = [];
  let misses = 0;
  for (const coordinate of block.coordinates) {
    if (mode === 'disabled') {
      coordinates.push({ coordinate, reservedInvocation: true });
      misses += 1;
      continue;
    }
    const binding = prepared.bindings.get(coordinate.targetId);
    if (binding === undefined) throw new Error('Target binding disappeared');
    const key = cacheKey(plan, coordinate);
    try {
      const entry = await ports.cache?.get(key);
      if (entry !== undefined) {
        const sourceRecord = assertCachedRecord(entry, key, coordinate, binding.runtime);
        coordinates.push({
          coordinate,
          cached: replayRecord(
            entry,
            sourceRecord,
            mode === 'replay-only' ? 'replay' : 'transparent-hit',
          ),
          reservedInvocation: false,
        });
        continue;
      }
    } catch {
      setStop('failed', 'execution-cache-read-failed', {
        code: 'execution-cache-read-failed',
        stage: 'infrastructure',
        message: 'Execution cache read or validation failed.',
      });
      return undefined;
    }
    if (mode === 'replay-only') {
      setStop('failed', 'execution-cache-miss', {
        code: 'execution-cache-miss',
        stage: 'infrastructure',
        message: 'Replay-only Execution cache did not contain every planned coordinate.',
      });
      return undefined;
    }
    await events.emit('execution.cache.miss', 'trial', coordinate.trialId, {
      trialId: coordinate.trialId,
      cacheKeyDigest: key,
    });
    coordinates.push({ coordinate, reservedInvocation: true });
    misses += 1;
  }
  if (!budget.reserveInitial(misses)) {
    setStop('budget-exhausted', 'target-invocation-budget-exhausted');
    return undefined;
  }
  return { block, coordinates };
}

function censoredRecord(
  plan: SealedRunPlan,
  prepared: PreparedRuntime,
  coordinate: PlannedExecutionCoordinate,
  censoredAt: string,
  reason: string,
): Extract<ExecutionRecord, { executionStatus: 'budget-censored' }> {
  const binding = prepared.bindings.get(coordinate.targetId);
  if (binding === undefined) throw new Error('Target binding disappeared');
  return {
    ...coordinate,
    runtime: snapshotJson(binding.runtime),
    provenance: {
      provenanceKind: 'native',
      trust: 'verified',
      parentDigests: [plan.execution.executionPlanDigest],
    },
    executionStatus: 'budget-censored',
    censorReasonCode: reason,
    censoredAt,
  };
}

function replayability(records: readonly ExecutionRecord[]): ExecutionBundle['replayability'] {
  const completed = records.filter(
    (record): record is CompletedExecutionRecord => record.executionStatus === 'completed',
  );
  if (completed.length === 0) return 'summary-only';
  const active = records.filter((record) => record.executionStatus !== 'budget-censored');
  const captured = active.flatMap((record) => record.executionStatus === 'completed'
    ? [record.output, record.trace]
    : [record.trace]).filter(
    (content): content is CapturedContent => content !== undefined,
  );
  if (completed.every((record) => record.output?.contentKind === 'inline')
      && captured.every((content) => content.contentKind === 'inline')) return 'self-contained';
  if (completed.every((record) => record.output?.contentKind === 'inline'
        || record.output?.contentKind === 'descriptor')
      && captured.every((content) => content.contentKind === 'inline'
        || content.contentKind === 'descriptor')
      && captured.some((content) => content.contentKind === 'descriptor')) return 'resolvable';
  return 'summary-only';
}

function coverage(
  planned: number,
  records: readonly ExecutionRecord[],
): ExecutionBundle['coverage'] {
  const succeeded = records.filter((record) => record.executionStatus === 'completed').length;
  const failed = records.filter((record) => record.executionStatus === 'failed').length;
  const cancelled = records.filter((record) => record.executionStatus === 'cancelled').length;
  const budgetCensored = records.filter(
    (record) => record.executionStatus === 'budget-censored',
  ).length;
  return {
    planned,
    started: succeeded + failed + cancelled,
    succeeded,
    failed,
    cancelled,
    budgetCensored,
    notStarted: planned - records.length,
  };
}

function makeBundle(
  plan: SealedRunPlan,
  options: ExecutionRunOptions,
  records: ExecutionRecord[],
  plannedCount: number,
  stop: StopState,
): ExecutionBundle {
  const sortedRecords = records.sort(compareRecords);
  const executionBundleStatus = stop.stopKind ?? 'completed';
  const bundle: ExecutionBundle = {
    schemaVersion: EXECUTION_BUNDLE_SCHEMA_VERSION,
    bundleId: options.bundleId,
    runContractDigest: plan.digests.runContractDigest,
    executionPlanDigest: plan.digests.executionPlanDigest,
    datasetRevisionDigest: plan.digests.datasetRevisionDigest,
    executionInputDigest: plan.digests.executionInputDigest,
    executionBundleStatus,
    ...(stop.reason !== undefined ? { terminationReasonCode: stop.reason } : {}),
    coverage: coverage(plannedCount, sortedRecords),
    replayability: replayability(sortedRecords),
    records: sortedRecords,
    provenance: {
      provenanceKind: 'native',
      trust: 'verified',
      parentDigests: [plan.digests.runContractDigest],
      ...(stop.error !== undefined
        ? { facets: snapshotJson({ terminalError: stop.error }) as unknown as JsonValue }
        : {}),
    },
    bundleDigest: `sha256:${'0'.repeat(64)}`,
  };
  bundle.bundleDigest = digestArtifactPayload(bundle, 'bundleDigest');
  return parseExecutionBundle(bundle, plan);
}

function terminalEventKind(
  status: ExecutionBundle['executionBundleStatus'],
): ExecutionEventKind {
  switch (status) {
    case 'completed': return 'execution.run.completed';
    case 'cancelled': return 'execution.run.cancelled';
    case 'budget-exhausted': return 'execution.run.budget-exhausted';
    case 'failed': return 'execution.run.failed';
  }
}

async function runExecution(
  plan: SealedRunPlan,
  ports: ExecutionRuntimePorts,
  options: ExecutionRunOptions,
  prepared: PreparedRuntime,
  stream: BoundedEventStream,
): Promise<ExecutionBundle> {
  const schedule = deriveExecutionSchedule(plan);
  const plannedCoordinates = schedule.flatMap((block) => block.coordinates);
  const stop: StopState = {};
  const controller = new AbortController();
  const setStop = (kind: StopKind, reason: string, error?: EvaluationError): void => {
    if (stop.stopKind !== undefined) return;
    stop.stopKind = kind;
    stop.reason = reason;
    if (error !== undefined) stop.error = error;
    if (kind !== 'budget-exhausted') controller.abort(reason);
  };
  const onExternalAbort = (): void => {
    setStop('cancelled', 'external-cancellation');
  };
  if (options.signal?.aborted) onExternalAbort();
  else options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const events = new EventEmitter(plan, ports, options, stream, (reason, error) => {
    setStop('failed', reason, error);
  });
  const sessions = new RunSessions(plan, options);
  const budget = new BudgetTracker(plan);
  const records = new Map<string, ExecutionRecord>();
  const pendingCacheEntries = new Map<Sha256Digest, ExecutionCacheEntry>();
  const durationController = new AbortController();
  const durationTimer = plan.execution.policy.budget.maxDurationMs === undefined
    ? undefined
    : ports.clock.sleep(
      plan.execution.policy.budget.maxDurationMs,
      durationController.signal,
    ).then(() => {
      setStop('budget-exhausted', 'duration-budget-exhausted');
    }).catch(() => undefined);
  try {
    await events.emit('execution.run.started', 'run', options.runId, {
      runContractDigest: plan.digests.runContractDigest,
      executionPlanDigest: plan.execution.executionPlanDigest,
      planned: plannedCoordinates.length,
    });
    const batchSize = plan.execution.policy.execution.maxConcurrency;
    for (let offset = 0; offset < schedule.length && stop.stopKind === undefined; offset += batchSize) {
      const batch = schedule.slice(offset, offset + batchSize);
      const preparedBlocks: PreparedBlock[] = [];
      for (const block of batch) {
        if (stop.stopKind !== undefined) break;
        const preparedBlock = await prepareBlock(
          plan,
          ports,
          prepared,
          events,
          budget,
          block,
          setStop,
        );
        if (preparedBlock !== undefined) preparedBlocks.push(preparedBlock);
      }
      const results = await Promise.all(preparedBlocks.map(async (preparedBlock) => {
        await events.emit('execution.block.started', 'scheduling-block', preparedBlock.block.schedulingBlockId, {
          coordinateCount: preparedBlock.coordinates.length,
        });
        const coordinateResults = await Promise.all(preparedBlock.coordinates.map((coordinate) => (
          executeCoordinate(
            plan,
            ports,
            options,
            prepared,
            sessions,
            events,
            budget,
            coordinate,
            controller.signal,
            setStop,
          )
        )));
        for (const result of coordinateResults) {
          if (result.record !== undefined) {
            records.set(coordinateKey(result.record), result.record);
          }
          if (result.cacheEntry !== undefined) {
            pendingCacheEntries.set(result.cacheEntry.cacheKeyDigest, result.cacheEntry);
          }
        }
        await events.emit('execution.block.completed', 'scheduling-block', preparedBlock.block.schedulingBlockId, {
          coordinateCount: preparedBlock.coordinates.length,
          completedCount: coordinateResults.filter((result) => result.record !== undefined).length,
        });
        return coordinateResults;
      }));

      const failedCount = results.flat().filter((result) => result.failed).length;
      const failurePolicy = plan.execution.policy.failure;
      const totalFailed = [...records.values()].filter(
        (record) => record.executionStatus === 'failed',
      ).length;
      if (stop.stopKind === undefined
          && failurePolicy.failureMode === 'fail-fast'
          && failedCount > 0) {
        setStop('failed', 'failure-policy-fail-fast');
      } else if (stop.stopKind === undefined
          && failurePolicy.failureMode === 'failure-threshold'
          && totalFailed > (failurePolicy.maxFailures ?? 0)) {
        setStop('failed', 'failure-policy-threshold');
      } else if (stop.stopKind === undefined && budget.providerCostExhausted) {
        setStop('budget-exhausted', 'provider-cost-budget-exhausted');
      }
    }
  } catch {
    setStop('failed', 'execution-runtime-internal-failed', {
      code: 'execution-runtime-internal-failed',
      stage: 'internal',
      message: 'Execution runtime encountered an internal failure.',
    });
  } finally {
    durationController.abort();
    await durationTimer;
    options.signal?.removeEventListener('abort', onExternalAbort);
    const disposeErrors = await sessions.dispose();
    if (disposeErrors.length > 0) {
      setStop('failed', 'executor-run-dispose-failed', disposeErrors[0]);
    }
    if (disposeErrors.length === 0 && stop.stopKind === undefined) {
      for (const entry of [...pendingCacheEntries.values()].sort((left, right) => (
        compareStrings(left.cacheKeyDigest, right.cacheKeyDigest)
      ))) {
        try {
          await ports.cache?.put(entry);
        } catch {
          setStop('failed', 'execution-cache-write-failed', {
            code: 'execution-cache-write-failed',
            stage: 'infrastructure',
            message: 'Execution cache write failed.',
          });
          break;
        }
      }
    }
  }

  if (stop.stopKind === 'budget-exhausted') {
    const censoredAt = ports.clock.timestamp();
    for (const coordinate of plannedCoordinates) {
      if (!records.has(coordinateKey(coordinate))) {
        records.set(coordinateKey(coordinate), censoredRecord(
          plan,
          prepared,
          coordinate,
          censoredAt,
          stop.reason ?? 'budget-exhausted',
        ));
      }
    }
  }
  let bundle = makeBundle(
    plan,
    options,
    [...records.values()],
    plannedCoordinates.length,
    stop,
  );
  const terminalDelivered = await events.emit(
    terminalEventKind(bundle.executionBundleStatus),
    'run',
    options.runId,
    {
      bundleDigest: bundle.bundleDigest,
      executionBundleStatus: bundle.executionBundleStatus,
      coverage: bundle.coverage,
    },
  );
  if (!terminalDelivered) {
    bundle = makeBundle(
      plan,
      options,
      [...records.values()],
      plannedCoordinates.length,
      stop,
    );
    await events.emit(
      terminalEventKind(bundle.executionBundleStatus),
      'run',
      options.runId,
      {
        bundleDigest: bundle.bundleDigest,
        executionBundleStatus: bundle.executionBundleStatus,
        coverage: bundle.coverage,
      },
    );
  }
  events.close();
  return bundle;
}

export function startExecution(
  plan: SealedRunPlan,
  ports: ExecutionRuntimePorts,
  options: ExecutionRunOptions,
): ExecutionRun {
  const prepared = prepareRuntime(plan, ports, options);
  const stream = new BoundedEventStream(options.eventBufferCapacity ?? 256);
  return {
    events: stream,
    result: runExecution(plan, ports, options, prepared, stream),
  };
}

export async function executeRunPlan(
  plan: SealedRunPlan,
  ports: ExecutionRuntimePorts,
  options: ExecutionRunOptions,
): Promise<ExecutionBundle> {
  return startExecution(plan, ports, options).result;
}
