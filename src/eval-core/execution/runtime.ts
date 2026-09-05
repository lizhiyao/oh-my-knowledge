import {
  EXECUTION_BUNDLE_SCHEMA_VERSION,
  CompletedExecutionRecordSchema,
  ContentClassificationSchema,
  ContentDescriptorSchema,
  EvaluationErrorSchema,
  IdentifierSchema,
  UsageRecordSchema,
  aggregateExecutionAttemptUsage,
  assertExecutionRecordMatchesAttemptPolicy,
  canonicalizeJson,
  deriveAttemptId,
  digestArtifactPayload,
  digestCanonicalJson,
  executionRecordMatchesEvidencePolicy,
  executionRecordSatisfiesCacheCostPolicy,
  executionRecordUsageMatchesAttempts,
  mostRestrictiveProviderCostLimit,
  parseWireDocument,
  verifyExecutionBundle,
  type CacheProvenance,
  type CapturedContent,
  type EvaluationError,
  type ExecutionAttempt,
  type ExecutionBundle,
  type ExecutionBundleSource,
  type ExecutionRecord,
  type JsonValue,
  type PlannedExecutionCoordinate,
  type Provenance,
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
import { RuntimeEventEmitter } from '../runtime/events.js';
import { BoundedEventStream } from '../runtime/event-stream.js';
import {
  assertRunBudgetSource,
  createRunBudgetSource,
  resolveRunBudgetSource,
  type RunBudgetController,
  type RunBudgetSource,
} from '../budget/index.js';
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
type ResolvedExecutionRunOptions = ExecutionRunOptions & { budgetSource: RunBudgetSource };

const PROVENANCE_TRUST_LEVEL = {
  untrusted: 0,
  unknown: 1,
  declared: 2,
  verified: 3,
} as const;

function minimumProvenanceTrust(
  records: readonly ExecutionRecord[],
): Provenance['trust'] {
  return records.reduce<Provenance['trust']>((minimum, record) => (
    PROVENANCE_TRUST_LEVEL[record.provenance.trust] < PROVENANCE_TRUST_LEVEL[minimum]
      ? record.provenance.trust
      : minimum
  ), 'verified');
}

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
  reservationId?: string;
}

interface PreparedBlock {
  block: ExecutionSchedulingBlock;
  coordinates: PreparedCoordinate[];
}

interface CoordinateResult {
  record?: ActiveExecutionRecord;
  cacheEntry?: ExecutionCacheEntry;
  verifiedCacheRecordDigest?: Sha256Digest;
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
  if (ports.eventSequencer === undefined) {
    configurationError(
      'EXECUTION_RUNTIME_EVENT_SEQUENCER_REQUIRED',
      'Execution runtime requires a shared per-Run EventSequencer.',
    );
  }
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
  const executorLimits = new Map<ExecutionExecutor, number>();
  const partialBindings: Array<{
    target: SealedRunPlan['execution']['targets'][number];
    executor: ExecutionExecutor;
    runtime: RuntimeIdentity;
    protocol: ProtocolManifest;
  }> = [];
  for (const target of plan.execution.targets) {
    const executor = ports.executorsByTargetId.get(target.targetId);
    if (executor === undefined) {
      configurationError(
        'EXECUTION_RUNTIME_EXECUTOR_MISSING',
        `No Executor binding is registered for Target ${target.targetId}.`,
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
    const budgetPolicy = plan.measurementPolicy.budget;
    const executionCostBudgetConfigured = budgetPolicy.run.maxProviderCost !== undefined
      || budgetPolicy.stages.execution.maxProviderCost !== undefined
      || budgetPolicy.coordinate.maxProviderCost !== undefined
      || budgetPolicy.attempt.maxProviderCost !== undefined;
    if (executionCostBudgetConfigured
        && budgetPolicy.providerCostAdmission.admissionMode === 'strict-reservation'
        && (expectedRuntime.assuranceLevel !== 'verified'
          || protocol.execution.telemetry.providerCost?.reporting !== 'required'
          || protocol.execution.telemetry.providerCost.trustedUpperBound === undefined)) {
      configurationError(
        'EXECUTION_RUNTIME_PROVIDER_COST_BOUND_REQUIRED',
        `Strict provider-cost admission requires a verified upper bound for ${target.targetId}.`,
      );
    }
    const capabilityLimit = protocol.execution.concurrency.safety === 'serialized'
      ? 1
      : (protocol.execution.concurrency.maxInFlight
        ?? plan.execution.policy.execution.maxConcurrency);
    const currentLimit = executorLimits.get(executor);
    executorLimits.set(
      executor,
      currentLimit === undefined ? capabilityLimit : Math.min(currentLimit, capabilityLimit),
    );
    partialBindings.push({ target, executor, runtime: expectedRuntime, protocol });
  }
  const semaphores = new Map(
    [...executorLimits].map(([executor, limit]) => [executor, new Semaphore(limit)]),
  );
  return {
    bindings: new Map(partialBindings.map((binding) => [binding.target.targetId, {
      ...binding,
      semaphore: semaphores.get(binding.executor) as Semaphore,
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

  get(targetId: string, executor: ExecutionExecutor): Promise<ExecutionExecutorRun> {
    const current = this.#sessions.get(targetId);
    if (current !== undefined) return current;
    const context = deepFreeze(snapshotJson({
      runId: this.#options.runId,
      executionPlanDigest: this.#plan.execution.executionPlanDigest as Sha256Digest,
    }));
    const session = Promise.resolve(executor.openRun(context));
    this.#sessions.set(targetId, session);
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

type ExecutionTerminalEventKind =
  | 'execution.run.completed'
  | 'execution.run.cancelled'
  | 'execution.run.budget-exhausted'
  | 'execution.run.failed';

type EventEmitter = RuntimeEventEmitter<
  ExecutionEventKind,
  ExecutionEventSubjectKind,
  ExecutionTerminalEventKind
>;

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

function cacheKey(coordinate: PlannedExecutionCoordinate): Sha256Digest {
  return digestCanonicalJson({
    derivation: 'omk.execution-cache-key/v2',
    executionCoordinateDigest: coordinate.executionCoordinateDigest,
    trialId: coordinate.trialId,
  });
}

function providerCostUpperBound(
  binding: TargetRuntimeBinding,
): { amount: number; currency: string } | undefined {
  if (binding.runtime.assuranceLevel !== 'verified') return undefined;
  return binding.protocol.execution.telemetry.providerCost?.trustedUpperBound;
}

function assertCachedRecord(
  entry: ExecutionCacheEntry,
  key: Sha256Digest,
  coordinate: PlannedExecutionCoordinate,
  runtime: RuntimeIdentity,
  plan: SealedRunPlan,
): CompletedExecutionRecord {
  const record = parseWireDocument(CompletedExecutionRecordSchema, entry.record);
  assertExecutionRecordMatchesAttemptPolicy(record, plan.execution.policy.retry);
  const expectedProvenance = {
    provenanceKind: 'native' as const,
    trust: runtime.assuranceLevel,
    parentDigests: [coordinate.executionCoordinateDigest],
  };
  if (entry.cacheKeyDigest !== key
      || entry.sourceRecordDigest !== digestCanonicalJson(record)
      || record.targetId !== coordinate.targetId
      || record.randomizationSlotId !== coordinate.randomizationSlotId
      || record.sampleId !== coordinate.sampleId
      || record.trialIndex !== coordinate.trialIndex
      || record.executionCoordinateDigest !== coordinate.executionCoordinateDigest
      || record.trialId !== coordinate.trialId
      || record.trialSeed !== coordinate.trialSeed
      || record.schedulingBlockId !== coordinate.schedulingBlockId
      || canonicalizeJson(record.samplingUnitIds)
        !== canonicalizeJson(coordinate.samplingUnitIds)
      || canonicalizeJson(record.runtime) !== canonicalizeJson(runtime)
      || canonicalizeJson(record.provenance) !== canonicalizeJson(expectedProvenance)
      || canonicalizeJson(record.cache) !== canonicalizeJson({
        cacheStatus: 'miss',
        cacheKeyDigest: key,
      })
      || !executionRecordMatchesEvidencePolicy(record, plan.execution.policy.evidence)
      || !executionRecordSatisfiesCacheCostPolicy(
        record,
        mostRestrictiveProviderCostLimit(
          plan.execution.policy.budget.run.maxProviderCost,
          plan.execution.policy.budget.stages.execution.maxProviderCost,
          plan.execution.policy.budget.coordinate.maxProviderCost,
        ),
        plan.execution.policy.budget.attempt.maxProviderCost,
      )
      || !executionRecordUsageMatchesAttempts(record)) {
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
  signal: AbortSignal,
): ExecutorTrialContext {
  const sample = plan.execution.samples.find(
    (candidate) => candidate.sampleId === coordinate.sampleId,
  );
  if (sample === undefined) throw new Error('Planned sample disappeared');
  const controlled = plan.execution.experiment.sampling.seedCoupling !== 'uncontrolled';
  const snapshot = deepFreeze(snapshotJson({
    sampleId: coordinate.sampleId,
    targetId: coordinate.targetId,
    executionCoordinateDigest: coordinate.executionCoordinateDigest,
    executionControl: coordinate.executionControl,
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
  }));
  return Object.freeze({ ...snapshot, signal }) as ExecutorTrialContext;
}

function executionRecordIdentity(coordinate: PlannedExecutionCoordinate) {
  return {
    targetId: coordinate.targetId,
    randomizationSlotId: coordinate.randomizationSlotId,
    sampleId: coordinate.sampleId,
    trialIndex: coordinate.trialIndex,
    executionCoordinateDigest: coordinate.executionCoordinateDigest,
    trialId: coordinate.trialId,
    trialSeed: coordinate.trialSeed,
    schedulingBlockId: coordinate.schedulingBlockId,
    samplingUnitIds: coordinate.samplingUnitIds,
  };
}

async function executeCoordinate(
  plan: SealedRunPlan,
  ports: ExecutionRuntimePorts,
  options: ExecutionRunOptions,
  prepared: PreparedRuntime,
  sessions: RunSessions,
  events: EventEmitter,
  budget: RunBudgetController,
  coordinate: PreparedCoordinate,
  runSignal: AbortSignal,
  setStop: (kind: StopKind, reason: string, error?: EvaluationError) => void,
): Promise<CoordinateResult> {
  if (coordinate.cached !== undefined) {
    await events.emit('execution.cache.hit', 'trial', coordinate.coordinate.trialId, {
      trialId: coordinate.coordinate.trialId,
      cacheStatus: coordinate.cached.cache.cacheStatus,
    });
    return {
      record: coordinate.cached,
      verifiedCacheRecordDigest: coordinate.cached.cache.sourceRecordDigest as Sha256Digest,
      failed: false,
    };
  }
  const binding = prepared.bindings.get(coordinate.coordinate.targetId);
  if (binding === undefined) throw new Error('Target binding disappeared');
  const releaseGlobal = await prepared.globalSemaphore.acquire(runSignal).catch(() => undefined);
  if (releaseGlobal === undefined) {
    if (coordinate.reservationId !== undefined) budget.release(coordinate.reservationId);
    return { failed: false };
  }
  const releaseRuntime = await binding.semaphore.acquire(runSignal).catch(() => undefined);
  if (releaseRuntime === undefined) {
    releaseGlobal();
    if (coordinate.reservationId !== undefined) budget.release(coordinate.reservationId);
    return { failed: false };
  }

  const attempts: ExecutionAttempt[] = [];
  let trial: ExecutionExecutorTrial | undefined;
  let inFlightAttempt: InFlightAttempt | undefined;
  const trialStartedAt = ports.clock.timestamp();
  const trialStartedMonotonic = ports.clock.monotonicNow();
  let output: CapturedContent | undefined;
  let trace: CapturedContent | undefined;
  let terminalError: EvaluationError | undefined;
  let terminalStatus: 'completed' | 'failed' | 'cancelled' = 'failed';
  let reservationId = coordinate.reservationId;
  let cacheEligible = true;
  const key = cacheKey(coordinate.coordinate);
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
    const runSession = await sessions.get(binding.target.targetId, binding.executor);
    trial = await runSession.openTrial(trialContext(
      plan,
      binding,
      coordinate.coordinate,
      runSignal,
    ));
    const retryPolicy = plan.execution.policy.retry;
    for (let attemptNumber = 1; attemptNumber <= retryPolicy.maxAttempts; attemptNumber += 1) {
      const attemptId = deriveAttemptId({
        trialId: coordinate.coordinate.trialId,
        attemptNumber,
      });
      if (attemptNumber > 1) {
        const admission = budget.reserve([{
          stage: 'execution',
          coordinateId: coordinate.coordinate.trialId,
          attemptId,
          ...(providerCostUpperBound(binding) === undefined
            ? {}
            : { providerCostUpperBound: providerCostUpperBound(binding) }),
        }]);
        if (!admission.admitted) {
          budget.noteTermination(admission.termination);
          setStop(
            admission.termination.terminationKind === 'failed' ? 'failed' : 'budget-exhausted',
            admission.termination.reasonCode,
          );
          break;
        }
        [reservationId] = admission.reservationIds;
      }
      const startedAt = ports.clock.timestamp();
      const startedMonotonic = ports.clock.monotonicNow();
      const attemptEventDelivered = await events.emit('execution.attempt.started', 'attempt', attemptId, {
        trialId: coordinate.coordinate.trialId,
        attemptNumber,
      });
      if (!attemptEventDelivered || runSignal.aborted) break;
      if (reservationId === undefined) throw new Error('Missing invocation reservation');
      budget.consume(reservationId);
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
        const budgetError = budget.settle(
          reservationId,
          durationMs(startedMonotonic, completedMonotonic),
          attemptUsage,
          'completed',
        );
        reservationId = undefined;
        if (budgetError !== undefined) {
          cacheEligible = false;
          const summary = budget.snapshot();
          setStop(
            summary.summaryStatus === 'failed' ? 'failed' : 'budget-exhausted',
            budgetError.code,
            summary.summaryStatus === 'failed' ? budgetError : undefined,
          );
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
      const budgetError = budget.settle(
        reservationId,
        durationMs(startedMonotonic, completedMonotonic),
        attemptUsage,
        failure.error.code === 'timeout'
          ? 'attempt-timeout'
          : failure.status === 'cancelled' ? 'cancelled' : 'failed',
      );
      reservationId = undefined;
      if (budgetError !== undefined) {
        cacheEligible = false;
        const summary = budget.snapshot();
        setStop(
          summary.summaryStatus === 'failed' ? 'failed' : 'budget-exhausted',
          budgetError.code,
          summary.summaryStatus === 'failed' ? budgetError : undefined,
        );
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
      const completedAt = ports.clock.timestamp();
      const completedMonotonic = ports.clock.monotonicNow();
      if (reservationId === undefined) throw new Error('Missing invocation reservation');
      budget.settle(
        reservationId,
        durationMs(inFlightAttempt.startedMonotonic, completedMonotonic),
        undefined,
        'failed',
      );
      reservationId = undefined;
      attempts.push({
        attemptId: inFlightAttempt.attemptId,
        attemptNumber: inFlightAttempt.attemptNumber,
        attemptStatus: 'failed',
        timing: {
          startedAt: inFlightAttempt.startedAt,
          completedAt,
          durationMs: durationMs(
            inFlightAttempt.startedMonotonic,
            completedMonotonic,
          ),
        },
        error: evaluationError,
      });
      inFlightAttempt = undefined;
      terminalError = evaluationError;
      terminalStatus = 'failed';
      cacheEligible = false;
      setStop('failed', evaluationError.code, evaluationError);
    } else if (attempts.length === 0 && runSignal.aborted) {
      cacheEligible = false;
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
    if (reservationId !== undefined) budget.release(reservationId);
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

  const usage = aggregateExecutionAttemptUsage(attempts);
  const completedAt = ports.clock.timestamp();
  const recordBase = {
    ...executionRecordIdentity(coordinate.coordinate),
    runtime: snapshotJson(binding.runtime),
    provenance: {
      provenanceKind: 'native' as const,
      trust: binding.runtime.assuranceLevel,
      parentDigests: [coordinate.coordinate.executionCoordinateDigest],
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
  budget: RunBudgetController,
  block: ExecutionSchedulingBlock,
  setStop: (kind: StopKind, reason: string, error?: EvaluationError) => void,
): Promise<PreparedBlock | undefined> {
  const mode = plan.execution.policy.executionCacheMode;
  const coordinates: PreparedCoordinate[] = [];
  for (const coordinate of block.coordinates) {
    if (mode === 'disabled') {
      coordinates.push({ coordinate });
      continue;
    }
    const binding = prepared.bindings.get(coordinate.targetId);
    if (binding === undefined) throw new Error('Target binding disappeared');
    const key = cacheKey(coordinate);
    try {
      const entry = await ports.cache?.get(key);
      if (entry !== undefined) {
        const sourceRecord = assertCachedRecord(entry, key, coordinate, binding.runtime, plan);
        coordinates.push({
          coordinate,
          cached: replayRecord(
            entry,
            sourceRecord,
            mode === 'replay-only' ? 'replay' : 'transparent-hit',
          ),
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
    coordinates.push({ coordinate });
  }
  const missesToReserve = coordinates.filter((coordinate) => coordinate.cached === undefined);
  const admission = budget.reserve(missesToReserve.map(({ coordinate }) => {
    const binding = prepared.bindings.get(coordinate.targetId);
    if (binding === undefined) throw new Error('Target binding disappeared');
    return {
      stage: 'execution' as const,
      coordinateId: coordinate.trialId as Sha256Digest,
      attemptId: deriveAttemptId({ trialId: coordinate.trialId, attemptNumber: 1 }),
      ...(providerCostUpperBound(binding) === undefined
        ? {}
        : { providerCostUpperBound: providerCostUpperBound(binding) }),
    };
  }));
  if (!admission.admitted) {
    budget.noteTermination(admission.termination);
    setStop(
      admission.termination.terminationKind === 'failed' ? 'failed' : 'budget-exhausted',
      admission.termination.reasonCode,
    );
    return undefined;
  }
  let reservationIndex = 0;
  for (const coordinate of coordinates) {
    if (coordinate.cached !== undefined) continue;
    coordinate.reservationId = admission.reservationIds[reservationIndex];
    reservationIndex += 1;
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
    ...executionRecordIdentity(coordinate),
    runtime: snapshotJson(binding.runtime),
    provenance: {
      provenanceKind: 'native',
      trust: 'verified',
      parentDigests: [coordinate.executionCoordinateDigest],
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
  options: ResolvedExecutionRunOptions,
  records: ExecutionRecord[],
  plannedCount: number,
  stop: StopState,
  verifiedCacheRecordDigests: ReadonlySet<Sha256Digest>,
): ExecutionBundleSource {
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
    budgetSummary: resolveRunBudgetSource(
      options.budgetSource,
      plan,
      options.runId,
    ).snapshot(),
    records: sortedRecords,
    provenance: {
      provenanceKind: 'native',
      trust: minimumProvenanceTrust(sortedRecords),
      parentDigests: [
        plan.digests.runContractDigest,
        plan.digests.executionPlanDigest,
      ],
      ...(stop.error !== undefined
        ? { facets: snapshotJson({ terminalError: stop.error }) as unknown as JsonValue }
        : {}),
    },
    bundleDigest: `sha256:${'0'.repeat(64)}`,
  };
  bundle.bundleDigest = digestArtifactPayload(bundle, 'bundleDigest');
  const verified = verifyExecutionBundle(bundle, plan, {
    verifiedCacheRecordDigests,
    verifiedProvenanceBundleDigests: new Set([bundle.bundleDigest as Sha256Digest]),
  });
  if (verified.planVerification.provenanceTrustStatus !== 'verified'
      || verified.planVerification.cacheReceiptStatus !== 'verified'
      || verified.planVerification.invocationBudgetStatus !== 'verified'
      || (bundle.executionBundleStatus === 'completed'
        && verified.planVerification.providerCostBudgetStatus !== 'verified'
        && bundle.budgetSummary.summaryStatus !== 'unverifiable')) {
    throw new TypeError('Execution Runtime produced an unverifiable Bundle.');
  }
  return verified;
}

function terminalEventKind(
  status: ExecutionBundle['executionBundleStatus'],
): ExecutionTerminalEventKind {
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
  options: ResolvedExecutionRunOptions,
  prepared: PreparedRuntime,
  stream: BoundedEventStream,
): Promise<ExecutionBundleSource> {
  const schedule = deriveExecutionSchedule(plan);
  const plannedCoordinates = schedule.flatMap((block) => block.coordinates);
  const stop: StopState = {};
  const controller = new AbortController();
  const budget = resolveRunBudgetSource(options.budgetSource, plan, options.runId);
  const setStop = (kind: StopKind, reason: string, error?: EvaluationError): void => {
    if (stop.stopKind === 'failed'
        || (stop.stopKind !== undefined && kind !== 'failed')) return;
    stop.stopKind = kind;
    stop.reason = reason;
    if (error !== undefined) stop.error = error;
    if (kind === 'cancelled' || kind === 'failed') {
      budget.noteTermination({
        terminationKind: kind,
        reasonCode: reason,
      });
    }
    if (kind !== 'budget-exhausted') controller.abort(reason);
  };
  const onExternalAbort = (): void => {
    setStop('cancelled', 'external-cancellation');
  };
  if (options.signal?.aborted) onExternalAbort();
  else options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const events = new RuntimeEventEmitter<
    ExecutionEventKind,
    ExecutionEventSubjectKind,
    ExecutionTerminalEventKind
  >(
    ports.clock,
    ports.eventSequencer,
    ports.eventWriter,
    {
      runId: options.runId,
      writerMode: plan.measurementPolicy.eventDelivery.writerMode,
      writerFailureMode: plan.measurementPolicy.eventDelivery.writerFailureMode,
      writerFailureReason: 'event-writer-failed',
      writerFailureError: {
        code: 'event-writer-failed',
        stage: 'infrastructure',
        message: 'Required EventWriter delivery failed.',
      },
      recoveryEventKinds: [
        'execution.run.completed',
        'execution.run.cancelled',
        'execution.run.budget-exhausted',
        'execution.run.failed',
      ],
    },
    stream,
    (reason: string, error: EvaluationError) => setStop('failed', reason, error),
  );
  const sessions = new RunSessions(plan, options);
  const records = new Map<string, ExecutionRecord>();
  const pendingCacheEntries = new Map<Sha256Digest, ExecutionCacheEntry>();
  const verifiedCacheRecordDigests = new Set<Sha256Digest>();
  const wallClockController = new AbortController();
  const wallClockRemainingMs = budget.wallClockRemainingMs();
  const wallClockTimer = wallClockRemainingMs === undefined
    ? undefined
    : ports.clock.sleep(wallClockRemainingMs, wallClockController.signal).then(() => {
      const termination = {
        terminationKind: 'wall-clock-exhausted' as const,
        resourceKind: 'wall-clock' as const,
        scopeKind: 'run' as const,
        scopeId: options.runId,
        reasonCode: 'run-wall-clock-budget-exhausted',
      };
      budget.noteTermination(termination);
      setStop('budget-exhausted', termination.reasonCode);
    }).catch(() => undefined);
  try {
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
          if (result.verifiedCacheRecordDigest !== undefined) {
            verifiedCacheRecordDigests.add(result.verifiedCacheRecordDigest);
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
      }
    }
    } catch (error) {
      if (!(error instanceof Error
          && error.name === 'AbortError'
          && stop.stopKind !== undefined)) {
        setStop('failed', 'execution-runtime-internal-failed', {
          code: 'execution-runtime-internal-failed',
          stage: 'internal',
          message: 'Execution runtime encountered an internal failure.',
        });
      }
    } finally {
      wallClockController.abort();
      await wallClockTimer;
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
    let source = makeBundle(
      plan,
      options,
      [...records.values()],
      plannedCoordinates.length,
      stop,
      verifiedCacheRecordDigests,
    );
    const terminalDelivered = await events.emit(
      terminalEventKind(source.bundle.executionBundleStatus),
      'run',
      options.runId,
      {
        bundleDigest: source.bundle.bundleDigest,
        executionBundleStatus: source.bundle.executionBundleStatus,
        coverage: source.bundle.coverage,
      },
    );
    if (!terminalDelivered) {
      source = makeBundle(
        plan,
        options,
        [...records.values()],
        plannedCoordinates.length,
        stop,
        verifiedCacheRecordDigests,
      );
      await events.emitRecovery(
        terminalEventKind(source.bundle.executionBundleStatus),
        'run',
        options.runId,
        {
          bundleDigest: source.bundle.bundleDigest,
          executionBundleStatus: source.bundle.executionBundleStatus,
          coverage: source.bundle.coverage,
        },
      );
    }
    return source;
  } finally {
    events.close();
  }
}

export function startExecution(
  plan: SealedRunPlan,
  ports: ExecutionRuntimePorts,
  options: ExecutionRunOptions,
): ExecutionRun {
  const runtimeOptions: ResolvedExecutionRunOptions = options.budgetSource === undefined
    ? { ...options, budgetSource: createRunBudgetSource(plan, options.runId, ports.clock) }
    : { ...options, budgetSource: options.budgetSource };
  assertRunBudgetSource(runtimeOptions.budgetSource, plan, runtimeOptions.runId);
  const prepared = prepareRuntime(plan, ports, runtimeOptions);
  const stream = new BoundedEventStream(options.eventBufferCapacity ?? 256);
  const source = runExecution(plan, ports, runtimeOptions, prepared, stream);
  let result: Promise<ExecutionBundle> | undefined;
  return {
    events: stream,
    source,
    budgetSource: runtimeOptions.budgetSource,
    get result() {
      result ??= source.then((verified) => verified.bundle);
      return result;
    },
  };
}

export async function executeRunPlan(
  plan: SealedRunPlan,
  ports: ExecutionRuntimePorts,
  options: ExecutionRunOptions,
): Promise<ExecutionBundle> {
  return startExecution(plan, ports, options).result;
}

export async function executeRunPlanSource(
  plan: SealedRunPlan,
  ports: ExecutionRuntimePorts,
  options: ExecutionRunOptions,
): Promise<ExecutionBundleSource> {
  return startExecution(plan, ports, options).source;
}
