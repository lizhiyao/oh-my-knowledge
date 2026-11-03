import { isAbsolute, relative } from 'node:path';
import type { TraceEvent } from '../../trace-ir.js';
import { extractCodexExecCommands } from './exec-command.js';
import { codexToolStatusFromValue } from './tool-status.js';

/**
 * Codex 的 `item_completed` 视图里，有几族承载的不是「模型发起的调用」，而是运行时观察到
 * 的效果或状态。它们映射成独立的事件档，不参与工具事件配对，因此既补上了证据，也不会
 * 改动工具计数——这是把 FileChange 与 shell 副作用区分开的唯一办法。
 */

interface ItemViewBase {
  sourceEventId?: string;
  sourceIndex: number;
  sourceType: string;
  timestamp?: string;
  turnId?: string;
}

export interface CodexItemViewContext {
  base: ItemViewBase;
  eventId: (suffix: string) => string;
  cwd?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 同一次执行的两套视图只在 `call_*` 命名空间里共享 id，`exec-*` 侧没有。 */
export function codexItemViewIds(item: Record<string, unknown>): string[] {
  const id = stringValue(item.id);
  const callId = stringValue(item.call_id);
  return [...new Set([id, callId].filter((x): x is string => x !== undefined))];
}

/**
 * WebSearch 在较新 Codex 版本里改由 `Extension` item 承载（kind=web.search），事实形态与
 * 旧的 `WebSearch` item 相同。两族走同一口径，搜索计数才跨版本可比。
 */
export function isCodexWebSearchItemView(item: Record<string, unknown>): boolean {
  return item.type === 'WebSearch'
    || (item.type === 'Extension' && stringValue(item.kind) === 'web.search');
}

/** 起止时间戳都齐全时才有时长；缺任一侧就不臆造。 */
export function codexItemViewDurationMs(payload: Record<string, unknown>): number | undefined {
  const started = numberValue(payload.started_at_ms);
  const completed = numberValue(payload.completed_at_ms);
  if (started === undefined || completed === undefined) return undefined;
  const durationMs = completed - started;
  return durationMs >= 0 ? durationMs : undefined;
}

/**
 * FileChange → observed_effect：一条记录可以覆盖多个文件，其中多数是 shell 命令的副作用
 * （版本控制、格式化、脚本生成），实测 item 与 `apply_patch` 调用之比约 3.9∶1，因此它
 * 不能算作一次模型发起的编辑调用。
 */
export function projectCodexObservedEffect(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
  context: CodexItemViewContext,
): TraceEvent | undefined {
  if (item.type !== 'FileChange' || !isObject(item.changes)) return undefined;
  const entries = Object.entries(item.changes);
  let addedLines = 0;
  let deletedLines = 0;
  for (const [, change] of entries) {
    const diff = isObject(change) ? stringValue(change.unified_diff) : undefined;
    if (!diff) continue;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) addedLines += 1;
      else if (line.startsWith('-')) deletedLines += 1;
    }
  }
  const status = stringValue(item.status);
  const explicit = status !== undefined;
  return {
    ...context.base,
    eventKind: 'observed_effect',
    eventId: context.eventId('observed-effect'),
    effectKind: 'file_change',
    paths: codexRelativePaths(entries.map(([path]) => path), context.cwd),
    changeCount: entries.length,
    ...(addedLines > 0 ? { addedLines } : {}),
    ...(deletedLines > 0 ? { deletedLines } : {}),
    status: codexToolStatusFromValue(status),
    statusSource: explicit ? 'runtime' : 'unknown',
    durationMs: codexItemViewDurationMs(payload),
    sourceIds: codexItemViewIds(item),
  };
}

/** SubAgentActivity → agent_activity(lifecycle)：子代理自身的状态变化，调用侧记录不承载。 */
export function projectCodexAgentLifecycle(
  item: Record<string, unknown>,
  context: CodexItemViewContext,
): TraceEvent | undefined {
  if (item.type !== 'SubAgentActivity') return undefined;
  return {
    ...context.base,
    eventKind: 'agent_activity',
    eventId: context.eventId('agent-lifecycle'),
    activityKind: 'lifecycle',
    agentId: stringValue(item.agent_thread_id),
    agentPath: stringValue(item.agent_path),
    activity: stringValue(item.kind),
    sourceIds: codexItemViewIds(item),
  };
}

/**
 * 评审模式：进入记录只表达模式切换，映射成 lifecycle；退出记录承载 findings 结论
 * （title／body／priority／confidence），其语义本轮未定，继续按原始证据保留。
 */
export function projectCodexReviewPhase(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
  context: CodexItemViewContext,
): TraceEvent | undefined {
  if (item.type !== 'EnteredReviewMode') return undefined;
  return {
    ...context.base,
    eventKind: 'lifecycle',
    eventId: context.eventId('review-phase'),
    phase: 'review_started',
    reason: stringValue(item.user_facing_hint),
    durationMs: codexItemViewDurationMs(payload),
    sourceIds: codexItemViewIds(item),
  };
}

/** 绝对路径只在原始日志里保留；落在会话 cwd 之外的路径不投影进派生层。 */
function codexRelativePaths(paths: string[], cwd?: string): string[] {
  if (cwd === undefined) return [];
  const out: string[] = [];
  for (const path of paths) {
    const rel = relative(cwd, path);
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) continue;
    out.push(rel);
  }
  return out;
}

export interface CodexExecResultView {
  sourceIndex: number;
  id: string;
  commands: string[];
  exitCode?: number;
  durationMs?: number;
}

/** 归属到同一次调用上的结果视图聚合：只填不会二义的量。 */
export interface CodexExecResultAggregate {
  /** 组内退出码只有一个取值时才是结论；多值时留空，不替整次调用编一个成败。 */
  exitCode?: number;
  /** 组内每条视图都有时长时才求和；缺任何一条就留空，避免给出偏小的时长。 */
  durationMs?: number;
  /** 组内结果视图的原生 id，按日志顺序。 */
  ids: string[];
}

/**
 * 一次调用实际执行的命令字面量。exec 桥接的命令写在 JS 源里，只能静态抽取；其余工具按
 * 常见字段取。这里是唯一实现——归属预扫描与主循环都必须走同一个口径，否则会分叉。
 */
export function codexCallCommandsFromPayload(payload: Record<string, unknown>): string[] {
  const sourceName = stringValue(payload.name) ?? '';
  const raw = typeof payload.input === 'string'
    ? payload.input
    : typeof payload.arguments === 'string'
      ? payload.arguments
      : undefined;
  if (sourceName.toLowerCase() === 'exec' && raw !== undefined) return extractCodexExecCommands(raw);
  const parsed = raw !== undefined ? safeJson(raw) : payload.input ?? payload.arguments;
  if (!isObject(parsed)) return [];
  if (Array.isArray(parsed.commands)) {
    const list = parsed.commands.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (list.length > 0) return list;
  }
  for (const key of ['command', 'cmd']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim()) return [value];
    if (Array.isArray(value)) {
      const list = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
      if (list.length > 0) return list;
    }
  }
  return [];
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function recordType(value: unknown): string | undefined {
  return isObject(value) ? stringValue(value.type) : undefined;
}

function recordPayload(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) && isObject(value.payload) ? value.payload : undefined;
}

interface CodexExecCall {
  index: number;
  callId: string;
  commands: string[];
  key: string;
}

/**
 * shell 命令的结果侧视图：Codex Desktop 的 exec 桥接把命令写成 JS 源，`response_item` 的
 * 调用与输出记录已映射成工具事件对，`item_completed` 则是同一次执行的结果视图，只多带
 * `exit_code`、时长与逐条状态。两侧不共享 id，只能按命令字面量归属。
 *
 * 归属分两级，都不猜：
 * 1. 命令集合完全相等，按调用出现序 1∶1 消费；
 * 2. 一次桥接跑多条命令时，每个子集视图在「只被唯一一次调用包含」时归到那次调用上
 *    （实测一次调用最多跑出 15 个结果视图）。被两次以上调用同时包含的视图不归属。
 *
 * 必须一次算完再进主循环：真实日志里结果视图既可能写在输出记录之后（实测间隔 4 行），
 * 也可能写在之前（间隔 136 行），边解析边消费会让已并入的记录因为先后顺序漏进未知档。
 */
export function indexCodexExecResultViews(records: unknown[]): {
  mergedByCallId: Map<string, CodexExecResultAggregate[]>;
  consumedSourceIndexes: Set<number>;
} {
  const views: CodexExecResultView[] = [];
  records.forEach((value, sourceIndex) => {
    const payload = recordPayload(value);
    if (!payload || payload.type !== 'item_completed') return;
    const item = isObject(payload.item) ? payload.item : undefined;
    if (!item || item.type !== 'CommandExecution') return;
    const id = stringValue(item.id);
    if (!id) return;
    const commands = (Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [])
      .map((entry) => (isObject(entry) ? stringValue(entry.cmd) : undefined))
      .filter((entry): entry is string => entry !== undefined);
    if (commands.length === 0) return;
    views.push({
      sourceIndex,
      id,
      commands,
      exitCode: numberValue(item.exit_code),
      durationMs: codexItemViewDurationMs(payload) ?? codexItemStructuredDurationMs(item.duration),
    });
  });

  const calls: CodexExecCall[] = [];
  records.forEach((value, sourceIndex) => {
    if (recordType(value) !== 'response_item') return;
    const payload = recordPayload(value);
    const payloadType = payload ? stringValue(payload.type) : undefined;
    if (payloadType !== 'function_call' && payloadType !== 'custom_tool_call') return;
    const commands = codexCallCommandsFromPayload(payload!);
    if (commands.length === 0) return;
    calls.push({
      index: sourceIndex,
      callId: stringValue(payload!.call_id) ?? stringValue(payload!.id) ?? `codex-call-${sourceIndex}`,
      commands,
      key: codexCommandSetKey(commands),
    });
  });

  // 1) 命令集合完全相等：按调用出现序 1∶1 消费。
  const viewsByKey = new Map<string, number[]>();
  views.forEach((view, position) => {
    const key = codexCommandSetKey(view.commands);
    viewsByKey.set(key, [...(viewsByKey.get(key) ?? []), position]);
  });
  const assigned = new Map<number, number[]>();
  const claimedViews = new Set<number>();
  calls.forEach((call, callPosition) => {
    const queue = viewsByKey.get(call.key);
    if (!queue) return;
    while (queue.length > 0) {
      const position = queue.shift()!;
      if (claimedViews.has(position)) continue;
      claimedViews.add(position);
      assigned.set(callPosition, [...(assigned.get(callPosition) ?? []), position]);
      break;
    }
  });

  // 2) 子集归属：只认「唯一包含它的调用」，被两次以上包含就不归。
  const callSets = calls.map((call) => new Set(call.commands));
  views.forEach((view, position) => {
    if (claimedViews.has(position)) return;
    const containing = calls
      .map((call, callPosition) => ({ call, callPosition }))
      .filter(({ call, callPosition }) => call.commands.length > view.commands.length
        && view.commands.every((command) => callSets[callPosition].has(command)));
    if (containing.length !== 1) return;
    claimedViews.add(position);
    const target = containing[0].callPosition;
    assigned.set(target, [...(assigned.get(target) ?? []), position]);
  });

  const consumedSourceIndexes = new Set<number>();
  const mergedByCallId = new Map<string, CodexExecResultAggregate[]>();
  for (const [callPosition, viewPositions] of [...assigned.entries()].sort((a, b) => a[0] - b[0])) {
    const ordered = [...viewPositions].sort((a, b) => views[a].sourceIndex - views[b].sourceIndex);
    const group = ordered.map((position) => {
      consumedSourceIndexes.add(views[position].sourceIndex);
      return views[position];
    });
    const aggregate = aggregateExecResultViews(group);
    const callId = calls[callPosition].callId;
    mergedByCallId.set(callId, [...(mergedByCallId.get(callId) ?? []), aggregate]);
  }

  return { mergedByCallId, consumedSourceIndexes };
}

function aggregateExecResultViews(group: CodexExecResultView[]): CodexExecResultAggregate {
  const exitCodes = group.map((view) => view.exitCode);
  const durations = group.map((view) => view.durationMs);
  const unique = new Set(exitCodes);
  return {
    // 组内每条都报告了退出码、且取值唯一，才算得出这一次调用的退出码；缺一条就不填。
    ...(exitCodes.every((code) => code !== undefined) && unique.size === 1
      ? { exitCode: exitCodes[0] as number }
      : {}),
    ...(durations.every((value) => value !== undefined)
      ? { durationMs: durations.reduce((total, value) => total + (value ?? 0), 0) }
      : {}),
    ids: group.map((view) => view.id),
  };
}

/** 命令集合的身份键：顺序无关，重复命令折叠。 */
export function codexCommandSetKey(commands: string[]): string {
  return JSON.stringify([...new Set(commands)].sort());
}

/** `duration: {secs, nanos}` 是 item 上的另一种时长写法。 */
function codexItemStructuredDurationMs(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  const secs = numberValue(value.secs);
  const nanos = numberValue(value.nanos);
  if (secs === undefined && nanos === undefined) return undefined;
  return Math.round((secs ?? 0) * 1000 + (nanos ?? 0) / 1_000_000);
}
