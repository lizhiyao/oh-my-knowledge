import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { retrieveKnowledge as retrieveEncoded, decodeKnowledgeContext, encodeKnowledgeContext, KNOWLEDGE_RETRIEVAL_DEFAULT_BYTES, type KnowledgeRetrievalProjection } from '../../src/knowledge/application/retrieval.js';
import { executeKnowledgeOperation } from '../../src/knowledge/application/operations.js';
import { modelWindow } from './fixtures.js';

const payloadBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) + '\n');
function retrieveKnowledge(...args: Parameters<typeof retrieveEncoded>) {
  const packet = retrieveEncoded(...args), decoded = decodeKnowledgeContext(packet);
  expect(payloadBytes(packet)).toBeLessThanOrEqual(args[1].maxBytes ?? KNOWLEDGE_RETRIEVAL_DEFAULT_BYTES);
  expect(encodeKnowledgeContext(decoded)).toEqual(packet);
  return decoded;
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function bytes(root: string): unknown {
  if (!existsSync(root)) return null;
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => ({
    name: entry.name, content: entry.isDirectory() ? bytes(join(root, entry.name))
      : createHash('sha256').update(readFileSync(join(root, entry.name))).digest('hex'),
  }));
}
async function setup(change?: (packet: ReturnType<typeof modelWindow>) => void, text = 'Alpha 使用 Beta。用户报告初始化 v-model 不更新；成本未知。') {
  const root = mkdtempSync(join(tmpdir(), 'omk-retrieve-')); roots.push(root);
  const workspace = join(root, 'workspace'), app = createLocalKnowledgeApplication(workspace), source = join(root, 'source.jsonl');
  writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text }] } }));
  const snapshot = app.capture({ path: source }), packet = modelWindow();
  packet.mentions.forEach(mention => { mention.selection.evidenceRef = snapshot.excerpts[0].evidenceRef; });
  const draft = packet.proposals[0].draft;
  draft.evidence[0].evidenceRef = snapshot.excerpts[0].evidenceRef;
  draft.evidence[0].basis = 'source_assertion'; draft.evidence[0].interpretation = '用户报告，未经独立复现';
  const statement = draft.content.statements[0];
  statement.relation = '初始化时不更新 v-model，调用 withDirectives(vnode,dirs)'; statement.polarity = 'negative';
  statement.context.conditions = ['仅父组件初始化']; statement.context.exceptions = ['不适用于用户输入'];
  statement.context.unknowns = ['成本未测'];
  packet.proposals[0].citations[0].selection.evidenceRef = snapshot.excerpts[0].evidenceRef;
  change?.(packet);
  let invocations = 0;
  const run = await app.generate(snapshot.snapshotId, { executor: 'authored-fixture', model: 'no-native-call',
    generate: async () => { invocations++; return { output: JSON.stringify(packet), durationMs: 0 }; } });
  const committed = run.committed[0]; expect(committed).toBeDefined();
  return { root, workspace, app, snapshot, run, committed, invocations: () => invocations,
    retain() { const detail = app.detail(committed.knowledgeId); app.maintain(committed.knowledgeId, detail.revision.revisionId, 'retain', 'fixture explicit choice', detail.history.generation); } };
}

describe('read-only task knowledge retrieval', () => {
  it('defaults to retained revisions, explicitly exposes pending candidates and preserves complete negative/conditional evidence within the default8192B', async () => {
    const f = await setup(), before = bytes(f.workspace);
    expect(retrieveKnowledge(f.app, { query: 'v-model', maxBytes: 8192 }).items).toEqual([]);
    const encoded = await executeKnowledgeOperation(f.app, { operation: 'retrieve', query: 'v-model', maxBytes: 8192, includeCandidates: true });
    const candidate = decodeKnowledgeContext(encoded);
    expect(payloadBytes(encoded)).toBeLessThanOrEqual(8192);
    expect(candidate.items).toHaveLength(1);
    expect(candidate.knowledge[0]).toMatchObject({ choice: null, reviewStatus: 'pending' });
    expect(candidate.items[0]).toMatchObject({ statement: { polarity: 'negative',
      context: { conditions: ['仅父组件初始化'], exceptions: ['不适用于用户输入'], unknowns: ['成本未测'], occurredDuring: { timeKind: 'unknown' } } } });
    expect(candidate.evidence).toMatchObject([{ basis: 'source_assertion', locators: [{ positionStatus: 'matched', sourceRole: 'user' }] }]);
    const locator = candidate.evidence[0].locators[0], source = candidate.sources[locator.source!];
    const resolved = f.app.source(source.snapshotId, source.sourceVersion);
    expect(resolved.status).toBe('available');
    if (resolved.status === 'available') expect(resolved.window.excerpts.find(e => e.evidenceRef === locator.evidenceRef)!.text.slice(locator.start, locator.end)).toBe(f.app.detail(f.committed.knowledgeId).grounding.citations[0].selection.quote);
    expect(locator).not.toHaveProperty('quote');
    expect(candidate.omitted.identityRelations).toBe(true);
    expect(candidate.entities.every(entity => !('componentRef' in entity) && !('collection' in entity) && !('possibleEntityIds' in entity))).toBe(true);
    expect(candidate.items[0].statement).toEqual(f.app.detail(f.committed.knowledgeId).revision.content.statements[0]);
    expect(payloadBytes(encodeKnowledgeContext(candidate))).toBeLessThanOrEqual(8192); expect(bytes(f.workspace)).toEqual(before); expect(f.invocations()).toBe(1);
    f.retain(); expect(retrieveKnowledge(f.app, { query: 'v-model' }).knowledge[0].choice).toBe('retain');
    const detail = f.app.detail(f.committed.knowledgeId);
    f.app.maintain(detail.revision.knowledgeId, detail.revision.revisionId, 'discard', 'fixture discard', detail.history.generation);
    expect(retrieveKnowledge(f.app, { query: 'v-model', includeCandidates: true }).items).toEqual([]);
  });
  it('roundtrips every projected semantic field, distinct null/absence/arrays and all fact-time variants without summaries', async () => {
    const f = await setup();
    const base = retrieveKnowledge(f.app, { query: 'v-model', includeCandidates: true });
    base.knowledge[0].identityUncertainties = ['Exact identity is unknown; do not merge.'];
    const entity = base.entities[0];
    if ('identityDetails' in entity) throw new Error('Fixture identity details must be available.');
    entity.qualifiers = ['version=3.5.12', 'parent-only']; entity.uncertainties = ['Identity has not been confirmed.'];
    base.evidence[0].locators[0].sourceTimestamp = '2026-01-01T00:00:00Z';
    const times: KnowledgeRetrievalProjection['items'][number]['statement']['context']['occurredDuring'][] = [
      { timeKind: 'unknown', reason: 'No event time in the source.' }, { timeKind: 'not_applicable', reason: 'A requested future behavior.' },
      { timeKind: 'instant', at: '2026-01-01T00:00:00Z' },
      { timeKind: 'interval', start: { boundKind: 'known', at: '2026-01-01T00:00:00Z' }, end: { boundKind: 'unknown', reason: 'End is unknown.' } },
      { timeKind: 'interval', start: { boundKind: 'unbounded' }, end: { boundKind: 'known', at: '2026-01-02T00:00:00Z' } },
    ];
    for (const time of times) {
      const input = structuredClone(base); input.items[0].statement.context.occurredDuring = time;
      input.items[0].statement.context.validDuring = { timeKind: 'unknown', reason: 'Applicability time differs from source time.' };
      input.items[0].statement.context.conditions.push('[-1,0] is literal text, not a dictionary reference.');
      const encoded = encodeKnowledgeContext(input);
      expect(decodeKnowledgeContext(JSON.parse(JSON.stringify(encoded)))).toEqual(input);
      expect(encoded).toMatchObject({ schemaVersion: 2, encoding: 'typed-columns/v1' });
      expect(input.knowledge[0].choice).toBeNull(); expect(input.items[0]).not.toHaveProperty('organizationRole');
    }
    const caseProjection = structuredClone(base);
    caseProjection.knowledge[0].organization = { knowledgeKind: 'case', situation: 'Exact source situation.', gaps: ['Outcome not verified.'], omittedActions: 1, omittedOutcomes: 2 };
    caseProjection.items[0].organizationRole = { action: true, outcome: false };
    expect(decodeKnowledgeContext(encodeKnowledgeContext(caseProjection))).toEqual(caseProjection);
    const invalid = encodeKnowledgeContext(base); invalid.items[0] = [-1, 99999];
    expect(() => decodeKnowledgeContext(invalid)).toThrow('Invalid knowledge task column context');
  });
  it('supports literal Chinese, case-insensitive English and code terms, exact source/entity scope and stable identity without name merging', async () => {
    const f = await setup(); f.retain(); const detail = f.app.detail(f.committed.knowledgeId), entityId = detail.revision.entities[0].entityId;
    for (const query of ['为什么父组件初始化时v-model不更新，withDirectives有什么条件？', 'Why does v-model not update during initialization?', 'ALPHA', 'withDirectives(vnode,dirs)']) {
      const result = retrieveKnowledge(f.app, { query, maxBytes: 8192, snapshot: f.snapshot.snapshotId, sourceVersion: f.snapshot.sourceVersion, entityId });
      expect(result.items).toHaveLength(1); expect(result.knowledge[result.items[0].knowledge].knowledgeId).toBe(f.committed.knowledgeId);
      expect(result).toEqual(retrieveKnowledge(f.app, { query, maxBytes: 8192, snapshot: f.snapshot.snapshotId, sourceVersion: f.snapshot.sourceVersion, entityId }));
    }
    expect(retrieveKnowledge(f.app, { query: 'Alpha', entityId: 'Alpha' })).toMatchObject({ items: [], scopeDiagnostics: { entity: 'no_eligible_knowledge' } });
    expect(retrieveKnowledge(f.app, { query: 'Alpha', snapshot: randomUUID() })).toMatchObject({ items: [], scopeDiagnostics: { source: { status: 'unavailable', reason: 'missing' } } });
  });
  it('keeps an explicitly associated Vue version scope without pretending that the framework is a statement endpoint', async () => {
    const f = await setup(packet => {
      packet.entities.push({ ...structuredClone(packet.entities[0]), entityId: 'vue', label: 'Vue', description: '报告所用的框架范围',
        qualifiers: ['3.5.12'], referentKind: 'component' });
      packet.mentions.push({ mentionId: 'm-vue', entityId: 'vue', basis: 'explicit', rationale: '明确框架版本范围',
        selection: { evidenceRef: packet.mentions[0].selection.evidenceRef, quote: 'Vue3.5.12' } });
      packet.proposals[0].entityIds.push('vue'); packet.proposals[0].mentionIds.push('m-vue');
    }, 'Vue3.5.12 Alpha 使用 Beta。用户报告初始化 v-model 不更新；成本未知。'); f.retain();
    const detail = f.app.detail(f.committed.knowledgeId), vue = detail.revision.entities.find(entity => entity.label === 'Vue')!;
    const query = '初始化时v-model为什么没有更新？';
    const ordinary = retrieveKnowledge(f.app, { query, maxBytes: 8192 });
    expect(ordinary.items).toHaveLength(1); expect(ordinary.entities.some(entity => entity.entityId === vue.entityId)).toBe(false);
    const scoped = retrieveKnowledge(f.app, { query, entityId: vue.entityId, maxBytes: 8192 });
    expect(scoped.items).toHaveLength(1); expect(scoped.scopeDiagnostics?.entity).toBe('matched_knowledge');
    const scopeIndex = scoped.knowledge[scoped.items[0].knowledge].scopeEntities![0];
    expect(scoped.entities[scopeIndex]).toMatchObject({ entityId: vue.entityId, label: 'Vue', qualifiers: ['3.5.12'] });
    expect(scoped.items[0].entities).not.toContain(scopeIndex);
    expect(scoped.items[0].statement.subject.entityId).not.toBe(vue.entityId);
    expect(retrieveKnowledge(f.app, { query: '3.5.12', maxBytes: 8192 }).items).toHaveLength(1);
  });
  it('returns method statement subsets without dangling step IDs and preserves organization purpose', async () => {
    const f = await setup(packet => {
      const content = packet.proposals[0].draft.content, other = structuredClone(content.statements[0]);
      other.statementId = 'other'; other.relation = 'withDirectives next required step';
      other.context.conditions = ['A required unshortened applicability condition. '.repeat(400)]; content.statements.push(other);
      content.organization = { knowledgeKind: 'method', purpose: '依次核对两个步骤', instructionStatementIds: ['usage', 'other'] };
      packet.proposals[0].draft.evidence[0].statementIds.push('other');
    }); f.retain();
    const result = retrieveKnowledge(f.app, { query: 'withDirectives', maxBytes: 8192 });
    expect(result.items).toHaveLength(1); expect(result.omitted.oversizedUnits).toBe(1);
    expect(result.knowledge[0]).toMatchObject({ statementScope: { returned: result.items.length, total: 2 },
      organization: { knowledgeKind: 'method', purpose: '依次核对两个步骤', omittedInstructions: 2 - result.items.length } });
    expect(result.items[0].organizationRole).toEqual({ instruction: true });
    expect(JSON.stringify(result)).not.toContain('instructionStatementIds');
  });
  it('packs multiple complete related statements within the default8192B using shared pools rather than duplicate metadata', async () => {
    const f = await setup(packet => {
      const content = packet.proposals[0].draft.content, next = structuredClone(content.statements[0]);
      next.statementId = 'next'; next.relation = 'v-model 的第二个完整相关陈述'; content.statements.push(next);
      packet.proposals[0].draft.evidence[0].statementIds.push('next');
    }); f.retain();
    const result = retrieveKnowledge(f.app, { query: '为什么初始化时v-model不更新？后续需要核对什么？', maxBytes: 8192 });
    expect(result.items).toHaveLength(2); expect(result.knowledge).toHaveLength(1); expect(result.evidence).toHaveLength(1);
    expect(payloadBytes(encodeKnowledgeContext(result))).toBeLessThanOrEqual(8192);
    for (const item of result.items) {
      const knowledge = result.knowledge[item.knowledge];
      expect(item.statement).toEqual(f.app.detail(knowledge.knowledgeId, knowledge.revisionId).revision.content.statements.find(s => s.statementId === item.statement.statementId));
      expect(item.entities.every(index => !!result.entities[index])).toBe(true); expect(item.evidence.every(index => !!result.evidence[index])).toBe(true);
    }
  });
  it('separates document recall from local statement relevance and rewards complementary coverage after sharing', async () => {
    const f = await setup(packet => {
      const draft = packet.proposals[0].draft, base = structuredClone(draft.content.statements[0]);
      draft.title = 'red green';
      draft.content.statements = ['unrelated', 'red', 'green', 'red'].map((relation, index) => ({ ...structuredClone(base),
        statementId: ['a-document-only', 'b-red', 'c-green', 'd-repeat'][index], relation }));
      draft.evidence[0].statementIds = draft.content.statements.map(statement => statement.statementId);
    }); f.retain();
    const result = retrieveKnowledge(f.app, { query: 'red green' });
    expect(result.items.slice(0, 2).map(item => item.statement.relation).sort()).toEqual(['green', 'red']);
    expect(result.items[0].statement.statementId).not.toBe('a-document-only');
    expect(result.items).toHaveLength(4); expect(result.knowledge).toHaveLength(1); expect(result.evidence).toHaveLength(1);
  });
  it('weights derived Han bigram novelty below explicit identifiers while preserving whole two-character runs and new topics', async () => {
    const fixture = async (labels: string[], definitions: [string, number, string][]) => {
      const text = [...labels, ...definitions.map(([, , relation]) => relation)].join('\n');
      return setup(packet => {
        const template = structuredClone(packet.entities[0]), evidenceRef = packet.mentions[0].selection.evidenceRef;
        packet.entities = labels.map((label, index) => ({ ...structuredClone(template), entityId: `object-${index}`, label,
          description: `Synthetic object ${index}.` }));
        packet.mentions = labels.map((label, index) => ({ mentionId: `mention-${index}`, entityId: `object-${index}`,
          basis: 'explicit', rationale: 'Authored synthetic identity.', selection: { evidenceRef, quote: label } }));
        const proposal = packet.proposals[0], draft = proposal.draft, base = structuredClone(draft.content.statements[0]);
        proposal.entityIds = packet.entities.map(entity => entity.entityId); proposal.mentionIds = packet.mentions.map(mention => mention.mentionId);
        draft.title = 'Synthetic lexical selection fixture';
        draft.content.statements = definitions.map(([statementId, subject, relation]) => {
          const statement = { ...structuredClone(base), statementId, subject: { entityId: `object-${subject}` }, relation,
            context: { scenario: 'Synthetic boundary example.', conditions: [], exceptions: [], unknowns: ['Authored data, not a technical claim.'],
              occurredDuring: { timeKind: 'unknown' as const, reason: 'Synthetic event time unspecified.' },
              validDuring: { timeKind: 'unknown' as const, reason: 'Synthetic applicability unspecified.' } } };
          delete statement.object; return statement;
        });
        draft.evidence[0].statementIds = definitions.map(([id]) => id);
        proposal.citations[0].selection = { evidenceRef, quote: text };
      }, text);
    };
    const definitions: [string, number, string][] = [['initial', 0, '支持配置条件。'], ['object-detail', 0, '保留附加适用条件。']];
    const first = await fixture(['CobaltToken', 'JuniperLedger'], [...definitions, ['grammar-overlap', 1, '没有执行记录。']]);
    const order = (app: typeof first.app, query: string) => retrieveKnowledge(app, { query, includeCandidates: true }).items.map(item => item.statement.statementId);
    expect(order(first.app, 'CobaltToken 的记录有哪些条件？')).toEqual(['initial', 'object-detail', 'grammar-overlap']);
    // Both Han fragments also occur as complete query runs: neither is downgraded merely for being two characters.
    expect(order(first.app, 'CobaltToken 的记录有哪些条件？ 记录 条件')).toEqual(['initial', 'grammar-overlap', 'object-detail']);
    const second = await fixture(['CobaltToken', 'AmberRoute', 'JuniperLedger'], [...definitions,
      ['new-topic', 1, '提供另一组条件。'], ['grammar-overlap', 2, '没有执行记录。']]);
    expect(order(second.app, 'CobaltToken AmberRoute 的条件和记录是什么？')).toEqual(['initial', 'new-topic', 'object-detail', 'grammar-overlap']);
  });
  it('reports oversized units without shortening conditions and can still pack a later complete smaller statement', async () => {
    const f = await setup(packet => {
      const content = packet.proposals[0].draft.content, small = structuredClone(content.statements[0]);
      small.statementId = 'small'; content.statements.push(small); packet.proposals[0].draft.evidence[0].statementIds.push('small');
      content.statements[0].context.conditions = ['前提条件'.repeat(1000)];
    }); f.retain(); const before = bytes(f.workspace);
    const result = retrieveKnowledge(f.app, { query: 'Alpha', maxBytes: 8192 });
    expect(result).toMatchObject({ omitted: { oversizedUnits: 1 }, items: [{ statement: { statementId: 'small' } }] });
    expect(payloadBytes(encodeKnowledgeContext(result))).toBeLessThanOrEqual(8192); expect(bytes(f.workspace)).toEqual(before);
    expect(retrieveKnowledge(f.app, { query: 'Alpha', maxBytes: 1024 })).toMatchObject({ items: [], omitted: { oversizedUnits: 2 } });
  });
  it('discloses unavailable sources and stale entity bindings while keeping historical content readable without writes', async () => {
    const f = await setup(); f.retain(); const analysis = f.app.entities(f.run.runId);
    const draft = structuredClone({ entities: analysis.revision.entities, mentions: analysis.revision.mentions });
    draft.entities[0].label = '原对象的修订名称';
    f.app.correctEntities(f.run.runId, analysis.revision.revisionId, analysis.history.generation, draft, 'fixture identity revision');
    const stale = retrieveKnowledge(f.app, { query: 'v-model' }); expect(stale.knowledge[0].entityBindingStatus).toBe('outdated');
    f.app.deleteSource(f.snapshot.snapshotId); const before = bytes(f.workspace);
    const missing = retrieveKnowledge(f.app, { query: 'v-model', snapshot: f.snapshot.snapshotId });
    expect(missing).toMatchObject({ scopeDiagnostics: { source: { status: 'unavailable', reason: 'deleted' } },
      sources: [{ status: 'unavailable', reason: 'deleted' }], evidence: [{ locators: [{ positionStatus: 'unavailable' }] }] });
    expect(bytes(f.workspace)).toEqual(before);
  });
  it('never creates an empty workspace and validates malformed requests before reading state', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-retrieve-empty-')); roots.push(root); const workspace = join(root, 'absent');
    const app = createLocalKnowledgeApplication(workspace);
    expect(retrieveKnowledge(app, { query: '没有内容' }).items).toEqual([]); expect(existsSync(workspace)).toBe(false);
    for (const input of [{ query: '' }, { query: '???' }, { query: 'x', maxBytes: 1023 }, { query: 'x', snapshot: 'invalid' }, { query: 'x', sourceVersion: `sha256:${'a'.repeat(64)}` }]) {
      expect(() => retrieveKnowledge(app, input)).toThrow(); expect(existsSync(workspace)).toBe(false);
    }
    expect(payloadBytes(encodeKnowledgeContext(retrieveKnowledge(app, { query: '长'.repeat(512), maxBytes: 1024 })))).toBeLessThanOrEqual(1024);
    expect(existsSync(workspace)).toBe(false);
  });
});
