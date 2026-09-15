import { z } from 'zod';
import { IdentifierSchema, JsonPointerSchema, JsonValueSchema } from '../../eval-core/contracts/index.js';
import { captureRubricJudgeCriteria } from '../judges/rubric-judge.js';
import { RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION } from '../judges/rubric-contracts.js';
import type { RubricJudgeEvaluator } from './contracts.js';
import { EvaluationConfigurationError, type EvaluationConfigurationIssue } from './errors.js';
import { MAX_RUBRIC_PANEL_COORDINATES } from './schemas.js';

type Path = readonly (string | number)[];
type Reason = EvaluationConfigurationIssue['reasonCode'];

// Only locally created diagnostics may cross the host-getter boundary unchanged.
class RubricDeclarationError extends EvaluationConfigurationError {}

export function rubricIssue(index: number, path: Path, reasonCode: Reason = 'invalid-value'): never {
  throw new RubricDeclarationError(
    'EVAL_RUNTIME_EVALUATOR_INVALID', 'Rubric 评委配置无效。请查看 issues 中的字段位置。',
    undefined, [{ path: ['evaluators', index, ...path], reasonCode }],
  );
}

/** Only static field paths are exposed; rejected values, keys and exceptions stay private. */
export function rubricAt<T>(index: number, path: Path, read: () => T): T {
  try { return read(); } catch (error) {
    if (error instanceof RubricDeclarationError) throw error;
    return rubricIssue(index, path);
  }
}

export function captureRubricDeclaration(value: RubricJudgeEvaluator, index: number) {
  const at = <T>(path: Path, read: () => T) => rubricAt(index, path, read);
  const keys = (candidate: unknown, allowed: readonly string[], path: Path) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return rubricIssue(index, path);
    if (Object.keys(candidate).some((key) => !allowed.includes(key))) return rubricIssue(index, path, 'unsupported-field');
  };
  const unique = (values: readonly string[], field: (i: number) => Path) => {
    const seen = new Set<string>();
    values.forEach((id, i) => {
      if (seen.has(id)) rubricIssue(index, field(i), 'duplicate-id');
      seen.add(id);
    });
  };
  return at([], () => {
    keys(value, ['evaluatorKind', 'evaluatorId', 'rubrics', 'judges', 'aggregation', 'lengthDebias', 'tracePolicy', 'actualPointer', 'tracePointer', 'classification'], []);
    const panelId = at(['evaluatorId'], () => IdentifierSchema.parse(value.evaluatorId));
    if (!Array.isArray(value.rubrics) || value.rubrics.length === 0) rubricIssue(index, ['rubrics']);
    const criteria = value.rubrics.map((rubric, i) => at(['rubrics', i], () => {
      keys(rubric, ['metricId', 'criterionId', 'prompt', 'rubric'], ['rubrics', i]);
      return {
        schemaVersion: RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
        metricId: at(['rubrics', i, 'metricId'], () => IdentifierSchema.parse(rubric.metricId)),
        criterionId: at(['rubrics', i, 'criterionId'], () => IdentifierSchema.parse(rubric.criterionId)),
        prompt: at(['rubrics', i, 'prompt'], () => z.string().parse(rubric.prompt)),
        rubric: at(['rubrics', i, 'rubric'], () => z.string().refine((text) => text.trim() !== '').parse(rubric.rubric)),
      };
    }));
    for (const field of ['metricId', 'criterionId'] as const) unique(criteria.map((r) => r[field]), (i) => ['rubrics', i, field]);
    const rubrics = captureRubricJudgeCriteria(criteria);
    if (!Array.isArray(value.judges) || value.judges.length === 0 || value.judges.length > MAX_RUBRIC_PANEL_COORDINATES) rubricIssue(index, ['judges']);
    const memberIds: string[] = [];
    const replicateCounts: number[] = [];
    value.judges.forEach((member, i) => at(['judges', i], () => {
      keys(member, ['memberId', 'model', 'judge', 'effort', 'replicateCount'], ['judges', i]);
      memberIds.push(at(['judges', i, 'memberId'], () => IdentifierSchema.parse(member.memberId)));
      at(['judges', i, 'model'], () => z.string().min(1).parse(member.model));
      if (member.effort !== undefined) at(['judges', i, 'effort'], () => z.enum(['low', 'medium', 'high', 'xhigh', 'max']).parse(member.effort));
      replicateCounts.push(at(['judges', i, 'replicateCount'], () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(member.replicateCount ?? 1)));
      at(['judges', i, 'judge', 'invoke'], () => {
        if (typeof member.judge?.invoke !== 'function') rubricIssue(index, ['judges', i, 'judge', 'invoke']);
      });
      at(['judges', i, 'judge', 'judgeId'], () => IdentifierSchema.parse(member.judge.judgeId));
      at(['judges', i, 'judge', 'version'], () => z.string().min(1).parse(member.judge.version));
      at(['judges', i, 'judge', 'providerCost'], () => {
        const cost = member.judge.providerCost;
        z.enum(['unsupported', 'optional', 'required']).parse(cost.reporting);
        if (cost.trustedUpperBound !== undefined) {
          if (cost.reporting !== 'required') rubricIssue(index, ['judges', i, 'judge', 'providerCost']);
          z.number().finite().nonnegative().parse(cost.trustedUpperBound.amount);
          z.string().regex(/^[A-Z]{3}$/).parse(cost.trustedUpperBound.currency);
        }
      });
      if (member.judge.fingerprintFacets !== undefined) at(['judges', i, 'judge', 'fingerprintFacets'], () => JsonValueSchema.parse(member.judge.fingerprintFacets));
    }));
    unique(memberIds, (i) => ['judges', i, 'memberId']);
    if (replicateCounts.reduce((sum, count) => sum + count, 0) > MAX_RUBRIC_PANEL_COORDINATES) rubricIssue(index, ['judges']);
    at(['aggregation'], () => {
      keys(value.aggregation, value.aggregation?.method === 'weighted-mean' ? ['method', 'missing', 'weights'] : ['method', 'missing'], ['aggregation']);
      at(['aggregation', 'method'], () => z.enum(['mean', 'weighted-mean']).parse(value.aggregation.method));
      at(['aggregation', 'missing'], () => z.literal('require-complete').parse(value.aggregation.missing));
    });
    const weights = value.aggregation.method === 'weighted-mean' ? value.aggregation.weights : undefined;
    if (value.aggregation.method === 'weighted-mean') at(['aggregation', 'weights'], () => {
      if (weights === null || typeof weights !== 'object' || Array.isArray(weights)) rubricIssue(index, ['aggregation', 'weights']);
      if (Object.keys(weights).length !== memberIds.length || memberIds.some((id) => !Object.hasOwn(weights, id))) rubricIssue(index, ['aggregation', 'weights']);
      if (memberIds.some((id) => typeof weights[id] !== 'number' || !Number.isFinite(weights[id]) || weights[id] <= 0)
          || Math.abs(memberIds.reduce((sum, id) => sum + weights[id], 0) - 1) > 1e-12) rubricIssue(index, ['aggregation', 'weights']);
    });
    if (value.lengthDebias !== undefined) at(['lengthDebias'], () => z.boolean().parse(value.lengthDebias));
    if (value.tracePolicy !== undefined) at(['tracePolicy'], () => z.enum(['none', 'source-neutral']).parse(value.tracePolicy));
    if (value.classification !== undefined) at(['classification'], () => z.enum(['public', 'sensitive']).parse(value.classification));
    for (const field of ['actualPointer', 'tracePointer'] as const) if (value[field] !== undefined) at([field], () => JsonPointerSchema.parse(value[field]));
    return { panelId, rubrics, metricIds: rubrics.map((r) => r.metricId), panelJudges: value.judges, memberIds, replicateCounts, weights };
  });
}
