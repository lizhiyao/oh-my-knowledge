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
  parseClaudeMessageSequence,
  type ParsedClaudeCliStream,
} from './claude-cli-protocol.js';
import {
  isValidToolCallInfo,
  isValidTurnInfo,
} from '../../../shared/executor-result.js';

export const CLAUDE_SDK_CORE_ADAPTER_IMPLEMENTATION_VERSION = '1.0.0' as const;
export type ParsedClaudeSdkStream = ParsedClaudeCliStream;

const CLAUDE_SDK_MESSAGE_PROFILE = Object.freeze({
  adapterLabel: 'Claude SDK',
  errorCode: 'OMK_CLAUDE_SDK_PROTOCOL_INVALID',
});

const CLAUDE_SDK_SCHEMA_DESCRIPTORS = {
  input: { valueKind: 'json-value' },
  output: { valueKind: 'string' },
  trace: {
    schemaVersion: 'omk.source-neutral-trace/v1',
    fields: ['fullNumTurns', 'numSubAgents', 'schemaVersion', 'toolCalls', 'turns'],
    turnAndToolCallItems: 'source-neutral-executor-trace/v1',
  },
} as const satisfies Readonly<Record<'input' | 'output' | 'trace', JsonValue>>;

const ClaudeSdkTraceSchema = z.object({
  schemaVersion: z.literal('omk.source-neutral-trace/v1'),
  turns: z.array(z.custom<JsonValue>(isValidTurnInfo)),
  toolCalls: z.array(z.custom<JsonValue>(isValidToolCallInfo)),
  fullNumTurns: z.number().int().nonnegative(),
  numSubAgents: z.number().int().nonnegative(),
}).strict();

function schemaIdentity(name: 'input' | 'output' | 'trace'): SchemaIdentity {
  const schemaVersion = `omk.claude-sdk-${name}/v1`;
  return {
    schemaVersion,
    schemaUri: `urn:omk:runtime:claude-sdk:${name}:v1`,
    schemaDigest: digestCanonicalJson({
      schemaVersion,
      sourceProtocol: '@anthropic-ai/claude-agent-sdk query',
      contract: CLAUDE_SDK_SCHEMA_DESCRIPTORS[name],
    }),
  };
}

export function createClaudeSdkCoreSchemaValidators(): readonly CoreSchemaValidator[] {
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
        return ClaudeSdkTraceSchema.parse(value) as JsonValue;
      },
    }),
  ]);
}

export function claudeSdkExecutorCapabilities(): ExecutorCapabilities {
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

export function parseClaudeSdkStream(messages: readonly unknown[]): ParsedClaudeSdkStream {
  return parseClaudeMessageSequence(messages, CLAUDE_SDK_MESSAGE_PROFILE);
}
