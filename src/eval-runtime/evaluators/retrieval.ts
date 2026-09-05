import {
  deepFreezeCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
} from '../../eval-core/contracts/index.js';
import type {
  EvaluationEvaluator,
  EvaluatorBindingValue,
  EvaluatorObservation,
} from '../../eval-core/evaluation/index.js';
import { createSameProcessEvaluatorAdapter } from '../adapters/same-process.js';
import { createRuntimeIdentity } from '../identity.js';

export const RETRIEVAL_EVALUATOR_IMPLEMENTATION_ID =
  'omk.eval-runtime.retrieval-metrics/v1' as const;

export interface RetrievalMetricIds {
  readonly recallAtK: string;
  readonly precisionAtK: string;
  readonly reciprocalRankAtK: string;
  readonly ndcgAtK: string;
}

export interface CreateRetrievalEvaluatorInput {
  readonly evaluatorId: string;
  readonly cutoff: number;
  readonly metricIds: RetrievalMetricIds;
  readonly rankingSource: 'output' | 'trace';
  readonly rankingPointer: string;
  readonly relevantDocumentIdsPointer: string;
  readonly rankingBindingId?: string;
  readonly relevantDocumentIdsBindingId?: string;
  readonly sessionIsolationKey?: string;
}

type RetrievalMetricKind = keyof RetrievalMetricIds;

const METRIC_KINDS = [
  'recallAtK',
  'precisionAtK',
  'reciprocalRankAtK',
  'ndcgAtK',
] as const satisfies readonly RetrievalMetricKind[];

function binding(
  bindings: readonly EvaluatorBindingValue[],
  bindingId: string,
): EvaluatorBindingValue | undefined {
  return bindings.find((candidate) => candidate.bindingId === bindingId);
}

function stringIds(value: JsonValue): string[] | undefined {
  if (!Array.isArray(value)
      || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    return undefined;
  }
  const ids = value as string[];
  return new Set(ids).size === ids.length ? ids : undefined;
}

function assertMetricInput(input: Readonly<{
  ranking: readonly string[];
  relevantDocumentIds: readonly string[];
  cutoff: number;
}>): void {
  if (!Number.isSafeInteger(input.cutoff) || input.cutoff < 1) {
    throw new TypeError('Retrieval cutoff must be a positive safe integer.');
  }
  for (const [name, ids] of [
    ['ranking', input.ranking],
    ['relevantDocumentIds', input.relevantDocumentIds],
  ] as const) {
    if (!Array.isArray(ids)
        || ids.some((documentId) => typeof documentId !== 'string' || documentId.length === 0)
        || new Set(ids).size !== ids.length) {
      throw new TypeError(`Retrieval ${name} must contain unique non-empty string IDs.`);
    }
  }
  if (input.relevantDocumentIds.length === 0) {
    throw new TypeError('Retrieval relevantDocumentIds must not be empty.');
  }
}

function observations(
  metricIds: Readonly<RetrievalMetricIds>,
  value: Readonly<
    | { observationStatus: 'observed'; values: Readonly<Record<RetrievalMetricKind, number>> }
    | { observationStatus: 'missing' | 'invalid'; reasonCode: string }
  >,
): EvaluatorObservation[] {
  return METRIC_KINDS.map((metricKind): EvaluatorObservation => {
    if (value.observationStatus === 'observed') {
      return {
        metricId: metricIds[metricKind],
        observationStatus: 'observed',
        valueType: 'numeric',
        value: value.values[metricKind],
      };
    }
    if (value.observationStatus === 'missing') {
      return {
        metricId: metricIds[metricKind],
        observationStatus: 'missing',
        valueType: 'numeric',
        reasonCode: value.reasonCode,
      };
    }
    return {
      metricId: metricIds[metricKind],
      observationStatus: 'invalid',
      valueType: 'numeric',
      reasonCode: value.reasonCode,
    };
  });
}

export function calculateBinaryRetrievalMetrics(input: Readonly<{
  ranking: readonly string[];
  relevantDocumentIds: readonly string[];
  cutoff: number;
}>): Readonly<Record<RetrievalMetricKind, number>> {
  assertMetricInput(input);
  const ranking = input.ranking.slice(0, input.cutoff);
  const relevant = new Set(input.relevantDocumentIds);
  const hits = ranking.filter((documentId) => relevant.has(documentId)).length;
  const firstRelevantIndex = ranking.findIndex((documentId) => relevant.has(documentId));
  const dcg = ranking.reduce((sum, documentId, index) => (
    sum + (relevant.has(documentId) ? 1 / Math.log2(index + 2) : 0)
  ), 0);
  const idealHits = Math.min(input.relevantDocumentIds.length, input.cutoff);
  let idealDcg = 0;
  for (let index = 0; index < idealHits; index += 1) {
    idealDcg += 1 / Math.log2(index + 2);
  }
  return deepFreezeCanonicalJson({
    recallAtK: hits / input.relevantDocumentIds.length,
    precisionAtK: hits / input.cutoff,
    reciprocalRankAtK: firstRelevantIndex < 0 ? 0 : 1 / (firstRelevantIndex + 1),
    ndcgAtK: dcg / idealDcg,
  });
}

export function createRetrievalEvaluatorIdentity(
  input: Readonly<CreateRetrievalEvaluatorInput>,
): RuntimeIdentity {
  return createRuntimeIdentity({
    implementationId: RETRIEVAL_EVALUATOR_IMPLEMENTATION_ID,
    version: '1.0.0',
    capabilities: {
      inputSourceKinds: [...new Set([input.rankingSource, 'expected'])].sort(),
      metricValueTypes: ['numeric'],
      schemas: [],
    },
    fingerprintFacets: {
      algorithm: 'binary-top-k-retrieval/log2-v1',
      cutoff: input.cutoff,
      evaluatorId: input.evaluatorId,
      metricIds: {
        recallAtK: input.metricIds.recallAtK,
        precisionAtK: input.metricIds.precisionAtK,
        reciprocalRankAtK: input.metricIds.reciprocalRankAtK,
        ndcgAtK: input.metricIds.ndcgAtK,
      },
      ranking: { source: input.rankingSource, pointer: input.rankingPointer },
      relevantDocumentIdsPointer: input.relevantDocumentIdsPointer,
    },
  });
}

/** Creates the deterministic binary-relevance top-k Evaluator used by the canonical façade. */
export function createRetrievalEvaluator(
  input: Readonly<CreateRetrievalEvaluatorInput>,
): EvaluationEvaluator {
  const rankingBindingId = input.rankingBindingId ?? 'ranking';
  const relevantBindingId = input.relevantDocumentIdsBindingId ?? 'relevant-document-ids';
  const identity = createRetrievalEvaluatorIdentity(input);
  return createSameProcessEvaluatorAdapter({
    identity,
    sessionIsolationKey: input.sessionIsolationKey
      ?? `omk.eval-runtime.retrieval-metrics/v1:${identity.fingerprint}`,
    resourceLeases: { forRun: () => undefined },
    implementation: {
      openRun: () => undefined,
      openRecord: () => undefined,
      evaluate({ record, attempt }) {
        if (attempt.signal.aborted) return Promise.reject(attempt.signal.reason);
        const rankingBinding = binding(record.bindings, rankingBindingId);
        const relevantBinding = binding(record.bindings, relevantBindingId);
        if (rankingBinding === undefined || relevantBinding === undefined) {
          return Promise.resolve({
            observations: observations(input.metricIds, {
              observationStatus: 'missing',
              reasonCode: rankingBinding === undefined
                ? 'retrieval-ranking-missing'
                : 'retrieval-relevance-missing',
            }),
          });
        }
        const ranking = stringIds(rankingBinding.value);
        if (ranking === undefined) {
          return Promise.resolve({
            observations: observations(input.metricIds, {
              observationStatus: 'invalid',
              reasonCode: 'retrieval-ranking-invalid',
            }),
          });
        }
        const relevantDocumentIds = stringIds(relevantBinding.value);
        if (relevantDocumentIds === undefined || relevantDocumentIds.length === 0) {
          return Promise.resolve({
            observations: observations(input.metricIds, {
              observationStatus: 'invalid',
              reasonCode: relevantDocumentIds?.length === 0
                ? 'retrieval-relevance-empty'
                : 'retrieval-relevance-invalid',
            }),
          });
        }
        return Promise.resolve({
          observations: observations(input.metricIds, {
            observationStatus: 'observed',
            values: calculateBinaryRetrievalMetrics({
              ranking,
              relevantDocumentIds,
              cutoff: input.cutoff,
            }),
          }),
        });
      },
      disposeRecord: () => undefined,
      disposeRun: () => undefined,
    },
  });
}
