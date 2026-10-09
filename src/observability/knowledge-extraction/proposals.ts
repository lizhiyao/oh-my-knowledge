import type { EntityMention, EvidenceExcerpt, EvidenceSelection, KnowledgeDraft } from '../../knowledge/contracts.js';
import { GroundingSchema } from '../../knowledge/store.js';
import { validateEvidenceSelection, validateGroundingReferences, validateKnowledgeDraft } from '../../knowledge/validation.js';

/** Host-resolved proposal using the shared window's temporary model identities. */
export interface ExtractionProposal {
  proposalId: string;
  draft: KnowledgeDraft;
  mentions: EntityMention[];
  citations: { evidenceLinkId: string; selection: EvidenceSelection }[];
  reuseRationale: string;
  identityUncertainties: string[];
}

export interface ProposalRejection { index: number; reasons: string[] }
export interface CheckedProposals {
  accepted: ExtractionProposal[];
  rejected: ProposalRejection[];
}

/** Validate the host-resolved proposal against the selected evidence window. */
export function resolvedProposalProblems(proposal: ExtractionProposal, excerpts: readonly EvidenceExcerpt[]): string[] {
  const evidence = new Set(excerpts.map(excerpt => excerpt.evidenceRef));
  if (evidence.size !== excerpts.length) throw new Error('Ambiguous evidence window.');
  const reasons: string[] = [];
  if (!GroundingSchema.shape.identityUncertainties.safeParse(proposal.identityUncertainties).success) {
    return ['invalid_structure:identityUncertainties'];
  }
  const draftResult = validateKnowledgeDraft(proposal.draft, evidence);
  if (!draftResult.accepted) reasons.push(...draftResult.problems.map(problem => `${problem.code}:${problem.path}`));
  reasons.push(...validateGroundingReferences(proposal.draft, proposal, evidence));
  for (const mention of proposal.mentions) {
    reasons.push(...validateEvidenceSelection(mention.selection, excerpts).map(problem => `mention:${problem.code}`));
  }
  for (const citation of proposal.citations) {
    reasons.push(...validateEvidenceSelection(citation.selection, excerpts).map(problem => `citation:${problem.code}`));
  }
  return reasons;
}
