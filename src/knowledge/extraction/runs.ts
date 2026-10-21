import type { ExtractionRunSealPreview, ExtractionRunSealRequest, ExtractionRunSealSummary } from './run-sealing.js';
import { EvidenceWindowSchema } from './evidence.js';
import { z } from 'zod';
import { KnowledgeActorSchema } from '../contracts.js';
import { canonicalJson, GroundingSchema } from '../store.js';
import { KnowledgeRevisionSchema } from '../contracts.js';
import { EntityAnalysisWriteSchema } from '../entities/contracts.js';
import { validateEntityAnalysis } from '../entities/validation.js';
import { validateGroundingReferences, validateKnowledgeDraft } from '../validation.js';
import { ExtractionGenerationPolicySchema, ExtractionBudgetReservationSchema, ExtractionAttemptAccountingSchema } from './generation-policy.js';

export type ExtractionJson = null | boolean | number | string | ExtractionJson[] | { [key: string]: ExtractionJson };
export interface ExtractionNativeResult { ok: boolean; output: string | null; [key: string]: ExtractionJson }
export interface ExtractionExceptionObservation {
  representationKind: 'exception-diagnostic/v1';
  sourceType: 'undefined' | 'boolean' | 'number' | 'bigint' | 'string' | 'symbol' | 'function' | 'object';
  name: string | null; message: string; truncated: boolean; accessorsSkipped: boolean;
}
export interface ExtractionModelProjection { output: string; durationMs: number; inputTokens?: number; outputTokens?: number; costUSD?: number }
export type ExtractionOutcome =
  | { outcomeKind: 'result'; result: ExtractionNativeResult; cleanupFailure?: { diagnostic: string } }
  | { outcomeKind: 'exception'; error: ExtractionExceptionObservation; cleanupFailure?: { diagnostic: string } }
  | { outcomeKind: 'model-port-projection'; scope: 'authored-model-port/v1'; result: ExtractionModelProjection };

/** JSON data only. Explicit frames permit deeply nested native trace JSON without getters or recursion. */
export function isExtractionJsonData(input: unknown): input is ExtractionJson {
  const active = new WeakSet<object>();
  const stack: { value: unknown; keys?: string[]; index: number }[] = [{ value: input, index: 0 }];
  try {
    while (stack.length) {
      const frame = stack[stack.length - 1], value = frame.value;
      if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) { stack.pop(); continue; }
      if (!value || typeof value !== 'object') return false;
      if (!frame.keys) {
        if (active.has(value)) return false;
        const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
        if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) return false;
        const own = Reflect.ownKeys(value);
        if (own.some(key => typeof key !== 'string')) return false;
        const keys: string[] = [];
        for (const key of own as string[]) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !('value' in descriptor)) return false;
          if (array && key === 'length') continue;
          if (!descriptor.enumerable) return false;
          keys.push(key);
        }
        if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) return false;
        frame.keys = keys; active.add(value);
      }
      if (frame.index >= frame.keys.length) { active.delete(value); stack.pop(); continue; }
      const key = frame.keys[frame.index++], descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return false;
      stack.push({ value: descriptor.value, index: 0 });
    }
    return true;
  } catch { return false; }
}
const jsonRecord = (value: unknown): value is Record<string, ExtractionJson> => !!value && typeof value === 'object' && !Array.isArray(value);
const utf8Limit = (value: unknown, max: number): value is string => typeof value === 'string' && new TextEncoder().encode(value).byteLength <= max;
function isExtractionOutcome(value: unknown): value is ExtractionOutcome {
  if (!isExtractionJsonData(value) || !jsonRecord(value)) return false;
  if (value.cleanupFailure !== undefined && (!jsonRecord(value.cleanupFailure) || Object.keys(value.cleanupFailure).length !== 1
    || !utf8Limit(value.cleanupFailure.diagnostic, 4096))) return false;
  if (value.outcomeKind === 'result') return Object.keys(value).every(key => ['outcomeKind', 'result', 'cleanupFailure'].includes(key))
    && jsonRecord(value.result) && typeof value.result.ok === 'boolean' && (value.result.output === null || typeof value.result.output === 'string');
  if (value.outcomeKind === 'exception') {
    const error = value.error;
    return Object.keys(value).every(key => ['outcomeKind', 'error', 'cleanupFailure'].includes(key)) && jsonRecord(error)
      && Object.keys(error).length === 6 && error.representationKind === 'exception-diagnostic/v1' && typeof error.sourceType === 'string'
      && ['undefined', 'boolean', 'number', 'bigint', 'string', 'symbol', 'function', 'object'].includes(error.sourceType)
      && (error.name === null || utf8Limit(error.name, 256)) && utf8Limit(error.message, 4096)
      && typeof error.truncated === 'boolean' && typeof error.accessorsSkipped === 'boolean';
  }
  if (value.outcomeKind !== 'model-port-projection' || value.scope !== 'authored-model-port/v1'
    || Object.keys(value).length !== 3 || !jsonRecord(value.result)) return false;
  const result = value.result;
  return Object.keys(result).every(key => ['output', 'durationMs', 'inputTokens', 'outputTokens', 'costUSD'].includes(key))
    && typeof result.output === 'string' && typeof result.durationMs === 'number'
    && ['inputTokens', 'outputTokens', 'costUSD'].every(key => result[key] === undefined || typeof result[key] === 'number');
}
// z.custom retains the original JSON object, including unknown native fields, without recursive Zod cloning.
export const ExtractionOutcomeSchema = z.custom<ExtractionOutcome>(isExtractionOutcome, 'Invalid extraction outcome JSON data.');
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const ExtractionOutcomeRefSchema = z.strictObject({ bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), digest });
export type ExtractionOutcomeRef = z.infer<typeof ExtractionOutcomeRefSchema>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rejection = z.strictObject({ index: count, reasons: z.array(z.string()) });
const entityRejection = z.strictObject({ component: z.enum(['entity', 'mention']), index: count, reasons: z.array(z.string()) });
export const ExtractionAttemptSchema = z.strictObject({
  attemptId: z.string().uuid(), startedAt: z.iso.datetime({ offset: true }), requestDigest: digest,
  request: z.strictObject({ systemDigest: digest, inputDigest: digest, outputMode: z.enum(['json-schema', 'prompt-json']),
    wireId: digest.optional(), timeoutMs: z.number().int().positive().max(2_147_483_647), maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }),
  producer: z.strictObject({ producerId: z.string().min(1).max(256), producerRevision: digest,
    sourceChannels: z.array(z.strictObject({ channel: z.string().min(1).max(256), maxBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })).min(1),
    maxOutcomeJsonBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), proof: z.custom<ExtractionJson>(isExtractionJsonData) }),
  outcome: ExtractionOutcomeRefSchema.optional(), failure: z.strictObject({ failureKind: z.string().min(1).max(256), diagnostic: z.string().max(4096) }).optional(),
  wireDiagnostic: z.strictObject({ wireId: digest, wireStatus: z.enum(['valid', 'item_failures']), itemFailureCount: z.number().int().nonnegative() }).optional(),
  budget: ExtractionBudgetReservationSchema.optional(), accounting: ExtractionAttemptAccountingSchema.optional(),
  trigger: z.strictObject({ triggerKind: z.enum(['transient', 'validation']), previousAttemptId: z.string().uuid(),
    notBefore: z.iso.datetime({ offset: true }), delayMs: count,
    feedback: z.strictObject({ feedbackVersion: z.literal('knowledge-generation-feedback/v1'), body: z.string().max(8192), digest }).optional() }).optional(),
  admission: z.strictObject({ assessmentVersion: z.literal('knowledge-generation-admission/v1'),
    entityCount: count, mentionCount: count, proposalCount: count, entityRejections: z.array(entityRejection), rejections: z.array(rejection) }).optional(),
}).superRefine((attempt, context) => {
  if (attempt.request.outputMode === 'json-schema' && !attempt.request.wireId) context.addIssue({ code: 'custom', path: ['request', 'wireId'], message: 'Structured output requires a frozen wire identity.' });
  if ((attempt.accounting || attempt.admission) && !attempt.outcome) {
    context.addIssue({ code: 'custom', path: ['outcome'], message: 'Extraction assessment requires its archived outcome.' });
  }
  if (attempt.accounting && !attempt.budget) context.addIssue({ code: 'custom', path: ['budget'], message: 'Extraction accounting requires its reservation.' });
});
export type ExtractionAttempt = z.infer<typeof ExtractionAttemptSchema>;

export const ExtractionRunSchema = z.strictObject({
  runKind: z.literal('knowledge-extraction-run'), schemaVersion: z.literal(5),
  runId: z.string().uuid(), requestDigest: z.string(), generation: z.number().int().positive(),
  snapshotId: z.string().uuid(), sourceVersion: z.string(),
  origin: EvidenceWindowSchema.shape.origin,
  executor: z.string().min(1), model: z.string().min(1),
  promptVersion: z.string().regex(/^knowledge-extraction-v[1-9]\d*(?![\s\S])/), promptHash: z.string(), inputDigest: z.string(),
  actor: KnowledgeActorSchema,
  policy: ExtractionGenerationPolicySchema, attempts: z.array(ExtractionAttemptSchema).min(1).max(3), selectedAttemptId: z.string().uuid().optional(),
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }).optional(),
  status: z.enum(['generating', 'prepared', 'completed', 'failed', 'cancelled']),
  error: z.string().optional(), rawOutput: z.string().optional(),
  rejections: z.array(rejection),
  entityAnalysis: EntityAnalysisWriteSchema.optional(),
  entityRejections: z.array(entityRejection).optional(),
  intents: z.array(z.strictObject({
    requestId: z.string(), revision: KnowledgeRevisionSchema, grounding: GroundingSchema,
  })),
  committed: z.array(z.strictObject({ knowledgeId: z.string(), revisionId: z.string() })),
  runtime: z.strictObject({
    durationMs: z.number(), inputTokens: z.number().optional(), outputTokens: z.number().optional(),
    durationApiMs: z.number().optional(), cacheReadTokens: z.number().optional(), cacheCreationTokens: z.number().optional(),
    tokenUsageReportedByExecutor: z.boolean().optional(), costUSD: z.number().optional(), costReportedByExecutor: z.boolean().optional(),
  }).optional(),
}).superRefine((run, context) => {
  const add = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message });
  if (new Set(run.attempts.map(attempt => attempt.attemptId)).size !== run.attempts.length) add(['attempts'], 'Duplicate extraction attempt identity.');
  if (run.policy.policyId === 'knowledge-generation-single/v1') {
    if (run.attempts.length !== 1) add(['attempts'], 'Single invocation policy requires exactly one attempt.');
    if (run.attempts.some(attempt => attempt.budget || attempt.accounting || attempt.trigger || attempt.admission)) add(['attempts'], 'Single invocation policy does not carry bounded-policy facts.');
  } else {
    if (run.attempts.length > run.policy.maxInvocations) add(['attempts'], 'Extraction invocation limit exceeded.');
    let reserved = 0n, reasks = 0;
    for (const [index, attempt] of run.attempts.entries()) {
      const previous = run.attempts[index - 1];
      if (!attempt.budget || attempt.budget.profileId !== run.policy.profileId
        || attempt.budget.outputUpperBound !== run.policy.maxOutputTokens || attempt.request.maxOutputTokens !== run.policy.maxOutputTokens) {
        add(['attempts', index, 'budget'], 'Bounded extraction requires the matching frozen token reservation.');
      }
      if (attempt.budget) reserved += BigInt(attempt.budget.tokensReserved);
      if (index === 0 ? attempt.trigger !== undefined : !attempt.trigger || attempt.trigger.previousAttemptId !== previous.attemptId || !previous.outcome || !previous.accounting) {
        add(['attempts', index, 'trigger'], 'Extraction attempt must follow its archived and accounted predecessor.');
      }
      if (attempt.trigger?.triggerKind === 'validation') reasks++;
      if (attempt.trigger?.triggerKind === 'transient' && attempt.trigger.feedback) add(['attempts', index, 'trigger'], 'Transient retry cannot introduce validation feedback.');
    }
    if (reserved > BigInt(run.policy.maxTotalTokens)) add(['attempts'], 'Extraction cumulative token reservation exceeded.');
    if (reasks > run.policy.maxReasks) add(['attempts'], 'Extraction validation reask limit exceeded.');
  }
  const selected = run.attempts.find(attempt => attempt.attemptId === run.selectedAttemptId);
  if (selected && run.policy.policyId === 'knowledge-generation-bounded/v1'
    && selected.attemptId !== run.attempts[run.attempts.length - 1].attemptId) add(['selectedAttemptId'], 'Bounded extraction must select its final attempt.');
  if ((run.selectedAttemptId !== undefined && !selected?.outcome) || (run.rawOutput !== undefined && !selected?.outcome)
    || (['prepared', 'completed'].includes(run.status) && (!selected?.outcome || run.rawOutput === undefined))) {
    context.addIssue({ code: 'custom', path: ['selectedAttemptId'], message: 'Selected extraction output requires its archived attempt.' });
  }
  if (['prepared', 'completed'].includes(run.status) && selected?.failure) {
    context.addIssue({ code: 'custom', path: ['selectedAttemptId'], message: 'Failed extraction attempt cannot prepare knowledge.' });
  }
  if (['prepared', 'completed'].includes(run.status) && !run.entityAnalysis) {
    context.addIssue({ code: 'custom', path: ['entityAnalysis'], message: 'Prepared window extraction needs an entity intent, including empty results.' });
  }
  if (run.entityAnalysis && (run.entityAnalysis.analysisId !== run.runId || run.entityAnalysis.snapshotId !== run.snapshotId
    || run.entityAnalysis.sourceVersion !== run.sourceVersion || run.entityAnalysis.expectedGeneration !== 0
    || run.entityAnalysis.expectedHeadRevisionId !== null)) {
    context.addIssue({ code: 'custom', path: ['entityAnalysis'], message: 'Entity intent does not match the extraction window.' });
  }
  if (['prepared', 'completed'].includes(run.status) && run.rawOutput === undefined) add(['rawOutput'], 'Prepared extraction needs its original output.');
  const analysis = run.entityAnalysis?.revision;
  if (!analysis) {
    if (run.intents.length || run.committed.length) add(['intents'], 'Knowledge intents require an entity analysis.');
    return;
  }
  const actor = { actorKind: 'agent', actorId: `extractor:${run.executor}`, executionRef: run.runId };
  if (validateEntityAnalysis(analysis).length || analysis.parentRevisionId !== undefined
    || canonicalJson(analysis.revisedBy) !== canonicalJson(actor)) add(['entityAnalysis'], 'Invalid entity birth intent.');
  if (new Set(run.intents.map(intent => intent.requestId)).size !== run.intents.length) add(['intents'], 'Duplicate knowledge request.');
  for (const field of ['knowledgeId', 'revisionId'] as const) {
    if (new Set(run.intents.map(intent => intent.revision[field])).size !== run.intents.length) add(['intents'], 'Duplicate knowledge identity.');
  }
  for (const [index, { revision, grounding }] of run.intents.entries()) {
    const refs = grounding.sourceBindings.flatMap(binding => binding.evidenceRefs); const registered = new Set(refs);
    const ref = grounding.entityAnalysisRef;
    const draft = { title: revision.title, content: revision.content, entities: revision.entities, evidence: revision.evidence };
    if (ref?.analysisId !== run.runId || ref.revisionId !== analysis.revisionId
      || grounding.sourceBindings.length !== 1 || grounding.sourceBindings[0].snapshotId !== run.snapshotId
      || grounding.sourceBindings[0].sourceVersion !== run.sourceVersion || registered.size !== refs.length
      || grounding.revisionId !== revision.revisionId || revision.parentRevision !== undefined
      || revision.createdAt !== revision.revisedAt || canonicalJson(revision.createdBy) !== canonicalJson(actor)
      || canonicalJson(revision.revisedBy) !== canonicalJson(actor)
      || !validateKnowledgeDraft(draft, registered).accepted || validateGroundingReferences(draft, grounding, registered).length
      || revision.entities.some(entity => {
        const known = analysis.entities.find(candidate => candidate.entityId === entity.entityId);
        return !known || known.label !== entity.label || known.description !== entity.description
          || known.uncertainties.some(reason => !grounding.identityUncertainties.includes(reason));
      })
      || grounding.mentions.some(mention => !analysis.mentions.some(known => canonicalJson(known) === canonicalJson(mention)))) {
      add(['intents', index], 'Knowledge intent differs from the bound entity birth revision.');
    }
  }
  const expected = run.intents.map(intent => ({ knowledgeId: intent.revision.knowledgeId, revisionId: intent.revision.revisionId }));
  if ((run.status === 'completed' && canonicalJson(expected) !== canonicalJson(run.committed))
    || new Set(run.committed.map(ref => ref.knowledgeId)).size !== run.committed.length
    || run.committed.some(ref => !expected.some(candidate => canonicalJson(candidate) === canonicalJson(ref)))) {
    add(['committed'], 'Committed knowledge does not match the run intents.');
  }
});
export type ExtractionRun = z.infer<typeof ExtractionRunSchema>;
export interface ExtractionRunStore {
  /** Optional capabilities are absent only on narrow replay/authored stores. Production provides all three. */
  inspectSeal?(runId: string, namespace?: 'current' | 'legacy'): ExtractionRunSealPreview | ExtractionRunSealSummary;
  seal?(request: ExtractionRunSealRequest): ExtractionRunSealSummary;
  listSeals?(): ExtractionRunSealSummary[];
  create(run: ExtractionRun): void;
  /** Validate the manifest and its referenced native archives before execution or recovery. */
  read(runId: string): ExtractionRun;
  /** Validate manifests only; recorded outcome references do not attest current archive integrity. */
  listManifests(): ExtractionRun[];
  save(run: ExtractionRun, expectedGeneration: number): void;
  writeOutcome(runId: string, attemptId: string, outcome: ExtractionOutcome, maxBytes: number): ExtractionOutcomeRef;
  readOutcome(runId: string, attemptId: string, ref?: ExtractionOutcomeRef): { outcome: ExtractionOutcome; ref: ExtractionOutcomeRef };
}

/** Safe manifest summary. Counts describe the saved birth; recorded means a saved outcome receipt, not archive verification. */
export function extractionRunSummary(run: ExtractionRun) {
  const analysis = run.entityAnalysis;
  const last = run.attempts[run.attempts.length - 1];
  const selected = run.attempts.find(attempt => attempt.attemptId === run.selectedAttemptId) ?? last;
  const reservedTokens = run.attempts.reduce((sum, attempt) => sum + (attempt.budget?.tokensReserved ?? 0), 0);
  const unknownAttempts = run.attempts.filter(attempt => !attempt.accounting || attempt.accounting.observedTokens === null).length;
  const observedTotal = run.attempts.reduce((sum, attempt) => sum + BigInt(attempt.accounting?.observedTokens ?? 0), 0n);
  const observedTokens = unknownAttempts || observedTotal > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(observedTotal);
  return { runId: run.runId, status: run.status, startedAt: run.startedAt, committed: run.committed, rejections: run.rejections,
    invocation: { policyId: run.policy.policyId, outputMode: selected.request.outputMode, wireId: selected.request.wireId ?? null,
      attemptCount: run.attempts.length, archiveStatus: last.outcome ? 'recorded' as const : 'pending' as const,
      failureKind: selected.failure?.failureKind ?? null,
      limits: { maxInvocations: run.policy.maxInvocations, maxReasks: run.policy.policyId === 'knowledge-generation-single/v1' ? 0 : run.policy.maxReasks },
      budget: { reservedTokens, observedTokens, unknownAttempts,
        ...(run.policy.policyId === 'knowledge-generation-bounded/v1' ? { maxTotalTokens: run.policy.maxTotalTokens } : {}) } },
    ...(run.runtime ? { runtime: run.runtime } : {}),
    ...(analysis ? { entityAnalysis: { analysisId: analysis.analysisId, revisionId: analysis.revision.revisionId,
      entityCount: analysis.revision.entities.length, mentionCount: analysis.revision.mentions.length,
      unresolvedCount: analysis.revision.entities.filter(entity => entity.identityStatus === 'unresolved').length,
      rejectedCount: run.entityRejections?.length ?? 0 } } : {}),
  };
}
export type ExtractionRunSummary = ReturnType<typeof extractionRunSummary>;
