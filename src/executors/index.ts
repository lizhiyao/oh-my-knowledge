import type { ExecutorFn } from '../types/index.js';
import { anthropicApiExecutor } from './anthropic-api.js';
import { claudeCliExecutor } from './claude-cli.js';
import { claudeSdkExecutor } from './claude-sdk.js';
import { extractAgentTrace } from './claude-sdk-trace.js';
import { codexCliExecutor } from './codex-cli.js';
import { geminiExecutor } from './gemini.js';
import { openAiApiExecutor } from './openai-api.js';
import { createScriptExecutor } from './script.js';
import { DEFAULT_MODEL, JUDGE_MODEL } from './shared.js';

// 'openai' 跟 'openai-api' 都指向 HTTP API 实现:两者历史上职责重复(都走
// chat.completions.create + 同一份 schema),'openai' 之前经外部 `openai` Python CLI binary
// 多一层启动 + parse 子进程 stdout,API key 读法跟 openai-api 一致,没有独有便利。
// 'openai' 名字保留为 alias,旧用户 `--executor openai` 仍工作 — 行为静默切到 HTTP,
// token 统计 / output schema 完全一致,verdict / Δ 跨版本可比。
const EXECUTOR_REGISTRY: Record<string, ExecutorFn> = {
  claude: claudeCliExecutor,
  'claude-sdk': claudeSdkExecutor,
  codex: codexCliExecutor,
  openai: openAiApiExecutor,
  gemini: geminiExecutor,
  'anthropic-api': anthropicApiExecutor,
  'openai-api': openAiApiExecutor,
};

export { DEFAULT_MODEL, JUDGE_MODEL, extractAgentTrace, createScriptExecutor };

export function createExecutor(name: string = 'claude'): ExecutorFn {
  return EXECUTOR_REGISTRY[name] || createScriptExecutor(name);
}
