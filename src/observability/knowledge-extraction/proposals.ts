import { z } from 'zod';
import {
  EntityMentionSchema, EvidenceSelectionSchema, KnowledgeDraftSchema,
  type EvidenceExcerpt,
} from '../../knowledge/contracts.js';
import { validateEvidenceSelection, validateGroundingReferences, validateKnowledgeDraft } from '../../knowledge/validation.js';

/** Local model identifiers exist only at this transport boundary. */
export const ExtractionProposalSchema = z.strictObject({
  proposalId: z.string().min(1).max(256),
  draft: KnowledgeDraftSchema,
  mentions: z.array(EntityMentionSchema).min(1).max(512),
  citations: z.array(z.strictObject({
    evidenceLinkId: z.string().min(1).max(256), selection: EvidenceSelectionSchema,
  })).min(1).max(512),
  reuseRationale: z.string().min(1).max(4096),
  identityUncertainties: z.array(z.string().min(1).max(4096)).max(64),
});
export type ExtractionProposal = z.infer<typeof ExtractionProposalSchema>;

const responseSchema = z.strictObject({
  proposals: z.array(z.unknown()).max(12),
});
export interface ProposalRejection { index: number; reasons: string[] }
export interface CheckedProposals {
  accepted: ExtractionProposal[];
  rejected: ProposalRejection[];
}

/** Partial acceptance preserves errors; an empty result is not a generation failure. */
export function checkExtractionResponse(input: unknown, excerpts: readonly EvidenceExcerpt[]): CheckedProposals {
  const response = responseSchema.parse(input);
  const evidence = new Set(excerpts.map((excerpt) => excerpt.evidenceRef));
  if (evidence.size !== excerpts.length) throw new Error('Ambiguous evidence window.');
  const parsed = response.proposals.map((proposal) => ExtractionProposalSchema.safeParse(proposal));
  const proposalCounts = new Map<string, number>();
  for (const result of parsed) {
    if (result.success) proposalCounts.set(result.data.proposalId, (proposalCounts.get(result.data.proposalId) ?? 0) + 1);
  }
  const accepted: ExtractionProposal[] = [];
  const rejected: ProposalRejection[] = [];
  for (const [index, result] of parsed.entries()) {
    if (!result.success) {
      rejected.push({ index, reasons: result.error.issues.map((issue) => `invalid_structure:${issue.path.join('.')}`) });
      continue;
    }
    const proposal = result.data;
    const reasons: string[] = [];
    if (proposalCounts.get(proposal.proposalId) !== 1) reasons.push('duplicate_proposal');
    const draftResult = validateKnowledgeDraft(proposal.draft, evidence);
    if (!draftResult.accepted) reasons.push(...draftResult.problems.map((problem) => `${problem.code}:${problem.path}`));
    reasons.push(...validateGroundingReferences(proposal.draft, proposal, evidence));
    for (const mention of proposal.mentions) {
      reasons.push(...validateEvidenceSelection(mention.selection, excerpts).map((problem) => `mention:${problem.code}`));
    }
    for (const citation of proposal.citations) {
      reasons.push(...validateEvidenceSelection(citation.selection, excerpts).map((problem) => `citation:${problem.code}`));
    }
    if (reasons.length) rejected.push({ index, reasons });
    else accepted.push(proposal);
  }
  return { accepted, rejected };
}
