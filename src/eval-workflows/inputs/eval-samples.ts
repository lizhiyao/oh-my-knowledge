export type {
  Assertion,
} from './contracts/assertion.js';
export type {
  Mock,
  MockMatch,
  MockReturn,
} from '../../executors/contracts/mock.js';
export type {
  EvalSampleSetDocument,
  AuthoredSample as Sample,
  SampleCheck,
  SampleCoverageTarget,
  SampleCoverageTargetKind,
  SampleDifficulty,
  SampleEnvironment,
  SampleProvenance,
  SampleRubric,
  SampleRubricCriterion,
} from './contracts/sample.js';
export {
  EVAL_SAMPLE_SET_SCHEMA_VERSION,
  createEvalSampleSetDocument,
  EvalSampleSetDocumentSchema,
  AuthoredSampleSchema,
} from './schemas/sample-set.js';

export const EVAL_SAMPLE_JSON_SCHEMA_FILES = [
  'eval-sample-set.schema.json',
] as const;

export type EvalSampleJsonSchemaFile = typeof EVAL_SAMPLE_JSON_SCHEMA_FILES[number];

const schemaFiles = new Set<string>(EVAL_SAMPLE_JSON_SCHEMA_FILES);

/** Resolves a shipped sample JSON Schema without relying on an unexported dist path. */
export function resolveEvalSampleJsonSchema(fileName: EvalSampleJsonSchemaFile): URL {
  if (!schemaFiles.has(fileName)) {
    throw new TypeError(`Unknown Eval Sample JSON Schema: ${String(fileName)}`);
  }
  return new URL(`./contracts/schemas/v3/${fileName}`, import.meta.url);
}

export { SampleInputSchema, SampleMessageSchema, type SampleInput, type SampleMessage } from './schemas/sample-input.js';
