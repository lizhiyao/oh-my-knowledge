import { describe, expect, it } from 'vitest';
import { validateEvidenceSelection, validateKnowledgeDraft } from '../../src/knowledge/admission.js';
import { KnowledgeTimeSchema, type KnowledgeDraft } from '../../src/knowledge/contracts.js';
import { checkExtractionResponse, type ExtractionProposal } from '../../src/observability/knowledge-extraction/proposals.js';

import { draft, proposal } from './fixtures.js';
const evidence = new Set(['record-1']);

describe('model output admission', () => {
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

describe('knowledge admission', () => {
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
