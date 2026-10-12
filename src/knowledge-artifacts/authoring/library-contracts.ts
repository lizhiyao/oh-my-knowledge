export type AuthoredArtifactKind = 'skill' | 'prompt';
export interface CarrierKnowledgeRef { knowledgeId: string; revisionId: string; generation: number }
export type CarrierSource = { sourceKind: 'new' } | { sourceKind: 'library'; artifactId: string } | { sourceKind: 'local'; path: string };
export interface CarrierVersion {
  schemaVersion: 'omk-carrier-v1'; artifactId: string; revisionId: string; version: number;
  name: string; directoryName: string; artifactKind: AuthoredArtifactKind; savedAt: string;
  knowledgeRefs: CarrierKnowledgeRef[]; contentHash: string;
  baseline: { locator: string; contentHash: string; revisionId: string | null } | null;
}
export interface CarrierDetail extends CarrierVersion { content: string; locator: string; artifactPath: string; drifted: boolean; versions: { version: number; revisionId: string; savedAt: string }[] }
export type CarrierRow = Pick<CarrierDetail, 'artifactId' | 'name' | 'artifactKind' | 'version' | 'savedAt' | 'locator' | 'drifted'>;
export interface CarrierDraft {
  artifactId: string; artifactKind: AuthoredArtifactKind; name: string; directoryName: string;
  source: CarrierSource; baselineRevisionId: string | null; baselineHash: string | null; baseContent: string; content: string; knowledgeRefs: CarrierKnowledgeRef[]; selectedRefs: CarrierKnowledgeRef[];
  tagSelections: { knowledgeId: string; generation: number }[];
}

/** Read-time review signals; none of these fields are persisted in a carrier manifest. */
export type CarrierReviewReason = 'revision_changed' | 'not_retained' | 'source_unavailable' | 'incorporated_unavailable' | 'current_unavailable';
export interface CarrierKnowledgeCheck {
  knowledgeId: string; title: string; incorporatedRevisionId: string; currentRevisionId: string | null;
  currentChoice: 'retain' | 'discard' | null; reasons: CarrierReviewReason[];
  changedFields: ('title' | 'statements' | 'organization' | 'entities' | 'evidence' | 'grounding')[];
  incorporatedContent: string | null; currentContent: string | null;
}
export interface CarrierReviewSummary { referenceCount: number; needsReviewCount: number; unavailableCount: number }
export interface CarrierKnowledgeReview extends CarrierReviewSummary { checkedAt: string; checks: CarrierKnowledgeCheck[] }
export interface ReviewedCarrierDetail extends CarrierDetail { knowledgeReview: CarrierKnowledgeReview }
export type ReviewedCarrierRow = CarrierRow & { knowledgeReview: CarrierReviewSummary };
export interface ReviewedCarrierDraft extends CarrierDraft {
  selectionChanges: { knowledgeId: string; title: string; previousRevisionIds: string[]; selectedRevisionId: string | null; changeKind: 'added' | 'replaced' | 'removed' | 'kept' }[];
}
