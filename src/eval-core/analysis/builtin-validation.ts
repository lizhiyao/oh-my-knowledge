/**
 * 内建分析的执行外壳与上下文校验：节点实现类、schema 校验器类与各结果的上下文断言。
 */
import { z } from 'zod';
import {
  canonicalizeJson,
  type CoreSchemaValidator,
  type CoreSchemaValidationContext,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
} from '../contracts/index.js';
import type {
  AnalysisNodeImplementation,
  AnalysisNodeRun,
} from './types.js';
import type {
  BuiltinDefinition,
} from './builtin-primitives.js';
import {
  HypothesisTableEnvelopeSchema,
  buildSimultaneousIntervalFamilyValue,
} from './builtin-hypothesis.js';
import {
  BonferroniParametersSchema,
  BootstrapParametersSchema,
  CompositeBootstrapParametersSchema,
  HierarchicalBootstrapParametersSchema,
  IntervalEnvelopeSchema,
  SimultaneousIntervalFamilyEnvelopeSchema,
} from './builtin-schemas.js';

export class BuiltinNodeImplementation implements AnalysisNodeImplementation {
  readonly identity: RuntimeIdentity;
  readonly outputSchema: SchemaIdentity;
  readonly #definition: BuiltinDefinition;

  constructor(definition: BuiltinDefinition) {
    this.#definition = definition;
    this.identity = definition.identity;
    this.outputSchema = definition.outputSchema;
  }

  async openRun(): Promise<AnalysisNodeRun> {
    return {
      execute: async (context) => this.#definition.execute(context),
      dispose: () => undefined,
    };
  }
}


export class BuiltinSchemaValidator implements CoreSchemaValidator {
  readonly schema: SchemaIdentity;
  readonly #zod: z.ZodType;
  readonly #validateContext?: (
    value: JsonValue,
    context?: Readonly<CoreSchemaValidationContext>,
  ) => void;
  readonly #normalize?: (value: JsonValue) => JsonValue;

  constructor(
    schema: SchemaIdentity,
    zodSchema: z.ZodType,
    validateContext?: (
      value: JsonValue,
      context?: Readonly<CoreSchemaValidationContext>,
    ) => void,
    normalize?: (value: JsonValue) => JsonValue,
  ) {
    this.schema = schema;
    this.#zod = zodSchema;
    this.#validateContext = validateContext;
    this.#normalize = normalize;
  }

  parse(value: unknown, context?: Readonly<CoreSchemaValidationContext>): JsonValue {
    const validated = this.#zod.parse(value) as JsonValue;
    const parsed = this.#normalize?.(validated) ?? validated;
    this.#validateContext?.(parsed, context);
    return parsed;
  }
}


function requireAnalysisOutputContext(
  context: Readonly<CoreSchemaValidationContext> | undefined,
): Readonly<CoreSchemaValidationContext> {
  if (context?.validationKind !== 'analysis-output') {
    throw new TypeError('Analysis output validation requires sealed node parameters.');
  }
  return context;
}


export function validateIntervalContext(
  value: JsonValue,
  context?: Readonly<CoreSchemaValidationContext>,
): void {
  const rawParameters = requireAnalysisOutputContext(context).parameters;
  const sealed = rawParameters !== null && typeof rawParameters === 'object'
      && !Array.isArray(rawParameters) && 'compositeMetricId' in rawParameters
    ? CompositeBootstrapParametersSchema.parse(rawParameters)
    : rawParameters !== null && typeof rawParameters === 'object'
        && !Array.isArray(rawParameters) && 'measurementAggregation' in rawParameters
      ? HierarchicalBootstrapParametersSchema.parse(rawParameters)
      : BootstrapParametersSchema.parse(rawParameters);
  const envelope = IntervalEnvelopeSchema.parse(value);
  if (envelope.value.resamples !== sealed.resamples
      || envelope.value.confidenceLevel !== 1 - sealed.alpha
      || envelope.value.unitCount !== context?.inputFacts.resamplingUnitCount) {
    throw new TypeError('Interval metadata does not match the sealed Analysis facts.');
  }
}


export function validateBonferroniContext(
  value: JsonValue,
  context?: Readonly<CoreSchemaValidationContext>,
): void {
  const sealed = BonferroniParametersSchema.parse(requireAnalysisOutputContext(context).parameters);
  const envelope = HypothesisTableEnvelopeSchema.parse(value);
  if (envelope.value.alpha !== sealed.alpha) {
    throw new TypeError('Bonferroni alpha does not match the sealed node parameters.');
  }
}


export function validateSimultaneousIntervalFamilyContext(
  value: JsonValue,
  context?: Readonly<CoreSchemaValidationContext>,
): void {
  const sealedContext = requireAnalysisOutputContext(context);
  const envelope = SimultaneousIntervalFamilyEnvelopeSchema.parse(value);
  const expected = buildSimultaneousIntervalFamilyValue(
    sealedContext.parameters,
    sealedContext.inputFacts.analysisResultInputs ?? [],
  );
  if (canonicalizeJson(envelope.value) !== canonicalizeJson(expected)) {
    throw new TypeError('Simultaneous interval family does not match its sealed Core inputs.');
  }
}

