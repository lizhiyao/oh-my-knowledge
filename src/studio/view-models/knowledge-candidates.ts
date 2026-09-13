import type { KnowledgeApplication } from '../../observability/knowledge-extraction/application.js';
import type { EvidenceWindow } from '../../observability/knowledge-extraction/evidence.js';
export type KnowledgeCandidateDetail = ReturnType<KnowledgeApplication['detail']>;
export type KnowledgeCandidateSource = EvidenceWindow;
export type KnowledgeCandidateRow = ReturnType<KnowledgeApplication['list']>[number];
export interface KnowledgeCandidateRun {
  runId: string; status: string; startedAt?: string;
  committed: { knowledgeId: string; revisionId: string }[];
  rejections: { index: number; reasons: string[] }[];
}
