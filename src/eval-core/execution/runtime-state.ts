/** Private stage coordination types, separate from public wire contracts. */
import type {
  EvaluationError,
  ExecutionRecord,
  PlannedExecutionCoordinate,
  RuntimeIdentity,
} from '../contracts/index.js';
import type { ProtocolManifest, SealedRunPlan } from '../compiler/index.js';
import type { RunBudgetSource } from '../budget/index.js';
import type { Semaphore } from './semaphore.js';
import type { ExecutionSchedulingBlock } from './scheduler.js';
import type { ExecutionExecutor, ExecutionRunOptions } from './types.js';

export type CompletedExecutionRecord = Extract<ExecutionRecord, { executionStatus: 'completed' }>;
export type ResolvedExecutionRunOptions = ExecutionRunOptions & { budgetSource: RunBudgetSource };


export interface TargetRuntimeBinding {
  target: SealedRunPlan['execution']['targets'][number];
  executor: ExecutionExecutor;
  runtime: RuntimeIdentity;
  protocol: ProtocolManifest;
  semaphore: Semaphore;
}

export interface PreparedRuntime {
  bindings: ReadonlyMap<string, TargetRuntimeBinding>;
  globalSemaphore: Semaphore;
}

export type StopKind = 'cancelled' | 'budget-exhausted' | 'failed';

export interface StopState {
  stopKind?: StopKind;
  reason?: string;
  error?: EvaluationError;
}

export interface PreparedCoordinate {
  coordinate: PlannedExecutionCoordinate;
  cached?: CompletedExecutionRecord;
  reservationId?: string;
}

export interface PreparedBlock {
  block: ExecutionSchedulingBlock;
  coordinates: PreparedCoordinate[];
}



export type ExecutionTerminalEventKind =
  | 'execution.run.completed'
  | 'execution.run.cancelled'
  | 'execution.run.budget-exhausted'
  | 'execution.run.failed';
