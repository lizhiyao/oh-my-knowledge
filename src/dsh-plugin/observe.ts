import type { ExperienceTimelineEvent, ExperienceTurnSummary } from '../observability/contracts/experience.js';
import type { ObservationSourceRecord, ObservationSourceRecordArchiveView } from '../observability/contracts/inbox.js';
import type { TraceIngestionSummary } from '../observability/contracts/trace.js';
import type {
  ConversationIndexViewModel,
  ConversationListItem,
  ConversationTaskItem,
} from '../observability/view-models/conversation.js';
import { durationMsBetween } from '../shared/time.js';
import {
  projectTraceSessionTimeline,
} from '../observability/experience.js';
import { reconstructExperienceTurns } from '../observability/turn-index.js';
import { observationSourceRecordFromLine } from '../observability/source-record-archive.js';
import type {
  ConversationCatalog,
  ConversationTaskTrajectory,
} from '../observability/conversation-catalog.js';
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
  readonly revision: unknown;
}

export interface DshSessionInspectionLike {
  readonly meta: DshSessionHeaderLike;
  readonly events: readonly DshSessionEventLike[];
}

export interface DshSessionPersistenceLike {
  listSnapshots(signal?: AbortSignal): Promise<readonly DshPersistenceSnapshotLike[]>;
  inspect(id: string, signal?: AbortSignal): Promise<DshSessionInspectionLike>;
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

function sameRevision(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
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
    return left !== undefined && right !== undefined && sameRevision(left.revision, right.revision);
  });
}

function revisionLabel(
  snapshots: Map<string, DshPersistenceSnapshotLike>,
  ids: readonly string[],
): string {
  return ids.map((id) => `${id}:${String(snapshots.get(id)?.revision ?? 'missing')}`).join('|');
}

/** Read one root+descendant group through the logical persistence seam without mutating it. */
export async function readDshObservedGroup(
  persistence: DshSessionPersistenceLike,
  selectedSessionId: string,
  signal?: AbortSignal,
): Promise<DshObservedGroup> {
  for (let attempt = 1; attempt <= MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const before = snapshotMap(await persistence.listSnapshots(signal));
    if (!before.has(selectedSessionId)) throw new Error(`DSH session 不存在：${selectedSessionId}。`);
    const rootId = rootSessionId(selectedSessionId, before);
    const ids = groupSessionIds(rootId, before);
    const inspections = await Promise.all(ids.map((id) => persistence.inspect(id, signal)));
    signal?.throwIfAborted();
    const after = snapshotMap(await persistence.listSnapshots(signal));
    if (!stableGroup(before, after, rootId)) continue;
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
  signal?: AbortSignal,
): Promise<DshObserveCandidate | undefined> {
  const sessionId = String(snapshot.header.id);
  try {
    const group = await readDshObservedGroup(persistence, sessionId, signal);
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
    return undefined;
  }
}

/** List recent terminal root sessions; the command's own live session stays out of the default result. */
export async function listDshObserveCandidates(
  persistence: DshSessionPersistenceLike,
  options: { excludeSessionId?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<DshObserveCandidate[]> {
  const limit = Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT);
  const snapshots = [...await persistence.listSnapshots(options.signal)]
    .filter((snapshot) => snapshot.header.origin !== 'subagent'
      && String(snapshot.header.id) !== options.excludeSessionId)
    .sort((left, right) => right.header.createdAt - left.header.createdAt)
    .slice(0, Math.max(limit, LIST_INSPECTION_LIMIT));
  const candidates: DshObserveCandidate[] = [];
  for (const snapshot of snapshots) {
    options.signal?.throwIfAborted();
    const candidate = await inspectCandidate(persistence, snapshot, options.signal);
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
    trajectoryHref: `/conversations/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(turn.turnId)}`,
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
  const rootTrace = group.traces.find((trace) => trace.session.runId === group.rootSessionId)
    ?? group.traces[0];
  if (!rootTrace) throw new Error(`DSH session group 为空：${group.rootSessionId}。`);
  const timeline = mergedTimeline(group);
  const turns = attachDescendantsToRootTurns(
    reconstructExperienceTurns(timeline),
    timeline,
    rootTrace.session.traceId,
  );
  const rootTimeline = timeline.filter((event) => event.traceId === rootTrace.session.traceId);
  const firstUser = rootTimeline.find((event) => event.kind === 'user_message');
  const title = firstUser?.fullText?.trim() || firstUser?.snippet?.trim() || `DSH session ${group.rootSessionId}`;
  const tasks = turns.map((turn) => taskItem(group.rootSessionId, turn));
  const startTimestamp = rootTrace.session.startTimestamp;
  const endTimestamp = rootTrace.session.endTimestamp;
  return {
    group,
    turns,
    timeline,
    records: sourceRecords(group),
    conversation: {
      threadId: group.rootSessionId,
      sourceThreadId: group.rootSessionId,
      sourceKind: 'dsh',
      title: title.replace(/\s+/g, ' ').slice(0, 160),
      preview: title.replace(/\s+/g, ' ').slice(0, 240),
      cwd: rootTrace.session.cwd,
      model: rootTrace.session.sourceMetadata?.model,
      childThreadCount: Math.max(0, group.traces.length - 1),
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
      entries.set(group.rootSessionId, entry);
      const selectedTrace = group.traces.find((trace) => trace.session.runId === group.selectedSessionId);
      const selectedTurn = [...entry.turns].reverse().find((turn) => turn.traceId === selectedTrace?.session.traceId)
        ?? entry.turns.at(-1);
      if (!selectedTurn) throw new Error(`DSH session 没有可展示的任务：${group.selectedSessionId}。`);
      return { threadId: group.rootSessionId, turnId: selectedTurn.turnId };
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
    async loadTaskTrajectory(threadId, turnId): Promise<ConversationTaskTrajectory | undefined> {
      const entry = entries.get(threadId);
      const turn = entry?.turns.find((candidate) => candidate.turnId === turnId);
      if (!entry || !turn) return undefined;
      const rootTrace = entry.group.traces.find((trace) => trace.session.runId === entry.group.rootSessionId)
        ?? entry.group.traces[0];
      if (!rootTrace) return undefined;
      return {
        revision: entry.group.revision,
        status: turn.status,
        liveObservable: false,
        session: {
          id: `dsh:${threadId}`,
          threadId,
          sourceThreadId: entry.group.rootSessionId,
          sessionId: entry.group.selectedSessionId,
          sourceTrace: rootTrace.session.sourcePath,
          sourceKind: 'dsh',
          entrypoint: 'dsh',
          sourceMetadata: rootTrace.session.sourceMetadata,
          cwd: rootTrace.session.cwd,
          startTimestamp: rootTrace.session.startTimestamp,
          endTimestamp: rootTrace.session.endTimestamp,
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
