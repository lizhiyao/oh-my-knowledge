import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeApplication } from '../../src/knowledge/application/application.js';
import { KNOWLEDGE_RETRIEVAL_RANKING_POLICY_ID, KnowledgeRetrievalRequestSchema, knowledgeRetrievalTerms, retrieveKnowledge } from '../../src/knowledge/application/retrieval.js';

const digest = `sha256:${'a'.repeat(64)}`;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8') + 1;
function fixture(texts = ['仅父组件初始化时 v-model 不更新；不适用于用户输入，成本未知。']) {
  const knowledgeId = randomUUID(), revisionId = randomUUID(), snapshotId = randomUUID(), sourceVersion = digest;
  const quote = '🙂 用户报告初始化问题，尚未独立验证。';
  const segments = texts.map((text, index) => ({ segmentId: `segment-${index}`, text, evidence: [{
    source: { snapshotId, sourceVersion }, selection: { evidenceRef: 'record:0', start: 0, end: quote.length, quote },
    basis: 'source_assertion' as const, interpretation: '用户报告，未经独立复现。',
  }] }));
  const bodyRef = { knowledgeId, revisionId, bodyDigest: digest };
  const derivedAssociations: { status: string; reviewStatus: 'pending' | 'accepted' | 'rejected'; bodyRef: typeof bodyRef; revision?: {
    revisionId: string; bodyRef: typeof bodyRef; status: 'available' | 'failed'; reviewStatus: 'pending'; issues: string[];
    segmentEntityRefs: { segmentId: string; entityId: string; mentionIds: string[] }[]; typedRelations?: unknown[];
  } } = { status: 'absent', reviewStatus: 'pending', bodyRef };
  const detail = { history: { generation: 1, writeHeadRevisionId: revisionId },
    revision: { ...bodyRef, revisedAt: '2026-01-01T00:00:00Z', title: '初始化记录', content: { segments } },
    maintenance: undefined as { choice: 'retain' | 'discard' } | undefined, tagging: { tags: [] as string[] }, reviewStatus: 'pending',
    derivedAssociations,
  };
  const row = { knowledgeId, revisionId, choice: null as 'retain' | 'discard' | null };
  const window = { sourceKind: 'codex', excerpts: [{ evidenceRef: 'record:0', text: quote }] };
  const source = vi.fn((id: string, version?: string) => id === snapshotId && (!version || version === sourceVersion)
    ? { status: 'available' as const, window } : { status: 'unavailable' as const, reason: 'missing' });
  const app = { list: vi.fn(() => [row]), detail: vi.fn(() => detail), source } as unknown as Pick<KnowledgeApplication, 'list' | 'detail' | 'source'>;
  return { app, row, detail, source, snapshotId, sourceVersion, segments,
    retain() { row.choice = 'retain'; detail.maintenance = { choice: 'retain' }; } };
}
function corpus(...entries: ReturnType<typeof fixture>[]) {
  entries.forEach(entry => entry.retain());
  return { list: () => entries.map(entry => entry.row), detail: (id: string) => entries.find(entry => entry.row.knowledgeId === id)!.detail,
    source: (id: string, version?: string) => entries.find(entry => entry.snapshotId === id)!.source(id, version) } as unknown as Pick<KnowledgeApplication, 'list' | 'detail' | 'source'>;
}

describe('canonical body segment retrieval', () => {
  it('defaults to retained current revisions, exposes candidates only explicitly and excludes discarded content without changing it', () => {
    const f = fixture(), before = structuredClone(f.detail);
    expect(retrieveKnowledge(f.app, { query: 'v-model' }).items).toEqual([]);
    const result = retrieveKnowledge(f.app, { query: 'v-model', includeCandidates: true });
    expect(result).toMatchObject({ projectionKind: 'knowledge-body-segments', schemaVersion: 1,
      knowledge: [{ bodyRef: { revisionId: f.row.revisionId, bodyDigest: digest }, choice: null, reviewStatus: 'pending' }] });
    expect(result.items[0].segment).toEqual(f.segments[0]);
    expect(result.items[0].evidenceChecks).toEqual([{ evidenceIndex: 0, source: 0, positionStatus: 'matched' }]);
    expect(result.items[0].segment.text).toContain('不适用于用户输入，成本未知');
    expect(f.detail).toEqual(before); expect(f.source).toHaveBeenCalledTimes(1);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    f.retain(); expect(retrieveKnowledge(f.app, { query: 'v-model' }).items).toHaveLength(1);
    f.row.choice = 'discard'; f.detail.maintenance = { choice: 'discard' };
    expect(retrieveKnowledge(f.app, { query: 'v-model', includeCandidates: true }).items).toEqual([]);
  });
  it('retrieves canonical text with absent, failed or stale associations and never recalls source-only text as knowledge', () => {
    const f = fixture(); f.retain();
    for (const status of ['absent', 'failed', 'stale']) {
      f.detail.derivedAssociations.status = status;
      expect(retrieveKnowledge(f.app, { query: 'v-model' })).toMatchObject({ items: [{ segment: f.segments[0] }], knowledge: [{ derivedAssociations: { status } }] });
    }
    expect(retrieveKnowledge(f.app, { query: '独立验证' }).items).toEqual([]);
  });
  it('keeps large derived catalogs outside the body budget and scopes only exact current-body associations, still pending', () => {
    const f = fixture(); f.retain(); const entityId = randomUUID(), associations = f.detail.derivedAssociations;
    associations.status = 'available'; associations.revision = { revisionId: randomUUID(), bodyRef: associations.bodyRef,
      status: 'available', reviewStatus: 'pending', issues: [], segmentEntityRefs: [{ segmentId: 'segment-0', entityId, mentionIds: ['mention-0'] }],
      typedRelations: ['large optional derived catalog'.repeat(10000)] };
    const scoped = retrieveKnowledge(f.app, { query: 'v-model', entityId });
    expect(scoped.items).toHaveLength(1); expect(bytes(scoped)).toBeLessThanOrEqual(8192);
    expect(scoped.knowledge[0].derivedAssociations).toMatchObject({ status: 'available', revision: { reviewStatus: 'pending', bodyRef: associations.bodyRef } });
    expect(scoped.knowledge[0].derivedAssociations.revision).not.toHaveProperty('typedRelations');
    expect(retrieveKnowledge(f.app, { query: 'v-model', entityId: '同名对象' }).items).toEqual([]);
    associations.reviewStatus = 'accepted';
    expect(retrieveKnowledge(f.app, { query: 'v-model', entityId }).knowledge[0].derivedAssociations).toMatchObject({ reviewStatus: 'accepted', revision: { reviewStatus: 'pending' } });
    associations.reviewStatus = 'rejected';
    expect(retrieveKnowledge(f.app, { query: 'v-model', entityId }).items).toEqual([]);
    expect(retrieveKnowledge(f.app, { query: 'v-model' }).items).toHaveLength(1);
    associations.reviewStatus = 'pending';
    associations.revision.bodyRef = { ...associations.bodyRef, bodyDigest: `sha256:${'b'.repeat(64)}` };
    expect(retrieveKnowledge(f.app, { query: 'v-model', entityId }).items).toEqual([]);
    expect(retrieveKnowledge(f.app, { query: 'v-model' }).items).toHaveLength(1);
    associations.status = 'stale'; expect(retrieveKnowledge(f.app, { query: 'v-model', entityId }).scopeDiagnostics?.entity?.status).toBe('no_eligible_segments');
  });
  it('budgets the complete segment and every inline evidence field; 8192 is adjustable, never a body storage cap', () => {
    expect(KnowledgeRetrievalRequestSchema.parse({ query: 'v-model' }).maxBytes).toBe(65536);
    const long = '必要否定和适用条件不得截断。'.repeat(1500), f = fixture([long, 'v-model 小段保留完整条件。']);
    f.detail.revision.title = 'v-model'; f.retain();
    const bounded = retrieveKnowledge(f.app, { query: 'v-model', maxBytes: 8192 });
    expect(bytes(bounded)).toBeLessThanOrEqual(8192); expect(bounded.omitted.oversizedSegments).toBe(1);
    expect(bounded.items.map(item => item.segment.segmentId)).toEqual(['segment-1']);
    const expanded = retrieveKnowledge(f.app, { query: 'v-model', maxBytes: 200000 });
    expect(expanded.items).toHaveLength(2); expect(expanded.items.find(item => item.segment.segmentId === 'segment-0')!.segment.text).toBe(long);
    for (const item of expanded.items) expect(item.segment).toEqual(f.segments[item.segmentIndex]);
    expect(bytes(expanded)).toBeLessThanOrEqual(200000); expect(f.segments[0].text).toBe(long);
  });
  it('scopes by the exact citation source pair and discloses unavailable sources and invalid locators without replacing body text', () => {
    const f = fixture(); f.retain();
    const scoped = retrieveKnowledge(f.app, { query: 'v-model', snapshot: f.snapshotId, sourceVersion: f.sourceVersion });
    expect(scoped.items).toHaveLength(1); expect(scoped.sources).toMatchObject([{ snapshotId: f.snapshotId, sourceVersion: f.sourceVersion, status: 'available' }]);
    expect(retrieveKnowledge(f.app, { query: 'v-model', snapshot: f.snapshotId, sourceVersion: `sha256:${'b'.repeat(64)}` }).items).toEqual([]);
    f.source.mockReturnValue({ status: 'unavailable', reason: 'deleted' });
    const missing = retrieveKnowledge(f.app, { query: 'v-model', snapshot: f.snapshotId });
    expect(missing).toMatchObject({ scopeDiagnostics: { source: { status: 'unavailable', reason: 'deleted' } },
      sources: [{ status: 'unavailable', reason: 'deleted' }], items: [{ evidenceChecks: [{ positionStatus: 'unavailable' }] }] });
    expect(missing.items[0].segment).toEqual(f.segments[0]);
    const other = fixture(); other.retain(); other.segments[0].evidence[0].selection.start = 1;
    expect(retrieveKnowledge(other.app, { query: 'v-model' }).items[0].evidenceChecks[0].positionStatus).toBe('mismatch');
  });
  it('separates local literal relevance from document recall and rewards complementary query terms deterministically', () => {
    const f = fixture(['unrelated', 'red', 'green', 'red']); f.retain(); f.detail.revision.title = 'red green';
    const result = retrieveKnowledge(f.app, { query: 'red green' });
    expect(result.items.slice(0, 2).map(item => item.segment.text).sort()).toEqual(['green', 'red']);
    expect(result.items).toHaveLength(4); expect(result.knowledge).toHaveLength(1); expect(result.sources).toHaveLength(1);
    expect(retrieveKnowledge(f.app, { query: 'red green' })).toEqual(result);
    expect(knowledgeRetrievalTerms('为什么 v-model/Value 没更新？')).toContain('v-model/value');
    expect(knowledgeRetrievalTerms('初始化')).toEqual(['初始化', '初始', '始化']);
  });
  it('validates requests before reads and fails closed on a changed current revision or maintenance choice', () => {
    const f = fixture();
    for (const input of [{ query: '' }, { query: '???' }, { query: 'x', maxBytes: 1023 }, { query: 'x', sourceVersion: digest }, { query: 'x', snapshot: 'invalid' }]) {
      expect(() => retrieveKnowledge(f.app, input)).toThrow();
    }
    expect(f.app.list).not.toHaveBeenCalled(); expect(f.app.detail).not.toHaveBeenCalled();
    f.retain(); f.detail.history.writeHeadRevisionId = randomUUID();
    expect(() => retrieveKnowledge(f.app, { query: 'v-model' })).toThrow('Knowledge changed during retrieval');
    f.detail.history.writeHeadRevisionId = f.row.revisionId; f.detail.maintenance = { choice: 'discard' };
    expect(retrieveKnowledge(f.app, { query: 'v-model', includeCandidates: true }).items).toEqual([]);
  });
  it('prioritizes a larger ASCII topic set without dropping a smaller set containing necessary constraints', () => {
    const constrained = fixture(['Vue Transition 初始化条件：仅第一次挂载可用；后续更新不适用。']);
    const extended = fixture(['Vue Transition 的 v-model 初始化条件尚未确认，成本未知。']);
    const result = retrieveKnowledge(corpus(constrained, extended), { query: 'Vue Transition v-model 初始化条件', maxBytes: 65536 });
    expect(result.rankingPolicyId).toBe(KNOWLEDGE_RETRIEVAL_RANKING_POLICY_ID);
    expect(result.knowledge.map(item => item.bodyRef.knowledgeId)).toEqual([extended.row.knowledgeId, constrained.row.knowledgeId]);
    expect(result.items.map(item => item.segment)).toEqual([extended.segments[0], constrained.segments[0]]);
    expect(result.omitted).toEqual({ oversizedSegments: 0, budgetSegments: 0 });
  });
  it('keeps incomparable ASCII topics instead of requiring every topic in one knowledge body', () => {
    const background = fixture(['Vue 通用背景。']), suspense = fixture(['Vue Suspense 的初始化条件尚未确认。']), transition = fixture(['Vue Transition 的初始化不支持任意推断。']);
    const result = retrieveKnowledge(corpus(background, suspense, transition), { query: 'Vue Suspense Transition 初始化' });
    expect(new Set(result.knowledge.slice(0, 2).map(item => item.bodyRef.knowledgeId))).toEqual(new Set([suspense.row.knowledgeId, transition.row.knowledgeId]));
    expect(result.knowledge.map(item => item.bodyRef.knowledgeId)).toContain(background.row.knowledgeId);
    expect(result.items).toHaveLength(3);
  });
  it('does not boost a scoped body using ASCII topics from an excluded source segment', () => {
    const scoped = fixture(['Vue 初始化条件：仅第一次挂载。', 'Transition v-model 属于另一来源的条件。']);
    const matching = fixture(['Vue Transition 初始化条件仍需独立核对。']);
    scoped.segments[1].evidence[0].source.snapshotId = randomUUID();
    matching.segments[0].evidence[0].source.snapshotId = scoped.snapshotId;
    const result = retrieveKnowledge(corpus(scoped, matching), { query: 'Vue Transition v-model 初始化条件', snapshot: scoped.snapshotId });
    expect(result.knowledge.map(item => item.bodyRef.knowledgeId)).toEqual([matching.row.knowledgeId, scoped.row.knowledgeId]);
    expect(result.items.map(item => item.segment.text)).toEqual([matching.segments[0].text, scoped.segments[0].text]);
  });
  it('preserves pure Han recall, all-unmatched ASCII fallback and multiple bodies with the same topic set', () => {
    const first = fixture(['Vue Transition 初始化条件：仅第一次有效。']), second = fixture(['Vue Transition 初始化条件：后续仍待验证。']), chinese = fixture(['初始化条件保留否定与未知。']);
    const app = corpus(first, second, chinese);
    expect(retrieveKnowledge(app, { query: '初始化条件' }).knowledge).toHaveLength(3);
    expect(retrieveKnowledge(app, { query: 'React 初始化条件' }).knowledge).toHaveLength(3);
    const sameTopic = retrieveKnowledge(app, { query: 'Vue Transition 初始化条件' });
    expect(new Set(sameTopic.knowledge.slice(0, 2).map(item => item.bodyRef.knowledgeId))).toEqual(new Set([first.row.knowledgeId, second.row.knowledgeId]));
    expect(sameTopic.items).toHaveLength(3);
  });
});
