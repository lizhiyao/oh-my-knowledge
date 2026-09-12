import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../../../../../src/eval-core/contracts/index.js';
import { parseStatelessApiSampleInput } from '../../../../../src/eval-workflows/hosts/adapters/shared/sample-input.js';
import { createOpenAIApiCoreSchemaValidators } from '../../../../../src/eval-workflows/hosts/adapters/openai/protocol.js';
import { createAnthropicApiCoreSchemaValidators } from '../../../../../src/eval-workflows/hosts/adapters/anthropic/protocol.js';

const history = (roles: string[]) => ({ inputKind: 'messages', interactionMode: 'history',
  messages: roles.map((role, index) => ({ messageId: String(index), role, content: '  exact bytes\n' })) });

describe('stateless API authored input capability', () => {
  it.each([['system'], ['assistant', 'user'], ['user', 'user'], ['user', 'assistant']])('rejects unsupported conversation: %j', (...roles) => {
    expect(() => parseStatelessApiSampleInput(history(roles))).toThrow();
  });
  it('preserves message content and IDs while validating the supported conversation', () => {
    const input = history(['system', 'system', 'user', 'assistant', 'user']);
    expect(parseStatelessApiSampleInput(input)).toEqual(input);
    expect(() => parseStatelessApiSampleInput({ ...input, messages: [{ messageId: 'u', role: 'user', content: '  ' }] })).toThrow(/non-empty/);
  });
  it('keeps raw Core JSON separate from an explicitly authored input', () => {
    expect(parseStatelessApiSampleInput({ applicationValue: 2 })).toBeUndefined();
    expect(() => parseStatelessApiSampleInput({ inputKind: 'unknown' })).toThrow(/Invalid authored input/);
  });
  it.each([createOpenAIApiCoreSchemaValidators, createAnthropicApiCoreSchemaValidators])('publishes the validating v2 input capability', (validators) => {
    const validator = validators().find((entry) => entry.schema.schemaVersion.includes('-input/'))!;
    expect(validator.schema.schemaVersion).toMatch(/\/v2$/);
    const schemaDocument = { $id: 'urn:test:input', type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false };
    const input = { inputKind: 'json', value: { count: 2 }, schemaDocument,
      schema: { schemaVersion: 'test/v1', schemaUri: schemaDocument.$id, schemaDigest: digestCanonicalJson(schemaDocument) } };
    expect(validator.parse(input)).toEqual(input);
    expect(() => validator.parse({ ...input, value: { count: '2' } })).toThrow(/Invalid authored input/);
    expect(() => validator.parse({ ...input, schema: { ...input.schema, schemaUri: 'urn:other' } })).toThrow();
  });
});
