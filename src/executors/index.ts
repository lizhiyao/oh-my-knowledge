import type { ExecutorFn } from '../types/index.js';
import { anthropicApiExecutor } from './anthropic-api.js';
import { claudeCliExecutor } from './claude-cli.js';
import { claudeSdkExecutor } from './claude-sdk.js';
import { extractAgentTrace } from './claude-sdk-trace.js';
import { codexCliExecutor } from './codex-cli.js';
import { codexSdkExecutor } from './codex-sdk.js';
import { geminiExecutor } from './gemini.js';
import { openAiApiExecutor } from './openai-api.js';
import { createScriptExecutor } from './script.js';
import { DEFAULT_MODEL, JUDGE_MODEL } from './shared.js';

// 命名一致性:provider HTTP 路径统一用 `<vendor>-api`(`anthropic-api` / `openai-api`),
// vendor coding agent CLI 用 vendor 名(`claude` / `codex`)。`openai` 这个不带 -api 后缀的
// 旧 alias 历史上指 openai-cli 子进程实现,删除后不再设别名 — 用 `--executor openai-api`。
const EXECUTOR_REGISTRY: Record<string, ExecutorFn> = {
  claude: claudeCliExecutor,
  'claude-sdk': claudeSdkExecutor,
  codex: codexCliExecutor,
  'codex-sdk': codexSdkExecutor,
  gemini: geminiExecutor,
  'anthropic-api': anthropicApiExecutor,
  'openai-api': openAiApiExecutor,
};

export { DEFAULT_MODEL, JUDGE_MODEL, extractAgentTrace, createScriptExecutor };

export function createExecutor(name: string = 'claude'): ExecutorFn {
  return EXECUTOR_REGISTRY[name] || createScriptExecutor(name);
}
