import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalEntityLinks, createLocalKnowledgeApplication, createLocalKnowledgeLibrary } from '../../../src/knowledge/application/local.js';
import type { ExecutorArchiveProducer } from '../../../src/executors/contracts/archive.js';
import type { ExecutorFn } from '../../../src/executors/contracts/ports.js';
import type { KnowledgeEntityLibraryDetail } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
import type { EntityLinkStudioInspection } from '../../../src/studio/view-models/knowledge/entity-links.js';
import { FileEntityAnalysisStore } from '../../../src/knowledge/adapters/entity-store.js';
import { FileSourceStore } from '../../../src/knowledge/adapters/source-store';
import { sourceSnapshotProjection } from '../../../src/knowledge/sources';
import { traceSourceFixture } from './source-fixture';

export async function entityLinkFixture(options: { terminate?: boolean; existingMember?: boolean } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'omk-studio-link-view-'));
  const knowledge = createLocalKnowledgeApplication(workspace);
  async function window(name: string) {
    const selected = { snapshotId: randomUUID(), sourceVersion: `sha256:${'a'.repeat(64)}` };
    const source = new FileSourceStore(join(workspace, 'sources'), workspace).capture(sourceSnapshotProjection(traceSourceFixture(selected,
      [{ evidenceRef: `${selected.snapshotId}:0`, text: 'Alpha 使用 Beta', recordIndex: 1, eventKind: 'message', role: 'user' }], { origin: { threadId: name, title: name } }))).snapshot;
    const analysisId = randomUUID(), revisionId = randomUUID(), entityId = randomUUID(), mentionId = randomUUID();
    const actor = { actorKind: 'human' as const, actorId: 'local-user' }, at = '2026-10-15T00:00:00Z';
    new FileEntityAnalysisStore(join(workspace, 'entities'), workspace).write({ analysisId, snapshotId: source.snapshotId, sourceVersion: source.sourceVersion,
      requestId: randomUUID(), expectedGeneration: 0, expectedHeadRevisionId: null, revision: { revisionId, revisedAt: at, revisedBy: actor, revisionReason: 'Authored entity fixture; no knowledge generation', limitations: [],
        entities: [{ entityId, label: 'Alpha', description: '本次项目', qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [], referentKind: 'object', componentRef: null, collection: null }],
        mentions: [{ mentionId, entityId, selection: { evidenceRef: source.excerpts[0].evidenceRef, start: 0, end: 5, quote: 'Alpha' }, basis: 'explicit', rationale: 'Literal project name' }] } }, actor);
    const detail = knowledge.entityDetail(analysisId, entityId);
    return detail satisfies KnowledgeEntityLibraryDetail;
  }
  const left = await window('left'), right = await window('right');
  let release!: () => void, invocationCount = 0;
  const held = options.terminate ? new Promise<void>(resolve => { release = resolve; }) : undefined;
  const execute: ExecutorFn = async input => {
    invocationCount++;
    if (held) await held;
    const pair = JSON.parse(input.prompt);
    return { ok: true, output: JSON.stringify({ responseKind: 'entity-link-suggestion', schemaVersion: 1, leftEntityId: pair.left.binding.entityId,
      rightEntityId: pair.right.binding.entityId, assessment: 'insufficient_evidence', leftMentionIds: pair.left.binding.mentionIds, rightMentionIds: pair.right.binding.mentionIds,
      rationale: '模型不知道 <script>unsafe</script>' }), durationMs: 1, durationApiMs: 0, inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUSD: 0, costReportedByExecutor: false, stopReason: 'stop', numTurns: 1 };
  };
  const evidence = { producerId: 'controlled-view-fixture', producerRevision: 'sha256:' + 'f'.repeat(64), sourceChannels: [{ channel: 'fixture', maxBytes: 4096 }], maxOutcomeJsonBytes: 8192, proof: { endpoint: 'https://fixture.invalid/v1/chat/completions' } };
  const producer: ExecutorArchiveProducer = { assertCapabilities() {}, inspect: () => evidence, configure: () => ({ evidence, execute }) };
  if (options.existingMember) createLocalKnowledgeLibrary(workspace).save({ objectId: randomUUID(), requestId: randomUUID(), generation: 0, headRevisionId: null,
    identityConfirmed: true, reason: '旧组织', draft: { label: 'Alpha', description: '旧范围', referentKind: 'object', members: [{ analysisId: left.history.analysisId,
      entityId: left.entity.entityId, entityRevisionId: left.revision.revisionId, mentionIds: left.revision.mentions.filter(m => m.entityId === left.entity.entityId).map(m => m.mentionId), rationale: '旧证据理由' }] } });
  const app = createLocalEntityLinks(workspace, producer), candidates = app.recall({ analysisId: left.history.analysisId, entityId: left.entity.entityId });
  const preview = app.preview({ analysisId: left.history.analysisId, entityId: left.entity.entityId }, { analysisId: right.history.analysisId, entityId: right.entity.entityId }, { executor: 'openai-api', model: 'fixture-model' });
  const prepared = app.prepare({ ...preview, confirmDigest: preview.plan.confirmedDigest });
  const preparedInspection = { workspace, history: prepared, projection: app.projectHistory(prepared), startToken: 'fixture-start' };
  const pending = app.start({ reviewId: preview.reviewId, requestId: preview.startRequestId, expectedGeneration: prepared.generation });
  let terminated: EntityLinkStudioInspection | undefined;
  if (options.terminate) {
    try {
      const running = app.inspect(preview.reviewId), execution = running.projection.execution!;
      const history = app.terminateExecution({ reviewId: preview.reviewId, requestId: randomUUID(), expectedGeneration: running.history.generation,
        executionId: execution.executionId, ownerId: execution.owner.ownerId, reason: '人工终止理由 <script>unsafe</script>' });
      terminated = { workspace, history, projection: app.projectHistory(history) };
    } finally { release(); }
  }
  const completed = await pending;
  const retryPreview = options.terminate ? { workspace, previewToken: 'fixture-retry-token', preview: app.preview(
    { analysisId: left.history.analysisId, entityId: left.entity.entityId }, { analysisId: right.history.analysisId, entityId: right.entity.entityId },
    { executor: 'openai-api', model: 'fixture-model' }, preview.reviewId) } : undefined;
  return { workspace, left, right, candidates, preview: { workspace, previewToken: 'fixture-token', preview }, prepared: preparedInspection,
    saved: { workspace, history: completed, projection: app.projectHistory(completed) },
    acceptancePreview: (reason: string, objectLabel?: string) => app.acceptPreview({ reviewId: completed.reviewId, expectedGeneration: completed.generation, reason, ...(objectLabel ? { objectLabel } : {}) }), terminated, retryPreview, invocationCount: () => invocationCount, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}
