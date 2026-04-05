import type { ExecutorFn } from './types.js';
import { anthropicApiExecutor } from './executors/anthropic-api.js';
import { claudeCliExecutor } from './executors/claude-cli.js';
import { claudeSdkExecutor } from './executors/claude-sdk.js';
import { extractAgentTrace } from './executors/claude-sdk-trace.js';
import { geminiExecutor } from './executors/gemini.js';
import { openAiApiExecutor } from './executors/openai-api.js';
import { openAiCliExecutor } from './executors/openai-cli.js';
import { createScriptExecutor } from './executors/script.js';
import { DEFAULT_MODEL, JUDGE_MODEL } from './executors/shared.js';

const EXECUTOR_REGISTRY: Record<string, ExecutorFn> = {
  claude: claudeCliExecutor,
  'claude-sdk': claudeSdkExecutor,
  openai: openAiCliExecutor,
  gemini: geminiExecutor,
  'anthropic-api': anthropicApiExecutor,
  'openai-api': openAiApiExecutor,
};

export { DEFAULT_MODEL, JUDGE_MODEL, extractAgentTrace, createScriptExecutor };

export function createExecutor(name: string = 'claude'): ExecutorFn {
  return EXECUTOR_REGISTRY[name] || createScriptExecutor(name);
}
