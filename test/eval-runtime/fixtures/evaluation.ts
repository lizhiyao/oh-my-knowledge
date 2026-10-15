import { z } from "zod";
import { type Clock, type CustomEvaluator, type Executor, type Variant } from "../../../src/eval-runtime/index.js";
import { digestCanonicalJson, type JsonValue } from "../../../src/eval-core/contracts/index.js";

export type Input = { prompt: string; };

export type Config = { answers: Record<string, string>; };

export function executor(
  execute?: Executor<Input, Config, string>['execute'],
  input: Readonly<{ executorId?: string; revision?: string; }> = {},
): Executor<Input, Config, string> {
  return {
    executorId: input.executorId ?? 'test.answer-executor/v1',
    version: '1.0.0',
    schemas: {
      input: z.object({ prompt: z.string() }).strict(),
      config: z.object({ answers: z.record(z.string(), z.string()) }).strict(),
      output: z.string(),
    },
    outputClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    fingerprintFacets: { deploymentRevision: input.revision ?? 'test-one' },
    execute: execute ?? (async ({ input: invocationInput, config, signal }) => {
      signal.throwIfAborted();
      return { output: config.answers[invocationInput.prompt] };
    }),
  };
}

export const controlSpec = {
  variantId: 'prompt-v1',
  artifact: {
    name: 'baseline',
    kind: 'baseline',
    source: 'baseline',
    content: null,
  },
  config: { answers: { one: 'A', two: 'wrong' } },
} as const;

export const treatmentSpec = {
  variantId: 'prompt-v2',
  artifact: {
    name: 'candidate',
    kind: 'prompt',
    source: 'inline',
    content: 'Answer exactly.',
  },
  runtimeContext: { values: { model: 'test-model' } },
  config: { answers: { one: 'A', two: 'B' } },
} as const;

interface VariantSpec {
  readonly variantId: string;
  readonly artifact: Variant<Input, Config, string>['artifact'];
  readonly runtimeContext?: Variant<Input, Config, string>['execution']['runtimeContext'];
  readonly config: Config;
}

export function variant(
  declaration: Executor<Input, Config, string>,
  spec: VariantSpec,
): Variant<Input, Config, string> {
  return {
    variantId: spec.variantId,
    artifact: spec.artifact,
    execution: {
      executor: declaration,
      ...('runtimeContext' in spec ? { runtimeContext: spec.runtimeContext } : {}),
      config: spec.config,
    },
  };
}

export const fixedClock: Clock = {
  monotonicNow: () => 0,
  timestamp: () => '2026-09-04T00:00:00.000Z',
  sleep: () => Promise.resolve(),
};

export function pairedInput(
  declaration: Executor<Input, Config, string> = executor(),
) {
  return {
    dataset: {
      datasetId: 'answers',
      samples: [
        { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
        { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
      ],
    },
    variants: [variant(declaration, controlSpec), variant(declaration, treatmentSpec)],
    evaluators: [{ evaluatorKind: 'exact-match' as const }],
    comparisons: [{
      comparisonId: 'baseline-vs-candidate',
      controlVariantId: controlSpec.variantId,
      treatmentVariantIds: [treatmentSpec.variantId],
      metricIds: ['correct'],
    }],
    analyses: [{
      analysisId: 'baseline-vs-candidate-correct',
      analysisKind: 'comparison-interval' as const,
      statistic: 'mean-difference' as const,
      comparisonId: 'baseline-vs-candidate',
      treatmentVariantId: treatmentSpec.variantId,
      metricId: 'correct',
      confidence: {
        method: 'percentile-bootstrap' as const,
        level: 0.95,
        resamples: 100,
      },
    }],
    experiment: {
      seed: 'fixed-seed',
      sampling: { samplingKind: 'paired' as const },
    },
    decision: {
      decisionKind: 'analysis' as const,
      analysisId: 'baseline-vs-candidate-correct',
    },
    policy: {
      execution: { maxConcurrency: 2 },
      evaluation: { maxConcurrency: 2 },
    },
  };
}

export function comparisonAnalysis(metricId: string, analysisId = `${metricId}-difference`) {
  return [{
    analysisId,
    analysisKind: 'comparison-interval' as const,
    statistic: 'mean-difference' as const,
    comparisonId: 'baseline-vs-candidate',
    treatmentVariantId: treatmentSpec.variantId,
    metricId,
    confidence: {
      method: 'percentile-bootstrap' as const,
      level: 0.95,
      resamples: 100,
    },
  }];
}

export function countedScoreInput(
  declaration: Executor<Input, Config, string>,
  scoreCalls: () => void,
) {
  const custom = numericCustomEvaluator('staged-score', () => {
    scoreCalls();
    return {
      resultKind: 'completed',
      results: [{ metricId: 'staged-score-score', resultKind: 'score', value: 1 }],
    };
  });
  const base = pairedInput(declaration);
  return {
    ...base,
    evaluators: [custom],
    comparisons: [{
      comparisonId: 'baseline-vs-candidate',
      controlVariantId: controlSpec.variantId,
      treatmentVariantIds: [treatmentSpec.variantId],
      metricIds: ['staged-score-score'],
    }],
    analyses: comparisonAnalysis('staged-score-score'),
    decision: {
      decisionKind: 'analysis' as const,
      analysisId: 'staged-score-score-difference',
    },
  };
}

export function numericCustomEvaluator(
  evaluatorId: string,
  callback: CustomEvaluator<{ actual: string; }>['implementation']['evaluate'],
  revision = 'test-one',
): CustomEvaluator<{ actual: string; }> {
  return {
    evaluatorKind: 'custom',
    evaluatorId,
    instrumentId: `${evaluatorId}-v1`,
    metrics: [{
      metricId: `${evaluatorId}-score`,
      valueType: 'numeric',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    }],
    bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
    implementation: {
      implementationId: `test.${evaluatorId}/v1`,
      version: '1.0.0',
      schemas: {
        bindings: z.object({ actual: z.string() }).strict(),
        values: { [`${evaluatorId}-score`]: z.number() },
        fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
      },
      fingerprintFacets: { revision },
      evaluate: callback,
    },
  };
}

export function qualitativeCustomEvaluator(
  evaluatorId: string,
  valueType: 'categorical' | 'text' | 'ranking',
  valueParser: Readonly<{ parse(value: unknown): JsonValue; }>,
  callback: CustomEvaluator<{ actual: string; }>['implementation']['evaluate'],
): CustomEvaluator<{ actual: string; }> {
  return {
    evaluatorKind: 'custom',
    evaluatorId,
    instrumentId: `${evaluatorId}-v1`,
    metrics: [{ metricId: `${evaluatorId}-value`, valueType, missingPolicyId: 'exclude/v1' }],
    bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
    implementation: {
      implementationId: `test.${evaluatorId}/v1`,
      version: '1.0.0',
      schemas: {
        bindings: z.object({ actual: z.string() }).strict(),
        values: { [`${evaluatorId}-value`]: valueParser },
        fingerprintFacets: { bindings: 'actual-string/v1', value: `${valueType}/v1` },
      },
      fingerprintFacets: { revision: 'test-one' },
      evaluate: callback,
    },
  };
}

export function stableFacadeId(
  identityKind: 'node' | 'decision' | 'slot',
  selector: Readonly<Record<string, string>>,
): string {
  return `${identityKind}:${digestCanonicalJson({
    derivation: 'omk.eval-runtime.definition-binding/v1',
    selector,
  }).slice('sha256:'.length)}`;
}
