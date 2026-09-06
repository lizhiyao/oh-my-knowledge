import type { ExecutorFn, ExecutorInput } from '../contracts/ports.js';
import {
  getExecutorDescriptor,
  type ExecutorCapabilities,
} from './registry.js';

export type { ExecutorCapabilities, SampleMockSupport } from './registry.js';

/**
 * Custom script executors receive the OMK_MOCK_* protocol environment and own
 * the final adapter. Built-ins are explicit so unsupported runtimes can never
 * silently turn mock assertions into model failures.
 */
export function getExecutorCapabilities(executorName: string): ExecutorCapabilities {
  return {
    sampleMocks: getExecutorDescriptor(executorName)?.sampleMocks ?? 'delegated-script',
  };
}

export function executorSupportsSampleMocks(executorName: string): boolean {
  return getExecutorCapabilities(executorName).sampleMocks !== 'unsupported';
}

function unsupportedMocksMessage(executorName: string): string {
  return `执行器「${executorName}」不支持 Sample.mocks 工具拦截。`
    + `继续运行会让 mock_hit 在结构上必然失败并产生伪证据。`
    + '受影响用例：<programmatic-input>。'
    + '请用「omk sample --no-mock」重新生成、删除 mocks/mock_hit，'
    + '或改用 claude/claude-sdk 评测。';
}

export function assertExecutorInputCapabilities(
  executorName: string,
  input: ExecutorInput,
): void {
  if (
    executorSupportsSampleMocks(executorName)
    || !Array.isArray(input.mocks)
    || input.mocks.length === 0
  ) return;
  throw new Error(unsupportedMocksMessage(executorName));
}

export function enforceExecutorCapabilities(
  executorName: string,
  executor: ExecutorFn,
): ExecutorFn {
  return async (input) => {
    assertExecutorInputCapabilities(executorName, input);
    return executor(input);
  };
}
