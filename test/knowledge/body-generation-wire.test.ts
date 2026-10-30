import { describe, expect, it } from 'vitest';
import { ASSOCIATION_GENERATION_PROFILE, BODY_GENERATION_PROFILE, checkGeneratedAssociations, checkGeneratedBodies } from '../../src/knowledge/extraction/body-generation-wire.js';
import { traceSnapshotFixture } from '../helpers/knowledge-source.js';

const window = traceSnapshotFixture('Alpha SDK 0.165.0. Use only with a matching build. Result unknown.', { snapshotId: '00000000-0000-4000-8000-000000000001', evidenceRef: 'record-1' });
const locator = (quote: string, contextBefore: string | null = null, contextAfter: string | null = null) => ({ evidenceRef: 'record-1', quote, contextBefore, contextAfter });
const evidence = (quote: string) => ({ ...locator(quote), basis: 'source_assertion' as const, interpretation: null as string | null });
function body() {
  return { responseKind: 'knowledge-body-generation', schemaVersion: 2, proposals: [{ proposalId: 'p1', title: 'Historical SDK conditions',
    requiredContexts: [{ literal: 'Alpha SDK 0.165.0', evidence: { ...evidence('Alpha SDK 0.165.0'), interpretation: 'Historical source scope.' } }],
    segments: [
      { segmentId: 's1', text: 'Alpha SDK 0.165.0 requires a matching build.', evidence: [evidence('Use only with a matching build.')] },
      { segmentId: 's2', text: 'The result of Alpha SDK 0.165.0 is unknown.', evidence: [evidence('Result unknown.')] },
    ], organization: null, reuseRationale: 'Recheck the same historical conditions.' }] };
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
  it('publishes new strict identities without exposing the ordinal or model-supplied mention ID', () => {
    expect(BODY_GENERATION_PROFILE).toMatchObject({ promptVersion: 'knowledge-body-generation/v9', outputName: 'knowledge_body_v2' });
    expect(ASSOCIATION_GENERATION_PROFILE).toMatchObject({ promptVersion: 'knowledge-association-generation/v7', outputName: 'knowledge_association_v3' });
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
        selection: { evidenceRef: 'record-1', quote: 'Alpha SDK 0.165.0', start: 0, end: 17 },
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

  it('uses exact adjacent context for a repeated version while retaining empty requiredContexts as an explicit declaration', () => {
    const selected = { ...window, excerpts: [{ ...window.excerpts[0], text: 'SDK 0.165.0 and CLI 0.165.0.' }] };
    const response = body();
    response.proposals[0].requiredContexts = [];
    response.proposals[0].segments = [{ segmentId: 's1', text: 'The selected CLI version is 0.165.0.',
      evidence: [{ ...evidence('0.165.0'), contextBefore: 'CLI ', contextAfter: '.' }] }];
    const result = checkGeneratedBodies(JSON.stringify(response), [selected]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].draft.content.segments[0].evidence[0].selection).toEqual({ evidenceRef: 'record-1', quote: '0.165.0', start: 20, end: 27 });
    response.proposals[0].segments[0].evidence[0].contextBefore = null;
    response.proposals[0].segments[0].evidence[0].contextAfter = null;
    expect(checkGeneratedBodies(JSON.stringify(response), [selected]).rejected[0].reasons[0]).toContain('ambiguous');
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
      requiredContexts: quotes.map(quote => ({ literal: '界', evidence: evidence(quote) })),
      segments: Array.from({ length: count }, (_, index) => ({ segmentId: `s${index}`, text: '界: a scoped claim.', evidence: [evidence('A scoped claim.')] })) });
    const small = { ...body().proposals[0], proposalId: 'small', requiredContexts: [],
      segments: [{ segmentId: 's1', text: 'A scoped claim.', evidence: [evidence('A scoped claim.')] }] };
    const response = { ...body(), proposals: scope === 'proposal' ? [expanded('too-large', 100), small]
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
    expect(() => checkGeneratedBodies(JSON.stringify({ ...response, schemaVersion: 1 }), [window])).toThrow('body generation wire rejected.');
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
