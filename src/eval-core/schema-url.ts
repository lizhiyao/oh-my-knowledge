import {
  EVALUATION_CORE_JSON_SCHEMA_FILES,
  type EvaluationCoreJsonSchemaFile,
} from './schemas.js';

export {
  EVALUATION_CORE_JSON_SCHEMA_FILES,
  type EvaluationCoreJsonSchemaFile,
};

const schemaFiles = new Set<string>(EVALUATION_CORE_JSON_SCHEMA_FILES);

/** Package-boundary locator; Core measurement modules never depend on module location. */
export function resolveEvaluationCoreJsonSchema(
  fileName: EvaluationCoreJsonSchemaFile,
): URL {
  if (!schemaFiles.has(fileName)) {
    throw new TypeError(`Unknown Evaluation Core JSON Schema: ${String(fileName)}`);
  }
  return new URL(`./contracts/schemas/v1/${fileName}`, import.meta.url);
}
