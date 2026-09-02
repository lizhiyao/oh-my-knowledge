import type {
  CoreCliGateProjection,
  CoreDecisionProjection,
} from './contracts.js';

function releasePassReason(verdict: string): string | undefined {
  if (verdict === 'PROGRESS') return 'release-gates-passed';
  if (verdict === 'SOLO') return 'solo-layer-gate-passed';
  return undefined;
}

/** Keeps exit success coupled to an explicit, stable release-gate reason. */
export function projectCompletedCoreCliGate(
  decision: Readonly<CoreDecisionProjection> | undefined,
): CoreCliGateProjection {
  if (decision === undefined) return {
    gateStatus: 'blocked',
    exitCode: 1,
    reasonCodes: ['core-decision-missing'],
  };
  if (decision.decisionStatus === 'not-decided') return {
    gateStatus: 'blocked',
    exitCode: 1,
    reasonCodes: ['core-decision-not-decided', ...decision.reasonCodes],
  };
  if (decision.decisionStatus === 'failed') return {
    gateStatus: 'blocked',
    exitCode: 1,
    reasonCodes: ['core-decision-failed', decision.errorCode],
  };
  const passReason = releasePassReason(decision.verdict);
  if (passReason !== undefined && decision.reasonCodes.includes(passReason)) return {
    gateStatus: 'passed',
    exitCode: 0,
    reasonCodes: [...decision.reasonCodes],
  };
  return {
    gateStatus: 'blocked',
    exitCode: 1,
    reasonCodes: [
      passReason === undefined
        ? 'core-release-verdict-blocked'
        : 'core-release-gate-not-passed',
      ...decision.reasonCodes,
    ],
  };
}
