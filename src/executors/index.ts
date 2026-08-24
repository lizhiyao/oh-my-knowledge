import type { ExecutorFn } from '../types/index.js';
import { anthropicApiExecutor } from './anthropic/api.js';
import { claudeCliExecutor } from './anthropic/claude/cli.js';
import { claudeSdkExecutor } from './anthropic/claude/sdk.js';
import { extractClaudeTrace } from './anthropic/claude/trace.js';
import { openAiApiExecutor } from './openai/api.js';
import { codexCliExecutor } from './openai/codex/cli.js';
import { codexSdkExecutor } from './openai/codex/sdk.js';
import { createScriptExecutor } from './script/index.js';
import { enforceExecutorCapabilities } from './core/capabilities.js';
import {
  getExecutorDescriptor,
  type ExecutableExecutorName,
} from './core/registry.js';
import { assertOptionalExecutorDependency } from './core/optional-dependencies.js';

// 命名一致性:provider HTTP 路径统一用 `<vendor>-api`(`anthropic-api` / `openai-api`),
// vendor coding agent CLI 用 vendor 名(`claude` / `codex`)。`openai` 这个不带 -api 后缀的
// 旧 alias 历史上指 openai-cli 子进程实现,删除后不再设别名 — 用 `--executor openai-api`。
const EXECUTOR_FACTORIES = {
  claude: claudeCliExecutor,
  'claude-sdk': claudeSdkExecutor,
  codex: codexCliExecutor,
  'codex-sdk': codexSdkExecutor,
  'anthropic-api': anthropicApiExecutor,
  'openai-api': openAiApiExecutor,
} satisfies Record<ExecutableExecutorName, ExecutorFn>;

export { extractClaudeTrace, createScriptExecutor };
export {
  assertExecutorInputCapabilities,
  assertSamplesCompatibleWithExecutor,
  executorSupportsSampleMocks,
  getExecutorCapabilities,
} from './core/capabilities.js';

export function createExecutor(name: string): ExecutorFn {
  if (name.trim().length === 0) {
    throw new Error('executor name or script command is required');
  }
  if (name === 'gemini') {
    throw new Error(
      '内置 gemini 执行器已移除；请改用自定义执行器适配脚本，并显式填写脚本命令。',
    );
  }
  const descriptor = getExecutorDescriptor(name);
  if (descriptor?.execution === 'host-only') {
    throw new Error('dsh-host 仅供 DeepSeek Harness 宿主插件内部使用；请在 DSH 中运行 /omk eval。');
  }
  if (descriptor) assertOptionalExecutorDependency(descriptor.name);
  const executor = descriptor
    ? EXECUTOR_FACTORIES[descriptor.name]
    : createScriptExecutor(name);
  return enforceExecutorCapabilities(name, executor);
}
