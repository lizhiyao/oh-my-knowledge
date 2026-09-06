import {
  type EvaluationResult,
} from './contracts.js';

/** Stable, redacted event-consumption failure from the canonical facade. */
export class EvaluationEventConsumptionError extends Error {
  readonly code:
    | 'EVAL_RUNTIME_EVENT_OBSERVER_FAILED'
    | 'EVAL_RUNTIME_EVENT_STREAM_FAILED';
  readonly runResult?: EvaluationResult;

  constructor(input: Readonly<{
    code: EvaluationEventConsumptionError['code'];
    message: string;
    runResult?: EvaluationResult;
  }>) {
    super(input.message);
    this.name = 'EvaluationEventConsumptionError';
    this.code = input.code;
    this.runResult = input.runResult;
  }
}

export class EvaluationConfigurationError extends TypeError {
  readonly code:
    | 'EVAL_RUNTIME_INPUT_INVALID'
    | 'EVAL_RUNTIME_EXECUTOR_INVALID'
    | 'EVAL_RUNTIME_VARIANT_INVALID'
    | 'EVAL_RUNTIME_EVALUATOR_INVALID'
    | 'EVAL_RUNTIME_COMPARABILITY_INVALID'
    | 'EVAL_RUNTIME_REUSE_INVALID'
    | 'EVAL_RUNTIME_SERIES_INVALID';

  constructor(code: EvaluationConfigurationError['code'], message: string) {
    super(message);
    this.name = 'EvaluationConfigurationError';
    this.code = code;
  }
}

export function configurationFailure(
  code: EvaluationConfigurationError['code'],
  message: string,
): never {
  throw new EvaluationConfigurationError(code, message);
}
