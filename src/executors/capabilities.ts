import type {
  ExecutorFn,
  ExecutorInput,
  Sample,
} from '../types/index.js';

export type SampleMockSupport =
  | 'native-hooks'
  | 'delegated-script'
  | 'unsupported';

export interface ExecutorCapabilities {
  sampleMocks: SampleMockSupport;
}

const BUILTIN_CAPABILITIES: Readonly<Record<string, ExecutorCapabilities>> = {
  claude: { sampleMocks: 'native-hooks' },
  'claude-sdk': { sampleMocks: 'native-hooks' },
  codex: { sampleMocks: 'unsupported' },
  'codex-sdk': { sampleMocks: 'unsupported' },
  dsh: { sampleMocks: 'unsupported' },
  'dsh-host': { sampleMocks: 'unsupported' },
  gemini: { sampleMocks: 'unsupported' },
  'anthropic-api': { sampleMocks: 'unsupported' },
  'openai-api': { sampleMocks: 'unsupported' },
};

/**
 * Custom script executors receive the OMK_MOCK_* protocol environment and own
 * the final adapter. Built-ins are explicit so unsupported runtimes can never
 * silently turn mock assertions into model failures.
 */
export function getExecutorCapabilities(executorName: string): ExecutorCapabilities {
  return BUILTIN_CAPABILITIES[executorName]
    ?? { sampleMocks: 'delegated-script' };
}

export function executorSupportsSampleMocks(executorName: string): boolean {
  return getExecutorCapabilities(executorName).sampleMocks !== 'unsupported';
}

function unsupportedMocksMessage(
  executorName: string,
  sampleIds: string[],
  lang: 'zh' | 'en',
): string {
  const ids = sampleIds.slice(0, 8).join(', ');
  const overflow = sampleIds.length > 8
    ? lang === 'zh'
      ? ` 等 ${sampleIds.length} 条`
      : ` and ${sampleIds.length - 8} more`
    : '';
  if (lang === 'en') {
    return `Executor "${executorName}" does not support Sample.mocks tool interception. `
      + `Continuing would make mock_hit assertions structurally impossible and create false evidence. `
      + `Affected samples: ${ids}${overflow}. `
      + 'Regenerate them with "omk sample --no-mock", remove mocks/mock_hit, '
      + 'or evaluate with claude/claude-sdk.';
  }
  return `执行器「${executorName}」不支持 Sample.mocks 工具拦截。`
    + `继续运行会让 mock_hit 在结构上必然失败并产生伪证据。`
    + `受影响用例：${ids}${overflow}。`
    + '请用「omk sample --no-mock」重新生成、删除 mocks/mock_hit，'
    + '或改用 claude/claude-sdk 评测。';
}

export function assertSamplesCompatibleWithExecutor(
  samples: Sample[],
  executorName: string,
  lang: 'zh' | 'en' = 'zh',
): void {
  if (executorSupportsSampleMocks(executorName)) return;
  const affected = samples
    .filter((sample) => Array.isArray(sample.mocks) && sample.mocks.length > 0)
    .map((sample) => sample.sample_id);
  if (affected.length === 0) return;
  throw new Error(unsupportedMocksMessage(executorName, affected, lang));
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
  throw new Error(unsupportedMocksMessage(executorName, ['<programmatic-input>'], 'zh'));
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
