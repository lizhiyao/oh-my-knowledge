/** Coordinate processing, attempts and evidence/cache handling. */
import { durationMs } from '../runtime/clock.js';
import type { RunResourceSessions } from '../runtime/run-resources.js';
import { linkAbortSignal } from '../runtime/abort.js';
import {
  CompletedExecutionRecordSchema,
  ContentClassificationSchema,
  ContentDescriptorSchema,
  EvaluationErrorSchema,
  UsageRecordSchema,
  canonicalizeJson,
  deriveAttemptId,
  digestCanonicalJson,
  mostRestrictiveProviderCostLimit,
  parseWireDocument,
  type CacheProvenance,
  type CapturedContent,
  type EvaluationError,
  type ExecutionAttempt,
  type ExecutionRecord,
  type PlannedExecutionCoordinate,
  type RuntimeIdentity,
  type Sha256Digest,
  type UsageRecord,
} from '../contracts/index.js';
import {
  aggregateExecutionAttemptUsage,
  assertExecutionRecordMatchesAttemptPolicy,
  executionRecordMatchesEvidencePolicy,
  executionRecordSatisfiesCacheCostPolicy,
  executionRecordUsageMatchesAttempts,
} from '../verify/index.js';
import { type SealedRunPlan } from '../compiler/index.js';
import { deepFreeze, snapshotJson } from '../compiler/immutability.js';
import type { RuntimeEventEmitter } from '../runtime/events.js';
import { type RunBudgetController } from '../budget/index.js';
import { abortError } from './semaphore.js';
import { type ExecutionSchedulingBlock } from './scheduler.js';
import {
  ExecutionPortFailure,
  ExecutionRuntimeConfigurationError,
  type ExecutionCacheEntry,
  type ExecutionClock,
  type ExecutionContent,
  type ExecutionEventKind,
  type ExecutionEventSubjectKind,
  type ExecutionExecutorRun,
  type ExecutionExecutorTrial,
  type ExecutionRuntimePorts,
  type ExecutorAttemptResult,
  type ExecutorTrialContext,
} from './types.js';
import type {
  CompletedExecutionRecord,
  ExecutionTerminalEventKind,
  PreparedBlock,
  PreparedCoordinate,
  PreparedRuntime,
  StopKind,
  TargetRuntimeBinding,
} from './runtime-state.js';


type ActiveExecutionRecord = Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>;

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

export function coordinateKey(coordinate: { trialId: string }): string {
  return coordinate.trialId;
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

type EventEmitter = RuntimeEventEmitter<
  ExecutionEventKind,
  ExecutionEventSubjectKind,
  ExecutionTerminalEventKind
>;


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

export async function executeCoordinate(
  plan: SealedRunPlan,
  ports: ExecutionRuntimePorts,
  prepared: PreparedRuntime,
  sessions: RunResourceSessions<TargetRuntimeBinding, ExecutionExecutorRun>,
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
    const runSession = await sessions.get(binding);
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

export async function prepareBlock(
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

export function censoredRecord(
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
