import {
  createBuiltinAnalysisNodes,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
} from '../../evaluation-core/analysis/index.js';
import { createSameProcessEvaluatorAdapter } from './adapters/same-process.js';
import {
  createOutputAssertionEvaluatorImplementation,
  OUTPUT_ASSERTION_EVALUATOR_IDENTITY,
  OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
} from './evaluators/output-assertions.js';
import type { OmkRuntimeBindingFactories } from './types.js';

export type OmkBuiltinAnalysisBindingFactories = Pick<
  OmkRuntimeBindingFactories,
  | 'analysisNodesByImplementationId'
  | 'missingPoliciesByImplementationId'
  | 'decisionPoliciesByImplementationId'
>;

export type OmkBuiltinScoringBindingFactories = Pick<
  OmkRuntimeBindingFactories,
  'evaluatorsByImplementationId'
>;

/** OMK-owned production Evaluators; provider-backed families land in later #480 slices. */
export function createBuiltinOmkScoringBindingFactories(): OmkBuiltinScoringBindingFactories {
  return {
    evaluatorsByImplementationId: new Map([[
      OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
      (context) => ({
        port: createSameProcessEvaluatorAdapter({
          identity: OUTPUT_ASSERTION_EVALUATOR_IDENTITY,
          sessionIsolationKey: context.sessionIsolationKey,
          resourceLeases: context.resourceLeases,
          implementation: createOutputAssertionEvaluatorImplementation(),
        }),
        satisfiesVersionConstraint: true,
        preflightDeclarations: [
          {
            preflightKind: 'credential',
            preflightDisposition: 'not-required',
            checkId: 'omk-output-assertion-credential',
            reasonCode: 'local-deterministic-evaluator',
          },
          {
            preflightKind: 'connectivity',
            preflightDisposition: 'not-required',
            checkId: 'omk-output-assertion-connectivity',
            reasonCode: 'local-deterministic-evaluator',
          },
        ],
      }),
    ]]),
  };
}

/** Binds Core-owned analysis implementations without copying their algorithms into the host. */
export function createBuiltinOmkAnalysisBindingFactories(): OmkBuiltinAnalysisBindingFactories {
  const analysisNodes = createBuiltinAnalysisNodes();
  const missingPolicies = createBuiltinMissingPolicies();
  const decisionPolicies = createBuiltinDecisionPolicies();
  return {
    analysisNodesByImplementationId: new Map([...analysisNodes].map(([implementationId, port]) => [
      implementationId,
      () => ({ port, satisfiesVersionConstraint: true, preflightDeclarations: [] }),
    ])),
    missingPoliciesByImplementationId: new Map([...missingPolicies].map(([
      implementationId,
      port,
    ]) => [implementationId, () => ({
      port,
      satisfiesVersionConstraint: true,
      preflightDeclarations: [],
    })])),
    decisionPoliciesByImplementationId: new Map([...decisionPolicies].map(([
      implementationId,
      port,
    ]) => [implementationId, () => ({
      port,
      satisfiesVersionConstraint: true,
      preflightDeclarations: [],
    })])),
  };
}
