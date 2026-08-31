import { z } from 'zod';
import {
  EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
  ExecutorCapabilitiesSchema,
  JsonValueSchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type CoreSchemaValidator,
  type ExecutorCapabilities,
  type JsonValue,
  type SchemaIdentity,
} from '../../../evaluation-core/contracts/index.js';
import {
  SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR,
  SourceNeutralTraceWithoutMocksSchema,
} from '../source-neutral-trace.js';

export interface StatelessApiProtocolProfile {
  readonly providerId: string;
  readonly sourceProtocol: string;
}

const StatelessApiTraceSchema = SourceNeutralTraceWithoutMocksSchema.superRefine(
  (trace, context) => {
    if (trace.toolCalls.length > 0) {
      context.addIssue({ code: 'custom', path: ['toolCalls'], message: 'Tool calls are unsupported.' });
    }
    if (trace.numTurns !== 1 || trace.fullNumTurns !== 1 || trace.numSubAgents !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['numTurns'],
        message: 'A stateless API trace contains exactly one root turn and no subagents.',
      });
    }
  },
);

const STATELESS_API_TRACE_SCHEMA_DESCRIPTOR: JsonValue = deepFreezeCanonicalJson({
  base: SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR,
  constraints: {
    toolCalls: 'none',
    numTurns: 1,
    fullNumTurns: 1,
    numSubAgents: 0,
  },
});

function schemaIdentity(
  profile: StatelessApiProtocolProfile,
  name: 'input' | 'output' | 'trace',
): SchemaIdentity {
  const contractVersion = name === 'trace' ? 'v2' : 'v1';
  const schemaVersion = `omk.${profile.providerId}-${name}/${contractVersion}`;
  const descriptor: JsonValue = name === 'input'
    ? { valueKind: 'json-value' }
    : name === 'output'
      ? { valueKind: 'string' }
      : STATELESS_API_TRACE_SCHEMA_DESCRIPTOR;
  return {
    schemaVersion,
    schemaUri: `urn:omk:runtime:${profile.providerId}:${name}:${contractVersion}`,
    schemaDigest: digestCanonicalJson({
      schemaVersion,
      sourceProtocol: profile.sourceProtocol,
      contract: descriptor,
    }),
  };
}

export function createStatelessApiCoreSchemaValidators(
  profile: StatelessApiProtocolProfile,
): readonly CoreSchemaValidator[] {
  return Object.freeze([
    Object.freeze({
      schema: deepFreezeCanonicalJson(schemaIdentity(profile, 'input')),
      parse(value: unknown): JsonValue {
        return JsonValueSchema.parse(value);
      },
    }),
    Object.freeze({
      schema: deepFreezeCanonicalJson(schemaIdentity(profile, 'output')),
      parse(value: unknown): JsonValue {
        return z.string().parse(value);
      },
    }),
    Object.freeze({
      schema: deepFreezeCanonicalJson(schemaIdentity(profile, 'trace')),
      parse(value: unknown): JsonValue {
        return StatelessApiTraceSchema.parse(value) as JsonValue;
      },
    }),
  ]);
}

export function statelessApiExecutorCapabilities(
  profile: StatelessApiProtocolProfile,
): ExecutorCapabilities {
  return deepFreezeCanonicalJson(ExecutorCapabilitiesSchema.parse({
    schemaVersion: EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
    protocols: [{
      protocolId: 'omk.invoke/v1',
      inputSchema: schemaIdentity(profile, 'input'),
      outputSchema: schemaIdentity(profile, 'output'),
      traceSchema: schemaIdentity(profile, 'trace'),
      execution: {
        concurrency: { safety: 'parallel-safe' },
        cancellation: 'cooperative',
        state: { resourceLifecycle: 'per-invocation', trialState: 'stateless' },
        seedControl: 'unsupported',
        determinism: 'stochastic',
        features: {
          systemInstructions: 'native',
          workspace: [],
          mcp: [],
          mockInterception: [],
          toolPolicies: ['runtime-default'],
          skillDiscovery: ['runtime-default'],
          sandboxIds: [],
        },
        telemetry: {
          trace: 'required',
          usage: 'optional',
          providerCost: { reporting: 'unsupported' },
        },
      },
    }],
  })) as ExecutorCapabilities;
}
