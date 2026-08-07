import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { ExperienceTurnStatus } from '../types/index.js';
import { codexUserDisplayText } from './codex-protocol.js';

const READ_CHUNK_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const INDEX_SCHEMA_VERSION = 6;

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
  schemaVersion: 6;
  sourcePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  sourceThreadId: string;
  sessionMeta?: unknown;
  sessionMetaLine?: number;
  tasks: CodexIndexedTask[];
  sourceRecordCount: number;
  malformedRecordCount: number;
}

interface MutableTask extends CodexIndexedTask {
  titlePriority: number;
}

export interface CodexJsonlLine {
  text: string;
  line: number;
  startOffset: number;
  endOffset: number;
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
  const lastTask = tasks.at(-1);
  const active = lastTask?.status === 'open'
    ? mutableTask(tasks.pop()!)
    : undefined;
  const state = scanCodexRolloutIndex(sourcePath, sourceThreadId, {
    tasks,
    active,
    sessionMeta: normalizedPrevious.sessionMeta,
    sessionMetaLine: normalizedPrevious.sessionMetaLine,
    sourceRecordCount: normalizedPrevious.sourceRecordCount,
    malformedRecordCount: normalizedPrevious.malformedRecordCount,
  }, previous.sourceSize, sourceStat.size, previous.sourceRecordCount);
  return indexFromState(sourcePath, sourceThreadId, sourceStat, state);
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
}

function scanCodexRolloutIndex(
  sourcePath: string,
  sourceThreadId: string,
  state: CodexIndexScanState,
  startOffset: number,
  endOffset: number,
  startLine: number,
): CodexIndexScanState {
  forEachJsonlLine(sourcePath, (record) => {
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
      state.active ??= newMutableTask(
        `turn:${sourceThreadId}:${record.line}`,
        record,
        timestamp,
      );
      const titlePriority = userPromptPriority(recordType, payloadType);
      if (titlePriority > state.active.titlePriority) {
        const message = userPromptText(payload)?.trim();
        if (message) {
          state.active.title = compactTitle(message);
          state.active.titlePriority = titlePriority;
        }
      }
      return;
    }

    if (!state.active) return;
    if (recordType === 'response_item' && isToolCallPayload(payloadType)) {
      state.active.toolCallCount += 1;
    }
    if (isFailedToolRecord(recordType, payloadType, payload)) {
      state.active.toolFailureCount += 1;
    }

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
    sourceThreadId,
    sessionMeta: state.sessionMeta,
    sessionMetaLine: state.sessionMetaLine,
    tasks,
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
  };
}

function mutableTask(task: CodexIndexedTask): MutableTask {
  return {
    ...task,
    titlePriority: task.title === '未命名任务' ? 0 : 1,
  };
}

export function isCurrentCodexRolloutIndex(value: unknown, sourcePath: string): value is CodexRolloutIndex {
  const candidate = objectValue(value);
  if (!candidate || candidate.schemaVersion !== INDEX_SCHEMA_VERSION || candidate.sourcePath !== sourcePath) return false;
  try {
    const current = statSync(sourcePath);
    return candidate.sourceSize === current.size
      && candidate.sourceMtimeMs === current.mtimeMs
      && Array.isArray(candidate.tasks);
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
    if (sourceSize === undefined || sourceMtimeMs === undefined) return false;
    if (current.size === sourceSize) return current.mtimeMs === sourceMtimeMs;
    return current.size > sourceSize && current.mtimeMs >= sourceMtimeMs;
  } catch {
    return false;
  }
}

export function readCodexTaskRecords(
  index: CodexRolloutIndex,
  task: CodexIndexedTask,
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
  return { records, lines, malformedRecordCount };
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

function stripMutable({ titlePriority: _titlePriority, ...task }: MutableTask): CodexIndexedTask {
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

function isFailedToolRecord(
  recordType: string | undefined,
  payloadType: string | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (recordType !== 'event_msg') return false;
  if (payloadType === 'mcp_tool_call_end') {
    const result = objectValue(payload.result);
    return payload.success === false || result?.is_error === true;
  }
  return payloadType === 'patch_apply_end' && payload.success === false;
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
  visit: (line: CodexJsonlLine) => void,
  startOffset = 0,
  endOffset = Number.POSITIVE_INFINITY,
  startLine = 0,
): void {
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let absoluteOffset = startOffset;
  let lineStartOffset = startOffset;
  let lineNumber = startLine;
  let fragments: Buffer[] = [];
  try {
    while (absoluteOffset < endOffset) {
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
        emitLine(lineBuffer, lineNumber, lineStartOffset, nextOffset, visit);
        fragments = [];
        cursor = index + 1;
        lineStartOffset = nextOffset;
        lineNumber += 1;
      }
      if (cursor < bytesRead) fragments.push(Buffer.from(buffer.subarray(cursor, bytesRead)));
      if (fragments.reduce((sum, item) => sum + item.length, 0) > MAX_RECORD_BYTES) {
        throw new Error(`Codex JSONL 单条记录超过 ${MAX_RECORD_BYTES} 字节上限：${filePath}`);
      }
      absoluteOffset += bytesRead;
    }
    if (fragments.length > 0) {
      emitLine(Buffer.concat(fragments), lineNumber, lineStartOffset, absoluteOffset, visit);
    }
  } finally {
    closeSync(fd);
  }
}

function emitLine(
  buffer: Buffer,
  line: number,
  startOffset: number,
  endOffset: number,
  visit: (line: CodexJsonlLine) => void,
): void {
  const text = buffer.toString('utf8').trim();
  if (!text) return;
  visit({ text, line, startOffset, endOffset });
}
