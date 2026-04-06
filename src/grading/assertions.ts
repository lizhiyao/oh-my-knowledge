import { resolve } from 'node:path';
import _Ajv from 'ajv';
import type { Assertion, AssertionDetail, AssertionResults, ExecutorFn, Sample, ToolCallInfo } from '../types.js';

const Ajv = _Ajv.default ?? _Ajv;
const ajv = new Ajv();
const CUSTOM_ASSERTION_TIMEOUT_MS = 30_000;

export const ASYNC_ASSERTION_TYPES = new Set(['semantic_similarity', 'custom']);

export interface AsyncAssertionContext {
  executor: ExecutorFn;
  judgeModel: string;
  sample: Sample;
  samplesDir: string;
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

export function ratioToScore(ratio: number): number {
  return Number((1 + ratio * 4).toFixed(2));
}

export function validateJsonSchema(data: unknown, schema: Record<string, unknown>): boolean {
  if (!schema || typeof schema !== 'object') return true;
  try {
    const validate = ajv.compile(schema);
    return validate(data) as boolean;
  } catch {
    return false;
  }
}

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
        passed = (assertion.values || []).every((v) => toolNames.includes(String(v).toLowerCase()));
        break;
      case 'tools_not_called':
        passed = (assertion.values || []).every((v) => !toolNames.includes(String(v).toLowerCase()));
        break;
      case 'tools_count_max':
        passed = toolCalls.length <= (assertion.value as number);
        break;
      case 'tools_count_min':
        passed = toolCalls.length >= (assertion.value as number);
        break;
      case 'tool_output_contains': {
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
        const sep = String(assertion.value).indexOf(':');
        if (sep > 0) {
          const targetTool = String(assertion.value).slice(0, sep).toLowerCase();
          const expected = String(assertion.value).slice(sep + 1).toLowerCase();
          passed = toolCalls.some((tc) =>
            tc.tool.toLowerCase() === targetTool &&
            JSON.stringify(tc.input || '').toLowerCase().includes(expected),
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
  const ratio = totalWeight > 0 ? passedWeight / totalWeight : 0;

  return {
    passed: passedCount,
    total: details.length,
    score: ratioToScore(ratio),
    details,
  };
}

export async function runAsyncAssertions(output: string, assertions: Assertion[], { executor, judgeModel, sample, samplesDir }: AsyncAssertionContext): Promise<AssertionResults> {
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

  return { passed: passedCount, total: details.length, score: ratioToScore(ratio), details, judgeCostUSD: asyncCostUSD };
}
