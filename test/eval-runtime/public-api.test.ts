import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type {
  AnalysisRequest,
  CohortFilter,
  CustomEvaluator,
  SamplingDesign,
} from '../../src/eval-runtime/index.js';

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
void incompleteQuantile;
void emptyCohortFilter;

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

const PUBLIC_API = {
  'eval-runtime': {
    entry: 'index',
    values: [
      'EvaluationConfigurationError',
      'EvaluationEventConsumptionError',
      'checkExecutor',
      'evaluate',
    ],
    types: [
      'Artifact',
      'ArtifactKind',
      'ArtifactSource',
      'Analysis',
      'AnalysisRequest',
      'Clock',
      'CohortFilter',
      'Comparison',
      'CustomEvaluator',
      'CustomEvaluatorBinding',
      'CustomEvaluatorContent',
      'CustomEvaluatorInvocation',
      'CustomEvaluatorResult',
      'Dataset',
      'Decision',
      'EvaluateInput',
      'EvaluationResult',
      'Evaluator',
      'EventObserver',
      'ExactMatchEvaluator',
      'Executor',
      'ExecutorCapabilities',
      'ExecutorCheckInput',
      'ExecutorCheckResult',
      'ExecutorInvocation',
      'ExecutorResult',
      'Experiment',
      'Judge',
      'Metric',
      'Policy',
      'Rubric',
      'RubricJudgeAggregation',
      'RubricJudgeEvaluator',
      'RubricJudgeMember',
      'RuntimeConformanceCheck',
      'RuntimeContext',
      'Sample',
      'SamplingDesign',
      'Variant',
      'VariantExecution',
    ],
  },
  'eval-runtime/advanced': {
    entry: 'advanced',
    values: [
      'EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID',
      'EvaluationEventConsumptionError',
      'EvaluationRuntimeAssemblyError',
      'INVOKE_JSON_INPUT_SCHEMA',
      'INVOKE_JSON_OUTPUT_SCHEMA',
      'INVOKE_JSON_TRACE_SCHEMA',
      'RuntimeConformanceError',
      'assertExecutorConformance',
      'createEvaluationRuntime',
      'createExactMatchDefinition',
      'createExactMatchEvaluator',
      'createExactMatchEvaluatorIdentity',
      'createExecutorFnAdapter',
      'createInvokeExecutorIdentity',
      'createJsonExecutorAdapter',
      'createMeasurementPolicy',
      'createNodeEvaluationClock',
      'createPairedComparisonDefinition',
      'createRubricJudgeCriterion',
      'createRubricJudgeEvaluationContext',
      'createRubricJudgeEvaluator',
      'createRubricJudgeEvaluatorDefinition',
      'createRubricJudgeEvaluatorIdentity',
      'createRubricJudgeEvaluatorRegistration',
      'createRubricJudgeInstrument',
      'createRubricJudgeKit',
      'createRubricJudgeMetricDefinition',
      'createRubricJudgeRegistration',
      'createRubricJudgeRuntimeConfig',
      'createRuntimeIdentity',
      'createSameProcessEvaluatorAdapter',
      'createSameProcessExecutorAdapter',
      'rubricJudgeInstrumentId',
      'runEvaluation',
      'runExecutorConformance',
    ],
    types: [
      'CreateEvaluationRuntimeInput',
      'CreateExactMatchEvaluatorInput',
      'CreateExecutorFnAdapterInput',
      'CreateJsonExecutorAdapterInput',
      'CreateRubricJudgeKitInput',
      'CreateRubricJudgeEvaluatorInput',
      'CreateSameProcessEvaluatorAdapterInput',
      'CreateSameProcessExecutorAdapterInput',
      'EvaluationEventObserver',
      'EvaluationRuntimeSupportPorts',
      'EvaluationRuntimeTarget',
      'ExecResult',
      'ExactMatchDefinitionBuilderInput',
      'ExactMatchTarget',
      'ExecutorFn',
      'ExecutorFnInputMapper',
      'ExecutorFnResultMapper',
      'ExecutorInput',
      'ExecutorConformanceProbeInput',
      'ExecutorConformanceResult',
      'InvokeExecutorIdentityDeclaration',
      'JsonExecutorInvocation',
      'JsonExecutorInvocationResult',
      'MeasurementEventDeliveryInput',
      'MeasurementPolicyBuilderInput',
      'OmkLlmJudgeEffort',
      'OmkLlmJudgeInvocationPort',
      'OmkLlmJudgeInvocationRequest',
      'OmkLlmJudgeInvocationResult',
      'PairedComparisonDefinitionBuilderInput',
      'RubricJudgeEvaluatorBinding',
      'RubricJudgeEvaluatorDefinitionBuilderInput',
      'RubricJudgeKit',
      'RunEvaluationInput',
      'RuntimeConformanceCheck',
      'RuntimeIdentityDeclaration',
      'RuntimePortRegistration',
      'RuntimeValueParser',
      'SameProcessEvaluatorImplementation',
      'SameProcessExecutorImplementation',
      'SameProcessOperationScope',
      'SameProcessResourceLeaseAccess',
      'SameProcessRunScope',
    ],
  },
  'eval-runtime/contracts': {
    entry: 'contracts',
    values: [
      'RUBRIC_JUDGE_BINDINGS',
      'RUBRIC_JUDGE_CONTEXT_SCHEMA',
      'RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION',
      'RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID',
      'RUBRIC_JUDGE_EVIDENCE_SCHEMA',
      'RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION',
      'RUBRIC_JUDGE_INSTRUMENT_SCHEMA',
      'RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION',
      'SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR',
      'SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION',
      'SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR',
      'SourceNeutralMockStatsSchema',
      'SourceNeutralTraceSchema',
      'SourceNeutralTraceWithoutMocksSchema',
      'attachSourceNeutralMockStats',
      'parseSourceNeutralTrace',
    ],
    types: [
      'RubricJudgeConfig',
      'RubricJudgeCriterion',
      'RubricJudgeInstrument',
      'RubricJudgeRuntimeConfig',
      'RubricJudgeTracePolicy',
      'SourceNeutralMockStats',
      'SourceNeutralTrace',
    ],
  },
} as const;

function declarationExports(entry: string): { values: string[]; types: string[] } {
  const file = resolve(`dist/eval-runtime/${entry}.d.ts`);
  if (!existsSync(file)) throw new Error(`缺少 ${file}；请先运行 yarn build。`);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const values: string[] = [];
  const types: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)
        || statement.exportClause === undefined
        || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      (statement.isTypeOnly || element.isTypeOnly ? types : values).push(element.name.text);
    }
  }
  return { values: values.sort(), types: types.sort() };
}

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
