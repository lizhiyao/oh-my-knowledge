/** Trace source loading: discovery, JSONL reading, format detection and session grouping; per-host record parsing lives in adapters/. */

import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { openStreamedJsonlRecords, streamedJsonlBytes } from './streamed-records.js';
import {
  iterateZstdFramePlainText,
  ZstdDecodedSizeLimitError,
  ZstdDecompressionUnavailableError,
  ZstdFrameDecodeError,
} from './zstd-frames.js';
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
  claudeMetadataEvidence,
  claudeTranscriptEvidence,
  parseClaudeSessionFile,
} from './adapters/claude/trace.js';
import type { CcRecord } from './adapters/claude/record-schema.js';
import {
  openClawMessageEvidence,
  openClawSessionEvidence,
  parseOpenClawSessionFile,
} from './adapters/openclaw/trace.js';
import { parseMarkdownLogFile } from './adapters/markdown/trace.js';
import {
  dshEventEvidence,
  dshSessionHeaderEvidence,
  parseDshSessionFile,
} from './adapters/dsh/trace.js';
import { isRecordObject } from './adapters/jsonl-records.js';
import type { TraceIngestionSummary } from '../contracts/trace.js';
import type {
  TraceEvent,
  TraceCorpus,
  TraceSession,
  TraceSourceKind,
} from './trace-ir.js';
import {
  createTraceId,
  normalizeTraceTimestamp,
  traceTimestampBounds,
  unknownTraceEvent,
} from './trace-ir.js';
import {
  emptyTraceIngestionSummary,
  mergeTraceIngestionSummaries,
} from './ingestion.js';

const TRACE_READ_CHUNK_BYTES = 64 * 1024;
const MAX_JSONL_RECORD_CHARS = 32 * 1024 * 1024;
/** 达到该大小的 Codex 日志走惰性记录视图；小文件按原路径整档解析更快。 */
const CODEX_STREAMED_MIN_BYTES = 16 * 1024 * 1024;

// ---------- Claude Code JSONL compatibility schema (v0.18 subset) ----------

export type {
  CcAssistantContent,
  CcAssistantRecord,
  CcRecord,
  CcUserRecord,
  CcUserTextContent,
  CcUserToolResultContent,
} from './adapters/claude/record-schema.js';

export type { TraceSourceMetadata } from '../contracts/trace.js';

export type { TraceEvent, TraceSession } from './trace-ir.js';

export {
  claudeMetadataEvidence,
  claudeTranscriptEvidence,
} from './adapters/claude/trace.js';
export {
  openClawMessageEvidence,
  openClawSessionEvidence,
} from './adapters/openclaw/trace.js';

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
  {
    // DSH 的记录名都带斜杠命名空间（`assistant/message`、`tool/call`），与其余四个宿主的
    // 判定子句互斥，因此不参与争抢；放最后只为读表顺序稳定。
    sourceKind: 'dsh',
    evidence: [dshSessionHeaderEvidence, dshEventEvidence],
    isMatch: (have) => have(dshSessionHeaderEvidence) && have(dshEventEvidence),
    parse: parseDshSessionFile,
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
  // 压缩会话解压后就是同一份 JSONL 记录流，走与 .jsonl 完全同一条解析路径。
  if (filePath.endsWith('.jsonl') || isCompressedTraceFile(filePath)) {
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

/** 压缩会话的明文预算：按压缩后大小 × 放大上限算，真机实测放大 2.36 倍。 */
const TRACE_ZSTD_MAX_AMPLIFICATION = 4;

export function isCompressedTraceFile(filePath: string): boolean {
  return filePath.endsWith('.zstd');
}

function* readFileBytesChunks(filePath: string): Generator<Buffer, void, void> {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch (cause) {
    throw new Error(`无法读取 trace 输入文件：${filePath}`, { cause });
  }
  try {
    const buffer = Buffer.allocUnsafe(TRACE_READ_CHUNK_BYTES);
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    closeSync(fd);
  }
}

function* readTraceChunks(filePath: string): Generator<Buffer, void, void> {
  if (!isCompressedTraceFile(filePath)) {
    yield* readFileBytesChunks(filePath);
    return;
  }
  const budget = statSync(filePath).size * TRACE_ZSTD_MAX_AMPLIFICATION;
  yield* iterateZstdFramePlainText(filePath, budget);
}

/**
 * 按行回调一份 trace 文件，压缩与未压缩共用同一套守卫（单条记录字符上限、空行跳过、
 * `visit` 返回 false 提前停止）。归档器与知识提炼读的都是**原始**证据文件，所以分流必须
 * 在这里做，而不是让每个调用方各自判断该不该解压。
 */
export function forEachNonEmptyUtf8Line(
  filePath: string,
  visit: (trimmedLine: string) => boolean | void,
): void {
  const decoder = new StringDecoder('utf8');
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
    for (const chunk of readTraceChunks(filePath)) {
      if (stopped) return;
      pending += decoder.write(chunk);
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
      && (cause.message.startsWith('trace JSONL 单条记录超过')
        // 解压自身的分类错误原样上抛，采集侧要据此区分容量／格式／运行时能力。
        || cause instanceof ZstdFrameDecodeError
        || cause instanceof ZstdDecodedSizeLimitError
        || cause instanceof ZstdDecompressionUnavailableError)
    ) throw cause;
    throw new Error(`无法解析 trace 输入文件：${filePath}`, { cause });
  }
}

/**
 * Codex 的大会话日志走「按字节偏移索引的惰性记录」：适配器逻辑一行不改，只是记录对象不再
 * 整档常驻，实测 1.3 GiB 档的采集峰值从 3.6 GiB 降到 1.5 GiB。其余宿主、小文件、以及格式
 * 判定不唯一的文件一律返回 undefined，由调用方走原有的整档解析路径。
 *
 * 判定这一趟只把整档扫一遍：`detectJsonlFormats` 把四个格式与丢弃条件合成一次遍历，每条记录
 * 只解析一次。合并前不匹配的谓词各自要把整档重扫一遍，在惰性视图上那就是一整轮重新解析，
 * 判定因此比映射本身还贵。
 */
function parseStreamedCodexSessionFile(filePath: string): ParsedTraceFile | undefined {
  // 惰性视图按字节偏移索引原始文件；压缩文件里几 MB 无换行的密文会被当成一条超长“记录”，
  // 既索不到证据又会撞单条上限。压缩会话一律走整档解析（明文本来就由帧读取器分块交付）。
  if (isCompressedTraceFile(filePath)) return undefined;
  if (streamedJsonlBytes(filePath) < CODEX_STREAMED_MIN_BYTES) return undefined;
  const view = openStreamedJsonlRecords<CcRecord>(filePath);
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
