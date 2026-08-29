import { z } from 'zod';
import {
  AssumptionCheckSchema,
  IdentifierSchema,
  Sha256DigestSchema,
} from '../contracts/index.js';
import { JsonValueSchema } from '../contracts/json.js';
import type {
  AnalysisBundle,
  AnalysisObservationCoverage,
  AnalysisRecord,
  AssumptionCheck,
  DecisionResult,
  EvaluationBundle,
  EvaluationError,
  EvaluationEvent,
  EvaluationReport,
  JsonValue,
  RuntimeIdentity,
  CoreSchemaValidator,
  SamplingUnitIds,
  SchemaIdentity,
  Sha256Digest,
} from '../contracts/index.js';
import type { SealedRunPlan } from '../compiler/index.js';
import type { RuntimeEventSequencer } from '../runtime/events.js';

export const ANALYSIS_RUNTIME_EVENT_KINDS = [
  'analysis.run.started',
  'analysis.run.completed',
  'analysis.run.cancelled',
  'analysis.run.failed',
  'analysis.node.started',
  'analysis.node.completed',
  'analysis.node.inconclusive',
  'analysis.node.failed',
  'analysis.node.not-evaluated',
  'decision.started',
  'decision.completed',
  'decision.not-decided',
  'decision.failed',
  'report.materialized',
  'report.failed',
] as const;

export type AnalysisRuntimeEventKind = typeof ANALYSIS_RUNTIME_EVENT_KINDS[number];

export type AnalysisMetricRowStatus =
  | 'observed'
  | 'missing'
  | 'invalid'
  | 'evaluation-failed'
  | 'source-unavailable'
  | 'not-started';

interface AnalysisMetricRowBase {
  rowId: Sha256Digest;
  targetId: string;
  sampleId: string;
  trialIndex: number;
  trialId: Sha256Digest;
  evaluatorId: string;
  metricId: string;
  valueType: SealedRunPlan['analysis']['metrics'][number]['valueType'];
  samplingUnitIds: SamplingUnitIds;
  censored: boolean;
}

export type AnalysisMetricRow = AnalysisMetricRowBase & ({
  rowStatus: 'observed';
  value: JsonValue;
} | {
  rowStatus: Exclude<AnalysisMetricRowStatus, 'observed'>;
  reasonCode: string;
});

export type AnalysisNodeInput = {
  inputKind: 'metric-observations';
  referenceId: string;
  metric: SealedRunPlan['analysis']['metrics'][number];
  rows: readonly AnalysisMetricRow[];
} | {
  inputKind: 'analysis-result';
  referenceId: string;
  record: Extract<AnalysisRecord, { analysisStatus: 'completed' }>;
} | {
  inputKind: 'comparison';
  referenceId: string;
  contrast: {
    comparisonId: string;
    controlTargetId: string;
    treatmentTargetId: string;
    metricId: string;
  };
};

export interface AnalysisNodeRunContext {
  runId: string;
  analysisPlanDigest: Sha256Digest;
  evaluationBundleDigest: Sha256Digest;
  analysisMode: 'preregistered' | 'exploratory';
}

export interface AnalysisNodeExecutionContext {
  node: SealedRunPlan['analysis']['analysisGraph']['nodes'][number];
  inputs: readonly AnalysisNodeInput[];
  analysisPlanDigest: Sha256Digest;
  sampling: SealedRunPlan['analysis']['experiment']['sampling'];
  rootSeed: string;
  signal: AbortSignal;
}

export type AnalysisNodeExecutionResult = {
  analysisStatus: 'completed';
  resultType: Extract<AnalysisRecord, { analysisStatus: 'completed' }>['resultType'];
  value: JsonValue;
  includedRowIds?: readonly Sha256Digest[];
  comparableRowIds?: readonly Sha256Digest[];
  assumptionChecks?: readonly Omit<AssumptionCheck, 'nodeId'>[];
} | {
  analysisStatus: 'inconclusive';
  reasonCodes: readonly string[];
  includedRowIds?: readonly Sha256Digest[];
  comparableRowIds?: readonly Sha256Digest[];
  assumptionChecks?: readonly Omit<AssumptionCheck, 'nodeId'>[];
};

const PortAssumptionCheckSchema = AssumptionCheckSchema.omit({ nodeId: true });

export const AnalysisNodeExecutionResultSchema = z.discriminatedUnion('analysisStatus', [
  z.object({
    analysisStatus: z.literal('completed'),
    resultType: z.enum(['scalar', 'interval', 'distribution', 'table', 'matrix', 'curve']),
    value: JsonValueSchema,
    includedRowIds: z.array(Sha256DigestSchema).optional(),
    comparableRowIds: z.array(Sha256DigestSchema).optional(),
    assumptionChecks: z.array(PortAssumptionCheckSchema).optional(),
  }).strict(),
  z.object({
    analysisStatus: z.literal('inconclusive'),
    reasonCodes: z.array(IdentifierSchema).min(1),
    includedRowIds: z.array(Sha256DigestSchema).optional(),
    comparableRowIds: z.array(Sha256DigestSchema).optional(),
    assumptionChecks: z.array(PortAssumptionCheckSchema).optional(),
  }).strict(),
]);

export interface AnalysisNodeRun {
  execute(context: Readonly<AnalysisNodeExecutionContext>): Promise<AnalysisNodeExecutionResult>;
  dispose(): void | Promise<void>;
}

export interface AnalysisNodeImplementation {
  readonly identity: RuntimeIdentity;
  readonly outputSchema: SchemaIdentity;
  openRun(context: Readonly<AnalysisNodeRunContext>): Promise<AnalysisNodeRun>;
}

export interface MissingPolicyContext {
  metric: SealedRunPlan['analysis']['metrics'][number];
  row: Exclude<AnalysisMetricRow, { rowStatus: 'observed' }>;
}

export interface AnalysisMissingPolicy {
  readonly identity: RuntimeIdentity;
  decide(context: Readonly<MissingPolicyContext>): 'exclude' | 'reject';
}

export interface DecisionPolicyContext {
  runId: string;
  policy: NonNullable<SealedRunPlan['decision']['decisionPolicy']>;
  analysisBundleDigest: Sha256Digest;
  analysisCoverage: AnalysisBundle['coverage'];
  results: readonly Extract<AnalysisRecord, { analysisStatus: 'completed' }>[];
  contrasts: readonly {
    analysisResultId: string;
    hypothesisId?: string;
    comparisonId: string;
    controlTargetId: string;
    treatmentTargetId: string;
    metricId: string;
  }[];
  evidenceStatus: 'complete' | 'partial' | 'unresolvable';
  signal: AbortSignal;
}

export type DecisionPolicyOutput = {
  decisionStatus: 'decided';
  verdict: string;
} | {
  decisionStatus: 'not-decided';
  reasonCodes: readonly string[];
};

export const DecisionPolicyOutputSchema = z.discriminatedUnion('decisionStatus', [
  z.object({
    decisionStatus: z.literal('decided'),
    verdict: IdentifierSchema,
  }).strict(),
  z.object({
    decisionStatus: z.literal('not-decided'),
    reasonCodes: z.array(IdentifierSchema).min(1),
  }).strict(),
]);

export interface AnalysisDecisionPolicy {
  readonly identity: RuntimeIdentity;
  decide(context: Readonly<DecisionPolicyContext>): Promise<DecisionPolicyOutput>;
}

export interface AnalysisClock {
  timestamp(): string;
}

export interface AnalysisEventWriter {
  write(event: Readonly<EvaluationEvent>): Promise<void>;
}

export interface AnalysisRuntimePorts {
  analysisNodes: ReadonlyMap<string, AnalysisNodeImplementation>;
  schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
  missingPolicies: ReadonlyMap<string, AnalysisMissingPolicy>;
  decisionPolicies: ReadonlyMap<string, AnalysisDecisionPolicy>;
  clock: AnalysisClock;
  eventSequencer: RuntimeEventSequencer;
  eventWriter?: AnalysisEventWriter;
}

export interface AnalysisRunOptions {
  runId: string;
  bundleId: string;
  signal?: AbortSignal;
  eventBufferCapacity?: number;
}

export interface AnalysisRun {
  events: AsyncIterable<EvaluationEvent>;
  result: Promise<AnalysisBundle>;
}

export interface DecisionOptions {
  runId: string;
  signal?: AbortSignal;
  eventBufferCapacity?: number;
}

export interface DecisionRun {
  events: AsyncIterable<EvaluationEvent>;
  result: Promise<DecisionResult | undefined>;
}

export interface EvaluationReportMaterializationOptions {
  reportId: string;
  annotations?: JsonValue;
  summaries?: JsonValue;
}

export interface EvaluationReportRunOptions extends EvaluationReportMaterializationOptions {
  runId: string;
  eventBufferCapacity?: number;
}

export interface EvaluationReportRun {
  events: AsyncIterable<EvaluationEvent>;
  result: Promise<EvaluationReport>;
}

export interface EvaluationReportSources {
  executionBundle: unknown;
  evaluationBundle: EvaluationBundle;
  analysisBundle: AnalysisBundle;
  decision?: DecisionResult;
}

export class AnalysisPortFailure extends Error {
  readonly evaluationError: EvaluationError;

  constructor(error: EvaluationError) {
    super(error.message);
    this.name = 'AnalysisPortFailure';
    this.evaluationError = error;
  }
}

export class AnalysisRuntimeConfigurationError extends TypeError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AnalysisRuntimeConfigurationError';
    this.code = code;
  }
}

export type AnalysisRuntimePlan = SealedRunPlan;
export type AnalysisObservationCoverageSnapshot = AnalysisObservationCoverage;
export type MaterializedEvaluationReport = EvaluationReport;
