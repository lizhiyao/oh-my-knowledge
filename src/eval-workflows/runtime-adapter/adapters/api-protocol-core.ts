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
import { isValidTurnInfo } from '../../../shared/executor-result.js';

export interface StatelessApiProtocolProfile {
  readonly providerId: string;
  readonly sourceProtocol: string;
}

const SourceNeutralTraceSchema = z.object({
  schemaVersion: z.literal('omk.source-neutral-trace/v1'),
  turns: z.array(z.custom<JsonValue>(isValidTurnInfo)),
  toolCalls: z.array(z.never()),
  fullNumTurns: z.literal(1),
  numSubAgents: z.literal(0),
}).strict();

function schemaIdentity(
  profile: StatelessApiProtocolProfile,
  name: 'input' | 'output' | 'trace',
): SchemaIdentity {
  const schemaVersion = `omk.${profile.providerId}-${name}/v1`;
  const descriptor: JsonValue = name === 'input'
    ? { valueKind: 'json-value' }
    : name === 'output'
      ? { valueKind: 'string' }
      : {
          schemaVersion: 'omk.source-neutral-trace/v1',
          fields: ['fullNumTurns', 'numSubAgents', 'schemaVersion', 'toolCalls', 'turns'],
          turnItems: 'source-neutral-executor-trace/v1',
          toolCalls: 'none',
        };
  return {
    schemaVersion,
    schemaUri: `urn:omk:runtime:${profile.providerId}:${name}:v1`,
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
        return SourceNeutralTraceSchema.parse(value) as JsonValue;
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
