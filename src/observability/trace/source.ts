/** Trace source loading and parsing for Claude / Codex / Qoder / OpenClaw JSONL and generic markdown logs. */

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
import { CODEX_RECORD_SCHEMA } from './codex-record-schema.js';
import { openStreamedJsonlRecords, streamedJsonlBytes } from './streamed-records.js';
import {
  codexFormatEvidence,
  codexGuardianEvidence,
  parseCodexSessionFile,
} from './adapters/codex/trace.js';
import {
  parseQoderSessionFile,
  qoderFormatEvidence,
} from './adapters/qoder/trace.js';
import {
  extractMarkdownLogSkill,
  isClaudeBuiltinCommand,
  stripCommandEnvelopeText,
} from './attribution.js';
import {
  isRuntimeProtocolPromptText,
  isSyntheticUserMessageText,
} from './message-classification.js';
import { isToolResultFailureText } from '../../executors/tool-call-status.js';
import type { TraceIngestionSummary, TraceSourceMetadata } from '../contracts/trace.js';
import type {
  TraceEvent,
  TraceCorpus,
  TraceLifecycleEvent,
  TraceMessageOrigin,
  TraceSession,
  TraceSourceKind,
  TraceUsageEvent,
} from './trace-ir.js';
import { normalizeToolIdentity } from '../../executors/core/tool-identity.js';
import {
  correlateTraceToolEvents,
  createTraceId,
  normalizeTraceTimestamp,
  traceTimestampBounds,
  unknownTraceEvent,
} from './trace-ir.js';
import { nonNegativeMetric, tokenCount } from '../../executors/core/token-usage.js';
import {
  emptyTraceIngestionSummary,
  mergeTraceIngestionSummaries,
} from './ingestion.js';

const TRACE_READ_CHUNK_BYTES = 64 * 1024;
const MAX_JSONL_RECORD_CHARS = 32 * 1024 * 1024;
/** 达到该大小的 Codex 日志走惰性记录视图；小文件按原路径整档解析更快。 */
const CODEX_STREAMED_MIN_BYTES = 16 * 1024 * 1024;
const MAX_MARKDOWN_LOG_BYTES = 64 * 1024 * 1024;

// ---------- Claude Code JSONL compatibility schema (v0.18 subset) ----------

export interface CcAssistantContent {
  type: 'thinking' | 'text' | 'tool_use' | 'reasoning';
  thinking?: string;
  /** Claude 的推理链签名；明文被脱敏时它是「这块确实存在」的唯一证据。 */
  signature?: string;
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

export type { TraceSourceMetadata } from '../contracts/trace.js';

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

/** 格式判定的最小单位：单条记录是否构成某一条证据；空洞（`undefined`）不是任何证据。 */
export type RecordEvidence = (value: unknown) => boolean;

export interface JsonlTraceAdapter {
  sourceKind: Exclude<TraceSourceKind, 'markdown_log' | 'unknown'>;
  /**
   * 判定该格式用到的证据子句。跨格式共享的子句必须是同一个函数引用（例如 claude 要让给
   * qoder 的那一条），单遍扫描才会对它只求值一次。
   */
  evidence: readonly RecordEvidence[];
  /** 用「这些证据是否在全档出现过」合成命中结果，组合方式与合并前的四个 `matches` 逐字一致。 */
  isMatch(have: (evidence: RecordEvidence) => boolean): boolean;
  parse(filePath: string, records: Array<CcRecord | undefined>): TraceSession;
  /** 唯一命中本条目时才会被查阅的「整份丢弃」证据（Codex 的子代理日志）。 */
  filterEvidence?: RecordEvidence;
}

const JSONL_TRACE_ADAPTERS: readonly JsonlTraceAdapter[] = [
  {
    sourceKind: 'codex',
    evidence: [codexFormatEvidence],
    isMatch: (have) => have(codexFormatEvidence),
    parse: parseCodexSessionFile,
    filterEvidence: codexGuardianEvidence,
  },
  {
    sourceKind: 'openclaw',
    evidence: [openClawSessionEvidence, openClawMessageEvidence],
    isMatch: (have) => have(openClawSessionEvidence) && have(openClawMessageEvidence),
    parse: parseOpenClawSessionFile,
  },
  {
    // Qoder transcripts reuse the Claude Code record vocabulary (`user` /
    // `assistant` + `sessionId` + `message`), so this entry has to win the
    // tie, and the Claude entry below has to give Qoder up.
    sourceKind: 'qoder',
    evidence: [qoderFormatEvidence],
    isMatch: (have) => have(qoderFormatEvidence),
    parse: parseQoderSessionFile,
  },
  {
    sourceKind: 'claude',
    evidence: [qoderFormatEvidence, claudeTranscriptEvidence, claudeMetadataEvidence],
    isMatch: (have) => !have(qoderFormatEvidence)
      && (have(claudeTranscriptEvidence) || have(claudeMetadataEvidence)),
    parse: parseClaudeSessionFile,
  },
];

export interface JsonlFormatDetection {
  /** 命中的条目，顺序与注册表一致；长度不为 1 时调用方按「格式不唯一」处理。 */
  matching: JsonlTraceAdapter[];
  /** 该证据是否在扫描里出现过——`filterEvidence` 只允许对唯一命中的条目查它。 */
  satisfied(evidence: RecordEvidence): boolean;
}

/**
 * 一趟记录遍历同时判定四个宿主格式与 Codex 的丢弃条件。
 *
 * 每条证据一旦在某条记录上成立就恒为真（记录级谓词只看那一条记录，与位置无关），所以已成立的
 * 子句不再求值，跨格式共享的子句（claude 让给 qoder 的那一条）也只算一次。合并前是「每个格式
 * 各自 `some` 一遍」，不成立的谓词等于把整档重扫一遍——惰性记录视图上每一轮都是一整趟全档解析。
 *
 * 布尔结果与合并前逐字相同：`some` 只回答「存在与否」，与遍历顺序、与其他谓词的求值时机无关；
 * 否定项要求「整档都没有」，它没成立时提前停止的条件就不满足，因此这一条必然扫完整档。提前停止
 * 唯一允许在「所有子句都已出现过」时发生。
 */
export function detectJsonlFormats(records: Iterable<CcRecord | undefined>): JsonlFormatDetection {
  const clauses: RecordEvidence[] = [];
  for (const adapter of JSONL_TRACE_ADAPTERS) {
    for (const evidence of adapter.filterEvidence
      ? [...adapter.evidence, adapter.filterEvidence]
      : adapter.evidence) {
      if (!clauses.includes(evidence)) clauses.push(evidence);
    }
  }
  const satisfied = new Set<RecordEvidence>();
  for (const record of records) {
    for (const evidence of clauses) {
      if (!satisfied.has(evidence) && evidence(record)) satisfied.add(evidence);
    }
    if (satisfied.size === clauses.length) break;
  }
  return {
    matching: JSONL_TRACE_ADAPTERS.filter((adapter) =>
      adapter.isMatch((evidence) => satisfied.has(evidence))
    ),
    satisfied: (evidence) => satisfied.has(evidence),
  };
}

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

export interface DetectedJsonlTrace {
  sourceKind: JsonlTraceAdapter['sourceKind'];
  session: TraceSession;
}

/**
 * 用与文件加载完全同源的判定归因一批内存中的 JSONL 记录。
 * 零个或多个适配器命中时返回 undefined：身份有歧义就不能静默归给某个来源。
 */
export function detectJsonlTraceSource(
  filePath: string,
  records: Array<CcRecord | undefined>,
): DetectedJsonlTrace | undefined {
  const { matching } = detectJsonlFormats(records);
  if (matching.length !== 1) return undefined;
  return { sourceKind: matching[0].sourceKind, session: matching[0].parse(filePath, records) };
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
  const streamed = parseStreamedCodexSessionFile(filePath);
  if (streamed) return streamed;
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
  const { matching: matchingAdapters, satisfied } = detectJsonlFormats(records);
  let session: TraceSession;
  if (matchingAdapters.length === 1) {
    const adapter = matchingAdapters[0];
    if (adapter.filterEvidence && satisfied(adapter.filterEvidence)) {
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
      // 文案不写单位：整档按字符判，惰性视图按字节判，同一个数值两条路径都要能报出同一句话。
      throw new Error(
        `trace JSONL 单条记录超过 ${MAX_JSONL_RECORD_CHARS} 上限：${filePath}`,
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

// 证据谓词都可能拿到带空洞的记录数组：整档路径把畸形行挡在数组外，惰性视图里畸形与非对象下标是
// undefined。判定语义保持一致——空洞不是任何格式的证据。
export function claudeTranscriptEvidence(value: unknown): boolean {
  if (!isRecordObject(value)) return false;
  return (value.type === 'assistant' || value.type === 'user')
    && typeof value.sessionId === 'string'
    && isRecordObject(value.message);
}

export function claudeMetadataEvidence(value: unknown): boolean {
  if (!isRecordObject(value)) return false;
  return isKnownClaudeRecordType(value.type) && typeof value.sessionId === 'string';
}

/**
 * Codex 的大会话日志走「偏移索引 ＋ 按声明装配一次」的记录读取层：适配器逻辑一行不改，只是每条
 * 记录只解它真正被消费的字段。其余宿主、小文件、以及格式判定不唯一的文件一律返回 undefined，
 * 由调用方走原有的整档解析路径。
 *
 * 判定这一趟只把整档扫一遍：`detectJsonlFormats` 把四个格式与丢弃条件合成一次遍历，每条记录
 * 只解析一次。合并前不匹配的谓词各自要把整档重扫一遍，在惰性视图上那就是一整轮重新解析，
 * 判定因此比映射本身还贵。
 */
function parseStreamedCodexSessionFile(filePath: string): ParsedTraceFile | undefined {
  if (streamedJsonlBytes(filePath) < CODEX_STREAMED_MIN_BYTES) return undefined;
  const view = openStreamedJsonlRecords<CcRecord>(filePath, CODEX_RECORD_SCHEMA);
  try {
    const { matching, satisfied } = detectJsonlFormats(view.values);
    if (matching.length !== 1 || matching[0].sourceKind !== 'codex') return undefined;
    const adapter = matching[0];
    if (adapter.filterEvidence && satisfied(adapter.filterEvidence)) {
      return { sessions: [], ingestion: streamedIngestion(view, 1) };
    }
    const session = adapter.parse(filePath, view.values);
    const ingestion = streamedIngestion(view, 0);
    return {
      sessions: [session],
      ingestion: {
        ...ingestion,
        unknownEventCount: session.events.filter((event) => event.eventKind === 'unknown').length,
      },
    };
  } finally {
    view.close();
  }
}

function streamedIngestion(
  view: { stats: () => { sourceRecordCount: number; malformedRecordCount: number; ignoredValueCount: number } },
  filteredSessionCount: number,
): TraceIngestionSummary {
  const stats = view.stats();
  return {
    fileCount: 1,
    sourceRecordCount: stats.sourceRecordCount,
    parsedRecordCount: stats.sourceRecordCount - stats.malformedRecordCount - stats.ignoredValueCount,
    malformedRecordCount: stats.malformedRecordCount,
    ignoredValueCount: stats.ignoredValueCount,
    unknownEventCount: 0,
    filteredSessionCount,
  };
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
    return [unknownTraceEvent(
      {
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp: normalizeTraceTimestamp(record.timestamp),
      },
      `${runId}:${sourceIndex}:unknown`,
      record,
    )];
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
    record ? claudeRecordToTraceEvents(record, runId, sourceIndex, 'claude') : []
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

function claudeRecordToTraceEvents(
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
      if (isRecordObject(part) && (part.type === 'thinking' || part.type === 'reasoning')) {
        // 两个来源的推理块字段名不同：Claude 是 thinking，AI SDK 族宿主是 reasoning + text。
        const reasoning = typeof part.thinking === 'string'
          ? part.thinking.trim()
          : typeof part.text === 'string'
            ? part.text.trim()
            : '';
        if (reasoning) {
          events.push({
            eventKind: 'model_activity',
            eventId: eventId(`model-activity-${partIndex}`),
            sourceEventId,
            sourceIndex,
            sourceType,
            timestamp,
            activityKind: 'reasoning',
            contentVisibility: 'plaintext',
            text: reasoning,
            contentSource: 'text',
            model,
          });
        } else if (typeof part.signature === 'string' && part.signature.trim()) {
          // 推理被脱敏成签名时只登记边界，不编造推理文本。
          events.push({
            eventKind: 'model_activity',
            eventId: eventId(`model-activity-${partIndex}`),
            sourceEventId,
            sourceIndex,
            sourceType,
            timestamp,
            activityKind: 'reasoning',
            contentVisibility: 'opaque',
            model,
          });
        }
        return;
      }
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
        return;
      }
      // 同族宿主复用 Claude 的落盘目录，但工具块是 AI SDK 命名：tool-call + toolCallId/toolName。
      if (
        isRecordObject(part)
        && part.type === 'tool-call'
        && typeof part.toolCallId === 'string'
        && typeof part.toolName === 'string'
      ) {
        events.push({
          eventKind: 'tool_call',
          eventId: eventId(`tool-call-${partIndex}`),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          callId: part.toolCallId,
          tool: normalizeToolIdentity({ sourceName: part.toolName }),
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
      events.push(usageEvent ?? unknownTraceEvent(
        { sourceEventId, sourceIndex, sourceType, timestamp },
        eventId('invalid-usage'),
        raw,
      ));
    }
    return events;
  }

  // 同族宿主把工具结果写成独立记录（type:"tool"），而不是 user 记录里的 tool_result 块。
  if (sourceType === 'tool' && isRecordObject(raw.message)) {
    const parts = Array.isArray(raw.message.content) ? raw.message.content : [];
    const events: TraceEvent[] = [];
    let partIndex = 0;
    for (const part of parts) {
      if (
        isRecordObject(part)
        && part.type === 'tool-result'
        && typeof part.toolCallId === 'string'
      ) {
        const output = claudeToolResultOutput(part.output);
        const explicit = typeof part.isError === 'boolean';
        const inferredFailure = !explicit && isToolResultFailureText(output);
        events.push({
          eventKind: 'tool_result',
          eventId: eventId(`tool-result-${partIndex}`),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          callId: part.toolCallId,
          output,
          status: explicit
            ? part.isError === true ? 'failure' : 'success'
            : inferredFailure ? 'failure' : 'unknown',
          statusSource: explicit ? 'runtime' : inferredFailure ? 'inferred' : 'unknown',
        });
      }
      partIndex += 1;
    }
    // 一块都没配上就退回 unknown 统计，别让新分支静默吞掉未知形态。
    if (events.length > 0) return events;
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
  return [unknownTraceEvent(
    { sourceEventId, sourceIndex, sourceType, timestamp },
    eventId('unknown'),
    raw,
  )];
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

/** 同族宿主的 tool-result.output 实测只有字符串与 `{type,value}` 两种包装；其余形态保留为 JSON，不静默丢证据。 */
function claudeToolResultOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecordObject(value) && typeof value.value === 'string') return value.value;
  return value === undefined ? '' : JSON.stringify(value);
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

export function openClawSessionEvidence(value: unknown): boolean {
  if (!isRecordObject(value)) return false;
  return value.type === 'session' && typeof value.id === 'string';
}

export function openClawMessageEvidence(value: unknown): boolean {
  if (!isRecordObject(value)) return false;
  return value.type === 'message' && isRecordObject(value.message);
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
    return [unknownTraceEvent(
      { sourceEventId, sourceIndex, sourceType, timestamp },
      eventId('unknown'),
      raw,
    )];
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
    return [unknownTraceEvent(
      { sourceEventId, sourceIndex, sourceType, timestamp },
      eventId('unknown-message'),
      raw,
    )];
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
        events.push(unknownTraceEvent(
          { sourceEventId, sourceIndex, sourceType, timestamp },
          eventId('invalid-usage'),
          raw,
        ));
      }
    }
    return events;
  }

  if (message.role === 'toolResult') {
    const toolUseId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
    if (!toolUseId) {
      return [unknownTraceEvent(
        { sourceEventId, sourceIndex, sourceType, timestamp },
        eventId('orphan-tool-result'),
        raw,
      )];
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

  return [unknownTraceEvent(
    { sourceEventId, sourceIndex, sourceType, timestamp },
    eventId('unknown-role'),
    raw,
  )];
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
