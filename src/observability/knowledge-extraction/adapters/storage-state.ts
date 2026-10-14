import { KnowledgeStorageStateError } from '../../../evidence/storage/knowledge-workspace.js';

export function assertCurrentStorage(value: unknown, storage: 'knowledge' | 'run'): void {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const current = storage === 'knowledge'
    ? data.storeKind === 'knowledge-item-history' && data.schemaVersion === 2
    : data.runKind === 'knowledge-extraction-run' && data.schemaVersion === 4;
  if (!current) throw new KnowledgeStorageStateError('knowledge_storage_unsupported');
}
