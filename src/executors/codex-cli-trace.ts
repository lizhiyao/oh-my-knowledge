import type { ToolCallInfo, TurnInfo } from '../types/index.js';
import type { CodexEvent } from './shared.js';

// Codex CLI(codex 0.125)`exec --json` 事件流 → omk trace 抽取器。
// 跟 claude-sdk-trace.ts 不同源:
//   Claude SDK 是 message[block] 嵌套结构,有 tool_use / tool_result 配对;
//   Codex 是事件流(turn.started → turn.completed,夹杂 item.* 事件),每个
//   item.completed 事件直接生成完整 ToolCallInfo,**不需要 use/result 配对**。
//
// schema(基于 codex 0.125 实测,fixture 测试锁住假设;漂移时 fixture 先红):
//   - {type:'thread.started' | 'turn.started'} 划 turn 边界
//   - {type:'turn.completed', usage} / {type:'turn.failed', error} 收尾
//   - {type:'item.started', item:{type, status:'in_progress', ...}} 是 in_progress 占位 → 跳过
//   - {type:'item.completed', item:{type:'agent_message', text:'...'}} → assistant 文本
//   - {type:'item.completed', item:{type:'command_execution', command, aggregated_output, exit_code, status}} → ToolCallInfo
//   - 其他 item.type(file_read/file_write/web_search 等)best-effort 抽 input/output
// codex 无 sub-agent 概念,numSubAgents 恒 0。字段缺失静默 skip 不 throw。

const TOOL_INPUT_LIMIT = 500;
const TOOL_OUTPUT_LIMIT = 500;

export function isCodexResultEvent(event: CodexEvent): boolean {
  return event.type === 'turn.completed' || event.type === 'turn.failed';
}

function extractToolInput(item: NonNullable<CodexEvent['item']>, itemType: string): unknown {
  if (itemType === 'command_execution') return (item.command || '').slice(0, TOOL_INPUT_LIMIT);
  if (itemType === 'file_read' || itemType === 'file_write') return item.path || null;
  if (itemType === 'web_search') return item.query || null;
  return null;
}

function extractToolOutput(item: NonNullable<CodexEvent['item']>, itemType: string): string {
  if (itemType === 'command_execution' && item.aggregated_output) {
    return item.aggregated_output.slice(0, TOOL_OUTPUT_LIMIT);
  }
  if (itemType === 'file_read' && item.content) return item.content.slice(0, TOOL_OUTPUT_LIMIT);
  if (item.results) return JSON.stringify(item.results).slice(0, TOOL_OUTPUT_LIMIT);
  return '';
}

export function extractCodexTrace(events: CodexEvent[]): { turns: TurnInfo[]; toolCalls: ToolCallInfo[]; fullNumTurns: number; numSubAgents: number } {
  const turns: TurnInfo[] = [];
  const toolCalls: ToolCallInfo[] = [];
  let fullNumTurns = 0;
  // codex 没有 Agent 工具(像 Claude 的 sub-agent),恒 0
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
      if (currentTurnHasContent || currentTurnTools.length > 0) flushTurn();
      if (event.ts) lastTurnTs = event.ts;
      continue;
    }

    if (t === 'turn.completed') {
      flushTurn(event);
      continue;
    }

    if (t === 'turn.failed') {
      if (currentTurnTools.length > 0) {
        currentTurnTools[currentTurnTools.length - 1].success = false;
      }
      flushTurn(event);
      continue;
    }

    // 只关心 item.completed —— item.started 是 in_progress 占位,后面会被 completed 覆盖
    if (t !== 'item.completed') continue;
    const item = event.item;
    if (!item || !item.type) continue;

    const itemType = item.type;
    if (itemType === 'agent_message') {
      const txt = item.text || '';
      if (txt) {
        if (currentTurnText) currentTurnText += '\n';
        currentTurnText += txt;
        currentTurnHasContent = true;
      }
      continue;
    }

    // 其他 item type 当 tool call
    const isError = !!event.error || (typeof item.exit_code === 'number' && item.exit_code !== 0);
    const tc: ToolCallInfo = {
      tool: itemType,
      input: extractToolInput(item, itemType),
      output: extractToolOutput(item, itemType),
      success: !isError,
    };
    currentTurnTools.push(tc);
    toolCalls.push(tc);
    currentTurnHasContent = true;
  }

  // 流末尾 flush(防止最后一个 turn 没 turn.completed 收尾)
  flushTurn();

  return { turns, toolCalls, fullNumTurns, numSubAgents };
}
