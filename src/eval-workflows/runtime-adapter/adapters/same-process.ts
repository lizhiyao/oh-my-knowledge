import {
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type RuntimeIdentity,
  type Sha256Digest,
} from '../../../evaluation-core/contracts/index.js';
import type {
  EvaluationEvaluator,
  EvaluationEvaluatorRecord,
  EvaluationEvaluatorRun,
  EvaluatorAttemptContext,
  EvaluatorAttemptResult,
  EvaluatorRecordContext,
  EvaluatorRunContext,
} from '../../../evaluation-core/evaluation/index.js';
import type {
  ExecutionExecutor,
  ExecutionExecutorRun,
  ExecutionExecutorTrial,
  ExecutorAttemptContext,
  ExecutorAttemptResult,
  ExecutorRunContext,
  ExecutorTrialContext,
} from '../../../evaluation-core/execution/index.js';
import type {
  OmkBindingResourceLease,
  OmkBindingResourceLeaseAccess,
} from '../resource-leases/types.js';

type MaybePromise<Value> = Value | Promise<Value>;

export interface SameProcessRunScope {
  readonly sessionIsolationKey: string;
  readonly runIsolationKey: Sha256Digest;
}

export interface SameProcessOperationScope extends SameProcessRunScope {
  readonly operationIsolationKey: Sha256Digest;
}

export interface SameProcessExecutorImplementation<RunState, TrialState> {
  openRun(context: Readonly<{
    run: Readonly<ExecutorRunContext>;
    scope: SameProcessRunScope;
    resources: OmkBindingResourceLease;
  }>): MaybePromise<RunState>;
  openTrial(context: Readonly<{
    run: Readonly<ExecutorRunContext>;
    runState: RunState;
    trial: Readonly<ExecutorTrialContext>;
    scope: SameProcessOperationScope;
    resources: OmkBindingResourceLease;
  }>): MaybePromise<TrialState>;
  execute(context: Readonly<{
    run: Readonly<ExecutorRunContext>;
    runState: RunState;
    trial: Readonly<ExecutorTrialContext>;
    trialState: TrialState;
    attempt: Readonly<ExecutorAttemptContext>;
    scope: SameProcessOperationScope;
    resources: OmkBindingResourceLease;
  }>): Promise<ExecutorAttemptResult>;
  disposeTrial(context: Readonly<{
    run: Readonly<ExecutorRunContext>;
    runState: RunState;
    trial: Readonly<ExecutorTrialContext>;
    trialState: TrialState;
    scope: SameProcessOperationScope;
    resources: OmkBindingResourceLease;
  }>): MaybePromise<void>;
  disposeRun(context: Readonly<{
    run: Readonly<ExecutorRunContext>;
    runState: RunState;
    scope: SameProcessRunScope;
    resources: OmkBindingResourceLease;
  }>): MaybePromise<void>;
}

export interface SameProcessEvaluatorImplementation<RunState, RecordState> {
  openRun(context: Readonly<{
    run: Readonly<EvaluatorRunContext>;
    scope: SameProcessRunScope;
    resources: OmkBindingResourceLease;
  }>): MaybePromise<RunState>;
  openRecord(context: Readonly<{
    run: Readonly<EvaluatorRunContext>;
    runState: RunState;
    record: Readonly<EvaluatorRecordContext>;
    scope: SameProcessOperationScope;
    resources: OmkBindingResourceLease;
  }>): MaybePromise<RecordState>;
  evaluate(context: Readonly<{
    run: Readonly<EvaluatorRunContext>;
    runState: RunState;
    record: Readonly<EvaluatorRecordContext>;
    recordState: RecordState;
    attempt: Readonly<EvaluatorAttemptContext>;
    scope: SameProcessOperationScope;
    resources: OmkBindingResourceLease;
  }>): Promise<EvaluatorAttemptResult>;
  disposeRecord(context: Readonly<{
    run: Readonly<EvaluatorRunContext>;
    runState: RunState;
    record: Readonly<EvaluatorRecordContext>;
    recordState: RecordState;
    scope: SameProcessOperationScope;
    resources: OmkBindingResourceLease;
  }>): MaybePromise<void>;
  disposeRun(context: Readonly<{
    run: Readonly<EvaluatorRunContext>;
    runState: RunState;
    scope: SameProcessRunScope;
    resources: OmkBindingResourceLease;
  }>): MaybePromise<void>;
}

export interface CreateSameProcessExecutorAdapterInput<RunState, TrialState> {
  readonly identity: RuntimeIdentity;
  readonly sessionIsolationKey: string;
  readonly resourceLeases: OmkBindingResourceLeaseAccess;
  readonly implementation: SameProcessExecutorImplementation<RunState, TrialState>;
}

export interface CreateSameProcessEvaluatorAdapterInput<RunState, RecordState> {
  readonly identity: RuntimeIdentity;
  readonly sessionIsolationKey: string;
  readonly resourceLeases: OmkBindingResourceLeaseAccess;
  readonly implementation: SameProcessEvaluatorImplementation<RunState, RecordState>;
}

function captureIdentity(identity: RuntimeIdentity): RuntimeIdentity {
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse(structuredClone(identity)));
}

function assertSessionIsolationKey(value: string): void {
  if (value.trim() === '') {
    throw new TypeError('Same-process adapter requires a non-empty sessionIsolationKey.');
  }
}

function runScope(sessionIsolationKey: string, runId: string): SameProcessRunScope {
  return Object.freeze({
    sessionIsolationKey,
    runIsolationKey: digestCanonicalJson({
      derivation: 'omk.same-process-run-isolation/v1',
      sessionIsolationKey,
      runId,
    }),
  });
}

function operationScope(
  scope: SameProcessRunScope,
  operationKind: 'trial' | 'evaluation-record',
  operationId: Sha256Digest,
): SameProcessOperationScope {
  return Object.freeze({
    ...scope,
    operationIsolationKey: digestCanonicalJson({
      derivation: 'omk.same-process-operation-isolation/v1',
      runIsolationKey: scope.runIsolationKey,
      operationKind,
      operationId,
    }),
  });
}

function once(callback: () => MaybePromise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => {
    if (result === undefined) {
      try {
        result = Promise.resolve(callback());
      } catch (error) {
        result = Promise.reject(error);
      }
    }
    return result;
  };
}

function bindMethod<Arguments extends readonly unknown[], Result>(
  owner: object,
  method: (...arguments_: Arguments) => Result,
): (...arguments_: Arguments) => Result {
  if (typeof method !== 'function') {
    throw new TypeError('Same-process adapter requires every lifecycle callback.');
  }
  return (...arguments_) => Reflect.apply(method, owner, arguments_) as Result;
}

/**
 * Bridges a binding-local in-process implementation into the Core Executor port.
 * Core remains the only owner of retries, timeouts, budgets, and cancellation.
 */
export function createSameProcessExecutorAdapter<RunState, TrialState>(
  input: Readonly<CreateSameProcessExecutorAdapterInput<RunState, TrialState>>,
): ExecutionExecutor {
  assertSessionIsolationKey(input.sessionIsolationKey);
  const identity = captureIdentity(input.identity);
  const sessionIsolationKey = input.sessionIsolationKey;
  const resolveResources = bindMethod(input.resourceLeases, input.resourceLeases.forRun);
  const implementation = Object.freeze({
    openRun: bindMethod(input.implementation, input.implementation.openRun),
    openTrial: bindMethod(input.implementation, input.implementation.openTrial),
    execute: bindMethod(input.implementation, input.implementation.execute),
    disposeTrial: bindMethod(input.implementation, input.implementation.disposeTrial),
    disposeRun: bindMethod(input.implementation, input.implementation.disposeRun),
  });
  const activeRuns = new Set<string>();

  return Object.freeze({
    identity,
    async openRun(run: Readonly<ExecutorRunContext>): Promise<ExecutionExecutorRun> {
      if (activeRuns.has(run.runId)) {
        throw new TypeError(`Same-process Executor already owns run "${run.runId}".`);
      }
      activeRuns.add(run.runId);
      const scope = runScope(sessionIsolationKey, run.runId);
      const activeTrials = new Set<Sha256Digest>();
      let runDisposed = false;
      const releaseRunReservation = (): void => {
        if (runDisposed && activeTrials.size === 0) activeRuns.delete(run.runId);
      };
      let resources: OmkBindingResourceLease;
      let runState: RunState;
      try {
        resources = resolveResources(run.runId);
        runState = await implementation.openRun(Object.freeze({ run, scope, resources }));
      } catch (error) {
        activeRuns.delete(run.runId);
        throw error;
      }
      const disposeRun = once(async () => {
        runDisposed = true;
        try {
          await implementation.disposeRun(Object.freeze({ run, runState, scope, resources }));
        } finally {
          releaseRunReservation();
        }
      });

      return Object.freeze({
        async openTrial(trial: Readonly<ExecutorTrialContext>): Promise<ExecutionExecutorTrial> {
          if (runDisposed) {
            throw new TypeError('Same-process Executor run is already disposed.');
          }
          if (activeTrials.has(trial.trialId)) {
            throw new TypeError(`Same-process Executor already owns trial "${trial.trialId}".`);
          }
          activeTrials.add(trial.trialId);
          const trialScope = operationScope(scope, 'trial', trial.trialId);
          let trialState: TrialState;
          try {
            trialState = await implementation.openTrial(Object.freeze({
              run,
              runState,
              trial,
              scope: trialScope,
              resources,
            }));
          } catch (error) {
            activeTrials.delete(trial.trialId);
            releaseRunReservation();
            throw error;
          }
          let trialDisposed = false;
          const disposeTrial = once(async () => {
            trialDisposed = true;
            try {
              await implementation.disposeTrial(Object.freeze({
                run,
                runState,
                trial,
                trialState,
                scope: trialScope,
                resources,
              }));
            } finally {
              activeTrials.delete(trial.trialId);
              releaseRunReservation();
            }
          });
          return Object.freeze({
            execute: async (attempt: Readonly<ExecutorAttemptContext>) => {
              if (runDisposed || trialDisposed) {
                throw new TypeError('Same-process Executor trial is already disposed.');
              }
              return implementation.execute(Object.freeze({
                run,
                runState,
                trial,
                trialState,
                attempt,
                scope: trialScope,
                resources,
              }));
            },
            dispose: disposeTrial,
          });
        },
        dispose: disposeRun,
      });
    },
  });
}

/**
 * Bridges a binding-local in-process implementation into the Core Evaluator port.
 * Returned observations and optional usage stay untouched for Core validation.
 */
export function createSameProcessEvaluatorAdapter<RunState, RecordState>(
  input: Readonly<CreateSameProcessEvaluatorAdapterInput<RunState, RecordState>>,
): EvaluationEvaluator {
  assertSessionIsolationKey(input.sessionIsolationKey);
  const identity = captureIdentity(input.identity);
  const sessionIsolationKey = input.sessionIsolationKey;
  const resolveResources = bindMethod(input.resourceLeases, input.resourceLeases.forRun);
  const implementation = Object.freeze({
    openRun: bindMethod(input.implementation, input.implementation.openRun),
    openRecord: bindMethod(input.implementation, input.implementation.openRecord),
    evaluate: bindMethod(input.implementation, input.implementation.evaluate),
    disposeRecord: bindMethod(input.implementation, input.implementation.disposeRecord),
    disposeRun: bindMethod(input.implementation, input.implementation.disposeRun),
  });
  const activeRuns = new Set<string>();

  return Object.freeze({
    identity,
    async openRun(run: Readonly<EvaluatorRunContext>): Promise<EvaluationEvaluatorRun> {
      if (activeRuns.has(run.runId)) {
        throw new TypeError(`Same-process Evaluator already owns run "${run.runId}".`);
      }
      activeRuns.add(run.runId);
      const scope = runScope(sessionIsolationKey, run.runId);
      const activeRecords = new Set<Sha256Digest>();
      let runDisposed = false;
      const releaseRunReservation = (): void => {
        if (runDisposed && activeRecords.size === 0) activeRuns.delete(run.runId);
      };
      let resources: OmkBindingResourceLease;
      let runState: RunState;
      try {
        resources = resolveResources(run.runId);
        runState = await implementation.openRun(Object.freeze({ run, scope, resources }));
      } catch (error) {
        activeRuns.delete(run.runId);
        throw error;
      }
      const disposeRun = once(async () => {
        runDisposed = true;
        try {
          await implementation.disposeRun(Object.freeze({ run, runState, scope, resources }));
        } finally {
          releaseRunReservation();
        }
      });

      return Object.freeze({
        async openRecord(
          record: Readonly<EvaluatorRecordContext>,
        ): Promise<EvaluationEvaluatorRecord> {
          if (runDisposed) {
            throw new TypeError('Same-process Evaluator run is already disposed.');
          }
          if (activeRecords.has(record.evaluationId)) {
            throw new TypeError(
              `Same-process Evaluator already owns record "${record.evaluationId}".`,
            );
          }
          activeRecords.add(record.evaluationId);
          const recordScope = operationScope(
            scope,
            'evaluation-record',
            record.evaluationId,
          );
          let recordState: RecordState;
          try {
            recordState = await implementation.openRecord(Object.freeze({
              run,
              runState,
              record,
              scope: recordScope,
              resources,
            }));
          } catch (error) {
            activeRecords.delete(record.evaluationId);
            releaseRunReservation();
            throw error;
          }
          let recordDisposed = false;
          const disposeRecord = once(async () => {
            recordDisposed = true;
            try {
              await implementation.disposeRecord(Object.freeze({
                run,
                runState,
                record,
                recordState,
                scope: recordScope,
                resources,
              }));
            } finally {
              activeRecords.delete(record.evaluationId);
              releaseRunReservation();
            }
          });
          return Object.freeze({
            evaluate: async (attempt: Readonly<EvaluatorAttemptContext>) => {
              if (runDisposed || recordDisposed) {
                throw new TypeError('Same-process Evaluator record is already disposed.');
              }
              return implementation.evaluate(Object.freeze({
                run,
                runState,
                record,
                recordState,
                attempt,
                scope: recordScope,
                resources,
              }));
            },
            dispose: disposeRecord,
          });
        },
        dispose: disposeRun,
      });
    },
  });
}
