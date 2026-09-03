/**
 * OMK workflow specialization of the public same-process lifecycle adapter.
 * It fixes the generic ResourceLease parameter to product-owned materialized resources.
 */
export type {
  SameProcessOperationScope,
  SameProcessResourceLeaseAccess,
  SameProcessRunScope,
} from '../../../../eval-runtime/adapters/same-process.js';

import type {
  CreateSameProcessEvaluatorAdapterInput as RuntimeEvaluatorAdapterInput,
  CreateSameProcessExecutorAdapterInput as RuntimeExecutorAdapterInput,
  SameProcessEvaluatorImplementation as RuntimeEvaluatorImplementation,
  SameProcessExecutorImplementation as RuntimeExecutorImplementation,
} from '../../../../eval-runtime/adapters/same-process.js';
import {
  createSameProcessEvaluatorAdapter as createRuntimeEvaluatorAdapter,
  createSameProcessExecutorAdapter as createRuntimeExecutorAdapter,
} from '../../../../eval-runtime/adapters/same-process.js';
import type { EvaluationEvaluator } from '../../../../eval-core/evaluation/index.js';
import type { ExecutionExecutor } from '../../../../eval-core/execution/index.js';
import type { OmkBindingResourceLease } from '../../resource-leases/types.js';

export type SameProcessExecutorImplementation<
  RunState,
  TrialState,
  ResourceLease = OmkBindingResourceLease,
> = RuntimeExecutorImplementation<RunState, TrialState, ResourceLease>;

export type SameProcessEvaluatorImplementation<
  RunState,
  RecordState,
  ResourceLease = OmkBindingResourceLease,
> = RuntimeEvaluatorImplementation<RunState, RecordState, ResourceLease>;

export type CreateSameProcessExecutorAdapterInput<
  RunState,
  TrialState,
  ResourceLease = OmkBindingResourceLease,
> = RuntimeExecutorAdapterInput<RunState, TrialState, ResourceLease>;

export type CreateSameProcessEvaluatorAdapterInput<
  RunState,
  RecordState,
  ResourceLease = OmkBindingResourceLease,
> = RuntimeEvaluatorAdapterInput<RunState, RecordState, ResourceLease>;

export function createSameProcessExecutorAdapter<RunState, TrialState>(
  input: Readonly<CreateSameProcessExecutorAdapterInput<RunState, TrialState>>,
): ExecutionExecutor {
  return createRuntimeExecutorAdapter(input);
}

export function createSameProcessEvaluatorAdapter<RunState, RecordState>(
  input: Readonly<CreateSameProcessEvaluatorAdapterInput<RunState, RecordState>>,
): EvaluationEvaluator {
  return createRuntimeEvaluatorAdapter(input);
}
