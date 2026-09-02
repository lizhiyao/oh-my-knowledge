import { incrementRecordCount } from '../../shared/record-count.js';
import {
  isToolCallCancelled,
  isToolCallFailure,
  isToolCallSuccess,
  isToolCallUnknown,
  toolCallStatus,
} from '../../executors/tool-call-status.js';
import type { ToolCallInfo, TurnInfo } from '../../executors/contracts/trace.js';

const INPUT_PREVIEW_MAX = 280;
const TOOL_DETAIL_MAX_CALLS = 12;

export const JUDGE_TRACE_SUMMARY_ALGORITHM_VERSION =
  'omk.judge-trace-summary/v1' as const;

function previewToolInput(toolCall: ToolCallInfo): string {
  const input = toolCall.input as unknown;
  if (input == null) return '';
  if (typeof input === 'object'
      && 'command' in input
      && typeof (input as { command: unknown }).command === 'string') {
    const command = (input as { command: string }).command;
    return command.length > INPUT_PREVIEW_MAX
      ? `${command.slice(0, INPUT_PREVIEW_MAX)}…`
      : command;
  }
  const representation = typeof input === 'string' ? input : JSON.stringify(input);
  return representation.length > INPUT_PREVIEW_MAX
    ? `${representation.slice(0, INPUT_PREVIEW_MAX)}…`
    : representation;
}

/**
 * Converts provider-neutral turns and tool calls into the exact rubric prompt
 * context used by the legacy grader. This shaping logic is part of the rubric
 * instrument and is shared by both old and Core execution paths.
 */
export function buildJudgeTraceSummary(
  turns?: readonly TurnInfo[],
  toolCalls?: readonly ToolCallInfo[],
): string | null {
  if ((!turns || turns.length === 0) && (!toolCalls || toolCalls.length === 0)) return null;

  const lines: string[] = [];

  if (toolCalls && toolCalls.length > 0) {
    lines.push(`共调用 ${toolCalls.length} 个工具：`);
    const successCount = toolCalls.filter(isToolCallSuccess).length;
    const failureCount = toolCalls.filter(isToolCallFailure).length;
    const cancelledCount = toolCalls.filter(isToolCallCancelled).length;
    const unknownCount = toolCalls.filter(isToolCallUnknown).length;
    lines.push(`  成功 ${successCount}/${toolCalls.length}`);
    if (failureCount > 0) lines.push(`  失败 ${failureCount}/${toolCalls.length}`);
    if (cancelledCount > 0) lines.push(`  取消 ${cancelledCount}/${toolCalls.length}`);
    if (unknownCount > 0) lines.push(`  状态未知 ${unknownCount}/${toolCalls.length}`);

    const distribution: Record<string, number> = {};
    for (const toolCall of toolCalls) incrementRecordCount(distribution, toolCall.tool);
    lines.push(`  工具分布：${Object.entries(distribution).map(([key, value]) => `${key}(${value})`).join(', ')}`);
    const failedTools = toolCalls.filter(isToolCallFailure).map((toolCall) => toolCall.tool);
    if (failedTools.length > 0) {
      lines.push(`  失败工具：${[...new Set(failedTools)].join(', ')}`);
    }

    lines.push('  调用详情(注意:Bash 命令内的 `mcporter --tool X` / `code-host Y` 等才是真实语义调用):');
    const detailCap = Math.min(toolCalls.length, TOOL_DETAIL_MAX_CALLS);
    for (let index = 0; index < detailCap; index++) {
      const toolCall = toolCalls[index];
      const resultStatus = toolCallStatus(toolCall);
      const status = resultStatus === 'failure'
        ? ' [失败]'
        : resultStatus === 'cancelled'
          ? ' [取消]'
          : resultStatus === 'unknown' ? ' [状态未知]' : '';
      lines.push(`    [${index + 1}] ${toolCall.tool}${status} → ${previewToolInput(toolCall)}`);
    }
    if (toolCalls.length > TOOL_DETAIL_MAX_CALLS) {
      lines.push(`    ... 还有 ${toolCalls.length - TOOL_DETAIL_MAX_CALLS} 次调用`);
    }
  }

  if (turns && turns.length > 0) {
    lines.push('');
    lines.push('执行轨迹摘要：');
    const userTurns = turns.filter((turn) => turn.role === 'user').length;
    const assistantTurns = turns.filter((turn) => turn.role === 'assistant').length;
    const toolTurns = turns.filter((turn) => turn.role === 'tool').length;
    lines.push(`  共 ${turns.length} 步（user ${userTurns} / assistant ${assistantTurns} / tool ${toolTurns}）`);
    const maxTurns = Math.min(turns.length, 10);
    for (let index = 0; index < maxTurns; index++) {
      const turn = turns[index];
      const preview = turn.content.slice(0, 100) + (turn.content.length > 100 ? '...' : '');
      if (turn.role === 'assistant' && turn.toolCalls?.length) {
        lines.push(`  [${index + 1}] assistant: 调用 ${turn.toolCalls.map((toolCall) => toolCall.tool).join(', ')}`);
      } else if (turn.role === 'tool') {
        lines.push(`  [${index + 1}] tool: ${preview}`);
      } else {
        lines.push(`  [${index + 1}] ${turn.role}: ${preview}`);
      }
    }
    if (turns.length > maxTurns) lines.push(`  ... 还有 ${turns.length - maxTurns} 步`);
  }

  return lines.join('\n');
}
