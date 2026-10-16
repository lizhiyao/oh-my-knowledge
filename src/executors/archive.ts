import type { ExecutorArchiveProducer } from './contracts/archive.js';
import { createOpenAiArchiveProducer } from './openai/archive.js';
import { createCodexArchiveProducer } from './openai/codex/archive.js';

/** Concrete producer selection is a delivery concern; no fallback between executors. */
export function createExtractionArchiveProducer(environment: NodeJS.ProcessEnv): ExecutorArchiveProducer {
  const api = createOpenAiArchiveProducer(environment), codex = createCodexArchiveProducer(environment);
  const select = (executor: string) => {
    if (executor === 'openai-api') return api;
    if (executor === 'codex') return codex;
    throw new Error('Unsupported knowledge-generation archive producer.');
  };
  return {
    assertCapabilities: (executor, input) => select(executor).assertCapabilities(executor, input),
    inspect: (executor, input) => select(executor).inspect(executor, input),
    configure: (executor, input) => select(executor).configure(executor, input),
  };
}
