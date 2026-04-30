import type { ExecutorFn } from '../types/index.js';
import { anthropicApiExecutor } from './anthropic-api.js';
import { claudeCliExecutor } from './claude-cli.js';
import { claudeSdkExecutor } from './claude-sdk.js';
import { extractAgentTrace } from './claude-sdk-trace.js';
import { codexCliExecutor } from './codex-cli.js';
import { geminiExecutor } from './gemini.js';
import { openAiApiExecutor } from './openai-api.js';
import { openAiCliExecutor } from './openai-cli.js';
import { createScriptExecutor } from './script.js';
import { DEFAULT_MODEL, JUDGE_MODEL } from './shared.js';

const EXECUTOR_REGISTRY: Record<string, ExecutorFn> = {
  claude: claudeCliExecutor,
  'claude-sdk': claudeSdkExecutor,
  codex: codexCliExecutor,
  openai: openAiCliExecutor,
  gemini: geminiExecutor,
  'anthropic-api': anthropicApiExecutor,
  'openai-api': openAiApiExecutor,
};

export { DEFAULT_MODEL, JUDGE_MODEL, extractAgentTrace, createScriptExecutor };

export function createExecutor(name: string = 'claude'): ExecutorFn {
  return EXECUTOR_REGISTRY[name] || createScriptExecutor(name);
}
