import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { PUBLIC_API, declarationExports } from './public-api-contract.js';
import type {
  AbstentionEvaluator,
  AbstentionMetricIds,
  AnalysisRequest,
  AttemptBudgetScope,
  BudgetPolicy,
  BudgetScope,
  CohortFilter,
  CustomEvaluator,
  Decision,
  EvaluationExecutor,
  ExecutorSessionAttempt,
  ExecutorSessionContext,
  Policy,
  ProviderCostLimit,
  RetrievalEvaluator,
  RetrievalMetricIds,
  RunBudgetScope,
  SamplingDesign,
  SessionExecutor,
  ToolTrajectoryEvaluator,
  ToolTrajectoryMatchMode,
} from '../../src/eval-runtime/index.js';

const publicSessionExecutor: SessionExecutor<{ query: string }, undefined, string> = {
  protocol: 'session',
  executorId: 'public.session/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ query: z.string() }).strict(),
    output: z.string(),
  },
  async openSession(context: Readonly<ExecutorSessionContext<{ query: string }, undefined>>) {
    void context.runId;
    return {
      async execute(attempt: Readonly<ExecutorSessionAttempt>) {
        attempt.signal.throwIfAborted();
        return { output: context.input.query };
      },
      close() {},
    };
  },
};
const publicEvaluationExecutor: EvaluationExecutor<
  { query: string }, undefined, string
> = publicSessionExecutor;
void publicEvaluationExecutor;

const independentSampling: SamplingDesign = {
  samplingKind: 'independent',
  allocations: [
    { variantId: 'control', weight: 1 },
    { variantId: 'treatment', weight: 1 },
  ],
  minimumSamplesPerVariant: 2,
  minimumSamplesPerVariantPerStratum: 1,
};

// @ts-expect-error quantile requests require an explicit probability.
const incompleteQuantile: AnalysisRequest = {
  analysisId: 'p95', analysisKind: 'summary', statistic: 'quantile',
  variantId: 'candidate', metricId: 'latency-ms',
};
// @ts-expect-error an explicit cohort filter must select or exclude at least one cohort.
const emptyCohortFilter: CohortFilter = {};
const incompleteFamily: AnalysisRequest = {
  analysisId: 'release-family',
  analysisKind: 'comparison-family',
  statistic: 'mean-difference',
  // @ts-expect-error simultaneous interval families require at least two declared members.
  members: [{
    analysisId: 'only-member',
    comparisonId: 'baseline-vs-candidate',
    treatmentVariantId: 'candidate',
    metricId: 'correct',
  }],
  confidence: {
    method: 'bonferroni-percentile-bootstrap',
    level: 0.95,
    resamples: 1_000,
  },
};
const publicComposite: AnalysisRequest = {
  analysisId: 'overall-quality',
  analysisKind: 'composite-quality-interval',
  compositeMetricId: 'overall-quality',
  variantId: 'candidate',
  components: [
    { metricId: 'correct', weight: 0.6 },
    { metricId: 'concise', weight: 0.4 },
  ],
  aggregation: { method: 'weighted-mean', missing: 'require-complete' },
  confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 1_000 },
};
const incompleteComposite: AnalysisRequest = {
  analysisId: 'invalid-overall-quality',
  analysisKind: 'composite-quality-interval',
  compositeMetricId: 'invalid-overall-quality',
  variantId: 'candidate',
  // @ts-expect-error composite analysis requires at least two components.
  components: [{ metricId: 'correct', weight: 1 }],
  aggregation: { method: 'weighted-mean', missing: 'require-complete' },
  confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 1_000 },
};
void incompleteQuantile;
void emptyCohortFilter;
void incompleteFamily;
void publicComposite;
void incompleteComposite;
const unboundedFamilyDecision: Decision = {
  decisionKind: 'comparison-family',
  analysisId: 'release-family',
  rule: 'all',
  criteria: [
    // @ts-expect-error comparison-family criteria must declare at least one effect boundary.
    { analysisId: 'correctness' },
    { analysisId: 'latency-ms', maximumEffect: 20 },
  ],
};
void unboundedFamilyDecision;
const invalidFailurePolicy: Policy = {
  failure: {
    failureMode: 'continue',
    // @ts-expect-error failure thresholds are valid only with failure-threshold mode.
    maxFailures: 1,
  },
};
void invalidFailurePolicy;
const publicProviderCost: ProviderCostLimit = { amount: 1, currency: 'USD' };
const publicBudgetScope: BudgetScope = {
  maxInvocations: 10,
  maxActiveDurationMs: 1_000,
  maxProviderCost: publicProviderCost,
};
const publicRunBudget: RunBudgetScope = {
  ...publicBudgetScope,
  maxWallClockMs: 2_000,
};
const publicAttemptBudget: AttemptBudgetScope = { maxProviderCost: publicProviderCost };
const publicBudget: BudgetPolicy = {
  run: publicRunBudget,
  execution: publicBudgetScope,
  attempt: publicAttemptBudget,
  onUnreportedProviderCost: 'fail-run',
};
void publicBudget;
const publicRetrievalMetrics: RetrievalMetricIds = {
  recallAtK: 'recall-at-10',
  precisionAtK: 'precision-at-10',
  reciprocalRankAtK: 'reciprocal-rank-at-10',
  ndcgAtK: 'ndcg-at-10',
};
const publicRetrievalEvaluator: RetrievalEvaluator = {
  evaluatorKind: 'retrieval',
  evaluatorId: 'retrieval-quality',
  cutoff: 10,
  ranking: { source: 'output', pointer: '/documents' },
  relevantDocumentIdsPointer: '/relevantDocumentIds',
  metricIds: publicRetrievalMetrics,
};
void publicRetrievalEvaluator;
const publicAbstentionMetrics: AbstentionMetricIds = {
  abstentionCorrect: 'abstention-correct', falseAbstention: 'false-abstention',
};
const publicAbstention: AbstentionEvaluator = {
  evaluatorKind: 'abstention', evaluatorId: 'abstention',
  ranking: { source: 'output', pointer: '/documents' },
  shouldAbstainPointer: '/shouldAbstain', metricIds: publicAbstentionMetrics,
};
void publicAbstention;
const publicTrajectoryMatch: ToolTrajectoryMatchMode = 'contains-in-order';
const publicToolTrajectoryEvaluator: ToolTrajectoryEvaluator = {
  evaluatorKind: 'tool-trajectory',
  evaluatorId: 'tool-trajectory',
  metricId: 'tool-trajectory-match',
  tracePointer: '',
  expectedToolNamesPointer: '/expectedToolNames',
  match: publicTrajectoryMatch,
};
void publicToolTrajectoryEvaluator;
const invalidAttemptBudget: AttemptBudgetScope = {
  // @ts-expect-error an attempt budget only supports provider cost.
  maxInvocations: 1,
};
void invalidAttemptBudget;

const publicCustomEvaluator = {
  evaluatorKind: 'custom',
  evaluatorId: 'public-length',
  instrumentId: 'public-length-v1',
  metric: {
    metricId: 'public-length-score',
    valueType: 'numeric',
    direction: 'lower-is-better',
    missingPolicyId: 'exclude/v1',
  },
  bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
  parameters: { trim: true },
  implementation: {
    implementationId: 'test.public-length/v1',
    version: '1.0.0',
    schemas: {
      bindings: z.object({ actual: z.string() }).strict(),
      value: z.number(),
      fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
    },
    fingerprintFacets: { revision: 'test-one' },
    evaluate({ bindings, parameters }) {
      return {
        resultKind: 'score',
        value: (parameters?.trim ? bindings.actual.trim() : bindings.actual).length,
      };
    },
  },
} satisfies CustomEvaluator<{ actual: string }, { trim: boolean }>;

describe('published eval-runtime API allowlist', () => {
  it('exposes the independent-group design through the public TypeScript contract', () => {
    expect(independentSampling.samplingKind).toBe('independent');
    expect(publicCustomEvaluator.evaluatorKind).toBe('custom');
  });

  it('makes the package root an exact runtime façade alias', async () => {
    const rootEntry = '../../dist/index.js';
    const runtimeEntry = '../../dist/eval-runtime/index.js';
    const root = await import(rootEntry);
    const runtime = await import(runtimeEntry);
    expect(Object.keys(root).sort()).toEqual(Object.keys(runtime).sort());
    expect(Object.keys(root).sort()).toEqual([
      ...PUBLIC_API['eval-runtime'].values,
    ].sort());
    expect(readFileSync(resolve('dist/index.d.ts'), 'utf8')).toContain(
      "export * from './eval-runtime/index.js';",
    );
  });

  for (const [subpath, contract] of Object.entries(PUBLIC_API)) {
    it(`locks values and types for ${subpath}`, async () => {
      const runtime = await import(`../../dist/eval-runtime/${contract.entry}.js`);
      expect(Object.keys(runtime).sort()).toEqual([...contract.values].sort());
      expect(declarationExports(contract.entry)).toEqual({
        values: [...contract.values].sort(),
        types: [...contract.types].sort(),
      });
    });
  }

  it('documents every allowlisted export in both API references', () => {
    const references = [
      readFileSync(resolve('docs/reference/eval-runtime-api.md'), 'utf8'),
      readFileSync(resolve('docs/zh/reference/eval-runtime-api.md'), 'utf8'),
    ];
    for (const contract of Object.values(PUBLIC_API)) {
      for (const exportName of [...contract.values, ...contract.types]) {
        for (const reference of references) {
          expect(reference).toContain(`\`${exportName}\``);
        }
      }
    }
  });
});
