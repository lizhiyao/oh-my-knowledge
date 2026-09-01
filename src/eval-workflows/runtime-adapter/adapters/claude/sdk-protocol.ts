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
} from '../../../../evaluation-core/contracts/index.js';
import {
  parseClaudeMessageSequence,
  type ParsedClaudeCliStream,
} from './cli-protocol.js';
import {
  SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR,
  SourceNeutralTraceSchema,
} from '../../source-neutral-trace.js';

export const CLAUDE_SDK_CORE_ADAPTER_IMPLEMENTATION_VERSION = '1.2.0' as const;
export type ParsedClaudeSdkStream = ParsedClaudeCliStream;

const CLAUDE_SDK_MESSAGE_PROFILE = Object.freeze({
  adapterLabel: 'Claude SDK',
  errorCode: 'OMK_CLAUDE_SDK_PROTOCOL_INVALID',
});

const CLAUDE_SDK_SCHEMA_DESCRIPTORS = {
  input: { valueKind: 'json-value' },
  output: { valueKind: 'string' },
  trace: SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR,
} as const satisfies Readonly<Record<'input' | 'output' | 'trace', JsonValue>>;

function schemaIdentity(name: 'input' | 'output' | 'trace'): SchemaIdentity {
  const contractVersion = name === 'trace' ? 'v2' : 'v1';
  const schemaVersion = `omk.claude-sdk-${name}/${contractVersion}`;
  return {
    schemaVersion,
    schemaUri: `urn:omk:runtime:claude-sdk:${name}:${contractVersion}`,
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
        return SourceNeutralTraceSchema.parse(value) as JsonValue;
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
