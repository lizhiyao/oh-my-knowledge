/** Coordinate processing, attempts and evidence/cache handling. */
import { durationMs } from '../runtime/clock.js';
import type { RunResourceSessions } from '../runtime/run-resources.js';
import { linkAbortSignal } from '../runtime/abort.js';
import { minimumTrust } from '../primitives/provenance.js';
import { resolveJsonPointer } from '../primitives/json-pointer.js';
import {
  CompletedEvaluationRecordSchema,
  ContentDescriptorSchema,
  EvaluationErrorSchema,
  MetricObservationSchema,
  UsageRecordSchema,
  canonicalizeJson,
  deriveEvaluationAttemptId,
  deriveMetricObservationId,
  digestCanonicalJson,
  mostRestrictiveProviderCostLimit,
  parseWireDocument,
  projectExecutionFacts,
  type CapturedContent,
  type EvaluationAttempt,
  type EvaluationError,
  type EvaluationRecord,
  type ExecutionRecord,
  type JsonValue,
  type MetricObservation,
  type PlannedEvaluationCoordinate,
  type Provenance,
  type RuntimeIdentity,
  type Sha256Digest,
  type UsageRecord,
} from '../contracts/index.js';
import {
  aggregateEvaluationAttemptUsage,
  evaluationRecordMatchesEvidencePolicy,
  evaluationRecordSatisfiesCacheCostPolicy,
  evaluationRecordUsageMatchesAttempts,
} from '../verify/index.js';
import { effectiveExecutionBundleTrust } from '../verify/index.js';
import { deepFreeze, snapshotJson } from '../compiler/immutability.js';
import type { SealedRunPlan } from '../compiler/index.js';
import { EvaluatorCapabilitiesSchema } from '../compiler/index.js';
import type { RuntimeEventEmitter } from '../runtime/events.js';
import { type RunBudgetController } from '../budget/index.js';
import {
  EvaluationPortFailure,
  type EvaluationCacheEntry,
  type EvaluationClock,
  type EvaluationContent,
  type EvaluationEvaluatorRun,
  type EvaluationRuntimeEventKind,
  type EvaluationRuntimePorts,
  type EvaluatorBindingValue,
  type EvaluatorObservation,
} from './types.js';
import type {
  EligibleCoordinate,
  EvaluationTerminalEventKind,
  EvaluatorBinding,
  PreparedRuntime,
  StopKind,
} from './runtime-state.js';


type ActiveRecord = Exclude<EvaluationRecord, { evaluationStatus: 'not-evaluated' }>;
type CompletedRecord = Extract<EvaluationRecord, { evaluationStatus: 'completed' }>;

interface UnavailableCoordinate {
  coordinate: PlannedEvaluationCoordinate;
  binding: EvaluatorBinding;
  source?: ExecutionRecord;
  reasonCode: string;
}

type PreparedCoordinate = EligibleCoordinate | UnavailableCoordinate;

class EvaluationAttemptTimeoutError extends Error {
  constructor() {
    super('Evaluation attempt timed out.');
    this.name = 'EvaluationAttemptTimeoutError';
  }
}

export class EvaluationAttemptCancelledError extends Error {
  constructor() {
    super('Evaluation attempt was cancelled.');
    this.name = 'AbortError';
  }
}

const CLASSIFICATION_LEVEL = { public: 0, sensitive: 1, secret: 2, gold: 3 } as const;

export function trialKey(value: { targetId: string; sampleId: string; trialIndex: number }): string {
  return canonicalizeJson([value.targetId, value.sampleId, value.trialIndex]);
}

export function safeError(error: unknown): EvaluationError {
  if (error instanceof EvaluationAttemptTimeoutError) {
    return {
      code: 'timeout',
      stage: 'evaluation',
      message: 'Evaluator attempt exceeded the sealed timeout.',
    };
  }
  if (error instanceof EvaluationPortFailure) {
    const parsed = EvaluationErrorSchema.safeParse(error.evaluationError);
    if (parsed.success) return {
      code: parsed.data.code,
      stage: parsed.data.stage,
      message: 'Evaluator reported a structured failure.',
    };
    return {
      code: 'evaluator-error-invalid',
      stage: 'infrastructure',
      message: 'Evaluator returned an invalid structured failure.',
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'cancelled', stage: 'infrastructure', message: 'Evaluation was cancelled.' };
  }
  return {
    code: 'evaluator-error',
    stage: 'evaluation',
    message: 'Evaluator failed without a structured EvaluationError.',
  };
}


function validatedUsage(value: UsageRecord | undefined): UsageRecord | undefined {
  if (value === undefined) return undefined;
  const parsed = UsageRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new EvaluationPortFailure({
      code: 'evaluator-usage-invalid',
      stage: 'infrastructure',
      message: 'Evaluator returned an invalid UsageRecord.',
    });
  }
  return parsed.data;
}

function resolvePointer(value: JsonValue, pointer: string): JsonValue {
  const result = resolveJsonPointer(value, pointer);
  if (!result.resolved) throw new TypeError('pointer-unresolved');
  canonicalizeJson(result.value);
  return result.value as JsonValue;
}

async function resolveCaptured(
  content: CapturedContent | undefined,
  ports: EvaluationRuntimePorts,
): Promise<EvaluationContent | undefined> {
  if (content === undefined || content.contentKind === 'digest-only') return undefined;
  if (content.contentKind === 'inline') {
    return { value: snapshotJson(content.value), classification: content.classification };
  }
  if (ports.contentResolver === undefined) return undefined;
  const resolved = await ports.contentResolver.resolve(content.descriptor);
  if (digestCanonicalJson(resolved.value) !== content.descriptor.digest) {
    throw new EvaluationPortFailure({
      code: 'content-digest-mismatch',
      stage: 'infrastructure',
      message: 'Resolved content does not match its descriptor digest.',
    });
  }
  if (resolved.classification !== content.classification) {
    throw new EvaluationPortFailure({
      code: 'content-classification-mismatch',
      stage: 'infrastructure',
      message: 'Resolved content classification differs from its descriptor.',
    });
  }
  if (resolved.mediaType !== undefined
      && resolved.mediaType !== content.descriptor.mediaType) {
    throw new EvaluationPortFailure({
      code: 'content-media-type-mismatch',
      stage: 'infrastructure',
      message: 'Resolved content media type differs from its descriptor.',
    });
  }
  return {
    ...snapshotJson(resolved),
    mediaType: content.descriptor.mediaType,
  };
}

async function materializeBindings(
  plan: SealedRunPlan,
  record: Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>,
  sourceTrust: Provenance['trust'],
  evaluator: SealedRunPlan['evaluation']['evaluators'][number],
  ports: EvaluationRuntimePorts,
  signal: AbortSignal,
  shouldStop: () => boolean,
): Promise<EvaluatorBindingValue[] | undefined> {
  const sample = plan.evaluation.samples.find((candidate) => candidate.sampleId === record.sampleId);
  if (sample === undefined) throw new Error('Sealed evaluation sample disappeared');
  const result: EvaluatorBindingValue[] = [];
  for (const input of evaluator.inputs) {
    if (signal.aborted || shouldStop()) throw new EvaluationAttemptCancelledError();
    let source: EvaluationContent | undefined;
    if (input.sourceKind === 'output') {
      source = record.executionStatus === 'completed'
        ? await resolveCaptured(record.output, ports)
        : undefined;
    }
    else if (input.sourceKind === 'trace') source = await resolveCaptured(record.trace, ports);
    else if (input.sourceKind === 'execution-facts') {
      source = projectExecutionFacts(record, sourceTrust);
    }
    else {
      const value = input.sourceKind === 'expected'
        ? sample.expected
        : sample.evaluationContext;
      if (value !== undefined) source = {
        value: snapshotJson(value) as JsonValue,
        classification: 'gold',
      };
    }
    if (signal.aborted || shouldStop()) throw new EvaluationAttemptCancelledError();
    if (source === undefined) return undefined;
    try {
      result.push({
        bindingId: input.bindingId,
        sourceKind: input.sourceKind,
        value: resolvePointer(source.value, input.pointer),
        classification: source.classification,
        ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
      });
    } catch {
      return undefined;
    }
  }
  return result;
}

async function capture(
  content: EvaluationContent | undefined,
  plan: SealedRunPlan,
  ports: EvaluationRuntimePorts,
): Promise<CapturedContent | undefined> {
  if (content === undefined || plan.measurementPolicy.evidence.evidence === 'none') {
    return undefined;
  }
  if (CLASSIFICATION_LEVEL[content.classification]
      > CLASSIFICATION_LEVEL[plan.measurementPolicy.evidence.maximumClassification]) {
    throw new EvaluationPortFailure({
      code: 'evidence-classification-exceeded',
      stage: 'infrastructure',
      message: 'Evaluator evidence exceeds the sealed classification ceiling.',
    });
  }
  const digest = digestCanonicalJson(content.value);
  const mode = plan.measurementPolicy.evidence.evidence;
  if (mode === 'full') {
    return { contentKind: 'inline', classification: content.classification, value: snapshotJson(content.value) };
  }
  if (mode === 'digest') {
    return { contentKind: 'digest-only', classification: content.classification, digest };
  }
  const mediaType = content.mediaType ?? 'application/json';
  const descriptor = await ports.contentStore?.put({
    ...snapshotJson(content),
    digest,
    mediaType,
  });
  const parsedDescriptor = ContentDescriptorSchema.safeParse(descriptor);
  if (!parsedDescriptor.success
      || parsedDescriptor.data.digest !== digest
      || parsedDescriptor.data.mediaType !== mediaType) {
    throw new EvaluationPortFailure({
      code: 'content-store-invalid',
      stage: 'infrastructure',
      message: 'ContentStore returned an invalid descriptor.',
    });
  }
  return {
    contentKind: 'descriptor',
    classification: content.classification,
    descriptor: snapshotJson(parsedDescriptor.data),
  };
}

async function normalizeObservations(
  raw: readonly EvaluatorObservation[],
  evaluationId: Sha256Digest,
  evaluator: SealedRunPlan['evaluation']['evaluators'][number],
  plan: SealedRunPlan,
  ports: EvaluationRuntimePorts,
): Promise<MetricObservation[]> {
  const rawByMetric = new Map<string, EvaluatorObservation>();
  for (const observation of raw) {
    if (!evaluator.metricIds.includes(observation.metricId)
        || rawByMetric.has(observation.metricId)) {
      throw new EvaluationPortFailure({
        code: 'evaluator-observation-set-invalid',
        stage: 'infrastructure',
        message: 'Evaluator returned an unknown or duplicate metric observation.',
      });
    }
    rawByMetric.set(observation.metricId, observation);
  }
  const metrics = new Map(plan.evaluation.metrics.map((metric) => [metric.metricId, metric]));
  const normalized: MetricObservation[] = [];
  for (const metricId of evaluator.metricIds) {
    const metric = metrics.get(metricId);
    if (metric === undefined) throw new Error('Sealed metric disappeared');
    const observationId = deriveMetricObservationId({ evaluationId, metricId });
    const rawObservation = rawByMetric.get(metricId);
    if (rawObservation === undefined) {
      normalized.push({
        observationId,
        metricId,
        observationStatus: 'missing',
        valueType: metric.valueType,
        reasonCode: 'evaluator-omitted-metric',
      });
      continue;
    }
    const evidence = await capture(rawObservation.evidence, plan, ports);
    const metadata = await capture(rawObservation.metadata, plan, ports);
    const base = {
      observationId,
      metricId,
      ...(evidence === undefined ? {} : { evidence }),
      ...(metadata === undefined ? {} : { metadata }),
    };
    if (rawObservation.valueType !== metric.valueType) {
      normalized.push({
        ...base,
        observationStatus: 'invalid',
        valueType: metric.valueType,
        reasonCode: 'evaluator-value-type-mismatch',
      });
      continue;
    }
    if (rawObservation.observationStatus === 'observed'
        && rawObservation.valueType === 'numeric'
        && metric.scale !== undefined
        && ((metric.scale.min !== undefined && rawObservation.value < metric.scale.min)
          || (metric.scale.max !== undefined && rawObservation.value > metric.scale.max))) {
      const invalidValue = await capture({
        value: rawObservation.value,
        classification: 'public',
      }, plan, ports);
      normalized.push({
        ...base,
        observationStatus: 'invalid',
        valueType: 'numeric',
        reasonCode: 'metric-scale-out-of-range',
        ...(invalidValue === undefined ? {} : { invalidValue }),
      });
      continue;
    }
    const capturedInvalidValue = rawObservation.observationStatus === 'invalid'
        && rawObservation.invalidValue !== undefined
      ? await capture(rawObservation.invalidValue, plan, ports)
      : undefined;
    const candidate = rawObservation.observationStatus === 'observed'
      ? {
        ...base,
        observationStatus: rawObservation.observationStatus,
        valueType: rawObservation.valueType,
        value: snapshotJson(rawObservation.value),
      }
      : rawObservation.observationStatus === 'missing'
        ? {
          ...base,
          observationStatus: rawObservation.observationStatus,
          valueType: rawObservation.valueType,
          reasonCode: rawObservation.reasonCode,
        }
        : {
          ...base,
          observationStatus: rawObservation.observationStatus,
          valueType: rawObservation.valueType,
          reasonCode: rawObservation.reasonCode,
          ...(capturedInvalidValue === undefined
            ? {}
            : { invalidValue: capturedInvalidValue }),
        };
    normalized.push(parseWireDocument(MetricObservationSchema, candidate));
  }
  return normalized;
}


async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  clock: EvaluationClock,
  parent: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const unlink = linkAbortSignal(parent, controller);
  const timerController = new AbortController();
  const operationResult = Promise.resolve().then(() => operation(controller.signal));
  try {
    if (timeoutMs === undefined) {
      try {
        const value = await operationResult;
        if (parent.aborted) throw new EvaluationAttemptCancelledError();
        return value;
      } catch (error) {
        if (parent.aborted) throw new EvaluationAttemptCancelledError();
        throw error;
      }
    }
    const winner = await Promise.race([
      operationResult.then(
        (value) => ({ resultKind: 'value' as const, value }),
        (error: unknown) => ({ resultKind: 'error' as const, error }),
      ),
      clock.sleep(timeoutMs, timerController.signal).then(() => ({
        resultKind: 'timeout' as const,
      })),
    ]);
    if (winner.resultKind === 'timeout') {
      controller.abort('timeout');
      await operationResult.catch(() => undefined);
      if (parent.aborted) throw new EvaluationAttemptCancelledError();
      throw new EvaluationAttemptTimeoutError();
    }
    if (parent.aborted) throw new EvaluationAttemptCancelledError();
    if (winner.resultKind === 'value') return winner.value;
    throw winner.error;
  } finally {
    unlink();
    timerController.abort();
  }
}

type RuntimeEvents = RuntimeEventEmitter<
  EvaluationRuntimeEventKind,
  'run' | 'evaluation' | 'attempt',
  EvaluationTerminalEventKind
>;



function runtimeTrust(runtime: RuntimeIdentity): Provenance['trust'] {
  return runtime.assuranceLevel;
}

function providerCostUpperBound(
  binding: EvaluatorBinding,
): { amount: number; currency: string } | undefined {
  if (binding.runtime.assuranceLevel !== 'verified') return undefined;
  const capabilities = EvaluatorCapabilitiesSchema.safeParse(binding.runtime.capabilities);
  return capabilities.success
    ? capabilities.data.providerCost?.trustedUpperBound
    : undefined;
}

export function notEvaluatedRecord(
  plan: SealedRunPlan,
  binding: EvaluatorBinding,
  coordinate: PlannedEvaluationCoordinate,
  reason: string,
  time: string,
  sourceTrust: Provenance['trust'],
  source?: ExecutionRecord,
): Extract<EvaluationRecord, { evaluationStatus: 'not-evaluated' }> {
  return {
    ...coordinate,
    runtime: snapshotJson(binding.runtime),
    provenance: {
      provenanceKind: 'native',
      trust: minimumTrust([sourceTrust, runtimeTrust(binding.runtime)], 'verified'),
      parentDigests: [
        plan.evaluation.evaluationPlanDigest,
        ...(source === undefined ? [] : [digestCanonicalJson(source)]),
      ],
    },
    evaluationStatus: 'not-evaluated',
    notEvaluatedReasonCode: reason,
    notEvaluatedAt: time,
    ...(source === undefined ? {} : { sourceRecordDigest: digestCanonicalJson(source) }),
  };
}

function cacheKey(
  plan: SealedRunPlan,
  coordinate: PlannedEvaluationCoordinate,
  binding: EvaluatorBinding,
  sourceTrust: Provenance['trust'],
  bindings: readonly EvaluatorBindingValue[],
): Sha256Digest {
  return digestCanonicalJson({
    derivation: 'omk.evaluation-cache-key/v2',
    evaluationPlanDigest: plan.evaluation.evaluationPlanDigest,
    evaluationId: coordinate.evaluationId,
    evaluatorRuntime: binding.runtime,
    sourceTrust,
    bindings,
  });
}

function replayRecord(
  entry: EvaluationCacheEntry,
  key: Sha256Digest,
  coordinate: PlannedEvaluationCoordinate,
  binding: EvaluatorBinding,
  sourceRecordDigest: Sha256Digest,
  sourceTrust: Provenance['trust'],
  plan: SealedRunPlan,
): CompletedRecord {
  const parsedRecord = CompletedEvaluationRecordSchema.safeParse(entry.record);
  if (!parsedRecord.success) {
    throw new EvaluationPortFailure({
      code: 'evaluation-cache-entry-invalid',
      stage: 'infrastructure',
      message: 'Evaluation cache entry is not a valid completed record.',
    });
  }
  const record = parsedRecord.data;
  const expectedMetricIds = binding.evaluator.metricIds;
  const metrics = new Map(plan.evaluation.metrics.map((metric) => [metric.metricId, metric]));
  const expectedTrust = minimumTrust([sourceTrust, runtimeTrust(binding.runtime)], 'verified');
  const expectedNativeProvenance = {
    provenanceKind: 'native' as const,
    trust: expectedTrust,
    parentDigests: [plan.evaluation.evaluationPlanDigest, record.sourceRecordDigest],
  };
  const contractInvalid = record.targetId !== coordinate.targetId
    || record.sampleId !== coordinate.sampleId
    || record.trialIndex !== coordinate.trialIndex
    || record.trialId !== coordinate.trialId
    || record.evaluatorId !== coordinate.evaluatorId
    || record.evaluationId !== coordinate.evaluationId
    || canonicalizeJson(record.runtime) !== canonicalizeJson(binding.runtime)
    || canonicalizeJson(record.provenance) !== canonicalizeJson(expectedNativeProvenance)
    || canonicalizeJson(record.cache) !== canonicalizeJson({
      cacheStatus: 'miss',
      cacheKeyDigest: key,
    })
    || !evaluationRecordUsageMatchesAttempts(record)
    || !evaluationRecordSatisfiesCacheCostPolicy(
      record,
      mostRestrictiveProviderCostLimit(
        plan.evaluation.policy.budget.run.maxProviderCost,
        plan.evaluation.policy.budget.stages.evaluation.maxProviderCost,
        plan.evaluation.policy.budget.coordinate.maxProviderCost,
      ),
      plan.evaluation.policy.budget.attempt.maxProviderCost,
    )
    || record.attempts.length > plan.evaluation.policy.runtime.retry.maxAttempts
    || !evaluationRecordMatchesEvidencePolicy(record, plan.evaluation.policy.evidence)
    || record.attempts.at(-1)?.attemptStatus !== 'completed'
    || record.attempts.some((attempt, index) => (
      attempt.attemptNumber !== index + 1
      || attempt.attemptId !== deriveEvaluationAttemptId({
        evaluationId: coordinate.evaluationId,
        attemptNumber: index + 1,
      })
      || (index < record.attempts.length - 1
        && (attempt.attemptStatus !== 'failed'
          || !plan.evaluation.policy.runtime.retry.retryableErrorCodes
            .includes(attempt.error.code)))
    ))
    || record.observations.length !== expectedMetricIds.length
    || record.observations.some((observation, index) => {
      const metric = metrics.get(observation.metricId);
      if (observation.metricId !== expectedMetricIds[index]
          || observation.observationId !== deriveMetricObservationId({
            evaluationId: coordinate.evaluationId,
            metricId: observation.metricId,
          })
          || metric === undefined
          || observation.valueType !== metric.valueType) return true;
      return observation.observationStatus === 'observed'
        && observation.valueType === 'numeric'
        && metric.scale !== undefined
        && ((metric.scale.min !== undefined && observation.value < metric.scale.min)
          || (metric.scale.max !== undefined && observation.value > metric.scale.max));
    });
  if (entry.cacheKeyDigest !== key
      || entry.cachedRecordDigest !== digestCanonicalJson(record)
      || contractInvalid) {
    throw new EvaluationPortFailure({
      code: 'evaluation-cache-entry-invalid',
      stage: 'infrastructure',
      message: 'Evaluation cache entry does not match its sealed coordinate.',
    });
  }
  return {
    ...snapshotJson(record),
    sourceRecordDigest,
    provenance: {
      provenanceKind: 'replay',
      trust: expectedTrust,
      parentDigests: [entry.cachedRecordDigest],
    },
    cache: {
      cacheStatus: 'transparent-hit',
      cacheKeyDigest: key,
      sourceRecordDigest: entry.cachedRecordDigest,
    },
  };
}

export async function evaluateCoordinate(
  plan: SealedRunPlan,
  ports: EvaluationRuntimePorts,
  sessions: RunResourceSessions<EvaluatorBinding, EvaluationEvaluatorRun>,
  events: RuntimeEvents,
  budget: RunBudgetController,
  prepared: EligibleCoordinate,
  signal: AbortSignal,
  setStop: (kind: StopKind, reason: string, error?: EvaluationError) => void,
): Promise<{
  record?: EvaluationRecord;
  cacheEntry?: EvaluationCacheEntry;
  verifiedCacheRecordDigest?: Sha256Digest;
}> {
  const { binding, coordinate, sourceRecordDigest, sourceTrust, inputs } = prepared;
  if (signal.aborted) return {};
  const key = cacheKey(
    plan,
    coordinate,
    binding,
    sourceTrust,
    inputs,
  );
  if (plan.evaluation.policy.evaluationCacheMode === 'reuse') {
    try {
      const entry = await ports.cache?.get(key);
      if (signal.aborted) return {};
      if (entry !== undefined) {
        const record = replayRecord(
          entry,
          key,
          coordinate,
          binding,
          sourceRecordDigest,
          sourceTrust,
          plan,
        );
        const delivered = await events.emit('evaluation.cache.hit', 'evaluation', coordinate.evaluationId, {
          cacheKeyDigest: key,
        });
        if (!delivered || signal.aborted) return {};
        return { record, verifiedCacheRecordDigest: entry.cachedRecordDigest };
      }
      const delivered = await events.emit('evaluation.cache.miss', 'evaluation', coordinate.evaluationId, {
        cacheKeyDigest: key,
      });
      if (!delivered || signal.aborted) return {};
    } catch (error) {
      setStop('failed', 'evaluation-cache-read-failed', safeError(error));
      return {};
    }
  }
  const attempts: EvaluationAttempt[] = [];
  const startedAt = ports.clock.timestamp();
  const startedMono = ports.clock.monotonicNow();
  let terminalError: EvaluationError | undefined;
  let observations: MetricObservation[] | undefined;
  let evidence: CapturedContent | undefined;
  let evaluatorRecord: Awaited<ReturnType<EvaluationEvaluatorRun['openRecord']>> | undefined;
  let resourceClean = true;
  const recordStarted = await events.emit(
    'evaluation.record.started',
    'evaluation',
    coordinate.evaluationId,
    {
      targetId: coordinate.targetId,
      sampleId: coordinate.sampleId,
      trialIndex: coordinate.trialIndex,
      evaluatorId: coordinate.evaluatorId,
    },
  );
  if (!recordStarted || signal.aborted) return {};
  try {
    const session = await sessions.get(binding);
    evaluatorRecord = await session.openRecord(deepFreeze(snapshotJson({
      ...coordinate,
      ...(binding.evaluator.config === undefined
        ? {}
        : { evaluatorConfig: binding.evaluator.config as JsonValue }),
      bindings: inputs,
      metrics: binding.evaluator.metricIds.map((metricId) => {
        const metric = plan.evaluation.metrics.find((candidate) => candidate.metricId === metricId);
        if (metric === undefined) throw new Error('Sealed metric disappeared');
        return metric;
      }),
    })) as Parameters<EvaluationEvaluatorRun['openRecord']>[0]);
    const activeEvaluatorRecord = evaluatorRecord;
    const retry = plan.evaluation.policy.runtime.retry;
    for (let attemptNumber = 1; attemptNumber <= retry.maxAttempts; attemptNumber += 1) {
      const attemptId = deriveEvaluationAttemptId({
        evaluationId: coordinate.evaluationId,
        attemptNumber,
      });
      const admission = budget.reserve([{
        stage: 'evaluation',
        coordinateId: coordinate.trialId,
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
      const [reservationId] = admission.reservationIds;
      const attemptStartedAt = ports.clock.timestamp();
      const attemptStartedMono = ports.clock.monotonicNow();
      const attemptDelivery = await events.emit('evaluation.attempt.started', 'attempt', attemptId, {
        evaluationId: coordinate.evaluationId,
        attemptNumber,
      });
      if (!attemptDelivery || signal.aborted) {
        budget.release(reservationId);
        break;
      }
      budget.consume(reservationId);
      let attemptUsage: UsageRecord | undefined;
      try {
        const result = await withTimeout(
          (attemptSignal) => activeEvaluatorRecord.evaluate(Object.freeze({
            attemptId,
            attemptNumber,
            signal: attemptSignal,
          })),
          plan.evaluation.policy.runtime.timeoutMs,
          ports.clock,
          signal,
        );
        if (signal.aborted) throw new EvaluationAttemptCancelledError();
        attemptUsage = validatedUsage(result.usage);
        observations = await normalizeObservations(
          result.observations,
          coordinate.evaluationId,
          binding.evaluator,
          plan,
          ports,
        );
        evidence = await capture(result.evidence, plan, ports);
        if (signal.aborted) throw new EvaluationAttemptCancelledError();
        const completedAt = ports.clock.timestamp();
        const completedMono = ports.clock.monotonicNow();
        attempts.push({
          attemptId,
          attemptNumber,
          attemptStatus: 'completed',
          timing: {
            startedAt: attemptStartedAt,
            completedAt,
            durationMs: durationMs(attemptStartedMono, completedMono),
          },
          ...(attemptUsage === undefined ? {} : { usage: snapshotJson(attemptUsage) }),
        });
        const budgetError = budget.settle(
          reservationId,
          durationMs(attemptStartedMono, completedMono),
          attemptUsage,
          'completed',
        );
        if (budgetError !== undefined) {
          const summary = budget.snapshot();
          setStop(
            summary.summaryStatus === 'failed' ? 'failed' : 'budget-exhausted',
            budgetError.code,
            summary.summaryStatus === 'failed' ? budgetError : undefined,
          );
        }
        await events.emit('evaluation.attempt.completed', 'attempt', attemptId, {
          attemptNumber,
          attemptStatus: 'completed',
        });
        break;
      } catch (error) {
        let failure = safeError(error);
        const cancelled = signal.aborted;
        const completedAt = ports.clock.timestamp();
        const completedMono = ports.clock.monotonicNow();
        let usage = attemptUsage;
        if (usage === undefined && error instanceof EvaluationPortFailure
            && error.usage !== undefined) {
          try {
            usage = validatedUsage(error.usage);
          } catch (usageValidationError) {
            failure = safeError(usageValidationError);
          }
        }
        attempts.push({
          attemptId,
          attemptNumber,
          attemptStatus: cancelled ? 'cancelled' : 'failed',
          timing: {
            startedAt: attemptStartedAt,
            completedAt,
            durationMs: durationMs(attemptStartedMono, completedMono),
          },
          error: failure,
          ...(usage === undefined ? {} : { usage: snapshotJson(usage) }),
        });
        const budgetError = budget.settle(
          reservationId,
          durationMs(attemptStartedMono, completedMono),
          usage,
          failure.code === 'timeout'
            ? 'attempt-timeout'
            : cancelled ? 'cancelled' : 'failed',
        );
        if (budgetError !== undefined) {
          const summary = budget.snapshot();
          setStop(
            summary.summaryStatus === 'failed' ? 'failed' : 'budget-exhausted',
            budgetError.code,
            summary.summaryStatus === 'failed' ? budgetError : undefined,
          );
        }
        terminalError = failure;
        await events.emit('evaluation.attempt.completed', 'attempt', attemptId, {
          attemptNumber,
          attemptStatus: cancelled ? 'cancelled' : 'failed',
          errorCode: failure.code,
        });
        if (signal.aborted || budget.snapshot().summaryStatus === 'exhausted'
            || cancelled || !retry.retryableErrorCodes.includes(failure.code)
            || attemptNumber === retry.maxAttempts) break;
        const delay = retry.backoff.backoffKind === 'none'
          ? 0
          : retry.backoff.backoffKind === 'fixed'
            ? retry.backoff.initialDelayMs
            : Math.min(
              retry.backoff.initialDelayMs * (2 ** (attemptNumber - 1)),
              retry.backoff.maxDelayMs ?? Number.MAX_SAFE_INTEGER,
            );
        await events.emit('evaluation.retry.scheduled', 'evaluation', coordinate.evaluationId, {
          attemptNumber: attemptNumber + 1,
          delayMs: delay,
          errorCode: failure.code,
        });
        if (delay > 0) await ports.clock.sleep(delay, signal);
      }
    }
  } catch (error) {
    terminalError = safeError(error);
    if (attempts.length === 0) {
      setStop('failed', 'evaluator-resource-open-failed', terminalError);
      return {};
    }
  } finally {
    if (evaluatorRecord !== undefined) {
      try { await evaluatorRecord.dispose(); } catch {
        resourceClean = false;
        setStop('failed', 'evaluator-record-dispose-failed', {
          code: 'evaluator-record-dispose-failed',
          stage: 'infrastructure',
          message: 'Evaluator record resource disposal failed.',
        });
      }
    }
  }
  if (attempts.length === 0) return {};
  const finalStatus = attempts.at(-1)?.attemptStatus;
  const usage = aggregateEvaluationAttemptUsage(attempts);
  const base = {
    ...coordinate,
    runtime: snapshotJson(binding.runtime),
    provenance: {
      provenanceKind: 'native' as const,
      trust: minimumTrust([sourceTrust, runtimeTrust(binding.runtime)], 'verified'),
      parentDigests: [plan.evaluation.evaluationPlanDigest, sourceRecordDigest],
    },
    sourceRecordDigest,
    attempts,
    timing: {
      startedAt,
      completedAt: ports.clock.timestamp(),
      durationMs: durationMs(startedMono, ports.clock.monotonicNow()),
    },
    ...(usage === undefined ? {} : { usage }),
    ...(evidence === undefined ? {} : { evidence }),
    cache: plan.evaluation.policy.evaluationCacheMode === 'disabled'
      ? { cacheStatus: 'not-used' as const }
      : { cacheStatus: 'miss' as const, cacheKeyDigest: key },
  };
  const record: ActiveRecord = finalStatus === 'completed' && observations !== undefined
    ? { ...base, evaluationStatus: 'completed', observations }
    : finalStatus === 'cancelled'
      ? {
        ...base,
        evaluationStatus: 'cancelled',
        ...(terminalError === undefined ? {} : { error: terminalError }),
      }
      : {
        ...base,
        evaluationStatus: 'failed',
        error: terminalError ?? {
          code: 'evaluation-failed',
          stage: 'evaluation',
          message: 'Evaluation failed without a terminal error.',
        },
      };
  await events.emit('evaluation.record.completed', 'evaluation', coordinate.evaluationId, {
    evaluationStatus: record.evaluationStatus,
  });
  const cacheEntry = record.evaluationStatus === 'completed'
      && resourceClean
      && plan.evaluation.policy.evaluationCacheMode === 'reuse'
    ? {
      cacheKeyDigest: key,
      cachedRecordDigest: digestCanonicalJson(record),
      record: snapshotJson(record),
    } satisfies EvaluationCacheEntry
    : undefined;
  return { record, ...(cacheEntry === undefined ? {} : { cacheEntry }) };
}

export async function prepareEvaluationCoordinates(
  plan: SealedRunPlan,
  ports: EvaluationRuntimePorts,
  prepared: PreparedRuntime,
  coordinates: readonly PlannedEvaluationCoordinate[],
  signal: AbortSignal,
  shouldStop: () => boolean,
): Promise<PreparedCoordinate[]> {
  const sourceByTrial = new Map(
    prepared.source.bundle.records.map((record) => [trialKey(record), record]),
  );
  const result: PreparedCoordinate[] = [];
  for (const coordinate of coordinates) {
    if (signal.aborted || shouldStop()) break;
    const binding = prepared.bindings.get(coordinate.evaluatorId);
    if (binding === undefined) throw new Error('Evaluator binding disappeared');
    const source = sourceByTrial.get(trialKey(coordinate));
    if (source === undefined || source.executionStatus === 'budget-censored') {
      result.push({
        coordinate,
        binding,
        ...(source === undefined ? {} : { source }),
        reasonCode: source === undefined
          ? 'execution-record-unavailable'
          : 'execution-budget-censored',
      });
      continue;
    }
    const sourceTrust = minimumTrust([effectiveExecutionBundleTrust(prepared.source), source.provenance.trust], 'verified');
    const inputs = await materializeBindings(
      plan,
      source,
      sourceTrust,
      binding.evaluator,
      ports,
      signal,
      shouldStop,
    );
    if (signal.aborted || shouldStop()) break;
    if (inputs === undefined) {
      result.push({ coordinate, binding, source, reasonCode: 'evaluator-input-unavailable' });
      continue;
    }
    result.push({
      coordinate,
      binding,
      source,
      sourceRecordDigest: digestCanonicalJson(source),
      sourceTrust,
      inputs,
    });
  }
  return result;
}
