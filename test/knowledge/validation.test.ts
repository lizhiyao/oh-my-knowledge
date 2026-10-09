import { describe, expect, it } from 'vitest';
import { validateEvidenceSelection, validateKnowledgeDraft } from '../../src/knowledge/validation.js';
import { KnowledgeTimeSchema, type KnowledgeDraft } from '../../src/knowledge/contracts.js';
import { checkWindowExtractionResponse as check, type WindowExtractionModel } from '../../src/observability/knowledge-extraction/window-proposals.js';

import { draft, modelWindow } from './fixtures.js';
const evidence = new Set(['record-1']);

describe('window model admission', () => {
  const excerpts = [{ evidenceRef: 'record-1', text: '前文😀Alpha 使用 Beta。后文' }];
  it('resolves UTF-16 positions, preserves raw output, and admits an empty window result', () => {
    const raw = modelWindow(); const before = structuredClone(raw);
    const result = check(raw, excerpts);
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].mentions[0].selection).toEqual({ evidenceRef: 'record-1', quote: 'Alpha', start: 4, end: 9 });
    expect(result.accepted[0].citations[0].selection).toEqual({ evidenceRef: 'record-1', quote: 'Alpha 使用 Beta', start: 4, end: 17 });
    expect(raw).toEqual(before);
    expect(check({ ...raw, entities: [], mentions: [], proposals: [] }, excerpts)).toMatchObject({ accepted: [], rejected: [], analysis: { entities: [], mentions: [], rejected: [] } });
  });
  it.each([
    ['missing', 'Alpha使用Beta', 'citation:quote_mismatch'],
    ['repeated', '重复', 'citation:ambiguous_quote'],
    ['overlapping', 'aaa', 'citation:ambiguous_quote'],
    ['foreign source', 'Alpha 使用 Beta', 'citation:unknown_evidence'],
  ] as const)('preserves partial acceptance and original indices for %s citation', (name, quote, reason) => {
    const raw = modelWindow(); const invalid = structuredClone(raw.proposals[0]); invalid.proposalId = 'other';
    invalid.citations[0].selection.quote = quote;
    if (name === 'foreign source') invalid.citations[0].selection.evidenceRef = 'outside';
    raw.proposals.unshift(invalid);
    const result = check(raw, [{ ...excerpts[0], text: `${excerpts[0].text} 重复重复 aaaa` }, { evidenceRef: 'elsewhere', text: quote }]);
    expect(result.rejected).toEqual([{ index: 0, reasons: expect.arrayContaining([reason]) }]);
    expect(result.accepted).toHaveLength(1);
  });
  it('requires unique evidence and rejects colliding proposal identities including malformed entries', () => {
    const raw = modelWindow();
    expect(() => check(raw, [...excerpts, ...excerpts])).toThrow('Ambiguous evidence window');
    const collision = { proposalId: raw.proposals[0].proposalId };
    const result = check({ ...raw, proposals: [collision, raw.proposals[0]] }, excerpts);
    expect(result.accepted).toEqual([]); expect(result.rejected).toHaveLength(2);
    expect(result.rejected[1].reasons).toContain('duplicate_proposal');
  });
  it.each([
    ['empty quote', (w: WindowExtractionModel) => { w.proposals[0].citations[0].selection.quote = ''; }],
    ['model positions', (w: WindowExtractionModel) => { Object.assign(w.proposals[0].citations[0].selection, { start: 0, end: 14 }); }],
    ['foreign entity', (w: WindowExtractionModel) => { w.proposals[0].draft.content.statements[0].subject.entityId = 'outside'; }],
    ['missing provenance', (w: WindowExtractionModel) => { w.proposals[0].mentionIds.pop(); }],
    ['wrong evidence link', (w: WindowExtractionModel) => { w.proposals[0].citations[0].evidenceLinkId = 'outside'; }],
    ['foreign source', (w: WindowExtractionModel) => { w.mentions[0].selection.evidenceRef = 'outside'; }],
    ['lifecycle authority', (w: WindowExtractionModel) => { Object.assign(w.proposals[0], { reviewStatus: 'supported' }); }],
  ] as const)('rejects %s without changing model authority', (_name, mutate) => {
    const raw = modelWindow(); mutate(raw);
    expect(check(raw, excerpts).accepted).toEqual([]);
  });
  it('rejects a composed uncertainty list beyond the grounding limit without losing valid siblings or entity analysis', () => {
    const raw = modelWindow();
    raw.entities.forEach((entity, index) => { entity.uncertainties = Array.from({ length: 32 }, (_, item) => `对象${index}-${item}`); });
    const valid = { ...structuredClone(raw.proposals[0]), proposalId: 'other' };
    raw.proposals[0].identityUncertainties = ['额外身份不确定性']; raw.proposals.push(valid);
    const result = check(raw, excerpts);
    expect(result.analysis.entities).toHaveLength(2);
    expect(result.rejected).toEqual([{ index: 0, reasons: ['invalid_structure:identityUncertainties'] }]);
    expect(result.accepted).toHaveLength(1); expect(result.accepted[0].identityUncertainties).toHaveLength(64);
  });
  it('requires the current response discriminator and version', () => {
    for (const value of [{ proposals: [] }, { ...modelWindow(), schemaVersion: 2 }]) expect(() => check(value, excerpts)).toThrow();
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
