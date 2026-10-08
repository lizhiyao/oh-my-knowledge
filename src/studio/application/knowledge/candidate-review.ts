import type { KnowledgeCandidateRow, KnowledgeCandidateRun, KnowledgeReviewBatch } from '../../view-models/knowledge/knowledge-candidates.js';

/** A batch is the candidates actually saved by one extraction, never the whole folder. */
export function candidateReviewRun(runs: KnowledgeCandidateRun[], knowledgeId: string) {
  return runs.find(run => run.committed.some(item => item.knowledgeId === knowledgeId));
}

/** Project current maintenance choices, including new revisions that await a new decision. */
export function projectCandidateBatch(run: KnowledgeCandidateRun | undefined, rows: KnowledgeCandidateRow[], selectedId?: string): KnowledgeReviewBatch | undefined {
  if (!run?.committed.length) return undefined;
  const ids = [...new Set(run.committed.map(item => item.knowledgeId))];
  const byId = new Map(rows.map(row => [row.knowledgeId, row]));
  const batchRows = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  const current = batchRows.findIndex(row => row.knowledgeId === selectedId);
  const next = [...batchRows.slice(current + 1), ...batchRows.slice(0, Math.max(current, 0))].find(row => row.choice === null);
  const pending = batchRows.filter(row => row.choice === null).length;
  const missing = ids.length - batchRows.length;
  return { runId: run.runId, rows: batchRows, total: ids.length, pending, missing,
    retained: batchRows.filter(row => row.choice === 'retain').length,
    discarded: batchRows.filter(row => row.choice === 'discard').length,
    complete: pending === 0 && missing === 0, ...(next ? { nextId: next.knowledgeId } : {}) };
}
