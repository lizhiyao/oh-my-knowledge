import { WRITING_DRAFT_PROFILE, checkWritingDraft } from '../../src/knowledge/extraction/writing-draft.js';
import { describe, expect, it } from 'vitest';
import { ASSOCIATION_GENERATION_PROFILE, BODY_GENERATION_PROFILE, checkGeneratedAssociations, checkGeneratedBodies } from '../../src/knowledge/extraction/body-generation-wire.js';
import { SOURCE_LEDGER_GENERATION_PROFILE, SOURCE_COVERAGE_GENERATION_PROFILE } from '../../src/knowledge/extraction/source-review-wire.js';
import { traceSnapshotFixture } from '../helpers/knowledge-source.js';
import { bodySourcePassages } from '../../src/knowledge/extraction/source-input.js';
import { passageRange } from '../helpers/source-passages.js';

const window = traceSnapshotFixture('Alpha SDK 0.165.0. Use only with a matching build. Result unknown.', { snapshotId: '00000000-0000-4000-8000-000000000001', evidenceRef: 'record-1' });
const locator = (quote: string, contextBefore: string | null = null, contextAfter: string | null = null) => ({ evidenceRef: 'record-1', quote, contextBefore, contextAfter });
const evidence = (quote: string, source = window) => ({ ...passageRange(bodySourcePassages([source]).index, 'record-1', quote),
  basis: 'source_assertion' as const, interpretation: null as string | null });
function body(source = window) {
  return { responseKind: 'knowledge-body-generation', schemaVersion: 3, proposals: [{ proposalId: 'p1', title: 'Historical SDK conditions',
    requiredContexts: [{ literal: 'Alpha SDK 0.165.0', evidence: { ...evidence('Alpha SDK 0.165.0'), interpretation: 'Historical source scope.' } }],
    segments: [
      { segmentId: 's1', text: 'Alpha SDK 0.165.0 requires a matching build.', evidence: [evidence('Use only with a matching build.')] },
      { segmentId: 's2', text: 'The result of Alpha SDK 0.165.0 is unknown.', evidence: [evidence('Result unknown.')] },
    ], organization: null, reuseRationale: 'Recheck the same historical conditions.' }], passageIndexDigest: bodySourcePassages([source]).index.digest };
}
function association() {
  const entity = (entityId: string, label: string) => ({ entityId, label, description: 'Authored source-local object.', qualifiers: [],
    identityStatus: 'proposed' as const, possibleEntityIds: [], uncertainties: [], referentKind: 'object' as const,
    componentLink: null, collectionLink: null,
    mentions: [{ mentionKey: 'name', selection: locator(label), basis: 'explicit' as const, rationale: 'Exact source mention.' }] });
  return { responseKind: 'knowledge-association-generation', schemaVersion: 3,
    catalogs: [{ sourceKey: 's0', entities: [entity('e1', 'Alpha'), entity('e2', 'SDK')] }],
    associations: [{ bodyKey: 'b0', segmentDecisions: [
      { segmentId: 's1', decisionKind: 'mapped', entityRefs: [{ sourceKey: 's0', entityId: 'e1', mentionKeys: ['name'] }], reason: 'The segment refers to this source object.' },
      { segmentId: 's2', decisionKind: 'abstained', entityRefs: [], reason: 'No source-supported entity association declared.' },
    ], typedRelations: null, issues: [] }] };
}

describe('versioned body and association generation wire', () => {
  it('pins the unverified writing contract and rejects extra authority fields or malformed native responses', () => {
    expect(WRITING_DRAFT_PROFILE).toMatchObject({ stageKind: 'body_draft', promptVersion: 'knowledge-writing-draft/v1', outputName: 'knowledge_body_draft_v1',
      profileId: 'sha256:aebc7105045a69553fe356708f93bc526fe77e389501a0b204f6cb4c9dd95574',
      wireId: 'sha256:ef64aa65dbfd1816b4e8c22160aa9ca579bf0ab550102526db648f788b88fca8' });
    expect(Object.isFrozen(WRITING_DRAFT_PROFILE.wireSchema.properties)).toBe(true);
    const draft = { responseKind: 'knowledge-writing-draft', schemaVersion: 1, text: '# 未核验草稿\n\n来源说法仍须回原文定位。' };
    expect(checkWritingDraft(JSON.stringify(draft))).toBe(draft.text);
    expect(checkWritingDraft(JSON.stringify({ ...draft, text: '' }))).toBe('');
    for (const raw of ['not JSON', JSON.stringify({ ...draft, schemaVersion: 2 }), JSON.stringify({ ...draft, approved: true }), JSON.stringify({ ...draft, text: null })]) {
      expect(() => checkWritingDraft(raw)).toThrow();
    }
  });

  it('publishes new strict identities without exposing the ordinal or model-supplied mention ID', () => {
    expect(BODY_GENERATION_PROFILE).toMatchObject({ promptVersion: 'knowledge-body-generation/v20', outputName: 'knowledge_body_v3',
      profileId: 'sha256:9170f3c707305a5b970628bb16ae0e3d4a2286ee2f23c35885e48020426ca189',
      wireId: 'sha256:bc3089693087eb4eef0a03cfc141a0c6eabb8e7b838526228d22c689fb4b797d' });
    expect(ASSOCIATION_GENERATION_PROFILE).toMatchObject({ promptVersion: 'knowledge-association-generation/v8', outputName: 'knowledge_association_v3',
      profileId: 'sha256:7b4ae125132697ac9c251c3b6d75f6dfaa09c07f253a53e190811ed9ed9fdb80',
      wireId: 'sha256:2c9acd3fc02d852587b89dc6fa8c5b6d91c0bea41073ebaa0a64bbad066fa226' });
    expect(SOURCE_LEDGER_GENERATION_PROFILE).toMatchObject({ promptVersion: 'knowledge-source-ledger-generation/v4',
      profileId: 'sha256:a211c0c6a3a8ca48e256a66488d8c87079d00be9cbdb8df92f19d6581f35024c',
      wireId: 'sha256:e04d50b8fe84b48339888651df392b10a5580bf37527a7a64ffd2d85877c2e67' });
    expect(SOURCE_COVERAGE_GENERATION_PROFILE).toMatchObject({ promptVersion: 'knowledge-source-coverage-generation/v6',
      outputName: 'knowledge_source_coverage_v3',
      profileId: 'sha256:0de76effdddb72462cf8497266f678512d724431832096ec88ae0a3c65c70686',
      wireId: 'sha256:051de277225cfb10d2016a269ec2ec04dad3a72ea2ccf89cd1e7bd4c15abe3a8' });
    for (const profile of [BODY_GENERATION_PROFILE, ASSOCIATION_GENERATION_PROFILE]) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.wireSchema)).toBe(true);
      expect(JSON.stringify(profile.wireSchema)).not.toContain('occurrence');
      expect(JSON.stringify(profile.wireSchema)).not.toContain('oneOf');
    }
    expect(JSON.stringify(ASSOCIATION_GENERATION_PROFILE.wireSchema)).not.toContain('"mentionId"');
  });

  it('attaches declared source context to each segment without rewriting content or upgrading attribution', () => {
    const response = body(), original = JSON.stringify(response);
    const result = checkGeneratedBodies(original, [window]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].draft.content.segments.map(segment => segment.text)).toEqual(response.proposals[0].segments.map(segment => segment.text));
    for (const segment of result.accepted[0].draft.content.segments) {
      expect(segment.evidence).toHaveLength(2);
      expect(segment.evidence[1]).toEqual({ source: { snapshotId: window.snapshotId, sourceVersion: window.sourceVersion },
        selection: { evidenceRef: 'record-1', quote: window.excerpts[0].text, start: 0, end: window.excerpts[0].text.length },
        basis: 'source_assertion', interpretation: 'Historical source scope.' });
    }
    expect(JSON.stringify(response)).toBe(original);
  });

  it('deduplicates only identical complete evidence while keeping a different interpretation of the same span', () => {
    const response = body(), anchor = response.proposals[0].requiredContexts[0].evidence;
    response.proposals[0].segments = [{ segmentId: 's1', text: 'Alpha SDK 0.165.0', evidence: [anchor,
      { ...anchor, interpretation: 'A separate source interpretation, retained as such.' }] }];
    const result = checkGeneratedBodies(JSON.stringify(response), [window]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].draft.content.segments[0].evidence.map(item => item.interpretation))
      .toEqual(['Historical source scope.', 'A separate source interpretation, retained as such.']);
  });

  it.each(['source', 'segment', 'blank'] as const)('rejects an invalid shared %s literal per proposal without repairing its text', target => {
    const response = body(), invalid = structuredClone(response.proposals[0]);
    invalid.proposalId = 'invalid';
    if (target === 'source') invalid.requiredContexts[0].literal = 'Alpha SDK 0.166.0';
    if (target === 'segment') invalid.segments[1].text = 'The result remains unknown.';
    if (target === 'blank') invalid.requiredContexts[0].literal = ' ';
    response.proposals.push(invalid);
    const before = JSON.stringify(response), result = checkGeneratedBodies(before, [window]);
    expect(result.accepted.map(item => item.proposalId)).toEqual(['p1']);
    expect(result.rejected).toEqual([{ index: 1, reasons: [expect.stringContaining('Required context literal')] }]);
    expect(JSON.stringify(response)).toBe(before);
  });

  it('selects the host block containing a repeated version without asking the model for offsets or context', () => {
    const selected = { ...window, excerpts: [{ ...window.excerpts[0], text: 'SDK 0.165.0. ' + '.'.repeat(260) + ' CLI 0.165.0.' }] };
    const response = body(selected);
    response.proposals[0].requiredContexts = [];
    response.proposals[0].segments = [{ segmentId: 's1', text: 'The selected CLI version is 0.165.0.',
      evidence: [evidence('CLI 0.165.0.', selected)] }];
    const result = checkGeneratedBodies(JSON.stringify(response), [selected]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].draft.content.segments[0].evidence[0].selection).toEqual({ evidenceRef: 'record-1',
      quote: selected.excerpts[0].text.slice(256), start: 256, end: selected.excerpts[0].text.length });
    response.proposals[0].segments[0].evidence[0].startPassageId = 'invented';
    expect(checkGeneratedBodies(JSON.stringify(response), [selected]).rejected[0].reasons[0]).toContain('Unknown source passage');
  });

  it('enforces the combined evidence capacity instead of silently truncating claims or shared contexts', () => {
    const response = body(), anchor = response.proposals[0].requiredContexts[0].evidence;
    response.proposals[0].segments = [{ segmentId: 's1', text: 'Alpha SDK 0.165.0',
      evidence: Array.from({ length: 512 }, (_, index) => ({ ...anchor, interpretation: `Authored capacity entry ${index}.` })) }];
    expect(checkGeneratedBodies(JSON.stringify(response), [window])).toEqual({ accepted: [], rejected: [{ index: 0, reasons: ['Combined body evidence capacity exceeded.'] }] });
  });

  it.each(['proposal', 'stage'] as const)('rejects shared evidence amplification at the compiled %s byte limit without charging rejected drafts', scope => {
    const quotes = Array.from({ length: 8 }, (_, index) => '界'.repeat(8191) + index);
    const selected = { ...window, excerpts: [{ ...window.excerpts[0], text: [...quotes, 'A scoped claim.'].join('\n') }] };
    const expanded = (proposalId: string, count: number) => ({ ...body().proposals[0], proposalId,
      requiredContexts: quotes.map(quote => ({ literal: '界', evidence: evidence(quote, selected) })),
      segments: Array.from({ length: count }, (_, index) => ({ segmentId: `s${index}`, text: '界: a scoped claim.', evidence: [evidence('A scoped claim.', selected)] })) });
    const small = { ...body().proposals[0], proposalId: 'small', requiredContexts: [],
      segments: [{ segmentId: 's1', text: 'A scoped claim.', evidence: [evidence('A scoped claim.', selected)] }] };
    const response = { ...body(selected), proposals: scope === 'proposal' ? [expanded('too-large', 100), small]
      : [expanded('first', 50), expanded('too-large', 50), small] };
    const raw = JSON.stringify(response);
    // Input stays small; each segment is < 256 KiB, but shared quotations amplify its total UTF-8 size.
    expect(Buffer.byteLength(raw)).toBeLessThan(512 * 1024);
    const result = checkGeneratedBodies(raw, [selected]);
    expect(result.rejected).toEqual([{ index: scope === 'proposal' ? 0 : 1, reasons: ['Compiled body capacity exceeded.'] }]);
    expect(result.accepted.map(item => item.proposalId)).toEqual(scope === 'proposal' ? ['small'] : ['first', 'small']);
    expect(result.accepted.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item.draft)), 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
    if (scope === 'stage') expect(Buffer.byteLength(JSON.stringify(result.accepted[0].draft))).toBeGreaterThan(8 * 1024 * 1024);
  });

  it('rejects old response versions and old locator fields rather than interpreting them under the new wire', () => {
    const response = body();
    const other = traceSnapshotFixture(window.excerpts[0].text, { snapshotId: '00000000-0000-4000-8000-000000000002', evidenceRef: 'record-1' });
    expect(() => checkGeneratedBodies(JSON.stringify(response), [other])).toThrow('passage index mismatch');
    for (const schemaVersion of [1, 2]) {
      expect(() => checkGeneratedBodies(JSON.stringify({ ...response, schemaVersion }), [window])).toThrow('body generation wire rejected.');
    }
    expect(() => checkGeneratedBodies(JSON.stringify({ ...response, proposals: response.proposals.map(proposal => ({ ...proposal,
      segments: proposal.segments.map(segment => ({ ...segment, evidence: segment.evidence.map(item => ({ ...item, occurrence: 0 })) })) })) }), [window])).toThrow('body generation wire rejected.');
    expect(() => checkGeneratedAssociations(JSON.stringify({ ...association(), schemaVersion: 2 }))).toThrow('association generation wire rejected.');
  });

  it('keeps mention keys owned by each entity and preserves an explicit abstention and optional relation request', () => {
    const response = association(), result = checkGeneratedAssociations(JSON.stringify(response));
    expect(result.catalogs[0].entities.map(entity => entity.mentions[0].mentionKey)).toEqual(['name', 'name']);
    expect(result.associations[0].segmentDecisions[1]).toMatchObject({ decisionKind: 'abstained', entityRefs: [], reason: expect.any(String) });
    expect(result.associations[0].typedRelations).toBeNull();
    expect(result.catalogs[0]).not.toHaveProperty('mentions');
  });

  it.each(['mapped-empty', 'abstained-nonempty', 'blank-reason', 'oversized-reason', 'top-level-mentions', 'old-component'] as const)('rejects inconsistent association shape %s', change => {
    const response = association();
    if (change === 'mapped-empty') response.associations[0].segmentDecisions[0].entityRefs = [];
    if (change === 'abstained-nonempty') response.associations[0].segmentDecisions[1].entityRefs = response.associations[0].segmentDecisions[0].entityRefs;
    if (change === 'blank-reason') response.associations[0].segmentDecisions[1].reason = ' ';
    if (change === 'oversized-reason') response.associations[0].segmentDecisions[1].reason = '界'.repeat(32769);
    const raw = JSON.parse(JSON.stringify(response));
    if (change === 'top-level-mentions') raw.catalogs[0].mentions = [];
    if (change === 'old-component') raw.catalogs[0].entities[0].componentRef = null;
    expect(() => checkGeneratedAssociations(JSON.stringify(raw))).toThrow();
  });

  it('retains the total mention capacity across entity-owned arrays', () => {
    const response = association(), owned = response.catalogs[0].entities[0].mentions[0];
    response.catalogs[0].entities[0].mentions = Array.from({ length: 512 }, (_, index) => ({ ...owned, mentionKey: `name-${index}` }));
    expect(() => checkGeneratedAssociations(JSON.stringify(response))).toThrow('Source catalog mention capacity exceeded.');
  });
});
