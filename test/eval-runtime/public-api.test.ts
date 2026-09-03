import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PUBLIC_API = {
  'eval-runtime': {
    entry: 'index',
    values: [
      'EvaluationEventConsumptionError',
      'EvaluationRuntimeAssemblyError',
      'RuntimeConformanceError',
      'assertExecutorConformance',
      'createEvaluationEngine',
      'createEvaluationRuntime',
      'createExactMatchDefinition',
      'createExactMatchEvaluator',
      'createInvokeExecutorIdentity',
      'createJsonExecutorAdapter',
      'createMeasurementPolicy',
      'createPairedComparisonDefinition',
      'createRubricJudgeEvaluationContext',
      'createRubricJudgeKit',
      'createRubricJudgeRegistration',
      'createRuntimeIdentity',
      'runEvaluation',
      'runExecutorConformance',
    ],
    types: [
      'CreateEvaluationRuntimeInput',
      'CreateExactMatchEvaluatorInput',
      'CreateJsonExecutorAdapterInput',
      'CreateRubricJudgeKitInput',
      'EvaluationEventObserver',
      'EvaluationRuntimeTarget',
      'ExactMatchDefinitionBuilderInput',
      'ExactMatchTarget',
      'ExecutorConformanceProbeInput',
      'ExecutorConformanceResult',
      'InvokeExecutorIdentityDeclaration',
      'JsonExecutorInvocation',
      'JsonExecutorInvocationResult',
      'MeasurementPolicyBuilderInput',
      'OmkLlmJudgeEffort',
      'OmkLlmJudgeInvocationPort',
      'OmkLlmJudgeInvocationRequest',
      'OmkLlmJudgeInvocationResult',
      'PairedComparisonDefinitionBuilderInput',
      'RubricJudgeKit',
      'RunEvaluationInput',
      'RuntimeConformanceCheck',
      'RuntimeIdentityDeclaration',
      'RuntimeValueParser',
    ],
  },
  'eval-runtime/advanced': {
    entry: 'advanced',
    values: [
      'EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID',
      'INVOKE_JSON_INPUT_SCHEMA',
      'INVOKE_JSON_OUTPUT_SCHEMA',
      'INVOKE_JSON_TRACE_SCHEMA',
      'createExactMatchEvaluatorIdentity',
      'createExecutorFnAdapter',
      'createNodeEvaluationClock',
      'createRubricJudgeCriterion',
      'createRubricJudgeEvaluator',
      'createRubricJudgeEvaluatorDefinition',
      'createRubricJudgeEvaluatorIdentity',
      'createRubricJudgeEvaluatorRegistration',
      'createRubricJudgeInstrument',
      'createRubricJudgeMetricDefinition',
      'createRubricJudgeRuntimeConfig',
      'createSameProcessEvaluatorAdapter',
      'createSameProcessExecutorAdapter',
      'rubricJudgeInstrumentId',
    ],
    types: [
      'CreateExecutorFnAdapterInput',
      'CreateRubricJudgeEvaluatorInput',
      'CreateSameProcessEvaluatorAdapterInput',
      'CreateSameProcessExecutorAdapterInput',
      'EvaluationRuntimeSupportPorts',
      'ExecResult',
      'ExecutorFn',
      'ExecutorFnInputMapper',
      'ExecutorFnResultMapper',
      'ExecutorInput',
      'RubricJudgeEvaluatorBinding',
      'RubricJudgeEvaluatorDefinitionBuilderInput',
      'RuntimePortRegistration',
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
