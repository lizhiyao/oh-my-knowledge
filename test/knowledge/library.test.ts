import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalKnowledgeApplication } from '../../src/observability/knowledge-extraction/local.js';
import { createLocalKnowledgeLibrary } from '../../src/observability/knowledge-extraction/library.js';
import type { LibraryDraft, LibraryMember } from '../../src/knowledge/library/contracts.js';
import { modelWindow } from './fixtures.js';

describe('entity knowledge library', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omk-library-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const app = () => createLocalKnowledgeApplication(root);
  const library = () => createLocalKnowledgeLibrary(root);
  async function window(name: string, transform: (packet: ReturnType<typeof modelWindow>) => void = () => {}, text = 'Alpha 使用 Beta') {
    const source = app().capture({ path: join(root, `${name}.jsonl`), origin: { threadId: name, title: name }, records: [{ recordIndex: 1,
      raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) }] });
    const run = await app().generate(source.snapshotId, { executor: 'recorded-fixture', model: 'no-model-call', generate: async (_system, input) => {
      const packet = modelWindow(); transform(packet);
      return { output: JSON.stringify(packet).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 0 };
    } });
    const analysis = app().entities(run.runId); const knowledge = app().detail(run.committed[0].knowledgeId);
    const member = (label = 'Alpha'): LibraryMember => {
      const entity = analysis.revision.entities.find(value => value.label === label)!;
      return { analysisId: run.runId, entityId: entity.entityId, entityRevisionId: analysis.revision.revisionId,
        mentionIds: analysis.revision.mentions.filter(value => value.entityId === entity.entityId).map(value => value.mentionId), rationale: '按原文确认同一项目对象' };
    };
    return { source, run, analysis, knowledge, member };
  }
  const draft = (members: LibraryMember[], label = '项目 Alpha'): LibraryDraft => ({ label, description: '来源明确描述的本项目对象；范围不推广到其它项目', referentKind: 'object', members });
  const initial = (value: LibraryDraft) => ({ objectId: randomUUID(), requestId: randomUUID(), generation: 0,
    headRevisionId: null, draft: value, reason: '核对来源后建立知识入口', identityConfirmed: true as const });

  it('accumulates two windows and reaches the same knowledge from both subject and object without copying bodies', async () => {
    const a = await window('first'); const b = await window('second');
    for (const item of [a, b]) app().maintain(item.knowledge.revision.knowledgeId, item.knowledge.revision.revisionId, 'retain', '按条件维护', item.knowledge.history.generation);
    const before = readFileSync(join(root, 'entities', `${a.run.runId}.json`));
    const saved = library().save(initial(draft([a.member(), b.member()])));
    const beta = library().save(initial(draft([a.member('Beta'), b.member('Beta')], '工具 Beta')));
    const detail = library().detail(saved.objectId); const other = library().detail(beta.objectId);
    expect(detail.counts).toEqual({ retained: 2, pending: 0, discarded: 0, needsReview: 0 });
    expect(detail.knowledge.map(value => value.knowledgeId).sort()).toEqual(other.knowledge.map(value => value.knowledgeId).sort());
    expect(detail.knowledge.map(value => value.content)).toEqual(other.knowledge.map(value => value.content));
    expect(detail.knowledge[0].roles[0].role).toBe('subject'); expect(other.knowledge[0].roles[0].role).toBe('object');
    expect(detail.knowledge[0].sourceStatus).toBe('available'); expect(detail.members.every(member => member.status === 'available')).toBe(true);
    expect(readFileSync(join(root, 'library', `${saved.objectId}.json`), 'utf8')).not.toContain('statements');
    expect(readFileSync(join(root, 'entities', `${a.run.runId}.json`))).toEqual(before);
    expect(library().catalog({ query: '项目', pageSize: 1, page: 999 })).toMatchObject({ total: 2, page: 2 });
    expect(library().catalog({ query: '不存在' }).rows).toEqual([]);
  });
  it('projects the whole workspace once, including unassociated knowledge and exact shared-object matches', async () => {
    const shared = await window('shared'); const unassociated = await window('unassociated');
    const alpha = library().save(initial(draft([shared.member()])));
    const beta = library().save(initial(draft([shared.member('Beta')], '工具 Beta')));
    const catalog = library().knowledgeCatalog();
    expect(catalog.rows).toHaveLength(2);
    expect(catalog.rows.find(row => row.knowledgeId === shared.knowledge.revision.knowledgeId)?.objects)
      .toEqual(expect.arrayContaining([{ objectId: alpha.objectId, label: '项目 Alpha', associationStatus: 'matched' }, { objectId: beta.objectId, label: '工具 Beta', associationStatus: 'matched' }]));
    expect(catalog.rows.find(row => row.knowledgeId === unassociated.knowledge.revision.knowledgeId)?.objects).toEqual([]);
    expect(catalog.rows.every(row => row.knowledgeKind === 'fact')).toBe(true);
    const before = app().detail(shared.knowledge.revision.knowledgeId);
    const revised = app().revise(before.revision.knowledgeId, before.revision.revisionId, before.history.generation,
      { title: '限定的新修订', content: before.revision.content, entities: before.revision.entities, evidence: before.revision.evidence }, '补充适用范围');
    expect(library().knowledgeCatalog().rows.find(row => row.knowledgeId === revised.revision.knowledgeId))
      .toMatchObject({ title: '限定的新修订', revisionId: revised.revision.revisionId, choice: null });
    app().deleteSource(shared.source.snapshotId);
    expect(library().knowledgeCatalog().rows).toHaveLength(2);
  });
  it('does not join names automatically and rejects a competing owner, including across exact revision changes', async () => {
    const a = await window('a'); const b = await window('b');
    expect(library().catalog().objectCount).toBe(0);
    const first = library().save(initial(draft([a.member()])));
    const second = library().save(initial(draft([b.member()])));
    expect(first.objectId).not.toBe(second.objectId);
    expect(() => library().save(initial(draft([a.member()])))).toThrow('owner conflict');
    expect(library().owners(a.run.runId, a.member().entityId)).toEqual([{ objectId: first.objectId, label: '项目 Alpha' }]);
  });
  it('keeps differing conditions and opposite claims together without letting chronology decide truth', async () => {
    const a = await window('staging', packet => { packet.proposals[0].draft.content.statements[0].context.conditions = ['仅测试环境']; });
    const b = await window('production', packet => {
      packet.proposals[0].draft.content.statements[0].polarity = 'negative';
      packet.proposals[0].draft.content.statements[0].context.conditions = ['仅生产环境'];
      packet.proposals[0].draft.evidence[0].basis = 'source_assertion';
      packet.proposals[0].citations[0].selection.quote = 'Alpha 不使用 Beta';
    }, 'Alpha 不使用 Beta');
    const saved = library().save(initial(draft([a.member(), b.member()])));
    expect(library().detail(saved.objectId).counts.pending).toBe(2);
    app().maintain(a.knowledge.revision.knowledgeId, a.knowledge.revision.revisionId, 'retain', '保留限定范围', 1);
    app().maintain(b.knowledge.revision.knowledgeId, b.knowledge.revision.revisionId, 'discard', '仍保留原始反对说法', 1);
    const detail = library().detail(saved.objectId);
    expect(detail.counts).toEqual({ retained: 1, pending: 0, discarded: 1, needsReview: 0 });
    expect(detail.knowledge).toHaveLength(2);
    expect(detail.knowledge.find(item => item.knowledgeId === b.knowledge.revision.knowledgeId)?.content).toEqual(b.knowledge.revision.content);
    expect(detail.knowledge.find(item => item.knowledgeId === a.knowledge.revision.knowledgeId)?.content).toEqual(a.knowledge.revision.content);
  });
  it('retries an identical request once and rejects altered idempotency inputs or stale drafts', async () => {
    const a = await window('a'); const input = initial(draft([a.member()])); const first = library().save(input);
    expect(library().save(input)).toEqual(first);
    expect(() => library().save({ ...input, reason: '不同的请求内容' })).toThrow('idempotency conflict');
    expect(() => library().save({ ...input, requestId: randomUUID() })).toThrow('revision conflict');
    expect(existsSync(join(root, '.knowledge-write.lock'))).toBe(false);
  });
  it('requires current readable mention evidence and rejects unresolved or incompatible levels', async () => {
    const a = await window('a'); const member = a.member();
    expect(() => library().save(initial(draft([{ ...member, mentionIds: [randomUUID()] }])))).toThrow('evidence mismatch');
    expect(() => library().save(initial({ ...draft([member]), referentKind: 'component' }))).toThrow('needs correction');
    expect(() => library().save({ ...initial(draft([member])), identityConfirmed: false as unknown as true })).toThrow();
    expect(() => library().save(initial(draft([member, member])))).toThrow();
    const entities = structuredClone(a.analysis.revision.entities); entities[0].identityStatus = 'unresolved'; entities[0].uncertainties = ['原文所指待核对'];
    const changed = app().correctEntities(a.run.runId, a.analysis.revision.revisionId, 1, { entities, mentions: a.analysis.revision.mentions }, '记录歧义');
    expect(() => library().save(initial(draft([member])))).toThrow('revision conflict');
    expect(() => library().save(initial(draft([{ ...member, entityRevisionId: changed.revision.revisionId }])))).toThrow('needs correction');
  });
  it('quarantines knowledge after an explicit entity update until the organization link is reviewed', async () => {
    const a = await window('a'); const input = initial(draft([a.member()])); const saved = library().save(input);
    const entities = structuredClone(a.analysis.revision.entities); entities[0].label = '明确项目 Alpha';
    const changed = app().correctEntities(a.run.runId, a.analysis.revision.revisionId, 1, { entities, mentions: a.analysis.revision.mentions }, '补充限定');
    const revised = app().reviseUsingEntities(a.knowledge.revision.knowledgeId, a.knowledge.revision.revisionId, a.knowledge.history.generation,
      a.run.runId, changed.revision.revisionId, { title: a.knowledge.revision.title, content: a.knowledge.revision.content,
        evidence: a.knowledge.revision.evidence, entities: changed.revision.entities.map(({ entityId, label, description }) => ({ entityId, label, description })) }, '明确应用实体修订');
    app().maintain(revised.revision.knowledgeId, revised.revision.revisionId, 'retain', '重新核对', revised.history.generation);
    expect(library().detail(saved.objectId).counts).toMatchObject({ retained: 0, needsReview: 1 });
    const updated = library().save({ ...input, requestId: randomUUID(), generation: saved.generation, headRevisionId: saved.writeHeadRevisionId,
      draft: draft([{ ...a.member(), entityRevisionId: changed.revision.revisionId, rationale: '核对补充限定后确认仍为同一对象' }]), reason: '显式核对关联' });
    expect(library().detail(saved.objectId).counts).toMatchObject({ retained: 1, needsReview: 0 });
    expect(updated.revisions[0]).toEqual(saved.revisions[0]);
    expect(library().detail(saved.objectId, saved.writeHeadRevisionId).counts.needsReview).toBe(1);
    expect(app().detail(a.knowledge.revision.knowledgeId).history.revisions[0]).toEqual(a.knowledge.revision);
  });
  it('can remove links after source loss without destroying source identities, history, or knowledge', async () => {
    const a = await window('a'); const input = initial(draft([a.member()])); const saved = library().save(input);
    app().deleteSource(a.source.snapshotId);
    expect(library().detail(saved.objectId).knowledge[0].sourceStatus).toBe('unavailable');
    expect(library().detail(saved.objectId).members[0]).toMatchObject({ sourceStatus: 'unavailable' });
    const noSource = await window('b'); app().deleteSource(noSource.source.snapshotId);
    expect(() => library().save(initial(draft([noSource.member()])))).toThrow('source unavailable');
    const removed = library().save({ ...input, requestId: randomUUID(), generation: 1, headRevisionId: saved.writeHeadRevisionId, draft: draft([]), reason: '解除组织关联' });
    expect(removed.revisions).toHaveLength(2); expect(library().detail(saved.objectId).knowledge).toEqual([]);
    expect(library().detail(saved.objectId, saved.writeHeadRevisionId).knowledge).toHaveLength(1);
    expect(app().detail(a.knowledge.revision.knowledgeId).revision).toEqual(a.knowledge.revision);
  });
  it('fails closed for unreadable owners and refuses symlink storage or a live workspace lock', async () => {
    const a = await window('a'); const saved = library().save(initial(draft([a.member()])));
    const file = join(root, 'library', `${saved.objectId}.json`); const original = readFileSync(file);
    writeFileSync(file, '{bad'); expect(() => library().catalog()).toThrow();
    expect(() => library().save(initial(draft([])))).toThrow(); writeFileSync(file, original);
    const lock = join(root, '.knowledge-write.lock'); writeFileSync(lock, JSON.stringify({ owner: randomUUID(), pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() }));
    expect(() => library().save(initial(draft([a.member('Beta')])))).toThrow(); rmSync(lock);
    expect(readFileSync(file)).toEqual(original);
    rmSync(join(root, 'library'), { recursive: true }); symlinkSync(join(root, 'entities'), join(root, 'library'));
    expect(() => library().catalog()).toThrow('storage directory'); expect(() => library().save(initial(draft([a.member()])))).toThrow();
  });
  it('rejects broken organization history and shows unknown rather than partial knowledge counts', async () => {
    const a = await window('a'); const input = initial(draft([a.member()])); const first = library().save(input);
    const saved = library().save({ ...input, requestId: randomUUID(), generation: 1, headRevisionId: first.writeHeadRevisionId,
      draft: { ...input.draft, description: '明确补充本项目限定，保留原始知识' }, reason: '补充对象范围' });
    const file = join(root, 'library', `${saved.objectId}.json`); const original = readFileSync(file);
    const tampered = structuredClone(saved); tampered.revisions[1].parentRevisionId = randomUUID();
    writeFileSync(file, JSON.stringify(tampered)); expect(() => library().detail(saved.objectId)).toThrow('history references');
    expect(() => library().save(initial(draft([a.member('Beta')])))).toThrow(); writeFileSync(file, original);
    const knowledgeFile = join(root, 'items', readdirSync(join(root, 'items'))[0]); const knowledgeBytes = readFileSync(knowledgeFile);
    writeFileSync(knowledgeFile, '{bad');
    expect(library().detail(saved.objectId)).toMatchObject({ knowledgeStatus: 'unavailable', knowledge: [],
      counts: { retained: null, pending: null, discarded: null, needsReview: null } });
    writeFileSync(knowledgeFile, knowledgeBytes); expect(library().detail(saved.objectId).counts.pending).toBe(1);
    expect(existsSync(join(root, '.knowledge-write.lock'))).toBe(false);
  });
});
