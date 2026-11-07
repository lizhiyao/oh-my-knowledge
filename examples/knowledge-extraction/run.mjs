#!/usr/bin/env node

// Repository-only dogfood: these built application modules are not a public SDK API.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const caseDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(process.env.OMK_PACKAGE_ROOT ?? join(caseDirectory, '../..'));
const applicationEntry = join(packageRoot, 'dist/knowledge/application/local.js');
assert.ok(existsSync(applicationEntry), 'Run yarn build:runtime from the OMK source checkout before this example.');
const { createLocalKnowledgeApplication } = await import(pathToFileURL(applicationEntry).href);
const sandbox = mkdtempSync(join(tmpdir(), 'omk-knowledge-example-'));
let summary;

try {
  const source = join(sandbox, 'authored-source.jsonl');
  const workspace = join(sandbox, 'knowledge');
  const message = 'Alpha 使用 Beta';
  const sourceBytes = [
    { type: 'session_meta', payload: { id: 'synthetic-knowledge-example' } },
    { type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: message }] } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n';
  writeFileSync(source, sourceBytes);

  const operator = { actorKind: 'agent', actorId: 'knowledge-extraction-example-operator', executionRef: `node-example:${randomUUID()}` };
  const selections = [{ sourceKind: 'agent_trace', sourceId: 'authored-teaching-source', traceKind: 'codex',
    recordRanges: [{ startRecord: 1, endRecord: 1 }] }];
  const app = createLocalKnowledgeApplication(workspace, { actor: operator, sourceScope: { scopeVersion: 'knowledge-source-scope/v1', projects: [],
    traces: [{ sourceId: 'authored-teaching-source', traceKind: 'codex', path: source,
      material: { materialType: 'discussion', reason: 'Authored teaching message, not a native model execution.' } }] } });
  const preview = app.previewSources(selections);
  assert.equal(existsSync(join(workspace, 'sources')), false);
  assert.equal(preview.savePlan.actualSnapshotsWritten, 0);
  assert.equal(preview.sendDraft.authorization, 'not_granted');
  assert.equal(preview.items[0].excerpts[0].text, message);
  const captured = app.captureSources({ previewId: preview.previewId, previewDigest: preview.previewDigest });
  assert.equal(captured.sendAuthorization, 'not_granted');
  assert.equal(captured.sources.length, 1);
  const snapshot = captured.sources[0].snapshot;
  assert.equal(snapshot.projectionVersion, 'knowledge-window-v3');
  assert.equal(snapshot.rawUnits[0].coordinate.recordIndex, 1);
  assert.equal(snapshot.excerpts.length, 1);
  const sourceRefs = [{ snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion }];
  const evidenceRef = snapshot.excerpts[0].evidenceRef;
  const entities = ['Alpha', 'Beta'].map((label, index) => ({
    entityId: `entity-${index}`, label, description: '合成窗口明确命名的对象', qualifiers: [],
    identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [],
    referentKind: 'object', componentLink: null, collectionLink: null,
    mentions: [{ mentionKey: 'name', selection: { evidenceRef, quote: label, contextBefore: null, contextAfter: null },
      basis: 'explicit', rationale: '逐字对象名称' }],
  }));
  // Authored current responses, not native model captures or semantic-quality annotations.
  const bodyText = '来源报告 Alpha 使用 Beta；仅限本合成窗口，版本、结果和事实发生时间未知。';
  const bodyResponse = {
    responseKind: 'knowledge-body-generation', schemaVersion: 3, passageIndexDigest: null,
    proposals: [{ proposalId: 'candidate', title: message, requiredContexts: [],
      segments: [{ segmentId: 'usage', text: bodyText, evidence: [{ startPassageId: 'p0', endPassageId: 'p0',
        basis: 'source_assertion', interpretation: '只记录来源说法，尚待核对' }] }],
      organization: { knowledgeKind: 'fact' }, reuseRationale: '演示后续核对相同条件下的来源说法' }],
  };
  const associationResponse = {
    responseKind: 'knowledge-association-generation', schemaVersion: 3,
    catalogs: [{ sourceKey: 's0', entities }],
    associations: [{ bodyKey: 'b0', segmentDecisions: [{ segmentId: 'usage', decisionKind: 'mapped',
      entityRefs: entities.map(entity => ({ sourceKey: 's0', entityId: entity.entityId, mentionKeys: ['name'] })),
      reason: '合成来源明确命名两个对象；关联仍待核对。' }], typedRelations: [{ relationId: 'reported-use', segmentIds: ['usage'], subject: { sourceKey: 's0', entityId: 'entity-0' },
      object: { sourceKey: 's0', entityId: 'entity-1' }, relation: 'source reports use, limited to this authored window', modality: 'descriptive', polarity: 'positive',
      evidence: [{ segmentId: 'usage', evidenceIndex: 0 }], issues: [] }], issues: [] }],
  };
  const rawByStage = {};
  let fixtureInvocations = 0;
  const fixture = {
    executor: 'authored-fixture', model: 'not-a-model', timeoutMs: 300_000,
    inspect() {
      return { producerId: 'authored-example/v3', producerRevision: 'body-first-direct-association', sourceChannels: [],
        maxOutcomeJsonBytes: 1024 * 1024, proof: { nativeObserved: false, scope: 'authored demonstration only' } };
    },
    async invoke(profile, input, _signal, beforeDispatch) {
      const parsed = JSON.parse(input);
      assert.ok(!input.includes(sandbox)); assert.equal(parsed.rawUnits, undefined);
      assert.equal(parsed.inputVersion, profile.stageKind === 'body' ? 'knowledge-body-generation-input/v5' : profile.stageKind === 'body_draft' ? 'knowledge-writing-draft-input/v1' : 'knowledge-source-generation-input/v1');
      assert.equal(parsed.sourceSetId, prepared.journal.sourceSetId); assert.equal(parsed.sources.length, 1);
      const selected = parsed.sources[0];
      assert.equal(selected.sourceKey, 's0');
      const excerpts = profile.stageKind === 'body' ? selected.excerpts.map(({ passages, ...excerpt }) => ({ ...excerpt, text: passages.map(part => part.text).join('') })) : selected.excerpts;
      assert.deepEqual(excerpts, snapshot.excerpts); assert.deepEqual(selected.limitations, snapshot.limitations);
      assert.equal(selected.source.snapshotId, snapshot.snapshotId); assert.equal(selected.source.sourceVersion, snapshot.sourceVersion);
      for (const key of ['identity', 'selection', 'material', 'provenance']) assert.deepEqual(selected.source[key], snapshot[key]);
      assert.equal(selected.source.sourcePath, undefined); assert.equal(selected.source.capturedAt, undefined); assert.equal(selected.rawUnits, undefined);
      assert.equal(selected.source.sourceKind, 'agent_trace');
      if (profile.stageKind === 'association') {
        assert.equal(app.list().length, 1); assert.equal(parsed.bodies.length, 1); assert.equal(parsed.bodies[0].bodyKey, 'b0');
        assert.equal(parsed.bodies[0].content.segments[0].text, bodyText);
        assert.equal(app.detail(parsed.bodies[0].bodyRef.knowledgeId).revision.bodyDigest, parsed.bodies[0].bodyRef.bodyDigest);
      } else assert.equal(parsed.bodies, undefined);
      if (profile.stageKind === 'body') {
        assert.equal(parsed.ledger, undefined);
        assert.equal(parsed.writingDraft.text, 'Unverified teaching draft; use original source evidence.');
        bodyResponse.passageIndexDigest = parsed.passageIndexDigest;
      }
      const output = profile.stageKind === 'body_draft' ? { responseKind: 'knowledge-writing-draft', schemaVersion: 1, text: 'Unverified teaching draft; use original source evidence.' } : profile.stageKind === 'body' ? bodyResponse : associationResponse;
      beforeDispatch(); fixtureInvocations++;
      assert.equal(rawByStage[profile.stageKind], undefined); rawByStage[profile.stageKind] = JSON.stringify(output);
      // Missing provider token/cost measurements remain missing, not fabricated zeros.
      return { outcomeKind: 'result', result: { ok: true, output: rawByStage[profile.stageKind], authoredFixture: true } };
    },
  };
  // This helper sends only an already prepared phase; it never prepares the next one or records a decision.
  async function confirmPhase(state) {
    const stage = state.journal.stages.at(-1), before = fixtureInvocations;
    await assert.rejects(app.continueStage(state.journal.runId, state.journal.generation, fixture), /Confirm the exact prepared generation request/);
    assert.equal(fixtureInvocations, before);
    const result = await app.continueStage(state.journal.runId, state.journal.generation, fixture, undefined, { confirmedRequestDigest: stage.requestDigest });
    assert.equal(fixtureInvocations, before + 1); assert.equal(result.journal.stages.length, state.journal.stages.length);
    return result;
  }
  const prepared = app.prepareGeneration(sourceRefs, fixture);
  assert.equal(prepared.journal.workflowId, 'knowledge-body-first/v8'); assert.equal(prepared.journal.schemaVersion, 8);
  assert.equal(prepared.journal.stages[0].stageKind, 'body_draft'); assert.equal(prepared.journal.stages[0].state, 'prepared'); assert.equal(fixtureInvocations, 0);
  await assert.rejects(app.generate(sourceRefs, fixture, prepared.journal.runId), /Confirm the exact prepared generation request/);
  const written = await confirmPhase(prepared);
  assert.ok(written.journal.writingDraftRef); assert.equal(app.list().length, 0);
  const bodyPrepared = app.prepareGeneration(sourceRefs, fixture, prepared.journal.runId);
  assert.equal(fixtureInvocations, 1); assert.equal(bodyPrepared.journal.stages.at(-1).stageKind, 'body');
  const body = await confirmPhase(bodyPrepared);
  assert.equal(body.journal.bodies.length, 1); assert.equal(body.journal.stages.length, 2); assert.equal(body.journal.status, 'completed');
  assert.equal(body.journal.ledgerRef, undefined); assert.equal(body.journal.coverageRef, undefined);
  // Association is explicitly prepared after saving the body; no source analysis or decision is needed.
  const associationPrepared = app.prepareAssociationRebuild(sourceRefs, body.journal.bodies, fixture);
  assert.equal(fixtureInvocations, 2); assert.equal(associationPrepared.journal.stages[0].stageKind, 'association');
  const run = await confirmPhase(associationPrepared);
  assert.equal(run.journal.status, 'completed'); assert.equal(run.journal.workflowId, 'knowledge-body-first/v8'); assert.equal(run.journal.bodies.length, 1);
  assert.deepEqual(run.journal.stages.map(stage => stage.stageKind), ['association']);
  for (const stage of run.journal.stages) { assert.equal(stage.state, 'completed'); assert.deepEqual(stage.rejected ?? [], []); }

  // Reopening the same identity only replays durable publication; it never calls any fixture phase again.
  const reopened = createLocalKnowledgeApplication(workspace);
  const replay = await reopened.generate(sourceRefs, fixture);
  assert.deepEqual(replay, body); assert.equal(fixtureInvocations, 3);
  const originals = [body, run].flatMap(state => reopened.inspect(state.journal.runId).nativeOutcomes);
  assert.equal(originals.length, 3);
  for (const original of originals) {
    assert.equal(original.outcome.outcomeKind, 'result');
    assert.equal(original.outcome.result.output, rawByStage[original.stageKind]);
    assert.equal(original.outcome.result.inputTokens, undefined);
    assert.equal(original.outcome.result.costUSD, undefined);
  }
  const stored = reopened.detail(run.journal.bodies[0].knowledgeId);
  assert.equal(stored.reviewStatus, 'pending'); assert.equal(stored.maintenance, null);
  assert.equal(stored.revision.content.segments[0].text, bodyText);
  const bodyEvidence = stored.revision.content.segments[0].evidence[0];
  assert.equal(bodyEvidence.basis, 'source_assertion');
  assert.equal(bodyEvidence.source.snapshotId, snapshot.snapshotId);
  assert.equal(bodyEvidence.source.sourceVersion, snapshot.sourceVersion);
  assert.equal(stored.sources[0].status, 'available');
  assert.equal(stored.sources[0].snapshot.snapshotId, snapshot.snapshotId);
  assert.equal(stored.sources[0].snapshot.sourceVersion, snapshot.sourceVersion);
  assert.equal(stored.derivedAssociations.status, 'available');
  assert.equal(stored.derivedAssociations.reviewStatus, 'pending');
  const projection = stored.derivedAssociations.revision;
  assert.equal(projection.typedRelations.length, 1);
  assert.equal(reopened.graph().edges.filter(edge => edge.edgeKind === 'typed_relation').length, 1);
  assert.equal(existsSync(join(workspace, 'source-ledgers')), false); assert.equal(existsSync(join(workspace, 'source-coverage')), false);
  assert.deepEqual(projection.bodyRef, run.journal.bodies[0]);
  const analysis = reopened.entities(projection.catalogRefs[0].analysisId, projection.catalogRefs[0].entityRevisionId);
  assert.equal(analysis.revision.entities.length, 2);
  for (const selection of [bodyEvidence.selection, ...analysis.revision.mentions.map(mention => mention.selection)]) {
    const excerpt = stored.sources[0].snapshot.excerpts.find(value => value.evidenceRef === selection.evidenceRef);
    assert.ok(excerpt); assert.equal(excerpt.text.slice(selection.start, selection.end), selection.quote);
  }
  const found = reopened.queryEntities({ query: 'Alpha', analysisId: analysis.history.analysisId });
  assert.equal(found.total, 1); assert.equal(found.rows[0].label, 'Alpha'); assert.equal(found.rows[0].knowledgeCount, 1);
  assert.equal(readFileSync(source, 'utf8'), sourceBytes);
  summary = {
    fixtureInvocations, modelCalls: 0, workflowId: run.journal.workflowId,
    phaseKinds: [body, run].flatMap(state => state.journal.stages.map(stage => stage.stageKind)), generationPhaseKinds: body.journal.stages.map(stage => stage.stageKind), runStatus: run.journal.status,
    candidateCount: run.journal.bodies.length, entityCount: analysis.revision.entities.length,
    reopened: true, sourceBindingVerified: true, entitySearchMatches: found.total,
    linkedKnowledgeCount: found.rows[0].knowledgeCount, reviewStatus: stored.reviewStatus,
    relationCount: projection.typedRelations.length, semanticQuality: 'not_assessed',
    humanReview: 'pending', independentReview: 'pending', associationReview: stored.derivedAssociations.reviewStatus, usageReported: false,
  };
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
assert.equal(existsSync(sandbox), false);
process.stdout.write(JSON.stringify({ ...summary, temporaryWorkspaceRemoved: true }) + '\n');
