import { createHash } from 'node:crypto';
import { z } from 'zod';
import { KnowledgeActorSchema } from '../contracts.js';
import { canonicalJson } from '../store.js';
import { ExtractionAttemptSchema } from './runs.js';
import { ExtractionGenerationPolicySchema } from './generation-policy.js';
import { extractionPrompt, extractionRequestDigest } from './generation.js';
import { WINDOW_EXTRACTION_WIRE_ID, WINDOW_EXTRACTION_WIRE_SCHEMA } from './model-wire.js';
import { serializeOpenAiChatBody } from '../../executors/contracts/openai-chat.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const text = z.string().min(1);
const variantId = z.enum(['baseline', 'candidate']);
const Prompt = z.strictObject({ profileVersion: z.literal('knowledge-extraction-prompt-profile/v1'), promptVersion: text, system: text });
const Criteria = z.strictObject({ maxConfirmedErrors: z.number().int().nonnegative(), confirmedErrorsRationale: text,
  maxRequiredGaps: z.number().int().nonnegative(), requiredGapsRationale: text });
const Sampling = z.strictObject({ selectionFrame: text, inclusionExclusion: text, unit: z.literal('lineage-group'),
  strata: z.array(z.strictObject({ stratumId: text, coverageRationale: text })).min(1), sampleSizeRationale: text,
  stoppingRule: text, budgetRationale: text, interruptionPolicy: text });
/** Serialized plan capacity, not an arbitrary model-call allowance. */
export const EXTRACTION_STUDY_PLAN_MAX_BYTES = 16 * 1024 * 1024;
const Host = z.strictObject({ runtimeDigest: digest, dependencyDigest: digest, runnerDigest: digest,
  nodeVersion: text, nodeBinaryDigest: digest });
const Variant = z.strictObject({ variantId, executor: text, model: text, policy: ExtractionGenerationPolicySchema,
  promptProfile: Prompt, outputMode: z.enum(['json-schema', 'prompt-json']), wireId: digest.nullable(),
  timeoutMs: z.number().int().positive(), maxOutputTokens: z.number().int().positive().nullable() });
const Request = ExtractionAttemptSchema.shape.request;
const Producer = ExtractionAttemptSchema.shape.producer;
const Case = z.strictObject({ caseId: text, snapshotId: z.string().uuid(), sourceVersion: digest,
  windowDigest: digest, input: text, inputDigest: digest });
const Slot = z.strictObject({ slotId: text, caseId: text, variantId, repeat: z.number().int().positive(),
  runId: z.string().uuid(), requestDigest: digest, request: Request, producer: Producer });
export const ExtractionStudyPlanSchema = z.strictObject({
  planVersion: z.literal('omk-knowledge-extraction-study/v1'), planId: digest, declaredAt: z.iso.datetime({ offset: true }),
  corpusDigest: digest, corpusBytesDigest: digest, configurationDigest: digest, split: z.enum(['development', 'validation']),
  caseIds: z.array(text).min(1), repeats: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  changedVariable: z.enum(['prompt', 'policy', 'replication']), orderPolicy: z.literal('alternating-arm-first/v1'),
  criteria: Criteria, sampling: Sampling,
  host: Host, actor: KnowledgeActorSchema, variants: z.tuple([Variant, Variant]), cases: z.array(Case).min(1), slots: z.array(Slot).min(2),
  retryOwnership: z.literal('production-policy-only;existing-run-resume-only/v1'),
  evidenceScope: z.literal('production-outcome;not-raw-provider-transport/v1'),
});
export type ExtractionStudyPlan = z.infer<typeof ExtractionStudyPlanSchema>;
export type ExtractionStudyHost = z.infer<typeof Host>;
export type ExtractionStudyVariantId = z.infer<typeof variantId>;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const frozenHash = extractionRequestDigest;
const rawHash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export function checkVariation(variants: ExtractionStudyPlan['variants'], changed: ExtractionStudyPlan['changedVariable']) {
  const [a, b] = variants;
  if (a.variantId !== 'baseline' || b.variantId !== 'candidate') throw new Error('Study variants must be baseline, then candidate.');
  const shared = (value: typeof a) => ({ executor: value.executor, model: value.model, outputMode: value.outputMode,
    wireId: value.wireId, timeoutMs: value.timeoutMs,
    ...(changed === 'policy' ? {} : { maxOutputTokens: value.maxOutputTokens }),
    ...(changed === 'prompt' ? {} : { promptProfile: value.promptProfile }),
    ...(changed === 'policy' ? {} : { policy: value.policy }) });
  if (!equal(shared(a), shared(b))) throw new Error('Study changes more than its declared variable.');
  if (changed === 'prompt' && (a.promptProfile.system === b.promptProfile.system || a.promptProfile.promptVersion === b.promptProfile.promptVersion)) {
    throw new Error('Prompt contrast needs distinct version labels and raw system bytes.');
  }
  if (changed === 'policy' && equal(a.policy, b.policy)) throw new Error('Policy contrast needs distinct production policies.');
}

/** Pure validation of the frozen plan, including the complete ordered paired slot denominator. */
export function parseExtractionStudyPlan(input: unknown): ExtractionStudyPlan {
  const plan = ExtractionStudyPlanSchema.parse(input), { planId, ...body } = plan;
  if (Buffer.byteLength(JSON.stringify(plan)) > EXTRACTION_STUDY_PLAN_MAX_BYTES) throw new Error('Serialized study plan exceeds its 16 MiB evidence capacity.');
  if (frozenHash(body) !== planId) throw new Error('Study plan identity mismatch.');
  checkVariation(plan.variants, plan.changedVariable);
  for (const variant of plan.variants) {
    extractionPrompt({ outputMode: variant.outputMode }, variant.promptProfile);
    if (Buffer.from(variant.promptProfile.system).toString('utf8') !== variant.promptProfile.system
      || variant.outputMode === 'json-schema' && variant.wireId !== WINDOW_EXTRACTION_WIRE_ID
      || variant.outputMode === 'prompt-json' && variant.wireId !== null) throw new Error('Study prompt raw bytes or wire identity is invalid.');
  }
  if (new Set(plan.caseIds).size !== plan.caseIds.length || !equal(plan.caseIds, plan.cases.map(value => value.caseId))) throw new Error('Study case selection differs from its frozen denominator.');
  const expectedCount = BigInt(plan.cases.length) * BigInt(plan.repeats) * 2n;
  if (expectedCount !== BigInt(plan.slots.length) || new Set(plan.slots.map(value => value.slotId)).size !== plan.slots.length
    || new Set(plan.slots.map(value => value.runId)).size !== plan.slots.length) throw new Error('Study paired slot sequence is invalid.');
  for (const [index, slot] of plan.slots.entries()) {
    const pairIndex = Math.floor(index / 2), caseIndex = Math.floor(pairIndex / plan.repeats), repeatIndex = pairIndex % plan.repeats;
    const arms = (caseIndex + repeatIndex) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    if (slot.caseId !== plan.cases[caseIndex].caseId || slot.repeat !== repeatIndex + 1 || slot.variantId !== arms[index % 2]) throw new Error('Study paired slot sequence is invalid.');
    const sample = plan.cases[caseIndex], variant = plan.variants.find(value => value.variantId === slot.variantId)!;
    const request = { systemDigest: rawHash(variant.promptProfile.system), inputDigest: rawHash(sample.input), outputMode: variant.outputMode,
      ...(variant.wireId ? { wireId: variant.wireId } : {}), timeoutMs: variant.timeoutMs,
      ...(variant.maxOutputTokens === null ? {} : { maxOutputTokens: variant.maxOutputTokens }) };
    const requestDigest = frozenHash({ snapshotId: sample.snapshotId, sourceVersion: sample.sourceVersion,
      executor: variant.executor, model: variant.model, promptHash: frozenHash(variant.promptProfile.system), inputDigest: frozenHash(sample.input),
      actor: plan.actor, policy: variant.policy, outputMode: variant.outputMode, wireId: variant.wireId,
      timeoutMs: variant.timeoutMs, maxOutputTokens: variant.maxOutputTokens });
    if (!equal(slot.request, request) || slot.requestDigest !== requestDigest) throw new Error('Study slot request identity differs from its frozen prompt/input/configuration.');
    const proof = slot.producer.proof as Record<string, unknown>;
    if (slot.producer.producerId === 'openai-chat-archive/v1') {
      const body = serializeOpenAiChatBody({ model: variant.model, system: variant.promptProfile.system, prompt: sample.input,
        ...(variant.maxOutputTokens === null ? {} : { maxOutputTokens: variant.maxOutputTokens }),
        outputFormat: variant.outputMode === 'json-schema' ? { mode: 'json-schema', name: 'knowledge_extraction_v1', schema: WINDOW_EXTRACTION_WIRE_SCHEMA }
          : { mode: 'prompt-json' } }, 'single-completion/v1');
      if (proof?.proofKind !== 'openai-chat-return-bound/v1' || proof.bodyDigest !== rawHash(body)) throw new Error('Frozen study producer request body differs from its declared input.');
    }
  }
  if (new Set(plan.sampling.strata.map(value => value.stratumId)).size !== plan.sampling.strata.length) throw new Error('Duplicate sampling stratum.');
  for (const sample of plan.cases) if (sample.inputDigest !== frozenHash(sample.input)) throw new Error('Frozen study input changed.');
  return plan;
}


export { Variant as ExtractionStudyVariantSchema, Criteria as ExtractionStudyCriteriaSchema, Sampling as ExtractionStudySamplingSchema };
