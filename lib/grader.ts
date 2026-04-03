/**
 * Mixed grading: deterministic assertions + LLM judge + multi-dimensional scoring.
 */

import { resolve } from 'node:path';
import _Ajv from 'ajv';
// ajv CJS interop: default export wrapping
const Ajv = _Ajv.default ?? _Ajv;
import type { Assertion, AssertionResults, AssertionDetail, GradeResult, DimensionResult, ExecutorFn, Sample, ToolCallInfo, TurnInfo } from './types.js';

// Async assertion types that need LLM or dynamic imports
const ASYNC_ASSERTION_TYPES = new Set(['semantic_similarity', 'custom']);

// Score scale: maps pass ratio (0.0~1.0) to score (SCORE_MIN~SCORE_MAX)
const SCORE_MIN = 1;
const SCORE_MAX = 5;
const SCORE_RANGE = SCORE_MAX - SCORE_MIN;

// Custom assertion timeout (ms)
const CUSTOM_ASSERTION_TIMEOUT_MS = 30_000;

function ratioToScore(ratio: number): number {
  return Number((SCORE_MIN + ratio * SCORE_RANGE).toFixed(2));
}

interface GradeOptions {
  output: string;
  sample: Sample;
  executor: ExecutorFn;
  judgeModel: string;
  execMetrics?: { costUSD?: number; durationMs?: number; numTurns?: number; toolCalls?: ToolCallInfo[]; turns?: TurnInfo[] };
  samplesDir?: string;
}

interface JudgeResponse {
  score?: number | string;
  reason?: string;
}

interface CustomAssertionModule {
  default?: CustomAssertionFn;
  check?: CustomAssertionFn;
}

interface CustomAssertionResult {
  pass?: boolean;
  message?: string;
}

type CustomAssertionFn = (output: string, context: { sample: Sample; assertion: Assertion }) =>
  Promise<CustomAssertionResult> | CustomAssertionResult;

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Grade a model output against a sample's criteria.
 */
export async function grade({ output, sample, executor, judgeModel, execMetrics = {}, samplesDir = '.' }: GradeOptions): Promise<GradeResult> {
  const results: {
    assertions?: AssertionResults;
    llmScore?: number;
    llmReason?: string;
    dimensions?: Record<string, DimensionResult>;
    judgeCostUSD?: number;
    compositeScore: number;
  } = { compositeScore: 0 };

  // 1. Deterministic assertions (pure, no LLM)
  const allAssertions = sample.assertions || [];
  const syncAssertions = allAssertions.filter((a) => !ASYNC_ASSERTION_TYPES.has(a.type));
  const asyncAssertions = allAssertions.filter((a) => ASYNC_ASSERTION_TYPES.has(a.type));

  if (syncAssertions.length > 0) {
    results.assertions = runAssertions(output, syncAssertions, { ...execMetrics });
  }

  // 1b. Async assertions (custom JS, semantic_similarity)
  if (asyncAssertions.length > 0 && executor != null) {
    const asyncResults = await runAsyncAssertions(output, asyncAssertions, {
      executor, judgeModel, sample, samplesDir,
    });
    if (results.assertions) {
      // Merge async results into sync results
      results.assertions.details.push(...asyncResults.details);
      results.assertions.total += asyncResults.total;
      results.assertions.passed += asyncResults.passed;
      // Recompute score from merged details
      const allDetails = results.assertions.details;
      const totalWeight = allDetails.reduce((s, d) => s + d.weight, 0);
      const passedWeight = allDetails.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
      const ratio = totalWeight > 0 ? passedWeight / totalWeight : 0;
      results.assertions.score = ratioToScore(ratio);
    } else {
      results.assertions = asyncResults;
    }
    // Accumulate async assertion judge cost
    if (asyncResults.judgeCostUSD && asyncResults.judgeCostUSD > 0) {
      results.judgeCostUSD = (results.judgeCostUSD || 0) + asyncResults.judgeCostUSD;
    }
  }

  // 2. LLM scoring
  // Build execution trace summary for agent-aware judging
  const traceSummary = buildTraceSummary(execMetrics.turns, execMetrics.toolCalls);

  if (sample.dimensions && Object.keys(sample.dimensions).length > 0) {
    // Multi-dimensional scoring
    results.dimensions = {};
    for (const [dim, rubric] of Object.entries(sample.dimensions)) {
      results.dimensions[dim] = await llmJudge({
        output,
        rubric,
        prompt: sample.prompt,
        executor,
        model: judgeModel,
        traceSummary,
      });
    }
    const dimValues = Object.values(results.dimensions);
    const dimScores = dimValues.map((d) => d.score).filter((s) => s > 0);
    if (dimScores.length > 0) {
      results.llmScore = Number((dimScores.reduce((a, b) => a + b, 0) / dimScores.length).toFixed(2));
    }
    // Accumulate judge cost from all dimensions (add to any existing async assertion cost)
    const dimCost = dimValues.reduce((s, d) => s + (d.judgeCostUSD || 0), 0);
    if (dimCost > 0) results.judgeCostUSD = (results.judgeCostUSD || 0) + dimCost;
  } else if (sample.rubric) {
    // Single rubric scoring
    const judge = await llmJudge({
      output,
      rubric: sample.rubric,
      prompt: sample.prompt,
      executor,
      model: judgeModel,
      traceSummary,
    });
    results.llmScore = judge.score;
    results.llmReason = judge.reason;
    results.judgeCostUSD = (results.judgeCostUSD || 0) + (judge.judgeCostUSD || 0);
  }

  // 3. Composite score
  results.compositeScore = computeComposite(results);

  return results;
}

/**
 * Run deterministic assertions against output text.
 * Pure function — no async, no LLM calls.
 */
export function runAssertions(output: string, assertions: Assertion[], context: { costUSD?: number; durationMs?: number; numTurns?: number; toolCalls?: ToolCallInfo[] } = {}): AssertionResults {
  const outputLower = output.toLowerCase();
  const details: AssertionDetail[] = [];
  const toolCalls = context.toolCalls || [];
  const toolNames = toolCalls.map((tc) => tc.tool.toLowerCase());

  for (const assertion of assertions) {
    const weight = assertion.weight ?? 1;
    let passed = false;

    switch (assertion.type) {
      case 'contains':
        passed = outputLower.includes(String(assertion.value).toLowerCase());
        break;
      case 'not_contains':
        passed = !outputLower.includes(String(assertion.value).toLowerCase());
        break;
      case 'regex': {
        const flags = assertion.flags || 'i';
        const re = new RegExp(assertion.pattern!, flags);
        passed = re.test(output);
        break;
      }
      case 'min_length':
        passed = output.length >= (assertion.value as number);
        break;
      case 'max_length':
        passed = output.length <= (assertion.value as number);
        break;
      case 'json_valid':
        try { JSON.parse(output); passed = true; } catch { passed = false; }
        break;
      case 'json_schema':
        try {
          const data = JSON.parse(output);
          passed = validateJsonSchema(data, assertion.schema!);
        } catch { passed = false; }
        break;
      case 'starts_with':
        passed = outputLower.startsWith(String(assertion.value).toLowerCase());
        break;
      case 'ends_with':
        passed = outputLower.endsWith(String(assertion.value).toLowerCase());
        break;
      case 'equals':
        passed = output.trim() === String(assertion.value).trim();
        break;
      case 'not_equals':
        passed = output.trim() !== String(assertion.value).trim();
        break;
      case 'word_count_min':
        passed = output.split(/\s+/).filter(Boolean).length >= (assertion.value as number);
        break;
      case 'word_count_max':
        passed = output.split(/\s+/).filter(Boolean).length <= (assertion.value as number);
        break;
      case 'contains_all':
        passed = (assertion.values || []).every((v) => outputLower.includes(String(v).toLowerCase()));
        break;
      case 'contains_any':
        passed = (assertion.values || []).some((v) => outputLower.includes(String(v).toLowerCase()));
        break;
      case 'cost_max':
        passed = (context.costUSD ?? Infinity) <= (assertion.value as number);
        break;
      case 'latency_max':
        passed = (context.durationMs ?? Infinity) <= (assertion.value as number);
        break;
      case 'turns_max':
        passed = (context.numTurns ?? Infinity) <= (assertion.value as number);
        break;
      case 'turns_min':
        passed = (context.numTurns ?? 0) >= (assertion.value as number);
        break;
      case 'tools_called':
        // Assert that specific tools were called (values = expected tool names)
        passed = (assertion.values || []).every((v) => toolNames.includes(String(v).toLowerCase()));
        break;
      case 'tools_not_called':
        // Assert that specific tools were NOT called
        passed = (assertion.values || []).every((v) => !toolNames.includes(String(v).toLowerCase()));
        break;
      case 'tools_count_max':
        passed = toolCalls.length <= (assertion.value as number);
        break;
      case 'tools_count_min':
        passed = toolCalls.length >= (assertion.value as number);
        break;
      case 'tool_output_contains': {
        // Assert that a specific tool's output contains a string
        // value = "toolName:expectedContent"
        const sep = String(assertion.value).indexOf(':');
        if (sep > 0) {
          const targetTool = String(assertion.value).slice(0, sep).toLowerCase();
          const expected = String(assertion.value).slice(sep + 1).toLowerCase();
          passed = toolCalls.some((tc) =>
            tc.tool.toLowerCase() === targetTool &&
            String(tc.output || '').toLowerCase().includes(expected),
          );
        }
        break;
      }
      case 'tool_input_contains': {
        // Assert that a specific tool was called with input containing a string
        // value = "toolName:expectedInputContent"
        const sep2 = String(assertion.value).indexOf(':');
        if (sep2 > 0) {
          const targetTool2 = String(assertion.value).slice(0, sep2).toLowerCase();
          const expected2 = String(assertion.value).slice(sep2 + 1).toLowerCase();
          passed = toolCalls.some((tc) =>
            tc.tool.toLowerCase() === targetTool2 &&
            JSON.stringify(tc.input || '').toLowerCase().includes(expected2),
          );
        }
        break;
      }
      default:
        passed = false;
    }

    details.push({
      type: assertion.type,
      value: assertion.value ?? assertion.pattern ?? assertion.values?.join(', ') ?? '',
      weight,
      passed,
    });
  }

  const totalWeight = details.reduce((s, d) => s + d.weight, 0);
  const passedWeight = details.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
  const passedCount = details.filter((d) => d.passed).length;

  // Normalize to 1-5 scale
  const ratio = totalWeight > 0 ? passedWeight / totalWeight : 0;
  const score = ratioToScore(ratio);

  return {
    passed: passedCount,
    total: details.length,
    score,
    details,
  };
}

/**
 * Validate data against a JSON Schema using ajv.
 */
const ajv = new Ajv();

export function validateJsonSchema(data: unknown, schema: Record<string, unknown>): boolean {
  if (!schema || typeof schema !== 'object') return true;
  try {
    const validate = ajv.compile(schema);
    return validate(data) as boolean;
  } catch {
    return false;
  }
}

interface AsyncAssertionContext {
  executor: ExecutorFn;
  judgeModel: string;
  sample: Sample;
  samplesDir: string;
}

/**
 * Run async assertions (custom JS functions, semantic_similarity).
 */
async function runAsyncAssertions(output: string, assertions: Assertion[], { executor, judgeModel, sample, samplesDir }: AsyncAssertionContext): Promise<AssertionResults> {
  const details: AssertionDetail[] = [];
  let asyncCostUSD = 0;

  for (const assertion of assertions) {
    const weight = assertion.weight ?? 1;
    let passed = false;
    let message = '';

    if (assertion.type === 'semantic_similarity') {
      const reference = assertion.reference || '';
      const judgePrompt = [
        '请判断以下两段文本的语义相似度。',
        '',
        '## 参考文本',
        reference,
        '',
        '## 待评估文本',
        output,
        '',
        '请返回 JSON（不要包含 markdown 代码块标记）：',
        '{"score": <1-5的整数>, "reason": "<简短理由>"}',
        '',
        '评分：1=完全无关, 2=略有关联, 3=部分相似, 4=大致相同, 5=高度一致',
      ].join('\n');

      const result = await executor({
        model: judgeModel,
        system: '你是语义相似度评审员。只返回 JSON，不要其他内容。',
        prompt: judgePrompt,
      });

      asyncCostUSD += result.costUSD || 0;
      if (result.ok) {
        try {
          const jsonMatch = result.output!.trim().match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as JudgeResponse;
            const score = Number(parsed.score) || 0;
            const threshold = assertion.threshold ?? 3;
            passed = score >= threshold;
            message = parsed.reason || '';
          } else {
            process.stderr.write(`[omk] semantic_similarity judge returned non-JSON: ${result.output!.slice(0, 100)}\n`);
          }
        } catch (parseErr: unknown) {
          process.stderr.write(`[omk] semantic_similarity judge parse error: ${getErrorMessage(parseErr)}\n`);
        }
      }
    } else if (assertion.type === 'custom') {
      try {
        const fnPath = resolve(samplesDir, assertion.fn!);
        const mod = await import(fnPath) as CustomAssertionModule;
        const fn = mod.default || mod.check;
        if (!fn) throw new Error('custom assertion module must export default or check');
        // Timeout custom assertion at 30 seconds
        const result = await Promise.race<CustomAssertionResult>([
          fn(output, { sample, assertion }),
          new Promise<CustomAssertionResult>((_, reject) => setTimeout(() => reject(new Error(`custom assertion timed out (${CUSTOM_ASSERTION_TIMEOUT_MS / 1000}s)`)), CUSTOM_ASSERTION_TIMEOUT_MS)),
        ]);
        passed = Boolean(result.pass);
        message = result.message || '';
      } catch (err: unknown) {
        passed = false;
        message = `custom assertion error: ${getErrorMessage(err)}`;
      }
    }

    details.push({
      type: assertion.type,
      value: assertion.reference || assertion.fn || '',
      weight,
      passed,
      ...(message && { message }),
    });
  }

  const totalWeight = details.reduce((s, d) => s + d.weight, 0);
  const passedWeight = details.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
  const passedCount = details.filter((d) => d.passed).length;
  const ratio = totalWeight > 0 ? passedWeight / totalWeight : 0;
  const score = ratioToScore(ratio);

  return { passed: passedCount, total: details.length, score, details, judgeCostUSD: asyncCostUSD };
}

/**
 * Build a concise summary of agent execution trace for LLM judge context.
 */
export function buildTraceSummary(turns?: TurnInfo[], toolCalls?: ToolCallInfo[]): string | null {
  if ((!turns || turns.length === 0) && (!toolCalls || toolCalls.length === 0)) return null;

  const lines: string[] = [];

  if (toolCalls && toolCalls.length > 0) {
    lines.push(`共调用 ${toolCalls.length} 个工具：`);
    const successCount = toolCalls.filter((tc) => tc.success).length;
    lines.push(`  成功 ${successCount}/${toolCalls.length}`);

    // Tool distribution
    const dist: Record<string, number> = {};
    for (const tc of toolCalls) {
      dist[tc.tool] = (dist[tc.tool] || 0) + 1;
    }
    lines.push(`  工具分布：${Object.entries(dist).map(([k, v]) => `${k}(${v})`).join(', ')}`);
  }

  if (turns && turns.length > 0) {
    lines.push('');
    lines.push('执行轨迹摘要：');
    // Only include first 10 turns to keep prompt concise
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
    if (turns.length > maxTurns) {
      lines.push(`  ... 还有 ${turns.length - maxTurns} 步`);
    }
  }

  return lines.join('\n');
}

interface LlmJudgeOptions {
  output: string;
  rubric: string;
  prompt: string;
  executor: ExecutorFn;
  model: string;
  traceSummary?: string | null;
}

/**
 * LLM judge: ask a model to score output against a rubric.
 */
async function llmJudge({ output, rubric, prompt, executor, model, traceSummary }: LlmJudgeOptions): Promise<DimensionResult> {
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

interface CompositeInput {
  assertions?: AssertionResults;
  llmScore?: number;
}

/**
 * Compute composite score from assertion and LLM results.
 *
 * Scoring dimensions (each weighted equally when present):
 * - assertions: deterministic rule checks (1-5)
 * - llmScore: LLM judge evaluation (1-5)
 * - efficiency: from efficiency assertions (cost_max, latency_max, turns_max) if present
 *
 * When efficiency assertions exist, they are split out from the main assertion score
 * and treated as a separate dimension to give efficiency proper weight.
 */
function computeComposite(results: CompositeInput): number {
  const hasAssertions = results.assertions && results.assertions.score > 0;
  const hasLlm = typeof results.llmScore === 'number' && results.llmScore > 0;

  // Check if there are efficiency assertions mixed into the assertion results
  const EFFICIENCY_TYPES = new Set(['cost_max', 'latency_max', 'turns_max', 'turns_min', 'tools_count_max', 'tools_count_min']);
  let efficiencyScore: number | null = null;
  let contentScore: number | null = null;

  if (hasAssertions && results.assertions!.details) {
    const effDetails = results.assertions!.details.filter((d) => EFFICIENCY_TYPES.has(d.type));
    const contentDetails = results.assertions!.details.filter((d) => !EFFICIENCY_TYPES.has(d.type));

    if (effDetails.length > 0 && contentDetails.length > 0) {
      // Split into efficiency and content scores
      const effWeight = effDetails.reduce((s, d) => s + d.weight, 0);
      const effPassedWeight = effDetails.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
      efficiencyScore = effWeight > 0 ? ratioToScore(effPassedWeight / effWeight) : null;

      const contentWeight = contentDetails.reduce((s, d) => s + d.weight, 0);
      const contentPassedWeight = contentDetails.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
      contentScore = contentWeight > 0 ? ratioToScore(contentPassedWeight / contentWeight) : null;
    }
  }

  // Build dimensions array
  const dimensions: number[] = [];
  if (efficiencyScore !== null && contentScore !== null) {
    // Split mode: content assertions + efficiency assertions as separate dimensions
    dimensions.push(contentScore);
    if (hasLlm) dimensions.push(results.llmScore!);
    dimensions.push(efficiencyScore);
  } else {
    // Original mode: assertions and LLM as before
    if (hasAssertions) dimensions.push(results.assertions!.score);
    if (hasLlm) dimensions.push(results.llmScore!);
  }

  if (dimensions.length === 0) return 0;
  return Number((dimensions.reduce((a, b) => a + b, 0) / dimensions.length).toFixed(2));
}
