export const EVALUATION_CORE_JSON_SCHEMA_FILES = Object.freeze([
  'analysis-bundle.schema.json',
  'analysis-plan.schema.json',
  'budget-summary.schema.json',
  'comparability-assessment.schema.json',
  'comparability-policy.schema.json',
  'decision-plan.schema.json',
  'evaluation-bundle.schema.json',
  'evaluation-definition.schema.json',
  'evaluation-event.schema.json',
  'evaluation-plan.schema.json',
  'evaluation-report.schema.json',
  'evaluation-series-definition.schema.json',
  'evaluation-series-plan.schema.json',
  'evaluation-series-report.schema.json',
  'execution-bundle.schema.json',
  'execution-facts.schema.json',
  'execution-plan.schema.json',
  'executor-capabilities.schema.json',
  'measurement-policy.schema.json',
  'run-plan.schema.json',
  'series-analysis-bundle.schema.json',
] as const);

export type EvaluationCoreJsonSchemaFile =
  typeof EVALUATION_CORE_JSON_SCHEMA_FILES[number];

export function evaluationCoreJsonSchemaLocation(
  fileName: EvaluationCoreJsonSchemaFile,
): `v${number}/${EvaluationCoreJsonSchemaFile}` {
  if (fileName === 'evaluation-definition.schema.json'
    || fileName === 'run-plan.schema.json') {
    return `v5/${fileName}`;
  }
  if (fileName === 'execution-plan.schema.json') {
    return `v4/${fileName}`;
  }
  if (fileName === 'analysis-plan.schema.json') {
    return `v3/${fileName}`;
  }
  return fileName === 'analysis-bundle.schema.json'
    || fileName === 'comparability-assessment.schema.json'
    || fileName === 'evaluation-report.schema.json'
    || fileName === 'series-analysis-bundle.schema.json'
    ? `v2/${fileName}`
    : `v1/${fileName}`;
}
