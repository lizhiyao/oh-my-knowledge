import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { ConversationCatalog } from '../../observability/conversation/catalog.js';
import { checkStorageDirectory, withWorkspaceWrite } from '../../evidence/storage/knowledge-workspace.js';
import type { EvidenceWindow } from '../extraction/evidence.js';
import { conversationExtractionSource } from '../extraction/conversation-source.js';
import type { KnowledgeGenerationModel, KnowledgeGenerationOptions } from './application.js';
import { createLocalKnowledgeApplication } from './local.js';
import { FileGenerationJournalStore } from '../adapters/generation-journal-store.js';
import { GenerationOutcomeRefSchema, measureGenerationJSON, observeGenerationJSON } from '../extraction/native-outcome.js';
import type { GenerationJournal, GenerationStage } from '../extraction/generation-journal.js';
import { publishKnowledgeBytes, confirmKnowledgePublication } from '../adapters/durable-publication.js';
import { canonicalJson } from '../store.js';

const text = z.string().min(1).max(4096), uuid = z.string().uuid(), sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const AUTO_EXTRACTION_WORKFLOW = 'knowledge-body-first/v1' as const;
const ledgerVersion = 'conversation-phase-invocations/v2' as const;
const stageKind = z.enum(['body', 'association']);
const permissionFields = {
  schemaVersion: z.literal(2), workflowId: z.literal(AUTO_EXTRACTION_WORKFLOW),
  permissionId: uuid, threadId: text, executor: text, model: text,
  maxCalls: z.number().int().min(1).max(20), enabledAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  ledgerVersion: z.literal(ledgerVersion),
};
export const AutoExtractionStateSchema = z.strictObject({
  ...permissionFields, automationKind: z.literal('conversation-knowledge-extraction'), schemaStatus: z.literal('current'),
  owner: uuid, pid: z.number().int().positive(), hostname: text, callsUsed: z.number().int().min(0).max(20), enabled: z.boolean(),
  reason: z.enum(['waiting', 'generating', 'stopped', 'quota', 'expired', 'failed', 'interrupted', 'capacity']),
  checkedTurns: z.array(text).max(2000), initialTurns: z.array(text).max(3), attemptedVersions: z.array(text).max(1000),
  lastRunId: uuid.optional(), notBefore: z.iso.datetime().optional(),
});
export type AutoExtractionState = z.infer<typeof AutoExtractionStateSchema>;
export interface AutoExtractionUnsupportedState {
  schemaStatus: 'unsupported'; threadId: string; enabled: false; reason: 'permission_upgrade_required';
}
export type AutoExtractionStatus = AutoExtractionState | AutoExtractionUnsupportedState;
export const AutoExtractionConsentSchema = z.strictObject({
  workflowId: z.literal(AUTO_EXTRACTION_WORKFLOW), token: text, executor: z.enum(['codex', 'openai-api']), model: text,
  maxCalls: z.number().int().min(1).max(20),
});
export interface AutoExtractionPreview {
  token: string; title: string; turnCount: number; messages: EvidenceWindow['excerpts']; limitations: string[];
}
const permissionSchema = z.strictObject({ ...permissionFields, automationKind: z.literal('conversation-knowledge-permission'),
  token: text, initialTurns: z.array(text).max(3),
  futureWindow: z.strictObject({ newTurns: z.literal(3), precedingTurns: z.literal(2), stableMs: z.literal(30_000) }),
});
const scheduleSchema = z.strictObject({
  schemaVersion: z.literal(2), automationKind: z.literal('conversation-knowledge-schedule'), workflowId: z.literal(AUTO_EXTRACTION_WORKFLOW),
  permissionId: uuid, threadId: text, runId: uuid, executor: text, model: text,
  sourceVersion: sha, turnIds: z.array(text).min(1).max(5), scheduledAt: z.iso.datetime(), firstCallNumber: z.number().int().min(1).max(20),
});
type Schedule = z.infer<typeof scheduleSchema>;
const receiptSchema = z.strictObject({
  schemaVersion: z.literal(2), automationKind: z.literal('conversation-knowledge-invocation'), ledgerVersion: z.literal(ledgerVersion),
  permissionId: uuid, threadId: text, runId: uuid, invocationId: uuid, stageKind, requestDigest: sha,
  turnIds: z.array(text).min(1).max(5), sourceVersion: sha, callNumber: z.number().int().min(1).max(20),
  at: z.iso.datetime(), evidenceKind: z.enum(['dispatch-reservation', 'journal-claim-recovery']),
  recoveredFrom: z.strictObject({ journalGeneration: z.number().int().positive(), phaseState: text, nativeOutcome: GenerationOutcomeRefSchema.optional() }).optional(),
}).superRefine((receipt, context) => {
  if ((receipt.evidenceKind === 'journal-claim-recovery') !== !!receipt.recoveredFrom) context.addIssue({ code: 'custom', message: 'Invalid invocation recovery evidence.' });
});
const cooldownSchema = z.strictObject({
  schemaVersion: z.literal(2), automationKind: z.literal('conversation-knowledge-cooldown'), permissionId: uuid, threadId: text,
  runId: uuid, invocationId: uuid, stageKind, requestDigest: sha, outcome: GenerationOutcomeRefSchema, observedAt: z.iso.datetime(),
  decision: z.enum(['no-cooldown', 'required', 'invalid']), retryAfterMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), notBefore: z.iso.datetime().optional(),
}).superRefine((fact, context) => {
  if (fact.decision === 'required' ? fact.retryAfterMs === undefined || !fact.notBefore
    || Date.parse(fact.notBefore) !== Date.parse(fact.observedAt) + fact.retryAfterMs : fact.retryAfterMs !== undefined || fact.notBefore !== undefined) {
    context.addIssue({ code: 'custom', message: 'Invalid automation cooldown evidence.' });
  }
});
type Cooldown = z.infer<typeof cooldownSchema>;
type DispatchClaim = Parameters<NonNullable<KnowledgeGenerationOptions['beforeDispatch']>>[0];
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const unsupported = (threadId: string): AutoExtractionUnsupportedState => ({ schemaStatus: 'unsupported', threadId, enabled: false, reason: 'permission_upgrade_required' });
const MAX_FILES = 3000, INPUT_MAX_BYTES = 1024 * 1024;
class AutoExtractionCapacityError extends Error {}

/** One Studio lifetime schedules scoped windows. Every native phase consumes a distinct non-refundable reservation. */
export class ConversationAutoExtraction {
  private readonly owner = randomUUID();
  private readonly roots = new Map<string, { root: string; threadId: string }>();
  private readonly stable = new Map<string, { version: string; since: number }>();
  private active?: { key: string; permissionId: string; controller: AbortController };
  private ticking = false;
  private closed = false;
  private readonly timer?: ReturnType<typeof setInterval>;
  constructor(private readonly catalog: ConversationCatalog, private readonly options: {
    now?: () => number; stableMs?: number; intervalMs?: number; model(executor: string, model: string): KnowledgeGenerationModel;
  }) {
    if (options.intervalMs !== 0) { this.timer = setInterval(() => { void this.tick(); }, options.intervalMs ?? 5000); this.timer.unref(); }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private location(root: string, threadId: string) {
    if (!root.trim() || !threadId.trim()) throw new Error('Explicit auto-extraction scope required.');
    const workspace = resolve(root), directory = join(workspace, 'auto-extraction');
    checkStorageDirectory(workspace); checkStorageDirectory(directory);
    return { workspace, directory, path: join(directory, `${digest(threadId)}.json`), key: `${workspace}\0${threadId}` };
  }
  private readDocument(path: string): unknown {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1024n * 1024n) throw new Error('Invalid automation document.');
    const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Automation document changed during read.');
    const data = bytes.toString('utf8'); if (!Buffer.from(data).equals(bytes)) throw new Error('Invalid automation document UTF8.');
    return JSON.parse(data);
  }
  private read(root: string, threadId: string): AutoExtractionStatus | null {
    const { path } = this.location(root, threadId); if (!existsSync(path)) return null;
    const raw = this.readDocument(path) as Record<string, unknown>;
    if (raw.schemaVersion !== 2) return unsupported(threadId); // Never interpret legacy permission as authority for two calls.
    const state = AutoExtractionStateSchema.parse(raw);
    if (state.threadId !== threadId) throw new Error('Automation identity conflict.'); return state;
  }
  private write(root: string, state: AutoExtractionState) {
    publishKnowledgeBytes(this.location(root, state.threadId).path, JSON.stringify(AutoExtractionStateSchema.parse(state), null, 2), root, false);
  }
  private publish(root: string, path: string, value: unknown) {
    if (existsSync(path)) {
      if (canonicalJson(this.readDocument(path)) !== canonicalJson(value)) throw new Error('Automation immutable evidence conflict.');
      confirmKnowledgePublication(path, root);
    } else publishKnowledgeBytes(path, JSON.stringify(value, null, 2), root, true);
  }
  private files(root: string): string[] {
    const directory = join(root, 'auto-extraction'); checkStorageDirectory(directory);
    const entries = existsSync(directory) ? readdirSync(directory) : [];
    if (entries.length > MAX_FILES) throw new AutoExtractionCapacityError('Automation capacity exceeded.'); return entries;
  }
  private schedulePath(root: string, permissionId: string, runId: string) { return join(root, 'auto-extraction', `schedule-${uuid.parse(permissionId)}-${uuid.parse(runId)}.json`); }
  private receiptPath(root: string, permissionId: string, invocationId: string) { return join(root, 'auto-extraction', `phase-${uuid.parse(permissionId)}-${uuid.parse(invocationId)}.json`); }
  private store(root: string) { return new FileGenerationJournalStore(join(root, 'generation-journals'), root); }
  private journal(schedule: Schedule, root: string): GenerationJournal | undefined {
    const journal = this.store(root).read(schedule.runId);
    if (journal && (journal.workflowId !== AUTO_EXTRACTION_WORKFLOW || journal.mode !== 'generate' || journal.executor !== schedule.executor || journal.model !== schedule.model
      || journal.sourceVersion !== schedule.sourceVersion || journal.stages[0].stageKind !== 'body'
      || journal.stages.some((stage, index) => stage.stageKind !== (index === 0 ? 'body' : 'association')))) throw new Error('Automation journal identity conflict.');
    return journal;
  }
  private cooldown(root: string, schedule: Schedule, journal: GenerationJournal, stage: GenerationStage): Cooldown | undefined {
    const path = join(root, 'auto-extraction', `outcome-${schedule.permissionId}-${stage.invocationId}.json`);
    const outcome = this.store(root).outcome(journal, stage);
    if (!outcome) { if (existsSync(path)) throw new Error('Automation cooldown native evidence missing.'); return undefined; }
    // Reading an orphan native original does not call the model or invent a run5 receipt.
    const record = stage.outcomeRef ?? measureGenerationJSON(observeGenerationJSON({ archiveKind: 'knowledge-generation-native', schemaVersion: 1,
      runId: journal.runId, invocationId: stage.invocationId, requestDigest: stage.requestDigest, outcome }), 512 * 1024 * 1024);
    if (existsSync(path)) {
      const fact = cooldownSchema.parse(this.readDocument(path));
      if (fact.permissionId !== schedule.permissionId || fact.threadId !== schedule.threadId || fact.runId !== schedule.runId
        || fact.invocationId !== stage.invocationId || fact.stageKind !== stage.stageKind || fact.requestDigest !== stage.requestDigest
        || canonicalJson(fact.outcome) !== canonicalJson(record)) throw new Error('Automation cooldown identity conflict.');
      confirmKnowledgePublication(path, root); return fact;
    }
    const observedAt = new Date(this.now()).toISOString();
    const failure = outcome.outcomeKind === 'result' && outcome.result.ok === false ? outcome.result.failure : undefined;
    const retry = failure && typeof failure === 'object' && !Array.isArray(failure) ? failure.retryAfterMs : undefined;
    let wait: Pick<Cooldown, 'decision' | 'retryAfterMs' | 'notBefore'> = { decision: 'no-cooldown' };
    if (retry !== undefined) {
      if (typeof retry !== 'number' || !Number.isSafeInteger(retry) || retry < 0 || !Number.isSafeInteger(this.now() + retry)) wait = { decision: 'invalid' };
      else try { wait = { decision: 'required', retryAfterMs: retry, notBefore: new Date(Date.parse(observedAt) + retry).toISOString() }; } catch { wait = { decision: 'invalid' }; }
    }
    const fact = cooldownSchema.parse({ schemaVersion: 2, automationKind: 'conversation-knowledge-cooldown', permissionId: schedule.permissionId,
      threadId: schedule.threadId, runId: schedule.runId, invocationId: stage.invocationId, stageKind: stage.stageKind,
      requestDigest: stage.requestDigest, outcome: record, observedAt, ...wait });
    if (this.files(root).length >= MAX_FILES) throw new AutoExtractionCapacityError('Automation capacity exceeded.');
    this.publish(root, path, fact); return fact;
  }
  /** Reconstruct a missing ledger receipt only from an exact scheduled durable journal claim. No slot is refunded. */
  private reconcile(root: string, state: AutoExtractionState) {
    const directory = join(root, 'auto-extraction');
    const permission = permissionSchema.parse(this.readDocument(join(directory, `permission-${state.permissionId}.json`)));
    const identity = (value: z.infer<typeof permissionSchema> | AutoExtractionState) => Object.fromEntries(Object.keys(permissionFields).map(key => [key, value[key as keyof typeof value]]));
    if (canonicalJson(identity(permission)) !== canonicalJson(identity(state))) throw new Error('Automation permission conflict.');
    const schedules = this.files(root).filter(name => /^schedule-[a-f0-9-]{36}-[a-f0-9-]{36}\.json$/i.test(name)).map(name => {
      const schedule = scheduleSchema.parse(this.readDocument(join(directory, name)));
      if (name !== `schedule-${schedule.permissionId}-${schedule.runId}.json`) throw new Error('Automation schedule identity conflict.'); return schedule;
    }).filter(schedule => schedule.threadId === state.threadId);
    const facts: Cooldown[] = [];
    for (const schedule of schedules) {
      const journal = this.journal(schedule, root); if (!journal) continue;
      for (const [index, stage] of journal.stages.entries()) {
        const path = this.receiptPath(root, schedule.permissionId, stage.invocationId);
        if (stage.state !== 'prepared' && !existsSync(path)) {
          const recovered = receiptSchema.parse({ schemaVersion: 2, automationKind: 'conversation-knowledge-invocation', ledgerVersion,
            permissionId: schedule.permissionId, threadId: schedule.threadId, runId: schedule.runId, invocationId: stage.invocationId,
            stageKind: stage.stageKind, requestDigest: stage.requestDigest, turnIds: schedule.turnIds, sourceVersion: schedule.sourceVersion,
            callNumber: schedule.firstCallNumber + index, at: new Date(this.now()).toISOString(), evidenceKind: 'journal-claim-recovery',
            recoveredFrom: { journalGeneration: journal.generation, phaseState: stage.state, ...(stage.outcomeRef ? { nativeOutcome: stage.outcomeRef } : {}) } });
          if (this.files(root).length >= MAX_FILES) throw new AutoExtractionCapacityError('Automation capacity exceeded.'); this.publish(root, path, recovered);
        }
        const fact = stage.state !== 'prepared' ? this.cooldown(root, schedule, journal, stage) : undefined; if (fact) facts.push(fact);
      }
    }
    const receipts = this.files(root).filter(name => name.startsWith(`phase-${state.permissionId}-`) && name.endsWith('.json')).map(name => {
      const receipt = receiptSchema.parse(this.readDocument(join(directory, name)));
      const schedule = schedules.find(value => value.runId === receipt.runId && value.permissionId === state.permissionId);
      if (name !== `phase-${receipt.permissionId}-${receipt.invocationId}.json` || receipt.permissionId !== state.permissionId || receipt.threadId !== state.threadId
        || !schedule || schedule.sourceVersion !== receipt.sourceVersion || canonicalJson(schedule.turnIds) !== canonicalJson(receipt.turnIds)
        || receipt.callNumber !== schedule.firstCallNumber + (receipt.stageKind === 'body' ? 0 : 1)) throw new Error('Automation reservation conflict.'); return receipt;
    });
    const numbers = new Set(receipts.map(receipt => receipt.callNumber));
    if (numbers.size !== receipts.length || receipts.length < state.callsUsed || receipts.length > state.maxCalls
      || [...numbers].some(number => number > receipts.length)) throw new Error('Automation reservation conflict.');
    const latest = facts.filter(fact => fact.decision === 'required').map(fact => fact.notBefore!).sort().at(-1);
    const invalid = facts.some(fact => fact.decision === 'invalid');
    const changed = state.callsUsed !== receipts.length || latest !== undefined && (!state.notBefore || latest > state.notBefore) || invalid && state.enabled;
    state.callsUsed = receipts.length;
    if (latest && (!state.notBefore || latest > state.notBefore)) state.notBefore = latest;
    if (invalid && state.enabled) { state.enabled = false; state.reason = 'failed'; }
    if (changed) this.write(root, state); return state;
  }
  private reserve(root: string, threadId: string, expected: AutoExtractionState, schedule: Schedule, claim: DispatchClaim, signal: AbortSignal) {
    signal.throwIfAborted();
    withWorkspaceWrite(root, () => {
      const current = this.read(root, threadId);
      if (!current || current.schemaStatus !== 'current' || current.permissionId !== expected.permissionId || current.owner !== this.owner || !current.enabled
        || current.lastRunId !== claim.runId || !current.attemptedVersions.includes(schedule.sourceVersion)) throw new Error('Automation permission conflict.');
      this.reconcile(root, current);
      if (!current.enabled) throw new Error('Automation permission stopped.');
      if (this.now() >= Date.parse(current.expiresAt)) { current.enabled = false; current.reason = 'expired'; this.write(root, current); throw new Error('Automation permission expired.'); }
      if (current.notBefore && this.now() < Date.parse(current.notBefore)) throw new Error('Automation server cooldown is active.');
      const journal = this.journal(schedule, root), stage = journal?.stages.find(stage => stage.invocationId === claim.invocationId);
      if (!journal || !stage || stage.state !== 'prepared' || stage.stageKind !== claim.stageKind || stage.requestDigest !== claim.requestDigest) throw new Error('Automation phase claim conflict.');
      if (Buffer.byteLength(stage.system) + Buffer.byteLength(stage.input) > INPUT_MAX_BYTES) throw new AutoExtractionCapacityError('Automation input capacity exceeded.');
      const path = this.receiptPath(root, current.permissionId, claim.invocationId);
      if (existsSync(path)) throw new Error('Automation invocation already reserved; unknown dispatch must not be repeated.');
      if (current.callsUsed >= current.maxCalls) { current.enabled = false; current.reason = 'quota'; this.write(root, current); throw new Error('Automation quota exhausted.'); }
      if (this.files(root).length >= MAX_FILES) throw new AutoExtractionCapacityError('Automation capacity exceeded.');
      const receipt = receiptSchema.parse({ schemaVersion: 2, automationKind: 'conversation-knowledge-invocation', ledgerVersion,
        permissionId: current.permissionId, threadId, ...claim, turnIds: schedule.turnIds, sourceVersion: schedule.sourceVersion,
        at: new Date(this.now()).toISOString(), callNumber: current.callsUsed + 1, evidenceKind: 'dispatch-reservation' });
      this.publish(root, path, receipt); current.callsUsed++; this.write(root, current);
      signal.throwIfAborted();
      if (this.now() >= Date.parse(current.expiresAt)) { current.enabled = false; current.reason = 'expired'; this.write(root, current); throw new Error('Automation permission expired.'); }
    });
  }
  private ownerAlive(state: AutoExtractionState) {
    if (state.hostname !== hostname()) return true;
    try { process.kill(state.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  private async completed(threadId: string) {
    const conversation = await this.catalog.getConversation(threadId); if (!conversation) throw new Error('Conversation unavailable.');
    const turns = [...new Set(conversation.tasks.filter(task => ['completed', 'failed', 'interrupted'].includes(task.status)).map(task => task.sourceTurnId ?? task.turnId))];
    if (turns.length > 2000) throw new AutoExtractionCapacityError('Automation capacity exceeded.'); return { conversation, turns };
  }
  private async plan(threadId: string, signal?: AbortSignal) {
    const { conversation, turns } = await this.completed(threadId), selected = turns.slice(-3);
    const source = selected.length ? await conversationExtractionSource(this.catalog, threadId, undefined, signal, selected) : undefined;
    return { turns, selected, preview: { token: digest({ turns, version: source?.window.sourceVersion ?? null }), title: conversation.title,
      turnCount: selected.length, messages: source?.messages ?? [], limitations: source?.window.limitations ?? [] } };
  }
  async preview(threadId: string, signal?: AbortSignal): Promise<AutoExtractionPreview> { return (await this.plan(threadId, signal)).preview; }
  status(root: string, threadId: string): AutoExtractionStatus | null {
    const { workspace, key } = this.location(root, threadId);
    return withWorkspaceWrite(workspace, () => {
      const state = this.read(workspace, threadId); if (!state || state.schemaStatus === 'unsupported') return state;
      this.reconcile(workspace, state);
      if (state.enabled && state.owner !== this.owner && !this.ownerAlive(state)) { state.enabled = false; state.reason = 'interrupted'; this.write(workspace, state); }
      else if (state.enabled && this.now() >= Date.parse(state.expiresAt)) {
        state.enabled = false; state.reason = 'expired'; this.write(workspace, state); if (this.active?.key === key) this.active.controller.abort();
      }
      if (!state.enabled) this.roots.delete(key); return state;
    });
  }
  async enable(root: string, threadId: string, input: z.infer<typeof AutoExtractionConsentSchema>, signal?: AbortSignal) {
    const consent = AutoExtractionConsentSchema.parse(input);
    if (this.closed) throw new Error('Automation stopped.');
    const plan = await this.plan(threadId, signal); if (plan.preview.token !== consent.token) throw new Error('Source conflict. Preview again.'); signal?.throwIfAborted();
    const { workspace, directory, path, key } = this.location(root, threadId);
    if (this.roots.size >= 32 && !this.roots.has(key)) throw new AutoExtractionCapacityError('Automation capacity exceeded.');
    this.status(workspace, threadId);
    const state = withWorkspaceWrite(workspace, () => {
      const previous = this.read(workspace, threadId), current = previous?.schemaStatus === 'current' ? previous : undefined;
      if (current) this.reconcile(workspace, current);
      if (current?.enabled || this.active?.key === key || (current && current.owner !== this.owner && current.reason === 'generating' && this.ownerAlive(current))) throw new Error('Automation conflict. Stop the active run first.');
      if (this.files(workspace).length >= MAX_FILES - 3) throw new AutoExtractionCapacityError('Automation capacity exceeded.');
      if (previous?.schemaStatus === 'unsupported') {
        const original = readFileSync(path, 'utf8');
        const archive = join(directory, `legacy-state-${digest(threadId)}-${digest(original)}.json`);
        if (existsSync(archive)) {
          if (readFileSync(archive, 'utf8') !== original) throw new Error('Legacy permission archive conflict.'); confirmKnowledgePublication(archive, workspace);
        } else publishKnowledgeBytes(archive, original, workspace, true);
      }
      const next = AutoExtractionStateSchema.parse({ workflowId: consent.workflowId, executor: consent.executor, model: consent.model, maxCalls: consent.maxCalls, schemaVersion: 2, automationKind: 'conversation-knowledge-extraction', schemaStatus: 'current',
        threadId, owner: this.owner, pid: process.pid, hostname: hostname(), permissionId: randomUUID(), callsUsed: 0, ledgerVersion,
        enabledAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 24 * 60 * 60 * 1000).toISOString(), enabled: true, reason: 'waiting',
        checkedTurns: plan.turns.filter(id => !plan.selected.includes(id)), initialTurns: plan.selected, attemptedVersions: current?.attemptedVersions ?? [],
        ...(current?.lastRunId ? { lastRunId: current.lastRunId } : {}), ...(current?.notBefore ? { notBefore: current.notBefore } : {}) });
      this.publish(workspace, join(directory, `permission-${next.permissionId}.json`), permissionSchema.parse({ ...Object.fromEntries(Object.keys(permissionFields).map(key => [key, next[key as keyof typeof next]])),
        automationKind: 'conversation-knowledge-permission', token: consent.token, initialTurns: plan.selected, futureWindow: { newTurns: 3, precedingTurns: 2, stableMs: 30_000 } }));
      this.write(workspace, next); return next;
    });
    this.roots.set(key, { root: workspace, threadId }); this.stable.delete(key); return state;
  }
  stop(root: string, threadId: string) {
    const { workspace, key } = this.location(root, threadId);
    const state = withWorkspaceWrite(workspace, () => {
      const current = this.read(workspace, threadId);
      if (!current || current.schemaStatus === 'unsupported') return current;
      this.reconcile(workspace, current);
      if (current.enabled && current.owner !== this.owner && this.ownerAlive(current)) throw new Error('Automation conflict. Stop it in its owning Studio.');
      current.enabled = false; current.reason = 'stopped'; this.write(workspace, current); return current;
    });
    if (this.active?.key === key) this.active.controller.abort(); this.roots.delete(key); this.stable.delete(key); return state;
  }
  async tick() {
    if (this.closed || this.ticking) return; this.ticking = true;
    try {
      for (const [key, { root, threadId }] of this.roots) {
        if (this.closed) break;
        let deadline: ReturnType<typeof setTimeout> | undefined, scheduled: Schedule | undefined, permissionId: string | undefined;
        const controller = new AbortController();
        try {
          const state = this.status(root, threadId); if (!state || state.schemaStatus !== 'current' || !state.enabled || state.owner !== this.owner) continue;
          permissionId = state.permissionId; this.active = { key, permissionId, controller };
          if (state.notBefore && this.now() < Date.parse(state.notBefore)) continue;
          const { turns } = await this.completed(threadId), pending = state.initialTurns.length ? state.initialTurns : turns.filter(id => !state.checkedTurns.includes(id)).slice(0, 3);
          if (!pending.length) continue;
          const first = turns.indexOf(pending[0]), selected = state.initialTurns.length ? pending : [...turns.slice(Math.max(0, first - 2), first), ...pending];
          const { window } = await conversationExtractionSource(this.catalog, threadId, undefined, controller.signal, selected);
          const model = this.options.model(state.executor, state.model);
          if (model.executor !== state.executor || model.model !== state.model || model.timeoutMs !== 300_000) throw new Error('Automation model selection conflict.');
          const stable = this.stable.get(key);
          if (!stable || stable.version !== window.sourceVersion) { this.stable.set(key, { version: window.sourceVersion, since: this.now() }); continue; }
          if (this.now() - stable.since < (this.options.stableMs ?? 30_000)) continue;
          const reserved = withWorkspaceWrite(root, () => {
            const current = this.read(root, threadId); if (!current || current.schemaStatus !== 'current' || !current.enabled || current.owner !== this.owner || this.now() >= Date.parse(current.expiresAt)) return null;
            this.reconcile(root, current); if (!current.enabled || current.notBefore && this.now() < Date.parse(current.notBefore)) return null;
            const duplicate = current.attemptedVersions.includes(window.sourceVersion);
            current.checkedTurns = [...new Set([...current.checkedTurns, ...pending])]; current.initialTurns = [];
            if (!duplicate) {
              if (current.callsUsed >= current.maxCalls) { current.enabled = false; current.reason = 'quota'; this.write(root, current); return null; }
              if (current.attemptedVersions.length >= 1000 || this.files(root).length >= MAX_FILES - 3) throw new AutoExtractionCapacityError('Automation capacity exceeded.');
              current.lastRunId = randomUUID(); current.attemptedVersions.push(window.sourceVersion); current.reason = 'generating';
              scheduled = scheduleSchema.parse({ schemaVersion: 2, automationKind: 'conversation-knowledge-schedule', workflowId: AUTO_EXTRACTION_WORKFLOW,
                permissionId: current.permissionId, threadId, runId: current.lastRunId, executor: current.executor, model: current.model,
                sourceVersion: window.sourceVersion, turnIds: selected, scheduledAt: new Date(this.now()).toISOString(), firstCallNumber: current.callsUsed + 1 });
              this.publish(root, this.schedulePath(root, current.permissionId, current.lastRunId), scheduled);
            }
            this.write(root, current); return duplicate ? null : current;
          });
          this.stable.delete(key); if (!reserved || !scheduled) continue;
          deadline = setTimeout(() => controller.abort(), Math.max(0, Date.parse(reserved.expiresAt) - this.now())); deadline.unref();
          const app = createLocalKnowledgeApplication(root), snapshot = app.capture({ path: window.sourcePath, records: window.records, origin: window.origin }, controller.signal);
          const result = await app.generate(snapshot.snapshotId, model, scheduled.runId, controller.signal, {
            beforeDispatch: claim => this.reserve(root, threadId, reserved, scheduled!, claim, controller.signal),
            onOutcomeArchived: () => withWorkspaceWrite(root, () => {
              const journal = this.journal(scheduled!, root); if (journal) { const stage = journal.stages.at(-1)!; this.cooldown(root, scheduled!, journal, stage); }
            }),
          });
          withWorkspaceWrite(root, () => {
            const current = this.read(root, threadId);
            if (!current || current.schemaStatus !== 'current' || current.permissionId !== reserved.permissionId || current.owner !== this.owner) return;
            this.reconcile(root, current); if (current.enabled) {
              current.reason = result.journal.status === 'completed' ? 'waiting' : 'failed';
              if (result.journal.status !== 'completed') current.enabled = false;
              if (current.callsUsed >= current.maxCalls) { current.enabled = false; current.reason = 'quota'; } this.write(root, current);
            }
          });
        } catch (error) {
          try { withWorkspaceWrite(root, () => {
            const current = this.read(root, threadId);
            if (!current || current.schemaStatus !== 'current' || current.permissionId !== permissionId || current.owner !== this.owner) return;
            this.reconcile(root, current);
            if (scheduled && !this.files(root).some(name => name.startsWith(`phase-${current.permissionId}-`)
              && receiptSchema.parse(this.readDocument(join(root, 'auto-extraction', name))).runId === scheduled!.runId)) {
              current.attemptedVersions = current.attemptedVersions.filter(version => version !== scheduled!.sourceVersion);
            }
            if (current.enabled) { current.enabled = false; current.reason = error instanceof AutoExtractionCapacityError ? 'capacity' : 'failed'; } this.write(root, current);
          }); } catch { /* A blocked ledger must not authorize more calls or crash Studio. */ }
        } finally { if (deadline) clearTimeout(deadline); this.active = undefined; }
      }
    } finally { this.ticking = false; }
  }
  close() {
    this.closed = true; if (this.timer) clearInterval(this.timer); this.active?.controller.abort();
    for (const { root, threadId } of this.roots.values()) try { withWorkspaceWrite(root, () => {
      const current = this.read(root, threadId);
      if (current?.schemaStatus === 'current' && current.enabled && current.owner === this.owner) { current.enabled = false; current.reason = 'interrupted'; this.write(root, current); }
    }); } catch { /* Preserve claims on shutdown failures. */ }
    this.roots.clear(); this.stable.clear();
  }
}
