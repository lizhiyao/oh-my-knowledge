/**
 * Published surface for OMK's official reference Executors: ready-made `Executor` declarations for
 * real vendor runtimes, assembled from plain configuration instead of the private host registry.
 *
 * This entry is the only supported way to consume an adapter from outside this repository. It adds
 * no registry, discovery, download or dynamic loading, and it publishes no smaller capability than
 * the sealed host seam silently: each reference Executor declares the supported surface it verified
 * and fails closed on everything else.
 */
export {
  CODEX_CLI_MIN_SUPPORTED_VERSION,
  CODEX_CLI_REFERENCE_ADAPTER_VERSION,
  DEFAULT_CODEX_CLI_REFERENCE_PROBE_TIMEOUT_MS,
  createCodexCliReferenceExecutor,
  type CreateCodexCliReferenceExecutorInput,
} from './adapters/codex/reference-executor.js';
export type {
  CodexCliContentIdentityFile,
  CodexCliEnvironmentEntry,
} from './adapters/codex/cli.js';
