import type {
  KnowledgeApplication,
  EvidenceWindow,
} from '../../../observability/application.js';

export type KnowledgeCandidateDetail = ReturnType<KnowledgeApplication['detail']> & { origin?: EvidenceWindow['origin'] };
export type KnowledgeCandidateSource = EvidenceWindow;
export type KnowledgeCandidateRow = ReturnType<KnowledgeApplication['list']>[number];
export interface KnowledgeCandidateRun {
  runId: string; status: string; startedAt?: string;
  committed: { knowledgeId: string; revisionId: string }[];
  rejections: { index: number; reasons: string[] }[];
}
