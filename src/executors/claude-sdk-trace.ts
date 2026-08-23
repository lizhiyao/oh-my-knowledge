import type { ToolCallInfo, TurnInfo } from '../types/index.js';
import type { ClaudeSdkBaseMessage } from './claude-protocol.js';
import { safeSliceForJson } from '../util/safe-slice.js';
import { isToolResultFailureText } from '../observability/text-signals.js';
import { normalizeToolIdentity } from '../shared/tool-identity.js';

export function isClaudeSdkResultMessage(message: ClaudeSdkBaseMessage): boolean {
  return message.type === 'result';
}

export function extractAgentTrace(messages: ClaudeSdkBaseMessage[], timestamps?: number[]): { turns: TurnInfo[]; toolCalls: ToolCallInfo[]; fullNumTurns: number; numSubAgents: number } {
  const turns: TurnInfo[] = [];
  const toolCalls: ToolCallInfo[] = [];
  const pendingToolUse = new Map<string, ToolCallInfo[]>();
  let lastTurnTs = timestamps?.[0] || 0;
  let fullNumTurns = 0;
  let numSubAgents = 0;

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    const msgTs = timestamps?.[msgIdx] || 0;
    if (msg.type === 'result' || msg.type === 'system' || msg.type === 'rate_limit_event') continue;

    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    if (msg.type === 'assistant') {
      const textParts: string[] = [];
      const turnToolCalls: ToolCallInfo[] = [];
      let hasNonThinking = false;

      for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
        const block = content[blockIndex];
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
          hasNonThinking = true;
        } else if (block.type === 'tool_use' && block.name) {
          const toolIdentity = normalizeToolIdentity({ sourceName: block.name });
          const toolCall: ToolCallInfo = {
            tool: toolIdentity.name,
            ...(toolIdentity.sourceName ? { sourceTool: toolIdentity.sourceName } : {}),
            ...(toolIdentity.namespace ? { toolNamespace: toolIdentity.namespace } : {}),
            ...(toolIdentity.provider ? { toolProvider: toolIdentity.provider } : {}),
            input: block.input,
            output: null,
            status: 'unknown',
            statusSource: 'unknown',
            success: false,
            callInstanceId: `claude-sdk:${msgIdx}:${blockIndex}`,
            toolUseId: block.id,
          };
          if (block.id) {
            const pending = pendingToolUse.get(block.id) ?? [];
            pending.push(toolCall);
            pendingToolUse.set(block.id, pending);
          }
          turnToolCalls.push(toolCall);
          toolCalls.push(toolCall);
          hasNonThinking = true;
          if (toolIdentity.name === 'Agent') numSubAgents++;
        } else if (block.type !== 'thinking') {
          hasNonThinking = true;
        }
      }
      if (hasNonThinking) fullNumTurns++;

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
      for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
        const block = content[blockIndex];
        if (block.type !== 'tool_result') continue;
        const toolUseId = (block as unknown as { tool_use_id?: string }).tool_use_id || '';
        const pendingQueue = pendingToolUse.get(toolUseId);
        const pending = pendingQueue?.shift();
        if (pendingQueue?.length === 0) pendingToolUse.delete(toolUseId);
        const runtimeError = (block as unknown as { is_error?: boolean }).is_error;
        const hasRuntimeStatus = typeof runtimeError === 'boolean';
        const resultContent = (block as unknown as { content?: string | Array<{ type: string; text?: string }> }).content;
        const outputText = typeof resultContent === 'string'
          ? resultContent
          : Array.isArray(resultContent)
            ? resultContent.map((c) => c.text || '').join('')
            : '';

        // Mock 命中:omk 用 permissionDecision='deny' 把 stub 数据塞进 result.content,
        // is_error 因此为 true,但语义上是"mock 成功返回"。识别前缀 → 覆盖 success=true。
        // 见 src/eval-core/mocks-runtime.ts 的 wrappedReason 前缀。
        const isMockHit = outputText.startsWith('[mock] simulated tool output');
        const inferredFailure = !hasRuntimeStatus && isToolResultFailureText(outputText);

        const tc = pending ?? {
          tool: 'unknown',
          input: null,
          output: null,
          status: 'unknown',
          statusSource: 'unknown',
          success: false,
          callInstanceId: `claude-sdk:orphan-result:${msgIdx}:${blockIndex}`,
          toolUseId,
        } satisfies ToolCallInfo;
        tc.output = safeSliceForJson(outputText, 500, '');
        tc.status = isMockHit
          ? 'success'
          : hasRuntimeStatus
            ? runtimeError ? 'failure' : 'success'
            : inferredFailure ? 'failure' : 'unknown';
        tc.statusSource = isMockHit
          ? 'tool-output'
          : hasRuntimeStatus ? 'runtime' : inferredFailure ? 'inferred' : 'unknown';
        tc.success = tc.status === 'success';
        if (!pending) toolCalls.push(tc);

        const toolDur = msgTs && lastTurnTs ? msgTs - lastTurnTs : undefined;
        turns.push({
          role: 'tool',
          content: safeSliceForJson(outputText, 500, ''),
          ...(toolDur != null && toolDur > 0 && { durationMs: toolDur }),
        });
        if (msgTs) lastTurnTs = msgTs;
      }
    }
  }

  return { turns, toolCalls, fullNumTurns, numSubAgents };
}
