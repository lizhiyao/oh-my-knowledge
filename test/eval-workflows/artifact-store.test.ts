import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  digestArtifactPayload,
  digestCanonicalJson,
  type EvaluationBundle,
  type EvaluationReport,
  type RunPlan,
} from '../../src/evaluation-core/contracts/index.js';
import type { SealedRunPlan } from '../../src/evaluation-core/compiler/index.js';
import {
  CORE_RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  CORE_RUN_DOCUMENT_FILES,
  LEGACY_CORE_RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  LEGACY_CORE_RUN_EVALUATION_REPORT_FILE,
  CoreRunArtifactStoreError,
  CoreRunArtifactOverlayError,
  NodeCoreContentStoreError,
  createOverlayCoreRunArtifactStore,
  createNodeCoreContentStore,
  createNodeCoreRunArtifactStore,
  materializeCoreRunArtifactManifest,
  projectCoreRunArtifactIndexCard,
} from '../../src/eval-workflows/artifact-store/index.js';
import {
  InMemoryConformanceArtifactStore,
  runConformanceScenario,
  type ConformanceResult,
  type ConformanceTarget,
} from '../evaluation-core/conformance/harness.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'omk-core-artifacts-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

function saveRequest(result: ConformanceResult, runId: string) {
  return {
    runId,
    createdAt: '2026-08-31T12:00:00.000Z',
    plan: result.plan,
    execution: result.execution,
    evaluation: result.evaluation,
    analysis: result.analysis,
    report: result.report,
  };
}

async function publishedRunDirectory(root: string): Promise<string> {
  const entry = (await readdir(root)).find((name) => /^run-[0-9a-f]{64}$/.test(name));
  if (entry === undefined) throw new Error('missing published run directory');
  return join(root, entry);
}

function expectStoreError(code: CoreRunArtifactStoreError['code']) {
  return (error: unknown): boolean => (
    error instanceof CoreRunArtifactStoreError && error.code === code
  );
}

function expectContentStoreError(code: NodeCoreContentStoreError['code']) {
  return (error: unknown): boolean => (
    error instanceof NodeCoreContentStoreError && error.code === code
  );
}

describe('Node Core run artifact store', () => {
  it.each(['function', 'rag', 'agent'] as const)(
    'round-trips an exact %s Plan, Bundle chain, Report, manifest, and index card',
    async (target: ConformanceTarget) => {
      const root = await temporaryDirectory();
      const runId = `artifact-round-trip-${target}`;
      const result = await runConformanceScenario(target, { runId });
      const store = createNodeCoreRunArtifactStore(root);

      const stored = await store.save(saveRequest(result, runId));
      assert.deepEqual(stored.plan, result.plan);
      assert.deepEqual(stored.execution, result.execution);
      assert.deepEqual(stored.evaluation, result.evaluation);
      assert.deepEqual(stored.analysis, result.analysis);
      assert.deepEqual(stored.report, result.report);
      assert.equal(
        stored.manifest.schemaVersion,
        CORE_RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION,
      );
      assert.deepEqual(
        stored.manifest.documents.map((document) => document.documentKind),
        [
          'run-plan',
          'execution-bundle',
          'evaluation-bundle',
          'analysis-bundle',
          'evaluation-report',
        ],
      );
      assert.deepEqual(await store.get(runId), stored);
      assert.deepEqual(
        await store.inspect(runId),
        projectCoreRunArtifactIndexCard(stored.manifest),
      );
      assert.equal(await store.exists(runId), true);
      assert.deepEqual(await store.list(), [{
        runId,
        reportId: result.report.reportId,
        runContractDigest: result.plan.digests.runContractDigest,
        reportDigest: result.report.reportDigest,
        artifactSetDigest: digestCanonicalJson(stored.manifest.documents),
        createdAt: '2026-08-31T12:00:00.000Z',
        status: result.report.status,
        replayability: {
          execution: result.execution.replayability,
          evaluation: result.evaluation.replayability,
        },
        maximumCapturedClassification: target === 'agent' ? 'sensitive' : 'public',
      }]);
      const runDirectory = await publishedRunDirectory(root);
      assert.equal((await stat(runDirectory)).mode & 0o077, 0);
      for (const fileName of Object.values(CORE_RUN_DOCUMENT_FILES)) {
        assert.equal((await stat(join(runDirectory, fileName))).mode & 0o077, 0);
      }
    },
  );

  it('is idempotent for the same run identity and rejects a different artifact set', async () => {
    const root = await temporaryDirectory();
    const store = createNodeCoreRunArtifactStore(root);
    const first = await runConformanceScenario('function', {
      runId: 'shared-run',
      suffix: 'first',
    });
    const second = await runConformanceScenario('rag', {
      runId: 'shared-run',
      suffix: 'second',
    });
    const request = saveRequest(first, 'shared-run');
    const stored = await store.save(request);
    assert.deepEqual(await store.save(request), stored);
    await assert.rejects(
      store.save(saveRequest(second, 'shared-run')),
      expectStoreError('CORE_RUN_ARTIFACT_RUN_ID_CONFLICT'),
    );
    assert.deepEqual(await store.get('shared-run'), stored);
  });

  it('continues to authenticate and read a manifest v1 bundle', async () => {
    const root = await temporaryDirectory();
    const runId = 'legacy-manifest-run';
    const result = await runConformanceScenario('function', { runId });
    const store = createNodeCoreRunArtifactStore(root);
    const stored = await store.save(saveRequest(result, runId));
    const directory = await publishedRunDirectory(root);
    await rename(
      join(directory, CORE_RUN_DOCUMENT_FILES.evaluationReport),
      join(directory, LEGACY_CORE_RUN_EVALUATION_REPORT_FILE),
    );
    const manifestPayload = { ...stored.manifest };
    delete (manifestPayload as { manifestDigest?: string }).manifestDigest;
    const manifest = materializeCoreRunArtifactManifest({
      ...manifestPayload,
      schemaVersion: LEGACY_CORE_RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION,
      documents: manifestPayload.documents.map((document) => (
        document.documentKind === 'evaluation-report'
          ? { ...document, fileName: LEGACY_CORE_RUN_EVALUATION_REPORT_FILE }
          : document
      )),
    });
    await writeFile(
      join(directory, CORE_RUN_DOCUMENT_FILES.manifest),
      JSON.stringify(manifest),
    );
    assert.deepEqual((await store.get(runId))?.report, result.report);
  });

  it('publishes one complete winner under concurrent conflicting writers', async () => {
    const root = await temporaryDirectory();
    const store = createNodeCoreRunArtifactStore(root);
    const [first, second] = await Promise.all([
      runConformanceScenario('function', { runId: 'concurrent-run', suffix: 'first' }),
      runConformanceScenario('agent', { runId: 'concurrent-run', suffix: 'second' }),
    ]);
    const outcomes = await Promise.allSettled([
      store.save(saveRequest(first, 'concurrent-run')),
      store.save(saveRequest(second, 'concurrent-run')),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.ok(rejection?.status === 'rejected');
    assert.ok(expectStoreError('CORE_RUN_ARTIFACT_RUN_ID_CONFLICT')(rejection.reason));
    const loaded = await store.get('concurrent-run');
    assert.ok(loaded);
    assert.ok([
      first.report.reportDigest,
      second.report.reportDigest,
    ].includes(loaded.report.reportDigest));
  });

  it('ignores unpublished staging directories but fails explicitly on a corrupt published run', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, '.run-interrupted.tmp'), { recursive: true });
    await writeFile(
      join(root, '.run-interrupted.tmp', CORE_RUN_DOCUMENT_FILES.runPlan),
      '{}',
    );
    const store = createNodeCoreRunArtifactStore(root);
    assert.deepEqual(await store.list(), []);

    const result = await runConformanceScenario('function', { runId: 'corrupt-run' });
    await store.save(saveRequest(result, 'corrupt-run'));
    const directory = await publishedRunDirectory(root);
    await writeFile(join(directory, CORE_RUN_DOCUMENT_FILES.manifest), '{}');
    await assert.rejects(
      store.list(),
      expectStoreError('CORE_RUN_ARTIFACT_MANIFEST_INVALID'),
    );
  });

  it('detects a valid document whose digest differs from the published manifest', async () => {
    const root = await temporaryDirectory();
    const result = await runConformanceScenario('function', { runId: 'tampered-run' });
    const store = createNodeCoreRunArtifactStore(root);
    await store.save(saveRequest(result, 'tampered-run'));
    const directory = await publishedRunDirectory(root);
    const report = structuredClone(result.report) as EvaluationReport;
    report.annotations = { tampered: true };
    report.reportDigest = digestArtifactPayload(report, 'reportDigest');
    await writeFile(
      join(directory, CORE_RUN_DOCUMENT_FILES.evaluationReport),
      JSON.stringify(report),
    );
    await assert.rejects(
      store.get('tampered-run'),
      expectStoreError('CORE_RUN_ARTIFACT_DOCUMENT_DIGEST_MISMATCH'),
    );
  });

  it('rejects a recomputed Bundle that breaks the authenticated parent chain', async () => {
    const root = await temporaryDirectory();
    const result = await runConformanceScenario('function', { runId: 'chain-run' });
    const evaluation = structuredClone(result.evaluation) as EvaluationBundle;
    evaluation.executionBundleDigest = digestCanonicalJson({ wrong: 'parent' });
    evaluation.bundleDigest = digestArtifactPayload(evaluation, 'bundleDigest');
    const store = createNodeCoreRunArtifactStore(root);
    await assert.rejects(
      store.save({
        ...saveRequest(result, 'chain-run'),
        evaluation,
      }),
      expectStoreError('CORE_RUN_ARTIFACT_SOURCE_CHAIN_INVALID'),
    );
    assert.equal(await store.exists('chain-run'), false);
  });

  it('rejects a RunPlan whose declared digest no longer matches its design', async () => {
    const root = await temporaryDirectory();
    const result = await runConformanceScenario('function', { runId: 'plan-run' });
    const plan = structuredClone(result.plan) as unknown as RunPlan;
    plan.digests.runContractDigest = digestCanonicalJson({ wrong: 'contract' });
    const store = createNodeCoreRunArtifactStore(root);
    await assert.rejects(
      store.save({
        ...saveRequest(result, 'plan-run'),
        plan: plan as unknown as SealedRunPlan,
      }),
      expectStoreError('CORE_RUN_ARTIFACT_PLAN_INVALID'),
    );
  });

  it('rejects stage payload tampering even when every declared Plan digest is unchanged', async () => {
    const root = await temporaryDirectory();
    const result = await runConformanceScenario('function', { runId: 'stage-plan-run' });
    const plan = structuredClone(result.plan) as unknown as RunPlan;
    plan.execution.samples[0].input = { tampered: true };
    const store = createNodeCoreRunArtifactStore(root);
    await assert.rejects(
      store.save({
        ...saveRequest(result, 'stage-plan-run'),
        plan: plan as unknown as SealedRunPlan,
      }),
      expectStoreError('CORE_RUN_ARTIFACT_PLAN_INVALID'),
    );
  });

  it('requires every descriptor to resolve before publishing a resolvable run', async () => {
    const root = await temporaryDirectory();
    const artifactStore = new InMemoryConformanceArtifactStore();
    const result = await runConformanceScenario('function', {
      runId: 'resolvable-run',
      artifactStore,
      mutate(_definition, policy) {
        policy.evidence.output = 'reference';
      },
    });
    const withoutResolver = createNodeCoreRunArtifactStore(root);
    await assert.rejects(
      withoutResolver.save(saveRequest(result, 'resolvable-run')),
      expectStoreError('CORE_RUN_ARTIFACT_CONTENT_RESOLVER_REQUIRED'),
    );
    const withResolver = createNodeCoreRunArtifactStore(root, {
      contentResolver: artifactStore,
    });
    const stored = await withResolver.save(saveRequest(result, 'resolvable-run'));
    assert.equal(stored.execution.replayability, 'resolvable');
    const indexOnly = createNodeCoreRunArtifactStore(root);
    assert.equal((await indexOnly.list()).length, 1);
    assert.equal(await indexOnly.exists('resolvable-run'), true);
    await assert.rejects(
      indexOnly.get('resolvable-run'),
      expectStoreError('CORE_RUN_ARTIFACT_CONTENT_RESOLVER_REQUIRED'),
    );
  });
});

describe('Core run artifact store overlay', () => {
  it('uses primary precedence when layers contain the exact same artifact set', async () => {
    const primaryRoot = await temporaryDirectory();
    const fallbackRoot = await temporaryDirectory();
    const primary = createNodeCoreRunArtifactStore(primaryRoot);
    const fallback = createNodeCoreRunArtifactStore(fallbackRoot);
    const runId = 'overlay-identical';
    const result = await runConformanceScenario('function', { runId });
    await fallback.save({
      ...saveRequest(result, runId),
      createdAt: '2026-08-31T11:00:00.000Z',
    });
    const primaryArtifacts = await primary.save({
      ...saveRequest(result, runId),
      createdAt: '2026-08-31T13:00:00.000Z',
    });
    const overlay = createOverlayCoreRunArtifactStore(primary, [fallback]);

    assert.deepEqual(await overlay.get(runId), primaryArtifacts);
    assert.deepEqual(
      await overlay.inspect(runId),
      projectCoreRunArtifactIndexCard(primaryArtifacts.manifest),
    );
    assert.deepEqual(await overlay.list(), [
      projectCoreRunArtifactIndexCard(primaryArtifacts.manifest),
    ]);
    assert.equal(await overlay.exists(runId), true);
  });

  it('fails explicitly when one run id resolves to different artifact sets', async () => {
    const primary = createNodeCoreRunArtifactStore(await temporaryDirectory());
    const fallback = createNodeCoreRunArtifactStore(await temporaryDirectory());
    const runId = 'overlay-conflict';
    const [first, second] = await Promise.all([
      runConformanceScenario('function', { runId, suffix: 'primary' }),
      runConformanceScenario('rag', { runId, suffix: 'fallback' }),
    ]);
    await primary.save(saveRequest(first, runId));
    await fallback.save(saveRequest(second, runId));
    const overlay = createOverlayCoreRunArtifactStore(primary, [fallback]);

    for (const operation of [
      () => overlay.get(runId),
      () => overlay.inspect(runId),
      () => overlay.list(),
      () => overlay.exists(runId),
    ]) {
      await assert.rejects(operation, (error: unknown) => (
        error instanceof CoreRunArtifactOverlayError
        && error.code === 'CORE_RUN_ARTIFACT_OVERLAY_ID_CONFLICT'
      ));
    }
  });

  it('never shadows an existing fallback run during writes', async () => {
    const primary = createNodeCoreRunArtifactStore(await temporaryDirectory());
    const fallback = createNodeCoreRunArtifactStore(await temporaryDirectory());
    const runId = 'overlay-shadow';
    const result = await runConformanceScenario('function', { runId });
    await fallback.save(saveRequest(result, runId));
    const overlay = createOverlayCoreRunArtifactStore(primary, [fallback]);

    await assert.rejects(
      overlay.save(saveRequest(result, runId)),
      (error: unknown) => (
        error instanceof CoreRunArtifactOverlayError
        && error.code === 'CORE_RUN_ARTIFACT_OVERLAY_SHADOW_CONFLICT'
      ),
    );
    assert.equal((await primary.list()).length, 0);
  });
});

describe('Node Core content store', () => {
  it('content-addresses values without conflating classification and enforces private modes', async () => {
    const root = await temporaryDirectory();
    const store = createNodeCoreContentStore(root);
    const value = { answer: 42 };
    const digest = digestCanonicalJson(value);
    const publicDescriptor = await store.put({
      value,
      digest,
      mediaType: 'application/json',
      classification: 'public',
    });
    const goldDescriptor = await store.put({
      value,
      digest,
      mediaType: 'application/json',
      classification: 'gold',
    });
    assert.notEqual(publicDescriptor.uri, goldDescriptor.uri);
    assert.deepEqual(await store.resolve(publicDescriptor), {
      value,
      classification: 'public',
      mediaType: 'application/json',
    });
    assert.deepEqual(await store.resolve(goldDescriptor), {
      value,
      classification: 'gold',
      mediaType: 'application/json',
    });
    const contentDirectory = join(root, 'content');
    assert.equal((await stat(contentDirectory)).mode & 0o077, 0);
    for (const file of await readdir(contentDirectory)) {
      assert.equal((await stat(join(contentDirectory, file))).mode & 0o077, 0);
    }
  });

  it('rejects mismatched input digests and corrupted stored content', async () => {
    const root = await temporaryDirectory();
    const store = createNodeCoreContentStore(root);
    await assert.rejects(store.put({
      value: { answer: 42 },
      digest: digestCanonicalJson({ answer: 41 }),
      mediaType: 'application/json',
      classification: 'public',
    }), /digest does not match/);

    const descriptor = await store.put({
      value: { answer: 42 },
      digest: digestCanonicalJson({ answer: 42 }),
      mediaType: 'application/json',
      classification: 'sensitive',
    });
    const contentDirectory = join(root, 'content');
    const file = (await readdir(contentDirectory))[0];
    const document = JSON.parse(await readFile(join(contentDirectory, file), 'utf8'));
    document.value = { answer: 99 };
    await chmod(join(contentDirectory, file), 0o600);
    await writeFile(join(contentDirectory, file), JSON.stringify(document));
    await assert.rejects(
      store.resolve(descriptor),
      expectContentStoreError('CORE_CONTENT_DOCUMENT_INVALID'),
    );
  });

  it('distinguishes unavailable content from a malformed content document', async () => {
    const root = await temporaryDirectory();
    const store = createNodeCoreContentStore(root);
    const descriptor = await store.put({
      value: { answer: 42 },
      digest: digestCanonicalJson({ answer: 42 }),
      mediaType: 'application/json',
      classification: 'public',
    });
    const contentDirectory = join(root, 'content');
    const file = (await readdir(contentDirectory))[0];
    await writeFile(join(contentDirectory, file), '{');
    await assert.rejects(
      store.resolve(descriptor),
      expectContentStoreError('CORE_CONTENT_DOCUMENT_INVALID'),
    );
    await rm(join(contentDirectory, file));
    await assert.rejects(
      store.resolve(descriptor),
      expectContentStoreError('CORE_CONTENT_UNAVAILABLE'),
    );
  });
});
