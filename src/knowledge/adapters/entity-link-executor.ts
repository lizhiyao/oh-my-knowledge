import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorFn, ExecutorInput } from '../../executors/contracts/ports.js';
import type { ExecResult } from '../../executors/contracts/result.js';
import { canonicalJson } from '../store.js';
import { entityLinkDigest } from '../entity-linking/entity-link-hash.js';
import { ENTITY_LINK_PROMPT, ENTITY_LINK_PROMPT_HASH, ENTITY_LINK_PROMPT_VERSION,
  ENTITY_LINK_RESPONSE_JSON_SCHEMA, ENTITY_LINK_RESPONSE_SCHEMA_HASH, ENTITY_LINK_RESPONSE_SCHEMA_ID } from '../entity-linking/entity-link-prompt.js';

const TIMEOUT_MS = 300_000;
const API_MAX_OUTPUT_TOKENS = 4096;
const MAX_INPUT_BYTES = 256 * 1024;

/** Exact prompt/request integrity only; endpoint, binary and effective config are not frozen here. */
export interface EntityLinkExecutionRequest {
  readonly requestKind: 'entity-link-execution-request';
  readonly protocolId: 'entity-link-executor/v1';
  readonly executor: 'codex' | 'openai-api';
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly promptVersion: typeof ENTITY_LINK_PROMPT_VERSION;
  readonly promptHash: string;
  readonly responseSchemaId: typeof ENTITY_LINK_RESPONSE_SCHEMA_ID;
  readonly responseSchemaHash: string;
  readonly outputFormat: Extract<NonNullable<ExecutorInput['outputFormat']>, { mode: 'json-schema' }>;
  readonly timeoutMs: number;
  readonly maxOutputTokens?: number;
  readonly requestDigest: string;
}

/** Preparation is local and has no executor, filesystem or network side effects. */
export function createEntityLinkExecutionRequest(selection: { executor: string; model: string }, input: unknown): EntityLinkExecutionRequest {
  if (selection.executor !== 'codex' && selection.executor !== 'openai-api') throw new Error('Unsupported entity-link executor.');
  const executor: EntityLinkExecutionRequest['executor'] = selection.executor;
  if (!selection.model.trim()) throw new Error('An explicitly configured model is required.');
  const prompt = canonicalJson(input);
  if (Buffer.byteLength(ENTITY_LINK_PROMPT, 'utf8') + Buffer.byteLength(prompt, 'utf8') > MAX_INPUT_BYTES) throw new Error('Entity-link input capacity exceeded.');
  const request = { requestKind: 'entity-link-execution-request' as const, protocolId: 'entity-link-executor/v1' as const,
    executor, model: selection.model, system: ENTITY_LINK_PROMPT, prompt,
    promptVersion: ENTITY_LINK_PROMPT_VERSION, promptHash: ENTITY_LINK_PROMPT_HASH,
    responseSchemaId: ENTITY_LINK_RESPONSE_SCHEMA_ID, responseSchemaHash: ENTITY_LINK_RESPONSE_SCHEMA_HASH,
    outputFormat: Object.freeze({ mode: 'json-schema' as const, name: 'entity_link_suggestion_v1', schema: ENTITY_LINK_RESPONSE_JSON_SCHEMA }),
    timeoutMs: TIMEOUT_MS, ...(selection.executor === 'openai-api' ? { maxOutputTokens: API_MAX_OUTPUT_TOKENS } : {}) };
  return Object.freeze({ ...request, requestDigest: entityLinkDigest(request) });
}

/** Delivery hosts own runtime capability checks and concrete executor composition. */
export interface EntityLinkExecutorHost {
  assertCapabilities(executor: string, input: ExecutorInput): void;
  create(executor: string): ExecutorFn;
}

export type EntityLinkExecutionOutcome = (
  | { outcomeKind: 'result'; result: ExecResult }
  | { outcomeKind: 'exception'; error: unknown }
) & { cleanupFailure?: { diagnostic: string } };

/**
 * Configuration/preflight errors precede dispatch. A future durable host must also
 * bind and recheck runtime identity before marking started; this adapter grants no authorization.
 */
export function configuredEntityLinkExecutor(request: EntityLinkExecutionRequest, host: EntityLinkExecutorHost) {
  const snapshot = createEntityLinkExecutionRequest(request, JSON.parse(request.prompt));
  if (canonicalJson(snapshot) !== canonicalJson(request)) throw new Error('Entity-link execution request identity conflict.');
  host.assertCapabilities(snapshot.executor, snapshot);
  const execute = host.create(snapshot.executor);
  return {
    request: snapshot,
    async execute(signal?: AbortSignal): Promise<EntityLinkExecutionOutcome> {
      signal?.throwIfAborted();
      const cwd = snapshot.executor === 'codex' ? mkdtempSync(join(tmpdir(), 'omk-entity-link-')) : undefined;
      let outcome: EntityLinkExecutionOutcome;
      try {
        // No tool/JSON/refusal admission here: archive the entire returned fact first.
        outcome = { outcomeKind: 'result', result: await execute({ model: snapshot.model, system: snapshot.system, prompt: snapshot.prompt,
          outputFormat: snapshot.outputFormat, timeoutMs: snapshot.timeoutMs,
          ...(snapshot.maxOutputTokens !== undefined ? { maxOutputTokens: snapshot.maxOutputTokens } : {}),
          // Private cwd isolates project context, not global Codex skill discovery.
          ...(cwd ? { cwd } : {}), abortSignal: signal }) };
      } catch (error) { outcome = { outcomeKind: 'exception', error }; }
      finally {
        if (cwd) {
          try { rmSync(cwd, { recursive: true, force: true }); }
          // Do not replace a returned paid response or the original invocation exception.
          catch { outcome!.cleanupFailure = { diagnostic: 'Private execution directory cleanup failed.' }; }
        }
      }
      // A late abort cannot erase a response already returned by the executor.
      return outcome;
    },
  };
}
