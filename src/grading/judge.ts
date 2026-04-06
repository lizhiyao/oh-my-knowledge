import type { DimensionResult, ExecutorFn, ToolCallInfo, TurnInfo } from '../types.js';

interface JudgeResponse {
  score?: number | string;
  reason?: string;
}

interface LlmJudgeOptions {
  output: string;
  rubric: string;
  prompt: string;
  executor: ExecutorFn;
  model: string;
  traceSummary?: string | null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function buildTraceSummary(turns?: TurnInfo[], toolCalls?: ToolCallInfo[]): string | null {
  if ((!turns || turns.length === 0) && (!toolCalls || toolCalls.length === 0)) return null;

  const lines: string[] = [];

  if (toolCalls && toolCalls.length > 0) {
    lines.push(`共调用 ${toolCalls.length} 个工具：`);
    const successCount = toolCalls.filter((tc) => tc.success).length;
    const failureCount = toolCalls.length - successCount;
    lines.push(`  成功 ${successCount}/${toolCalls.length}`);
    if (failureCount > 0) lines.push(`  失败 ${failureCount}/${toolCalls.length}`);

    const dist: Record<string, number> = {};
    for (const tc of toolCalls) {
      dist[tc.tool] = (dist[tc.tool] || 0) + 1;
    }
    lines.push(`  工具分布：${Object.entries(dist).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    const failedTools = toolCalls.filter((tc) => !tc.success).map((tc) => tc.tool);
    if (failedTools.length > 0) {
      lines.push(`  失败工具：${[...new Set(failedTools)].join(', ')}`);
    }
  }

  if (turns && turns.length > 0) {
    lines.push('');
    lines.push('执行轨迹摘要：');
    const assistantTurns = turns.filter((turn) => turn.role === 'assistant').length;
    const toolTurns = turns.filter((turn) => turn.role === 'tool').length;
    lines.push(`  共 ${turns.length} 步（assistant ${assistantTurns} / tool ${toolTurns}）`);
    const maxTurns = Math.min(turns.length, 10);
    for (let i = 0; i < maxTurns; i++) {
      const t = turns[i];
      const preview = t.content.slice(0, 100) + (t.content.length > 100 ? '...' : '');
      if (t.role === 'assistant' && t.toolCalls?.length) {
        lines.push(`  [${i + 1}] assistant: 调用 ${t.toolCalls.map((tc) => tc.tool).join(', ')}`);
      } else if (t.role === 'tool') {
        lines.push(`  [${i + 1}] tool: ${preview}`);
      } else {
        lines.push(`  [${i + 1}] ${t.role}: ${preview}`);
      }
    }
    if (turns.length > maxTurns) lines.push(`  ... 还有 ${turns.length - maxTurns} 步`);
  }

  return lines.join('\n');
}

export async function llmJudge({ output, rubric, prompt, executor, model, traceSummary }: LlmJudgeOptions): Promise<DimensionResult> {
  const traceSection = traceSummary
    ? ['', '## Agent 执行过程', traceSummary, '', '请同时考虑执行过程的合理性（工具选择、步骤效率、错误恢复）。']
    : [];

  const judgePrompt = [
    '请对以下 AI 输出进行质量评分。',
    '',
    '## 原始任务',
    prompt,
    '',
    '## 评分标准',
    rubric,
    '',
    '## AI 输出',
    output,
    ...traceSection,
    '',
    '请返回 JSON（不要包含 markdown 代码块标记）：',
    '{"score": <1-5的整数>, "reason": "<简短理由>"}',
    '',
    '评分标准：1=完全不达标, 2=部分涉及, 3=基本达标, 4=较好, 5=优秀',
  ].join('\n');

  const result = await executor({
    model,
    system: '你是一个严格的 AI 输出质量评审员。只返回 JSON，不要其他内容。',
    prompt: judgePrompt,
  });

  if (!result.ok) return { score: 0, reason: `judge error: ${result.error}`, judgeCostUSD: result.costUSD };

  try {
    const text = result.output!.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      process.stderr.write(`[omk] LLM judge returned non-JSON: ${text.slice(0, 100)}\n`);
      return { score: 0, reason: 'judge returned non-JSON', judgeCostUSD: result.costUSD };
    }
    const parsed = JSON.parse(jsonMatch[0]) as JudgeResponse;
    return {
      score: Number(parsed.score) || 0,
      reason: String(parsed.reason || ''),
      judgeCostUSD: result.costUSD,
    };
  } catch (parseErr: unknown) {
    process.stderr.write(`[omk] LLM judge parse error: ${getErrorMessage(parseErr)}\n`);
    return { score: 0, reason: 'failed to parse judge response', judgeCostUSD: result.costUSD };
  }
}
