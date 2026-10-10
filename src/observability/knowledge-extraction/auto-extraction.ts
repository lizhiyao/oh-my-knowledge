import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createJsonFileAtomic, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import type { ConversationCatalog } from '../conversation/catalog.js';
import type { EvidenceWindow } from './evidence.js';
import type { ExtractionModel } from './application.js';
import { createLocalKnowledgeApplication } from './local.js';
import { configuredExtractionModel } from './adapters/executor.js';
import { checkStorageDirectory, withWorkspaceWrite } from './adapters/storage-state.js';
import { conversationExtractionSource } from './conversation-source.js';

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
});
export type AutoExtractionState = z.infer<typeof schema>;
export interface AutoExtractionPreview {
  token: string; title: string; turnCount: number; messages: EvidenceWindow['excerpts']; limitations: string[];
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

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
    now?: () => number; stableMs?: number; intervalMs?: number; model?: (executor: string, model: string) => ExtractionModel;
  } = {}) {
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
    writeJsonFileAtomic(path, schema.parse(state));
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
  async enable(root: string, threadId: string, consent: { token: string; executor: string; model: string; maxCalls: number }, signal?: AbortSignal) {
    if (this.closed) throw new Error('Automation stopped.');
    const plan = await this.plan(threadId, signal);
    if (plan.preview.token !== consent.token) throw new Error('Source conflict. Preview again.');
    // Validate executor/model before saving permission, without invoking it.
    configuredExtractionModel(consent.executor, consent.model);
    signal?.throwIfAborted();
    const { workspace, key } = this.location(root, threadId);
    if (this.roots.size >= 32 && !this.roots.has(key)) throw new Error('Automation capacity exceeded.');
    this.status(root, threadId);
    const state = withWorkspaceWrite(workspace, () => {
      const previous = this.read(workspace, threadId);
      if (previous?.enabled || this.active?.key === key || (previous?.owner !== this.owner && previous?.reason === 'generating' && this.ownerAlive(previous))) throw new Error('Automation conflict. Stop the active run first.');
      const directory = join(workspace, 'auto-extraction');
      if (existsSync(directory) && readdirSync(directory).length >= 2998) throw new Error('Automation capacity exceeded.');
      const next = schema.parse({ schemaVersion: 1, automationKind: 'conversation-knowledge-extraction', threadId,
        owner: this.owner, pid: process.pid, hostname: hostname(), permissionId: randomUUID(), executor: consent.executor, model: consent.model,
        maxCalls: consent.maxCalls, callsUsed: 0, enabledAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(this.now() + 24 * 60 * 60 * 1000).toISOString(), enabled: true, reason: 'waiting',
        checkedTurns: plan.turns.filter(id => !plan.selected.includes(id)), initialTurns: plan.selected,
        attemptedVersions: previous?.attemptedVersions ?? [], ...(previous?.lastRunId ? { lastRunId: previous.lastRunId } : {}) });
      createJsonFileAtomic(join(directory, `permission-${next.permissionId}.json`), {
        schemaVersion: 1, automationKind: 'conversation-knowledge-permission', permissionId: next.permissionId,
        threadId, executor: next.executor, model: next.model, maxCalls: next.maxCalls,
        enabledAt: next.enabledAt, expiresAt: next.expiresAt, token: consent.token, initialTurns: plan.selected,
        futureWindow: { newTurns: 3, precedingTurns: 2, stableMs: 30_000 },
      });
      this.write(workspace, next); return next;
    });
    this.roots.set(key, { root: workspace, threadId });
    this.stable.delete(key); return state;
  }
  stop(root: string, threadId: string) {
    const { workspace, key } = this.location(root, threadId);
    const state = withWorkspaceWrite(workspace, () => {
      const current = this.read(workspace, threadId);
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
        try {
          const state = this.status(root, threadId);
          if (!state?.enabled || state.owner !== this.owner) continue;
          const { turns } = await this.completed(threadId);
          const pending = state.initialTurns.length ? state.initialTurns : turns.filter(id => !state.checkedTurns.includes(id)).slice(0, 3);
          if (!pending.length) continue;
          const first = turns.indexOf(pending[0]);
          const selected = state.initialTurns.length ? pending : [...turns.slice(Math.max(0, first - 2), first), ...pending];
          const { window } = await conversationExtractionSource(this.catalog, threadId, undefined, controller.signal, selected);
          const stable = this.stable.get(key);
          if (!stable || stable.version !== window.sourceVersion) { this.stable.set(key, { version: window.sourceVersion, since: this.now() }); continue; }
          if (this.now() - stable.since < (this.options.stableMs ?? 30_000)) continue;
          const reserved = withWorkspaceWrite(root, () => {
            const current = this.read(root, threadId);
            if (!current?.enabled || current.owner !== this.owner || this.now() >= Date.parse(current.expiresAt)) return null;
            const duplicate = current.attemptedVersions.includes(window.sourceVersion);
            current.checkedTurns = [...new Set([...current.checkedTurns, ...pending])]; current.initialTurns = [];
            if (!duplicate) {
              if (readdirSync(join(root, 'auto-extraction')).length >= 3000) { current.enabled = false; current.reason = 'capacity'; this.write(root, current); return null; }
              if (current.callsUsed >= current.maxCalls) { current.enabled = false; current.reason = 'quota'; this.write(root, current); return null; }
              if (current.attemptedVersions.length >= 1000) { current.enabled = false; current.reason = 'capacity'; this.write(root, current); return null; }
              current.callsUsed++; current.attemptedVersions.push(window.sourceVersion); current.lastRunId = randomUUID(); current.reason = 'generating';
            }
            this.write(root, current);
            if (!duplicate) createJsonFileAtomic(join(root, 'auto-extraction', `attempt-${current.lastRunId}.json`), {
              schemaVersion: 1, automationKind: 'conversation-knowledge-attempt', runId: current.lastRunId,
              permissionId: current.permissionId, threadId, turnIds: selected, sourceVersion: window.sourceVersion,
              reservedAt: new Date(this.now()).toISOString(), callNumber: current.callsUsed,
            });
            return duplicate ? null : current;
          });
          this.stable.delete(key);
          if (!reserved) continue;
          deadline = setTimeout(() => controller.abort(), Math.max(0, Date.parse(reserved.expiresAt) - this.now())); deadline.unref();
          const app = createLocalKnowledgeApplication(root);
          const snapshot = app.capture({ path: window.sourcePath, records: window.records, origin: window.origin }, controller.signal);
          const model = (this.options.model ?? configuredExtractionModel)(reserved.executor, reserved.model);
          const run = await app.generate(snapshot.snapshotId, model, reserved.lastRunId!, controller.signal);
          withWorkspaceWrite(root, () => {
            const current = this.read(root, threadId);
            if (!current || current.lastRunId !== reserved.lastRunId || !current.enabled) return;
            current.reason = run.status === 'completed' ? 'waiting' : 'failed';
            if (run.status !== 'completed') current.enabled = false;
            else if (current.callsUsed >= current.maxCalls) { current.enabled = false; current.reason = 'quota'; }
            this.write(root, current);
          });
        } catch {
          // Errors never trigger a fresh model attempt; details stay in local run evidence.
          try { withWorkspaceWrite(root, () => {
            const current = this.read(root, threadId);
            if (current?.enabled && current.owner === this.owner) { current.enabled = false; current.reason = 'failed'; this.write(root, current); }
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
