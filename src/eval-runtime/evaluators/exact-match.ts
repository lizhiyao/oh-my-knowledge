import {
  canonicalizeJson,
  type RuntimeIdentity,
} from '../../eval-core/contracts/index.js';
import type {
  EvaluationEvaluator,
  EvaluatorBindingValue,
  EvaluatorObservation,
} from '../../eval-core/evaluation/index.js';
import { createRuntimeIdentity } from '../identity.js';
import { createSameProcessEvaluatorAdapter } from '../adapters/same-process.js';

export const EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID =
  'omk.eval-runtime.exact-match/v1' as const;

export interface CreateExactMatchEvaluatorInput {
  readonly metricId?: string;
  readonly actualBindingId?: string;
  readonly expectedBindingId?: string;
  readonly sessionIsolationKey?: string;
}

function binding(
  bindings: readonly EvaluatorBindingValue[],
  bindingId: string,
): EvaluatorBindingValue | undefined {
  return bindings.find((candidate) => candidate.bindingId === bindingId);
}

export function createExactMatchEvaluatorIdentity(input: Readonly<{
  metricId?: string;
  actualBindingId?: string;
  expectedBindingId?: string;
}> = {}): RuntimeIdentity {
  const metricId = input.metricId ?? 'correct';
  const actualBindingId = input.actualBindingId ?? 'actual';
  const expectedBindingId = input.expectedBindingId ?? 'expected';
  return createRuntimeIdentity({
    implementationId: EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID,
    version: '1.0.0',
    capabilities: {
      inputSourceKinds: ['expected', 'output'],
      metricValueTypes: ['boolean'],
      schemas: [],
    },
    fingerprintFacets: {
      algorithm: 'canonical-json-exact-match/v1',
      metricId,
      actualBindingId,
      expectedBindingId,
    },
  });
}

/** Creates the deterministic exact-match Evaluator used by the convenience Definition builder. */
export function createExactMatchEvaluator(
  input: Readonly<CreateExactMatchEvaluatorInput> = {},
): EvaluationEvaluator {
  const metricId = input.metricId ?? 'correct';
  const actualBindingId = input.actualBindingId ?? 'actual';
  const expectedBindingId = input.expectedBindingId ?? 'expected';
  return createSameProcessEvaluatorAdapter({
    identity: createExactMatchEvaluatorIdentity({ metricId, actualBindingId, expectedBindingId }),
    sessionIsolationKey: input.sessionIsolationKey ?? 'omk.eval-runtime.exact-match/v1',
    resourceLeases: { forRun: () => undefined },
    implementation: {
      openRun: () => undefined,
      openRecord: () => undefined,
      evaluate({ record, attempt }) {
        if (attempt.signal.aborted) return Promise.reject(attempt.signal.reason);
        const actual = binding(record.bindings, actualBindingId);
        const expected = binding(record.bindings, expectedBindingId);
        let observation: EvaluatorObservation;
        if (actual === undefined || expected === undefined) {
          observation = {
            metricId,
            observationStatus: 'missing',
            valueType: 'boolean',
            reasonCode: actual === undefined
              ? 'exact-match-actual-binding-missing'
              : 'exact-match-expected-binding-missing',
          };
        } else {
          observation = {
            metricId,
            observationStatus: 'observed',
            valueType: 'boolean',
            value: canonicalizeJson(actual.value) === canonicalizeJson(expected.value),
          };
        }
        return Promise.resolve({ observations: [observation] });
      },
      disposeRecord: () => undefined,
      disposeRun: () => undefined,
    },
  });
}
