import type { JsonValue } from '../../../eval-core/contracts/json.js';
import type { SchemaIdentity } from '../../../eval-core/contracts/common.js';

export interface SampleToolCall {
  toolCallId: string;
  name: string;
  arguments: Record<string, JsonValue>;
}
export type SampleMessage =
  | { messageId: string; role: 'system' | 'user'; content: string }
  | { messageId: string; role: 'assistant'; content: string; toolCalls?: SampleToolCall[] }
  | { messageId: string; role: 'tool'; toolCallId: string; content: string };

export type SampleInput =
  | { inputKind: 'text'; text: string }
  | { inputKind: 'json'; value: JsonValue; schema: SchemaIdentity; schemaDocument: Record<string, JsonValue> }
  | { inputKind: 'messages'; interactionMode: 'history'; messages: SampleMessage[] };
