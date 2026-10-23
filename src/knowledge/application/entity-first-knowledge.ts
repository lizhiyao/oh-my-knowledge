import { createHash } from 'node:crypto';
import type { KnowledgeActor } from '../contracts.js';
import type { EntityAnalysisStore } from '../entities/contracts.js';
import { mapEntityIdentity } from '../entities/identity.js';
import { canonicalJson } from '../store.js';
import type { BoundKnowledgeCatalog } from '../extraction/bound-knowledge.js';
import type { EvidenceStore } from '../extraction/evidence.js';
import { extractionExecution, extractionPrompt, extractionRequestDigest, extractionResponse,
  type ExtractionModel, type ExtractionPromptProfile } from '../extraction/generation.js';
import { SINGLE_EXTRACTION_POLICY } from '../extraction/generation-policy.js';
import { extractionTaskInput } from '../extraction/model-input.js';
import { WINDOW_EXTRACTION_WIRE_ID } from '../extraction/model-wire.js';
import type { ExtractionRunStore } from '../extraction/runs.js';
import { checkWindowExtractionResponse } from '../extraction/window-proposals.js';

interface EntityFirstContextPorts {
  evidence: EvidenceStore; entities: EntityAnalysisStore; runs: ExtractionRunStore;
  actor: KnowledgeActor; hash(value: unknown): string;
}

/** Authenticate a completed source-only E task and its actual persisted initial revision, without generating anything. */
export function readEntityFirstKnowledgeContext(ports: EntityFirstContextPorts, runId: string,
  model: ExtractionModel, profile: ExtractionPromptProfile) {
  if (model.outputMode !== 'json-schema' || model.wireId !== WINDOW_EXTRACTION_WIRE_ID || !model.inspect) {
    throw new Error('Entity-first knowledge requires a native structured entity task.');
  }
  const run = ports.runs.read(runId), attempt = run.attempts[0];
  if (run.status !== 'completed' || !run.finishedAt || canonicalJson(run.policy) !== canonicalJson(SINGLE_EXTRACTION_POLICY)
    || run.attempts.length !== 1 || run.selectedAttemptId !== attempt?.attemptId || !attempt.outcome
    || !run.entityAnalysis || run.entityAnalysis.analysisId !== runId
    || run.entityAnalysis.expectedGeneration !== 0 || run.entityAnalysis.expectedHeadRevisionId !== null
    || run.intents.length || run.committed.length || run.rejections.length || run.entityRejections?.length) {
    throw new Error('Entity-first knowledge requires a completed, unrejected entity-only predecessor.');
  }
  const source = ports.evidence.read(run.snapshotId, run.sourceVersion);
  if (source.status !== 'available') throw new Error('Entity-first source unavailable.');
  const window = source.window;
  const { system, promptVersion } = extractionPrompt(model, profile);
  const input = extractionTaskInput(window, promptVersion);
  const { producer, ...request } = extractionExecution(model, system, input);
  const rootRequestDigest = ports.hash({ snapshotId: window.snapshotId, sourceVersion: window.sourceVersion,
    executor: model.executor, model: model.model, promptHash: ports.hash(system), inputDigest: ports.hash(input),
    actor: ports.actor, policy: SINGLE_EXTRACTION_POLICY, outputMode: model.outputMode,
    wireId: model.wireId, timeoutMs: model.timeoutMs ?? 300_000, maxOutputTokens: model.maxOutputTokens ?? null });
  if (producer.producerId === 'authored-model-port/v1' || canonicalJson(attempt.producer) !== canonicalJson(producer)
    || canonicalJson(attempt.request) !== canonicalJson(request)
    || run.requestDigest !== rootRequestDigest || run.promptVersion !== promptVersion
    || run.promptHash !== ports.hash(system) || run.inputDigest !== ports.hash(input)
    || run.executor !== model.executor || run.model !== model.model
    || attempt.requestDigest !== extractionRequestDigest({ requestDigest: run.requestDigest, request, producer,
      policy: SINGLE_EXTRACTION_POLICY })) {
    throw new Error('Entity-first predecessor request or producer differs from the frozen source-only entity task.');
  }
  const archived = ports.runs.readOutcome(runId, attempt.attemptId, attempt.outcome);
  const outcome = archived.outcome;
  if (canonicalJson(archived.ref) !== canonicalJson(attempt.outcome)
    || outcome.outcomeKind !== 'result' || outcome.cleanupFailure || outcome.result.ok !== true
    || outcome.result.output !== run.rawOutput || outcome.result.refusal !== undefined
    || outcome.result.toolCalls !== undefined && (!Array.isArray(outcome.result.toolCalls) || outcome.result.toolCalls.length > 0)
    || outcome.result.numSubAgents !== undefined && outcome.result.numSubAgents !== 0
    || outcome.result.attemptCount !== undefined && outcome.result.attemptCount !== 1
    || outcome.result.numTurns !== undefined && outcome.result.numTurns !== 1
    || outcome.result.fullNumTurns !== undefined && outcome.result.fullNumTurns !== 1
    || outcome.result.stopReason !== (model.executor === 'codex' ? 'end_turn' : 'stop')) {
    throw new Error('Entity-first predecessor lacks a complete successful native return.');
  }
  const decoded = extractionResponse(outcome, 'json-schema', WINDOW_EXTRACTION_WIRE_ID);
  if (decoded.status !== 'decoded' || decoded.wireDiagnostic?.wireStatus !== 'valid') {
    throw new Error('Entity-first predecessor wire was rejected.');
  }
  const checked = checkWindowExtractionResponse(decoded.response, window.excerpts);
  if (checked.analysis.rejected.length || checked.rejected.length || checked.accepted.length) {
    throw new Error('Entity-first predecessor must contain only admitted entities and mentions, with no knowledge.');
  }
  const write = run.entityAnalysis, history = ports.entities.read(write.analysisId);
  const revision = history.revisions.find(value => value.revisionId === write.revision.revisionId);
  if (write.snapshotId !== window.snapshotId || write.sourceVersion !== window.sourceVersion
    || history.snapshotId !== window.snapshotId || history.sourceVersion !== window.sourceVersion
    || history.revisions[0]?.revisionId !== write.revision.revisionId || !revision
    || canonicalJson(revision) !== canonicalJson(write.revision)
    || revision.entities.length !== checked.analysis.entities.length || revision.mentions.length !== checked.analysis.mentions.length) {
    throw new Error('Entity-first analysis differs from the persisted initial revision.');
  }
  // Match host ID allocation by original admission order, never by a label or similarity.
  const entityIds = new Map(checked.analysis.entities.map((entity, index) => [entity.entityId, revision.entities[index].entityId]));
  const mentionIds = new Map(checked.analysis.mentions.map((mention, index) => [mention.mentionId, revision.mentions[index].mentionId]));
  const actual = { entities: revision.entities, mentions: revision.mentions, limitations: revision.limitations };
  const expected = { entities: checked.analysis.entities.map(entity => mapEntityIdentity(entity, entityIds, mentionIds)),
    mentions: checked.analysis.mentions.map(mention => ({ ...mention, mentionId: mentionIds.get(mention.mentionId)!,
      entityId: entityIds.get(mention.entityId)! })), limitations: window.limitations };
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error('Entity-first analysis differs from its native admission.');
  const catalog: BoundKnowledgeCatalog = structuredClone({ analysisId: write.analysisId, revisionId: revision.revisionId,
    snapshotId: history.snapshotId, sourceVersion: history.sourceVersion, ...actual });
  return { window: structuredClone(window), catalog, entityRunId: runId, entityAttemptId: attempt.attemptId,
    entityOutcomeRef: archived.ref, entityFinishedAt: run.finishedAt };
}

/** Private import identity v1. Replaying one receipt/proposal uses the same three UUIDs and store request ID. */
export function boundKnowledgeIntentIds(receiptId: string, proposalId: string) {
  return ['knowledge', 'revision', 'request'].map(role => {
    const bytes = createHash('sha256').update(canonicalJson({ identityVersion: 'knowledge-bound-import-ids/v1',
      receiptId, proposalId, role })).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x80; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });
}
