import { createHash } from 'node:crypto';
import { KnowledgeDraftSchema, type KnowledgeBodyRef, type KnowledgeDraft, type KnowledgeRevision } from '../contracts.js';
import { canonicalJson } from '../store.js';

export function canonicalKnowledgeBody(input: KnowledgeDraft): string {
  const { title, content, reuseRationale } = KnowledgeDraftSchema.parse({ title: input.title, content: input.content, reuseRationale: input.reuseRationale });
  return canonicalJson({ bodyVersion: 'knowledge-body/v1', title, content, reuseRationale });
}
export function knowledgeBodyDigest(draft: KnowledgeDraft): string {
  return `sha256:${createHash('sha256').update(canonicalKnowledgeBody(draft)).digest('hex')}`;
}
export function knowledgeBodyRef(revision: KnowledgeRevision): KnowledgeBodyRef {
  return { knowledgeId: revision.knowledgeId, revisionId: revision.revisionId, bodyDigest: revision.bodyDigest };
}
export function validateKnowledgeBodyDigests(revisions: readonly KnowledgeRevision[]): void {
  for (const revision of revisions) {
    const draft = { title: revision.title, content: revision.content, reuseRationale: revision.reuseRationale };
    if (knowledgeBodyDigest(draft) !== revision.bodyDigest) throw new Error('Knowledge body digest mismatch.');
  }
}
