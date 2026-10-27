import { executeKnowledgeCandidateAction } from '../../src/studio/application/knowledge/knowledge-candidates.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeApplication, type ExtractionModel } from '../../src/knowledge/application/application.js';
import { executeKnowledgeOperation, knowledgeFailureCode, KnowledgeOperationSchema } from '../../src/knowledge/application/operations.js';
import { KnowledgeCitationRevisionError, type KnowledgeCitationLocator } from '../../src/knowledge/application/citation-locators.js';
import { TraceEvidenceStore } from '../../src/knowledge/adapters/trace-evidence.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileExtractionRunStore } from '../../src/knowledge/adapters/run-store.js';
import { FileKnowledgeTags } from '../../src/knowledge/adapters/knowledge-tags.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { configuredExtractionModel } from '../../src/knowledge/adapters/executor.js';
import { createCodexArchiveProducer } from '../../src/executors/openai/codex/archive.js';
import { EXTRACTION_PROMPT, EXTRACTION_PROMPT_VERSION } from '../../src/knowledge/extraction/prompt.js';
import { EXTRACTION_INPUT_MAX_BYTES } from '../../src/knowledge/extraction/model-input.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { identityWindow, modelWindow, wireModelWindow } from './fixtures.js';
import { authoredTechnicalDiscussion, technicalDiscussionSources } from './fixtures/technical-discussion.js';
import { STRICT_EXTRACTION_PROMPT, STRICT_EXTRACTION_PROMPT_VERSION } from '../../src/knowledge/extraction/strict-prompt.js';
import { STRICT_EXTRACTION_FEWSHOT_EXAMPLES } from '../../src/knowledge/extraction/strict-fewshot.js';
import { WINDOW_EXTRACTION_WIRE_ID } from '../../src/knowledge/extraction/model-wire.js';
import { extractionQuality } from '../../src/knowledge/extraction/quality.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(text = 'Alpha 使用 Beta', extraTexts: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-app-')); roots.push(root);
  const source = join(root, 'log.jsonl');
  writeFileSync(source, [text, ...extraTexts].map(value => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: value }] } })).join('\n'));
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'test');
  const runs = new FileExtractionRunStore(join(root, 'extraction-runs'), root);
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
  it('aggregates saved birth admission with proven localization stages, unknowns and once-per-run recovery', async () => {
    const { app, snapshot, model, ports, generate } = setup();
    const first = await app.generate(snapshot.snapshotId, model);
    const packet = modelWindow(); packet.mentions[0].selection.quote = 'not in this window';
    packet.mentions.push({ ...packet.mentions[0], mentionId: 'extra-bad-mention' });
    model.generate = async () => ({ output: JSON.stringify(packet).replaceAll('record-1', snapshot.excerpts[0].evidenceRef), durationMs: 1 });
    const write = vi.spyOn(ports.entities, 'write').mockImplementationOnce(() => { throw new Error('interrupted before entity write'); });
    const id = randomUUID(); await expect(app.generate(snapshot.snapshotId, model, id)).rejects.toThrow('interrupted'); write.mockRestore();
    const prepared = app.quality().groups[0]; expect(prepared.runs).toMatchObject({ prepared: 1, completed: 1, total: 2 });
    app.resume(id);
    const group = app.quality().groups[0];
    expect(group.entities).toEqual({ accepted: 3, rejected: 1, recorded: 4, unknownRuns: 0, acceptanceRate: 3 / 4 });
    expect(group.mentions).toEqual({ accepted: 3, rejected: 2, recorded: 5, unknownRuns: 0, acceptanceRate: 3 / 5 });
    expect(group.proposals).toEqual({ accepted: 1, rejected: 1, recorded: 2, unknownRuns: 0, acceptanceRate: 1 / 2 });
    expect(group.localization).toEqual({ passed: 3, rejected: 2, notChecked: 0, unknown: 0, unknownRuns: 0, passRate: 3 / 5 });
    expect(group.referenceRejections).toBe(2);
    expect(group.runs).toMatchObject({ prepared: 0, completed: 2, total: 2, zeroKnowledge: 1, withoutAdmission: 0 });
    expect(group.entities).toEqual(prepared.entities);
    // Later human maintenance and entity corrections are not generation quality measurements.
    const before = app.entities(first.runId); const edit = structuredClone(before.revision); edit.entities[0].label = 'Changed by human';
    app.correctEntities(first.runId, before.revision.revisionId, before.history.generation, { entities: edit.entities, mentions: edit.mentions }, 'Reviewed identity');
    expect(app.quality().groups[0]).toEqual(group);
    model.generate = async () => ({ output: JSON.stringify({ responseKind: 'knowledge-extraction', schemaVersion: 4, entities: [], mentions: [], proposals: [] }), durationMs: 1 });
    const empty = await app.generate(snapshot.snapshotId, { ...model, model: 'empty' });
    expect(app.quality().groups.find(value => value.identity.model === 'empty')).toMatchObject({ runs: { zeroAccepted: 1, zeroKnowledge: 1 }, mentions: { acceptanceRate: null }, localization: { passRate: null } });
    await app.generate(snapshot.snapshotId, { ...model, model: 'failed', generate: async () => { throw new Error('fixture failure'); } });
    expect(app.quality().groups.find(value => value.identity.model === 'failed')).toMatchObject({ runs: { failed: 1, withoutAdmission: 1 }, mentions: { unknownRuns: 1, acceptanceRate: null } });
    const calls = generate.mock.calls.length;
    expect(await executeKnowledgeOperation(app, { operation: 'quality' })).toEqual(app.quality()); expect(generate).toHaveBeenCalledTimes(calls);
    const rejections = ['invalid_structure', 'duplicate_mention', 'mention_identifier_fragment', 'duplicate_mention_position', 'unknown_entity', 'future_check'];
    const diagnostic = { ...empty, entityRejections: rejections.map((reason, index) => ({ component: 'mention' as const, index, reasons: [reason] })) };
    const details = extractionQuality([diagnostic]).groups[0];
    expect(details.localization).toEqual({ passed: 3, rejected: 0, notChecked: 2, unknown: 1, unknownRuns: 0, passRate: null });
    expect(details.identifierFragmentRejections).toBe(1); expect(details.identifierFragmentRejectionRate).toBe(1 / 6);
    const localShapes = ['invalid_collection_shape', 'incomplete_collection_without_reason', 'partial_collection_without_members', 'unknown_future_rule'];
    const local = { ...empty, entityRejections: localShapes.map((reason, index) => ({ component: 'entity' as const, index, reasons: [reason] })) };
    expect(extractionQuality([local]).groups[0].referenceRejections).toBe(0);
    expect(extractionQuality([{ ...local, rejections: [{ index: 0, reasons: ['unknown_component', 'unknown_entity_analysis_reference'] }] }]).groups[0].referenceRejections).toBe(1);
    const legacy = extractionQuality([{ ...first, entityRejections: undefined }]).groups[0];
    expect(legacy.mentions).toMatchObject({ accepted: 2, unknownRuns: 1, acceptanceRate: null }); expect(legacy.localization.passRate).toBeNull();
    expect(extractionQuality([first, { ...first, runId: randomUUID(), promptHash: 'different' }]).groups).toHaveLength(2);
    expect(() => extractionQuality([first, first])).toThrow('Duplicate extraction run');
  });

  it.each(['missing', 'corrupt'] as const)('projects saved run/quality manifests without %s native archives but refuses recovery', async problem => {
    const { app, snapshot, model, runs, generate, root } = setup();
    const run = await app.generate(snapshot.snapshotId, model), quality = app.quality();
    const path = join(root, 'extraction-runs', 'outcomes', run.runId, `${run.attempts[0].attemptId}.json`);
    if (problem === 'missing') rmSync(path); else writeFileSync(path, '{invalid native archive');
    expect(app.runs()).toEqual([run]); expect(app.quality()).toEqual(quality);
    expect(await executeKnowledgeOperation(app, { operation: 'runs' })).toEqual([run]);
    expect(await executeKnowledgeOperation(app, { operation: 'quality' })).toEqual(quality);
    expect(() => runs.read(run.runId)).toThrow(); expect(() => app.resume(run.runId)).toThrow();
    await expect(app.generate(snapshot.snapshotId, model, run.runId)).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('bounds the full UTF-8 model input before reservation, preserves source bytes and permits a smaller capture', async () => {
    const { app, snapshot, model, generate, source, runs } = setup('中'.repeat(400_000));
    const original = readFileSync(source);
    const input = JSON.stringify({ excerpts: snapshot.excerpts, limitations: snapshot.limitations });
    expect(input.length + EXTRACTION_PROMPT.length).toBeLessThan(EXTRACTION_INPUT_MAX_BYTES);
    expect(Buffer.byteLength(input) + Buffer.byteLength(EXTRACTION_PROMPT)).toBeGreaterThan(EXTRACTION_INPUT_MAX_BYTES);
    await expect(app.generate(snapshot.snapshotId, model)).rejects.toThrow(/--start-record\/--end-record.*one turn/);
    expect(generate).not.toHaveBeenCalled(); expect(runs.listManifests()).toEqual([]); expect(app.list()).toEqual([]);
    expect(readFileSync(source)).toEqual(original);
    writeFileSync(source, `${original.toString()}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } })}`);
    const smaller = app.capture({ path: source, startRecord: 1, endRecord: 1 });
    model.generate = async () => ({ output: JSON.stringify(modelWindow()).replaceAll('record-1', smaller.excerpts[0].evidenceRef), durationMs: 1 });
    expect(await app.generate(smaller.snapshotId, model)).toMatchObject({ status: 'completed', committed: [expect.anything()] });
    expect(app.source(snapshot.snapshotId)).toEqual({ status: 'available', window: snapshot });
  });
  it('rejects identifier fragments in new corrections without changing stored history or moving the old mention', async () => {
    const text = '_prefixAlphaSuffix；Alpha 使用 Beta';
    const { app, snapshot, model, root } = setup(text);
    const packet = modelWindow(); packet.mentions[0].selection.occurrence = 1;
    model.generate = async () => ({ output: JSON.stringify(packet).replaceAll('record-1', snapshot.excerpts[0].evidenceRef), durationMs: 0 });
    const run = await app.generate(snapshot.snapshotId, model);
    expect(run.entityRejections).toEqual([]); expect(run.committed).toHaveLength(1);
    const before = app.entities(run.runId), file = join(root, 'entities', `${run.runId}.json`);
    const bytes = readFileSync(file);
    const edit = structuredClone({ entities: before.revision.entities, mentions: before.revision.mentions });
    edit.mentions[0] = { ...edit.mentions[0], mentionId: 'new:identifier-piece',
      selection: { ...edit.mentions[0].selection, start: 7, end: 12 } };
    expect(() => app.correctEntities(run.runId, before.revision.revisionId, before.history.generation, edit, '错误子串')).toThrow('mention_identifier_fragment');
    expect(readFileSync(file)).toEqual(bytes);
    expect(app.entities(run.runId).history).toEqual(before.history);
  });
  it('preserves configuration literal types, scope and unknown code-state identity after reopening stored knowledge', async () => {
    const text = "当前 master 的被测代码尚未发布；客户端 C 的 enabled 在测试环境为布尔值 false，在生产环境为字符串 'false'。";
    const { app, snapshot, ports, model, root } = setup(text);
    const output = modelWindow();
    output.entities[0] = { ...output.entities[0], label: '当前 master', referentKind: 'version',
      description: '本次被测代码状态', uncertainties: ['未记录提交标识'], qualifiers: ['本次状态，尚未发布'] };
    output.entities[1] = { ...output.entities[1], label: 'enabled', description: '客户端 C 的配置字段', qualifiers: ['所属客户端 C'] };
    output.mentions[0].selection.quote = '当前 master'; output.mentions[1].selection.quote = 'enabled';
    const candidate = output.proposals[0];
    const original = candidate.draft.content.statements[0];
    candidate.draft.content.statements = [
      { ...original, statementId: 'code-state', subject: { entityId: 'project' }, object: undefined,
        relation: '本次被测代码已发布', polarity: 'negative', context: { ...original.context, scenario: '本次被测代码状态',
          conditions: ['仅本次代码状态'], unknowns: ['未记录提交标识，不代表身份未消解'] } },
      ...(['test-value', 'production-value'] as const).map((statementId, index) => ({ ...original, statementId,
        subject: { entityId: 'tool' }, object: undefined, relation: index ? "配置值为字符串 'false'" : '配置值为布尔值 false',
        context: { ...original.context, scenario: '客户端 C 的 enabled 配置', conditions: [index ? '生产环境' : '测试环境'],
          unknowns: ['未记录开关的运行效果，不能推断已禁用'] } })),
    ];
    candidate.draft.evidence[0].statementIds = candidate.draft.content.statements.map(statement => statement.statementId);
    candidate.draft.evidence[0].basis = 'source_assertion';
    candidate.citations[0].selection.quote = text;
    model.generate = async () => ({ output: JSON.stringify(output).replaceAll('record-1', snapshot.excerpts[0].evidenceRef), durationMs: 0 });
    const run = await app.generate(snapshot.snapshotId, model);
    expect(run.status).toBe('completed'); expect(run.entityRejections).toEqual([]); expect(run.rejections).toEqual([]);
    const reopened = new KnowledgeApplication({ ...ports, knowledge: new FileKnowledgeStore(join(root, 'items'), 'test'),
      runs: new FileExtractionRunStore(join(root, 'extraction-runs'), root), entities: new FileEntityAnalysisStore(join(root, 'entities')),
      evidence: new TraceEvidenceStore(join(root, 'sources')) });
    const detail = reopened.detail(run.committed[0].knowledgeId);
    expect(detail.entityAnalysis?.status).toBe('available');
    expect(detail.grounding.entityAnalysisRef?.analysisId).toBe(run.runId);
    expect(detail.revision.content.statements.map(({ relation, context }) => ({ relation, context })))
      .toEqual(candidate.draft.content.statements.map(({ relation, context }) => ({ relation, context })));
    expect(detail.revision.evidence[0].basis).toBe('source_assertion');
    expect(detail.revision.content.statements[0].polarity).toBe('negative');
    expect(reopened.entities(run.runId).revision.entities.find(entity => entity.label === '当前 master'))
      .toMatchObject({ identityStatus: 'proposed', referentKind: 'version', uncertainties: ['未记录提交标识'] });
    expect(reopened.queryEntities({ query: 'enabled' }).rows).toHaveLength(1);
    expect(reopened.queryEntities({ query: 'master' }).rows).toHaveLength(1);
  });

  it('persists authored unknown and explicit fact times unchanged without using message timestamps as a repair rule', async () => {
    const example = STRICT_EXTRACTION_FEWSHOT_EXAMPLES.find(value => value.exampleId === 'synthetic-source-time-and-fact-time-v1')!;
    const { app, model, ports, root, source } = setup();
    writeFileSync(source, example.input.excerpts.map(excerpt => JSON.stringify({ timestamp: excerpt.timestamp, type: 'response_item',
      payload: { type: 'message', role: excerpt.role, content: [{ type: excerpt.role === 'assistant' ? 'output_text' : 'input_text', text: excerpt.text }] } })).join('\n'));
    const snapshot = app.capture({ path: source });
    expect(snapshot.excerpts.map(excerpt => excerpt.timestamp)).toEqual(example.input.excerpts.map(excerpt => excerpt.timestamp));
    expect(snapshot.excerpts.map(excerpt => excerpt.role)).toEqual(example.input.excerpts.map(excerpt => excerpt.role));
    let raw = JSON.stringify(example.output);
    example.input.excerpts.forEach((excerpt, index) => { raw = raw.replaceAll(JSON.stringify(excerpt.evidenceRef), JSON.stringify(snapshot.excerpts[index].evidenceRef)); });
    const generate = vi.fn(async () => ({ output: raw, durationMs: 1 }));
    const strictModel: ExtractionModel = { ...model, outputMode: 'json-schema', wireId: WINDOW_EXTRACTION_WIRE_ID, generate };
    const run = await app.generate(snapshot.snapshotId, strictModel);
    expect(run.status).toBe('completed'); expect(run.rejections).toEqual([]); expect(run.entityRejections).toEqual([]);
    expect(run.rawOutput).toBe(raw); expect(run.promptVersion).toBe(STRICT_EXTRACTION_PROMPT_VERSION);
    const reopened = new KnowledgeApplication({ ...ports, knowledge: new FileKnowledgeStore(join(root, 'items'), 'test'),
      runs: new FileExtractionRunStore(join(root, 'extraction-runs'), root), entities: new FileEntityAnalysisStore(join(root, 'entities')),
      evidence: new TraceEvidenceStore(join(root, 'sources')) });
    const saved = run.committed.flatMap(({ knowledgeId }) => reopened.detail(knowledgeId).revision.content.statements);
    expect(saved).toHaveLength(example.output.proposals.reduce((count, proposal) => count + proposal.draft.content.statements.length, 0));
    for (const proposal of example.output.proposals) for (const expected of proposal.draft.content.statements) {
      expect(saved.find(statement => statement.statementId === expected.statementId)?.context).toEqual(expected.context);
    }
    expect(saved.find(statement => statement.statementId === 's_start')?.context.occurredDuring)
      .toEqual({ timeKind: 'instant', at: snapshot.excerpts[2].timestamp });
    expect(run.attempts[0].wireDiagnostic).toMatchObject({ wireStatus: 'valid', itemFailureCount: 0 });
    expect(generate).toHaveBeenCalledTimes(1);
    // The callback supplies an authored response. This verifies persistence, not model behavior or semantic acceptance.
  });
  it('preserves authored public discussion problems, objections, proposals and negative support through one strict31 birth and reopen', async () => {
    const { app, model, ports, root, source } = setup();
    // Constructed local carrier with literal public fragments; no live source/model invocation.
    writeFileSync(source, technicalDiscussionSources.map(row => JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: row.text }] } })).join('\n'));
    const snapshot = app.capture({ path: source }), authored = authoredTechnicalDiscussion(snapshot.excerpts);
    const packet = { ...authored, proposals: authored.proposals.map(p => ({ ...p, draft: { ...p.draft,
      content: { ...p.draft.content, statements: p.draft.content.statements.map(s => ({ ...s, object: null })) } } })) };
    const raw = JSON.stringify(packet), generate = vi.fn(async (_system: string) => ({ output: raw, durationMs: 1 }));
    const run = await app.generate(snapshot.snapshotId, { ...model, outputMode: 'json-schema', wireId: WINDOW_EXTRACTION_WIRE_ID, generate });
    expect(run.status).toBe('completed'); expect(run.promptVersion).toBe('knowledge-extraction-v31');
    expect(run.rawOutput).toBe(raw); expect(run.rejections).toEqual([]); expect(run.entityRejections).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1); expect(generate.mock.calls[0][0]).toBe(STRICT_EXTRACTION_PROMPT);
    const reopened = new KnowledgeApplication({ ...ports, knowledge: new FileKnowledgeStore(join(root, 'items'), 'test'),
      runs: new FileExtractionRunStore(join(root, 'extraction-runs'), root), entities: new FileEntityAnalysisStore(join(root, 'entities')),
      evidence: new TraceEvidenceStore(join(root, 'sources')) });
    expect(reopened.resume(run.runId).rawOutput).toBe(raw); expect(run.committed).toHaveLength(2);
    const saved = run.committed.map(({ knowledgeId }) => reopened.detail(knowledgeId));
    for (const proposal of authored.proposals) {
      const actual = saved.find(k => k.revision.title === proposal.draft.title)!;
      expect(actual.reviewStatus).toBe('pending'); expect(actual.revision.content.organization).toEqual({ knowledgeKind: 'fact' });
      expect(actual.revision.evidence).toEqual(proposal.draft.evidence);
      for (const expected of proposal.draft.content.statements) {
        const statement = actual.revision.content.statements.find(s => s.statementId === expected.statementId)!;
        expect({ ...statement, subject: expected.subject }).toEqual(expected);
      }
      expect(actual.grounding!.citations.map(c => ({ evidenceLinkId: c.evidenceLinkId, quote: c.selection.quote })))
        .toEqual(proposal.citations.map(c => ({ evidenceLinkId: c.evidenceLinkId, quote: c.selection.quote })));
    }
    expect(saved.flatMap(k => k.revision.content.statements)).toHaveLength(8);
    // Authored returns verify representability/persistence, not the model's completeness.
  });
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
    await expect(executeKnowledgeOperation(app, { operation: 'generate', snapshot: snapshot.snapshotId, executor: model.executor, model: model.model, runId }, undefined, () => model)).rejects.toThrow('acknowledgement');
    const prepared = runs.read(runId);
    expect(prepared.status).toBe('prepared');
    write.mockRestore(); expect((await executeKnowledgeOperation(app, { operation: 'resume', id: runId })).status).toBe('completed');
    expect(app.entities(runId).history.generation).toBe(1);
    expect(app.entities(runId).revision.revisionId).toBe(prepared.entityAnalysis!.revision.revisionId);
    const analysis = app.entities(runId);
    expect(analysis.history.schemaVersion).toBe(2);
    expect(prepared).toMatchObject({ schemaVersion: 5, promptVersion: EXTRACTION_PROMPT_VERSION });
    const [component, instance, group] = analysis.revision.entities;
    const [, instanceMention, groupMention] = analysis.revision.mentions;
    expect(instance.componentRef).toMatchObject({ entityId: component.entityId, mentionIds: [instanceMention.mentionId] });
    expect(group.collection).toMatchObject({ memberEntityIds: [component.entityId, instance.entityId], mentionIds: [groupMention.mentionId] });
    expect(instance.entityId).not.toBe('tool');
    expect(analysis.revision).toEqual(prepared.entityAnalysis!.revision);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('reads and resumes the current run format with its original prompt identity without another model call', async () => {
    const { app, snapshot, model, runs, ports, generate, root } = setup();
    const write = vi.spyOn(ports.entities, 'write').mockImplementationOnce(() => { throw new Error('interrupted before entity write'); });
    const runId = randomUUID();
    await expect(app.generate(snapshot.snapshotId, model, runId)).rejects.toThrow('interrupted');
    write.mockRestore();
    const prepared = runs.read(runId);
    const historical = { ...prepared, promptVersion: 'knowledge-extraction-v4', promptHash: 'frozen-original-prompt', requestDigest: 'frozen-original-request' };
    const file = join(root, 'extraction-runs', `${runId}.json`); const bytes = JSON.stringify(historical);
    writeFileSync(file, bytes);
    expect(runs.read(runId)).toEqual(historical); expect(readFileSync(file, 'utf8')).toBe(bytes);
    // A current prompt request cannot reuse a historical prompt generation identity.
    await expect(app.generate(snapshot.snapshotId, model, runId)).rejects.toThrow('identity conflict');
    const resumed = app.resume(runId);
    expect(resumed).toMatchObject({ status: 'completed', schemaVersion: 5,
      promptVersion: historical.promptVersion, promptHash: historical.promptHash, requestDigest: historical.requestDigest, rawOutput: prepared.rawOutput });
    expect(app.entities(runId).revision).toEqual(prepared.entityAnalysis!.revision);
    expect(generate).toHaveBeenCalledTimes(1);
    const completedBytes = readFileSync(file, 'utf8');
    expect(app.resume(runId)).toEqual(resumed); expect(readFileSync(file, 'utf8')).toBe(completedBytes);
    for (const promptVersion of ['', 'knowledge-extraction-v0', 'unknown', 'knowledge-extraction-v5\n']) {
      const invalidBytes = JSON.stringify({ ...resumed, promptVersion }); writeFileSync(file, invalidBytes);
      expect(() => runs.read(runId)).toThrow(); expect(readFileSync(file, 'utf8')).toBe(invalidBytes);
    }
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
    const entityPath = join(root, 'entities', `${run.runId}.json`); const runPath = join(root, 'extraction-runs', `${run.runId}.json`);
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
    const path = join(root, 'extraction-runs', `${runId}.json`);
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
  it('explicitly corrects tested-build release scope while preserving raw evidence, old bindings and reviewed uncertainty', async () => {
    const text = '已发布 beta 包 R；本次真实 beta 构建 T，未确认是否为 R；T 的事件 ID 返回 undefined。';
    const { app, snapshot, model, root, ports } = setup(text); const packet = modelWindow();
    // Authored incorrect response: admission cannot infer artifact identity from names.
    packet.entities.forEach((entity, index) => {
      entity.label = 'beta'; entity.referentKind = 'version';
      entity.description = index ? '已发布且被用于本次测试的构建' : '来源中的发布包 R';
      entity.qualifiers = ['已发布'];
      entity.uncertainties = index ? ['精确构建未知'] : [];
      packet.mentions[index].selection.quote = index ? '真实 beta 构建 T' : '已发布 beta 包 R';
    });
    const statement = packet.proposals[0].draft.content.statements[0];
    statement.subject = { entityId: 'tool' }; delete statement.object;
    statement.relation = '本次事件 ID 返回 undefined';
    statement.context = { ...statement.context, scenario: '来源描述本次 T 测试', unknowns: ['发布状态及是否为 R 未确认'] };
    packet.proposals[0].draft.title = '本次被测构建的 ID 行为';
    packet.proposals[0].citations[0].selection.quote = text;
    packet.proposals[0].identityUncertainties = ['保留的附加说明'];
    model.generate = async (_prompt, input) => ({ output: JSON.stringify(packet).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 1 });
    const run = await app.generate(snapshot.snapshotId, model); const before = app.detail(run.committed[0].knowledgeId);
    const analysis = app.entities(run.runId); const edit = structuredClone({ entities: analysis.revision.entities, mentions: analysis.revision.mentions });
    const runFile = join(root, 'extraction-runs', `${run.runId}.json`); const runBytes = readFileSync(runFile);
    edit.entities[1].description = '来源中的本次被测构建 T'; edit.entities[1].qualifiers = ['本次测试'];
    edit.entities[1].uncertainties = ['精确构建未知', '发布状态及是否为 R 未确认'];
    const corrected = app.correctEntities(run.runId, analysis.revision.revisionId, 1, edit, '不继承发布包的限定');
    expect(app.detail(before.revision.knowledgeId).grounding).toEqual(before.grounding);
    const draft = { title: before.revision.title, entities: before.revision.entities.map(entity => {
      const current = corrected.revision.entities.find(value => value.entityId === entity.entityId)!;
      return { entityId: current.entityId, label: current.label, description: current.description };
    }), content: before.revision.content, evidence: before.revision.evidence };
    const reviewed = app.reviseUsingEntities(before.revision.knowledgeId, before.revision.revisionId, 1, run.runId, corrected.revision.revisionId, draft, '逐项核对后移除旧说明', []);
    expect(reviewed.grounding.identityUncertainties).toEqual(['精确构建未知', '发布状态及是否为 R 未确认']);
    expect(reviewed.history.grounding[0]).toEqual(before.grounding);
    expect(reviewed.revision.content).toEqual(before.revision.content);
    expect(reviewed.grounding.citations).toEqual(before.grounding.citations);
    expect(reviewed.grounding.entityAnalysisRef?.revisionId).toBe(corrected.revision.revisionId);
    const reopened = new KnowledgeApplication({ ...ports, knowledge: new FileKnowledgeStore(join(root, 'items'), 'test'),
      entities: new FileEntityAnalysisStore(join(root, 'entities')), runs: new FileExtractionRunStore(join(root, 'extraction-runs'), root),
      evidence: new TraceEvidenceStore(join(root, 'sources')) });
    expect(reopened.detail(before.revision.knowledgeId, before.revision.revisionId).revision).toEqual(before.revision);
    expect(reopened.entities(run.runId, analysis.revision.revisionId).revision).toEqual(analysis.revision);
    expect(reopened.queryEntities({ query: 'beta' }).rows).toHaveLength(2);
    expect(reopened.entityDetail(run.runId, analysis.revision.entities[1].entityId).entity)
      .toMatchObject({ qualifiers: ['本次测试'], identityStatus: 'proposed', uncertainties: ['精确构建未知', '发布状态及是否为 R 未确认'] });
    expect(readFileSync(runFile)).toEqual(runBytes);
    expect(reopened.runs()[0].rawOutput).toBe(run.rawOutput);
  });

  it('rebinds a work-record claim to its source topic without rewriting birth results or losing record provenance', async () => {
    const text = '缓存策略要求缓存 60 秒；PR #23 已合并该策略，记录链接 https://example.com/pr/23，线上效果未知。';
    const { app, snapshot, model, root, ports } = setup(text); const packet = modelWindow();
    packet.entities[0] = { ...packet.entities[0], label: '缓存策略', description: '来源讨论的缓存时效策略' };
    packet.entities[1] = { ...packet.entities[1], label: 'PR #23', description: '来源中的具体工作记录' };
    packet.mentions[0].selection.quote = '缓存策略'; packet.mentions[1].selection.quote = 'PR #23';
    const proposal = packet.proposals[0]; const statement = proposal.draft.content.statements[0];
    proposal.draft.title = 'PR #23 的合并记录';
    statement.subject = { entityId: 'tool' }; delete statement.object;
    statement.relation = '已合并缓存 60 秒的策略';
    statement.context = { ...statement.context, scenario: '来源报告的一次策略合并', unknowns: ['线上效果未知'] };
    proposal.draft.evidence[0] = { ...proposal.draft.evidence[0], relation: 'supports', basis: 'source_assertion' };
    proposal.citations[0].selection.quote = 'PR #23';
    model.generate = async (_system, input) => ({ output: JSON.stringify(packet).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 1 });
    const run = await app.generate(snapshot.snapshotId, model); const knowledgeId = run.committed[0].knowledgeId;
    const birth = app.detail(knowledgeId); const analysis = app.entities(run.runId);
    const runFile = join(root, 'extraction-runs', run.runId + '.json'); const runBytes = readFileSync(runFile);
    const quality = app.quality(); const calls = vi.fn(model.generate); model.generate = calls;
    app.maintain(knowledgeId, birth.revision.revisionId, 'retain', '原规则下的来源候选', birth.history.generation);
    const retained = app.detail(knowledgeId);
    const topic = analysis.revision.entities.find(entity => entity.label === '缓存策略')!;
    const record = analysis.revision.entities.find(entity => entity.label === 'PR #23')!;
    const corrected = app.correctEntities(run.runId, analysis.revision.revisionId, analysis.history.generation, {
      entities: [topic], mentions: analysis.revision.mentions.filter(mention => mention.entityId === topic.entityId),
    }, '具体工作记录回到来源上下文，主题身份不变');
    const draft = { title: '缓存策略的时效选择', entities: [{ entityId: topic.entityId, label: topic.label, description: topic.description }],
      content: structuredClone(retained.revision.content), evidence: retained.revision.evidence };
    draft.content.statements[0].subject = { entityId: topic.entityId };
    draft.content.statements[0].relation = '要求缓存 60 秒';
    draft.content.statements[0].context = { ...draft.content.statements[0].context,
      scenario: 'PR #23 报告已合并该策略；记录链接 https://example.com/pr/23', unknowns: ['线上效果未知'] };
    const invalid = { ...draft, entities: retained.revision.entities };
    expect(() => app.reviseUsingEntities(knowledgeId, retained.revision.revisionId, retained.history.generation,
      run.runId, corrected.revision.revisionId, invalid, '不可保留已退出目录的端点')).toThrow('Knowledge entity differs');
    const revised = await executeKnowledgeOperation(app, { operation: 'apply-entities', id: knowledgeId,
      revision: retained.revision.revisionId, generation: retained.history.generation, analysisId: run.runId,
      entityRevision: corrected.revision.revisionId, draft, reason: '按主题组织知识并保留工作记录依据',
      citationLocators: [{ evidenceLinkId: draft.evidence[0].evidenceLinkId,
        selection: { evidenceRef: draft.evidence[0].evidenceRef, quote: '缓存策略要求缓存 60 秒' } }],
    });
    expect(revised.maintenance).toBeNull();
    expect(revised.grounding.citations[0].selection.quote).toBe('缓存策略要求缓存 60 秒');
    expect(revised.grounding.citations).not.toEqual(birth.grounding.citations);
    expect(app.detail(knowledgeId, birth.revision.revisionId).grounding).toEqual(birth.grounding);
    expect(revised.revision.content.statements[0]).toMatchObject({ subject: { entityId: topic.entityId },
      context: { scenario: expect.stringContaining('https://example.com/pr/23') } });
    expect(revised.revision.entities.map(entity => entity.entityId)).toEqual([topic.entityId]);
    const reopened = new KnowledgeApplication({ ...ports, knowledge: new FileKnowledgeStore(join(root, 'items'), 'test'),
      entities: new FileEntityAnalysisStore(join(root, 'entities')), runs: new FileExtractionRunStore(join(root, 'extraction-runs'), root),
      evidence: new TraceEvidenceStore(join(root, 'sources')) });
    expect(reopened.detail(knowledgeId).revision).toEqual(revised.revision);
    expect(reopened.detail(knowledgeId, birth.revision.revisionId).revision).toEqual(birth.revision);
    expect(reopened.entities(run.runId, analysis.revision.revisionId).revision.entities).toContainEqual(record);
    expect(() => reopened.entityDetail(run.runId, record.entityId)).toThrow('Entity is absent');
    expect(reopened.quality()).toEqual(quality);
    reopened.resume(run.runId);
    expect(readFileSync(runFile)).toEqual(runBytes); expect(calls).not.toHaveBeenCalled();
    expect(reopened.runs()[0].rawOutput).toBe(run.rawOutput);
  });
  it('preserves output and usage when cancellation arrives after generation and resumes without regenerating', async () => {
    const { app, snapshot, generate } = setup(); const controller = new AbortController();
    const runtime = configuredExtractionModel('codex', 'fixture', createCodexArchiveProducer({}, () => async input => {
      const result = await generate(input.system ?? '', input.prompt); controller.abort();
      return { ...result, output: JSON.stringify(wireModelWindow(JSON.parse(result.output))), ok: true, durationApiMs: 5, inputTokens: 7, outputTokens: 9, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUSD: 0, costReportedByExecutor: false, stopReason: 'end_turn', numTurns: 1 };
    }));
    const cancelled = await app.generate(snapshot.snapshotId, runtime, randomUUID(), controller.signal);
    expect(cancelled).toMatchObject({ status: 'cancelled', runtime: { durationMs: 5, inputTokens: 7, outputTokens: 9 } });
    expect(cancelled.runtime).not.toHaveProperty('costUSD');
    expect(cancelled.promptVersion).toBe(STRICT_EXTRACTION_PROMPT_VERSION);
    expect(generate.mock.calls[0][0]).toBe(STRICT_EXTRACTION_PROMPT);
    expect(cancelled.attempts[0].request.systemDigest).toBe(`sha256:${createHash('sha256').update(STRICT_EXTRACTION_PROMPT).digest('hex')}`);
    expect(cancelled.rawOutput).toBeTruthy();
    const completed = app.resume(cancelled.runId);
    expect(completed.status).toBe('completed'); expect(completed.error).toBeUndefined();
    expect(completed.committed).toHaveLength(1); expect(completed.attempts[0].wireDiagnostic).toMatchObject({ wireStatus: 'valid', itemFailureCount: 0 });
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
    expect(run.promptVersion).toBe(EXTRACTION_PROMPT_VERSION);
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
  it('archives the complete failed return before admission and keeps unreported metrics unknown', async () => {
    const { app, snapshot, model, runs } = setup();
    const native = { ok: false, output: 'partial original assistant text', durationMs: 7, durationApiMs: 6,
      error: 'transport interrupted', failure: { failureKind: 'network', retryable: true }, refusal: 'original refusal',
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0,
      tokenUsageReportedByExecutor: false, costReportedByExecutor: false,
      turns: [{ tools: [{ input: { original: [1, null, 'private native detail'] }, output: 'untouched' }] }] };
    const call = vi.fn(async () => ({ outcomeKind: 'result' as const, result: native })); model.generate = call;
    const run = await app.generate(snapshot.snapshotId, model);
    expect(run).toMatchObject({ status: 'failed', rawOutput: native.output, runtime: { durationMs: 7, durationApiMs: 6,
      tokenUsageReportedByExecutor: false, costReportedByExecutor: false }, attempts: [{ failure: { failureKind: 'network' } }] });
    expect(run.runtime).not.toHaveProperty('inputTokens'); expect(run.runtime).not.toHaveProperty('costUSD');
    expect(runs.readOutcome(run.runId, run.attempts[0].attemptId, run.attempts[0].outcome).outcome)
      .toEqual({ outcomeKind: 'result', result: native });
    expect(app.resume(run.runId)).toEqual(run); expect(await app.generate(snapshot.snapshotId, model, run.runId)).toEqual(run);
    expect(call).toHaveBeenCalledTimes(1); expect(app.list()).toEqual([]);
  });
  it('retains an unacknowledged return, blocks competing effects and retries only archival', async () => {
    const { app, snapshot, model, generate, runs, ports } = setup();
    let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
    model.generate = async (system, input) => { await ready; return generate(system, input); };
    const id = randomUUID(), other = randomUUID(); const pending = app.generate(snapshot.snapshotId, model, id);
    await expect(app.generate(snapshot.snapshotId, model, other)).rejects.toThrow('pending');
    expect(() => runs.read(other)).toThrow(); expect(app.resume(id).status).toBe('generating');
    const archive = vi.spyOn(runs, 'writeOutcome').mockImplementationOnce(() => { throw new Error('archive unavailable'); });
    release(); await expect(pending).rejects.toThrow('archive unavailable');
    expect(runs.read(id)).toMatchObject({ status: 'generating', attempts: [expect.not.objectContaining({ outcome: expect.anything() })] });
    expect(new KnowledgeApplication(ports).resume(id).status).toBe('generating');
    await expect(app.generate(snapshot.snapshotId, model, other)).rejects.toThrow('pending');
    expect(app.resume(id).status).toBe('completed'); expect(archive).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('recovers a published outcome after lost acknowledgement in a fresh application without redispatch', async () => {
    const { app, snapshot, model, generate, runs, ports } = setup(); const id = randomUUID();
    const original = runs.writeOutcome.bind(runs);
    vi.spyOn(runs, 'writeOutcome').mockImplementationOnce((...args) => { original(...args); throw new Error('lost archive acknowledgement'); });
    await expect(app.generate(snapshot.snapshotId, model, id)).rejects.toThrow('lost archive acknowledgement');
    expect(runs.read(id).attempts[0].outcome).toBeUndefined();
    const reopened = new KnowledgeApplication(ports); const recovered = await reopened.generate(snapshot.snapshotId, model, id);
    expect(recovered.status).toBe('completed'); expect(recovered.attempts[0].outcome).toBeDefined();
    expect(app.resume(id)).toEqual(recovered); expect(generate).toHaveBeenCalledTimes(1);
    expect(ports.entities.read(id).generation).toBe(1); expect(ports.knowledge.list()).toHaveLength(1);
    expect((await app.generate(snapshot.snapshotId, model)).status).toBe('completed'); expect(generate).toHaveBeenCalledTimes(2);
  });
  it('recovers a lost manifest acknowledgement and preserves one frozen birth across overlapping resumes', async () => {
    const { app, snapshot, model, runs, ports, generate } = setup(); const id = randomUUID();
    const save = runs.save.bind(runs); let reentered = false, lostAcknowledgement = false;
    vi.spyOn(runs, 'save').mockImplementation((run, generation) => {
      if (run.status === 'prepared' && !reentered) { reentered = true; new KnowledgeApplication(ports).resume(id); }
      save(run, generation);
      if (run.generation === 2 && !lostAcknowledgement) { lostAcknowledgement = true; throw new Error('lost manifest acknowledgement'); }
    });
    const run = await app.generate(snapshot.snapshotId, model, id);
    expect(run.status).toBe('completed'); expect(reentered).toBe(true); expect(generate).toHaveBeenCalledTimes(1);
    expect(ports.entities.read(id).generation).toBe(1); expect(ports.knowledge.list()).toHaveLength(1);
    expect(ports.knowledge.list()[0].generation).toBe(1);
    expect(app.resume(id)).toEqual(run);
  });
  it('preserves invalid-output evidence, rejects oversized responses once, and completes an empty result at the limit', async () => {
    const { app, snapshot, model, generate, runs, ports, root } = setup();
    generate.mockResolvedValue({ output: 'invalid JSON', durationMs: 1 });
    const invalid = await app.generate(snapshot.snapshotId, model);
    expect(invalid).toMatchObject({ status: 'failed', rawOutput: 'invalid JSON' });
    expect(app.list()).toEqual([]);

    const empty = '{"responseKind":"knowledge-extraction","schemaVersion":4,"entities":[],"mentions":[],"proposals":[]}';
    // The v5 admission guard keeps the existing JavaScript string-length boundary after native archival.
    const maxOutputLength = 2 * 1024 * 1024;
    generate.mockResolvedValue({ output: empty.padEnd(maxOutputLength + 1, ' '), durationMs: 1 });
    const runId = randomUUID();
    const failed = await app.generate(snapshot.snapshotId, model, runId);
    expect(failed).toMatchObject({ schemaVersion: 5, status: 'failed', error: 'Extraction response exceeds capacity.', intents: [], committed: [] });
    expect(ports.entities.list()).toEqual({ histories: [], unavailable: 0 }); expect(app.list()).toEqual([]);
    expect(runs.read(runId)).toEqual(failed);
    const archived = runs.readOutcome(runId, failed.attempts[0].attemptId, failed.attempts[0].outcome);
    expect(archived.outcome.outcomeKind).toBe('model-port-projection');
    if (archived.outcome.outcomeKind !== 'exception') expect(archived.outcome.result.output).toHaveLength(maxOutputLength + 1);
    const failedFile = join(root, 'extraction-runs', `${runId}.json`), failedBytes = readFileSync(failedFile);
    expect(await app.generate(snapshot.snapshotId, model, runId)).toEqual(failed);
    expect(app.resume(runId)).toEqual(failed);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(readFileSync(failedFile)).toEqual(failedBytes);

    const atLimit = empty.padEnd(maxOutputLength, ' ');
    generate.mockResolvedValue({ output: atLimit, durationMs: 1 });
    const completed = await app.generate(snapshot.snapshotId, model);
    expect(completed).toMatchObject({ schemaVersion: 5, status: 'completed', rawOutput: atLimit, committed: [] });
    expect(runs.read(completed.runId)).toEqual(completed);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(readFileSync(failedFile)).toEqual(failedBytes);
  });
  it('binds corrections to a new analysis and knowledge revision without changing historical positions', async () => {
    const { app, snapshot, model, root } = setup();
    const run = await app.generate(snapshot.snapshotId, model);
    const { knowledgeId, revisionId } = run.committed[0];
    const before = app.detail(knowledgeId);
    const draft = structuredClone({ title: before.revision.title, content: before.revision.content,
      entities: before.revision.entities, evidence: before.revision.evidence });
    const analysis = app.entities(run.runId);
    const edit = structuredClone({ entities: analysis.revision.entities, mentions: analysis.revision.mentions });
    edit.entities[0].label = '项目 Alpha';
    const historyBytes = () => Object.fromEntries(['entities', 'items', 'extraction-runs'].flatMap(directory =>
      readdirSync(join(root, directory), { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.json')).sort().map(name => {
        const path = join(root, directory, name);
        return [path, readFileSync(path, 'utf8')] as const;
      })));
    const originalBytes = historyBytes();
    const duplicateEntity = structuredClone(edit);
    duplicateEntity.entities[0].entityId = 'new:project';
    duplicateEntity.mentions[0].entityId = 'new:project';
    duplicateEntity.entities.push(structuredClone(duplicateEntity.entities[0]));
    const duplicateMention = structuredClone(edit);
    duplicateMention.mentions[0].mentionId = 'new:mention';
    duplicateMention.mentions.push(structuredClone(duplicateMention.mentions[0]));
    const unresolvedCandidate = structuredClone(edit);
    unresolvedCandidate.entities.forEach(entity => {
      entity.identityStatus = 'unresolved'; entity.uncertainties = ['来源尚未消解该对象'];
    });
    unresolvedCandidate.entities[0].possibleEntityIds = [unresolvedCandidate.entities[1].entityId];
    for (const [invalid, message] of [
      [duplicateEntity, 'Duplicate correction identity'],
      [duplicateMention, 'Duplicate correction identity'],
      [unresolvedCandidate, 'unresolved_possible_entity'],
    ] as const) {
      expect(() => app.correctEntities(run.runId, analysis.revision.revisionId, analysis.history.generation,
        invalid, '拒绝不闭合或重复身份')).toThrow(message);
      expect(historyBytes()).toEqual(originalBytes);
      expect(app.entities(run.runId).history.generation).toBe(1);
    }
    const corrected = app.correctEntities(run.runId, analysis.revision.revisionId, analysis.history.generation, edit, '明确项目');
    expect(corrected.history.generation).toBe(2);
    expect(app.entities(run.runId, analysis.revision.revisionId).revision).toEqual(analysis.revision);
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
  it('replaces citations across excerpts in the same window with exact repeated UTF-16 ranges', async () => {
    const text = '😀 Alpha 使用 Beta；限于本次；限于本次。';
    const extra = 'Alpha 使用 Beta，限于本次；没有长期验证。';
    const { app, snapshot, model, root, generate } = setup(text, [extra]);
    const run = await app.generate(snapshot.snapshotId, model); const { knowledgeId, revisionId } = run.committed[0];
    const runFile = join(root, 'extraction-runs', run.runId + '.json'); const runBytes = readFileSync(runFile);
    const before = app.detail(knowledgeId); const quality = app.quality();
    app.maintain(knowledgeId, revisionId, 'retain', '保留待修订依据', before.history.generation);
    const retained = app.detail(knowledgeId);
    const extraRef = snapshot.excerpts.find(excerpt => excerpt.text === extra)!.evidenceRef;
    const evidence = before.revision.evidence[0];
    const draft = { title: before.revision.title, content: structuredClone(before.revision.content), entities: before.revision.entities,
      evidence: [{ ...evidence, evidenceRef: extraRef }, { ...evidence, evidenceLinkId: 'condition-link', interpretation: '原文中重复出现的适用条件' }] };
    draft.content.statements[0].context.conditions = ['限于本次'];
    draft.content.statements[0].context.unknowns = ['没有长期验证'];
    const citationLocators: KnowledgeCitationLocator[] = [
      { evidenceLinkId: evidence.evidenceLinkId, selection: { evidenceRef: extraRef, quote: extra } },
      { evidenceLinkId: 'condition-link', selection: { evidenceRef: evidence.evidenceRef, quote: '限于本次', occurrence: 0 } },
      { evidenceLinkId: 'condition-link', selection: { evidenceRef: evidence.evidenceRef, quote: '限于本次', occurrence: 1 } },
    ];
    const after = await executeKnowledgeOperation(app, { operation: 'revise', id: knowledgeId, revision: revisionId,
      generation: retained.history.generation, draft, reason: '补齐同窗适用条件及未知信息的直接定位', citationLocators });
    const first = text.indexOf('限于本次'); const second = text.indexOf('限于本次', first + 1);
    expect(after.grounding.citations).toEqual([
      { evidenceLinkId: evidence.evidenceLinkId, selection: { evidenceRef: extraRef, quote: extra, start: 0, end: extra.length } },
      { evidenceLinkId: 'condition-link', selection: { evidenceRef: evidence.evidenceRef, quote: '限于本次', start: first, end: first + 4 } },
      { evidenceLinkId: 'condition-link', selection: { evidenceRef: evidence.evidenceRef, quote: '限于本次', start: second, end: second + 4 } },
    ]);
    expect(after.maintenance).toBeNull();
    expect(after.grounding.sourceBindings).toEqual([{ snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion,
      evidenceRefs: [extraRef, evidence.evidenceRef] }]);
    expect(app.detail(knowledgeId, revisionId).grounding).toEqual(before.grounding);
    expect(app.detail(knowledgeId, revisionId).maintenance?.choice).toBe('retain');
    expect(readFileSync(runFile)).toEqual(runBytes); expect(app.quality()).toEqual(quality);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it.each(['empty', 'capacity', 'offset', 'nonexact', 'ambiguous', 'occurrence', 'negative-occurrence', 'outside', 'unknown-link', 'wrong-excerpt', 'uncovered-link'] as const)(
    'rejects %s replacement citations before writing and preserves the saved revision', async target => {
      const { app, snapshot, model, root, knowledge, generate } = setup('Alpha 使用 Beta；重复；重复。', ['Alpha 仅限本次。']);
      const run = await app.generate(snapshot.snapshotId, model); const { knowledgeId, revisionId } = run.committed[0];
      const before = app.detail(knowledgeId);
      const draft = { title: before.revision.title, content: before.revision.content, entities: before.revision.entities,
        evidence: structuredClone(before.revision.evidence) };
      const link = draft.evidence[0];
      const locator = { evidenceLinkId: link.evidenceLinkId, selection: { evidenceRef: link.evidenceRef, quote: 'Alpha 使用 Beta' } };
      let input: unknown = [locator];
      if (target === 'empty') input = [];
      if (target === 'capacity') input = Array.from({ length: 513 }, () => locator);
      if (target === 'offset') input = [{ ...locator, selection: { ...locator.selection, start: 0 } }];
      if (target === 'nonexact') locator.selection.quote = 'Alpha  使用 Beta';
      if (target === 'ambiguous') locator.selection.quote = '重复';
      if (target === 'occurrence') input = [{ ...locator, selection: { ...locator.selection, quote: '重复', occurrence: 2 } }];
      if (target === 'negative-occurrence') input = [{ ...locator, selection: { ...locator.selection, occurrence: -1 } }];
      if (target === 'outside') locator.selection.evidenceRef = 'outside-window';
      if (target === 'unknown-link') locator.evidenceLinkId = 'not-in-draft';
      if (target === 'wrong-excerpt') { locator.selection.evidenceRef = snapshot.excerpts[1].evidenceRef; locator.selection.quote = 'Alpha 仅限本次。'; }
      if (target === 'uncovered-link') draft.evidence.push({ ...link, evidenceLinkId: 'missing-citation' });
      const itemPath = join(root, 'items', readdirSync(join(root, 'items')).find(name => name.endsWith('.json'))!);
      const bytes = readFileSync(itemPath); const write = vi.spyOn(knowledge, 'write');
      expect(() => app.revise(knowledgeId, revisionId, before.history.generation, draft, '无效定位不得追加', input))
        .toThrow(KnowledgeCitationRevisionError);
      expect(write).not.toHaveBeenCalled(); expect(readFileSync(itemPath)).toEqual(bytes);
      expect(app.detail(knowledgeId).history).toEqual(before.history); expect(generate).toHaveBeenCalledTimes(1);
    });
  it('rejects foreign windows, stale generations, stale heads and missing sources without appending citation revisions', async () => {
    const { app, snapshot, model, root, source, knowledge } = setup();
    const run = await app.generate(snapshot.snapshotId, model); const { knowledgeId, revisionId } = run.committed[0];
    const before = app.detail(knowledgeId);
    const draft = { title: before.revision.title, content: before.revision.content, entities: before.revision.entities, evidence: before.revision.evidence };
    const citationLocators = before.grounding.citations.map(citation => ({ evidenceLinkId: citation.evidenceLinkId,
      selection: { evidenceRef: citation.selection.evidenceRef, quote: citation.selection.quote } }));
    const itemPath = join(root, 'items', readdirSync(join(root, 'items')).find(name => name.endsWith('.json'))!);
    const birthBytes = readFileSync(itemPath);
    const foreignSnapshot = app.capture({ path: source }); const foreignRun = await app.generate(foreignSnapshot.snapshotId, model);
    const foreign = app.entities(foreignRun.runId);
    expect(() => app.reviseUsingEntities(knowledgeId, revisionId, 1, foreignRun.runId, foreign.revision.revisionId,
      draft, '外窗不得改绑', undefined, citationLocators)).toThrow('different evidence window');
    expect(readFileSync(itemPath)).toEqual(birthBytes);
    const write = vi.spyOn(knowledge, 'write').mockImplementationOnce(() => { throw new Error('fixture persistence failure'); });
    expect(() => app.revise(knowledgeId, revisionId, 1, draft, '存储未提交', citationLocators)).toThrow('fixture persistence failure');
    write.mockRestore(); expect(readFileSync(itemPath)).toEqual(birthBytes);
    app.maintain(knowledgeId, revisionId, 'retain', '先核对维护状态', 1);
    const retainedBytes = readFileSync(itemPath);
    expect(() => app.revise(knowledgeId, revisionId, 1, draft, '旧 generation', citationLocators)).toThrow('conflict');
    expect(readFileSync(itemPath)).toEqual(retainedBytes);
    const revised = app.revise(knowledgeId, revisionId, 2, draft, '明确更新引用', citationLocators);
    const revisedBytes = readFileSync(itemPath);
    expect(() => app.revise(knowledgeId, revisionId, 3, draft, '旧 head', citationLocators)).toThrow('conflict');
    expect(readFileSync(itemPath)).toEqual(revisedBytes);
    app.deleteSource(snapshot.snapshotId);
    expect(() => app.revise(knowledgeId, revised.revision.revisionId, revised.history.generation,
      draft, '来源已不可用', citationLocators)).toThrow('Entity source unavailable');
    expect(readFileSync(itemPath)).toEqual(revisedBytes);
    expect(app.detail(knowledgeId, revisionId).grounding).toEqual(before.grounding);
  });
  it.each(['revise', 'apply-entities'] as const)('checks %s citation input with the shared schema and a bounded failure code', operation => {
    const base = { operation, id: 'knowledge-id', revision: 'revision-id', generation: 1, draft: {}, reason: '明确更新引用',
      ...(operation === 'apply-entities' ? { analysisId: randomUUID(), entityRevision: randomUUID() } : {}) };
    const locator = { evidenceLinkId: 'link', selection: { evidenceRef: 'ref', quote: '原文' } };
    expect(KnowledgeOperationSchema.safeParse(base).success).toBe(true);
    expect(KnowledgeOperationSchema.safeParse({ ...base, citationLocators: [locator] }).success).toBe(true);
    for (const citationLocators of [[], Array.from({ length: 513 }, () => locator), [{ ...locator, selection: { ...locator.selection, start: 0 } }]]) {
      const parsed = KnowledgeOperationSchema.safeParse({ ...base, citationLocators });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(knowledgeFailureCode(parsed.error)).toBe('knowledge_citations_invalid');
    }
    const mixed = KnowledgeOperationSchema.safeParse({ ...base, generation: 0, citationLocators: [] });
    expect(mixed.success).toBe(false);
    if (!mixed.success) expect(knowledgeFailureCode(mixed.error)).toBe('knowledge_request_failed');
    expect(knowledgeFailureCode(new KnowledgeCitationRevisionError())).toBe('knowledge_citations_invalid');
    expect(knowledgeFailureCode(new Error('arbitrary citationLocators text'))).toBe('knowledge_request_failed');
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
    expect(after.grounding.citations).toEqual(before.grounding.citations);
    expect(after.reviewStatus).toBe('pending');
    expect(after.maintenance).toBeNull();
    expect(app.list()[0]).toMatchObject({ revisionId: after.revision.revisionId, title: draft.title, choice: null, reviewStatus: 'pending' });
    expect(app.detail(knowledgeId, revisionId).maintenance?.choice).toBe('retain');
    app.deleteSource(snapshot.snapshotId);
    expect(app.detail(knowledgeId).sources[0]).toMatchObject({ status: 'unavailable', reason: 'deleted' });
  });
});
