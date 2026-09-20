/** Claude Code session JSONL -> source-neutral Trace IR. */

import { basename, dirname } from 'node:path';
import type { TraceSession } from '../../trace-ir.js';
import {
  correlateTraceToolEvents,
  createTraceId,
  traceTimestampBounds,
} from '../../trace-ir.js';
import { isRecordObject } from '../jsonl-records.js';
import { claudeRecordToTraceEvents, isKnownClaudeRecordType } from './record-events.js';
import type { CcRecord } from './record-schema.js';

/**
 * 格式判定的最小单位：单条记录是否构成 Claude 格式的证据。「文件里是否存在这样一条记录」
 * 由 `source.ts` 的单遍扫描合成——判定不再每个格式各自把整档重解析一遍。
 *
 * 证据谓词都可能拿到带空洞的记录数组：整档路径把畸形行挡在数组外，惰性视图里畸形与非对象下标是
 * undefined。判定语义保持一致——空洞不是任何格式的证据。
 */
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

export function parseClaudeSessionFile(filePath: string, records: Array<CcRecord | undefined>): TraceSession {
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
