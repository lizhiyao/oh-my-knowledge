import { z } from 'zod';
import {
  IdentifierSchema,
  JsonPointerSchema,
  JsonValueSchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  type JsonValue,
} from '../../eval-core/contracts/index.js';
import {
  type CustomEvaluator,
  type CustomEvaluatorBinding,
  type CustomEvaluatorInvocation,
  type CustomEvaluatorResult,
  type CustomMetricResult,
} from '../custom-evaluator.js';

/** Built-in formula calculator identifiers. */
export const FORMULA_CALCULATOR_IDS = [
  'ratio',
  'ranking',
  'duration',
  'mean',
  'percentage',
] as const;

export type FormulaCalculatorId = typeof FORMULA_CALCULATOR_IDS[number];

/** A binding source without its name; the configuration key is the binding ID. */
export type FormulaEvaluatorBinding = Omit<CustomEvaluatorBinding, 'bindingId'>;

/** Declarative formula evaluator configuration. */
export interface FormulaEvaluatorConfig {
  readonly evaluatorId: string;
  readonly calculatorId: FormulaCalculatorId;
  readonly bindings: Readonly<Record<string, FormulaEvaluatorBinding>>;
  readonly metric: {
    readonly metricId: string;
    readonly direction: 'higher-is-better' | 'lower-is-better';
    readonly missingPolicyId: 'exclude/v1';
    readonly unit?: string;
    readonly scale?: Scale;
  };
}

/** Declarative formula evaluator: a CustomEvaluator whose evaluate is generated from a calculator. */
export type FormulaEvaluator = CustomEvaluator;

type Scale = Readonly<{ min?: number; max?: number }>;

/** Every built-in calculator emits a finite number, so the Metric is always numeric. */
const CALCULATOR_PROTOCOL = 'deterministic-formula/v1' as const;

/** The exact binding names each calculator reads; configuration must supply these and nothing else. */
const CALCULATOR_BINDINGS: Readonly<Record<FormulaCalculatorId, readonly string[]>> = {
  ratio: ['numerator', 'denominator'],
  ranking: ['target', 'candidates'],
  duration: ['startMs', 'endMs'],
  mean: ['values'],
  percentage: ['value'],
};

type Outcome =
  | Readonly<{ outcomeKind: 'value'; value: number }>
  | Readonly<{ outcomeKind: 'missing'; reasonCode: string }>
  | Readonly<{ outcomeKind: 'invalid'; reasonCode: string }>;

type Bindings = Readonly<Record<string, JsonValue>>;

const scored = (value: number): Outcome => ({ outcomeKind: 'value', value });
const missing = (reasonCode: string): Outcome => ({ outcomeKind: 'missing', reasonCode });
const invalid = (reasonCode: string): Outcome => ({ outcomeKind: 'invalid', reasonCode });

function readNumber(bindings: Bindings, name: string): number | Outcome {
  const raw = bindings[name];
  if (raw === undefined) return missing(`formula-${name}-missing`);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return invalid(`formula-${name}-not-numeric`);
  return raw;
}

function isOutcome(result: number | Outcome): result is Outcome {
  return typeof result !== 'number';
}

const CALCULATORS: Readonly<Record<FormulaCalculatorId, (bindings: Bindings) => Outcome>> = {
  ratio: (bindings) => {
    const numerator = readNumber(bindings, 'numerator');
    const denominator = readNumber(bindings, 'denominator');
    if (isOutcome(numerator)) return numerator;
    if (isOutcome(denominator)) return denominator;
    if (denominator === 0) return invalid('formula-ratio-denominator-zero');
    return scored(numerator / denominator);
  },
  ranking: (bindings) => {
    const target = bindings.target;
    const candidates = bindings.candidates;
    if (target === undefined) return missing('formula-target-missing');
    if (candidates === undefined) return missing('formula-candidates-missing');
    if (!Array.isArray(candidates)) return invalid('formula-candidates-not-a-list');
    const wanted = canonicalizeJson(target);
    const position = candidates.findIndex((candidate) => canonicalizeJson(candidate) === wanted);
    // Being absent from the ranked list is not a rank; exclude the coordinate and keep the reason.
    return position < 0
      ? missing('formula-ranking-target-not-ranked')
      : scored(position + 1);
  },
  duration: (bindings) => {
    const startMs = readNumber(bindings, 'startMs');
    const endMs = readNumber(bindings, 'endMs');
    if (isOutcome(startMs)) return startMs;
    if (isOutcome(endMs)) return endMs;
    if (endMs < startMs) return invalid('formula-duration-reversed');
    return scored(endMs - startMs);
  },
  mean: (bindings) => {
    const values = bindings.values;
    if (values === undefined) return missing('formula-values-missing');
    if (!Array.isArray(values)) return invalid('formula-values-not-a-list');
    if (values.length === 0) return missing('formula-values-empty');
    let sum = 0;
    for (const item of values) {
      if (typeof item !== 'number' || !Number.isFinite(item)) {
        return invalid('formula-values-not-numeric');
      }
      sum += item;
    }
    return scored(sum / values.length);
  },
  percentage: (bindings) => {
    const value = readNumber(bindings, 'value');
    if (isOutcome(value)) return value;
    return scored(value * 100);
  },
};

const ConfigSchema = z.object({
  evaluatorId: IdentifierSchema,
  calculatorId: z.enum(FORMULA_CALCULATOR_IDS),
  bindings: z.record(z.string(), z.object({
    sourceKind: z.enum([
      'output',
      'trace',
      'expected',
      'evaluation-context',
      'execution-facts',
    ]),
    pointer: JsonPointerSchema,
  }).strict()),
  metric: z.object({
    metricId: IdentifierSchema,
    direction: z.enum(['higher-is-better', 'lower-is-better']),
    missingPolicyId: z.literal('exclude/v1'),
    unit: z.string().min(1).optional(),
    scale: z.object({
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
    }).strict().optional(),
  }).strict(),
}).strict().superRefine((config, context) => {
  const required = CALCULATOR_BINDINGS[config.calculatorId];
  const declared = Object.keys(config.bindings);
  for (const name of required) {
    if (!declared.includes(name)) {
      context.addIssue({
        code: 'custom',
        path: ['bindings'],
        message: `calculator "${config.calculatorId}" 需要 binding "${name}"。`,
      });
    }
  }
  for (const name of declared) {
    if (!required.includes(name)) {
      context.addIssue({
        code: 'custom',
        path: ['bindings', name],
        message: `calculator "${config.calculatorId}" 不接受 binding "${name}"，`
          + `可用名称为 ${required.join('、')}。`,
      });
    }
  }
  if (config.metric.scale?.min !== undefined && config.metric.scale.max !== undefined
      && config.metric.scale.min > config.metric.scale.max) {
    context.addIssue({
      code: 'custom',
      path: ['metric', 'scale'],
      message: 'metric.scale.min 不得大于 max。',
    });
  }
});

function toResult(outcome: Outcome, scale: Scale | undefined, metricId: string): CustomMetricResult {
  if (outcome.outcomeKind === 'missing') return { metricId, resultKind: 'missing', reasonCode: outcome.reasonCode };
  if (outcome.outcomeKind === 'invalid') return { metricId, resultKind: 'invalid', reasonCode: outcome.reasonCode };
  const belowScale = scale?.min !== undefined && outcome.value < scale.min;
  const aboveScale = scale?.max !== undefined && outcome.value > scale.max;
  if (belowScale || aboveScale) {
    return {
      metricId,
      resultKind: 'invalid',
      reasonCode: `formula-value-${belowScale ? 'below' : 'above'}-scale`,
      invalidValue: { value: outcome.value, classification: 'gold' },
    };
  }
  return { metricId, resultKind: 'score', value: outcome.value };
}

/** Creates a declarative formula evaluator from configuration. */
export function createFormulaEvaluator(
  config: Readonly<FormulaEvaluatorConfig>,
): FormulaEvaluator {
  const value = deepFreezeCanonicalJson(ConfigSchema.parse(structuredClone(config)));
  const calculator = CALCULATORS[value.calculatorId];
  return Object.freeze({
    evaluatorKind: 'custom',
    evaluatorId: value.evaluatorId,
    instrumentId: `formula-${value.calculatorId}-v1`,
    metrics: [{
      metricId: value.metric.metricId,
      valueType: 'numeric' as const,
      direction: value.metric.direction,
      missingPolicyId: value.metric.missingPolicyId,
      ...(value.metric.unit === undefined ? {} : { unit: value.metric.unit }),
      ...(value.metric.scale === undefined ? {} : { scale: value.metric.scale }),
    }],
    bindings: Object.keys(value.bindings).sort().map((bindingId) => ({
      bindingId,
      sourceKind: value.bindings[bindingId].sourceKind,
      pointer: value.bindings[bindingId].pointer,
    })),
    implementation: {
      implementationId: `omk.eval-runtime.formula-evaluator/${value.calculatorId}/v1`,
      version: '1.0.0',
      schemas: {
        bindings: z.record(z.string(), JsonValueSchema),
        values: { [value.metric.metricId]: z.number().finite() },
        fingerprintFacets: { bindings: 'json-value-map/v1', value: 'finite-number/v1' },
      },
      fingerprintFacets: {
        calculatorId: value.calculatorId,
        protocol: CALCULATOR_PROTOCOL,
      },
      evaluate: async (invocation: CustomEvaluatorInvocation): Promise<CustomEvaluatorResult> => ({
        resultKind: 'completed',
        results: [toResult(calculator(invocation.bindings), value.metric.scale, value.metric.metricId)],
      }),
    },
  });
}
