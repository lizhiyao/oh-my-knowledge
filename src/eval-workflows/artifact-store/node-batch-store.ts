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
  canonicalizeJson,
  digestCanonicalJson,
} from '../../eval-core/contracts/index.js';
import { KeyedMutex } from '../../shared/keyed-mutex.js';
import {
  CORE_BATCH_MANIFEST_FILE,
  CORE_BATCH_MANIFEST_SCHEMA_VERSION,
  materializeCoreBatchManifest,
  parseCoreBatchManifestDocument,
  projectCoreBatchIndexCard,
  SaveCoreBatchRequestSchema,
  type CoreBatchArtifactStore,
  type CoreBatchChildReference,
  type CoreBatchIndexCard,
  type CoreBatchManifest,
  type SaveCoreBatchRequest,
  type StoredCoreBatch,
} from './batch-contracts.js';
import type { CoreRunArtifactStore } from './contracts.js';
import {
  ensurePrivateDirectory,
  publishPrivateDirectoryExclusive,
  writePrivateJson,
} from './private-json-file.js';

export type CoreBatchArtifactStoreErrorCode =
  | 'CORE_BATCH_INPUT_INVALID'
  | 'CORE_BATCH_CHILD_NOT_FOUND'
  | 'CORE_BATCH_CHILD_INVALID'
  | 'CORE_BATCH_MANIFEST_MISSING'
  | 'CORE_BATCH_MANIFEST_INVALID'
  | 'CORE_BATCH_ID_CONFLICT';

export class CoreBatchArtifactStoreError extends TypeError {
  readonly code: CoreBatchArtifactStoreErrorCode;

  constructor(code: CoreBatchArtifactStoreErrorCode, message: string) {
    super(message);
    this.name = 'CoreBatchArtifactStoreError';
    this.code = code;
  }
}

function fail(code: CoreBatchArtifactStoreErrorCode, message: string): never {
  throw new CoreBatchArtifactStoreError(code, message);
}

function batchDirectoryName(batchId: string): string {
  return `batch-${createHash('sha256').update(batchId).digest('hex')}`;
}

function batchDirectoryPath(rootDir: string, batchId: string): string {
  return join(rootDir, batchDirectoryName(batchId));
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

async function readManifest(directory: string): Promise<CoreBatchManifest> {
  let encoded: string;
  try {
    encoded = await readFile(join(directory, CORE_BATCH_MANIFEST_FILE), 'utf8');
  } catch {
    fail('CORE_BATCH_MANIFEST_MISSING', 'Core batch manifest is missing or unreadable.');
  }
  try {
    return parseCoreBatchManifestDocument(JSON.parse(encoded) as unknown);
  } catch (error: unknown) {
    if (error instanceof CoreBatchArtifactStoreError) throw error;
    fail('CORE_BATCH_MANIFEST_INVALID', 'Core batch manifest is invalid.');
  }
}

async function resolveChildren(
  runStore: CoreRunArtifactStore,
  request: SaveCoreBatchRequest,
): Promise<CoreBatchChildReference[]> {
  if (request.children.length === 0
      || new Set(request.children.map(({ itemId }) => itemId)).size
        !== request.children.length
      || new Set(request.children.map(({ runId }) => runId)).size
        !== request.children.length) {
    fail(
      'CORE_BATCH_INPUT_INVALID',
      'Core batch requires unique item and child run identities.',
    );
  }
  return Promise.all(request.children.map(async (child, ordinal) => {
    let artifacts;
    try {
      artifacts = await runStore.get(child.runId);
    } catch {
      fail('CORE_BATCH_CHILD_INVALID', 'Core batch child run cannot be verified.');
    }
    if (artifacts === undefined) {
      fail('CORE_BATCH_CHILD_NOT_FOUND', 'Core batch child run was not found.');
    }
    const card = {
      batchItemKind: 'core-run' as const,
      itemId: child.itemId,
      ordinal,
      locator: { locatorKind: 'core-run' as const, runId: child.runId },
      reportId: artifacts.manifest.reportId,
      runContractDigest: artifacts.manifest.runContractDigest,
      reportDigest: artifacts.report.reportDigest,
      artifactSetDigest: digestCanonicalJson(artifacts.manifest.documents),
      status: artifacts.manifest.status,
      maximumCapturedClassification: artifacts.manifest.maximumCapturedClassification,
    };
    return card;
  }));
}

function assertChildrenMatch(
  manifest: CoreBatchManifest,
  children: readonly CoreBatchChildReference[],
): void {
  if (canonicalizeJson(manifest.children) !== canonicalizeJson(children)) {
    fail(
      'CORE_BATCH_CHILD_INVALID',
      'Core batch child locator no longer resolves to the recorded artifact set.',
    );
  }
}

export function createNodeCoreBatchArtifactStore(
  rootDir: string,
  runStore: CoreRunArtifactStore,
): CoreBatchArtifactStore {
  const mutations = new KeyedMutex();

  async function loadDirectory(
    directory: string,
    expectedBatchId?: string,
    verifyChildren = true,
  ): Promise<StoredCoreBatch> {
    const manifest = await readManifest(directory);
    if ((expectedBatchId !== undefined && manifest.batchId !== expectedBatchId)
        || batchDirectoryName(manifest.batchId) !== basename(directory)) {
      fail(
        'CORE_BATCH_MANIFEST_INVALID',
        'Core batch manifest identity differs from its locator.',
      );
    }
    if (verifyChildren) {
      const children = await resolveChildren(runStore, {
        batchId: manifest.batchId,
        createdAt: manifest.createdAt,
        children: manifest.children.map(({ itemId, locator }) => ({
          itemId,
          runId: locator.runId,
        })),
      });
      assertChildrenMatch(manifest, children);
    }
    return Object.freeze({ manifest });
  }

  async function get(batchId: string): Promise<StoredCoreBatch | undefined> {
    const directory = batchDirectoryPath(rootDir, batchId);
    if (!await pathExists(directory)) return undefined;
    return loadDirectory(directory, batchId);
  }

  async function save(request: Readonly<SaveCoreBatchRequest>): Promise<StoredCoreBatch> {
    const parsed = SaveCoreBatchRequestSchema.safeParse(request);
    if (!parsed.success) {
      fail('CORE_BATCH_INPUT_INVALID', 'Core batch save request is invalid.');
    }
    const parsedRequest = parsed.data;
    return mutations.run(parsedRequest.batchId, async () => {
      const children = await resolveChildren(runStore, parsedRequest);
      const existing = await get(parsedRequest.batchId);
      if (existing !== undefined) {
        if (canonicalizeJson(existing.manifest.children) === canonicalizeJson(children)) {
          return existing;
        }
        fail('CORE_BATCH_ID_CONFLICT', 'Core batch id identifies different child runs.');
      }
      const manifest = materializeCoreBatchManifest({
        schemaVersion: CORE_BATCH_MANIFEST_SCHEMA_VERSION,
        batchManifestKind: 'evaluation-core-child-runs',
        batchId: parsedRequest.batchId,
        createdAt: parsedRequest.createdAt,
        children,
      });
      await ensurePrivateDirectory(rootDir);
      const staging = join(
        rootDir,
        `.${batchDirectoryName(parsedRequest.batchId)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await mkdir(staging, { mode: 0o700 });
      try {
        await writePrivateJson(join(staging, CORE_BATCH_MANIFEST_FILE), manifest);
        const outcome = await publishPrivateDirectoryExclusive(
          staging,
          batchDirectoryPath(rootDir, parsedRequest.batchId),
        );
        if (outcome === 'exists') {
          const concurrent = await get(parsedRequest.batchId);
          if (concurrent !== undefined
              && canonicalizeJson(concurrent.manifest.children)
                === canonicalizeJson(children)) return concurrent;
          fail(
            'CORE_BATCH_ID_CONFLICT',
            'Core batch id was concurrently published with different child runs.',
          );
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      const stored = await get(parsedRequest.batchId);
      if (stored === undefined) {
        fail('CORE_BATCH_MANIFEST_MISSING', 'Published Core batch cannot be reloaded.');
      }
      return stored;
    });
  }

  async function list(): Promise<CoreBatchIndexCard[]> {
    if (!await pathExists(rootDir)) return [];
    const entries = (await readdir(rootDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^batch-[0-9a-f]{64}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const batches = await Promise.all(entries.map((entry) => (
      loadDirectory(join(rootDir, entry), undefined, false)
    )));
    return batches
      .map(({ manifest }) => projectCoreBatchIndexCard(manifest))
      .sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt)
        || left.batchId.localeCompare(right.batchId)
      ));
  }

  async function exists(batchId: string): Promise<boolean> {
    const directory = batchDirectoryPath(rootDir, batchId);
    if (!await pathExists(directory)) return false;
    await loadDirectory(directory, batchId, false);
    return true;
  }

  return Object.freeze({ save, get, list, exists });
}
