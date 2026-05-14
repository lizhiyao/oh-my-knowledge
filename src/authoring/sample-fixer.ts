import { sanitizeGeneratedSamples } from './generator.js';
import { validateSamples } from '../inputs/load-samples.js';
import type { Sample } from '../types/index.js';
import type { EvaluationReport } from '../types/report.js';

export interface FixContext {
  sampleId: string;
  originalSample: Sample;
  diagnosticSummary: string;
  expected: string;
  actual: string;
  suggestionSample: string;
  failedAssertions: Array<{ type: string; value: string; passed: boolean }>;
}

export interface FixSamplesOptions {
  skillContent: string;
  samples: Sample[];
  report: EvaluationReport;
  treatmentKey: string;
  executor: (opts: { model: string; system: string; prompt: string; timeoutMs: number; lean?: boolean }) => Promise<{ ok: boolean; text: string; costUSD: number }>;
  model?: string;
}

export interface FixSamplesResult {
  samples: Sample[];
  fixedCount: number;
  costUSD: number;
  fixes: Array<{ sampleId: string; changed: boolean; error?: string }>;
}

const FIX_SYSTEM_PROMPT = `你是一个评测用例修复专家。根据诊断信息修复有设计缺陷的评测用例（sample）。

修复原则：
1. 只修复诊断标记为 sample_design 的问题
2. 保持 sample_id 不变
3. 保持用例的测试意图不变（prompt 核心要测什么不变）
4. 修复范围：mocks / assertions / environment，必要时微调 rubric
5. 常见修复：补全缺失的 mock（工具调用被 mock-strict 拦截）、放宽过严的断言、修正与 mock 环境矛盾的断言
6. 不要删除整条用例

输出**仅包含修复后的完整 sample JSON 对象**（不是数组）。第一字符 \`{\`，最后 \`}\`，不要用 \`\`\`json\`\`\` 围栏，不要寒暄。`;

const FIXABLE_FIELDS = ['mocks', 'mocksStrict', 'assertions', 'environment', 'rubric'] as const;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function mergeAndValidateFixedSample(
  original: Sample,
  fixed: Record<string, unknown>,
  sampleId: string,
  skillContent: string,
): { sample: Sample; changed: boolean } {
  const candidate = cloneJson(original) as Record<string, unknown>;
  candidate.sample_id = sampleId;

  for (const field of FIXABLE_FIELDS) {
    if (hasOwn(fixed, field)) {
      candidate[field] = fixed[field];
    }
  }

  if (candidate.mocksStrict !== undefined && typeof candidate.mocksStrict !== 'boolean') {
    throw new Error('mocksStrict must be boolean when present');
  }

  const normalized = cloneJson(candidate) as Sample;
  const { stripped } = sanitizeGeneratedSamples([normalized], { skillContent });
  if (stripped.length > 0) {
    throw new Error(`fixed sample failed sanitizer: ${stripped.join('; ')}`);
  }
  validateSamples([normalized]);

  const merged = cloneJson(original) as Record<string, unknown>;
  merged.sample_id = sampleId;
  for (const field of FIXABLE_FIELDS) {
    const touchedByFix = hasOwn(fixed, field) || (field === 'mocksStrict' && hasOwn(fixed, 'mocks'));
    if (!touchedByFix) continue;
    const normalizedRecord = normalized as unknown as Record<string, unknown>;
    if (hasOwn(normalizedRecord, field)) {
      merged[field] = normalizedRecord[field];
    } else {
      delete merged[field];
    }
  }
  const sample = merged as Sample;
  validateSamples([sample]);

  return {
    sample,
    changed: JSON.stringify(sample) !== JSON.stringify(original),
  };
}

function buildFixPrompt(ctx: FixContext, skillContent: string): string {
  const skillPreview = skillContent.length > 8000
    ? skillContent.slice(0, 8000) + '\n\n... (truncated)'
    : skillContent;

  const failedList = ctx.failedAssertions
    .filter((a) => !a.passed)
    .map((a) => `- ${a.type}: ${a.value}`)
    .join('\n');

  return `## 原始 Sample

${JSON.stringify(ctx.originalSample, null, 2)}

## 诊断信息

- 归因：sample_design
- 诊断摘要：${ctx.diagnosticSummary}
- 期望行为：${ctx.expected}
- 实际行为：${ctx.actual}
- Sample 修改建议：${ctx.suggestionSample || '(无)'}

## 失败的断言

${failedList || '(无)'}

## Skill 原文（参考）

${skillPreview}

请根据诊断信息修复这个 sample。直接输出修复后的完整 sample JSON 对象。`;
}

function parseFixedSample(text: string): Record<string, unknown> | null {
  let cleaned = text.trim();
  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch { /* fall through */ }

  // Try to extract first JSON object
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

export async function fixSamples(options: FixSamplesOptions): Promise<FixSamplesResult> {
  const { skillContent, samples, report, treatmentKey, executor, model = 'opus' } = options;
  const sampleMap = new Map(samples.map((s) => [s.sample_id, s]));
  let totalCost = 0;
  const fixes: FixSamplesResult['fixes'] = [];

  for (const entry of report.results) {
    const variant = entry.variants?.[treatmentKey];
    if (!variant) continue;
    const variantObj = variant as unknown as Record<string, unknown>;
    const rootCause: string[] = variantObj.diagnostic
      ? (variantObj.diagnostic as Record<string, unknown>).rootCause as string[] ?? []
      : [];
    if (!rootCause.includes('sample_design')) continue;

    const sid = entry.sample_id;
    const original = sampleMap.get(sid);
    if (!original) { fixes.push({ sampleId: sid, changed: false, error: 'sample not found in file' }); continue; }

    const variantAny = variant as unknown as Record<string, unknown>;
    const diag = variantAny.diagnostic as Record<string, unknown> | undefined;
    const suggestion = diag?.suggestion as Record<string, string> | undefined;
    const assertionDetails = (variantAny.assertions as Record<string, unknown>)?.details as Array<{ type: string; value: string; passed: boolean }> ?? [];

    const ctx: FixContext = {
      sampleId: sid,
      originalSample: original,
      diagnosticSummary: (diag?.summary as string) ?? '',
      expected: (diag?.expected as string) ?? '',
      actual: (diag?.actual as string) ?? '',
      suggestionSample: suggestion?.sample ?? '',
      failedAssertions: assertionDetails,
    };

    const prompt = buildFixPrompt(ctx, skillContent);

    try {
      const result = await executor({ model, system: FIX_SYSTEM_PROMPT, prompt, timeoutMs: 120_000, lean: true });
      totalCost += result.costUSD;

      if (!result.ok) { fixes.push({ sampleId: sid, changed: false, error: 'executor failed' }); continue; }

      const fixed = parseFixedSample(result.text);
      if (!fixed) { fixes.push({ sampleId: sid, changed: false, error: 'failed to parse LLM response as JSON' }); continue; }

      const merged = mergeAndValidateFixedSample(original, fixed, sid, skillContent);
      if (merged.changed) sampleMap.set(sid, merged.sample);
      fixes.push({ sampleId: sid, changed: merged.changed });
    } catch (err) {
      fixes.push({ sampleId: sid, changed: false, error: String(err) });
    }
  }

  return {
    samples: samples.map((s) => sampleMap.get(s.sample_id) ?? s),
    fixedCount: fixes.filter((f) => f.changed).length,
    costUSD: totalCost,
    fixes,
  };
}
