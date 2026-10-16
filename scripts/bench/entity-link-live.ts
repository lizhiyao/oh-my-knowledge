import { accessSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { authorReviewStatus, reviewDigest, reviewOutputRoot } from './entity-extraction-review.js';
import { entityLinkReviewInput, parseEntityLinkReviewCorpus, type EntityLinkReviewInput } from './entity-link-review-corpus.js';
import { bytesDigest } from './entity-capture-provider.js';
import { canonicalLinkReview, EntityLinkMeasurementIdentitySchema } from './entity-link-review.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), key = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const time = z.iso.datetime({ offset: true }), split = z.enum(['development', 'validation']);
const Host = z.strictObject({ runtimeDigest: digest, checkerDigest: digest, dependencyDigest: digest, nodeVersion: z.string().min(1),
  validatorVersion: z.string().min(1), validatorDigest: digest,
  nodeBinaryDigest: digest, codexBinaryDigest: digest, codexBinaryPath: z.string().min(1), runnerDigest: digest });
const Manifest = z.object({ ...EntityLinkMeasurementIdentitySchema.shape, measurementId: digest, exploratoryReady: z.literal(true) });
const Slot = z.strictObject({ caseId: key, repeat: z.literal(1), inputDigest: digest, requestDigest: digest });
const Plan = z.strictObject({ planVersion: z.literal('omk-entity-link-live-plan/v1'), planId: digest, createdAt: time,
  repository: z.string().min(1), host: Host, measurementId: digest, manifestDigest: digest, corpusDigest: digest,
  selfReviewDigest: digest, promptHash: digest, promptVersion: z.string().min(1), responseSchemaHash: digest, schemaFileDigest: digest,
  executor: z.literal('codex'), model: z.string().trim().min(1), split, maxCalls: z.number().int().positive().max(64), slots: z.array(Slot).min(1).max(64),
  protocol: z.literal('production-entity-link-request-adapter-codex/v1'),
  scope: z.literal('request-adapter-executor;not-durable-entity-link-codex-host'),
  limits: z.literal('OMK-invocations-only;no-provider-request-token-or-USD-cap'),
  context: z.literal('private-cwd;runtime-default-global-skills-and-effort;system-prepended'),
  retry: z.literal('one-slot-per-case;never-retry-reserved;stop-on-failure'),
});
export type EntityLinkLivePlan = z.infer<typeof Plan>;
export interface EntityLinkLiveRequest extends Record<string, unknown> { requestDigest: string; system: string; prompt: string;
  promptHash: string; promptVersion: string; responseSchemaHash: string; outputFormat: { schema: unknown } }
export interface EntityLinkLiveRuntime {
  host(repository: string, environment: NodeJS.ProcessEnv): Promise<z.infer<typeof Host>>;
  parseInput(input: unknown): EntityLinkReviewInput;
  createRequest(selection: { executor: 'codex'; model: string }, input: unknown): EntityLinkLiveRequest;
  configure(request: EntityLinkLiveRequest, environment: NodeJS.ProcessEnv): { execute(signal?: AbortSignal): Promise<unknown> };
  parseOutcome(outcome: unknown): { outcomeKind: 'exception'; error: unknown } | { outcomeKind: 'result'; result: Record<string, unknown> };
  parseSuggestion(output: unknown, input: EntityLinkReviewInput): { leftEntityId: string; rightEntityId: string; leftMentionIds: string[]; rightMentionIds: string[] };
  observeException(error: unknown): unknown;
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${canonical((value as Record<string, unknown>)[name])}`).join(',')}}`;
  return JSON.stringify(value);
};
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function raw(path: string, maxBytes = 8 * 1024 * 1024): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Expected a bounded regular evidence file.');
  return readFileSync(path);
}
function text(bytes: Buffer): string {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value).equals(bytes)) throw new Error('Evidence must be valid UTF-8.');
  return value;
}
const json = (path: string): unknown => JSON.parse(text(raw(path)));
function directory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected a regular evidence directory.');
}
function syncDirectory(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function publish(path: string, value: string | Uint8Array) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
const publishJson = (path: string, value: unknown) => publish(path, JSON.stringify(value, null, 2) + '\n');
/** Native trace nesting cannot depend on JSON.stringify's recursive depth limit. */
function publishNative(path: string, value: unknown) {
  const fd = openSync(path, 'wx', 0o600), active = new Set<object>();
  const frames: { value: unknown; keys?: string[]; index: number }[] = [{ value, index: 0 }];
  try {
    while (frames.length) {
      const frame = frames[frames.length - 1], current = frame.value;
      if (current === null || ['string', 'boolean', 'number'].includes(typeof current)) {
        writeFileSync(fd, JSON.stringify(current)); frames.pop(); continue;
      }
      if (!current || typeof current !== 'object') throw new Error('Native return is not JSON data; reserved invocation will not be retried.');
      const array = Array.isArray(current), object = current as Record<string, unknown>;
      if (!frame.keys) {
        if (active.has(current) || Object.hasOwn(object, 'toJSON')) throw new Error('Native return is not acyclic JSON data.');
        active.add(current);
        frame.keys = array ? Array.from({ length: current.length }, (_, index) => String(index))
          : Object.keys(object).filter(name => {
            const descriptor = Object.getOwnPropertyDescriptor(object, name);
            if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Native return contains an accessor.');
            return descriptor.value !== undefined;
          });
        writeFileSync(fd, array ? '[' : '{');
      }
      if (frame.index >= frame.keys.length) { writeFileSync(fd, array ? ']' : '}'); active.delete(current); frames.pop(); continue; }
      const name = frame.keys[frame.index]; if (frame.index++) writeFileSync(fd, ',');
      if (!array) writeFileSync(fd, JSON.stringify(name) + ':');
      const property = Object.getOwnPropertyDescriptor(object, name);
      if (property && !Object.hasOwn(property, 'value')) throw new Error('Native return contains an accessor.');
      frames.push({ value: property?.value === undefined ? null : property.value, index: 0 });
    }
    writeFileSync(fd, '\n'); fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
function codexBinary(environment: NodeJS.ProcessEnv): string {
  // Only PATH is inspected. Authentication and credential access belong to the native CLI.
  for (const entry of (environment.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = resolve(entry, 'codex');
    try { accessSync(candidate, constants.X_OK); const target = realpathSync(candidate); if (lstatSync(target).isFile()) return target; } catch { /* next PATH entry */ }
  }
  throw new Error('Codex binary is absent from PATH.');
}
async function loadRuntime(): Promise<EntityLinkLiveRuntime> {
  // The repository path supplies the installed build, never an input-selected module.
  const importBuilt = async (repository: string, path: string) => import(pathToFileURL(resolve(repository, 'dist', path)).href);
  type Execute = (input: Record<string, unknown>) => Promise<unknown>;
  interface Modules {
    adapter: { createEntityLinkExecutionRequest: EntityLinkLiveRuntime['createRequest'];
      configuredEntityLinkExecutor(request: EntityLinkLiveRequest, host: { assertCapabilities(executor: string, input: unknown): void; create(name: string): Execute }): ReturnType<EntityLinkLiveRuntime['configure']> };
    invocation: { EntityLinkModelInputSchema: { parse: EntityLinkLiveRuntime['parseInput'] }; EntityLinkExecutionOutcomeSchema: { parse: EntityLinkLiveRuntime['parseOutcome'] } };
    executors: { assertExecutorInputCapabilities(executor: string, input: unknown): void; createExecutor(name: string, options: { env: NodeJS.ProcessEnv }): Execute };
    links: { checkEntityLinkSuggestion(output: unknown, binding: { left: EntityLinkReviewInput['left']['binding']; right: EntityLinkReviewInput['right']['binding'] }): ReturnType<EntityLinkLiveRuntime['parseSuggestion']> };
    generation: { observeExtractionException: EntityLinkLiveRuntime['observeException'] };
  }
  let loaded: Modules;
  return {
    async host(repository, environment) {
      const review = await import('./entity-link-review.js');
      const identity = review.entityLinkReviewHostIdentity(repository);
      const binary = codexBinary(environment);
      loaded = {
        adapter: await importBuilt(repository, 'observability/knowledge-extraction/adapters/entity-link-executor.js'),
        invocation: await importBuilt(repository, 'knowledge/entities/link-invocation.js'),
        executors: await importBuilt(repository, 'executors/index.js'), links: await importBuilt(repository, 'knowledge/entities/links.js'),
        generation: await importBuilt(repository, 'observability/knowledge-extraction/generation.js') };
      return Host.parse({ ...identity, nodeBinaryDigest: bytesDigest(readFileSync(process.execPath)),
        codexBinaryPath: binary, codexBinaryDigest: bytesDigest(readFileSync(binary)),
        runnerDigest: reviewDigest(readFileSync(fileURLToPath(import.meta.url), 'utf8')) });
    },
    parseInput: input => loaded.invocation.EntityLinkModelInputSchema.parse(input),
    createRequest: (selection, input) => loaded.adapter.createEntityLinkExecutionRequest(selection, input),
    configure: (request, environment) => loaded.adapter.configuredEntityLinkExecutor(request, {
      assertCapabilities: loaded.executors.assertExecutorInputCapabilities,
      create: (name: string) => loaded.executors.createExecutor(name, { env: environment }),
    }),
    parseOutcome: outcome => loaded.invocation.EntityLinkExecutionOutcomeSchema.parse(outcome),
    parseSuggestion: (output, input) => loaded.links.checkEntityLinkSuggestion(output, { left: input.left.binding, right: input.right.binding }),
    observeException: error => loaded.generation.observeExtractionException(error),
  };
}
interface PrepareOptions { repository: string; bundle: string; output: string; executor: 'codex'; model: string; maxCalls: number;
  caseIds: string[]; split: z.infer<typeof split> }
function bundleFiles(root: string, runtime: EntityLinkLiveRuntime) {
  directory(root); directory(resolve(root, 'inputs'));
  const manifestBytes = raw(resolve(root, 'manifest.json')), corpusBytes = raw(resolve(root, 'corpus.json'));
  const promptBytes = raw(resolve(root, 'system.prompt.txt')), schemaBytes = raw(resolve(root, 'response-schema.json'));
  const selfReviewBytes = raw(resolve(root, 'self-review.json'));
  const guideEn = raw(resolve(root, 'annotation-guide.en.md')), guideZh = raw(resolve(root, 'annotation-guide.zh.md'));
  const manifest = Manifest.parse(JSON.parse(text(manifestBytes)));
  const corpus = parseEntityLinkReviewCorpus(text(corpusBytes), input => runtime.parseInput(input));
  const identity = EntityLinkMeasurementIdentitySchema.parse(Object.fromEntries(Object.keys(EntityLinkMeasurementIdentitySchema.shape)
    .map(field => [field, manifest[field as keyof typeof manifest]])));
  if (reviewDigest(canonicalLinkReview(identity)) !== manifest.measurementId
    || reviewDigest(text(corpusBytes)) !== manifest.corpusDigest
    || reviewDigest(text(guideEn) + '\0' + text(guideZh)) !== manifest.guideDigest) throw new Error('Bundle measurement/corpus/annotation guide identity conflict.');
  if (reviewDigest(text(promptBytes)) !== manifest.promptHash
    || reviewDigest(canonical(JSON.parse(text(schemaBytes)))) !== manifest.responseSchemaHash) throw new Error('Bundle prompt/Schema identity conflict.');
  if (authorReviewStatus(text(selfReviewBytes), corpus, manifest.measurementId).status !== 'completed') throw new Error('An approved author review is required before capture.');
  return { manifestBytes, corpusBytes, promptBytes, schemaBytes, selfReviewBytes, guideEn, guideZh, manifest, corpus };
}
function assertHost(manifest: z.infer<typeof Manifest>, host: z.infer<typeof Host>) {
  for (const field of ['runtimeDigest', 'checkerDigest', 'dependencyDigest', 'nodeVersion', 'validatorVersion', 'validatorDigest', 'nodeBinaryDigest'] as const) {
    if (manifest[field] !== host[field]) throw new Error(`Review bundle ${field} differs from the actual host.`);
  }
}
function assertRequest(request: EntityLinkLiveRequest, input: string, prompt: string, schema: unknown, manifest: z.infer<typeof Manifest>) {
  if (request.prompt !== input || request.system !== prompt || !same(request.outputFormat.schema, schema)
    || request.promptHash !== manifest.promptHash || request.promptVersion !== manifest.promptVersion
    || request.responseSchemaHash !== manifest.responseSchemaHash) throw new Error('Production request differs from frozen review input/prompt/Schema.');
}
/** Pure local preparation. No executor is constructed and no model call is authorized implicitly. */
export async function prepareEntityLinkLive(options: PrepareOptions, runtimeOverride?: EntityLinkLiveRuntime) {
  const runtime = runtimeOverride ?? await loadRuntime(), repository = realpathSync(options.repository);
  if (options.executor !== 'codex' || !options.model.trim() || !Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1
    || options.maxCalls !== options.caseIds.length || new Set(options.caseIds).size !== options.caseIds.length) throw new Error('Declare one unique case per explicit Codex invocation slot.');
  split.parse(options.split); options.caseIds.forEach(id => key.parse(id));
  const bundle = reviewOutputRoot(repository, options.bundle), output = reviewOutputRoot(repository, options.output);
  const host = await runtime.host(repository, process.env), files = bundleFiles(bundle, runtime); assertHost(files.manifest, host);
  const inputs = new Map<string, Buffer>(), requests = new Map<string, EntityLinkLiveRequest>();
  const slots = options.caseIds.map(caseId => {
    const sample = files.corpus.cases.find(item => item.caseId === caseId && item.split === options.split);
    if (!sample) throw new Error('Selected case/split is absent from the frozen corpus.');
    const inputBytes = raw(resolve(bundle, 'inputs', `${caseId}.json`)), input = text(inputBytes);
    if (input !== canonical(entityLinkReviewInput(sample))) throw new Error('Frozen case input is not the canonical corpus input.');
    const request = runtime.createRequest({ executor: 'codex', model: options.model }, runtime.parseInput(JSON.parse(input)));
    assertRequest(request, input, text(files.promptBytes), JSON.parse(text(files.schemaBytes)), files.manifest);
    inputs.set(caseId, inputBytes); requests.set(caseId, request);
    return { caseId, repeat: 1 as const, inputDigest: reviewDigest(input), requestDigest: request.requestDigest };
  });
  const identity = { planVersion: 'omk-entity-link-live-plan/v1' as const, createdAt: new Date().toISOString(), repository, host,
    measurementId: files.manifest.measurementId, manifestDigest: reviewDigest(text(files.manifestBytes)), corpusDigest: reviewDigest(text(files.corpusBytes)),
    selfReviewDigest: reviewDigest(text(files.selfReviewBytes)), promptHash: files.manifest.promptHash, promptVersion: files.manifest.promptVersion,
    responseSchemaHash: files.manifest.responseSchemaHash, schemaFileDigest: reviewDigest(text(files.schemaBytes)),
    executor: 'codex' as const, model: options.model, split: options.split, maxCalls: options.maxCalls, slots,
    protocol: 'production-entity-link-request-adapter-codex/v1' as const, scope: 'request-adapter-executor;not-durable-entity-link-codex-host' as const,
    limits: 'OMK-invocations-only;no-provider-request-token-or-USD-cap' as const,
    context: 'private-cwd;runtime-default-global-skills-and-effort;system-prepended' as const,
    retry: 'one-slot-per-case;never-retry-reserved;stop-on-failure' as const };
  const plan = Plan.parse({ ...identity, planId: reviewDigest(canonical(identity)) });
  mkdirSync(output, { mode: 0o700 });
  for (const name of ['inputs', 'requests', 'reserved', 'native', 'records']) mkdirSync(resolve(output, name), { mode: 0o700 });
  for (const [name, bytes] of [['manifest.json', files.manifestBytes], ['corpus.json', files.corpusBytes], ['self-review.json', files.selfReviewBytes],
    ['system.prompt.txt', files.promptBytes], ['response-schema.json', files.schemaBytes],
    ['annotation-guide.en.md', files.guideEn], ['annotation-guide.zh.md', files.guideZh]] as const) publish(resolve(output, name), bytes);
  for (const [caseId, input] of inputs) { publish(resolve(output, 'inputs', `${caseId}.json`), input); publishJson(resolve(output, 'requests', `${caseId}.json`), requests.get(caseId)); }
  publishJson(resolve(output, 'plan.json'), plan); syncDirectory(dirname(output)); return plan;
}
async function openPlan(repositoryInput: string, directoryInput: string, environment: NodeJS.ProcessEnv, runtime: EntityLinkLiveRuntime) {
  const repository = realpathSync(repositoryInput), root = reviewOutputRoot(repository, directoryInput);
  directory(root); for (const name of ['inputs', 'requests', 'reserved', 'native', 'records']) directory(resolve(root, name));
  const plan = Plan.parse(json(resolve(root, 'plan.json'))), { planId, ...identity } = plan;
  if (plan.repository !== repository || reviewDigest(canonical(identity)) !== planId || plan.maxCalls !== plan.slots.length
    || new Set(plan.slots.map(slot => slot.caseId)).size !== plan.slots.length) throw new Error('Capture plan integrity conflict.');
  const host = await runtime.host(repository, environment), files = bundleFiles(root, runtime); assertHost(files.manifest, host);
  if (!same(host, plan.host) || files.manifest.measurementId !== plan.measurementId
    || reviewDigest(text(files.manifestBytes)) !== plan.manifestDigest || reviewDigest(text(files.corpusBytes)) !== plan.corpusDigest
    || reviewDigest(text(files.selfReviewBytes)) !== plan.selfReviewDigest || reviewDigest(text(files.promptBytes)) !== plan.promptHash
    || reviewDigest(text(files.schemaBytes)) !== plan.schemaFileDigest) throw new Error('Capture host or frozen bundle changed.');
  authorReviewStatus(text(files.selfReviewBytes), files.corpus, plan.measurementId, plan.createdAt);
  const requests = new Map<string, EntityLinkLiveRequest>();
  for (const slot of plan.slots) {
    const sample = files.corpus.cases.find(item => item.caseId === slot.caseId && item.split === plan.split);
    const input = text(raw(resolve(root, 'inputs', `${slot.caseId}.json`)));
    if (!sample || input !== canonical(entityLinkReviewInput(sample)) || reviewDigest(input) !== slot.inputDigest) throw new Error('Frozen selected input changed.');
    const request = runtime.createRequest({ executor: 'codex', model: plan.model }, runtime.parseInput(JSON.parse(input)));
    assertRequest(request, input, text(files.promptBytes), JSON.parse(text(files.schemaBytes)), files.manifest);
    if (request.requestDigest !== slot.requestDigest || !same(json(resolve(root, 'requests', `${slot.caseId}.json`)), request)) throw new Error('Frozen request changed.');
    requests.set(slot.caseId, request);
  }
  return { root, plan, requests };
}
const Reservation = z.strictObject({ reservationVersion: z.literal('omk-entity-link-live-reservation/v1'), planId: digest, slot: Slot, reservedAt: time });
function deriveRecord(plan: EntityLinkLivePlan, slot: z.infer<typeof Slot>, request: EntityLinkLiveRequest,
  reservation: z.infer<typeof Reservation>, nativeBytes: Buffer, runtime: EntityLinkLiveRuntime) {
  const native = JSON.parse(text(nativeBytes));
  let admission = 'invalid_native', result: Record<string, unknown> | undefined;
  try {
    const outcome = runtime.parseOutcome(native);
    if (outcome.outcomeKind === 'exception') admission = 'exception';
    else {
      result = outcome.result;
      const tools = result.toolCalls as unknown[] | undefined, turns = result.turns as { toolCalls?: unknown[] }[] | undefined;
      admission = !result.ok ? 'failed_execution' : result.refusal !== undefined || result.failure !== undefined ? 'failed_execution'
        : tools?.length || turns?.some(turn => turn?.toolCalls?.length) ? 'observed_tools'
        : result.tokenUsageReportedByExecutor === false ? 'usage_unreported' : 'invalid_response';
      if (admission === 'invalid_response' && typeof result.output === 'string') {
        try {
          const input = runtime.parseInput(JSON.parse(request.prompt));
          runtime.parseSuggestion(JSON.parse(result.output), input);
          admission = 'admitted';
        } catch { /* Original output is retained for the offline checker. */ }
      }
    }
  } catch { /* The complete original returned JSON remains in native. */ }
  const usageReported = result && result.tokenUsageReportedByExecutor !== false;
  const usage = { reportedByExecutor: result?.tokenUsageReportedByExecutor === true,
    reportingUnspecified: result !== undefined && result.tokenUsageReportedByExecutor === undefined,
    inputTokens: usageReported && result ? result.inputTokens : null, outputTokens: usageReported && result ? result.outputTokens : null,
    cacheReadTokens: usageReported && result ? result.cacheReadTokens : null, cacheCreationTokens: usageReported && result ? result.cacheCreationTokens : null,
    costReportedByExecutor: result?.costReportedByExecutor === true,
    costReportingUnspecified: result !== undefined && result.costReportedByExecutor === undefined,
    costUSD: result?.costReportedByExecutor === true ? result.costUSD : null };
  const duration = typeof result?.durationMs === 'number' && Number.isFinite(result.durationMs) && result.durationMs >= 0 ? result.durationMs : undefined;
  const metadata = { ...(duration === undefined ? {} : { durationMs: duration }), ...(usage.costUSD === null ? {} : { costUSD: usage.costUSD }) };
  const captureResult = result?.ok && typeof result.output === 'string' && ['admitted', 'invalid_response'].includes(admission)
    ? { captureStatus: 'output' as const, output: result.output, usage, ...metadata }
    : { captureStatus: result?.failure && (result.failure as { failureKind?: string }).failureKind === 'cancelled' ? 'cancelled' as const : 'call_failure' as const, failure: admission, ...metadata };
  return { recordVersion: 'omk-entity-link-live-record/v1', planId: plan.planId, reservationDigest: reviewDigest(canonical(reservation)),
    nativeDigest: reviewDigest(text(nativeBytes)), admission, usage,
    captureRecord: { caseId: slot.caseId, repeat: 1, inputDigest: slot.inputDigest, result: captureResult } };
}
function inspectRecords(root: string, plan: EntityLinkLivePlan, requests: Map<string, EntityLinkLiveRequest>, runtime: EntityLinkLiveRuntime) {
  const records: ReturnType<typeof deriveRecord>[] = [], unknown: string[] = [], pendingRecords: { caseId: string; record: ReturnType<typeof deriveRecord> }[] = [];
  let startedAt: string | undefined;
  for (const slot of plan.slots) {
    const reserved = resolve(root, 'reserved', `${slot.caseId}.json`), native = resolve(root, 'native', `${slot.caseId}.json`), recordPath = resolve(root, 'records', `${slot.caseId}.json`);
    if (!existsSync(reserved)) { if (existsSync(native) || existsSync(recordPath)) throw new Error('Capture evidence has no reservation.'); continue; }
    const reservation = Reservation.parse(json(reserved));
    if (reservation.planId !== plan.planId || !same(reservation.slot, slot)) throw new Error('Reservation identity conflict.');
    if (startedAt === undefined || reservation.reservedAt < startedAt) startedAt = reservation.reservedAt;
    if (!existsSync(native)) { if (existsSync(recordPath)) throw new Error('Derived record has no native archive.'); unknown.push(slot.caseId); continue; }
    const record = deriveRecord(plan, slot, requests.get(slot.caseId)!, reservation, raw(native, 512 * 1024 * 1024), runtime);
    if (existsSync(recordPath)) { if (!same(json(recordPath), record)) throw new Error('Derived record differs from the complete native archive.'); }
    else pendingRecords.push({ caseId: slot.caseId, record });
    records.push(record);
  }
  return { records, unknown, pendingRecords, capture: { captureVersion: 'omk-entity-link-captures/v1', measurementId: plan.measurementId,
    split: plan.split, repeats: 1, startedAt: startedAt ?? plan.createdAt, executor: plan.executor, model: plan.model, records: records.map(record => record.captureRecord) } };
}
/** Read-only replay. Reserved slots without native evidence are unknown and can never be re-dispatched. */
export async function checkEntityLinkLive(options: { repository: string; directory: string }, runtimeOverride?: EntityLinkLiveRuntime) {
  const runtime = runtimeOverride ?? await loadRuntime(), opened = await openPlan(options.repository, options.directory, process.env, runtime);
  const state = inspectRecords(opened.root, opened.plan, opened.requests, runtime);
  return { plan: opened.plan, ...state, complete: state.records.length === opened.plan.slots.length && !state.unknown.length,
    stopped: state.unknown.length > 0 || state.records.some(record => record.admission !== 'admitted') };
}
/** Explicit invocation; the plan digest acknowledges the exact model, selected inputs and known limits. */
export async function executeEntityLinkLive(options: { repository: string; directory: string; confirmPlanId: string }, environment: NodeJS.ProcessEnv,
  runtimeOverride?: EntityLinkLiveRuntime, signal?: AbortSignal) {
  const runtime = runtimeOverride ?? await loadRuntime();
  let opened = await openPlan(options.repository, options.directory, environment, runtime);
  if (options.confirmPlanId !== opened.plan.planId) throw new Error('Explicit confirmation of this exact capture plan is required.');
  for (const slot of opened.plan.slots) {
    signal?.throwIfAborted();
    opened = await openPlan(options.repository, options.directory, environment, runtime);
    const state = inspectRecords(opened.root, opened.plan, opened.requests, runtime);
    for (const pending of state.pendingRecords) publishJson(resolve(opened.root, 'records', `${pending.caseId}.json`), pending.record);
    if (state.unknown.length || state.records.some(record => record.admission !== 'admitted')) break;
    if (state.records.some(record => record.captureRecord.caseId === slot.caseId)) continue;
    const request = opened.requests.get(slot.caseId)!;
    const configured = runtime.configure(request, environment); // Construction/preflight cannot consume a slot.
    const reservation = Reservation.parse({ reservationVersion: 'omk-entity-link-live-reservation/v1', planId: opened.plan.planId, slot, reservedAt: new Date().toISOString() });
    try { publishJson(resolve(opened.root, 'reserved', `${slot.caseId}.json`), reservation); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') break; throw error; }
    let outcome: unknown;
    try {
      outcome = await configured.execute(signal);
      if (outcome && typeof outcome === 'object' && (outcome as { outcomeKind?: string }).outcomeKind === 'exception') {
        outcome = { ...outcome, error: runtime.observeException((outcome as { error: unknown }).error) };
      }
    } catch (error) { outcome = { outcomeKind: 'exception', error: runtime.observeException(error) }; }
    // Complete returned JSON is persisted before parsing, admission, usage projection or stopping.
    const nativePath = resolve(opened.root, 'native', `${slot.caseId}.json`); publishNative(nativePath, outcome);
    const record = deriveRecord(opened.plan, slot, request, reservation, raw(nativePath, 512 * 1024 * 1024), runtime);
    publishJson(resolve(opened.root, 'records', `${slot.caseId}.json`), record);
    if (record.admission !== 'admitted') break;
  }
  const state = inspectRecords(opened.root, opened.plan, opened.requests, runtime);
  const temporary = resolve(opened.root, `captures-${process.pid}.tmp`);
  publishJson(temporary, state.capture); renameSync(temporary, resolve(opened.root, 'captures.json')); syncDirectory(opened.root);
  return { plan: opened.plan, ...state, complete: state.records.length === opened.plan.slots.length && !state.unknown.length,
    stopped: state.unknown.length > 0 || state.records.some(record => record.admission !== 'admitted') };
}
export function parseEntityLinkLiveArguments(args: string[]) {
  const command = args[0]; if (!['prepare', 'execute', 'check'].includes(command)) throw new Error('Choose prepare, execute or check explicitly.');
  const allowed = command === 'prepare' ? ['--repository', '--bundle', '--out', '--executor', '--model', '--max-calls', '--split', '--cases']
    : command === 'execute' ? ['--repository', '--out', '--confirm-plan'] : ['--repository', '--out'];
  const values: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!allowed.includes(name) || values[name] !== undefined || !value?.trim() || value.startsWith('--')) throw new Error('Unknown, missing or duplicate flag.'); values[name] = value;
  }
  if (allowed.some(name => values[name] === undefined)) throw new Error('Every mode requires its explicit flags.');
  if (!isAbsolute(values['--repository']) || !isAbsolute(values['--out'])) throw new Error('Use absolute repository/output paths.');
  return { command, values };
}
async function main() {
  const { command, values } = parseEntityLinkLiveArguments(process.argv.slice(2));
  if (command === 'prepare') console.log(JSON.stringify(await prepareEntityLinkLive({ repository: values['--repository'], bundle: values['--bundle'], output: values['--out'],
    executor: z.literal('codex').parse(values['--executor']), model: values['--model'], maxCalls: Number(values['--max-calls']), caseIds: values['--cases'].split(','), split: split.parse(values['--split']) }), null, 2));
  else if (command === 'check') console.log(JSON.stringify(await checkEntityLinkLive({ repository: values['--repository'], directory: values['--out'] }), null, 2));
  else {
    const controller = new AbortController(), abort = () => controller.abort(new Error('Capture cancelled.'));
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const result = await executeEntityLinkLive({ repository: values['--repository'], directory: values['--out'], confirmPlanId: values['--confirm-plan'] }, process.env, undefined, controller.signal);
      console.log(JSON.stringify(result, null, 2)); if (!result.complete || result.stopped) process.exitCode = 1;
    }
    finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : 'Entity-link capture failed.'); process.exitCode = 1; });
