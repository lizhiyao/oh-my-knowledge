import { deepFreezeCanonicalJson, type JsonValue } from '../../../../eval-core/contracts/index.js';
import type { SampleInput } from '../../../inputs/contracts/sample-input.js';
import { SampleInputSchema } from '../../../inputs/schemas/sample-input.js';

/** The supported intersection is a next-answer conversation, without tool execution or prefill. */
export const STATELESS_API_SAMPLE_INPUT_POLICY = deepFreezeCanonicalJson({
  policyVersion: 'omk.stateless-api-sample-input/v1',
  inputKinds: ['text', 'json', 'messages'],
  history: { contextSchemaVersion: 'omk.stateless-api-history-context/v1', system: 'prefix', firstRole: 'user', lastRole: 'user',
    conversationRoles: 'alternating-user-assistant', toolCalls: 'unsupported', emptyContent: 'unsupported' },
});

/** Raw Core JSON remains data; inputKind explicitly opts into the authored input contract. */
export function parseStatelessApiSampleInput(value: JsonValue): SampleInput | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !Object.hasOwn(value, 'inputKind')) return undefined;
  const parsed = SampleInputSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('Invalid authored input; check the v3 sample input contract.');
  const input = parsed.data;
  if (input.inputKind === 'messages') {
    let nextRole = 'user';
    let conversationCount = 0;
    for (const message of input.messages) {
      if (message.role === 'tool' || (message.role === 'assistant' && message.toolCalls !== undefined)) {
        throw new TypeError('API sample history does not support tool calls/results; use custom-executor.');
      }
      if (message.content.trim() === '') throw new TypeError('API sample history requires non-empty message content.');
      if (message.role === 'system') continue;
      if (message.role !== nextRole) throw new TypeError('API sample history must alternate user/assistant roles, starting with user.');
      conversationCount += 1;
      nextRole = nextRole === 'user' ? 'assistant' : 'user';
    }
    if (conversationCount === 0 || nextRole !== 'assistant') {
      throw new TypeError('API sample history must end with a user message; assistant prefill is unsupported.');
    }
  }
  return input;
}
