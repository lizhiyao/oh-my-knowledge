import { createHash } from 'node:crypto';
import { canonicalJson } from '../store.js';
import type { EvidenceWindow } from './evidence.js';
import { ENTITY_ONLY_EXTRACTION_PROMPT, ENTITY_ONLY_EXTRACTION_PROMPT_VERSION,
  ENTITY_ONLY_EXTRACTION_SYSTEM_DIGEST } from './entity-only-prompt.js';
import { SINGLE_EXTRACTION_POLICY } from './generation-policy.js';
import { extractionModelInput } from './model-input.js';
import { WINDOW_EXTRACTION_WIRE_ID } from './model-wire.js';
import type { ExtractionRun } from './runs.js';
import { WindowExtractionEnvelopeSchema } from './window-proposals.js';

const rawDigest = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

/** New fixed task only. No legacy task, response or stored revision is reinterpreted. */
export function entityOnlyTaskViolation(run: ExtractionRun, window: EvidenceWindow, response: unknown,
  hash: (value: unknown) => string): string | undefined {
  if (run.promptVersion !== ENTITY_ONLY_EXTRACTION_PROMPT_VERSION) return;
  const attempt = run.attempts[0], input = extractionModelInput(window);
  if (run.attempts.length !== 1 || canonicalJson(run.policy) !== canonicalJson(SINGLE_EXTRACTION_POLICY)
    || run.snapshotId !== window.snapshotId || run.sourceVersion !== window.sourceVersion
    || run.promptHash !== hash(ENTITY_ONLY_EXTRACTION_PROMPT) || run.inputDigest !== hash(input)
    || attempt.request.outputMode !== 'json-schema' || attempt.request.wireId !== WINDOW_EXTRACTION_WIRE_ID
    || attempt.request.systemDigest !== ENTITY_ONLY_EXTRACTION_SYSTEM_DIGEST
    || attempt.request.inputDigest !== rawDigest(input)) {
    return 'Entity-only extraction task identity differs from the fixed structured source-only profile; no entity or knowledge admission is allowed.';
  }
  const requestDigest = hash({ snapshotId: run.snapshotId, sourceVersion: run.sourceVersion,
    executor: run.executor, model: run.model, promptHash: hash(ENTITY_ONLY_EXTRACTION_PROMPT), inputDigest: hash(input),
    actor: run.actor, policy: SINGLE_EXTRACTION_POLICY, outputMode: attempt.request.outputMode,
    wireId: attempt.request.wireId, timeoutMs: attempt.request.timeoutMs, maxOutputTokens: attempt.request.maxOutputTokens ?? null });
  if (run.requestDigest !== requestDigest || run.selectedAttemptId !== attempt.attemptId || !attempt.outcome
    || attempt.requestDigest !== rawDigest(canonicalJson({ requestDigest, request: attempt.request,
      producer: attempt.producer, policy: SINGLE_EXTRACTION_POLICY }))) {
    return 'Entity-only extraction request identity differs from the archived source-only task; no entity or knowledge admission is allowed.';
  }
  const parsed = WindowExtractionEnvelopeSchema.safeParse(response);
  if (!parsed.success || parsed.data.proposals.length !== 0) {
    return 'Entity-only extraction must return an explicit empty proposals array; the original outcome remains archived and no entity or knowledge admission is allowed.';
  }
  if (run.intents.length || run.committed.length) {
    return 'Entity-only extraction cannot carry knowledge intents or committed knowledge; the original records remain unchanged and no further admission is allowed.';
  }
}
