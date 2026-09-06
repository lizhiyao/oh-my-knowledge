import {
  type PreparedEvaluation,
  type EvaluationResult,
  type EventObserver,
  type EvaluateInput,
  type EvaluationRunOptions,
  type AssessComparabilityInput,
  type EvaluationComparabilityAssessment,
} from './contracts.js';
import {
  type Sha256Digest,
  canonicalizeJson,
  type JsonValue,
  type EvaluationSeriesMembership,
  type EvaluationSeriesMemberSource,
  createEvaluationSeriesMemberSource,
  type EvaluationEvent,
  type ExecutionBundleSource,
  type EvaluationBundleSource,
  type AnalysisBundleSource,
  assertExecutionBundleSourceMatchesPlan,
  assertEvaluationBundleSourceMatchesPlan,
  assertAnalysisBundleSourceMatchesPlan,
  type DecisionResultSource,
  type ComparisonScope,
  createComparabilityPolicy,
  COMPARABILITY_POLICY_SCHEMA_VERSION,
  assessComparability as assessCoreComparability,
} from '../../eval-core/contracts/index.js';
import {
  corePreparedEvaluations,
  attachDefinition,
  authenticatedCanonicalRuns,
  type AuthenticatedCanonicalRun,
} from './result-state.js';
import {
  configurationFailure,
  EvaluationConfigurationError,
  EvaluationEventConsumptionError,
} from './errors.js';
import {
  materializeAuthenticatedEvaluationRunResult,
  type AdvancedPreparedEvaluation as CoreAdvancedPreparedEvaluation,
} from '../../eval-core/engine/index.js';
import {
  type SealedRunPlan,
} from '../../eval-core/compiler/index.js';
import {
  prepareEvaluation,
  captureRunOptions,
} from './prepare.js';
import {
  randomUUID,
} from 'node:crypto';

/** @internal Re-admits one serialized result against an exact prepared contract. */
export function restorePreparedEvaluationResult(
  preparedFacade: PreparedEvaluation,
  value: unknown,
  verification: Readonly<{
    verifiedProvenanceBundleDigests: ReadonlySet<Sha256Digest>;
    verifiedCacheRecordDigests: ReadonlySet<Sha256Digest>;
    verifiedPolicyExecutionDigests: ReadonlySet<Sha256Digest>;
  }>,
): EvaluationResult {
  const prepared = corePreparedEvaluations.get(preparedFacade);
  if (prepared === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_REUSE_INVALID',
      'Evaluation prepared capability 无法用于结果恢复。',
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return configurationFailure(
      'EVAL_RUNTIME_REUSE_INVALID',
      'Evaluation stored result 无效。',
    );
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  const runId = candidate.runId;
  const artifacts = candidate.artifacts;
  const report = candidate.report;
  const reportRunId = report !== null && typeof report === 'object' && !Array.isArray(report)
    ? (report as { budgetSummary?: { runId?: unknown } }).budgetSummary?.runId
    : undefined;
  if (typeof runId !== 'string'
      || reportRunId !== runId
      || artifacts === null
      || typeof artifacts !== 'object'
      || Array.isArray(artifacts)
      || report === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_REUSE_INVALID',
      'Evaluation stored result 缺少完整的 canonical artifacts。',
    );
  }
  const artifactRecord = artifacts as Readonly<Record<string, unknown>>;
  try {
    const executionBundle = artifactRecord.execution as Readonly<Record<string, unknown>>;
    const evaluationBundle = artifactRecord.evaluation as Readonly<Record<string, unknown>>;
    const execution = prepared.admitExecutionBundle(
      executionBundle,
      {
        verifiedProvenanceBundleDigests: verification.verifiedProvenanceBundleDigests,
        verifiedCacheRecordDigests: verification.verifiedCacheRecordDigests,
      },
    );
    const evaluation = prepared.admitEvaluationBundle(evaluationBundle, {
      execution,
      verification: {
        verifiedProvenanceBundleDigests: verification.verifiedProvenanceBundleDigests,
        verifiedCacheRecordDigests: verification.verifiedCacheRecordDigests,
      },
    });
    const analysis = prepared.admitAnalysisBundle(artifactRecord.analysis, {
      execution,
      evaluation,
      verification: {
        verifiedProvenanceBundleDigests: verification.verifiedProvenanceBundleDigests,
      },
    });
    const decision = artifactRecord.decision === undefined
      ? undefined
      : prepared.admitDecisionResult(artifactRecord.decision, {
          execution,
          evaluation,
          analysis,
          verification: {
            verifiedPolicyExecutionDigests: verification.verifiedPolicyExecutionDigests,
          },
        });
    const admittedReport = prepared.admitReport(report, {
      execution,
      evaluation,
      analysis,
      ...(decision === undefined ? {} : { decision }),
    });
    const restored = attachDefinition(materializeAuthenticatedEvaluationRunResult({
      plan: prepared.plan,
      execution,
      evaluation,
      analysis,
      ...(decision === undefined ? {} : { decision }),
      report: admittedReport,
    }), runId, prepared.plan);
    if (canonicalizeJson(restored) !== canonicalizeJson(value as JsonValue)) {
      return configurationFailure(
        'EVAL_RUNTIME_REUSE_INVALID',
        'Evaluation stored result 与 canonical Runtime result 不一致。',
      );
    }
    return restored;
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    return configurationFailure(
      'EVAL_RUNTIME_REUSE_INVALID',
      'Evaluation stored result 未通过 Core admission。',
    );
  }
}

/** @internal Admits an exact canonical result as its preregistered Series slot. */
export function createCanonicalEvaluationSeriesMemberSource(
  result: EvaluationResult,
  membership: Readonly<EvaluationSeriesMembership>,
): EvaluationSeriesMemberSource | undefined {
  const authenticated = authenticatedCanonicalRuns.get(result);
  const { execution, evaluation, analysis, decision } = authenticated?.sources ?? {};
  if (authenticated === undefined
      || execution === undefined
      || evaluation === undefined
      || analysis === undefined
      || result.report === undefined
      || canonicalizeJson(authenticated.plan.definition.seriesMembership)
        !== canonicalizeJson(membership)) {
    return undefined;
  }
  return createEvaluationSeriesMemberSource({
    ...membership,
    plan: authenticated.plan,
    execution,
    evaluation,
    analysis,
    ...(decision === undefined ? {} : { decision }),
    report: result.report,
  });
}

type EvaluationReuseKind = 'rescore' | 'reanalyze' | 'redecide';

interface ReuseEventConsumerState {
  observerFailed: boolean;
  observerFailure?: unknown;
  streamFailed: boolean;
  streamFailure?: unknown;
}

function createReuseEventConsumer(
  observer: EventObserver | undefined,
  controller: AbortController,
) {
  const state: ReuseEventConsumerState = {
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

function reuseSource(
  result: EvaluationResult,
): AuthenticatedCanonicalRun {
  const source = authenticatedCanonicalRuns.get(result);
  if (source === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_REUSE_INVALID',
      'Evaluation stage reuse 只接受当前进程由 canonical Runtime 产生的原始 Run result。',
    );
  }
  return source;
}

function assertReusablePrefix(
  reuseKind: EvaluationReuseKind,
  plan: SealedRunPlan,
  source: AuthenticatedCanonicalRun,
): Readonly<{
  execution: ExecutionBundleSource;
  evaluation?: EvaluationBundleSource;
  analysis?: AnalysisBundleSource;
}> {
  const execution = source.sources.execution;
  if (execution === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_REUSE_INVALID',
      'Evaluation source result 缺少可复用的 Execution stage。',
    );
  }
  try {
    if (reuseKind === 'rescore') {
      assertExecutionBundleSourceMatchesPlan(execution, plan);
      return Object.freeze({ execution });
    }
    const evaluation = source.sources.evaluation;
    if (evaluation === undefined) {
      return configurationFailure(
        'EVAL_RUNTIME_REUSE_INVALID',
        'Evaluation source result 缺少可复用的 Evaluation stage。',
      );
    }
    assertEvaluationBundleSourceMatchesPlan(plan, execution, evaluation);
    if (reuseKind === 'reanalyze') {
      return Object.freeze({ execution, evaluation });
    }
    const analysis = source.sources.analysis;
    if (analysis === undefined) {
      return configurationFailure(
        'EVAL_RUNTIME_REUSE_INVALID',
        'Evaluation source result 缺少可复用的 Analysis stage。',
      );
    }
    assertAnalysisBundleSourceMatchesPlan(plan, execution, evaluation, analysis);
    return Object.freeze({ execution, evaluation, analysis });
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    return configurationFailure(
      'EVAL_RUNTIME_REUSE_INVALID',
      'Evaluation source result 与新声明的可复用阶段不一致。',
    );
  }
}

async function runEvaluationSuffix(
  reuseKind: EvaluationReuseKind,
  input: Readonly<EvaluateInput>,
  sourceResult: EvaluationResult,
  options: Readonly<EvaluationRunOptions>,
): Promise<EvaluationResult> {
  const source = reuseSource(sourceResult);
  const preparedFacade = await prepareEvaluation(input);
  if (reuseKind === 'redecide' && preparedFacade.definition.decisionPolicy === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_REUSE_INVALID',
      'redecide() 需要新声明包含 Decision。',
    );
  }
  const prepared = corePreparedEvaluations.get(preparedFacade);
  if (prepared === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_REUSE_INVALID',
      'Evaluation prepared capability 无法用于阶段复用。',
    );
  }
  const prefix = assertReusablePrefix(reuseKind, prepared.plan, source);
  const runId = options.runId ?? `run-${randomUUID()}`;
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const consumer = createReuseEventConsumer(options.onEvent, controller);
  let session: ReturnType<CoreAdvancedPreparedEvaluation['stages']> | undefined;
  let result: EvaluationResult | undefined;
  let stageFailure: unknown;
  try {
    session = prepared.stages({
      runId,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      signal: controller.signal,
      ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
      ...(options.summaries === undefined ? {} : { summaries: options.summaries }),
      ...(options.eventBufferCapacity === undefined
        ? {}
        : { eventBufferCapacity: options.eventBufferCapacity }),
    });
    const execution = prefix.execution;
    let evaluation = prefix.evaluation;
    if (reuseKind === 'rescore') {
      const evaluationRun = session.evaluate({ execution });
      consumer.enqueue(evaluationRun.events);
      evaluation = await evaluationRun.source;
    }
    if (evaluation === undefined) {
      throw new TypeError('Evaluation stage source is unavailable.');
    }
    let analysis = prefix.analysis;
    if (reuseKind !== 'redecide') {
      const analysisRun = session.analyze({ execution, evaluation });
      consumer.enqueue(analysisRun.events);
      analysis = await analysisRun.source;
    }
    if (analysis === undefined) {
      throw new TypeError('Analysis stage source is unavailable.');
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
    stageFailure = error;
  } finally {
    await session?.close();
    await consumer.wait();
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
  if (stageFailure !== undefined || result === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_REUSE_INVALID',
      'Evaluation stage reuse 无法完成。',
    );
  }
  if (consumer.state.observerFailed) {
    throw new EvaluationEventConsumptionError({
      code: 'EVAL_RUNTIME_EVENT_OBSERVER_FAILED',
      message: 'Evaluation event observer 执行失败；评测保持 Core 终态并完成清理。',
      runResult: result,
    });
  }
  if (consumer.state.streamFailed) {
    throw new EvaluationEventConsumptionError({
      code: 'EVAL_RUNTIME_EVENT_STREAM_FAILED',
      message: 'Evaluation event stream 消费失败；评测已取消并完成清理。',
      runResult: result,
    });
  }
  return result;
}

/** Reuses an authenticated Execution stage and runs Evaluation onward. */
export async function rescore(
  input: Readonly<EvaluateInput>,
  source: EvaluationResult,
  options?: Readonly<EvaluationRunOptions>,
): Promise<EvaluationResult> {
  return runEvaluationSuffix('rescore', input, source, captureRunOptions(options));
}

/** Reuses authenticated Execution and Evaluation stages and runs Analysis onward. */
export async function reanalyze(
  input: Readonly<EvaluateInput>,
  source: EvaluationResult,
  options?: Readonly<EvaluationRunOptions>,
): Promise<EvaluationResult> {
  return runEvaluationSuffix('reanalyze', input, source, captureRunOptions(options));
}

/** Reuses authenticated Execution, Evaluation and Analysis stages and runs Decision onward. */
export async function redecide(
  input: Readonly<EvaluateInput>,
  source: EvaluationResult,
  options?: Readonly<EvaluationRunOptions>,
): Promise<EvaluationResult> {
  return runEvaluationSuffix('redecide', input, source, captureRunOptions(options));
}

function comparabilitySourcePrefix(
  run: AuthenticatedCanonicalRun,
  scope: ComparisonScope,
) {
  return Object.freeze({
    ...(run.sources.execution === undefined ? {} : { execution: run.sources.execution }),
    ...(run.sources.evaluation === undefined ? {} : { evaluation: run.sources.evaluation }),
    ...(scope === 'evaluation' || run.sources.analysis === undefined
      ? {}
      : { analysis: run.sources.analysis }),
    ...(scope !== 'decision' || run.sources.decision === undefined
      ? {}
      : { decision: run.sources.decision }),
  });
}

/**
 * Checks whether two canonical Runs can support an exact cross-Run comparison.
 * Target changes are allowed only when explicitly mapped as subjects.
 */
export function assessComparability(
  input: Readonly<AssessComparabilityInput>,
): EvaluationComparabilityAssessment {
  const allowedKeys = new Set(['comparisonScope', 'subjects', 'left', 'right']);
  if (input === null
      || typeof input !== 'object'
      || Object.keys(input).some((key) => !allowedKeys.has(key))
      || !Array.isArray(input.subjects)) {
    return configurationFailure(
      'EVAL_RUNTIME_COMPARABILITY_INVALID',
      'Evaluation comparability input 无效。',
    );
  }
  const left = authenticatedCanonicalRuns.get(input.left);
  const right = authenticatedCanonicalRuns.get(input.right);
  if (left === undefined || right === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_COMPARABILITY_INVALID',
      'Evaluation comparability 只接受当前进程由 canonical Runtime 产生的 Run result。',
    );
  }
  try {
    const policy = createComparabilityPolicy({
      schemaVersion: COMPARABILITY_POLICY_SCHEMA_VERSION,
      designMode: 'exact-measurement-design',
      comparisonScope: input.comparisonScope,
      subjects: input.subjects.map((subject) => ({
        subjectId: subject.subjectId,
        leftTargetId: subject.leftVariantId,
        rightTargetId: subject.rightVariantId,
      })),
    });
    return assessCoreComparability(
      policy,
      left.plan,
      right.plan,
      comparabilitySourcePrefix(left, input.comparisonScope),
      comparabilitySourcePrefix(right, input.comparisonScope),
    ).assessment;
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_COMPARABILITY_INVALID',
      'Evaluation comparability 无法验证输入、subject mapping 或 source lineage。',
    );
  }
}
