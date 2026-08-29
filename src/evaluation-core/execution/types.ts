import type {
  ContentDescriptor,
  EvaluationError,
  EvaluationEvent,
  ExecutionBundle,
  ExecutionBundleSource,
  ExecutionRecord,
  JsonValue,
  RuntimeIdentity,
  Sha256Digest,
  UsageRecord,
} from '../contracts/index.js';
import type { SealedRunPlan } from '../compiler/index.js';
import type { RuntimeEventSequencer } from '../runtime/events.js';

export const EXECUTION_EVENT_KINDS = [
  'execution.run.started',
  'execution.run.completed',
  'execution.run.cancelled',
  'execution.run.budget-exhausted',
  'execution.run.failed',
  'execution.block.started',
  'execution.block.completed',
  'execution.trial.started',
  'execution.trial.completed',
  'execution.attempt.started',
  'execution.attempt.completed',
  'execution.retry.scheduled',
  'execution.cache.hit',
  'execution.cache.miss',
] as const;

export type ExecutionEventKind = typeof EXECUTION_EVENT_KINDS[number];

export type ExecutionEventSubjectKind =
  | 'run'
  | 'scheduling-block'
  | 'trial'
  | 'attempt';

export interface ExecutionContent {
  value: JsonValue;
  classification: 'public' | 'sensitive' | 'secret' | 'gold';
  mediaType?: string;
}

export interface ExecutorRunContext {
  runId: string;
  executionPlanDigest: Sha256Digest;
}

export interface ExecutorTrialContext {
  targetId: string;
  protocolId: 'omk.invoke/v1' | 'omk.session/v1';
  input: JsonValue;
  executionContext?: JsonValue;
  targetConfig?: JsonValue;
  trialIndex: number;
  trialId: Sha256Digest;
  schedulingBlockId: Sha256Digest;
  samplingUnitIds: {
    pairingBlockId?: Sha256Digest;
    clusterId?: Sha256Digest;
    stratumId?: Sha256Digest;
  };
  trialSeed?: Sha256Digest;
}

export interface ExecutorAttemptContext {
  attemptId: Sha256Digest;
  attemptNumber: number;
  signal: AbortSignal;
}

export interface ExecutorAttemptResult {
  output?: ExecutionContent;
  trace?: ExecutionContent;
  usage?: UsageRecord;
}

export interface ExecutionExecutorTrial {
  execute(context: Readonly<ExecutorAttemptContext>): Promise<ExecutorAttemptResult>;
  dispose(): void | Promise<void>;
}

export interface ExecutionExecutorRun {
  openTrial(context: Readonly<ExecutorTrialContext>): Promise<ExecutionExecutorTrial>;
  dispose(): void | Promise<void>;
}

export interface ExecutionExecutor {
  readonly identity: RuntimeIdentity;
  openRun(context: Readonly<ExecutorRunContext>): Promise<ExecutionExecutorRun>;
}

export interface ExecutionClock {
  monotonicNow(): number;
  timestamp(): string;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface ExecutionCacheEntry {
  cacheKeyDigest: Sha256Digest;
  sourceRecordDigest: Sha256Digest;
  record: Extract<ExecutionRecord, { executionStatus: 'completed' }>;
}

export interface ExecutionCache {
  get(cacheKeyDigest: Sha256Digest): Promise<ExecutionCacheEntry | undefined>;
  put(entry: Readonly<ExecutionCacheEntry>): Promise<void>;
}

export interface ExecutionContentStoreRequest extends ExecutionContent {
  digest: Sha256Digest;
  mediaType: string;
}

export interface ExecutionContentStore {
  put(request: Readonly<ExecutionContentStoreRequest>): Promise<ContentDescriptor>;
}

export interface ExecutionEventWriter {
  write(event: Readonly<EvaluationEvent>): Promise<void>;
}

export interface ExecutionRuntimePorts {
  executors: ReadonlyMap<string, ExecutionExecutor>;
  clock: ExecutionClock;
  eventSequencer: RuntimeEventSequencer;
  cache?: ExecutionCache;
  contentStore?: ExecutionContentStore;
  eventWriter?: ExecutionEventWriter;
}

export interface ExecutionRunOptions {
  runId: string;
  bundleId: string;
  signal?: AbortSignal;
  eventBufferCapacity?: number;
}

export interface ExecutionRun {
  events: AsyncIterable<EvaluationEvent>;
  result: Promise<ExecutionBundle>;
  source: Promise<ExecutionBundleSource>;
}

export class ExecutionPortFailure extends Error {
  readonly evaluationError: EvaluationError;
  readonly usage?: UsageRecord;

  constructor(error: EvaluationError, usage?: UsageRecord) {
    super(error.message);
    this.name = 'ExecutionPortFailure';
    this.evaluationError = error;
    this.usage = usage;
  }
}

export class ExecutionRuntimeConfigurationError extends TypeError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExecutionRuntimeConfigurationError';
    this.code = code;
  }
}

export type ExecutionPlan = SealedRunPlan;
