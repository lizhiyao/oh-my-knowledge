import type { ToolCallInfo, TurnInfo } from '../../types/index.js';
import { safeSliceForJson } from '../../util/safe-slice.js';
import type { CodexEvent } from './protocol.js';
import { normalizeToolIdentity } from '../../shared/tool-identity.js';

// Codex CLI(codex 0.125)`exec --json` 事件流 → omk trace 抽取器。
// 跟 claude-sdk-trace.ts 不同源:
//   Claude SDK 是 message[block] 嵌套结构,有 tool_use / tool_result 配对;
//   Codex 是事件流(turn.started → turn.completed,夹杂 item.* 事件),每个
//   item.completed 事件直接生成完整 ToolCallInfo,**不需要 use/result 配对**。
//
// schema(基于 codex 0.125 实测,fixture 测试锁住假设;漂移时 fixture 先红):
//   - {type:'thread.started' | 'turn.started'} 划 turn 边界
//   - {type:'turn.completed', usage} / {type:'turn.failed', error} 收尾
//   - {type:'item.started', item:{type, status:'in_progress', ...}} 暂存；缺 completed 时保留为 unknown
//   - {type:'item.completed', item:{type:'agent_message', text:'...'}} → assistant 文本
//   - {type:'item.completed', item:{type:'command_execution', command, aggregated_output, exit_code, status}} → ToolCallInfo
//   - 其他 item.type(file_read/file_write/web_search/agent tools 等)best-effort 抽 input/output
// 子代理统计只认事件流里的具体 spawn 工具事实；旧协议没有这类事件时自然为 0。

const TOOL_INPUT_LIMIT = 500;
const TOOL_OUTPUT_LIMIT = 500;

export function isCodexResultEvent(event: CodexEvent): boolean {
  return event.type === 'turn.completed' || event.type === 'turn.failed';
}

function extractToolInput(item: NonNullable<CodexEvent['item']>, itemType: string): unknown {
  if (itemType === 'command_execution') {
    return { command: safeSliceForJson(item.command || '', TOOL_INPUT_LIMIT, '') };
  }
  if (itemType === 'file_read' || itemType === 'file_write') {
    return { file_path: item.path || null };
  }
  if (itemType === 'file_change') {
    return item.changes?.slice(0, 50).map((change) => ({
      path: safeSliceForJson(change.path || '', TOOL_INPUT_LIMIT, ''),
      ...(change.changeKind && { kind: change.changeKind }),
    })) ?? [];
  }
  if (itemType === 'web_search') return { query: item.query || null };
  if (itemType === 'mcp_tool_call') return item.arguments ?? null;
  return null;
}

function stringifyToolValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return safeSliceForJson(json ?? String(value), TOOL_OUTPUT_LIMIT, '');
  } catch {
    return safeSliceForJson(String(value), TOOL_OUTPUT_LIMIT, '');
  }
}

function extractToolOutput(item: NonNullable<CodexEvent['item']>, itemType: string): string {
  if (itemType === 'command_execution' && item.aggregated_output) {
    return safeSliceForJson(item.aggregated_output, TOOL_OUTPUT_LIMIT, '');
  }
  if (itemType === 'file_read' && item.content) return safeSliceForJson(item.content, TOOL_OUTPUT_LIMIT, '');
  if (itemType === 'file_change') return item.status || '';
  if (itemType === 'mcp_tool_call') {
    if (item.error?.message) return safeSliceForJson(item.error.message, TOOL_OUTPUT_LIMIT, '');
    if (item.result !== undefined) return stringifyToolValue(item.result);
  }
  if (itemType === 'error' && item.message) return safeSliceForJson(item.message, TOOL_OUTPUT_LIMIT, '');
  if (item.results) return stringifyToolValue(item.results);
  return '';
}

function codexItemStatus(
  event: CodexEvent,
  item: NonNullable<CodexEvent['item']>,
): NonNullable<ToolCallInfo['status']> {
  if (
    event.error
    || item.error
    || item.type === 'error'
    || (typeof item.exit_code === 'number' && item.exit_code !== 0)
  ) return 'failure';
  const status = item.status?.toLowerCase();
  if (status === 'failed' || status === 'error') return 'failure';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (
    status === 'completed'
    || status === 'complete'
    || status === 'success'
    || status === 'succeeded'
  ) return 'success';
  if (status) return 'unknown';
  if (typeof item.exit_code === 'number' && item.exit_code === 0) return 'success';
  // `item.completed` is the legacy success signal when older Codex events omit
  // item.status. Keep that compatibility while preferring explicit status above.
  return 'success';
}

export function extractCodexTrace(events: CodexEvent[]): { turns: TurnInfo[]; toolCalls: ToolCallInfo[]; fullNumTurns: number; numSubAgents: number } {
  const turns: TurnInfo[] = [];
  const toolCalls: ToolCallInfo[] = [];
  let fullNumTurns = 0;
  let numSubAgents = 0;

  let currentTurnText = '';
  let currentTurnTools: ToolCallInfo[] = [];
  let currentTurnHasContent = false;
  let lastTurnTs: number | undefined;
  const pendingItems = new Map<string, Array<{
    item: NonNullable<CodexEvent['item']>;
    callInstanceId: string;
  }>>();

  const appendToolCall = (
    item: NonNullable<CodexEvent['item']>,
    status: NonNullable<ToolCallInfo['status']>,
    statusSource: NonNullable<ToolCallInfo['statusSource']>,
    callInstanceId: string,
  ): void => {
    const itemType = item.type;
    if (!itemType || isNonToolItem(itemType)) return;
    if (isAgentSpawnItem(item)) numSubAgents += 1;
    const toolIdentity = normalizeToolIdentity({
      sourceName: itemType,
      provider: itemType === 'mcp_tool_call' ? item.server : undefined,
      authoritativeName: itemType === 'mcp_tool_call' ? item.tool ?? item.name : undefined,
    });
    const tc: ToolCallInfo = {
      tool: toolIdentity.name,
      ...(toolIdentity.sourceName ? { sourceTool: toolIdentity.sourceName } : {}),
      ...(toolIdentity.namespace ? { toolNamespace: toolIdentity.namespace } : {}),
      ...(toolIdentity.provider ? { toolProvider: toolIdentity.provider } : {}),
      input: extractToolInput(item, itemType),
      output: extractToolOutput(item, itemType),
      status,
      statusSource,
      success: status === 'success',
      callInstanceId,
      toolUseId: item.id,
    };
    currentTurnTools.push(tc);
    toolCalls.push(tc);
    currentTurnHasContent = true;
  };

  const materializePendingItems = (): void => {
    for (const queue of pendingItems.values()) {
      for (const pending of queue) {
        appendToolCall(pending.item, 'unknown', 'unknown', pending.callInstanceId);
      }
    }
    pendingItems.clear();
  };

  const flushTurn = (closingEvent?: CodexEvent): void => {
    if (!currentTurnHasContent && currentTurnTools.length === 0) return;
    const dur = closingEvent?.ts && lastTurnTs ? closingEvent.ts - lastTurnTs : undefined;
    const turn: TurnInfo = {
      role: 'assistant',
      content: currentTurnText,
      ...(currentTurnTools.length > 0 && { toolCalls: currentTurnTools }),
      ...(dur != null && dur > 0 && { durationMs: dur }),
    };
    turns.push(turn);
    if (currentTurnHasContent) fullNumTurns++;
    currentTurnText = '';
    currentTurnTools = [];
    currentTurnHasContent = false;
    if (closingEvent?.ts) lastTurnTs = closingEvent.ts;
  };

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    const t = event.type;
    if (!t) continue;

    if (t === 'thread.started' || t === 'turn.started') {
      materializePendingItems();
      if (currentTurnHasContent || currentTurnTools.length > 0) flushTurn();
      if (event.ts) lastTurnTs = event.ts;
      continue;
    }

    if (t === 'turn.completed') {
      materializePendingItems();
      flushTurn(event);
      continue;
    }

    if (t === 'turn.failed') {
      materializePendingItems();
      flushTurn(event);
      continue;
    }

    if (t === 'item.started') {
      const item = event.item;
      if (item?.id && item.type && item.type !== 'agent_message') {
        const pending = pendingItems.get(item.id) ?? [];
        pending.push({
          item,
          callInstanceId: `codex-exec:${eventIndex}:started`,
        });
        pendingItems.set(item.id, pending);
      }
      continue;
    }
    if (t === 'item.updated') {
      const item = event.item;
      if (item?.id && item.type && item.type !== 'agent_message') {
        const pending = pendingItems.get(item.id);
        const current = pending?.at(-1);
        if (current) {
          current.item = { ...current.item, ...item };
        } else {
          pendingItems.set(item.id, [{
            item,
            callInstanceId: `codex-exec:${eventIndex}:updated`,
          }]);
        }
      }
      continue;
    }
    if (t !== 'item.completed') continue;
    const item = event.item;
    if (!item || !item.type) continue;
    const pendingQueue = item.id ? pendingItems.get(item.id) : undefined;
    const started = pendingQueue?.shift();
    if (item.id && pendingQueue?.length === 0) pendingItems.delete(item.id);
    const completedItem = started
      ? { ...started.item, ...item, status: item.status }
      : item;

    const itemType = completedItem.type;
    if (itemType === 'agent_message') {
      const txt = completedItem.text || '';
      if (txt) {
        if (currentTurnText) currentTurnText += '\n';
        currentTurnText += txt;
        currentTurnHasContent = true;
      }
      continue;
    }

    const status = codexItemStatus(event, completedItem);
    appendToolCall(
      completedItem,
      status,
      'runtime',
      started?.callInstanceId ?? `codex-exec:${eventIndex}:completed`,
    );
  }

  // 流末尾 flush(防止最后一个 turn 没 turn.completed 收尾)
  materializePendingItems();
  flushTurn();

  return { turns, toolCalls, fullNumTurns, numSubAgents };
}

function isAgentSpawnItem(item: NonNullable<CodexEvent['item']>): boolean {
  const identity = [
    item.type,
    item.server,
    item.tool,
    item.name,
  ].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
  return /(?:^|[^a-z0-9])(?:spawn|create|start)[_-]?(?:sub)?agent(?:$|[^a-z0-9])/.test(identity)
    || /^(?:agent|subagent|task)$/.test(item.type?.toLowerCase() ?? '');
}

function isNonToolItem(itemType: string): boolean {
  return itemType === 'agent_message'
    || itemType === 'reasoning'
    || itemType === 'todo_list'
    || itemType === 'error';
}
