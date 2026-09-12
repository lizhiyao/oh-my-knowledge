import { ExecutionPortFailure } from '../../../../eval-core/execution/index.js';
import {
  codexCoreExecutorCapabilities,
  createCodexCoreSchemaValidators,
  parseCodexCoreEvents,
  type CodexCoreProtocolProfile,
  type ParsedCodexCoreStream,
} from './protocol-core.js';
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

/**
 * Recognises the one vendor message this adapter can act on without echoing provider text: the
 * selected model needs a newer Codex CLI. Detection stays structural, so a credential that happens
 * to appear in stdout can never be quoted back into a diagnostic.
 */
export function requiresCodexUpgrade(stdout: string): boolean {
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as { type?: string; message?: unknown; error?: { message?: unknown } };
      if (!event || typeof event !== 'object') continue;
      let message = event.type === 'error' ? event.message
        : event.type === 'turn.failed' ? event.error?.message : undefined;
      if (typeof message !== 'string') continue;
      if (message.startsWith('{')) {
        const detail = JSON.parse(message) as { error?: { message?: unknown } };
        message = detail?.error?.message;
      }
      if (typeof message === 'string'
          && /^The '[^'\r\n]+' model requires a newer version of Codex\./.test(message)) return true;
    } catch {
      // Only recognized provider error events produce an actionable, redacted code.
    }
  }
  return false;
}
