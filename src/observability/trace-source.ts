/** Trace source loading and parsing for Claude / Codex / OpenClaw JSONL and generic markdown logs. */

import { createHash } from 'node:crypto';
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  isCodexGuardianRollout,
  isCodexJsonl,
  parseCodexSessionFile,
} from './codex-trace-adapter.js';
import {
  extractMarkdownLogSkill,
  isClaudeBuiltinCommand,
  stripCommandEnvelopeText,
} from './trace-attribution.js';
import {
  isRuntimeProtocolPromptText,
  isSyntheticUserMessageText,
  isToolResultFailureText,
} from './text-signals.js';
import type { TraceIngestionSummary, TraceSourceMetadata } from './contracts/trace.js';
import type {
  TraceEvent,
  TraceCorpus,
  TraceLifecycleEvent,
  TraceMessageOrigin,
  TraceSession,
  TraceSourceKind,
  TraceUsageEvent,
} from './trace-ir.js';
import { normalizeToolIdentity } from '../shared/tool-identity.js';
import {
  correlateTraceToolEvents,
  createTraceId,
  normalizeTraceTimestamp,
  traceTimestampBounds,
} from './trace-ir.js';
import { nonNegativeMetric, tokenCount } from '../shared/token-usage.js';
import {
  emptyTraceIngestionSummary,
  mergeTraceIngestionSummaries,
} from './trace-ingestion.js';

const TRACE_READ_CHUNK_BYTES = 64 * 1024;
const MAX_JSONL_RECORD_CHARS = 32 * 1024 * 1024;
const MAX_MARKDOWN_LOG_BYTES = 64 * 1024 * 1024;

// ---------- Claude Code JSONL compatibility schema (v0.18 subset) ----------

export interface CcAssistantContent {
  type: 'thinking' | 'text' | 'tool_use';
  thinking?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface CcAssistantRecord {
  type: 'assistant';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  attributionSkill?: string;
  message: {
    role: 'assistant';
    model?: string;
    content: CcAssistantContent[];
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

export interface CcUserToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface CcUserTextContent {
  type: 'text';
  text: string;
}

export interface CcUserRecord {
  type: 'user';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  entrypoint?: string;
  message: {
    role: 'user';
    content: string | Array<CcUserTextContent | CcUserToolResultContent>;
  };
}

export type CcRecord = CcAssistantRecord | CcUserRecord | { type: string; [k: string]: unknown };

export type { TraceSourceMetadata } from './contracts/trace.js';

// ---------- Legacy session compatibility ----------

/** @deprecated Compatibility shape for callers that still construct Claude-style fixtures. */
export interface CcSession {
  sessionId: string;
  /**
   * Logical root session used to aggregate a main trace and all descendants.
   * For a directory shaped as:
   *   A/main.jsonl
   *   A/subagents/x1.jsonl
   *   A/subagents/x2.jsonl
   * all three traces share the same sessionGroupId, while sourcePath still
   * points at the concrete evidence file.
   */
  sessionGroupId?: string;
  sessionGroupPath?: string;
  traceId?: string;
  traceRole?: 'standalone' | 'main' | 'subagent';
  traceLabel?: string;
  sourcePath: string;
  sourceKind?: TraceSourceKind;
  // records 用 unknown[] 是有意为之: cc JSONL 里 permission-mode / file-history-snapshot /
  // 未来可能新增的 record type 都会共存, 严格 union 会拒绝合法输入。
  // segmentBySkill 内部按 type 字段做 structural type guard, 比静态类型约束更 robust。
  records: unknown[];
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  sourceMetadata?: TraceSourceMetadata;
  startTimestamp?: string;
  endTimestamp?: string;
}

export type { TraceEvent, TraceSession } from './trace-ir.js';

// ---------- Load ----------

/**
 * 加载一个目录(或单个 JSONL/agent markdown log 文件)下的所有 session。
 * 递归扫描目录,覆盖 Claude Code 主 session 旁边的 subagents/*.jsonl,
 * 也支持 agent workspace/logs/*.log 里的 Markdown 对话记录。
 */
export function loadTraceSessions(path: string): TraceSession[] {
  return loadTraceCorpus(path).sessions;
}

export function loadTraceCorpus(path: string): TraceCorpus {
  const stat = statSync(path);
  if (stat.isFile()) {
    const parsed = parseTraceFile(path);
    return {
      sessions: resolveParentLinkedSessionGroups(
        parsed.sessions.map((session) => withStandaloneTraceMetadata(session)),
      ),
      ingestion: parsed.ingestion,
    };
  }
  const entries = collectTraceFiles(path);
  const parsed = entries.map(parseTraceFile);
  return {
    sessions: resolveParentLinkedSessionGroups(
      annotateSessionGroups(path, parsed.flatMap((entry) => entry.sessions)),
    ),
    ingestion: mergeTraceIngestionSummaries(parsed.map((entry) => entry.ingestion)),
  };
}

/** @deprecated Use `loadTraceSessions`. */
export const loadCcSessions = loadTraceSessions;

function collectTraceFiles(
  dir: string,
  visitedDirs = new Set<string>(),
  visitedFiles = new Set<string>(),
  rootRealPath?: string,
): string[] {
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch (cause) {
    throw new Error(`无法读取 trace 输入目录：${dir}`, { cause });
  }
  const scanRoot = rootRealPath ?? realDir;
  if (!isWithinTraceRoot(scanRoot, realDir)) return [];
  if (visitedDirs.has(realDir)) return [];
  visitedDirs.add(realDir);

  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (cause) {
    throw new Error(`无法扫描 trace 输入目录：${dir}`, { cause });
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const entryPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(entryPath);
    } catch (cause) {
      throw new Error(`无法读取 trace 输入项：${entryPath}`, { cause });
    }
    if (stat.isDirectory()) {
      files.push(...collectTraceFiles(entryPath, visitedDirs, visitedFiles, scanRoot));
    } else if (entry.endsWith('.jsonl') || entry.endsWith('.log')) {
      let realFile: string;
      try {
        realFile = realpathSync(entryPath);
      } catch (cause) {
        throw new Error(`无法解析 trace 输入文件：${entryPath}`, { cause });
      }
      if (!isWithinTraceRoot(scanRoot, realFile)) continue;
      if (visitedFiles.has(realFile)) continue;
      visitedFiles.add(realFile);
      files.push(entryPath);
    }
  }
  return files.sort();
}

function isWithinTraceRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const rel = relative(rootRealPath, candidateRealPath);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

interface ParsedTraceFile {
  sessions: TraceSession[];
  ingestion: TraceIngestionSummary;
}

interface JsonlTraceAdapter {
  sourceKind: Exclude<TraceSourceKind, 'markdown_log' | 'unknown'>;
  matches(records: CcRecord[]): boolean;
  parse(filePath: string, records: Array<CcRecord | undefined>): TraceSession;
  shouldFilter?(records: CcRecord[]): boolean;
}

const JSONL_TRACE_ADAPTERS: readonly JsonlTraceAdapter[] = [
  {
    sourceKind: 'codex',
    matches: isCodexJsonl,
    parse: parseCodexSessionFile,
    shouldFilter: isCodexGuardianRollout,
  },
  {
    sourceKind: 'openclaw',
    matches: isOpenClawJsonl,
    parse: parseOpenClawSessionFile,
  },
  {
    sourceKind: 'claude',
    matches: isClaudeJsonl,
    parse: parseClaudeSessionFile,
  },
];

function parseTraceFile(filePath: string): ParsedTraceFile {
  if (filePath.endsWith('.jsonl')) {
    return parseJsonlSessionFile(filePath);
  }
  if (filePath.endsWith('.log')) return parseMarkdownLogFile(filePath);
  return {
    sessions: [],
    ingestion: emptyTraceIngestionSummary(),
  };
}

function withStandaloneTraceMetadata(session: TraceSession): TraceSession {
  return {
    ...session,
    rootRunId: session.rootRunId || session.runId,
    groupPath: session.groupPath || dirname(session.sourcePath),
    traceId: session.traceId || traceIdFor(session),
    role: session.role ?? 'standalone',
    label: session.label || basename(session.sourcePath),
  };
}

function annotateSessionGroups(rootPath: string, sessions: TraceSession[]): TraceSession[] {
  const groupRoots = new Set<string>();
  for (const session of sessions) {
    const subagentRoot = subagentGroupRoot(session.sourcePath);
    if (subagentRoot) groupRoots.add(subagentRoot);
  }

  if (groupRoots.size === 0) {
    return sessions.map((session) => withStandaloneTraceMetadata(session));
  }

  const groupIdByRoot = new Map<string, string>();
  for (const root of groupRoots) {
    const mainSession = sessions
      .filter((session) => groupRootForPath(session.sourcePath, groupRoots) === root && !isSubagentTrace(session.sourcePath))
      .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))[0];
    groupIdByRoot.set(root, mainSession?.runId || basename(root) || relative(dirname(rootPath), root) || root);
  }

  return sessions.map((session) => {
    const groupRoot = groupRootForPath(session.sourcePath, groupRoots);
    if (!groupRoot) return withStandaloneTraceMetadata(session);
    const role = isSubagentTrace(session.sourcePath) ? 'subagent' : 'main';
    return {
      ...session,
      rootRunId: groupIdByRoot.get(groupRoot) ?? session.runId,
      groupPath: groupRoot,
      traceId: session.traceId || traceIdFor(session),
      role,
      label: traceLabelFor(session.sourcePath, groupRoot, role),
    };
  });
}

function resolveParentLinkedSessionGroups(sessions: TraceSession[]): TraceSession[] {
  const sessionBySourceAndId = new Map<string, TraceSession>();
  const ambiguousSessionKeys = new Set<string>();
  for (const session of sessions) {
    const key = traceRunKey(session.sourceKind, session.runId);
    if (ambiguousSessionKeys.has(key)) continue;
    if (sessionBySourceAndId.has(key)) {
      sessionBySourceAndId.delete(key);
      ambiguousSessionKeys.add(key);
      continue;
    }
    sessionBySourceAndId.set(key, session);
  }
  const linkedSessionKeys = new Set<string>();
  for (const session of sessions) {
    if (!session.rootRunId || session.rootRunId === session.runId) continue;
    linkedSessionKeys.add(traceRunKey(session.sourceKind, session.runId));
    linkedSessionKeys.add(traceRunKey(session.sourceKind, session.rootRunId));
  }

  return sessions.map((session) => {
    const sessionKey = traceRunKey(session.sourceKind, session.runId);
    if (ambiguousSessionKeys.has(sessionKey)) return isolateAmbiguousSession(session);
    if (!linkedSessionKeys.has(sessionKey)) return session;
    if (!session.rootRunId || session.rootRunId === session.runId) {
      return {
        ...session,
        rootRunId: session.runId,
        groupPath: `${session.sourceKind}:${session.runId}`,
      };
    }
    const seen = new Set<string>([session.runId]);
    let groupId = session.rootRunId || session.runId;
    while (true) {
      if (seen.has(groupId)) {
        return isolateAmbiguousSession(session);
      }
      seen.add(groupId);
      const parentKey = traceRunKey(session.sourceKind, groupId);
      if (ambiguousSessionKeys.has(parentKey)) return isolateAmbiguousSession(session);
      const parent = sessionBySourceAndId.get(parentKey);
      if (!parent) break;
      const parentGroupId = parent.rootRunId || parent.runId;
      if (parentGroupId === parent.runId) {
        groupId = parent.runId;
        break;
      }
      groupId = parentGroupId;
    }
    return {
      ...session,
      rootRunId: groupId,
      groupPath: `${session.sourceKind}:${groupId}`,
    };
  });
}

function traceRunKey(sourceKind: TraceSession['sourceKind'], runId: string): string {
  return `${sourceKind}\u0000${runId}`;
}

function isolateAmbiguousSession(session: TraceSession): TraceSession {
  return {
    ...session,
    rootRunId: session.runId,
    groupPath: `${session.sourceKind}:trace:${session.traceId}`,
  };
}

function traceIdFor(session: Pick<TraceSession, 'runId' | 'sourcePath' | 'sourceKind'>): string {
  return createTraceId({
    sourceKind: session.sourceKind,
    runId: session.runId,
    sourcePath: session.sourcePath,
  });
}

function isSubagentTrace(filePath: string): boolean {
  return normalizedTracePath(filePath).split('/').includes('subagents');
}

function subagentGroupRoot(filePath: string): string | undefined {
  const marker = '/subagents/';
  const index = normalizedTracePath(filePath).indexOf(marker);
  if (index < 0) return undefined;
  return filePath.slice(0, index);
}

function normalizedTracePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function groupRootForPath(filePath: string, groupRoots: Set<string>): string | undefined {
  const subagentRoot = subagentGroupRoot(filePath);
  if (subagentRoot && groupRoots.has(subagentRoot)) return subagentRoot;
  const parent = dirname(filePath);
  if (groupRoots.has(parent)) return parent;
  return undefined;
}

function traceLabelFor(filePath: string, groupRoot: string, role: 'main' | 'subagent'): string {
  const rel = relative(groupRoot, filePath) || basename(filePath);
  return role === 'subagent' ? rel : `main/${basename(filePath)}`;
}

function parseJsonlSessionFile(filePath: string): ParsedTraceFile {
  const records: CcRecord[] = [];
  const indexedRecords: Array<CcRecord | undefined> = [];
  let sourceRecordCount = 0;
  let malformedRecordCount = 0;
  let ignoredValueCount = 0;
  forEachNonEmptyUtf8Line(filePath, (trimmed) => {
    sourceRecordCount += 1;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecordObject(parsed)) {
        const record = parsed as CcRecord;
        records.push(record);
        indexedRecords.push(record);
      } else {
        ignoredValueCount += 1;
        indexedRecords.push(undefined);
      }
    } catch {
      malformedRecordCount += 1;
      indexedRecords.push(undefined);
      // malformed line → skip. cc 有罕见的截断 record, 不让单行 fail 整个 session
    }
  });
  const ingestion: TraceIngestionSummary = {
    fileCount: 1,
    sourceRecordCount,
    parsedRecordCount: records.length,
    malformedRecordCount,
    ignoredValueCount,
    unknownEventCount: 0,
    filteredSessionCount: 0,
  };
  if (records.length === 0) return { sessions: [], ingestion };
  const matchingAdapters = JSONL_TRACE_ADAPTERS.filter((adapter) =>
    adapter.matches(records)
  );
  let session: TraceSession;
  if (matchingAdapters.length === 1) {
    const adapter = matchingAdapters[0];
    if (adapter.shouldFilter?.(records)) {
      return {
        sessions: [],
        ingestion: { ...ingestion, filteredSessionCount: 1 },
      };
    }
    session = adapter.parse(filePath, indexedRecords);
  } else {
    session = parseUnknownJsonlSession(filePath, indexedRecords);
  }
  return {
    sessions: [session],
    ingestion: {
      ...ingestion,
      unknownEventCount: session.events.filter((event) => event.eventKind === 'unknown').length,
    },
  };
}

export function forEachNonEmptyUtf8Line(
  filePath: string,
  visit: (trimmedLine: string) => boolean | void,
): void {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch (cause) {
    throw new Error(`无法读取 trace 输入文件：${filePath}`, { cause });
  }
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(TRACE_READ_CHUNK_BYTES);
  let pending = '';
  let stopped = false;
  const consumeCompleteLines = (): void => {
    let newline = pending.indexOf('\n');
    while (newline >= 0 && !stopped) {
      if (newline > MAX_JSONL_RECORD_CHARS) {
        throw new Error(
          `trace JSONL 单条记录超过 ${MAX_JSONL_RECORD_CHARS} 字符上限：${filePath}`,
        );
      }
      const trimmed = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (trimmed && visit(trimmed) === false) {
        stopped = true;
        return;
      }
      newline = pending.indexOf('\n');
    }
    if (stopped) return;
    if (pending.length > MAX_JSONL_RECORD_CHARS) {
      throw new Error(
        `trace JSONL 单条记录超过 ${MAX_JSONL_RECORD_CHARS} 字符上限：${filePath}`,
      );
    }
  };

  try {
    while (!stopped) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      consumeCompleteLines();
    }
    if (stopped) return;
    pending += decoder.end();
    consumeCompleteLines();
    const trimmed = pending.trim();
    if (trimmed.length > MAX_JSONL_RECORD_CHARS) {
      throw new Error(
        `trace JSONL 单条记录超过 ${MAX_JSONL_RECORD_CHARS} 字符上限：${filePath}`,
      );
    }
    if (trimmed) visit(trimmed);
  } catch (cause) {
    if (
      cause instanceof Error
      && cause.message.startsWith('trace JSONL 单条记录超过')
    ) throw cause;
    throw new Error(`无法解析 trace 输入文件：${filePath}`, { cause });
  } finally {
    closeSync(fd);
  }
}

function isClaudeJsonl(records: CcRecord[]): boolean {
  return records.some((record) =>
    (record.type === 'assistant' || record.type === 'user')
    && typeof record.sessionId === 'string'
    && isRecordObject(record.message)
  ) || records.some((record) =>
    isKnownClaudeRecordType(record.type)
    && typeof record.sessionId === 'string'
  );
}

function parseUnknownJsonlSession(
  filePath: string,
  records: Array<CcRecord | undefined>,
): TraceSession {
  const first = records.find((record): record is CcRecord => Boolean(record));
  const firstRecord = first as Record<string, unknown> | undefined;
  const runId = firstRecord && typeof firstRecord.sessionId === 'string'
    ? firstRecord.sessionId
    : firstRecord && typeof firstRecord.runId === 'string'
      ? firstRecord.runId
      : basename(filePath, '.jsonl');
  const events: TraceEvent[] = records.flatMap((record, sourceIndex) => {
    if (!record) return [];
    const rawRecord = record as Record<string, unknown>;
    const sourceType = typeof record.type === 'string' ? record.type : 'unknown';
    const sourceEventId = typeof record.uuid === 'string'
      ? record.uuid
      : typeof rawRecord.id === 'string'
        ? rawRecord.id
        : undefined;
    return [{
      eventKind: 'unknown' as const,
      eventId: `${runId}:${sourceIndex}:unknown`,
      sourceEventId,
      sourceIndex,
      sourceType,
      timestamp: normalizeTraceTimestamp(record.timestamp),
      raw: record,
    }];
  });
  const bounds = traceTimestampBounds(events.map((event) => event.timestamp));
  return {
    runId,
    rootRunId: runId,
    traceId: createTraceId({ sourceKind: 'unknown', runId, sourcePath: filePath }),
    groupPath: dirname(filePath),
    role: 'standalone',
    label: basename(filePath),
    sourcePath: filePath,
    sourceKind: 'unknown',
    events,
    ...bounds,
  };
}

function parseClaudeSessionFile(filePath: string, records: Array<CcRecord | undefined>): TraceSession {
  const first = records.find((r) => r && 'sessionId' in r && typeof r.sessionId === 'string') as
    | (CcRecord & { sessionId: string; cwd?: string; gitBranch?: string; entrypoint?: string; timestamp?: string })
    | undefined;
  const runId = first?.sessionId ?? basename(filePath, '.jsonl');
  const events = correlateTraceToolEvents(records.flatMap((record, sourceIndex) =>
    record ? legacyRecordToTraceEvents(record, runId, sourceIndex, 'claude') : []
  ));
  const bounds = traceTimestampBounds([
    ...events.map((event) => event.timestamp),
    first?.timestamp,
  ]);
  return {
    runId,
    rootRunId: runId,
    traceId: createTraceId({ sourceKind: 'claude', runId, sourcePath: filePath }),
    groupPath: dirname(filePath),
    role: 'standalone',
    label: basename(filePath),
    sourcePath: filePath,
    sourceKind: 'claude',
    events,
    cwd: first?.cwd,
    gitBranch: first?.gitBranch,
    entrypoint: first?.entrypoint,
    ...bounds,
  };
}

export function legacyCcSessionToTraceSession(session: CcSession): TraceSession {
  const runId = session.sessionId;
  const rootRunId = session.sessionGroupId ?? runId;
  const sourceKind = session.sourceKind ?? 'claude';
  const traceId = session.traceId ?? createTraceId({
    sourceKind,
    runId,
    sourcePath: session.sourcePath,
  });
  const events = correlateTraceToolEvents(session.records.flatMap((record, sourceIndex) =>
    legacyRecordToTraceEvents(record, runId, sourceIndex, sourceKind),
  ));
  const bounds = traceTimestampBounds([
    ...events.map((event) => event.timestamp),
    session.startTimestamp,
    session.endTimestamp,
  ]);
  return {
    runId,
    rootRunId,
    traceId,
    groupPath: session.sessionGroupPath ?? dirname(session.sourcePath),
    role: session.traceRole ?? 'standalone',
    label: session.traceLabel ?? basename(session.sourcePath),
    sourcePath: session.sourcePath,
    sourceKind,
    events,
    cwd: session.cwd,
    gitBranch: session.gitBranch,
    entrypoint: session.entrypoint,
    sourceMetadata: session.sourceMetadata,
    ...bounds,
  };
}

function legacyRecordToTraceEvents(
  raw: unknown,
  runId: string,
  sourceIndex: number,
  sourceKind: TraceSourceKind,
): TraceEvent[] {
  if (!isRecordObject(raw)) return [];
  const sourceType = typeof raw.type === 'string' ? raw.type : 'unknown';
  const timestamp = normalizeTraceTimestamp(raw.timestamp);
  const sourceEventId = typeof raw.uuid === 'string'
    ? raw.uuid
    : typeof raw.id === 'string'
      ? raw.id
      : undefined;
  const eventId = (suffix: string): string => `${runId}:${sourceIndex}:${suffix}`;

  if (sourceType === 'user' && isRecordObject(raw.message)) {
    const content = raw.message.content;
    const events: TraceEvent[] = [];
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    let partIndex = 0;
    for (const part of parts) {
      if (!isRecordObject(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        const text = sourceKind === 'claude'
          ? stripClaudeBuiltinCommandEnvelope(part.text)
          : part.text;
        if (!text) {
          partIndex += 1;
          continue;
        }
        events.push({
          eventKind: 'message',
          eventId: eventId(`message-${partIndex}`),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          role: 'user',
          origin: classifyUserMessageOrigin(raw, text),
          text,
        });
      } else if (
        part.type === 'tool_result'
        && typeof part.tool_use_id === 'string'
      ) {
        const output = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
        const explicit = typeof part.is_error === 'boolean';
        const inferredFailure = !explicit && isToolResultFailureText(output);
        events.push({
          eventKind: 'tool_result',
          eventId: eventId(`tool-result-${partIndex}`),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          callId: part.tool_use_id,
          output,
          status: explicit
            ? part.is_error === true ? 'failure' : 'success'
            : inferredFailure ? 'failure' : 'unknown',
          statusSource: explicit ? 'runtime' : inferredFailure ? 'inferred' : 'unknown',
        });
      }
      partIndex += 1;
    }
    return events;
  }

  if (sourceType === 'assistant' && isRecordObject(raw.message)) {
    const events: TraceEvent[] = [];
    const content = Array.isArray(raw.message.content) ? raw.message.content : [];
    const model = typeof raw.message.model === 'string' ? raw.message.model : undefined;
    const text = content.flatMap((part) =>
      isRecordObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    ).join('\n');
    if (text) {
      events.push({
        eventKind: 'message',
        eventId: eventId('message'),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        role: 'assistant',
        origin: 'synthetic',
        text,
        model,
        attributionSkill: typeof raw.attributionSkill === 'string' ? raw.attributionSkill : undefined,
      });
    }
    content.forEach((part, partIndex) => {
      if (
        isRecordObject(part)
        && part.type === 'tool_use'
        && typeof part.id === 'string'
        && typeof part.name === 'string'
      ) {
        events.push({
          eventKind: 'tool_call',
          eventId: eventId(`tool-call-${partIndex}`),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          callId: part.id,
          tool: normalizeToolIdentity({ sourceName: part.name }),
          input: isRecordObject(part.input) ? part.input : {},
          model,
        });
      }
    });
    if (isRecordObject(raw.message.usage)) {
      const usageEvent = usageEventFromLegacy(
        raw.message.usage,
        eventId('usage'),
        sourceIndex,
        sourceType,
        timestamp,
        model,
      );
      events.push(usageEvent ?? {
        eventKind: 'unknown',
        eventId: eventId('invalid-usage'),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        raw,
      });
    }
    return events;
  }

  if (sourceType === 'system') {
    if (raw.subtype === 'turn_duration') {
      return [{
        eventKind: 'lifecycle',
        eventId: eventId('turn-completed'),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        phase: 'turn_completed',
        durationMs: nonNegativeMetric(raw.durationMs),
      }];
    }
    const text = claudeSystemRecordText(raw);
    if (text) {
      return [{
        eventKind: 'message',
        eventId: eventId('system-message'),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        role: 'system',
        origin: 'runtime',
        text,
      }];
    }
    return [];
  }

  const lifecycle = lifecycleEventFromLegacy(raw, runId, sourceIndex, sourceType, timestamp);
  if (lifecycle) return [lifecycle];
  if (isKnownClaudeRecordType(sourceType)) return [];
  return [{
    eventKind: 'unknown',
    eventId: eventId('unknown'),
    sourceEventId,
    sourceIndex,
    sourceType,
    timestamp,
    raw,
  }];
}

function stripClaudeBuiltinCommandEnvelope(text: string): string {
  const match = /<command-name>\/([^<]+)<\/command-name>/.exec(text);
  return match?.[1] && isClaudeBuiltinCommand(match[1])
    ? stripCommandEnvelopeText(text)
    : text;
}

function isKnownClaudeRecordType(value: unknown): boolean {
  return value === 'assistant'
    || value === 'user'
    || value === 'attachment'
    || value === 'pr-link'
    || value === 'mode'
    || value === 'permission-mode'
    || value === 'last-prompt'
    || value === 'ai-title'
    || value === 'agent-name'
    || value === 'system'
    || value === 'file-history-snapshot'
    || value === 'queue-operation';
}

function claudeSystemRecordText(record: Record<string, unknown>): string {
  if (typeof record.content === 'string' && record.content.trim()) return record.content;
  if (typeof record.message === 'string' && record.message.trim()) return record.message;
  if (record.subtype !== 'api_error' || !isRecordObject(record.error)) return '';
  if (typeof record.error.formatted === 'string' && record.error.formatted.trim()) {
    return record.error.formatted;
  }
  return typeof record.error.message === 'string' ? record.error.message : '';
}

function usageEventFromLegacy(
  usage: Record<string, unknown>,
  eventId: string,
  sourceIndex: number,
  sourceType: string,
  timestamp?: string,
  model?: string,
): TraceUsageEvent | null {
  if (!isValidUsageCounters(
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  )) return null;
  return {
    eventKind: 'usage',
    eventId,
    sourceIndex,
    sourceType,
    timestamp,
    model,
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    cacheReadTokens: tokenCount(usage.cache_read_input_tokens),
    cacheCreationTokens: tokenCount(usage.cache_creation_input_tokens),
  };
}

function lifecycleEventFromLegacy(
  raw: Record<string, unknown>,
  runId: string,
  sourceIndex: number,
  sourceType: string,
  timestamp?: string,
): TraceLifecycleEvent | null {
  const phase = /^session[._-]started$/i.test(sourceType)
    ? 'session_started'
    : /^session[._-]ended$/i.test(sourceType)
      ? 'session_ended'
      : /^turn[._-]started$/i.test(sourceType)
        ? 'turn_started'
        : /^turn[._-](?:ended|completed)$/i.test(sourceType)
          ? 'turn_completed'
          : /^turn[._-]aborted$/i.test(sourceType)
            ? 'turn_aborted'
            : /^turn[._-]interrupted$/i.test(sourceType)
              ? 'turn_interrupted'
              : null;
  if (!phase) return null;
  return {
    eventKind: 'lifecycle',
    eventId: `${runId}:${sourceIndex}:lifecycle`,
    sourceIndex,
    sourceType,
    timestamp,
    turnId: typeof raw.turnId === 'string' ? raw.turnId : undefined,
    phase,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    durationMs: nonNegativeMetric(raw.durationMs),
  };
}

function classifyUserMessageOrigin(record: Record<string, unknown>, text: string): TraceMessageOrigin {
  if (record.isMeta === true && typeof record.sourceToolUseID === 'string') return 'skill-context';
  if (/^Base directory for this skill:\s+.+(?:\n| )#\s+[a-z0-9][\w.-]*/i.test(text)) return 'skill-context';
  if (isRuntimeInjectedMessage(text)) return 'runtime';
  if (
    record.entrypoint === 'sdk-ts'
    && typeof record.promptId === 'string'
    && (
      /^进入.+流程。当前页面已经完成本地工作区恢复/.test(text)
      || /gui-workflow route/.test(text)
      || /当前页面已经完成本地工作区恢复/.test(text)
    )
  ) return 'runtime';
  if (isSyntheticUserMessageText(text)) return 'synthetic';
  return 'human';
}

function isRuntimeInjectedMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return /^Conversation info \(untrusted metadata\):\s*```json/i.test(trimmed)
    || isRuntimeProtocolPromptText(trimmed)
    || /^# AGENTS\.md instructions\b/i.test(trimmed)
    || /^<(?:app-context|environment_context|permissions instructions|collaboration_mode|apps_instructions|plugins_instructions|skills_instructions|recommended_plugins)>/i.test(trimmed);
}

function isOpenClawJsonl(records: CcRecord[]): boolean {
  return records.some((record) => record.type === 'session' && typeof (record as { id?: unknown }).id === 'string')
    && records.some((record) => record.type === 'message' && isRecordObject((record as { message?: unknown }).message));
}

function parseOpenClawSessionFile(filePath: string, rawRecords: Array<CcRecord | undefined>): TraceSession {
  const sessionRecord = rawRecords.find((record) => record?.type === 'session') as
    | { id?: unknown; cwd?: unknown; timestamp?: unknown }
    | undefined;
  const sessionId = typeof sessionRecord?.id === 'string'
    ? sessionRecord.id
    : basename(filePath, '.jsonl');
  const cwd = typeof sessionRecord?.cwd === 'string' ? sessionRecord.cwd : undefined;
  const sourceMetadata = extractOpenClawSourceMetadata(rawRecords);
  const events = correlateTraceToolEvents(rawRecords.flatMap((raw, sourceIndex) =>
    raw ? openClawRecordToTraceEvents(raw, sessionId, sourceIndex) : [],
  ));
  const bounds = traceTimestampBounds([
    ...events.map((event) => event.timestamp),
    sessionRecord?.timestamp,
  ]);

  return {
    runId: sessionId,
    rootRunId: sessionId,
    traceId: createTraceId({
      sourceKind: 'openclaw',
      runId: sessionId,
      sourcePath: filePath,
    }),
    groupPath: dirname(filePath),
    role: 'standalone',
    label: basename(filePath),
    sourcePath: filePath,
    sourceKind: 'openclaw',
    events,
    cwd,
    entrypoint: 'openclaw',
    sourceMetadata,
    ...bounds,
  };
}

function extractOpenClawSourceMetadata(rawRecords: Array<CcRecord | undefined>): TraceSourceMetadata {
  const meta: TraceSourceMetadata = {};
  const commands = new Set<string>();
  for (const raw of rawRecords) {
    if (!raw) continue;
    if (raw.type === 'model_change') {
      const modelChange = raw as { provider?: unknown; modelId?: unknown };
      if (typeof modelChange.provider === 'string') meta.provider = modelChange.provider;
      if (typeof modelChange.modelId === 'string') meta.model = modelChange.modelId;
      continue;
    }
    if (raw.type === 'custom') {
      const custom = raw as { customType?: unknown; data?: unknown };
      if (custom.customType === 'model-snapshot' && isRecordObject(custom.data)) {
        if (typeof custom.data.provider === 'string') meta.provider = custom.data.provider;
        if (typeof custom.data.modelId === 'string') meta.model = custom.data.modelId;
        if (typeof custom.data.modelApi === 'string') meta.modelApi = custom.data.modelApi;
      }
      continue;
    }
    if (raw.type !== 'message') continue;
    const message = (raw as { message?: unknown }).message;
    if (!isRecordObject(message)) continue;
    if (typeof message.provider === 'string') meta.provider = message.provider;
    if (typeof message.model === 'string') meta.model = message.model;
    if (typeof message.api === 'string') meta.modelApi = message.api;
    const text = openClawContentText(message.content);
    for (const name of extractBusinessActionNames(text)) commands.add(name);
    const conversationInfo = extractOpenClawConversationInfo(text);
    if (conversationInfo.channel) meta.channel = conversationInfo.channel;
    if (conversationInfo.sender) meta.sender = conversationInfo.sender;
    if (conversationInfo.senderId) meta.senderId = conversationInfo.senderId;
  }
  if (commands.size > 0) meta.businessActions = Array.from(commands).sort();
  return meta;
}

function extractOpenClawConversationInfo(text: string): Pick<TraceSourceMetadata, 'channel' | 'sender' | 'senderId'> {
  const match = text.match(/Conversation info \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    return {
      channel: typeof parsed.channel === 'string' ? parsed.channel : undefined,
      sender: typeof parsed.sender === 'string' ? parsed.sender : undefined,
      senderId: typeof parsed.sender_id === 'string' ? parsed.sender_id : typeof parsed.senderId === 'string' ? parsed.senderId : undefined,
    };
  } catch {
    return {};
  }
}

function extractBusinessActionNames(text: string): string[] {
  const names: string[] = [];
  const re = /<[a-z][\w.-]*-cmd\b[^>]*\bname=["']([^"']+)["'][^>]*>/g;
  for (const match of text.matchAll(re)) {
    if (match[1]?.trim()) names.push(match[1].trim());
  }
  return names;
}

function openClawRecordToTraceEvents(
  raw: CcRecord,
  sessionId: string,
  sourceIndex: number,
): TraceEvent[] {
  const sourceType = typeof raw.type === 'string' ? raw.type : 'unknown';
  const timestamp = normalizeTraceTimestamp(raw.timestamp);
  const sourceEventId = 'id' in raw && typeof raw.id === 'string' ? raw.id : undefined;
  const eventId = (suffix: string): string => `${sessionId}:${sourceIndex}:${suffix}`;

  if (raw.type === 'session') {
    return [{
      eventKind: 'lifecycle',
      eventId: eventId('session-started'),
      sourceEventId,
      sourceIndex,
      sourceType,
      timestamp,
      phase: 'session_started',
    }];
  }

  const lifecycle = lifecycleEventFromLegacy(
    raw as Record<string, unknown>,
    sessionId,
    sourceIndex,
    sourceType,
    timestamp,
  );
  if (lifecycle) return [lifecycle];
  if (isKnownOpenClawMetadataRecord(raw)) return [];
  if (raw.type !== 'message') {
    return [{
      eventKind: 'unknown',
      eventId: eventId('unknown'),
      sourceEventId,
      sourceIndex,
      sourceType,
      timestamp,
      raw,
    }];
  }

  const messageRecord = raw as {
    id?: unknown;
    timestamp?: unknown;
    message?: {
      role?: unknown;
      content?: unknown;
      model?: unknown;
      usage?: unknown;
      stopReason?: unknown;
      api?: unknown;
      provider?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      isError?: unknown;
    };
  };
  const message = messageRecord.message;
  if (!message || typeof message.role !== 'string') {
    return [{
      eventKind: 'unknown',
      eventId: eventId('unknown-message'),
      sourceEventId,
      sourceIndex,
      sourceType,
      timestamp,
      raw,
    }];
  }

  if (message.role === 'user') {
    return splitOpenClawRuntimeMetadata(openClawContentText(message.content))
      .map((text, partIndex): TraceEvent => ({
        eventKind: 'message',
        eventId: eventId(`message-${partIndex}`),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        role: 'user',
        origin: classifyUserMessageOrigin({ entrypoint: 'openclaw' }, text),
        text,
      }));
  }

  if (message.role === 'assistant') {
    const events: TraceEvent[] = [];
    const model = typeof message.model === 'string' ? message.model : undefined;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = typeof message.content === 'string'
      ? message.content
      : content.flatMap((part) =>
        isRecordObject(part) && part.type === 'text' && typeof part.text === 'string'
          ? [part.text]
          : [],
      ).join('\n');
    if (text) {
      events.push({
        eventKind: 'message',
        eventId: eventId('message'),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        role: 'assistant',
        origin: 'synthetic',
        text,
        model,
      });
    }
    content.forEach((part, partIndex) => {
      if (
        !isRecordObject(part)
        || part.type !== 'toolCall'
        || typeof part.id !== 'string'
        || typeof part.name !== 'string'
      ) return;
      const sourceName = part.name.trim();
      // OpenClaw's native shell tool is named `exec`. Keep that protocol fact in
      // this adapter instead of teaching the source-neutral identity layer that
      // every custom tool named `exec` is a shell.
      const tool = sourceName.toLowerCase() === 'exec'
        ? { name: 'Bash', sourceName }
        : normalizeToolIdentity({ sourceName });
      events.push({
        eventKind: 'tool_call',
        eventId: eventId(`tool-call-${partIndex}`),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        callId: part.id,
        tool,
        input: normalizeOpenClawToolInput(
          tool.name,
          isRecordObject(part.arguments) ? part.arguments : {},
        ),
        model,
      });
    });
    if (isRecordObject(message.usage)) {
      const inputTokens = message.usage.input ?? message.usage.input_tokens;
      const outputTokens = message.usage.output ?? message.usage.output_tokens;
      const cacheReadTokens = message.usage.cacheRead ?? message.usage.cache_read_input_tokens;
      const cacheCreationTokens = message.usage.cacheWrite ?? message.usage.cache_creation_input_tokens;
      if (isValidUsageCounters(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens)) {
        events.push({
          eventKind: 'usage',
          eventId: eventId('usage'),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          model,
          inputTokens: tokenCount(inputTokens),
          outputTokens: tokenCount(outputTokens),
          cacheReadTokens: tokenCount(cacheReadTokens),
          cacheCreationTokens: tokenCount(cacheCreationTokens),
        });
      } else {
        events.push({
          eventKind: 'unknown',
          eventId: eventId('invalid-usage'),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          raw,
        });
      }
    }
    return events;
  }

  if (message.role === 'toolResult') {
    const toolUseId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
    if (!toolUseId) {
      return [{
        eventKind: 'unknown',
        eventId: eventId('orphan-tool-result'),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        raw,
      }];
    }
    const content = openClawToolResultText(message.content);
    const hasRuntimeStatus = typeof message.isError === 'boolean';
    const inferredFailure = !hasRuntimeStatus && isToolResultFailureText(content);
    return [{
      eventKind: 'tool_result',
      eventId: eventId('tool-result'),
      sourceEventId,
      sourceIndex,
      sourceType,
      timestamp,
      callId: toolUseId,
      output: content,
      status: hasRuntimeStatus
        ? message.isError === true ? 'failure' : 'success'
        : inferredFailure ? 'failure' : 'unknown',
      statusSource: hasRuntimeStatus ? 'runtime' : inferredFailure ? 'inferred' : 'unknown',
    }];
  }

  return [{
    eventKind: 'unknown',
    eventId: eventId('unknown-role'),
    sourceEventId,
    sourceIndex,
    sourceType,
    timestamp,
    raw,
  }];
}

function isKnownOpenClawMetadataRecord(raw: CcRecord): boolean {
  if (raw.type === 'model_change') return true;
  if (raw.type !== 'custom') return false;
  return (raw as { customType?: unknown }).customType === 'model-snapshot';
}

function splitOpenClawRuntimeMetadata(text: string): string[] {
  const match = text.match(/^(Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*)([\s\S]*)$/);
  if (!match) return text ? [text] : [];
  const metadata = match[1].trim();
  const rest = match[2].trim();
  return rest ? [metadata, rest] : [metadata];
}

function normalizeOpenClawToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName === 'Read' && typeof input.path === 'string' && typeof input.file_path !== 'string') {
    return { ...input, file_path: input.path };
  }
  return input;
}

function openClawToolResultText(content: unknown): string {
  return openClawContentText(content);
}

function openClawContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (isRecordObject(part) && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidUsageCounters(
  input: unknown,
  output: unknown,
  cacheRead: unknown,
  cacheCreation: unknown,
): boolean {
  return isTokenCounter(input)
    && isTokenCounter(output)
    && (cacheRead === undefined || isTokenCounter(cacheRead))
    && (cacheCreation === undefined || isTokenCounter(cacheCreation));
}

function isTokenCounter(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const MARKDOWN_LOG_BLOCK_RE = /(?:^|\n)---\s*\n## \[([^\]]+)\] 对话记录[^\n]*\n([\s\S]*?)(?=\n---\s*\n## \[|$)/g;

function parseMarkdownLogFile(filePath: string): ParsedTraceFile {
  const fileSize = statSync(filePath).size;
  if (fileSize > MAX_MARKDOWN_LOG_BYTES) {
    throw new Error(
      `trace Markdown 日志超过 ${MAX_MARKDOWN_LOG_BYTES} 字节上限：${filePath}`,
    );
  }
  const content = readFileSync(filePath, 'utf-8');
  const sourceRecordCount = (content.match(/^## \[[^\]]+\] 对话记录.*$/gm) ?? []).length;
  if (!content.includes('### 用户输入') || !content.includes('### AI 回复')) {
    return {
      sessions: [],
      ingestion: {
        ...emptyTraceIngestionSummary(1),
        sourceRecordCount,
        malformedRecordCount: sourceRecordCount,
      },
    };
  }

  const sessions: TraceSession[] = [];
  const streamOccurrences = new Map<string, number>();
  let index = 0;

  for (const match of content.matchAll(MARKDOWN_LOG_BLOCK_RE)) {
    const timestamp = markdownLogTimestampToIso(match[1]);
    const body = match[2] ?? '';
    const blockCwd = body.match(/^\*\*工作目录\*\*:\s*(.+)$/m)?.[1]?.trim();
    const blockSessionId = body.match(/^\*\*会话 ID\*\*:\s*(.+)$/m)?.[1]?.trim();
    const explicitRequestId = body.match(/^\*\*请求 ID\*\*:\s*(.+)$/m)?.[1]?.trim();
    const userText = extractMarkdownLogSection(body, '### 用户输入', '### AI 回复');
    const assistantText = extractMarkdownLogSection(body, '### AI 回复');
    if (!userText && !assistantText) continue;

    const contentFingerprint = createHash('sha256')
      .update(`${userText}\u0000${assistantText}`)
      .digest('hex')
      .slice(0, 24);
    const requestId = explicitRequestId ?? contentFingerprint;
    const sessionId = blockSessionId || `${basename(filePath, '.log')}:${requestId}`;
    const streamKey = [
      blockSessionId ? `session:${blockSessionId}` : '',
      explicitRequestId ? `request:${explicitRequestId}` : `content:${contentFingerprint}`,
    ].join('\u0000');
    const streamOccurrence = streamOccurrences.get(streamKey) ?? 0;
    streamOccurrences.set(streamKey, streamOccurrence + 1);
    const cwd = blockCwd;
    const skill = extractMarkdownLogSkill(`${userText}\n${assistantText}`);
    const userContent = skill ? `<command-name>/${skill}</command-name>\n${userText}` : userText;
    const events: TraceEvent[] = [];
    if (userContent) {
      events.push({
        eventKind: 'message',
        eventId: `markdown-log-${requestId}-user-${index}`,
        sourceIndex: 0,
        sourceType: 'markdown:user',
        timestamp,
        role: 'user',
        origin: 'human',
        text: userContent,
      });
    }
    if (assistantText) {
      events.push({
        eventKind: 'message',
        eventId: `markdown-log-${requestId}-assistant-${index}`,
        sourceIndex: 1,
        sourceType: 'markdown:assistant',
        timestamp,
        role: 'assistant',
        origin: 'synthetic',
        text: assistantText,
        attributionSkill: skill ?? undefined,
      });
    }
    sessions.push({
      runId: sessionId,
      rootRunId: sessionId,
      traceId: createTraceId({
        sourceKind: 'markdown_log',
        runId: sessionId,
        sourcePath: filePath,
        streamId: `${streamKey}\u0000occurrence:${streamOccurrence}`,
      }),
      groupPath: dirname(filePath),
      role: 'standalone',
      label: `${basename(filePath)}#${requestId}`,
      sourcePath: filePath,
      sourceKind: 'markdown_log',
      events,
      cwd,
      entrypoint: 'markdown_log',
      startTimestamp: timestamp,
      endTimestamp: timestamp,
    });
    index += 1;
  }

  return {
    sessions,
    ingestion: {
      ...emptyTraceIngestionSummary(1),
      sourceRecordCount,
      parsedRecordCount: sessions.length,
      malformedRecordCount: Math.max(0, sourceRecordCount - sessions.length),
    },
  };
}

function markdownLogTimestampToIso(value: string): string | undefined {
  const m = value.match(
    /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*(Z|[+-]\d{2}:?\d{2})$/,
  );
  if (!m) return undefined;
  const rawOffset = m[7];
  if (!rawOffset) return undefined;
  const offset = rawOffset === 'Z' || rawOffset.includes(':')
    ? rawOffset
    : `${rawOffset.slice(0, 3)}:${rawOffset.slice(3)}`;
  return normalizeTraceTimestamp(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${offset}`,
  );
}

function extractMarkdownLogSection(body: string, startMarker: string, endMarker?: string): string {
  const start = body.indexOf(startMarker);
  if (start < 0) return '';
  const from = start + startMarker.length;
  const end = endMarker ? body.indexOf(endMarker, from) : -1;
  return body.slice(from, end >= 0 ? end : undefined).trim();
}
