import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ENTITY_CHECK_VERSION, ENTITY_GUIDE_VERSION, entityReviewInput, parseEntityReviewCorpus } from './entity-review-corpus.js';
import { reviewOutputRoot } from './entity-extraction-review.js';
import { bytesDigest, canonical, captureHostIdentity, identityDigest, loadCaptureRuntime, type CaptureInput, type NativeResult } from './entity-capture-provider.js';
import { OPENAI_CAPTURE_BUDGET_EVIDENCE, OPENAI_CAPTURE_BUDGET_EVIDENCE_DIGEST, resolveCaptureBudgetProfile } from './entity-capture-profile.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/); const positive = z.number().int().positive();
const key = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/); const text = z.string().min(1); const time = z.iso.datetime({ offset: true });
const Excerpt = z.strictObject({ evidenceRef: text, recordIndex: z.number().int().nonnegative(), eventKind: z.literal('message'), role: z.enum(['user', 'assistant']), text });
const Case = z.strictObject({ caseId: key, split: z.enum(['development', 'validation']), excerpts: z.array(Excerpt).min(1), limitations: z.array(text).min(1) });
/** Separate from synthetic corpus v12; real input is development-only, never gold or a model capture. */
export const CaptureSourceSchema = z.strictObject({ sourceVersion: z.literal('omk-entity-capture-source/v1'),
  provenance: z.strictObject({ sourceKind: z.enum(['synthetic', 'public-redacted-real', 'private-real']), originDigest: digest,
    transformation: text, toolPolicy: z.literal('excluded') }),
  review: z.strictObject({ human: z.literal('pending'), independent: z.literal('pending'), gold: z.literal('none') }),
  cases: z.array(Case.extend({ split: z.literal('development') })).min(1).max(64) });
const Config = z.strictObject({ executor: z.enum(['openai-api', 'codex']), model: text, profileId: text,
  timeoutMs: positive.max(2_147_483_647), maxOutputTokens: positive, maxCalls: positive, maxTokens: positive,
  outputMode: z.enum(['prompt-json', 'json-object', 'json-schema']), schemaName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).nullable(),
  promptVariant: z.enum(['v14-original', 'v14-derived', 'v15-candidate']),
  caseIds: z.array(key).min(1), split: z.enum(['development', 'validation']), repeats: z.union([z.literal(1), z.literal(2)]) });
const Host = z.strictObject({ runtimeDigest: digest, collectorDigest: digest, checkerDigest: digest, dependencyDigest: digest,
  guideDigest: digest, validatorIdentity: z.strictObject({ zod: text, ajv: text }), nodeVersion: text, nodeBinaryDigest: digest });
const ReviewIdentity = z.object({ corpusVersion: text, checkVersion: text, guideVersion: text, corpusDigest: digest, guideDigest: digest,
  checkerDigest: digest, runtimeDigest: digest, dependencyDigest: digest, nodeVersion: text, promptVersion: text,
  promptHash: digest, promptHashEncoding: z.literal('raw-utf8'), responseSchemaVersion: z.literal(4) });
const Slot = z.strictObject({ slotId: key, caseId: key, repeat: positive, inputDigest: digest, requestDigest: digest.nullable() });
const Plan = z.strictObject({ planVersion: z.literal('omk-entity-live-plan/v1'), planId: digest, createdAt: time,
  host: Host, checkVersion: text, guideVersion: text, config: Config,
  source: z.strictObject({ sourceKind: z.enum(['review-bundle', 'capture-source']), digest, provenance: z.enum(['synthetic', 'public-redacted-real', 'private-real']),
    sourceMeasurementId: digest.nullable(), reviewManifestDigest: digest.nullable() }),
  promptDigest: digest, promptBytes: positive, wireSchemaDigest: digest.nullable(), wireId: digest.nullable(),
  endpoint: text.nullable(), protocol: text, requestBuilderVersion: text,
  configurationPolicy: z.literal('shared-builder-fields-only;provider-defaults-unreported'),
  usageEvidence: z.literal('executor-standardized;provider-bucket-presence-unreported'),
  auditability: z.literal('requested-provider-identity;server-model-and-fingerprint-unreported'),
  budgetEvidenceDigest: digest, slots: z.array(Slot).min(1),
  retry: z.literal('one-invocation-per-slot;no-reask;never-retry-reserved'),
  transport: z.literal('single-completion/v1;redirect-error'),
});
export type LiveCapturePlan = z.infer<typeof Plan>;
const Permission = z.strictObject({ authorizationVersion: z.literal('omk-entity-live-permission/v1'), authorizationStatus: z.literal('granted'),
  planId: digest, sourceDigest: digest, promptDigest: digest, endpoint: text, executor: z.literal('openai-api'), model: text,
  maxCalls: positive, maxTokens: positive, grantedAt: time, expiresAt: time, authorizedBy: text,
  action: z.literal('send-frozen-selected-inputs-to-the-declared-model') });
const Reservation = z.strictObject({ ledgerVersion: z.literal('omk-entity-live-ledger/v1'), planId: digest, permissionDigest: digest,
  slot: Slot, reservedAt: time, tokenReservation: positive });
const Native = z.object({ ok: z.boolean(), output: z.string().nullable(), error: z.string().optional(), refusal: z.string().optional(),
  failure: z.object({ failureKind: text }).passthrough().optional(), attemptCount: positive.optional(), toolCalls: z.array(z.unknown()).optional(),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), cacheReadTokens: z.number().int().nonnegative(), cacheCreationTokens: z.number().int().nonnegative(),
  tokenUsageReportedByExecutor: z.boolean().optional(), costUSD: z.number().finite().nonnegative(), costReportedByExecutor: z.boolean().optional() }).passthrough();
const Attempt = z.strictObject({ attemptVersion: z.literal('omk-entity-live-attempt/v1'), reservationDigest: digest, finishedAt: time,
  nativeDigest: digest.nullable(), nativeException: z.string().nullable(), dispatchCount: z.number().int().min(0).max(1), cancelled: z.boolean(),
  outcome: text, usage: z.strictObject({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), cacheReadTokens: z.number().nullable(), cacheCreationTokens: z.number().nullable() }),
  costUSD: z.number().nullable(), blocked: z.boolean() });
type AttemptRecord = z.infer<typeof Attempt>;
const ORIGINAL_V14 = 'sha256:e3acd05eca278b0e34f5d8b75767176c5ede7ce7fade561975eb1f4e4c417399';
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const utf8 = (bytes: Buffer) => { const value = bytes.toString('utf8'); if (!Buffer.from(value).equals(bytes)) throw new Error('Evidence is not valid raw UTF-8.'); return value; };
function syncDirectory(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function publish(path: string, bytes: string | Uint8Array) {
  const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path)); // Persist the reservation's name before any dispatch, not only its contents.
}
const publishJson = (path: string, value: unknown) => publish(path, JSON.stringify(value, null, 2) + '\n');
function privateDirectory(path: string) { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Evidence directory must not be a symlink.'); }
function sourceCases(raw: Buffer, sourceKind: LiveCapturePlan['source']['sourceKind'], manifest?: Buffer) {
  if (sourceKind === 'capture-source') {
    const source = CaptureSourceSchema.parse(JSON.parse(utf8(raw)));
    return { cases: source.cases, provenance: source.provenance.sourceKind, sourceMeasurementId: null };
  }
  const corpus = parseEntityReviewCorpus(utf8(raw)); const metadata = JSON.parse(utf8(manifest!)); const review = ReviewIdentity.parse(metadata);
  const measurementId = z.object({ measurementId: digest }).parse(metadata).measurementId;
  if (bytesDigest(JSON.stringify(review)) !== measurementId || review.corpusDigest !== bytesDigest(raw)
    || review.corpusVersion !== corpus.corpusVersion || review.checkVersion !== ENTITY_CHECK_VERSION || review.guideVersion !== ENTITY_GUIDE_VERSION) throw new Error('Frozen review bundle needs its exact measurement/checker/annotation identity.');
  return { cases: corpus.cases.map(sample => Case.parse({ caseId: sample.caseId, split: sample.split, ...entityReviewInput(sample) })), provenance: corpus.provenance, sourceMeasurementId: measurementId };
}
function validateCases(cases: z.infer<typeof Case>[]) {
  if (new Set(cases.map(sample => sample.caseId)).size !== cases.length) throw new Error('Duplicate input case.');
  for (const sample of cases) {
    const refs = sample.excerpts.map(excerpt => excerpt.evidenceRef);
    if (new Set(refs).size !== refs.length || sample.excerpts.some(excerpt => excerpt.evidenceRef !== `${sample.caseId}:${excerpt.recordIndex}`)) throw new Error('Input must preserve stable unique case:record references.');
  }
}
function inputFor(plan: LiveCapturePlan, prompt: string, sample: z.infer<typeof Case>, schema: Record<string, unknown> | null): CaptureInput {
  const config = plan.config;
  return { model: config.model, system: prompt, prompt: JSON.stringify({ excerpts: sample.excerpts, limitations: sample.limitations }),
    timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens,
    outputFormat: config.outputMode === 'json-schema' ? { mode: 'json-schema', name: config.schemaName!, schema: schema! } : { mode: config.outputMode } };
}
export async function prepareLiveCapture(options: { repository: string; output: string; source?: string; reviewBundle?: string; prompt: string; config: string; wireSchema?: string }, environment: NodeJS.ProcessEnv) {
  if (!!options.source === !!options.reviewBundle) throw new Error('Choose exactly one --source or --review-bundle.');
  const config = Config.parse(readJson(options.config)); const runtime = await loadCaptureRuntime(options.repository);
  const sourceKind = options.source ? 'capture-source' : 'review-bundle';
  const sourceBytes = readFileSync(options.source ?? resolve(options.reviewBundle!, 'corpus.json'));
  const manifest = options.reviewBundle ? readFileSync(resolve(options.reviewBundle, 'manifest.json')) : null;
  const source = sourceCases(sourceBytes, sourceKind, manifest ?? undefined); validateCases(source.cases);
  const cases = config.caseIds.map(id => source.cases.find(sample => sample.caseId === id && sample.split === config.split));
  if (cases.some(value => !value) || new Set(config.caseIds).size !== config.caseIds.length) throw new Error('Explicit case/split selection is missing or duplicated.');
  const promptBytes = readFileSync(options.prompt); const prompt = utf8(promptBytes);
  if ((config.promptVariant === 'v14-original') !== (bytesDigest(promptBytes) === ORIGINAL_V14)) throw new Error('Original v14 label must match its exact frozen prompt bytes.');
  const schemaBytes = options.wireSchema ? readFileSync(options.wireSchema) : null;
  if ((config.outputMode === 'json-schema') !== !!schemaBytes || (config.outputMode === 'json-schema') !== !!config.schemaName
    || (schemaBytes && (bytesDigest(schemaBytes) !== runtime.WINDOW_EXTRACTION_WIRE_IDENTITY.wireSchemaDigest || config.promptVariant === 'v14-original'))) throw new Error('Explicit wire schema/identity/mode/prompt variant mismatch.');
  const schema = schemaBytes ? JSON.parse(utf8(schemaBytes)) as Record<string, unknown> : null;
  const base = { planVersion: 'omk-entity-live-plan/v1', createdAt: new Date().toISOString(), host: captureHostIdentity(options.repository, runtime.CAPTURE_VALIDATOR_IDENTITY),
    checkVersion: ENTITY_CHECK_VERSION, guideVersion: ENTITY_GUIDE_VERSION, config,
    source: { sourceKind, digest: bytesDigest(sourceBytes), provenance: source.provenance, sourceMeasurementId: source.sourceMeasurementId,
      reviewManifestDigest: manifest ? bytesDigest(manifest) : null },
    promptDigest: bytesDigest(promptBytes), promptBytes: promptBytes.length, wireSchemaDigest: schemaBytes ? bytesDigest(schemaBytes) : null,
    wireId: schemaBytes ? runtime.WINDOW_EXTRACTION_WIRE_ID : null,
    endpoint: null as string | null, protocol: config.executor === 'openai-api' ? runtime.OPENAI_CHAT_COMPLETIONS_ADAPTER_VERSION : 'codex-exec-jsonl/v1',
    requestBuilderVersion: runtime.OPENAI_CHAT_REQUEST_VERSION, budgetEvidenceDigest: OPENAI_CAPTURE_BUDGET_EVIDENCE_DIGEST,
    configurationPolicy: 'shared-builder-fields-only;provider-defaults-unreported', usageEvidence: 'executor-standardized;provider-bucket-presence-unreported', auditability: 'requested-provider-identity;server-model-and-fingerprint-unreported',
    slots: [] as z.infer<typeof Slot>[], retry: 'one-invocation-per-slot;no-reask;never-retry-reserved', transport: 'single-completion/v1;redirect-error' };
  const requestBodies = new Map<string, string>();
  const planDraft = base as unknown as LiveCapturePlan;
  base.slots = (cases as z.infer<typeof Case>[]).flatMap(sample => Array.from({ length: config.repeats }, (_, index) => {
    const input = inputFor(planDraft, prompt, sample, schema); const request = config.executor === 'openai-api' ? runtime.buildOpenAiChatRequest(input, environment, 'single-completion/v1') : null;
    if (request) base.endpoint = request.endpoint;
    const slot = { slotId: `${sample.caseId}-repeat-${index + 1}`, caseId: sample.caseId, repeat: index + 1,
      inputDigest: bytesDigest(input.prompt), requestDigest: request ? bytesDigest(request.body) : null };
    if (request) requestBodies.set(slot.slotId, request.body); return slot;
  }));
  if (config.maxCalls > base.slots.length) throw new Error('Call budget exceeds the predeclared slot count.');
  const plan = Plan.parse({ ...base, planId: identityDigest(base) });
  const output = reviewOutputRoot(options.repository, options.output); mkdirSync(output, { mode: 0o700 });
  for (const name of ['ledger', 'requests', 'gates']) mkdirSync(resolve(output, name), { mode: 0o700 });
  publishJson(resolve(output, 'plan.json'), plan); publish(resolve(output, 'source.json'), sourceBytes); publish(resolve(output, 'prompt.txt'), promptBytes);
  if (manifest) publish(resolve(output, 'review-manifest.json'), manifest); if (schemaBytes) publish(resolve(output, 'wire-schema.json'), schemaBytes);
  for (const [slot, bytes] of requestBodies) publish(resolve(output, 'requests', `${slot}.json`), bytes);
  publishJson(resolve(output, 'budget-evidence.json'), OPENAI_CAPTURE_BUDGET_EVIDENCE);
  publishJson(resolve(output, 'permission-template.json'), { authorizationVersion: 'omk-entity-live-permission/v1', authorizationStatus: 'pending',
    planId: plan.planId, sourceDigest: plan.source.digest, promptDigest: plan.promptDigest, endpoint: plan.endpoint, executor: config.executor, model: config.model,
    maxCalls: config.maxCalls, maxTokens: config.maxTokens, grantedAt: null, expiresAt: null, authorizedBy: null, action: 'send-frozen-selected-inputs-to-the-declared-model' });
  syncDirectory(dirname(output));
  return plan;
}
export async function openLiveCapture(repository: string, directory: string) {
  privateDirectory(directory); for (const name of ['ledger', 'requests', 'gates']) privateDirectory(resolve(directory, name));
  const plan = Plan.parse(readJson(resolve(directory, 'plan.json'))); const { planId, ...identity } = plan;
  const runtime = await loadCaptureRuntime(repository);
  if (identityDigest(identity) !== planId || !equal(plan.host, captureHostIdentity(repository, runtime.CAPTURE_VALIDATOR_IDENTITY)) || plan.checkVersion !== ENTITY_CHECK_VERSION || plan.guideVersion !== ENTITY_GUIDE_VERSION) throw new Error('Capture plan/host/checker identity mismatch.');
  const sourceBytes = readFileSync(resolve(directory, 'source.json')); const promptBytes = readFileSync(resolve(directory, 'prompt.txt'));
  const manifest = plan.source.reviewManifestDigest ? readFileSync(resolve(directory, 'review-manifest.json')) : null;
  if (bytesDigest(sourceBytes) !== plan.source.digest || bytesDigest(promptBytes) !== plan.promptDigest || promptBytes.length !== plan.promptBytes
    || (manifest && bytesDigest(manifest) !== plan.source.reviewManifestDigest)
    || identityDigest(readJson(resolve(directory, 'budget-evidence.json'))) !== identityDigest(OPENAI_CAPTURE_BUDGET_EVIDENCE)
    || plan.budgetEvidenceDigest !== OPENAI_CAPTURE_BUDGET_EVIDENCE_DIGEST) throw new Error('Frozen capture bytes/evidence changed.');
  const source = sourceCases(sourceBytes, plan.source.sourceKind, manifest ?? undefined); validateCases(source.cases);
  if (source.provenance !== plan.source.provenance || source.sourceMeasurementId !== plan.source.sourceMeasurementId) throw new Error('Source provenance mismatch.');
  const cases = plan.config.caseIds.map(id => source.cases.find(sample => sample.caseId === id && sample.split === plan.config.split));
  if (cases.some(value => !value) || new Set(plan.config.caseIds).size !== cases.length) throw new Error('Invalid fixed cases.');
  const prompt = utf8(promptBytes);
  if ((plan.config.promptVariant === 'v14-original') !== (plan.promptDigest === ORIGINAL_V14)) throw new Error('Prompt variant mismatch.');
  const schemaBytes = plan.wireSchemaDigest ? readFileSync(resolve(directory, 'wire-schema.json')) : null;
  if ((plan.config.outputMode === 'json-schema') !== !!schemaBytes || (schemaBytes && (bytesDigest(schemaBytes) !== plan.wireSchemaDigest
    || plan.wireSchemaDigest !== runtime.WINDOW_EXTRACTION_WIRE_IDENTITY.wireSchemaDigest || plan.wireId !== runtime.WINDOW_EXTRACTION_WIRE_ID
    || plan.config.promptVariant === 'v14-original'))) throw new Error('Wire identity mismatch.');
  const schema = schemaBytes ? JSON.parse(utf8(schemaBytes)) as Record<string, unknown> : null;
  const expected = (cases as z.infer<typeof Case>[]).flatMap(sample => Array.from({ length: plan.config.repeats }, (_, index) => ({
    slotId: `${sample.caseId}-repeat-${index + 1}`, caseId: sample.caseId, repeat: index + 1,
    inputDigest: bytesDigest(JSON.stringify({ excerpts: sample.excerpts, limitations: sample.limitations })) })));
  if (expected.length !== plan.slots.length || expected.some((slot, index) => !equal(slot, { ...plan.slots[index], requestDigest: undefined }))) throw new Error('Slot/input identity mismatch.');
  for (const slot of plan.slots) if (slot.requestDigest && bytesDigest(readFileSync(resolve(directory, 'requests', `${slot.slotId}.json`))) !== slot.requestDigest) throw new Error('Frozen request changed.');
  return { plan, cases: cases as z.infer<typeof Case>[], prompt, schema, runtime };
}
function projection(native: unknown, exception: string | null, inputBound: number, outputBound: number) {
  const parsed = Native.safeParse(native); const result = parsed.success ? parsed.data : null;
  // ExecResult uses absence as reported; the API marks missing/invalid usage explicitly false.
  const reported = !!result && result.tokenUsageReportedByExecutor !== false;
  const usage = { inputTokens: reported ? result.inputTokens : null, outputTokens: reported ? result.outputTokens : null,
    cacheReadTokens: reported ? result.cacheReadTokens : null, cacheCreationTokens: reported ? result.cacheCreationTokens : null };
  let outcome = exception ? 'host_exception' : !result ? 'invalid_native_result' : result.refusal ? 'refusal'
    : result.failure?.failureKind ?? (!result.ok || result.output === null ? 'call_failure' : 'output');
  if (result && ((result.attemptCount ?? 1) !== 1 || result.toolCalls?.length
    || (reported && (result.inputTokens + result.cacheReadTokens + result.cacheCreationTokens > inputBound || result.outputTokens > outputBound)))) outcome = 'policy_violation';
  return { outcome, usage, costUSD: result && result.costReportedByExecutor !== false ? result.costUSD : null,
    blocked: !reported || outcome === 'policy_violation' || !!exception || !result };
}
function ledger(directory: string, plan: LiveCapturePlan, reservationTokens: number, inputBound: number) {
  const allowed = new Set(plan.slots.flatMap(slot => [`${slot.slotId}.reserved.json`, `${slot.slotId}.native.json`, `${slot.slotId}.attempt.json`]));
  if (readdirSync(resolve(directory, 'ledger')).some(name => !allowed.has(name))) throw new Error('Unknown ledger file.');
  const records: { reservation: z.infer<typeof Reservation>; attempt: AttemptRecord | null; native: unknown }[] = [];
  const permissionFile = resolve(directory, 'permission.json');
  const permissionDigest = existsSync(permissionFile) ? bytesDigest(readFileSync(permissionFile)) : null;
  let gap = false; let blocked = false;
  for (const slot of plan.slots) {
    const path = (extension: string) => resolve(directory, 'ledger', `${slot.slotId}.${extension}.json`);
    if (!existsSync(path('reserved'))) { if (existsSync(path('native')) || existsSync(path('attempt'))) throw new Error('Result without reservation.'); gap = true; continue; }
    if (gap || blocked) throw new Error('Out-of-order/after-blocked call.');
    const reservation = Reservation.parse(readJson(path('reserved')));
    if (reservation.planId !== plan.planId || reservation.permissionDigest !== permissionDigest || !equal(reservation.slot, slot) || reservation.tokenReservation !== reservationTokens) throw new Error('Reservation/permission identity mismatch.');
    const nativeBytes = existsSync(path('native')) ? readFileSync(path('native')) : null;
    const native = nativeBytes ? JSON.parse(utf8(nativeBytes)) as unknown : null;
    const attempt = existsSync(path('attempt')) ? Attempt.parse(readJson(path('attempt'))) : null;
    if (attempt && (attempt.reservationDigest !== identityDigest(reservation) || attempt.nativeDigest !== (nativeBytes ? bytesDigest(nativeBytes) : null)
      || Date.parse(attempt.finishedAt) < Date.parse(reservation.reservedAt)
      || !equal(projection(native, attempt.nativeException, inputBound, plan.config.maxOutputTokens), { outcome: attempt.outcome, usage: attempt.usage, costUSD: attempt.costUSD, blocked: attempt.blocked }))) throw new Error('Native/attempt evidence mismatch.');
    blocked = !attempt || attempt.blocked; records.push({ reservation, attempt, native });
  }
  if (records.length > plan.config.maxCalls || records.length * reservationTokens > plan.config.maxTokens) throw new Error('Ledger exceeds frozen budget.');
  return { records, blocked };
}
function profileFor(plan: LiveCapturePlan) {
  if (plan.config.executor !== 'openai-api' || !plan.endpoint) throw new Error('Codex has no enforceable output token cap; no dispatch allowed.');
  const profile = resolveCaptureBudgetProfile(plan.config.profileId, plan.config.model, plan.endpoint);
  if (plan.config.maxOutputTokens > profile.outputUpperBound) throw new Error('Requested output cap exceeds the verified profile.');
  return profile;
}
export async function checkLiveCapture(repository: string, directory: string, env: NodeJS.ProcessEnv) {
  const bundle = await openLiveCapture(repository, directory); const { plan } = bundle;
  try {
    const profile = profileFor(plan);
    if (profile.authority === 'official-contract' && ((env.NODE_OPTIONS ?? '').trim() || process.execArgv.some(arg => /^(--import|--require|--loader|--experimental-loader|-r$)/.test(arg)))) throw new Error('Official profile rejects injected Node loaders.');
    const input = inputFor(plan, bundle.prompt, bundle.cases[0], bundle.schema);
    bundle.runtime.assertExecutorInputCapabilities(plan.config.executor, input);
    const request = bundle.runtime.buildOpenAiChatRequest(input, env, 'single-completion/v1');
    if (request.endpoint !== plan.endpoint || bundle.runtime.OPENAI_CHAT_COMPLETIONS_ADAPTER_VERSION !== plan.protocol
      || bundle.runtime.OPENAI_CHAT_REQUEST_VERSION !== plan.requestBuilderVersion) throw new Error('Actual env/request/protocol differs from plan.');
    for (const slot of plan.slots) {
      const sample = bundle.cases.find(value => value.caseId === slot.caseId)!;
      const actual = bundle.runtime.buildOpenAiChatRequest(inputFor(plan, bundle.prompt, sample, bundle.schema), env, 'single-completion/v1');
      if (actual.endpoint !== plan.endpoint || bytesDigest(actual.body) !== slot.requestDigest) throw new Error('Actual request bytes differ from the frozen plan.');
    }
    const state = ledger(directory, plan, profile.inputUpperBound + plan.config.maxOutputTokens, profile.inputUpperBound);
    const remaining = plan.config.maxTokens - state.records.length * (profile.inputUpperBound + plan.config.maxOutputTokens);
    const executable = !state.blocked && state.records.length < Math.min(plan.config.maxCalls, plan.slots.length)
      && remaining >= profile.inputUpperBound + plan.config.maxOutputTokens;
    return { bundle, profile, state, executable, reasons: executable ? [] : ['Incomplete/unknown reservation or budget exhausted.'] };
  } catch (error) { return { bundle, executable: false, reasons: [String(error)] }; }
}
/** Exactly one production createExecutor invocation, authorized and bounded before dispatch. */
export async function executeLiveCapture(options: { repository: string; directory: string; permission: string; authorizePlan: string; slotId: string; signal?: AbortSignal }, environment: NodeJS.ProcessEnv) {
  reviewOutputRoot(options.repository, options.directory); privateDirectory(options.directory);
  const env = Object.freeze({ ...environment }); const lock = resolve(options.directory, 'active.lock'); const fd = openSync(lock, 'wx', 0o600);
  let dispatchCount = 0;
  try {
    const checked = await checkLiveCapture(options.repository, options.directory, env); const { bundle } = checked; const { plan } = bundle;
    if (!checked.executable || !checked.profile || !checked.state) throw new Error(checked.reasons.join(' '));
    const permissionBytes = readFileSync(options.permission); const permission = Permission.parse(JSON.parse(utf8(permissionBytes)));
    if (options.authorizePlan !== plan.planId || permission.planId !== plan.planId || permission.sourceDigest !== plan.source.digest
      || permission.promptDigest !== plan.promptDigest || permission.endpoint !== plan.endpoint || permission.executor !== plan.config.executor || permission.model !== plan.config.model
      || permission.maxCalls !== plan.config.maxCalls || permission.maxTokens !== plan.config.maxTokens
      || Date.parse(permission.grantedAt) > Date.now() || Date.parse(permission.expiresAt) <= Date.now()) throw new Error('Explicit permission does not authorize this exact plan/data/model/budget.');
    if (!env.OPENAI_API_KEY?.trim()) throw new Error('OPENAI_API_KEY missing; no dispatch allowed.');
    const permissionFile = resolve(options.directory, 'permission.json');
    if (existsSync(permissionFile)) { if (bytesDigest(readFileSync(permissionFile)) !== bytesDigest(permissionBytes)) throw new Error('Permission bytes changed after first invocation.'); }
    else publish(permissionFile, permissionBytes);
    const slot = plan.slots[checked.state.records.length]; if (!slot || slot.slotId !== options.slotId) throw new Error('Slot was reserved/already completed/out of order; never retry implicitly.');
    const tokenReservation = checked.profile.inputUpperBound + plan.config.maxOutputTokens;
    const reservation = Reservation.parse({ ledgerVersion: 'omk-entity-live-ledger/v1', planId: plan.planId, permissionDigest: bytesDigest(permissionBytes), slot,
      reservedAt: new Date().toISOString(), tokenReservation });
    const path = (extension: string) => resolve(options.directory, 'ledger', `${slot.slotId}.${extension}.json`);
    publishJson(path('reserved'), reservation);
    const sample = bundle.cases.find(value => value.caseId === slot.caseId)!; const input = inputFor(plan, bundle.prompt, sample, bundle.schema);
    input.abortSignal = options.signal;
    let native: NativeResult | null = null; let nativeException: string | null = null; let nativeDigest: string | null = null;
    try {
      const execute = bundle.runtime.createExecutor(plan.config.executor, { env, apiDispatchPolicy: { requestConstraints: 'single-completion/v1', redirect: 'error',
        beforeDispatch(request) {
          if (dispatchCount || request.endpoint !== plan.endpoint || bytesDigest(request.body) !== slot.requestDigest
            || bytesDigest(readFileSync(resolve(options.directory, 'source.json'))) !== plan.source.digest
            || bytesDigest(readFileSync(resolve(options.directory, 'prompt.txt'))) !== plan.promptDigest
            || bytesDigest(readFileSync(resolve(options.directory, 'requests', `${slot.slotId}.json`))) !== slot.requestDigest
            || (plan.wireSchemaDigest && bytesDigest(readFileSync(resolve(options.directory, 'wire-schema.json'))) !== plan.wireSchemaDigest)
            || !equal(plan.host, captureHostIdentity(options.repository, bundle.runtime.CAPTURE_VALIDATOR_IDENTITY)) || bytesDigest(readFileSync(resolve(options.directory, 'plan.json'))) !== bytesDigest(JSON.stringify(plan, null, 2) + '\n')
            || bytesDigest(readFileSync(resolve(options.directory, 'permission.json'))) !== reservation.permissionDigest
            || Date.parse(permission.expiresAt) <= Date.now()) throw new Error('Dispatch identity/permission changed; request refused.');
          dispatchCount++; // The one actual production fetch follows this synchronous gate.
        } } });
      native = await execute(input);
      const bytes = JSON.stringify(native); publish(path('native'), bytes); nativeDigest = bytesDigest(bytes); // Archive before any normalization/admission.
    } catch (error) { nativeException = String(error); }
    const attempt = Attempt.parse({ attemptVersion: 'omk-entity-live-attempt/v1', reservationDigest: identityDigest(reservation), finishedAt: new Date().toISOString(),
      nativeDigest, nativeException, dispatchCount, cancelled: options.signal?.aborted ?? false,
      ...projection(native, nativeException, checked.profile.inputUpperBound, plan.config.maxOutputTokens) });
    publishJson(path('attempt'), attempt);
    return { planId: plan.planId, slotId: slot.slotId, outcome: attempt.outcome, blocked: attempt.blocked, dispatchCount,
      authority: checked.profile.authority, tokenReservation, modelCalls: dispatchCount ? 'not_attested' : 0 };
  } catch (error) {
    publishJson(resolve(options.directory, 'gates', `${Date.now()}-${randomUUID()}.json`), { eventKind: 'capture-gate-rejection', at: new Date().toISOString(), error: String(error), dispatchCount });
    throw error;
  } finally { closeSync(fd); unlinkSync(lock); }
}
export async function replayLiveCapture(repository: string, directory: string) {
  const bundle = await openLiveCapture(repository, directory); const { plan } = bundle; const profile = profileFor(plan);
  const state = ledger(directory, plan, profile.inputUpperBound + plan.config.maxOutputTokens, profile.inputUpperBound);
  const records = state.records.map(({ reservation, attempt, native }) => {
    const result = Native.safeParse(native); let admission: unknown = null; let parseFailure: string | null = null; let wire: unknown = null;
    if (attempt?.outcome === 'output' && result.success && result.data.output !== null) {
      let response: unknown;
      if (Buffer.from(result.data.output).toString('utf8') !== result.data.output) parseFailure = 'Native text is not round-trip UTF-8; original native JSON retained.';
      else try { response = JSON.parse(result.data.output); } catch (error) { parseFailure = String(error); }
      if (!parseFailure && plan.config.outputMode === 'json-schema') {
        const decoded = bundle.runtime.decodeWindowExtractionWire(Buffer.from(result.data.output)); wire = decoded;
        if (decoded.decodeStatus === 'decoded') response = decoded.domainInput; else parseFailure = 'Wire envelope rejected; original evidence retained.';
      }
      if (!parseFailure) {
        const sample = bundle.cases.find(value => value.caseId === reservation.slot.caseId)!;
        try { admission = bundle.runtime.checkWindowExtractionResponse(response, sample.excerpts); }
        catch (error) { if (!(error instanceof z.ZodError)) throw error; parseFailure = 'Domain envelope rejected.'; }
      }
    }
    return { slot: reservation.slot, attempt, native, parseFailure, wire, admission };
  });
  return { planId: plan.planId, sourceMeasurementId: plan.source.sourceMeasurementId, provenance: plan.source.provenance, authority: profile.authority,
    usageEvidence: plan.usageEvidence, records, unattempted: plan.slots.slice(records.length), blocked: state.blocked, requestsByThisCommand: 0,
    semanticReview: 'pending', independentHumanReview: 'pending', qualityConclusion: 'not_evaluated' };
}
export async function compareLiveCaptures(repository: string, left: string, right: string) {
  const a = (await openLiveCapture(repository, left)).plan; const b = (await openLiveCapture(repository, right)).plan;
  const conditions = (plan: LiveCapturePlan) => ({ host: plan.host, source: plan.source, checkVersion: plan.checkVersion, guideVersion: plan.guideVersion,
    config: { ...plan.config, promptVariant: undefined }, wireSchemaDigest: plan.wireSchemaDigest, wireId: plan.wireId, endpoint: plan.endpoint,
    protocol: plan.protocol, requestBuilderVersion: plan.requestBuilderVersion, budgetEvidenceDigest: plan.budgetEvidenceDigest, retry: plan.retry, transport: plan.transport,
    configurationPolicy: plan.configurationPolicy, usageEvidence: plan.usageEvidence, auditability: plan.auditability,
    slots: plan.slots.map(slot => ({ ...slot, requestDigest: undefined })) });
  if (!equal(conditions(a), conditions(b))) throw new Error('Input/host/checker/provider/schema/retry/budget conditions differ; prompt-only comparison refused.');
  if (a.promptDigest === b.promptDigest) throw new Error('No prompt-byte contrast.');
  const leftReplay = await replayLiveCapture(repository, left); const rightReplay = await replayLiveCapture(repository, right);
  const summarize = (report: typeof leftReplay) => report.records.map(record => ({ slotId: record.slot.slotId,
    outcome: record.attempt?.outcome ?? 'incomplete', nativeDigest: record.attempt?.nativeDigest ?? null,
    hostAcceptedProposals: record.admission ? (record.admission as { accepted: unknown[] }).accepted.length : null }));
  return { comparisonVersion: 'omk-entity-live-comparison/v1', leftPlanId: a.planId, rightPlanId: b.planId, matchingConditions: true,
    promptDigests: [a.promptDigest, b.promptDigest], sourceMeasurementIds: [a.source.sourceMeasurementId, b.source.sourceMeasurementId],
    recordSummaries: { left: summarize(leftReplay), right: summarize(rightReplay) },
    pairingOrder: 'not_attested', controlledExecutionClaim: false, requestsByThisCommand: 0, semanticReview: 'pending', independentHumanReview: 'pending', qualityConclusion: 'not_evaluated' };
}
