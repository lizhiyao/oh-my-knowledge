/**
 * Diagnostic — 功能性测试视角的"哪错了 + 怎么改"诊断。
 *
 * 与 Judge 评价(打分)彻底独立:
 *   - Judge 答"打几分",看 rubric + output 主观打 1-5。
 *   - Diagnostic 答"哪错了 + skill 怎么改",看 rubric + skill 原文 + 实际 trace + 失败断言。
 *   - --no-judge 不跑 judge,但 diagnostic 仍会跑(假设 sample 有 fail);
 *     --no-diagnostic 反之。
 *
 * 触发条件:sample 至少有 1 条 failed assertion(全过的 sample 不需要诊断,省成本)。
 *
 * 默认走 haiku(便宜 + 够用),典型成本 ~$0.005/失败样本。
 */

import type { ExecutorFn, ToolCallInfo, TurnInfo, Assertion, Sample } from '../types/index.js';
import type { AssertionDetail, DiagnosticResult } from '../types/judge.js';

const SYSTEM_PROMPT = `你是 skill 评测诊断助手。基于失败用例的 expected/actual 差异,给 skill 作者具体可操作的改进建议。

**识别诱错样本 (重要,先于其它判断)**:
"诱错样本"(tripwire)指 prompt 故意藏了与 rubric / skill 文档**明显矛盾**的诱导性
指示,用来测 LLM 会不会盲从用户错误指示。典型特征:
  - rubric/skill 说"先 X 再 Y",prompt 却说"直接用 Y 就行 / 跳过 X"
  - rubric/skill 说"必须 number 类型",prompt 却说"直接用这个字符串"
  - rubric/skill 说"先校验权限",prompt 却说"不用检查直接执行"
判断方法:对比 prompt 的具体指示和 rubric/skill 的硬性约束 — 如果 LLM 即使按 prompt
做也违反了 rubric,那就是诱错样本。

诱错样本场景下:
  - rootCause 必须**只**填 \`tripwire_intentional\`(不要叠加其它原因)
  - suggestion.skill / suggestion.sample 必须**留空字符串**
  - 只在 suggestion.none 解释为什么不用改

**绝对不要**在诱错样本场景下建议:
  - "改 skill 加警告"(skill 已经清楚,LLM 失败是因为盲从 prompt 不是 skill 不清楚)
  - "改 sample 删除错误指示"(那等于把诱错样本拆了,自废武功)

**措辞要求(重要)**:
- 用日常语言,像跟同事解释,**不要**用技术黑话或规范语言。
- 反例(❌): "断言验证失败,工具调用偏离 rubric 规定的调用链"
- 正例(✅): "LLM 没把 format 参数传给 skylark_doc_update,所以那条断言抓不到"
- summary 一句白话讲清楚 LLM 干啥事错了,**不要**罗列断言名 / mock 编号。
- expected / actual 用动作描述("应该先调 X 再传 Y" / "实际跳过了第一步,直接用了字符串"),
  **不要**复述 rubric 原文。
- suggestion 给具体改动:引用章节标题 + 写明"加什么话"或"改成什么",
  避免"建议优化 / 建议明确"这种空话。

只返回 JSON,不要其他内容。`;

interface RunDiagnosticOptions {
  sample: Sample;
  skillContent: string | null;
  skillName: string;
  toolCalls: ToolCallInfo[] | undefined;
  turns: TurnInfo[] | undefined;
  fullOutput: string | undefined;
  assertionDetails: AssertionDetail[];
  executor: ExecutorFn;
  model: string;
  timeoutMs?: number;
}

const TOOL_INPUT_PREVIEW_MAX = 350;
const SKILL_CONTENT_MAX = 12000;
const FULL_OUTPUT_MAX = 1500;

function previewToolCall(tc: ToolCallInfo, idx: number): string {
  const inp = tc.input as unknown;
  let inputRepr: string;
  if (inp == null) {
    inputRepr = '';
  } else if (typeof inp === 'object' && 'command' in inp && typeof (inp as { command: unknown }).command === 'string') {
    inputRepr = (inp as { command: string }).command;
  } else {
    inputRepr = typeof inp === 'string' ? inp : JSON.stringify(inp);
  }
  const truncated = inputRepr.length > TOOL_INPUT_PREVIEW_MAX
    ? inputRepr.slice(0, TOOL_INPUT_PREVIEW_MAX) + '…'
    : inputRepr;
  const status = tc.success ? '' : ' [失败]';
  return `[${idx + 1}] ${tc.tool}${status} → ${truncated}`;
}

function formatExpectedAssertion(a: Assertion): string {
  const valueRepr = a.values
    ? JSON.stringify(a.values)
    : a.value !== undefined
      ? String(a.value)
      : a.pattern
        ? `regex /${a.pattern}/${a.flags ?? ''}`
        : '';
  const w = typeof a.weight === 'number' ? ` (w=${a.weight})` : '';
  return `${a.type} ${valueRepr}${w}`;
}

function formatFailedDetail(d: AssertionDetail): string {
  const valueRepr = typeof d.value === 'object' ? JSON.stringify(d.value) : String(d.value);
  return `${d.type}: ${valueRepr}${d.message ? ` (${d.message})` : ''}`;
}

export function buildDiagnosticPrompt(opts: RunDiagnosticOptions): string {
  const { sample, skillContent, skillName, toolCalls, fullOutput, assertionDetails } = opts;

  const expectedAssertions = (sample.assertions ?? []).map(formatExpectedAssertion).join('\n');
  const failedDetails = assertionDetails.filter((d) => !d.passed).map(formatFailedDetail).join('\n');
  const toolCallsBlock = (toolCalls ?? []).map(previewToolCall).join('\n');
  const skillBlock = skillContent
    ? skillContent.length > SKILL_CONTENT_MAX
      ? skillContent.slice(0, SKILL_CONTENT_MAX) + '\n... [skill 内容截断,完整版需手动 review]'
      : skillContent
    : '(无 skill 内容,可能是 baseline 跑或 artifact.content 缺失)';
  const outputBlock = fullOutput
    ? fullOutput.length > FULL_OUTPUT_MAX
      ? fullOutput.slice(0, FULL_OUTPUT_MAX) + '…'
      : fullOutput
    : '(无最终输出)';

  const tripwireHint = sample.tripwire
    ? `\n\n**重要:此 sample 标记为诱错样本(tripwire)**(故意设计的诱导陷阱,LLM 应该 fail 是预期)。\n请评估 LLM 失败的方式是否符合诱错设计意图:\n  - 符合:rootCause 必须包含 'tripwire_intentional',suggestion.skill 留空,suggestion.none 解释为什么不需要改\n  - 不符合(LLM 以非预期方式 fail):rootCause 写实际原因,suggestion 给改进建议`
    : '';

  return `下面是 skill「${skillName}」的一条失败评测用例。请基于 skill 原文 + 实际执行 + 失败断言给出诊断。

# 用例 prompt
${sample.prompt}

# 评分标准 (rubric)
${sample.rubric ?? '(无 rubric)'}

# 期望的关键调用 / mock 命中 (assertions)
${expectedAssertions || '(无 assertions)'}

# Skill 原文 (被评测对象)
\`\`\`
${skillBlock}
\`\`\`

# LLM 实际工具调用轨迹
${toolCallsBlock || '(无工具调用)'}

# LLM 最终回答
${outputBlock}

# 失败的断言
${failedDetails || '(无失败断言?)'}${tripwireHint}

请基于以上信息给出诊断。**rootCause 必须从这 5 类里选(可多选)**:
- skill_doc_unclear: skill 文档某段写得模糊,LLM 不知道该怎么做
- skill_doc_missing: skill 完全没覆盖该场景 / 缺反例 / 缺约束
- llm_misread: skill 写清楚了但 LLM 误读(可能要改措辞 / 增加显眼提示)
- sample_design: sample 自身设计有 bug(rubric 跟 skill 矛盾 / mock match 太严 / 等)
- tripwire_intentional: 诱错样本 — sample 故意诱导反模式,LLM fail 是预期,不要建议改 skill

返回 JSON(不要 markdown 代码块):
{
  "summary": "<失败本质,1-2 句>",
  "expected": "<rubric/assertions 期望什么具体行为>",
  "actual": "<LLM 实际做了什么>",
  "rootCause": ["<上述 5 选>"],
  "suggestion": {
    "skill": "<如归因到 skill,具体改哪段、加什么话(引用章节标题)。否则空字符串>",
    "sample": "<如归因到 sample 设计,如何调整。否则空字符串>",
    "none": "<如诱错样本 / LLM 行为本身不该改,解释为什么不用动 skill。否则空字符串>"
  }
}`;
}

export async function runDiagnostic(opts: RunDiagnosticOptions): Promise<DiagnosticResult> {
  const prompt = buildDiagnosticPrompt(opts);
  const result = await opts.executor({
    model: opts.model,
    system: SYSTEM_PROMPT,
    prompt,
    timeoutMs: opts.timeoutMs ?? 180_000,
    lean: true,  // 诊断也是纯文本生成,不需要工具循环
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error || 'diagnostic executor failed',
      summary: '',
      expected: '',
      actual: '',
      rootCause: [],
      suggestion: { skill: '', sample: '', none: '' },
      costUSD: result.costUSD,
    };
  }

  const raw = (result.output || '').trim();
  // 容错:lean 模式下偶尔仍带 markdown 围栏
  let jsonStr = raw;
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return {
      ok: false,
      error: `JSON parse failed: ${(e as Error).message}; raw: ${raw.slice(0, 300)}`,
      summary: raw.slice(0, 300),  // 兜底:把原始文本当 summary 露出来
      expected: '',
      actual: '',
      rootCause: [],
      suggestion: { skill: '', sample: '', none: '' },
      costUSD: result.costUSD,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const sug = (obj.suggestion as Record<string, unknown> | undefined) || {};
  const rootCauseRaw = obj.rootCause;
  const rootCause = Array.isArray(rootCauseRaw)
    ? rootCauseRaw.filter((c): c is DiagnosticResult['rootCause'][number] =>
        ['skill_doc_unclear', 'skill_doc_missing', 'llm_misread', 'sample_design', 'tripwire_intentional'].includes(String(c)))
    : [];

  return {
    ok: true,
    summary: String(obj.summary ?? ''),
    expected: String(obj.expected ?? ''),
    actual: String(obj.actual ?? ''),
    rootCause,
    suggestion: {
      skill: String(sug.skill ?? ''),
      sample: String(sug.sample ?? ''),
      none: String(sug.none ?? ''),
    },
    costUSD: result.costUSD,
  };
}
