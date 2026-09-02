import {
  EVALUATION_CORE_JSON_SCHEMA_FILES,
  type EvaluationCoreJsonSchemaFile,
} from '../evaluation-core/schemas.js';

export {
  EVALUATION_CORE_JSON_SCHEMA_FILES,
  type EvaluationCoreJsonSchemaFile,
};

const schemaFiles = new Set<string>(EVALUATION_CORE_JSON_SCHEMA_FILES);

/** Resolves one shipped JSON Schema without reading files or relying on `dist/*` deep imports. */
export function resolveEvaluationCoreJsonSchema(
  fileName: EvaluationCoreJsonSchemaFile,
): URL {
  if (!schemaFiles.has(fileName)) {
    throw new TypeError(`Unknown Evaluation Core JSON Schema: ${String(fileName)}`);
  }
  return new URL(`../evaluation-core/contracts/schemas/v1/${fileName}`, import.meta.url);
}
