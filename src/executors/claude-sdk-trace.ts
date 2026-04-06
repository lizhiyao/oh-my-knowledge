import type { ToolCallInfo, TurnInfo } from '../types.js';
import type { ClaudeSdkBaseMessage } from './shared.js';

export function isClaudeSdkResultMessage(message: ClaudeSdkBaseMessage): boolean {
  return message.type === 'result';
}

export function extractAgentTrace(messages: ClaudeSdkBaseMessage[], timestamps?: number[]): { turns: TurnInfo[]; toolCalls: ToolCallInfo[] } {
  const turns: TurnInfo[] = [];
  const toolCalls: ToolCallInfo[] = [];
  const pendingToolUse = new Map<string, { tool: string; input: unknown }>();
  let lastTurnTs = timestamps?.[0] || 0;

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    const msgTs = timestamps?.[msgIdx] || 0;
    if (msg.type === 'result' || msg.type === 'system' || msg.type === 'rate_limit_event') continue;

    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    if (msg.type === 'assistant') {
      const textParts: string[] = [];
      const turnToolCalls: ToolCallInfo[] = [];

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        } else if (block.type === 'tool_use' && block.name) {
          pendingToolUse.set(block.id || '', { tool: block.name, input: block.input });
          turnToolCalls.push({ tool: block.name, input: block.input, output: null, success: true });
        }
      }

      if (textParts.length > 0 || turnToolCalls.length > 0) {
        const dur = msgTs && lastTurnTs ? msgTs - lastTurnTs : undefined;
        turns.push({
          role: 'assistant',
          content: textParts.join('\n'),
          ...(turnToolCalls.length > 0 && { toolCalls: turnToolCalls }),
          ...(dur != null && dur > 0 && { durationMs: dur }),
        });
        if (msgTs) lastTurnTs = msgTs;
      }
    }

    if (msg.type === 'user') {
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const toolUseId = (block as unknown as { tool_use_id?: string }).tool_use_id || '';
        const pending = pendingToolUse.get(toolUseId);
        const isError = (block as unknown as { is_error?: boolean }).is_error || false;
        const resultContent = (block as unknown as { content?: string | Array<{ type: string; text?: string }> }).content;
        const outputText = typeof resultContent === 'string'
          ? resultContent
          : Array.isArray(resultContent)
            ? resultContent.map((c) => c.text || '').join('')
            : '';

        const tc: ToolCallInfo = {
          tool: pending?.tool || 'unknown',
          input: pending?.input || null,
          output: outputText.slice(0, 500),
          success: !isError,
        };
        toolCalls.push(tc);

        if (pending) {
          for (let i = turns.length - 1; i >= 0; i--) {
            const turn = turns[i];
            if (turn.role === 'assistant' && turn.toolCalls) {
              const placeholder = turn.toolCalls.find((t) => t.tool === pending.tool && t.output === null);
              if (placeholder) {
                placeholder.output = tc.output;
                placeholder.success = !isError;
                break;
              }
            }
          }
        }

        const toolDur = msgTs && lastTurnTs ? msgTs - lastTurnTs : undefined;
        turns.push({
          role: 'tool',
          content: outputText.slice(0, 500),
          ...(toolDur != null && toolDur > 0 && { durationMs: toolDur }),
        });
        if (msgTs) lastTurnTs = msgTs;
        pendingToolUse.delete(toolUseId);
      }
    }
  }

  return { turns, toolCalls };
}
