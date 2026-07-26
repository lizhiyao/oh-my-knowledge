/** Trace source loading and parsing for Claude / Codex / OpenClaw JSONL and generic markdown logs. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import {
  isCodexGuardianRollout,
  isCodexJsonl,
  parseCodexSessionFile,
} from './codex-trace-adapter.js';
import { extractMarkdownLogSkill } from './trace-attribution.js';
import {
  isRuntimeProtocolPromptText,
  isSyntheticUserMessageText,
  isToolResultFailureText,
} from './text-signals.js';
import type { TraceSourceMetadata } from '../types/index.js';
import type {
  TraceEvent,
  TraceLifecycleEvent,
  TraceMessageOrigin,
  TraceSession,
  TraceUsageEvent,
} from './trace-ir.js';

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

export type { TraceSourceMetadata } from '../types/index.js';

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
  sourceKind?: 'claude' | 'codex' | 'openclaw' | 'markdown_log' | 'unknown';
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
  const stat = statSync(path);
  if (stat.isFile()) {
    return resolveCodexSessionGroups(
      parseTraceFile(path).map((session) => withStandaloneTraceMetadata(session)),
    );
  }
  const entries = collectTraceFiles(path);
  return resolveCodexSessionGroups(
    annotateSessionGroups(path, entries.flatMap(parseTraceFile)),
  );
}

/** @deprecated Use `loadTraceSessions`. */
export const loadCcSessions = loadTraceSessions;

function collectTraceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const entryPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...collectTraceFiles(entryPath));
    } else if (entry.endsWith('.jsonl') || entry.endsWith('.log')) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function parseTraceFile(filePath: string): TraceSession[] {
  if (filePath.endsWith('.jsonl')) {
    const session = parseJsonlSessionFile(filePath);
    return session ? [session] : [];
  }
  if (filePath.endsWith('.log')) return parseMarkdownLogFile(filePath);
  return [];
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
      traceId: traceIdFor(session),
      role,
      label: traceLabelFor(session.sourcePath, groupRoot, role),
    };
  });
}

function resolveCodexSessionGroups(sessions: TraceSession[]): TraceSession[] {
  const codexSessionsById = new Map(
    sessions
      .filter((session) => session.sourceKind === 'codex')
      .map((session) => [session.runId, session]),
  );

  return sessions.map((session) => {
    if (session.sourceKind !== 'codex') return session;
    const seen = new Set<string>([session.runId]);
    let groupId = session.rootRunId || session.runId;
    while (true) {
      if (seen.has(groupId)) {
        groupId = Array.from(seen).sort()[0] ?? session.runId;
        break;
      }
      seen.add(groupId);
      const parent = codexSessionsById.get(groupId);
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
      groupPath: `codex:${groupId}`,
    };
  });
}

function traceIdFor(session: Pick<TraceSession, 'runId' | 'sourcePath'>): string {
  return `${session.runId}\u0000${session.sourcePath}`;
}

function isSubagentTrace(filePath: string): boolean {
  return filePath.split('/').includes('subagents');
}

function subagentGroupRoot(filePath: string): string | undefined {
  const marker = '/subagents/';
  const index = filePath.indexOf(marker);
  if (index < 0) return undefined;
  return filePath.slice(0, index);
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

function parseJsonlSessionFile(filePath: string): TraceSession | null {
  const content = readFileSync(filePath, 'utf-8');
  const records: CcRecord[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as CcRecord);
    } catch {
      // malformed line → skip. cc 有罕见的截断 record, 不让单行 fail 整个 session
    }
  }
  if (isCodexJsonl(records)) {
    if (isCodexGuardianRollout(records)) return null;
    return parseCodexSessionFile(filePath, records);
  }
  return isOpenClawJsonl(records)
    ? parseOpenClawSessionFile(filePath, records)
    : parseClaudeSessionFile(filePath, records);
}

function parseClaudeSessionFile(filePath: string, records: CcRecord[]): TraceSession {
  const first = records.find((r) => 'sessionId' in r && typeof r.sessionId === 'string') as
    | (CcRecord & { sessionId: string; cwd?: string; gitBranch?: string; entrypoint?: string; timestamp?: string })
    | undefined;
  const last = [...records].reverse().find((r) => 'timestamp' in r && typeof r.timestamp === 'string') as
    | (CcRecord & { timestamp?: string })
    | undefined;
  const runId = first?.sessionId ?? filePath.split('/').pop()!.replace('.jsonl', '');
  const events = records.flatMap((record, sourceIndex) => legacyRecordToTraceEvents(record, runId, sourceIndex));
  return {
    runId,
    rootRunId: runId,
    traceId: `${runId}\u0000${filePath}`,
    groupPath: dirname(filePath),
    role: 'standalone',
    label: basename(filePath),
    sourcePath: filePath,
    sourceKind: 'claude',
    events,
    cwd: first?.cwd,
    gitBranch: first?.gitBranch,
    entrypoint: first?.entrypoint,
    startTimestamp: first?.timestamp,
    endTimestamp: last?.timestamp,
  };
}

export function legacyCcSessionToTraceSession(session: CcSession): TraceSession {
  const runId = session.sessionId;
  const rootRunId = session.sessionGroupId ?? runId;
  const traceId = session.traceId ?? `${runId}\u0000${session.sourcePath}`;
  const sourceKind = session.sourceKind ?? 'unknown';
  const events = session.records.flatMap((record, sourceIndex) =>
    legacyRecordToTraceEvents(record, runId, sourceIndex),
  );
  const timestamps = events
    .map((event) => event.timestamp)
    .filter((value): value is string => Boolean(value));
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
    startTimestamp: session.startTimestamp ?? timestamps[0],
    endTimestamp: session.endTimestamp ?? timestamps.at(-1),
  };
}

function legacyRecordToTraceEvents(raw: unknown, runId: string, sourceIndex: number): TraceEvent[] {
  if (!isRecordObject(raw)) return [];
  const sourceType = typeof raw.type === 'string' ? raw.type : 'unknown';
  const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : undefined;
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
        events.push({
          eventKind: 'message',
          eventId: eventId(`message-${partIndex}`),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          role: 'user',
          origin: classifyUserMessageOrigin(raw, part.text),
          text: part.text,
        });
      } else if (
        part.type === 'tool_result'
        && typeof part.tool_use_id === 'string'
      ) {
        const output = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
        const explicit = typeof part.is_error === 'boolean';
        const failed = part.is_error === true || (!explicit && isToolResultFailureText(output));
        events.push({
          eventKind: 'tool_result',
          eventId: eventId(`tool-result-${partIndex}`),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          callId: part.tool_use_id,
          output,
          status: failed ? 'failure' : 'success',
          statusSource: explicit ? 'runtime' : 'inferred',
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
          tool: { name: part.name },
          input: isRecordObject(part.input) ? part.input : {},
          model,
        });
      }
    });
    if (isRecordObject(raw.message.usage)) {
      events.push(usageEventFromLegacy(raw.message.usage, eventId('usage'), sourceIndex, sourceType, timestamp, model));
    }
    return events;
  }

  const lifecycle = lifecycleEventFromLegacy(raw, runId, sourceIndex, sourceType, timestamp);
  if (lifecycle) return [lifecycle];
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

function usageEventFromLegacy(
  usage: Record<string, unknown>,
  eventId: string,
  sourceIndex: number,
  sourceType: string,
  timestamp?: string,
  model?: string,
): TraceUsageEvent {
  return {
    eventKind: 'usage',
    eventId,
    sourceIndex,
    sourceType,
    timestamp,
    model,
    inputTokens: numberValue(usage.input_tokens) ?? 0,
    outputTokens: numberValue(usage.output_tokens) ?? 0,
    cacheReadTokens: numberValue(usage.cache_read_input_tokens) ?? 0,
    cacheCreationTokens: numberValue(usage.cache_creation_input_tokens) ?? 0,
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
    durationMs: numberValue(raw.durationMs),
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

function parseOpenClawSessionFile(filePath: string, rawRecords: CcRecord[]): TraceSession {
  const sessionRecord = rawRecords.find((record) => record.type === 'session') as
    | { id?: unknown; cwd?: unknown; timestamp?: unknown }
    | undefined;
  const sessionId = typeof sessionRecord?.id === 'string'
    ? sessionRecord.id
    : filePath.split('/').pop()!.replace(/\.jsonl$/, '');
  const cwd = typeof sessionRecord?.cwd === 'string' ? sessionRecord.cwd : undefined;
  const sourceMetadata = extractOpenClawSourceMetadata(rawRecords);
  const events: TraceEvent[] = [];

  rawRecords.forEach((raw, sourceIndex) => {
    const converted = convertOpenClawRecord(raw, sessionId, cwd);
    if (converted) {
      events.push(...legacyRecordToTraceEvents(converted, sessionId, sourceIndex));
    } else if (isSessionBoundaryRawRecord(raw)) {
      events.push(...legacyRecordToTraceEvents({ ...raw, sessionId }, sessionId, sourceIndex));
    }
  });
  const timestamps = events.map((event) => event.timestamp).filter((value): value is string => Boolean(value));

  return {
    runId: sessionId,
    rootRunId: sessionId,
    traceId: `${sessionId}\u0000${filePath}`,
    groupPath: dirname(filePath),
    role: 'standalone',
    label: basename(filePath),
    sourcePath: filePath,
    sourceKind: 'openclaw',
    events,
    cwd,
    entrypoint: 'openclaw',
    sourceMetadata,
    startTimestamp: timestamps[0] ?? (typeof sessionRecord?.timestamp === 'string' ? sessionRecord.timestamp : undefined),
    endTimestamp: timestamps.at(-1),
  };
}

function extractOpenClawSourceMetadata(rawRecords: CcRecord[]): TraceSourceMetadata {
  const meta: TraceSourceMetadata = {};
  const commands = new Set<string>();
  for (const raw of rawRecords) {
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

function convertOpenClawRecord(raw: CcRecord, sessionId: string, cwd?: string): CcRecord | null {
  if (raw.type !== 'message') return null;
  const messageRecord = raw as {
    id?: unknown;
    parentId?: unknown;
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
  if (!message || typeof message.role !== 'string') return null;
  const uuid = typeof messageRecord.id === 'string' ? messageRecord.id : `${sessionId}-${recordsafeTimestamp(messageRecord.timestamp)}`;
  const parentUuid = typeof messageRecord.parentId === 'string' ? messageRecord.parentId : null;
  const timestamp = typeof messageRecord.timestamp === 'string' ? messageRecord.timestamp : new Date().toISOString();

  if (message.role === 'user') {
    return {
      type: 'user',
      uuid,
      parentUuid,
      sessionId,
      timestamp,
      entrypoint: 'openclaw',
      message: {
        role: 'user',
        content: openClawTextParts(message.content),
      },
    } as CcUserRecord;
  }

  if (message.role === 'assistant') {
    return {
      type: 'assistant',
      uuid,
      parentUuid,
      sessionId,
      timestamp,
      cwd,
      entrypoint: 'openclaw',
      message: {
        role: 'assistant',
        model: typeof message.model === 'string' ? message.model : undefined,
        content: openClawAssistantContent(message.content),
        stop_reason: typeof message.stopReason === 'string' ? message.stopReason : undefined,
        usage: openClawUsage(message.usage),
      },
    } as CcAssistantRecord;
  }

  if (message.role === 'toolResult') {
    const toolUseId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
    if (!toolUseId) return null;
    const content = openClawToolResultText(message.content);
    return {
      type: 'user',
      uuid,
      parentUuid,
      sessionId,
      timestamp,
      entrypoint: 'openclaw',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: message.isError === true || isToolResultFailureText(content),
        }],
      },
    } as CcUserRecord;
  }

  return null;
}

function isSessionBoundaryRawRecord(raw: CcRecord): boolean {
  const type = typeof raw.type === 'string' ? raw.type : '';
  return /^session[._-](?:started|ended)$/i.test(type);
}

function recordsafeTimestamp(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_-]/g, '') : Math.random().toString(36).slice(2);
}

function openClawTextParts(content: unknown): CcUserTextContent[] {
  const text = openClawContentText(content);
  const split = splitOpenClawRuntimeMetadata(text);
  return split.map((part) => ({ type: 'text', text: part }));
}

function splitOpenClawRuntimeMetadata(text: string): string[] {
  const match = text.match(/^(Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*)([\s\S]*)$/);
  if (!match) return text ? [text] : [];
  const metadata = match[1].trim();
  const rest = match[2].trim();
  return rest ? [metadata, rest] : [metadata];
}

function openClawAssistantContent(content: unknown): CcAssistantContent[] {
  if (!Array.isArray(content)) return [];
  const parts: CcAssistantContent[] = [];
  for (const part of content) {
    if (!isRecordObject(part) || typeof part.type !== 'string') continue;
    if (part.type === 'thinking') {
      parts.push({ type: 'thinking', thinking: typeof part.thinking === 'string' ? part.thinking : '' });
      continue;
    }
    if (part.type === 'text') {
      parts.push({ type: 'text', text: typeof part.text === 'string' ? part.text : '' });
      continue;
    }
    if (part.type === 'toolCall') {
      const id = typeof part.id === 'string' ? part.id : undefined;
      const name = typeof part.name === 'string' ? normalizeOpenClawToolName(part.name) : undefined;
      if (!id || !name) continue;
      parts.push({
        type: 'tool_use',
        id,
        name,
        input: normalizeOpenClawToolInput(name, isRecordObject(part.arguments) ? part.arguments : {}),
      });
    }
  }
  return parts;
}

function normalizeOpenClawToolName(name: string): string {
  const normalized = name.trim();
  const lower = normalized.toLowerCase();
  if (lower === 'read') return 'Read';
  if (lower === 'grep' || lower === 'search') return 'Grep';
  // OpenClaw uses exec/run/shell labels for command execution; collapse them for tool-count comparability.
  if (lower === 'bash' || lower === 'shell' || lower === 'run' || lower === 'exec') return 'Bash';
  if (lower === 'edit') return 'Edit';
  if (lower === 'write') return 'Write';
  return normalized;
}

function normalizeOpenClawToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName === 'Read' && typeof input.path === 'string' && typeof input.file_path !== 'string') {
    return { ...input, file_path: input.path };
  }
  return input;
}

function openClawUsage(value: unknown): CcAssistantRecord['message']['usage'] | undefined {
  if (!isRecordObject(value)) return undefined;
  return {
    input_tokens: numberValue(value.input ?? value.input_tokens),
    output_tokens: numberValue(value.output ?? value.output_tokens),
    cache_read_input_tokens: numberValue(value.cacheRead ?? value.cache_read_input_tokens),
    cache_creation_input_tokens: numberValue(value.cacheWrite ?? value.cache_creation_input_tokens),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

const MARKDOWN_LOG_BLOCK_RE = /(?:^|\n)---\s*\n## \[([^\]]+)\] 对话记录[^\n]*\n([\s\S]*?)(?=\n---\s*\n## \[|$)/g;

function parseMarkdownLogFile(filePath: string): TraceSession[] {
  const content = readFileSync(filePath, 'utf-8');
  if (!content.includes('### 用户输入') || !content.includes('### AI 回复')) return [];

  const sessions: TraceSession[] = [];
  let index = 0;

  for (const match of content.matchAll(MARKDOWN_LOG_BLOCK_RE)) {
    const timestamp = markdownLogTimestampToIso(match[1]);
    const body = match[2] ?? '';
    const blockCwd = body.match(/^\*\*工作目录\*\*:\s*(.+)$/m)?.[1]?.trim();
    const blockSessionId = body.match(/^\*\*会话 ID\*\*:\s*(.+)$/m)?.[1]?.trim();
    const requestId = body.match(/^\*\*请求 ID\*\*:\s*(.+)$/m)?.[1]?.trim() ?? String(index);
    const userText = extractMarkdownLogSection(body, '### 用户输入', '### AI 回复');
    const assistantText = extractMarkdownLogSection(body, '### AI 回复');
    if (!userText && !assistantText) continue;

    const sessionId = blockSessionId || `${filePath.split('/').pop()!.replace(/\.log$/, '')}:${requestId}`;
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
      traceId: `${sessionId}\u0000${filePath}\u0000${requestId}`,
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

  return sessions;
}

function markdownLogTimestampToIso(value: string): string {
  const m = value.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return new Date().toISOString();
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
}

function extractMarkdownLogSection(body: string, startMarker: string, endMarker?: string): string {
  const start = body.indexOf(startMarker);
  if (start < 0) return '';
  const from = start + startMarker.length;
  const end = endMarker ? body.indexOf(endMarker, from) : -1;
  return body.slice(from, end >= 0 ? end : undefined).trim();
}
