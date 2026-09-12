import {
  type EvaluateInput,
  type EvaluationRunOptions,
  type ExecutedEvaluation,
} from './contracts.js';
import {
  configurationFailure,
  EvaluationEventConsumptionError,
} from './errors.js';
import {
  corePreparedEvaluations,
  executedEvaluations,
} from './result-state.js';
import {
  assertEventWriterDelivery,
  captureRunOptions,
  prepareEvaluation,
} from './prepare.js';
import {
  openStageSession,
  stageRunId,
  type StageSessionHandle,
} from './stage-session.js';
import {
  type Sha256Digest,
} from '../../eval-core/contracts/index.js';
import {
  type AdvancedPreparedEvaluation as CoreAdvancedPreparedEvaluation,
} from '../../eval-core/engine/index.js';

/**
 * @internal One execution-stage session, driven to its end state and always torn down.
 * A rejection keeps Core's own error: this entry adds no reuse prefix, so it redacts nothing.
 */
async function runExecutionStage(
  prepared: CoreAdvancedPreparedEvaluation,
  options: Readonly<EvaluationRunOptions>,
  runId: string,
): Promise<Readonly<{
  executed: ExecutedEvaluation;
  consumer: StageSessionHandle['consumer'];
}>> {
  const opened = openStageSession(prepared, options, runId);
  try {
    const { session, consumer } = opened;
    const executionRun = session.execute();
    consumer.enqueue(executionRun.events);
    const source = await executionRun.source;
    const bundle = source.bundle;
    const executed = Object.freeze({
      runId,
      executionPlanDigest: bundle.executionPlanDigest as Sha256Digest,
      executionInputDigest: bundle.executionInputDigest as Sha256Digest,
      bundle,
      bundleOrigin: 'runtime' as const,
    });
    executedEvaluations.set(executed, { bundle, source });
    return { executed, consumer };
  } finally {
    await opened.close();
  }
}

/**
 * Runs the Execution stage of one complete measurement declaration and stops before any score.
 * The declaration still preregisters its evaluators, analyses and decision, so the sealed
 * execution stage stays byte-identical to the one `evaluate()` produces; only Target calls
 * happen here, and no `Sample.expected` reaches an executor.
 * A partial stop is a value, not an error: `bundle.executionBundleStatus` says so.
 */
export async function executeEvaluation(
  input: Readonly<EvaluateInput>,
  options?: Readonly<EvaluationRunOptions>,
): Promise<ExecutedEvaluation> {
  const captured = captureRunOptions(options);
  const preparedFacade = await prepareEvaluation(input);
  const prepared = corePreparedEvaluations.get(preparedFacade);
  if (prepared === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation prepared capability 无法用于只执行阶段。',
    );
  }
  assertEventWriterDelivery(prepared.plan, captured);
  const { executed, consumer } = await runExecutionStage(
    prepared,
    captured,
    stageRunId(captured),
  );
  if (consumer.state.observerFailed) {
    throw new EvaluationEventConsumptionError({
      code: 'EVAL_RUNTIME_EVENT_OBSERVER_FAILED',
      message: 'Evaluation event observer 执行失败；只执行阶段保持 Core 终态并完成清理。',
      executed,
    });
  }
  if (consumer.state.streamFailed) {
    throw new EvaluationEventConsumptionError({
      code: 'EVAL_RUNTIME_EVENT_STREAM_FAILED',
      message: 'Evaluation event stream 消费失败；只执行阶段已取消并完成清理。',
      executed,
    });
  }
  return executed;
}
