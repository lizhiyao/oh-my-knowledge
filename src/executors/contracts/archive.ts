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
  /** Must not dispatch; snapshot configuration and prove the complete returned JSON bound. */
  configure(executor: string, input: ExecutorInput): { evidence: ExecutorArchiveEvidence; execute: ExecutorFn };
}
