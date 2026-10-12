import type { KnowledgeLibraryKnowledge } from '../../view-models/knowledge/knowledge-library.js';
export function filterLibraryKnowledge(catalog: KnowledgeLibraryKnowledge, filters: {
  query: string; choice: 'all' | 'pending' | 'retain' | 'discard'; knowledgeKind: 'all' | 'fact' | 'case' | 'method'; objects: string[];
}) {
  const search = filters.query.trim().toLocaleLowerCase();
  return catalog.rows.filter(row => (row.title.toLocaleLowerCase().includes(search) || (row.tags ?? []).some(tag => tag.toLocaleLowerCase().includes(search)))
    && (filters.choice === 'all' || (filters.choice === 'pending' ? row.choice === null : row.choice === filters.choice))
    && (filters.knowledgeKind === 'all' || row.knowledgeKind === filters.knowledgeKind)
    && (!filters.objects.length || row.objects.some(object => filters.objects.includes(object.objectId))));
}
