import {
  EVALUATION_BUNDLE_SCHEMA_VERSION,
  CompletedEvaluationRecordSchema,
  ContentDescriptorSchema,
  EvaluationErrorSchema,
  IdentifierSchema,
  MetricObservationSchema,
  UsageRecordSchema,
  aggregateEvaluationAttemptUsage,
  canonicalizeJson,
  deriveEvaluationAttemptId,
  deriveMetricObservationId,
  derivePlannedEvaluationCoordinates,
  digestArtifactPayload,
  digestCanonicalJson,
  evaluationRecordMatchesEvidencePolicy,
  evaluationRecordSatisfiesCacheCostPolicy,
  evaluationRecordUsageMatchesAttempts,
  effectiveExecutionBundleTrust,
  parseWireDocument,
  verifyEvaluationBundle,
  type CapturedContent,
  type EvaluationAttempt,
  type EvaluationBundle,
  type EvaluationBundleSource,
  type EvaluationError,
  type EvaluationRecord,
  type ExecutionBundleSource,
  type ExecutionRecord,
  type JsonValue,
  type MetricObservation,
  type PlannedEvaluationCoordinate,
  type Provenance,
  type RuntimeIdentity,
  type Sha256Digest,
  type UsageRecord,
} from '../contracts/index.js';
import { deepFreeze, snapshotJson } from '../compiler/immutability.js';
import type { SealedRunPlan } from '../compiler/index.js';
import { BoundedEventStream } from '../runtime/event-stream.js';
import { RuntimeEventEmitter } from '../runtime/events.js';
import {
  EvaluationPortFailure,
  EvaluationRuntimeConfigurationError,
  type EvaluationCacheEntry,
  type EvaluationClock,
  type EvaluationContent,
  type EvaluationEvaluator,
  type EvaluationEvaluatorRun,
  type EvaluationRun,
  type EvaluationRunOptions,
  type EvaluationRuntimeEventKind,
  type EvaluationRuntimePorts,
  type EvaluatorBindingValue,
  type EvaluatorObservation,
} from './types.js';

type ActiveRecord = Exclude<EvaluationRecord, { evaluationStatus: 'not-evaluated' }>;
type CompletedRecord = Extract<EvaluationRecord, { evaluationStatus: 'completed' }>;
type StopKind = 'cancelled' | 'budget-exhausted' | 'failed';

interface StopState {
  stopKind?: StopKind;
  reason?: string;
  error?: EvaluationError;
}

interface EvaluatorBinding {
  evaluator: SealedRunPlan['evaluation']['evaluators'][number];
  port: EvaluationEvaluator;
  runtime: RuntimeIdentity;
}

interface PreparedRuntime {
  bindings: ReadonlyMap<string, EvaluatorBinding>;
  source: ExecutionBundleSource;
}

interface EligibleCoordinate {
  coordinate: PlannedEvaluationCoordinate;
  binding: EvaluatorBinding;
  source: Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>;
  sourceRecordDigest: Sha256Digest;
  sourceTrust: Provenance['trust'];
  inputs: readonly EvaluatorBindingValue[];
}

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

class EvaluationAttemptCancelledError extends Error {
  constructor() {
    super('Evaluation attempt was cancelled.');
    this.name = 'AbortError';
  }
}

const CLASSIFICATION_LEVEL = { public: 0, sensitive: 1, secret: 2, gold: 3 } as const;

function configurationError(code: string, message: string): never {
  throw new EvaluationRuntimeConfigurationError(code, message);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRecords(left: EvaluationRecord, right: EvaluationRecord): number {
  return compareStrings(left.targetId, right.targetId)
    || compareStrings(left.sampleId, right.sampleId)
    || left.trialIndex - right.trialIndex
    || compareStrings(left.evaluatorId, right.evaluatorId);
}

function trialKey(value: { targetId: string; sampleId: string; trialIndex: number }): string {
  return canonicalizeJson([value.targetId, value.sampleId, value.trialIndex]);
}

function validateOptions(options: EvaluationRunOptions): void {
  if (!IdentifierSchema.safeParse(options.runId).success
      || !IdentifierSchema.safeParse(options.bundleId).success) {
    configurationError(
      'EVALUATION_RUNTIME_IDENTIFIER_INVALID',
      'runId and bundleId must be valid Evaluation Core identifiers.',
    );
  }
  if (options.eventBufferCapacity !== undefined
      && (!Number.isSafeInteger(options.eventBufferCapacity)
        || options.eventBufferCapacity < 1)) {
    configurationError(
      'EVALUATION_RUNTIME_EVENT_BUFFER_INVALID',
      'eventBufferCapacity must be a positive safe integer.',
    );
  }
}

function prepareRuntime(
  plan: SealedRunPlan,
  source: ExecutionBundleSource,
  ports: EvaluationRuntimePorts,
  options: EvaluationRunOptions,
): PreparedRuntime {
  validateOptions(options);
  if (ports.eventSequencer === undefined) {
    configurationError(
      'EVALUATION_RUNTIME_EVENT_SEQUENCER_REQUIRED',
      'Evaluation runtime requires a shared per-Run EventSequencer.',
    );
  }
  effectiveExecutionBundleTrust(source);
  if (plan.evaluation.policy.evaluationCacheMode !== 'disabled' && ports.cache === undefined) {
    configurationError(
      'EVALUATION_RUNTIME_CACHE_REQUIRED',
      'Evaluation cache reuse requires an injected EvaluationCache.',
    );
  }
  if (plan.measurementPolicy.evidence.evidence === 'reference'
      && ports.contentStore === undefined) {
    configurationError(
      'EVALUATION_RUNTIME_CONTENT_STORE_REQUIRED',
      'Reference evidence capture requires an injected EvaluationContentStore.',
    );
  }
  if (plan.measurementPolicy.eventDelivery.writerMode === 'required'
      && ports.eventWriter === undefined) {
    configurationError(
      'EVALUATION_RUNTIME_EVENT_WRITER_REQUIRED',
      'Required EventWriter mode needs an injected EventWriter.',
    );
  }
  const runtimes = new Map<string, RuntimeIdentity>();
  for (const runtime of plan.evaluation.runtimes) {
    if (runtime.runtimeKind !== 'evaluator') continue;
    if (runtimes.has(runtime.referenceId)) {
      configurationError(
        'EVALUATION_RUNTIME_BINDING_INVALID',
        `EvaluationPlan contains duplicate Runtime binding for ${runtime.referenceId}.`,
      );
    }
    runtimes.set(runtime.referenceId, runtime.identity as RuntimeIdentity);
  }
  const bindings = new Map<string, EvaluatorBinding>();
  for (const evaluator of plan.evaluation.evaluators) {
    const port = ports.evaluators.get(evaluator.implementationId);
    const runtime = runtimes.get(evaluator.evaluatorId);
    if (port === undefined) {
      configurationError(
        'EVALUATION_RUNTIME_EVALUATOR_MISSING',
        `No Evaluator is registered for ${evaluator.implementationId}.`,
      );
    }
    if (runtime === undefined
        || canonicalizeJson(port.identity) !== canonicalizeJson(runtime)) {
      configurationError(
        'EVALUATION_RUNTIME_IDENTITY_MISMATCH',
        `Evaluator identity for ${evaluator.evaluatorId} differs from the sealed plan.`,
      );
    }
    bindings.set(evaluator.evaluatorId, { evaluator, port, runtime });
  }
  return { bindings, source };
}

function safeError(error: unknown): EvaluationError {
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

function durationMs(start: number, end: number): number {
  return Math.max(0, end - start);
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
  let current: unknown = value;
  if (pointer === '') return value;
  for (const encoded of pointer.slice(1).split('/')) {
    const token = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object') throw new TypeError('pointer-unresolved');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) {
        throw new TypeError('pointer-unresolved');
      }
      current = current[Number(token)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        throw new TypeError('pointer-unresolved');
      }
      current = (current as Record<string, unknown>)[token];
    }
  }
  canonicalizeJson(current);
  return current as JsonValue;
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

function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  const abort = (): void => child.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort, { once: true });
  return () => parent.removeEventListener('abort', abort);
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  clock: EvaluationClock,
  parent: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const unlink = linkAbort(parent, controller);
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

type EvaluationTerminalEventKind =
  | 'evaluation.run.completed'
  | 'evaluation.run.cancelled'
  | 'evaluation.run.budget-exhausted'
  | 'evaluation.run.failed';

type RuntimeEvents = RuntimeEventEmitter<
  EvaluationRuntimeEventKind,
  'run' | 'evaluation' | 'attempt',
  EvaluationTerminalEventKind
>;

class Sessions {
  readonly #plan: SealedRunPlan;
  readonly #options: EvaluationRunOptions;
  readonly #sessions = new Map<string, Promise<EvaluationEvaluatorRun>>();

  constructor(plan: SealedRunPlan, options: EvaluationRunOptions) {
    this.#plan = plan;
    this.#options = options;
  }

  get(binding: EvaluatorBinding): Promise<EvaluationEvaluatorRun> {
    const current = this.#sessions.get(binding.evaluator.implementationId);
    if (current !== undefined) return current;
    const session = Promise.resolve(binding.port.openRun(deepFreeze(snapshotJson({
      runId: this.#options.runId,
      evaluationPlanDigest: this.#plan.evaluation.evaluationPlanDigest as Sha256Digest,
    }))));
    this.#sessions.set(binding.evaluator.implementationId, session);
    return session;
  }

  async dispose(): Promise<boolean> {
    let failed = false;
    for (const session of this.#sessions.values()) {
      try { await (await session).dispose(); } catch { failed = true; }
    }
    return failed;
  }
}

class Budget {
  readonly #max?: number;
  readonly #cost?: { amount: number; currency: string };
  #used = 0;
  #reserved = 0;
  #providerCost = 0;

  constructor(plan: SealedRunPlan) {
    this.#max = plan.evaluation.policy.runtime.budget.maxEvaluatorInvocations;
    this.#cost = plan.evaluation.policy.runtime.budget.maxProviderCost;
  }

  reserveInvocation(): boolean {
    if (this.#max !== undefined && this.#used + this.#reserved >= this.#max) return false;
    this.#reserved += 1;
    return true;
  }

  consumeReservation(): void {
    if (this.#reserved < 1) throw new Error('Evaluator invocation reservation disappeared.');
    this.#reserved -= 1;
    this.#used += 1;
  }

  releaseReservation(): void {
    if (this.#reserved < 1) throw new Error('Evaluator invocation reservation disappeared.');
    this.#reserved -= 1;
  }

  record(usage: UsageRecord | undefined): EvaluationError | undefined {
    if (this.#cost === undefined) return undefined;
    if (usage?.providerCost === undefined) return {
      code: 'provider-cost-unreported',
      stage: 'infrastructure',
      message: 'Provider cost budget requires every evaluator invocation to report cost.',
    };
    if (usage.providerCost.currency !== this.#cost.currency) return {
      code: 'provider-cost-currency-mismatch',
      stage: 'infrastructure',
      message: 'Evaluator cost currency differs from the sealed budget currency.',
    };
    this.#providerCost += usage.providerCost.amount;
    return undefined;
  }

  get exhausted(): boolean {
    return this.#cost !== undefined && this.#providerCost >= this.#cost.amount;
  }
}

const TRUST_LEVEL: Record<Provenance['trust'], number> = {
  untrusted: 0,
  unknown: 1,
  declared: 2,
  verified: 3,
};

function minimumTrust(...values: readonly Provenance['trust'][]): Provenance['trust'] {
  return values.reduce((minimum, value) => (
    TRUST_LEVEL[value] < TRUST_LEVEL[minimum] ? value : minimum
  ), 'verified');
}

function runtimeTrust(runtime: RuntimeIdentity): Provenance['trust'] {
  return runtime.assuranceLevel;
}

function notEvaluatedRecord(
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
      trust: minimumTrust(sourceTrust, runtimeTrust(binding.runtime)),
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
  sourceRecordDigest: Sha256Digest,
  sourceTrust: Provenance['trust'],
  bindings: readonly EvaluatorBindingValue[],
): Sha256Digest {
  return digestCanonicalJson({
    derivation: 'omk.evaluation-cache-key/v1',
    evaluationPlanDigest: plan.evaluation.evaluationPlanDigest,
    evaluationId: coordinate.evaluationId,
    evaluatorRuntime: binding.runtime,
    sourceRecordDigest,
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
  const expectedTrust = minimumTrust(sourceTrust, runtimeTrust(binding.runtime));
  const expectedNativeProvenance = {
    provenanceKind: 'native' as const,
    trust: expectedTrust,
    parentDigests: [plan.evaluation.evaluationPlanDigest, sourceRecordDigest],
  };
  const contractInvalid = record.targetId !== coordinate.targetId
    || record.sampleId !== coordinate.sampleId
    || record.trialIndex !== coordinate.trialIndex
    || record.trialId !== coordinate.trialId
    || record.evaluatorId !== coordinate.evaluatorId
    || record.evaluationId !== coordinate.evaluationId
    || record.sourceRecordDigest !== sourceRecordDigest
    || canonicalizeJson(record.runtime) !== canonicalizeJson(binding.runtime)
    || canonicalizeJson(record.provenance) !== canonicalizeJson(expectedNativeProvenance)
    || canonicalizeJson(record.cache) !== canonicalizeJson({
      cacheStatus: 'miss',
      cacheKeyDigest: key,
    })
    || !evaluationRecordUsageMatchesAttempts(record)
    || !evaluationRecordSatisfiesCacheCostPolicy(
      record,
      plan.evaluation.policy.runtime.budget.maxProviderCost,
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

async function evaluateCoordinate(
  plan: SealedRunPlan,
  ports: EvaluationRuntimePorts,
  sessions: Sessions,
  events: RuntimeEvents,
  budget: Budget,
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
    sourceRecordDigest,
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
      if (!budget.reserveInvocation()) {
        setStop('budget-exhausted', 'evaluator-invocation-budget-exhausted');
        break;
      }
      const attemptId = deriveEvaluationAttemptId({
        evaluationId: coordinate.evaluationId,
        attemptNumber,
      });
      const attemptStartedAt = ports.clock.timestamp();
      const attemptStartedMono = ports.clock.monotonicNow();
      const attemptDelivery = await events.emit('evaluation.attempt.started', 'attempt', attemptId, {
        evaluationId: coordinate.evaluationId,
        attemptNumber,
      });
      if (!attemptDelivery || signal.aborted) {
        budget.releaseReservation();
        break;
      }
      budget.consumeReservation();
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
        attempts.push({
          attemptId,
          attemptNumber,
          attemptStatus: 'completed',
          timing: {
            startedAt: attemptStartedAt,
            completedAt,
            durationMs: durationMs(attemptStartedMono, ports.clock.monotonicNow()),
          },
          ...(attemptUsage === undefined ? {} : { usage: snapshotJson(attemptUsage) }),
        });
        const budgetError = budget.record(attemptUsage);
        if (budgetError !== undefined) setStop('failed', budgetError.code, budgetError);
        await events.emit('evaluation.attempt.completed', 'attempt', attemptId, {
          attemptNumber,
          attemptStatus: 'completed',
        });
        break;
      } catch (error) {
        let failure = safeError(error);
        const cancelled = signal.aborted;
        const completedAt = ports.clock.timestamp();
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
            durationMs: durationMs(attemptStartedMono, ports.clock.monotonicNow()),
          },
          error: failure,
          ...(usage === undefined ? {} : { usage: snapshotJson(usage) }),
        });
        const budgetError = budget.record(usage);
        if (budgetError !== undefined) setStop('failed', budgetError.code, budgetError);
        terminalError = failure;
        await events.emit('evaluation.attempt.completed', 'attempt', attemptId, {
          attemptNumber,
          attemptStatus: cancelled ? 'cancelled' : 'failed',
          errorCode: failure.code,
        });
        if (signal.aborted || budget.exhausted
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
      trust: minimumTrust(sourceTrust, runtimeTrust(binding.runtime)),
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

function replayability(records: readonly EvaluationRecord[]): EvaluationBundle['replayability'] {
  const captured = records.flatMap((record) => {
    if (record.evaluationStatus === 'not-evaluated') return [];
    return [
      record.evidence,
      ...(record.evaluationStatus === 'completed'
        ? record.observations.flatMap((observation) => [
          observation.evidence,
          observation.metadata,
          observation.observationStatus === 'invalid' ? observation.invalidValue : undefined,
        ])
        : []),
    ].filter((content): content is CapturedContent => content !== undefined);
  });
  if (captured.every((content) => content.contentKind === 'inline')) return 'self-contained';
  if (captured.every((content) => content.contentKind !== 'digest-only')
      && captured.some((content) => content.contentKind === 'descriptor')) return 'resolvable';
  return 'summary-only';
}

function makeBundle(
  plan: SealedRunPlan,
  source: ExecutionBundleSource,
  options: EvaluationRunOptions,
  records: EvaluationRecord[],
  planned: number,
  stop: StopState,
  verifiedCacheRecordDigests: ReadonlySet<Sha256Digest>,
): EvaluationBundleSource {
  const execution = source.bundle;
  records.sort(compareRecords);
  const sourceUnavailable = records.filter(
    (record) => record.evaluationStatus === 'not-evaluated',
  ).length;
  const completed = records.filter((record) => record.evaluationStatus === 'completed').length;
  const failed = records.filter((record) => record.evaluationStatus === 'failed').length;
  const cancelled = records.filter((record) => record.evaluationStatus === 'cancelled').length;
  const started = completed + failed + cancelled;
  const eligible = planned - sourceUnavailable;
  const bundle: EvaluationBundle = {
    schemaVersion: EVALUATION_BUNDLE_SCHEMA_VERSION,
    bundleId: options.bundleId,
    runContractDigest: plan.digests.runContractDigest,
    executionBundleDigest: execution.bundleDigest,
    evaluationPlanDigest: plan.digests.evaluationPlanDigest,
    evaluationInputDigest: plan.digests.evaluationInputDigest,
    evaluationBundleStatus: stop.stopKind ?? 'completed',
    ...(stop.reason === undefined ? {} : { terminationReasonCode: stop.reason }),
    coverage: {
      planned,
      eligible,
      sourceUnavailable,
      started,
      completed,
      failed,
      cancelled,
      notStarted: eligible - started,
    },
    replayability: replayability(records),
    records,
    provenance: {
      provenanceKind: 'native',
      trust: minimumTrust(
        effectiveExecutionBundleTrust(source),
        ...records.map((record) => record.provenance.trust),
      ),
      parentDigests: [execution.bundleDigest, plan.evaluation.evaluationPlanDigest],
      ...(stop.error === undefined
        ? {}
        : { facets: snapshotJson({ terminalError: stop.error }) as unknown as JsonValue }),
    },
    bundleDigest: `sha256:${'0'.repeat(64)}`,
  };
  bundle.bundleDigest = digestArtifactPayload(bundle, 'bundleDigest');
  const verified = verifyEvaluationBundle(
    bundle,
    plan,
    source,
    {
      verifiedCacheRecordDigests,
      verifiedProvenanceBundleDigests: new Set([bundle.bundleDigest as Sha256Digest]),
      executionSourceTrust: effectiveExecutionBundleTrust(source),
    },
  );
  if (verified.planVerification.provenanceTrustStatus !== 'verified'
      || verified.planVerification.cacheReceiptStatus !== 'verified'
      || verified.planVerification.invocationBudgetStatus !== 'verified') {
    throw new TypeError('Evaluation Runtime produced an unverifiable Bundle.');
  }
  return verified;
}

async function prepareEvaluationCoordinates(
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
    const inputs = await materializeBindings(
      plan,
      source,
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
      sourceTrust: minimumTrust(
        effectiveExecutionBundleTrust(prepared.source),
        source.provenance.trust,
      ),
      inputs,
    });
  }
  return result;
}

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
  options: EvaluationRunOptions,
  prepared: PreparedRuntime,
  stream: BoundedEventStream,
): Promise<EvaluationBundleSource> {
  const coordinates = derivePlannedEvaluationCoordinates(plan);
  const records = new Map<string, EvaluationRecord>();
  const pendingCache: EvaluationCacheEntry[] = [];
  const verifiedCacheRecordDigests = new Set<Sha256Digest>();
  const stop: StopState = {};
  const controller = new AbortController();
  const setStop = (stopKind: StopKind, reason: string, error?: EvaluationError): void => {
    if (stop.stopKind === 'failed'
        || (stop.stopKind !== undefined && stopKind !== 'failed')) return;
    stop.stopKind = stopKind;
    stop.reason = reason;
    if (error !== undefined) stop.error = error;
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
  const sessions = new Sessions(plan, options);
  const budget = new Budget(plan);
  const durationController = new AbortController();
  const duration = plan.evaluation.policy.runtime.budget.maxDurationMs === undefined
    ? undefined
    : ports.clock.sleep(
      plan.evaluation.policy.runtime.budget.maxDurationMs,
      durationController.signal,
    ).then(() => setStop('budget-exhausted', 'evaluation-duration-budget-exhausted'))
      .catch(() => undefined);
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
        minimumTrust(
          effectiveExecutionBundleTrust(prepared.source),
          item.source?.provenance.trust ?? effectiveExecutionBundleTrust(prepared.source),
        ),
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
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.record !== undefined) records.set(result.record.evaluationId, result.record);
        if (result.cacheEntry !== undefined) pendingCache.push(result.cacheEntry);
        if (result.verifiedCacheRecordDigest !== undefined) {
          verifiedCacheRecordDigests.add(result.verifiedCacheRecordDigest);
        }
      }
      const failures = results.filter((result) => result.record?.evaluationStatus === 'failed').length;
      const totalFailures = [...records.values()].filter(
        (record) => record.evaluationStatus === 'failed',
      ).length;
      const policy = plan.evaluation.policy.failure;
      if (stop.stopKind === undefined && policy.failureMode === 'fail-fast' && failures > 0) {
        setStop('failed', 'evaluation-failure-policy-fail-fast');
      } else if (stop.stopKind === undefined
          && policy.failureMode === 'failure-threshold'
          && totalFailures > (policy.maxFailures ?? 0)) {
        setStop('failed', 'evaluation-failure-policy-threshold');
      } else if (stop.stopKind === undefined && budget.exhausted) {
        setStop('budget-exhausted', 'evaluation-provider-cost-budget-exhausted');
      }
    }
  } catch (error) {
    if (!(error instanceof EvaluationAttemptCancelledError
        && stop.stopKind !== undefined)) {
      setStop('failed', 'evaluation-runtime-internal-failed', safeError(error));
    }
  } finally {
    durationController.abort();
    await duration;
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
    await events.emitRecovery(terminalKind(source.bundle.evaluationBundleStatus), 'run', options.runId, {
      bundleDigest: source.bundle.bundleDigest,
      evaluationBundleStatus: source.bundle.evaluationBundleStatus,
      coverage: source.bundle.coverage,
    });
  }
  events.close();
  return source;
}

export function startEvaluation(
  plan: SealedRunPlan,
  source: ExecutionBundleSource,
  ports: EvaluationRuntimePorts,
  options: EvaluationRunOptions,
): EvaluationRun {
  const prepared = prepareRuntime(plan, source, ports, options);
  const stream = new BoundedEventStream(options.eventBufferCapacity ?? 256);
  const verified = runEvaluation(plan, ports, options, prepared, stream);
  let result: Promise<EvaluationBundle> | undefined;
  return {
    events: stream,
    source: verified,
    get result() {
      result ??= verified.then((sourceResult) => sourceResult.bundle);
      return result;
    },
  };
}

export async function evaluateExecutionBundle(
  plan: SealedRunPlan,
  source: ExecutionBundleSource,
  ports: EvaluationRuntimePorts,
  options: EvaluationRunOptions,
): Promise<EvaluationBundle> {
  return startEvaluation(plan, source, ports, options).result;
}

export async function evaluateExecutionBundleSource(
  plan: SealedRunPlan,
  source: ExecutionBundleSource,
  ports: EvaluationRuntimePorts,
  options: EvaluationRunOptions,
): Promise<EvaluationBundleSource> {
  return startEvaluation(plan, source, ports, options).source;
}
