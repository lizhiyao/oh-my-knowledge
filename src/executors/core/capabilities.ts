import type { ExecutorFn, ExecutorInput } from '../contracts/ports.js';
import type { ExecutorFailure } from '../contracts/result.js';
import { createExecutorDiagnosticRedactor } from './diagnostics.js';
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
    outputFormats: executorName === 'openai-api' ? ['json-schema', 'json-object', 'prompt-json']
      : executorName === 'codex' ? ['json-schema', 'prompt-json'] : [],
    maxOutputTokens: executorName === 'openai-api',
  };
}

export class ExecutorCapabilityError extends Error {
  readonly failure: ExecutorFailure = { failureKind: 'unsupported_output' };
}

export function executorSupportsSampleMocks(executorName: string): boolean {
  return getExecutorCapabilities(executorName).sampleMocks !== 'unsupported';
}

function unsupportedMocksMessage(executorName: string): string {
  return `执行器「${executorName}」不支持 Sample.mocks 工具拦截。`
    + `继续运行会让 mock_hit 在结构上必然失败并产生伪证据。`
    + '受影响用例：<programmatic-input>。'
    + '请用「omk sample --no-mock」重新生成、删除 mocks/mock_hit，'
    + '或使用实现 mock 协议的自定义执行器评测。';
}

export function assertExecutorInputCapabilities(
  executorName: string,
  input: ExecutorInput,
): void {
  const capabilities = getExecutorCapabilities(executorName);
  if (input.outputFormat !== undefined) {
    const format = input.outputFormat;
    if (!capabilities.outputFormats.includes(format.mode)) {
      throw new ExecutorCapabilityError(`执行器「${executorName}」不支持输出模式「${format.mode}」。`);
    }
    if (format.mode === 'json-schema' && (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(format.name)
      || !format.schema || typeof format.schema !== 'object' || Array.isArray(format.schema)
    )) throw new TypeError('Structured output requires a valid name and JSON Schema object.');
  }
  if (input.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
      throw new TypeError('maxOutputTokens must be a positive safe integer.');
    }
    if (!capabilities.maxOutputTokens) {
      throw new ExecutorCapabilityError(`执行器「${executorName}」不支持 maxOutputTokens 输出上限。`);
    }
  }
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
  environment: NodeJS.ProcessEnv = process.env,
): ExecutorFn {
  return async (input) => {
    const redact = createExecutorDiagnosticRedactor(environment);
    assertExecutorInputCapabilities(executorName, input);
    const result = await executor(input);
    return typeof result.error === 'string' ? { ...result, error: redact(result.error) } : result;
  };
}
