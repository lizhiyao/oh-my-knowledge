import { describe, expect, it } from 'vitest';
import { EvaluationPortFailure } from '../../src/eval-core/evaluation/index.js';
import {
  createRubricJudgeEvaluationContext,
  createRubricJudgeKit,
  createRubricJudgeRegistration,
  createRuntimeIdentity,
} from '../../src/eval-runtime/advanced.js';
import {
  createRubricJudgeCriterion,
  createRubricJudgeEvaluator,
  createRubricJudgeEvaluatorDefinition,
  createRubricJudgeInstrument,
  createRubricJudgeMetricDefinition,
  createRubricJudgeRuntimeConfig,
} from '../../src/eval-runtime/advanced.js';
import {
  SourceNeutralTraceSchema,
} from '../../src/eval-runtime/contracts.js';
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
  it('creates the same frozen Core fragments and Runtime identity as manual assembly', () => {
    const invocation = {
      identity: gatewayIdentity(),
      providerCost: { reporting: 'unsupported' as const },
      invoke: async () => ({ invocationStatus: 'completed' as const, output: '{}' }),
    };
    const kit = createRubricJudgeKit({
      evaluatorId: 'correctness-judge',
      metricId: 'correctness-score',
      model: 'judge-model',
      effort: 'low',
      invocation,
      lengthDebias: false,
      actualPointer: '/answer',
    });
    const instrument = createRubricJudgeInstrument({ lengthDebias: false });
    const runtime = createRubricJudgeRuntimeConfig({
      executorId: invocation.identity.implementationId,
      model: 'judge-model',
      effort: 'low',
      instrument,
    });
    const evaluatorDefinition = createRubricJudgeEvaluatorDefinition({
      evaluatorId: 'correctness-judge',
      metricId: 'correctness-score',
      instrument,
      runtime,
      criterionPointer: '/rubricJudge/correctness-judge',
      actualPointer: '/answer',
    });

    expect(kit.instrument).toEqual(instrument);
    expect(kit.runtime).toEqual(runtime);
    expect(kit.evaluatorDefinition).toEqual(evaluatorDefinition);
    expect(kit.metricDefinition).toEqual(
      createRubricJudgeMetricDefinition('correctness-score'),
    );
    const criterion = kit.createCriterion({
      criterionId: 'correctness',
      prompt: 'Answer.',
      rubric: 'Be correct.',
    });
    expect(criterion).toEqual(createRubricJudgeCriterion({
      criterionId: 'correctness',
      prompt: 'Answer.',
      rubric: 'Be correct.',
    }));
    expect(kit.createEvaluationContext(criterion)).toEqual({
      rubricJudge: { 'correctness-judge': criterion },
    });
    expect(Object.isFrozen(kit)).toBe(true);

    if (kit.evaluatorRegistration.createPort === undefined) {
      throw new Error('Expected a Rubric Judge evaluator factory.');
    }
    const fromKit = kit.evaluatorRegistration.createPort({
      referenceId: 'correctness-judge',
      implementationId: 'omk.rubric-judge/v1',
    });
    const manual = createRubricJudgeEvaluator({ instrument, runtime, invocation });
    expect(fromKit.identity).toEqual(manual.identity);
  });

  it('combines sealed kits without exposing or resynchronizing evaluator bindings', () => {
    const invocation = {
      identity: gatewayIdentity(),
      providerCost: { reporting: 'unsupported' as const },
      invoke: async () => ({ invocationStatus: 'completed' as const, output: '{}' }),
    };
    const first = createRubricJudgeKit({
      evaluatorId: 'correctness-judge',
      metricId: 'correctness-score',
      model: 'judge-model',
      invocation,
    });
    const second = createRubricJudgeKit({
      evaluatorId: 'safety-judge',
      metricId: 'safety-score',
      model: 'judge-model',
      invocation,
    });
    const registration = createRubricJudgeRegistration([first, second]);
    const context = createRubricJudgeEvaluationContext([
      {
        kit: first,
        criterion: first.createCriterion({
          criterionId: 'correctness',
          prompt: 'Answer.',
          rubric: 'Be correct.',
        }),
      },
      {
        kit: second,
        criterion: second.createCriterion({
          criterionId: 'safety',
          prompt: 'Answer.',
          rubric: 'Be safe.',
        }),
      },
    ], { tenant: 'test' });
    if (registration.createPort === undefined) {
      throw new Error('Expected a Rubric Judge evaluator factory.');
    }

    expect(registration.createPort({
      referenceId: first.evaluatorDefinition.evaluatorId,
      implementationId: first.evaluatorDefinition.implementationId,
    }).identity).toEqual(registration.createPort({
      referenceId: second.evaluatorDefinition.evaluatorId,
      implementationId: second.evaluatorDefinition.implementationId,
    }).identity);
    expect(context).toMatchObject({
      tenant: 'test',
      rubricJudge: {
        'correctness-judge': { criterionId: 'correctness' },
        'safety-judge': { criterionId: 'safety' },
      },
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => createRubricJudgeEvaluationContext([
      {
        kit: first,
        criterion: first.createCriterion({
          criterionId: 'one',
          prompt: 'Answer.',
          rubric: 'Be correct.',
        }),
      },
      {
        kit: first,
        criterion: first.createCriterion({
          criterionId: 'two',
          prompt: 'Answer.',
          rubric: 'Be safe.',
        }),
      },
    ])).toThrow(/duplicated/);
  });

  it('captures the provider identity and fails closed on evaluator version constraints', () => {
    const originalInvoke = async () => ({ invocationStatus: 'completed' as const, output: '{}' });
    const originalIdentity = gatewayIdentity();
    const invocation = {
      identity: originalIdentity,
      providerCost: { reporting: 'unsupported' as const },
      invoke: originalInvoke,
    };
    const kit = createRubricJudgeKit({
      evaluatorId: 'versioned-judge',
      metricId: 'versioned-score',
      evaluatorVersionConstraint: '^1.0.0',
      satisfiesEvaluatorVersionConstraint: (constraint) => constraint === '^1.0.0',
      model: 'judge-model',
      invocation,
    });
    invocation.invoke = async () => {
      throw new Error('mutated provider method must not run');
    };
    invocation.identity = gatewayIdentity('mutated');
    expect(kit.evaluatorDefinition.versionConstraint).toBe('^1.0.0');
    expect(kit.evaluatorRegistration.satisfiesVersionConstraint?.('^1.0.0')).toBe(true);
    expect(kit.evaluatorRegistration.satisfiesVersionConstraint?.('^2.0.0')).toBe(false);
    if (kit.evaluatorRegistration.createPort === undefined) {
      throw new Error('Expected a Rubric Judge evaluator factory.');
    }
    const evaluator = kit.evaluatorRegistration.createPort({
      referenceId: 'versioned-judge',
      implementationId: 'omk.rubric-judge/v1',
      versionConstraint: '^1.0.0',
    });
    expect(evaluator.identity).toEqual(createRubricJudgeEvaluator({
      instrument: kit.instrument,
      runtime: kit.runtime,
      invocation: {
        identity: originalIdentity,
        providerCost: { reporting: 'unsupported' },
        invoke: originalInvoke,
      },
    }).identity);

    const noVerifier = createRubricJudgeKit({
      evaluatorId: 'unverified-judge',
      metricId: 'unverified-score',
      evaluatorVersionConstraint: '^1.0.0',
      model: 'judge-model',
      invocation,
    });
    expect(noVerifier.evaluatorRegistration.satisfiesVersionConstraint).toBeUndefined();
  });

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
