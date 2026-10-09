import { describe, expect, it } from 'vitest';
import { validateEvidenceSelection, validateKnowledgeDraft } from '../../src/knowledge/validation.js';
import { KnowledgeTimeSchema, type KnowledgeDraft } from '../../src/knowledge/contracts.js';
import { checkExtractionResponse, extractionResponseChecker, type ExtractionProposal } from '../../src/observability/knowledge-extraction/proposals.js';

import { draft, modelProposal, proposal } from './fixtures.js';
const evidence = new Set(['record-1']);

describe('model output validation', () => {
  const excerpts = [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta' }];
  it('accepts a grounded proposal and treats zero proposals as a valid result', () => {
    expect(checkExtractionResponse({ proposals: [proposal()] }, excerpts).accepted).toHaveLength(1);
    expect(checkExtractionResponse({ proposals: [] }, excerpts)).toEqual({ accepted: [], rejected: [] });
  });
  it('rejects all colliding proposal IDs rather than selecting an arbitrary winner', () => {
    const result = checkExtractionResponse({ proposals: [proposal(), proposal()] }, excerpts);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(2);
  });
  it.each([
    ['invented quote', (p: ExtractionProposal) => { p.citations[0].selection.quote = 'fabricated'; }],
    ['missing entity provenance', (p: ExtractionProposal) => { p.mentions.pop(); }],
    ['foreign mention', (p: ExtractionProposal) => { p.mentions[0].selection.evidenceRef = 'other'; }],
    ['wrong link', (p: ExtractionProposal) => { p.citations[0].evidenceLinkId = 'other'; }],
  ] as const)('keeps partial rejection visible for %s', (_name, mutate) => {
    const invalid = proposal();
    invalid.proposalId = 'candidate-2';
    mutate(invalid);
    const result = checkExtractionResponse({ proposals: [proposal(), invalid] }, excerpts);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([{ index: 1, reasons: expect.any(Array) }]);
    expect(result.rejected[0].reasons.length).toBeGreaterThan(0);
  });
});

describe('quote-only model admission', () => {
  const check = extractionResponseChecker('knowledge-extraction-v2');
  const excerpts = [{ evidenceRef: 'record-1', text: '前文😀Alpha 使用 Beta。后文' }];
  it('computes exact UTF-16 positions without altering the original response', () => {
    const raw = { proposals: [modelProposal()] };
    const before = structuredClone(raw);
    const result = check(raw, excerpts);
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].mentions[0].selection).toEqual({ evidenceRef: 'record-1', quote: 'Alpha', start: 4, end: 9 });
    expect(result.accepted[0].citations[0].selection).toEqual({ evidenceRef: 'record-1', quote: 'Alpha 使用 Beta', start: 4, end: 17 });
    expect(raw).toEqual(before);
    expect(check({ proposals: [] }, excerpts)).toEqual({ accepted: [], rejected: [] });
  });
  it.each([
    ['missing', 'Alpha使用Beta', excerpts, 'citation:quote_mismatch'],
    ['repeated', 'Alpha 使用 Beta', [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta；Alpha 使用 Beta' }], 'citation:ambiguous_quote'],
    ['overlapping', 'aaa', [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta aaaa' }], 'citation:ambiguous_quote'],
    ['foreign source', 'Alpha 使用 Beta', excerpts, 'citation:unknown_evidence'],
  ] as const)('rejects %s quotes while preserving partial acceptance and original indices', (name, quote, source, reason) => {
    const invalid = modelProposal();
    invalid.proposalId = 'other';
    invalid.citations[0].selection.quote = quote;
    if (name === 'foreign source') invalid.citations[0].selection.evidenceRef = 'outside';
    const result = check({ proposals: [invalid, modelProposal()] }, [...source, { evidenceRef: 'elsewhere', text: quote }]);
    expect(result.rejected[0]).toMatchObject({ index: 0, reasons: expect.arrayContaining([reason]) });
    if (name !== 'repeated') expect(result.accepted).toHaveLength(1);
    else expect(result.accepted).toEqual([]);
  });
  it('admits an expanded verbatim quote that distinguishes repeated short mentions', () => {
    const candidate = modelProposal();
    candidate.mentions[0].selection.quote = 'Alpha 使用 Beta；';
    candidate.mentions[1].selection.quote = 'Beta；';
    candidate.citations[0].selection.quote = 'Alpha 使用 Beta；';
    const result = check({ proposals: [candidate] }, [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta；Alpha 使用 Beta' }]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].citations[0].selection).toMatchObject({ start: 0, end: 14 });
  });
  it('requires a unique excerpt identity and rejects duplicate proposal identities even when one quote fails', () => {
    expect(() => check({ proposals: [] }, [...excerpts, ...excerpts])).toThrow('Ambiguous evidence window');
    const invalid = modelProposal(); invalid.citations[0].selection.quote = 'missing';
    const result = check({ proposals: [invalid, modelProposal()] }, excerpts);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.every(({ reasons }) => reasons.includes('duplicate_proposal'))).toBe(true);
  });
  it.each([
    (p: ReturnType<typeof modelProposal>) => { p.citations[0].selection.quote = ''; },
    (p: ReturnType<typeof modelProposal>) => { Object.assign(p.citations[0].selection, { start: 0, end: 14 }); },
    (p: ReturnType<typeof modelProposal>) => { p.mentions[0].entityId = 'outside'; },
    (p: ReturnType<typeof modelProposal>) => { p.citations[0].evidenceLinkId = 'outside'; },
    (p: ReturnType<typeof modelProposal>) => { Object.assign(p, { reviewStatus: 'supported' }); },
  ])('keeps transport and grounding authority strict', (mutate) => {
    const invalid = modelProposal(); mutate(invalid);
    expect(check({ proposals: [invalid] }, excerpts).accepted).toEqual([]);
  });
  it('selects the original admission policy for frozen versions and refuses unregistered versions', () => {
    const raw = proposal(); raw.citations[0].selection.end += 1;
    for (const version of ['knowledge-extraction-v1', 'knowledge-local-rules-v1']) {
      expect(extractionResponseChecker(version)({ proposals: [raw] }, [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta。' }]).rejected[0].reasons).toContain('citation:quote_mismatch');
    }
    expect(() => extractionResponseChecker('unregistered')).toThrow('Unsupported');
    expect(check({ proposals: [modelProposal()] }, [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta。' }]).accepted).toHaveLength(1);
  });
});

describe('knowledge validation', () => {
  it('admits background-only candidates without promoting inference to support', () => {
    const input = draft();
    const result = validateKnowledgeDraft(input, evidence);
    expect(result).toEqual({ accepted: true, draft: input });
    expect(result).not.toHaveProperty('reviewStatus');
  });

  it('keeps same-named entities distinct and rejects dangling object references', () => {
    const input = draft();
    input.entities[1].label = input.entities[0].label;
    expect(validateKnowledgeDraft(input, evidence).accepted).toBe(true);
    input.content.statements[0].object = { entityId: 'missing' };
    expect(validateKnowledgeDraft(input, evidence)).toMatchObject({
      accepted: false, problems: [{ code: 'unknown_entity' }],
    });
  });

  it.each([
    ['duplicate entity', (d: KnowledgeDraft) => { d.entities.push(d.entities[0]); }, 'duplicate_id'],
    ['duplicate statement', (d: KnowledgeDraft) => { d.content.statements.push(d.content.statements[0]); }, 'duplicate_id'],
    ['invented source', (d: KnowledgeDraft) => { d.evidence[0].evidenceRef = 'other'; }, 'unknown_evidence'],
    ['dangling statement', (d: KnowledgeDraft) => { d.evidence[0].statementIds.push('missing'); }, 'unknown_statement'],
    ['uncovered statement', (d: KnowledgeDraft) => { d.content.statements.push({ ...d.content.statements[0], statementId: 'extra' }); }, 'uncovered_statement'],
  ] as const)('rejects %s', (_name, mutate, code) => {
    const input = draft();
    mutate(input);
    const result = validateKnowledgeDraft(input, evidence);
    expect(result).toMatchObject({ accepted: false, problems: expect.arrayContaining([expect.objectContaining({ code })]) });
  });

  it('rejects lifecycle authority injected into model content', () => {
    expect(validateKnowledgeDraft({ ...draft(), reviewStatus: 'supported' }, evidence).accepted).toBe(false);
  });

  it('requires case roles to reference observed statements and a nonempty action or outcome', () => {
    const input = draft();
    input.content.organization = { knowledgeKind: 'case', situation: '一次任务', actionStatementIds: ['usage'], outcomeStatementIds: [], gaps: ['结果未记录'] };
    expect(validateKnowledgeDraft(input, evidence).accepted).toBe(true);
    input.content.statements[0].modality = 'normative';
    expect(validateKnowledgeDraft(input, evidence).accepted).toBe(false);
    input.content.organization.actionStatementIds = [];
    expect(validateKnowledgeDraft(input, evidence).accepted).toBe(false);
  });

  it('rejects methods with nonexistent or repeated steps', () => {
    const input = draft();
    input.content.organization = { knowledgeKind: 'method', purpose: '复用做法', instructionStatementIds: ['missing'] };
    expect(validateKnowledgeDraft(input, evidence).accepted).toBe(false);
    input.content.organization.instructionStatementIds = ['usage', 'usage'];
    expect(validateKnowledgeDraft(input, evidence).accepted).toBe(false);
  });

  it('validates half-open time intervals without filling unknown bounds', () => {
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
