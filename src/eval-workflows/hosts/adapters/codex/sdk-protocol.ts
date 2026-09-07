import {
  codexCoreExecutorCapabilities,
  createCodexCoreSchemaValidators,
  parseCodexCoreEvents,
  type CodexCoreProtocolProfile,
  type ParsedCodexCoreStream,
} from './protocol-core.js';
export type ParsedCodexSdkStream = ParsedCodexCoreStream;

const CODEX_SDK_PROTOCOL_PROFILE = Object.freeze({
  adapterLabel: 'Codex SDK',
  errorCode: 'OMK_CODEX_SDK_PROTOCOL_INVALID',
  schemaNamespace: 'omk.codex-sdk',
  schemaUriNamespace: 'urn:omk:runtime:codex-sdk',
  sourceProtocol: '@openai/codex-sdk runStreamed',
}) satisfies CodexCoreProtocolProfile;

/** Validators matching the schema identities advertised by this adapter. */
export function createCodexSdkCoreSchemaValidators() {
  return createCodexCoreSchemaValidators(CODEX_SDK_PROTOCOL_PROFILE);
}

export function codexSdkExecutorCapabilities() {
  return codexCoreExecutorCapabilities(CODEX_SDK_PROTOCOL_PROFILE);
}

export function parseCodexSdkStream(events: readonly unknown[]): ParsedCodexSdkStream {
  return parseCodexCoreEvents(events, CODEX_SDK_PROTOCOL_PROFILE);
}
