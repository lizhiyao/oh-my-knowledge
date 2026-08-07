import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type {
  ConversationIndexViewModel,
  ConversationListItem,
  ConversationTaskItem,
  ExperienceTurnStatus,
  ObservationSourceRecordArchiveView,
  TaskTrajectorySession,
  TraceIngestionSummary,
} from '../types/index.js';
import { DEFAULT_CACHE_DIR } from '../eval-core/default-dirs.js';
import { durationMsBetween } from '../shared/time.js';
import { writeJsonFileAtomic } from '../shared/atomic-json.js';
import {
  isCurrentCodexRolloutIndex,
  isReusableCodexRolloutIndex,
  normalizeCodexRolloutIndex,
  readCodexTaskRecords,
  synchronizeCurrentCodexRolloutIndex,
  type CodexIndexedTask,
  type CodexRolloutIndex,
} from './codex-conversation-index.js';
import { parseCodexSessionFile } from './codex-trace-adapter.js';
import { projectTraceSessionTimeline } from './experience.js';
import { reconstructExperienceTurns } from './turn-index.js';
import { observationSourceRecordFromLine } from './source-record-archive.js';
import {
  PollingSubscriptionHub,
  type PollingSnapshot,
} from './polling-subscription-hub.js';

const BACKGROUND_INDEX_THRESHOLD_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_RECORD_ARCHIVE_BYTES = 16 * 1024 * 1024;
const DEFAULT_LIVE_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

export interface ConversationTaskTrajectory {
  revision: string;
  status: ExperienceTurnStatus;
  session: TaskTrajectorySession;
  ingestion: TraceIngestionSummary;
  sourceRecords: ObservationSourceRecordArchiveView;
}

export interface ConversationTaskTrajectoryObserver {
  next(trajectory: ConversationTaskTrajectory): void;
  complete?(): void;
  error?(cause: unknown): void;
}

export interface ConversationCatalog {
  listConversations(): Promise<ConversationIndexViewModel>;
  getConversation(threadId: string): Promise<ConversationListItem | undefined>;
  loadTaskTrajectory(threadId: string, turnId: string): Promise<ConversationTaskTrajectory | undefined>;
  /** Optional live capability. Static catalogs do not need to implement it. */
  observeTaskTrajectory?(
    threadId: string,
    turnId: string,
    observer: ConversationTaskTrajectoryObserver,
  ): Promise<() => void>;
}

export interface CodexConversationCatalogOptions {
  codexHome?: string;
  cacheDir?: string;
  /** Tests can keep synthetic fixtures in-process. */
  useBackgroundProcess?: boolean;
  backgroundProcessThresholdBytes?: number;
  livePollIntervalMs?: number;
  /** An unclosed final task is only live while its rollout is still recent. */
  liveActivityWindowMs?: number;
  now?: () => number;
}

interface CodexThreadRow {
  id: string;
  rolloutPath: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  source?: string;
  cwd?: string;
  title?: string;
  preview?: string;
  firstUserMessage?: string;
  archived: boolean;
  tokensUsed?: number;
  model?: string;
  reasoningEffort?: string;
  childThreadCount: number;
}

export function createCodexConversationCatalog(
  options: CodexConversationCatalogOptions = {},
): ConversationCatalog {
  return new CodexConversationCatalog(options);
}

class CodexConversationCatalog implements ConversationCatalog {
  private readonly codexHome: string;
  private readonly cacheDir: string;
  private readonly useBackgroundProcess: boolean;
  private readonly backgroundProcessThresholdBytes: number;
  private readonly liveActivityWindowMs: number;
  private readonly now: () => number;
  private readonly indexPromises = new Map<string, Promise<CodexRolloutIndex>>();
  private readonly trajectoryPromises = new Map<string, Promise<ConversationTaskTrajectory | undefined>>();
  private readonly liveTrajectories: PollingSubscriptionHub<ConversationTaskTrajectory>;

  constructor(options: CodexConversationCatalogOptions) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    this.cacheDir = options.cacheDir ?? join(DEFAULT_CACHE_DIR, 'conversations');
    this.useBackgroundProcess = options.useBackgroundProcess ?? true;
    this.backgroundProcessThresholdBytes = options.backgroundProcessThresholdBytes
      ?? BACKGROUND_INDEX_THRESHOLD_BYTES;
    this.liveActivityWindowMs = options.liveActivityWindowMs ?? DEFAULT_LIVE_ACTIVITY_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.liveTrajectories = new PollingSubscriptionHub(options.livePollIntervalMs);
  }

  async listConversations(): Promise<ConversationIndexViewModel> {
    const rows = this.listThreadRows();
    const conversations = await Promise.all(rows.map((row) => this.conversationForOverview(row)));
    const indexed = conversations.filter((item) => item.turnCount !== undefined);
    return {
      conversations,
      totalTurnCount: indexed.reduce((sum, item) => sum + (item.turnCount ?? 0), 0),
      totalToolCallCount: indexed.reduce((sum, item) => sum + (item.toolCallCount ?? 0), 0),
      totalToolFailureCount: indexed.reduce((sum, item) => sum + (item.toolFailureCount ?? 0), 0),
      indexedConversationCount: indexed.length,
      unarchivedConversationCount: conversations.filter((item) => !item.archived).length,
      archivedConversationCount: conversations.filter((item) => item.archived).length,
      workspaceCount: new Set(conversations.flatMap((item) => item.cwd ? [item.cwd] : [])).size,
    };
  }

  async getConversation(threadId: string): Promise<ConversationListItem | undefined> {
    const row = this.findThreadRow(threadId);
    if (!row || !existsSync(row.rolloutPath)) return undefined;
    const index = await this.currentIndexFor(row);
    return this.conversationFromIndex(row, index);
  }

  async loadTaskTrajectory(
    threadId: string,
    turnId: string,
  ): Promise<ConversationTaskTrajectory | undefined> {
    const key = `${threadId}\u0000${turnId}`;
    const existing = this.trajectoryPromises.get(key);
    if (existing) return existing;
    const pending = this.loadTaskTrajectoryUncached(threadId, turnId);
    this.trajectoryPromises.set(key, pending);
    try {
      return await pending;
    } finally {
      this.trajectoryPromises.delete(key);
    }
  }

  async observeTaskTrajectory(
    threadId: string,
    turnId: string,
    observer: ConversationTaskTrajectoryObserver,
  ): Promise<() => void> {
    const row = this.findThreadRow(threadId);
    if (!row || !existsSync(row.rolloutPath)) {
      throw new Error(`Codex 对话不存在：${threadId}`);
    }
    const key = `${threadId}\u0000${turnId}`;
    return this.liveTrajectories.subscribe(
      key,
      async (previous) => this.loadLiveSnapshot(row, turnId, previous),
      {
        next: ({ value }) => observer.next(value),
        complete: () => observer.complete?.(),
        error: (cause) => observer.error?.(cause),
      },
    );
  }

  private async loadTaskTrajectoryUncached(
    threadId: string,
    turnId: string,
  ): Promise<ConversationTaskTrajectory | undefined> {
    const row = this.findThreadRow(threadId);
    if (!row || !existsSync(row.rolloutPath)) return undefined;
    let index = await this.indexFor(row);
    let indexedTask = index.tasks.find((task) => task.turnId === turnId);
    if ((!indexedTask || indexedTask.status === 'open')
      && !isCurrentCodexRolloutIndex(index, row.rolloutPath)) {
      index = await this.awaitIndex(row);
      indexedTask = index.tasks.find((task) => task.turnId === turnId);
    }
    if (!indexedTask) return undefined;
    return this.trajectoryFromIndex(row, index, indexedTask);
  }

  private trajectoryFromIndex(
    row: CodexThreadRow,
    index: CodexRolloutIndex,
    indexedTask: CodexIndexedTask,
  ): ConversationTaskTrajectory {
    const threadId = row.id;
    const turnId = indexedTask.turnId;
    const selected = readCodexTaskRecords(index, indexedTask);
    const traceSession = parseCodexSessionFile(row.rolloutPath, selected.records);
    const fullSessionTimeline = projectTraceSessionTimeline(traceSession);
    const turns = reconstructExperienceTurns(fullSessionTimeline);
    const taskTurn = turns.find((turn) => turn.sourceTurnId === turnId || turn.turnId === turnId);
    const startTimestamp = taskTurn?.startTimestamp ?? indexedTask.startTimestamp;
    const endTimestamp = taskTurn?.endTimestamp ?? indexedTask.endTimestamp ?? startTimestamp;
    const sourceRecords = sourceRecordView(
      selected.lines,
      traceSession.traceId,
      row.rolloutPath,
    );
    const status = this.taskStatus(index, indexedTask, taskTurn?.status);
    return {
      revision: trajectoryRevision(index, status),
      status,
      session: {
        id: `codex:${threadId}:${turnId}`,
        threadId,
        sourceThreadId: threadId,
        sessionId: traceSession.runId,
        sourceTrace: row.rolloutPath,
        sourceKind: 'codex',
        entrypoint: traceSession.entrypoint,
        sourceMetadata: traceSession.sourceMetadata,
        cwd: traceSession.cwd ?? row.cwd,
        startTimestamp,
        endTimestamp,
        attributedEventIds: [],
        turns,
        fullSessionTimeline,
        indicators: { userCorrectionCount: 0 },
      },
      ingestion: {
        fileCount: 1,
        sourceRecordCount: selected.lines.length,
        parsedRecordCount: selected.lines.length - selected.malformedRecordCount,
        malformedRecordCount: selected.malformedRecordCount,
        ignoredValueCount: 0,
        unknownEventCount: traceSession.events.filter((event) => event.eventKind === 'unknown').length,
        filteredSessionCount: 0,
      },
      sourceRecords,
    };
  }

  private async loadLiveSnapshot(
    row: CodexThreadRow,
    turnId: string,
    previous: PollingSnapshot<ConversationTaskTrajectory> | undefined,
  ): Promise<PollingSnapshot<ConversationTaskTrajectory>> {
    const sourceStat = statSync(row.rolloutPath);
    if (previous
      && previous.revision === trajectoryRevisionFromStat(sourceStat, previous.value.status)) {
      const status = previous.value.status === 'open' && !this.isLiveSource(sourceStat.mtimeMs)
        ? 'unknown'
        : previous.value.status;
      if (status === previous.value.status) return previous;
      const value = {
        ...previous.value,
        revision: trajectoryRevisionFromStat(sourceStat, status),
        status,
      };
      return {
        revision: value.revision,
        terminal: true,
        value,
      };
    }

    const index = await this.currentIndexFor(row);
    const indexedTask = index.tasks.find((task) => task.turnId === turnId);
    if (!indexedTask) throw new Error(`Codex 任务不存在：${turnId}`);
    const value = this.trajectoryFromIndex(row, index, indexedTask);
    return {
      revision: value.revision,
      terminal: value.status !== 'open',
      value,
    };
  }

  private conversationSummary(
    row: CodexThreadRow,
    cached: CodexRolloutIndex | undefined,
  ): ConversationListItem {
    const liveTurnId = cached ? this.liveTurnId(cached) : undefined;
    const tasks = cached ? taskItems(row.id, cached.tasks, liveTurnId) : [];
    return {
      threadId: row.id,
      sourceThreadId: row.id,
      sourceKind: 'codex',
      title: conversationTitle(row),
      preview: row.preview,
      cwd: row.cwd,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      archived: row.archived,
      tokensUsed: row.tokensUsed,
      childThreadCount: row.childThreadCount,
      startTimestamp: timestampFromMs(row.createdAtMs),
      endTimestamp: timestampFromMs(row.updatedAtMs),
      durationMs: durationMsBetween(timestampFromMs(row.createdAtMs), timestampFromMs(row.updatedAtMs)),
      ...(cached ? {
        turnCount: tasks.length,
        toolCallCount: tasks.reduce((sum, task) => sum + task.toolCallCount, 0),
        toolFailureCount: tasks.reduce((sum, task) => sum + task.toolFailureCount, 0),
      } : {}),
      relatedSkillNames: [],
      tasks,
    };
  }

  private taskStatus(
    index: CodexRolloutIndex,
    task: CodexIndexedTask,
    reconstructed: ExperienceTurnStatus | undefined,
  ): ExperienceTurnStatus {
    if (task.status === 'unknown') return 'unknown';
    const observed = reconstructed ?? task.status;
    if (observed !== 'open') return observed;
    return this.liveTurnId(index) === task.turnId ? 'open' : 'unknown';
  }

  private liveTurnId(index: CodexRolloutIndex): string | undefined {
    const lastTask = index.tasks.at(-1);
    if (!lastTask || lastTask.status !== 'open') return undefined;
    return this.isLiveSource(index.sourceMtimeMs) ? lastTask.turnId : undefined;
  }

  private isLiveSource(sourceMtimeMs: number): boolean {
    const ageMs = Math.max(0, this.now() - sourceMtimeMs);
    return ageMs <= this.liveActivityWindowMs;
  }

  private async conversationForOverview(row: CodexThreadRow): Promise<ConversationListItem> {
    const cached = this.readCachedIndex(row);
    if (!cached || isCurrentCodexRolloutIndex(cached, row.rolloutPath)) {
      return this.conversationSummary(row, cached);
    }
    try {
      return this.conversationFromIndex(row, await this.currentIndexFor(row));
    } catch {
      return this.conversationFromIndex(row, cached);
    }
  }

  private conversationFromIndex(row: CodexThreadRow, index: CodexRolloutIndex): ConversationListItem {
    return this.conversationSummary(row, index);
  }

  private async indexFor(row: CodexThreadRow): Promise<CodexRolloutIndex> {
    const cached = this.readCachedIndex(row);
    if (cached) {
      if (!isCurrentCodexRolloutIndex(cached, row.rolloutPath)) this.refreshIndexInBackground(row);
      return cached;
    }
    return this.awaitIndex(row);
  }

  private async currentIndexFor(row: CodexThreadRow): Promise<CodexRolloutIndex> {
    const cached = this.readCachedIndex(row);
    if (cached && isCurrentCodexRolloutIndex(cached, row.rolloutPath)) return cached;
    return this.awaitIndex(row);
  }

  private async awaitIndex(row: CodexThreadRow): Promise<CodexRolloutIndex> {
    const inFlight = this.indexPromises.get(row.id);
    if (inFlight) return inFlight;
    const pending = this.buildIndex(row);
    this.indexPromises.set(row.id, pending);
    try {
      return await pending;
    } finally {
      this.indexPromises.delete(row.id);
    }
  }

  private refreshIndexInBackground(row: CodexThreadRow): void {
    if (this.indexPromises.has(row.id)) return;
    const pending = this.buildIndex(row);
    this.indexPromises.set(row.id, pending);
    void pending.catch(() => undefined).finally(() => {
      if (this.indexPromises.get(row.id) === pending) this.indexPromises.delete(row.id);
    });
  }

  private buildIndex(row: CodexThreadRow): Promise<CodexRolloutIndex> {
    const sourceSize = statSync(row.rolloutPath).size;
    const cachePath = this.cachePath(row.id);
    const cached = this.readCachedIndex(row);
    const pendingBytes = cached ? sourceSize - cached.indexedSize : sourceSize;
    if (!this.useBackgroundProcess || pendingBytes < this.backgroundProcessThresholdBytes) {
      const index = synchronizeCurrentCodexRolloutIndex(row.rolloutPath, row.id, cached);
      writeJsonFileAtomic(cachePath, index);
      return Promise.resolve(index);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderr = '';
      const processPath = fileURLToPath(new URL('./conversation-index-process.js', import.meta.url));
      const child = spawn(process.execPath, [processPath, row.rolloutPath, row.id, cachePath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 16_384) stderr += chunk;
      });
      child.once('error', (cause) => {
        if (settled) return;
        settled = true;
        reject(cause);
      });
      child.once('exit', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Codex 对话索引进程异常退出：${code ?? 'unknown'}`));
          return;
        }
        const cachedIndex = this.readCachedIndex(row);
        if (!cachedIndex) {
          reject(new Error('Codex 对话索引进程未生成有效缓存'));
          return;
        }
        try {
          const index = synchronizeCurrentCodexRolloutIndex(row.rolloutPath, row.id, cachedIndex);
          writeJsonFileAtomic(cachePath, index);
          resolve(index);
        } catch (cause) {
          reject(cause);
        }
      });
    });
  }

  private readCachedIndex(row: CodexThreadRow): CodexRolloutIndex | undefined {
    const path = this.cachePath(row.id);
    if (!existsSync(path) || !existsSync(row.rolloutPath)) return undefined;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return isReusableCodexRolloutIndex(value, row.rolloutPath)
        ? normalizeCodexRolloutIndex(value)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private cachePath(threadId: string): string {
    const digest = createHash('sha256').update(threadId).digest('hex').slice(0, 24);
    return join(this.cacheDir, `${digest}.json`);
  }

  private listThreadRows(): CodexThreadRow[] {
    return this.readRowsFromStateDatabase() ?? this.readRowsFromSessionIndex();
  }

  private findThreadRow(threadId: string): CodexThreadRow | undefined {
    return this.readRowsFromStateDatabase(threadId)?.[0]
      ?? this.readRowsFromSessionIndex().find((row) => row.id === threadId);
  }

  private readRowsFromStateDatabase(threadId?: string): CodexThreadRow[] | undefined {
    const path = join(this.codexHome, 'state_5.sqlite');
    if (!existsSync(path)) return undefined;
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path, { readOnly: true });
      const childCounts = childThreadCounts(database);
      const where = `where (thread_source = 'user' or (thread_source is null and source not like '{"subagent"%'))${threadId ? ' and id = ?' : ''}`;
      const statement = database.prepare(`
        select id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
               source, cwd, title, preview, first_user_message, archived,
               tokens_used, model, reasoning_effort
        from threads
        ${where}
        order by recency_at desc, updated_at desc
      `);
      const values = threadId ? statement.all(threadId) : statement.all();
      return values.map((value) => threadRow(value, childCounts));
    } catch {
      return undefined;
    } finally {
      database?.close();
    }
  }

  private readRowsFromSessionIndex(): CodexThreadRow[] {
    const path = join(this.codexHome, 'session_index.jsonl');
    if (!existsSync(path)) return [];
    const rolloutPaths = new Map<string, string>();
    return readFileSync(path, 'utf8').split(/\r?\n/u).flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        const id = textValue(value.id);
        if (!id) return [];
        let rolloutPath = rolloutPaths.get(id);
        if (!rolloutPath) {
          rolloutPath = findRolloutPath(join(this.codexHome, 'sessions'), id) ?? '';
          rolloutPaths.set(id, rolloutPath);
        }
        return [{
          id,
          rolloutPath,
          title: textValue(value.thread_name),
          preview: textValue(value.thread_name),
          updatedAtMs: numberValue(value.updated_at),
          archived: false,
          childThreadCount: 0,
        }];
      } catch {
        return [];
      }
    }).sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0));
  }
}

function threadRow(value: Record<string, unknown>, childCounts: Map<string, number>): CodexThreadRow {
  const id = textValue(value.id) ?? '';
  return {
    id,
    rolloutPath: textValue(value.rollout_path) ?? '',
    createdAtMs: numberValue(value.created_at_ms) ?? secondsToMs(value.created_at),
    updatedAtMs: numberValue(value.updated_at_ms) ?? secondsToMs(value.updated_at),
    source: textValue(value.source),
    cwd: textValue(value.cwd),
    title: textValue(value.title),
    preview: textValue(value.preview),
    firstUserMessage: textValue(value.first_user_message),
    archived: numberValue(value.archived) === 1,
    tokensUsed: numberValue(value.tokens_used),
    model: textValue(value.model),
    reasoningEffort: textValue(value.reasoning_effort),
    childThreadCount: childCounts.get(id) ?? 0,
  };
}

function childThreadCounts(database: DatabaseSync): Map<string, number> {
  const counts = new Map<string, number>();
  try {
    const rows = database.prepare(`
      select parent_thread_id, count(*) as child_count
      from thread_spawn_edges
      group by parent_thread_id
    `).all();
    for (const row of rows) {
      const parent = textValue(row.parent_thread_id);
      if (parent) counts.set(parent, numberValue(row.child_count) ?? 0);
    }
  } catch {
    // Older Codex state databases may not expose spawn edges.
  }
  return counts;
}

function taskItems(
  threadId: string,
  tasks: CodexIndexedTask[],
  liveTurnId: string | undefined,
): ConversationTaskItem[] {
  return tasks.map((task) => ({
    turnId: task.turnId,
    sourceTurnId: task.turnId,
    trajectoryHref: `/conversations/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(task.turnId)}`,
    title: task.title,
    startTimestamp: task.startTimestamp,
    endTimestamp: task.endTimestamp,
    durationMs: durationMsBetween(task.startTimestamp, task.endTimestamp),
    status: task.status === 'open' && task.turnId !== liveTurnId ? 'unknown' : task.status,
    eventCount: task.sourceRecordCount,
    toolCallCount: task.toolCallCount,
    toolFailureCount: task.toolFailureCount,
    relatedSkillNames: [],
  }));
}

function sourceRecordView(
  lines: Array<{ text: string; line: number }>,
  traceId: string,
  sourceTrace: string,
): ObservationSourceRecordArchiveView {
  let byteCount = 0;
  let omittedRecordCount = 0;
  const records = lines.flatMap((line) => {
    const record = observationSourceRecordFromLine(line.text, line.line, traceId, sourceTrace);
    if (byteCount + record.byteCount > MAX_SOURCE_RECORD_ARCHIVE_BYTES) {
      omittedRecordCount += 1;
      return [];
    }
    byteCount += record.byteCount;
    return [record];
  });
  const truncated = omittedRecordCount > 0 || records.some((record) => record.truncated);
  return {
    status: truncated ? 'partial' : 'available',
    recordCount: records.length,
    records,
    omittedRecordCount,
    byteCount,
    truncated,
    ...(truncated ? { reason: 'archive_limit' as const } : {}),
  };
}

function conversationTitle(row: CodexThreadRow): string {
  return row.title?.trim()
    || row.preview?.trim()
    || row.firstUserMessage?.trim()
    || '未命名对话';
}

function timestampFromMs(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

function rolloutRevision(index: CodexRolloutIndex): string {
  return `${index.sourceSize}:${index.sourceMtimeMs}`;
}

function trajectoryRevision(
  index: CodexRolloutIndex,
  status: ExperienceTurnStatus,
): string {
  return `${rolloutRevision(index)}:${status}`;
}

function trajectoryRevisionFromStat(
  sourceStat: { size: number; mtimeMs: number },
  status: ExperienceTurnStatus,
): string {
  return `${sourceStat.size}:${sourceStat.mtimeMs}:${status}`;
}

function secondsToMs(value: unknown): number | undefined {
  const seconds = numberValue(value);
  return seconds === undefined ? undefined : seconds * 1000;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function findRolloutPath(root: string, threadId: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findRolloutPath(path, threadId);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith('.jsonl')) {
      return path;
    }
  }
  return undefined;
}

export function conversationSourceLabel(path: string): string {
  return basename(path).replace(/\.jsonl$/u, '');
}
