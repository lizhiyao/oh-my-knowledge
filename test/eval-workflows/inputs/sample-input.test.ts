import { describe, expect, it } from 'vitest';
import { SampleInputSchema } from '../../../src/eval-workflows/inputs/schemas/sample-input.js';

const history = {
  inputKind: 'messages', interactionMode: 'history', messages: [
    { messageId: 'u1', role: 'user', content: 'Check stock.' },
    { messageId: 'a1', role: 'assistant', content: '', toolCalls: [
      { toolCallId: 'call-1', name: 'stock', arguments: { sku: 'red' } },
      { toolCallId: 'call-2', name: 'stock', arguments: { sku: 'blue' } },
    ] },
    { messageId: 't2', role: 'tool', toolCallId: 'call-2', content: '0' },
    { messageId: 't1', role: 'tool', toolCallId: 'call-1', content: '3' },
    { messageId: 'u2', role: 'user', content: 'Use red.' },
  ],
};

describe('sample input contract', () => {
  it('preserves text bytes and complete tool-correlated history', () => {
    const input = { inputKind: 'text', text: '  Q\r\nC\n  ' };
    expect(SampleInputSchema.parse(input)).toEqual(input);
    expect(SampleInputSchema.parse(history)).toEqual(history);
  });

  it.each([
    ['orphan result', [history.messages[2]]],
    ['unfinished call', history.messages.slice(0, 2)],
    ['duplicate result', [...history.messages.slice(0, 4), history.messages[2]]],
    ['interrupted calls', [...history.messages.slice(0, 2), history.messages[4]]],
    ['late system', [history.messages[0], { messageId: 's1', role: 'system', content: 'late' }]],
    ['duplicate message', [history.messages[0], history.messages[0]]],
  ])('rejects %s', (_name, messages) => {
    expect(SampleInputSchema.safeParse({ ...history, messages }).success).toBe(false);
  });

  it('preserves identity bytes and rejects duplicate tool-call identities', () => {
    const duplicate = structuredClone(history);
    duplicate.messages[1].toolCalls![1].toolCallId = 'call-1';
    expect(SampleInputSchema.safeParse(duplicate).success).toBe(false);
    const spaced = { inputKind: 'messages', interactionMode: 'history', messages: [
      { messageId: ' user-1 ', role: 'user', content: 'Q' },
    ] };
    expect(SampleInputSchema.parse(spaced)).toEqual(spaced);
  });

  it.each([
    { prompt: 'legacy' },
    { inputKind: 'messages', interactionMode: 'interactive', messages: history.messages },
    { inputKind: 'json', value: { x: true } },
    { inputKind: 'text', text: 'Q', expected: 'gold' },
  ])('rejects unsupported or ambiguous inputs', (input) => {
    expect(SampleInputSchema.safeParse(input).success).toBe(false);
  });
});
