import { z } from 'zod';
import type {
  EvalSampleSetDocument,
  Sample,
  SampleCoverageTarget,
  SampleEnvironment,
  SampleRubricCriterion,
} from '../contracts/sample.js';
import { RUBRIC_WEIGHT_SUM_TOLERANCE } from '../rubric-contract.js';
import { AssertionSchema } from './assertion.js';
import { MockSchema } from './mock.js';

export const EVAL_SAMPLE_SET_SCHEMA_VERSION = 'omk.eval-sample-set/v2' as const;

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

/** Strict, versioned authoring case shape. Cross-field measurement rules run after parsing. */
export const SampleSchema: z.ZodType<Sample> = z.object({
  sample_id: z.string().min(1),
  prompt: z.string().min(1),
  context: z.string().optional(),
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

export const DependencyRequirementsSchema = z.object({
  tools: z.array(z.string().min(1)).optional(),
  files: z.array(z.string().min(1)).optional(),
  env: z.array(z.string().min(1)).optional(),
  preflight: z.array(z.string().min(1)).optional(),
}).strict();

export const EvalSampleSetDocumentSchema: z.ZodType<EvalSampleSetDocument> = z.object({
  schemaVersion: z.literal(EVAL_SAMPLE_SET_SCHEMA_VERSION),
  requires: DependencyRequirementsSchema.optional(),
  samples: z.array(SampleSchema).min(1),
}).strict().meta({ title: 'OMK Eval Sample Set v2' });

export function createEvalSampleSetDocument(
  samples: Sample[],
  requires?: EvalSampleSetDocument['requires'],
): EvalSampleSetDocument {
  return {
    schemaVersion: EVAL_SAMPLE_SET_SCHEMA_VERSION,
    ...(requires === undefined ? {} : { requires }),
    samples,
  };
}
