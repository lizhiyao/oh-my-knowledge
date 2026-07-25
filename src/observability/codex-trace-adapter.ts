/** Codex rollout JSONL -> omk's normalized Claude-shaped trace records. */

import { basename } from 'node:path';
import { isToolResultFailureText } from './text-signals.js';
import type {
  CcAssistantContent,
  CcAssistantRecord,
  CcRecord,
  CcSession,
  CcUserRecord,
} from './trace-source.js';
import type { TraceSourceMetadata } from '../types/index.js';

interface CodexRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

export function isCodexJsonl(records: CcRecord[]): boolean {
  return records.some((record) =>
    record.type === 'session_meta'
    && isObject((record as CodexRecord).payload),
  );
}

export function isCodexGuardianRollout(records: CcRecord[]): boolean {
  return records.some((record) => {
    if (record.type !== 'session_meta') return false;
    const raw = record as CodexRecord;
    const payload = isObject(raw.payload) ? raw.payload : {};
    const source = isObject(payload.source) ? payload.source : {};
    const subagent = source.subagent;
    return (typeof subagent === 'string' && subagent === 'guardian')
      || (isObject(subagent) && stringValue(subagent.other) === 'guardian');
  });
}

export function parseCodexSessionFile(filePath: string, rawRecords: CcRecord[]): CcSession {
  const meta = rawRecords.find((record) => record.type === 'session_meta') as CodexRecord | undefined;
  const metaPayload = isObject(meta?.payload) ? meta.payload : {};
  const sessionId = stringValue(metaPayload.id)
    ?? stringValue(metaPayload.session_id)
    ?? basename(filePath).replace(/\.jsonl$/, '');
  const parentThreadId = stringValue(metaPayload.parent_thread_id);
  const sessionGroupId = parentThreadId ?? sessionId;
  const cwd = stringValue(metaPayload.cwd);
  const entrypoint = codexEntrypoint(metaPayload);
  const traceRole = parentThreadId || metaPayload.thread_source === 'subagent'
    ? 'subagent'
    : 'main';
  const sourceMetadata = codexSourceMetadata(rawRecords, metaPayload);
  const records = convertCodexRecords(rawRecords, sessionId, cwd, entrypoint);
  const timestamps = records
    .map((record) => stringValue((record as { timestamp?: unknown }).timestamp))
    .filter((value): value is string => Boolean(value));

  return {
    sessionId,
    sessionGroupId,
    sessionGroupPath: `codex:${sessionGroupId}`,
    traceRole,
    traceLabel: traceRole === 'subagent' ? `subagent/${sessionId}` : `main/${basename(filePath)}`,
    sourcePath: filePath,
    sourceKind: 'codex',
    records,
    cwd,
    gitBranch: isObject(metaPayload.git) ? stringValue(metaPayload.git.branch) : undefined,
    entrypoint,
    sourceMetadata,
    startTimestamp: timestamps[0] ?? stringValue(meta?.timestamp) ?? stringValue(metaPayload.timestamp),
    endTimestamp: timestamps.at(-1),
  };
}

function convertCodexRecords(
  rawRecords: CcRecord[],
  sessionId: string,
  cwd: string | undefined,
  entrypoint: string,
): CcRecord[] {
  const records: CcRecord[] = [];
  const hasResponseUser = hasResponseMessageRole(rawRecords, 'user');
  const hasResponseAssistant = hasResponseMessageRole(rawRecords, 'assistant');
  let activeModel: string | undefined;
  let previousTotalUsageFingerprint: string | undefined;

  rawRecords.forEach((raw, index) => {
    const record = raw as CodexRecord;
    const timestamp = stringValue(record.timestamp) ?? new Date().toISOString();
    const payload = isObject(record.payload) ? record.payload : {};
    const payloadType = stringValue(payload.type);

    if (record.type === 'turn_context') {
      activeModel = stringValue(payload.model) ?? activeModel;
      return;
    }

    if (record.type === 'response_item' && payloadType === 'message') {
      const converted = convertCodexMessage(payload, sessionId, timestamp, cwd, entrypoint, index, activeModel);
      if (converted) records.push(converted);
      return;
    }

    if (record.type === 'response_item' && payloadType === 'tool_search_call') {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `codex-tool-search-${index}`;
      records.push(codexToolUseRecord({
        callId,
        id: stringValue(payload.id),
        name: 'tool_search',
        input: parseToolInput(payload.arguments),
        sessionId,
        timestamp,
        cwd,
        entrypoint,
        model: activeModel,
      }));
      return;
    }

    if (record.type === 'response_item' && payloadType === 'tool_search_output') {
      const callId = stringValue(payload.call_id) ?? `codex-tool-search-${index}`;
      const output = JSON.stringify({
        status: stringValue(payload.status),
        execution: stringValue(payload.execution),
        tools: summarizeDiscoveredTools(payload.tools),
      });
      records.push(codexToolResultRecord({
        callId,
        output,
        failed: codexStatusFailed(payload.status),
        sessionId,
        timestamp,
        entrypoint,
        index,
      }));
      return;
    }

    if (record.type === 'response_item' && payloadType === 'web_search_call') {
      const callId = stringValue(payload.id) ?? `codex-web-search-${index}`;
      records.push(codexToolUseRecord({
        callId,
        id: stringValue(payload.id),
        name: 'web_search',
        input: isObject(payload.action) ? payload.action : {},
        sessionId,
        timestamp,
        cwd,
        entrypoint,
        model: activeModel,
      }));
      records.push(codexToolResultRecord({
        callId,
        output: JSON.stringify({ status: stringValue(payload.status) }),
        failed: codexStatusFailed(payload.status),
        sessionId,
        timestamp,
        entrypoint,
        index,
      }));
      return;
    }

    if (record.type === 'response_item' && payloadType === 'image_generation_call') {
      const callId = stringValue(payload.id) ?? `codex-image-generation-${index}`;
      const result = typeof payload.result === 'string' ? payload.result : '';
      records.push(codexToolUseRecord({
        callId,
        id: stringValue(payload.id),
        name: 'image_generation',
        input: {
          prompt: stringValue(payload.revised_prompt),
        },
        sessionId,
        timestamp,
        cwd,
        entrypoint,
        model: activeModel,
      }));
      records.push(codexToolResultRecord({
        callId,
        output: JSON.stringify({
          status: stringValue(payload.status),
          resultBytes: result.length,
        }),
        failed: codexStatusFailed(payload.status),
        sessionId,
        timestamp,
        entrypoint,
        index,
      }));
      return;
    }

    if (
      record.type === 'response_item'
      && (payloadType === 'function_call' || payloadType === 'custom_tool_call')
    ) {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `codex-call-${index}`;
      const name = stringValue(payload.name) ?? 'unknown';
      const normalized = normalizeCodexTool(name, payload.arguments ?? payload.input);
      records.push({
        type: 'assistant',
        uuid: stringValue(payload.id) ?? callId,
        parentUuid: null,
        sessionId,
        timestamp,
        cwd,
        entrypoint,
        message: {
          role: 'assistant',
          model: activeModel,
          content: [{
            type: 'tool_use',
            id: callId,
            name: normalized.name,
            input: normalized.input,
          }],
        },
      } as CcAssistantRecord);
      return;
    }

    if (
      record.type === 'response_item'
      && (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')
    ) {
      const callId = stringValue(payload.call_id) ?? `codex-call-${index}`;
      const output = codexContentText(payload.output);
      records.push({
        type: 'user',
        uuid: `codex-output-${callId}-${index}`,
        parentUuid: null,
        sessionId,
        timestamp,
        entrypoint,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: callId,
            content: output,
            is_error: isToolResultFailureText(output) || codexToolOutputFailed(output),
          }],
        },
      } as CcUserRecord);
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'token_count') {
      const info = isObject(payload.info) ? payload.info : {};
      const usage = isObject(info.last_token_usage) ? info.last_token_usage : undefined;
      if (!usage) return;
      const totalUsage = isObject(info.total_token_usage) ? info.total_token_usage : undefined;
      const totalUsageFingerprint = tokenUsageFingerprint(totalUsage);
      if (
        totalUsageFingerprint
        && totalUsageFingerprint === previousTotalUsageFingerprint
      ) return;
      previousTotalUsageFingerprint = totalUsageFingerprint;
      records.push({
        type: 'assistant',
        uuid: `codex-usage-${index}`,
        parentUuid: null,
        sessionId,
        timestamp,
        cwd,
        entrypoint,
        message: {
          role: 'assistant',
          model: activeModel,
          content: [],
          usage: {
            input_tokens: numberValue(usage.input_tokens),
            output_tokens: numberValue(usage.output_tokens),
            cache_read_input_tokens: numberValue(usage.cached_input_tokens),
            cache_creation_input_tokens: numberValue(usage.cache_write_input_tokens),
          },
        },
      } as CcAssistantRecord);
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'task_started') {
      records.push({
        type: 'turn_started',
        sessionId,
        timestamp,
        turnId: stringValue(payload.turn_id),
      } as CcRecord);
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'task_complete') {
      records.push({
        type: 'turn_ended',
        sessionId,
        timestamp,
        turnId: stringValue(payload.turn_id),
      } as CcRecord);
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'user_message' && !hasResponseUser) {
      const message = stringValue(payload.message);
      if (!message) return;
      records.push(codexUserRecord(message, sessionId, timestamp, entrypoint, index));
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'agent_message' && !hasResponseAssistant) {
      const message = stringValue(payload.message);
      if (!message) return;
      records.push(codexAssistantRecord(message, sessionId, timestamp, cwd, entrypoint, index, undefined, activeModel));
    }
  });

  return records;
}

interface CodexToolUseRecordInput {
  callId: string;
  id?: string;
  name: string;
  input: Record<string, unknown>;
  sessionId: string;
  timestamp: string;
  cwd?: string;
  entrypoint: string;
  model?: string;
}

function codexToolUseRecord(input: CodexToolUseRecordInput): CcAssistantRecord {
  return {
    type: 'assistant',
    uuid: input.id ?? input.callId,
    parentUuid: null,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    cwd: input.cwd,
    entrypoint: input.entrypoint,
    message: {
      role: 'assistant',
      model: input.model,
      content: [{
        type: 'tool_use',
        id: input.callId,
        name: input.name,
        input: input.input,
      }],
    },
  };
}

interface CodexToolResultRecordInput {
  callId: string;
  output: string;
  failed: boolean;
  sessionId: string;
  timestamp: string;
  entrypoint: string;
  index: number;
}

function codexToolResultRecord(input: CodexToolResultRecordInput): CcUserRecord {
  return {
    type: 'user',
    uuid: `codex-output-${input.callId}-${input.index}`,
    parentUuid: null,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    entrypoint: input.entrypoint,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: input.callId,
        content: input.output,
        is_error: input.failed,
      }],
    },
  };
}

function summarizeDiscoveredTools(value: unknown): Array<{
  type?: string;
  name?: string;
  tools?: string[];
}> {
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

function codexStatusFailed(value: unknown): boolean {
  const status = stringValue(value)?.toLowerCase();
  return status === 'failed'
    || status === 'error'
    || status === 'cancelled'
    || status === 'canceled';
}

function convertCodexMessage(
  payload: Record<string, unknown>,
  sessionId: string,
  timestamp: string,
  cwd: string | undefined,
  entrypoint: string,
  index: number,
  model?: string,
): CcRecord | null {
  const role = stringValue(payload.role);
  const text = codexContentText(payload.content);
  if (role === 'user') return codexUserRecord(text, sessionId, timestamp, entrypoint, index);
  if (role === 'assistant') {
    return codexAssistantRecord(text, sessionId, timestamp, cwd, entrypoint, index, stringValue(payload.id), model);
  }
  return null;
}

function codexUserRecord(
  text: string,
  sessionId: string,
  timestamp: string,
  entrypoint: string,
  index: number,
): CcUserRecord {
  return {
    type: 'user',
    uuid: `codex-user-${index}`,
    parentUuid: null,
    sessionId,
    timestamp,
    entrypoint,
    message: { role: 'user', content: text },
  };
}

function codexAssistantRecord(
  text: string,
  sessionId: string,
  timestamp: string,
  cwd: string | undefined,
  entrypoint: string,
  index: number,
  id?: string,
  model?: string,
): CcAssistantRecord {
  const content: CcAssistantContent[] = text ? [{ type: 'text', text }] : [];
  return {
    type: 'assistant',
    uuid: id ?? `codex-assistant-${index}`,
    parentUuid: null,
    sessionId,
    timestamp,
    cwd,
    entrypoint,
    message: { role: 'assistant', model, content },
  };
}

function normalizeCodexTool(name: string, rawInput: unknown): {
  name: string;
  input: Record<string, unknown>;
} {
  const input = parseToolInput(rawInput);
  const lower = name.toLowerCase();
  if (lower === 'exec_command') {
    return {
      name: 'Bash',
      input: {
        ...input,
        command: stringValue(input.command) ?? stringValue(input.cmd) ?? '',
      },
    };
  }
  if (lower === 'apply_patch') return { name: 'Edit', input };
  if (lower === 'view_image') {
    return {
      name: 'ViewImage',
      input: {
        ...input,
        file_path: stringValue(input.file_path) ?? stringValue(input.path),
      },
    };
  }
  if (lower === 'write_stdin') return { name: 'WriteStdin', input };
  return { name, input };
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
    const text = stringValue(part.text);
    if (text) return text;
    return part.type === 'input_image' ? '[image]' : '';
  }).filter(Boolean).join('\n');
}

function codexToolOutputFailed(output: string): boolean {
  return /\b(?:process|script)\s+(?:exited|failed)\s+with\s+(?:exit\s+)?code\s+[1-9]\d*\b/i.test(output)
    || /\bexit[_\s-]?code\s*[:=]\s*[1-9]\d*\b/i.test(output)
    || /\bapply_patch verification failed\b/i.test(output);
}

function codexSourceMetadata(
  records: CcRecord[],
  metaPayload: Record<string, unknown>,
): TraceSourceMetadata {
  const models = Array.from(new Set(records.flatMap((record) => {
    if (record.type !== 'turn_context') return [];
    const raw = record as CodexRecord;
    const payload = isObject(raw.payload) ? raw.payload : {};
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

function codexEntrypoint(metaPayload: Record<string, unknown>): string {
  const originator = stringValue(metaPayload.originator)?.toLowerCase() ?? '';
  return originator.includes('desktop') ? 'codex-desktop' : 'codex-cli';
}

function hasResponseMessageRole(records: CcRecord[], role: string): boolean {
  return records.some((record) => {
    if (record.type !== 'response_item') return false;
    const raw = record as CodexRecord;
    const payload = isObject(raw.payload) ? raw.payload : {};
    return payload.type === 'message' && payload.role === role;
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
