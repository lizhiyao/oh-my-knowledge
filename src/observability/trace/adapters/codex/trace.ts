/** Codex rollout JSONL -> source-neutral Trace IR. */

import { basename } from 'node:path';
import type { TraceSession } from '../../trace-ir.js';
import {
  correlateTraceToolEvents,
  createTraceId,
  traceTimestampBounds,
} from '../../trace-ir.js';
import type { TraceSourceMetadata } from '../../../contracts/trace.js';
import { convertCodexRecords } from './record-conversion.js';
import { asCodexRecord, isObject, stringValue, type CodexRecord } from './record-fields.js';
import { isCodexEventMessageType, isCodexResponseItemType } from './protocol.js';

/**
 * 格式判定的最小单位：单条记录是否构成 Codex 格式的证据。「文件里是否存在这样一条记录」
 * 由 `source.ts` 的单遍扫描合成——判定不再每个格式各自把整档重解析一遍。
 */
export function codexFormatEvidence(value: unknown): boolean {
  const raw = asCodexRecord(value);
  if (!isObject(raw?.payload)) return false;
  const payloadType = stringValue(raw.payload.type);
  if (raw.type === 'session_meta') {
    return stringValue(raw.payload.id) !== undefined
      || stringValue(raw.payload.session_id) !== undefined;
  }
  if (raw.type === 'turn_context') {
    return stringValue(raw.payload.turn_id) !== undefined
      || stringValue(raw.payload.model) !== undefined;
  }
  if (raw.type === 'response_item') {
    return isCodexResponseItemType(payloadType);
  }
  return raw.type === 'event_msg'
    && isCodexEventMessageType(payloadType);
}

export function codexGuardianEvidence(value: unknown): boolean {
  const raw = asCodexRecord(value);
  if (raw?.type !== 'session_meta') return false;
  const payload = isObject(raw.payload) ? raw.payload : {};
  const source = isObject(payload.source) ? payload.source : {};
  const subagent = source.subagent;
  return (typeof subagent === 'string' && subagent === 'guardian')
    || (isObject(subagent) && stringValue(subagent.other) === 'guardian');
}

export function parseCodexSessionFile(filePath: string, rawRecords: unknown[]): TraceSession {
  // 逐条取，不 map：记录视图可能是按偏移惰性解析的，map 会把整份文件的解析结果一次留住。
  let meta: CodexRecord | undefined;
  for (let index = 0; index < rawRecords.length; index++) {
    const record = asCodexRecord(rawRecords[index]);
    if (record?.type !== 'session_meta') continue;
    meta = record;
    break;
  }
  const metaPayload = isObject(meta?.payload) ? meta.payload : {};
  const runId = stringValue(metaPayload.id)
    ?? stringValue(metaPayload.session_id)
    ?? basename(filePath).replace(/\.jsonl$/, '');
  const parentRunId = stringValue(metaPayload.parent_thread_id);
  const subagentKind = codexSubagentKind(metaPayload);
  const cwd = stringValue(metaPayload.cwd);
  const entrypoint = codexEntrypoint(metaPayload);
  const role = parentRunId || metaPayload.thread_source === 'subagent' || subagentKind
    ? 'subagent'
    : 'main';
  const events = correlateTraceToolEvents(convertCodexRecords(rawRecords, runId, cwd));
  const bounds = traceTimestampBounds([
    ...events.map((event) => event.timestamp),
    meta?.timestamp,
    metaPayload.timestamp,
  ]);

  return {
    runId,
    rootRunId: parentRunId ?? runId,
    parentRunId,
    traceId: createTraceId({ sourceKind: 'codex', runId, sourcePath: filePath }),
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
    ...bounds,
  };
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

function codexEntrypoint(metaPayload: Record<string, unknown>): string | undefined {
  const originator = stringValue(metaPayload.originator)?.toLowerCase().trim() ?? '';
  if (!originator) return undefined;
  if (originator.includes('desktop')) return 'codex-desktop';
  if (originator.includes('vscode')) return 'codex-vscode';
  if (originator.includes('sdk')) return 'codex-sdk';
  if (originator === 'claudian') return 'claudian';
  if (/(?:^|[-_ ])(?:cli|tui|exec)(?:$|[-_ ])/.test(originator)) return 'codex-cli';
  const normalized = originator.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized ? `codex-${normalized}` : undefined;
}

function codexSubagentKind(metaPayload: Record<string, unknown>): string | undefined {
  const source = isObject(metaPayload.source) ? metaPayload.source : {};
  const subagent = source.subagent;
  if (typeof subagent === 'string') return stringValue(subagent);
  return isObject(subagent) ? stringValue(subagent.other) : undefined;
}
