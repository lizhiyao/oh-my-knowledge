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
import type { EvaluationConfigurationIssue } from './evaluation/errors.js';

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
        path: ['direction'],
        message: 'A quantitative custom Metric requires a monotonic direction.',
      });
    }
    if (metric.valueType !== 'numeric' && metric.scale !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scale'],
        message: 'Only a numeric custom Metric can declare scale.',
      });
    }
    if (metric.scale?.target !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scale', 'target'],
        message: 'The canonical custom Metric does not support target-is-best scale.',
      });
    }
    if (metric.scale?.min !== undefined && metric.scale.max !== undefined
        && metric.scale.min > metric.scale.max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scale'],
        message: 'A custom Metric scale requires min to be less than or equal to max.',
      });
    }
    if (!quantitative && metric.direction !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['direction'],
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
  constructor(readonly issues: readonly EvaluationConfigurationIssue[] = []) {
    super('Custom Evaluator declaration is invalid.');
    this.name = 'CustomEvaluatorDeclarationError';
  }
}

function invalidDeclaration(
  path: readonly (string | number)[] = [],
  reasonCode: EvaluationConfigurationIssue['reasonCode'] = 'invalid-value',
): never {
  throw new CustomEvaluatorDeclarationError([{ path, reasonCode }]);
}

// Only OMK-owned schema field names may extend a diagnostic path. Host errors are opaque.
const diagnosticFields = new Set([
  'bindingId', 'sourceKind', 'pointer', 'metricId', 'valueType', 'direction', 'unit',
  'scale', 'min', 'max', 'target', 'missingPolicyId', 'reporting', 'trustedUpperBound',
  'amount', 'currency',
]);

function at<Value>(path: readonly (string | number)[], read: () => Value): Value {
  try {
    return read();
  } catch (error) {
    if (error instanceof CustomEvaluatorDeclarationError) throw error;
    if (error instanceof z.ZodError) {
      throw new CustomEvaluatorDeclarationError(error.issues.map((issue) => ({
        path: [...path, ...issue.path.filter((part): part is string | number => (
          typeof part === 'number' || (typeof part === 'string' && diagnosticFields.has(part))
        ))],
        reasonCode: 'invalid-value',
      })));
    }
    return invalidDeclaration(path);
  }
}

function captureParser<Value>(
  parser: Readonly<RuntimeValueParser<Value>> | undefined,
  path: readonly (string | number)[],
) {
  if (parser == null || typeof parser.parse !== 'function') invalidDeclaration(path, 'parser-required');
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
    if (!Array.isArray(value.bindings) || value.bindings.length === 0) invalidDeclaration(['bindings']);
    const bindings = value.bindings.map((binding, index) => (
      at(['bindings', index], () => EvaluatorInputBindingSchema.parse(structuredClone(binding)))
    ));
    const seenBindings = new Set<string>();
    bindings.forEach((binding, index) => {
      if (seenBindings.has(binding.bindingId)) invalidDeclaration(['bindings', index, 'bindingId'], 'duplicate-id');
      seenBindings.add(binding.bindingId);
      if (binding.sourceKind === 'execution-facts' && binding.pointer !== '') {
        invalidDeclaration(['bindings', index, 'pointer']);
      }
    });
    bindings.sort((left, right) => left.bindingId < right.bindingId ? -1 : left.bindingId > right.bindingId ? 1 : 0);
    if ('metric' in value) invalidDeclaration(['metric'], 'unsupported-field');
    const implementation = at(['implementation'], () => {
      if (value.implementation == null) invalidDeclaration(['implementation']);
      return value.implementation;
    });
    const schemas = at(['implementation', 'schemas'], () => {
      if (implementation.schemas == null) invalidDeclaration(['implementation', 'schemas']);
      return implementation.schemas;
    });
    if ('value' in schemas) invalidDeclaration(['implementation', 'schemas', 'value'], 'unsupported-field');
    if (!Array.isArray(value.metrics) || value.metrics.length === 0) invalidDeclaration(['metrics']);
    const seenMetrics = new Set<string>();
    const metrics = value.metrics.map((metric, index) => {
      const parsed = at(['metrics', index], () => MetricDefinitionSchema.parse({
        ...CustomMetricSchema.parse(structuredClone(metric)), scope: 'sample',
      }));
      if (seenMetrics.has(parsed.metricId)) invalidDeclaration(['metrics', index, 'metricId'], 'duplicate-id');
      seenMetrics.add(parsed.metricId);
      return parsed;
    }).sort((left, right) => left.metricId < right.metricId ? -1 : left.metricId > right.metricId ? 1 : 0);
    const metricIds = metrics.map((metric) => metric.metricId);
    at(['implementation', 'schemas', 'values'], () => {
      if (schemas.values == null || Array.isArray(schemas.values)
          || canonicalizeJson(Object.keys(schemas.values).sort()) !== canonicalizeJson(metricIds)) {
        invalidDeclaration(['implementation', 'schemas', 'values'], 'metric-set-mismatch');
      }
    });
    const parameters = value.parameters === undefined ? undefined : at(['parameters'], () => (
      deepFreezeCanonicalJson(JsonValueSchema.parse(structuredClone(value.parameters)))
    ));
    const bindingParser = at(['implementation', 'schemas', 'bindings'], () => (
      captureParser(schemas.bindings, ['implementation', 'schemas', 'bindings'])
    ));
    const valueParsers = new Map(metrics.map((metric) => [
      metric.metricId,
      at(['implementation', 'schemas', 'values', metric.metricId], () => (
        captureParser(schemas.values[metric.metricId], ['implementation', 'schemas', 'values', metric.metricId])
      )),
    ]));
    if (typeof implementation.evaluate !== 'function') invalidDeclaration(['implementation', 'evaluate']);
    const schemaFingerprintFacets = at(['implementation', 'schemas', 'fingerprintFacets'], () => (
      deepFreezeCanonicalJson(JsonValueSchema.parse(structuredClone(schemas.fingerprintFacets)))
    ));
    const fingerprintFacets = at(['implementation', 'fingerprintFacets'], () => (
      deepFreezeCanonicalJson(JsonValueSchema.parse(structuredClone(implementation.fingerprintFacets)))
    ));
    const providerCost = implementation.providerCost === undefined ? undefined : at(['implementation', 'providerCost'], () => (
      deepFreezeCanonicalJson(structuredClone(implementation.providerCost))
    ));
    const capabilities = at(['implementation', 'providerCost'], () => EvaluatorCapabilitiesSchema.parse({
      inputSourceKinds: [...new Set(bindings.map((binding) => binding.sourceKind))].sort(),
      metricValueTypes: [...new Set(metrics.map((metric) => metric.valueType))].sort(),
      schemas: [],
      ...(providerCost === undefined ? {} : { providerCost }),
    }));
    const implementationId = at(['implementation', 'implementationId'], () => IdentifierSchema.parse(implementation.implementationId));
    const version = at(['implementation', 'version'], () => z.string().min(1).parse(implementation.version));
    const identity = at(['implementation'], () => createRuntimeIdentity({
      implementationId,
      version,
      capabilities,
      fingerprintFacets: {
        facade: 'omk.eval-runtime.custom-evaluator/v2',
        schemas: schemaFingerprintFacets,
        host: fingerprintFacets,
      },
    }));
    if (identity.version === undefined) return invalidDeclaration(['implementation', 'version']);
    const evaluatorId = at(['evaluatorId'], () => IdentifierSchema.parse(value.evaluatorId));
    const instrumentId = at(['instrumentId'], () => IdentifierSchema.parse(value.instrumentId));
    const definition = EvaluatorDefinitionSchema.parse({
      evaluatorId,
      evaluatorKind: 'custom',
      implementationId: identity.implementationId,
      versionConstraint: identity.version,
      measurement: {
        instrumentId,
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
