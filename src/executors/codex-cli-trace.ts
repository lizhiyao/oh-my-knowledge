import type { ToolCallInfo, TurnInfo } from '../types/index.js';
import type { CodexEvent } from './shared.js';

// Codex CLI(codex 0.125)`exec --json` 事件流 → omk trace 抽取器。
// 跟 claude-sdk-trace.ts 不同源:
//   Claude SDK 是 message[block] 嵌套结构,有 tool_use / tool_result 配对;
//   Codex 是事件流(turn.started → turn.completed,夹杂 item.* 事件),每个
//   item.* 事件直接生成完整 ToolCallInfo,**不需要 use/result 配对**。
//
// schema 假设(基于 codex 0.125,未来版本可能变):
//   - 'turn.started' / 'turn.completed' / 'turn.failed' 划 assistant turn 边界
//   - 'item.assistant_message' append 文本到当前 turn
//   - 'item.command_execution' / 'item.file_read' / 'item.file_write' / 'item.web_search'
//     等 item.* 事件当 ToolCallInfo;tool 名取 item_type 或 type 去 'item.' 前缀
//   - codex 无 sub-agent 概念,numSubAgents 恒 0
// 字段缺失静默 skip 不 throw,保证 schema 漂移时不破主流程。

const TOOL_INPUT_LIMIT = 500;
const TOOL_OUTPUT_LIMIT = 500;

export function isCodexResultEvent(event: CodexEvent): boolean {
  return event.type === 'turn.completed' || event.type === 'turn.failed';
}

interface ItemPayload {
  command?: string;
  path?: string;
  query?: string;
  text?: string;
  stdout?: string;
  stderr?: string;
  content?: string;
  results?: unknown[];
}

function getItemType(event: CodexEvent): string {
  // 优先 item_type 字段,fallback 把 'item.command_execution' 切成 'command_execution'
  if (event.item_type) return event.item_type;
  if (event.type?.startsWith('item.')) return event.type.slice(5);
  return event.type || 'unknown';
}

function extractToolInput(event: CodexEvent, itemType: string): unknown {
  const payload = event.payload as ItemPayload | undefined;
  if (!payload) return null;
  if (itemType === 'command_execution') return (payload.command || '').slice(0, TOOL_INPUT_LIMIT);
  if (itemType === 'file_read' || itemType === 'file_write') return payload.path || null;
  if (itemType === 'web_search') return payload.query || null;
  return payload;
}

function extractToolOutput(event: CodexEvent, itemType: string): string {
  const payload = event.payload as ItemPayload | undefined;
  // command_execution: stdout + stderr 合并
  if (itemType === 'command_execution' && payload) {
    const out = (payload.stdout || '') + (payload.stderr ? `\n[stderr] ${payload.stderr}` : '');
    return out.slice(0, TOOL_OUTPUT_LIMIT);
  }
  // file_read: content
  if (itemType === 'file_read' && payload?.content) return payload.content.slice(0, TOOL_OUTPUT_LIMIT);
  // 通用 fallback:event.result 或 payload.results
  if (typeof event.result === 'string') return event.result.slice(0, TOOL_OUTPUT_LIMIT);
  if (payload?.results) return JSON.stringify(payload.results).slice(0, TOOL_OUTPUT_LIMIT);
  return '';
}

function extractAssistantText(event: CodexEvent): string {
  // assistant_message payload 可能是 { text } 或顶层 text
  const payload = event.payload as ItemPayload | undefined;
  if (payload?.text) return payload.text;
  if (event.text) return event.text;
  return '';
}

export function extractCodexTrace(events: CodexEvent[]): { turns: TurnInfo[]; toolCalls: ToolCallInfo[]; fullNumTurns: number; numSubAgents: number } {
  const turns: TurnInfo[] = [];
  const toolCalls: ToolCallInfo[] = [];
  let fullNumTurns = 0;
  // numSubAgents:codex 没有 sub-agent 概念(没有像 Claude 的 Agent 工具),恒 0
  const numSubAgents = 0;

  let currentTurnText = '';
  let currentTurnTools: ToolCallInfo[] = [];
  let currentTurnHasContent = false;
  let lastTurnTs: number | undefined;

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

  for (const event of events) {
    const t = event.type;
    if (!t) continue;

    if (t === 'thread.started' || t === 'turn.started') {
      // 开新 turn(如果上一个 turn 还有 buffered 内容,先 flush)
      if (currentTurnHasContent || currentTurnTools.length > 0) flushTurn();
      if (event.ts) lastTurnTs = event.ts;
      continue;
    }

    if (t === 'turn.completed') {
      flushTurn(event);
      continue;
    }

    if (t === 'turn.failed') {
      // 标 failed turn:把最后一个 ToolCallInfo(如有)success=false,flush
      if (currentTurnTools.length > 0) {
        currentTurnTools[currentTurnTools.length - 1].success = false;
      }
      flushTurn(event);
      continue;
    }

    // item.* 事件
    if (t.startsWith('item.') || event.item_type) {
      const itemType = getItemType(event);
      if (itemType === 'assistant_message') {
        const txt = extractAssistantText(event);
        if (txt) {
          if (currentTurnText) currentTurnText += '\n';
          currentTurnText += txt;
          currentTurnHasContent = true;
        }
        continue;
      }
      // 其他 item.* 当 tool call
      const isError = !!event.error || (typeof event.exit_code === 'number' && event.exit_code !== 0);
      const tc: ToolCallInfo = {
        tool: itemType,
        input: extractToolInput(event, itemType),
        output: extractToolOutput(event, itemType),
        success: !isError,
      };
      currentTurnTools.push(tc);
      toolCalls.push(tc);
      currentTurnHasContent = true;
      continue;
    }

    // 其他事件(rate_limit / system 等)忽略
  }

  // 流末尾 flush(防止最后一个 turn 没有 turn.completed 收尾)
  flushTurn();

  return { turns, toolCalls, fullNumTurns, numSubAgents };
}
