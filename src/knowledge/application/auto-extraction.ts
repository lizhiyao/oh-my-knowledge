import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { createJsonFileAtomic, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import type { ConversationCatalog } from '../../observability/conversation/catalog.js';
import type { EvidenceWindow } from '../extraction/evidence.js';
import type { ExtractionModel } from './application.js';
import { createLocalKnowledgeApplication } from './local.js';
import { validateExtractionModelSelection } from '../adapters/executor.js';
import { checkStorageDirectory, withWorkspaceWrite } from '../../evidence/storage/knowledge-workspace.js';
import { conversationExtractionSource } from '../extraction/conversation-source.js';
import { assertExtractionInputCapacity, extractionModelInput, ExtractionInputCapacityError } from '../extraction/model-input.js';
import { extractionPrompt } from '../extraction/generation.js';
import { FileExtractionRunStore } from '../adapters/run-store.js';
import { ExtractionOutcomeRefSchema } from '../extraction/runs.js';
import { ExtractionBudgetReservationSchema, ExtractionGenerationPolicySchema, SINGLE_EXTRACTION_POLICY, TRANSIENT_EXTRACTION_FAILURES,
  type ExtractionBudgetReservation, type ExtractionGenerationPolicy } from '../extraction/generation-policy.js';

const text = z.string().min(1).max(4096);
const schema = z.strictObject({
  schemaVersion: z.literal(1), automationKind: z.literal('conversation-knowledge-extraction'),
  threadId: text, owner: z.string().uuid(), pid: z.number().int().positive(), hostname: text,
  permissionId: z.string().uuid(),
  executor: text, model: text, maxCalls: z.number().int().min(1).max(20), callsUsed: z.number().int().min(0).max(20),
  enabledAt: z.iso.datetime(), expiresAt: z.iso.datetime(), enabled: z.boolean(),
  reason: z.enum(['waiting', 'generating', 'stopped', 'quota', 'expired', 'failed', 'interrupted', 'capacity']),
  checkedTurns: z.array(text).max(2000), initialTurns: z.array(text).max(3),
  attemptedVersions: z.array(text).max(1000), lastRunId: z.string().uuid().optional(),
  policy: ExtractionGenerationPolicySchema.optional(), ledgerVersion: z.literal('conversation-invocations/v1').optional(),
  tokensReserved: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  notBefore: z.iso.datetime().optional(),
});
export type AutoExtractionState = z.infer<typeof schema>;
export interface AutoExtractionPreview {
  token: string; title: string; turnCount: number; messages: EvidenceWindow['excerpts']; limitations: string[];
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const permissionSchema = z.strictObject({ schemaVersion: z.literal(1), automationKind: z.literal('conversation-knowledge-permission'),
  permissionId: z.string().uuid(), threadId: text, executor: text, model: text, maxCalls: z.number().int().min(1).max(20),
  enabledAt: z.iso.datetime(), expiresAt: z.iso.datetime(), token: text, initialTurns: z.array(text).max(3),
  futureWindow: z.strictObject({ newTurns: z.literal(3), precedingTurns: z.literal(2), stableMs: z.literal(30_000) }),
  policy: ExtractionGenerationPolicySchema.optional(), ledgerVersion: z.literal('conversation-invocations/v1').optional(),
});
const receiptSchema = z.strictObject({ schemaVersion: z.literal(1), automationKind: z.literal('conversation-knowledge-attempt'),
  ledgerVersion: z.literal('conversation-invocations/v1'), permissionId: z.string().uuid(), threadId: text,
  runId: z.string().uuid(), attemptId: z.string().uuid(), requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  policyId: z.enum(['knowledge-generation-single/v1', 'knowledge-generation-bounded/v1']),
  turnIds: z.array(text).min(1).max(5), sourceVersion: text, reservedAt: z.iso.datetime(), callNumber: z.number().int().min(1).max(20),
  budget: ExtractionBudgetReservationSchema.optional(),
});
const cooldownSchema = z.strictObject({ schemaVersion: z.literal(1), automationKind: z.literal('conversation-knowledge-cooldown'),
  permissionId: z.string().uuid(), threadId: text, runId: z.string().uuid(), attemptId: z.string().uuid(),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceVersion: text, policyId: z.enum(['knowledge-generation-single/v1', 'knowledge-generation-bounded/v1']),
  outcome: ExtractionOutcomeRefSchema, observedAt: z.iso.datetime(),
  decision: z.enum(['no-cooldown', 'required', 'invalid']), retryAfterMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  notBefore: z.iso.datetime().optional(),
}).superRefine((fact, context) => {
  if (fact.decision === 'required' ? fact.retryAfterMs === undefined || !fact.notBefore
    || Date.parse(fact.notBefore) !== Date.parse(fact.observedAt) + fact.retryAfterMs : fact.retryAfterMs !== undefined || fact.notBefore !== undefined) {
    context.addIssue({ code: 'custom', message: 'Invalid automation cooldown evidence.' });
  }
});
type CooldownFact = z.infer<typeof cooldownSchema>;
type DispatchClaim = { runId: string; attemptId: string; requestDigest: string; budget?: ExtractionBudgetReservation };
function readDocument(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid automation receipt.');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
/** Publication is exclusive. A lost acknowledgement still leaves an authoritative, non-refundable receipt. */
function syncDocument(path: string) {
  for (const target of [path, dirname(path), dirname(dirname(path))]) {
    const fd = openSync(target, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
function publishReceipt(path: string, value: unknown) {
  createJsonFileAtomic(path, value); syncDocument(path);
}

/** One Studio lifetime owns scheduling. A reservation is durable before any model call. */
export class ConversationAutoExtraction {
  private readonly owner = randomUUID();
  private readonly roots = new Map<string, { root: string; threadId: string }>();
  private readonly stable = new Map<string, { version: string; since: number }>();
  private active?: { key: string; controller: AbortController };
  private ticking = false;
  private closed = false;
  private readonly timer?: ReturnType<typeof setInterval>;
  constructor(private readonly catalog: ConversationCatalog, private readonly options: {
    now?: () => number; stableMs?: number; intervalMs?: number; model: (executor: string, model: string, policy?: ExtractionGenerationPolicy) => ExtractionModel;
  }) {
    if (options.intervalMs !== 0) {
      this.timer = setInterval(() => { void this.tick(); }, options.intervalMs ?? 5000);
      this.timer.unref();
    }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private location(root: string, threadId: string) {
    if (!root.trim() || !threadId.trim()) throw new Error('Explicit auto-extraction scope required.');
    const workspace = resolve(root), directory = join(workspace, 'auto-extraction');
    checkStorageDirectory(workspace); checkStorageDirectory(directory);
    return { workspace, path: join(directory, `${digest(threadId)}.json`), key: `${workspace}\0${threadId}` };
  }
  private read(root: string, threadId: string) {
    const { path } = this.location(root, threadId);
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid automation state.');
    const state = schema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (state.threadId !== threadId) throw new Error('Automation identity conflict.');
    return state;
  }
  private write(root: string, state: AutoExtractionState) {
    const { path } = this.location(root, state.threadId);
    writeJsonFileAtomic(path, schema.parse(state)); syncDocument(path);
  }
  /** Once per archived invocation, including sidecars whose manifest acknowledgement was lost. */
  private cooldowns(root: string, threadId: string): CooldownFact[] {
    const directory = join(root, 'auto-extraction'), cooldownRoot = join(directory, 'cooldowns');
    checkStorageDirectory(cooldownRoot);
    const entries = readdirSync(directory);
    if (entries.length > 3000 || existsSync(cooldownRoot) && readdirSync(cooldownRoot).length > 3000) throw new Error('Automation capacity exceeded.');
    const receipts = entries.filter(name => /^attempt-[a-f0-9-]{36}-[a-f0-9-]{36}\.json$/i.test(name))
      .map(name => ({ name, receipt: receiptSchema.parse(readDocument(join(directory, name))) }))
      .filter(({ receipt }) => receipt.threadId === threadId);
    const facts: CooldownFact[] = [];
    for (const { name, receipt } of receipts) {
      if (name !== `attempt-${receipt.permissionId}-${receipt.attemptId}.json`) throw new Error('Automation reservation conflict.');
      const path = join(cooldownRoot, `${digest(threadId)}-${receipt.runId}-${receipt.attemptId}.json`);
      const existing = () => {
        const fact = cooldownSchema.parse(readDocument(path));
        if (fact.permissionId !== receipt.permissionId || fact.threadId !== receipt.threadId || fact.runId !== receipt.runId
          || fact.attemptId !== receipt.attemptId || fact.requestDigest !== receipt.requestDigest
          || fact.sourceVersion !== receipt.sourceVersion || fact.policyId !== receipt.policyId) throw new Error('Automation cooldown identity conflict.');
        syncDocument(path); return fact;
      };
      if (existsSync(path)) { facts.push(existing()); continue; }
      const store = new FileExtractionRunStore(join(root, 'extraction-runs'), root), run = store.read(receipt.runId);
      const attempt = run.attempts.find(value => value.attemptId === receipt.attemptId);
      if (!attempt || attempt.requestDigest !== receipt.requestDigest || run.sourceVersion !== receipt.sourceVersion
        || run.policy.policyId !== receipt.policyId) throw new Error('Automation outcome identity conflict.');
      let recorded: ReturnType<FileExtractionRunStore['readOutcome']>;
      try { recorded = store.readOutcome(receipt.runId, receipt.attemptId, attempt.outcome); }
      catch (error) { if (!attempt.outcome && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const result = recorded.outcome.outcomeKind === 'result' ? recorded.outcome.result : undefined;
      const failure = result?.failure;
      const value = result?.ok === false && failure && typeof failure === 'object' && !Array.isArray(failure) ? failure.retryAfterMs : undefined;
      const observedAt = new Date(this.now()).toISOString();
      let wait: { decision: 'no-cooldown' | 'required' | 'invalid'; retryAfterMs?: number; notBefore?: string } = { decision: 'no-cooldown' };
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(this.now() + value)) wait = { decision: 'invalid' };
        else {
          try {
            const notBefore = new Date(Date.parse(observedAt) + value).toISOString();
            wait = z.iso.datetime().safeParse(notBefore).success ? { decision: 'required', retryAfterMs: value, notBefore } : { decision: 'invalid' };
          } catch { wait = { decision: 'invalid' }; }
        }
      }
      const fact = cooldownSchema.parse({ schemaVersion: 1, automationKind: 'conversation-knowledge-cooldown',
        permissionId: receipt.permissionId, threadId, runId: receipt.runId, attemptId: receipt.attemptId,
        requestDigest: receipt.requestDigest, sourceVersion: receipt.sourceVersion, policyId: receipt.policyId,
        outcome: recorded.ref, observedAt, ...wait });
      try { publishReceipt(path, fact); facts.push(fact); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; facts.push(existing()); }
    }
    return facts;
  }
  private reconcile(root: string, state: AutoExtractionState) {
    // Existing v1 permissions without this optional ledger retain their original single-call accounting.
    if (!state.ledgerVersion) return state;
    const directory = join(root, 'auto-extraction');
    const permission = permissionSchema.parse(readDocument(join(directory, `permission-${state.permissionId}.json`)));
    if (permission.permissionId !== state.permissionId || permission.ledgerVersion !== state.ledgerVersion || permission.threadId !== state.threadId
      || permission.executor !== state.executor || permission.model !== state.model || permission.maxCalls !== state.maxCalls
      || permission.enabledAt !== state.enabledAt || permission.expiresAt !== state.expiresAt
      || digest(permission.policy ?? SINGLE_EXTRACTION_POLICY) !== digest(state.policy ?? SINGLE_EXTRACTION_POLICY)) throw new Error('Automation permission conflict.');
    const prefix = `attempt-${state.permissionId}-`;
    const receipts = readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith('.json'));
    if (receipts.length > state.maxCalls) throw new Error('Automation reservation conflict.');
    const numbers = new Set<number>(); let tokens = 0;
    const policy = state.policy ?? SINGLE_EXTRACTION_POLICY;
    for (const name of receipts) {
      const receipt = receiptSchema.parse(readDocument(join(directory, name)));
      if (name !== `${prefix}${receipt.attemptId}.json` || receipt.permissionId !== state.permissionId
        || receipt.threadId !== state.threadId || receipt.policyId !== policy.policyId || numbers.has(receipt.callNumber)
        || policy.policyId === 'knowledge-generation-bounded/v1' && (!receipt.budget || receipt.budget.profileId !== policy.profileId
          || receipt.budget.outputUpperBound !== policy.maxOutputTokens)
        || policy.policyId === 'knowledge-generation-single/v1' && receipt.budget) throw new Error('Automation reservation conflict.');
      numbers.add(receipt.callNumber); tokens += receipt.budget?.tokensReserved ?? 0;
    }
    if ([...numbers].some(number => number > receipts.length) || receipts.length < state.callsUsed
      || !Number.isSafeInteger(tokens) || tokens < (state.tokensReserved ?? 0)
      || policy.policyId === 'knowledge-generation-bounded/v1' && tokens > policy.maxTotalTokens) throw new Error('Automation reservation conflict.');
    const facts = this.cooldowns(root, state.threadId);
    const latest = facts.filter(fact => fact.decision === 'required').map(fact => fact.notBefore!).sort().at(-1);
    const invalid = facts.some(fact => fact.permissionId === state.permissionId && fact.decision === 'invalid');
    const changed = state.callsUsed !== receipts.length || state.tokensReserved !== tokens || latest !== undefined && (!state.notBefore || latest > state.notBefore)
      || invalid && state.enabled;
    state.callsUsed = receipts.length; state.tokensReserved = tokens;
    if (latest && (!state.notBefore || latest > state.notBefore)) state.notBefore = latest;
    if (invalid && state.enabled) { state.enabled = false; state.reason = 'failed'; }
    if (changed) this.write(root, state);
    return state;
  }
  private reserve(root: string, threadId: string, expected: AutoExtractionState, window: EvidenceWindow,
    turnIds: string[], claim: DispatchClaim, signal: AbortSignal) {
    signal.throwIfAborted();
    withWorkspaceWrite(root, () => {
      const current = this.read(root, threadId);
      if (!current || current.permissionId !== expected.permissionId || current.owner !== this.owner || !current.enabled
        || current.lastRunId !== claim.runId || !current.attemptedVersions.includes(window.sourceVersion)) throw new Error('Automation permission conflict.');
      this.reconcile(root, current);
      if (!current.enabled) throw new Error('Automation permission stopped.');
      if (this.now() >= Date.parse(current.expiresAt)) {
        current.enabled = false; current.reason = 'expired'; this.write(root, current); throw new Error('Automation permission expired.');
      }
      if (current.notBefore && this.now() < Date.parse(current.notBefore)) throw new Error('Automation is waiting for the server cooldown.');
      const policy = current.policy ?? SINGLE_EXTRACTION_POLICY;
      const path = join(root, 'auto-extraction', `attempt-${current.permissionId}-${claim.attemptId}.json`);
      if (existsSync(path)) {
        const saved = receiptSchema.parse(readDocument(path));
        if (saved.runId !== claim.runId || saved.requestDigest !== claim.requestDigest || digest(saved.budget) !== digest(claim.budget)) throw new Error('Automation reservation conflict.');
        return; // The exact receipt has already consumed its slot; never debit twice.
      }
      if (!current.ledgerVersion || policy.policyId === 'knowledge-generation-bounded/v1' && (!claim.budget
        || claim.budget.profileId !== policy.profileId || claim.budget.outputUpperBound !== policy.maxOutputTokens)
        || policy.policyId === 'knowledge-generation-single/v1' && claim.budget) throw new Error('Automation reservation policy conflict.');
      const total = (current.tokensReserved ?? 0) + (claim.budget?.tokensReserved ?? 0);
      if (current.callsUsed >= current.maxCalls || !Number.isSafeInteger(total)
        || policy.policyId === 'knowledge-generation-bounded/v1' && total > policy.maxTotalTokens) {
        current.enabled = false; current.reason = 'quota'; this.write(root, current); throw new Error('Automation quota exhausted.');
      }
      const cooldownRoot = join(root, 'auto-extraction', 'cooldowns');
      if (readdirSync(join(root, 'auto-extraction')).length + (existsSync(cooldownRoot) ? 1 : 2) > 3000) {
        current.enabled = false; current.reason = 'capacity'; this.write(root, current); throw new Error('Automation capacity exceeded.');
      }
      signal.throwIfAborted();
      mkdirSync(cooldownRoot, { recursive: true }); checkStorageDirectory(cooldownRoot);
      const receipt = receiptSchema.parse({ schemaVersion: 1, automationKind: 'conversation-knowledge-attempt',
        ledgerVersion: 'conversation-invocations/v1', permissionId: current.permissionId, threadId,
        ...claim, policyId: policy.policyId, turnIds, sourceVersion: window.sourceVersion,
        reservedAt: new Date(this.now()).toISOString(), callNumber: current.callsUsed + 1 });
      publishReceipt(path, receipt);
      current.callsUsed++; current.tokensReserved = total; this.write(root, current);
      signal.throwIfAborted();
      if (this.now() >= Date.parse(current.expiresAt)) {
        current.enabled = false; current.reason = 'expired'; this.write(root, current); throw new Error('Automation permission expired.');
      }
    });
  }
  /** Only a fully checked, empty dispatch ledger proves a failed local start did not send this window. */
  private releaseUnsentWindow(root: string, current: AutoExtractionState, scheduled: { runId: string; sourceVersion: string }) {
    if (!current.ledgerVersion || current.lastRunId !== scheduled.runId) return;
    this.reconcile(root, current);
    const directory = join(root, 'auto-extraction'), prefix = `attempt-${current.permissionId}-`;
    const receipts = readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith('.json'))
      .map(name => receiptSchema.parse(readDocument(join(directory, name))));
    if (!receipts.some(receipt => receipt.runId === scheduled.runId)) {
      current.attemptedVersions = current.attemptedVersions.filter(version => version !== scheduled.sourceVersion);
    }
  }
  private ownerAlive(state: AutoExtractionState) {
    if (state.hostname !== hostname()) return true;
    try { process.kill(state.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  private async completed(threadId: string) {
    const conversation = await this.catalog.getConversation(threadId);
    if (!conversation) throw new Error('Conversation unavailable.');
    const turns = [...new Set(conversation.tasks.filter(task => ['completed', 'failed', 'interrupted'].includes(task.status))
      .map(task => task.sourceTurnId ?? task.turnId))];
    if (turns.length > 2000) throw new Error('Automation capacity exceeded.');
    return { conversation, turns };
  }
  private async plan(threadId: string, signal?: AbortSignal) {
    const { conversation, turns } = await this.completed(threadId);
    const selected = turns.slice(-3);
    const source = selected.length ? await conversationExtractionSource(this.catalog, threadId, undefined, signal, selected) : undefined;
    return { turns, selected, preview: { token: digest({ turns, version: source?.window.sourceVersion ?? null }),
      title: conversation.title, turnCount: selected.length, messages: source?.messages ?? [], limitations: source?.window.limitations ?? [] } };
  }
  async preview(threadId: string, signal?: AbortSignal): Promise<AutoExtractionPreview> { return (await this.plan(threadId, signal)).preview; }
  status(root: string, threadId: string) {
    const { workspace, key } = this.location(root, threadId);
    return withWorkspaceWrite(workspace, () => {
      const state = this.read(workspace, threadId);
      if (!state) return null;
      this.reconcile(workspace, state);
      if (state.enabled && state.owner !== this.owner && !this.ownerAlive(state)) {
        state.enabled = false; state.reason = 'interrupted'; this.write(workspace, state);
      } else if (state.enabled && this.now() >= Date.parse(state.expiresAt)) {
        state.enabled = false; state.reason = 'expired'; this.write(workspace, state);
        if (this.active?.key === key) this.active.controller.abort();
      }
      if (!state.enabled) this.roots.delete(key);
      return state;
    });
  }
  async enable(root: string, threadId: string, consent: { token: string; executor: string; model: string; maxCalls: number; policy?: ExtractionGenerationPolicy }, signal?: AbortSignal) {
    if (this.closed) throw new Error('Automation stopped.');
    const plan = await this.plan(threadId, signal);
    if (plan.preview.token !== consent.token) throw new Error('Source conflict. Preview again.');
    const policy = ExtractionGenerationPolicySchema.parse(consent.policy ?? SINGLE_EXTRACTION_POLICY);
    // Validate executor/model before saving permission, without invoking it.
    validateExtractionModelSelection(consent.executor, consent.model);
    signal?.throwIfAborted();
    const { workspace, key } = this.location(root, threadId);
    if (this.roots.size >= 32 && !this.roots.has(key)) throw new Error('Automation capacity exceeded.');
    this.status(root, threadId);
    const state = withWorkspaceWrite(workspace, () => {
      const previous = this.read(workspace, threadId);
      if (previous) this.reconcile(workspace, previous);
      if (previous?.enabled || this.active?.key === key || (previous?.owner !== this.owner && previous?.reason === 'generating' && this.ownerAlive(previous))) throw new Error('Automation conflict. Stop the active run first.');
      const directory = join(workspace, 'auto-extraction');
      if (existsSync(directory) && readdirSync(directory).length >= 2998) throw new Error('Automation capacity exceeded.');
      const next = schema.parse({ schemaVersion: 1, automationKind: 'conversation-knowledge-extraction', threadId,
        owner: this.owner, pid: process.pid, hostname: hostname(), permissionId: randomUUID(), executor: consent.executor, model: consent.model,
        maxCalls: consent.maxCalls, callsUsed: 0, ledgerVersion: 'conversation-invocations/v1', tokensReserved: 0,
        ...(policy.policyId === 'knowledge-generation-bounded/v1' ? { policy } : {}), enabledAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(this.now() + 24 * 60 * 60 * 1000).toISOString(), enabled: true, reason: 'waiting',
        checkedTurns: plan.turns.filter(id => !plan.selected.includes(id)), initialTurns: plan.selected,
        ...(previous?.notBefore ? { notBefore: previous.notBefore } : {}),
        attemptedVersions: previous?.attemptedVersions ?? [], ...(previous?.lastRunId ? { lastRunId: previous.lastRunId } : {}) });
      publishReceipt(join(directory, `permission-${next.permissionId}.json`), permissionSchema.parse({
        schemaVersion: 1, automationKind: 'conversation-knowledge-permission', permissionId: next.permissionId,
        threadId, executor: next.executor, model: next.model, maxCalls: next.maxCalls,
        enabledAt: next.enabledAt, expiresAt: next.expiresAt, token: consent.token, initialTurns: plan.selected,
        futureWindow: { newTurns: 3, precedingTurns: 2, stableMs: 30_000 }, ledgerVersion: next.ledgerVersion,
        ...(next.policy ? { policy: next.policy } : {}),
      }));
      this.write(workspace, next); return next;
    });
    this.roots.set(key, { root: workspace, threadId });
    this.stable.delete(key); return state;
  }
  stop(root: string, threadId: string) {
    const { workspace, key } = this.location(root, threadId);
    const state = withWorkspaceWrite(workspace, () => {
      const current = this.read(workspace, threadId);
      if (current) this.reconcile(workspace, current);
      if (current?.enabled && current.owner !== this.owner && this.ownerAlive(current)) throw new Error('Automation conflict. Stop it in its owning Studio.');
      if (current) { current.enabled = false; current.reason = 'stopped'; this.write(workspace, current); }
      return current;
    });
    if (this.active?.key === key) this.active.controller.abort();
    this.roots.delete(key); this.stable.delete(key); return state;
  }
  /** Serialized across scopes. Tests use an explicit clock and a model stub. */
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      for (const [key, { root, threadId }] of this.roots) {
        if (this.closed) break;
        const controller = new AbortController(); this.active = { key, controller };
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let scheduled: { runId: string; sourceVersion: string } | undefined;
        try {
          const state = this.status(root, threadId);
          if (!state?.enabled || state.owner !== this.owner) continue;
          if (state.notBefore && this.now() < Date.parse(state.notBefore)) continue;
          const { turns } = await this.completed(threadId);
          const pending = state.initialTurns.length ? state.initialTurns : turns.filter(id => !state.checkedTurns.includes(id)).slice(0, 3);
          if (!pending.length) continue;
          const first = turns.indexOf(pending[0]);
          const selected = state.initialTurns.length ? pending : [...turns.slice(Math.max(0, first - 2), first), ...pending];
          const { window } = await conversationExtractionSource(this.catalog, threadId, undefined, controller.signal, selected);
          // Check before reserving a paid call or marking this source version attempted.
          const model = this.options.model(state.executor, state.model, state.policy);
          if (model.executor !== state.executor || model.model !== state.model) throw new Error('Automation model selection conflict.');
          assertExtractionInputCapacity(extractionModelInput(window), extractionPrompt(model).system);
          const stable = this.stable.get(key);
          if (!stable || stable.version !== window.sourceVersion) { this.stable.set(key, { version: window.sourceVersion, since: this.now() }); continue; }
          if (this.now() - stable.since < (this.options.stableMs ?? 30_000)) continue;
          const reserved = withWorkspaceWrite(root, () => {
            const current = this.read(root, threadId);
            if (!current?.enabled || current.owner !== this.owner || this.now() >= Date.parse(current.expiresAt)) return null;
            if (current.notBefore && this.now() < Date.parse(current.notBefore)) return null;
            const duplicate = current.attemptedVersions.includes(window.sourceVersion);
            current.checkedTurns = [...new Set([...current.checkedTurns, ...pending])]; current.initialTurns = [];
            if (!duplicate) {
              if (readdirSync(join(root, 'auto-extraction')).length >= 3000) { current.enabled = false; current.reason = 'capacity'; this.write(root, current); return null; }
              if (current.callsUsed >= current.maxCalls) { current.enabled = false; current.reason = 'quota'; this.write(root, current); return null; }
              if (current.attemptedVersions.length >= 1000) { current.enabled = false; current.reason = 'capacity'; this.write(root, current); return null; }
              current.attemptedVersions.push(window.sourceVersion); current.lastRunId = randomUUID(); current.reason = 'generating';
            }
            this.write(root, current);
            return duplicate ? null : current;
          });
          this.stable.delete(key);
          if (!reserved) continue;
          scheduled = { runId: reserved.lastRunId!, sourceVersion: window.sourceVersion };
          deadline = setTimeout(() => controller.abort(), Math.max(0, Date.parse(reserved.expiresAt) - this.now())); deadline.unref();
          const app = createLocalKnowledgeApplication(root);
          const snapshot = app.capture({ path: window.sourcePath, records: window.records, origin: window.origin }, controller.signal);
          const run = await app.generate(snapshot.snapshotId, model, reserved.lastRunId!, controller.signal, { policy: reserved.policy,
            beforeDispatch: claim => this.reserve(root, threadId, reserved, window, selected, claim, controller.signal),
            onOutcomeArchived: () => withWorkspaceWrite(root, () => { this.cooldowns(root, threadId); }) });
          withWorkspaceWrite(root, () => {
            // Publish facts even when an old owner finishes after a new permission was granted.
            // The old task never mutates that new permission; its gate/status reconciles these facts.
            this.cooldowns(root, threadId);
            const current = this.read(root, threadId);
            if (!current || current.permissionId !== reserved.permissionId || current.owner !== this.owner
              || current.lastRunId !== reserved.lastRunId) return;
            if (run.status !== 'completed') this.releaseUnsentWindow(root, current, scheduled!);
            this.reconcile(root, current);
            if (!current.enabled) { this.write(root, current); return; }
            const last = run.attempts[run.attempts.length - 1];
            const transient = run.status === 'failed' && !!last.outcome
              && TRANSIENT_EXTRACTION_FAILURES.has(last.failure?.failureKind ?? '');
            current.reason = run.status === 'completed' || transient ? 'waiting' : 'failed';
            if (run.status !== 'completed' && !transient) current.enabled = false;
            const policy = current.policy ?? SINGLE_EXTRACTION_POLICY;
            if (current.callsUsed >= current.maxCalls || policy.policyId === 'knowledge-generation-bounded/v1'
              && (current.tokensReserved ?? 0) >= policy.maxTotalTokens) { current.enabled = false; current.reason = 'quota'; }
            this.write(root, current);
          });
        } catch (error) {
          // Errors never trigger a fresh model attempt; details stay in local run evidence.
          try { withWorkspaceWrite(root, () => {
            const current = this.read(root, threadId);
            if (current && current.owner === this.owner) {
              if (scheduled) this.releaseUnsentWindow(root, current, scheduled);
              if (current.enabled) { current.enabled = false; current.reason = error instanceof ExtractionInputCapacityError ? 'capacity' : 'failed'; }
              this.write(root, current);
            }
          }); } catch { /* A blocked store must not crash the server or authorize another call. */ }
        } finally { if (deadline) clearTimeout(deadline); this.active = undefined; }
      }
    } finally { this.ticking = false; }
  }
  close() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    this.active?.controller.abort();
    for (const { root, threadId } of this.roots.values()) {
      try { withWorkspaceWrite(root, () => {
        const current = this.read(root, threadId);
        if (current?.enabled && current.owner === this.owner) { current.enabled = false; current.reason = 'interrupted'; this.write(root, current); }
      }); } catch { /* Preserve durable reservations on shutdown failures. */ }
    }
    this.roots.clear(); this.stable.clear();
  }
}
