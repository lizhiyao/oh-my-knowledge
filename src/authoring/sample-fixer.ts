import type { EvaluationReport } from '../types/report.js';
import type { Sample } from '../types/index.js';
import { sanitizeGeneratedSamples } from './generator.js';

export interface FixContext {
  sampleId: string;
  originalSample: Record<string, unknown>;
  diagnosticSummary: string;
  expected: string;
  actual: string;
  suggestionSample: string;
  rootCause: string[];
  failedAssertions: Array<{ type: string; value: string; passed: boolean }>;
  toolCalls: Array<{ tool: string; input: unknown; success: boolean }>;
}

export interface FixSamplesOptions {
  skillContent: string;
  samples: Record<string, unknown>[];
  report: EvaluationReport;
  treatmentKey: string;
  executor: (opts: { model: string; system: string; prompt: string; timeoutMs: number; lean?: boolean }) => Promise<{ ok: boolean; text: string; costUSD: number }>;
  model?: string;
  maxAttemptsPerSample?: number;
}

export interface FixSamplesResult {
  samples: Record<string, unknown>[];
  fixedCount: number;
  costUSD: number;
  fixes: Array<{ sampleId: string; changed: boolean; error?: string }>;
}

const FIX_SYSTEM_PROMPT = `你是一个评测用例修复专家。根据诊断信息和失败断言修复评测用例（sample）。

修复原则：
1. 先分析失败原因——是 sample 设计问题（mock 缺失 / 断言写错 / 工具名不匹配）还是 LLM 行为问题（LLM 真的做错了,低分合理）
2. **如果是 LLM 行为问题（低分合理）,不要改 sample,原样返回**
3. 如果是 sample 设计问题,修复 mocks / assertions / environment,必要时微调 rubric
4. 保持 sample_id 不变,保持测试意图不变
5. provenance 只能使用现有合法枚举: "human" / "llm-generated" / "production-trace"。不要发明 "llm-generated-fixed"、"fixed" 等新值；不确定时保留原值或用 "llm-generated"
6. 断言修复只保留核心行为节点：必要输出位置、必须/禁止的关键副作用、关键安全约束。不要为了贴合某次执行轨迹而绑定具体工具、命令形态、文案、完整步骤顺序或临时实现细节
7. 常见 sample 设计问题：
   - mock 缺失：LLM 调用被 mock-strict 拦截,需要补 mock
   - 工具名不匹配：断言写 Write:X 但场景是修改（应该是 Edit:X）,或反之
   - mock 返回格式不对：通配 mock 返回了文件内容但 Glob 工具期望路径列表
   - 断言过严：检查了不该检查的细节
8. 不要删除整条用例
9. **只能修改 sample,绝对不能建议修改 SKILL.md** — skill 是被测对象,fix 只优化测试用例本身

输出一个 **JSON 数组**,包含所有待修复 sample（修改过的和原样保留的都要包含）。
第一字符 \`[\`，最后 \`]\`，不要用 \`\`\`json\`\`\` 围栏，不要寒暄。
如果判断某条是 LLM 行为问题不需要改,也原样放进数组。`;


function sanitizeFixedSamples(samples: Record<string, unknown>[], skillContent: string): Record<string, unknown>[] {
  sanitizeGeneratedSamples(samples as Sample[], { skillContent });
  return samples;
}

function fixAttempts(sample: Record<string, unknown>): number {
  const meta = sample.omkFix;
  if (!meta || typeof meta !== 'object') return 0;
  const attempts = (meta as Record<string, unknown>).attempts;
  return typeof attempts === 'number' && Number.isFinite(attempts) ? attempts : 0;
}

function stampFixMetadata(sample: Record<string, unknown>, reportId: string): void {
  sample.omkFix = {
    ...(typeof sample.omkFix === 'object' && sample.omkFix !== null ? sample.omkFix as Record<string, unknown> : {}),
    attempts: fixAttempts(sample) + 1,
    lastFixedAt: new Date().toISOString(),
    lastReportId: reportId,
  };
}

function parseFixedSamples(text: string): Record<string, unknown>[] | null {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr) && arr.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return arr;
  } catch { /* fall through */ }

  // Try to extract first JSON array
  const start = cleaned.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '[') depth++;
    else if (cleaned[i] === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export async function fixSamples(options: FixSamplesOptions): Promise<FixSamplesResult> {
  const { skillContent, samples, report, treatmentKey, executor, model = 'opus', maxAttemptsPerSample = 2 } = options;
  const sampleMap = new Map(samples.map((s) => [s.sample_id as string, s]));

  // Collect all fixable samples into one batch
  const fixContexts: FixContext[] = [];
  const skippedByAttempts: string[] = [];

  for (const entry of report.results) {
    const variant = entry.variants?.[treatmentKey];
    if (!variant) continue;
    const variantObj = variant as unknown as Record<string, unknown>;
    if (variantObj.ok === false) continue;
    const assertionDetails = (variantObj.assertions as Record<string, unknown>)?.details as Array<{ type: string; value: string; passed: boolean }> ?? [];
    if (assertionDetails.length === 0 || assertionDetails.every((d) => d.passed)) continue;

    const sid = entry.sample_id;
    const original = sampleMap.get(sid);
    if (!original) continue;
    if (fixAttempts(original) >= maxAttemptsPerSample) {
      skippedByAttempts.push(sid);
      continue;
    }

    const diag = variantObj.diagnostic as Record<string, unknown> | undefined;
    const suggestion = diag?.suggestion as Record<string, string> | undefined;

    fixContexts.push({
      sampleId: sid,
      originalSample: original,
      diagnosticSummary: (diag?.summary as string) ?? '',
      expected: (diag?.expected as string) ?? '',
      actual: (diag?.actual as string) ?? '',
      suggestionSample: suggestion?.sample ?? '',
      rootCause: (diag?.rootCause as string[]) ?? [],
      failedAssertions: assertionDetails,
      toolCalls: (variantObj.toolCalls ?? []) as Array<{ tool: string; input: unknown; success: boolean }>,
    });
  }

  if (fixContexts.length === 0) {
    return {
      samples,
      fixedCount: 0,
      costUSD: 0,
      fixes: skippedByAttempts.map((sampleId) => ({ sampleId, changed: false, error: `max attempts reached (${maxAttemptsPerSample})` })),
    };
  }

  // Build one batch prompt with all failing samples
  const skillPreview = skillContent.length > 6000
    ? skillContent.slice(0, 6000) + '\n\n... (truncated)'
    : skillContent;

  const sampleSections = fixContexts.map((ctx) => {
    const failedList = ctx.failedAssertions
      .filter((a) => !a.passed)
      .map((a) => `  - ${a.type}: ${a.value}`)
      .join('\n');
    const toolCallsSummary = ctx.toolCalls.length > 0
      ? ctx.toolCalls.map((tc, i) => `  [${i}] ${tc.tool} success=${tc.success} input=${JSON.stringify(tc.input).slice(0, 150)}`).join('\n')
      : '  (无工具调用)';
    return `### ${ctx.sampleId}

原始 sample:
${JSON.stringify(ctx.originalSample, null, 2)}

诊断: ${ctx.rootCause.join(', ') || '(无)'} — ${ctx.diagnosticSummary}
期望: ${ctx.expected}
实际: ${ctx.actual}
建议: ${ctx.suggestionSample || '(无)'}

失败断言:
${failedList || '(无)'}

实际工具调用:
${toolCallsSummary}`;
  }).join('\n\n---\n\n');

  const prompt = `以下有 ${fixContexts.length} 条失败的评测用例需要分析修复。

## Skill 原文（参考，不可修改）

${skillPreview}

## 待修复的用例

${sampleSections}

请分析每条用例的失败原因，判断是 sample 设计问题还是 LLM 行为问题。若是 sample 设计问题，优先把断言收敛到核心行为节点，放松易随机的工具/命令/文案/完整步骤绑定；不要为了过用例而要求修改 SKILL.md，也不要把 skill 的完整流程细节塞进 sample。输出一个 JSON 数组，包含所有 ${fixContexts.length} 条 sample（修改过的和原样保留的都要包含）。`;

  try {
    const result = await executor({ model, system: FIX_SYSTEM_PROMPT, prompt, timeoutMs: 300_000 });

    if (!result.ok) {
      return {
        samples,
        fixedCount: 0,
        costUSD: result.costUSD,
        fixes: fixContexts.map((ctx) => ({ sampleId: ctx.sampleId, changed: false, error: 'executor failed' })),
      };
    }

    const fixedArr = parseFixedSamples(result.text);
    if (!fixedArr) {
      return {
        samples,
        fixedCount: 0,
        costUSD: result.costUSD,
        fixes: fixContexts.map((ctx) => ({ sampleId: ctx.sampleId, changed: false, error: 'failed to parse LLM response as JSON array' })),
      };
    }

    const sanitizedFixedArr = sanitizeFixedSamples(fixedArr, skillContent);

    const fixes: FixSamplesResult['fixes'] = [];
    for (const fixed of sanitizedFixedArr) {
      const sid = fixed.sample_id as string;
      if (!sid) continue;
      const original = sampleMap.get(sid);
      if (!original) continue;
      const changed = JSON.stringify(fixed) !== JSON.stringify(original);
      fixed.sample_id = sid;
      if (changed) stampFixMetadata(fixed, report.id);
      sampleMap.set(sid, fixed);
      fixes.push({ sampleId: sid, changed });
    }

    return {
      samples: samples.map((s) => sampleMap.get(s.sample_id as string) ?? s),
      fixedCount: fixes.filter((f) => f.changed).length,
      costUSD: result.costUSD,
      fixes: [
        ...fixes,
        ...skippedByAttempts.map((sampleId) => ({ sampleId, changed: false, error: `max attempts reached (${maxAttemptsPerSample})` })),
      ],
    };
  } catch (err) {
    return {
      samples,
      fixedCount: 0,
      costUSD: 0,
      fixes: fixContexts.map((ctx) => ({ sampleId: ctx.sampleId, changed: false, error: String(err) })),
    };
  }
}
