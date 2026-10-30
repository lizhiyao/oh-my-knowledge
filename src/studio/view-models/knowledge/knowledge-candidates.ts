import type { KnowledgeApplication } from '../../../knowledge/application/application.js';
import type { SourceSnapshot, SourceResolution, TraceOrigin, SourceRef } from '../../../knowledge/sources.js';
import type { SourceLedgerRef, SourceCoverageRef, SourceCoverageDecisionRef } from '../../../knowledge/source-review.js';
import type { KnowledgeBodyRef } from '../../../knowledge/contracts.js';
import type { GenerationArchiveCheck, GenerationStage, GenerationJournal } from '../../../knowledge/extraction/generation-journal.js';
import type { KnowledgeRetrievalRequest, KnowledgeRetrievalResult } from '../../../knowledge/application/retrieval.js';

type CandidateDetail = ReturnType<KnowledgeApplication['detail']>;
type WithoutRaw<T> = T extends SourceSnapshot ? Omit<T, 'rawUnits'> : never;
export type SourceViewSnapshot = WithoutRaw<SourceSnapshot>;
export type SourceViewResolution = Exclude<SourceResolution, { status: 'available' }> | { status: 'available'; snapshot: SourceViewSnapshot };
export type KnowledgeCandidateDetail = Omit<CandidateDetail, 'sources'> & { sources: SourceViewResolution[]; origin?: TraceOrigin };
export type KnowledgeGraph = ReturnType<KnowledgeApplication['graph']>;
export type KnowledgeAssociationCatalogs = ReturnType<KnowledgeApplication['associationCatalogs']>;
export type KnowledgeExtractionQuality = ReturnType<KnowledgeApplication['quality']>;
export type KnowledgeTaskRetrieval = KnowledgeRetrievalResult;
export type KnowledgeTaskQuery = Pick<KnowledgeRetrievalRequest, 'query' | 'maxBytes' | 'includeCandidates' | 'snapshot' | 'sourceVersion'>;
export type KnowledgeCandidateRow = ReturnType<KnowledgeApplication['list']>[number];
export type KnowledgeEntityCatalog = Omit<ReturnType<KnowledgeApplication['queryEntities']>, 'knowledgeStatus'> & { knowledgeStatus: 'available' | 'unavailable' };
export type KnowledgeEntityLibraryDetail = Omit<ReturnType<KnowledgeApplication['entityDetail']>, 'source' | 'knowledgeStatus'> & Pick<KnowledgeEntityAnalysisDetail, 'source'> & { knowledgeStatus: 'available' | 'unavailable' };
export interface KnowledgeCandidateRun {
  runId: string; schemaStatus: 'current' | 'unsupported' | 'unavailable'; status: 'active' | 'completed' | 'failed' | 'unsupported' | 'unavailable';
  journalGeneration?: number; workflowId?: GenerationJournal['workflowId']; mode?: GenerationJournal['mode']; inputVersion?: string; sourceSetId?: string; preparedStage?: GenerationStage;
  createdAt?: string; executor?: string; model?: string; sources?: { snapshotId: string; sourceVersion: string; sourceKind?: SourceSnapshot['sourceKind']; projectId?: string; origin?: TraceOrigin }[];
  sourceMetadataStatus?: 'frozen_input' | 'unknown';
  archiveVerification: 'not_verified' | 'verified'; archiveChecks: GenerationArchiveCheck[];
  bodies: KnowledgeBodyRef[]; ledgerRef?: SourceLedgerRef; coverageRef?: SourceCoverageRef; sourceCoverageDecisionRef?: SourceCoverageDecisionRef;
  phases: (Pick<GenerationStage, 'stageKind' | 'state' | 'invocationId' | 'profileId' | 'promptVersion' | 'wireId' | 'outcomeRef' | 'committed' | 'issues'> & {
    producerId: string; producerRevision: string; rejectedCount: number | null;
  })[];
  nextAction: 'prepare_next_stage' | 'review_source_coverage' | 'continue_stage' | 'outcome_unknown_do_not_redispatch' | 'resume_publication' | 'none' | 'unsupported' | 'unavailable';
  entityAnalyses?: { analysisId: string; revisionId: string; entityCount: number; mentionCount: number; unresolvedCount: number; reviewStatus: 'pending' }[];
  unsupportedReason?: string;
  unavailableReason?: 'unreadable' | 'invalid_identity' | 'invalid_source_metadata' | 'project_membership_unavailable';
}
export interface KnowledgeCandidateQueue { rows: KnowledgeCandidateRow[]; runs: KnowledgeCandidateRun[] }
type EntityDetail = ReturnType<KnowledgeApplication['entities']>;
export type KnowledgeEntityAnalysisDetail = Omit<EntityDetail, 'source'> & { source: SourceViewResolution };

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
  origin: TraceOrigin;
  sourceVersion: string;
  messages: { excerptKey: string; recordIndex: number; role: string; text: string; timestamp?: string }[];
  preview: KnowledgeSourcePreview;
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

/** Local source preview contains selected originals; it never grants model-send authority. */
export type KnowledgeSourcePreview = ReturnType<KnowledgeApplication['previewSources']>;
export type KnowledgeSourceCapture = ReturnType<KnowledgeApplication['captureSources']>;
export type KnowledgeSourceRef = SourceRef;
export interface KnowledgeSourceCatalog {
  projects: { projectId: string }[];
  traces: { sourceId: string; traceKind: string; title?: string }[];
}

export type KnowledgeSourceUpdates = ReturnType<KnowledgeApplication['sourceUpdates']>;
