import { KnowledgeDraftSchema, type EvidenceExcerpt, type EvidenceSelection, type KnowledgeDraft } from './contracts.js';

export interface KnowledgeSourceView {
  snapshotId: string;
  sourceVersion: string;
  excerpts: readonly EvidenceExcerpt[];
}
export interface KnowledgeValidationProblem {
  code: 'invalid_structure' | 'duplicate_id' | 'unknown_evidence' | 'quote_mismatch' | 'source_mismatch';
  path: string;
}

/** Structural admission and, when sources are supplied, exact citation checking; never a truth or completeness judgement. */
export function validateKnowledgeDraft(input: unknown, sources?: readonly KnowledgeSourceView[]):
  { accepted: true; draft: KnowledgeDraft } | { accepted: false; problems: KnowledgeValidationProblem[] } {
  const parsed = KnowledgeDraftSchema.safeParse(input);
  if (!parsed.success) return { accepted: false, problems: parsed.error.issues.map(issue => ({
    code: 'invalid_structure', path: issue.path.join('.'),
  })) };
  const draft = parsed.data; const problems: KnowledgeValidationProblem[] = [];
  const ids = new Set<string>();
  for (const [i, segment] of draft.content.segments.entries()) {
    const path = `content.segments.${i}`;
    if (ids.has(segment.segmentId)) problems.push({ code: 'duplicate_id', path });
    ids.add(segment.segmentId);
    for (const [j, evidence] of segment.evidence.entries()) {
      const evidencePath = `${path}.evidence.${j}`;
      const selection = evidence.selection;
      if (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)
        || selection.end - selection.start !== selection.quote.length) problems.push({ code: 'quote_mismatch', path: evidencePath });
      if (sources) {
        const matches = sources.filter(source => source.snapshotId === evidence.source.snapshotId
          && source.sourceVersion === evidence.source.sourceVersion);
        if (matches.length !== 1) problems.push({ code: 'source_mismatch', path: evidencePath });
        else problems.push(...validateEvidenceSelection(selection, matches[0].excerpts).map(problem => ({ ...problem, path: evidencePath })));
      }
    }
  }
  return problems.length ? { accepted: false, problems } : { accepted: true, draft };
}

export function validateEvidenceSelection(selection: EvidenceSelection, excerpts: readonly EvidenceExcerpt[]): KnowledgeValidationProblem[] {
  const matches = excerpts.filter(excerpt => excerpt.evidenceRef === selection.evidenceRef);
  if (matches.length !== 1) return [{ code: 'unknown_evidence', path: selection.evidenceRef }];
  const source = matches[0].text;
  if (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)
    || selection.start < 0 || selection.end <= selection.start || selection.end > source.length
    || !selection.quote || source.slice(selection.start, selection.end) !== selection.quote) {
    return [{ code: 'quote_mismatch', path: selection.evidenceRef }];
  }
  return [];
}
