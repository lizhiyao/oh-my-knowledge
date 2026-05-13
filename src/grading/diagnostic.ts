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
import type { AssertionDetail, DiagnosticResult, WorkflowCheck, FailureMode } from '../types/judge.js';
import { FAILURE_MODES } from '../types/judge.js';

const SYSTEM_PROMPT = `你是 skill 评测诊断助手。基于失败用例的 expected/actual 差异,给 skill 作者具体可操作的改进建议。

**诱错样本(tripwire)规则 — 只看 sample 的显式标记,不要自己识别**:
"诱错样本"指 prompt 故意藏了跟 rubric / skill 矛盾的诱导指示,用来测 LLM 会不会
盲从错误。这是 sample 作者的设计决策,**只有 sample 作者显式标 \`tripwire: true\` 才算**。

判断逻辑(用户消息会告诉你 sample.tripwire 的值):
  - sample.tripwire === true →
       rootCause 必须**只**填 \`tripwire_intentional\`(不要叠加其它原因)
       suggestion.skill / suggestion.sample 必须**留空字符串**
       只在 suggestion.none 解释为什么不用改
  - sample.tripwire === false / undefined →
       **绝对不要**输出 \`tripwire_intentional\` rootCause,**绝对不要**判断它是诱错
       即使 prompt 看起来像诱导,也按"非诱错"诊断,给出 skill / sample 改进建议
       (如果你强烈怀疑应该是诱错,可以在 summary 末尾加一句"建议 sample 作者
       考虑显式标记 tripwire:true",但 rootCause 仍按非诱错走)

**绝对不要**在诱错样本(tripwire=true)场景下建议:
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
- workflowChecks / failureModes 的描述全部用中文,evidence 引用具体的工具调用编号([N] 这种),不要用英文枚举名以外的英文表达。

**工作流校验(workflowChecks)**:
把 rubric / skill 规定的关键步骤拆成可勾选的清单,每条给:
- step: 中文描述这一步要干啥(如"调 code-host auth status 拿当前 username")
- passed: LLM 是否做了该步骤
- evidence: 引用 trace 里的具体证据。passed=true 时点名是哪一步工具调用做的;passed=false 时说明哪里偏离了(漏调 / 调错 / 参数错)
不是工作流型任务(rubric 是开放式问答 / 单纯文本生成)就给空数组 []。

**失败模式标签(failureModes)**:
从下面 7 个里选(可多选),用来一眼归类 LLM 是怎么错的:
${FAILURE_MODES.map((m, i) => `  ${i + 1}. ${m}`).join('\n')}
含义:
- 工作流跳步: 没按 rubric/skill 规定的步骤顺序执行
- 硬编码值: 该用前面变量传递的字段写死成具体值(如 namespace、id 直接写 testuser001)
- 幻觉输出: 声称完成 / 给出实际不存在的结果(虚构 commit hash、虚构文件路径、虚构 id)
- 工具误用: 选错工具 / 参数错 / 重复尝试同一失败动作
- 环境拦截: mock-strict 或工具不可用导致 LLM 行为正确但仍 fail(诊断要把这种和真错区分)
- 误读约束: skill 写清楚的约束被 LLM 漏掉 / 误读(常和 llm_misread rootCause 搭)
- 其他: 兜底,不属于以上任何类
全过的 sample 给空数组 []。

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

  // tripwire 状态显式传给 LLM:不允许它"自己识别",只能按 ground truth 处理。
  //   true → 强诱错提示(rootCause 必须 tripwire_intentional)
  //   false / undefined → 明确告知"不是诱错",绝不允许输出 tripwire_intentional
  const tripwireHint = sample.tripwire === true
    ? '\n\n**sample.tripwire = true(诱错样本,ground truth)**\nLLM 失败是预期。请评估失败的方式是否符合诱错设计意图:\n  - 符合:rootCause 必须**只**填 tripwire_intentional,suggestion.skill / suggestion.sample 留空,suggestion.none 解释为什么不需要改\n  - 不符合(LLM 以非预期方式 fail,例如真的工具错):rootCause 写实际原因(不要叠加 tripwire_intentional),suggestion 给改进建议'
    : '\n\n**sample.tripwire = false(非诱错,ground truth)**\n这条 sample 不是诱错。**绝对不要**输出 tripwire_intentional rootCause。即使 prompt 看起来像诱导,也按"非诱错"诊断,给 skill / sample 改进建议。';

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
  "workflowChecks": [
    {"step": "<rubric/skill 规定的一步,中文>", "passed": true, "evidence": "<引 trace 中 [N] 工具调用编号或简短中文证据>"}
  ],
  "failureModes": ["<从 7 个中文标签里选,可多选;无可归类则空数组>"],
  "rootCause": ["<上述 5 选>"],
  "suggestion": {
    "skill": "<如归因到 skill,具体改哪段、加什么话(引用章节标题)。否则空字符串>",
    "sample": "<如归因到 sample 设计,如何调整。否则空字符串>",
    "none": "<如诱错样本 / LLM 行为本身不该改,解释为什么不用动 skill。否则空字符串>"
  }
}`;
}

/**
 * 字段级 salvage:LLM 诊断输出在字符串中间被截断时(unterminated string),
 * JSON.parse 整条丢; 这里用正则按字段名抽取已写完(或截断到 EOF)的内容,
 * 至少把 summary/expected/actual 露出来让用户看到。
 *
 * 策略:
 *   - 顶层字符串字段(summary/expected/actual):匹配 `"key"\s*:\s*"((?:[^"\\]|\\.)*)("|$)`,
 *     允许字符串没有闭合引号(走 `$` 分支吃到 EOF)。
 *   - rootCause(数组):匹配方括号内容,按字符串元素逐个解析。
 *   - suggestion(嵌套对象):取出花括号内容后用相同策略递归提取 skill/sample/none。
 *
 * 不试图重建完整 JSON,只挑能挑出的字段。
 */
function unescapeJsonString(s: string): string {
  // 单次扫描:顺序替换会导致 `\\t` 先被处理成 `\` + `t`,再被当成转义符二次处理。
  // 对每个反斜杠序列只解码一次。截断到悬空 `\` 时按原样保留(避免吃掉合法尾字符)。
  return s.replace(/\\(["\\/bnrt]|u[0-9a-fA-F]{4})/g, (_match, esc: string) => {
    if (esc.startsWith('u')) {
      return String.fromCharCode(parseInt(esc.slice(1), 16));
    }
    const map: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    return map[esc] ?? esc;
  });
}

function extractStringField(blob: string, key: string): string | undefined {
  // 匹配 "key": "...content..."  允许末尾没有闭合引号(被截断的情况)。
  // 内容部分允许转义对(\\ 任意字符)和非引号非反斜杠字符。
  const re = new RegExp(
    `"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)(?:"|$)`,
    's',
  );
  const m = blob.match(re);
  if (!m) return undefined;
  return unescapeJsonString(m[1]);
}

function extractRootCause(blob: string): DiagnosticResult['rootCause'] | undefined {
  const re = /"rootCause"\s*:\s*\[([^\]]*)/s;
  const m = blob.match(re);
  if (!m) return undefined;
  const inner = m[1];
  const valid = new Set(['skill_doc_unclear', 'skill_doc_missing', 'llm_misread', 'sample_design', 'tripwire_intentional']);
  const items: DiagnosticResult['rootCause'] = [];
  for (const sm of inner.matchAll(/"([^"]+)"/g)) {
    if (valid.has(sm[1])) items.push(sm[1] as DiagnosticResult['rootCause'][number]);
  }
  return items;
}

function extractSuggestion(blob: string): DiagnosticResult['suggestion'] | undefined {
  // suggestion 是嵌套对象。先抓 "suggestion": { ... 直到 EOF 或匹配的 } ,
  // 然后在那段 blob 里按 key 抽 string 字段。
  const start = blob.search(/"suggestion"\s*:\s*\{/);
  if (start < 0) return undefined;
  const tail = blob.slice(start);
  // 取从 "suggestion": { 后到 EOF / 闭合花括号 / 下一个顶层 key 之前的内容
  const inner = tail;
  const skill = extractStringField(inner, 'skill');
  const sample = extractStringField(inner, 'sample');
  const none = extractStringField(inner, 'none');
  if (skill === undefined && sample === undefined && none === undefined) return undefined;
  return {
    skill: skill ?? '',
    sample: sample ?? '',
    none: none ?? '',
  };
}

function extractWorkflowChecks(blob: string): WorkflowCheck[] | undefined {
  // 抓 "workflowChecks": [ ... ] 内部内容,容忍 ] 缺失(被截断的情况)。
  const headIdx = blob.search(/"workflowChecks"\s*:\s*\[/);
  if (headIdx < 0) return undefined;
  const tail = blob.slice(headIdx);
  const innerStart = tail.indexOf('[');
  if (innerStart < 0) return undefined;
  const innerBlob = tail.slice(innerStart + 1);
  // 按对象边界拆 — 用括号深度计数从 { 到匹配的 } 切片。
  // 截断在某个对象中间时,该对象丢弃,前面完整的保留。
  const items: WorkflowCheck[] = [];
  let depth = 0, objStart = -1;
  for (let i = 0; i < innerBlob.length; i++) {
    const ch = innerBlob[i];
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const objStr = innerBlob.slice(objStart, i + 1);
        const step = extractStringField(objStr, 'step');
        const evidence = extractStringField(objStr, 'evidence');
        const passedMatch = objStr.match(/"passed"\s*:\s*(true|false)/);
        if (step) {
          items.push({
            step,
            passed: passedMatch?.[1] === 'true',
            evidence: evidence ?? '',
          });
        }
        objStart = -1;
      }
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }
  return items;
}

function extractFailureModes(blob: string): FailureMode[] | undefined {
  const re = /"failureModes"\s*:\s*\[([^\]]*)/s;
  const m = blob.match(re);
  if (!m) return undefined;
  const inner = m[1];
  const valid = new Set<string>(FAILURE_MODES);
  const seen = new Set<FailureMode>();
  const items: FailureMode[] = [];
  for (const sm of inner.matchAll(/"([^"]+)"/g)) {
    if (valid.has(sm[1]) && !seen.has(sm[1] as FailureMode)) {
      seen.add(sm[1] as FailureMode);
      items.push(sm[1] as FailureMode);
    }
  }
  return items;
}

export function salvagePartialJson(blob: string): {
  summary?: string;
  expected?: string;
  actual?: string;
  rootCause?: DiagnosticResult['rootCause'];
  workflowChecks?: WorkflowCheck[];
  failureModes?: FailureMode[];
  suggestion?: DiagnosticResult['suggestion'];
} {
  return {
    summary: extractStringField(blob, 'summary'),
    expected: extractStringField(blob, 'expected'),
    actual: extractStringField(blob, 'actual'),
    rootCause: extractRootCause(blob),
    workflowChecks: extractWorkflowChecks(blob),
    failureModes: extractFailureModes(blob),
    suggestion: extractSuggestion(blob),
  };
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
    // LLM 输出可能在字符串中间被截断(例如 max_output_tokens 命中、模型 stop 早),
    // 完整 JSON.parse 会失败但前面写完的字段可能已经有用。做字段级 salvage。
    const salvaged = salvagePartialJson(jsonStr);
    const hasContent = !!(salvaged.summary || salvaged.expected || salvaged.actual
      || (salvaged.workflowChecks && salvaged.workflowChecks.length > 0));
    if (hasContent) {
      return {
        ok: true,
        // 把 parse error 放在 error 里,UI 仍能区分"完整诊断"和"截断 salvage";
        // 但 ok=true 让 summary/expected/actual 正常展示给用户。
        error: `partial: JSON parse failed (${(e as Error).message}), salvaged ${
          [
            salvaged.summary && 'summary',
            salvaged.expected && 'expected',
            salvaged.actual && 'actual',
            salvaged.workflowChecks?.length && 'workflowChecks',
            salvaged.failureModes?.length && 'failureModes',
          ].filter(Boolean).join('/')
        }`,
        summary: salvaged.summary ?? '',
        expected: salvaged.expected ?? '',
        actual: salvaged.actual ?? '',
        rootCause: salvaged.rootCause ?? [],
        workflowChecks: salvaged.workflowChecks ?? [],
        failureModes: salvaged.failureModes ?? [],
        suggestion: salvaged.suggestion ?? { skill: '', sample: '', none: '' },
        costUSD: result.costUSD,
      };
    }
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
  const workflowChecks = parseWorkflowChecks(obj.workflowChecks);
  const failureModes = parseFailureModes(obj.failureModes);

  return {
    ok: true,
    summary: String(obj.summary ?? ''),
    expected: String(obj.expected ?? ''),
    actual: String(obj.actual ?? ''),
    rootCause,
    workflowChecks,
    failureModes,
    suggestion: {
      skill: String(sug.skill ?? ''),
      sample: String(sug.sample ?? ''),
      none: String(sug.none ?? ''),
    },
    costUSD: result.costUSD,
  };
}

function parseWorkflowChecks(raw: unknown): WorkflowCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkflowCheck[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const step = typeof r.step === 'string' ? r.step.trim() : '';
    const evidence = typeof r.evidence === 'string' ? r.evidence.trim() : '';
    if (!step) continue;  // 没 step 描述就丢掉
    out.push({
      step,
      passed: r.passed === true,
      evidence,
    });
  }
  return out;
}

function parseFailureModes(raw: unknown): FailureMode[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set<string>(FAILURE_MODES);
  const seen = new Set<FailureMode>();
  const out: FailureMode[] = [];
  for (const item of raw) {
    const s = typeof item === 'string' ? item.trim() : '';
    if (valid.has(s) && !seen.has(s as FailureMode)) {
      seen.add(s as FailureMode);
      out.push(s as FailureMode);
    }
  }
  return out;
}
