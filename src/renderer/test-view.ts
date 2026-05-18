/**
 * 单测视角渲染器 — 把 EvaluationReport 当作 vitest 风格的测试结果看：
 *
 *   每个 sample = 一个 test case
 *     ┌─ 用例设计(测试契约): prompt / rubric / 期望 assertions / 工具调用 mock
 *     ├─ 执行轨迹: thinking + tool calls + 断言绑定到 turn
 *     └─ 断言汇总: 每条 assertion 在哪一步触发,pass/fail
 *
 * 数据全部来自 EvaluationReport,不引入新数据源:
 *   - 设计  ← report.sampleSnapshots[sample_id]
 *   - 执行  ← VariantResult.turns / .toolCalls / .mockStats / .fullOutput
 *   - 断言  ← VariantResult.assertions.details (已经有 passed/failed)
 *
 * 旧 report 缺 sampleSnapshots 时降级显示("无设计快照,只有执行结果")。
 */

import type { EvaluationReport, SampleSnapshot, VariantResult, Lang } from '../types/index.js';
import type { Assertion, Mock } from '../types/eval.js';
import type { ToolCallInfo, TurnInfo } from '../types/executor.js';
import type { AssertionDetail } from '../types/judge.js';
import { e } from './layout.js';

// ──────────────────────────────────────────────────────────────────
// Assertion → Turn 绑定:扫执行轨迹找断言匹配的 turn 编号
// ──────────────────────────────────────────────────────────────────

/** Tool call 的稳定签名,用于在 turns 里反查 turn 序号。 */
export function toolCallSignature(tc: ToolCallInfo): string {
  return `${tc.tool}::${JSON.stringify(tc.input)}`;
}

/** 走 turns 数组,给每个 tool call 标一个 turn 编号(1-based)。导出供单测验证。 */
export function indexToolCallsByTurn(turns: TurnInfo[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!turns) return map;
  turns.forEach((turn, i) => {
    if (turn.toolCalls) {
      for (const tc of turn.toolCalls) {
        const sig = toolCallSignature(tc);
        if (!map.has(sig)) map.set(sig, i + 1);
      }
    }
  });
  return map;
}

/** 字符串解析:`tool_input_contains` / `tool_output_contains` 用 `Tool:substring` 格式。 */
export function parseToolColonValue(value: string): { tool: string; needle: string } {
  const idx = value.indexOf(':');
  if (idx < 0) return { tool: '', needle: value };
  return { tool: value.slice(0, idx), needle: value.slice(idx + 1) };
}

/** 把单条 assertion 绑定到某一步。匹配不到返回 null(contains/regex 等作用于 fullOutput
 *  的天然没有 turn 绑定)。导出供单测。
 *
 *  局限:mock_hit 的 turn 绑定靠"该 tool 的第 N 次调用 = 第 N 个 mock"启发式,
 *  和真实 mock matcher(按 match 规则)可能不一致——状态机 mock 场景下 turn 标签可能近似。
 *  pass/fail 仍以 AssertionDetail.passed 为准。 */
export function findAssertionTurn(
  assertion: Assertion,
  detail: AssertionDetail,
  toolCalls: ToolCallInfo[],
  turnByCallSig: Map<string, number>,
): { turn: number | null; matchedCall?: ToolCallInfo } {
  const type = assertion.type;
  if (type === 'tool_input_contains' || type === 'tool_output_contains' || type === 'tool_input_not_contains') {
    const value = String(assertion.value ?? detail.value ?? '');
    const { tool, needle } = parseToolColonValue(value);
    for (const tc of toolCalls) {
      if (tool && tc.tool !== tool) continue;
      const target = type === 'tool_output_contains'
        ? JSON.stringify(tc.output ?? '')
        : JSON.stringify(tc.input ?? '');
      if (target.includes(needle)) {
        return { turn: turnByCallSig.get(toolCallSignature(tc)) ?? null, matchedCall: tc };
      }
    }
    return { turn: null };
  }
  if (type === 'tools_called' || type === 'tools_not_called') {
    const targets = (assertion.values ?? [String(assertion.value ?? '')]).filter(Boolean);
    for (const tc of toolCalls) {
      if (targets.includes(tc.tool)) {
        return { turn: turnByCallSig.get(toolCallSignature(tc)) ?? null, matchedCall: tc };
      }
    }
    return { turn: null };
  }
  if (type === 'mock_hit') {
    // mock_hit 的 value 形如 "Bash:2",对应 mockStats.perMock 的 key。
    // 不靠 mockStats 反推 turn(没有那个映射),靠 assertion.value 解析的 tool + 第 N 个该 tool 的调用。
    const value = String(assertion.value ?? detail.value ?? '');
    const { tool, needle } = parseToolColonValue(value);
    const targetIndex = parseInt(needle, 10);
    if (!Number.isFinite(targetIndex)) return { turn: null };
    let counter = 0;
    for (const tc of toolCalls) {
      if (tc.tool !== tool) continue;
      counter += 1;
      if (counter === targetIndex) {
        return { turn: turnByCallSig.get(toolCallSignature(tc)) ?? null, matchedCall: tc };
      }
    }
    return { turn: null };
  }
  // contains / not_contains / regex 作用于 fullOutput,无 turn 绑定
  return { turn: null };
}

// ──────────────────────────────────────────────────────────────────
// 渲染:per-sample 卡片
// ──────────────────────────────────────────────────────────────────

/** 用例的整体 verdict:全部 assertion 通过 → pass;任一失败 → fail;无 assertion → 视为 pass(谨慎)。 */
export function sampleVerdict(details: AssertionDetail[] | undefined): 'pass' | 'fail' {
  if (!details || details.length === 0) return 'pass';
  return details.every((d) => d.passed) ? 'pass' : 'fail';
}

/**
 * 判断 sample 是否是"诱错样本(tripwire)"——视觉上要跟普通 fail 区分开。
 *
 * 识别来源(任一即算):
 *   1. snapshot.tripwire === true(generator/作者显式标记)
 *   2. diagnostic.rootCause 包含 'tripwire_intentional'(LLM 诊断时自己识破的)
 *
 * 用途:UI 把诱错样本的失败渲染成紫色 "🪤 诱错触发" 而非红色 "✗ FAIL",
 * 避免使用者误以为是要修的真 bug。
 */
export function isTripwireSample(snapshot: SampleSnapshot | undefined, variant: VariantResult): boolean {
  if (snapshot?.tripwire === true) return true;
  const rc = variant.diagnostic?.rootCause || [];
  return rc.includes('tripwire_intentional');
}

/** 作用于 LLM 全文输出的 assertion 类型(不绑定到具体 turn,而是检查 fullOutput / final answer)。 */
const OUTPUT_LEVEL_ASSERTION_TYPES = new Set([
  'contains', 'not_contains', 'regex',
  'min_length', 'max_length', 'length',
  'json_schema', 'starts_with', 'ends_with',
  'rouge_n_min', 'bleu_min', 'levenshtein_max',
  'embedding_similarity_min', 'answer_relevancy', 'faithfulness',
]);

function renderAssertionLine(d: AssertionDetail, turn: number | null, lang: Lang): string {
  const icon = d.passed ? '✅' : '❌';
  const valueRepr = typeof d.value === 'object' ? JSON.stringify(d.value) : String(d.value);
  let turnTag: string;
  if (turn !== null) {
    turnTag = `<span class="tv-turn-tag">@ Turn ${turn}</span>`;
  } else if (OUTPUT_LEVEL_ASSERTION_TYPES.has(d.type)) {
    turnTag = `<span class="tv-turn-tag">${lang === 'zh' ? '@ 全文输出' : '@ full output'}</span>`;
  } else if (d.passed && d.type === 'tools_not_called') {
    turnTag = `<span class="tv-turn-tag tv-turn-tag--ok">${lang === 'zh' ? '未触发(通过)' : 'never triggered (pass)'}</span>`;
  } else {
    turnTag = `<span class="tv-turn-tag tv-turn-tag--miss">${lang === 'zh' ? '未匹配到任何 turn' : 'no matching turn'}</span>`;
  }
  return `<div class="tv-assert ${d.passed ? 'tv-assert--pass' : 'tv-assert--fail'}">
    ${icon} <code>${e(d.type)}</code> <code class="tv-assert-value">${e(valueRepr)}</code>${turnTag}
    ${d.message ? `<div class="tv-assert-msg">${e(d.message)}</div>` : ''}
  </div>`;
}

function renderDesignSection(snapshot: SampleSnapshot | undefined, lang: Lang): string {
  // 注意:本函数返回的内容会被外层 `<details><summary>用例设计</summary>` 包起来
  //(见 renderSubSections 的 .tv-section),所以这里不再重复"📋 用例设计"标题。
  if (!snapshot) {
    return `<div class="tv-empty">${lang === 'zh' ? '该 report 早于单测视角支持时间,缺设计快照' : 'Report predates test-view support; no design snapshot'}</div>`;
  }
  const meta: string[] = [];
  if (snapshot.capability && snapshot.capability.length > 0) {
    const capLabel = lang === 'zh' ? '能力(capability)' : 'capability';
    meta.push(`<span class="tv-meta-pill">${capLabel}: ${snapshot.capability.map(e).join(' · ')}</span>`);
  }
  if (snapshot.construct) {
    const lbl = lang === 'zh' ? '验证目标(construct)' : 'construct';
    meta.push(`<span class="tv-meta-pill">${lbl}: ${e(constructValueLabel(snapshot.construct, lang))}</span>`);
  }
  if (snapshot.difficulty) {
    const lbl = lang === 'zh' ? '难度(difficulty)' : 'difficulty';
    meta.push(`<span class="tv-meta-pill">${lbl}: ${e(difficultyValueLabel(snapshot.difficulty, lang))}</span>`);
  }
  if (snapshot.provenance) {
    const lbl = lang === 'zh' ? '来源(provenance)' : 'provenance';
    meta.push(`<span class="tv-meta-pill">${lbl}: ${e(provenanceValueLabel(snapshot.provenance, lang))}</span>`);
  }

  const expectedAssertions = (snapshot.assertions ?? []).map((a) => renderExpectedAssertion(a)).join('');
  const mocksBlock = snapshot.mocks && snapshot.mocks.length > 0
    ? `<details class="tv-collapsible"><summary>${lang === 'zh' ? `工具调用 Mock(${snapshot.mocks.length} 条)` : `Tool-call mocks (${snapshot.mocks.length})`}</summary>
       <div class="tv-mocks">${snapshot.mocks.map((m, i) => renderMock(m, i + 1)).join('')}</div>
       </details>`
    : '';

  return `<div class="tv-section--design-body">
    <div class="tv-prompt"><strong>${lang === 'zh' ? '提示词(Prompt):' : 'Prompt:'}</strong> <span>${e(snapshot.prompt)}</span></div>
    ${snapshot.rubric ? `<div class="tv-rubric"><strong>${lang === 'zh' ? '评分标准(Rubric):' : 'Rubric:'}</strong> <span>${e(snapshot.rubric)}</span></div>` : ''}
    ${snapshot.context ? `<details class="tv-collapsible"><summary>${lang === 'zh' ? '上下文(Context)' : 'Context'}</summary><pre class="tv-pre">${e(snapshot.context)}</pre></details>` : ''}
    ${meta.length > 0 ? `<div class="tv-meta-pills">${meta.join(' ')}</div>` : ''}
    ${expectedAssertions ? `<div class="tv-expected">
      <div class="tv-expected-h">${lang === 'zh' ? '期望（assertions）：' : 'Expected (assertions):'}</div>
      ${expectedAssertions}
    </div>` : ''}
    ${mocksBlock}
  </div>`;
}

/** construct 取值常见三种,zh 显示纯中文;非枚举的自由值原样回显(作者自定义,无法翻译)。 */
function constructValueLabel(v: string, lang: Lang): string {
  if (lang !== 'zh') return v;
  const map: Record<string, string> = {
    'necessity': '必要性',
    'capability': '能力',
    'quality': '质量',
  };
  return map[v] ?? v;
}

function difficultyValueLabel(v: string, lang: Lang): string {
  if (lang !== 'zh') return v;
  const map: Record<string, string> = {
    'easy': '容易',
    'medium': '中等',
    'hard': '困难',
  };
  return map[v] ?? v;
}

function provenanceValueLabel(v: string, lang: Lang): string {
  if (lang !== 'zh') return v;
  const map: Record<string, string> = {
    'human': '人工编写',
    'llm-generated': 'LLM 生成',
    'production-trace': '线上轨迹',
  };
  return map[v] ?? v;
}

function renderExpectedAssertion(a: Assertion): string {
  const typeLabel = e(a.type);
  const valueRepr = a.values
    ? JSON.stringify(a.values)
    : a.value !== undefined
      ? String(a.value)
      : a.pattern
        ? `regex /${a.pattern}/${a.flags ?? ''}`
        : '';
  const weight = typeof a.weight === 'number' ? ` (w=${a.weight})` : '';
  return `<div class="tv-expect-line">• <code>${typeLabel}</code> <code class="tv-assert-value">${e(valueRepr)}</code>${weight}</div>`;
}

function renderMock(m: Mock, n: number): string {
  const match = m.match ? JSON.stringify(m.match) : '(any)';
  let returnRepr: string;
  if (m.return !== undefined) {
    returnRepr = typeof m.return === 'string' ? m.return : JSON.stringify(m.return);
  } else if (m.return_seq) {
    returnRepr = `seq(${m.return_seq.length})`;
  } else if (m.return_file) {
    returnRepr = `file: ${m.return_file}`;
  } else {
    returnRepr = '(no return)';
  }
  return `<div class="tv-mock-line">
    <span class="tv-mock-idx">#${n}</span>
    <code class="tv-mock-tool">${e(m.tool)}</code>
    <code class="tv-mock-match">${e(match)}</code>
    <span class="tv-mock-arrow">→</span>
    <code class="tv-mock-return">${e(returnRepr.length > 200 ? returnRepr.slice(0, 200) + '…' : returnRepr)}</code>
  </div>`;
}

function renderExecutionTrace(
  variant: VariantResult,
  detailsByTurn: Map<number, AssertionDetail[]>,
  matchedMockNumbersByTurn: Map<number, number[]>,
  lang: Lang,
): string {
  const turns = variant.turns ?? [];
  if (turns.length === 0) {
    return `<div class="tv-section tv-section--trace">
      <div class="tv-section-h">${lang === 'zh' ? '🎬 执行轨迹' : '🎬 Execution trace'}</div>
      <div class="tv-empty">${lang === 'zh' ? '该 variant 无 turn 轨迹(executor 未上报)' : 'No turn trace from executor'}</div>
    </div>`;
  }
  const stepsHtml = turns.map((turn, i) => {
    const turnNum = i + 1;
    const isAssistant = turn.role === 'assistant';
    const thinkingBlock = isAssistant && turn.content
      ? `<details class="tv-thinking"><summary>${lang === 'zh' ? '展开 thinking' : 'show thinking'} (${turn.content.length} ${lang === 'zh' ? '字' : 'chars'})</summary><div class="tv-thinking-body">${e(turn.content)}</div></details>`
      : '';
    const calls = (turn.toolCalls ?? []).map((tc) => renderToolCall(tc, turnNum, matchedMockNumbersByTurn.get(turnNum) ?? [])).join('');
    const assertsForTurn = (detailsByTurn.get(turnNum) ?? []);
    const turnAssertsHtml = assertsForTurn.map((d) => `<div class="tv-trace-assert ${d.passed ? 'tv-assert--pass' : 'tv-assert--fail'}">${d.passed ? '✅' : '❌'} <code>${e(d.type)}</code> <code class="tv-assert-value">${e(typeof d.value === 'object' ? JSON.stringify(d.value) : String(d.value))}</code></div>`).join('');
    const durationTag = turn.durationMs ? `<span class="tv-turn-dur">${(turn.durationMs / 1000).toFixed(1)}s</span>` : '';
    return `<div class="tv-turn">
      <div class="tv-turn-h">Turn ${turnNum} · <code>${e(turn.role)}</code> ${durationTag}</div>
      ${thinkingBlock}
      ${calls}
      ${turnAssertsHtml}
    </div>`;
  }).join('');
  const finalOutput = variant.fullOutput
    ? `<div class="tv-final"><div class="tv-final-h">${lang === 'zh' ? '最终回答' : 'Final answer'}</div><pre class="tv-pre">${e(variant.fullOutput.length > 2000 ? variant.fullOutput.slice(0, 2000) + '…' : variant.fullOutput)}</pre></div>`
    : '';
  return `<div class="tv-section tv-section--trace">
    <div class="tv-section-h">${lang === 'zh' ? '🎬 执行轨迹' : '🎬 Execution trace'}</div>
    ${stepsHtml}
    ${finalOutput}
  </div>`;
}

function renderToolCall(tc: ToolCallInfo, _turnNum: number, mockHitsHere: number[]): string {
  const inputRepr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? '');
  const outputRepr = typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output ?? '');
  const mockBadge = mockHitsHere.length > 0
    ? `<span class="tv-mock-badge" title="matched mock #${mockHitsHere.join(',#')}">✓ mock#${mockHitsHere.join(',#')}</span>`
    : '';
  return `<div class="tv-call ${tc.success ? '' : 'tv-call--err'}">
    <div class="tv-call-h">🔧 <code>${e(tc.tool)}</code> ${mockBadge}</div>
    <details><summary>input</summary><pre class="tv-pre">${e(inputRepr.length > 1000 ? inputRepr.slice(0, 1000) + '…' : inputRepr)}</pre></details>
    <details><summary>output</summary><pre class="tv-pre">${e(outputRepr.length > 1000 ? outputRepr.slice(0, 1000) + '…' : outputRepr)}</pre></details>
  </div>`;
}

function renderAssertionsSummary(
  details: AssertionDetail[] | undefined,
  expected: Assertion[] | undefined,
  toolCalls: ToolCallInfo[],
  turns: TurnInfo[] | undefined,
  lang: Lang,
): { html: string; detailsByTurn: Map<number, AssertionDetail[]>; matchedMocks: number[] } {
  if (!details || details.length === 0) {
    return {
      html: `<div class="tv-section tv-section--asserts">
        <div class="tv-section-h">${lang === 'zh' ? '📊 断言结果' : '📊 Assertion results'}</div>
        <div class="tv-empty">${lang === 'zh' ? '该 sample 没有声明 assertion' : 'No assertions declared on this sample'}</div>
      </div>`,
      detailsByTurn: new Map(),
      matchedMocks: [],
    };
  }
  const turnByCallSig = indexToolCallsByTurn(turns);
  const detailsByTurn = new Map<number, AssertionDetail[]>();
  const matchedMocks: number[] = [];
  const lines: string[] = [];
  details.forEach((d, i) => {
    const expectedAssertion = expected?.[i];
    const binding = expectedAssertion
      ? findAssertionTurn(expectedAssertion, d, toolCalls, turnByCallSig)
      : { turn: null };
    if (binding.turn !== null) {
      const arr = detailsByTurn.get(binding.turn) ?? [];
      arr.push(d);
      detailsByTurn.set(binding.turn, arr);
    }
    if (expectedAssertion?.type === 'mock_hit' && binding.turn !== null) {
      const value = String(expectedAssertion.value ?? d.value ?? '');
      const { needle } = parseToolColonValue(value);
      const idx = parseInt(needle, 10);
      if (Number.isFinite(idx)) matchedMocks.push(idx);
    }
    lines.push(renderAssertionLine(d, binding.turn, lang));
  });
  const passCount = details.filter((d) => d.passed).length;
  return {
    html: `<div class="tv-section tv-section--asserts">
      <div class="tv-section-h">${lang === 'zh' ? '📊 断言结果' : '📊 Assertion results'} <span class="tv-section-stat">(${passCount}/${details.length})</span></div>
      ${lines.join('')}
    </div>`,
    detailsByTurn,
    matchedMocks,
  };
}

function buildMatchedMocksByTurn(
  matchedMockIndices: number[],
  expected: Assertion[] | undefined,
  toolCalls: ToolCallInfo[],
  turns: TurnInfo[] | undefined,
): Map<number, number[]> {
  // matchedMockIndices: list of mock indices(1-based)that have an associated turn-bound assertion.
  // 重新走一遍 toolCalls,把 mock idx 对应的 turn 编号收集起来。
  const out = new Map<number, number[]>();
  if (matchedMockIndices.length === 0 || !expected) return out;
  const turnByCallSig = indexToolCallsByTurn(turns);
  const counters = new Map<string, number>();
  // 给每个 toolCall 配上"它在该 tool 内的第几次调用"
  const callIndexByCall = new Map<string, number>();
  for (const tc of toolCalls) {
    const next = (counters.get(tc.tool) ?? 0) + 1;
    counters.set(tc.tool, next);
    callIndexByCall.set(toolCallSignature(tc), next);
  }
  // 对每条 mock_hit 期望,找到匹配的 toolCall 的 turn
  for (const a of expected) {
    if (a.type !== 'mock_hit') continue;
    const value = String(a.value ?? '');
    const { tool, needle } = parseToolColonValue(value);
    const want = parseInt(needle, 10);
    if (!Number.isFinite(want)) continue;
    if (!matchedMockIndices.includes(want)) continue;
    for (const tc of toolCalls) {
      if (tc.tool !== tool) continue;
      const sig = toolCallSignature(tc);
      if (callIndexByCall.get(sig) === want) {
        const turn = turnByCallSig.get(sig);
        if (turn) {
          const arr = out.get(turn) ?? [];
          arr.push(want);
          out.set(turn, arr);
        }
        break;
      }
    }
  }
  return out;
}

/**
 * Diagnostic 区 — 与 Judge 评价彻底独立的功能性测试视角。
 *
 * 数据来源:variant.diagnostic(eval pipeline 在 failed sample 上跑独立 LLM 调用产出)。
 * --no-diagnostic 跑会缺这个字段,显示降级提示。
 *
 * 与 Judge 评价的区别:
 *   - Judge 答"打几分"(主观质量),归 📊 评分 tab。
 *   - Diagnostic 答"哪错了 + skill 怎么改"(可操作建议),归 ✅ 单测 tab。
 * 此 renderer 只负责后者,不读 llmReason / llmReasoning。
 *
 * 设计:fail 用例顶部默认展开;pass 用例不显示这个 section(诊断只对 fail 有意义)。
 */
function renderDiagnosticSection(variant: VariantResult, verdict: 'pass' | 'fail', lang: Lang): string {
  // pass 用例不需要诊断
  if (verdict === 'pass') return '';

  const diag = variant.diagnostic;
  if (!diag) {
    return `<div class="tv-diag">
      <p class="tv-diag-text"><em>${lang === 'zh' ? '此用例无诊断(可能跑了 --no-diagnostic 或 report 早于诊断功能)。重跑 omk eval 即可看到针对性建议。' : 'No diagnostic on this failed case. Re-run omk eval to get targeted suggestions.'}</em></p>
    </div>`;
  }
  if (!diag.ok) {
    return `<div class="tv-diag">
      <p class="tv-diag-text"><em>${lang === 'zh' ? '诊断生成失败:' : 'Diagnostic generation failed:'} ${e(diag.error || '')}</em></p>
      ${diag.summary ? `<p class="tv-diag-text">${e(diag.summary)}</p>` : ''}
    </div>`;
  }

  // 单一建议块:三类 suggestion 中只挑非空的展示。优先级 sample > skill > none(用例bug 比 skill 改进比"无需改"更紧迫)。
  let suggestion: { label: string; body: string } | null = null;
  if (diag.suggestion.sample) {
    suggestion = { label: lang === 'zh' ? '◇ 建议改 sample' : '◇ Edit sample', body: diag.suggestion.sample };
  } else if (diag.suggestion.skill) {
    suggestion = { label: lang === 'zh' ? '◇ 建议改 skill' : '◇ Edit skill', body: diag.suggestion.skill };
  } else if (diag.suggestion.none) {
    suggestion = { label: lang === 'zh' ? '◇ 无需改动' : '◇ No fix needed', body: diag.suggestion.none };
  }
  const suggestionHtml = suggestion
    ? `<div class="tv-suggestion">
        <span class="tv-suggestion-label">${suggestion.label}</span>
        <p class="tv-suggestion-body">${e(suggestion.body)}</p>
       </div>`
    : '';

  // 失败模式标签 — 中文枚举,直接显著展示在 summary 下
  const failureModes = diag.failureModes ?? [];
  const failureModesHtml = failureModes.length > 0
    ? `<div class="tv-diag-modes">
        <span class="tv-diag-modes-label">${lang === 'zh' ? '失败模式:' : 'Failure modes:'}</span>
        ${failureModes.map((m) => `<span class="tv-diag-mode-pill tv-diag-mode--${e(failureModeSlug(m))}">${e(m)}</span>`).join('')}
       </div>`
    : '';

  // 工作流校验清单 — 默认展开,放在 suggestion 之上(最直接的"哪步对哪步错"视图)
  const workflowChecks = diag.workflowChecks ?? [];
  const workflowChecksHtml = workflowChecks.length > 0
    ? `<div class="tv-diag-workflow">
        <p class="tv-diag-workflow-title">${lang === 'zh' ? '工作流校验' : 'Workflow checklist'}</p>
        <ul class="tv-diag-workflow-list">
          ${workflowChecks.map((c) => `
            <li class="tv-diag-workflow-item tv-diag-workflow-item--${c.passed ? 'pass' : 'fail'}">
              <span class="tv-diag-workflow-icon">${c.passed ? '✓' : '✗'}</span>
              <div class="tv-diag-workflow-body">
                <span class="tv-diag-workflow-step">${e(c.step)}</span>
                ${c.evidence ? `<span class="tv-diag-workflow-evidence">${e(c.evidence)}</span>` : ''}
              </div>
            </li>
          `).join('')}
        </ul>
       </div>`
    : '';

  // 详情区(rootCause + expected/actual + 其余 suggestion)默认折叠
  const rootCausePills = diag.rootCause.length > 0
    ? `<p><strong>${lang === 'zh' ? '归因:' : 'Root cause:'}</strong>${diag.rootCause.map((c) => `<span class="tv-diag-rc-pill tv-diag-rc--${e(c)}">${e(rootCauseLabel(c, lang))}</span>`).join('')}</p>`
    : '';
  const detailsContent: string[] = [];
  if (rootCausePills) detailsContent.push(rootCausePills);
  if (diag.expected) detailsContent.push(`<p><strong>${lang === 'zh' ? '期望:' : 'Expected:'}</strong>${e(diag.expected)}</p>`);
  if (diag.actual) detailsContent.push(`<p><strong>${lang === 'zh' ? '实际:' : 'Actual:'}</strong>${e(diag.actual)}</p>`);
  // 其它 suggestion 槽位也露出来(避免完全隐藏)
  if (diag.suggestion.sample && suggestion?.label !== (lang === 'zh' ? '◇ 建议改 sample' : '◇ Edit sample')) {
    detailsContent.push(`<p><strong>${lang === 'zh' ? '另:改 sample' : 'Also: edit sample'}</strong>${e(diag.suggestion.sample)}</p>`);
  }
  if (diag.suggestion.skill && suggestion?.label !== (lang === 'zh' ? '◇ 建议改 skill' : '◇ Edit skill')) {
    detailsContent.push(`<p><strong>${lang === 'zh' ? '另:改 skill' : 'Also: edit skill'}</strong>${e(diag.suggestion.skill)}</p>`);
  }
  const detailsHtml = detailsContent.length > 0
    ? `<details class="tv-diag-details"><summary>${lang === 'zh' ? '展开归因细节' : 'show root cause / expected vs actual'}</summary>
        <div class="tv-diag-details-body">${detailsContent.join('')}</div>
       </details>`
    : '';

  // 部分内容(salvage)时挂个小提示,让用户知道诊断 LLM 输出被截断
  const partialBadge = diag.error?.startsWith('partial:')
    ? `<p class="tv-diag-partial"><em>${lang === 'zh' ? '⚠ 诊断 LLM 输出被截断,以下为部分内容' : '⚠ Diagnostic LLM output truncated; partial content shown'}</em></p>`
    : '';

  return `<div class="tv-diag">
    ${partialBadge}
    ${diag.summary ? `<p class="tv-diag-text">${e(diag.summary)}</p>` : ''}
    ${failureModesHtml}
    ${workflowChecksHtml}
    ${suggestionHtml}
    ${detailsHtml}
  </div>`;
}

/** 失败模式中文标签 → CSS-safe slug,用于挂 tv-diag-mode--<slug> 的颜色样式。 */
function failureModeSlug(m: string): string {
  const map: Record<string, string> = {
    '工作流跳步': 'workflow-skip',
    '硬编码值': 'hardcoded',
    '幻觉输出': 'hallucination',
    '工具误用': 'tool-misuse',
    '环境拦截': 'env-blocked',
    '误读约束': 'misread',
    '其他': 'other',
  };
  return map[m] ?? 'other';
}

/** rootCause 英文枚举 → 中文/英文短标签(给已有 rc-pill 用,UI 不再直接吐 enum 名)。 */
function rootCauseLabel(c: string, lang: Lang): string {
  const zh: Record<string, string> = {
    'skill_doc_unclear': 'skill 文档模糊',
    'skill_doc_missing': 'skill 缺失场景',
    'llm_misread': 'LLM 误读',
    'sample_design': 'sample 设计 bug',
    'tripwire_intentional': '诱错样本(预期)',
  };
  const en: Record<string, string> = {
    'skill_doc_unclear': 'skill doc unclear',
    'skill_doc_missing': 'skill doc missing',
    'llm_misread': 'LLM misread',
    'sample_design': 'sample design bug',
    'tripwire_intentional': 'tripwire (expected fail)',
  };
  return (lang === 'zh' ? zh : en)[c] ?? c;
}

interface SampleCardData {
  sample_id: string;
  snapshot: SampleSnapshot | undefined;
  variant: VariantResult;
  cardKind: 'pass' | 'fail' | 'tripwire';
}

/** 把 design / trace / assertions 三段子内容包成 <details>(默认折叠),供 pass row 展开 / fail card 折叠后查看用。 */
function renderSubSections(d: SampleCardData, lang: Lang): string {
  const { snapshot, variant } = d;
  const toolCalls = variant.toolCalls ?? [];
  const turns = variant.turns;
  const summary = renderAssertionsSummary(variant.assertions?.details, snapshot?.assertions, toolCalls, turns, lang);
  const matchedByTurn = buildMatchedMocksByTurn(summary.matchedMocks, snapshot?.assertions, toolCalls, turns);
  const designHtml = renderDesignSection(snapshot, lang);
  const traceHtml = renderExecutionTrace(variant, summary.detailsByTurn, matchedByTurn, lang);
  const totalAsserts = variant.assertions?.total ?? 0;
  const passedAsserts = variant.assertions?.passed ?? 0;

  return `
    <details class="tv-section"><summary>${lang === 'zh' ? '用例设计' : 'Test design'}</summary><div class="tv-section-body">${designHtml}</div></details>
    <details class="tv-section"><summary>${lang === 'zh' ? '执行轨迹' : 'Execution trace'}<span class="tv-section-stat">(${turns?.length ?? 0} ${lang === 'zh' ? '步' : 'steps'} · ${toolCalls.length} ${lang === 'zh' ? '工具调用' : 'tool calls'})</span></summary><div class="tv-section-body">${traceHtml}</div></details>
    <details class="tv-section"><summary>${lang === 'zh' ? '断言结果' : 'Assertion results'}<span class="tv-section-stat">(${passedAsserts}/${totalAsserts})</span></summary><div class="tv-section-body">${summary.html}</div></details>
  `;
}

function buildCardData(sample_id: string, snapshot: SampleSnapshot | undefined, variant: VariantResult): SampleCardData {
  const rawVerdict = variant.ok === false ? 'fail' : sampleVerdict(variant.assertions?.details);
  const isTripwire = rawVerdict === 'fail' && isTripwireSample(snapshot, variant);
  return { sample_id, snapshot, variant, cardKind: isTripwire ? 'tripwire' : rawVerdict };
}

/** Header 公共部分:状态点 + sample_id + 标题 + 耗时。
 *  评分(compositeScore)和成本($cost)挪到详情区,列表只保留状态识别需要的最小信息。 */
function renderCardHeader(d: SampleCardData, lang: Lang): string {
  const { sample_id, snapshot, variant, cardKind } = d;
  const dur = variant.timing?.execMs ?? variant.durationMs;
  const durTag = dur ? `${(dur / 1000).toFixed(1)}s` : '—';
  const titleSnippet = snapshot?.prompt
    ? snapshot.prompt.slice(0, 80).replace(/\n/g, ' ')
    : (lang === 'zh' ? '(无 prompt 快照)' : '(no prompt snapshot)');

  return `
    <span class="tv-dot tv-dot--${cardKind}"></span>
    <code class="tv-id">${e(sample_id)}</code>
    <span class="tv-title">${e(titleSnippet)}${snapshot?.prompt && snapshot.prompt.length > 80 ? '…' : ''}</span>
    <span class="tv-meta">${durTag}</span>
  `;
}

/** Pass 用例:单行折叠,点击展开看完整内容(design/trace/assertions)。 */
function renderPassRow(d: SampleCardData, lang: Lang): string {
  return `<details class="tv-row tv-row--pass">
    <summary class="tv-row-h">${renderCardHeader(d, lang)}</summary>
    <div class="tv-row-body">${renderSubSections(d, lang)}</div>
  </details>`;
}

/** Fail / tripwire 卡片:默认展开,顶部诊断区,sub-section 折叠。 */
function renderFailCard(d: SampleCardData, lang: Lang): string {
  const tripwireBanner = d.cardKind === 'tripwire'
    ? `<div class="tv-tripwire-banner">
        <div class="tv-tripwire-banner-title">${lang === 'zh' ? '◆ 这是诱错样本' : '◆ This is a tripwire sample'}</div>
        <div class="tv-tripwire-banner-body">${lang === 'zh'
          ? '用户 prompt 故意诱导 LLM 走错。LLM 失败 = 已记录的 LLM 边界数据点,不是要修的 bug。跨版本对比这条用例的 pass 率,可观察 LLM 抗诱导能力变化。'
          : 'The user prompt intentionally misdirects the LLM. A failure here is a recorded LLM-susceptibility data point — not a bug to fix.'}</div>
       </div>`
    : '';
  const diagnosticHtml = renderDiagnosticSection(d.variant, 'fail', lang);

  // 默认折叠(用户反馈:fail/tripwire 也别自动展开,跟 pass 行为一致)。
  // 卡片头部加一行诊断 summary 摘要,折叠态也能看到失败原因不用展开。
  const diagSummaryPreview = d.variant.diagnostic?.ok && d.variant.diagnostic.summary
    ? `<div class="tv-card-preview">${e(d.variant.diagnostic.summary.slice(0, 120))}${d.variant.diagnostic.summary.length > 120 ? '…' : ''}</div>`
    : '';

  return `<details class="tv-card tv-card--${d.cardKind}">
    <summary class="tv-card-h">${renderCardHeader(d, lang)}</summary>
    ${diagSummaryPreview}
    <div class="tv-card-body">
      ${tripwireBanner}
      ${diagnosticHtml}
      ${renderSubSections(d, lang)}
    </div>
  </details>`;
}

// ──────────────────────────────────────────────────────────────────
// 主入口
// ──────────────────────────────────────────────────────────────────

export function renderTestView(report: EvaluationReport, lang: Lang): string {
  const variants = report.meta.variants || [];
  const results = report.results || [];
  const snapshots = report.sampleSnapshots ?? {};
  if (variants.length === 0 || results.length === 0) {
    return `<div class="tv-root"><div class="tv-empty-page">${lang === 'zh' ? '无 variant 或 result,无法渲染单测视角' : 'No variants or results to render'}</div></div>`;
  }
  const hasSnapshots = Object.keys(snapshots).length > 0;
  const fallbackBanner = hasSnapshots ? '' : `<div class="tv-warn">${lang === 'zh' ? '⚠ 该 report 缺 sampleSnapshots(早期版本生成),只能展示执行结果,无设计信息' : '⚠ Report has no sampleSnapshots (older format); only execution results shown'}</div>`;

  const variantSections = variants.map((variant, idx) => {
    // 按 verdict 分三组:pass(单行) / fail(完整卡片) / tripwire(诱错卡片)。
    const passData: SampleCardData[] = [];
    const failData: SampleCardData[] = [];
    const tripwireData: SampleCardData[] = [];
    for (const r of results) {
      const v = r.variants[variant];
      if (!v) continue;
      const d = buildCardData(r.sample_id, snapshots[r.sample_id], v);
      if (d.cardKind === 'pass') passData.push(d);
      else if (d.cardKind === 'tripwire') tripwireData.push(d);
      else failData.push(d);
    }

    const passSection = passData.length > 0
      ? `<div class="tv-group-sep">${lang === 'zh' ? '通过用例' : 'Passed'}</div>
         <div class="tv-rows">${passData.map((d) => renderPassRow(d, lang)).join('')}</div>`
      : '';
    const failSection = failData.length > 0
      ? `<div class="tv-group-sep">${lang === 'zh' ? '失败用例' : 'Failed'}</div>
         ${failData.map((d) => renderFailCard(d, lang)).join('')}`
      : '';
    const tripwireSection = tripwireData.length > 0
      ? `<div class="tv-group-sep">${lang === 'zh' ? '诱错样本' : 'Tripwire samples'}</div>
         ${tripwireData.map((d) => renderFailCard(d, lang)).join('')}`
      : '';

    const variantStats = computeVariantStats(report, variant);
    const tripwireStat = variantStats.tripwire > 0
      ? `<span class="tv-stat tv-stat--tripwire"><span class="tv-stat-num">${variantStats.tripwire}</span>${lang === 'zh' ? '诱错触发' : 'tripwire'}</span>`
      : '';

    return `<div class="tv-variant-panel" data-variant="${e(variant)}" ${idx === 0 ? '' : 'hidden'}>
      <div class="tv-variant-stats">
        <span class="tv-stat tv-stat--pass"><span class="tv-stat-num">${variantStats.passed}</span>${lang === 'zh' ? '通过' : 'passed'}</span>
        <span class="tv-stat tv-stat--fail"><span class="tv-stat-num">${variantStats.failed}</span>${lang === 'zh' ? '失败' : 'failed'}</span>
        ${tripwireStat}
        <span class="tv-stat"><span class="tv-stat-num">${variantStats.avgScore.toFixed(1)}</span>${lang === 'zh' ? '平均分' : 'avg / 5'}</span>
      </div>
      ${failSection}
      ${tripwireSection}
      ${passSection}
    </div>`;
  }).join('');

  // 只 1 个 variant 时不显示切换器(SOLO 模式没对照,显示 tab 反而困惑)。
  const variantTabsHtml = variants.length > 1
    ? `<div class="tv-variant-tabs">${variants.map((variant, idx) => `<button type="button" class="tv-vtab ${idx === 0 ? 'tv-vtab--active' : ''}" data-target="${e(variant)}" onclick="omkSwitchVariant(this)">${e(variant)}</button>`).join('')}</div>`
    : '';

  // 整个 test view 包在 tv-root 里,scoped 浅色岛(覆盖外层深色 layout)。
  return `<div class="tv-root">${fallbackBanner}
    ${variantTabsHtml}
    ${variantSections}</div>`;
}

function computeVariantStats(report: EvaluationReport, variant: string): { passed: number; failed: number; tripwire: number; avgScore: number } {
  const snapshots = report.sampleSnapshots ?? {};
  let passed = 0;
  let failed = 0;
  let tripwire = 0;
  let scoreSum = 0;
  let scoreCount = 0;
  for (const r of report.results) {
    const v = r.variants[variant];
    if (!v) continue;
    const verdict = v.ok === false ? 'fail' : sampleVerdict(v.assertions?.details);
    if (verdict === 'pass') {
      passed += 1;
    } else if (isTripwireSample(snapshots[r.sample_id], v)) {
      tripwire += 1;  // 诱错样本失败单独统计,不算"失败"也不算"通过"
    } else {
      failed += 1;
    }
    if (typeof v.compositeScore === 'number') {
      scoreSum += v.compositeScore;
      scoreCount += 1;
    }
  }
  return {
    passed,
    failed,
    tripwire,
    avgScore: scoreCount > 0 ? scoreSum / scoreCount : 0,
  };
}

/** 单测视角的 CSS。
 *
 * 设计原则:
 *   - **scoped 浅色岛**:外层 layout 是深色主题(评分 tab 用),test view 在 .tv-root
 *     里覆盖一套浅色变量,实现"切到单测 tab = 切到杂志阅读模式"。
 *   - **潘通启发的哑色调**:sage/dusty rose/mauve(饱和度 ~50%),不像 GitHub error log。
 *   - **大字号 + 高行高**:正文 15px / 行高 1.75,代码 13px。中文优先 PingFang/YaHei。
 *   - **subtle shadow 替代 border**:卡片间 16-24px 留白,box-shadow 浮起感。
 *   - **default-collapsed**:通过的用例只显一行;失败/诱错展开诊断,其余 section 折叠。
 */
export const TEST_VIEW_CSS = `
/* tv-root: 浅色岛,scoped 覆盖外层深色 layout */
.tv-root {
  --tv-bg:#fbfaf7; --tv-bg-card:#ffffff; --tv-bg-soft:rgba(58,58,58,.025);
  --tv-text:#3a3a3a; --tv-text-2:#7a7a7a; --tv-text-3:#a8a8a8;
  --tv-divider:#e8e3da;
  /* 加大 pass / fail / tripwire 的色相距离 + 暗度差,避免远看雷同。
     pass: 鼠尾草绿(暗一档,靠近林地);fail: 砖红土陶(暗一档,远离 pink);tripwire: 紫罗兰(独立色相)。 */
  --tv-pass:#5e8252; --tv-fail:#9c4a3f; --tv-tripwire:#7a6b89;
  --tv-pass-soft:rgba(94,130,82,.10); --tv-fail-soft:rgba(156,74,63,.10); --tv-tripwire-soft:rgba(122,107,137,.10);
  --tv-accent:#5a7a93; --tv-warn:#b08030;
  --tv-shadow:0 1px 3px rgba(58,58,58,.06);
  --tv-shadow-hover:0 2px 8px rgba(58,58,58,.10);
  background:var(--tv-bg); color:var(--tv-text);
  padding:32px 0; margin:-16px 0 0; border-radius:6px;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;
  font-size:15px; line-height:1.75;
}
/* Variant tabs — 显式 reset 浏览器默认 button 样式(border-radius / outline / appearance)
   防止 layout 那边的全局 button 规则给底部加了奇怪圆角和深色背景。 */
.tv-root .tv-variant-tabs { display:flex;gap:0;margin:0 0 24px;border-bottom:1px solid var(--tv-divider) }
.tv-root .tv-vtab { padding:12px 20px;background:transparent;border:none;border-radius:0;cursor:pointer;color:var(--tv-text-2);border-bottom:2px solid transparent;font-size:14px;font-family:inherit;font-weight:500;outline:none;appearance:none;-webkit-appearance:none;margin-bottom:-1px }
.tv-root .tv-vtab:hover { color:var(--tv-text) }
.tv-root .tv-vtab--active { color:var(--tv-text);border-bottom-color:var(--tv-accent);font-weight:600 }
.tv-root .tv-vtab:focus-visible { outline:2px solid var(--tv-accent);outline-offset:-4px;border-radius:4px }
/* tv-variant-panel: 不打横向 padding,内容直接对齐 .tv-root 边界,跟外层 omk-view-panel 的 h1/subtitle 同基线。 */
/* Stats — 更扁平的数字+标签布局 */
.tv-root .tv-variant-stats { display:flex;gap:32px;margin:0 0 24px;font-size:14px;color:var(--tv-text-2);align-items:baseline }
.tv-root .tv-stat { display:flex;align-items:baseline;gap:6px }
.tv-root .tv-stat-num { color:var(--tv-text);font-weight:600;font-size:18px;font-variant-numeric:tabular-nums }
.tv-root .tv-stat--pass .tv-stat-num { color:var(--tv-pass) }
.tv-root .tv-stat--fail .tv-stat-num { color:var(--tv-fail) }
.tv-root .tv-stat--tripwire .tv-stat-num { color:var(--tv-tripwire) }
/* Group separator */
.tv-root .tv-group-sep { display:flex;align-items:center;gap:14px;margin:32px 0 16px;color:var(--tv-text-3);font-size:12px;text-transform:uppercase;letter-spacing:0.08em;font-weight:500 }
.tv-root .tv-group-sep::after { content:'';flex:1;height:1px;background:var(--tv-divider) }
/* Pass rows — one-line list,左边一道淡 sage 色条做"通过"暗示 */
.tv-root .tv-rows { display:flex;flex-direction:column;gap:6px;margin:0 }
.tv-root .tv-row { background:var(--tv-bg-card);border-radius:6px;box-shadow:var(--tv-shadow);transition:box-shadow .15s;border-left:3px solid var(--tv-pass) }
.tv-root .tv-row:hover { box-shadow:var(--tv-shadow-hover) }
.tv-root .tv-row[open] { box-shadow:var(--tv-shadow-hover) }
.tv-root .tv-row-h { display:flex;align-items:center;gap:14px;padding:14px 20px;cursor:pointer;list-style:none;font-size:15px }
.tv-root .tv-row-h::-webkit-details-marker { display:none }
.tv-root .tv-row-h::after { content:'›';margin-left:8px;color:var(--tv-text-3);font-size:18px;transition:transform .15s }
.tv-root .tv-row[open] .tv-row-h::after { transform:rotate(90deg) }
/* Cards (fail / tripwire) — 默认折叠,跟 pass row 一致;头部下面加一行 preview 让折叠态也有信息密度 */
.tv-root .tv-card { background:var(--tv-bg-card);border-radius:8px;box-shadow:var(--tv-shadow);margin:0 0 12px;transition:box-shadow .15s }
.tv-root .tv-card:hover { box-shadow:var(--tv-shadow-hover) }
.tv-root .tv-card--fail { border-left:3px solid var(--tv-fail) }
.tv-root .tv-card--tripwire { border-left:3px solid var(--tv-tripwire) }
.tv-root .tv-card-h { display:flex;align-items:center;gap:14px;padding:16px 22px;cursor:pointer;list-style:none;font-size:15px }
.tv-root .tv-card-h::-webkit-details-marker { display:none }
.tv-root .tv-card-h::after { content:'›';margin-left:8px;color:var(--tv-text-3);font-size:18px;transition:transform .15s }
.tv-root .tv-card[open] .tv-card-h::after { transform:rotate(90deg) }
.tv-root .tv-card[open] .tv-card-h { border-bottom:1px solid var(--tv-divider) }
.tv-root .tv-card-preview { padding:0 22px 14px;color:var(--tv-text-2);font-size:14px;line-height:1.7;border-bottom:1px solid var(--tv-divider) }
.tv-root .tv-card[open] .tv-card-preview { display:none }
/* Status dots — 用形状 + 色 + 字符的三重区分,避免色盲 / 远看雷同。
   pass: 实心圆 sage;fail: 红 ✗ 字符(更显眼);tripwire: 紫色 ◆ 菱形。 */
.tv-root .tv-dot { display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex-shrink:0;font-size:14px;font-weight:700;line-height:1 }
.tv-root .tv-dot--pass::before { content:'';width:10px;height:10px;border-radius:50%;background:var(--tv-pass);box-shadow:0 0 0 3px var(--tv-pass-soft) }
.tv-root .tv-dot--fail::before { content:'✗';color:var(--tv-fail);font-size:16px;font-weight:700 }
.tv-root .tv-dot--tripwire::before { content:'◆';color:var(--tv-tripwire);font-size:13px }
.tv-root .tv-id { font-family:"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;font-size:13px;color:var(--tv-text-3) }
.tv-root .tv-title { flex:1;font-size:15px;color:var(--tv-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
.tv-root .tv-meta { font-size:13px;color:var(--tv-text-3);font-variant-numeric:tabular-nums;font-family:"SF Mono","JetBrains Mono",Menlo,monospace }
/* Body padding */
.tv-root .tv-card-body, .tv-root .tv-row-body { padding:22px }
/* Tripwire banner — 卡片顶部的紫色解释带 */
.tv-root .tv-tripwire-banner { margin:-22px -22px 20px;padding:18px 22px;background:rgba(139,124,147,.08);border-radius:8px 8px 0 0;border-bottom:1px solid var(--tv-divider) }
.tv-root .tv-tripwire-banner-title { font-size:14px;font-weight:600;color:var(--tv-tripwire);margin-bottom:6px;letter-spacing:0.02em }
.tv-root .tv-tripwire-banner-body { font-size:14px;color:var(--tv-text-2);line-height:1.7 }
/* Diagnosis — 一段白话 + 单一蓝色建议块 + 折叠细节 */
.tv-root .tv-diag { margin:4px 0 16px }
.tv-root .tv-diag-text { font-size:15px;line-height:1.75;color:var(--tv-text);margin:0 0 16px }
.tv-root .tv-suggestion { background:rgba(90,122,147,.06);border-left:3px solid var(--tv-accent);padding:14px 18px;margin:12px 0;border-radius:0 4px 4px 0 }
.tv-root .tv-suggestion-label { display:inline-block;color:var(--tv-accent);font-weight:600;font-size:13px;margin-right:8px;letter-spacing:0.02em }
.tv-root .tv-suggestion-body { margin:6px 0 0;font-size:14.5px;line-height:1.7;color:var(--tv-text) }
.tv-root .tv-diag-details { margin-top:14px }
.tv-root .tv-diag-details > summary { cursor:pointer;font-size:13px;color:var(--tv-text-2);list-style:none }
.tv-root .tv-diag-details > summary::-webkit-details-marker { display:none }
.tv-root .tv-diag-details > summary::before { content:'▸ ';color:var(--tv-text-3);display:inline-block;width:16px }
.tv-root .tv-diag-details[open] > summary::before { content:'▾ ' }
.tv-root .tv-diag-details-body { padding:10px 0 0 16px;font-size:14px;line-height:1.7;color:var(--tv-text-2) }
.tv-root .tv-diag-details-body p { margin:6px 0 }
.tv-root .tv-diag-details-body strong { color:var(--tv-text);margin-right:6px }
/* RootCause inline pill */
.tv-root .tv-diag-rc-pill { font-size:11px;padding:2px 8px;border-radius:10px;background:var(--tv-bg-soft);color:var(--tv-text-2);margin-right:6px;display:inline-block }
.tv-root .tv-diag-rc--tripwire_intentional { background:rgba(139,124,147,.12);color:var(--tv-tripwire) }
.tv-root .tv-diag-rc--sample_design { background:rgba(90,122,147,.10);color:var(--tv-accent) }
.tv-root .tv-diag-rc--skill_doc_unclear, .tv-diag-rc--skill_doc_missing, .tv-root .tv-diag-rc--llm_misread { background:rgba(176,128,48,.10);color:var(--tv-warn) }
/* Failure-mode chips — 中文标签,显著展示在 summary 下 */
.tv-root .tv-diag-modes { display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:8px 0 14px }
.tv-root .tv-diag-modes-label { font-size:12px;color:var(--tv-text-2);margin-right:4px }
.tv-root .tv-diag-mode-pill { font-size:12px;padding:3px 10px;border-radius:11px;background:var(--tv-bg-soft);color:var(--tv-text);font-weight:500 }
.tv-root .tv-diag-mode--workflow-skip   { background:rgba(176,128,48,.12);color:var(--tv-warn) }
.tv-root .tv-diag-mode--hardcoded       { background:rgba(176,128,48,.12);color:var(--tv-warn) }
.tv-root .tv-diag-mode--hallucination   { background:rgba(180,75,75,.14);color:#b44b4b }
.tv-root .tv-diag-mode--tool-misuse     { background:rgba(176,128,48,.12);color:var(--tv-warn) }
.tv-root .tv-diag-mode--env-blocked     { background:rgba(90,122,147,.12);color:var(--tv-accent) }
.tv-root .tv-diag-mode--misread         { background:rgba(176,128,48,.12);color:var(--tv-warn) }
.tv-root .tv-diag-mode--other           { background:var(--tv-bg-soft);color:var(--tv-text-2) }
/* Workflow checklist — 默认展开,放在 suggestion 之上,直观展示 LLM 走对哪几步 */
.tv-root .tv-diag-workflow { margin:14px 0;padding:12px 14px;background:var(--tv-bg-soft);border-radius:6px }
.tv-root .tv-diag-workflow-title { font-size:13px;font-weight:600;color:var(--tv-text);margin:0 0 10px;letter-spacing:0.02em }
.tv-root .tv-diag-workflow-list { list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px }
.tv-root .tv-diag-workflow-item { display:flex;align-items:flex-start;gap:10px;line-height:1.6 }
.tv-root .tv-diag-workflow-icon { flex-shrink:0;font-weight:700;font-size:14px;width:16px;text-align:center;margin-top:2px }
.tv-root .tv-diag-workflow-item--pass .tv-diag-workflow-icon { color:#3a8a3a }
.tv-root .tv-diag-workflow-item--fail .tv-diag-workflow-icon { color:#b44b4b }
.tv-root .tv-diag-workflow-body { display:flex;flex-direction:column;gap:2px;flex:1 }
.tv-root .tv-diag-workflow-step { font-size:14px;color:var(--tv-text) }
.tv-root .tv-diag-workflow-evidence { font-size:12.5px;color:var(--tv-text-2);line-height:1.55 }
.tv-root .tv-diag-workflow-item--fail .tv-diag-workflow-step { color:#b44b4b }
/* Partial salvage 提示 */
.tv-root .tv-diag-partial { font-size:12px;color:var(--tv-text-3);margin:0 0 8px;font-style:italic }
/* Sub-sections — design / trace / assertions, 全部默认折叠 */
.tv-root .tv-section { margin-top:6px;border-top:1px solid var(--tv-divider);padding-top:14px }
.tv-root .tv-section > summary { cursor:pointer;font-size:14px;font-weight:500;color:var(--tv-text);padding:6px 0;list-style:none }
.tv-root .tv-section > summary::-webkit-details-marker { display:none }
.tv-root .tv-section > summary::before { content:'▸ ';color:var(--tv-text-3);display:inline-block;width:16px;font-weight:400 }
.tv-root .tv-section[open] > summary::before { content:'▾ ' }
.tv-root .tv-section-stat { font-weight:400;color:var(--tv-text-3);margin-left:6px;font-size:13px }
.tv-root .tv-section-body { padding:14px 0 0 16px;font-size:14.5px;line-height:1.7 }
/* Design fields */
.tv-root .tv-prompt, .tv-root .tv-rubric { font-size:14.5px;line-height:1.75;margin:8px 0;color:var(--tv-text-2) }
.tv-root .tv-prompt strong, .tv-root .tv-rubric strong { color:var(--tv-text);margin-right:6px;font-weight:600 }
.tv-root .tv-meta-pills { margin:10px 0;display:flex;flex-wrap:wrap;gap:8px }
.tv-root .tv-meta-pill { font-size:12px;padding:3px 10px;background:var(--tv-bg-soft);border-radius:10px;color:var(--tv-text-2);font-family:"SF Mono",Menlo,monospace }
.tv-root .tv-expected { margin-top:12px }
.tv-root .tv-expected-h { font-size:13px;color:var(--tv-text-2);margin-bottom:6px }
.tv-root .tv-expect-line { font-size:13px;font-family:"SF Mono",Menlo,monospace;color:var(--tv-text-2);padding:3px 0;line-height:1.6 }
.tv-root .tv-collapsible { margin-top:10px;font-size:13px }
.tv-root .tv-collapsible > summary { cursor:pointer;color:var(--tv-text-2) }
/* Mocks */
.tv-root .tv-mocks { margin-top:8px }
.tv-root .tv-mock-line { font-size:12px;font-family:"SF Mono",Menlo,monospace;padding:3px 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center;line-height:1.6 }
.tv-root .tv-mock-idx { color:var(--tv-text-3);font-weight:600 }
.tv-root .tv-mock-tool { background:var(--tv-bg-soft);padding:2px 6px;border-radius:3px }
.tv-root .tv-mock-match, .tv-root .tv-mock-return { color:var(--tv-text-2);overflow:hidden;text-overflow:ellipsis;max-width:340px;white-space:nowrap }
.tv-root .tv-mock-arrow { color:var(--tv-text-3) }
/* Trace turns */
.tv-root .tv-turn { margin:10px 0;padding:12px 16px;background:var(--tv-bg-soft);border-radius:4px;border-left:2px solid var(--tv-divider) }
.tv-root .tv-turn-h { font-size:14px;font-weight:500;color:var(--tv-text);margin-bottom:6px }
.tv-root .tv-turn-dur { color:var(--tv-text-3);font-weight:400;font-size:12px;margin-left:6px }
.tv-root .tv-thinking { margin:6px 0;font-size:13px }
.tv-root .tv-thinking summary { cursor:pointer;color:var(--tv-text-3);font-style:italic }
.tv-root .tv-thinking-body { padding:10px 14px;background:rgba(58,58,58,.04);border-radius:4px;color:var(--tv-text-2);white-space:pre-wrap;font-size:13px;line-height:1.7;margin-top:6px }
/* Tool calls */
.tv-root .tv-call { margin:6px 0;padding:10px 14px;background:rgba(58,58,58,.03);border-radius:4px;font-size:13px }
.tv-root .tv-call--err { border-left:2px solid var(--tv-fail) }
.tv-root .tv-call-h { font-weight:500;color:var(--tv-text);margin-bottom:4px;font-size:14px }
.tv-root .tv-call details { margin:4px 0;font-size:12px }
.tv-root .tv-call summary { cursor:pointer;color:var(--tv-text-3);padding:2px 0 }
.tv-root .tv-pre { font-family:"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;font-size:13px;background:rgba(58,58,58,.04);padding:10px 14px;border-radius:4px;overflow:auto;max-height:320px;white-space:pre-wrap;margin:4px 0;color:var(--tv-text-2);line-height:1.55 }
.tv-root .tv-mock-badge { font-size:12px;color:var(--tv-pass);background:rgba(125,155,118,.12);padding:2px 8px;border-radius:10px;margin-left:8px }
.tv-root .tv-trace-assert { font-size:13px;font-family:"SF Mono",Menlo,monospace;padding:3px 0;margin-top:6px;line-height:1.5 }
.tv-root .tv-trace-assert.tv-assert--fail { color:var(--tv-fail) }
.tv-root .tv-trace-assert.tv-assert--pass { color:var(--tv-text-2) }
/* Final answer */
.tv-root .tv-final { margin-top:14px }
.tv-root .tv-final-h { font-size:14px;font-weight:500;color:var(--tv-text);margin-bottom:6px }
/* Assertions */
.tv-root .tv-assert { font-size:14px;font-family:"SF Mono",Menlo,monospace;padding:5px 0;line-height:1.6 }
.tv-root .tv-assert--pass { color:var(--tv-text-2) }
.tv-root .tv-assert--fail { color:var(--tv-fail) }
.tv-root .tv-assert-value { background:rgba(58,58,58,.04);padding:2px 6px;border-radius:3px;margin:0 2px }
.tv-root .tv-turn-tag { font-size:12px;color:var(--tv-text-3);margin-left:8px;font-style:italic;font-family:-apple-system,sans-serif }
.tv-root .tv-turn-tag--ok { color:var(--tv-pass) }
.tv-root .tv-turn-tag--miss { color:var(--tv-fail) }
.tv-root .tv-assert-msg { font-size:13px;color:var(--tv-text-3);margin-left:20px;margin-top:3px }
/* Empty/warn states */
.tv-root .tv-empty, .tv-root .tv-empty-page { color:var(--tv-text-3);font-style:italic;padding:14px 0;font-size:14px }
.tv-root .tv-warn { color:var(--tv-warn);background:rgba(176,128,48,.08);padding:14px 18px;border-radius:4px;margin:8px 24px;font-size:14px;line-height:1.7 }
`;

/** 单测视角配套 JS:variant 切换 + view tab 切换。挂在 layout 末尾。 */
export const TEST_VIEW_JS = `
function omkSwitchVariant(btn) {
  var target = btn.getAttribute('data-target');
  var tabs = btn.parentElement.querySelectorAll('.tv-vtab');
  tabs.forEach(function(t){ t.classList.toggle('tv-vtab--active', t === btn); });
  var panels = btn.parentElement.parentElement.querySelectorAll('.tv-variant-panel');
  panels.forEach(function(p){ p.hidden = (p.getAttribute('data-variant') !== target); });
}
function omkSwitchView(name) {
  var tabs = document.querySelectorAll('.omk-view-tab');
  tabs.forEach(function(t){ t.classList.toggle('omk-view-tab--active', t.getAttribute('data-view') === name); });
  var panels = document.querySelectorAll('.omk-view-panel');
  panels.forEach(function(p){ p.hidden = (p.getAttribute('data-view') !== name); });
}
`;
