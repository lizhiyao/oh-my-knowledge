import type { JsonValue } from '../../evaluation-core/contracts/index.js';

export type CliEvaluationInputErrorCode =
  | 'CLI_INPUT_INVALID'
  | 'CLI_INPUT_DUPLICATE_ID'
  | 'CLI_INPUT_BASELINE_ISOLATION_CONFLICT'
  | 'CLI_INPUT_CONTROL_REQUIRED'
  | 'CLI_INPUT_TREATMENT_REQUIRED'
  | 'CLI_INPUT_RESOURCE_MISSING'
  | 'CLI_INPUT_RESOURCE_KIND_MISMATCH'
  | 'CLI_INPUT_RESOURCE_DIGEST_MISMATCH'
  | 'CLI_INPUT_JUDGE_REQUIRED'
  | 'CLI_INPUT_SERIES_INVALID'
  | 'CLI_INPUT_CORE_SCHEMA_INVALID'
  | 'CLI_INPUT_CORE_SEMANTICS_INVALID'
  | 'CLI_INPUT_RESTRICTED_INLINE_CONTENT';

export class CliEvaluationInputError extends Error {
  readonly code: CliEvaluationInputErrorCode;
  readonly sourcePath?: string;
  readonly fieldPath?: string;
  readonly details?: JsonValue;

  constructor(input: {
    code: CliEvaluationInputErrorCode;
    message: string;
    sourcePath?: string;
    fieldPath?: string;
    details?: JsonValue;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'CliEvaluationInputError';
    this.code = input.code;
    this.sourcePath = input.sourcePath;
    this.fieldPath = input.fieldPath;
    this.details = input.details;
  }
}
