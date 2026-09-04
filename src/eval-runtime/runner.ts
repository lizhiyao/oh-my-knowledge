import type {
  EvaluationDefinition,
  EvaluationEvent,
  JsonValue,
  MeasurementPolicy,
} from '../eval-core/contracts/index.js';
import type {
  EvaluationEngineEventWriter,
  EvaluationEngineRuntime,
  EvaluationRunResult,
} from '../eval-core/engine/index.js';
import { createEvaluationEngine as createCoreEvaluationEngine } from '../eval-core/engine/index.js';

type MaybePromise<Value> = Value | Promise<Value>;

export type EvaluationEventObserver = (
  event: Readonly<EvaluationEvent>,
) => MaybePromise<void>;

export interface RunEvaluationInput {
  readonly runtime: EvaluationEngineRuntime;
  readonly definition: EvaluationDefinition;
  readonly policy: MeasurementPolicy;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly annotations?: JsonValue;
  readonly summaries?: JsonValue;
  readonly eventWriter?: EvaluationEngineEventWriter;
  /**
   * Capacity of the Core progress stream consumed by `onEvent`. When a slow observer falls
   * behind, the bounded stream drops its oldest pending progress event and retains the latest.
   */
  readonly eventBufferCapacity?: number;
  /** Ordered, best-effort progress projection. Durable lossless delivery belongs to `eventWriter`. */
  readonly onEvent?: EvaluationEventObserver;
}

export class EvaluationEventConsumptionError extends Error {
  readonly code:
    | 'EVAL_RUNTIME_EVENT_OBSERVER_FAILED'
    | 'EVAL_RUNTIME_EVENT_STREAM_FAILED';
  readonly runResult?: EvaluationRunResult;
  override readonly cause: unknown;

  constructor(input: Readonly<{
    code: EvaluationEventConsumptionError['code'];
    message: string;
    cause: unknown;
    runResult?: EvaluationRunResult;
  }>) {
    super(input.message);
    this.name = 'EvaluationEventConsumptionError';
    this.code = input.code;
    this.cause = input.cause;
    this.runResult = input.runResult;
  }
}

/**
 * Runs the standard Core pipeline while owning the event-stream consumer.
 * Observer failure never changes measurement; it drains the stream, then rejects with the Core result.
 * A slow observer applies no measurement backpressure: Core's bounded stream retains recent progress
 * and may expose sequence gaps rather than creating an unbounded callback backlog.
 */
export async function runEvaluation(
  input: Readonly<RunEvaluationInput>,
): Promise<EvaluationRunResult> {
  if (input.eventWriter !== undefined
      && input.policy.eventDelivery.writerMode === 'disabled') {
    throw new TypeError(
      'eventWriter requires an explicit optional or required eventDelivery policy.',
    );
  }
  const controller = new AbortController();
  const externalAbort = (): void => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) externalAbort();
  else input.signal?.addEventListener('abort', externalAbort, { once: true });

  const run = createCoreEvaluationEngine(input.runtime).start(input.definition, {
    policy: input.policy,
    runId: input.runId,
    signal: controller.signal,
    ...(input.annotations === undefined ? {} : { annotations: input.annotations }),
    ...(input.summaries === undefined ? {} : { summaries: input.summaries }),
    ...(input.eventWriter === undefined ? {} : { eventWriter: input.eventWriter }),
    ...(input.eventBufferCapacity === undefined
      ? {}
      : { eventBufferCapacity: input.eventBufferCapacity }),
  });

  let observerFailed = false;
  let observerFailure: unknown;
  let streamFailed = false;
  let streamFailure: unknown;
  const draining = (async () => {
    try {
      for await (const event of run.events) {
        if (input.onEvent === undefined || observerFailed) continue;
        try {
          await input.onEvent(event);
        } catch (error) {
          observerFailed = true;
          observerFailure = error;
        }
      }
    } catch (error) {
      streamFailed = true;
      streamFailure = error;
      controller.abort(error);
    }
  })();

  try {
    const [resultOutcome] = await Promise.allSettled([run.result, draining]);
    if (resultOutcome.status === 'rejected') throw resultOutcome.reason;
    const result = resultOutcome.value;
    if (observerFailed) {
      throw new EvaluationEventConsumptionError({
        code: 'EVAL_RUNTIME_EVENT_OBSERVER_FAILED',
        message: 'Evaluation event observer 执行失败；评测保持 Core 终态并完成清理。',
        cause: observerFailure,
        runResult: result,
      });
    }
    if (streamFailed) {
      throw new EvaluationEventConsumptionError({
        code: 'EVAL_RUNTIME_EVENT_STREAM_FAILED',
        message: 'Evaluation event stream 消费失败；评测已取消并完成清理。',
        cause: streamFailure,
        runResult: result,
      });
    }
    return result;
  } finally {
    input.signal?.removeEventListener('abort', externalAbort);
  }
}
