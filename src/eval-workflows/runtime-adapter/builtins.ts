import {
  createBuiltinAnalysisNodes,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
} from '../../evaluation-core/analysis/index.js';
import type { OmkRuntimeBindingFactories } from './types.js';

export type OmkBuiltinAnalysisBindingFactories = Pick<
  OmkRuntimeBindingFactories,
  | 'analysisNodesByImplementationId'
  | 'missingPoliciesByImplementationId'
  | 'decisionPoliciesByImplementationId'
>;

/** Binds Core-owned analysis implementations without copying their algorithms into the host. */
export function createBuiltinOmkAnalysisBindingFactories(): OmkBuiltinAnalysisBindingFactories {
  const analysisNodes = createBuiltinAnalysisNodes();
  const missingPolicies = createBuiltinMissingPolicies();
  const decisionPolicies = createBuiltinDecisionPolicies();
  return {
    analysisNodesByImplementationId: new Map([...analysisNodes].map(([implementationId, port]) => [
      implementationId,
      () => ({ port, satisfiesVersionConstraint: true }),
    ])),
    missingPoliciesByImplementationId: new Map([...missingPolicies].map(([
      implementationId,
      port,
    ]) => [implementationId, () => ({ port, satisfiesVersionConstraint: true })])),
    decisionPoliciesByImplementationId: new Map([...decisionPolicies].map(([
      implementationId,
      port,
    ]) => [implementationId, () => ({ port, satisfiesVersionConstraint: true })])),
  };
}
