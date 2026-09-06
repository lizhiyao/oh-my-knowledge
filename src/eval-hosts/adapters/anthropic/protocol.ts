import {
  UsageRecordSchema,
  type JsonValue,
  type UsageRecord,
} from '../../../eval-core/contracts/index.js';
import { ExecutionPortFailure } from '../../../eval-core/execution/index.js';
import {
  createStatelessApiCoreSchemaValidators,
  statelessApiExecutorCapabilities,
  type StatelessApiProtocolProfile,
} from '../shared/api-protocol-core.js';
import { SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION } from '../../../eval-runtime/traces/source-neutral.js';

export const ANTHROPIC_API_CORE_ADAPTER_IMPLEMENTATION_VERSION = '1.1.0' as const;

export const ANTHROPIC_API_PROTOCOL_PROFILE = Object.freeze({
  providerId: 'anthropic-api',
  sourceProtocol: 'Anthropic Messages API 2023-06-01',
}) satisfies StatelessApiProtocolProfile;

export function createAnthropicApiCoreSchemaValidators() {
  return createStatelessApiCoreSchemaValidators(ANTHROPIC_API_PROTOCOL_PROFILE);
}

export function anthropicApiExecutorCapabilities() {
  return statelessApiExecutorCapabilities(ANTHROPIC_API_PROTOCOL_PROFILE);
}

export interface ParsedAnthropicApiMessage {
  readonly output: string;
  readonly trace: JsonValue;
  readonly usage: UsageRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function fail(message: string, usage?: UsageRecord): never {
  throw new ExecutionPortFailure({
    code: 'OMK_ANTHROPIC_API_PROTOCOL_INVALID',
    stage: 'execution',
    message,
  }, usage);
}

function parseUsage(
  rawUsage: unknown,
  responseModel: string,
  stopReason: string | null,
  stopSequence: string | null,
): UsageRecord {
  let inputTokens: number | undefined;
  let uncachedInputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let cacheCreationInputTokens1h: number | undefined;
  let cacheCreationInputTokens5m: number | undefined;
  let thinkingOutputTokens: number | undefined;
  let inferenceGeo: string | undefined;
  let serviceTier: string | undefined;
  if (rawUsage !== undefined) {
    if (!isRecord(rawUsage)) fail('Anthropic API reported invalid usage.');
    uncachedInputTokens = tokenCount(rawUsage.input_tokens);
    outputTokens = tokenCount(rawUsage.output_tokens);
    cacheReadInputTokens = rawUsage.cache_read_input_tokens === undefined
      || rawUsage.cache_read_input_tokens === null
      ? undefined
      : tokenCount(rawUsage.cache_read_input_tokens);
    cacheCreationInputTokens = rawUsage.cache_creation_input_tokens === undefined
      || rawUsage.cache_creation_input_tokens === null
      ? undefined
      : tokenCount(rawUsage.cache_creation_input_tokens);
    if (
      uncachedInputTokens === undefined
      || outputTokens === undefined
      || (
        rawUsage.cache_read_input_tokens !== undefined
        && rawUsage.cache_read_input_tokens !== null
        && cacheReadInputTokens === undefined
      )
      || (
        rawUsage.cache_creation_input_tokens !== undefined
        && rawUsage.cache_creation_input_tokens !== null
        && cacheCreationInputTokens === undefined
      )
    ) fail('Anthropic API reported invalid usage.');
    if (cacheReadInputTokens !== undefined && cacheCreationInputTokens !== undefined) {
      inputTokens = uncachedInputTokens + cacheReadInputTokens + cacheCreationInputTokens;
      if (!Number.isSafeInteger(inputTokens)) {
        fail('Anthropic API reported overflowing usage.');
      }
    }
    if (rawUsage.cache_creation !== undefined && rawUsage.cache_creation !== null) {
      if (!isRecord(rawUsage.cache_creation)) {
        fail('Anthropic API reported invalid cache creation usage.');
      }
      cacheCreationInputTokens1h = tokenCount(
        rawUsage.cache_creation.ephemeral_1h_input_tokens,
      );
      cacheCreationInputTokens5m = tokenCount(
        rawUsage.cache_creation.ephemeral_5m_input_tokens,
      );
      if (
        cacheCreationInputTokens1h === undefined
        || cacheCreationInputTokens5m === undefined
        || (
          cacheCreationInputTokens !== undefined
          && cacheCreationInputTokens1h + cacheCreationInputTokens5m
            !== cacheCreationInputTokens
        )
      ) fail('Anthropic API reported inconsistent cache creation usage.');
    }
    if (rawUsage.output_tokens_details !== undefined
        && rawUsage.output_tokens_details !== null) {
      if (!isRecord(rawUsage.output_tokens_details)) {
        fail('Anthropic API reported invalid output token details.');
      }
      thinkingOutputTokens = tokenCount(rawUsage.output_tokens_details.thinking_tokens);
      if (thinkingOutputTokens === undefined || thinkingOutputTokens > outputTokens) {
        fail('Anthropic API reported invalid thinking token usage.');
      }
    }
    if (rawUsage.inference_geo !== undefined && rawUsage.inference_geo !== null) {
      if (typeof rawUsage.inference_geo !== 'string') {
        fail('Anthropic API reported invalid inference geography.');
      }
      inferenceGeo = rawUsage.inference_geo;
    }
    if (rawUsage.service_tier !== undefined && rawUsage.service_tier !== null) {
      if (typeof rawUsage.service_tier !== 'string' || rawUsage.service_tier.trim() === '') {
        fail('Anthropic API reported invalid service tier.');
      }
      serviceTier = rawUsage.service_tier;
    }
    if (rawUsage.server_tool_use !== undefined && rawUsage.server_tool_use !== null) {
      if (
        !isRecord(rawUsage.server_tool_use)
        || Object.values(rawUsage.server_tool_use).some((count) => tokenCount(count) === undefined)
      ) fail('Anthropic API reported invalid server tool usage.');
      if (Object.values(rawUsage.server_tool_use).some((count) => (count as number) > 0)) {
        fail('Anthropic API used a server tool that was not requested.');
      }
    }
  }
  const totalTokens = inputTokens === undefined || outputTokens === undefined
    ? undefined
    : inputTokens + outputTokens;
  if (totalTokens !== undefined && !Number.isSafeInteger(totalTokens)) {
    fail('Anthropic API reported overflowing usage.');
  }
  return UsageRecordSchema.parse({
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    details: {
      provider: 'anthropic',
      responseModel,
      stopReason,
      stopSequence,
      tokenAccounting: 'exclusive-cache-input-buckets',
      ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
      ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
      ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
      ...(cacheCreationInputTokens1h === undefined ? {} : { cacheCreationInputTokens1h }),
      ...(cacheCreationInputTokens5m === undefined ? {} : { cacheCreationInputTokens5m }),
      ...(thinkingOutputTokens === undefined ? {} : { thinkingOutputTokens }),
      ...(inferenceGeo === undefined ? {} : { inferenceGeo }),
      ...(serviceTier === undefined ? {} : { serviceTier }),
    },
  });
}

export function parseAnthropicApiMessage(value: JsonValue): ParsedAnthropicApiMessage {
  if (
    !isRecord(value)
    || value.type !== 'message'
    || value.role !== 'assistant'
    || typeof value.model !== 'string'
    || value.model.trim() === ''
    || !Array.isArray(value.content)
    || (value.stop_reason !== null && typeof value.stop_reason !== 'string')
    || (value.stop_sequence !== null && typeof value.stop_sequence !== 'string')
  ) fail('Anthropic API returned an invalid Message envelope.');
  const usage = parseUsage(value.usage, value.model, value.stop_reason, value.stop_sequence);
  const text: string[] = [];
  const supportedBlockTypes = new Set(['text', 'thinking', 'redacted_thinking']);
  for (const block of value.content) {
    if (!isRecord(block) || typeof block.type !== 'string' || block.type.trim() === '') {
      fail('Anthropic API returned an invalid content block.', usage);
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') {
        fail('Anthropic API returned an invalid text block.', usage);
      }
      text.push(block.text);
    } else if (block.type === 'thinking') {
      if (typeof block.thinking !== 'string' || typeof block.signature !== 'string') {
        fail('Anthropic API returned an invalid thinking block.', usage);
      }
    } else if (block.type === 'redacted_thinking') {
      if (typeof block.data !== 'string') {
        fail('Anthropic API returned an invalid redacted thinking block.', usage);
      }
    } else if (!supportedBlockTypes.has(block.type)) {
      fail('Anthropic API returned an unsupported content block.', usage);
    }
  }
  const output = text.join('');
  if (output.trim() === '') {
    fail('Anthropic API completed without assistant text.', usage);
  }
  return Object.freeze({
    output,
    trace: {
      schemaVersion: SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
      turns: [{ role: 'assistant', content: output }],
      toolCalls: [],
      numTurns: 1,
      fullNumTurns: 1,
      numSubAgents: 0,
    },
    usage,
  });
}
