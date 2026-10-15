import type { ExecutorFn } from './contracts/ports.js';
import { openAiApiExecutor } from './openai/api.js';
import { codexCliExecutor } from './openai/codex/cli.js';
import { codexSdkExecutor } from './openai/codex/sdk.js';
import { createScriptExecutor } from './script/index.js';
import { enforceExecutorCapabilities } from './core/capabilities.js';
import {
  getExecutorDescriptor,
  isRemovedBuiltinExecutor,
  type ExecutableExecutorName,
} from './core/registry.js';
import { assertOptionalExecutorDependency } from './core/optional-dependencies.js';

const EXECUTOR_FACTORIES = {
  codex: codexCliExecutor,
  'codex-sdk': codexSdkExecutor,
  'openai-api': openAiApiExecutor,
} satisfies Record<ExecutableExecutorName, ExecutorFn>;

export { createScriptExecutor };
export {
  assertExecutorInputCapabilities,
  executorSupportsSampleMocks,
  getExecutorCapabilities,
} from './core/capabilities.js';

export function createExecutor(name: string): ExecutorFn {
  if (name.trim().length === 0) {
    throw new Error('executor name or script command is required');
  }
  if (isRemovedBuiltinExecutor(name)) {
    throw new Error(
      `内置 ${name} 执行器已移除；请改用 codex、codex-sdk、openai-api 或自定义执行器文件路径。`,
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
