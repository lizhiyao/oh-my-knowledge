import { executeKnowledgeCandidateAction } from '../../src/studio/application/knowledge/knowledge-candidates.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeApplication, type ExtractionModel } from '../../src/observability/knowledge-extraction/application.js';
import { TraceEvidenceStore } from '../../src/observability/knowledge-extraction/adapters/trace-evidence.js';
import { FileKnowledgeStore } from '../../src/observability/knowledge-extraction/adapters/knowledge-store.js';
import { FileExtractionRunStore } from '../../src/observability/knowledge-extraction/adapters/run-store.js';
import { FileKnowledgeTags } from '../../src/observability/knowledge-extraction/adapters/knowledge-tags.js';
import { FileEntityAnalysisStore } from '../../src/observability/knowledge-extraction/adapters/entity-store.js';
import { configuredExtractionModel } from '../../src/observability/knowledge-extraction/adapters/executor.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { identityWindow, modelWindow } from './fixtures.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(text = 'Alpha 使用 Beta') {
  const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-app-')); roots.push(root);
  const source = join(root, 'log.jsonl');
  writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'test');
  const runs = new FileExtractionRunStore(join(root, 'runs'));
  const evidence = new TraceEvidenceStore(join(root, 'sources'));
  const ports = {
    evidence, knowledge, runs, tags: new FileKnowledgeTags(join(root, 'tags'), 'test'), id: randomUUID, now: () => '2026-09-14T00:00:00Z',
    entities: new FileEntityAnalysisStore(join(root, 'entities')),
    hash: (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex'),
    actor: { actorKind: 'human' as const, actorId: 'tester' },
  };
  const app = new KnowledgeApplication(ports);
  const snapshot = app.capture({ path: source });
  const generate = vi.fn(async (_system: string, input: string) => {
    const data = JSON.parse(input);
    const ref = data.excerpts.find((entry: { text: string }) => entry.text === text).evidenceRef;
    return { output: JSON.stringify(modelWindow()).replaceAll('record-1', ref), durationMs: 5 };
  });
  const model: ExtractionModel = { executor: 'fake', model: 'test-model', generate };
  return { app, snapshot, knowledge, runs, evidence, model, generate, ports, source, root };
}

describe('shared knowledge application', () => {
  it('uses one window identity for entities and mentions across candidates', async () => {
    const { app, snapshot, model, generate } = setup();
    model.generate = async (_system, input) => {
      const packet = modelWindow(); packet.proposals.push({ ...packet.proposals[0], proposalId: 'candidate-2' });
      return { output: JSON.stringify(packet).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 5 };
    };
    const run = await app.generate(snapshot.snapshotId, model);
    expect(run.committed).toHaveLength(2);
    const first = app.detail(run.committed[0].knowledgeId); const second = app.detail(run.committed[1].knowledgeId);
    expect(first.revision.entities).toEqual(second.revision.entities);
    expect(first.grounding.mentions).toEqual(second.grounding.mentions);
    expect(first.grounding.entityAnalysisRef).toEqual(second.grounding.entityAnalysisRef);
    expect(app.entities(run.runId).revision.entities.map(entity => entity.entityId)).toEqual(first.revision.entities.map(entity => entity.entityId));
    expect(generate).not.toHaveBeenCalled();
  });
  it('saves independent entities when there are no knowledge candidates or one entity was rejected', async () => {
    const { app, snapshot, model } = setup();
    const packet = modelWindow(); packet.proposals = [];
    model.generate = async (_system, input) => ({ output: JSON.stringify(packet).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 1 });
    const entitiesOnly = await app.generate(snapshot.snapshotId, model);
    expect(entitiesOnly.committed).toEqual([]);
    expect(app.entities(entitiesOnly.runId).revision.entities).toHaveLength(2);
    packet.proposals = modelWindow().proposals; packet.mentions[1].selection.quote = 'invented';
    const partial = await app.generate(snapshot.snapshotId, model);
    expect(partial.status).toBe('completed'); expect(partial.committed).toEqual([]);
    expect(partial.entityRejections).toHaveLength(2);
    expect(partial.rejections[0].reasons).toContain('unknown_entity_analysis_reference');
    expect(app.entities(partial.runId).revision.entities).toHaveLength(1);
    const summary = await executeKnowledgeCandidateAction({ operation: 'runs', workspace: 'fixture' }, undefined, () => app);
    expect(summary).toEqual(expect.arrayContaining([expect.objectContaining({ runId: entitiesOnly.runId,
      committed: [], entityAnalysis: expect.objectContaining({ entityCount: 2, mentionCount: 2, rejectedCount: 0 }) })]));
    expect(JSON.stringify(summary)).not.toContain('rawOutput');
  });
  it('searches source-window entities without merging names, including entities with no knowledge', async () => {
    const { app, model, source } = setup();
    const first = app.capture({ path: source, origin: { threadId: 'first', title: 'A 项目', cwd: '/a' } });
    const second = app.capture({ path: source, origin: { threadId: 'second', title: 'B 项目', cwd: '/b' } });
    const packet = modelWindow(); packet.proposals = [];
    model.generate = async (_system, input) => ({ output: JSON.stringify(packet).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 1 });
    const firstRun = await app.generate(first.snapshotId, model); await app.generate(second.snapshotId, model);
    const matches = app.queryEntities({ query: 'Alpha', pageSize: 1 });
    expect(matches).toMatchObject({ total: 2, page: 1, entityCount: 4, analysisCount: 2, unavailableAnalyses: 0 });
    expect(matches.rows[0].knowledgeCount).toBe(0);
    expect(matches.rows[0]).not.toHaveProperty('surfaces');
    const next = app.queryEntities({ query: 'Alpha', page: 999, pageSize: 1 }); expect(next.page).toBe(2);
    expect(next.rows[0].entityId).not.toBe(matches.rows[0].entityId);
    const scoped = app.queryEntities({ threadId: 'first' }); expect(scoped.rows).toHaveLength(2);
    expect(scoped.rows.every(row => row.analysisId === firstRun.runId)).toBe(true);
    app.deleteSource(first.snapshotId);
    expect(app.queryEntities({ sourceStatus: 'unavailable', threadId: 'first' }).rows).toHaveLength(2);
    expect(() => app.queryEntities({ pageSize: 101 })).toThrow();
  });
  it('links current knowledge with actual bound entity revisions and reports corrupt storage without false zeroes', async () => {
    const { app, model, snapshot, root, knowledge } = setup(); const run = await app.generate(snapshot.snapshotId, model);
    const before = app.entities(run.runId); const entityId = before.revision.entities[0].entityId;
    expect(app.entityDetail(run.runId, entityId).knowledge[0]).toMatchObject({ currentEntityRevision: true, roles: [{ role: 'subject', relation: '使用' }] });
    expect(app.entityDetail(run.runId, entityId).mentionChecks[0].positionStatus).toBe('matched');
    const edit = structuredClone({ entities: before.revision.entities, mentions: before.revision.mentions }); edit.entities[0].label = 'Alpha 新名称';
    const corrected = app.correctEntities(run.runId, before.revision.revisionId, 1, edit, '纠正名称');
    const current = app.entityDetail(run.runId, entityId);
    expect(current.entity.label).toBe('Alpha 新名称');
    expect(current.knowledge[0]).toMatchObject({ entityRevisionId: before.revision.revisionId, currentEntityRevision: false });
    expect(app.entityDetail(run.runId, entityId, before.revision.revisionId).entity.label).toBe('Alpha');
    expect(app.queryEntities({ query: 'Alpha 新名称' }).rows[0].outdatedKnowledgeCount).toBe(1);
    expect(app.detail(run.committed[0].knowledgeId).grounding.entityAnalysisRef?.revisionId).not.toBe(corrected.revision.revisionId);
    const badFile = join(root, 'entities', `${randomUUID()}.json`); const badBytes = '{broken'; writeFileSync(badFile, badBytes);
    expect(app.queryEntities()).toMatchObject({ total: 2, unavailableAnalyses: 1 }); expect(readFileSync(badFile, 'utf8')).toBe(badBytes);
    symlinkSync(join(root, 'entities', `${run.runId}.json`), join(root, 'entities', `${randomUUID()}.json`));
    expect(app.queryEntities()).toMatchObject({ total: 2, unavailableAnalyses: 2 });
    const read = vi.spyOn(knowledge, 'list').mockImplementation(() => { throw new Error('private-path'); });
    expect(app.queryEntities().rows.every(row => row.knowledgeCount === null)).toBe(true);
    expect(app.entityDetail(run.runId, entityId)).toMatchObject({ knowledgeStatus: 'unavailable', knowledge: [] }); read.mockRestore();
  });
  it('recovers a lost entity commit acknowledgement with the same birth intent and no second model call', async () => {
    const { app, snapshot, model, ports, generate, runs } = setup('Alpha 使用 Beta；它们共同失败。');
    generate.mockImplementation(async (_system, input) => ({ output: JSON.stringify(identityWindow()).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 5 }));
    const original = ports.entities.write.bind(ports.entities);
    const write = vi.spyOn(ports.entities, 'write').mockImplementationOnce((command, actor) => {
      original(command, actor); throw new Error('lost entity acknowledgement');
    });
    const runId = randomUUID();
    await expect(app.generate(snapshot.snapshotId, model, runId)).rejects.toThrow('acknowledgement');
    const prepared = runs.read(runId);
    expect(prepared.status).toBe('prepared');
    write.mockRestore(); expect(app.resume(runId).status).toBe('completed');
    expect(app.entities(runId).history.generation).toBe(1);
    expect(app.entities(runId).revision.revisionId).toBe(prepared.entityAnalysis!.revision.revisionId);
    const analysis = app.entities(runId);
    expect(analysis.history.schemaVersion).toBe(2);
    expect(prepared).toMatchObject({ schemaVersion: 4, promptVersion: 'knowledge-extraction-v4' });
    const [component, instance, group] = analysis.revision.entities;
    const [, instanceMention, groupMention] = analysis.revision.mentions;
    expect(instance.componentRef).toMatchObject({ entityId: component.entityId, mentionIds: [instanceMention.mentionId] });
    expect(group.collection).toMatchObject({ memberEntityIds: [component.entityId, instance.entityId], mentionIds: [groupMention.mentionId] });
    expect(instance.entityId).not.toBe('tool');
    expect(analysis.revision).toEqual(prepared.entityAnalysis!.revision);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('maps new correction links together and rejects broken references without changing old bindings', async () => {
    const { app, snapshot, model } = setup('Alpha 使用 Beta；它们共同失败。');
    model.generate = async (_system, input) => ({ output: JSON.stringify(identityWindow()).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 1 });
    const run = await app.generate(snapshot.snapshotId, model); const before = app.entities(run.runId);
    const edit = structuredClone({ entities: before.revision.entities, mentions: before.revision.mentions });
    edit.entities[0].entityId = 'new:component'; edit.mentions[0].entityId = 'new:component';
    edit.mentions[0].mentionId = 'new:mention';
    edit.entities[1].componentRef!.entityId = 'new:component';
    edit.entities[1].componentRef!.mentionIds.push('new:mention');
    edit.entities[2].collection!.memberEntityIds[0] = 'new:component';
    const after = app.correctEntities(run.runId, before.revision.revisionId, 1, edit, '显式替换对象身份及依据');
    expect(after.revision.entities[0].entityId).not.toBe(before.revision.entities[0].entityId);
    expect(after.revision.entities[1].componentRef).toMatchObject({ entityId: after.revision.entities[0].entityId,
      mentionIds: [after.revision.mentions[1].mentionId, after.revision.mentions[0].mentionId] });
    expect(after.revision.entities[2].collection!.memberEntityIds[0]).toBe(after.revision.entities[0].entityId);
    expect(app.entities(run.runId, before.revision.revisionId).revision).toEqual(before.revision);
    expect(app.detail(run.committed[0].knowledgeId).grounding.entityAnalysisRef!.revisionId).toBe(before.revision.revisionId);
    const invalid = structuredClone({ entities: after.revision.entities, mentions: after.revision.mentions });
    invalid.entities[1].componentRef!.mentionIds = ['new:absent'];
    expect(() => app.correctEntities(run.runId, after.revision.revisionId, 2, invalid, '无依据')).toThrow('mapping');
    invalid.entities[1].componentRef!.mentionIds = [after.revision.mentions[1].mentionId];
    invalid.entities[0].referentKind = 'object';
    expect(() => app.correctEntities(run.runId, after.revision.revisionId, 2, invalid, '改变关联目标层次')).toThrow('invalid_component_target');
    expect(app.entities(run.runId).history.generation).toBe(2);
  });
  it('rejects old entity and run files without rewriting them while keeping knowledge bodies readable', async () => {
    const { app, snapshot, model, root, runs } = setup(); const run = await app.generate(snapshot.snapshotId, model);
    const entityPath = join(root, 'entities', `${run.runId}.json`); const runPath = join(root, 'runs', `${run.runId}.json`);
    const oldEntity = JSON.parse(readFileSync(entityPath, 'utf8')); oldEntity.schemaVersion = 1;
    for (const entity of oldEntity.revisions[0].entities) { delete entity.referentKind; delete entity.componentRef; delete entity.collection; }
    const oldRun = { ...run, schemaVersion: 3, promptVersion: 'knowledge-extraction-v3' };
    const entityBytes = JSON.stringify(oldEntity); const runBytes = JSON.stringify(oldRun);
    writeFileSync(entityPath, entityBytes); writeFileSync(runPath, runBytes);
    expect(() => runs.read(run.runId)).toThrow('knowledge_storage_unsupported');
    expect(() => app.resume(run.runId)).toThrow('knowledge_storage_unsupported');
    expect(() => app.entities(run.runId)).toThrow();
    expect(app.queryEntities()).toMatchObject({ total: 0, unavailableAnalyses: 1 });
    expect(app.detail(run.committed[0].knowledgeId).revision.title).toBe('项目 Alpha 使用工具 Beta');
    expect(readFileSync(entityPath, 'utf8')).toBe(entityBytes); expect(readFileSync(runPath, 'utf8')).toBe(runBytes);
  });
  it('rejects stale corrections, foreign identities and changed evidence without altering saved knowledge', async () => {
    const { app, snapshot, model } = setup(); const run = await app.generate(snapshot.snapshotId, model);
    const analysis = app.entities(run.runId);
    const edit = structuredClone({ entities: analysis.revision.entities, mentions: analysis.revision.mentions });
    edit.entities[0].label = '新名称';
    app.correctEntities(run.runId, analysis.revision.revisionId, 1, edit, '核对名称');
    expect(() => app.correctEntities(run.runId, analysis.revision.revisionId, 1, edit, '过期修改')).toThrow('conflict');
    const latest = app.entities(run.runId);
    edit.entities[0].entityId = randomUUID();
    expect(() => app.correctEntities(run.runId, latest.revision.revisionId, 2, edit, '外部身份')).toThrow('Unknown correction identity');
    edit.entities[0].entityId = latest.revision.entities[0].entityId;
    edit.mentions[0].selection.quote = 'invented';
    expect(() => app.correctEntities(run.runId, latest.revision.revisionId, 2, edit, '虚构来源')).toThrow('correction');
    expect(app.detail(run.committed[0].knowledgeId).revision.entities[0].label).toBe('Alpha');
    expect(app.entities(run.runId).history.generation).toBe(2);
  });
  it.each(['binding', 'mention', 'label', 'author', 'unresolved', 'committed', 'component', 'collection'] as const)('rejects corrupted %s in a prepared run before committing any knowledge', async target => {
    const { app, snapshot, model, ports, knowledge, runs, root } = setup();
    const write = vi.spyOn(ports.entities, 'write').mockImplementationOnce(() => { throw new Error('stop before entity commit'); });
    const runId = randomUUID(); await expect(app.generate(snapshot.snapshotId, model, runId)).rejects.toThrow('stop before');
    write.mockRestore(); const prepared = runs.read(runId);
    const path = join(root, 'runs', `${runId}.json`);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    if (target === 'binding') stored.intents[0].grounding.entityAnalysisRef.revisionId = randomUUID();
    if (target === 'mention') stored.intents[0].grounding.mentions[0].selection.quote = 'Beta';
    if (target === 'label') stored.intents[0].revision.entities[0].label = 'different object';
    if (target === 'author') stored.entityAnalysis.revision.revisedBy.executionRef = randomUUID();
    if (target === 'unresolved') stored.entityAnalysis.revision.entities[0].possibleEntityIds = [randomUUID()];
    if (target === 'component') { stored.entityAnalysis.revision.entities[0].referentKind = 'instance'; stored.entityAnalysis.revision.entities[0].componentRef = { entityId: randomUUID(), mentionIds: [stored.entityAnalysis.revision.mentions[0].mentionId], rationale: '不存在的组件' }; }
    if (target === 'collection') { stored.entityAnalysis.revision.entities[0].referentKind = 'collection'; stored.entityAnalysis.revision.entities[0].collection = { memberEntityIds: [stored.entityAnalysis.revision.entities[0].entityId], completeness: 'complete', mentionIds: [stored.entityAnalysis.revision.mentions[0].mentionId], rationale: '循环成员' }; }
    if (target === 'committed') { stored.status = 'completed'; stored.committed = []; }
    writeFileSync(path, JSON.stringify(stored));
    expect(() => app.resume(runId)).toThrow(); expect(knowledge.list()).toEqual([]);
    expect(() => ports.entities.read(runId)).toThrow();
    writeFileSync(path, JSON.stringify(prepared)); expect(app.resume(runId).status).toBe('completed');
  });
  it('projects entity inspection and correction without raw envelopes or native source paths', async () => {
    const { app, snapshot, model, source } = setup(); const run = await app.generate(snapshot.snapshotId, model);
    const execute = (fields: Record<string, unknown>) => executeKnowledgeCandidateAction({ workspace: 'fixture', ...fields }, undefined, () => app);
    const detail = await execute({ operation: 'entities', analysisId: run.runId });
    expect(detail).toMatchObject({ revision: { entities: [{ label: 'Alpha' }, { label: 'Beta' }] }, source: { status: 'available', excerpts: snapshot.excerpts } });
    expect(JSON.stringify(detail)).not.toContain(source); expect(JSON.stringify(detail)).not.toContain('records');
    const current = app.entities(run.runId);
    const edit = { entities: structuredClone(current.revision.entities), mentions: current.revision.mentions };
    edit.entities[0].label = '项目 Alpha';
    const corrected = await execute({ operation: 'correct-entities', analysisId: run.runId, revision: current.revision.revisionId,
      generation: 1, draft: edit, reason: '核对名称' });
    expect(corrected).toMatchObject({ history: { generation: 2 } }); expect(JSON.stringify(corrected)).not.toContain(source);
  });
  it('allows explicitly reviewed uncertainty notes to change while preserving current entity ambiguity and old grounding', async () => {
    const { app, snapshot, model } = setup(); const packet = modelWindow();
    packet.entities[0].uncertainties = ['旧的身份待核对']; packet.proposals[0].identityUncertainties = ['补充的身份说明'];
    model.generate = async (_prompt, input) => ({ output: JSON.stringify(packet).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 1 });
    const run = await app.generate(snapshot.snapshotId, model); const before = app.detail(run.committed[0].knowledgeId);
    const analysis = app.entities(run.runId); const edit = structuredClone({ entities: analysis.revision.entities, mentions: analysis.revision.mentions });
    edit.entities[0].uncertainties = ['当前仍有的身份限制'];
    const corrected = app.correctEntities(run.runId, analysis.revision.revisionId, 1, edit, '核对原文');
    const draft = { title: before.revision.title, entities: before.revision.entities, content: before.revision.content, evidence: before.revision.evidence };
    const reviewed = app.reviseUsingEntities(before.revision.knowledgeId, before.revision.revisionId, 1, run.runId, corrected.revision.revisionId, draft, '逐项核对后移除旧说明', []);
    expect(reviewed.grounding.identityUncertainties).toEqual(['当前仍有的身份限制']);
    expect(reviewed.history.grounding[0]).toEqual(before.grounding);
  });
  it('preserves output and usage when cancellation arrives after generation and resumes without regenerating', async () => {
    const { app, snapshot, model, generate } = setup(); const controller = new AbortController();
    const runtime = configuredExtractionModel('codex', 'fixture', async input => {
      const result = await model.generate(input.system ?? '', input.prompt); controller.abort();
      return { ...result, ok: true, durationApiMs: 5, inputTokens: 7, outputTokens: 9, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUSD: 0, costReportedByExecutor: false, stopReason: 'end_turn', numTurns: 1 };
    });
    const cancelled = await app.generate(snapshot.snapshotId, runtime, randomUUID(), controller.signal);
    expect(cancelled).toMatchObject({ status: 'cancelled', runtime: { durationMs: 5, inputTokens: 7, outputTokens: 9 } });
    expect(cancelled.runtime).not.toHaveProperty('costUSD');
    expect(cancelled.rawOutput).toBeTruthy();
    const completed = app.resume(cancelled.runId);
    expect(completed.status).toBe('completed'); expect(completed.error).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('stores topic tags through the shared Studio action without changing claims, decisions or generation calls', async () => {
    const { app, snapshot, model, generate } = setup();
    const run = await app.generate(snapshot.snapshotId, model);
    const id = run.committed[0].knowledgeId;
    const before = app.detail(id);
    const execute = (fields: Record<string, unknown>) => executeKnowledgeCandidateAction({ workspace: 'fixture', ...fields }, undefined, () => app);
    await expect(execute({ operation: 'tag', id, generation: 0, tags: ['排障', 'Taro'] })).resolves.toEqual({ generation: 1, tags: ['排障', 'Taro'] });
    expect(app.detail(id).history).toEqual(before.history);
    expect(app.list()[0]).toMatchObject({ tags: ['排障', 'Taro'] });
    await expect(execute({ operation: 'tag', id, generation: 0, tags: ['other'] })).rejects.toThrow('conflict');
    await expect(execute({ operation: 'tag', id: 'missing', generation: 0, tags: ['other'] })).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('generates once, assigns host identities, and preserves raw response and source bindings', async () => {
    const { app, snapshot, model, generate, source } = setup('前文😀Alpha 使用 Beta。');
    const id = randomUUID();
    const run = await app.generate(snapshot.snapshotId, model, id);
    expect(run.status).toBe('completed');
    expect(run.promptVersion).toBe('knowledge-extraction-v4');
    expect(run.rawOutput).toBe((await generate.mock.results[0].value).output);
    expect(JSON.parse(run.rawOutput!).proposals[0].citations[0].selection).not.toHaveProperty('start');
    expect(run.committed).toHaveLength(1);
    expect(run.runtime).not.toHaveProperty('costUSD');
    expect(generate.mock.calls[0][1]).not.toContain(source);
    const entry = app.detail(run.committed[0].knowledgeId);
    expect(entry.revision.knowledgeId).not.toBe('candidate-1');
    expect(entry.revision.entities[0].entityId).not.toBe('project');
    expect(entry.grounding.mentions[0].entityId).toBe(entry.revision.entities[0].entityId);
    expect(entry.grounding.citations[0].selection).toMatchObject({ start: 4, end: 17, quote: 'Alpha 使用 Beta' });
    expect(entry.reviewStatus).toBe('pending');
    expect(entry.revision.createdBy).toMatchObject({ actorKind: 'agent', executionRef: id });
    expect(await app.generate(snapshot.snapshotId, model, id)).toEqual(run);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('retains conversation links and maintenance choices after deleting source text', async () => {
    const { app, model, source, generate } = setup();
    const origin = { threadId: 'thread', turnId: 'turn', title: 'Private conversation title', cwd: '/private/project' };
    const snapshot = app.capture({ path: source, origin });
    const run = await app.generate(snapshot.snapshotId, model);
    expect(run.origin).toEqual(origin);
    expect(generate.mock.calls[0][1]).not.toContain(origin.title);
    const ref = run.committed[0];
    app.maintain(ref.knowledgeId, ref.revisionId, 'retain', 'Checked', 1);
    app.deleteSource(snapshot.snapshotId);
    const related = await executeKnowledgeCandidateAction({ operation: 'queue', workspace: 'fixture', threadId: 'thread' }, undefined, () => app);
    expect(related).toMatchObject({ rows: [{ knowledgeId: ref.knowledgeId, choice: 'retain' }], runs: [{ runId: run.runId }] });
    const detail = await executeKnowledgeCandidateAction({ operation: 'show', workspace: 'fixture', id: ref.knowledgeId }, undefined, () => app);
    expect(detail).toMatchObject({ origin, sources: [{ status: 'unavailable', reason: 'deleted' }] });
  });
  it('recovers interrupted commits using persisted identities without calling the model again', async () => {
    const { app, snapshot, model, generate, knowledge, runs } = setup();
    const original = knowledge.write.bind(knowledge);
    const write = vi.spyOn(knowledge, 'write').mockImplementationOnce((command, actor) => {
      original(command, actor);
      throw new Error('simulated lost response after commit');
    });
    const id = randomUUID();
    await expect(app.generate(snapshot.snapshotId, model, id)).rejects.toThrow('lost response');
    expect(runs.read(id).status).toBe('prepared');
    write.mockRestore();
    expect(app.resume(id).status).toBe('completed');
    expect(knowledge.list()).toHaveLength(1);
    expect(knowledge.list()[0].generation).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('keeps invalid model output as failure evidence and treats an empty result as completed', async () => {
    const { app, snapshot, model } = setup();
    model.generate = async () => ({ output: 'invalid JSON', durationMs: 1 });
    const failed = await app.generate(snapshot.snapshotId, model);
    expect(failed).toMatchObject({ status: 'failed', rawOutput: 'invalid JSON' });
    expect(app.list()).toEqual([]);
    model.generate = async () => ({ output: '{"responseKind":"knowledge-extraction","schemaVersion":4,"entities":[],"mentions":[],"proposals":[]}', durationMs: 1 });
    expect(await app.generate(snapshot.snapshotId, model)).toMatchObject({ status: 'completed', committed: [] });
  });
  it('binds corrections to a new analysis and knowledge revision without changing historical positions', async () => {
    const { app, snapshot, model } = setup();
    const run = await app.generate(snapshot.snapshotId, model);
    const { knowledgeId, revisionId } = run.committed[0];
    const before = app.detail(knowledgeId);
    const draft = structuredClone({ title: before.revision.title, content: before.revision.content,
      entities: before.revision.entities, evidence: before.revision.evidence });
    const analysis = app.entities(run.runId);
    const edit = structuredClone({ entities: analysis.revision.entities, mentions: analysis.revision.mentions });
    edit.entities[0].label = '项目 Alpha';
    const corrected = app.correctEntities(run.runId, analysis.revision.revisionId, analysis.history.generation, edit, '明确项目');
    draft.entities = draft.entities.map(entity => {
      const correctedEntity = corrected.revision.entities.find(value => value.entityId === entity.entityId)!;
      return { entityId: entity.entityId, label: correctedEntity.label, description: correctedEntity.description };
    });
    draft.evidence[0].interpretation = '仅描述本次任务，未证实未来仍适用';
    const after = app.reviseUsingEntities(knowledgeId, revisionId, 1, run.runId, corrected.revision.revisionId, draft, '澄清实体与来源范围');
    expect(after.revision.entities[0].label).toBe('项目 Alpha');
    expect(after.grounding.mentions).toEqual(before.grounding.mentions);
    expect(before.grounding.entityAnalysisRef?.revisionId).toBe(analysis.revision.revisionId);
    expect(after.grounding.entityAnalysisRef?.revisionId).toBe(corrected.revision.revisionId);
    expect(app.detail(knowledgeId, revisionId).revision.entities[0].label).toBe('Alpha');
    expect(after.reviewStatus).toBe('pending');
    draft.entities[0].entityId = 'invented';
    expect(() => app.revise(knowledgeId, after.revision.revisionId, 2, draft, '错误身份')).toThrow();
    expect(app.detail(knowledgeId).history.generation).toBe(2);
  });
  it('retains and revises without transferring a maintenance choice or changing the original revision', async () => {
    const { app, snapshot, model } = setup();
    const run = await app.generate(snapshot.snapshotId, model);
    const { knowledgeId, revisionId } = run.committed[0];
    app.maintain(knowledgeId, revisionId, 'retain', '未来工具排查会用到', 1);
    expect(app.list()[0]).toMatchObject({ knowledgeId, revisionId, choice: 'retain', reviewStatus: 'pending' });
    const before = app.detail(knowledgeId);
    const draft = { title: '修订后的标题', content: before.revision.content, entities: before.revision.entities, evidence: before.revision.evidence };
    const after = app.revise(knowledgeId, revisionId, 2, draft, '明确适用项目');
    expect(after.revision.title).toBe('修订后的标题');
    expect(after.reviewStatus).toBe('pending');
    expect(after.maintenance).toBeNull();
    expect(app.list()[0]).toMatchObject({ revisionId: after.revision.revisionId, title: draft.title, choice: null, reviewStatus: 'pending' });
    expect(app.detail(knowledgeId, revisionId).maintenance?.choice).toBe('retain');
    app.deleteSource(snapshot.snapshotId);
    expect(app.detail(knowledgeId).sources[0]).toMatchObject({ status: 'unavailable', reason: 'deleted' });
  });
});
