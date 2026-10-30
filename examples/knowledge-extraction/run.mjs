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
  const app = createLocalKnowledgeApplication(workspace, { actor: operator, reviewActor: operator, sourceScope: { scopeVersion: 'knowledge-source-scope/v1', projects: [],
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
    responseKind: 'knowledge-body-generation', schemaVersion: 2,
    proposals: [{ proposalId: 'candidate', title: message, requiredContexts: [],
      segments: [{ segmentId: 'usage', text: bodyText, evidence: [{ evidenceRef, quote: message, contextBefore: null, contextAfter: null,
        basis: 'source_assertion', interpretation: '只记录来源说法，尚待核对' }] }],
      organization: { knowledgeKind: 'fact' }, reuseRationale: '演示后续核对相同条件下的来源说法' }],
  };
  const associationResponse = {
    responseKind: 'knowledge-association-generation', schemaVersion: 3,
    catalogs: [{ sourceKey: 's0', entities }],
    associations: [{ bodyKey: 'b0', segmentDecisions: [{ segmentId: 'usage', decisionKind: 'mapped',
      entityRefs: entities.map(entity => ({ sourceKey: 's0', entityId: entity.entityId, mentionKeys: ['name'] })),
      reason: '合成来源明确命名两个对象；关联仍待核对。' }], typedRelations: [], issues: [] }],
  };
  const target = (targetKind, values) => ({ targetKind, unitKey: null, itemId: null, facetId: null, bodyKey: null, segmentId: null, ...values });
  const quote = (unitKey, text) => ({ unitKey, quote: text, contextBefore: null, contextAfter: null });
  function authoredLedger(input) {
    return { responseKind: 'knowledge-source-ledger', schemaVersion: 2,
      unitDispositions: input.units.map(unit => ({ unitKey: unit.unitKey, disposition: 'retain',
        reason: 'Authored demonstration only; preserve each delivered unit explicitly.' })),
      items: input.units.map((unit, index) => ({ itemId: `item-${index}`,
        statement: unit.unitKind === 'source_metadata' ? 'The metadata identifies this teaching source and its selected range.' : 'The teaching message reports Alpha using Beta.',
        disposition: 'retain', reason: 'Authored demonstration only, without factual acceptance.', equivalentItemIds: [], evidence: [quote(unit.unitKey, unit.text)],
        facets: unit.unitKind === 'excerpt_text' ? [{ facetId: 'time-unknown', statement: 'The selected message does not supply the fact-occurrence time.',
          epistemicStatus: 'not_stated', evidence: [] }] : [] })),
      limitations: ['Authored demonstration only; the proposed inventory is fallible and is not Gold.'] };
  }
  function authoredCoverage(input) {
    const base = { coverageTarget: 'knowledge_meaning', status: 'unassessable', factualValue: 'not_applicable',
      reason: 'Authored demonstration only; this check does not establish semantic coverage.', bodyEvidence: [], boundedInput: null };
    const sourceQuote = unitKey => quote(unitKey, input.units.find(unit => unit.unitKey === unitKey).text);
    return { responseKind: 'knowledge-source-coverage', schemaVersion: 1,
      checks: [...input.units.map((unit, index) => ({ ...base, checkId: `unit-${index}`, target: target('source_unit', { unitKey: unit.unitKey }), sourceEvidence: [sourceQuote(unit.unitKey)] })),
        ...input.ledger.data.items.flatMap((item, index) => [{ ...base, checkId: `item-${index}`, target: target('ledger_item', { itemId: item.itemId }),
          sourceEvidence: item.evidence.map(anchor => sourceQuote(anchor.unitKey)) },
          ...item.facets.map((facet, facetIndex) => ({ ...base, checkId: `facet-${index}-${facetIndex}`, target: target('ledger_facet', { itemId: item.itemId, facetId: facet.facetId }),
            coverageTarget: 'factual_value', factualValue: 'unknown', sourceEvidence: [] }))]),
        ...input.bodies.flatMap((body, index) => body.segments.map((segment, segmentIndex) => ({ ...base, checkId: `paragraph-${index}-${segmentIndex}`,
          target: target('body_segment', { bodyKey: body.bodyKey, segmentId: segment.segmentId }), sourceEvidence: [],
          bodyEvidence: [{ bodyKey: body.bodyKey, segmentId: segment.segmentId, quote: segment.text, contextBefore: null, contextAfter: null }] })))],
      findings: [], limitations: ['Authored demonstration only; unknown factual values remain unknown and no model response approves continuation.'] };
  }
  const rawByStage = {};
  let fixtureInvocations = 0;
  const fixture = {
    executor: 'authored-fixture', model: 'not-a-model', timeoutMs: 300_000,
    inspect() {
      return { producerId: 'authored-example/v3', producerRevision: 'four-stage-source-first', sourceChannels: [],
        maxOutcomeJsonBytes: 1024 * 1024, proof: { nativeObserved: false, scope: 'authored demonstration only' } };
    },
    async invoke(profile, input, _signal, beforeDispatch) {
      const parsed = JSON.parse(input), review = profile.stageKind === 'source_ledger' || profile.stageKind === 'source_coverage';
      assert.ok(!input.includes(sandbox)); assert.equal(parsed.rawUnits, undefined);
      if (review) {
        assert.equal(parsed.manifest.inputVersion, 'knowledge-source-generation-input/v2');
        assert.equal(parsed.manifest.sourceSetId, prepared.journal.sourceSetId);
        assert.deepEqual(parsed.manifest.sources.map(value => value.sourceRef), sourceRefs);
        assert.deepEqual(parsed.units.map(unit => unit.unitKind), ['source_metadata', 'excerpt_text']);
        const metadata = JSON.parse(parsed.units[0].text);
        assert.deepEqual(metadata.source.identity, snapshot.identity); assert.deepEqual(metadata.source.selection, snapshot.selection);
        assert.deepEqual(metadata.source.material, snapshot.material); assert.deepEqual(metadata.source.provenance, snapshot.provenance);
        assert.deepEqual(metadata.excerpts, snapshot.excerpts.map(({ text, ...descriptor }) => { void text; return descriptor; }));
        assert.deepEqual(metadata.limitations, snapshot.limitations); assert.equal(metadata.source.rawUnits, undefined); assert.equal(metadata.source.capturedAt, undefined);
        assert.equal(parsed.units[1].text, message); assert.equal(parsed.units[1].evidenceRef, evidenceRef);
      } else {
        assert.equal(parsed.inputVersion, profile.stageKind === 'body' ? 'knowledge-source-generation-input/v2' : 'knowledge-source-generation-input/v1');
        assert.equal(parsed.sourceSetId, prepared.journal.sourceSetId); assert.equal(parsed.sources.length, 1);
        const selected = parsed.sources[0];
        assert.equal(selected.sourceKey, 's0'); assert.deepEqual(selected.excerpts, snapshot.excerpts); assert.deepEqual(selected.limitations, snapshot.limitations);
        assert.equal(selected.source.snapshotId, snapshot.snapshotId); assert.equal(selected.source.sourceVersion, snapshot.sourceVersion);
        assert.equal(selected.source.sourcePath, undefined); assert.equal(selected.source.capturedAt, undefined); assert.equal(selected.rawUnits, undefined);
        assert.equal(selected.source.sourceKind, 'agent_trace'); assert.deepEqual(selected.source.identity, { sourceId: 'authored-teaching-source', traceKind: 'codex' });
      }
      if (profile.stageKind === 'body' || profile.stageKind === 'source_coverage') {
        const ledger = app.sourceLedger(parsed.ledger.ref.ledgerId, parsed.ledger.ref.revisionId);
        assert.deepEqual(parsed.ledger.ref, ledger.ref); assert.deepEqual(parsed.ledger.data, ledger.revision.data);
      }
      if (profile.stageKind === 'source_coverage' || profile.stageKind === 'association') {
        assert.equal(app.list().length, 1); assert.equal(parsed.bodies.length, 1); assert.equal(parsed.bodies[0].bodyKey, 'b0');
        const segments = profile.stageKind === 'association' ? parsed.bodies[0].content.segments : parsed.bodies[0].segments;
        assert.equal(segments[0].text, bodyText);
        assert.equal(app.detail(parsed.bodies[0].bodyRef.knowledgeId).revision.bodyDigest, parsed.bodies[0].bodyRef.bodyDigest);
      } else assert.equal(parsed.bodies, undefined);
      const output = profile.stageKind === 'source_ledger' ? authoredLedger(parsed) : profile.stageKind === 'source_coverage' ? authoredCoverage(parsed)
        : profile.stageKind === 'body' ? bodyResponse : associationResponse;
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
  assert.equal(prepared.journal.workflowId, 'knowledge-body-first/v4'); assert.equal(prepared.journal.schemaVersion, 4);
  assert.equal(prepared.journal.stages[0].stageKind, 'source_ledger'); assert.equal(prepared.journal.stages[0].state, 'prepared'); assert.equal(fixtureInvocations, 0);
  await assert.rejects(app.generate(sourceRefs, fixture, prepared.journal.runId), /Confirm the exact prepared generation request/);
  assert.equal(fixtureInvocations, 0);
  const inventoried = await confirmPhase(prepared);
  assert.ok(inventoried.journal.ledgerRef); assert.equal(inventoried.journal.bodies.length, 0); assert.equal(inventoried.journal.stages.length, 1);
  const bodyPrepared = app.prepareGeneration(sourceRefs, fixture, prepared.journal.runId);
  assert.equal(fixtureInvocations, 1); assert.equal(bodyPrepared.journal.stages.at(-1).stageKind, 'body');
  const body = await confirmPhase(bodyPrepared);
  assert.equal(body.journal.bodies.length, 1); assert.equal(body.journal.stages.length, 2);
  const coveragePrepared = app.prepareGeneration(sourceRefs, fixture, prepared.journal.runId);
  assert.equal(fixtureInvocations, 2); assert.equal(coveragePrepared.journal.stages.at(-1).stageKind, 'source_coverage');
  const checked = await confirmPhase(coveragePrepared);
  assert.equal(checked.nextAction, 'review_source_coverage'); assert.equal(fixtureInvocations, 3);
  const status = app.sourceCoverageStatus(checked.journal.coverageRef.coverageId, checked.journal.coverageRef.revisionId);
  assert.equal(status.decision.status, 'not_reviewed'); assert.ok(status.unresolvedIds.length > 0);
  assert.deepEqual(app.prepareGeneration(sourceRefs, fixture, prepared.journal.runId), checked);

  // The actual Node example runner explicitly accepts only this authored demonstration's limits.
  // This is not a native callback, human review, factual certification or a semantic-quality pass.
  const requestId = randomUUID(), decision = { coverageRef: status.ref, sourceSetId: checked.journal.sourceSetId, ledgerRef: checked.journal.ledgerRef, bodyRefs: checked.journal.bodies,
    decisionKind: 'proceed_with_limits', reason: 'Authored demonstration only; exercise the application contract without accepting model quality.',
    limitations: ['Authored demonstration only; all semantic checks and unknown factual values remain limited, without human Gold.'], supersedesEventIds: [],
    dispositions: status.unresolvedIds.map(unresolvedId => ({ unresolvedId, disposition: 'accepted_limit', reason: 'Authored demonstration only; retain this unresolved item as a visible limitation.' })) };
  const command = { commandKind: 'record_decision', coverageId: status.ref.coverageId, requestId, expectedGeneration: status.history.generation,
    expectedHeadEventId: status.history.writeHeadEventId, decision };
  const receipt = app.reviewSourceCoverage(command); assert.equal(receipt.requestId, requestId); assert.equal(fixtureInvocations, 3);
  const reviewed = app.sourceCoverageStatus(status.ref.coverageId, status.ref.revisionId);
  assert.deepEqual(reviewed.history.events.at(-1).actor, operator); assert.equal(reviewed.decision.status, 'proceed_with_limits');
  const { coverageRef, sourceSetId, ledgerRef, bodyRefs } = decision;
  const sourceCoverageDecisionRef = { coverageRef, sourceSetId, ledgerRef, bodyRefs, eventId: requestId };
  const associationPrepared = app.prepareGeneration(sourceRefs, fixture, prepared.journal.runId, undefined, sourceCoverageDecisionRef);
  assert.equal(fixtureInvocations, 3); assert.equal(associationPrepared.journal.stages.at(-1).stageKind, 'association');
  const run = await confirmPhase(associationPrepared);
  assert.equal(run.journal.status, 'completed'); assert.equal(run.journal.workflowId, 'knowledge-body-first/v4'); assert.equal(run.journal.bodies.length, 1);
  assert.deepEqual(run.journal.stages.map(stage => stage.stageKind), ['source_ledger', 'body', 'source_coverage', 'association']);
  for (const stage of run.journal.stages) { assert.equal(stage.state, 'completed'); assert.deepEqual(stage.rejected ?? [], []); }

  // Reopening the same identity only replays durable publication; it never calls any fixture phase again.
  const reopened = createLocalKnowledgeApplication(workspace);
  const replay = await reopened.generate(sourceRefs, fixture);
  assert.deepEqual(replay, run); assert.equal(fixtureInvocations, 4);
  const originals = reopened.inspect(run.journal.runId).nativeOutcomes;
  assert.equal(originals.length, 4);
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
    phaseKinds: run.journal.stages.map(stage => stage.stageKind), runStatus: run.journal.status,
    candidateCount: run.journal.bodies.length, entityCount: analysis.revision.entities.length,
    reopened: true, sourceBindingVerified: true, entitySearchMatches: found.total,
    linkedKnowledgeCount: found.rows[0].knowledgeCount, reviewStatus: stored.reviewStatus,
    sourceCoverageDecision: reviewed.decision.status, sourceReviewActorKind: operator.actorKind, semanticQuality: 'not_assessed',
    humanReview: 'pending', independentReview: 'pending', associationReview: stored.derivedAssociations.reviewStatus, usageReported: false,
  };
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
assert.equal(existsSync(sandbox), false);
process.stdout.write(JSON.stringify({ ...summary, temporaryWorkspaceRemoved: true }) + '\n');
