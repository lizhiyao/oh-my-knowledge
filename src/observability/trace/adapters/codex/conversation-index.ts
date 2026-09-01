import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { ExperienceTurnStatus } from '../../../contracts/experience.js';
import type { TraceToolStatus } from '../../trace-ir.js';
import { codexUserDisplayText, codexUserMessageOrigin } from './protocol.js';
import {
  codexRuntimeToolOutcomeFromPayload,
  codexToolOutputOutcome,
} from './tool-status.js';

const READ_CHUNK_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const INDEX_SCHEMA_VERSION = 12;
const MAX_CURRENT_INDEX_ATTEMPTS = 4;

export interface CodexIndexedTask {
  turnId: string;
  title: string;
  startTimestamp?: string;
  endTimestamp?: string;
  status: ExperienceTurnStatus;
  sourceRecordCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export interface CodexRolloutIndex {
  schemaVersion: 12;
  sourcePath: string;
  /** File size observed when the index was produced. */
  sourceSize: number;
  sourceMtimeMs: number;
  /** Byte boundary after the last complete JSONL record. */
  indexedSize: number;
  /** Physical line number at indexedSize, including blank lines. */
  indexedLineCount: number;
  /** Whether indexedSize is immediately after a newline delimiter. */
  indexedEndsWithNewline: boolean;
  sourceThreadId: string;
  sessionMeta?: unknown;
  sessionMetaLine?: number;
  tasks: CodexIndexedTask[];
  /** Incremental matcher state for the final unclosed task only. */
  activeToolOutcomeState?: CodexActiveToolOutcomeState;
  sourceRecordCount: number;
  malformedRecordCount: number;
}

interface MutableTask extends CodexIndexedTask {
  titlePriority: number;
  toolOutcomeTracker: ToolOutcomeTracker;
}

export interface CodexActiveToolOutcomeState {
  callOccurrences: Array<[string, number]>;
  resultOccurrences: Array<[string, number]>;
  runtimeOccurrences: Array<[string, number]>;
  outcomes: Array<[string, IndexedToolOutcome]>;
}

interface IndexedToolOutcome {
  outputStatus?: TraceToolStatus;
  runtimeStatus?: TraceToolStatus;
}

interface ToolOutcomeTracker {
  callOccurrences: Map<string, number>;
  resultOccurrences: Map<string, number>;
  runtimeOccurrences: Map<string, number>;
  outcomes: Map<string, IndexedToolOutcome>;
}

export interface CodexJsonlLine {
  text: string;
  line: number;
  startOffset: number;
  endOffset: number;
}

export interface CodexTaskRecordReadOptions {
  /** Include only the next task prefix through its first human user message. */
  includeNextHumanMessage?: boolean;
}

/**
 * Build a compact byte-range index without retaining the rollout. Only records
 * needed for turn boundaries and list metrics are parsed.
 */
export function buildCodexRolloutIndex(
  sourcePath: string,
  sourceThreadId: string,
): CodexRolloutIndex {
  const sourceStat = statSync(sourcePath);
  const state = scanCodexRolloutIndex(sourcePath, sourceThreadId, {
    tasks: [],
    sourceRecordCount: 0,
    malformedRecordCount: 0,
    indexedSize: 0,
    indexedLineCount: 0,
    indexedEndsWithNewline: true,
  }, 0, sourceStat.size, 0);
  return indexFromState(sourcePath, sourceThreadId, sourceStat, state);
}

/**
 * Extend an append-only rollout index from its last byte boundary. If the
 * source was replaced or truncated, rebuild so callers never observe a mixed
 * index from two different files.
 */
export function extendCodexRolloutIndex(
  sourcePath: string,
  sourceThreadId: string,
  previous: CodexRolloutIndex,
): CodexRolloutIndex {
  const sourceStat = statSync(sourcePath);
  if (!isReusableCodexRolloutIndex(previous, sourcePath)
    || previous.sourceThreadId !== sourceThreadId
    || sourceStat.size < previous.sourceSize) {
    return buildCodexRolloutIndex(sourcePath, sourceThreadId);
  }
  const normalizedPrevious = normalizeCodexRolloutIndex(previous);
  if (sourceStat.size === previous.sourceSize && sourceStat.mtimeMs === previous.sourceMtimeMs) {
    return normalizedPrevious;
  }

  const tasks = normalizedPrevious.tasks.map((task) => ({ ...task }));
  const resume = resumeAppendCursor(sourcePath, normalizedPrevious, sourceStat.size);
  if (!resume) return buildCodexRolloutIndex(sourcePath, sourceThreadId);
  completeTailTaskDelimiter(tasks, normalizedPrevious.indexedSize, resume.indexedSize);
  const lastTask = tasks.at(-1);
  const active = lastTask?.status === 'open'
    ? mutableTask(tasks.pop()!, normalizedPrevious.activeToolOutcomeState)
    : undefined;
  const state: CodexIndexScanState = {
    tasks,
    active,
    sessionMeta: normalizedPrevious.sessionMeta,
    sessionMetaLine: normalizedPrevious.sessionMetaLine,
    sourceRecordCount: normalizedPrevious.sourceRecordCount,
    malformedRecordCount: normalizedPrevious.malformedRecordCount,
    indexedSize: resume.indexedSize,
    indexedLineCount: normalizedPrevious.indexedLineCount,
    indexedEndsWithNewline: resume.indexedEndsWithNewline,
  };
  const extended = resume.indexedSize < sourceStat.size
    ? scanCodexRolloutIndex(
      sourcePath,
      sourceThreadId,
      state,
      resume.indexedSize,
      sourceStat.size,
      normalizedPrevious.indexedLineCount,
    )
    : state;
  return indexFromState(sourcePath, sourceThreadId, sourceStat, extended);
}

/**
 * Catch an append-only rollout up to a snapshot that is still current after
 * indexing. Returning a stale prefix here would violate current-read callers.
 */
export function synchronizeCurrentCodexRolloutIndex(
  sourcePath: string,
  sourceThreadId: string,
  initial?: CodexRolloutIndex,
): CodexRolloutIndex {
  let index = initial
    && initial.sourceThreadId === sourceThreadId
    && isReusableCodexRolloutIndex(initial, sourcePath)
    ? normalizeCodexRolloutIndex(initial)
    : buildCodexRolloutIndex(sourcePath, sourceThreadId);
  for (let attempt = 0; attempt < MAX_CURRENT_INDEX_ATTEMPTS; attempt += 1) {
    if (isCurrentCodexRolloutIndex(index, sourcePath)) return index;
    index = extendCodexRolloutIndex(sourcePath, sourceThreadId, index);
  }
  if (isCurrentCodexRolloutIndex(index, sourcePath)) return index;
  throw new Error('Codex 对话日志持续写入，暂时无法形成当前索引快照');
}

function resumeAppendCursor(
  sourcePath: string,
  previous: CodexRolloutIndex,
  sourceSize: number,
): { indexedSize: number; indexedEndsWithNewline: boolean } | undefined {
  if (previous.indexedEndsWithNewline) {
    return {
      indexedSize: previous.indexedSize,
      indexedEndsWithNewline: true,
    };
  }

  const fd = openSync(sourcePath, 'r');
  const buffer = Buffer.allocUnsafe(Math.min(4_096, Math.max(1, sourceSize - previous.indexedSize)));
  let offset = previous.indexedSize;
  try {
    while (offset < sourceSize) {
      const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, sourceSize - offset), offset);
      if (bytesRead === 0) break;
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index];
        if (byte === 0x0a) {
          return {
            indexedSize: offset + index + 1,
            indexedEndsWithNewline: true,
          };
        }
        if (byte !== 0x09 && byte !== 0x0d && byte !== 0x20) return undefined;
      }
      offset += bytesRead;
    }
  } finally {
    closeSync(fd);
  }
  return {
    indexedSize: sourceSize,
    indexedEndsWithNewline: false,
  };
}

function completeTailTaskDelimiter(
  tasks: CodexIndexedTask[],
  previousIndexedSize: number,
  indexedSize: number,
): void {
  if (indexedSize <= previousIndexedSize) return;
  const tailTask = tasks.at(-1);
  if (tailTask?.endOffset === previousIndexedSize) tailTask.endOffset = indexedSize;
}

/**
 * A single Codex rollout is sequential: once a newer task starts, an older
 * task without a terminal record can no longer be live. Normalize historical
 * caches in memory so an omitted task_complete never becomes a permanent
 * "running" conversation.
 */
export function normalizeCodexRolloutIndex(index: CodexRolloutIndex): CodexRolloutIndex {
  let changed = false;
  const tasks = index.tasks.map((task, taskIndex) => {
    if (task.status !== 'open' || taskIndex === index.tasks.length - 1) return task;
    changed = true;
    return {
      ...task,
      status: 'unknown' as const,
      endTimestamp: task.endTimestamp ?? index.tasks[taskIndex + 1]?.startTimestamp,
    };
  });
  return changed ? { ...index, tasks } : index;
}

interface CodexIndexScanState {
  tasks: CodexIndexedTask[];
  active?: MutableTask;
  sessionMeta?: unknown;
  sessionMetaLine?: number;
  sourceRecordCount: number;
  malformedRecordCount: number;
  indexedSize: number;
  indexedLineCount: number;
  indexedEndsWithNewline: boolean;
}

function scanCodexRolloutIndex(
  sourcePath: string,
  sourceThreadId: string,
  state: CodexIndexScanState,
  startOffset: number,
  endOffset: number,
  startLine: number,
): CodexIndexScanState {
  const scanned = forEachJsonlLine(sourcePath, (record) => {
    state.sourceRecordCount += 1;
    const relevant = isIndexRelevantLine(record.text);
    if (!relevant) {
      includeRecord(state.active, record);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(record.text) as unknown;
    } catch {
      state.malformedRecordCount += 1;
      includeRecord(state.active, record);
      return;
    }
    const raw = objectValue(parsed);
    if (!raw) return;
    const recordType = stringValue(raw.type);
    const payload = objectValue(raw.payload) ?? {};
    const payloadType = stringValue(payload.type);
    const timestamp = stringValue(raw.timestamp);

    if (recordType === 'session_meta' && state.sessionMeta === undefined) {
      state.sessionMeta = parsed;
      state.sessionMetaLine = record.line;
      return;
    }

    if (recordType === 'event_msg' && payloadType === 'task_started') {
      if (state.active) {
        state.tasks.push(finalizeSupersededTask(
          state.active,
          record.startOffset,
          record.line - 1,
          timestamp,
        ));
      }
      const nativeTurnId = stringValue(payload.turn_id);
      state.active = newMutableTask(
        nativeTurnId ?? `turn:${sourceThreadId}:${record.line}`,
        record,
        timestamp,
      );
      return;
    }

    includeRecord(state.active, record);

    if (isUserPromptRecord(recordType, payloadType, payload)) {
      const message = userPromptText(payload)?.trim();
      const displayText = message && codexUserMessageOrigin(message) === 'human'
        ? codexUserDisplayText(message)?.trim()
        : undefined;
      if (!displayText) return;
      state.active ??= newMutableTask(
        `turn:${sourceThreadId}:${record.line}`,
        record,
        timestamp,
      );
      const titlePriority = userPromptPriority(recordType, payloadType);
      if (titlePriority > state.active.titlePriority) {
        state.active.title = compactTitle(displayText);
        state.active.titlePriority = titlePriority;
      }
      return;
    }

    if (!state.active) return;
    if (recordType === 'response_item' && isToolCallPayload(payloadType)) {
      recordToolCall(state.active, record, payload);
    }
    recordToolOutcome(state.active, record, recordType, payloadType, payload);

    if (recordType === 'event_msg' && payloadType === 'task_complete') {
      state.active.status = 'completed';
      state.active.endTimestamp = timestamp;
      if (state.active.titlePriority === 0) {
        const fallback = stringValue(payload.last_agent_message)?.trim();
        if (fallback) state.active.title = compactTitle(fallback);
      }
      state.tasks.push(stripMutable(state.active));
      state.active = undefined;
      return;
    }
    if (recordType === 'event_msg' && (payloadType === 'turn_aborted' || payloadType === 'turn_interrupted')) {
      state.active.status = payloadType === 'turn_aborted' ? 'aborted' : 'interrupted';
      state.active.endTimestamp = timestamp;
      state.tasks.push(stripMutable(state.active));
      state.active = undefined;
    }
  }, startOffset, endOffset, startLine);
  state.indexedSize = scanned.indexedSize;
  state.indexedLineCount = scanned.indexedLineCount;
  state.indexedEndsWithNewline = scanned.indexedEndsWithNewline;
  return state;
}

function indexFromState(
  sourcePath: string,
  sourceThreadId: string,
  sourceStat: { size: number; mtimeMs: number },
  state: CodexIndexScanState,
): CodexRolloutIndex {
  const tasks = state.active
    ? [...state.tasks, stripMutable(state.active)]
    : state.tasks;
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    sourcePath,
    sourceSize: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    indexedSize: state.indexedSize,
    indexedLineCount: state.indexedLineCount,
    indexedEndsWithNewline: state.indexedEndsWithNewline,
    sourceThreadId,
    sessionMeta: state.sessionMeta,
    sessionMetaLine: state.sessionMetaLine,
    tasks,
    activeToolOutcomeState: state.active
      ? serializeToolOutcomeTracker(state.active.toolOutcomeTracker)
      : undefined,
    sourceRecordCount: state.sourceRecordCount,
    malformedRecordCount: state.malformedRecordCount,
  };
}

function newMutableTask(
  turnId: string,
  record: CodexJsonlLine,
  startTimestamp: string | undefined,
): MutableTask {
  return {
    turnId,
    title: '未命名任务',
    titlePriority: 0,
    startTimestamp,
    status: 'open',
    sourceRecordCount: 1,
    toolCallCount: 0,
    toolFailureCount: 0,
    startOffset: record.startOffset,
    endOffset: record.endOffset,
    startLine: record.line,
    endLine: record.line,
    toolOutcomeTracker: createToolOutcomeTracker(),
  };
}

function mutableTask(
  task: CodexIndexedTask,
  activeToolOutcomeState?: CodexActiveToolOutcomeState,
): MutableTask {
  return {
    ...task,
    titlePriority: task.title === '未命名任务' ? 0 : 1,
    toolOutcomeTracker: createToolOutcomeTracker(activeToolOutcomeState),
  };
}

export function isCurrentCodexRolloutIndex(value: unknown, sourcePath: string): value is CodexRolloutIndex {
  const candidate = objectValue(value);
  if (!candidate || candidate.schemaVersion !== INDEX_SCHEMA_VERSION || candidate.sourcePath !== sourcePath) return false;
  const sourceSize = numberValue(candidate.sourceSize);
  const indexedSize = numberValue(candidate.indexedSize);
  const indexedLineCount = numberValue(candidate.indexedLineCount);
  if (sourceSize === undefined || indexedSize === undefined || indexedLineCount === undefined
    || typeof candidate.indexedEndsWithNewline !== 'boolean') return false;
  if (indexedSize > sourceSize || !Array.isArray(candidate.tasks)) return false;
  try {
    const current = statSync(sourcePath);
    return sourceSize === current.size
      && candidate.sourceMtimeMs === current.mtimeMs
      && indexedSize <= current.size;
  } catch {
    return false;
  }
}

/**
 * Codex rollouts are append-only while a conversation is active. A prefix
 * index remains internally consistent even after newer records are appended.
 */
export function isReusableCodexRolloutIndex(value: unknown, sourcePath: string): value is CodexRolloutIndex {
  const candidate = objectValue(value);
  if (!candidate || candidate.schemaVersion !== INDEX_SCHEMA_VERSION || candidate.sourcePath !== sourcePath) return false;
  if (!Array.isArray(candidate.tasks)) return false;
  try {
    const current = statSync(sourcePath);
    const sourceSize = numberValue(candidate.sourceSize);
    const sourceMtimeMs = numberValue(candidate.sourceMtimeMs);
    const indexedSize = numberValue(candidate.indexedSize);
    const indexedLineCount = numberValue(candidate.indexedLineCount);
    if (sourceSize === undefined || sourceMtimeMs === undefined
      || indexedSize === undefined || indexedLineCount === undefined
      || typeof candidate.indexedEndsWithNewline !== 'boolean') return false;
    if (indexedSize > sourceSize || sourceSize > current.size) return false;
    if (current.size === sourceSize) return current.mtimeMs === sourceMtimeMs;
    return current.size > sourceSize && current.mtimeMs >= sourceMtimeMs;
  } catch {
    return false;
  }
}

export function readCodexTaskRecords(
  index: CodexRolloutIndex,
  task: CodexIndexedTask,
  options: CodexTaskRecordReadOptions = {},
): { records: Array<unknown | undefined>; lines: CodexJsonlLine[]; malformedRecordCount: number } {
  const records: Array<unknown | undefined> = [];
  if (index.sessionMeta !== undefined && index.sessionMetaLine !== undefined) {
    records[index.sessionMetaLine] = index.sessionMeta;
  }
  const lines: CodexJsonlLine[] = [];
  let malformedRecordCount = 0;
  forEachJsonlLine(index.sourcePath, (record) => {
    if (record.endOffset <= task.startOffset || record.startOffset >= task.endOffset) return;
    lines.push(record);
    try {
      records[record.line] = JSON.parse(record.text) as unknown;
    } catch {
      malformedRecordCount += 1;
    }
  }, task.startOffset, task.endOffset, task.startLine);
  if (options.includeNextHumanMessage) {
    const taskIndex = index.tasks.findIndex((candidate) => candidate.turnId === task.turnId);
    const nextTask = taskIndex >= 0 ? index.tasks[taskIndex + 1] : undefined;
    if (nextTask) {
      forEachJsonlLine(index.sourcePath, (record) => {
        lines.push(record);
        try {
          const parsed = JSON.parse(record.text) as unknown;
          records[record.line] = parsed;
          return isHumanUserPrompt(parsed) ? false : undefined;
        } catch {
          malformedRecordCount += 1;
          return undefined;
        }
      }, nextTask.startOffset, nextTask.endOffset, nextTask.startLine);
    }
  }
  return { records, lines, malformedRecordCount };
}

function isHumanUserPrompt(value: unknown): boolean {
  const raw = objectValue(value);
  if (!raw) return false;
  const recordType = stringValue(raw.type);
  const payload = objectValue(raw.payload) ?? {};
  const payloadType = stringValue(payload.type);
  if (!isUserPromptRecord(recordType, payloadType, payload)) return false;
  const message = userPromptText(payload)?.trim();
  return Boolean(
    message
    && codexUserMessageOrigin(message) === 'human'
    && codexUserDisplayText(message)?.trim(),
  );
}

function finalizeSupersededTask(
  task: MutableTask,
  endOffset: number,
  endLine: number,
  endTimestamp: string | undefined,
): CodexIndexedTask {
  return stripMutable({
    ...task,
    status: 'unknown',
    endTimestamp: task.endTimestamp ?? endTimestamp,
    endOffset: Math.max(task.endOffset, endOffset),
    endLine: Math.max(task.endLine, endLine),
  });
}

function stripMutable({
  titlePriority: _titlePriority,
  toolOutcomeTracker: _toolOutcomeTracker,
  ...task
}: MutableTask): CodexIndexedTask {
  return task;
}

function includeRecord(task: MutableTask | undefined, record: CodexJsonlLine): void {
  if (!task) return;
  task.sourceRecordCount += 1;
  task.endOffset = record.endOffset;
  task.endLine = record.line;
}

function isIndexRelevantLine(line: string): boolean {
  return line.includes('"type":"session_meta"')
    || line.includes('"type":"task_started"')
    || line.includes('"type":"task_complete"')
    || line.includes('"type":"turn_aborted"')
    || line.includes('"type":"turn_interrupted"')
    || line.includes('"type":"user_message"')
    || line.includes('"type":"message"')
    || line.includes('"type":"function_call"')
    || line.includes('"type":"custom_tool_call"')
    || line.includes('"type":"local_shell_call"')
    || line.includes('"type":"function_call_output"')
    || line.includes('"type":"custom_tool_call_output"')
    || line.includes('"type":"mcp_tool_call_end"')
    || line.includes('"type":"patch_apply_end"');
}

function isToolCallPayload(payloadType: string | undefined): boolean {
  return payloadType === 'function_call'
    || payloadType === 'custom_tool_call'
    || payloadType === 'local_shell_call';
}

function isUserPromptRecord(
  recordType: string | undefined,
  payloadType: string | undefined,
  payload: Record<string, unknown>,
): boolean {
  return (recordType === 'event_msg' && payloadType === 'user_message')
    || (recordType === 'response_item' && payloadType === 'message' && payload.role === 'user');
}

function userPromptPriority(
  recordType: string | undefined,
  payloadType: string | undefined,
): number {
  return recordType === 'event_msg' && payloadType === 'user_message' ? 2 : 1;
}

function userPromptText(payload: Record<string, unknown>): string | undefined {
  const direct = stringValue(payload.message) ?? stringValue(payload.content);
  if (direct) return direct;
  if (!Array.isArray(payload.content)) return undefined;
  const parts = payload.content.flatMap((value) => {
    const item = objectValue(value);
    const text = item ? stringValue(item.text) : undefined;
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function recordToolOutcome(
  task: MutableTask,
  record: CodexJsonlLine,
  recordType: string | undefined,
  payloadType: string | undefined,
  payload: Record<string, unknown>,
): void {
  if (recordType === 'response_item'
    && (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')) {
    const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `result:${record.line}`;
    const occurrence = takeToolOccurrence(task.toolOutcomeTracker.resultOccurrences, callId);
    updateToolOutcome(
      task,
      toolOccurrenceKey(callId, occurrence),
      'outputStatus',
      codexToolOutputOutcome(payload.output, payload.status).status,
    );
    return;
  }
  if (recordType !== 'event_msg'
    || (payloadType !== 'mcp_tool_call_end' && payloadType !== 'patch_apply_end')) return;
  const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `runtime:${record.line}`;
  const occurrence = takeToolOccurrence(task.toolOutcomeTracker.runtimeOccurrences, callId);
  ensureRepresentedToolCall(task, callId, occurrence);
  const outcome = codexRuntimeToolOutcomeFromPayload(payloadType, payload);
  if (!outcome.present) return;
  updateToolOutcome(
    task,
    toolOccurrenceKey(callId, occurrence),
    'runtimeStatus',
    outcome.status,
  );
}

function recordToolCall(
  task: MutableTask,
  record: CodexJsonlLine,
  payload: Record<string, unknown>,
): void {
  const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `call:${record.line}`;
  takeToolOccurrence(task.toolOutcomeTracker.callOccurrences, callId);
  task.toolCallCount += 1;
}

/** Match Trace IR's contract: a standalone runtime end still represents one tool call. */
function ensureRepresentedToolCall(
  task: MutableTask,
  callId: string,
  occurrence: number,
): void {
  const representedCount = task.toolOutcomeTracker.callOccurrences.get(callId) ?? 0;
  const requiredCount = occurrence + 1;
  if (representedCount >= requiredCount) return;
  task.toolOutcomeTracker.callOccurrences.set(callId, requiredCount);
  task.toolCallCount += requiredCount - representedCount;
}

function updateToolOutcome(
  task: MutableTask,
  key: string,
  source: keyof IndexedToolOutcome,
  status: TraceToolStatus,
): void {
  const previous = task.toolOutcomeTracker.outcomes.get(key) ?? {};
  const wasFailure = resolvedToolStatus(previous) === 'failure';
  const next = { ...previous, [source]: status };
  task.toolOutcomeTracker.outcomes.set(key, next);
  const isFailure = resolvedToolStatus(next) === 'failure';
  if (wasFailure !== isFailure) task.toolFailureCount += isFailure ? 1 : -1;
}

function resolvedToolStatus(outcome: IndexedToolOutcome): TraceToolStatus {
  return outcome.runtimeStatus ?? outcome.outputStatus ?? 'unknown';
}

function takeToolOccurrence(counts: Map<string, number>, callId: string): number {
  const occurrence = counts.get(callId) ?? 0;
  counts.set(callId, occurrence + 1);
  return occurrence;
}

function toolOccurrenceKey(callId: string, occurrence: number): string {
  return `${callId}\u0000${occurrence}`;
}

function createToolOutcomeTracker(
  state?: CodexActiveToolOutcomeState,
): ToolOutcomeTracker {
  return {
    callOccurrences: new Map(state?.callOccurrences ?? []),
    resultOccurrences: new Map(state?.resultOccurrences ?? []),
    runtimeOccurrences: new Map(state?.runtimeOccurrences ?? []),
    outcomes: new Map(state?.outcomes ?? []),
  };
}

function serializeToolOutcomeTracker(
  tracker: ToolOutcomeTracker,
): CodexActiveToolOutcomeState {
  return {
    callOccurrences: [...tracker.callOccurrences],
    resultOccurrences: [...tracker.resultOccurrences],
    runtimeOccurrences: [...tracker.runtimeOccurrences],
    outcomes: [...tracker.outcomes],
  };
}

function compactTitle(value: string): string {
  return (codexUserDisplayText(value) ?? '').replace(/\s+/gu, ' ').trim().slice(0, 180);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function forEachJsonlLine(
  filePath: string,
  visit: (line: CodexJsonlLine) => void | boolean,
  startOffset = 0,
  endOffset = Number.POSITIVE_INFINITY,
  startLine = 0,
): { indexedSize: number; indexedLineCount: number; indexedEndsWithNewline: boolean } {
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let absoluteOffset = startOffset;
  let lineStartOffset = startOffset;
  let lineNumber = startLine;
  let indexedSize = startOffset;
  let indexedLineCount = startLine;
  let indexedEndsWithNewline = true;
  let fragments: Buffer[] = [];
  try {
    readLoop: while (absoluteOffset < endOffset) {
      const requestBytes = Math.min(buffer.length, endOffset - absoluteOffset);
      const bytesRead = readSync(fd, buffer, 0, requestBytes, absoluteOffset);
      if (bytesRead === 0) break;
      let cursor = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        const tail = buffer.subarray(cursor, index);
        const lineBuffer = fragments.length > 0
          ? Buffer.concat([...fragments, tail])
          : tail;
        const nextOffset = absoluteOffset + index + 1;
        const shouldContinue = emitLine(lineBuffer, lineNumber, lineStartOffset, nextOffset, visit);
        indexedSize = nextOffset;
        indexedLineCount = lineNumber + 1;
        indexedEndsWithNewline = true;
        fragments = [];
        cursor = index + 1;
        lineStartOffset = nextOffset;
        lineNumber += 1;
        if (!shouldContinue) break readLoop;
      }
      if (cursor < bytesRead) fragments.push(Buffer.from(buffer.subarray(cursor, bytesRead)));
      if (fragments.reduce((sum, item) => sum + item.length, 0) > MAX_RECORD_BYTES) {
        throw new Error(`Codex JSONL 单条记录超过 ${MAX_RECORD_BYTES} 字节上限：${filePath}`);
      }
      absoluteOffset += bytesRead;
    }
    if (fragments.length > 0) {
      const trailing = Buffer.concat(fragments);
      if (isCompleteJsonRecord(trailing)) {
        emitLine(trailing, lineNumber, lineStartOffset, absoluteOffset, visit);
        indexedSize = absoluteOffset;
        indexedLineCount = lineNumber + 1;
        indexedEndsWithNewline = false;
      }
    }
  } finally {
    closeSync(fd);
  }
  return { indexedSize, indexedLineCount, indexedEndsWithNewline };
}

function isCompleteJsonRecord(buffer: Buffer): boolean {
  const text = buffer.toString('utf8').trim();
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function emitLine(
  buffer: Buffer,
  line: number,
  startOffset: number,
  endOffset: number,
  visit: (line: CodexJsonlLine) => void | boolean,
): boolean {
  const text = buffer.toString('utf8').trim();
  if (!text) return true;
  return visit({ text, line, startOffset, endOffset }) !== false;
}
