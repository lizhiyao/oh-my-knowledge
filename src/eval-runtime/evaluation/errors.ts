import {
  type EvaluationResult,
  type ExecutedEvaluation,
} from './contracts.js';

/** Stable, redacted event-consumption failure from the canonical facade. */
export class EvaluationEventConsumptionError extends Error {
  readonly code:
    | 'EVAL_RUNTIME_EVENT_OBSERVER_FAILED'
    | 'EVAL_RUNTIME_EVENT_STREAM_FAILED';
  readonly runResult?: EvaluationResult;
  /** Set by the execute-only entry, whose consumed work is a handle rather than a scored Run. */
  readonly executed?: ExecutedEvaluation;

  constructor(input: Readonly<{
    code: EvaluationEventConsumptionError['code'];
    message: string;
    runResult?: EvaluationResult;
    executed?: ExecutedEvaluation;
  }>) {
    super(input.message);
    this.name = 'EvaluationEventConsumptionError';
    this.code = input.code;
    this.runResult = input.runResult;
    this.executed = input.executed;
  }
}

/**
 * Redacted origin of a failure that a facade boundary re-reports under its own code.
 * Carries only the underlying stable code, never the wrapped error's text: message and
 * cause stay free of host data. `code` is present only for `failureKind: 'configuration'`.
 */
export type EvaluationFailureOrigin = Readonly<{
  failureKind: 'configuration' | 'invariant' | 'unknown';
  code?: string;
}>;

export class EvaluationConfigurationError extends TypeError {
  readonly code:
    | 'EVAL_RUNTIME_INPUT_INVALID'
    | 'EVAL_RUNTIME_EXECUTOR_INVALID'
    | 'EVAL_RUNTIME_VARIANT_INVALID'
    | 'EVAL_RUNTIME_EVALUATOR_INVALID'
    | 'EVAL_RUNTIME_COMPARABILITY_INVALID'
    | 'EVAL_RUNTIME_REUSE_INVALID'
    | 'EVAL_RUNTIME_SERIES_INVALID';
  /** Set only when a boundary wraps another failure; absent on a direct rejection. */
  declare readonly cause: EvaluationFailureOrigin | undefined;

  constructor(
    code: EvaluationConfigurationError['code'],
    message: string,
    origin?: EvaluationFailureOrigin,
  ) {
    super(message, origin === undefined ? undefined : { cause: origin });
    this.name = 'EvaluationConfigurationError';
    this.code = code;
  }
}

export function configurationFailure(
  code: EvaluationConfigurationError['code'],
  message: string,
  origin?: EvaluationFailureOrigin,
): never {
  throw new EvaluationConfigurationError(code, message, origin);
}
