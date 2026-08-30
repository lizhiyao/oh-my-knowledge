import type {
  ContentDescriptor,
  EvaluationBundle,
  EvaluationBundleSource,
  EvaluationError,
  EvaluationEvent,
  EvaluationRecord,
  JsonValue,
  MetricDefinition,
  RuntimeIdentity,
  Sha256Digest,
  UsageRecord,
} from '../contracts/index.js';
import type { SealedRunPlan } from '../compiler/index.js';
import type { RuntimeEventSequencer } from '../runtime/events.js';

export const EVALUATION_RUNTIME_EVENT_KINDS = [
  'evaluation.run.started',
  'evaluation.run.completed',
  'evaluation.run.cancelled',
  'evaluation.run.budget-exhausted',
  'evaluation.run.failed',
  'evaluation.record.not-evaluated',
  'evaluation.record.started',
  'evaluation.record.completed',
  'evaluation.attempt.started',
  'evaluation.attempt.completed',
  'evaluation.retry.scheduled',
  'evaluation.cache.hit',
  'evaluation.cache.miss',
] as const;

export type EvaluationRuntimeEventKind = typeof EVALUATION_RUNTIME_EVENT_KINDS[number];

export interface EvaluationContent {
  value: JsonValue;
  classification: 'public' | 'sensitive' | 'secret' | 'gold';
  mediaType?: string;
}

export interface EvaluatorBindingValue extends EvaluationContent {
  bindingId: string;
  sourceKind: 'output' | 'trace' | 'expected' | 'evaluation-context';
}

export type EvaluatorObservation = {
  metricId: string;
  observationStatus: 'observed';
  valueType: 'numeric';
  value: number;
  evidence?: EvaluationContent;
  metadata?: EvaluationContent;
} | {
  metricId: string;
  observationStatus: 'observed';
  valueType: 'boolean';
  value: boolean;
  evidence?: EvaluationContent;
  metadata?: EvaluationContent;
} | {
  metricId: string;
  observationStatus: 'observed';
  valueType: 'categorical' | 'text';
  value: string;
  evidence?: EvaluationContent;
  metadata?: EvaluationContent;
} | {
  metricId: string;
  observationStatus: 'observed';
  valueType: 'ranking';
  value: string[];
  evidence?: EvaluationContent;
  metadata?: EvaluationContent;
} | {
  metricId: string;
  observationStatus: 'missing';
  valueType: 'numeric' | 'boolean' | 'categorical' | 'text' | 'ranking';
  reasonCode: string;
  evidence?: EvaluationContent;
  metadata?: EvaluationContent;
} | {
  metricId: string;
  observationStatus: 'invalid';
  valueType: 'numeric' | 'boolean' | 'categorical' | 'text' | 'ranking';
  reasonCode: string;
  invalidValue?: EvaluationContent;
  evidence?: EvaluationContent;
  metadata?: EvaluationContent;
};

export interface EvaluatorRunContext {
  runId: string;
  evaluationPlanDigest: Sha256Digest;
}

export interface EvaluatorRecordContext {
  targetId: string;
  sampleId: string;
  trialIndex: number;
  trialId: Sha256Digest;
  evaluatorId: string;
  measurement: {
    instrumentId: string;
    ensembleMemberId: string;
    replicateGroupId: string;
    replicateIndex: number;
  };
  evaluationId: Sha256Digest;
  evaluatorConfig?: JsonValue;
  bindings: readonly EvaluatorBindingValue[];
  metrics: readonly MetricDefinition[];
}

export interface EvaluatorAttemptContext {
  attemptId: Sha256Digest;
  attemptNumber: number;
  signal: AbortSignal;
}

export interface EvaluatorAttemptResult {
  observations: readonly EvaluatorObservation[];
  usage?: UsageRecord;
  evidence?: EvaluationContent;
}

export interface EvaluationEvaluatorRecord {
  evaluate(context: Readonly<EvaluatorAttemptContext>): Promise<EvaluatorAttemptResult>;
  dispose(): void | Promise<void>;
}

export interface EvaluationEvaluatorRun {
  openRecord(context: Readonly<EvaluatorRecordContext>): Promise<EvaluationEvaluatorRecord>;
  dispose(): void | Promise<void>;
}

export interface EvaluationEvaluator {
  readonly identity: RuntimeIdentity;
  openRun(context: Readonly<EvaluatorRunContext>): Promise<EvaluationEvaluatorRun>;
}

export interface EvaluationClock {
  monotonicNow(): number;
  timestamp(): string;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface EvaluationContentResolver {
  resolve(descriptor: Readonly<ContentDescriptor>): Promise<EvaluationContent>;
}

export interface EvaluationContentStoreRequest extends EvaluationContent {
  digest: Sha256Digest;
  mediaType: string;
}

export interface EvaluationContentStore {
  put(request: Readonly<EvaluationContentStoreRequest>): Promise<ContentDescriptor>;
}

export interface EvaluationCacheEntry {
  cacheKeyDigest: Sha256Digest;
  cachedRecordDigest: Sha256Digest;
  record: Extract<EvaluationRecord, { evaluationStatus: 'completed' }>;
}

export interface EvaluationCache {
  get(cacheKeyDigest: Sha256Digest): Promise<EvaluationCacheEntry | undefined>;
  put(entry: Readonly<EvaluationCacheEntry>): Promise<void>;
}

export interface EvaluationEventWriter {
  write(event: Readonly<EvaluationEvent>): Promise<void>;
}

export interface EvaluationRuntimePorts {
  evaluators: ReadonlyMap<string, EvaluationEvaluator>;
  clock: EvaluationClock;
  eventSequencer: RuntimeEventSequencer;
  contentResolver?: EvaluationContentResolver;
  contentStore?: EvaluationContentStore;
  cache?: EvaluationCache;
  eventWriter?: EvaluationEventWriter;
}

export interface EvaluationRunOptions {
  runId: string;
  bundleId: string;
  signal?: AbortSignal;
  eventBufferCapacity?: number;
}

export interface EvaluationRun {
  events: AsyncIterable<EvaluationEvent>;
  result: Promise<EvaluationBundle>;
  source: Promise<EvaluationBundleSource>;
}

export class EvaluationPortFailure extends Error {
  readonly evaluationError: EvaluationError;
  readonly usage?: UsageRecord;

  constructor(error: EvaluationError, usage?: UsageRecord) {
    super(error.message);
    this.name = 'EvaluationPortFailure';
    this.evaluationError = error;
    this.usage = usage;
  }
}

export class EvaluationRuntimeConfigurationError extends TypeError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EvaluationRuntimeConfigurationError';
    this.code = code;
  }
}

export type EvaluationRuntimePlan = SealedRunPlan;
