import {
  type EvaluationResult,
  type EvaluationRunOptions,
  type EventObserver,
} from './contracts.js';
import {
  type EvaluationEvent,
  type ExecutionBundleSource,
  type EvaluationBundleSource,
  type AnalysisBundleSource,
  type DecisionResultSource,
} from '../../eval-core/contracts/index.js';
import {
  materializeAuthenticatedEvaluationRunResult,
  EvaluationStageSessionError,
  type EvaluationStageSessionErrorCode,
  type AdvancedPreparedEvaluation as CoreAdvancedPreparedEvaluation,
} from '../../eval-core/engine/index.js';
import {
  ExecutionRuntimeConfigurationError,
} from '../../eval-core/execution/types.js';
import {
  EvaluationRuntimeConfigurationError,
} from '../../eval-core/evaluation/types.js';
import {
  AnalysisRuntimeConfigurationError,
} from '../../eval-core/analysis/types.js';
import {
  configurationFailure,
  EvaluationConfigurationError,
  type EvaluationFailureOrigin,
  EvaluationEventConsumptionError,
} from './errors.js';
import {
  attachDefinition,
} from './result-state.js';
import {
  assertEventWriterDelivery,
} from './prepare.js';
import {
  randomUUID,
} from 'node:crypto';

/** @internal A stage-session invariant the Runtime itself broke; no host input should reach it. */
export class StageInvariantViolation extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'StageInvariantViolation';
  }
}

const STABLE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Codes that describe how the caller opened the stage session, not how OMK drove it. */
const CALLER_STAGE_SESSION_CODES: readonly EvaluationStageSessionErrorCode[] = [
  'EVALUATION_STAGE_SESSION_RUN_ID_INVALID',
  'EVALUATION_STAGE_SESSION_RUN_ID_ACTIVE',
  'EVALUATION_STAGE_SESSION_EVENT_BUFFER_CAPACITY_INVALID',
];

type StageFailureReport = Readonly<{
  message: string;
  origin: EvaluationFailureOrigin;
}>;

function configurationReport(
  boundary: string,
  code: string,
): StageFailureReport {
  return {
    message: `${boundary} 因 Run 配置错误失败关闭。`,
    origin: STABLE_ERROR_CODE.test(code)
      ? { failureKind: 'configuration', code }
      : { failureKind: 'configuration' },
  };
}

function invariantReport(boundary: string): StageFailureReport {
  return {
    message: `${boundary} 命中 OMK 内部不变量失败。`,
    origin: { failureKind: 'invariant' },
  };
}

/**
 * @internal Maps one caught stage failure onto the redacted report of the public boundary that
 * reports it. The public code stays the boundary's own; diagnosability comes from a per-origin
 * sentence plus a `cause` that carries only a stable Core code.
 */
export function describeStageFailure(
  failure: unknown,
  boundary: string,
): StageFailureReport {
  if (failure instanceof EvaluationStageSessionError) {
    return CALLER_STAGE_SESSION_CODES.includes(failure.code)
      ? configurationReport(boundary, failure.code)
      : invariantReport(boundary);
  }
  if (failure instanceof ExecutionRuntimeConfigurationError
      || failure instanceof EvaluationRuntimeConfigurationError
      || failure instanceof AnalysisRuntimeConfigurationError) {
    return configurationReport(boundary, failure.code);
  }
  if (failure instanceof StageInvariantViolation) {
    return invariantReport(boundary);
  }
  return {
    message: `${boundary} 无法完成。`,
    origin: { failureKind: 'unknown' },
  };
}

interface StageEventConsumerState {
  observerFailed: boolean;
  observerFailure?: unknown;
  streamFailed: boolean;
  streamFailure?: unknown;
}

export function createStageEventConsumer(
  observer: EventObserver | undefined,
  controller: AbortController,
) {
  const state: StageEventConsumerState = {
    observerFailed: false,
    streamFailed: false,
  };
  let draining = Promise.resolve();
  return Object.freeze({
    state,
    enqueue(events: AsyncIterable<EvaluationEvent>): void {
      draining = draining.then(async () => {
        try {
          for await (const event of events) {
            if (observer === undefined || state.observerFailed) continue;
            try {
              await observer(event);
            } catch (error) {
              state.observerFailed = true;
              state.observerFailure = error;
            }
          }
        } catch (error) {
          if (!state.streamFailed) {
            state.streamFailed = true;
            state.streamFailure = error;
            controller.abort(error);
          }
        }
      });
    },
    async wait(): Promise<void> {
      await draining;
    },
  });
}

/** @internal The authenticated prefix one suffix run may reuse; scoring needs only execution. */
export interface ReusableStagePrefix {
  readonly execution: ExecutionBundleSource;
  readonly evaluation?: EvaluationBundleSource;
  readonly analysis?: AnalysisBundleSource;
}

/** @internal One run identity per stage session; the caller keeps control through `runId`. */
export function stageRunId(options: Readonly<EvaluationRunOptions>): string {
  return options.runId ?? `run-${randomUUID()}`;
}

/** @internal One opened stage session, its bounded event consumer and idempotent teardown. */
export interface StageSessionHandle {
  readonly session: ReturnType<CoreAdvancedPreparedEvaluation['stages']>;
  readonly consumer: ReturnType<typeof createStageEventConsumer>;
  close(): Promise<void>;
}

/**
 * @internal Opens one stage session and forwards the caller's cancellation into it.
 * A session that fails to open leaves no listener behind on the caller's signal.
 */
export function openStageSession(
  prepared: CoreAdvancedPreparedEvaluation,
  options: Readonly<EvaluationRunOptions>,
  runId: string,
): StageSessionHandle {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const consumer = createStageEventConsumer(options.onEvent, controller);
  let session: StageSessionHandle['session'];
  try {
    session = prepared.stages({
      runId,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      signal: controller.signal,
      ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
      ...(options.summaries === undefined ? {} : { summaries: options.summaries }),
      ...(options.eventWriter === undefined ? {} : { eventWriter: options.eventWriter }),
      ...(options.eventBufferCapacity === undefined
        ? {}
        : { eventBufferCapacity: options.eventBufferCapacity }),
    });
  } catch (error) {
    options.signal?.removeEventListener('abort', abortFromCaller);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    session,
    consumer,
    close() {
      closePromise ??= (async () => {
        await session.close();
        await consumer.wait();
        options.signal?.removeEventListener('abort', abortFromCaller);
      })();
      return closePromise;
    },
  };
}

/**
 * Runs Evaluation onward from one authenticated prefix inside a single stage session.
 * A suffix failure never changes measurement semantics: it is re-reported under the calling
 * boundary's code with a redacted origin, and event-consumption failure keeps the Core end state.
 */
export async function runSuffixStages(
  prepared: CoreAdvancedPreparedEvaluation,
  prefix: Readonly<ReusableStagePrefix>,
  options: Readonly<EvaluationRunOptions>,
  boundary: string,
): Promise<EvaluationResult> {
  assertEventWriterDelivery(prepared.plan, options);
  const runId = stageRunId(options);
  let opened: StageSessionHandle | undefined;
  let result: EvaluationResult | undefined;
  let stageFailure: unknown;
  try {
    opened = openStageSession(prepared, options, runId);
    const { session, consumer } = opened;
    const execution = prefix.execution;
    let evaluation = prefix.evaluation;
    if (evaluation === undefined) {
      const evaluationRun = session.evaluate({ execution });
      consumer.enqueue(evaluationRun.events);
      evaluation = await evaluationRun.source;
    }
    if (evaluation === undefined) {
      throw new StageInvariantViolation('Evaluation stage source is unavailable.');
    }
    let analysis = prefix.analysis;
    if (analysis === undefined) {
      const analysisRun = session.analyze({ execution, evaluation });
      consumer.enqueue(analysisRun.events);
      analysis = await analysisRun.source;
    }
    if (analysis === undefined) {
      throw new StageInvariantViolation('Analysis stage source is unavailable.');
    }
    const decisionRun = session.decide({ execution, evaluation, analysis });
    consumer.enqueue(decisionRun.events);
    const decision: DecisionResultSource | undefined = await decisionRun.source;
    const reportRun = session.materializeReport({
      execution,
      evaluation,
      analysis,
      ...(decision === undefined ? {} : { decision }),
    });
    consumer.enqueue(reportRun.events);
    const report = await reportRun.result;
    const coreResult = materializeAuthenticatedEvaluationRunResult({
      plan: prepared.plan,
      execution,
      evaluation,
      analysis,
      ...(decision === undefined ? {} : { decision }),
      report,
    });
    result = attachDefinition(coreResult, runId, prepared.plan);
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    stageFailure = error;
  } finally {
    await opened?.close();
  }
  if (stageFailure !== undefined || result === undefined) {
    const report = describeStageFailure(stageFailure, boundary);
    return configurationFailure(
      'EVAL_RUNTIME_REUSE_INVALID',
      report.message,
      report.origin,
    );
  }
  const consumer = opened?.consumer;
  if (consumer?.state.observerFailed) {
    throw new EvaluationEventConsumptionError({
      code: 'EVAL_RUNTIME_EVENT_OBSERVER_FAILED',
      message: 'Evaluation event observer 执行失败；评测保持 Core 终态并完成清理。',
      runResult: result,
    });
  }
  if (consumer?.state.streamFailed) {
    throw new EvaluationEventConsumptionError({
      code: 'EVAL_RUNTIME_EVENT_STREAM_FAILED',
      message: 'Evaluation event stream 消费失败；评测已取消并完成清理。',
      runResult: result,
    });
  }
  return result;
}
