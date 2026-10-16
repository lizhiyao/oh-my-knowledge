import type { CaptureRuntime } from './entity-capture-provider.js';

/** The fixed built runtime owns budget facts. No cross-root source import or copied profile literal. */
export function captureBudgetProfile(runtime: Pick<CaptureRuntime,
  'OPENAI_TOKEN_BUDGET_EVIDENCE' | 'OPENAI_TOKEN_BUDGET_EVIDENCE_DIGEST' | 'resolveTokenBudgetProfile'>) {
  return {
    OPENAI_CAPTURE_BUDGET_EVIDENCE: runtime.OPENAI_TOKEN_BUDGET_EVIDENCE,
    OPENAI_CAPTURE_BUDGET_EVIDENCE_DIGEST: runtime.OPENAI_TOKEN_BUDGET_EVIDENCE_DIGEST,
    resolveCaptureBudgetProfile: runtime.resolveTokenBudgetProfile,
  };
}
