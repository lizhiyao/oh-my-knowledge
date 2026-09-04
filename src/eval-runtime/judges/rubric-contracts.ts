import {
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type SchemaIdentity,
} from '../../eval-core/contracts/index.js';
import type { OmkLlmJudgeEffort } from './invocation.js';

export const RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID =
  'omk.rubric-judge/v1' as const;
export const RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION =
  'omk.rubric-judge-instrument/v1' as const;
export const RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION =
  'omk.rubric-judge-context/v1' as const;
export const RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION =
  'omk.rubric-judge-evidence/v1' as const;
export const RUBRIC_JUDGE_BINDINGS = Object.freeze({
  actual: 'actual',
  criterion: 'criterion',
  trace: 'trace',
});

export type RubricJudgeTracePolicy = 'none' | 'source-neutral';

type JsonObject = Readonly<{ [key: string]: JsonValue }>;

export type RubricJudgeInstrument = JsonObject & {
  readonly schemaVersion: typeof RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION;
  readonly promptId: 'rubric-judge-debias-on' | 'rubric-judge-debias-off';
  readonly promptHash: string;
  readonly lengthDebias: boolean;
  readonly tracePolicy: RubricJudgeTracePolicy;
};

export type RubricJudgeRuntimeConfig = JsonObject & {
  readonly executorId: string;
  readonly model: string;
  readonly deploymentRevision?: string;
  readonly effort?: OmkLlmJudgeEffort;
  readonly promptVariant: string;
};

export type RubricJudgeConfig = JsonObject & {
  readonly evaluator: JsonObject & {
    readonly classification: 'public' | 'sensitive';
    readonly value: RubricJudgeInstrument;
  };
  readonly runtime: RubricJudgeRuntimeConfig;
};

export type RubricJudgeCriterion = JsonObject & {
  readonly schemaVersion: typeof RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION;
  readonly criterionId: string;
  readonly prompt: string;
  readonly rubric: string;
};

const INSTRUMENT_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:rubric-judge-instrument:v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'promptId', 'promptHash', 'lengthDebias', 'tracePolicy'],
  properties: {
    schemaVersion: { const: RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION },
    promptId: { enum: ['rubric-judge-debias-on', 'rubric-judge-debias-off'] },
    promptHash: { type: 'string', pattern: '^[0-9a-f]{12}$' },
    lengthDebias: { type: 'boolean' },
    tracePolicy: { enum: ['none', 'source-neutral'] },
  },
};

const CONTEXT_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:rubric-judge-context:v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'criterionId', 'prompt', 'rubric'],
  properties: {
    schemaVersion: { const: RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION },
    criterionId: { type: 'string', minLength: 1, maxLength: 256 },
    prompt: { type: 'string' },
    rubric: { type: 'string', minLength: 1 },
  },
};

const EVIDENCE_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:rubric-judge-evidence:v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'criterionId',
    'promptId',
    'promptHash',
    'lengthDebias',
    'tracePolicy',
    'score',
    'reason',
  ],
  properties: {
    schemaVersion: { const: RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION },
    criterionId: { type: 'string' },
    promptId: { type: 'string' },
    promptHash: { type: 'string' },
    lengthDebias: { type: 'boolean' },
    tracePolicy: { enum: ['none', 'source-neutral'] },
    score: { type: 'integer', minimum: 1, maximum: 5 },
    reason: { type: 'string', minLength: 1 },
    reasoning: { type: 'string', minLength: 1 },
  },
};

function schemaIdentity(
  schemaVersion: string,
  schemaUri: string,
  schema: JsonValue,
): SchemaIdentity {
  return deepFreezeCanonicalJson({
    schemaVersion,
    schemaUri,
    schemaDigest: digestCanonicalJson(schema),
  });
}

export const RUBRIC_JUDGE_INSTRUMENT_SCHEMA = schemaIdentity(
  RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION,
  'urn:omk:rubric-judge-instrument:v1',
  INSTRUMENT_SCHEMA_DOCUMENT,
);
export const RUBRIC_JUDGE_CONTEXT_SCHEMA = schemaIdentity(
  RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
  'urn:omk:rubric-judge-context:v1',
  CONTEXT_SCHEMA_DOCUMENT,
);
export const RUBRIC_JUDGE_EVIDENCE_SCHEMA = schemaIdentity(
  RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION,
  'urn:omk:rubric-judge-evidence:v1',
  EVIDENCE_SCHEMA_DOCUMENT,
);
