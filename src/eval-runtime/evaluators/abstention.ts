import { z } from 'zod';
import {
  EvaluatorDefinitionSchema,
  ExecutionFactsSchema,
  IdentifierSchema,
  JsonPointerSchema,
  MetricDefinitionSchema,
  deepFreezeCanonicalJson,
  type JsonValue,
} from '../../eval-core/contracts/index.js';
import type { EvaluatorObservation } from '../../eval-core/evaluation/index.js';
import { createSameProcessEvaluatorAdapter } from '../adapters/same-process.js';
import { createRuntimeIdentity } from '../identity.js';

export const ABSTENTION_EVALUATOR_IMPLEMENTATION_ID =
  'omk.eval-runtime.abstention/v1' as const;

export interface AbstentionMetricIds {
  readonly abstentionCorrect: string;
  readonly falseAbstention: string;
}

/** A successful, valid empty final ID list is an abstention; failures are not. */
export interface AbstentionEvaluator {
  readonly evaluatorKind: 'abstention';
  readonly evaluatorId: string;
  readonly ranking: Readonly<{ readonly source: 'output' | 'trace'; readonly pointer: string }>;
  readonly shouldAbstainPointer: string;
  readonly metricIds: AbstentionMetricIds;
}

const InputSchema = z.object({
  evaluatorKind: z.literal('abstention'),
  evaluatorId: IdentifierSchema,
  ranking: z.object({ source: z.enum(['output', 'trace']), pointer: JsonPointerSchema }).strict(),
  shouldAbstainPointer: JsonPointerSchema,
  metricIds: z.object({
    abstentionCorrect: IdentifierSchema,
    falseAbstention: IdentifierSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.metricIds.abstentionCorrect === value.metricIds.falseAbstention) {
    context.addIssue({ code: 'custom', path: ['metricIds'], message: '弃答指标 ID 必须唯一。' });
  }
});

function validRanking(value: JsonValue | undefined): value is string[] {
  return Array.isArray(value)
    && value.every((id) => typeof id === 'string' && id.trim().length > 0)
    && new Set(value).size === value.length;
}

function unobserved(
  metricId: string,
  observationStatus: 'missing' | 'invalid',
  reasonCode: string,
): EvaluatorObservation {
  return { metricId, valueType: 'boolean', observationStatus, reasonCode };
}

/** Compiles a built-in instrument, without selecting samples or interpreting business labels. */
export function createAbstentionEvaluatorBinding(input: Readonly<AbstentionEvaluator>) {
  const value = deepFreezeCanonicalJson(InputSchema.parse(structuredClone(input)));
  const metricIds = Object.values(value.metricIds);
  const config = {
    protocol: 'completed-unique-string-list/v1',
    abstention: 'empty-final-list',
    applicability: 'explicit-boolean-expectation',
    idComparison: 'case-sensitive-no-normalization',
  } as const;
  const identity = createRuntimeIdentity({
    implementationId: ABSTENTION_EVALUATOR_IMPLEMENTATION_ID,
    version: '1.0.0',
    capabilities: {
      inputSourceKinds: ['execution-facts', 'expected', value.ranking.source].sort(),
      metricValueTypes: ['boolean'],
      schemas: [],
    },
    fingerprintFacets: { ...value, ...config },
  });
  const definition = EvaluatorDefinitionSchema.parse({
    evaluatorId: value.evaluatorId,
    evaluatorKind: 'assertion',
    implementationId: ABSTENTION_EVALUATOR_IMPLEMENTATION_ID,
    measurement: {
      instrumentId: 'final-list-abstention-v1',
      ensembleMemberId: 'deterministic-local',
      replicateGroupId: value.evaluatorId,
      replicateIndex: 0,
    },
    metricIds,
    inputs: [
      { bindingId: 'ranking', sourceKind: value.ranking.source, pointer: value.ranking.pointer },
      { bindingId: 'should-abstain', sourceKind: 'expected', pointer: value.shouldAbstainPointer },
      { bindingId: 'execution-facts', sourceKind: 'execution-facts', pointer: '' },
    ],
    config,
  });
  const metrics = metricIds.map((metricId) => MetricDefinitionSchema.parse({
    metricId,
    valueType: 'boolean',
    scope: 'sample',
    direction: metricId === value.metricIds.falseAbstention ? 'lower-is-better' : 'higher-is-better',
    missingPolicyId: 'exclude/v1',
  }));
  const port = createSameProcessEvaluatorAdapter({
    identity,
    sessionIsolationKey: `${ABSTENTION_EVALUATOR_IMPLEMENTATION_ID}:${identity.fingerprint}`,
    resourceLeases: { forRun: () => undefined },
    implementation: {
      openRun: () => undefined,
      openRecord: () => undefined,
      evaluate({ record, attempt }) {
        attempt.signal.throwIfAborted();
        const binding = (id: string) => record.bindings.find((item) => item.bindingId === id)?.value;
        const facts = binding('execution-facts');
        const shouldAbstain = binding('should-abstain');
        const ranking = binding('ranking');
        const unavailable = (observationStatus: 'missing' | 'invalid', reasonCode: string) => ({
          observations: metricIds.map((metricId) => unobserved(metricId, observationStatus, reasonCode)),
        });
        if (facts === undefined) {
          return Promise.resolve(unavailable('missing', 'abstention-execution-status-missing'));
        }
        const parsedFacts = ExecutionFactsSchema.safeParse(facts);
        if (!parsedFacts.success) {
          return Promise.resolve(unavailable('invalid', 'abstention-execution-facts-invalid'));
        }
        if (parsedFacts.data.terminal.executionStatus !== 'completed') {
          return Promise.resolve(unavailable('missing', 'abstention-execution-not-completed'));
        }
        if (shouldAbstain === undefined) {
          return Promise.resolve(unavailable('missing', 'abstention-expectation-missing'));
        }
        if (typeof shouldAbstain !== 'boolean') {
          return Promise.resolve(unavailable('invalid', 'abstention-expectation-invalid'));
        }
        if (ranking === undefined) {
          return Promise.resolve(unavailable('missing', 'abstention-ranking-missing'));
        }
        if (!validRanking(ranking)) {
          return Promise.resolve(unavailable('invalid', 'abstention-ranking-invalid'));
        }
        const applicable = shouldAbstain ? value.metricIds.abstentionCorrect : value.metricIds.falseAbstention;
        return Promise.resolve({
          observations: metricIds.map((metricId): EvaluatorObservation => metricId === applicable
            ? { metricId, valueType: 'boolean', observationStatus: 'observed', value: ranking.length === 0 }
            : unobserved(metricId, 'missing', 'abstention-not-applicable')),
        });
      },
      disposeRecord: () => undefined,
      disposeRun: () => undefined,
    },
  });
  return Object.freeze({ definition, metrics, port });
}
