import { IdentifierSchema } from '../../eval-core/contracts/index.js';
import type { Rubric, RubricJudgeEvaluator } from '../evaluation/contracts.js';
import { captureJudge } from '../evaluation/capture-judge.js';
import { EvaluationConfigurationError } from '../evaluation/errors.js';
import { captureRubricDeclaration, rubricAt, rubricIssue } from '../evaluation/rubric-declaration.js';

/** Rubric map keys are metric IDs; all measurement choices retain the standard contract. */
export type CreateRubricEvaluatorInput = Omit<RubricJudgeEvaluator, 'evaluatorKind' | 'rubrics'> & Readonly<{
  rubrics: Readonly<Record<string, Rubric>>;
}>;

/** Validates without invoking a provider and returns a standard Rubric declaration. */
export function createRubricEvaluator(input: Readonly<CreateRubricEvaluatorInput>): RubricJudgeEvaluator {
  let metricIds: string[] = [];
  try {
    return rubricAt(0, [], () => {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) rubricIssue(0, []);
      if (Object.hasOwn(input, 'evaluatorKind')) rubricIssue(0, [], 'unsupported-field');
      const source = rubricAt(0, ['rubrics'], () => input.rubrics);
      if (source === null || typeof source !== 'object' || Array.isArray(source)) rubricIssue(0, ['rubrics']);
      metricIds = Object.keys(source);
      // Invalid map keys are rejected at the map itself rather than copied into diagnostics.
      if (metricIds.some((id) => !IdentifierSchema.safeParse(id).success)) rubricIssue(0, ['rubrics']);
      const rubrics = metricIds.map((metricId, index) => rubricAt(0, ['rubrics', index], () => {
        const rubric = source[metricId];
        if (rubric === null || typeof rubric !== 'object' || Array.isArray(rubric)) rubricIssue(0, ['rubrics', index]);
        if (Object.keys(rubric).some((key) => !['criterionId', 'prompt', 'rubric'].includes(key))) {
          rubricIssue(0, ['rubrics', index], 'unsupported-field');
        }
        return { ...rubric, metricId };
      }));
      const evaluator: RubricJudgeEvaluator = { ...input, evaluatorKind: 'rubric-judge', rubrics };
      const { panelJudges } = captureRubricDeclaration(evaluator, 0);
      panelJudges.forEach((member, index) => rubricAt(0, ['judges', index, 'judge'], () => captureJudge(member.judge)));
      return evaluator;
    });
  } catch (error) {
    // rubricAt wraps host exceptions before their fields can enter this public error.
    throw new EvaluationConfigurationError(
      'EVAL_RUNTIME_EVALUATOR_INVALID', 'Rubric 评委配置无效。请查看 issues 中的字段位置。', undefined,
      error instanceof EvaluationConfigurationError ? error.issues.map((issue) => {
        const [, , root, index, ...rest] = issue.path;
        const path = root === 'rubrics' && typeof index === 'number'
          ? ['rubrics', metricIds[index], ...rest]
          : issue.path.slice(2);
        return { ...issue, path };
      }) : [],
    );
  }
}
