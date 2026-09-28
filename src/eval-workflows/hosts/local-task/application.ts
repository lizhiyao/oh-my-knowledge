import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { deepFreezeCanonicalJson, digestCanonicalJson, type JsonValue } from '../../../eval-core/contracts/index.js';
import { prepareEvaluation } from '../../../eval-runtime/evaluation/prepare.js';
import { rescore } from '../../../eval-runtime/evaluation/reuse.js';
import type { EvaluateInput, EvaluationResult } from '../../../eval-runtime/evaluation/contracts.js';
import { saveEvaluationResult } from '../../../eval-runtime/result-store.js';
import { createNodeCoreContentStore, createNodeCoreRunArtifactStore, type StoredCoreRunArtifacts } from '../../artifact-store/index.js';
import { persistCoreArtifactSidecars } from '../../orchestration/artifact-graph-persistence.js';
import { LocalTaskDefinitionSchema, LocalTaskOutputSchema, type LocalTaskDefinition, type TaskFile } from '../../inputs/contracts/local-task.js';
import { captureTaskFiles, fileDigest, taskTreeDigest } from './files.js';
import { createTaskDiagnostics } from './diagnostics.js';
import { createTaskWorkspace } from './workspace.js';
import { createTaskExecutor } from './executor.js';
import { createTaskAcceptance, TASK_METRIC_ID } from './acceptance.js';
import { probeCodexCliVersion } from '../adapters/codex/version.js';
import { captureIdentityFiles } from '../adapters/shared/content-identity.js';

export interface LocalTaskOptions {
  readonly definitionPath: string;
  readonly temporaryRoot: string;
  readonly outputDirectory: string;
  /** Read only for explicit live runs; copied into an attempt-private home, never persisted. */
  readonly authenticationFile?: string;
}

function assertSupported(task: LocalTaskDefinition): void {
  if (task.samples.requires !== undefined) throw new TypeError('TASK_REQUIREMENTS_UNSUPPORTED');
  for (const sample of task.samples.samples) {
    if (sample.input.inputKind !== 'text' || sample.executionContext !== undefined
      || sample.evaluationContext !== undefined || sample.expected !== undefined) {
      throw new TypeError('Local tasks currently accept text sample v3 input and annotations; acceptance belongs in the independent verifier.');
    }
  }
}

/** Host application shared by CLI and programmatic users. All locators remain outside identities. */
export async function prepareLocalTask(options: LocalTaskOptions) {
  const base = dirname(resolve(options.definitionPath));
  const task = LocalTaskDefinitionSchema.parse(yaml.load(await readFile(options.definitionPath, 'utf8')));
  assertSupported(task);
  const snapshotRoot = await realpath(resolve(base, task.snapshot.root));
  const acceptanceRoot = await realpath(resolve(base, task.acceptance.root));
  const snapshotPaths = new Set(task.snapshot.files.map((file) => join(snapshotRoot, file)));
  if (task.acceptance.files.some((file) => snapshotPaths.has(join(acceptanceRoot, file)))) {
    throw new TypeError('TASK_ACCEPTANCE_EXPOSED_IN_SNAPSHOT');
  }
  const [snapshot, acceptanceFiles, control, treatment] = await Promise.all([
    captureTaskFiles(snapshotRoot, task.snapshot.files, task.artifacts.maxBytes),
    captureTaskFiles(acceptanceRoot, task.acceptance.files, 16 * 1024 * 1024),
    readFile(resolve(base, task.variants.control), 'utf8'),
    readFile(resolve(base, task.variants.treatment), 'utf8'),
  ]);
  if (control.trim() === '' || treatment.trim() === '') throw new TypeError('TASK_KNOWLEDGE_EMPTY');
  const execution = task.execution;
  const executable = execution.runtimeKind === 'fixture' ? process.execPath : await realpath(resolve(base, execution.executable));
  const fixtureSource = execution.runtimeKind === 'fixture' ? await readFile(resolve(base, execution.script), 'utf8') : undefined;
  const identityFiles = await captureIdentityFiles([
    { facetId: 'node-runtime', path: process.execPath },
    ...(execution.runtimeKind === 'codex' ? [{ facetId: 'codex-executable', path: executable },
      ...execution.identityFiles.map((file) => ({ ...file, path: resolve(base, file.path) }))] : []),
  ], 'Local task');
  const executableDigest = fixtureSource === undefined
    ? identityFiles.find((file) => file.facetId === 'codex-executable')!.digest : fileDigest(Buffer.from(fixtureSource));
  let version = process.version;
  if (execution.runtimeKind === 'codex') {
    const probeHome = await mkdtemp(join(options.temporaryRoot, 'probe-'));
    try {
      version = await probeCodexCliVersion({ executablePath: executable,
        environment: { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
          HOME: probeHome, CODEX_HOME: probeHome, TMPDIR: probeHome, LANG: 'C', TZ: 'UTC' },
        maxOutputBytes: 65536, timeoutMs: 5000 });
    } finally { await rm(probeHome, { recursive: true, force: true }); }
  }
  const workspace = createTaskWorkspace(snapshot, options.temporaryRoot);
  const contentStore = createNodeCoreContentStore(join(options.outputDirectory, 'content'));
  const diagnostics = createTaskDiagnostics(contentStore, options.outputDirectory);
  const executor = createTaskExecutor({ captureDiagnostic: diagnostics.capture, definition: task, snapshot, provider: workspace.provider,
    temporaryRoot: options.temporaryRoot, executable, executableDigest, version, identityFiles,
    ...(fixtureSource === undefined ? {} : { fixtureSource }),
    ...(options.authenticationFile === undefined ? {} : { authenticationFile: options.authenticationFile }),
  });
  const store = createNodeCoreRunArtifactStore(options.outputDirectory, { contentResolver: contentStore });
  const declaration: EvaluateInput = {
    dataset: { datasetId: task.taskId, samples: task.samples.samples.map((sample) => ({
      sampleId: sample.sampleId, input: sample.input as JsonValue,
      ...(sample.annotations === undefined ? {} : { annotations: sample.annotations as JsonValue }),
    })) },
    variants: (['control', 'treatment'] as const).map((variantId) => ({
      variantId, artifact: { name: variantId, kind: 'skill', source: 'inline', content: variantId === 'control' ? control : treatment },
      execution: { executor, workspace: workspace.descriptor },
    })),
    evaluators: [createTaskAcceptance({ captureDiagnostic: diagnostics.capture, definition: task.acceptance, files: acceptanceFiles,
      requiredArtifacts: task.artifacts.files, temporaryRoot: options.temporaryRoot,
      runtimeFiles: identityFiles.filter((file) => file.facetId === 'node-runtime') })],
    comparisons: [{ comparisonId: 'task-ab', controlVariantId: 'control', treatmentVariantIds: ['treatment'], metricIds: [TASK_METRIC_ID] }],
    analyses: [{ analysisId: 'task-difference', analysisKind: 'comparison-interval', statistic: 'mean-difference',
      comparisonId: 'task-ab', treatmentVariantId: 'treatment', metricId: TASK_METRIC_ID,
      confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 1000 } }],
    decision: { decisionKind: 'analysis', analysisId: 'task-difference', minimumEvidenceStatus: 'complete' },
    experiment: { seed: task.seed, trials: task.trials, sampling: { samplingKind: 'paired', seedCoupling: 'uncontrolled' } },
    policy: { execution: { maxConcurrency: 1, timeoutMs: execution.timeoutMs }, evaluation: { maxConcurrency: 1 },
      evidence: { output: 'full', trace: 'full', evaluatorEvidence: 'full', maximumClassification: 'sensitive' } },
    infrastructure: { contentStore, contentResolver: contentStore },
  };
  const prepared = await prepareEvaluation(declaration);
  async function archiveFiles(files: readonly TaskFile[], mediaType: string) {
    return contentStore.put({ value: [...files], digest: taskTreeDigest(files), mediaType, classification: 'sensitive' });
  }
  async function persist(result: EvaluationResult, plan = prepared.plan): Promise<StoredCoreRunArtifacts> {
    const { execution: executed, evaluation, analysis } = result.artifacts ?? {};
    if (!executed || !evaluation || !analysis || !result.report) throw new Error(`TASK_RUN_INCOMPLETE:${result.status}`);
    const artifacts = await store.save({ runId: result.runId, createdAt: new Date().toISOString(),
      plan, execution: executed, evaluation, analysis, report: result.report });
    await persistCoreArtifactSidecars({ source: artifacts, outputDirectory: options.outputDirectory, cwd: base });
    return artifacts;
  }
  const preview = deepFreezeCanonicalJson({
    projectionKind: 'local-task-preview', taskId: task.taskId, knowledgeMode: 'provided-content',
    runtimeKind: execution.runtimeKind, runtimeVersion: version,
    model: execution.runtimeKind === 'codex' ? execution.model : 'offline-fixture',
    effort: execution.runtimeKind === 'codex' ? execution.effort : 'none',
    executionTimeoutMs: execution.timeoutMs, acceptanceTimeoutMs: task.acceptance.timeoutMs,
    toolPolicy: 'runtime-default', strongIsolation: false,
    diagnosticsPolicy: 'attempt-snapshot/v1', maxStreamBytes: 10 * 1024 * 1024,
    runtimeFiles: identityFiles.map(({ facetId, digest, size }) => ({ facetId, digest, size })),
    snapshotDigest: taskTreeDigest(snapshot), acceptanceDigest: taskTreeDigest(acceptanceFiles),
    snapshotFiles: task.snapshot.files, artifactFiles: task.artifacts.files, maxArtifactBytes: task.artifacts.maxBytes,
    samples: task.samples.samples.map(({ sampleId, annotations }) => ({ sampleId, ...(annotations === undefined ? {} : { annotations: annotations as JsonValue }) })),
    trust: task.trust, writeBoundary: 'trial-private-workspace', retryState: 'shared-within-trial',
    estimatedCostUSD: null, estimatedWork: { ...prepared.estimatedWork, uncertain: [...prepared.estimatedWork.uncertain] },
    limitations: ['trusted-local-not-hostile-code-sandbox', 'native-skill-discovery-not-measured',
      'external-provider-conditions-uncontrolled', 'small-example-is-not-release-evidence'],
  });
  return Object.freeze({
    preview,
    async run(signal?: AbortSignal) {
      const snapshotReference = await archiveFiles(snapshot, workspace.descriptor.mediaType);
      const acceptanceReference = await archiveFiles(acceptanceFiles, 'application/vnd.omk.local-task-verifier');
      const runId = `run-${randomUUID()}`;
      const diagnosticsDirectory = `task-diagnostics/${runId}`;
      const { value: result, references: diagnosticReferences } = await diagnostics.run(runId, () =>
        prepared.run({ runId, signal, annotations: { ...preview, snapshotReference, acceptanceReference, diagnosticsDirectory } }));
      if (result.status === 'failed') {
        const value = JSON.parse(JSON.stringify(result)) as JsonValue;
        const failureReference = await contentStore.put({ value, digest: digestCanonicalJson(value), mediaType: 'application/json', classification: 'sensitive' });
        throw new Error(`TASK_RUN_FAILED:${result.error.code}:${failureReference.uri}`);
      }
      const reference = await saveEvaluationResult({ result, store: contentStore });
      return { result, artifacts: await persist(result), reference, diagnosticsDirectory, diagnosticReferences };
    },
    async rescore(source: EvaluationResult, acceptance: LocalTaskDefinition['acceptance'], root: string, signal?: AbortSignal) {
      const verifiedAcceptance = LocalTaskDefinitionSchema.shape.acceptance.parse(acceptance);
      const records = source.artifacts?.execution?.records;
      if (!records || records.length === 0) throw new TypeError('TASK_RESCORE_EVIDENCE_MISSING');
      for (const record of records) {
        if (record.executionStatus !== 'completed' || record.output?.contentKind !== 'inline') throw new TypeError('TASK_RESCORE_EVIDENCE_MISSING');
        const output = LocalTaskOutputSchema.parse(record.output.value);
        if (output.missing.length || output.collectionErrors.length
          || task.artifacts.files.some((path) => !output.files.some((file) => file.path === path))) throw new TypeError('TASK_RESCORE_EVIDENCE_MISSING');
      }
      const files = await captureTaskFiles(resolve(root, verifiedAcceptance.root), verifiedAcceptance.files, 16 * 1024 * 1024);
      const nextInput: EvaluateInput = { ...declaration,
        evaluators: [createTaskAcceptance({ captureDiagnostic: diagnostics.capture, definition: verifiedAcceptance, files, requiredArtifacts: task.artifacts.files,
          temporaryRoot: options.temporaryRoot, runtimeFiles: identityFiles.filter((file) => file.facetId === 'node-runtime') })] };
      const acceptanceReference = await archiveFiles(files, 'application/vnd.omk.local-task-verifier');
      const runId = `run-${randomUUID()}`;
      const diagnosticsDirectory = `task-diagnostics/${runId}`;
      const { value: result, references: diagnosticReferences } = await diagnostics.run(runId, () =>
        rescore(nextInput, source, { runId, signal, annotations: { ...preview, diagnosticsDirectory,
        acceptanceDigest: taskTreeDigest(files), acceptanceTimeoutMs: verifiedAcceptance.timeoutMs,
        acceptanceReference, postHocRescore: true, sourceRunId: source.runId } }));
      // The existing run-artifact store requires a single run contract. A reused Execution
      // retains its original contract, so persist suffix runs through Runtime's result store.
      const reference = await saveEvaluationResult({ result, store: contentStore });
      return { result, reference, diagnosticsDirectory, diagnosticReferences };
    },
  });
}
