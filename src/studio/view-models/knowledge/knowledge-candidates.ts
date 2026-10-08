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

/** Existing conversation-selection and preview operations; contains no source file paths. */
export interface KnowledgeConversation {
  threadId: string;
  title: string;
  cwd?: string;
}
export interface KnowledgeConversationDetail extends KnowledgeConversation {
  tasks: { turnId: string; title: string }[];
}
export interface KnowledgeConversationPreview {
  origin: NonNullable<KnowledgeCandidateSource['origin']>;
  sourceVersion: string;
  messages: KnowledgeCandidateSource['excerpts'];
}

/** Local review projection; extraction identity and maintenance data stay unchanged. */
export interface KnowledgeReviewBatch {
  runId: string;
  rows: KnowledgeCandidateRow[];
  total: number;
  retained: number;
  discarded: number;
  pending: number;
  missing: number;
  complete: boolean;
  nextId?: string;
}
