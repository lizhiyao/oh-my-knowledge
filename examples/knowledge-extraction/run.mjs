#!/usr/bin/env node

// Repository-only dogfood: these built application modules are not a public SDK API.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const caseDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(process.env.OMK_PACKAGE_ROOT ?? join(caseDirectory, '../..'));
const applicationEntry = join(packageRoot, 'dist/observability/knowledge-extraction/local.js');
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
  // Authored Schema v4 response, not a model capture or human-reviewed annotation.
  const response = {
    responseKind: 'knowledge-extraction', schemaVersion: 4, entities,
    mentions: entities.map((entity, index) => ({
      mentionId: `mention-${index}`, entityId: entity.entityId,
      selection: { evidenceRef, quote: entity.label }, basis: 'explicit', rationale: '逐字对象名称',
    })),
    proposals: [{
      proposalId: 'candidate', entityIds: entities.map(entity => entity.entityId),
      mentionIds: ['mention-0', 'mention-1'],
      draft: {
        title: message,
        content: {
          statements: [{ statementId: 'usage', subject: { entityId: 'entity-0' },
            object: { entityId: 'entity-1' }, relation: '使用', modality: 'descriptive', polarity: 'positive',
            context: { scenario: '本例合成日志的来源说法', conditions: [], exceptions: [],
              unknowns: ['版本与结果未记录'],
              occurredDuring: { timeKind: 'unknown', reason: '原文未说明' },
              validDuring: { timeKind: 'unknown', reason: '适用范围未验证' } } }],
          organization: { knowledgeKind: 'fact' },
        },
        evidence: [{ evidenceLinkId: 'evidence', evidenceRef, statementIds: ['usage'],
          relation: 'supports', basis: 'source_assertion', interpretation: '只记录来源说法，尚待核对' }],
      },
      citations: [{ evidenceLinkId: 'evidence', selection: { evidenceRef, quote: message } }],
      reuseRationale: '演示后续检查对象之间的关系', identityUncertainties: [],
    }],
  };
  const rawOutput = JSON.stringify(response);
  let fixtureInvocations = 0;
  const fixture = {
    executor: 'authored-fixture', model: 'not-a-model',
    async generate(_system, input) {
      fixtureInvocations++;
      assert.deepEqual(JSON.parse(input), { excerpts: snapshot.excerpts, limitations: snapshot.limitations });
      // No provider usage was measured: do not populate token/cost fields with fake zeros.
      return { output: rawOutput, durationMs: 0 };
    },
  };
  const run = await app.generate(snapshot.snapshotId, fixture);
  assert.equal(run.status, 'completed');
  assert.equal(run.rawOutput, rawOutput);
  assert.equal(run.committed.length, 1);
  assert.equal(run.rejections.length, 0);
  assert.equal(run.entityRejections.length, 0);
  assert.equal(run.runtime.inputTokens, undefined);
  assert.equal(run.runtime.costUSD, undefined);

  // Reopen stores from disk; an existing completed run must not invoke the fixture again.
  const reopened = createLocalKnowledgeApplication(workspace);
  const replay = await reopened.generate(snapshot.snapshotId, fixture, run.runId);
  assert.equal(replay.runId, run.runId);
  assert.equal(replay.rawOutput, rawOutput);
  assert.equal(fixtureInvocations, 1);
  const stored = reopened.detail(run.committed[0].knowledgeId);
  assert.equal(stored.reviewStatus, 'pending');
  assert.equal(stored.revision.evidence[0].basis, 'source_assertion');
  assert.equal(stored.sources[0].status, 'available');
  assert.equal(stored.sources[0].window.snapshotId, snapshot.snapshotId);
  assert.equal(stored.sources[0].window.sourceVersion, snapshot.sourceVersion);
  assert.equal(stored.grounding.sourceBindings[0].snapshotId, snapshot.snapshotId);
  assert.equal(stored.grounding.sourceBindings[0].sourceVersion, snapshot.sourceVersion);
  assert.equal(stored.grounding.entityAnalysisRef.analysisId, run.runId);
  assert.equal(stored.entityAnalysis.status, 'available');
  assert.equal(stored.entityAnalysis.revision.revisionId, stored.grounding.entityAnalysisRef.revisionId);
  assert.equal(stored.entityAnalysis.revision.entities.length, 2);
  for (const mention of stored.grounding.mentions) {
    const excerpt = stored.sources[0].window.excerpts.find(value => value.evidenceRef === mention.selection.evidenceRef);
    assert.ok(excerpt);
    assert.equal(excerpt.text.slice(mention.selection.start, mention.selection.end), mention.selection.quote);
  }
  const found = reopened.queryEntities({ query: 'Alpha', analysisId: run.runId });
  assert.equal(found.total, 1);
  assert.equal(found.rows[0].label, 'Alpha');
  assert.equal(found.rows[0].knowledgeCount, 1);
  assert.equal(readFileSync(source, 'utf8'), sourceBytes);
  summary = {
    fixtureInvocations, modelCalls: 0, runStatus: run.status,
    candidateCount: run.committed.length, entityCount: stored.entityAnalysis.revision.entities.length,
    reopened: true, sourceBindingVerified: true, entitySearchMatches: found.total,
    linkedKnowledgeCount: found.rows[0].knowledgeCount, reviewStatus: stored.reviewStatus,
    humanReview: 'pending', independentReview: 'pending', usageReported: false,
  };
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
assert.equal(existsSync(sandbox), false);
process.stdout.write(JSON.stringify({ ...summary, temporaryWorkspaceRemoved: true }) + '\n');
