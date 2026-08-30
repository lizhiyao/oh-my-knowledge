import {
  CODEX_READ_ONLY_SANDBOX_ID,
  CODEX_WORKSPACE_WRITE_SANDBOX_ID,
  codexCoreExecutorCapabilities,
  createCodexCoreSchemaValidators,
  parseCodexCoreEvents,
  type CodexCoreProtocolProfile,
  type ParsedCodexCoreStream,
} from './codex-protocol-core.js';

export const CODEX_SDK_READ_ONLY_SANDBOX_ID = CODEX_READ_ONLY_SANDBOX_ID;
export const CODEX_SDK_WORKSPACE_WRITE_SANDBOX_ID = CODEX_WORKSPACE_WRITE_SANDBOX_ID;
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
