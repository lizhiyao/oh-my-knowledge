import { describe, expect, it } from 'vitest';
import { filterLibraryKnowledge } from '../../../src/studio/application/knowledge/library-view.js';
import type { KnowledgeLibraryKnowledge } from '../../../src/studio/view-models/knowledge/knowledge-library.js';
const rows: KnowledgeLibraryKnowledge['rows'] = [
  { bodyDigest: `sha256:${'a'.repeat(64)}`, knowledgeId: 'shared', revisionId: 'one', generation: 1, reviewStatus: 'pending', choice: 'retain', knowledgeKind: 'method', title: 'Shared method', revisedAt: '', objects: [{ objectId: 'a', label: 'A', associationStatus: 'matched' }, { objectId: 'b', label: 'B', associationStatus: 'matched' }] },
  { bodyDigest: `sha256:${'a'.repeat(64)}`, knowledgeId: 'unassociated', revisionId: 'two', generation: 1, reviewStatus: 'pending', choice: null, knowledgeKind: 'fact', title: 'Unassociated fact', revisedAt: '', objects: [] },
  { bodyDigest: `sha256:${'a'.repeat(64)}`, knowledgeId: 'pending', revisionId: 'three', generation: 1, reviewStatus: 'pending', choice: null, knowledgeKind: 'fact', title: 'Pending fact', revisedAt: '', tags: ['SDK'], objects: [{ objectId: 'a', label: 'A', associationStatus: 'needs_review' }] },
];
const defaults = { query: '', choice: 'all', knowledgeKind: 'all', objects: [] } as const;
const select = (changes: Partial<Parameters<typeof filterLibraryKnowledge>[1]> = {}) => filterLibraryKnowledge({ rows, objects: [] }, { ...defaults, objects: [], ...changes });
describe('whole-library presentation filtering', () => {
  it('includes unassociated knowledge by default and takes object unions without copying shared identities', () => {
    expect(select().map(row => row.knowledgeId)).toEqual(['shared', 'unassociated', 'pending']);
    expect(select({ objects: ['a', 'b'] }).map(row => row.knowledgeId)).toEqual(['shared', 'pending']);
    expect(select({ objects: ['b'] })[0]).toBe(rows[0]);
    expect(select({ objects: ['a'], choice: 'pending', knowledgeKind: 'fact', query: 'sdk' }).map(row => row.knowledgeId)).toEqual(['pending']);
    expect(select({ query: 'unknown' })).toEqual([]);
  });
  it('recomputes visible knowledge after current maintenance and title changes, without mutating the projection', () => {
    const before = JSON.stringify(rows); const filtered = select({ choice: 'pending' });
    const revised = { rows: rows.map(row => row.knowledgeId === 'pending' ? { ...row, title: 'Updated', choice: 'retain' as const } : row), objects: [] };
    expect(filterLibraryKnowledge(revised, { ...defaults, objects: [], choice: 'pending' }).map(row => row.knowledgeId)).toEqual(['unassociated']);
    expect(filterLibraryKnowledge(revised, { ...defaults, objects: [], query: 'Pending fact' })).toEqual([]);
    expect(filtered).toHaveLength(2); expect(JSON.stringify(rows)).toBe(before);
  });
});
