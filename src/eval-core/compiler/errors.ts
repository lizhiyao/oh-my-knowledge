import type { EvaluationError, JsonValue } from '../contracts/index.js';

export type EvaluationDefinitionErrorCode =
  | 'EVAL_DEFINITION_SCHEMA_INVALID'
  | 'EVAL_DEFINITION_DUPLICATE_ID'
  | 'EVAL_DEFINITION_MISSING_REFERENCE'
  | 'EVAL_DEFINITION_GRAPH_CYCLE'
  | 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID'
  | 'EVAL_DEFINITION_POLICY_INVALID'
  | 'EVAL_DEFINITION_PROTOCOL_INVALID'
  | 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED'
  | 'EVAL_DEFINITION_RUNTIME_BINDING_INVALID'
  | 'EVAL_DEFINITION_RUNTIME_RESOLUTION_FAILED'
  | 'EVAL_DEFINITION_EXTENSION_INVALID';

export type PreparationStage =
  | 'schema'
  | 'semantics'
  | 'runtime-resolution'
  | 'extension-resolution'
  | 'sealing';

interface EvaluationDefinitionErrorOptions {
  code: EvaluationDefinitionErrorCode;
  stage: 'configuration' | 'infrastructure' | 'internal';
  preparationStage: PreparationStage;
  message: string;
  details?: JsonValue;
  causes?: EvaluationError[];
}

export class EvaluationDefinitionError extends Error implements EvaluationError {
  readonly code: EvaluationDefinitionErrorCode;
  readonly stage: 'configuration' | 'infrastructure' | 'internal';
  readonly preparationStage: PreparationStage;
  readonly details?: JsonValue;
  readonly causes?: EvaluationError[];

  constructor(options: EvaluationDefinitionErrorOptions) {
    super(options.message);
    this.name = 'EvaluationDefinitionError';
    this.code = options.code;
    this.stage = options.stage;
    this.preparationStage = options.preparationStage;
    this.details = options.details;
    this.causes = options.causes;
  }

  toJSON(): EvaluationError & { preparationStage: PreparationStage } {
    return {
      code: this.code,
      stage: this.stage,
      message: this.message,
      preparationStage: this.preparationStage,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(this.causes !== undefined ? { causes: this.causes } : {}),
    };
  }
}

export function definitionError(
  code: EvaluationDefinitionErrorCode,
  message: string,
  details?: JsonValue,
): EvaluationDefinitionError {
  return new EvaluationDefinitionError({
    code,
    stage: 'configuration',
    preparationStage: 'semantics',
    message,
    ...(details !== undefined ? { details } : {}),
  });
}
