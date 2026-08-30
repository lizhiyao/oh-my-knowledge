import { z } from 'zod';
import {
  EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
  ExecutorCapabilitiesSchema,
  JsonValueSchema,
  UsageRecordSchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type CoreSchemaValidator,
  type ExecutorCapabilities,
  type JsonValue,
  type SchemaIdentity,
  type UsageRecord,
} from '../../../evaluation-core/contracts/index.js';
import { ExecutionPortFailure } from '../../../evaluation-core/execution/index.js';
import {
  normalizeCodexProtocolEvent,
  type CodexEvent,
} from '../../../executors/openai/codex/protocol.js';
import { extractCodexTrace } from '../../../executors/openai/codex/trace.js';
import {
  isValidToolCallInfo,
  isValidTurnInfo,
} from '../../../shared/executor-result.js';

export const CODEX_CLI_READ_ONLY_SANDBOX_ID = 'omk.codex.read-only/v1' as const;
export const CODEX_CLI_WORKSPACE_WRITE_SANDBOX_ID =
  'omk.codex.workspace-write/v1' as const;

export interface ParsedCodexCliStream {
  readonly events: readonly CodexEvent[];
  readonly output?: string;
  readonly trace?: JsonValue;
  readonly usage?: UsageRecord;
  readonly terminalStatus: 'completed' | 'failed';
}

const CodexCliTraceSchema = z.object({
  schemaVersion: z.literal('omk.source-neutral-trace/v1'),
  turns: z.array(z.custom<JsonValue>(isValidTurnInfo)),
  toolCalls: z.array(z.custom<JsonValue>(isValidToolCallInfo)),
  fullNumTurns: z.number().int().nonnegative(),
  numSubAgents: z.number().int().nonnegative(),
}).strict();

const CODEX_CLI_SCHEMA_DESCRIPTORS = {
  input: {
    valueKind: 'json-value',
  },
  output: {
    valueKind: 'string',
  },
  trace: {
    schemaVersion: 'omk.source-neutral-trace/v1',
    fields: ['fullNumTurns', 'numSubAgents', 'schemaVersion', 'toolCalls', 'turns'],
    turnAndToolCallItems: 'source-neutral-executor-trace/v1',
  },
} as const satisfies Readonly<Record<'input' | 'output' | 'trace', JsonValue>>;

function fail(message: string, usage?: UsageRecord): never {
  throw new ExecutionPortFailure({
    code: 'OMK_CODEX_CLI_PROTOCOL_INVALID',
    stage: 'execution',
    message,
  }, usage);
}

function schemaIdentity(name: 'input' | 'output' | 'trace'): SchemaIdentity {
  const schemaVersion = `omk.codex-cli-${name}/v1`;
  return {
    schemaVersion,
    schemaUri: `urn:omk:runtime:codex-cli:${name}:v1`,
    schemaDigest: digestCanonicalJson({
      schemaVersion,
      sourceProtocol: 'codex exec --json',
      contract: CODEX_CLI_SCHEMA_DESCRIPTORS[name],
    }),
  };
}

/** Validators matching the schema identities advertised by this adapter. */
export function createCodexCliCoreSchemaValidators(): readonly CoreSchemaValidator[] {
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
        return CodexCliTraceSchema.parse(value) as JsonValue;
      },
    }),
  ]);
}

export function codexCliExecutorCapabilities(): ExecutorCapabilities {
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
          systemInstructions: 'prepended',
          workspace: ['copy-on-write-overlay'],
          mcp: [],
          mockInterception: [],
          toolPolicies: ['runtime-default'],
          skillDiscovery: ['runtime-default'],
          sandboxIds: [
            CODEX_CLI_READ_ONLY_SANDBOX_ID,
            CODEX_CLI_WORKSPACE_WRITE_SANDBOX_ID,
          ],
        },
        telemetry: {
          trace: 'optional',
          usage: 'optional',
          providerCost: { reporting: 'unsupported' },
        },
      },
    }],
  })) as ExecutorCapabilities;
}

function safeToken(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function usageFromEvent(event: CodexEvent): UsageRecord | undefined {
  if (event.usage === undefined) return undefined;
  const inputTokens = safeToken(event.usage.input_tokens);
  const outputTokens = safeToken(event.usage.output_tokens);
  const cachedInputTokens = safeToken(event.usage.cached_input_tokens);
  const reasoningOutputTokens = safeToken(event.usage.reasoning_output_tokens);
  if (
    (event.usage.input_tokens !== undefined && inputTokens === undefined)
    || (event.usage.output_tokens !== undefined && outputTokens === undefined)
    || (event.usage.cached_input_tokens !== undefined && cachedInputTokens === undefined)
    || (event.usage.reasoning_output_tokens !== undefined && reasoningOutputTokens === undefined)
    || (cachedInputTokens !== undefined && inputTokens !== undefined && cachedInputTokens > inputTokens)
  ) fail('Codex CLI reported invalid usage.');
  const totalTokens = inputTokens !== undefined && outputTokens !== undefined
    && Number.isSafeInteger(inputTokens + outputTokens)
    ? inputTokens + outputTokens
    : undefined;
  const usage = UsageRecordSchema.parse({
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined && reasoningOutputTokens === undefined ? {} : {
      details: {
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
      },
    }),
  });
  return Object.keys(usage).length === 0 ? undefined : usage;
}

export function parseCodexCliStream(stdout: string): ParsedCodexCliStream {
  const events: CodexEvent[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail('Codex CLI returned malformed JSONL.');
    }
    const event = normalizeCodexProtocolEvent(value);
    if (event === null || typeof event.type !== 'string') {
      fail('Codex CLI returned an invalid event.');
    }
    events.push(event);
  }
  const supportedEvents = new Set([
    'thread.started', 'turn.started', 'turn.completed', 'turn.failed',
    'item.started', 'item.updated', 'item.completed', 'error',
  ]);
  const supportedItems = new Set([
    'agent_message', 'reasoning', 'command_execution', 'file_change',
    'mcp_tool_call', 'web_search', 'todo_list', 'error', 'file_read', 'file_write',
  ]);
  const pending = new Map<string, string>();
  const completed = new Set<string>();
  let threadStarted = 0;
  let started = 0;
  let terminal: CodexEvent | undefined;
  let protocolError = false;
  for (const [index, event] of events.entries()) {
    if (!supportedEvents.has(event.type ?? '')) protocolError = true;
    if (terminal !== undefined) protocolError = true;
    if (event.type === 'thread.started') {
      threadStarted += 1;
      if (index !== 0 || started > 0) protocolError = true;
    }
    if (event.type === 'turn.started') {
      started += 1;
      if (threadStarted !== 1) protocolError = true;
    }
    if (event.type?.startsWith('item.')) {
      if (started !== 1) protocolError = true;
      const itemId = event.item?.id;
      const itemType = event.item?.type;
      if (
        !supportedItems.has(itemType ?? '')
        || typeof itemId !== 'string'
        || itemId.trim() === ''
      ) protocolError = true;
      else if (event.type === 'item.started') {
        if (pending.has(itemId) || completed.has(itemId)) protocolError = true;
        pending.set(itemId, itemType as string);
      } else if (
        event.type === 'item.updated'
        && pending.get(itemId) !== itemType
      ) protocolError = true;
      else if (event.type === 'item.completed') {
        if (
          completed.has(itemId)
          || (pending.has(itemId) && pending.get(itemId) !== itemType)
        ) protocolError = true;
        pending.delete(itemId);
        completed.add(itemId);
      }
    }
    if (event.type === 'error') protocolError = true;
    if (event.type === 'turn.completed' || event.type === 'turn.failed') {
      if (started !== 1) protocolError = true;
      terminal = event;
    }
  }
  if (events.length === 0 || threadStarted !== 1 || started !== 1 || pending.size > 0) {
    protocolError = true;
  }
  if (protocolError) fail('Codex CLI event stream is invalid.');
  if (terminal === undefined) fail('Codex CLI event stream has no terminal event.');
  const usage = usageFromEvent(terminal);
  const finalMessage = [...events].reverse().find((event) => (
    event.type === 'item.completed' && event.item?.type === 'agent_message'
  ))?.item?.text;
  if (terminal.type === 'turn.completed' && (typeof finalMessage !== 'string' || finalMessage.trim() === '')) {
    fail('Codex CLI completed without an assistant response.', usage);
  }
  const neutral = extractCodexTrace(events);
  const trace = CodexCliTraceSchema.parse({
    schemaVersion: 'omk.source-neutral-trace/v1',
    turns: neutral.turns,
    toolCalls: neutral.toolCalls,
    fullNumTurns: neutral.fullNumTurns,
    numSubAgents: neutral.numSubAgents,
  });
  return {
    events,
    ...(typeof finalMessage === 'string' && finalMessage.trim() !== ''
      ? { output: finalMessage }
      : {}),
    trace,
    ...(usage === undefined ? {} : { usage }),
    terminalStatus: terminal.type === 'turn.completed' ? 'completed' : 'failed',
  };
}
