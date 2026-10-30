import { join, resolve } from 'node:path';
import { assertSourceMigrationComplete, KnowledgeStorageStateError } from '../../evidence/storage/knowledge-workspace.js';
import { FileGenerationJournalStore } from './generation-journal-store.js';
import { FileSourceStore } from './source-store.js';

/** No marker or compatibility decoder: older workspaces must be migrated to an independent copy. */
export function assertSourceWorkspaceWritable(root: string): void {
  if (!root.trim()) throw new Error('Explicit knowledge workspace required.');
  const workspace = resolve(root);
  assertSourceMigrationComplete(workspace);
  new FileSourceStore(join(workspace, 'sources'), workspace).assertCurrentFormat();
  const inventory = new FileGenerationJournalStore(join(workspace, 'generation-journals'), workspace).list();
  if (inventory.unsupported.length || inventory.unavailable.length) throw new KnowledgeStorageStateError('knowledge_storage_unsupported');
}
