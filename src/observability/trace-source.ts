/** Trace source loading and parsing for Claude JSONL / OpenClaw JSONL / generic markdown logs. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { extractMarkdownLogSkill } from './trace-attribution.js';

// ---------- cc session JSONL raw schema (v0.18 subset) ----------

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

export interface TraceSourceMetadata {
  channel?: string;
  sender?: string;
  senderId?: string;
  provider?: string;
  model?: string;
  modelApi?: string;
  aimaCommands?: string[];
}

// ---------- Session-level structure ----------

export interface CcSession {
  sessionId: string;
  /**
   * Logical parent session. For a directory shaped as:
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
  sourceKind?: 'claude' | 'openclaw' | 'markdown_log' | 'unknown';
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

// ---------- Load ----------

/**
 * 加载一个目录(或单个 JSONL/agent markdown log 文件)下的所有 session。
 * 递归扫描目录,覆盖 Claude Code 主 session 旁边的 subagents/*.jsonl,
 * 也支持 agent workspace/logs/*.log 里的 Markdown 对话记录。
 */
export function loadCcSessions(path: string): CcSession[] {
  const stat = statSync(path);
  if (stat.isFile()) {
    return parseTraceFile(path).map((session) => withStandaloneTraceMetadata(session));
  }
  const entries = collectTraceFiles(path);
  return annotateSessionGroups(path, entries.flatMap(parseTraceFile));
}

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

function parseTraceFile(filePath: string): CcSession[] {
  if (filePath.endsWith('.jsonl')) return [parseJsonlSessionFile(filePath)];
  if (filePath.endsWith('.log')) return parseMarkdownLogFile(filePath);
  return [];
}

function withStandaloneTraceMetadata(session: CcSession): CcSession {
  return {
    ...session,
    sessionGroupId: session.sessionId,
    sessionGroupPath: dirname(session.sourcePath),
    traceId: traceIdFor(session),
    traceRole: session.traceRole ?? 'standalone',
    traceLabel: session.traceLabel ?? basename(session.sourcePath),
  };
}

function annotateSessionGroups(rootPath: string, sessions: CcSession[]): CcSession[] {
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
    groupIdByRoot.set(root, mainSession?.sessionId || basename(root) || relative(dirname(rootPath), root) || root);
  }

  return sessions.map((session) => {
    const groupRoot = groupRootForPath(session.sourcePath, groupRoots);
    if (!groupRoot) return withStandaloneTraceMetadata(session);
    const role = isSubagentTrace(session.sourcePath) ? 'subagent' : 'main';
    return {
      ...session,
      sessionGroupId: groupIdByRoot.get(groupRoot) ?? session.sessionId,
      sessionGroupPath: groupRoot,
      traceId: traceIdFor(session),
      traceRole: role,
      traceLabel: traceLabelFor(session.sourcePath, groupRoot, role),
    };
  });
}

function traceIdFor(session: CcSession): string {
  return `${session.sessionId}\u0000${session.sourcePath}`;
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

function parseJsonlSessionFile(filePath: string): CcSession {
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
  return isOpenClawJsonl(records) ? parseOpenClawSessionFile(filePath, records) : parseCcSessionFile(filePath, records);
}

function parseCcSessionFile(filePath: string, records: CcRecord[]): CcSession {
  const first = records.find((r) => 'sessionId' in r && typeof r.sessionId === 'string') as
    | (CcRecord & { sessionId: string; cwd?: string; gitBranch?: string; entrypoint?: string; timestamp?: string })
    | undefined;
  const last = [...records].reverse().find((r) => 'timestamp' in r && typeof r.timestamp === 'string') as
    | (CcRecord & { timestamp?: string })
    | undefined;
  return {
    sessionId: first?.sessionId ?? filePath.split('/').pop()!.replace('.jsonl', ''),
    sourcePath: filePath,
    sourceKind: 'claude',
    records,
    cwd: first?.cwd,
    gitBranch: first?.gitBranch,
    entrypoint: first?.entrypoint,
    startTimestamp: first?.timestamp,
    endTimestamp: last?.timestamp,
  };
}

function isOpenClawJsonl(records: CcRecord[]): boolean {
  return records.some((record) => record.type === 'session' && typeof (record as { id?: unknown }).id === 'string')
    && records.some((record) => record.type === 'message' && isRecordObject((record as { message?: unknown }).message));
}

function parseOpenClawSessionFile(filePath: string, rawRecords: CcRecord[]): CcSession {
  const sessionRecord = rawRecords.find((record) => record.type === 'session') as
    | { id?: unknown; cwd?: unknown; timestamp?: unknown }
    | undefined;
  const sessionId = typeof sessionRecord?.id === 'string'
    ? sessionRecord.id
    : filePath.split('/').pop()!.replace(/\.jsonl$/, '');
  const cwd = typeof sessionRecord?.cwd === 'string' ? sessionRecord.cwd : undefined;
  const sourceMetadata = extractOpenClawSourceMetadata(rawRecords);
  const records: CcRecord[] = [];

  for (const raw of rawRecords) {
    const converted = convertOpenClawRecord(raw, sessionId, cwd);
    if (converted) records.push(converted);
  }

  const first = records.find((record) => typeof (record as { timestamp?: unknown }).timestamp === 'string') as
    | { timestamp?: string }
    | undefined;
  const last = [...records].reverse().find((record) => typeof (record as { timestamp?: unknown }).timestamp === 'string') as
    | { timestamp?: string }
    | undefined;

  return {
    sessionId,
    sourcePath: filePath,
    sourceKind: 'openclaw',
    records,
    cwd,
    entrypoint: 'openclaw',
    sourceMetadata,
    startTimestamp: first?.timestamp ?? (typeof sessionRecord?.timestamp === 'string' ? sessionRecord.timestamp : undefined),
    endTimestamp: last?.timestamp,
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
    for (const name of extractAimaCommandNames(text)) commands.add(name);
    const conversationInfo = extractOpenClawConversationInfo(text);
    if (conversationInfo.channel) meta.channel = conversationInfo.channel;
    if (conversationInfo.sender) meta.sender = conversationInfo.sender;
    if (conversationInfo.senderId) meta.senderId = conversationInfo.senderId;
  }
  if (commands.size > 0) meta.aimaCommands = Array.from(commands).sort();
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

function extractAimaCommandNames(text: string): string[] {
  const names: string[] = [];
  const re = /<aima-cmd\b[^>]*\bname=["']([^"']+)["'][^>]*>/g;
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
          content: openClawToolResultText(message.content),
          is_error: message.isError === true,
        }],
      },
    } as CcUserRecord;
  }

  return null;
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
  if (lower === 'bash' || lower === 'shell' || lower === 'run') return 'Bash';
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

function parseMarkdownLogFile(filePath: string): CcSession[] {
  const content = readFileSync(filePath, 'utf-8');
  if (!content.includes('### 用户输入') || !content.includes('### AI 回复')) return [];

  const sessions: CcSession[] = [];
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
    const records: CcRecord[] = [{
      type: 'user',
      uuid: `markdown-log-${requestId}-user-${index}`,
      parentUuid: null,
      sessionId,
      timestamp,
      message: { role: 'user', content: userContent },
    } as CcUserRecord, {
      type: 'assistant',
      uuid: `markdown-log-${requestId}-assistant-${index}`,
      parentUuid: `markdown-log-${requestId}-user-${index}`,
      sessionId,
      timestamp,
      cwd,
      attributionSkill: skill,
      message: {
        role: 'assistant',
        content: assistantText ? [{ type: 'text', text: assistantText }] : [],
        stop_reason: 'end_turn',
      },
    } as CcAssistantRecord];
    sessions.push({
      sessionId,
      sourcePath: filePath,
      sourceKind: 'markdown_log',
      records,
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
