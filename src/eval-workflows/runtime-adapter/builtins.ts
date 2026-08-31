import {
  createExecutionAssertionEvaluatorImplementation,
  EXECUTION_ASSERTION_EVALUATOR_IDENTITY,
  EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
} from './evaluators/execution-assertions.js';
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
import { createJudgeAggregationAnalysisNodes } from './analysis/judge-aggregation.js';
import { createAssertionLayerAnalysisNodes } from './analysis/assertion-layer-node.js';

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
    evaluatorsByImplementationId: new Map([
      [OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID, (context) => ({
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
      })],
      [EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID, (context) => ({
        port: createSameProcessEvaluatorAdapter({
          identity: EXECUTION_ASSERTION_EVALUATOR_IDENTITY,
          sessionIsolationKey: context.sessionIsolationKey,
          resourceLeases: context.resourceLeases,
          implementation: createExecutionAssertionEvaluatorImplementation(),
        }),
        satisfiesVersionConstraint: true,
        preflightDeclarations: [
          {
            preflightKind: 'credential',
            preflightDisposition: 'not-required',
            checkId: 'omk-execution-assertion-credential',
            reasonCode: 'local-deterministic-evaluator',
          },
          {
            preflightKind: 'connectivity',
            preflightDisposition: 'not-required',
            checkId: 'omk-execution-assertion-connectivity',
            reasonCode: 'local-deterministic-evaluator',
          },
        ],
      })],
    ]),
  };
}

/** Binds Core built-ins together with versioned OMK host-owned Analysis implementations. */
export function createBuiltinOmkAnalysisBindingFactories(): OmkBuiltinAnalysisBindingFactories {
  const analysisNodes = new Map([
    ...createBuiltinAnalysisNodes(),
    ...createAssertionLayerAnalysisNodes(),
    ...createJudgeAggregationAnalysisNodes(),
  ]);
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
