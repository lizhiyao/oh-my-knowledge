import { createClaudeCoreSchemaValidators, claudeCoreExecutorCapabilities } from './core-protocol-contract.js';
import {
  digestCanonicalJson,
  type CoreSchemaValidator,
  type ExecutorCapabilities,
  type JsonValue,
  type SchemaIdentity,
} from '../../../../eval-core/contracts/index.js';
import {
  parseClaudeMessageSequence,
  type ParsedClaudeCliStream,
} from './cli-protocol.js';
import {
  SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR,
} from '../../../../eval-runtime/traces/source-neutral.js';

export const CLAUDE_SDK_CORE_ADAPTER_IMPLEMENTATION_VERSION = '2.0.0' as const;
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
  return createClaudeCoreSchemaValidators(schemaIdentity);
}

export function claudeSdkExecutorCapabilities(): ExecutorCapabilities {
  return claudeCoreExecutorCapabilities(schemaIdentity);
}

export function parseClaudeSdkStream(messages: readonly unknown[]): ParsedClaudeSdkStream {
  return parseClaudeMessageSequence(messages, CLAUDE_SDK_MESSAGE_PROFILE);
}
