import type { ExecutionStrategyKind, ExecutorInput, Task } from './types.js';

export interface ExecutionPlan {
  strategy: ExecutionStrategyKind;
  cacheSystem: string;
  input: ExecutorInput;
}

function combineUserPrompt(prefix: string | null, prompt: string): string {
  if (!prefix) return prompt;
  return `${prefix}\n\n${prompt}`;
}

export function resolveExecutionStrategy(task: Task, model: string, timeoutMs?: number, verbose?: boolean): ExecutionPlan {
  const baseInput = {
    model,
    cwd: task.cwd,
    timeoutMs,
    verbose,
  };

  switch (task.evaluand.kind) {
    case 'baseline':
      return {
        strategy: 'baseline',
        cacheSystem: '',
        input: {
          ...baseInput,
          system: null,
          prompt: task.prompt,
        },
      };
    case 'prompt':
      return {
        strategy: 'user-prompt',
        cacheSystem: '',
        input: {
          ...baseInput,
          system: null,
          prompt: combineUserPrompt(task.evaluand.content, task.prompt),
        },
      };
    case 'agent':
      return {
        strategy: 'agent-session',
        cacheSystem: task.evaluand.content ?? '',
        input: {
          ...baseInput,
          system: task.evaluand.content,
          prompt: task.prompt,
        },
      };
    case 'workflow':
      return {
        strategy: 'workflow-session',
        cacheSystem: task.evaluand.content ?? '',
        input: {
          ...baseInput,
          system: task.evaluand.content,
          prompt: task.prompt,
        },
      };
    case 'skill':
    default:
      return {
        strategy: 'system-prompt',
        cacheSystem: task.evaluand.content ?? '',
        input: {
          ...baseInput,
          system: task.evaluand.content,
          prompt: task.prompt,
        },
      };
  }
}
