import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalKnowledgeApplication } from '../../src/observability/knowledge-extraction/local.js';
import { createLocalEntityLinks } from '../../src/observability/knowledge-extraction/local.js';
import { EntityLinkApplication } from '../../src/observability/knowledge-extraction/entity-links.js';
import { FileEntityAnalysisStore } from '../../src/observability/knowledge-extraction/adapters/entity-store.js';
import { KnowledgeLibraryApplication } from '../../src/observability/knowledge-extraction/library.js';
import { FileLibraryStore } from '../../src/observability/knowledge-extraction/adapters/library-store.js';
import { FileEntityLinkStore } from '../../src/observability/knowledge-extraction/adapters/entity-link-store.js';
import type { EntityLinkCapture, EntityLinkStore, EntityLinkTransaction } from '../../src/knowledge/entities/links.js';
import { entityLinkDigest } from '../../src/observability/knowledge-extraction/entity-link-hash.js';
import { validateEntityLinkReview } from '../../src/knowledge/entities/links.js';
import { createLocalKnowledgeLibrary } from '../../src/observability/knowledge-extraction/local.js';
import type { LibraryDraft, LibraryEnvelope, LibraryMember } from '../../src/knowledge/library/contracts.js';
import { modelWindow } from './fixtures.js';

describe('entity knowledge library', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omk-library-')); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
  const links = () => createLocalEntityLinks(root);
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

  const reference = (value: Awaited<ReturnType<typeof window>>) => ({ analysisId: value.run.runId, entityId: value.member().entityId });
  function capture(preview: ReturnType<ReturnType<typeof links>['preview']>, assessment: 'same_object' | 'different_objects' | 'insufficient_evidence' = 'same_object'): EntityLinkCapture {
    return { reviewId: preview.reviewId, requestId: randomUUID(), left: preview.left, right: preview.right, inputDigest: preview.inputDigest,
      evidence: { executor: 'recorded-fixture', model: 'no-model-call', promptVersion: 'entity-link-proposal-v1', promptHash: `sha256:${'a'.repeat(64)}`, durationMs: 0,
        rawOutput: JSON.stringify({ responseKind: 'entity-link-suggestion', schemaVersion: 1, leftEntityId: preview.left.entityId, rightEntityId: preview.right.entityId,
          assessment, leftMentionIds: preview.left.mentionIds, rightMentionIds: preview.right.mentionIds, rationale: '两侧来源仍需人工核对所指对象' }) } };
  }
  function accept(reviewId: string, expectedGeneration = 1, requestId = randomUUID()) {
    return links().decide({ reviewId, requestId, expectedGeneration, decision: 'accept', reason: '独立核对两侧来源后确认所指同一对象', identityConfirmed: true });
  }

  function historyAt(history: LibraryEnvelope, versions: number, value?: LibraryDraft): LibraryEnvelope {
    const result = structuredClone(history);
    if (value) result.revisions[0].draft = value;
    while (result.revisions.length < versions) {
      const previous = result.revisions.at(-1)!; const revisionId = randomUUID();
      result.revisions.push({ ...previous, revisionId, parentRevisionId: previous.revisionId,
        draft: { ...previous.draft, description: `历史 ${result.revisions.length} · ${previous.draft.description}`.slice(0, 4096) } });
      result.receipts.push({ requestId: randomUUID(), commandDigest: `sha256:${'f'.repeat(64)}`, revisionId, committedGeneration: result.revisions.length });
    }
    result.generation = result.revisions.length; result.writeHeadRevisionId = result.revisions.at(-1)!.revisionId; return result;
  }

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
  it('recalls normalized names only as candidates and preserves rejected revisions, raw suggestions, identities and knowledge', async () => {
    const a = await window('a'); const b = await window('b');
    const entities = structuredClone(b.analysis.revision.entities); entities[0].label = 'Ａ l P h A';
    const changed = app().correctEntities(b.run.runId, b.analysis.revision.revisionId, 1, { entities, mentions: b.analysis.revision.mentions }, '规范化检索仍需独立人审');
    expect(links().recall(reference(a)).rows.map(row => row.entityId)).toContain(b.member().entityId);
    expect(library().catalog().objectCount).toBe(0);
    const preview = links().preview(reference(a), reference(b)); const command = capture(preview, 'different_objects');
    const before = [a, b].map(value => [readFileSync(join(root, 'entities', `${value.run.runId}.json`)), readFileSync(join(root, 'items', readdirSync(join(root, 'items')).find(file => readFileSync(join(root, 'items', file), 'utf8').includes(value.knowledge.revision.knowledgeId))!))]);
    const recorded = links().record(command); expect(links().record(command)).toEqual(recorded);
    expect(recorded.suggestion).toMatchObject({ status: 'admitted', value: { assessment: 'different_objects' } });
    const rejected = links().decide({ reviewId: preview.reviewId, requestId: randomUUID(), expectedGeneration: 1, decision: 'reject', reason: '同名来源没有同一对象证据' });
    expect(links().read(preview.reviewId)).toEqual(rejected); expect(rejected.capture.evidence.rawOutput).toBe(command.evidence.rawOutput);
    expect(rejected.events[0]).toEqual(recorded.events[0]); expect(links().recall(reference(a)).rows).toEqual([]);
    expect(() => links().preview(reference(b), reference(a))).toThrow('already reviewed');
    expect(library().catalog().objectCount).toBe(0);
    for (const [index, value] of [a, b].entries()) {
      expect(readFileSync(join(root, 'entities', `${value.run.runId}.json`))).toEqual(before[index][0]);
      expect(app().detail(value.knowledge.revision.knowledgeId).revision).toEqual(value.knowledge.revision);
    }
    app().correctEntities(b.run.runId, changed.revision.revisionId, 2, { entities: changed.revision.entities, mentions: changed.revision.mentions }, '新修订重新核对');
    expect(links().recall(reference(a)).rows).toHaveLength(1);
  });
  it('records explicit human override and stable organization receipts without copying or changing either source UUID', async () => {
    const a = await window('a'), b = await window('b');
    const before = [a, b].map(value => readFileSync(join(root, 'entities', `${value.run.runId}.json`)));
    const command = capture(links().preview(reference(a), reference(b)), 'insufficient_evidence'); links().record(command);
    expect(() => links().decide({ reviewId: command.reviewId, requestId: randomUUID(), expectedGeneration: 1, decision: 'accept', reason: '没有显式确认', identityConfirmed: false as unknown as true })).toThrow();
    expect(links().read(command.reviewId).generation).toBe(1);
    const requestId = randomUUID(), applied = accept(command.reviewId, 1, requestId);
    expect(applied.events.map(event => event.eventKind)).toEqual(['recorded', 'reviewed', 'applied']);
    expect(applied.suggestion).toMatchObject({ status: 'admitted', value: { assessment: 'insufficient_evidence' } });
    expect(accept(command.reviewId, 1, requestId)).toEqual(applied); expect(links().resume(command.reviewId)).toEqual(applied);
    const objects = library().catalog().rows; expect(objects).toHaveLength(1);
    const history = library().detail(objects[0].objectId).history; expect(history.generation).toBe(1); expect(history.receipts).toHaveLength(1);
    expect(history.revisions[0].draft.members.map(member => member.entityId)).toEqual([a.member().entityId, b.member().entityId]);
    for (const [index, value] of [a, b].entries()) {
      expect(readFileSync(join(root, 'entities', `${value.run.runId}.json`))).toEqual(before[index]);
      expect(app().detail(value.knowledge.revision.knowledgeId).revision).toEqual(value.knowledge.revision);
    }
    expect(existsSync(join(root, '.knowledge-write.lock'))).toBe(false);
  });
  it.each(['library_ack', 'review_append', 'library_ack_at_history_limit'] as const)('resumes a stable committed intent after %s loss even if source heads have since changed', async failure => {
    const a = await window('a'), b = await window('b');
    if (failure === 'library_ack_at_history_limit') {
      const owner = library().save(initial(draft([a.member()]))); writeFileSync(join(root, 'library', `${owner.objectId}.json`), JSON.stringify(historyAt(owner, 255), null, 2));
    }
    const command = capture(links().preview(reference(a), reference(b))); links().record(command);
    let application = links();
    if (failure !== 'review_append') {
      const original = KnowledgeLibraryApplication.prototype.applyLinkIntent;
      vi.spyOn(KnowledgeLibraryApplication.prototype, 'applyLinkIntent').mockImplementationOnce(function (this: KnowledgeLibraryApplication, ...args) { original.apply(this, args); throw new Error('lost acknowledgement'); });
    } else {
      const base = new FileEntityLinkStore(join(root, 'entity-links'), root); let fail = true;
      const store: EntityLinkStore = { list: () => base.list(), read: id => base.read(id),
        transaction: operation => base.transaction(transaction => operation({ ...transaction, append: (id, generation, events) => {
          if (fail && events.at(-1)?.eventKind === 'applied') { fail = false; throw new Error('lost acknowledgement'); }
          return transaction.append(id, generation, events);
        } })) };
      application = new EntityLinkApplication(app(), new FileEntityAnalysisStore(join(root, 'entities'), root), store, new FileLibraryStore(join(root, 'library'), root));
    }
    expect(() => application.decide({ reviewId: command.reviewId, requestId: randomUUID(), expectedGeneration: 1, decision: 'accept', reason: '核对两侧来源的同一对象', identityConfirmed: true })).toThrow('lost acknowledgement');
    const pending = links().read(command.reviewId); expect(pending.events.map(event => event.eventKind)).toEqual(['recorded', 'reviewed']);
    expect(library().catalog().objectCount).toBe(1);
    const entities = structuredClone(a.analysis.revision.entities); entities[0].label = '后续来源修订';
    app().correctEntities(a.run.runId, a.analysis.revision.revisionId, 1, { entities, mentions: a.analysis.revision.mentions }, '修订不推翻已提交回执');
    const recovered = links().resume(command.reviewId);
    expect(recovered.events.at(-1)?.eventKind).toBe('applied'); expect(recovered.events.slice(0, 2)).toEqual(pending.events);
    expect(library().detail(library().catalog().rows[0].objectId).history.generation).toBe(failure === 'library_ack_at_history_limit' ? 256 : 1);
    expect(existsSync(join(root, '.knowledge-write.lock'))).toBe(false);
  });
  it('validates both unchanged owner anchors inside the publication lock and records stale or unavailable sources as conflicts', async () => {
    const a = await window('a'), b = await window('b'); const owner = library().save(initial(draft([a.member()])));
    const command = capture(links().preview(reference(a), reference(b))); links().record(command);
    vi.spyOn(KnowledgeLibraryApplication.prototype, 'applyLinkIntent').mockImplementationOnce(() => { throw new Error('interrupted before publication'); });
    expect(() => accept(command.reviewId)).toThrow('interrupted');
    const entities = structuredClone(a.analysis.revision.entities); entities[0].label = '新的所指限定';
    app().correctEntities(a.run.runId, a.analysis.revision.revisionId, 1, { entities, mentions: a.analysis.revision.mentions }, '修改原有 owner 的相同成员');
    const conflict = links().resume(command.reviewId);
    expect(conflict.events.at(-1)).toMatchObject({ eventKind: 'conflict', conflictCode: 'entity_changed' });
    expect(library().detail(owner.objectId).history.generation).toBe(1);
    const c = await window('c'), d = await window('d'); const other = capture(links().preview(reference(c), reference(d))); links().record(other); app().deleteSource(c.source.snapshotId);
    expect(accept(other.reviewId).events.at(-1)).toMatchObject({ eventKind: 'conflict', conflictCode: 'source_unavailable' });
  });
  it('records owner changes after model capture as conflicts and refuses known competing owners before preview', async () => {
    const a = await window('a'), b = await window('b'); const command = capture(links().preview(reference(a), reference(b))); links().record(command);
    vi.spyOn(KnowledgeLibraryApplication.prototype, 'applyLinkIntent').mockImplementationOnce(() => { throw new Error('pause before owner validation'); });
    expect(() => accept(command.reviewId)).toThrow('pause before owner validation');
    const first = library().save(initial(draft([a.member()]))), second = library().save(initial(draft([b.member()])));
    expect(() => links().preview(reference(a), reference(b))).toThrow('already reviewed');
    const decided = links().resume(command.reviewId);
    expect(decided.events.at(-1)).toMatchObject({ eventKind: 'conflict', conflictCode: 'owner_conflict' });
    expect(() => links().preview(reference(a), reference(b))).toThrow('owner_conflict');
    expect(library().detail(first.objectId).history.generation).toBe(1); expect(library().detail(second.objectId).history.generation).toBe(1);
  });
  it('retains invalid raw responses for rejection and fails closed for corrupt, unsupported or redirected review storage', async () => {
    const a = await window('a'), b = await window('b'); const command = capture(links().preview(reference(a), reference(b))); command.evidence.rawOutput = 'not json';
    const review = links().record(command); expect(review.suggestion).toEqual({ status: 'invalid', errorCode: 'invalid_response' });
    expect(() => accept(command.reviewId)).toThrow('cannot be accepted');
    const file = join(root, 'entity-links', `${command.reviewId}.json`), bytes = readFileSync(file); writeFileSync(file, '{bad');
    expect(() => links().list()).toThrow(); expect(() => links().recall(reference(a))).toThrow(); writeFileSync(file, bytes);
    const unsupported = { ...review, schemaVersion: 9 }; writeFileSync(file, JSON.stringify(unsupported)); expect(() => links().read(command.reviewId)).toThrow('knowledge_storage_unsupported'); writeFileSync(file, bytes);
    const rejected = links().decide({ reviewId: command.reviewId, requestId: randomUUID(), expectedGeneration: 1, decision: 'reject', reason: '原始建议格式不可采纳' });
    expect(rejected.capture.evidence.rawOutput).toBe('not json');
    const tampered = structuredClone(rejected); tampered.events[1].commandDigest = `sha256:${'b'.repeat(64)}`; expect(() => validateEntityLinkReview(tampered, entityLinkDigest)).toThrow('digest mismatch');
    rmSync(join(root, 'entity-links'), { recursive: true }); symlinkSync(join(root, 'entities'), join(root, 'entity-links')); expect(() => links().list()).toThrow('storage directory');
  });
  it('rejects escaped transaction writes after releasing the shared workspace lock', async () => {
    const a = await window('a'), b = await window('b'); const review = links().record(capture(links().preview(reference(a), reference(b))));
    expect(() => new EntityLinkApplication(app(), new FileEntityAnalysisStore(join(root, 'entities'), root),
      new FileEntityLinkStore(join(root, 'entity-links'), root), new FileLibraryStore(join(root, 'library'), root),
      { actorKind: 'agent', actorId: 'fixture-agent', executionRef: 'fixture-run' })).toThrow('explicit human');
    let escaped!: EntityLinkTransaction;
    new FileEntityLinkStore(join(root, 'entity-links'), root).transaction(transaction => { escaped = transaction; });
    expect(() => escaped.append(review.capture.reviewId, 1, [])).toThrow('expired');
    const object = library().save(initial(draft([a.member()]))); const write = { requestId: randomUUID(), objectId: object.objectId, expectedGeneration: 1, expectedHeadRevisionId: object.writeHeadRevisionId,
      revision: { ...object.revisions[0], revisionId: randomUUID(), parentRevisionId: object.writeHeadRevisionId, draft: { ...object.revisions[0].draft, description: '明确更新描述' } } };
    expect(() => escaped.library.write(write, () => {})).toThrow('expired');
    let escapedLibrary!: Parameters<Parameters<FileLibraryStore['transaction']>[0]>[0];
    new FileLibraryStore(join(root, 'library'), root).transaction(value => { escapedLibrary = value; });
    expect(() => escapedLibrary.write(write, () => {})).toThrow('expired'); expect(existsSync(join(root, '.knowledge-write.lock'))).toBe(false);
  });

  it('archives stale and concurrent captures without allowing them to bypass revision conflicts or a rejection', async () => {
    const a = await window('a'), b = await window('b');
    const first = capture(links().preview(reference(a), reference(b))), second = capture(links().preview(reference(a), reference(b)));
    const entities = structuredClone(a.analysis.revision.entities); entities[0].description = '后续明确的所指限定';
    app().correctEntities(a.run.runId, a.analysis.revision.revisionId, 1, { entities, mentions: a.analysis.revision.mentions }, '模型返回之前更正');
    app().deleteSource(b.source.snapshotId);
    const one = links().record(first), two = links().record(second);
    expect(one.duplicateOf).toBe(null); expect(two.duplicateOf).toBe(one.capture.reviewId);
    expect(links().read(first.reviewId).capture).toEqual(first); expect(links().read(second.reviewId).capture).toEqual(second);
    expect(accept(first.reviewId).events.at(-1)).toMatchObject({ eventKind: 'conflict', conflictCode: 'entity_changed' });
    expect(accept(second.reviewId).events.at(-1)).toMatchObject({ eventKind: 'conflict', conflictCode: 'pair_already_reviewed' });
    expect(library().catalog().objectCount).toBe(0);
    const c = await window('c'), d = await window('d'); const rejectedCommand = capture(links().preview(reference(c), reference(d)));
    const late = capture(links().preview(reference(c), reference(d))); links().record(rejectedCommand);
    links().decide({ reviewId: rejectedCommand.reviewId, requestId: randomUUID(), expectedGeneration: 1, decision: 'reject', reason: '来源没有证明同一对象' });
    expect(links().record(late).duplicateOf).toBe(rejectedCommand.reviewId);
    expect(accept(late.reviewId).events.at(-1)).toMatchObject({ eventKind: 'conflict', conflictCode: 'pair_already_reviewed' });
    expect(links().read(late.reviewId).capture.evidence.rawOutput).toBe(late.evidence.rawOutput);
  });
  it('lets a human name a new organization when the complete entity label exceeds the library limit', async () => {
    const a = await window('a'), b = await window('b'); const entities = structuredClone(a.analysis.revision.entities); entities[0].label = 'A'.repeat(257);
    const current = app().correctEntities(a.run.runId, a.analysis.revision.revisionId, 1, { entities, mentions: a.analysis.revision.mentions }, '保留完整来源名称');
    const before = readFileSync(join(root, 'entities', `${a.run.runId}.json`)); const command = capture(links().preview(reference(a), reference(b))); links().record(command);
    expect(() => accept(command.reviewId)).toThrow('explicit organization label'); expect(links().read(command.reviewId).generation).toBe(1);
    const applied = links().decide({ reviewId: command.reviewId, requestId: randomUUID(), expectedGeneration: 1, decision: 'accept', reason: '人工核对完整名称及两侧所指', identityConfirmed: true, objectLabel: '项目 Alpha' });
    expect(applied.events.at(-1)?.eventKind).toBe('applied'); expect(library().catalog().rows[0].label).toBe('项目 Alpha');
    expect(app().entities(a.run.runId).revision).toEqual(current.revision); expect(readFileSync(join(root, 'entities', `${a.run.runId}.json`))).toEqual(before);
    expect(app().detail(a.knowledge.revision.knowledgeId).revision).toEqual(a.knowledge.revision);
  });

  it('adds one unowned entity to its pinned owner and preserves unrelated existing organization members', async () => {
    const a = await window('a'), b = await window('b'), c = await window('c');
    const owner = library().save(initial(draft([a.member(), c.member()], '人工维护的项目入口')));
    const command = capture(links().preview(reference(a), reference(b))); links().record(command); const applied = accept(command.reviewId);
    expect(applied.events.at(-1)?.eventKind).toBe('applied'); const saved = library().detail(owner.objectId).history;
    expect(library().catalog().objectCount).toBe(1); expect(saved.generation).toBe(2);
    expect(saved.revisions[0]).toEqual(owner.revisions[0]); expect(saved.revisions[1].draft.label).toBe('人工维护的项目入口');
    expect(saved.revisions[1].draft.members.find(member => member.entityId === c.member().entityId)).toEqual(c.member());
    expect(saved.revisions[1].draft.members.map(member => member.entityId).sort()).toEqual([a.member().entityId, b.member().entityId, c.member().entityId].sort());
  });

  it('terminates an incompatible fixed owner kind both before intent and when recovering a previously prepared intent', async () => {
    const a = await window('a'), b = await window('b', packet => { packet.entities[0].referentKind = 'activity'; });
    const owner = library().save(initial(draft([a.member()])));
    const entities = structuredClone(a.analysis.revision.entities); entities[0].referentKind = 'activity';
    app().correctEntities(a.run.runId, a.analysis.revision.revisionId, 1, { entities, mentions: a.analysis.revision.mentions }, '改为原文所指的活动');
    const command = capture(links().preview(reference(a), reference(b))); links().record(command);
    expect(accept(command.reviewId).events.at(-1)).toMatchObject({ eventKind: 'conflict', conflictCode: 'identity_unresolved' });
    const legacy = capture(links().preview(reference(a), reference(b))); links().record(legacy);
    const actor = { actorKind: 'human' as const, actorId: 'local-user' }, reason = '旧版本已保存的待应用同一活动决定';
    const decision = { reviewId: legacy.reviewId, requestId: randomUUID(), decision: 'accept' as const, reason, objectLabel: null, actor };
    const intent = { requestId: randomUUID(), objectId: owner.objectId, expectedGeneration: owner.generation, expectedHeadRevisionId: owner.writeHeadRevisionId,
      revision: { revisionId: randomUUID(), parentRevisionId: owner.writeHeadRevisionId, revisedAt: new Date().toISOString(), revisedBy: actor, reason,
        draft: { ...owner.revisions[0].draft, referentKind: 'activity' as const, members: [legacy.left, legacy.right].map(endpoint => ({ analysisId: endpoint.analysisId, entityId: endpoint.entityId,
          entityRevisionId: endpoint.entityRevisionId, mentionIds: endpoint.mentionIds, rationale: reason })) } } };
    new FileEntityLinkStore(join(root, 'entity-links'), root).transaction(transaction => transaction.append(legacy.reviewId, 1, [{ eventKind: 'reviewed', eventId: randomUUID(), requestId: decision.requestId,
      commandDigest: entityLinkDigest(decision), at: new Date().toISOString(), actor, decision: 'accept', reason, objectLabel: null, applicationIntent: intent }]));
    const recovered = links().resume(legacy.reviewId); expect(recovered.events.at(-1)).toMatchObject({ eventKind: 'conflict', conflictCode: 'identity_unresolved' });
    expect(library().detail(owner.objectId).history).toEqual(owner); expect(links().resume(legacy.reviewId)).toEqual(recovered);
  });
  it('records history capacity as a terminal prepublication conflict and still resolves an existing receipt at the 256-revision limit', async () => {
    const a = await window('a'), b = await window('b'); const input = initial(draft([a.member()])); const owner = library().save(input);
    const full = historyAt(owner, 256); const file = join(root, 'library', `${owner.objectId}.json`); writeFileSync(file, JSON.stringify(full, null, 2));
    expect(library().save(input)).toEqual(full);
    const command = capture(links().preview(reference(a), reference(b))); links().record(command);
    const conflict = accept(command.reviewId); expect(conflict.events.at(-1)).toMatchObject({ eventKind: 'conflict', conflictCode: 'library_capacity' });
    expect(conflict.events[1]).toMatchObject({ eventKind: 'reviewed', decision: 'accept', applicationIntent: expect.any(Object) });
    expect(library().detail(owner.objectId).history).toEqual(full); expect(links().resume(command.reviewId)).toEqual(conflict);
  });
  it.each(['file', 'workspace'] as const)('terminates only known %s write capacity rejection before library publication', async scope => {
    const a = await window('a'), b = await window('b'); const owner = library().save(initial(draft([a.member()])));
    const heavy = draft([a.member(), ...Array.from({ length: 253 }, (): LibraryMember => ({ analysisId: randomUUID(), entityId: randomUUID(), entityRevisionId: randomUUID(),
      mentionIds: [randomUUID()], rationale: '界'.repeat(4096) }))]);
    const current = historyAt(owner, scope === 'file' ? 2 : 1, heavy), file = join(root, 'library', `${owner.objectId}.json`);
    writeFileSync(file, JSON.stringify(current, null, 2));
    if (scope === 'workspace') {
      const others = Array.from({ length: 10 }, () => { const alternate = { ...heavy, members: heavy.members.map(member => ({ ...member, analysisId: randomUUID(), entityId: randomUUID(), rationale: '界'.repeat(4000) })) };
        return { ...historyAt(owner, 2, alternate), objectId: randomUUID() }; });
      const all = [current, ...others];
      expect(all.reduce((sum, history) => sum + Buffer.byteLength(JSON.stringify(history, null, 2)), 0)).toBeLessThan(64 * 1024 * 1024);
      vi.spyOn(FileLibraryStore.prototype, 'list').mockImplementation(() => all);
    }
    const command = capture(links().preview(reference(a), reference(b))); links().record(command);
    const conflict = accept(command.reviewId); expect(conflict.events.at(-1)).toMatchObject({ eventKind: 'conflict', conflictCode: 'library_capacity' });
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(current, null, 2));
    expect(links().resume(command.reviewId)).toEqual(conflict); expect(existsSync(join(root, '.knowledge-write.lock'))).toBe(false);
  });
  it('keeps unreadable library capacity and unknown acknowledgement failures pending rather than inventing a capacity rejection', async () => {
    const a = await window('a'), b = await window('b'); const command = capture(links().preview(reference(a), reference(b))); links().record(command);
    vi.spyOn(KnowledgeLibraryApplication.prototype, 'applyLinkIntent').mockImplementationOnce(() => { throw new Error('pause before publication'); });
    expect(() => accept(command.reviewId)).toThrow('pause before publication');
    vi.spyOn(FileLibraryStore.prototype, 'list').mockImplementationOnce(() => { throw new Error('Library capacity exceeded.'); });
    expect(() => links().resume(command.reviewId)).toThrow('Library capacity exceeded.'); expect(links().read(command.reviewId).generation).toBe(2);
    expect(links().resume(command.reviewId).events.at(-1)?.eventKind).toBe('applied');
  });

  it('rejects review intent capacity before persisting a decision or publishing library changes', async () => {
    const a = await window('a'), b = await window('b'); const owner = library().save(initial(draft([a.member()])));
    const heavy = draft([a.member(), ...Array.from({ length: 253 }, (): LibraryMember => ({ analysisId: randomUUID(), entityId: randomUUID(), entityRevisionId: randomUUID(),
      mentionIds: Array.from({ length: 64 }, () => randomUUID()), rationale: '界'.repeat(4096) }))]);
    const current = historyAt(owner, 1, heavy), file = join(root, 'library', `${owner.objectId}.json`); writeFileSync(file, JSON.stringify(current, null, 2));
    const command = capture(links().preview(reference(a), reference(b))); command.evidence.rawOutput += ' '.repeat(500 * 1024);
    links().record(command); expect(() => accept(command.reviewId)).toThrow('Entity-link capacity exceeded.');
    expect(links().read(command.reviewId).events.map(event => event.eventKind)).toEqual(['recorded']);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(current, null, 2)); expect(existsSync(join(root, '.knowledge-write.lock'))).toBe(false);
  });

});
