import { z } from 'zod';
import {
  EvaluationDatasetSchema,
  IdentifierSchema,
  JsonPointerSchema,
  JsonValueSchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
} from '../eval-core/contracts/index.js';
import type { Dataset } from './evaluate.js';
import type { CustomEvaluator, CustomEvaluatorResult } from './custom-evaluator.js';
import { calculateBinaryRetrievalMetrics } from './evaluators/retrieval.js';

const EVALUATION_VERSION = 'omk.retrieval-abstention/v1';
const metricNames = [
  'recallAtK', 'precisionAtK', 'reciprocalRankAtK', 'ndcgAtK',
  'abstentionCorrect', 'falseAbstention', 'forbiddenHitAtK',
] as const;
type MetricName = typeof metricNames[number];

export interface RetrievalAbstentionEvaluationInput {
  readonly dataset: Dataset;
  readonly cutoff: number;
  /** Final, threshold-filtered recommendations, not the internal candidate pool. */
  readonly ranking: { readonly source: 'output' | 'trace'; readonly pointer: string };
  /** All pointers are relative to sample.expected. */
  readonly expected?: {
    readonly shouldAbstainPointer?: string;
    readonly relevantDocumentIdsPointer?: string;
    readonly forbiddenDocumentIdsPointer?: string;
    readonly reviewStatusPointer?: string;
  };
  readonly pendingPolicy?: 'error' | 'exclude';
  readonly metricPrefix?: string;
}

export interface RetrievalAbstentionEvaluation {
  readonly dataset: Dataset;
  readonly evaluators: readonly CustomEvaluator[];
  readonly metricIds: Readonly<Record<MetricName, string>>;
}

/** Stable errors contain coordinates, never prompts, Gold contents or rejected payloads. */
export class RetrievalAbstentionInputError extends TypeError {
  readonly sampleIds: readonly string[];

  constructor(readonly code: string, sampleIds: readonly string[] = []) {
    super(`召回与拒答评测输入无效：${code}。请检查 sampleIds。`);
    this.name = 'RetrievalAbstentionInputError';
    this.sampleIds = Object.freeze([...sampleIds]);
  }
}

const OptionsSchema = z.object({
  cutoff: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ranking: z.object({ source: z.enum(['output', 'trace']), pointer: JsonPointerSchema }).strict(),
  expected: z.object({
    shouldAbstainPointer: JsonPointerSchema.default('/shouldAbstain'),
    relevantDocumentIdsPointer: JsonPointerSchema.default('/acceptableSolutionIds'),
    forbiddenDocumentIdsPointer: JsonPointerSchema.default('/forbiddenSolutionIds'),
    reviewStatusPointer: JsonPointerSchema.default('/reviewStatus'),
  }).strict().prefault({}),
  pendingPolicy: z.enum(['error', 'exclude']).default('error'),
  metricPrefix: IdentifierSchema.default('retrieval-abstention'),
}).strict();
type Options = z.infer<typeof OptionsSchema>;

function atPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function ids(value: unknown): string[] | undefined {
  if (!Array.isArray(value)
      || value.some((id) => typeof id !== 'string' || id.trim().length === 0)
      || new Set(value).size !== value.length) return undefined;
  return value as string[];
}

function expectation(value: unknown, options: Options, sampleId: string) {
  const mapping = options.expected;
  const raw = atPointer(value, mapping.shouldAbstainPointer);
  const relevant = ids(atPointer(value, mapping.relevantDocumentIdsPointer));
  const forbidden = ids(atPointer(value, mapping.forbiddenDocumentIdsPointer));
  const reviewStatus = atPointer(value, mapping.reviewStatusPointer);
  if ((raw !== true && raw !== false && raw !== null)
      || relevant === undefined || forbidden === undefined
      || (reviewStatus !== undefined && typeof reviewStatus !== 'string')) {
    throw new RetrievalAbstentionInputError('RETRIEVAL_ABSTENTION_LABEL_INVALID', [sampleId]);
  }
  const shouldAbstain = reviewStatus === 'pending_human_annotation' ? null : raw;
  if (relevant.some((id) => forbidden.includes(id))) {
    throw new RetrievalAbstentionInputError('RETRIEVAL_ABSTENTION_LABEL_OVERLAP', [sampleId]);
  }
  if (shouldAbstain !== null && (shouldAbstain ? relevant.length !== 0 : relevant.length === 0)) {
    throw new RetrievalAbstentionInputError('RETRIEVAL_ABSTENTION_LABEL_CONFLICT', [sampleId]);
  }
  return { shouldAbstain, relevant, forbidden };
}

function score(
  name: MetricName,
  bindings: Readonly<Record<string, JsonValue>>,
  options: Options,
  sampleId: string,
): CustomEvaluatorResult {
  const executionStatus = atPointer(bindings.executionFacts, '/terminal/executionStatus');
  if (executionStatus !== 'completed') {
    return executionStatus === undefined
      ? { resultKind: 'invalid', reasonCode: 'retrieval-abstention-execution-facts-invalid' }
      : { resultKind: 'missing', reasonCode: 'retrieval-abstention-execution-not-completed' };
  }
  let gold;
  try {
    gold = expectation(bindings.expected, options, sampleId);
  } catch {
    return { resultKind: 'invalid', reasonCode: 'retrieval-abstention-label-invalid' };
  }
  if (gold.shouldAbstain === null) {
    return { resultKind: 'invalid', reasonCode: 'retrieval-abstention-label-pending' };
  }
  const ranking = ids(bindings.ranking);
  if (ranking === undefined) {
    return { resultKind: 'invalid', reasonCode: 'retrieval-abstention-ranking-invalid' };
  }
  const evidence = {
    classification: 'gold' as const,
    value: {
      shouldAbstain: gold.shouldAbstain,
      relevantDocumentIds: gold.relevant,
      forbiddenDocumentIds: gold.forbidden,
      finalRecommendationIds: ranking,
      cutoff: options.cutoff,
    },
  };
  const notApplicable = (): CustomEvaluatorResult => ({
    resultKind: 'missing', reasonCode: 'retrieval-abstention-not-applicable', evidence,
  });
  if (name === 'abstentionCorrect') {
    return gold.shouldAbstain
      ? { resultKind: 'score', value: ranking.length === 0, evidence }
      : notApplicable();
  }
  if (name === 'falseAbstention') {
    return !gold.shouldAbstain
      ? { resultKind: 'score', value: ranking.length === 0, evidence }
      : notApplicable();
  }
  if (name === 'forbiddenHitAtK') {
    return gold.forbidden.length > 0
      ? {
        resultKind: 'score',
        value: ranking.slice(0, options.cutoff).some((id) => gold.forbidden.includes(id)),
        evidence,
      }
      : notApplicable();
  }
  if (gold.shouldAbstain) return notApplicable();
  return {
    resultKind: 'score',
    value: calculateBinaryRetrievalMetrics({
      ranking, relevantDocumentIds: gold.relevant, cutoff: options.cutoff,
    })[name],
    evidence,
  };
}

/** Opt-in composition of existing Dataset / CustomEvaluator contracts; no I/O or second engine. */
export function createRetrievalAbstentionEvaluation(
  input: Readonly<RetrievalAbstentionEvaluationInput>,
): RetrievalAbstentionEvaluation {
  let dataset;
  let options: Options;
  try {
    const { dataset: source, ...rawOptions } = input;
    dataset = EvaluationDatasetSchema.parse(structuredClone(source));
    options = deepFreezeCanonicalJson(OptionsSchema.parse(structuredClone(rawOptions)));
  } catch {
    throw new RetrievalAbstentionInputError('RETRIEVAL_ABSTENTION_INPUT_INVALID');
  }
  const sampleIds = dataset.samples.map((sample) => sample.sampleId);
  if (new Set(sampleIds).size !== sampleIds.length) {
    throw new RetrievalAbstentionInputError('RETRIEVAL_ABSTENTION_SAMPLE_DUPLICATE');
  }
  const excludedSampleIds: string[] = [];
  let positiveCount = 0;
  let abstentionCount = 0;
  const samples = dataset.samples.filter((sample) => {
    const gold = expectation(sample.expected, options, sample.sampleId);
    if (gold.shouldAbstain === null) {
      excludedSampleIds.push(sample.sampleId);
      return false;
    }
    if (gold.shouldAbstain) abstentionCount++;
    else positiveCount++;
    return true;
  });
  if (excludedSampleIds.length > 0 && options.pendingPolicy === 'error') {
    throw new RetrievalAbstentionInputError('RETRIEVAL_ABSTENTION_PENDING', excludedSampleIds);
  }
  if (samples.length === 0) {
    throw new RetrievalAbstentionInputError('RETRIEVAL_ABSTENTION_DATASET_EMPTY', excludedSampleIds);
  }
  const metricIds = Object.fromEntries(metricNames.map((name) => [
    name, `${options.metricPrefix}.${name}`,
  ])) as Record<MetricName, string>;
  try {
    for (const metricId of Object.values(metricIds)) {
      IdentifierSchema.parse(metricId);
      IdentifierSchema.parse(`${metricId}/v1`);
    }
  } catch {
    throw new RetrievalAbstentionInputError('RETRIEVAL_ABSTENTION_METRIC_ID_INVALID');
  }
  const evaluators = metricNames.map((name): CustomEvaluator => {
    const numeric = !['abstentionCorrect', 'falseAbstention', 'forbiddenHitAtK'].includes(name);
    return {
      evaluatorKind: 'custom',
      evaluatorId: metricIds[name],
      instrumentId: `${metricIds[name]}/v1`,
      metric: {
        metricId: metricIds[name],
        ...(numeric
          ? { valueType: 'numeric' as const, scale: { min: 0, max: 1 } }
          : { valueType: 'boolean' as const }),
        direction: name === 'falseAbstention' || name === 'forbiddenHitAtK'
          ? 'lower-is-better' : 'higher-is-better',
        missingPolicyId: 'exclude/v1',
      },
      bindings: [
        { bindingId: 'ranking', sourceKind: options.ranking.source, pointer: options.ranking.pointer },
        { bindingId: 'expected', sourceKind: 'expected', pointer: '' },
        { bindingId: 'executionFacts', sourceKind: 'execution-facts', pointer: '' },
      ],
      parameters: { ...options, metricName: name },
      implementation: {
        implementationId: `${EVALUATION_VERSION}:${name}`,
        version: '1.0.0',
        schemas: {
          bindings: z.record(z.string(), JsonValueSchema),
          value: numeric ? z.number().min(0).max(1) : z.boolean(),
          fingerprintFacets: { evaluation: EVALUATION_VERSION, metricName: name, options },
        },
        fingerprintFacets: { evaluation: EVALUATION_VERSION, metricName: name, options },
        evaluate({ bindings, sampleId, signal }) {
          signal.throwIfAborted();
          return score(name, bindings, options, sampleId);
        },
      },
    };
  });
  return Object.freeze({
    dataset: deepFreezeCanonicalJson({
      ...dataset,
      samples,
      annotations: {
        original: dataset.annotations ?? null,
        retrievalAbstention: {
          schemaVersion: EVALUATION_VERSION,
          sourceDatasetDigest: digestCanonicalJson(dataset),
          pendingPolicy: options.pendingPolicy,
          sourceSampleCount: dataset.samples.length,
          positiveCount,
          abstentionCount,
          pendingCount: excludedSampleIds.length,
          excludedSampleIds,
        },
      },
    }),
    evaluators: Object.freeze(evaluators),
    metricIds: Object.freeze(metricIds),
  });
}
