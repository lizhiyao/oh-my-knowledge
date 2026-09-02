import {
  UsageRecordSchema,
  type JsonValue,
  type UsageRecord,
} from '../../../../eval-core/contracts/index.js';
import { ExecutionPortFailure } from '../../../../eval-core/execution/index.js';
import {
  createStatelessApiCoreSchemaValidators,
  statelessApiExecutorCapabilities,
  type StatelessApiProtocolProfile,
} from '../shared/api-protocol-core.js';
import { SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION } from '../../source-neutral-trace.js';

export const OPENAI_API_CORE_ADAPTER_IMPLEMENTATION_VERSION = '1.1.0' as const;

export const OPENAI_API_PROTOCOL_PROFILE = Object.freeze({
  providerId: 'openai-api',
  sourceProtocol: 'OpenAI Responses API',
}) satisfies StatelessApiProtocolProfile;

export function createOpenAIApiCoreSchemaValidators() {
  return createStatelessApiCoreSchemaValidators(OPENAI_API_PROTOCOL_PROFILE);
}

export function openAIApiExecutorCapabilities() {
  return statelessApiExecutorCapabilities(OPENAI_API_PROTOCOL_PROFILE);
}

export interface ParsedOpenAIApiResponse {
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

function fail(message: string, usage?: UsageRecord, code = 'OMK_OPENAI_API_PROTOCOL_INVALID'): never {
  throw new ExecutionPortFailure({ code, stage: 'execution', message }, usage);
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`OpenAI API reported an invalid ${label}.`);
  }
  return value;
}

function parseEffectiveEffort(
  rawReasoning: unknown,
  requestedEffort: string | undefined,
): string | undefined {
  if (rawReasoning === undefined || rawReasoning === null) return requestedEffort;
  if (!isRecord(rawReasoning)) fail('OpenAI API reported invalid reasoning metadata.');
  return optionalNonEmptyString(rawReasoning.effort, 'reasoning effort') ?? requestedEffort;
}

function parseUsage(
  rawUsage: unknown,
  responseModel: string,
  responseStatus: string,
  serviceTier: string | undefined,
  effectiveEffort: string | undefined,
): UsageRecord {
  if (rawUsage === undefined || rawUsage === null) {
    return UsageRecordSchema.parse({
      details: {
        provider: 'openai',
        responseModel,
        responseStatus,
        tokenAccounting: 'inclusive-provider-totals',
        ...(serviceTier === undefined ? {} : { serviceTier }),
        ...(effectiveEffort === undefined ? {} : { effectiveEffort }),
      },
    });
  }
  if (!isRecord(rawUsage)) fail('OpenAI API reported invalid usage.');
  const inputTokens = tokenCount(rawUsage.input_tokens);
  const outputTokens = tokenCount(rawUsage.output_tokens);
  const totalTokens = tokenCount(rawUsage.total_tokens);
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || totalTokens === undefined
    || !Number.isSafeInteger(inputTokens + outputTokens)
    || inputTokens + outputTokens !== totalTokens
  ) fail('OpenAI API reported inconsistent usage.');

  let cachedInputTokens: number | undefined;
  let cacheWriteInputTokens: number | undefined;
  if (rawUsage.input_tokens_details !== undefined && rawUsage.input_tokens_details !== null) {
    if (!isRecord(rawUsage.input_tokens_details)) {
      fail('OpenAI API reported invalid input token details.');
    }
    const details = rawUsage.input_tokens_details;
    if (details.cached_tokens !== undefined && details.cached_tokens !== null) {
      cachedInputTokens = tokenCount(details.cached_tokens);
      if (cachedInputTokens === undefined || cachedInputTokens > inputTokens) {
        fail('OpenAI API reported invalid cached input token usage.');
      }
    }
    if (details.cache_write_tokens !== undefined && details.cache_write_tokens !== null) {
      cacheWriteInputTokens = tokenCount(details.cache_write_tokens);
      if (cacheWriteInputTokens === undefined || cacheWriteInputTokens > inputTokens) {
        fail('OpenAI API reported invalid cache write token usage.');
      }
    }
  }

  let reasoningOutputTokens: number | undefined;
  if (rawUsage.output_tokens_details !== undefined && rawUsage.output_tokens_details !== null) {
    if (!isRecord(rawUsage.output_tokens_details)) {
      fail('OpenAI API reported invalid output token details.');
    }
    const reasoningTokens = rawUsage.output_tokens_details.reasoning_tokens;
    if (reasoningTokens !== undefined && reasoningTokens !== null) {
      reasoningOutputTokens = tokenCount(reasoningTokens);
      if (reasoningOutputTokens === undefined || reasoningOutputTokens > outputTokens) {
        fail('OpenAI API reported invalid reasoning token usage.');
      }
    }
  }

  return UsageRecordSchema.parse({
    inputTokens,
    outputTokens,
    totalTokens,
    details: {
      provider: 'openai',
      responseModel,
      responseStatus,
      tokenAccounting: 'inclusive-provider-totals',
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
      ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
      ...(serviceTier === undefined ? {} : { serviceTier }),
      ...(effectiveEffort === undefined ? {} : { effectiveEffort }),
    },
  });
}

function validateStatelessEnvelope(value: Record<string, unknown>, usage: UsageRecord): void {
  if (value.store !== undefined && value.store !== false) {
    fail('OpenAI API unexpectedly stored the response.', usage);
  }
  if (value.background !== undefined && value.background !== false) {
    fail('OpenAI API unexpectedly used background execution.', usage);
  }
  if (value.previous_response_id !== undefined && value.previous_response_id !== null) {
    fail('OpenAI API unexpectedly linked server-side response state.', usage);
  }
  if (value.conversation !== undefined && value.conversation !== null) {
    fail('OpenAI API unexpectedly linked a server-side conversation.', usage);
  }
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length !== 0)) {
    fail('OpenAI API unexpectedly enabled tools.', usage);
  }
  if (value.tool_choice !== undefined && value.tool_choice !== 'none') {
    fail('OpenAI API unexpectedly enabled tool choice.', usage);
  }
  if (value.parallel_tool_calls !== undefined && value.parallel_tool_calls !== false) {
    fail('OpenAI API unexpectedly enabled parallel tool calls.', usage);
  }
  if (value.truncation !== undefined && value.truncation !== 'disabled') {
    fail('OpenAI API unexpectedly changed truncation semantics.', usage);
  }
}

function validateReasoningItem(item: Record<string, unknown>, usage: UsageRecord): void {
  if (typeof item.id !== 'string' || item.id.trim() === '') {
    fail('OpenAI API returned invalid reasoning output.', usage);
  }
  if (item.summary !== undefined && !Array.isArray(item.summary)) {
    fail('OpenAI API returned invalid reasoning summary metadata.', usage);
  }
}

function parseAssistantMessage(item: Record<string, unknown>, usage: UsageRecord): string {
  if (
    typeof item.id !== 'string'
    || item.id.trim() === ''
    || item.status !== 'completed'
    || item.role !== 'assistant'
    || !Array.isArray(item.content)
  ) fail('OpenAI API returned an invalid assistant message.', usage);
  const text: string[] = [];
  for (const content of item.content) {
    if (!isRecord(content) || typeof content.type !== 'string') {
      fail('OpenAI API returned invalid assistant content.', usage);
    }
    if (content.type === 'output_text') {
      if (typeof content.text !== 'string') {
        fail('OpenAI API returned invalid output text.', usage);
      }
      text.push(content.text);
    } else if (content.type === 'refusal') {
      fail('OpenAI API completed with a refusal instead of assistant text.', usage);
    } else {
      fail('OpenAI API returned unsupported assistant content.', usage);
    }
  }
  const output = text.join('');
  if (output.trim() === '') fail('OpenAI API completed without assistant text.', usage);
  return output;
}

export function parseOpenAIApiResponse(
  value: JsonValue,
  requestedEffort?: string,
): ParsedOpenAIApiResponse {
  if (
    !isRecord(value)
    || value.object !== 'response'
    || typeof value.model !== 'string'
    || value.model.trim() === ''
    || typeof value.status !== 'string'
    || value.status.trim() === ''
    || !Array.isArray(value.output)
  ) fail('OpenAI API returned an invalid Response envelope.');

  const serviceTier = optionalNonEmptyString(value.service_tier, 'service tier');
  const effectiveEffort = parseEffectiveEffort(value.reasoning, requestedEffort);
  const usage = parseUsage(
    value.usage,
    value.model,
    value.status,
    serviceTier,
    effectiveEffort,
  );
  if (
    requestedEffort !== undefined
    && effectiveEffort !== undefined
    && effectiveEffort !== requestedEffort
  ) fail('OpenAI API changed the requested reasoning effort.', usage);
  validateStatelessEnvelope(value, usage);
  if (value.error !== undefined && value.error !== null) {
    fail(
      'OpenAI API response failed.',
      usage,
      'OMK_OPENAI_API_RESPONSE_FAILED',
    );
  }
  if (value.status === 'incomplete') {
    fail(
      'OpenAI API response was incomplete.',
      usage,
      'OMK_OPENAI_API_RESPONSE_INCOMPLETE',
    );
  }
  if (value.status !== 'completed') {
    fail(
      'OpenAI API response did not complete.',
      usage,
      'OMK_OPENAI_API_RESPONSE_FAILED',
    );
  }

  let output: string | undefined;
  for (const item of value.output) {
    if (!isRecord(item) || typeof item.type !== 'string' || item.type.trim() === '') {
      fail('OpenAI API returned an invalid output item.', usage);
    }
    if (item.type === 'reasoning') {
      validateReasoningItem(item, usage);
    } else if (item.type === 'message') {
      if (output !== undefined) {
        fail('OpenAI API returned multiple assistant messages.', usage);
      }
      output = parseAssistantMessage(item, usage);
    } else {
      fail('OpenAI API returned an unsupported output item.', usage);
    }
  }
  if (output === undefined) fail('OpenAI API completed without an assistant message.', usage);
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
