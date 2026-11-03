/** OpenClaw session JSONL -> source-neutral Trace IR. */

import { basename, dirname } from 'node:path';
import type { TraceSession } from '../../trace-ir.js';
import {
  correlateTraceToolEvents,
  createTraceId,
  traceTimestampBounds,
} from '../../trace-ir.js';
import type { TraceSourceMetadata } from '../../../contracts/trace.js';
import { isRecordObject } from '../jsonl-records.js';
import {
  asOpenClawRecord,
  openClawContentText,
  openClawRecordToTraceEvents,
  type OpenClawRecord,
} from './record-events.js';

/**
 * 格式判定的最小单位：单条记录是否构成 OpenClaw 格式的证据。「文件里是否存在这样一条记录」
 * 由 `source.ts` 的单遍扫描合成——判定不再每个格式各自把整档重解析一遍。
 */
export function openClawSessionEvidence(value: unknown): boolean {
  if (!isRecordObject(value)) return false;
  return value.type === 'session' && typeof value.id === 'string';
}

export function openClawMessageEvidence(value: unknown): boolean {
  if (!isRecordObject(value)) return false;
  return value.type === 'message' && isRecordObject(value.message);
}

export function parseOpenClawSessionFile(filePath: string, rawRecords: unknown[]): TraceSession {
  const records = rawRecords.map(asOpenClawRecord);
  const sessionRecord = records.find((record) => record?.type === 'session') as
    | { id?: unknown; cwd?: unknown; timestamp?: unknown }
    | undefined;
  const sessionId = typeof sessionRecord?.id === 'string'
    ? sessionRecord.id
    : basename(filePath, '.jsonl');
  const cwd = typeof sessionRecord?.cwd === 'string' ? sessionRecord.cwd : undefined;
  const sourceMetadata = extractOpenClawSourceMetadata(records);
  const events = correlateTraceToolEvents(records.flatMap((raw, sourceIndex) =>
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

function extractOpenClawSourceMetadata(rawRecords: Array<OpenClawRecord | undefined>): TraceSourceMetadata {
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
