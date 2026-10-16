import type { ExecutorFn, ExecutorInput } from './ports.js';

/** Trusted concrete producer proof; delivery code supplies its implementation. */
export interface ExecutorArchiveEvidence {
  producerId: string;
  producerRevision: string;
  sourceChannels: Array<{ channel: string; maxBytes: number }>;
  maxOutcomeJsonBytes: number;
  proof: unknown;
}
export interface ExecutorArchiveProducer {
  assertCapabilities(executor: string, input: ExecutorInput): void;
  /** Pure local preflight; no executor construction, filesystem or network. */
  inspect(executor: string, input: ExecutorInput): ExecutorArchiveEvidence;
  /** Snapshot configuration and prove the complete returned JSON bound without dispatch.
   * The optional synchronous gate runs after identity checks, immediately before dispatch. */
  configure(executor: string, input: ExecutorInput, beforeDispatch?: () => void): { evidence: ExecutorArchiveEvidence; execute: ExecutorFn };
}
