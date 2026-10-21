import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalEntityLinks, createLocalKnowledgeApplication } from '../../../src/knowledge/application/local.js';
import type { ExecutorArchiveProducer } from '../../../src/executors/contracts/archive.js';
import type { ExecutorFn } from '../../../src/executors/contracts/ports.js';
import type { KnowledgeEntityLibraryDetail } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
import type { EntityLinkStudioInspection } from '../../../src/studio/view-models/knowledge/entity-links.js';
import { modelWindow } from '../../knowledge/fixtures.js';

export async function entityLinkFixture(options: { terminate?: boolean } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'omk-studio-link-view-'));
  const knowledge = createLocalKnowledgeApplication(workspace);
  async function window(name: string) {
    const source = knowledge.capture({ path: join(workspace, `${name}.jsonl`), records: [{ recordIndex: 1,
      raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }) }] });
    const run = await knowledge.generate(source.snapshotId, { executor: 'fixture', model: 'no-model-call', generate: async (_system, input) => ({ output: JSON.stringify(modelWindow()).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 0 }) });
    const analysis = knowledge.entities(run.runId), detail = knowledge.entityDetail(run.runId, analysis.revision.entities[0].entityId);
    const sourceView = detail.source.status === 'available' ? { status: 'available' as const, excerpts: detail.source.window.excerpts, limitations: detail.source.window.limitations } : detail.source;
    return { ...detail, source: sourceView } satisfies KnowledgeEntityLibraryDetail;
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
    saved: { workspace, history: completed, projection: app.projectHistory(completed) }, terminated, retryPreview, invocationCount: () => invocationCount, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}
