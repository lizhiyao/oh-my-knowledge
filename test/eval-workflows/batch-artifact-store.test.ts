import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  CORE_BATCH_MANIFEST_FILE,
  CORE_BATCH_MANIFEST_SCHEMA_VERSION,
  CORE_RUN_DOCUMENT_FILES,
  CoreBatchArtifactStoreError,
  createNodeCoreBatchArtifactStore,
  createNodeCoreRunArtifactStore,
} from '../../src/eval-workflows/artifact-store/index.js';
import {
  runConformanceScenario,
  type ConformanceResult,
} from '../evaluation-core/conformance/harness.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
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
    createdAt: '2026-08-31T13:00:00.000Z',
    plan: result.plan,
    execution: result.execution,
    evaluation: result.evaluation,
    analysis: result.analysis,
    report: result.report,
  };
}

function expectBatchError(code: CoreBatchArtifactStoreError['code']) {
  return (error: unknown): boolean => (
    error instanceof CoreBatchArtifactStoreError && error.code === code
  );
}

async function publishedBatchDirectory(root: string): Promise<string> {
  const entry = (await readdir(root)).find((name) => /^batch-[0-9a-f]{64}$/.test(name));
  if (entry === undefined) throw new Error('missing published batch directory');
  return join(root, entry);
}

describe('Node Core batch artifact store', () => {
  it('publishes independent child locators and a rebuildable batch index', async () => {
    const runRoot = await temporaryDirectory('omk-core-batch-runs-');
    const batchRoot = await temporaryDirectory('omk-core-batches-');
    const runStore = createNodeCoreRunArtifactStore(runRoot);
    const [functionRun, ragRun] = await Promise.all([
      runConformanceScenario('function', { runId: 'child-function' }),
      runConformanceScenario('rag', { runId: 'child-rag' }),
    ]);
    await Promise.all([
      runStore.save(saveRequest(functionRun, 'child-function')),
      runStore.save(saveRequest(ragRun, 'child-rag')),
    ]);
    const batchStore = createNodeCoreBatchArtifactStore(batchRoot, runStore);
    const stored = await batchStore.save({
      batchId: 'batch-one',
      createdAt: '2026-08-31T14:00:00.000Z',
      children: [
        { itemId: 'function-item', runId: 'child-function' },
        { itemId: 'rag-item', runId: 'child-rag' },
      ],
    });

    assert.equal(stored.manifest.schemaVersion, CORE_BATCH_MANIFEST_SCHEMA_VERSION);
    assert.deepEqual(stored.manifest.children.map((child) => ({
      itemId: child.itemId,
      ordinal: child.ordinal,
      runId: child.locator.runId,
      reportDigest: child.reportDigest,
    })), [
      {
        itemId: 'function-item',
        ordinal: 0,
        runId: 'child-function',
        reportDigest: functionRun.report.reportDigest,
      },
      {
        itemId: 'rag-item',
        ordinal: 1,
        runId: 'child-rag',
        reportDigest: ragRun.report.reportDigest,
      },
    ]);
    assert.deepEqual(await batchStore.get('batch-one'), stored);
    assert.deepEqual(await batchStore.list(), [{
      batchId: 'batch-one',
      createdAt: '2026-08-31T14:00:00.000Z',
      childCount: 2,
      batchManifestDigest: stored.manifest.batchManifestDigest,
    }]);
    assert.equal(await batchStore.exists('batch-one'), true);
    const directory = await publishedBatchDirectory(batchRoot);
    assert.equal((await stat(directory)).mode & 0o077, 0);
    assert.equal((await stat(join(directory, CORE_BATCH_MANIFEST_FILE))).mode & 0o077, 0);
    const raw = JSON.parse(await readFile(
      join(directory, CORE_BATCH_MANIFEST_FILE),
      'utf8',
    ));
    assert.equal(raw.kind, undefined);
    assert.equal(raw.items, undefined);
  });

  it('accepts a cancelled child as an honest independent run summary', async () => {
    const runRoot = await temporaryDirectory('omk-core-batch-runs-');
    const batchRoot = await temporaryDirectory('omk-core-batches-');
    const controller = new AbortController();
    controller.abort('batch child cancellation');
    const child = await runConformanceScenario('function', {
      runId: 'cancelled-child',
      executionSignal: controller.signal,
    });
    assert.equal(child.report.status.runStatus, 'cancelled');
    const runStore = createNodeCoreRunArtifactStore(runRoot);
    await runStore.save(saveRequest(child, 'cancelled-child'));
    const batchStore = createNodeCoreBatchArtifactStore(batchRoot, runStore);
    const stored = await batchStore.save({
      batchId: 'cancelled-batch',
      createdAt: '2026-08-31T14:00:00.000Z',
      children: [{ itemId: 'cancelled-item', runId: 'cancelled-child' }],
    });
    assert.equal(stored.manifest.children[0].status.runStatus, 'cancelled');
  });

  it('is idempotent for the same children and rejects changed or duplicate identity', async () => {
    const runStore = createNodeCoreRunArtifactStore(
      await temporaryDirectory('omk-core-batch-runs-'),
    );
    const batchStore = createNodeCoreBatchArtifactStore(
      await temporaryDirectory('omk-core-batches-'),
      runStore,
    );
    const [first, second] = await Promise.all([
      runConformanceScenario('function', { runId: 'first-child' }),
      runConformanceScenario('rag', { runId: 'second-child' }),
    ]);
    await Promise.all([
      runStore.save(saveRequest(first, 'first-child')),
      runStore.save(saveRequest(second, 'second-child')),
    ]);
    const request = {
      batchId: 'stable-batch',
      createdAt: '2026-08-31T14:00:00.000Z',
      children: [{ itemId: 'item', runId: 'first-child' }],
    } as const;
    const stored = await batchStore.save(request);
    assert.deepEqual(await batchStore.save(request), stored);
    await assert.rejects(batchStore.save({
      ...request,
      children: [{ itemId: 'item', runId: 'second-child' }],
    }), expectBatchError('CORE_BATCH_ID_CONFLICT'));
    await assert.rejects(batchStore.save({
      batchId: 'duplicate-batch',
      createdAt: request.createdAt,
      children: [
        { itemId: 'same', runId: 'first-child' },
        { itemId: 'same', runId: 'second-child' },
      ],
    }), expectBatchError('CORE_BATCH_INPUT_INVALID'));
  });

  it('does not publish missing children and fails when a referenced child later corrupts', async () => {
    const runRoot = await temporaryDirectory('omk-core-batch-runs-');
    const batchRoot = await temporaryDirectory('omk-core-batches-');
    const runStore = createNodeCoreRunArtifactStore(runRoot);
    const batchStore = createNodeCoreBatchArtifactStore(batchRoot, runStore);
    await assert.rejects(batchStore.save({
      batchId: 'missing-child-batch',
      createdAt: '2026-08-31T14:00:00.000Z',
      children: [{ itemId: 'missing-item', runId: 'missing-child' }],
    }), expectBatchError('CORE_BATCH_CHILD_NOT_FOUND'));
    assert.deepEqual(await batchStore.list(), []);

    const child = await runConformanceScenario('function', { runId: 'corrupt-child' });
    await runStore.save(saveRequest(child, 'corrupt-child'));
    await batchStore.save({
      batchId: 'corrupt-child-batch',
      createdAt: '2026-08-31T14:00:00.000Z',
      children: [{ itemId: 'corrupt-item', runId: 'corrupt-child' }],
    });
    const runDirectory = (await readdir(runRoot)).find((name) => name.startsWith('run-'));
    assert.ok(runDirectory);
    await writeFile(
      join(runRoot, runDirectory, CORE_RUN_DOCUMENT_FILES.manifest),
      '{}',
    );
    await assert.rejects(
      batchStore.get('corrupt-child-batch'),
      expectBatchError('CORE_BATCH_CHILD_INVALID'),
    );
    assert.equal((await batchStore.list()).length, 1);
  });

  it('ignores interrupted staging directories and rejects a corrupt published manifest', async () => {
    const batchRoot = await temporaryDirectory('omk-core-batches-');
    const runStore = createNodeCoreRunArtifactStore(
      await temporaryDirectory('omk-core-batch-runs-'),
    );
    await mkdir(join(batchRoot, '.batch-interrupted.tmp'));
    const batchStore = createNodeCoreBatchArtifactStore(batchRoot, runStore);
    assert.deepEqual(await batchStore.list(), []);

    const child = await runConformanceScenario('function', { runId: 'manifest-child' });
    await runStore.save(saveRequest(child, 'manifest-child'));
    await batchStore.save({
      batchId: 'manifest-batch',
      createdAt: '2026-08-31T14:00:00.000Z',
      children: [{ itemId: 'manifest-item', runId: 'manifest-child' }],
    });
    const directory = await publishedBatchDirectory(batchRoot);
    await writeFile(join(directory, CORE_BATCH_MANIFEST_FILE), '{}');
    await assert.rejects(
      batchStore.list(),
      expectBatchError('CORE_BATCH_MANIFEST_INVALID'),
    );
  });
});
