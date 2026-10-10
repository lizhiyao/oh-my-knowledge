import type {
  KnowledgeApplication,
  EvidenceWindow,
  ExtractionRunSummary,
} from '../../../observability/application.js';

type CandidateDetail = ReturnType<KnowledgeApplication['detail']>;
export type KnowledgeCandidateDetail = Omit<CandidateDetail, 'entityAnalysis'> & {
  entityAnalysis?: ({ status: 'available' } & KnowledgeEntityAnalysisDetail)
    | { status: 'unavailable'; reason: 'analysis_unavailable' };
  origin?: EvidenceWindow['origin'];
};
export type KnowledgeCandidateSource = EvidenceWindow;
export type KnowledgeCandidateRow = ReturnType<KnowledgeApplication['list']>[number];
export type KnowledgeCandidateRun = Omit<ExtractionRunSummary, 'startedAt'> & { startedAt?: string };
export interface KnowledgeCandidateQueue { rows: KnowledgeCandidateRow[]; runs: KnowledgeCandidateRun[] }
export type { AutoExtractionState, AutoExtractionPreview } from '../../../observability/application.js';
type EntityDetail = ReturnType<KnowledgeApplication['entities']>;
export type KnowledgeEntityAnalysisDetail = Omit<EntityDetail, 'source'> & {
  source: { status: 'available'; excerpts: EvidenceWindow['excerpts']; limitations: EvidenceWindow['limitations'] }
    | Exclude<EntityDetail['source'], { status: 'available' }>;
};

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
