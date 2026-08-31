import { z } from 'zod';
import {
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  EVALUATION_BUNDLE_SCHEMA_VERSION,
  EVALUATION_REPORT_SCHEMA_VERSION,
  EXECUTION_BUNDLE_SCHEMA_VERSION,
  RUN_PLAN_SCHEMA_VERSION,
  EvaluationStatusSchema,
  IdentifierSchema,
  ReplayabilitySchema,
  Sha256DigestSchema,
  TimestampSchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  parseWireDocument,
  type AnalysisBundle,
  type EvaluationBundle,
  type EvaluationReport,
  type ExecutionBundle,
  type RunPlan,
} from '../../evaluation-core/contracts/index.js';
import type { SealedRunPlan } from '../../evaluation-core/compiler/index.js';

export const CORE_RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION =
  'omk.core-run-artifact-manifest/v1' as const;

export const CORE_RUN_DOCUMENT_FILES = Object.freeze({
  runPlan: 'run-plan.json',
  executionBundle: 'execution-bundle.json',
  evaluationBundle: 'evaluation-bundle.json',
  analysisBundle: 'analysis-bundle.json',
  evaluationReport: 'evaluation-report.json',
  manifest: 'manifest.json',
});

const RunPlanDocumentReferenceSchema = z.object({
  documentKind: z.literal('run-plan'),
  fileName: z.literal(CORE_RUN_DOCUMENT_FILES.runPlan),
  schemaVersion: z.literal(RUN_PLAN_SCHEMA_VERSION),
  identityDigest: Sha256DigestSchema,
  documentDigest: Sha256DigestSchema,
}).strict();

const ExecutionBundleDocumentReferenceSchema = z.object({
  documentKind: z.literal('execution-bundle'),
  fileName: z.literal(CORE_RUN_DOCUMENT_FILES.executionBundle),
  schemaVersion: z.literal(EXECUTION_BUNDLE_SCHEMA_VERSION),
  identityDigest: Sha256DigestSchema,
  documentDigest: Sha256DigestSchema,
}).strict();

const EvaluationBundleDocumentReferenceSchema = z.object({
  documentKind: z.literal('evaluation-bundle'),
  fileName: z.literal(CORE_RUN_DOCUMENT_FILES.evaluationBundle),
  schemaVersion: z.literal(EVALUATION_BUNDLE_SCHEMA_VERSION),
  identityDigest: Sha256DigestSchema,
  documentDigest: Sha256DigestSchema,
}).strict();

const AnalysisBundleDocumentReferenceSchema = z.object({
  documentKind: z.literal('analysis-bundle'),
  fileName: z.literal(CORE_RUN_DOCUMENT_FILES.analysisBundle),
  schemaVersion: z.literal(ANALYSIS_BUNDLE_SCHEMA_VERSION),
  identityDigest: Sha256DigestSchema,
  documentDigest: Sha256DigestSchema,
}).strict();

const EvaluationReportDocumentReferenceSchema = z.object({
  documentKind: z.literal('evaluation-report'),
  fileName: z.literal(CORE_RUN_DOCUMENT_FILES.evaluationReport),
  schemaVersion: z.literal(EVALUATION_REPORT_SCHEMA_VERSION),
  identityDigest: Sha256DigestSchema,
  documentDigest: Sha256DigestSchema,
}).strict();

export const CoreRunDocumentReferenceSchema = z.discriminatedUnion('documentKind', [
  RunPlanDocumentReferenceSchema,
  ExecutionBundleDocumentReferenceSchema,
  EvaluationBundleDocumentReferenceSchema,
  AnalysisBundleDocumentReferenceSchema,
  EvaluationReportDocumentReferenceSchema,
]);

export const CoreRunArtifactManifestSchema = z.object({
  schemaVersion: z.literal(CORE_RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION),
  manifestKind: z.literal('evaluation-core-run-artifacts'),
  runId: IdentifierSchema,
  reportId: IdentifierSchema,
  runContractDigest: Sha256DigestSchema,
  createdAt: TimestampSchema,
  status: EvaluationStatusSchema,
  replayability: z.object({
    execution: ReplayabilitySchema,
    evaluation: ReplayabilitySchema,
  }).strict(),
  maximumCapturedClassification: z.enum([
    'public',
    'sensitive',
    'secret',
    'gold',
  ]),
  documents: z.array(CoreRunDocumentReferenceSchema).length(5),
  manifestDigest: Sha256DigestSchema,
}).strict();

export type CoreRunDocumentReference = z.infer<typeof CoreRunDocumentReferenceSchema>;
export type CoreRunArtifactManifest = z.infer<typeof CoreRunArtifactManifestSchema>;

export interface CoreRunArtifactSet {
  readonly plan: SealedRunPlan;
  readonly execution: ExecutionBundle;
  readonly evaluation: EvaluationBundle;
  readonly analysis: AnalysisBundle;
  readonly report: EvaluationReport;
}

export interface StoredCoreRunArtifacts {
  readonly manifest: CoreRunArtifactManifest;
  readonly plan: RunPlan;
  readonly execution: ExecutionBundle;
  readonly evaluation: EvaluationBundle;
  readonly analysis: AnalysisBundle;
  readonly report: EvaluationReport;
}

export interface CoreRunArtifactIndexCard {
  readonly runId: string;
  readonly reportId: string;
  readonly runContractDigest: string;
  readonly reportDigest: string;
  readonly createdAt: string;
  readonly status: EvaluationReport['status'];
  readonly replayability: CoreRunArtifactManifest['replayability'];
  readonly maximumCapturedClassification:
    CoreRunArtifactManifest['maximumCapturedClassification'];
}

export interface SaveCoreRunArtifactsRequest extends CoreRunArtifactSet {
  readonly runId: string;
  readonly createdAt: string;
}

export interface CoreRunArtifactStore {
  save(request: Readonly<SaveCoreRunArtifactsRequest>): Promise<StoredCoreRunArtifacts>;
  get(runId: string): Promise<StoredCoreRunArtifacts | undefined>;
  list(): Promise<CoreRunArtifactIndexCard[]>;
  exists(runId: string): Promise<boolean>;
}

const DOCUMENT_ORDER: readonly CoreRunDocumentReference['documentKind'][] = [
  'run-plan',
  'execution-bundle',
  'evaluation-bundle',
  'analysis-bundle',
  'evaluation-report',
];

export function parseCoreRunArtifactManifestDocument(
  value: unknown,
): CoreRunArtifactManifest {
  const manifest = parseWireDocument(CoreRunArtifactManifestSchema, value);
  if (manifest.documents.some((document, index) => (
    document.documentKind !== DOCUMENT_ORDER[index]
  ))) {
    throw new TypeError('Core run artifact manifest documents are not canonically ordered.');
  }
  const { manifestDigest, ...payload } = manifest;
  if (digestCanonicalJson(payload) !== manifestDigest) {
    throw new TypeError('Core run artifact manifest digest does not match its payload.');
  }
  return deepFreezeCanonicalJson(manifest);
}

export function materializeCoreRunArtifactManifest(
  input: Omit<CoreRunArtifactManifest, 'manifestDigest'>,
): CoreRunArtifactManifest {
  return parseCoreRunArtifactManifestDocument({
    ...input,
    manifestDigest: digestCanonicalJson(input),
  });
}

export function projectCoreRunArtifactIndexCard(
  manifest: CoreRunArtifactManifest,
): CoreRunArtifactIndexCard {
  const report = manifest.documents.find((document) => (
    document.documentKind === 'evaluation-report'
  ));
  if (report === undefined) {
    throw new TypeError('Core run artifact manifest is missing its EvaluationReport.');
  }
  return deepFreezeCanonicalJson({
    runId: manifest.runId,
    reportId: manifest.reportId,
    runContractDigest: manifest.runContractDigest,
    reportDigest: report.identityDigest,
    createdAt: manifest.createdAt,
    status: manifest.status,
    replayability: manifest.replayability,
    maximumCapturedClassification: manifest.maximumCapturedClassification,
  });
}
