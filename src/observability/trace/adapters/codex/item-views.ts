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
  status?: string;
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

/**
 * shell 命令的结果侧视图：Codex Desktop 的 exec 桥接把命令写成 JS 源，`response_item` 的
 * 调用与输出记录已映射成工具事件对，`item_completed` 则是同一次执行的结果视图，只多带
 * `exit_code`、时长与逐条状态。两侧不共享 id，只能按「命令字面量集合完全相等」归属，
 * 归属不到的记录继续留作待映射证据。
 *
 * 归属在解析主循环之前一次算完：真实日志里结果视图既可能写在输出记录之后、也可能写在之前
 * （同一命令在不同宿主版本里有 4 行和 136 行两种间距），边解析边消费会让「已并入的记录」
 * 因为先后顺序漏进未知档。
 */
export function indexCodexExecResultViews(records: unknown[]): {
  mergedByCallId: Map<string, CodexExecResultView[]>;
  consumedSourceIndexes: Set<number>;
} {
  const byCommandSet = new Map<string, CodexExecResultView[]>();
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
    const view: CodexExecResultView = {
      sourceIndex,
      id,
      commands,
      exitCode: numberValue(item.exit_code),
      durationMs: codexItemViewDurationMs(payload) ?? codexItemStructuredDurationMs(item.duration),
      status: stringValue(item.status),
    };
    const key = codexCommandSetKey(commands);
    byCommandSet.set(key, [...(byCommandSet.get(key) ?? []), view]);
  });

  // 按 callId 分组保存归属结果：主循环消费输出记录时按同一顺序取用，不依赖两侧的
  // 出现序计数是否一致（调用没有输出记录时那两个计数就会错开）。
  const mergedByCallId = new Map<string, CodexExecResultView[]>();
  const consumedSourceIndexes = new Set<number>();
  records.forEach((value, sourceIndex) => {
    if (recordType(value) !== 'response_item') return;
    const payload = recordPayload(value);
    const payloadType = payload ? stringValue(payload.type) : undefined;
    if (payloadType !== 'function_call' && payloadType !== 'custom_tool_call') return;
    const callId = stringValue(payload?.call_id) ?? stringValue(payload?.id) ?? `codex-call-${sourceIndex}`;
    const commands = codexCallCommandsFromPayload(payload!);
    if (commands.length === 0) return;
    const view = (byCommandSet.get(codexCommandSetKey(commands)) ?? [])
      .find((candidate) => !consumedSourceIndexes.has(candidate.sourceIndex));
    if (!view) return;
    consumedSourceIndexes.add(view.sourceIndex);
    mergedByCallId.set(callId, [...(mergedByCallId.get(callId) ?? []), view]);
  });

  return { mergedByCallId, consumedSourceIndexes };
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
