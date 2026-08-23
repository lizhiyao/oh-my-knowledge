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
import { enforceExecutorCapabilities } from './capabilities.js';
import {
  getExecutorDescriptor,
  type ExecutableExecutorName,
} from './registry.js';

// 命名一致性:provider HTTP 路径统一用 `<vendor>-api`(`anthropic-api` / `openai-api`),
// vendor coding agent CLI 用 vendor 名(`claude` / `codex`)。`openai` 这个不带 -api 后缀的
// 旧 alias 历史上指 openai-cli 子进程实现,删除后不再设别名 — 用 `--executor openai-api`。
const EXECUTOR_FACTORIES = {
  claude: claudeCliExecutor,
  'claude-sdk': claudeSdkExecutor,
  codex: codexCliExecutor,
  'codex-sdk': codexSdkExecutor,
  gemini: geminiExecutor,
  'anthropic-api': anthropicApiExecutor,
  'openai-api': openAiApiExecutor,
} satisfies Record<ExecutableExecutorName, ExecutorFn>;

export { extractAgentTrace, createScriptExecutor };
export {
  assertExecutorInputCapabilities,
  assertSamplesCompatibleWithExecutor,
  executorSupportsSampleMocks,
  getExecutorCapabilities,
} from './capabilities.js';

export function createExecutor(name: string): ExecutorFn {
  if (name.trim().length === 0) {
    throw new Error('executor name or script command is required');
  }
  const descriptor = getExecutorDescriptor(name);
  if (descriptor?.execution === 'host-only') {
    throw new Error('dsh-host 仅供 DeepSeek Harness 宿主插件内部使用；请在 DSH 中运行 /omk eval。');
  }
  const executor = descriptor
    ? EXECUTOR_FACTORIES[descriptor.name]
    : createScriptExecutor(name);
  return enforceExecutorCapabilities(name, executor);
}
