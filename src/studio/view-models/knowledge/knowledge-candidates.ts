import type { KnowledgeApplication } from '../../../knowledge/application/application.js';
import type { EvidenceWindow } from '../../../knowledge/extraction/evidence.js';
import type { KnowledgeBodyRef } from '../../../knowledge/contracts.js';
import type { GenerationArchiveCheck, GenerationStage } from '../../../knowledge/extraction/generation-journal.js';

type CandidateDetail = ReturnType<KnowledgeApplication['detail']>;
export type KnowledgeCandidateDetail = CandidateDetail & { origin?: EvidenceWindow['origin'] };
export type KnowledgeCandidateSource = EvidenceWindow;
export type KnowledgeExtractionQuality = ReturnType<KnowledgeApplication['quality']>;
export type KnowledgeCandidateRow = ReturnType<KnowledgeApplication['list']>[number];
export type KnowledgeEntityCatalog = Omit<ReturnType<KnowledgeApplication['queryEntities']>, 'knowledgeStatus'> & { knowledgeStatus: 'available' | 'unavailable' };
export type KnowledgeEntityLibraryDetail = Omit<ReturnType<KnowledgeApplication['entityDetail']>, 'source' | 'knowledgeStatus'> & Pick<KnowledgeEntityAnalysisDetail, 'source'> & { knowledgeStatus: 'available' | 'unavailable' };
export interface KnowledgeCandidateRun {
  runId: string; schemaStatus: 'current' | 'unsupported' | 'unavailable'; status: 'active' | 'completed' | 'failed' | 'unsupported' | 'unavailable';
  createdAt?: string; executor?: string; model?: string; snapshotId?: string; sourceVersion?: string; origin?: EvidenceWindow['origin'];
  sourceMetadataStatus?: 'frozen_input' | 'unknown';
  archiveVerification: 'not_verified' | 'verified'; archiveChecks: GenerationArchiveCheck[];
  bodies: KnowledgeBodyRef[];
  phases: (Pick<GenerationStage, 'stageKind' | 'state' | 'invocationId' | 'profileId' | 'promptVersion' | 'wireId' | 'outcomeRef' | 'committed' | 'issues'> & {
    producerId: string; producerRevision: string; rejectedCount: number | null;
  })[];
  nextAction: 'continue_stage' | 'outcome_unknown_do_not_redispatch' | 'resume_publication' | 'none' | 'unsupported' | 'unavailable';
  entityAnalysis?: { analysisId: string; revisionId: string; entityCount: number; mentionCount: number; unresolvedCount: number; reviewStatus: 'pending' };
  unsupportedReason?: string;
  unavailableReason?: 'unreadable' | 'invalid_identity' | 'invalid_source_metadata';
}
export interface KnowledgeCandidateQueue { rows: KnowledgeCandidateRow[]; runs: KnowledgeCandidateRun[] }
export type { AutoExtractionState, AutoExtractionStatus, AutoExtractionPreview } from '../../../knowledge/application/auto-extraction.js';
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
