import { normalizeAuthoredSample, authorSample } from '../sample-mapping.js';
import { sampleContractValidationError } from '../sample-contract.js';
import { z } from 'zod';
import { JsonValueSchema, JsonPointerSchema } from '../../../eval-core/contracts/index.js';
import { SampleInputSchema } from './sample-input.js';
import type {
  EvalSampleSetDocument,
  AuthoredSample,
  Sample,
  SampleCoverageTarget,
  SampleEnvironment,
  SampleRubricCriterion,
} from '../contracts/sample.js';
import { RUBRIC_WEIGHT_SUM_TOLERANCE } from '../rubric-contract.js';
import { AssertionSchema } from './assertion.js';
import { MockSchema } from './mock.js';

export const EVAL_SAMPLE_SET_SCHEMA_VERSION = 'omk.eval-sample-set/v3' as const;

export const SampleCoverageTargetSchema: z.ZodType<SampleCoverageTarget> = z.object({
  targetKind: z.enum([
    'skill',
    'skill_file',
    'frontmatter',
    'reference',
    'script',
    'hard_rule',
    'workflow',
    'workflow_node',
  ]),
  ref: z.string().min(1),
}).strict();

export const SampleEnvironmentSchema: z.ZodType<SampleEnvironment> = z.object({
  cli_available: z.array(z.string().min(1)).optional(),
  files_available: z.array(z.string().min(1)).optional(),
  notes: z.string().optional(),
}).strict();

export const SampleRubricCriterionSchema: z.ZodType<SampleRubricCriterion> = z.object({
  criterion: z.string().min(1).refine((value) => value.trim().length > 0, {
    message: 'Rubric criterion must not be blank.',
  }),
  weight: z.number().finite().positive().max(1),
}).strict();

const SampleRubricSchema = z.record(
  z.string().min(1).refine((value) => value.trim().length > 0, {
    message: 'Rubric dimension name must not be blank.',
  }),
  SampleRubricCriterionSchema,
).refine((rubric) => Object.keys(rubric).length > 0, {
  message: 'Rubric must contain at least one dimension.',
}).refine((rubric) => (
  Math.abs(Object.values(rubric).reduce((sum, entry) => sum + entry.weight, 0) - 1)
    <= RUBRIC_WEIGHT_SUM_TOLERANCE
), {
  message: 'Rubric weights must sum to 1.',
});

const SampleChecksSchema = z.array(z.object({
  checkKind: z.literal('exact-match'),
  checkId: z.string().min(1).max(256),
  actual: z.object({ sourceKind: z.enum(['output', 'trace']), pointer: JsonPointerSchema }).strict(),
  expectedPointer: JsonPointerSchema,
  layer: z.enum(['fact', 'behavior']),
  weight: z.number().finite().positive().optional(),
}).strict()).min(1).refine((checks) => new Set(checks.map((check) => check.checkId)).size === checks.length,
  { message: 'checkId must be unique within each sample.' });

/** Normalized workflow DTO; the public authoring envelope is AuthoredSampleSchema. */
export const SampleSchema: z.ZodType<Sample> = z.object({
  sample_id: z.string().min(1).max(256).refine((value) => value.trim().length > 0),
  input: SampleInputSchema,
  reference: z.string().optional(),
  expected: JsonValueSchema.optional(),
  checks: SampleChecksSchema.optional(),
  executionData: JsonValueSchema.optional(),
  cwd: z.string().min(1).optional(),
  rubric: SampleRubricSchema.optional(),
  assertions: z.array(AssertionSchema).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  capability: z.array(z.string().min(1)).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  construct: z.string().min(1).optional(),
  provenance: z.enum(['human', 'llm-generated', 'production-trace']).optional(),
  covers: z.array(SampleCoverageTargetSchema).optional(),
  tripwire: z.boolean().optional(),
  mocks: z.array(MockSchema).min(1).optional(),
  mocksStrict: z.boolean().optional(),
  environment: SampleEnvironmentSchema.optional(),
}).strict();

export const AuthoredSampleSchema: z.ZodType<AuthoredSample> = z.object({
  sampleId: z.string().min(1).max(256).refine((value) => value.trim().length > 0),
  input: SampleInputSchema,
  executionContext: z.object({
    cwd: z.string().min(1).optional(),
    allowedTools: z.array(z.string().min(1)).optional(),
    mocks: z.array(MockSchema).min(1).optional(),
    mocksStrict: z.boolean().optional(),
    environment: SampleEnvironmentSchema.optional(),
    data: JsonValueSchema.optional(),
  }).strict().optional(),
  expected: JsonValueSchema.optional(),
  evaluationContext: z.object({
    rubric: SampleRubricSchema.optional(),
    assertions: z.array(AssertionSchema).optional(),
    reference: z.string().optional(),
    checks: SampleChecksSchema.optional(),
  }).strict().optional(),
  annotations: z.object({
    capability: z.array(z.string().min(1)).optional(),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    construct: z.string().min(1).optional(),
    provenance: z.enum(['human', 'llm-generated', 'production-trace']).optional(),
    covers: z.array(SampleCoverageTargetSchema).optional(),
    tripwire: z.boolean().optional(),
  }).strict().optional(),
}).strict().superRefine((sample, context) => {
  const error = sampleContractValidationError(normalizeAuthoredSample(sample));
  if (error !== undefined) context.addIssue({ code: 'custom', message: error });
});

export const DependencyRequirementsSchema = z.object({
  tools: z.array(z.string().min(1)).optional(),
  files: z.array(z.string().min(1)).optional(),
  env: z.array(z.string().min(1)).optional(),
  preflight: z.array(z.string().min(1)).optional(),
}).strict();

export const EvalSampleSetDocumentSchema: z.ZodType<EvalSampleSetDocument> = z.object({
  schemaVersion: z.literal(EVAL_SAMPLE_SET_SCHEMA_VERSION),
  requires: DependencyRequirementsSchema.optional(),
  samples: z.array(AuthoredSampleSchema).min(1),
}).strict().superRefine((document, context) => {
  const firstIndexById = new Map<string, number>();
  for (const [index, sample] of document.samples.entries()) {
    const first = firstIndexById.get(sample.sampleId);
    if (first !== undefined) context.addIssue({ code: 'custom', path: ['samples', index, 'sampleId'],
      message: `duplicate sampleId "${sample.sampleId}" at samples[${index}] (first defined at samples[${first}])` });
    else firstIndexById.set(sample.sampleId, index);
  }
}).meta({ title: 'OMK Eval Sample Set v3' });

export function createWorkflowSampleSetDocument(
  samples: Sample[],
  requires?: EvalSampleSetDocument['requires'],
): EvalSampleSetDocument {
  return createEvalSampleSetDocument(samples.map(authorSample), requires);
}

/** Public constructor uses the same canonical envelope as JSON/YAML authoring. */
export function createEvalSampleSetDocument(
  samples: AuthoredSample[],
  requires?: EvalSampleSetDocument['requires'],
): EvalSampleSetDocument {
  return {
    schemaVersion: EVAL_SAMPLE_SET_SCHEMA_VERSION,
    ...(requires === undefined ? {} : { requires: structuredClone(requires) }),
    samples: structuredClone(samples),
  };
}
