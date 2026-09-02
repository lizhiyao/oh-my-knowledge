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
