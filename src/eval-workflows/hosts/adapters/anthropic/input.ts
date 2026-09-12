import type { JsonValue } from '../../../../eval-core/contracts/json.js';
import type { StatelessApiRunState, StatelessApiTrialState } from '../shared/stateless-api-resources.js';

/** Messages carries system content separately, and user/assistant history in messages. */
export function projectAnthropicApiInput(run: StatelessApiRunState, trial: StatelessApiTrialState): {
  messages: JsonValue[];
  system?: JsonValue;
} {
  if (trial.projectionKind === 'prompt') return {
    messages: [{ role: 'user', content: trial.prompt }],
    ...(run.systemInstructions === undefined ? {} : { system: run.systemInstructions }),
  };
  const system: JsonValue[] = run.systemInstructions === undefined ? [] : [{ type: 'text', text: run.systemInstructions }];
  const messages: JsonValue[] = [];
  let context = trial.context;
  for (const message of trial.messages) {
    if (message.role === 'tool' || (message.role === 'assistant' && message.toolCalls !== undefined)) {
      throw new TypeError('Anthropic API sample history does not support tool calls/results.');
    }
    if (message.role === 'system') {
      system.push({ type: 'text', text: message.content });
      continue;
    }
    const content = [
      ...(message.role === 'user' && context !== undefined ? [{ type: 'text', text: context }] : []),
      { type: 'text', text: message.content },
    ];
    if (message.role === 'user') context = undefined;
    messages.push({ role: message.role, content });
  }
  return { messages, ...(system.length === 0 ? {} : { system }) };
}
