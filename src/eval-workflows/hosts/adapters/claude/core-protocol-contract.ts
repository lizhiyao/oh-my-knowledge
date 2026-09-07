import { z } from 'zod';
import {
  EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
  ExecutorCapabilitiesSchema,
  JsonValueSchema,
  deepFreezeCanonicalJson,
  type CoreSchemaValidator,
  type ExecutorCapabilities,
  type JsonValue,
  type SchemaIdentity,
} from '../../../../eval-core/contracts/index.js';
import { SourceNeutralTraceSchema } from '../../../../eval-runtime/traces/source-neutral.js';

type ClaudeSchemaIdentity = (name: 'input' | 'output' | 'trace') => SchemaIdentity;

export function createClaudeCoreSchemaValidators(schemaIdentity: ClaudeSchemaIdentity): readonly CoreSchemaValidator[] {
  return Object.freeze([
    Object.freeze({
      schema: deepFreezeCanonicalJson(schemaIdentity('input')),
      parse(value: unknown): JsonValue {
        return JsonValueSchema.parse(value);
      },
    }),
    Object.freeze({
      schema: deepFreezeCanonicalJson(schemaIdentity('output')),
      parse(value: unknown): JsonValue {
        return z.string().parse(value);
      },
    }),
    Object.freeze({
      schema: deepFreezeCanonicalJson(schemaIdentity('trace')),
      parse(value: unknown): JsonValue {
        return SourceNeutralTraceSchema.parse(value) as JsonValue;
      },
    }),
  ]);
}

export function claudeCoreExecutorCapabilities(schemaIdentity: ClaudeSchemaIdentity): ExecutorCapabilities {
  return deepFreezeCanonicalJson(ExecutorCapabilitiesSchema.parse({
    schemaVersion: EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
    protocols: [{
      protocolId: 'omk.invoke/v1',
      inputSchema: schemaIdentity('input'),
      outputSchema: schemaIdentity('output'),
      traceSchema: schemaIdentity('trace'),
      execution: {
        concurrency: { safety: 'serialized', maxInFlight: 1 },
        cancellation: 'best-effort',
        state: { resourceLifecycle: 'per-invocation', trialState: 'stateless' },
        seedControl: 'unsupported',
        determinism: 'stochastic',
        features: {
          systemInstructions: 'native',
          workspace: ['copy-on-write-overlay'],
          mcp: ['native-config'],
          mockInterception: ['pre-tool-call'],
          toolPolicies: ['allow-list', 'runtime-default'],
          skillDiscovery: ['disabled', 'runtime-default'],
          sandboxIds: [],
        },
        telemetry: {
          trace: 'required',
          usage: 'optional',
          providerCost: { reporting: 'optional' },
        },
      },
    }],
  })) as ExecutorCapabilities;
}
