import type { SampleInput, SampleMessage } from '../contracts/sample-input.js';
import { z } from 'zod';
import _Ajv2020 from 'ajv/dist/2020.js';
import { JsonValueSchema, SchemaIdentitySchema, digestCanonicalJson } from '../../../eval-core/contracts/index.js';

const IdSchema = z.string().min(1).max(256).refine((value) => value.trim().length > 0, {
  message: 'Identifier must not be blank.',
});

const ToolCallSchema = z.object({
  toolCallId: IdSchema,
  name: IdSchema,
  arguments: z.record(z.string(), JsonValueSchema),
}).strict();

export const SampleMessageSchema: z.ZodType<SampleMessage> = z.discriminatedUnion('role', [
  z.object({ messageId: IdSchema, role: z.literal('system'), content: z.string() }).strict(),
  z.object({ messageId: IdSchema, role: z.literal('user'), content: z.string() }).strict(),
  z.object({
    messageId: IdSchema,
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z.array(ToolCallSchema).min(1).optional(),
  }).strict(),
  z.object({
    messageId: IdSchema,
    role: z.literal('tool'),
    toolCallId: IdSchema,
    content: z.string(),
  }).strict(),
]);

const MessagesSchema = z.array(SampleMessageSchema).min(1).superRefine((messages, context) => {
  const messageIds = new Set<string>();
  const callIds = new Set<string>();
  const outstanding = new Set<string>();
  let conversationStarted = false;
  for (const [index, message] of messages.entries()) {
    const issue = (field: string, message: string) => context.addIssue({
      code: 'custom', path: [index, field], message,
    });
    if (messageIds.has(message.messageId)) issue('messageId', 'Duplicate messageId.');
    messageIds.add(message.messageId);
    if (message.role === 'system') {
      if (conversationStarted) issue('role', 'System messages must precede conversation messages.');
    } else conversationStarted = true;
    if (message.role === 'tool') {
      if (!outstanding.delete(message.toolCallId)) {
        issue('toolCallId', 'Tool result must reference an outstanding earlier call.');
      }
      continue;
    }
    if (outstanding.size > 0) issue('role', 'Tool calls must receive results before the next message.');
    if (message.role === 'assistant') {
      for (const [callIndex, call] of (message.toolCalls ?? []).entries()) {
        if (callIds.has(call.toolCallId)) context.addIssue({
          code: 'custom', path: [index, 'toolCalls', callIndex, 'toolCallId'], message: 'Duplicate toolCallId.',
        });
        callIds.add(call.toolCallId);
        outstanding.add(call.toolCallId);
      }
    }
  }
  if (outstanding.size > 0) context.addIssue({
    code: 'custom', message: 'History contains tool calls without results.',
  });
});

const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const JsonInputSchema = z.object({
  inputKind: z.literal('json'),
  value: JsonValueSchema,
  schema: SchemaIdentitySchema,
  schemaDocument: z.record(z.string(), JsonValueSchema),
}).strict().superRefine((input, context) => {
  try {
    if (input.schema.schemaDigest !== digestCanonicalJson(input.schemaDocument)
        || input.schemaDocument.$id !== input.schema.schemaUri) {
      context.addIssue({ code: 'custom', path: ['schema'], message: 'Schema identity must match the embedded schema document.' });
      return;
    }
    // No coercion, defaults, property removal, remote loading or shared mutable registry.
    const validate = new Ajv2020({ strict: true, allErrors: false }).compile(input.schemaDocument);
    if (!validate(input.value)) context.addIssue({ code: 'custom', path: ['value'],
      message: `Input does not satisfy its schema: ${validate.errors?.[0]?.instancePath ?? ''} ${validate.errors?.[0]?.message ?? ''}` });
  } catch {
    context.addIssue({ code: 'custom', path: ['schemaDocument'], message: 'Invalid or unsupported self-contained JSON Schema 2020-12.' });
  }
});

/** Authoring input only. References and grading instructions belong outside this union. */
export const SampleInputSchema: z.ZodType<SampleInput> = z.discriminatedUnion('inputKind', [
  z.object({ inputKind: z.literal('text'), text: z.string().min(1) }).strict(),
  JsonInputSchema,
  z.object({
    inputKind: z.literal('messages'),
    interactionMode: z.literal('history'),
    messages: MessagesSchema,
  }).strict(),
]);

export type { SampleInput, SampleMessage };
