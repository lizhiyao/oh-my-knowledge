import { createHash } from 'node:crypto';
import type { DimensionResult, ExecutorFn, ToolCallInfo, TurnInfo } from '../types.js';

interface JudgeResponse {
  score?: number | string;
  reason?: string;
  reasoning?: string;
}

/**
 * Judge prompt template version. Bump when the prompt's intent or structure changes
 * meaningfully — reports tagged with the same hash are score-comparable; mismatched
 * hashes mean "we changed how we ask the judge to think" and should not be compared blind.
 */
const JUDGE_PROMPT_TEMPLATE_V = 'v2-cot';

const JUDGE_SYSTEM_PROMPT = '你是一个严格的 AI 输出质量评审员。先逐条对照评分标准做推理，再给最终分数。只返回 JSON，不要其他内容。';

function buildJudgePrompt(prompt: string, rubric: string, output: string, traceSummary: string | null): string {
  const traceSection = traceSummary
    ? ['', '## Agent 执行过程', traceSummary, '', '请同时考虑执行过程的合理性（工具选择、步骤效率、错误恢复）。']
    : [];

  return [
    `请对以下 AI 输出进行质量评分（template ${JUDGE_PROMPT_TEMPLATE_V}）。`,
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
    '## 评分流程',
    '1. 逐条对照评分标准，先做推理（reasoning）：列出 AI 输出哪些点对应哪条标准，哪些缺失，哪些有歧义。',
    '2. 基于推理给出最终分数（1-5 的整数）和简短理由。',
    '',
    '请返回 JSON（不要包含 markdown 代码块标记）：',
    '{"reasoning": "<对照标准的逐条推理>", "score": <1-5的整数>, "reason": "<最终结论的简短理由>"}',
    '',
    '评分标准：1=完全不达标, 2=部分涉及, 3=基本达标, 4=较好, 5=优秀',
  ].join('\n');
}

/**
 * Stable hash of the judge prompt template. Saved into ReportMeta.judgePromptHash so
 * downstream readers can detect "the judge prompt changed between these two reports".
 */
export function getJudgePromptHash(): string {
  // Hash the template-shaping function source + the version tag together. We hash a
  // deterministic stringified form of the template (with placeholder inputs) so any
  // structural edit shows up.
  const sample = buildJudgePrompt('<P>', '<R>', '<O>', '<T>');
  return createHash('sha256').update(JUDGE_PROMPT_TEMPLATE_V + '\n' + sample).digest('hex').slice(0, 12);
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
  const judgePrompt = buildJudgePrompt(prompt, rubric, output, traceSummary || null);

  const result = await executor({
    model,
    system: JUDGE_SYSTEM_PROMPT,
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
      reasoning: parsed.reasoning ? String(parsed.reasoning) : undefined,
      judgeCostUSD: result.costUSD,
    };
  } catch (parseErr: unknown) {
    process.stderr.write(`[omk] LLM judge parse error: ${getErrorMessage(parseErr)}\n`);
    return { score: 0, reason: 'failed to parse judge response', judgeCostUSD: result.costUSD };
  }
}

/**
 * Judge a single (output, rubric) pair N times and aggregate. Returns mean score,
 * stddev across runs, the raw score samples, and the first-run reasoning (we don't
 * keep N reasonings — only the score distribution matters for stability monitoring).
 *
 * Cost is summed across all N calls. When N <= 1 this is equivalent to llmJudge()
 * with scoreSamples = [score], scoreStddev = 0. The repeat value is clamped to >= 1
 * here as well as at the CLI layer — library callers shouldn't see surprises.
 *
 * Failures: any call returning score=0 (non-JSON / executor error / parse error) is
 * counted in `judgeFailureCount`. stddev is computed only over successful calls. If
 * stddev is 0 but judgeFailureCount > 0, that's NOT "judge agreed perfectly" — it
 * means most calls failed and one happened to succeed. Always inspect both fields.
 */
export async function llmJudgeRepeat(
  options: LlmJudgeOptions,
  repeat: number,
): Promise<DimensionResult> {
  const n = Math.max(1, Math.floor(repeat) || 1);
  if (n === 1) {
    const single = await llmJudge(options);
    const failed = single.score <= 0 ? 1 : 0;
    return { ...single, scoreSamples: [single.score], scoreStddev: 0, judgeFailureCount: failed };
  }

  const samples: number[] = [];
  const reasons: string[] = [];
  let totalCost = 0;
  let firstReasoning: string | undefined;

  for (let i = 0; i < n; i++) {
    const r = await llmJudge(options);
    samples.push(r.score);
    if (r.reason) reasons.push(r.reason);
    if (r.judgeCostUSD) totalCost += r.judgeCostUSD;
    if (i === 0 && r.reasoning) firstReasoning = r.reasoning;
  }

  const validSamples = samples.filter((s) => s > 0);
  const failures = samples.length - validSamples.length;
  const mean = validSamples.length > 0 ? validSamples.reduce((a, b) => a + b, 0) / validSamples.length : 0;
  const variance = validSamples.length > 1
    ? validSamples.reduce((s, x) => s + (x - mean) ** 2, 0) / (validSamples.length - 1)
    : 0;
  const stddev = Math.sqrt(variance);

  return {
    score: Number(mean.toFixed(2)),
    reason: reasons[0] || '',
    reasoning: firstReasoning,
    judgeCostUSD: totalCost,
    scoreSamples: samples,
    scoreStddev: Number(stddev.toFixed(3)),
    judgeFailureCount: failures,
  };
}
