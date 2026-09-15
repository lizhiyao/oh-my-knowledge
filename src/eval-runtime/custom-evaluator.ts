import { z } from 'zod';
import {
  EvaluatorDefinitionSchema,
  EvaluatorInputBindingSchema,
  IdentifierSchema,
  JsonValueSchema,
  MetricDefinitionSchema,
  UsageRecordSchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  type EvaluatorDefinition,
  type JsonValue,
  type MetricDefinition,
  type UsageRecord,
} from '../eval-core/contracts/index.js';
import { EvaluatorCapabilitiesSchema } from '../eval-core/compiler/index.js';
import {
  EvaluationPortFailure,
  type EvaluationEvaluator,
  type EvaluatorObservation,
} from '../eval-core/evaluation/index.js';
import { createSameProcessEvaluatorAdapter } from './adapters/same-process.js';
import type { RuntimeValueParser } from './adapters/json-executor.js';
import { createRuntimeIdentity } from './identity.js';

const CustomEvaluatorContentSchema = z.object({
  value: JsonValueSchema,
  classification: z.enum(['public', 'sensitive', 'secret', 'gold']),
  mediaType: z.string().min(1).optional(),
}).strict();

const CustomMetricResultSchema = z.discriminatedUnion('resultKind', [
  z.object({
    metricId: IdentifierSchema,
    resultKind: z.literal('score'),
    value: JsonValueSchema,
    evidence: CustomEvaluatorContentSchema.optional(),
  }).strict(),
  z.object({
    metricId: IdentifierSchema,
    resultKind: z.literal('missing'),
    reasonCode: IdentifierSchema,
    evidence: CustomEvaluatorContentSchema.optional(),
  }).strict(),
  z.object({
    metricId: IdentifierSchema,
    resultKind: z.literal('invalid'),
    reasonCode: IdentifierSchema,
    invalidValue: CustomEvaluatorContentSchema.optional(),
    evidence: CustomEvaluatorContentSchema.optional(),
  }).strict(),
]);

const CustomEvaluatorResultSchema = z.discriminatedUnion('resultKind', [
  z.object({
    resultKind: z.literal('completed'),
    results: z.array(CustomMetricResultSchema).min(1),
    usage: UsageRecordSchema.optional(),
  }).strict(),
  z.object({
    resultKind: z.literal('failed'),
    errorCode: IdentifierSchema,
    usage: UsageRecordSchema.optional(),
  }).strict(),
]);

const CustomMetricSchema = MetricDefinitionSchema.omit({ scope: true }).superRefine(
  (metric, context) => {
    const quantitative = metric.valueType === 'numeric' || metric.valueType === 'boolean';
    if (quantitative && (metric.direction === undefined || metric.direction === 'target-is-best')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A quantitative custom Metric requires a monotonic direction.',
      });
    }
    if (metric.valueType !== 'numeric' && metric.scale !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only a numeric custom Metric can declare scale.',
      });
    }
    if (metric.scale?.target !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The canonical custom Metric does not support target-is-best scale.',
      });
    }
    if (metric.scale?.min !== undefined && metric.scale.max !== undefined
        && metric.scale.min > metric.scale.max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A custom Metric scale requires min to be less than or equal to max.',
      });
    }
    if (!quantitative && metric.direction !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A qualitative custom Metric cannot declare direction.',
      });
    }
  },
);

interface MetricBase {
  readonly metricId: string;
  readonly unit?: string;
  readonly missingPolicyId: 'exclude/v1';
}

export type Metric = MetricBase & (
  | Readonly<{
      valueType: 'numeric';
      scale?: Readonly<{ min?: number; max?: number }>;
      direction: 'higher-is-better' | 'lower-is-better';
    }>
  | Readonly<{
      valueType: 'boolean';
      scale?: never;
      direction: 'higher-is-better' | 'lower-is-better';
    }>
  | Readonly<{
      valueType: 'categorical' | 'text' | 'ranking';
      scale?: never;
      direction?: never;
    }>
);

export interface CustomEvaluatorBinding {
  readonly bindingId: string;
  readonly sourceKind:
    | 'output'
    | 'trace'
    | 'expected'
    | 'evaluation-context'
    | 'execution-facts';
  readonly pointer: string;
}

export interface CustomEvaluatorContent {
  readonly value: JsonValue;
  readonly classification: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly mediaType?: string;
}

export type CustomMetricResult =
  | Readonly<{
      metricId: string;
      resultKind: 'score';
      value: JsonValue;
      evidence?: CustomEvaluatorContent;
    }>
  | Readonly<{
      metricId: string;
      resultKind: 'missing';
      reasonCode: string;
      evidence?: CustomEvaluatorContent;
    }>
  | Readonly<{
      metricId: string;
      resultKind: 'invalid';
      reasonCode: string;
      invalidValue?: CustomEvaluatorContent;
      evidence?: CustomEvaluatorContent;
    }>;

export type CustomEvaluatorResult =
  | Readonly<{
      resultKind: 'completed';
      results: readonly CustomMetricResult[];
      usage?: UsageRecord;
    }>
  | Readonly<{
      resultKind: 'failed';
      errorCode: string;
      usage?: UsageRecord;
    }>;

export interface CustomEvaluatorInvocation<
  Bindings extends Record<string, JsonValue> = Record<string, JsonValue>,
  Parameters extends JsonValue | undefined = JsonValue | undefined,
> {
  readonly bindings: Readonly<Bindings>;
  readonly parameters: Parameters | undefined;
  readonly sampleId: string;
  readonly variantId: string;
  readonly trialIndex: number;
  readonly attemptNumber: number;
  readonly signal: AbortSignal;
}

type CustomEvaluatorCallback<
  Bindings extends Record<string, JsonValue>,
  Parameters extends JsonValue | undefined,
> = {
  bivarianceHack(
    invocation: Readonly<CustomEvaluatorInvocation<Bindings, Parameters>>,
  ): CustomEvaluatorResult | Promise<CustomEvaluatorResult>;
}['bivarianceHack'];

export interface CustomEvaluator<
  Bindings extends Record<string, JsonValue> = Record<string, JsonValue>,
  Parameters extends JsonValue | undefined = JsonValue | undefined,
> {
  readonly evaluatorKind: 'custom';
  readonly evaluatorId: string;
  readonly instrumentId: string;
  readonly metrics: readonly Metric[];
  readonly bindings: readonly CustomEvaluatorBinding[];
  readonly parameters?: Parameters;
  readonly implementation: Readonly<{
    implementationId: string;
    version: string;
    schemas: Readonly<{
      bindings: RuntimeValueParser<Bindings>;
      values: Readonly<Record<string, RuntimeValueParser<JsonValue>>>;
      fingerprintFacets: JsonValue;
    }>;
    providerCost?: Readonly<{
      reporting: 'unsupported' | 'optional' | 'required';
      trustedUpperBound?: Readonly<{ amount: number; currency: string }>;
    }>;
    fingerprintFacets: JsonValue;
    evaluate: CustomEvaluatorCallback<Bindings, Parameters>;
  }>;
}

export interface CapturedCustomEvaluator {
  readonly definition: EvaluatorDefinition;
  readonly metrics: readonly MetricDefinition[];
  readonly port: EvaluationEvaluator;
  readonly implementationId: string;
  readonly version: string;
}

export class CustomEvaluatorDeclarationError extends TypeError {
  constructor() {
    super('Custom Evaluator declaration is invalid.');
    this.name = 'CustomEvaluatorDeclarationError';
  }
}

function invalidDeclaration(): never {
  throw new CustomEvaluatorDeclarationError();
}

function captureParser<Value>(parser: Readonly<RuntimeValueParser<Value>> | undefined) {
  if (parser === undefined || typeof parser.parse !== 'function') invalidDeclaration();
  const parse = parser.parse;
  return Object.freeze({
    parse: (value: unknown): Value => Reflect.apply(parse, parser, [value]) as Value,
  });
}

function customValueMatchesMetric(valueType: Metric['valueType'], value: JsonValue): boolean {
  if (valueType === 'numeric') return typeof value === 'number' && Number.isFinite(value);
  if (valueType === 'boolean') return typeof value === 'boolean';
  if (valueType === 'categorical' || valueType === 'text') return typeof value === 'string';
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Captures one canonical custom declaration and adapts it to the Core Evaluator port. */
export function captureCustomEvaluator(
  value: Readonly<CustomEvaluator>,
): Readonly<CapturedCustomEvaluator> {
  try {
    const bindings = value.bindings.map((binding) => (
      EvaluatorInputBindingSchema.parse(structuredClone(binding))
    )).sort((left, right) => (
      left.bindingId < right.bindingId ? -1 : left.bindingId > right.bindingId ? 1 : 0
    ));
    if (bindings.length === 0
        || new Set(bindings.map((binding) => binding.bindingId)).size !== bindings.length
        || bindings.some((binding) => (
          binding.sourceKind === 'execution-facts' && binding.pointer !== ''
        ))) {
      return invalidDeclaration();
    }
    if ('metric' in value || 'value' in value.implementation.schemas) return invalidDeclaration();
    const metrics = value.metrics.map((metric) => MetricDefinitionSchema.parse({
      ...CustomMetricSchema.parse(structuredClone(metric)),
      scope: 'sample',
    })).sort((left, right) => (
      left.metricId < right.metricId ? -1 : left.metricId > right.metricId ? 1 : 0
    ));
    const metricIds = metrics.map((metric) => metric.metricId);
    if (metrics.length === 0 || new Set(metricIds).size !== metrics.length
        || canonicalizeJson(Object.keys(value.implementation.schemas.values).sort())
          !== canonicalizeJson(metricIds)) return invalidDeclaration();
    const parameters = value.parameters === undefined
      ? undefined
      : deepFreezeCanonicalJson(JsonValueSchema.parse(structuredClone(value.parameters)));
    const bindingParser = captureParser(value.implementation.schemas.bindings);
    const valueParsers = new Map(metrics.map((metric) => [
      metric.metricId,
      captureParser(value.implementation.schemas.values[metric.metricId]),
    ]));
    if (typeof value.implementation.evaluate !== 'function') return invalidDeclaration();
    const schemaFingerprintFacets = deepFreezeCanonicalJson(JsonValueSchema.parse(
      structuredClone(value.implementation.schemas.fingerprintFacets),
    ));
    const fingerprintFacets = deepFreezeCanonicalJson(JsonValueSchema.parse(
      structuredClone(value.implementation.fingerprintFacets),
    ));
    const providerCost = value.implementation.providerCost === undefined
      ? undefined
      : deepFreezeCanonicalJson(structuredClone(value.implementation.providerCost));
    const capabilities = EvaluatorCapabilitiesSchema.parse({
      inputSourceKinds: [...new Set(bindings.map((binding) => binding.sourceKind))].sort(),
      metricValueTypes: [...new Set(metrics.map((metric) => metric.valueType))].sort(),
      schemas: [],
      ...(providerCost === undefined ? {} : { providerCost }),
    });
    const identity = createRuntimeIdentity({
      implementationId: value.implementation.implementationId,
      version: value.implementation.version,
      capabilities,
      fingerprintFacets: {
        facade: 'omk.eval-runtime.custom-evaluator/v2',
        schemas: schemaFingerprintFacets,
        host: fingerprintFacets,
      },
    });
    if (identity.version === undefined) return invalidDeclaration();
    const definition = EvaluatorDefinitionSchema.parse({
      evaluatorId: value.evaluatorId,
      evaluatorKind: 'custom',
      implementationId: identity.implementationId,
      versionConstraint: identity.version,
      measurement: {
        instrumentId: value.instrumentId,
        ensembleMemberId: 'custom-local',
        replicateGroupId: 'custom-primary',
        replicateIndex: 0,
      },
      metricIds,
      inputs: bindings,
      ...(parameters === undefined ? {} : { config: parameters }),
    });
    const callback = value.implementation.evaluate;
    const port = createSameProcessEvaluatorAdapter({
      identity,
      sessionIsolationKey: `omk.eval-runtime.custom-evaluator/v2:${definition.evaluatorId}`,
      resourceLeases: { forRun: () => undefined },
      implementation: {
        openRun: () => undefined,
        openRecord: () => undefined,
        async evaluate({ record, attempt }) {
          const rawBindings = deepFreezeCanonicalJson(Object.fromEntries(
            record.bindings.map((binding) => [binding.bindingId, binding.value]),
          ));
          let parsedBindings: Record<string, JsonValue>;
          try {
            const parsed = bindingParser.parse(structuredClone(rawBindings));
            const parsedWire = JsonValueSchema.parse(parsed) as Record<string, JsonValue>;
            if (canonicalizeJson(rawBindings) !== canonicalizeJson(parsedWire)) {
              throw new TypeError('binding parser transformed its input');
            }
            parsedBindings = deepFreezeCanonicalJson(parsedWire);
          } catch {
            return {
              observations: metrics.map((metric) => ({
                metricId: metric.metricId,
                observationStatus: 'invalid',
                valueType: metric.valueType,
                reasonCode: 'custom-evaluator-bindings-invalid',
              } satisfies EvaluatorObservation)),
            };
          }
          const rawResult = await Reflect.apply(callback, undefined, [Object.freeze({
            bindings: parsedBindings,
            parameters: record.evaluatorConfig,
            sampleId: record.sampleId,
            variantId: record.targetId,
            trialIndex: record.trialIndex,
            attemptNumber: attempt.attemptNumber,
            signal: attempt.signal,
          })]) as CustomEvaluatorResult;
          let result: z.infer<typeof CustomEvaluatorResultSchema>;
          let reportedUsage: UsageRecord | undefined;
          try {
            const capturedResult = structuredClone(rawResult);
            const usage = UsageRecordSchema.safeParse(capturedResult?.usage);
            if (usage.success) reportedUsage = usage.data;
            result = CustomEvaluatorResultSchema.parse(capturedResult);
            if (result.resultKind === 'completed') {
              const returnedIds = result.results.map((item) => item.metricId).sort();
              if (canonicalizeJson(returnedIds) !== canonicalizeJson(metricIds)) {
                throw new TypeError('results must cover each declared Metric exactly once');
              }
            }
          } catch {
            throw new EvaluationPortFailure({
              code: 'custom-evaluator-result-invalid',
              stage: 'evaluation',
              message: 'Custom Evaluator returned an invalid result contract.',
            }, reportedUsage);
          }
          if (result.resultKind === 'failed') {
            throw new EvaluationPortFailure({
              code: result.errorCode,
              stage: 'evaluation',
              message: 'Custom Evaluator reported a stable failure.',
            }, result.usage);
          }
          const resultsById = new Map(result.results.map((item) => [item.metricId, item]));
          const observations = metrics.map((metric): EvaluatorObservation => {
            const item = resultsById.get(metric.metricId)!;
            const evidence = item.evidence === undefined ? {} : { evidence: item.evidence };
            if (item.resultKind === 'score') {
              let parsedValue: JsonValue;
              try {
                parsedValue = JsonValueSchema.parse(
                  valueParsers.get(metric.metricId)!.parse(structuredClone(item.value)),
                );
                if (canonicalizeJson(item.value) !== canonicalizeJson(parsedValue)
                    || !customValueMatchesMetric(metric.valueType, parsedValue)) {
                  throw new TypeError('value parser rejected or transformed the score');
                }
              } catch {
                return {
                  metricId: metric.metricId,
                  observationStatus: 'invalid',
                  valueType: metric.valueType,
                  reasonCode: 'custom-evaluator-value-invalid',
                  invalidValue: { value: item.value, classification: 'gold' },
                  ...evidence,
                };
              }
              return {
                metricId: metric.metricId,
                observationStatus: 'observed',
                valueType: metric.valueType,
                value: parsedValue,
                ...evidence,
              } as EvaluatorObservation;
            }
            return {
              metricId: metric.metricId,
              observationStatus: item.resultKind,
              valueType: metric.valueType,
              reasonCode: item.reasonCode,
              ...(item.resultKind === 'invalid' && item.invalidValue !== undefined
                ? { invalidValue: item.invalidValue } : {}),
              ...evidence,
            };
          });
          return {
            observations,
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          };
        },
        disposeRecord: () => undefined,
        disposeRun: () => undefined,
      },
    });
    return Object.freeze({
      definition,
      metrics: Object.freeze(metrics),
      port,
      implementationId: identity.implementationId,
      version: identity.version,
    });
  } catch (error) {
    if (error instanceof CustomEvaluatorDeclarationError) throw error;
    return invalidDeclaration();
  }
}
