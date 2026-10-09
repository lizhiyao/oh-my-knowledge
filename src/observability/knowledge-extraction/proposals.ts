import { z } from 'zod';
import {
  EntityMentionSchema, EvidenceSelectionSchema, KnowledgeDraftSchema,
  type EvidenceExcerpt, type EvidenceSelection,
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

const quoteSelectionSchema = EvidenceSelectionSchema.omit({ start: true, end: true });
/** v2 delegates UTF-16 positions to the host; persisted grounding still uses the full schema. */
export const ExtractionModelProposalSchema = ExtractionProposalSchema.extend({
  mentions: z.array(EntityMentionSchema.extend({ selection: quoteSelectionSchema })).min(1).max(512),
  citations: z.array(z.strictObject({
    evidenceLinkId: z.string().min(1).max(256), selection: quoteSelectionSchema,
  })).min(1).max(512),
});
export type ExtractionModelProposal = z.infer<typeof ExtractionModelProposalSchema>;

export function extractionResponseChecker(version: string) {
  if (version === 'knowledge-extraction-v2') {
    return (input: unknown, excerpts: readonly EvidenceExcerpt[]) => checkResponse(input, excerpts, true);
  }
  // Persisted v1/local-rule runs resume with their original strict admission semantics.
  if (version === 'knowledge-extraction-v1' || version === 'knowledge-local-rules-v1') return checkExtractionResponse;
  throw new Error(`Unsupported extraction prompt version: ${version}`);
}

function resolveQuote(selection: z.infer<typeof quoteSelectionSchema>, excerpts: readonly EvidenceExcerpt[]): EvidenceSelection | string {
  const excerpt = excerpts.find((item) => item.evidenceRef === selection.evidenceRef);
  if (!excerpt) return 'unknown_evidence';
  const start = excerpt.text.indexOf(selection.quote);
  if (start < 0) return 'quote_mismatch';
  // Count overlapping matches too; never choose the first occurrence arbitrarily.
  if (excerpt.text.indexOf(selection.quote, start + 1) >= 0) return 'ambiguous_quote';
  return { ...selection, start, end: start + selection.quote.length };
}

function resolveProposal(proposal: ExtractionModelProposal, excerpts: readonly EvidenceExcerpt[]) {
  const reasons: string[] = [];
  const mentions = proposal.mentions.flatMap((mention) => {
    const selection = resolveQuote(mention.selection, excerpts);
    if (typeof selection === 'string') { reasons.push(`mention:${selection}`); return []; }
    return [{ ...mention, selection }];
  });
  const citations = proposal.citations.flatMap((citation) => {
    const selection = resolveQuote(citation.selection, excerpts);
    if (typeof selection === 'string') { reasons.push(`citation:${selection}`); return []; }
    return [{ ...citation, selection }];
  });
  return { proposal: { ...proposal, mentions, citations }, reasons };
}

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
  return checkResponse(input, excerpts, false);
}

function checkResponse(input: unknown, excerpts: readonly EvidenceExcerpt[], quoteOnly: boolean): CheckedProposals {
  const response = responseSchema.parse(input);
  const evidence = new Set(excerpts.map((excerpt) => excerpt.evidenceRef));
  if (evidence.size !== excerpts.length) throw new Error('Ambiguous evidence window.');
  const parsed = response.proposals.map((proposal) => (quoteOnly ? ExtractionModelProposalSchema : ExtractionProposalSchema).safeParse(proposal));
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
    const resolved = quoteOnly ? resolveProposal(result.data, excerpts) : { proposal: result.data as ExtractionProposal, reasons: [] };
    const proposal = resolved.proposal;
    const reasons = resolved.reasons;
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
