import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { KnowledgeActor } from '../contracts.js';
import type { EvidenceStore } from '../extraction/evidence.js';
import { canonicalJson } from '../store.js';
import { ExtractionOutcomeSchema, ExtractionRunSchema, type ExtractionOutcome, type ExtractionOutcomeRef, type ExtractionRun, type ExtractionRunStore } from '../extraction/runs.js';
import { ExtractionGenerationPolicySchema, accountExtractionOutcome, EXTRACTION_FEEDBACK_PREAMBLE,
  REASK_EXTRACTION_FAILURES, TRANSIENT_EXTRACTION_FAILURES, type ExtractionGenerationPolicy } from '../extraction/generation-policy.js';
import { resolveTokenBudgetProfile } from '../../executors/contracts/token-budget.js';
import { serializeOpenAiChatBody } from '../../executors/contracts/openai-chat.js';
import { assertExtractionInputCapacity, extractionModelInput } from '../extraction/model-input.js';
import { OCCURRENCE_GUIDED_EXTRACTION_PROMPT_VERSION } from '../extraction/occurrence-guided-prompt.js';
import { extractionExecution, extractionPrompt, extractionRequestDigest, extractionResponse, type ExtractionModel } from '../extraction/generation.js';
import { checkWindowExtractionResponse } from '../extraction/window-proposals.js';
import { WINDOW_EXTRACTION_WIRE_SCHEMA } from '../extraction/model-wire.js';
import { mapEntityIdentity } from '../entities/identity.js';
import { parseExtractionStudyCorpus, type ExtractionStudyCorpus } from '../extraction/study-corpus.js';
import { ExtractionStudyPlanSchema, parseExtractionStudyPlan, checkVariation, EXTRACTION_STUDY_PLAN_MAX_BYTES,
  ExtractionStudyVariantSchema as Variant, ExtractionStudyCriteriaSchema as Criteria, ExtractionStudySamplingSchema as Sampling,
  type ExtractionStudyPlan, type ExtractionStudyHost, type ExtractionStudyVariantId } from '../extraction/study-plan.js';
export { parseExtractionStudyPlan } from '../extraction/study-plan.js';
export type { ExtractionStudyPlan, ExtractionStudyHost, ExtractionStudyVariantId } from '../extraction/study-plan.js';
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const text = z.string().min(1);

export interface ExtractionStudyVariantInput {
  variantId: ExtractionStudyVariantId; model: ExtractionModel; policy: ExtractionGenerationPolicy;
  promptProfile?: { profileVersion: 'knowledge-extraction-prompt-profile/v1'; promptVersion: string; system: string };
}
/** Frozen typed measurement host, deliberately separate from canonical body application/store. */
export interface FrozenExtractionStudyApplication {
  source: EvidenceStore['read']; capture: EvidenceStore['capture'];
  resume(runId: string, signal?: AbortSignal): ExtractionRun;
  generate(snapshotId: string, model: ExtractionModel, runId?: string, signal?: AbortSignal, options?: {
    policy?: ExtractionGenerationPolicy; promptProfile?: ExtractionStudyVariantInput['promptProfile'];
    beforeDispatch?: (claim: { runId: string; attemptId: string; requestDigest: string; budget?: ExtractionRun['attempts'][number]['budget'] }) => void;
    onOutcomeArchived?: (event: { runId: string; attemptId: string; outcome: ExtractionOutcome; ref: ExtractionOutcomeRef }) => void;
  }): Promise<ExtractionRun>;
}
export interface ExtractionStudyRunnerPorts {
  application: FrozenExtractionStudyApplication; runs: ExtractionRunStore; actor: KnowledgeActor;
  hash(value: unknown): string; id(): string; now(): string; identity(): ExtractionStudyHost;
  model(variant: ExtractionStudyPlan['variants'][number]): ExtractionModel;
}
export interface ExtractionStudyAttemptObservation {
  attemptId: string; archiveStatus: 'recorded' | 'pending'; ref: ExtractionOutcomeRef | null; outcome: ExtractionOutcome | null;
}
export interface ExtractionStudySlotObservation {
  slotId: string; caseId: string; variantId: ExtractionStudyVariantId; repeat: number;
  run: ExtractionRun | null; nativeVerified: boolean; attempts: ExtractionStudyAttemptObservation[];
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const frozenHash = (value: unknown) => extractionRequestDigest(value);

function rootRequest(plan: Pick<ExtractionStudyPlan, 'actor'>, selected: ExtractionStudyPlan['cases'][number],
  variant: ExtractionStudyPlan['variants'][number], hash: ExtractionStudyRunnerPorts['hash']) {
  return hash({ snapshotId: selected.snapshotId, sourceVersion: selected.sourceVersion, executor: variant.executor, model: variant.model,
    promptHash: hash(variant.promptProfile.system), inputDigest: hash(selected.input), actor: plan.actor, policy: variant.policy,
    outputMode: variant.outputMode, wireId: variant.wireId, timeoutMs: variant.timeoutMs, maxOutputTokens: variant.maxOutputTokens });
}

/** No generation. Both arms inspect the same already-captured production source windows. */
export function prepareExtractionStudy(ports: ExtractionStudyRunnerPorts, input: {
  corpus: ExtractionStudyCorpus; corpusBytesDigest: string; configurationDigest: string; split: ExtractionStudyPlan['split']; repeats: number;
  changedVariable: ExtractionStudyPlan['changedVariable']; variants: [ExtractionStudyVariantInput, ExtractionStudyVariantInput];
  criteria: z.infer<typeof Criteria>; sampling: z.infer<typeof Sampling>;
}): ExtractionStudyPlan {
  const corpus = parseExtractionStudyCorpus(input.corpus);
  const variants = input.variants.map(value => {
    const selected = extractionPrompt(value.model, value.promptProfile);
    assertSharedStudyInputTask(selected.promptVersion);
    return Variant.parse({ variantId: value.variantId, executor: value.model.executor, model: value.model.model,
      policy: ExtractionGenerationPolicySchema.parse(value.policy), promptProfile: { profileVersion: 'knowledge-extraction-prompt-profile/v1', promptVersion: selected.promptVersion, system: selected.system },
      outputMode: value.model.outputMode ?? 'prompt-json', wireId: value.model.wireId ?? null,
      timeoutMs: value.model.timeoutMs ?? 300_000, maxOutputTokens: value.model.maxOutputTokens ?? null });
  }) as ExtractionStudyPlan['variants'];
  checkVariation(variants, input.changedVariable);
  const cases = corpus.cases.filter(sample => sample.split === input.split).map(sample => {
    const resolved = ports.application.source(sample.window.snapshotId, sample.window.sourceVersion);
    if (resolved.status !== 'available' || !equal(resolved.window, sample.window)) throw new Error('Study corpus differs from the captured production source.');
    const body = extractionModelInput(resolved.window);
    for (const variant of variants) assertExtractionInputCapacity(body, variant.promptProfile.system);
    return { caseId: sample.caseId, snapshotId: sample.window.snapshotId, sourceVersion: sample.window.sourceVersion,
      windowDigest: frozenHash(sample.window), input: body, inputDigest: frozenHash(body) };
  });
  const base = { planVersion: 'omk-knowledge-extraction-study/v1' as const, declaredAt: ports.now(),
    corpusDigest: corpus.corpusDigest, corpusBytesDigest: digest.parse(input.corpusBytesDigest), configurationDigest: digest.parse(input.configurationDigest), split: input.split,
    caseIds: cases.map(value => value.caseId), repeats: input.repeats, changedVariable: input.changedVariable,
    orderPolicy: 'alternating-arm-first/v1' as const, criteria: Criteria.parse(input.criteria), sampling: Sampling.parse(input.sampling), host: ports.identity(), actor: ports.actor, variants, cases,
    retryOwnership: 'production-policy-only;existing-run-resume-only/v1' as const,
    evidenceScope: 'production-outcome;not-raw-provider-transport/v1' as const };
  const repeats = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(input.repeats);
  const templates = cases.map(sample => variants.map((variant, arm) => {
    const model = input.variants[arm].model;
    if (!model.inspect || model.dispatchGate !== 'producer-before-dispatch/v1') throw new Error('Study generation requires an inspectable production dispatch gate.');
    const execution = extractionExecution(model, variant.promptProfile.system, sample.input), { producer, ...request } = execution;
    return { caseId: sample.caseId, variantId: variant.variantId, requestDigest: rootRequest(base, sample, variant, ports.hash), request, producer };
  }));
  for (const sample of cases) {
    // Actual slot proofs retain each arm's request and request-dependent archive bound.
    // Compare conditions using the same request instead of stripping opaque proof fields.
    const common = input.variants.map(({ model }) => extractionExecution(model, variants[0].promptProfile.system, sample.input).producer);
    const identity = (producer: typeof common[number]) => input.changedVariable === 'policy' ? stableProducer(producer) : producer;
    if (!equal(identity(common[0]), identity(common[1]))) throw new Error('Study producer conditions differ between arms.');
  }
  const slotBytes = templates.flat().reduce((sum, value) => sum + BigInt(Buffer.byteLength(JSON.stringify({ ...value,
    slotId: `${value.caseId}-${value.variantId}-${repeats}`, repeat: repeats, runId: '00000000-0000-0000-0000-000000000000' }))) + 1n, 0n);
  if (BigInt(Buffer.byteLength(JSON.stringify(base))) + slotBytes * BigInt(repeats) + 256n > BigInt(EXTRACTION_STUDY_PLAN_MAX_BYTES)) throw new Error('Serialized study plan exceeds its 16 MiB evidence capacity.');
  const slots = cases.flatMap((sample, caseIndex) => Array.from({ length: repeats }, (_, index) => {
    const order = (caseIndex + index) % 2 ? [1, 0] : [0, 1];
    return order.map(arm => {
      const variant = variants[arm];
      return { slotId: `${sample.caseId}-${variant.variantId}-${index + 1}`,
        repeat: index + 1, runId: ports.id(), ...templates[caseIndex][arm] };
    });
  }).flat());
  const plan = parseExtractionStudyPlan({ ...base, slots, planId: frozenHash({ ...base, slots }) });
  assertContext(ports, plan, corpus);
  return plan;
}

function assertContext(ports: ExtractionStudyRunnerPorts, plan: ExtractionStudyPlan, corpusInput: ExtractionStudyCorpus) {
  for (const variant of plan.variants) assertSharedStudyInputTask(variant.promptProfile.promptVersion);
  const corpus = parseExtractionStudyCorpus(corpusInput);
  if (plan.corpusDigest !== corpus.corpusDigest || !equal(ports.identity(), plan.host) || !equal(ports.actor, plan.actor)
    || !equal(plan.caseIds, corpus.cases.filter(value => value.split === plan.split).map(value => value.caseId))) throw new Error('Study corpus, host or actor identity changed.');
  const selectedStrata = [...new Set(corpus.cases.filter(value => value.split === plan.split).map(value => value.stratumId))].sort();
  if (!equal(selectedStrata, plan.sampling.strata.map(value => value.stratumId).sort())) throw new Error('Frozen sampling strata differ from the selected sources.');
  for (const sample of plan.cases) {
    const original = corpus.cases.find(value => value.caseId === sample.caseId)!;
    const resolved = ports.application.source(sample.snapshotId, sample.sourceVersion);
    if (frozenHash(original.window) !== sample.windowDigest || resolved.status !== 'available'
      || frozenHash(resolved.window) !== sample.windowDigest || extractionModelInput(resolved.window) !== sample.input) throw new Error('Frozen study source is unavailable or changed.');
  }
}

function assertSharedStudyInputTask(promptVersion: string): void {
  if (promptVersion === OCCURRENCE_GUIDED_EXTRACTION_PROMPT_VERSION) {
    throw new Error('The v37 occurrence-guided task requires a distinct input; extraction study/v1 supports only one shared source input per case.');
  }
}

function attemptInput(sample: ExtractionStudyPlan['cases'][number], run: ExtractionRun, attemptIndex: number) {
  // Transient retries retain the last validation feedback. Production never concatenates prior outputs.
  const feedback = run.attempts.slice(0, attemptIndex + 1).reverse().find(value => value.trigger?.feedback)?.trigger?.feedback;
  return feedback ? JSON.stringify({ ...JSON.parse(sample.input), feedback: {
    feedbackVersion: feedback.feedbackVersion, ...JSON.parse(feedback.body),
  } }) : sample.input;
}

/** Only this API producer's body bytes may vary under declared policy caps or validation feedback. */
function stableProducer(producer: ReturnType<typeof extractionExecution>['producer']) {
  const proof = producer.proof;
  return producer.producerId === 'openai-chat-archive/v1' && proof !== null && typeof proof === 'object' && !Array.isArray(proof)
    ? { ...producer, proof: { ...proof, bodyDigest: null } } : producer;
}

function verifyRun(ports: ExtractionStudyRunnerPorts, plan: ExtractionStudyPlan, slot: ExtractionStudyPlan['slots'][number], runInput: ExtractionRun,
  inspect: boolean) {
  const run = ExtractionRunSchema.parse(runInput), sample = plan.cases.find(value => value.caseId === slot.caseId)!;
  const variant = plan.variants.find(value => value.variantId === slot.variantId)!;
  if (run.runId !== slot.runId || run.requestDigest !== slot.requestDigest || rootRequest(plan, sample, variant, ports.hash) !== slot.requestDigest
    || run.snapshotId !== sample.snapshotId || run.sourceVersion !== sample.sourceVersion || run.executor !== variant.executor || run.model !== variant.model
    || run.promptVersion !== variant.promptProfile.promptVersion || run.promptHash !== ports.hash(variant.promptProfile.system)
    || run.inputDigest !== ports.hash(sample.input) || !equal(run.policy, variant.policy) || !equal(run.actor, plan.actor)
    || Date.parse(run.startedAt) < Date.parse(plan.declaredAt)) throw new Error('Production run is outside its frozen study slot.');
  const model = inspect ? ports.model(variant) : undefined;
  if (model && (model.executor !== variant.executor || model.model !== variant.model || model.dispatchGate !== 'producer-before-dispatch/v1')) throw new Error('Study actual model differs from its frozen variant.');
  for (const [index, attempt] of run.attempts.entries()) {
    const body = attemptInput(sample, run, index);
    const expected = { ...slot.request, inputDigest: extractionExecutionDigest(body) };
    if (!equal(attempt.request, expected) || (index === 0 && !equal(attempt.producer, slot.producer))) throw new Error('Production attempt request differs from its frozen study input.');
    if (!equal(stableProducer(attempt.producer), stableProducer(slot.producer))) throw new Error('Study attempt producer conditions changed.');
    if (attempt.producer.producerId === 'openai-chat-archive/v1') {
      const requestBody = serializeOpenAiChatBody({ model: variant.model, system: variant.promptProfile.system, prompt: body,
        ...(variant.maxOutputTokens === null ? {} : { maxOutputTokens: variant.maxOutputTokens }),
        outputFormat: variant.outputMode === 'json-schema' ? { mode: 'json-schema', name: 'knowledge_extraction_v1', schema: WINDOW_EXTRACTION_WIRE_SCHEMA }
          : { mode: 'prompt-json' } }, 'single-completion/v1');
      const proof = attempt.producer.proof as Record<string, unknown>;
      if (proof.bodyDigest !== extractionExecutionDigest(requestBody)) throw new Error('Study attempt producer request body differs from its frozen input.');
    }
    if (attempt.budget) {
      const proof = attempt.producer.proof as Record<string, unknown>, policy = run.policy;
      if (policy.policyId !== 'knowledge-generation-bounded/v1' || typeof proof.endpoint !== 'string') throw new Error('Study budget has no frozen production profile.');
      const profile = resolveTokenBudgetProfile(policy.profileId, run.model, proof.endpoint);
      if (!equal(attempt.budget, { ...profile, outputUpperBound: policy.maxOutputTokens, tokensReserved: profile.inputUpperBound + policy.maxOutputTokens })) throw new Error('Study attempt token reservation differs from the frozen profile.');
    }
    const requestDigest = run.policy.policyId === 'knowledge-generation-single/v1'
      ? extractionRequestDigest({ requestDigest: run.requestDigest, request: attempt.request, producer: attempt.producer, policy: run.policy })
      : extractionRequestDigest({ requestDigest: run.requestDigest, request: attempt.request, producer: attempt.producer, policy: run.policy,
        budget: attempt.budget, trigger: attempt.trigger ?? null });
    if (attempt.requestDigest !== requestDigest) throw new Error('Study attempt request receipt mismatch.');
    if (model && !equal(extractionExecution(model, variant.promptProfile.system, body), { ...attempt.request, producer: attempt.producer })) throw new Error('Study actual producer inspect differs from the reservation.');
  }
  return run;
}

// Request system/input digests hash raw UTF-8; study identities hash canonical JSON data.
function extractionExecutionDigest(value: string) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }

function verifyNativeDerivations(run: ExtractionRun, attempts: ExtractionStudyAttemptObservation[], corpus: ExtractionStudyCorpus, caseId: string) {
  const sample = corpus.cases.find(value => value.caseId === caseId)!;
  for (const [index, attempt] of run.attempts.entries()) {
    const native = attempts[index].outcome;
    if (!native) continue;
    const decoded = extractionResponse(native, attempt.request.outputMode, attempt.request.wireId);
    let checked: ReturnType<typeof checkWindowExtractionResponse> | undefined;
    if (decoded.status === 'decoded') {
      try { checked = checkWindowExtractionResponse(decoded.response, sample.window.excerpts); }
      catch (error) { if (!(error instanceof z.ZodError)) throw error; }
    }
    if (attempt.admission && (!checked || !equal(attempt.admission, {
      assessmentVersion: 'knowledge-generation-admission/v1', entityCount: checked.analysis.entities.length,
      mentionCount: checked.analysis.mentions.length, proposalCount: checked.accepted.length,
      entityRejections: checked.analysis.rejected, rejections: checked.rejected,
    }))) throw new Error('Study attempt admission differs from its native output.');
    if (attempt.wireDiagnostic && (decoded.status !== 'decoded' || !decoded.wireDiagnostic || !equal(attempt.wireDiagnostic, {
      wireId: decoded.wireDiagnostic.wireId, wireStatus: decoded.wireDiagnostic.wireStatus,
      itemFailureCount: decoded.wireDiagnostic.itemFailures.length,
    }))) throw new Error('Study wire diagnostic differs from its native output.');
    const next = run.attempts[index + 1];
    if (next?.trigger) {
      const policy = run.policy;
      if (policy.policyId !== 'knowledge-generation-bounded/v1' || attempt.accounting?.status === 'policy_violation') throw new Error('Study retry has no eligible predecessor.');
      const actualFailure = decoded.status === 'failed' ? decoded.failure.failureKind : !checked ? 'envelope_error' : null;
      const transient = actualFailure !== null && TRANSIENT_EXTRACTION_FAILURES.has(actualFailure);
      const validation = actualFailure !== null && REASK_EXTRACTION_FAILURES.has(actualFailure)
        || !!checked && !checked.analysis.entities.length && !checked.accepted.length
          && (!!checked.analysis.rejected.length || !!checked.rejected.length || decoded.status === 'decoded' && decoded.wireDiagnostic?.wireStatus === 'item_failures');
      if ((next.trigger.triggerKind === 'transient' && !transient) || (next.trigger.triggerKind === 'validation' && (transient || !validation))) throw new Error('Study retry trigger is unsupported by the archived predecessor.');
      if (next.trigger.triggerKind === 'validation') {
        const diagnostics = [...(attempt.admission?.entityRejections ?? []).map(value => ({ component: value.component, index: value.index, reasons: value.reasons })),
          ...(attempt.admission?.rejections ?? []).map(value => ({ component: 'proposal', index: value.index, reasons: value.reasons }))];
        const body = JSON.stringify({ instruction: EXTRACTION_FEEDBACK_PREAMBLE,
          failureCode: attempt.failure?.failureKind ?? 'empty_validation', diagnostics: diagnostics.slice(0, 12).map(value => ({
            component: value.component, index: value.index,
            codes: value.reasons.slice(0, 6).map(reason => reason.split(':')[0].replace(/[^a-z_]/g, '').slice(0, 48)) })) });
        if (!equal(next.trigger.feedback, { feedbackVersion: policy.feedbackVersion, body, digest: extractionRequestDigest({ body }) })) throw new Error('Study validation feedback differs from production diagnostics.');
      }
      const result = native.outcomeKind === 'result' ? native.result : undefined;
      const failure = result?.failure;
      const retryAfter = failure && typeof failure === 'object' && !Array.isArray(failure) ? failure.retryAfterMs : undefined;
      const cap = Math.min(policy.backoff.capMs, policy.backoff.baseMs * 2 ** index);
      if (retryAfter !== undefined && (typeof retryAfter !== 'number' || !Number.isSafeInteger(retryAfter) || retryAfter < 0 || retryAfter > policy.backoff.retryAfterCapMs)
        || next.trigger.delayMs < (typeof retryAfter === 'number' ? retryAfter : 0)
        || next.trigger.delayMs > Math.max(cap, typeof retryAfter === 'number' ? retryAfter : 0)) throw new Error('Study retry delay exceeds its frozen policy.');
    }
    if (run.selectedAttemptId !== attempt.attemptId || !run.entityAnalysis) continue;
    if (!checked || decoded.status !== 'decoded' || attempt.accounting?.status === 'policy_violation') throw new Error('Study birth has no successful native admission.');
    const birth = run.entityAnalysis.revision;
    if (birth.entities.length !== checked.analysis.entities.length || birth.mentions.length !== checked.analysis.mentions.length
      || run.intents.length !== checked.accepted.length) throw new Error('Study birth counts differ from native admission.');
    const entityIds = new Map(checked.analysis.entities.map((value, itemIndex) => [value.entityId, birth.entities[itemIndex].entityId]));
    const mentionIds = new Map(checked.analysis.mentions.map((value, itemIndex) => [value.mentionId, birth.mentions[itemIndex].mentionId]));
    const mapMention = (value: typeof checked.analysis.mentions[number]) => ({ ...value,
      mentionId: mentionIds.get(value.mentionId)!, entityId: entityIds.get(value.entityId)! });
    if (!equal(birth.entities, checked.analysis.entities.map(value => mapEntityIdentity(value, entityIds, mentionIds)))
      || !equal(birth.mentions, checked.analysis.mentions.map(mapMention)) || !equal(birth.limitations, sample.window.limitations)
      || !equal(run.entityRejections, checked.analysis.rejected) || !equal(run.rejections, checked.rejected)) throw new Error('Study entity birth differs from native admission.');
    for (const [itemIndex, proposal] of checked.accepted.entries()) {
      const intent = run.intents[itemIndex], revision = intent.revision;
      const draft = { ...proposal.draft,
        entities: proposal.draft.entities.map(value => ({ ...value, entityId: entityIds.get(value.entityId)! })),
        content: { ...proposal.draft.content, statements: proposal.draft.content.statements.map(value => ({ ...value,
          subject: { entityId: entityIds.get(value.subject.entityId)! }, ...(value.object ? { object: { entityId: entityIds.get(value.object.entityId)! } } : {}) })) } };
      const grounding = { revisionId: revision.revisionId,
        mentions: proposal.mentions.map(mapMention), citations: proposal.citations, reuseRationale: proposal.reuseRationale,
        identityUncertainties: proposal.identityUncertainties,
        sourceBindings: [{ snapshotId: sample.window.snapshotId, sourceVersion: sample.window.sourceVersion,
          evidenceRefs: [...new Set([...draft.evidence.map(value => value.evidenceRef), ...proposal.mentions.map(value => value.selection.evidenceRef)])] }],
        entityAnalysisRef: { analysisId: run.runId, revisionId: birth.revisionId } };
      if (!equal(draft, { title: revision.title, entities: revision.entities, content: revision.content, evidence: revision.evidence })
        || !equal(grounding, intent.grounding) || revision.observationRefs.length || revision.derivations.length) throw new Error('Study knowledge birth differs from native admission.');
    }
  }
}

function observeExtractionStudyRun(ports: ExtractionStudyRunnerPorts, plan: ExtractionStudyPlan,
  slot: ExtractionStudyPlan['slots'][number], runInput: ExtractionRun, corpus: ExtractionStudyCorpus): ExtractionStudySlotObservation {
  const run = verifyRun(ports, plan, slot, runInput, false);
  const attempts = run.attempts.map(attempt => {
    try {
      const native = ports.runs.readOutcome(run.runId, attempt.attemptId, attempt.outcome);
      if (attempt.accounting && (!attempt.budget || !equal(attempt.accounting, accountExtractionOutcome(native.outcome, attempt.budget)))) throw new Error('Study attempt accounting differs from its native archive.');
      return { attemptId: attempt.attemptId, archiveStatus: 'recorded' as const, ...native };
    } catch (error) {
      if (!missing(error) || attempt.outcome) throw error;
      return { attemptId: attempt.attemptId, archiveStatus: 'pending' as const, ref: null, outcome: null };
    }
  });
  const selected = run.attempts.find(value => value.attemptId === run.selectedAttemptId) ?? run.attempts.at(-1)!;
  const selectedOutcome = attempts.find(value => value.attemptId === selected.attemptId)?.outcome;
  const selectedResult = selectedOutcome && selectedOutcome.outcomeKind !== 'exception' ? selectedOutcome.result as Record<string, unknown> : null;
  if ((run.rawOutput !== undefined && selectedResult?.output !== run.rawOutput)
    || (run.runtime && (!selectedResult || Object.entries(run.runtime).some(([key, value]) => selectedResult[key] !== value)))) throw new Error('Study run selected projection differs from its native archive.');
  verifyNativeDerivations(run, attempts, corpus, slot.caseId);
  return { slotId: slot.slotId, caseId: slot.caseId, variantId: slot.variantId, repeat: slot.repeat, run,
    nativeVerified: attempts.every(value => value.archiveStatus === 'recorded'), attempts };
}

/** Read every planned slot and native attempt, replaying the frozen production checker without mutation or model construction. */
export function reportExtractionStudy(ports: ExtractionStudyRunnerPorts, planInput: unknown, corpus: ExtractionStudyCorpus) {
  const plan = parseExtractionStudyPlan(planInput); assertContext(ports, plan, corpus);
  const slots: ExtractionStudySlotObservation[] = plan.slots.map(slot => {
    let run: ExtractionRun;
    try { run = ports.runs.read(slot.runId); }
    catch (error) { if (!missing(error)) throw error; return { ...slot, run: null, nativeVerified: false, attempts: [] }; }
    return observeExtractionStudyRun(ports, plan, slot, run, corpus);
  });
  const attempts = slots.flatMap(value => value.attempts);
  const metric = (attempt: ExtractionStudyAttemptObservation, field: string, flag?: string) => {
    const result = attempt.outcome && attempt.outcome.outcomeKind !== 'exception' ? attempt.outcome.result as Record<string, unknown> : undefined;
    if (field === 'attemptCount' && attempt.outcome?.outcomeKind !== 'result') return null;
    // ExecResult's existing contract treats a missing attemptCount as one; exceptions have no such witness.
    const value = field === 'attemptCount' ? result?.[field] ?? 1 : result?.[field];
    return result && (!flag || result[flag] !== false) && typeof value === 'number' && Number.isFinite(value) && value >= 0
      && (!(field.endsWith('Tokens') || field === 'attemptCount') || Number.isSafeInteger(value))
      && (field !== 'attemptCount' || value >= 1) ? value : null;
  };
  const total = (field: string, flag?: string) => {
    const values = attempts.map(value => metric(value, field, flag));
    if (!values.length || values.some(value => value === null) || slots.some(value => !value.run || !value.nativeVerified)) return null;
    const sum = values.reduce<number>((sum, value) => sum + value!, 0);
    return Number.isFinite(sum) && (!(field.endsWith('Tokens') || field === 'attemptCount') || Number.isSafeInteger(sum)) ? sum : null;
  };
  const outputDigest = frozenHash(slots);
  return { reportVersion: 'omk-knowledge-extraction-study-report/v1' as const, planId: plan.planId, corpusDigest: plan.corpusDigest,
    outputDigest, slots, integrity: { planVerified: true, outputVerified: true }, summary: { planned: slots.length, unattempted: slots.filter(value => !value.run).length,
      incomplete: slots.filter(value => value.run && (!value.nativeVerified || ['generating', 'prepared'].includes(value.run.status))).length,
      generating: slots.filter(value => value.run?.status === 'generating').length, prepared: slots.filter(value => value.run?.status === 'prepared').length,
      archivePending: slots.filter(value => value.run && !value.nativeVerified).length,
      completed: slots.filter(value => value.run?.status === 'completed').length, failed: slots.filter(value => value.run?.status === 'failed').length,
      cancelled: slots.filter(value => value.run?.status === 'cancelled').length, attempts: attempts.length,
      recordedNative: attempts.filter(value => value.archiveStatus === 'recorded').length,
      executorReportedAttempts: total('attemptCount'),
      totalDurationMs: total('durationMs'), totalCostUSD: total('costUSD', 'costReportedByExecutor'),
      totalInputTokens: total('inputTokens', 'tokenUsageReportedByExecutor'), totalOutputTokens: total('outputTokens', 'tokenUsageReportedByExecutor'),
      totalCacheReadTokens: total('cacheReadTokens', 'tokenUsageReportedByExecutor'), totalCacheCreationTokens: total('cacheCreationTokens', 'tokenUsageReportedByExecutor') },
    modelCallsByThisCommand: 0, goldReady: false, semanticReview: 'pending' as const, independentHumanReview: 'pending' as const,
    qualityConclusion: 'not_evaluated' as const,
    limitations: ['Native archives are production executor observations, not raw provider transport or provider internal call counts.',
      'Summary attempts counts OMK production attempts; executorReportedAttempts separately sums native attemptCount, with missing equal to one under the existing executor contract.',
      'Unknown or unattempted spend is never reported as zero. Reference and output review are separate evidence.'] };
}

const Evidence = z.strictObject({ evidenceVersion: z.literal('omk-knowledge-extraction-study-evidence/v1'),
  plan: ExtractionStudyPlanSchema, corpusRaw: text, configurationRaw: text, records: z.array(z.strictObject({ runId: z.string().uuid(), raw: text,
    outcomes: z.array(z.strictObject({ attemptId: z.string().uuid(), raw: text })) })) });

/** Portable evidence is re-derived from original run and native JSON bytes, never trusted report/status booleans. */
export function replayExtractionStudyEvidence(input: unknown, expectedHost?: ExtractionStudyHost) {
  const evidence = Evidence.parse(input), plan = parseExtractionStudyPlan(evidence.plan);
  if (expectedHost && !equal(expectedHost, plan.host)) throw new Error('Portable study requires its frozen runtime and checker identity.');
  const rawHash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
  if (rawHash(evidence.corpusRaw) !== plan.corpusBytesDigest || rawHash(evidence.configurationRaw) !== plan.configurationDigest) throw new Error('Portable study corpus or configuration raw identity mismatch.');
  const corpus = parseExtractionStudyCorpus(JSON.parse(evidence.corpusRaw));
  const runRecords = new Map<string, ExtractionRun>(), nativeRecords = new Map<string, { outcome: ExtractionOutcome; ref: ExtractionOutcomeRef }>();
  for (const record of evidence.records) {
    if (runRecords.has(record.runId) || !plan.slots.some(slot => slot.runId === record.runId)) throw new Error('Unknown or duplicate portable study run.');
    const run = ExtractionRunSchema.parse(JSON.parse(record.raw));
    if (run.runId !== record.runId) throw new Error('Portable run file identity mismatch.');
    runRecords.set(record.runId, run);
    for (const native of record.outcomes) {
      const key = `${record.runId}/${native.attemptId}`;
      if (nativeRecords.has(key) || !run.attempts.some(attempt => attempt.attemptId === native.attemptId)) throw new Error('Unknown or duplicate portable native attempt.');
      const parsed = z.strictObject({ storeKind: z.literal('knowledge-extraction-attempt-outcome'), schemaVersion: z.literal(1),
        runId: z.literal(record.runId), attemptId: z.literal(native.attemptId), outcome: ExtractionOutcomeSchema }).parse(JSON.parse(native.raw));
      const bytes = Buffer.from(native.raw, 'utf8');
      if (bytes.toString('utf8') !== native.raw) throw new Error('Portable native evidence is not raw UTF-8.');
      nativeRecords.set(key, { outcome: parsed.outcome, ref: { bytes: bytes.length, digest: rawHash(native.raw) } });
    }
  }
  const absent = () => Object.assign(new Error('Study evidence is not recorded.'), { code: 'ENOENT' });
  const forbidden = () => { throw new Error('Portable study replay cannot write or generate.'); };
  const runs: ExtractionRunStore = { create: forbidden, save: forbidden, writeOutcome: forbidden,
    listManifests: () => [...runRecords.values()], read: runId => { const run = runRecords.get(runId); if (!run) throw absent(); return run; },
    readOutcome: (runId, attemptId, expected) => {
      const native = nativeRecords.get(`${runId}/${attemptId}`); if (!native) throw absent();
      if (expected && !equal(expected, native.ref)) throw new Error('Portable native archive digest mismatch.');
      return native;
    } };
  const source = (snapshotId: string, sourceVersion?: string) => {
    const sample = corpus.cases.find(value => value.window.snapshotId === snapshotId && (!sourceVersion || value.window.sourceVersion === sourceVersion));
    return sample ? { status: 'available' as const, window: sample.window } : { status: 'unavailable' as const, reason: 'missing' as const, detail: 'Not in frozen corpus.' };
  };
  const report = reportExtractionStudy({ application: { source, capture: forbidden, generate: forbidden, resume: forbidden }, runs, actor: plan.actor,
    hash: extractionRequestDigest, id: forbidden, now: forbidden, identity: () => plan.host, model: forbidden }, plan, corpus);
  return { ...report, integrity: { planVerified: true, outputVerified: !!expectedHost }, evidenceDigest: frozenHash(evidence),
    hostEvidence: 'frozen-plan-claim;current-host-not-required-for-read-only-replay' as const };
}

/** Advance one frozen slot. A persisted run grants recovery only, never another invocation. */
export async function runExtractionStudySlot(ports: ExtractionStudyRunnerPorts, input: {
  plan: unknown; corpus: ExtractionStudyCorpus; slotId: string; signal?: AbortSignal;
  beforeDispatch?: () => void; onOutcomeArchived?: (event: { runId: string; attemptId: string; outcome: ExtractionOutcome; ref: ExtractionOutcomeRef }) => void;
}) {
  const plan = parseExtractionStudyPlan(input.plan); assertContext(ports, plan, input.corpus);
  const index = plan.slots.findIndex(value => value.slotId === input.slotId), slot = plan.slots[index];
  if (!slot) throw new Error('Unknown study slot.');
  const variant = plan.variants.find(value => value.variantId === slot.variantId)!, sample = plan.cases.find(value => value.caseId === slot.caseId)!;
  let previous: ExtractionRun | undefined;
  try { previous = ports.runs.read(slot.runId); } catch (error) { if (!missing(error)) throw error; }
  if (previous) {
    verifyRun(ports, plan, slot, previous, false);
    ports.application.resume(slot.runId, input.signal);
    return reportExtractionStudy(ports, plan, input.corpus);
  }
  // Paired ordering is enforced, including unknown predecessor reservations. Failed outcomes remain visible and may precede the other arm.
  for (const predecessor of plan.slots.slice(0, index)) {
    let run: ExtractionRun;
    try { run = ports.runs.read(predecessor.runId); }
    catch (error) { if (missing(error)) throw new Error('Study slots must run in their predeclared order.'); throw error; }
    const observation = observeExtractionStudyRun(ports, plan, predecessor, run, input.corpus);
    if (!['completed', 'failed', 'cancelled'].includes(run.status) || !observation.nativeVerified) throw new Error('Previous study slot has an unknown or incomplete invocation; no new dispatch allowed.');
  }
  const model = ports.model(variant);
  if (!equal(extractionExecution(model, variant.promptProfile.system, sample.input), { ...slot.request, producer: slot.producer })) throw new Error('Study producer changed after preparation.');
  await ports.application.generate(sample.snapshotId, model, slot.runId, input.signal, { policy: variant.policy, promptProfile: variant.promptProfile,
    beforeDispatch(claim) {
      assertContext(ports, plan, input.corpus);
      const run = verifyRun(ports, plan, slot, ports.runs.read(slot.runId), true), attempt = run.attempts.at(-1)!;
      if (claim.runId !== slot.runId || claim.attemptId !== attempt.attemptId || claim.requestDigest !== attempt.requestDigest
        || !equal(claim.budget ?? null, attempt.budget ?? null)) throw new Error('Study dispatch claim is outside the saved reservation.');
      input.beforeDispatch?.();
    }, onOutcomeArchived: input.onOutcomeArchived });
  return reportExtractionStudy(ports, plan, input.corpus);
}
