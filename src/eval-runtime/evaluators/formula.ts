import { z } from 'zod';
import {
  JsonValueSchema,
  type JsonValue,
} from '../../eval-core/contracts/index.js';
import {
  configurationFailure,
} from '../evaluation/errors.js';
import {
  type CustomEvaluator,
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

/** Declarative formula evaluator configuration. */
export interface FormulaEvaluatorConfig {
  readonly evaluatorId: string;
  readonly calculatorId: FormulaCalculatorId;
  readonly bindings: Readonly<Record<string, {
    readonly sourceKind: 'output' | 'expected' | 'evaluation-context' | 'execution-facts';
    readonly pointer: string;
  }>>;
  readonly metric: {
    readonly metricId: string;
    readonly missingPolicyId: 'exclude/v1';
  } & (
    | {
        readonly valueType: 'numeric' | 'boolean';
        readonly direction: 'higher-is-better' | 'lower-is-better';
      }
    | {
        readonly valueType: 'categorical' | 'text' | 'ranking';
        readonly direction?: never;
      }
  );
  readonly parameters?: JsonValue;
}

/** Declarative formula evaluator: a CustomEvaluator whose evaluate is generated from a calculator. */
export type FormulaEvaluator = CustomEvaluator;

/** Calculator implementation: computes a score from resolved bindings. */
type Calculator = (bindings: Readonly<Record<string, JsonValue>>, parameters?: JsonValue) => JsonValue;

const CALCULATORS: Readonly<Record<FormulaCalculatorId, Calculator>> = {
  ratio: (bindings) => {
    const numerator = bindings.numerator;
    const denominator = bindings.denominator;
    if (typeof numerator !== 'number' || typeof denominator !== 'number' || denominator === 0) {
      return 0;
    }
    return numerator / denominator;
  },
  ranking: (bindings) => {
    const value = bindings.value;
    if (typeof value !== 'number') return 0;
    return value;
  },
  duration: (bindings) => {
    const startMs = bindings.startMs;
    const endMs = bindings.endMs;
    if (typeof startMs !== 'number' || typeof endMs !== 'number') return 0;
    return endMs - startMs;
  },
  mean: (bindings) => {
    const values = bindings.values;
    if (!Array.isArray(values) || values.length === 0) return 0;
    const numbers = values.filter((value): value is number => typeof value === 'number');
    if (numbers.length === 0) return 0;
    return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  },
  percentage: (bindings) => {
    const value = bindings.value;
    if (typeof value !== 'number') return 0;
    return value * 100;
  },
};

/** Creates a declarative formula evaluator from configuration. */
export function createFormulaEvaluator(
  config: Readonly<FormulaEvaluatorConfig>,
): FormulaEvaluator {
  const calculator = CALCULATORS[config.calculatorId];
  if (calculator === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      `未知的 formula calculator：${config.calculatorId}`,
    );
  }
  const bindings = Object.entries(config.bindings).map(([bindingId, binding]) => ({
    bindingId,
    sourceKind: binding.sourceKind,
    pointer: binding.pointer,
  }));
  return Object.freeze({
    evaluatorKind: 'custom',
    evaluatorId: config.evaluatorId,
    instrumentId: `formula-${config.calculatorId}-v1`,
    metric: {
      metricId: config.metric.metricId,
      missingPolicyId: config.metric.missingPolicyId,
      ...(config.metric.valueType === 'numeric' || config.metric.valueType === 'boolean'
        ? { valueType: config.metric.valueType, direction: config.metric.direction }
        : { valueType: config.metric.valueType }),
    },
    bindings,
    parameters: config.parameters,
    implementation: {
      implementationId: `omk.eval-runtime.formula-evaluator/${config.calculatorId}/v1`,
      version: '1.0.0',
      schemas: {
        bindings: z.record(z.string(), JsonValueSchema),
        value: JsonValueSchema,
        fingerprintFacets: { calculatorId: config.calculatorId },
      },
      fingerprintFacets: { calculatorId: config.calculatorId },
      evaluate: async (invocation) => {
        const value = calculator(invocation.bindings, config.parameters);
        return {
          resultKind: 'score',
          value,
        };
      },
    },
  });
}
