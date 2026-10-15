/** Private stage coordination types, separate from public wire contracts. */
import type {
  EvaluationError,
  ExecutionBundleSource,
  ExecutionRecord,
  PlannedEvaluationCoordinate,
  Provenance,
  RuntimeIdentity,
  Sha256Digest,
} from '../contracts/index.js';
import type { SealedRunPlan } from '../compiler/index.js';
import type { RunBudgetSource } from '../budget/index.js';
import type { EvaluationEvaluator, EvaluationRunOptions, EvaluatorBindingValue } from './types.js';

export type ResolvedEvaluationRunOptions = EvaluationRunOptions & { budgetSource: RunBudgetSource };
export type StopKind = 'cancelled' | 'budget-exhausted' | 'failed';

export interface StopState {
  stopKind?: StopKind;
  reason?: string;
  error?: EvaluationError;
}

export interface EvaluatorBinding {
  evaluator: SealedRunPlan['evaluation']['evaluators'][number];
  port: EvaluationEvaluator;
  runtime: RuntimeIdentity;
}

export interface PreparedRuntime {
  bindings: ReadonlyMap<string, EvaluatorBinding>;
  source: ExecutionBundleSource;
}

export interface EligibleCoordinate {
  coordinate: PlannedEvaluationCoordinate;
  binding: EvaluatorBinding;
  source: Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>;
  sourceRecordDigest: Sha256Digest;
  sourceTrust: Provenance['trust'];
  inputs: readonly EvaluatorBindingValue[];
}

export type EvaluationTerminalEventKind =
  | 'evaluation.run.completed'
  | 'evaluation.run.cancelled'
  | 'evaluation.run.budget-exhausted'
  | 'evaluation.run.failed';
