/** Codex rollout JSONL -> source-neutral Trace IR. */

import { basename } from 'node:path';
import { isToolResultFailureText } from './text-signals.js';
import type {
  TraceEvent,
  TraceMessageOrigin,
  TraceSession,
  TraceToolRef,
  TraceToolStatus,
} from './trace-ir.js';
import type { TraceSourceMetadata } from '../types/index.js';

interface CodexRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface McpCallEnd {
  callId: string;
  sourceIndex: number;
  timestamp?: string;
  isError?: boolean;
  status?: string;
  tool?: string;
  server?: string;
  output?: string;
}

export function isCodexJsonl(records: unknown[]): boolean {
  return records.some((record) => {
    const raw = asCodexRecord(record);
    return raw?.type === 'session_meta' && isObject(raw.payload);
  });
}

export function isCodexGuardianRollout(records: unknown[]): boolean {
  return records.some((record) => {
    const raw = asCodexRecord(record);
    if (raw?.type !== 'session_meta') return false;
    const payload = isObject(raw.payload) ? raw.payload : {};
    const source = isObject(payload.source) ? payload.source : {};
    const subagent = source.subagent;
    return (typeof subagent === 'string' && subagent === 'guardian')
      || (isObject(subagent) && stringValue(subagent.other) === 'guardian');
  });
}

export function parseCodexSessionFile(filePath: string, rawRecords: unknown[]): TraceSession {
  const meta = rawRecords.map(asCodexRecord).find((record) => record?.type === 'session_meta');
  const metaPayload = isObject(meta?.payload) ? meta.payload : {};
  const runId = stringValue(metaPayload.id)
    ?? stringValue(metaPayload.session_id)
    ?? basename(filePath).replace(/\.jsonl$/, '');
  const parentRunId = stringValue(metaPayload.parent_thread_id);
  const cwd = stringValue(metaPayload.cwd);
  const entrypoint = codexEntrypoint(metaPayload);
  const role = parentRunId || metaPayload.thread_source === 'subagent' ? 'subagent' : 'main';
  const events = convertCodexRecords(rawRecords, runId);
  const timestamps = events.map((event) => event.timestamp).filter((value): value is string => Boolean(value));

  return {
    runId,
    rootRunId: parentRunId ?? runId,
    parentRunId,
    traceId: `${runId}\u0000${filePath}`,
    groupPath: `codex:${parentRunId ?? runId}`,
    role,
    label: role === 'subagent' ? `subagent/${runId}` : `main/${basename(filePath)}`,
    sourcePath: filePath,
    sourceKind: 'codex',
    events,
    cwd,
    gitBranch: isObject(metaPayload.git) ? stringValue(metaPayload.git.branch) : undefined,
    entrypoint,
    sourceMetadata: codexSourceMetadata(rawRecords, metaPayload),
    startTimestamp: timestamps[0] ?? stringValue(meta?.timestamp) ?? stringValue(metaPayload.timestamp),
    endTimestamp: timestamps.at(-1),
  };
}

function convertCodexRecords(rawRecords: unknown[], runId: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  const mcpEnds = indexMcpCallEnds(rawRecords);
  const resultCallIds = new Set<string>();
  const hasResponseUser = hasResponseMessageRole(rawRecords, 'user');
  const hasResponseAssistant = hasResponseMessageRole(rawRecords, 'assistant');
  let activeModel: string | undefined;
  let activeTurnId: string | undefined;
  let previousTotalUsageFingerprint: string | undefined;

  rawRecords.forEach((value, sourceIndex) => {
    const record = asCodexRecord(value);
    if (!record) return;
    const timestamp = stringValue(record.timestamp);
    const payload = isObject(record.payload) ? record.payload : {};
    const payloadType = stringValue(payload.type);
    const eventId = (suffix: string): string => `${runId}:${sourceIndex}:${suffix}`;
    const base = { sourceIndex, sourceType: `${String(record.type ?? 'unknown')}:${payloadType ?? ''}`, timestamp, turnId: activeTurnId };

    if (record.type === 'turn_context') {
      activeModel = stringValue(payload.model) ?? activeModel;
      activeTurnId = stringValue(payload.turn_id) ?? activeTurnId;
      return;
    }

    if (record.type === 'response_item' && payloadType === 'message') {
      const role = stringValue(payload.role);
      const text = codexContentText(payload.content);
      if ((role === 'user' || role === 'assistant') && text) {
        events.push({
          ...base,
          eventKind: 'message',
          eventId: eventId('message'),
          role,
          origin: role === 'user' ? codexUserMessageOrigin(text) : 'synthetic',
          text,
          model: role === 'assistant' ? activeModel : undefined,
        });
      }
      return;
    }

    if (record.type === 'response_item' && payloadType === 'tool_search_call') {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `codex-tool-search-${sourceIndex}`;
      events.push(toolCallEvent(eventId('tool-call'), base, callId, { name: 'tool_search' }, parseToolInput(payload.arguments), activeModel));
      return;
    }

    if (record.type === 'response_item' && payloadType === 'tool_search_output') {
      const callId = stringValue(payload.call_id) ?? `codex-tool-search-${sourceIndex}`;
      const output = JSON.stringify({
        status: stringValue(payload.status),
        execution: stringValue(payload.execution),
        tools: summarizeDiscoveredTools(payload.tools),
      });
      events.push(toolResultEvent(eventId('tool-result'), base, callId, output, statusFromCodex(payload.status), 'runtime'));
      return;
    }

    if (record.type === 'response_item' && payloadType === 'web_search_call') {
      const callId = stringValue(payload.id) ?? `codex-web-search-${sourceIndex}`;
      events.push(toolCallEvent(eventId('tool-call'), base, callId, { name: 'web_search' }, isObject(payload.action) ? payload.action : {}, activeModel));
      events.push(toolResultEvent(
        eventId('tool-result'),
        base,
        callId,
        JSON.stringify({ status: stringValue(payload.status) }),
        statusFromCodex(payload.status),
        'runtime',
      ));
      return;
    }

    if (record.type === 'response_item' && payloadType === 'image_generation_call') {
      const callId = stringValue(payload.id) ?? `codex-image-generation-${sourceIndex}`;
      const result = typeof payload.result === 'string' ? payload.result : '';
      events.push(toolCallEvent(
        eventId('tool-call'),
        base,
        callId,
        { name: 'image_generation' },
        { prompt: stringValue(payload.revised_prompt) },
        activeModel,
      ));
      events.push(toolResultEvent(
        eventId('tool-result'),
        base,
        callId,
        JSON.stringify({ status: stringValue(payload.status), resultBytes: result.length }),
        statusFromCodex(payload.status),
        'runtime',
      ));
      return;
    }

    if (
      record.type === 'response_item'
      && (payloadType === 'function_call' || payloadType === 'custom_tool_call')
    ) {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `codex-call-${sourceIndex}`;
      const sourceName = stringValue(payload.name) ?? 'unknown';
      const normalized = normalizeCodexTool(sourceName, payload.arguments ?? payload.input, mcpEnds.get(callId));
      events.push(toolCallEvent(eventId('tool-call'), base, callId, normalized.tool, normalized.input, activeModel));
      return;
    }

    if (
      record.type === 'response_item'
      && (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')
    ) {
      const callId = stringValue(payload.call_id) ?? `codex-call-${sourceIndex}`;
      const mcpEnd = mcpEnds.get(callId);
      const output = codexContentText(payload.output) || mcpEnd?.output || '';
      const explicitStatus = mcpEndStatus(mcpEnd) ?? statusFromCodex(payload.status);
      const inferredFailure = isToolResultFailureText(output) || codexToolOutputFailed(output);
      events.push(toolResultEvent(
        eventId('tool-result'),
        base,
        callId,
        output,
        explicitStatus === 'unknown' ? (inferredFailure ? 'failure' : 'success') : explicitStatus,
        explicitStatus === 'unknown' ? 'inferred' : 'runtime',
      ));
      resultCallIds.add(callId);
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'token_count') {
      const info = isObject(payload.info) ? payload.info : {};
      const usage = isObject(info.last_token_usage) ? info.last_token_usage : undefined;
      if (!usage) return;
      const totalUsage = isObject(info.total_token_usage) ? info.total_token_usage : undefined;
      const fingerprint = tokenUsageFingerprint(totalUsage);
      if (fingerprint && fingerprint === previousTotalUsageFingerprint) return;
      previousTotalUsageFingerprint = fingerprint;
      const normalized = normalizeCodexTokenUsage(usage);
      events.push({
        ...base,
        eventKind: 'usage',
        eventId: eventId('usage'),
        model: activeModel,
        ...normalized,
      });
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'task_started') {
      activeTurnId = stringValue(payload.turn_id) ?? activeTurnId;
      events.push({
        ...base,
        turnId: activeTurnId,
        eventKind: 'lifecycle',
        eventId: eventId('lifecycle'),
        phase: 'turn_started',
      });
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'task_complete') {
      events.push({
        ...base,
        eventKind: 'lifecycle',
        eventId: eventId('lifecycle'),
        phase: 'turn_completed',
      });
      activeTurnId = undefined;
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'turn_aborted') {
      events.push({
        ...base,
        turnId: stringValue(payload.turn_id) ?? activeTurnId,
        eventKind: 'lifecycle',
        eventId: eventId('lifecycle'),
        phase: 'turn_aborted',
        reason: stringValue(payload.reason),
        durationMs: numberValue(payload.duration_ms),
      });
      activeTurnId = undefined;
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'user_message' && !hasResponseUser) {
      const text = stringValue(payload.message);
      if (text) {
        events.push({
          ...base,
          eventKind: 'message',
          eventId: eventId('message'),
          role: 'user',
          origin: codexUserMessageOrigin(text),
          text,
        });
      }
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'agent_message' && !hasResponseAssistant) {
      const text = stringValue(payload.message);
      if (text) {
        events.push({
          ...base,
          eventKind: 'message',
          eventId: eventId('message'),
          role: 'assistant',
          origin: 'synthetic',
          text,
          model: activeModel,
        });
      }
      return;
    }

    if (payloadType === 'mcp_tool_call_end') return;
    events.push({
      ...base,
      eventKind: 'unknown',
      eventId: eventId('unknown'),
      raw: value,
    });
  });

  for (const end of mcpEnds.values()) {
    if (resultCallIds.has(end.callId)) continue;
    const status = mcpEndStatus(end) ?? 'unknown';
    events.push({
      eventKind: 'tool_result',
      eventId: `${runId}:${end.sourceIndex}:mcp-tool-result`,
      sourceIndex: end.sourceIndex,
      sourceType: 'event_msg:mcp_tool_call_end',
      timestamp: end.timestamp,
      callId: end.callId,
      output: end.output ?? '',
      status,
      statusSource: status === 'unknown' ? 'unknown' : 'runtime',
    });
  }

  events.sort((a, b) => a.sourceIndex - b.sourceIndex);
  return events;
}

function toolCallEvent(
  eventId: string,
  base: Omit<TraceEventBase, 'eventId'>,
  callId: string,
  tool: TraceToolRef,
  input: Record<string, unknown>,
  model?: string,
): TraceEvent {
  return { ...base, eventKind: 'tool_call', eventId, callId, tool, input, model };
}

function toolResultEvent(
  eventId: string,
  base: Omit<TraceEventBase, 'eventId'>,
  callId: string,
  output: string,
  status: TraceToolStatus,
  statusSource: 'runtime' | 'inferred',
): TraceEvent {
  return { ...base, eventKind: 'tool_result', eventId, callId, output, status, statusSource };
}

interface TraceEventBase {
  sourceIndex: number;
  sourceType: string;
  timestamp?: string;
  turnId?: string;
  eventId: string;
}

function indexMcpCallEnds(records: unknown[]): Map<string, McpCallEnd> {
  const ends = new Map<string, McpCallEnd>();
  records.forEach((value, sourceIndex) => {
    const record = asCodexRecord(value);
    const payload = isObject(record?.payload) ? record.payload : {};
    if (payload.type !== 'mcp_tool_call_end') return;
    const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
    if (!callId) return;
    const invocation = isObject(payload.invocation) ? payload.invocation : {};
    const result = isObject(payload.result) ? payload.result : {};
    ends.set(callId, {
      callId,
      sourceIndex,
      timestamp: stringValue(record?.timestamp),
      isError: booleanValue(payload.isError) ?? booleanValue(payload.is_error) ?? booleanValue(result.isError) ?? booleanValue(result.is_error),
      status: stringValue(payload.status) ?? stringValue(result.status),
      tool: stringValue(invocation.tool) ?? stringValue(payload.tool),
      server: stringValue(invocation.server) ?? stringValue(invocation.provider) ?? stringValue(payload.server),
      output: codexContentText(payload.output ?? result.output ?? result.content),
    });
  });
  return ends;
}

function mcpEndStatus(end: McpCallEnd | undefined): TraceToolStatus | undefined {
  if (!end) return undefined;
  if (end.isError === true) return 'failure';
  if (end.isError === false) return 'success';
  return statusFromCodex(end.status);
}

function normalizeCodexTool(
  sourceName: string,
  rawInput: unknown,
  mcpEnd?: McpCallEnd,
): { tool: TraceToolRef; input: Record<string, unknown> } {
  const input = parseToolInput(rawInput);
  const lower = sourceName.toLowerCase();
  if (lower === 'exec_command') {
    return {
      tool: { name: 'Bash', sourceName },
      input: { ...input, command: stringValue(input.command) ?? stringValue(input.cmd) ?? '' },
    };
  }
  if (lower === 'apply_patch') return { tool: { name: 'Edit', sourceName }, input };
  if (lower === 'view_image') {
    return {
      tool: { name: 'ViewImage', sourceName },
      input: { ...input, file_path: stringValue(input.file_path) ?? stringValue(input.path) },
    };
  }
  if (lower === 'write_stdin') return { tool: { name: 'WriteStdin', sourceName }, input };

  const mcp = parseMcpToolName(sourceName, mcpEnd);
  if (mcp) return { tool: mcp, input };
  return { tool: { name: sourceName }, input };
}

function parseMcpToolName(sourceName: string, end?: McpCallEnd): TraceToolRef | null {
  if (!sourceName.startsWith('mcp__') && !end?.tool) return null;
  const parts = sourceName.split('__').filter(Boolean);
  const sourceLeaf = parts.at(-1) ?? sourceName;
  const namespace = parts.length > 1 ? parts.slice(0, -1).join('__') : undefined;
  const authoritative = end?.tool;
  const provider = end?.server;
  const displayName = authoritative
    ? authoritative.includes('.') || !provider ? authoritative : `${provider}.${authoritative}`
    : provider ? `${provider}.${sourceLeaf}` : sourceLeaf;
  return {
    name: displayName,
    sourceName,
    namespace,
    provider,
    displayName,
  };
}

function codexUserMessageOrigin(text: string): TraceMessageOrigin {
  const trimmed = text.trimStart();
  if (/^# AGENTS\.md instructions\b/i.test(trimmed)) return 'runtime';
  if (/^<(?:app-context|environment_context|permissions instructions|collaboration_mode|apps_instructions|plugins_instructions|skills_instructions|recommended_plugins)>/i.test(trimmed)) return 'runtime';
  return 'human';
}

function summarizeDiscoveredTools(value: unknown): Array<{ type?: string; name?: string; tools?: string[] }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isObject(entry)) return [];
    const nested = Array.isArray(entry.tools)
      ? entry.tools.flatMap((tool) => isObject(tool) && stringValue(tool.name) ? [stringValue(tool.name)!] : [])
      : undefined;
    return [{
      type: stringValue(entry.type),
      name: stringValue(entry.name),
      ...(nested && nested.length > 0 ? { tools: nested } : {}),
    }];
  });
}

function statusFromCodex(value: unknown): TraceToolStatus {
  const status = stringValue(value)?.toLowerCase();
  if (status === 'failed' || status === 'error') return 'failure';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'success' || status === 'succeeded' || status === 'completed' || status === 'complete') return 'success';
  return 'unknown';
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : { input: value };
  } catch {
    return { input: value };
  }
}

function codexContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value == null ? '' : JSON.stringify(value);
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!isObject(part)) return '';
    const text = stringValue(part.text) ?? stringValue(part.output_text);
    if (text) return text;
    return part.type === 'input_image' ? '[image]' : '';
  }).filter(Boolean).join('\n');
}

function codexToolOutputFailed(output: string): boolean {
  return /\b(?:process|script)\s+(?:exited|failed)\s+with\s+(?:exit\s+)?code\s+[1-9]\d*\b/i.test(output)
    || /\bexit[_\s-]?code\s*[:=]\s*[1-9]\d*\b/i.test(output)
    || /\bapply_patch verification failed\b/i.test(output);
}

function codexSourceMetadata(records: unknown[], metaPayload: Record<string, unknown>): TraceSourceMetadata {
  const models = Array.from(new Set(records.flatMap((value) => {
    const record = asCodexRecord(value);
    if (record?.type !== 'turn_context') return [];
    const payload = isObject(record.payload) ? record.payload : {};
    const model = stringValue(payload.model);
    return model ? [model] : [];
  })));
  return {
    provider: stringValue(metaPayload.model_provider) ?? 'openai',
    model: models.length > 0 ? models.join(', ') : undefined,
    modelApi: 'codex',
  };
}

function tokenUsageFingerprint(usage: Record<string, unknown> | undefined): string | undefined {
  if (!usage) return undefined;
  const keys = [
    'input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
    'total_tokens',
  ];
  const values = keys.map((key) => numberValue(usage[key]));
  if (values.every((value) => value === undefined)) return undefined;
  return values.map((value) => value ?? 0).join(':');
}

function normalizeCodexTokenUsage(usage: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens?: number;
} {
  const rawInput = numberValue(usage.input_tokens);
  const cacheRead = numberValue(usage.cached_input_tokens) ?? 0;
  const cacheCreation = numberValue(usage.cache_write_input_tokens) ?? 0;
  return {
    inputTokens: rawInput === undefined ? 0 : Math.max(0, rawInput - cacheRead - cacheCreation),
    outputTokens: numberValue(usage.output_tokens) ?? 0,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    reasoningTokens: numberValue(usage.reasoning_output_tokens),
  };
}

function codexEntrypoint(metaPayload: Record<string, unknown>): string {
  const originator = stringValue(metaPayload.originator)?.toLowerCase() ?? '';
  return originator.includes('desktop') ? 'codex-desktop' : 'codex-cli';
}

function hasResponseMessageRole(records: unknown[], role: string): boolean {
  return records.some((value) => {
    const record = asCodexRecord(value);
    if (record?.type !== 'response_item') return false;
    const payload = isObject(record.payload) ? record.payload : {};
    return payload.type === 'message' && payload.role === role;
  });
}

function asCodexRecord(value: unknown): CodexRecord | undefined {
  return isObject(value) ? value as CodexRecord : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
