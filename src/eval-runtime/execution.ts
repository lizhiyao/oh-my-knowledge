import {
  IdentifierSchema,
  deepFreezeCanonicalJson,
  type EvaluationDefinition,
  type JsonValue,
  type MeasurementPolicy,
} from '../eval-core/contracts/index.js';
import type { SealedRunPlan } from '../eval-core/compiler/index.js';
import {
  createEvaluationEngine,
  type EvaluationEngineEventWriter,
  type EvaluationEngineRuntime,
  type EvaluationRun,
  type EvaluationRunResult,
} from '../eval-core/engine/index.js';

/** Product compilers supply measurement declarations, never CLI configuration or locators. */
export interface EvaluationExecutionInput {
  readonly definition: EvaluationDefinition;
  readonly policy: MeasurementPolicy;
  readonly annotations?: JsonValue;
  readonly summaries?: JsonValue;
}

export interface EvaluationExecutionOptions {
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly eventBufferCapacity?: number;
}

export interface EvaluationRunAcquisition {
  readonly runId: string;
  readonly plan: SealedRunPlan;
  /** Hosts must stop bounded acquisition work when cancelled and release partial resources. */
  readonly signal: AbortSignal;
}

export interface EvaluationRunLease {
  /** Publish acquired resources to injected ports only when Runtime admits the run. */
  activate?(): void;
  readonly eventWriter?: EvaluationEngineEventWriter;
  /** Release all acquired resources, including after a failed activation. Called once. */
  close(): void | Promise<void>;
}

export interface PreparedEvaluationExecution {
  readonly plan: SealedRunPlan;
  start(options: Readonly<EvaluationExecutionOptions>): Promise<EvaluationRun>;
}

export type EvaluationRuntimeLifecycleErrorCode =
  | 'EVAL_RUNTIME_RUN_ACTIVE'
  | 'EVAL_RUNTIME_RUN_ABORTED_BEFORE_START'
  | 'EVAL_RUNTIME_RUN_LEASE_INVALID'
  | 'EVAL_RUNTIME_RUN_CLEANUP_FAILED';

export class EvaluationRuntimeLifecycleError extends Error {
  readonly code: EvaluationRuntimeLifecycleErrorCode;
  readonly runId: string;
  /** Measurement evidence survives a host cleanup failure without rewriting Core status. */
  readonly runResult?: EvaluationRunResult;
  /** On pre-start cancellation, also observes cleanup of a lease that arrives later. */
  readonly cleanup?: Promise<void>;

  constructor(input: {
    code: EvaluationRuntimeLifecycleErrorCode;
    runId: string;
    message: string;
    cause?: unknown;
    runResult?: EvaluationRunResult;
    cleanup?: Promise<void>;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'EvaluationRuntimeLifecycleError';
    this.code = input.code;
    this.runId = input.runId;
    this.runResult = input.runResult;
    this.cleanup = input.cleanup;
  }
}

/**
 * The host-independent execution seam beneath product and canonical façades.
 * Core alone owns scheduling, retries, timeouts and budgets. Runtime owns acquisition,
 * activation and release; a host cannot accidentally start Core after cancellation.
 */
export function createEvaluationExecution(input: Readonly<{
  runtime: EvaluationEngineRuntime;
  acquireRun?: (request: Readonly<EvaluationRunAcquisition>) => Promise<EvaluationRunLease>;
}>): { prepare(request: Readonly<EvaluationExecutionInput>): Promise<PreparedEvaluationExecution> } {
  const engine = createEvaluationEngine(input.runtime);
  const acquireRun = input.acquireRun?.bind(input);
  const activeRunIds = new Set<string>();
  return Object.freeze({
    async prepare(request: Readonly<EvaluationExecutionInput>): Promise<PreparedEvaluationExecution> {
      const captured = deepFreezeCanonicalJson(structuredClone(request) as unknown as JsonValue
      ) as unknown as EvaluationExecutionInput;
      const prepared = await engine.prepare(captured.definition, captured.policy);
      return Object.freeze({
        plan: prepared.plan,
        async start(options: Readonly<EvaluationExecutionOptions>): Promise<EvaluationRun> {
          const { runId, signal, eventBufferCapacity } = options;
          IdentifierSchema.parse(runId);
          if (eventBufferCapacity !== undefined
              && (!Number.isSafeInteger(eventBufferCapacity) || eventBufferCapacity <= 0)) {
            throw new TypeError('eventBufferCapacity 必须是正安全整数。');
          }
          if (signal !== undefined && (typeof signal.aborted !== 'boolean'
              || typeof signal.addEventListener !== 'function'
              || typeof signal.removeEventListener !== 'function')) {
            throw new TypeError('signal 不符合 AbortSignal 契约。');
          }
          if (activeRunIds.has(runId)) throw new EvaluationRuntimeLifecycleError({
            code: 'EVAL_RUNTIME_RUN_ACTIVE', runId, message: '该 runId 已有正在运行或清理的评测。',
          });
          const controller = new AbortController();
          const forwardAbort = (): void => controller.abort(signal?.reason);
          let rejectAbort: (reason: unknown) => void;
          const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
          // A handler is installed before observing an already-aborted external signal.
          void cancelled.catch(() => {});
          const abortError = new EvaluationRuntimeLifecycleError({
            code: 'EVAL_RUNTIME_RUN_ABORTED_BEFORE_START', runId,
            message: '评测在 Core 启动前已取消。',
          });
          const onAbort = (): void => rejectAbort(abortError);
          controller.signal.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) forwardAbort();
          else signal?.addEventListener('abort', forwardAbort, { once: true });
          activeRunIds.add(runId);
          let lease: EvaluationRunLease | undefined;
          let cleanupPromise: Promise<void> | undefined;
          const detach = (): void => {
            signal?.removeEventListener('abort', forwardAbort);
            controller.signal.removeEventListener('abort', onAbort);
          };
          const cleanup = (): Promise<void> => {
            cleanupPromise ??= Promise.resolve().then(() => lease?.close()).then(() => {});
            return cleanupPromise;
          };
          const acquisition = Promise.resolve().then(async () => {
            controller.signal.throwIfAborted();
            if (acquireRun === undefined) return;
            const acquired = await acquireRun(Object.freeze({
              runId, plan: prepared.plan, signal: controller.signal,
            }));
            if (acquired === null || typeof acquired !== 'object'
                || typeof acquired.close !== 'function') throw new EvaluationRuntimeLifecycleError({
              code: 'EVAL_RUNTIME_RUN_LEASE_INVALID', runId,
              message: '宿主返回的运行租约缺少清理接口。',
            });
            // Capture cleanup first so malformed optional ports still release their resources.
            lease = { close: acquired.close.bind(acquired) };
            if ((acquired.activate !== undefined && typeof acquired.activate !== 'function')
                || (acquired.eventWriter !== undefined
                  && typeof acquired.eventWriter?.write !== 'function')) {
              throw new EvaluationRuntimeLifecycleError({
                code: 'EVAL_RUNTIME_RUN_LEASE_INVALID', runId,
                message: '宿主返回的运行租约端口不合法。',
              });
            }
            lease = Object.freeze({
              close: lease.close,
              ...(acquired.activate === undefined ? {} : { activate: acquired.activate.bind(acquired) }),
              ...(acquired.eventWriter === undefined ? {} : {
                eventWriter: Object.freeze({ write: acquired.eventWriter.write.bind(acquired.eventWriter) }),
              }),
            });
          });
          try {
            await Promise.race([acquisition, cancelled]);
            if (controller.signal.aborted) throw abortError;
            if (lease?.eventWriter !== undefined
                && captured.policy.eventDelivery.writerMode === 'disabled') {
              throw new TypeError('已禁用事件写入的策略不能注入 EventWriter。');
            }
            lease?.activate?.();
            if (controller.signal.aborted) throw abortError;
            const coreRun = prepared.start({
              runId, signal: controller.signal,
              ...(eventBufferCapacity === undefined ? {} : { eventBufferCapacity }),
              ...(captured.annotations === undefined ? {} : { annotations: captured.annotations }),
              ...(captured.summaries === undefined ? {} : { summaries: captured.summaries }),
              ...(lease?.eventWriter === undefined ? {} : { eventWriter: lease.eventWriter }),
            });
            controller.signal.removeEventListener('abort', onAbort);
            const result = coreRun.result.then(async (runResult) => {
              try { await cleanup(); } catch (cause) {
                throw new EvaluationRuntimeLifecycleError({
                  code: 'EVAL_RUNTIME_RUN_CLEANUP_FAILED', runId, runResult, cause,
                  message: '运行资源清理失败；Core 测量结果已保留。',
                });
              }
              return runResult;
            }, async (cause) => {
              try { await cleanup(); } catch (cleanupCause) {
                throw new EvaluationRuntimeLifecycleError({
                  code: 'EVAL_RUNTIME_RUN_CLEANUP_FAILED', runId,
                  cause: new AggregateError([cause, cleanupCause]),
                  message: 'Core 执行异常后，运行资源清理也失败。',
                });
              }
              throw cause;
            }).finally(() => { detach(); activeRunIds.delete(runId); });
            return Object.freeze({ events: coreRun.events, result });
          } catch (cause) {
            detach();
            // Observe a non-cooperative host's late result without delaying cancellation.
            const completion = acquisition.then(cleanup, async (acquisitionCause) => {
              await cleanup();
              // A cooperative abort has no lease. Other late host failures must stay observable,
              // including a host's failure to release partially acquired resources.
              if (controller.signal.aborted && acquisitionCause !== controller.signal.reason) {
                throw acquisitionCause;
              }
            }).catch((cleanupCause) => {
              throw new EvaluationRuntimeLifecycleError({
                code: 'EVAL_RUNTIME_RUN_CLEANUP_FAILED', runId,
                cause: new AggregateError([cause, cleanupCause]),
                message: 'Core 启动前的运行资源清理失败。',
              });
            }).finally(() => { activeRunIds.delete(runId); });
            void completion.catch(() => {});
            if (controller.signal.aborted) throw new EvaluationRuntimeLifecycleError({
              code: 'EVAL_RUNTIME_RUN_ABORTED_BEFORE_START', runId, cause, cleanup: completion,
              message: '评测在 Core 启动前已取消；迟到的租约将被清理。',
            });
            await completion;
            throw cause;
          }
        },
      });
    },
  });
}
