import { describe, expect, it } from 'vitest';
import { validateEvidenceSelection, validateKnowledgeDraft } from '../../src/knowledge/validation.js';
import { KnowledgeTimeSchema } from '../../src/knowledge/contracts.js';
import { bodyDraft } from './body-fixtures.js';

describe('canonical knowledge body admission', () => {
  it('admits body without entities or typed labels and requires direct evidence for every segment', () => {
    const draft = bodyDraft();
    expect(validateKnowledgeDraft(draft)).toEqual({ accepted: true, draft });
    expect(validateKnowledgeDraft({ ...draft, entities: [] }).accepted).toBe(false);
    draft.content.segments[0].evidence = []; expect(validateKnowledgeDraft(draft).accepted).toBe(false);
  });
  it('checks source version and exact UTF16 selections when the selected source is supplied', () => {
    const draft = bodyDraft(), evidence = draft.content.segments[0].evidence[0];
    const source = { ...evidence.source, excerpts: [{ evidenceRef: 'record-1', text: 'Alpha 之后' }] };
    expect(validateKnowledgeDraft(draft, [source]).accepted).toBe(true);
    expect(validateKnowledgeDraft(draft, [{ ...source, sourceVersion: `sha256:${'b'.repeat(64)}` }])).toMatchObject({ accepted: false, problems: [{ code: 'source_mismatch' }] });
    expect(validateKnowledgeDraft(draft, [{ ...source, excerpts: [{ evidenceRef: 'record-1', text: 'Beta' }] }])).toMatchObject({ accepted: false, problems: [{ code: 'quote_mismatch' }] });
    expect(validateKnowledgeDraft(draft, [source, source]).accepted).toBe(false);
  });
  it('rejects duplicate segment IDs, forged lifecycle fields and malformed ranges without completing content from titles', () => {
    const draft = bodyDraft(); draft.content.segments.push(structuredClone(draft.content.segments[0]));
    expect(validateKnowledgeDraft(draft)).toMatchObject({ accepted: false, problems: [{ code: 'duplicate_id' }] });
    expect(validateKnowledgeDraft({ ...bodyDraft(), reviewStatus: 'retain' }).accepted).toBe(false);
    draft.content.segments.pop(); draft.content.segments[0].evidence[0].selection.end += 1;
    expect(validateKnowledgeDraft(draft)).toMatchObject({ accepted: false, problems: [{ code: 'quote_mismatch' }] });
  });
  it('does not impose a retrieval budget on complete stored body text', () => {
    const draft = bodyDraft(); draft.content.segments[0].text += '完整条件。'.repeat(10_000);
    expect(validateKnowledgeDraft(draft).accepted).toBe(true);
  });
  it('retains the shared explicit time validator without turning message time into fact time', () => {
    const start = { boundKind: 'known', at: '2026-09-13T00:00:00Z' };
    expect(KnowledgeTimeSchema.safeParse({ timeKind: 'interval', start, end: start }).success).toBe(false);
    expect(KnowledgeTimeSchema.safeParse({ timeKind: 'interval', start, end: { boundKind: 'unknown', reason: '未记录' } }).success).toBe(true);
  });
});

describe('evidence positions', () => {
  const excerpts = [{ evidenceRef: 'r', text: '前文😀项目 Alpha 使用 Beta。后文' }];
  const selection = { evidenceRef: 'r', start: 4, end: 12, quote: '项目 Alpha' };
  it('matches the exact original excerpt using UTF-16 offsets', () => {
    expect(validateEvidenceSelection(selection, excerpts)).toEqual([]);
  });
  it.each([
    { quote: '虚构原文' }, { start: -1 }, { end: 999 }, { start: 4.5 }, { end: 4 },
  ])('rejects mismatched or invalid selections %j', (change) => {
    expect(validateEvidenceSelection({ ...selection, ...change }, excerpts)[0].code).toBe('quote_mismatch');
  });
  it('rejects unknown and ambiguous source identities', () => {
    expect(validateEvidenceSelection(selection, [])[0].code).toBe('unknown_evidence');
    expect(validateEvidenceSelection(selection, [...excerpts, ...excerpts])[0].code).toBe('unknown_evidence');
  });
});
