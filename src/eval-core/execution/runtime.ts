import { RunResourceSessions } from '../runtime/run-resources.js';
import { compareStrings } from '../primitives/ordering.js';
import {
  type EvaluationError,
  type ExecutionBundle,
  type ExecutionBundleSource,
  type ExecutionRecord,
  type Sha256Digest,
} from '../contracts/index.js';
import { type SealedRunPlan } from '../compiler/index.js';
import { deepFreeze, snapshotJson } from '../compiler/immutability.js';
import { RuntimeEventEmitter } from '../runtime/events.js';
import { BoundedEventStream, DEFAULT_EVENT_BUFFER_CAPACITY } from '../runtime/event-stream.js';
import { assertRunBudgetSource, createRunBudgetSource, resolveRunBudgetSource } from '../budget/index.js';
import { deriveExecutionSchedule } from './scheduler.js';
import {
  type ExecutionCacheEntry,
  type ExecutionEventKind,
  type ExecutionEventSubjectKind,
  type ExecutionExecutorRun,
  type ExecutionRun,
  type ExecutionRunOptions,
  type ExecutionRuntimePorts,
} from './types.js';
import type {
  ExecutionTerminalEventKind,
  PreparedBlock,
  PreparedRuntime,
  ResolvedExecutionRunOptions,
  StopKind,
  StopState,
  TargetRuntimeBinding,
} from './runtime-state.js';
import {
  censoredRecord,
  coordinateKey,
  executeCoordinate,
  prepareBlock,
} from './coordinate.js';
import { makeBundle } from './bundle.js';
import { prepareRuntime } from './preparation.js';


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
  const sessions = new RunResourceSessions<TargetRuntimeBinding, ExecutionExecutorRun>(
    (binding) => binding.target.targetId,
    (binding) => binding.executor.openRun(deepFreeze(snapshotJson({
      runId: options.runId,
      executionPlanDigest: plan.execution.executionPlanDigest as Sha256Digest,
    }))),
  );
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
      const disposalFailures = await sessions.dispose();
      if (disposalFailures > 0) {
        setStop('failed', 'executor-run-dispose-failed', {
          code: 'executor-run-dispose-failed',
          stage: 'infrastructure',
          message: 'Executor run resource disposal failed.',
        });
      }
      if (disposalFailures === 0 && stop.stopKind === undefined) {
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
  const stream = new BoundedEventStream(options.eventBufferCapacity ?? DEFAULT_EVENT_BUFFER_CAPACITY);
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
