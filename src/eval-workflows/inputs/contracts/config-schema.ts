import { z } from 'zod';
import { DEFAULT_BOOTSTRAP_SAMPLES } from '../../analysis/bootstrap.js';
import {
  DEFAULT_EVALUATION_TIMEOUT_MS,
  DEFAULT_MINIMUM_COMPARISON_UNITS,
  DEFAULT_TARGET_POWER,
} from '../../evaluation-defaults.js';

export const EVAL_CONFIG_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const EVAL_CONFIG_DEFAULTS = Object.freeze({
  effort: 'low' as const,
  concurrency: 1,
  timeoutMs: DEFAULT_EVALUATION_TIMEOUT_MS,
  repeat: 1,
  judgeRepeat: 1,
  bootstrap: true,
  bootstrapSamples: DEFAULT_BOOTSTRAP_SAMPLES,
  lengthDebias: true,
  strictBaseline: true,
  noJudge: false,
  minimumComparisonUnits: DEFAULT_MINIMUM_COMPARISON_UNITS,
  targetPower: DEFAULT_TARGET_POWER,
});

function numberWhere(message: string, predicate: (value: number) => boolean) {
  return z.number({ error: message }).refine(predicate, { error: message });
}
const positiveInteger = numberWhere('must be a positive integer (≥ 1)',
  (value) => Number.isInteger(value) && value >= 1);
const positiveNumber = numberWhere('must be a finite number greater than 0', (value) => value > 0);
export const EVAL_CONFIG_NUMBER_SCHEMAS = {
  concurrency: positiveInteger,
  timeoutMs: positiveInteger,
  repeat: positiveInteger,
  judgeRepeat: positiveInteger,
  bootstrapSamples: numberWhere('must be an integer ≥ 100',
    (value) => Number.isInteger(value) && value >= 100),
  holdoutRatio: numberWhere('must be a number in (0, 1)', (value) => value > 0 && value < 1),
  budgetTotalUSD: positiveNumber,
  budgetPerSampleUSD: positiveNumber,
  budgetPerSampleMs: positiveNumber.refine(Number.isInteger, { error: 'must be an integer' }),
  threshold: numberWhere('must be in [1, 5]', (value) => value >= 1 && value <= 5),
  trivialDifference: numberWhere('must be in [0, 4]', (value) => value >= 0 && value <= 4),
  minimumComparisonUnits: numberWhere('must be a positive safe integer',
    (value) => Number.isSafeInteger(value) && value >= 1),
  minimumDetectableDifference: numberWhere('must be in (0, 4]', (value) => value > 0 && value <= 4),
  expectedDifferenceStandardDeviation: numberWhere('must be in (0, 4]', (value) => value > 0 && value <= 4),
  targetPower: numberWhere('must be in (0.5, 1)', (value) => value > 0.5 && value < 1),
} as const;

// These CLI decoding ranges intentionally differ from the YAML config surface.
export const EVAL_CLI_NUMBER_SCHEMAS = {
  timeoutSeconds: positiveNumber,
  retry: numberWhere('must be a non-negative integer',
    (value) => Number.isInteger(value) && value >= 0),
  threshold: z.number(),
  trivialDifference: numberWhere('must be non-negative', (value) => value >= 0),
} as const;

function nonEmptyString(message = 'must be a non-empty string') {
  return z.string({ error: message }).min(1, { error: message });
}
const optionalString = z.string({ error: 'must be a string' }).optional();
const optionalBoolean = z.boolean({ error: 'must be a boolean' }).optional();
const GitSchema = z.object({
  url: nonEmptyString('is required and must be a string'),
  ref: nonEmptyString().optional(),
  spec: nonEmptyString('is required and must be a string (in-repo skill path)'),
}, { error: 'must be an object { url, ref?, spec }' });

const VariantShape = z.object({
  name: nonEmptyString('is required and must be a string'),
  role: z.enum(['control', 'treatment'], { error: "must be 'control' or 'treatment'" }),
  artifact: nonEmptyString().optional(),
  git: GitSchema.optional(),
  cwd: optionalString,
  allowedSkills: z.array(nonEmptyString(), { error: 'must be an array of strings (use [] to disable skill discovery)' })
    .max(0, { error: 'non-empty skill whitelist is no longer supported; use [] or omit the field' }).optional(),
}, { error: 'must be an object' }).superRefine((value, context) => {
  if ((value.artifact !== undefined) === (value.git !== undefined)) {
    context.addIssue({ code: 'custom', message: "must have exactly one of 'artifact' or 'git'" });
  }
});
export type EvalConfigVariant = z.output<typeof VariantShape>;
const VariantSchema = VariantShape.transform((value): EvalConfigVariant => ({ ...value, cwd: value.cwd }));
const JudgeSchema = z.object({
  executor: nonEmptyString(),
  model: nonEmptyString(),
  deploymentRevision: z.string({ error: 'must be a non-empty string' })
    .trim().min(1, { error: 'must be a non-empty string' }).optional(),
}, { error: 'must be an object {executor, model}' });

const BudgetShape = z.object({
  totalUSD: EVAL_CONFIG_NUMBER_SCHEMAS.budgetTotalUSD.optional(),
  perSampleUSD: EVAL_CONFIG_NUMBER_SCHEMAS.budgetPerSampleUSD.optional(),
  perSampleMs: EVAL_CONFIG_NUMBER_SCHEMAS.budgetPerSampleMs.optional(),
}, { error: 'must be an object' });
export type EvalBudget = z.output<typeof BudgetShape>;
const BudgetSchema = BudgetShape.transform((value): EvalBudget => ({
  totalUSD: value.totalUSD,
  perSampleUSD: value.perSampleUSD,
  perSampleMs: value.perSampleMs,
}));

const PowerSchema = z.strictObject({
  minimumDetectableDifference: EVAL_CONFIG_NUMBER_SCHEMAS.minimumDetectableDifference,
  expectedDifferenceStandardDeviation: EVAL_CONFIG_NUMBER_SCHEMAS.expectedDifferenceStandardDeviation,
  // Preserve the existing distinction: absent stays absent; explicit null becomes the default.
  targetPower: z.preprocess((value) => value === null ? EVAL_CONFIG_DEFAULTS.targetPower : value,
    EVAL_CONFIG_NUMBER_SCHEMAS.targetPower).optional(),
  assumptionSource: z.string({ error: 'must be a non-empty string' })
    .trim().min(1, { error: 'must be a non-empty string' }),
}, { error: 'must be an object' });
export type EvalDecisionPowerConfig = z.output<typeof PowerSchema>;
const DecisionSchema = z.strictObject({
  threshold: EVAL_CONFIG_NUMBER_SCHEMAS.threshold.optional(),
  trivialDifference: EVAL_CONFIG_NUMBER_SCHEMAS.trivialDifference.optional(),
  minimumComparisonUnits: EVAL_CONFIG_NUMBER_SCHEMAS.minimumComparisonUnits.optional(),
  power: PowerSchema.optional(),
}, { error: 'must be an object' }).superRefine((value, context) => {
  if (value.minimumComparisonUnits !== undefined && value.power !== undefined) {
    context.addIssue({ code: 'custom', message: 'minimumComparisonUnits and decision.power are mutually exclusive' });
  }
});
export type EvalDecisionConfig = z.output<typeof DecisionSchema>;

const ConfigShape = z.object({
  samples: nonEmptyString('is required and must be a string'),
  executor: optionalString,
  model: optionalString,
  effort: z.enum(EVAL_CONFIG_EFFORTS, { error: 'must be one of low/medium/high/xhigh/max' }).optional(),
  noDiagnostic: optionalBoolean,
  skipDoctor: optionalBoolean,
  judgeModels: z.array(JudgeSchema, { error: 'must be an array of {executor, model}' })
    .min(1, { error: 'must have ≥ 1 entry (omit the field for default judge)' })
    .superRefine((values, context) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        const key = `${value.executor}:${value.model}`;
        if (seen.has(key)) context.addIssue({ code: 'custom', path: [index], message: `is a duplicate entry "${key}"` });
        seen.add(key);
      });
    }).optional(),
  concurrency: EVAL_CONFIG_NUMBER_SCHEMAS.concurrency.optional(),
  timeoutMs: EVAL_CONFIG_NUMBER_SCHEMAS.timeoutMs.optional(),
  noJudge: optionalBoolean,
  mcpConfig: optionalString,
  variants: z.array(VariantSchema, { error: 'is required and must be a non-empty array' })
    .min(1, { error: 'is required and must be a non-empty array' })
    .superRefine((values, context) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value.name)) context.addIssue({ code: 'custom', path: [index, 'name'], message: `"${value.name}" is duplicated` });
        seen.add(value.name);
      });
    }),
  budget: BudgetSchema.optional(),
  repeat: EVAL_CONFIG_NUMBER_SCHEMAS.repeat.optional(),
  holdoutRatio: EVAL_CONFIG_NUMBER_SCHEMAS.holdoutRatio.optional(),
  judgeRepeat: EVAL_CONFIG_NUMBER_SCHEMAS.judgeRepeat.optional(),
  bootstrap: optionalBoolean,
  bootstrapSamples: EVAL_CONFIG_NUMBER_SCHEMAS.bootstrapSamples.optional(),
  goldDir: optionalString,
  lengthDebias: optionalBoolean,
  strictBaseline: optionalBoolean,
  decision: DecisionSchema.optional(),
}, { error: 'top level must be an object' });
export type EvalConfig = z.output<typeof ConfigShape>;
export const EvalConfigSchema = ConfigShape.transform((value): EvalConfig => {
  const config = { ...value };
  // The loader historically materializes optional top-level keys as undefined.
  for (const key of Object.keys(ConfigShape.shape)) {
    if (!Object.hasOwn(config, key)) {
      Object.defineProperty(config, key, { value: undefined, enumerable: true, writable: true, configurable: true });
    }
  }
  return config;
});

type ConfigPaths<Value> = {
  [Key in keyof Value & string]-?: Key | (
    NonNullable<Value[Key]> extends readonly (infer Element)[]
      ? Element extends object ? `${Key}[].${ConfigPaths<Element>}` : never
      : NonNullable<Value[Key]> extends object ? `${Key}.${ConfigPaths<NonNullable<Value[Key]>>}` : never
  );
}[keyof Value & string];
export type EvalConfigSourcePath = ConfigPaths<EvalConfig>;

function pathsOf(schema: unknown, prefix = ''): string[] {
  if (schema instanceof z.ZodOptional) return pathsOf(schema.unwrap(), prefix);
  if (schema instanceof z.ZodPipe) return pathsOf(schema.in, prefix);
  if (schema instanceof z.ZodArray) return pathsOf(schema.element, `${prefix}[]`);
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.entries(schema.shape).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...pathsOf(child, path)];
  });
}
export const EVAL_CONFIG_SCHEMA_SOURCE_PATHS: readonly EvalConfigSourcePath[] = Object.freeze(
  pathsOf(ConfigShape) as EvalConfigSourcePath[],
);
