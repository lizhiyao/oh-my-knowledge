import type { ExperienceTimelineEvent, ExperienceTurnSummary } from '../observe/contracts/experience.js';
import type { ObservationSourceRecord, ObservationSourceRecordArchiveView } from '../observe/contracts/inbox.js';
import type { TraceIngestionSummary } from '../observe/contracts/trace.js';
import type {
  ConversationIndexViewModel,
  ConversationListItem,
  ConversationTaskItem,
} from '../observe/view-models/conversation.js';
import { durationMsBetween } from '../shared/time.js';
import {
  projectTraceSessionTimeline,
} from '../observe/experience.js';
import { reconstructExperienceTurns } from '../observe/conversation/turn-index.js';
import { observationSourceRecordFromLine } from '../observe/inbox/source-record-archive.js';
import type {
  ConversationCatalog,
  ConversationTaskTrajectory,
} from '../observe/conversation/catalog.js';
import {
  adaptDshSession,
  type DshSessionEventLike,
  type DshSessionHeaderLike,
  type DshTraceAdapterResult,
} from './trace-adapter.js';

const MAX_STABLE_READ_ATTEMPTS = 3;
const DEFAULT_LIST_LIMIT = 8;
const LIST_INSPECTION_LIMIT = 24;
const MAX_SOURCE_RECORD_BYTES = 16 * 1024 * 1024;

export interface DshPersistenceSnapshotLike {
  readonly header: DshSessionHeaderLike;
  readonly revision: string;
}

export interface DshSessionInspectionLike {
  readonly meta: DshSessionHeaderLike;
  readonly events: readonly DshSessionEventLike[];
}

interface DshSessionReadHandle {
  readonly header: DshSessionHeaderLike;
  readonly inheritedEventCount: number;
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{
    readonly events: readonly DshSessionEventLike[];
  }>;
  close(): Promise<void>;
}

export interface DshSessionPersistenceLike {
  list(options?: { signal?: AbortSignal }): Promise<readonly DshPersistenceSnapshotLike[]>;
  open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<DshSessionReadHandle>;
}

export interface DshObserveCandidate {
  sessionId: string;
  createdAt: string;
  cwd?: string;
  status: 'completed' | 'failed' | 'aborted' | 'interrupted';
}

export interface DshObservedGroup {
  rootSessionId: string;
  selectedSessionId: string;
  revision: string;
  traces: DshTraceAdapterResult[];
  inspections: DshSessionInspectionLike[];
}

/** Count every valid DSH logical record as parsed, including chunks consolidated into messages. */
export function dshTraceIngestionSummary(group: DshObservedGroup): TraceIngestionSummary {
  const sourceRecordCount = group.inspections.reduce((sum, item) => sum + item.events.length + 1, 0);
  return {
    fileCount: group.traces.length,
    sourceRecordCount,
    parsedRecordCount: sourceRecordCount,
    malformedRecordCount: 0,
    ignoredValueCount: 0,
    unknownEventCount: group.traces.reduce(
      (sum, item) => sum + item.integrity.unknownEventCount,
      0,
    ),
    filteredSessionCount: 0,
  };
}

function snapshotMap(
  snapshots: readonly DshPersistenceSnapshotLike[],
): Map<string, DshPersistenceSnapshotLike> {
  return new Map(snapshots.map((snapshot) => [String(snapshot.header.id), snapshot]));
}

function rootSessionId(
  sessionId: string,
  snapshots: Map<string, DshPersistenceSnapshotLike>,
): string {
  const seen = new Set<string>();
  let current = sessionId;
  while (true) {
    if (seen.has(current)) throw new Error(`DSH session lineage 存在循环：${sessionId}。`);
    seen.add(current);
    const currentHeader = snapshots.get(current)?.header;
    if (currentHeader?.origin !== 'subagent') return current;
    const parent = currentHeader.parentSession;
    if (!parent) return current;
    if (!snapshots.has(String(parent))) {
      throw new Error(`DSH session lineage 缺少 parent session：${String(parent)}。`);
    }
    current = String(parent);
  }
}

function groupSessionIds(
  rootId: string,
  snapshots: Map<string, DshPersistenceSnapshotLike>,
): string[] {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, snapshot] of snapshots) {
      const parent = snapshot.header.parentSession ? String(snapshot.header.parentSession) : undefined;
      if (snapshot.header.origin !== 'subagent' || !parent || !ids.has(parent) || ids.has(id)) continue;
      ids.add(id);
      changed = true;
    }
  }
  return Array.from(ids).sort((left, right) => {
    if (left === rootId) return -1;
    if (right === rootId) return 1;
    const depthDiff = (snapshots.get(left)?.header.delegationDepth ?? 0)
      - (snapshots.get(right)?.header.delegationDepth ?? 0);
    return depthDiff || left.localeCompare(right);
  });
}

function stableGroup(
  before: Map<string, DshPersistenceSnapshotLike>,
  after: Map<string, DshPersistenceSnapshotLike>,
  rootId: string,
): boolean {
  const beforeIds = groupSessionIds(rootId, before);
  const afterIds = groupSessionIds(rootId, after);
  if (beforeIds.length !== afterIds.length
    || beforeIds.some((id, index) => id !== afterIds[index])) return false;
  return beforeIds.every((id) => {
    const left = before.get(id);
    const right = after.get(id);
    return left !== undefined && right !== undefined && left.revision === right.revision;
  });
}

function revisionLabel(
  snapshots: Map<string, DshPersistenceSnapshotLike>,
  ids: readonly string[],
): string {
  return ids.map((id) => `${id}:${String(snapshots.get(id)?.revision ?? 'missing')}`).join('|');
}

async function inspectSession(
  persistence: DshSessionPersistenceLike, id: string, signal?: AbortSignal,
): Promise<DshSessionInspectionLike> {
  const handle = await persistence.open(id, 'read', { signal });
  try {
    const { events } = await handle.read(undefined, undefined, { signal });
    return { meta: { ...handle.header, seedLength: handle.inheritedEventCount }, events };
  } finally {
    await handle.close();
  }
}

type SessionReadOptions = {
  signal?: AbortSignal;
  includesCwd?: (cwd: string | undefined) => boolean;
};

/** Read one root+descendant group through the logical persistence seam without mutating it. */
export async function readDshObservedGroup(
  persistence: DshSessionPersistenceLike,
  selectedSessionId: string,
  { signal, includesCwd }: SessionReadOptions = {},
): Promise<DshObservedGroup> {
  for (let attempt = 1; attempt <= MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const before = snapshotMap(await persistence.list({ signal }));
    if (!before.has(selectedSessionId)) throw new Error(`DSH session 不存在：${selectedSessionId}。`);
    const rootId = rootSessionId(selectedSessionId, before);
    const ids = groupSessionIds(rootId, before);
    if (includesCwd && ids.some(id => !includesCwd(before.get(id)?.header.cwd))) {
      throw new Error('DSH 会话及其子会话必须属于当前项目。');
    }
    // Join all read handles before returning, including when a sibling read fails.
    const reads = await Promise.allSettled(ids.map((id) => inspectSession(persistence, id, signal)));
    signal?.throwIfAborted();
    const after = snapshotMap(await persistence.list({ signal }));
    if (!stableGroup(before, after, rootId)) continue;
    const inspections = reads.map((read, index) => {
      if (read.status === 'rejected') throw read.reason;
      if (read.value.meta.id !== ids[index] || includesCwd && !includesCwd(read.value.meta.cwd)) {
        throw new Error('DSH 会话读取结果与选定会话或项目不一致。');
      }
      return read.value;
    });
    const traces = inspections.map((inspection) => adaptDshSession(inspection.meta, inspection.events, {
      rootRunId: rootId,
      role: String(inspection.meta.id) === rootId ? 'main' : 'subagent',
      groupPath: `dsh:${rootId}`,
    }));
    return {
      rootSessionId: rootId,
      selectedSessionId,
      revision: revisionLabel(after, ids),
      traces,
      inspections,
    };
  }
  throw new Error(`DSH session 在读取期间持续变化，${MAX_STABLE_READ_ATTEMPTS} 次一致快照均失败：${selectedSessionId}。`);
}

async function inspectCandidate(
  persistence: DshSessionPersistenceLike,
  snapshot: DshPersistenceSnapshotLike,
  options: SessionReadOptions,
): Promise<DshObserveCandidate | undefined> {
  const sessionId = String(snapshot.header.id);
  try {
    const group = await readDshObservedGroup(persistence, sessionId, options);
    const trace = group.traces.find((item) => item.session.runId === sessionId);
    if (!trace) return undefined;
    if (group.traces.some((item) => !item.integrity.complete)) return undefined;
    const status = trace.integrity.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'aborted' && status !== 'interrupted') {
      return undefined;
    }
    return {
      sessionId,
      createdAt: new Date(snapshot.header.createdAt).toISOString(),
      cwd: snapshot.header.cwd,
      status,
    };
  } catch {
    options.signal?.throwIfAborted();
    return undefined;
  }
}

/** List recent terminal root sessions; the command's own live session stays out of the default result. */
export async function listDshObserveCandidates(
  persistence: DshSessionPersistenceLike,
  options: SessionReadOptions & { excludeSessionId?: string; limit?: number } = {},
): Promise<DshObserveCandidate[]> {
  const limit = Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT);
  const snapshots = [...await persistence.list({ signal: options.signal })]
    .filter((snapshot) => snapshot.header.origin !== 'subagent'
      && (!options.includesCwd || options.includesCwd(snapshot.header.cwd))
      && String(snapshot.header.id) !== options.excludeSessionId)
    .sort((left, right) => right.header.createdAt - left.header.createdAt)
    .slice(0, Math.max(limit, LIST_INSPECTION_LIMIT));
  const candidates: DshObserveCandidate[] = [];
  for (const snapshot of snapshots) {
    options.signal?.throwIfAborted();
    const candidate = await inspectCandidate(persistence, snapshot, options);
    if (candidate) candidates.push(candidate);
    if (candidates.length >= limit) break;
  }
  return candidates;
}

function mergedTimeline(group: DshObservedGroup): ExperienceTimelineEvent[] {
  const ranked = group.traces.flatMap((trace, traceRank) => (
    projectTraceSessionTimeline(trace.session).map((event) => ({ event, traceRank }))
  ));
  ranked.sort((left, right) => {
    if (left.event.timestamp && right.event.timestamp && left.event.timestamp !== right.event.timestamp) {
      return left.event.timestamp.localeCompare(right.event.timestamp);
    }
    return left.traceRank - right.traceRank || left.event.order - right.event.order;
  });
  return ranked.map(({ event }, index) => ({ ...event, order: index * 10 }));
}

function attachDescendantsToRootTurns(
  turns: ExperienceTurnSummary[],
  timeline: ExperienceTimelineEvent[],
  rootTraceId: string,
): ExperienceTurnSummary[] {
  const rootTurns = turns.filter((turn) => turn.traceId === rootTraceId);
  const childEvents = timeline.filter((event) => event.traceId !== rootTraceId);
  if (rootTurns.length === 0 || childEvents.length === 0) return turns;
  const eventById = new Map(timeline.map((event) => [event.id, event]));
  return turns.map((turn) => {
    if (turn.traceId !== rootTraceId) return turn;
    const related = childEvents.filter((event) => {
      if (rootTurns.length === 1) return true;
      if (!event.timestamp || !turn.startTimestamp) return false;
      return event.timestamp >= turn.startTimestamp
        && (!turn.endTimestamp || event.timestamp <= turn.endTimestamp);
    });
    if (related.length === 0) return turn;
    const eventIds = Array.from(new Set([...turn.eventIds, ...related.map((event) => event.id)]))
      .sort((left, right) => (eventById.get(left)?.order ?? 0) - (eventById.get(right)?.order ?? 0));
    return {
      ...turn,
      eventIds,
      toolCallCount: eventIds.filter((id) => eventById.get(id)?.kind === 'tool_use').length,
      toolFailureCount: eventIds.filter((id) => {
        const event = eventById.get(id);
        return event?.kind === 'tool_result' && (event.toolStatus === 'failure' || event.isError);
      }).length,
    };
  });
}

function sourceRecords(group: DshObservedGroup): ObservationSourceRecordArchiveView {
  let byteCount = 0;
  let omittedRecordCount = 0;
  const records: ObservationSourceRecord[] = [];
  group.traces.forEach((trace, traceIndex) => {
    const inspection = group.inspections[traceIndex];
    if (!inspection) return;
    const values: unknown[] = [{ type: 'session/header', ...inspection.meta }, ...inspection.events];
    values.forEach((value, sourceIndex) => {
      const raw = JSON.stringify(value);
      const event = sourceIndex === 0 ? undefined : inspection.events[sourceIndex - 1];
      const base = observationSourceRecordFromLine(
        raw,
        sourceIndex,
        trace.session.traceId,
        trace.session.sourcePath,
      );
      if (byteCount + base.byteCount > MAX_SOURCE_RECORD_BYTES) {
        omittedRecordCount += 1;
        return;
      }
      records.push({
        ...base,
        sourceType: sourceIndex === 0 ? 'session/header' : event?.type ?? 'unknown',
        sourceEventId: event ? `${String(inspection.meta.id)}:${event.seq}` : String(inspection.meta.id),
        timestamp: sourceIndex === 0
          ? new Date(inspection.meta.createdAt).toISOString()
          : event ? new Date(event.time).toISOString() : undefined,
      });
      byteCount += base.byteCount;
    });
  });
  return {
    status: omittedRecordCount > 0 ? 'partial' : 'available',
    recordCount: records.length,
    records,
    omittedRecordCount,
    byteCount,
    truncated: omittedRecordCount > 0,
    ...(omittedRecordCount > 0 ? { reason: 'archive_limit' as const } : {}),
  };
}

interface CatalogEntry {
  group: DshObservedGroup;
  conversation: ConversationListItem;
  turns: ExperienceTurnSummary[];
  timeline: ExperienceTimelineEvent[];
  records: ObservationSourceRecordArchiveView;
}

function taskItem(threadId: string, turn: ExperienceTurnSummary): ConversationTaskItem {
  return {
    turnId: turn.turnId,
    sourceTurnId: turn.sourceTurnId,
    trajectoryHref: `/observe/conversations/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(turn.turnId)}`,
    title: turn.title,
    startTimestamp: turn.startTimestamp,
    endTimestamp: turn.endTimestamp,
    durationMs: durationMsBetween(turn.startTimestamp, turn.endTimestamp),
    status: turn.status,
    eventCount: turn.eventIds.length,
    toolCallCount: turn.toolCallCount,
    toolFailureCount: turn.toolFailureCount,
    relatedSkillNames: [],
  };
}

function catalogEntry(group: DshObservedGroup): CatalogEntry {
  const rootTrace = group.traces.find(trace => trace.session.runId === group.rootSessionId);
  const selected = group.traces.find(trace => trace.session.runId === group.selectedSessionId);
  if (!rootTrace || !selected) throw new Error(`DSH session group 缺少会话：${group.selectedSessionId}。`);
  const timeline = mergedTimeline(group);
  const turns = attachDescendantsToRootTurns(
    reconstructExperienceTurns(timeline),
    timeline,
    rootTrace.session.traceId,
  );
  const { runId, traceId, cwd, startTimestamp, endTimestamp, sourceMetadata } = selected.session;
  const firstUser = timeline.find(event => event.traceId === traceId && event.kind === 'user_message');
  const title = firstUser?.fullText?.trim() || firstUser?.snippet?.trim() || `DSH session ${runId}`;
  // Each conversation owns one logical record index. Descendants still contribute trajectory evidence.
  const tasks = turns.filter(turn => turn.traceId === traceId).map(turn => taskItem(runId, turn));
  return {
    group,
    turns,
    timeline,
    records: sourceRecords(group),
    conversation: {
      threadId: runId,
      sourceThreadId: runId,
      sourceKind: 'dsh',
      title: title.replace(/\s+/g, ' ').slice(0, 160),
      preview: title.replace(/\s+/g, ' ').slice(0, 240),
      cwd,
      model: sourceMetadata?.model,
      childThreadCount: runId === group.rootSessionId ? group.traces.length - 1 : undefined,
      startTimestamp,
      endTimestamp,
      durationMs: durationMsBetween(startTimestamp, endTimestamp),
      turnCount: tasks.length,
      toolCallCount: tasks.reduce((sum, task) => sum + task.toolCallCount, 0),
      toolFailureCount: tasks.reduce((sum, task) => sum + task.toolFailureCount, 0),
      relatedSkillNames: [],
      tasks,
    },
  };
}

export interface DshCatalogTarget {
  threadId: string;
  turnId: string;
}

export interface MutableDshConversationCatalog extends ConversationCatalog {
  upsert(group: DshObservedGroup): DshCatalogTarget;
}

/** Static snapshot catalog used by Studio; importing another session updates it without adding a parallel UI. */
export function createDshConversationCatalog(): MutableDshConversationCatalog {
  const entries = new Map<string, CatalogEntry>();
  return {
    upsert(group) {
      const entry = catalogEntry(group);
      const selectedTurn = entry.conversation.tasks.at(-1);
      if (!selectedTurn) throw new Error(`DSH session 没有可展示的任务：${group.selectedSessionId}。`);
      entries.set(group.selectedSessionId, entry);
      return { threadId: group.selectedSessionId, turnId: selectedTurn.turnId };
    },
    async listConversations(): Promise<ConversationIndexViewModel> {
      const conversations = Array.from(entries.values())
        .map((entry) => entry.conversation)
        .sort((left, right) => (right.endTimestamp ?? '').localeCompare(left.endTimestamp ?? ''));
      return {
        conversations,
        totalTurnCount: conversations.reduce((sum, item) => sum + (item.turnCount ?? 0), 0),
        totalToolCallCount: conversations.reduce((sum, item) => sum + (item.toolCallCount ?? 0), 0),
        totalToolFailureCount: conversations.reduce((sum, item) => sum + (item.toolFailureCount ?? 0), 0),
        indexedConversationCount: conversations.length,
        unarchivedConversationCount: conversations.length,
        archivedConversationCount: 0,
        workspaceCount: new Set(conversations.flatMap((item) => item.cwd ? [item.cwd] : [])).size,
      };
    },
    async getConversation(threadId) {
      return entries.get(threadId)?.conversation;
    },
    async loadTaskMessageRecords(threadId, turnId) {
      const entry = entries.get(threadId);
      if (!entry?.conversation.tasks.some(task => task.turnId === turnId)) return undefined;
      const turn = entry.turns.find(candidate => candidate.turnId === turnId);
      if (!turn) return undefined;
      const traceIndex = entry.group.traces.findIndex(trace => trace.session.traceId === turn.traceId);
      const trace = entry.group.traces[traceIndex];
      const inspection = entry.group.inspections[traceIndex];
      if (!trace || !inspection) return undefined;
      const ids = new Set(turn.eventIds);
      const indexes = new Set(entry.timeline.flatMap(event => ids.has(event.id) && event.traceId === turn.traceId
        && (event.kind === 'user_message' && event.sourceType === 'user/message'
          || event.kind === 'assistant_message' && event.sourceType === 'assistant/message')
        && event.sourceLineIndex !== undefined ? [event.sourceLineIndex] : []));
      return {
        path: trace.session.sourcePath,
        records: [...indexes].sort((left, right) => left - right)
          .map(recordIndex => ({ recordIndex, raw: JSON.stringify(inspection.events[recordIndex - 1]) })),
      };
    },
    async loadTaskTrajectory(threadId, turnId): Promise<ConversationTaskTrajectory | undefined> {
      const entry = entries.get(threadId);
      if (!entry?.conversation.tasks.some(task => task.turnId === turnId)) return undefined;
      const turn = entry.turns.find((candidate) => candidate.turnId === turnId);
      const selected = entry.group.traces.find(trace => trace.session.runId === threadId);
      if (!turn || !selected) return undefined;
      return {
        revision: entry.group.revision,
        status: turn.status,
        liveObservable: false,
        session: {
          id: `dsh:${threadId}`,
          threadId,
          sourceThreadId: threadId,
          sessionId: threadId,
          sourceTrace: selected.session.sourcePath,
          sourceKind: 'dsh',
          entrypoint: 'dsh',
          sourceMetadata: selected.session.sourceMetadata,
          cwd: selected.session.cwd,
          startTimestamp: selected.session.startTimestamp,
          endTimestamp: selected.session.endTimestamp,
          attributedEventIds: [],
          turns: entry.turns,
          fullSessionTimeline: entry.timeline,
          indicators: { userCorrectionCount: 0 },
        },
        ingestion: dshTraceIngestionSummary(entry.group),
        sourceRecords: entry.records,
      };
    },
  };
}
