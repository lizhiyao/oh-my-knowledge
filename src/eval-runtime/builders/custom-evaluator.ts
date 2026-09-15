import type { JsonValue } from '../../eval-core/contracts/index.js';
import type { RuntimeValueParser } from '../adapters/json-executor.js';
import {
  captureCustomEvaluator,
  CustomEvaluatorDeclarationError,
  type CustomEvaluator,
  type CustomEvaluatorInvocation,
  type CustomEvaluatorResult,
  type CustomMetricResult,
  type Metric,
} from '../custom-evaluator.js';
import { EvaluationConfigurationError } from '../evaluation/errors.js';

type MetricValue = {
  numeric: number;
  boolean: boolean;
  categorical: string;
  text: string;
  ranking: string[];
};

type MetricDeclaration<M = Metric> = M extends Metric
  ? { [ValueType in M['valueType']]: Omit<M, 'metricId' | 'missingPolicyId' | 'valueType'> & Readonly<{
      valueType: ValueType;
      missingPolicyId?: 'exclude/v1';
      schema: RuntimeValueParser<MetricValue[ValueType]>;
    }> }[M['valueType']]
  : never;

/** The map key is the metricId; the parser sits beside its measurement definition. */
export type CustomEvaluatorMetric = MetricDeclaration;

type KeyedMetricResult<Value extends JsonValue> =
  | (Omit<Extract<CustomMetricResult, { resultKind: 'score' }>, 'metricId' | 'value'> & { readonly value: Value })
  | Omit<Extract<CustomMetricResult, { resultKind: 'missing' }>, 'metricId'>
  | Omit<Extract<CustomMetricResult, { resultKind: 'invalid' }>, 'metricId'>;

export type CustomEvaluatorScores<Metrics extends Record<string, CustomEvaluatorMetric>> =
  | Readonly<{
      resultKind: 'completed';
      results: { readonly [Id in keyof Metrics]: KeyedMetricResult<ReturnType<Metrics[Id]['schema']['parse']>> };
      usage?: Extract<CustomEvaluatorResult, { resultKind: 'completed' }>['usage'];
    }>
  | Extract<CustomEvaluatorResult, { resultKind: 'failed' }>;

export type CreateCustomEvaluatorInput<
  Metrics extends Record<string, CustomEvaluatorMetric>,
  Bindings extends Record<string, JsonValue> = Record<string, JsonValue>,
  Parameters extends JsonValue | undefined = JsonValue | undefined,
> = Omit<CustomEvaluator<Bindings, Parameters>, 'evaluatorKind' | 'metrics' | 'implementation'> & Readonly<{
  metrics: Metrics;
  implementation: Omit<CustomEvaluator<Bindings, Parameters>['implementation'], 'schemas' | 'evaluate'> & Readonly<{
    schemas: Omit<CustomEvaluator<Bindings, Parameters>['implementation']['schemas'], 'values'>;
    evaluate: (invocation: Readonly<CustomEvaluatorInvocation<Bindings, Parameters>>) =>
      CustomEvaluatorScores<NoInfer<Metrics>> | Promise<CustomEvaluatorScores<NoInfer<Metrics>>>;
  }>;
}>;

/** Expands an ergonomic declaration into the canonical v2 Custom Evaluator contract. */
export function createCustomEvaluator<
  const Metrics extends Record<string, CustomEvaluatorMetric>,
  Bindings extends Record<string, JsonValue>,
  Parameters extends JsonValue | undefined = JsonValue | undefined,
>(input: Readonly<CreateCustomEvaluatorInput<Metrics, Bindings, Parameters>>): CustomEvaluator<Bindings, Parameters> {
  let metricIds: string[] = [];
  try {
    if (input.metrics == null || typeof input.metrics !== 'object' || Array.isArray(input.metrics)) {
      throw new CustomEvaluatorDeclarationError([{ path: ['metrics'], reasonCode: 'invalid-value' }]);
    }
    const entries = Object.entries(input.metrics);
    metricIds = entries.map(([id]) => id);
    if (input.implementation == null) {
      throw new CustomEvaluatorDeclarationError([{ path: ['implementation'], reasonCode: 'invalid-value' }]);
    }
    for (const [id, metric] of entries) {
      if (metric == null || typeof metric !== 'object' || Array.isArray(metric)) {
        throw new CustomEvaluatorDeclarationError([{ path: ['metrics', id], reasonCode: 'invalid-value' }]);
      }
    }
    const callback = input.implementation.evaluate;
    const evaluator: CustomEvaluator<Bindings, Parameters> = {
      ...input,
      evaluatorKind: 'custom',
      metrics: entries.map(([metricId, { schema: _schema, ...metric }]) => ({
        missingPolicyId: 'exclude/v1', ...metric, metricId,
      })),
      implementation: {
        ...input.implementation,
        schemas: {
          ...input.implementation.schemas,
          values: Object.fromEntries(entries.map(([id, metric]) => [id, metric.schema])),
        },
        async evaluate(invocation) {
          const result = await callback(invocation);
          // Preserve malformed results for the canonical validator, including reported usage.
          if (result?.resultKind !== 'completed') return result as CustomEvaluatorResult;
          if (result.results == null || typeof result.results !== 'object' || Array.isArray(result.results)
              || Object.values(result.results).some((item) => item != null && typeof item === 'object' && 'metricId' in item)) {
            return { ...result, results: null } as unknown as CustomEvaluatorResult;
          }
          return {
            ...result,
            results: Object.entries(result.results).map(([metricId, item]) => ({ ...item, metricId })),
          } as CustomEvaluatorResult;
        },
      },
    };
    if (typeof callback !== 'function') {
      throw new CustomEvaluatorDeclarationError([{ path: ['implementation', 'evaluate'], reasonCode: 'invalid-value' }]);
    }
    captureCustomEvaluator(evaluator);
    return evaluator;
  } catch (error) {
    throw new EvaluationConfigurationError(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Custom Evaluator 配置无效。请查看 issues 中的字段位置。',
      undefined,
      error instanceof CustomEvaluatorDeclarationError ? error.issues.map((issue) => {
        const [root, index, ...rest] = issue.path;
        if (root === 'metrics' && typeof index === 'number') {
          return { ...issue, path: ['metrics', metricIds[index], ...rest] };
        }
        if (root === 'implementation' && index === 'schemas' && rest[0] === 'values' && typeof rest[1] === 'string') {
          return { ...issue, path: ['metrics', rest[1], 'schema'] };
        }
        return issue;
      }) : [],
    );
  }
}
