/**
 * DSH 磁盘会话（`~/.dsh/sessions/<cwd>/<session>/session.jsonl.zstd`）→ source-neutral Trace IR。
 *
 * 磁盘事件流与插件运行时喂给 `src/dsh-plugin/trace-adapter.ts` 的那套**不是同一个形状**：
 * 磁盘 header 没有 `seedLength`，工具结果的身份藏在 `data.message.content[].toolCallId`
 * 而不是 `data.toolCallId`（本机 10 份会话实测：678 个结果块的 toolCallId 全部命中
 * `tool/call.data.callId`，0 未命中，1 条 `isError=true`）。因此这里独立实现，不复用插件侧，
 * 也不反向依赖插件宿主。
 *
 * 只映射「有身份可依据」的族：
 * - `session` 头 → 会话身份／cwd／父会话；`session/title` → label
 * - `user/message`、`assistant/message`（含 usage 与 reasoning 块）
 * - `tool/call` ↔ `tool/result`（按 `toolCallId` 配对，状态取宿主自报的 `isError`）
 * - `turn/start|end`、`step/start|end` → 生命周期
 *
 * `reasoning-chunks`／`assistant/chunk`／`tool-call-chunks` 是同一事实的增量投递（本机占语料
 * 83%），刻意不映射成正牌事件——映射会把 token 与事件数放大数倍；它们仍以未识别事件保留原始
 * 证据，由 `unknown-disposition.ts` 的族表按身份／同类上界判成重复视图。其余尚未定口径的族
 * （`sandbox/mode`、`approval/policy`、`request/*`、`agent/inbox/spliced`、`todo/write`、
 * `subagent/descriptor`、`session/end-seed`）留在未支持档，等口径决定，不冒充已读。
 */
import { basename, dirname } from 'node:path';
import type {
  TraceEvent,
  TraceMessageEvent,
  TraceMessageOrigin,
  TraceSession,
  TraceUsageEvent,
} from '../../trace-ir.js';
import {
  correlateTraceToolEvents,
  createTraceId,
  normalizeTraceTimestamp,
  traceTimestampBounds,
  unknownTraceEvent,
} from '../../trace-ir.js';
import { normalizeToolIdentity } from '../../../../executors/core/tool-identity.js';
import { nonNegativeMetric, tokenCount } from '../../../../executors/core/token-usage.js';

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * 同一「步」的正牌事件与增量投递登记同一个视图键：分桶表据此按身份判重复视图，而不是靠
 * 计数近似。同一步里的多条累计快照都落到同一个键，正是累计视图的语义。
 */
export function dshStepViewKey(record: Record_): string | undefined {
  const data = isRecord(record.data) ? record.data : undefined;
  if (!data) return undefined;
  const step = numberValue(data.step);
  return step === undefined ? undefined : `dsh:step:${step}`;
}

/** 未识别记录：带步号的增量族把视图键登记成 recordId，让分桶按身份判定。 */
function dshUnknownEvent(record: Record_, runId: string, sourceIndex: number) {
  const sourceType = stringValue(record.type) ?? 'record';
  const event = unknownTraceEvent(
    { sourceIndex, sourceType },
    `${runId}:unknown:${sourceIndex}`,
    record,
  );
  const viewKey = dshStepViewKey(record);
  return viewKey === undefined ? event : { ...event, recordId: viewKey };
}

/** DSH 会话头：本机实测字段集稳定，`origin`／`parentSession` 仅子代理会话带。 */
export function dshSessionHeaderEvidence(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'session') return false;
  return typeof value.id === 'string'
    && typeof value.version === 'number'
    && typeof value.agentPreset === 'string'
    && typeof value.delegationDepth === 'number';
}

/** 斜杠命名空间的事件族是 DSH 独有；与任何已支持宿主的记录名都不重叠。 */
export function dshEventEvidence(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  return value.type === 'assistant/message'
    || value.type === 'user/message'
    || value.type === 'tool/call'
    || value.type === 'tool/result';
}

/**
 * `user/message` 的 `data.source.kind` 决定这条“用户消息”究竟是谁写的。本机观测分布：
 * plugin(21)／agent-instructions(20)／user(16)／skill-catalog(10)／agent-message(7)／
 * subagent-settled(5)。只有 `user` 是真人输入；技能目录属于技能上下文；其余都是运行期注入，
 * 不能算人说的话——把注入内容当成人机指令会直接污染观测侧的“用户意图”计数。
 */
function dshUserMessageOrigin(source: Record_ | undefined): TraceMessageOrigin {
  const kind = stringValue(source?.kind);
  if (kind === 'user') return 'human';
  if (kind === 'skill-catalog') return 'skill-context';
  return 'runtime';
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block as { text: string }).text)
    .join('\n');
}

function dshMessageEvent(
  record: Record_,
  runId: string,
  sourceIndex: number,
  role: 'user' | 'assistant',
  origin: TraceMessageOrigin,
  model: string | undefined,
): TraceMessageEvent {
  const data = isRecord(record.data) ? record.data : {};
  const payload = role === 'assistant' && isRecord(data.message) ? data.message : data;
  const sourceEventId = stringValue(payload.id);
  const toolCallIds = Array.isArray(payload.content)
    ? payload.content
      .filter((block) => isRecord(block))
      .map((block) => stringValue((block as Record_).id))
      .filter((id): id is string => id !== undefined)
    : [];
  const ids = [...new Set(
    [sourceEventId, dshStepViewKey(record), ...toolCallIds].filter((id): id is string => id !== undefined),
  )];
  return {
    eventKind: 'message',
    eventId: `${runId}:message:${record.seq ?? sourceIndex}`,
    ...(sourceEventId === undefined ? {} : { sourceEventId }),
    ...(ids.length === 0 ? {} : { sourceIds: ids }),
    sourceIndex,
    sourceType: 'message',
    ...(normalizeTraceTimestamp(record.time) === undefined ? {} : { timestamp: normalizeTraceTimestamp(record.time) }),
    role,
    origin,
    text: contentText(payload.content),
    ...(model === undefined ? {} : { model }),
  };
}

function dshUsageEvent(record: Record_, runId: string, sourceIndex: number, model: string | undefined): TraceUsageEvent | undefined {
  const data = isRecord(record.data) ? record.data : {};
  const message = isRecord(data.message) ? data.message : undefined;
  const usage = message && isRecord(message.usage) ? message.usage : undefined;
  if (!usage) return undefined;
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  const cacheRead = nonNegativeMetric(usage.cacheReadTokens);
  const reasoning = nonNegativeMetric(usage.reasoningTokens);
  return {
    eventKind: 'usage',
    eventId: `${runId}:usage:${record.seq ?? sourceIndex}`,
    sourceIndex,
    sourceType: 'usage',
    ...(normalizeTraceTimestamp(record.time) === undefined ? {} : { timestamp: normalizeTraceTimestamp(record.time) }),
    ...(model === undefined ? {} : { model }),
    inputTokens,
    outputTokens,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

/**
 * 推理块落成 `model_activity`：DSH 把 reasoning 与正文放在同一条 `assistant/message` 的
 * content 里，不单独落事件就会在派生层彻底没有落点，而 `reasoning-chunks` 的重复视图判定
 * 也需要一个同类正牌事件作上界。
 */
function dshReasoningEvents(
  record: Record_,
  runId: string,
  sourceIndex: number,
  model: string | undefined,
): TraceEvent[] {
  const data = isRecord(record.data) ? record.data : {};
  const message = isRecord(data.message) ? data.message : undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const timestamp = normalizeTraceTimestamp(record.time);
  const events: TraceEvent[] = [];
  blocks.forEach((block, position) => {
    if (!isRecord(block) || block.type !== 'reasoning') return;
    const text = stringValue(block.text) ?? stringValue(block.content) ?? stringValue(block.summary);
    if (text === undefined) return;
    events.push({
      eventKind: 'model_activity',
      activityKind: 'reasoning',
      contentVisibility: 'plaintext',
      contentSource: 'content',
      eventId: `${runId}:reasoning:${record.seq ?? sourceIndex}:${position}`,
      sourceIndex,
      sourceType: 'model_activity',
      sourceIds: [stringValue(message?.id), dshStepViewKey(record)].filter((id): id is string => id !== undefined),
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(model === undefined ? {} : { model }),
      text,
    });
  });
  return events;
}

function parseToolArguments(raw: unknown): Record_ {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    // 参数流被中断时只剩半截 JSON：留空对象，不让一条记录毁掉整场会话。
    return {};
  }
}

function dshToolEvents(record: Record_, runId: string, sourceIndex: number): TraceEvent[] {
  const data = isRecord(record.data) ? record.data : {};
  const timestamp = normalizeTraceTimestamp(record.time);
  if (record.type === 'tool/call') {
    const callId = stringValue(data.callId);
    const name = stringValue(data.name);
    if (!callId || !name) {
      return [unknownTraceEvent({ sourceIndex, sourceType: 'tool/call' }, `${runId}:broken:${sourceIndex}`, record)];
    }
    return [{
      eventKind: 'tool_call',
      eventId: `${runId}:call:${callId}`,
      sourceEventId: callId,
      sourceIds: [callId, dshStepViewKey(record)].filter((id): id is string => id !== undefined),
      sourceIndex,
      sourceType: 'tool_call',
      ...(timestamp === undefined ? {} : { timestamp }),
      callId,
      callInstanceId: `${runId}:${callId}`,
      tool: normalizeToolIdentity({ sourceName: name }),
      input: parseToolArguments(data.arguments),
    }];
  }
  const message = isRecord(data.message) ? data.message : undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const events: TraceEvent[] = [];
  blocks.forEach((block, position) => {
    if (!isRecord(block)) return;
    const callId = stringValue(block.toolCallId);
    if (!callId) return;
    const failed = block.isError === true;
    events.push({
      eventKind: 'tool_result',
      eventId: `${runId}:result:${callId}:${position}`,
      sourceEventId: stringValue(message?.id) ?? callId,
      sourceIds: [...new Set([stringValue(message?.id), callId].filter((id): id is string => id !== undefined))],
      sourceIndex,
      sourceType: 'tool_result',
      ...(timestamp === undefined ? {} : { timestamp }),
      callId,
      callInstanceId: `${runId}:${callId}`,
      output: contentText(block.content) || (typeof block.content === 'string' ? block.content : ''),
      status: failed ? 'failure' : 'success',
      // 状态来自宿主自报的 isError，不是从输出文本猜。
      statusSource: 'runtime',
    });
  });
  if (events.length === 0) {
    return [unknownTraceEvent({ sourceIndex, sourceType: 'tool/result' }, `${runId}:orphan:${sourceIndex}`, record)];
  }
  return events;
}

function dshLifecycleEvent(record: Record_, runId: string, sourceIndex: number): TraceEvent | undefined {
  const phase = record.type === 'turn/start' ? 'turn_started'
    : record.type === 'turn/end' ? 'turn_completed'
      : record.type === 'step/start' ? 'step_started'
        : record.type === 'step/end' ? 'step_completed' : undefined;
  if (!phase) return undefined;
  const timestamp = normalizeTraceTimestamp(record.time);
  return {
    eventKind: 'lifecycle',
    eventId: `${runId}:lifecycle:${record.seq ?? sourceIndex}`,
    sourceIndex,
    sourceType: 'lifecycle',
    ...(timestamp === undefined ? {} : { timestamp }),
    phase,
  };
}

export function parseDshSessionFile(filePath: string, rawRecords: unknown[]): TraceSession {
  const records = rawRecords.map((record) => (isRecord(record) ? record : undefined));
  const header = records.find((record) => record && dshSessionHeaderEvidence(record)) as Record_ | undefined;
  const runId = stringValue(header?.id) ?? basename(filePath, '.jsonl.zstd');
  const titleBySequence = records.reduce<string | undefined>((title, record) => {
    if (title || !record || record.type !== 'session/title') return title;
    const data = isRecord(record.data) ? record.data : {};
    return stringValue(data.title);
  }, undefined);

  const events = correlateTraceToolEvents(records.flatMap((record, sourceIndex) => {
    if (!record) return [];
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'user/message') {
      return [dshMessageEvent(record, runId, sourceIndex, 'user', dshUserMessageOrigin(
        isRecord(record.data) ? (record.data as Record_) : undefined,
      ), undefined)];
    }
    if (type === 'assistant/message') {
      const data = isRecord(record.data) ? record.data : {};
      const message = isRecord(data.message) ? data.message : undefined;
      const model = message && isRecord(message.source)
        ? stringValue((message.source as Record_).model)
        : undefined;
      const usage = dshUsageEvent(record, runId, sourceIndex, model);
      const reasoning = dshReasoningEvents(record, runId, sourceIndex, model);
      return [
        dshMessageEvent(record, runId, sourceIndex, 'assistant', 'runtime', model),
        ...reasoning,
        ...(usage ? [usage] : []),
      ];
    }
    if (type === 'tool/call' || type === 'tool/result') return dshToolEvents(record, runId, sourceIndex);
    if (type === 'turn/start' || type === 'turn/end' || type === 'step/start' || type === 'step/end') {
      const lifecycle = dshLifecycleEvent(record, runId, sourceIndex);
      return lifecycle ? [lifecycle] : [];
    }
    return [dshUnknownEvent(record, runId, sourceIndex)];
  }));

  const timestamps = [header?.createdAt, ...events.map((event) => event.timestamp)];
  const parentRunId = stringValue(header?.parentSession);
  return {
    runId,
    rootRunId: stringValue(header?.origin) === 'subagent' && parentRunId ? parentRunId : runId,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    traceId: createTraceId({ sourceKind: 'dsh', runId, sourcePath: filePath }),
    groupPath: dirname(filePath),
    role: 'standalone',
    label: titleBySequence ?? basename(filePath),
    sourcePath: filePath,
    sourceKind: 'dsh',
    events,
    ...(stringValue(header?.cwd) === undefined ? {} : { cwd: stringValue(header?.cwd) }),
    entrypoint: 'dsh',
    ...traceTimestampBounds(timestamps),
  };
}

/** DSH 记录里承载“同一事实的第二次写入”的增量族；分桶表按它判重复视图。 */
export const DSH_DUPLICATE_VIEW_FAMILIES = [
  'reasoning-chunks',
  'assistant/chunk',
  'text-chunks',
  'tool-call-chunks',
] as const;

/** 已识别但刻意不映射的族名（本机语料实测），供分桶表按族判定。 */
export const DSH_RECOGNIZED_FAMILIES: readonly string[] = [
  ...DSH_DUPLICATE_VIEW_FAMILIES,
  'session',
  'session/title',
  'session/end-seed',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'sandbox/mode',
  'approval/policy',
  'request/header',
  'request/context',
  'subagent/descriptor',
  'agent/inbox/spliced',
  'todo/write',
  'permission/preset',
  'session/title-llm-request',
  'command/run',
  'command/done',
  'approval/asked',
  'approval/decided',
];

export function dshRecordFamilyOf(record: unknown): string | undefined {
  return isRecord(record) ? stringValue(record.type) : undefined;
}
