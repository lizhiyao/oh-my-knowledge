#!/usr/bin/env node

// Repository-only dogfood: these built application modules are not a public SDK API.
import assert from 'node:assert/strict';
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

  const app = createLocalKnowledgeApplication(workspace);
  const snapshot = app.capture({ path: source, startRecord: 1, endRecord: 1 });
  assert.equal(snapshot.excerpts.length, 1);
  const evidenceRef = snapshot.excerpts[0].evidenceRef;
  const entities = ['Alpha', 'Beta'].map((label, index) => ({
    entityId: `entity-${index}`, label, description: '合成窗口明确命名的对象', qualifiers: [],
    identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [],
    referentKind: 'object', componentRef: null, collection: null,
  }));
  // Two authored current responses, not native model captures or reviewed annotations.
  const bodyText = '来源报告 Alpha 使用 Beta；仅限本合成窗口，版本、结果和事实发生时间未知。';
  const bodyResponse = {
    responseKind: 'knowledge-body-generation', schemaVersion: 1,
    proposals: [{ proposalId: 'candidate', title: message,
      segments: [{ segmentId: 'usage', text: bodyText, evidence: [{ evidenceRef, quote: message, occurrence: null,
        basis: 'source_assertion', interpretation: '只记录来源说法，尚待核对' }] }],
      organization: { knowledgeKind: 'fact' }, reuseRationale: '演示后续核对相同条件下的来源说法' }],
  };
  const associationResponse = {
    responseKind: 'knowledge-association-generation', schemaVersion: 2,
    catalogs: [{ sourceKey: 's0', entities,
    mentions: entities.map((entity, index) => ({
      mentionId: `mention-${index}`, entityId: entity.entityId,
      selection: { evidenceRef, quote: entity.label, occurrence: null }, basis: 'explicit', rationale: '逐字对象名称',
    })) }],
    associations: [{ bodyKey: 'b0', segmentEntityRefs: entities.map((entity, index) => ({
      segmentId: 'usage', sourceKey: 's0', entityId: entity.entityId, mentionIds: [`mention-${index}`],
    })), typedRelations: [], issues: [] }],
  };
  const rawByStage = { body: JSON.stringify(bodyResponse), association: JSON.stringify(associationResponse) };
  let fixtureInvocations = 0;
  const fixture = {
    executor: 'authored-fixture', model: 'not-a-model', timeoutMs: 300_000,
    inspect() {
      return { producerId: 'authored-example/v2', producerRevision: 'body-and-association', sourceChannels: [],
        maxOutcomeJsonBytes: 1024 * 1024, proof: { nativeObserved: false, scope: 'authored teaching fixture only' } };
    },
    async invoke(profile, input, _signal, beforeDispatch) {
      const parsed = JSON.parse(input);
      const selected = profile.stageKind === 'association' ? parsed.sources[0] : parsed;
      if (profile.stageKind === 'association') { assert.equal(parsed.sources.length, 1); assert.equal(selected.sourceKey, 's0'); }
      assert.deepEqual(selected.excerpts, snapshot.excerpts);
      assert.deepEqual(selected.limitations, snapshot.limitations);
      assert.equal(selected.source.snapshotId, snapshot.snapshotId);
      assert.equal(selected.source.sourceVersion, snapshot.sourceVersion);
      assert.equal(selected.source.sourcePath, undefined);
      if (profile.stageKind === 'association') {
        // The independent second phase consumes a body already committed to public storage.
        assert.equal(app.list().length, 1);
        assert.equal(parsed.bodies.length, 1);
        assert.equal(parsed.bodies[0].bodyKey, 'b0');
        assert.equal(parsed.bodies[0].content.segments[0].text, bodyText);
        assert.equal(app.detail(parsed.bodies[0].bodyRef.knowledgeId).revision.bodyDigest, parsed.bodies[0].bodyRef.bodyDigest);
      } else {
        assert.equal(profile.stageKind, 'body'); assert.equal(parsed.bodies, undefined);
      }
      beforeDispatch(); fixtureInvocations++;
      // Missing provider token/cost measurements remain missing, not fabricated zeros.
      return { outcomeKind: 'result', result: { ok: true, output: rawByStage[profile.stageKind], authoredFixture: true } };
    },
  };
  const run = await app.generate(snapshot.snapshotId, fixture);
  assert.equal(run.journal.status, 'completed');
  assert.equal(run.journal.workflowId, 'knowledge-body-first/v2');
  assert.equal(run.journal.bodies.length, 1);
  assert.deepEqual(run.journal.stages.map(stage => stage.stageKind), ['body', 'association']);
  for (const stage of run.journal.stages) {
    assert.equal(stage.state, 'completed'); assert.deepEqual(stage.rejected ?? [], []);
  }

  // Reopening the same identity only replays durable publication; it never calls either fixture phase again.
  const reopened = createLocalKnowledgeApplication(workspace);
  const replay = await reopened.generate(snapshot.snapshotId, fixture, run.journal.runId);
  assert.deepEqual(replay, run); assert.equal(fixtureInvocations, 2);
  const originals = reopened.inspect(run.journal.runId).nativeOutcomes;
  assert.equal(originals.length, 2);
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
  assert.equal(stored.sources[0].window.snapshotId, snapshot.snapshotId);
  assert.equal(stored.sources[0].window.sourceVersion, snapshot.sourceVersion);
  assert.equal(stored.derivedAssociations.status, 'available');
  assert.equal(stored.derivedAssociations.reviewStatus, 'pending');
  const projection = stored.derivedAssociations.revision;
  assert.deepEqual(projection.bodyRef, run.journal.bodies[0]);
  const analysis = reopened.entities(projection.catalogRefs[0].analysisId, projection.catalogRefs[0].entityRevisionId);
  assert.equal(analysis.revision.entities.length, 2);
  for (const selection of [bodyEvidence.selection, ...analysis.revision.mentions.map(mention => mention.selection)]) {
    const excerpt = stored.sources[0].window.excerpts.find(value => value.evidenceRef === selection.evidenceRef);
    assert.ok(excerpt); assert.equal(excerpt.text.slice(selection.start, selection.end), selection.quote);
  }
  const found = reopened.queryEntities({ query: 'Alpha', analysisId: analysis.history.analysisId });
  assert.equal(found.total, 1); assert.equal(found.rows[0].label, 'Alpha'); assert.equal(found.rows[0].knowledgeCount, 1);
  assert.equal(readFileSync(source, 'utf8'), sourceBytes);
  summary = {
    fixtureInvocations, modelCalls: 0, workflowId: run.journal.workflowId,
    phaseKinds: run.journal.stages.map(stage => stage.stageKind), runStatus: run.journal.status,
    candidateCount: run.journal.bodies.length, entityCount: analysis.revision.entities.length,
    reopened: true, sourceBindingVerified: true, entitySearchMatches: found.total,
    linkedKnowledgeCount: found.rows[0].knowledgeCount, reviewStatus: stored.reviewStatus,
    humanReview: 'pending', independentReview: 'pending', associationReview: stored.derivedAssociations.reviewStatus, usageReported: false,
  };
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
assert.equal(existsSync(sandbox), false);
process.stdout.write(JSON.stringify({ ...summary, temporaryWorkspaceRemoved: true }) + '\n');
