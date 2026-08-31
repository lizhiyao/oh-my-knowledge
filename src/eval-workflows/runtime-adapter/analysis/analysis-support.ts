import { z } from 'zod';
import {
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type CoreSchemaValidationContext,
  type CoreSchemaValidator,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
} from '../../../evaluation-core/contracts/index.js';
import type {
  AnalysisNodeExecutionContext,
  AnalysisNodeExecutionResult,
  AnalysisNodeImplementation,
} from '../../../evaluation-core/analysis/index.js';

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

export function analysisJsonSchema(
  schema: z.ZodType,
  invariants: readonly string[],
): JsonValue {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    cycles: 'ref',
    reused: 'ref',
  }) as unknown as Record<string, JsonValue>;
  return { ...generated, 'x-omk-invariants': [...invariants] };
}

export function analysisSchemaIdentity(
  schemaVersion: string,
  schemaUri: string,
  schema: JsonValue,
): SchemaIdentity {
  return deepFreezeCanonicalJson({
    schemaVersion,
    schemaUri,
    schemaDigest: digestCanonicalJson(schema),
  });
}

export function createAnalysisSchemaValidator(
  schema: SchemaIdentity,
  parse: (value: unknown, context?: Readonly<CoreSchemaValidationContext>) => JsonValue,
): CoreSchemaValidator {
  return Object.freeze({ schema, parse });
}

export function createStatelessAnalysisImplementation(input: Readonly<{
  identity: RuntimeIdentity;
  outputSchema: SchemaIdentity;
  parseParameters(parameters: unknown): void;
  execute(
    context: AnalysisNodeExecutionContext,
  ): AnalysisNodeExecutionResult | Promise<AnalysisNodeExecutionResult>;
}>): AnalysisNodeImplementation {
  return Object.freeze({
    identity: input.identity,
    outputSchema: input.outputSchema,
    async openRun() {
      return {
        async execute(context: AnalysisNodeExecutionContext) {
          if (context.signal.aborted) throw context.signal.reason;
          input.parseParameters(context.node.parameters);
          return input.execute(context);
        },
        dispose() {},
      };
    },
  });
}
