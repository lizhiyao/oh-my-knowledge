import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  RunPlanSchema,
  canonicalizeJson,
  computeAnalysisPlanDigest,
  computeDecisionPlanDigest,
  computeEvaluationPlanDigest,
  computeExecutionPlanDigest,
  computePlanDigests,
  computeRandomizationDesignDigest,
  computeRunContractDigest,
  deepFreezeCanonicalJson,
  deriveEvaluationStatus,
  digestCanonicalJson,
  evaluationRecordCapturedContents,
  parseAnalysisBundleDocument,
  parseEvaluationBundleDocument,
  parseEvaluationReportDocument,
  parseExecutionBundleDocument,
  parseWireDocument,
  type CapturedContent,
  type ContentDescriptor,
  type RunPlan,
  type Sha256Digest,
} from '../../evaluation-core/contracts/index.js';
import type { EvaluationContentResolver } from '../../evaluation-core/evaluation/index.js';
import { KeyedMutex } from '../../shared/keyed-mutex.js';
import { ensureOwnedLayoutForPath } from '../../omk-layout/index.js';
import {
  CORE_RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  CORE_RUN_DOCUMENT_FILES,
  CoreRunArtifactManifestSchema,
  materializeCoreRunArtifactManifest,
  parseCoreRunArtifactManifestDocument,
  projectCoreRunArtifactIndexCard,
  type CoreRunArtifactIndexCard,
  type CoreRunArtifactManifest,
  type CoreRunArtifactStore,
  type CoreRunDocumentReference,
  type SaveCoreRunArtifactsRequest,
  type StoredCoreRunArtifacts,
} from './contracts.js';
import {
  ensurePrivateDirectory,
  publishPrivateDirectoryExclusive,
  writePrivateJson,
} from './private-json-file.js';

const CLASSIFICATION_RANK = {
  public: 0,
  sensitive: 1,
  secret: 2,
  gold: 3,
} as const;

export type CoreRunArtifactStoreErrorCode =
  | 'CORE_RUN_ARTIFACT_INPUT_INVALID'
  | 'CORE_RUN_ARTIFACT_PLAN_INVALID'
  | 'CORE_RUN_ARTIFACT_SOURCE_CHAIN_INVALID'
  | 'CORE_RUN_ARTIFACT_MANIFEST_INVALID'
  | 'CORE_RUN_ARTIFACT_DOCUMENT_MISSING'
  | 'CORE_RUN_ARTIFACT_DOCUMENT_INVALID'
  | 'CORE_RUN_ARTIFACT_DOCUMENT_DIGEST_MISMATCH'
  | 'CORE_RUN_ARTIFACT_CONTENT_RESOLVER_REQUIRED'
  | 'CORE_RUN_ARTIFACT_CONTENT_INVALID'
  | 'CORE_RUN_ARTIFACT_RUN_ID_CONFLICT';

export class CoreRunArtifactStoreError extends TypeError {
  readonly code: CoreRunArtifactStoreErrorCode;

  constructor(code: CoreRunArtifactStoreErrorCode, message: string) {
    super(message);
    this.name = 'CoreRunArtifactStoreError';
    this.code = code;
  }
}

export interface NodeCoreRunArtifactStoreOptions {
  readonly contentResolver?: EvaluationContentResolver;
}

type ParsedCoreRunArtifacts = Omit<StoredCoreRunArtifacts, 'manifest'>;

function fail(code: CoreRunArtifactStoreErrorCode, message: string): never {
  throw new CoreRunArtifactStoreError(code, message);
}

export function coreRunArtifactDirectoryName(runId: string): string {
  return `run-${createHash('sha256').update(runId).digest('hex')}`;
}

function sha256(value: string): Sha256Digest {
  return value as Sha256Digest;
}

function runDirectoryPath(rootDir: string, runId: string): string {
  return join(rootDir, coreRunArtifactDirectoryName(runId));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertPlanDocument(plan: RunPlan): void {
  const definition = plan.definition;
  const expectedDigests = computePlanDigests({
    dataset: definition.dataset,
    targets: definition.targets,
    evaluators: definition.evaluators,
    metrics: definition.metrics,
    experiment: definition.experiment,
    analysisGraph: definition.analysisGraph,
    comparisons: definition.comparisons,
    ...(definition.decisionPolicy === undefined
      ? {}
      : { decisionPolicy: definition.decisionPolicy }),
    measurementPolicy: plan.measurementPolicy,
    executorRuntimes: plan.execution.runtimes,
    evaluatorRuntimes: plan.evaluation.runtimes,
    analysisRuntimes: plan.analysis.runtimes,
    decisionRuntimes: plan.decision.runtimes,
    schemaIdentities: plan.schemaIdentities,
    ...(definition.seriesMembership === undefined
      ? {}
      : { seriesMembership: definition.seriesMembership }),
    stageExtensions: {
      ...(plan.execution.extensions === undefined
        ? {}
        : { execution: plan.execution.extensions }),
      ...(plan.evaluation.extensions === undefined
        ? {}
        : { evaluation: plan.evaluation.extensions }),
      ...(plan.analysis.extensions === undefined
        ? {}
        : { analysis: plan.analysis.extensions }),
      ...(plan.decision.extensions === undefined
        ? {}
        : { decision: plan.decision.extensions }),
      ...(plan.extensions === undefined ? {} : { run: plan.extensions }),
    },
  });
  const actualRandomizationDesignDigest = computeRandomizationDesignDigest({
    executionInputDigest: sha256(plan.execution.executionInputDigest),
    samples: plan.execution.samples,
    schedulingTargetGroups: plan.execution.schedulingTargetGroups,
    experiment: {
      ...plan.execution.experiment,
      sampling: {
        ...plan.execution.experiment.sampling,
        estimatorId: definition.experiment.sampling.estimatorId,
      },
    },
  });
  const actualExecutionPlanDigest = computeExecutionPlanDigest({
    executionInputDigest: sha256(plan.execution.executionInputDigest),
    randomizationDesignDigest: sha256(plan.execution.randomizationDesignDigest),
    targets: plan.execution.targets,
    schedulingTargetGroups: plan.execution.schedulingTargetGroups,
    executorRuntimes: plan.execution.runtimes,
    experiment: plan.execution.experiment,
    policy: plan.execution.policy,
    ...(plan.execution.extensions === undefined
      ? {}
      : { extensions: plan.execution.extensions }),
  });
  const actualEvaluationPlanDigest = computeEvaluationPlanDigest({
    executionPlanDigest: sha256(plan.evaluation.executionPlanDigest),
    evaluationInputDigest: sha256(plan.evaluation.evaluationInputDigest),
    evaluators: plan.evaluation.evaluators,
    metrics: plan.evaluation.metrics,
    evaluatorRuntimes: plan.evaluation.runtimes,
    policy: plan.evaluation.policy,
    ...(plan.evaluation.extensions === undefined
      ? {}
      : { extensions: plan.evaluation.extensions }),
  });
  const actualAnalysisPlanDigest = computeAnalysisPlanDigest({
    evaluationPlanDigest: sha256(plan.analysis.evaluationPlanDigest),
    analysisInputDigest: sha256(plan.analysis.analysisInputDigest),
    samples: plan.analysis.samples,
    cohorts: plan.analysis.cohorts,
    metrics: plan.analysis.metrics,
    analysisGraph: plan.analysis.analysisGraph,
    experiment: plan.analysis.experiment,
    comparisons: plan.analysis.comparisons,
    analysisRuntimes: plan.analysis.runtimes,
    ...(plan.analysis.extensions === undefined
      ? {}
      : { extensions: plan.analysis.extensions }),
  });
  const actualDecisionPlanDigest = computeDecisionPlanDigest({
    analysisPlanDigest: sha256(plan.decision.analysisPlanDigest),
    analysisInputDigest: sha256(plan.decision.analysisInputDigest),
    ...(plan.decision.decisionPolicy === undefined
      ? {}
      : { decisionPolicy: plan.decision.decisionPolicy }),
    decisionRuntimes: plan.decision.runtimes,
    ...(plan.decision.extensions === undefined
      ? {}
      : { extensions: plan.decision.extensions }),
  });
  const actualRunContractDigest = computeRunContractDigest({
    executionPlanDigest: sha256(plan.execution.executionPlanDigest),
    evaluationPlanDigest: sha256(plan.evaluation.evaluationPlanDigest),
    analysisPlanDigest: sha256(plan.analysis.analysisPlanDigest),
    decisionPlanDigest: sha256(plan.decision.decisionPlanDigest),
    schemaIdentities: plan.schemaIdentities,
    eventDeliveryPolicy: plan.measurementPolicy.eventDelivery,
    ...(plan.definition.seriesMembership === undefined
      ? {}
      : { seriesMembership: plan.definition.seriesMembership }),
    ...(plan.extensions === undefined ? {} : { extensions: plan.extensions }),
  });
  const actualExecutionInputDigest = digestCanonicalJson({
    datasetId: plan.definition.dataset.datasetId,
    samples: plan.execution.samples,
  });
  const actualEvaluationInputDigest = digestCanonicalJson({
    datasetId: plan.definition.dataset.datasetId,
    samples: plan.evaluation.samples,
  });
  const actualAnalysisInputDigest = digestCanonicalJson({
    datasetId: plan.definition.dataset.datasetId,
    cohorts: plan.analysis.cohorts,
    samples: plan.analysis.samples,
  });
  if (canonicalizeJson(plan.digests) !== canonicalizeJson(expectedDigests)
      || actualExecutionInputDigest !== plan.digests.executionInputDigest
      || actualEvaluationInputDigest !== plan.digests.evaluationInputDigest
      || actualAnalysisInputDigest !== plan.digests.analysisInputDigest
      || actualRandomizationDesignDigest !== plan.digests.randomizationDesignDigest
      || actualExecutionPlanDigest !== plan.execution.executionPlanDigest
      || actualEvaluationPlanDigest !== plan.evaluation.evaluationPlanDigest
      || actualAnalysisPlanDigest !== plan.analysis.analysisPlanDigest
      || actualDecisionPlanDigest !== plan.decision.decisionPlanDigest
      || actualRunContractDigest !== plan.digests.runContractDigest
      || plan.execution.executionPlanDigest !== expectedDigests.executionPlanDigest
      || plan.evaluation.executionPlanDigest !== expectedDigests.executionPlanDigest
      || plan.evaluation.evaluationPlanDigest !== expectedDigests.evaluationPlanDigest
      || plan.analysis.evaluationPlanDigest !== expectedDigests.evaluationPlanDigest
      || plan.analysis.analysisPlanDigest !== expectedDigests.analysisPlanDigest
      || plan.decision.analysisPlanDigest !== expectedDigests.analysisPlanDigest
      || plan.decision.decisionPlanDigest !== expectedDigests.decisionPlanDigest) {
    fail(
      'CORE_RUN_ARTIFACT_PLAN_INVALID',
      'Persisted RunPlan digests do not match its sealed measurement contract.',
    );
  }
}

function exactBundleReferences(
  input: ParsedCoreRunArtifacts,
): boolean {
  return canonicalizeJson(input.report.bundles.map((reference) => ({
    bundleKind: reference.bundleKind,
    schemaVersion: reference.schemaVersion,
    bundleDigest: reference.bundleDigest,
  }))) === canonicalizeJson([
    {
      bundleKind: 'execution',
      schemaVersion: input.execution.schemaVersion,
      bundleDigest: input.execution.bundleDigest,
    },
    {
      bundleKind: 'evaluation',
      schemaVersion: input.evaluation.schemaVersion,
      bundleDigest: input.evaluation.bundleDigest,
    },
    {
      bundleKind: 'analysis',
      schemaVersion: input.analysis.schemaVersion,
      bundleDigest: input.analysis.bundleDigest,
    },
  ]);
}

function assertSourceChain(input: ParsedCoreRunArtifacts): void {
  const { plan, execution, evaluation, analysis, report } = input;
  const parentDigests = [
    execution.bundleDigest,
    evaluation.bundleDigest,
    analysis.bundleDigest,
    ...(report.decision === undefined ? [] : [report.decision.decisionDigest]),
  ];
  const expectedStatus = deriveEvaluationStatus({
    execution,
    evaluation,
    analysis,
    ...(report.decision === undefined ? {} : { decision: report.decision }),
  });
  if (execution.runContractDigest !== plan.digests.runContractDigest
      || execution.executionPlanDigest !== plan.digests.executionPlanDigest
      || execution.datasetRevisionDigest !== plan.digests.datasetRevisionDigest
      || execution.executionInputDigest !== plan.digests.executionInputDigest
      || evaluation.runContractDigest !== plan.digests.runContractDigest
      || evaluation.executionBundleDigest !== execution.bundleDigest
      || evaluation.evaluationPlanDigest !== plan.digests.evaluationPlanDigest
      || evaluation.evaluationInputDigest !== plan.digests.evaluationInputDigest
      || analysis.runContractDigest !== plan.digests.runContractDigest
      || analysis.evaluationBundleDigest !== evaluation.bundleDigest
      || analysis.analysisPlanDigest !== plan.digests.analysisPlanDigest
      || report.runContractDigest !== plan.digests.runContractDigest
      || !exactBundleReferences(input)
      || canonicalizeJson(report.budgetSummary) !== canonicalizeJson(evaluation.budgetSummary)
      || canonicalizeJson(report.status) !== canonicalizeJson(expectedStatus)
      || canonicalizeJson(report.provenance.parentDigests)
        !== canonicalizeJson(parentDigests)
      || (report.decision !== undefined
        && (report.decision.analysisBundleDigest !== analysis.bundleDigest
          || report.decision.decisionPlanDigest !== plan.digests.decisionPlanDigest))) {
    fail(
      'CORE_RUN_ARTIFACT_SOURCE_CHAIN_INVALID',
      'Persisted Core artifacts do not form one exact Plan and parent-digest chain.',
    );
  }
}

function executionCapturedContents(
  input: ParsedCoreRunArtifacts['execution'],
): CapturedContent[] {
  return input.records.flatMap((record) => {
    if (record.executionStatus === 'budget-censored') return [];
    return [
      ...(record.executionStatus === 'completed' && record.output !== undefined
        ? [record.output]
        : []),
      ...(record.trace === undefined ? [] : [record.trace]),
    ];
  });
}

function capturedContents(input: ParsedCoreRunArtifacts): CapturedContent[] {
  return [
    ...executionCapturedContents(input.execution),
    ...input.evaluation.records.flatMap(evaluationRecordCapturedContents),
  ];
}

function maximumCapturedClassification(
  input: ParsedCoreRunArtifacts,
): CoreRunArtifactManifest['maximumCapturedClassification'] {
  return capturedContents(input).reduce<
    CoreRunArtifactManifest['maximumCapturedClassification']
  >((current, content) => (
    CLASSIFICATION_RANK[content.classification] > CLASSIFICATION_RANK[current]
      ? content.classification
      : current
  ), 'public');
}

async function assertContentClosure(
  input: ParsedCoreRunArtifacts,
  resolver: EvaluationContentResolver | undefined,
): Promise<void> {
  const descriptors = new Map<string, {
    descriptor: ContentDescriptor;
    classification: CapturedContent['classification'];
  }>();
  for (const content of capturedContents(input)) {
    if (content.contentKind !== 'descriptor') continue;
    const key = canonicalizeJson(content.descriptor);
    const existing = descriptors.get(key);
    if (existing !== undefined && existing.classification !== content.classification) {
      fail(
        'CORE_RUN_ARTIFACT_CONTENT_INVALID',
        'One content descriptor is assigned conflicting classifications.',
      );
    }
    descriptors.set(key, {
      descriptor: content.descriptor,
      classification: content.classification,
    });
  }
  if (descriptors.size === 0) return;
  if (resolver === undefined) {
    fail(
      'CORE_RUN_ARTIFACT_CONTENT_RESOLVER_REQUIRED',
      'Resolvable Core artifacts require a host content resolver before publication.',
    );
  }
  for (const { descriptor, classification } of descriptors.values()) {
    let resolved;
    try {
      resolved = await resolver.resolve(descriptor);
    } catch {
      fail(
        'CORE_RUN_ARTIFACT_CONTENT_INVALID',
        'A captured content descriptor cannot be resolved.',
      );
    }
    if (digestCanonicalJson(resolved.value) !== descriptor.digest
        || resolved.classification !== classification
        || (resolved.mediaType !== undefined && resolved.mediaType !== descriptor.mediaType)) {
      fail(
        'CORE_RUN_ARTIFACT_CONTENT_INVALID',
        'Resolved captured content does not match its descriptor and classification.',
      );
    }
  }
}

function documents(input: ParsedCoreRunArtifacts): CoreRunDocumentReference[] {
  return [
    {
      documentKind: 'run-plan',
      fileName: CORE_RUN_DOCUMENT_FILES.runPlan,
      schemaVersion: input.plan.schemaVersion,
      identityDigest: input.plan.digests.runContractDigest,
      documentDigest: digestCanonicalJson(input.plan),
    },
    {
      documentKind: 'execution-bundle',
      fileName: CORE_RUN_DOCUMENT_FILES.executionBundle,
      schemaVersion: input.execution.schemaVersion,
      identityDigest: input.execution.bundleDigest,
      documentDigest: digestCanonicalJson(input.execution),
    },
    {
      documentKind: 'evaluation-bundle',
      fileName: CORE_RUN_DOCUMENT_FILES.evaluationBundle,
      schemaVersion: input.evaluation.schemaVersion,
      identityDigest: input.evaluation.bundleDigest,
      documentDigest: digestCanonicalJson(input.evaluation),
    },
    {
      documentKind: 'analysis-bundle',
      fileName: CORE_RUN_DOCUMENT_FILES.analysisBundle,
      schemaVersion: input.analysis.schemaVersion,
      identityDigest: input.analysis.bundleDigest,
      documentDigest: digestCanonicalJson(input.analysis),
    },
    {
      documentKind: 'evaluation-report',
      fileName: CORE_RUN_DOCUMENT_FILES.evaluationReport,
      schemaVersion: input.report.schemaVersion,
      identityDigest: input.report.reportDigest,
      documentDigest: digestCanonicalJson(input.report),
    },
  ];
}

function parseArtifactSet(input: {
  plan: unknown;
  execution: unknown;
  evaluation: unknown;
  analysis: unknown;
  report: unknown;
}): ParsedCoreRunArtifacts {
  try {
    const parsed = deepFreezeCanonicalJson({
      plan: parseWireDocument(RunPlanSchema, input.plan),
      execution: parseExecutionBundleDocument(input.execution),
      evaluation: parseEvaluationBundleDocument(input.evaluation),
      analysis: parseAnalysisBundleDocument(input.analysis),
      report: parseEvaluationReportDocument(input.report),
    });
    assertPlanDocument(parsed.plan);
    assertSourceChain(parsed);
    return parsed;
  } catch (error: unknown) {
    if (error instanceof CoreRunArtifactStoreError) throw error;
    fail(
      'CORE_RUN_ARTIFACT_DOCUMENT_INVALID',
      'A persisted Core wire document is invalid.',
    );
  }
}

async function readJson(path: string, code: CoreRunArtifactStoreErrorCode): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    fail(code, 'A required Core run artifact document is missing or unreadable.');
  }
}

function assertManifestMatchesArtifacts(
  manifest: CoreRunArtifactManifest,
  artifacts: ParsedCoreRunArtifacts,
): void {
  if (manifest.reportId !== artifacts.report.reportId
      || manifest.runContractDigest !== artifacts.plan.digests.runContractDigest
      || canonicalizeJson(manifest.status) !== canonicalizeJson(artifacts.report.status)
      || canonicalizeJson(manifest.replayability) !== canonicalizeJson({
        execution: artifacts.execution.replayability,
        evaluation: artifacts.evaluation.replayability,
      })
      || manifest.maximumCapturedClassification
        !== maximumCapturedClassification(artifacts)) {
    fail(
      'CORE_RUN_ARTIFACT_MANIFEST_INVALID',
      'Core run artifact manifest does not match its referenced documents.',
    );
  }
  const expected = documents(artifacts);
  if (manifest.documents.some((document, index) => (
    canonicalizeJson(document) !== canonicalizeJson(expected[index])
  ))) {
    fail(
      'CORE_RUN_ARTIFACT_DOCUMENT_DIGEST_MISMATCH',
      'Core run artifact document digest differs from its published manifest.',
    );
  }
}

export function createNodeCoreRunArtifactStore(
  rootDir: string,
  options: NodeCoreRunArtifactStoreOptions = {},
): CoreRunArtifactStore {
  const mutations = new KeyedMutex();

  async function loadDirectory(
    directory: string,
    expectedRunId?: string,
    verifyContentClosure = true,
  ): Promise<StoredCoreRunArtifacts> {
    let manifest: CoreRunArtifactManifest;
    try {
      manifest = parseCoreRunArtifactManifestDocument(await readJson(
        join(directory, CORE_RUN_DOCUMENT_FILES.manifest),
        'CORE_RUN_ARTIFACT_DOCUMENT_MISSING',
      ));
    } catch (error: unknown) {
      if (error instanceof CoreRunArtifactStoreError) throw error;
      fail(
        'CORE_RUN_ARTIFACT_MANIFEST_INVALID',
        'Core run artifact manifest is invalid.',
      );
    }
    if ((expectedRunId !== undefined && manifest.runId !== expectedRunId)
        || coreRunArtifactDirectoryName(manifest.runId) !== basename(directory)) {
      fail(
        'CORE_RUN_ARTIFACT_MANIFEST_INVALID',
        'Core run artifact manifest identity differs from its locator.',
      );
    }
    const artifacts = parseArtifactSet({
      plan: await readJson(
        join(directory, CORE_RUN_DOCUMENT_FILES.runPlan),
        'CORE_RUN_ARTIFACT_DOCUMENT_MISSING',
      ),
      execution: await readJson(
        join(directory, CORE_RUN_DOCUMENT_FILES.executionBundle),
        'CORE_RUN_ARTIFACT_DOCUMENT_MISSING',
      ),
      evaluation: await readJson(
        join(directory, CORE_RUN_DOCUMENT_FILES.evaluationBundle),
        'CORE_RUN_ARTIFACT_DOCUMENT_MISSING',
      ),
      analysis: await readJson(
        join(directory, CORE_RUN_DOCUMENT_FILES.analysisBundle),
        'CORE_RUN_ARTIFACT_DOCUMENT_MISSING',
      ),
      report: await readJson(
        join(directory, CORE_RUN_DOCUMENT_FILES.evaluationReport),
        'CORE_RUN_ARTIFACT_DOCUMENT_MISSING',
      ),
    });
    assertManifestMatchesArtifacts(manifest, artifacts);
    if (verifyContentClosure) {
      await assertContentClosure(artifacts, options.contentResolver);
    }
    return deepFreezeCanonicalJson({ manifest, ...artifacts });
  }

  async function get(runId: string): Promise<StoredCoreRunArtifacts | undefined> {
    const directory = runDirectoryPath(rootDir, runId);
    if (!await pathExists(directory)) return undefined;
    return loadDirectory(directory, runId);
  }

  async function save(
    request: Readonly<SaveCoreRunArtifactsRequest>,
  ): Promise<StoredCoreRunArtifacts> {
    return mutations.run(request.runId, async () => {
      let artifacts: ParsedCoreRunArtifacts;
      try {
        artifacts = parseArtifactSet(request);
        parseWireDocument(
          CoreRunArtifactManifestSchema.shape.runId,
          request.runId,
        );
        parseWireDocument(
          CoreRunArtifactManifestSchema.shape.createdAt,
          request.createdAt,
        );
      } catch (error: unknown) {
        if (error instanceof CoreRunArtifactStoreError) throw error;
        fail(
          'CORE_RUN_ARTIFACT_INPUT_INVALID',
          'Core run artifact save request is invalid.',
        );
      }
      await assertContentClosure(artifacts, options.contentResolver);
      const existing = await get(request.runId);
      if (existing !== undefined) {
        if (canonicalizeJson(documents(existing)) === canonicalizeJson(documents(artifacts))) {
          return existing;
        }
        fail(
          'CORE_RUN_ARTIFACT_RUN_ID_CONFLICT',
          'Core run id already identifies a different artifact set.',
        );
      }

      ensureOwnedLayoutForPath(rootDir);
      await ensurePrivateDirectory(rootDir);
      const staging = join(
        rootDir,
        `.${coreRunArtifactDirectoryName(request.runId)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await mkdir(staging, { mode: 0o700 });
      try {
        await Promise.all([
          writePrivateJson(join(staging, CORE_RUN_DOCUMENT_FILES.runPlan), artifacts.plan),
          writePrivateJson(
            join(staging, CORE_RUN_DOCUMENT_FILES.executionBundle),
            artifacts.execution,
          ),
          writePrivateJson(
            join(staging, CORE_RUN_DOCUMENT_FILES.evaluationBundle),
            artifacts.evaluation,
          ),
          writePrivateJson(
            join(staging, CORE_RUN_DOCUMENT_FILES.analysisBundle),
            artifacts.analysis,
          ),
          writePrivateJson(
            join(staging, CORE_RUN_DOCUMENT_FILES.evaluationReport),
            artifacts.report,
          ),
        ]);
        const manifest = materializeCoreRunArtifactManifest({
          schemaVersion: CORE_RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION,
          manifestKind: 'evaluation-core-run-artifacts',
          runId: request.runId,
          reportId: artifacts.report.reportId,
          runContractDigest: artifacts.plan.digests.runContractDigest,
          createdAt: request.createdAt,
          status: artifacts.report.status,
          replayability: {
            execution: artifacts.execution.replayability,
            evaluation: artifacts.evaluation.replayability,
          },
          maximumCapturedClassification: maximumCapturedClassification(artifacts),
          documents: documents(artifacts),
        });
        await writePrivateJson(
          join(staging, CORE_RUN_DOCUMENT_FILES.manifest),
          manifest,
        );
        const outcome = await publishPrivateDirectoryExclusive(
          staging,
          runDirectoryPath(rootDir, request.runId),
        );
        if (outcome === 'exists') {
          const concurrent = await get(request.runId);
          if (concurrent !== undefined
              && canonicalizeJson(documents(concurrent))
                === canonicalizeJson(documents(artifacts))) return concurrent;
          fail(
            'CORE_RUN_ARTIFACT_RUN_ID_CONFLICT',
            'Core run id was concurrently published with different artifacts.',
          );
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      const stored = await get(request.runId);
      if (stored === undefined) {
        fail(
          'CORE_RUN_ARTIFACT_DOCUMENT_MISSING',
          'Published Core run artifacts cannot be reloaded.',
        );
      }
      return stored;
    });
  }

  async function list(): Promise<CoreRunArtifactIndexCard[]> {
    if (!await pathExists(rootDir)) return [];
    const entries = (await readdir(rootDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^run-[0-9a-f]{64}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const artifacts = await Promise.all(entries.map((entry) => (
      loadDirectory(join(rootDir, entry), undefined, false)
    )));
    return artifacts
      .map(({ manifest }) => projectCoreRunArtifactIndexCard(manifest))
      .sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt)
        || left.runId.localeCompare(right.runId)
      ));
  }

  async function inspect(runId: string): Promise<CoreRunArtifactIndexCard | undefined> {
    const directory = runDirectoryPath(rootDir, runId);
    if (!await pathExists(directory)) return undefined;
    const { manifest } = await loadDirectory(directory, runId, false);
    return projectCoreRunArtifactIndexCard(manifest);
  }

  async function exists(runId: string): Promise<boolean> {
    return (await inspect(runId)) !== undefined;
  }

  return Object.freeze({ save, get, inspect, list, exists });
}
