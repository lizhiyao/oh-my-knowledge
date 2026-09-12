import type { JsonValue } from '../../../../eval-core/contracts/json.js';
import type { StatelessApiRunState, StatelessApiTrialState } from '../shared/stateless-api-resources.js';

/** Responses accepts system/user/assistant history as native input messages. */
export function projectOpenAIApiInput(run: StatelessApiRunState, trial: StatelessApiTrialState): {
  input: JsonValue;
  instructions?: string;
} {
  const instructions = run.systemInstructions === undefined ? {} : { instructions: run.systemInstructions };
  if (trial.projectionKind === 'prompt') return { input: trial.prompt, ...instructions };
  let context = trial.context;
  const input = trial.messages.map((message): JsonValue => {
    if (message.role === 'tool' || (message.role === 'assistant' && message.toolCalls !== undefined)) {
      throw new TypeError('OpenAI API sample history does not support tool calls/results.');
    }
    const content = message.role === 'user' && context !== undefined
      ? [{ type: 'input_text', text: context }, { type: 'input_text', text: message.content }]
      : message.content;
    if (message.role === 'user') context = undefined;
    return { role: message.role, content };
  });
  return { input, ...instructions };
}
