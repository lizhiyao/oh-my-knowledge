import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../store.js';
import { KnowledgeApplication } from './application.js';
import { KnowledgeReviewApplication } from './review.js';
import { SourceReviewApplication, type SourceReviewPorts } from './source-review.js';
import { FileSourceLedgerStore, FileSourceCoverageStore } from '../adapters/source-review-store.js';
import type { KnowledgeActor } from '../contracts.js';
import { FileKnowledgeReviewStore } from '../adapters/review-store.js';
import { FileSourceStore } from '../adapters/source-store.js';
import { assertSourceMigrationComplete } from '../../evidence/storage/knowledge-workspace.js';
import type { SourceCaptureService } from './source-capture.js';
import { createLocalSourceCapture, type LocalSourceScope } from './local-source-host.js';
import { assertSourceWorkspaceWritable } from '../adapters/source-workspace.js';
import { createLocalSourceUpdates } from './local-source-updates.js';
import { FileKnowledgeStore } from '../adapters/knowledge-store.js';
import { FileGenerationJournalStore } from '../adapters/generation-journal-store.js';
import { FileKnowledgeAssociationStore } from '../adapters/association-store.js';
import { FileKnowledgeTags } from '../adapters/knowledge-tags.js';
import { FileLibraryStore } from '../adapters/library-store.js';
import { KnowledgeLibraryApplication } from './library.js';
import { FileEntityAnalysisStore } from '../adapters/entity-store.js';
import { FileEntityLinkStore } from '../adapters/entity-link-store.js';
import { EntityLinkApplication } from '../entity-linking/entity-links.js';
import { validateEntityLinkPreview } from '../entities/link-invocation-state.js';
import { entityLinkDigest } from '../entity-linking/entity-link-hash.js';
import { entityLinkTextHash } from '../adapters/entity-link-api-producer.js';
import type { ExecutorArchiveProducer } from '../../executors/contracts/archive.js';

/** The root is an explicit user choice shared by CLI and Studio. */
export function createLocalKnowledgeApplication(root: string, options: { sourceCapture?: SourceCaptureService; sourceScope?: LocalSourceScope; actor?: KnowledgeActor } = {}): KnowledgeApplication {
  if (!root.trim()) throw new Error('Explicit knowledge workspace required.');
  const workspace = resolve(root);
  assertSourceMigrationComplete(workspace);
  if (options.sourceScope && options.sourceCapture) throw new Error('Supply either trusted source scope or an existing capture service.');
  const sourceCapture = options.sourceCapture ?? (options.sourceScope ? createLocalSourceCapture(workspace, options.sourceScope) : undefined);
  const knowledge = new FileKnowledgeStore(join(workspace, 'items'), 'local', workspace);
  const entities = new FileEntityAnalysisStore(join(workspace, 'entities'), workspace);
  return new KnowledgeApplication({
    assertWritable: () => assertSourceWorkspaceWritable(workspace),
    sources: new FileSourceStore(join(workspace, 'sources'), workspace),
    ...(sourceCapture ? { sourceCapture } : {}),
    ...(options.sourceScope ? { sourceUpdates: createLocalSourceUpdates(workspace, options.sourceScope) } : {}),
    knowledge,
    journals: new FileGenerationJournalStore(join(workspace, 'generation-journals'), workspace),
    associations: new FileKnowledgeAssociationStore(join(workspace, 'associations'), 'local', knowledge, entities, workspace),
    tags: new FileKnowledgeTags(join(workspace, 'tags'), 'local', workspace),
    entities,
    id: randomUUID, now: () => new Date().toISOString(),
    hash: (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`,
    actor: options.actor ?? { actorKind: 'human', actorId: 'local-user' },
  });
}

export function createLocalKnowledgeLibrary(root: string): KnowledgeLibraryApplication {
  if (!root.trim()) throw new Error('Explicit knowledge workspace required.');
  const workspace = resolve(root);
  return new KnowledgeLibraryApplication(createLocalKnowledgeApplication(workspace), new FileLibraryStore(join(workspace, 'library'), workspace));
}

/** Cross-window reviews have their own v1 journal; extraction histories stay unchanged. */
export function createLocalEntityLinks(root: string, execution: ExecutorArchiveProducer): EntityLinkApplication {
  if (!root.trim()) throw new Error('Explicit knowledge workspace required.');
  const workspace = resolve(root);
  return new EntityLinkApplication(createLocalKnowledgeApplication(workspace),
    new FileEntityAnalysisStore(join(workspace, 'entities'), workspace),
    new FileEntityLinkStore(join(workspace, 'entity-links'), workspace),
    new FileLibraryStore(join(workspace, 'library'), workspace), execution);
}

/** Parse a portable confirmation plan without touching a workspace or executor. */
export function parseEntityLinkPreview(value: unknown) {
  return validateEntityLinkPreview(value, { hashJson: entityLinkDigest, hashText: entityLinkTextHash });
}

/** Ephemeral UI invalidation hint only; never an evidence digest, admission check or persisted identity. */
export function knowledgeWorkspaceRefreshToken(root: string, scope: string, state: unknown): string | undefined {
  try {
    if (!root.trim() || !scope.trim()) return undefined;
    const workspace = resolve(root.trim());
    try {
      const stat = lstatSync(workspace);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined; }
    const heads = ['items', 'generation-journals', 'associations', 'tags', 'entities'].map(name => {
      const directory = join(workspace, name);
      try {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid knowledge head directory.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [name, null];
        throw error;
      }
      // Match the existing readers' published JSON heads; ignore temporary files and native-outcome subdirectories.
      return [name, readdirSync(directory).filter(file => file.endsWith('.json')).sort().map(file => {
        const stat = lstatSync(join(directory, file), { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid knowledge head file.');
        return [file, stat.dev.toString(), stat.ino.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()];
      })];
    });
    // Include the response state and request scope; this weak tag is not a byte-integrity promise.
    const value = createHash('sha256').update(JSON.stringify([workspace, scope.trim(), state, heads])).digest('hex');
    return `W/"omk-ui-${value}"`;
  } catch { return undefined; } // A missing hint means conservative UI refresh, never a cached acceptance.
}

/** The host supplies the actual actor. An omitted actor deliberately creates a read-only instance. */
export function createLocalKnowledgeReview(root: string, actor?: KnowledgeActor): KnowledgeReviewApplication {
  if (!root.trim()) throw new Error('Explicit review workspace required.');
  const workspace = resolve(root), knowledge = new FileKnowledgeStore(join(workspace, 'items'), 'local', workspace);
  assertSourceMigrationComplete(workspace);
  const entities = new FileEntityAnalysisStore(join(workspace, 'entities'), workspace);
  return new KnowledgeReviewApplication({ knowledge, entities, associations: new FileKnowledgeAssociationStore(join(workspace, 'associations'), 'local', knowledge, entities, workspace),
    sources: new FileSourceStore(join(workspace, 'sources'), workspace), reviews: new FileKnowledgeReviewStore(join(workspace, 'reviews'), 'local', workspace),
    actor, now: () => new Date().toISOString(), assertWritable: () => assertSourceWorkspaceWritable(workspace) });
}

/** Source analyses require a trusted original reader; an omitted actual actor keeps the host read-only. */
export function createLocalKnowledgeSourceReview(root: string, options: Pick<SourceReviewPorts, 'actor' | 'readOriginal'> = {}): SourceReviewApplication {
  if (!root.trim()) throw new Error('Explicit source review workspace required.');
  const workspace = resolve(root);
  assertSourceMigrationComplete(workspace);
  return new SourceReviewApplication({
    sources: new FileSourceStore(join(workspace, 'sources'), workspace),
    knowledge: new FileKnowledgeStore(join(workspace, 'items'), 'local', workspace),
    ledgers: new FileSourceLedgerStore(join(workspace, 'source-ledgers'), 'local', workspace),
    coverage: new FileSourceCoverageStore(join(workspace, 'source-coverage'), 'local', workspace),
    ...options, now: () => new Date().toISOString(), assertWritable: () => assertSourceWorkspaceWritable(workspace),
  });
}
