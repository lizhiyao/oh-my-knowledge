/**
 * 内建分析的假设族：Bonferroni 与同时区间族。
 */
import { compareStrings } from '../primitives/ordering.js';
import { z } from 'zod';
import {
  canonicalizeJson,
  bonferroniMarginalConfidenceLevel,
  type CoreSchemaValidationContext,
  type JsonValue,
} from '../contracts/index.js';
import type {
  AnalysisNodeExecutionContext,
  AnalysisNodeExecutionResult,
} from './types.js';
import {
  incomplete,
  parameterNumber,
  passedAssumption,
} from './builtin-primitives.js';
import {
  FiniteNumberSchema,
  IntervalEnvelopeSchema,
  ProbabilitySchema,
  SimultaneousIntervalFamilyEnvelopeSchema,
  SimultaneousIntervalFamilyParametersSchema,
  jsonSchema,
  schemaIdentity,
} from './builtin-schemas.js';

export const HypothesisInputEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: z.object({
    hypotheses: z.array(z.object({
      hypothesisId: z.string().min(1),
      pValue: ProbabilitySchema,
    }).strict()).min(1),
  }).strict(),
}).strict();

export const HypothesisTableEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: z.object({
    familySize: z.number().int().positive().safe(),
    alpha: FiniteNumberSchema.gt(0).lt(1),
    hypotheses: z.array(z.object({
      hypothesisId: z.string().min(1),
      rawPValue: ProbabilitySchema,
      adjustedPValue: ProbabilitySchema,
      rejected: z.boolean(),
    }).strict()).min(1),
  }).strict(),
}).strict().superRefine((envelope, context) => {
  const { familySize, alpha, hypotheses } = envelope.value;
  if (familySize !== hypotheses.length) {
    context.addIssue({ code: 'custom', path: ['value', 'familySize'], message: 'familySize mismatch' });
  }
  const ids = hypotheses.map((entry) => entry.hypothesisId);
  if (new Set(ids).size !== ids.length || canonicalizeJson(ids) !== canonicalizeJson([...ids].sort())) {
    context.addIssue({ code: 'custom', path: ['value', 'hypotheses'], message: 'IDs must be unique and canonical' });
  }
  for (const [index, entry] of hypotheses.entries()) {
    if (entry.adjustedPValue !== Math.min(1, entry.rawPValue * familySize)
        || entry.rejected !== (entry.rawPValue <= alpha / familySize)) {
      context.addIssue({ code: 'custom', path: ['value', 'hypotheses', index], message: 'Bonferroni invariant mismatch' });
    }
  }
});


export const BUILTIN_HYPOTHESIS_TABLE_SCHEMA = schemaIdentity(
  'omk.analysis-result.hypothesis-table/v1',
  'urn:omk:analysis-result:hypothesis-table:v1',
  jsonSchema(HypothesisTableEnvelopeSchema, [
    'familySize equals hypotheses.length',
    'hypothesisId values are unique and lexicographically sorted',
    'adjustedPValue=min(1,rawPValue*familySize)',
    'rejected=(rawPValue<=alpha/familySize)',
    'alpha equals the sealed node parameter alpha',
  ]),
);


export const BUILTIN_HYPOTHESIS_INPUT_SCHEMA = schemaIdentity(
  'omk.analysis-result.hypothesis-input/v1',
  'urn:omk:analysis-result:hypothesis-input:v1',
  jsonSchema(HypothesisInputEnvelopeSchema),
);


interface Hypothesis {
  hypothesisId: string;
  pValue: number;
}


function hypotheses(context: AnalysisNodeExecutionContext): Hypothesis[] {
  const result: Hypothesis[] = [];
  for (const input of context.inputs) {
    if (input.inputKind !== 'analysis-result') continue;
    const value = input.record.value;
    if (value === null || Array.isArray(value) || typeof value !== 'object') continue;
    const entries = (value as Record<string, JsonValue>).hypotheses;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry === null || Array.isArray(entry) || typeof entry !== 'object') continue;
      const hypothesisId = (entry as Record<string, JsonValue>).hypothesisId;
      const pValue = (entry as Record<string, JsonValue>).pValue;
      if (typeof hypothesisId === 'string'
          && typeof pValue === 'number'
          && Number.isFinite(pValue)
          && pValue >= 0
          && pValue <= 1) {
        result.push({ hypothesisId, pValue });
      }
    }
  }
  return result;
}


export function executeBonferroni(context: AnalysisNodeExecutionContext): AnalysisNodeExecutionResult {
  const raw = hypotheses(context);
  if (raw.length === 0) return incomplete('analysis-no-valid-hypotheses');
  if (new Set(raw.map((entry) => entry.hypothesisId)).size !== raw.length) {
    return incomplete('analysis-duplicate-hypothesis-id');
  }
  const alpha = parameterNumber(context, 'alpha', 0.05);
  if (alpha <= 0 || alpha >= 1) throw new TypeError('alpha must be in (0, 1).');
  const familySize = raw.length;
  return {
    analysisStatus: 'completed',
    resultType: 'table',
    value: {
      familySize,
      alpha,
      hypotheses: raw.sort((left, right) => (
        compareStrings(left.hypothesisId, right.hypothesisId)
      )).map((entry) => ({
        hypothesisId: entry.hypothesisId,
        rawPValue: entry.pValue,
        adjustedPValue: Math.min(1, entry.pValue * familySize),
        rejected: entry.pValue <= alpha / familySize,
      })),
    },
    assumptionChecks: passedAssumption('valid-hypothesis-family'),
  };
}


type SimultaneousIntervalInput = NonNullable<
  CoreSchemaValidationContext['inputFacts']['analysisResultInputs']
>[number];


export function buildSimultaneousIntervalFamilyValue(
  rawParameters: unknown,
  rawInputs: readonly SimultaneousIntervalInput[],
): z.infer<typeof SimultaneousIntervalFamilyEnvelopeSchema>['value'] {
  const sealed = SimultaneousIntervalFamilyParametersSchema.parse(rawParameters);
  if (rawInputs.length < 2) {
    throw new TypeError('A simultaneous interval family requires at least two interval results.');
  }
  const ids = rawInputs.map((input) => input.referenceId);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError('A simultaneous interval family cannot repeat a result identity.');
  }
  const marginalConfidenceLevel = bonferroniMarginalConfidenceLevel(
    sealed.familyConfidenceLevel,
    rawInputs.length,
  );
  const members = rawInputs.map((input) => {
    const interval = IntervalEnvelopeSchema.parse({
      resultType: input.resultType,
      value: input.value,
    }).value;
    if (interval.confidenceLevel !== marginalConfidenceLevel
        || interval.resamples !== sealed.resamples) {
      throw new TypeError('An interval result does not match the sealed Bonferroni family.');
    }
    return { analysisResultId: input.referenceId, interval };
  }).sort((left, right) => (
    compareStrings(left.analysisResultId, right.analysisResultId)
  ));
  return SimultaneousIntervalFamilyEnvelopeSchema.parse({
    resultType: 'table',
    value: {
      adjustmentMethod: 'bonferroni',
      familyConfidenceLevel: sealed.familyConfidenceLevel,
      marginalConfidenceLevel,
      familySize: members.length,
      resamples: sealed.resamples,
      members,
    },
  }).value;
}


export function executeSimultaneousIntervalFamily(
  context: AnalysisNodeExecutionContext,
): AnalysisNodeExecutionResult {
  const inputs = context.inputs.flatMap((input): SimultaneousIntervalInput[] => (
    input.inputKind === 'analysis-result'
      ? [{
        referenceId: input.referenceId,
        resultType: input.record.resultType,
        value: input.record.value,
      }]
      : []
  ));
  return {
    analysisStatus: 'completed',
    resultType: 'table',
    value: buildSimultaneousIntervalFamilyValue(context.node.parameters ?? {}, inputs),
    assumptionChecks: passedAssumption('complete-simultaneous-interval-family'),
  };
}

