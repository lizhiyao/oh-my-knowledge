import { RunResourceSessions } from '../runtime/run-resources.js';
import { compareStrings } from '../primitives/ordering.js';
import { minimumTrust } from '../primitives/provenance.js';
import {
  derivePlannedEvaluationCoordinates,
  type EvaluationBundle,
  type EvaluationBundleSource,
  type EvaluationError,
  type EvaluationRecord,
  type ExecutionBundleSource,
  type Sha256Digest,
} from '../contracts/index.js';
import { effectiveExecutionBundleTrust } from '../verify/index.js';
import { deepFreeze, snapshotJson } from '../compiler/immutability.js';
import type { SealedRunPlan } from '../compiler/index.js';
import { BoundedEventStream, DEFAULT_EVENT_BUFFER_CAPACITY } from '../runtime/event-stream.js';
import { RuntimeEventEmitter } from '../runtime/events.js';
import { assertRunBudgetSource, createRunBudgetSource, resolveRunBudgetSource } from '../budget/index.js';
import {
  type EvaluationCacheEntry,
  type EvaluationEvaluatorRun,
  type EvaluationRun,
  type EvaluationRunOptions,
  type EvaluationRuntimeEventKind,
  type EvaluationRuntimePorts,
} from './types.js';
import type {
  EligibleCoordinate,
  EvaluationTerminalEventKind,
  EvaluatorBinding,
  PreparedRuntime,
  ResolvedEvaluationRunOptions,
  StopKind,
  StopState,
} from './runtime-state.js';
import {
  EvaluationAttemptCancelledError,
  evaluateCoordinate,
  notEvaluatedRecord,
  prepareEvaluationCoordinates,
  safeError,
  trialKey,
} from './coordinate.js';
import { makeBundle } from './bundle.js';
import { prepareRuntime } from './preparation.js';


function terminalKind(
  status: EvaluationBundle['evaluationBundleStatus'],
): EvaluationTerminalEventKind {
  if (status === 'completed') return 'evaluation.run.completed';
  if (status === 'cancelled') return 'evaluation.run.cancelled';
  if (status === 'budget-exhausted') return 'evaluation.run.budget-exhausted';
  return 'evaluation.run.failed';
}

async function runEvaluation(
  plan: SealedRunPlan,
  ports: EvaluationRuntimePorts,
  options: ResolvedEvaluationRunOptions,
  prepared: PreparedRuntime,
  stream: BoundedEventStream,
): Promise<EvaluationBundleSource> {
  const coordinates = derivePlannedEvaluationCoordinates(plan);
  const records = new Map<string, EvaluationRecord>();
  const pendingCache: EvaluationCacheEntry[] = [];
  const verifiedCacheRecordDigests = new Set<Sha256Digest>();
  const stop: StopState = {};
  const controller = new AbortController();
  const budget = resolveRunBudgetSource(options.budgetSource, plan, options.runId);
  const setStop = (stopKind: StopKind, reason: string, error?: EvaluationError): void => {
    if (stop.stopKind === 'failed'
        || (stop.stopKind !== undefined && stopKind !== 'failed')) return;
    stop.stopKind = stopKind;
    stop.reason = reason;
    if (error !== undefined) stop.error = error;
    if (stopKind === 'cancelled' || stopKind === 'failed') {
      budget.noteTermination({
        terminationKind: stopKind,
        reasonCode: reason,
      });
    }
    if (stopKind !== 'budget-exhausted') controller.abort(reason);
  };
  const externalAbort = (): void => setStop('cancelled', 'external-cancellation');
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener('abort', externalAbort, { once: true });
  const events = new RuntimeEventEmitter<
    EvaluationRuntimeEventKind,
    'run' | 'evaluation' | 'attempt',
    EvaluationTerminalEventKind
  >(
    ports.clock,
    ports.eventSequencer,
    ports.eventWriter,
    {
      runId: options.runId,
      writerMode: plan.measurementPolicy.eventDelivery.writerMode,
      writerFailureMode: plan.measurementPolicy.eventDelivery.writerFailureMode,
      writerFailureReason: 'evaluation-event-writer-failed',
      writerFailureError: {
        code: 'evaluation-event-writer-failed',
        stage: 'infrastructure',
        message: 'Evaluation EventWriter failed under fail-run policy.',
      },
      recoveryEventKinds: [
        'evaluation.run.completed',
        'evaluation.run.cancelled',
        'evaluation.run.budget-exhausted',
        'evaluation.run.failed',
      ],
    },
    stream,
    (reason: string, error: EvaluationError) => setStop('failed', reason, error),
  );
  const sessions = new RunResourceSessions<EvaluatorBinding, EvaluationEvaluatorRun>(
    (binding) => binding.evaluator.evaluatorId,
    (binding) => binding.port.openRun(deepFreeze(snapshotJson({
      runId: options.runId,
      evaluationPlanDigest: plan.evaluation.evaluationPlanDigest as Sha256Digest,
    }))),
  );
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
      const runStarted = await events.emit('evaluation.run.started', 'run', options.runId, {
      evaluationPlanDigest: plan.evaluation.evaluationPlanDigest,
      executionBundleDigest: prepared.source.bundle.bundleDigest,
      planned: coordinates.length,
    });
    if (!runStarted || stop.stopKind !== undefined) {
      throw new EvaluationAttemptCancelledError();
    }
    const preparedCoordinates = await prepareEvaluationCoordinates(
      plan,
      ports,
      prepared,
      coordinates,
      controller.signal,
      () => stop.stopKind !== undefined,
    );
    for (const item of preparedCoordinates) {
      if (stop.stopKind !== undefined) break;
      if (!('reasonCode' in item)) continue;
      const record = notEvaluatedRecord(
        plan,
        item.binding,
        item.coordinate,
        item.reasonCode,
        ports.clock.timestamp(),
        minimumTrust([
          effectiveExecutionBundleTrust(prepared.source),
          item.source?.provenance.trust ?? effectiveExecutionBundleTrust(prepared.source),
        ], 'verified'),
        item.source,
      );
      records.set(record.evaluationId, record);
      const delivered = await events.emit(
        'evaluation.record.not-evaluated',
        'evaluation',
        item.coordinate.evaluationId,
        {
          reasonCode: record.notEvaluatedReasonCode,
        },
      );
      if (!delivered) break;
    }
    const eligibleCoordinates = preparedCoordinates.filter(
      (item): item is EligibleCoordinate => !('reasonCode' in item),
    );
    const width = plan.evaluation.policy.runtime.maxConcurrency;
    const granularity = plan.measurementPolicy.eventDelivery.progressGranularity ?? 'per-batch';
    const total = coordinates.length;
    const runtimePolicy = plan.evaluation.policy.runtime;
    const progressMetadata = {
      maxConcurrency: width,
      retry: {
        maxAttempts: runtimePolicy.retry.maxAttempts,
        retryableErrorCodes: [...runtimePolicy.retry.retryableErrorCodes],
      },
      ...(runtimePolicy.timeoutMs === undefined ? {} : { timeoutMs: runtimePolicy.timeoutMs }),
    };
    // A record already settled as not-evaluated still consumes one unit of planned work.
    let completed = records.size;
    let failed = [...records.values()].filter(
      (record) => record.evaluationStatus === 'failed',
    ).length;
    const emitProgress = async () => {
      if (granularity === 'start-end-only') return true;
      return events.emit('evaluation.run.progress', 'run', options.runId, {
        completed,
        total,
        failed,
        ...progressMetadata,
      });
    };
    for (let offset = 0;
      offset < eligibleCoordinates.length && stop.stopKind === undefined;
      offset += width) {
      const batch = eligibleCoordinates.slice(offset, offset + width);
      const results = await Promise.all(batch.map((coordinate) => evaluateCoordinate(
        plan,
        ports,
        sessions,
        events,
        budget,
        coordinate,
        controller.signal,
        setStop,
      )));
      let batchFailures = 0;
      let progressFailed = false;
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const record = result.record;
        if (record !== undefined && !records.has(record.evaluationId)) {
          completed += 1;
          if (record.evaluationStatus === 'failed') failed += 1;
        }
        if (record !== undefined) records.set(record.evaluationId, record);
        if (result.cacheEntry !== undefined) pendingCache.push(result.cacheEntry);
        if (result.verifiedCacheRecordDigest !== undefined) {
          verifiedCacheRecordDigests.add(result.verifiedCacheRecordDigest);
        }
        if (record !== undefined && record.evaluationStatus === 'failed') batchFailures += 1;
        // Progress is a projection: a dead EventWriter must never drop a settled record here,
        // because finalization would otherwise rewrite that coordinate as not-evaluated evidence.
        if (granularity === 'per-coordinate' && !progressFailed) {
          progressFailed = !(await emitProgress());
        }
      }
      const totalFailures = failed;
      if (granularity === 'per-batch' && !progressFailed) {
        progressFailed = !(await emitProgress());
      }
      const policy = plan.evaluation.policy.failure;
      if (stop.stopKind === undefined && policy.failureMode === 'fail-fast' && batchFailures > 0) {
        setStop('failed', 'evaluation-failure-policy-fail-fast');
      } else if (stop.stopKind === undefined
          && policy.failureMode === 'failure-threshold'
          && totalFailures > (policy.maxFailures ?? 0)) {
        setStop('failed', 'evaluation-failure-policy-threshold');
      }
      if (progressFailed) break;
    }
    } catch (error) {
      if (!(error instanceof EvaluationAttemptCancelledError
          && stop.stopKind !== undefined)) {
        setStop('failed', 'evaluation-runtime-internal-failed', safeError(error));
      }
    } finally {
      wallClockController.abort();
      await wallClockTimer;
      options.signal?.removeEventListener('abort', externalAbort);
      if (await sessions.dispose()) {
        setStop('failed', 'evaluator-run-dispose-failed', {
          code: 'evaluator-run-dispose-failed',
          stage: 'infrastructure',
          message: 'Evaluator run resource disposal failed.',
        });
      }
      if (stop.stopKind === undefined) {
        for (const entry of pendingCache.sort((left, right) => (
          compareStrings(left.cacheKeyDigest, right.cacheKeyDigest)
        ))) {
          try { await ports.cache?.put(entry); } catch {
            setStop('failed', 'evaluation-cache-write-failed', {
              code: 'evaluation-cache-write-failed',
              stage: 'infrastructure',
              message: 'Evaluation cache write failed.',
            });
            break;
          }
        }
      }
    }
    const sourceByTrial = new Map(
      prepared.source.bundle.records.map((record) => [trialKey(record), record]),
    );
    for (const coordinate of coordinates) {
      if (records.has(coordinate.evaluationId)) continue;
      const source = sourceByTrial.get(trialKey(coordinate));
      if (source !== undefined && source.executionStatus !== 'budget-censored') continue;
      const binding = prepared.bindings.get(coordinate.evaluatorId);
      if (binding === undefined) throw new Error('Evaluator binding disappeared');
      const record = notEvaluatedRecord(
        plan,
        binding,
        coordinate,
        source === undefined
          ? 'execution-record-unavailable'
          : 'execution-budget-censored',
        ports.clock.timestamp(),
        minimumTrust([
          effectiveExecutionBundleTrust(prepared.source),
          source?.provenance.trust ?? effectiveExecutionBundleTrust(prepared.source),
        ], 'verified'),
        source,
      );
      records.set(record.evaluationId, record);
      await events.emit(
        'evaluation.record.not-evaluated',
        'evaluation',
        coordinate.evaluationId,
        { reasonCode: record.notEvaluatedReasonCode },
      );
    }
    let source = makeBundle(
      plan,
      prepared.source,
      options,
      [...records.values()],
      coordinates.length,
      stop,
      verifiedCacheRecordDigests,
    );
    const terminalDelivered = await events.emit(
      terminalKind(source.bundle.evaluationBundleStatus),
      'run',
      options.runId,
      {
      bundleDigest: source.bundle.bundleDigest,
      evaluationBundleStatus: source.bundle.evaluationBundleStatus,
      coverage: source.bundle.coverage,
      },
    );
    if (!terminalDelivered) {
      source = makeBundle(
        plan,
        prepared.source,
        options,
        [...records.values()],
        coordinates.length,
        stop,
        verifiedCacheRecordDigests,
      );
      await events.emitRecovery(
        terminalKind(source.bundle.evaluationBundleStatus),
        'run',
        options.runId,
        {
          bundleDigest: source.bundle.bundleDigest,
          evaluationBundleStatus: source.bundle.evaluationBundleStatus,
          coverage: source.bundle.coverage,
        },
      );
    }
    return source;
  } finally {
    events.close();
  }
}

export function startEvaluation(
  plan: SealedRunPlan,
  source: ExecutionBundleSource,
  ports: EvaluationRuntimePorts,
  options: EvaluationRunOptions,
): EvaluationRun {
  const runtimeOptions: ResolvedEvaluationRunOptions = options.budgetSource === undefined
    ? {
      ...options,
      budgetSource: createRunBudgetSource(
        plan,
        options.runId,
        ports.clock,
        source.bundle.budgetSummary,
        'authenticated-stage-handoff',
      ),
    }
    : { ...options, budgetSource: options.budgetSource };
  assertRunBudgetSource(runtimeOptions.budgetSource, plan, runtimeOptions.runId);
  const prepared = prepareRuntime(plan, source, ports, runtimeOptions);
  const stream = new BoundedEventStream(options.eventBufferCapacity ?? DEFAULT_EVENT_BUFFER_CAPACITY);
  const verified = runEvaluation(plan, ports, runtimeOptions, prepared, stream);
  let result: Promise<EvaluationBundle> | undefined;
  return {
    events: stream,
    source: verified,
    budgetSource: runtimeOptions.budgetSource,
    get result() {
      result ??= verified.then((sourceResult) => sourceResult.bundle);
      return result;
    },
  };
}
