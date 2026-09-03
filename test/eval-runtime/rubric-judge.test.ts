import { describe, expect, it } from 'vitest';
import { EvaluationPortFailure } from '../../src/eval-core/evaluation/index.js';
import {
  createRubricJudgeCriterion,
  createRubricJudgeEvaluator,
  createRubricJudgeEvaluatorDefinition,
  createRubricJudgeInstrument,
  createRubricJudgeMetricDefinition,
  createRubricJudgeRuntimeConfig,
  createRuntimeIdentity,
  SourceNeutralTraceSchema,
} from '../../src/eval-runtime/index.js';
import { isValidToolCallInfo } from '../../src/executors/result-validation.js';
import {
  createRubricJudgeInstrument as createWorkflowInstrument,
} from '../../src/eval-workflows/runtime-adapter/evaluators/rubric-judge.js';

function gatewayIdentity(revision = 'one') {
  return createRuntimeIdentity({
    implementationId: 'test.gateway/v1',
    version: '1.0.0',
    capabilities: { invocation: 'single-call', cancellation: 'cooperative' },
    fingerprintFacets: { revision },
  });
}

describe('public eval-runtime Rubric Judge', () => {
  it('builds deeply immutable Core definition fragments with no hidden defaults', () => {
    const instrument = createRubricJudgeInstrument();
    const runtime = createRubricJudgeRuntimeConfig({
      executorId: gatewayIdentity().implementationId,
      model: 'judge-model',
      instrument,
    });
    const criterion = createRubricJudgeCriterion({
      criterionId: 'correctness',
      prompt: 'Answer.',
      rubric: 'Be correct.',
    });
    const evaluator = createRubricJudgeEvaluatorDefinition({
      evaluatorId: 'correctness-judge',
      metricId: 'correctness-score',
      instrument,
      runtime,
      actualPointer: '/answer',
      criterionPointer: '/correctness',
    });
    const metric = createRubricJudgeMetricDefinition('correctness-score');

    expect({ instrument, runtime, criterion, evaluator, metric }).toMatchObject({
      instrument: {
        schemaVersion: 'omk.rubric-judge-instrument/v1',
        promptId: 'rubric-judge-debias-on',
        tracePolicy: 'none',
      },
      runtime: { promptVariant: 'rubric-judge-debias-on' },
      criterion: { schemaVersion: 'omk.rubric-judge-context/v1' },
      evaluator: {
        evaluatorKind: 'llm-rubric',
        implementationId: 'omk.rubric-judge/v1',
        metricIds: ['correctness-score'],
      },
      metric: {
        valueType: 'numeric',
        scale: { min: 1, max: 5 },
        missingPolicyId: 'exclude/v1',
      },
    });
    expect(Object.isFrozen(evaluator)).toBe(true);
    expect(Object.isFrozen(evaluator.config)).toBe(true);
    expect(evaluator.inputs.map((binding) => binding.bindingId)).toEqual(['actual', 'criterion']);
  });

  it('uses the exact same frozen instrument implementation as the OMK product workflow', () => {
    const options = { lengthDebias: false, tracePolicy: 'source-neutral' as const };
    expect(createRubricJudgeInstrument(options)).toEqual(createWorkflowInstrument(options));
    expect(createRubricJudgeInstrument(options).promptHash).toBe('74be4a6a2439');
  });

  it('fails closed when the invocation identity differs from the sealed runtime', () => {
    const instrument = createRubricJudgeInstrument();
    const runtime = createRubricJudgeRuntimeConfig({
      executorId: gatewayIdentity().implementationId,
      model: 'judge-model',
      instrument,
    });
    expect(() => createRubricJudgeEvaluator({
      instrument,
      runtime,
      invocation: {
        identity: createRuntimeIdentity({
          implementationId: 'test.other-gateway/v1',
          version: '1.0.0',
          capabilities: { invocation: 'single-call' },
          fingerprintFacets: { revision: 'other' },
        }),
        providerCost: { reporting: 'unsupported' },
        invoke: async () => ({ invocationStatus: 'completed', output: '{}' }),
      },
    })).toThrow(expect.objectContaining<Partial<EvaluationPortFailure>>({
      evaluationError: expect.objectContaining({
        code: 'omk-rubric-judge-provider-identity-mismatch',
      }),
    }));
  });

  it('seals provider, model, prompt variant, and invocation revision into identity', () => {
    const instrument = createRubricJudgeInstrument();
    const runtime = createRubricJudgeRuntimeConfig({
      executorId: gatewayIdentity().implementationId,
      model: 'judge-model',
      effort: 'low',
      instrument,
    });
    const create = (revision: string) => createRubricJudgeEvaluator({
      instrument,
      runtime,
      invocation: {
        identity: gatewayIdentity(revision),
        providerCost: { reporting: 'unsupported' as const },
        invoke: async () => ({ invocationStatus: 'completed' as const, output: '{}' }),
      },
    });
    expect(create('one').identity.fingerprint).not.toBe(create('two').identity.fingerprint);
  });

  it('preserves the existing source-neutral Executor trace acceptance boundary', () => {
    const candidates: unknown[] = [
      { tool: 'search', input: { query: 'q' }, output: 'ok', success: true },
      { tool: 'search', input: null, output: null, success: false, status: 'failure' },
      { tool: 'search', input: null, output: null, success: false, status: 'success' },
      { tool: '', input: null, output: null, success: true },
      {
        tool: 'search',
        input: null,
        output: null,
        success: true,
        timestamp: '2026-02-29T00:00:00Z',
      },
    ];
    for (const candidate of candidates) {
      const traceAccepted = SourceNeutralTraceSchema.safeParse({
        schemaVersion: 'omk.source-neutral-trace/v2',
        turns: [],
        toolCalls: [candidate],
        numTurns: 0,
        fullNumTurns: 0,
        numSubAgents: 0,
      }).success;
      expect(traceAccepted).toBe(isValidToolCallInfo(candidate));
    }
  });
});
