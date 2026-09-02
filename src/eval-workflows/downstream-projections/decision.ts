import type {
  DecisionResult,
  SeriesDecisionResult,
} from '../../eval-core/contracts/index.js';
import type { CoreDecisionProjection } from './contracts.js';

/** Keeps all downstream views on one exact Decision status projection. */
export function projectCoreDecision(
  value: Readonly<DecisionResult | SeriesDecisionResult> | undefined,
): CoreDecisionProjection | undefined {
  if (value === undefined) return undefined;
  const base = {
    decisionPolicyId: value.decisionPolicyId,
    decisionDigest: value.decisionDigest,
  };
  if (value.decisionStatus === 'decided') return {
    ...base,
    decisionStatus: value.decisionStatus,
    verdict: value.verdict,
    reasonCodes: [...value.reasonCodes],
  };
  if (value.decisionStatus === 'not-decided') return {
    ...base,
    decisionStatus: value.decisionStatus,
    reasonCodes: [...value.reasonCodes],
  };
  return {
    ...base,
    decisionStatus: value.decisionStatus,
    errorCode: value.error.code,
  };
}
