import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { retrieveKnowledge } from '../../src/knowledge/application/retrieval.js';
import { executeKnowledgeOperation } from '../../src/knowledge/application/operations.js';
import { modelWindow } from './fixtures.js';

const payloadBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) + '\n');
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
  it('defaults to retained revisions, explicitly exposes pending candidates and preserves complete negative/conditional evidence within3000B', async () => {
    const f = await setup(), before = bytes(f.workspace);
    expect(retrieveKnowledge(f.app, { query: 'v-model', maxBytes: 3000 }).items).toEqual([]);
    const candidate = await executeKnowledgeOperation(f.app, { operation: 'retrieve', query: 'v-model', maxBytes: 3000, includeCandidates: true });
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
    expect(payloadBytes(candidate)).toBeLessThanOrEqual(3000); expect(bytes(f.workspace)).toEqual(before); expect(f.invocations()).toBe(1);
    f.retain(); expect(retrieveKnowledge(f.app, { query: 'v-model' }).knowledge[0].choice).toBe('retain');
    const detail = f.app.detail(f.committed.knowledgeId);
    f.app.maintain(detail.revision.knowledgeId, detail.revision.revisionId, 'discard', 'fixture discard', detail.history.generation);
    expect(retrieveKnowledge(f.app, { query: 'v-model', includeCandidates: true }).items).toEqual([]);
  });
  it('supports literal Chinese, case-insensitive English and code terms, exact source/entity scope and stable identity without name merging', async () => {
    const f = await setup(); f.retain(); const detail = f.app.detail(f.committed.knowledgeId), entityId = detail.revision.entities[0].entityId;
    for (const query of ['为什么父组件初始化时v-model不更新，withDirectives有什么条件？', 'Why does v-model not update during initialization?', 'ALPHA', 'withDirectives(vnode,dirs)']) {
      const result = retrieveKnowledge(f.app, { query, maxBytes: 3000, snapshot: f.snapshot.snapshotId, sourceVersion: f.snapshot.sourceVersion, entityId });
      expect(result.items).toHaveLength(1); expect(result.knowledge[result.items[0].knowledge].knowledgeId).toBe(f.committed.knowledgeId);
      expect(result).toEqual(retrieveKnowledge(f.app, { query, maxBytes: 3000, snapshot: f.snapshot.snapshotId, sourceVersion: f.snapshot.sourceVersion, entityId }));
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
    const ordinary = retrieveKnowledge(f.app, { query, maxBytes: 3000 });
    expect(ordinary.items).toHaveLength(1); expect(ordinary.entities.some(entity => entity.entityId === vue.entityId)).toBe(false);
    const scoped = retrieveKnowledge(f.app, { query, entityId: vue.entityId, maxBytes: 3000 });
    expect(scoped.items).toHaveLength(1); expect(scoped.scopeDiagnostics?.entity).toBe('matched_knowledge');
    const scopeIndex = scoped.knowledge[scoped.items[0].knowledge].scopeEntities![0];
    expect(scoped.entities[scopeIndex]).toMatchObject({ entityId: vue.entityId, label: 'Vue', qualifiers: ['3.5.12'] });
    expect(scoped.items[0].entities).not.toContain(scopeIndex);
    expect(scoped.items[0].statement.subject.entityId).not.toBe(vue.entityId);
    expect(retrieveKnowledge(f.app, { query: '3.5.12', maxBytes: 3000 }).items).toHaveLength(1);
  });
  it('returns method statement subsets without dangling step IDs and preserves organization purpose', async () => {
    const f = await setup(packet => {
      const content = packet.proposals[0].draft.content, other = structuredClone(content.statements[0]);
      other.statementId = 'other'; other.relation = '下一步检查'; content.statements.push(other);
      content.organization = { knowledgeKind: 'method', purpose: '依次核对两个步骤', instructionStatementIds: ['usage', 'other'] };
      packet.proposals[0].draft.evidence[0].statementIds.push('other');
    }); f.retain();
    const result = retrieveKnowledge(f.app, { query: 'withDirectives', maxBytes: 3000 });
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.knowledge[0]).toMatchObject({ statementScope: { returned: result.items.length, total: 2 },
      organization: { knowledgeKind: 'method', purpose: '依次核对两个步骤', omittedInstructions: 2 - result.items.length } });
    expect(result.items[0].organizationRole).toEqual({ instruction: true });
    expect(JSON.stringify(result)).not.toContain('instructionStatementIds');
  });
  it('packs multiple complete related statements within3000B using shared pools rather than duplicate metadata', async () => {
    const f = await setup(packet => {
      const content = packet.proposals[0].draft.content, next = structuredClone(content.statements[0]);
      next.statementId = 'next'; next.relation = 'v-model 的第二个完整相关陈述'; content.statements.push(next);
      packet.proposals[0].draft.evidence[0].statementIds.push('next');
    }); f.retain();
    const result = retrieveKnowledge(f.app, { query: '为什么初始化时v-model不更新？后续需要核对什么？', maxBytes: 3000 });
    expect(result.items).toHaveLength(2); expect(result.knowledge).toHaveLength(1); expect(result.evidence).toHaveLength(1);
    expect(payloadBytes(result)).toBeLessThanOrEqual(3000);
    for (const item of result.items) {
      const knowledge = result.knowledge[item.knowledge];
      expect(item.statement).toEqual(f.app.detail(knowledge.knowledgeId, knowledge.revisionId).revision.content.statements.find(s => s.statementId === item.statement.statementId));
      expect(item.entities.every(index => !!result.entities[index])).toBe(true); expect(item.evidence.every(index => !!result.evidence[index])).toBe(true);
    }
  });
  it('uses literal hits per complete serialized cost when a large same-hit statement would crowd out complementary smaller statements', async () => {
    const f = await setup(packet => {
      const content = packet.proposals[0].draft.content;
      const first = structuredClone(content.statements[0]), second = structuredClone(content.statements[0]);
      content.statements[0].statementId = 'a-large'; content.statements[0].context.conditions.push('必须保留的额外适用条件'.repeat(15));
      first.statementId = 'b-first'; second.statementId = 'c-second';
      content.statements.push(first, second); packet.proposals[0].draft.evidence[0].statementIds = ['a-large', 'b-first', 'c-second'];
    }); f.retain();
    const result = retrieveKnowledge(f.app, { query: 'Why does v-model fail during initialization?', maxBytes: 3000 });
    expect(result.items.map(item => item.statement.statementId)).toEqual(['b-first', 'c-second']);
    expect(result.omitted.budgetUnits).toBe(1); expect(result.omitted.oversizedUnits).toBe(0);
    expect(payloadBytes(result)).toBeLessThanOrEqual(3000);
    expect(f.app.detail(f.committed.knowledgeId).revision.content.statements[0].context.conditions[1]).toBe('必须保留的额外适用条件'.repeat(15));
  });
  it('reports oversized units without shortening conditions and can still pack a later complete smaller statement', async () => {
    const f = await setup(packet => {
      const content = packet.proposals[0].draft.content, small = structuredClone(content.statements[0]);
      small.statementId = 'small'; content.statements.push(small); packet.proposals[0].draft.evidence[0].statementIds.push('small');
      content.statements[0].context.conditions = ['前提条件'.repeat(1000)];
    }); f.retain(); const before = bytes(f.workspace);
    const result = retrieveKnowledge(f.app, { query: 'Alpha', maxBytes: 3000 });
    expect(result).toMatchObject({ omitted: { oversizedUnits: 1 }, items: [{ statement: { statementId: 'small' } }] });
    expect(payloadBytes(result)).toBeLessThanOrEqual(3000); expect(bytes(f.workspace)).toEqual(before);
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
    expect(payloadBytes(retrieveKnowledge(app, { query: '长'.repeat(512), maxBytes: 1024 }))).toBeLessThanOrEqual(1024);
    expect(existsSync(workspace)).toBe(false);
  });
});
