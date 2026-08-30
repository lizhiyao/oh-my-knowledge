import { ExecutionPortFailure } from '../../../evaluation-core/execution/index.js';
import {
  CODEX_READ_ONLY_SANDBOX_ID,
  CODEX_WORKSPACE_WRITE_SANDBOX_ID,
  codexCoreExecutorCapabilities,
  createCodexCoreSchemaValidators,
  parseCodexCoreEvents,
  type CodexCoreProtocolProfile,
  type ParsedCodexCoreStream,
} from './codex-protocol-core.js';

export const CODEX_CLI_READ_ONLY_SANDBOX_ID = CODEX_READ_ONLY_SANDBOX_ID;
export const CODEX_CLI_WORKSPACE_WRITE_SANDBOX_ID = CODEX_WORKSPACE_WRITE_SANDBOX_ID;
export type ParsedCodexCliStream = ParsedCodexCoreStream;

const CODEX_CLI_PROTOCOL_PROFILE = Object.freeze({
  adapterLabel: 'Codex CLI',
  errorCode: 'OMK_CODEX_CLI_PROTOCOL_INVALID',
  schemaNamespace: 'omk.codex-cli',
  schemaUriNamespace: 'urn:omk:runtime:codex-cli',
  sourceProtocol: 'codex exec --json',
}) satisfies CodexCoreProtocolProfile;

/** Validators matching the schema identities advertised by this adapter. */
export function createCodexCliCoreSchemaValidators() {
  return createCodexCoreSchemaValidators(CODEX_CLI_PROTOCOL_PROFILE);
}

export function codexCliExecutorCapabilities() {
  return codexCoreExecutorCapabilities(CODEX_CLI_PROTOCOL_PROFILE);
}

export function parseCodexCliStream(stdout: string): ParsedCodexCliStream {
  const values: unknown[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      throw new ExecutionPortFailure({
        code: CODEX_CLI_PROTOCOL_PROFILE.errorCode,
        stage: 'execution',
        message: 'Codex CLI returned malformed JSONL.',
      });
    }
  }
  return parseCodexCoreEvents(values, CODEX_CLI_PROTOCOL_PROFILE);
}
