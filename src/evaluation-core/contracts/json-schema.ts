import { z } from 'zod';
import {
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  AnalysisBundleSchema,
  EVALUATION_BUNDLE_SCHEMA_VERSION,
  EVALUATION_EVENT_SCHEMA_VERSION,
  EVALUATION_REPORT_SCHEMA_VERSION,
  EXECUTION_BUNDLE_SCHEMA_VERSION,
  EvaluationBundleSchema,
  EvaluationEventSchema,
  EvaluationReportSchema,
  ExecutionBundleSchema,
} from './artifacts.js';
import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  EvaluationDefinitionSchema,
  MEASUREMENT_POLICY_SCHEMA_VERSION,
  MeasurementPolicySchema,
} from './definition.js';
import { digestCanonicalJson, type JsonValue } from './json.js';
import {
  ANALYSIS_PLAN_SCHEMA_VERSION,
  AnalysisPlanSchema,
  DECISION_PLAN_SCHEMA_VERSION,
  DecisionPlanSchema,
  EVALUATION_PLAN_SCHEMA_VERSION,
  EXECUTION_PLAN_SCHEMA_VERSION,
  EvaluationPlanSchema,
  ExecutionPlanSchema,
  RUN_PLAN_SCHEMA_VERSION,
  RunPlanSchema,
} from './plans.js';
import type { SchemaIdentity } from './common.js';
import {
  COMPARABILITY_ASSESSMENT_SCHEMA_VERSION,
  COMPARABILITY_POLICY_SCHEMA_VERSION,
  ComparabilityAssessmentSchema,
  ComparabilityPolicySchema,
} from './comparability.js';
import {
  EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION,
  EVALUATION_SERIES_PLAN_SCHEMA_VERSION,
  EVALUATION_SERIES_REPORT_SCHEMA_VERSION,
  EvaluationSeriesDefinitionSchema,
  EvaluationSeriesPlanSchema,
  EvaluationSeriesReportSchema,
  SERIES_ANALYSIS_BUNDLE_SCHEMA_VERSION,
  SeriesAnalysisBundleSchema,
} from './series.js';

export interface WireSchemaCatalogEntry {
  fileName: string;
  schemaVersion: string;
  schema: z.ZodType;
  includedInRunContract?: false;
}

export const WIRE_SCHEMA_CATALOG: readonly WireSchemaCatalogEntry[] = [
  {
    fileName: 'evaluation-definition.schema.json',
    schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
    schema: EvaluationDefinitionSchema,
  },
  {
    fileName: 'measurement-policy.schema.json',
    schemaVersion: MEASUREMENT_POLICY_SCHEMA_VERSION,
    schema: MeasurementPolicySchema,
  },
  {
    fileName: 'execution-plan.schema.json',
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    schema: ExecutionPlanSchema,
  },
  {
    fileName: 'evaluation-plan.schema.json',
    schemaVersion: EVALUATION_PLAN_SCHEMA_VERSION,
    schema: EvaluationPlanSchema,
  },
  {
    fileName: 'analysis-plan.schema.json',
    schemaVersion: ANALYSIS_PLAN_SCHEMA_VERSION,
    schema: AnalysisPlanSchema,
  },
  {
    fileName: 'decision-plan.schema.json',
    schemaVersion: DECISION_PLAN_SCHEMA_VERSION,
    schema: DecisionPlanSchema,
  },
  {
    fileName: 'run-plan.schema.json',
    schemaVersion: RUN_PLAN_SCHEMA_VERSION,
    schema: RunPlanSchema,
  },
  {
    fileName: 'comparability-policy.schema.json',
    schemaVersion: COMPARABILITY_POLICY_SCHEMA_VERSION,
    schema: ComparabilityPolicySchema,
    includedInRunContract: false,
  },
  {
    fileName: 'comparability-assessment.schema.json',
    schemaVersion: COMPARABILITY_ASSESSMENT_SCHEMA_VERSION,
    schema: ComparabilityAssessmentSchema,
    includedInRunContract: false,
  },
  {
    fileName: 'evaluation-event.schema.json',
    schemaVersion: EVALUATION_EVENT_SCHEMA_VERSION,
    schema: EvaluationEventSchema,
  },
  {
    fileName: 'execution-bundle.schema.json',
    schemaVersion: EXECUTION_BUNDLE_SCHEMA_VERSION,
    schema: ExecutionBundleSchema,
  },
  {
    fileName: 'evaluation-bundle.schema.json',
    schemaVersion: EVALUATION_BUNDLE_SCHEMA_VERSION,
    schema: EvaluationBundleSchema,
  },
  {
    fileName: 'analysis-bundle.schema.json',
    schemaVersion: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    schema: AnalysisBundleSchema,
  },
  {
    fileName: 'evaluation-report.schema.json',
    schemaVersion: EVALUATION_REPORT_SCHEMA_VERSION,
    schema: EvaluationReportSchema,
  },
  {
    fileName: 'evaluation-series-definition.schema.json',
    schemaVersion: EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION,
    schema: EvaluationSeriesDefinitionSchema,
    includedInRunContract: false,
  },
  {
    fileName: 'evaluation-series-plan.schema.json',
    schemaVersion: EVALUATION_SERIES_PLAN_SCHEMA_VERSION,
    schema: EvaluationSeriesPlanSchema,
    includedInRunContract: false,
  },
  {
    fileName: 'series-analysis-bundle.schema.json',
    schemaVersion: SERIES_ANALYSIS_BUNDLE_SCHEMA_VERSION,
    schema: SeriesAnalysisBundleSchema,
    includedInRunContract: false,
  },
  {
    fileName: 'evaluation-series-report.schema.json',
    schemaVersion: EVALUATION_SERIES_REPORT_SCHEMA_VERSION,
    schema: EvaluationSeriesReportSchema,
    includedInRunContract: false,
  },
] as const;

const SCHEMA_BASE_URI = 'https://raw.githubusercontent.com/lizhiyao/oh-my-knowledge/main/schemas/evaluation-core/v1';

function assertNoEmptySchemaNode(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoEmptySchemaNode(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error(`JSON Schema generation produced an unconstrained {} node at ${path}`);
  }
  entries.forEach(([key, entry]) => assertNoEmptySchemaNode(entry, `${path}/${key}`));
}

export function generateWireJsonSchemas(): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(WIRE_SCHEMA_CATALOG.map((entry) => {
    const generated = z.toJSONSchema(entry.schema, {
      target: 'draft-2020-12',
      unrepresentable: 'throw',
      cycles: 'ref',
      reused: 'ref',
    });
    const schemaUri = `${SCHEMA_BASE_URI}/${entry.fileName}`;
    const schema = { ...generated, $id: schemaUri };
    assertNoEmptySchemaNode(schema);
    return [entry.fileName, schema as unknown as JsonValue];
  }));
}

export function generateWireSchemaIdentities(): SchemaIdentity[] {
  const schemas = generateWireJsonSchemas();
  return WIRE_SCHEMA_CATALOG.map((entry) => {
    const schema = schemas[entry.fileName] as Record<string, JsonValue>;
    const schemaUri = schema.$id;
    if (typeof schemaUri !== 'string') {
      throw new Error(`${entry.fileName} does not declare a JSON Schema $id`);
    }
    return {
      schemaVersion: entry.schemaVersion,
      schemaUri,
      schemaDigest: digestCanonicalJson(schema),
    };
  });
}

export function generateRunContractSchemaIdentities(): SchemaIdentity[] {
  const identities = new Map(generateWireSchemaIdentities().map((identity) => [
    identity.schemaVersion,
    identity,
  ]));
  return WIRE_SCHEMA_CATALOG
    .filter((entry) => entry.includedInRunContract !== false)
    .map((entry) => {
      const identity = identities.get(entry.schemaVersion);
      if (identity === undefined) {
        throw new Error(`Missing generated schema identity for ${entry.schemaVersion}`);
      }
      return identity;
    });
}
