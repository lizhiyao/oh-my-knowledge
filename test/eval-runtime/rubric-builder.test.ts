import { describe, expect, it, vi } from 'vitest';
import { createRubricEvaluator, EvaluationConfigurationError, type CreateRubricEvaluatorInput, type Judge } from '../../src/eval-runtime/index.js';

const rubric = { criterionId: 'criterion', prompt: '  原样保留\n', rubric: '  1～5 分\n' };
function input(): CreateRubricEvaluatorInput {
  return {
    evaluatorId: 'quality', rubrics: { accuracy: rubric },
    judges: [{ memberId: 'primary', model: 'fixture', judge: {
      judgeId: 'fixture', version: '1', providerCost: { reporting: 'optional' }, invoke: vi.fn<Judge['invoke']>(),
    } }],
    aggregation: { method: 'mean', missing: 'require-complete' },
  };
}

describe('createRubricEvaluator', () => {
  it('only expands map keys and the discriminator, preserving explicit measurement choices without invoking the provider', () => {
    const source = { ...input(), rubrics: Object.fromEntries([
      ['__proto__', rubric], ['constructor', { ...rubric, criterionId: 'other' }],
    ]) };
    const evaluator = createRubricEvaluator(source);
    expect(evaluator).toEqual({ ...source, evaluatorKind: 'rubric-judge', rubrics: [
      { ...rubric, metricId: '__proto__' }, { ...rubric, criterionId: 'other', metricId: 'constructor' },
    ] });
    expect(evaluator.judges[0].judge.invoke).toBe(source.judges[0].judge.invoke);
    expect(source.judges[0].judge.invoke).not.toHaveBeenCalled();
    expect(evaluator).not.toHaveProperty('lengthDebias');
    expect(evaluator).not.toHaveProperty('tracePolicy');
    expect(evaluator.judges[0]).not.toHaveProperty('replicateCount');
    expect(source.rubrics.accuracy).toBeUndefined();
    expect(rubric).not.toHaveProperty('metricId');
  });

  it('reports input-relative keyed paths, rejects shadowed IDs and redacts hostile getter errors before any provider call', () => {
    const source = input();
    const hostile = { ...rubric };
    Object.defineProperty(hostile, 'prompt', { enumerable: true, get() {
      throw new EvaluationConfigurationError('EVAL_RUNTIME_EVALUATOR_INVALID', 'secret-host-message', undefined, [{ path: ['secret-host-path'], reasonCode: 'invalid-value' }]);
    } });
    const cases: Array<[unknown, (string | number)[]]> = [
      [null, []],
      [{ ...source, rubrics: [] }, ['rubrics']],
      [{ ...source, rubrics: {} }, ['rubrics']],
      [{ ...source, rubrics: { ['secret-invalid-key'.repeat(30)]: rubric } }, ['rubrics']],
      [{ ...source, rubrics: { accuracy: null } }, ['rubrics', 'accuracy']],
      [{ ...source, rubrics: { accuracy: { ...rubric, rubric: '' } } }, ['rubrics', 'accuracy', 'rubric']],
      [{ ...source, rubrics: { accuracy: rubric, clarity: rubric } }, ['rubrics', 'clarity', 'criterionId']],
      [{ ...source, rubrics: { accuracy: { ...rubric, metricId: 'secret-shadow-id' } } }, ['rubrics', 'accuracy']],
      [{ ...source, rubrics: { accuracy: { ...rubric, 'secret-extra-key': true } } }, ['rubrics', 'accuracy']],
      [{ ...source, rubrics: { accuracy: hostile } }, ['rubrics', 'accuracy']],
      [{ ...source, evaluatorKind: 'rubric-judge' }, []],
      [{ ...source, 'secret-extra-key': true }, []],
      [{ ...source, judges: [{ ...source.judges[0], model: '' }] }, ['judges', 0, 'model']],
      [{ ...source, judges: [{ ...source.judges[0], judge: { ...source.judges[0].judge, providerCost: { reporting: 'optional', uncloneable: () => {} } } }] }, ['judges', 0, 'judge']],
      [{ ...source, aggregation: undefined }, ['aggregation']],
      [{ ...source, aggregation: { method: 'weighted-mean', missing: 'require-complete', weights: { primary: 0.5 } } }, ['aggregation', 'weights']],
      [{ ...source, actualPointer: 'secret-bad-pointer' }, ['actualPointer']],
    ];
    for (const [invalid, path] of cases) {
      let failure: unknown;
      try { createRubricEvaluator(invalid as CreateRubricEvaluatorInput); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(EvaluationConfigurationError);
      expect(failure).toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID', issues: [{ path }] });
      expect(JSON.stringify(failure)).not.toContain('secret-');
      expect(String(failure)).not.toContain('secret-');
    }
    expect(source.judges[0].judge.invoke).not.toHaveBeenCalled();
  });
});
