/**
 * 单测视角渲染器 — 把 EvaluationReport 当作 vitest 风格的测试结果看：
 *
 *   每个 sample = 一个 test case
 *     ┌─ 用例设计(测试契约): prompt / rubric / 期望 assertions / mocks 夹具
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
  if (type === 'tool_input_contains' || type === 'tool_output_contains') {
    const value = String(assertion.value ?? detail.value ?? '');
    const { tool, needle } = parseToolColonValue(value);
    for (const tc of toolCalls) {
      if (tool && tc.tool !== tool) continue;
      const target = type === 'tool_input_contains'
        ? JSON.stringify(tc.input ?? '')
        : JSON.stringify(tc.output ?? '');
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
  if (!snapshot) {
    return `<div class="tv-section tv-section--design">
      <div class="tv-section-h">${lang === 'zh' ? '📋 用例设计' : '📋 Test design'}</div>
      <div class="tv-empty">${lang === 'zh' ? '该 report 早于单测视角支持时间,缺设计快照' : 'Report predates test-view support; no design snapshot'}</div>
    </div>`;
  }
  const meta: string[] = [];
  if (snapshot.capability && snapshot.capability.length > 0) {
    meta.push(`<span class="tv-meta-pill">capability: ${snapshot.capability.map(e).join(' · ')}</span>`);
  }
  if (snapshot.construct) meta.push(`<span class="tv-meta-pill">construct: ${e(snapshot.construct)}</span>`);
  if (snapshot.difficulty) meta.push(`<span class="tv-meta-pill">difficulty: ${e(snapshot.difficulty)}</span>`);
  if (snapshot.provenance) meta.push(`<span class="tv-meta-pill">provenance: ${e(snapshot.provenance)}</span>`);

  const expectedAssertions = (snapshot.assertions ?? []).map((a) => renderExpectedAssertion(a)).join('');
  const mocksBlock = snapshot.mocks && snapshot.mocks.length > 0
    ? `<details class="tv-collapsible"><summary>${lang === 'zh' ? `Mock 夹具(${snapshot.mocks.length} 个)` : `Mock fixtures (${snapshot.mocks.length})`}</summary>
       <div class="tv-mocks">${snapshot.mocks.map((m, i) => renderMock(m, i + 1)).join('')}</div>
       </details>`
    : '';

  return `<div class="tv-section tv-section--design">
    <div class="tv-section-h">${lang === 'zh' ? '📋 用例设计' : '📋 Test design'}</div>
    <div class="tv-prompt"><strong>${lang === 'zh' ? 'Prompt:' : 'Prompt:'}</strong> <span>${e(snapshot.prompt)}</span></div>
    ${snapshot.rubric ? `<div class="tv-rubric"><strong>Rubric:</strong> <span>${e(snapshot.rubric)}</span></div>` : ''}
    ${snapshot.context ? `<details class="tv-collapsible"><summary>Context</summary><pre class="tv-pre">${e(snapshot.context)}</pre></details>` : ''}
    ${meta.length > 0 ? `<div class="tv-meta-pills">${meta.join(' ')}</div>` : ''}
    ${expectedAssertions ? `<div class="tv-expected">
      <div class="tv-expected-h">${lang === 'zh' ? '期望（assertions）：' : 'Expected (assertions):'}</div>
      ${expectedAssertions}
    </div>` : ''}
    ${mocksBlock}
  </div>`;
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
    return `<div class="tv-section tv-section--diagnostic tv-diag--empty">
      <div class="tv-section-h">${lang === 'zh' ? '🔍 诊断' : '🔍 Diagnostic'}</div>
      <div class="tv-empty">${lang === 'zh' ? '此 fail 用例无诊断(可能跑了 --no-diagnostic 或 report 早于诊断功能)。重跑 omk eval 即可看到针对性建议。' : 'No diagnostic on this failed case (likely --no-diagnostic or report predates this feature). Re-run omk eval to get targeted suggestions.'}</div>
    </div>`;
  }
  if (!diag.ok) {
    return `<div class="tv-section tv-section--diagnostic tv-diag--fail">
      <div class="tv-section-h">${lang === 'zh' ? '🔍 诊断' : '🔍 Diagnostic'} <span class="tv-diag-score">${lang === 'zh' ? '生成失败' : 'failed'}</span></div>
      <div class="tv-empty">${e(diag.error || '')}</div>
      ${diag.summary ? `<div class="tv-diag-cot-body">${e(diag.summary)}</div>` : ''}
    </div>`;
  }

  const rootCauseTags = diag.rootCause.length > 0
    ? `<div class="tv-diag-rootcause">${diag.rootCause.map((c) => `<span class="tv-diag-rc-pill tv-diag-rc--${e(c)}">${e(c)}</span>`).join(' ')}</div>`
    : '';

  const expectedActual = (diag.expected || diag.actual)
    ? `<div class="tv-diag-ea">
        ${diag.expected ? `<div class="tv-diag-ea-row"><strong>${lang === 'zh' ? '期望:' : 'Expected:'}</strong> ${e(diag.expected)}</div>` : ''}
        ${diag.actual ? `<div class="tv-diag-ea-row"><strong>${lang === 'zh' ? '实际:' : 'Actual:'}</strong> ${e(diag.actual)}</div>` : ''}
       </div>`
    : '';

  const suggestionItems: string[] = [];
  if (diag.suggestion.skill) {
    suggestionItems.push(`<div class="tv-diag-sugg-row"><span class="tv-diag-sugg-tag tv-diag-sugg-tag--skill">${lang === 'zh' ? '改 skill' : 'edit skill'}</span> ${e(diag.suggestion.skill)}</div>`);
  }
  if (diag.suggestion.sample) {
    suggestionItems.push(`<div class="tv-diag-sugg-row"><span class="tv-diag-sugg-tag tv-diag-sugg-tag--sample">${lang === 'zh' ? '改 sample' : 'edit sample'}</span> ${e(diag.suggestion.sample)}</div>`);
  }
  if (diag.suggestion.none) {
    suggestionItems.push(`<div class="tv-diag-sugg-row"><span class="tv-diag-sugg-tag tv-diag-sugg-tag--none">${lang === 'zh' ? '无需改动' : 'no fix'}</span> ${e(diag.suggestion.none)}</div>`);
  }
  const suggestionHtml = suggestionItems.length > 0
    ? `<div class="tv-diag-sugg">
        <div class="tv-diag-sugg-h">${lang === 'zh' ? '建议' : 'Suggestion'}</div>
        ${suggestionItems.join('')}
       </div>`
    : '';

  return `<div class="tv-section tv-section--diagnostic tv-diag--fail" open>
    <div class="tv-section-h">${lang === 'zh' ? '🔍 诊断' : '🔍 Diagnostic'}</div>
    ${diag.summary ? `<div class="tv-diag-summary">${e(diag.summary)}</div>` : ''}
    ${rootCauseTags}
    ${expectedActual}
    ${suggestionHtml}
  </div>`;
}

function renderSampleCard(
  sample_id: string,
  snapshot: SampleSnapshot | undefined,
  variant: VariantResult,
  lang: Lang,
): string {
  const rawVerdict = sampleVerdict(variant.assertions?.details);
  const isTripwire = rawVerdict === 'fail' && isTripwireSample(snapshot, variant);
  // 三态:pass / fail(真 bug) / tripwire(诱错样本,设计性失败)
  const cardKind: 'pass' | 'fail' | 'tripwire' = isTripwire ? 'tripwire' : rawVerdict;

  const total = variant.assertions?.total ?? 0;
  const passed = variant.assertions?.passed ?? 0;
  const compositeScore = typeof variant.compositeScore === 'number' ? variant.compositeScore.toFixed(1) : '—';
  const dur = variant.timing?.execMs ?? variant.durationMs;
  const durTag = dur ? `${(dur / 1000).toFixed(1)}s` : '—';
  const cost = variant.execCostUSD;
  const costTag = cost && variant.costReportedByExecutor !== false ? `$${cost.toFixed(3)}` : '—';
  const titleSnippet = snapshot?.prompt
    ? snapshot.prompt.slice(0, 60).replace(/\n/g, ' ')
    : (lang === 'zh' ? '(无 prompt 快照)' : '(no prompt snapshot)');

  const toolCalls = variant.toolCalls ?? [];
  const turns = variant.turns;
  const summary = renderAssertionsSummary(variant.assertions?.details, snapshot?.assertions, toolCalls, turns, lang);
  const matchedByTurn = buildMatchedMocksByTurn(summary.matchedMocks, snapshot?.assertions, toolCalls, turns);
  const designHtml = renderDesignSection(snapshot, lang);
  // 诊断区:与 Judge 评价独立。只 fail 用例显示;pass 用例没诊断需求。
  const diagnosticHtml = renderDiagnosticSection(variant, rawVerdict, lang);
  const traceHtml = renderExecutionTrace(variant, summary.detailsByTurn, matchedByTurn, lang);

  // verdict pill 三态:PASS / FAIL / 诱错触发(中文 UI) / TRIPWIRE(英文 UI)
  let verdictLabel: string;
  if (cardKind === 'pass') verdictLabel = '✓ PASS';
  else if (cardKind === 'tripwire') verdictLabel = lang === 'zh' ? '🪤 诱错触发' : '🪤 TRIPWIRE';
  else verdictLabel = '✗ FAIL';

  // 诱错横幅:在卡片体顶部解释"这是设计性失败,不是要修的 bug"
  const tripwireBanner = isTripwire
    ? `<div class="tv-tripwire-banner">
        <strong>${lang === 'zh' ? '🪤 这是诱错样本(tripwire)' : '🪤 This is a tripwire sample'}</strong>
        <div class="tv-tripwire-banner-body">${lang === 'zh'
          ? '用户 prompt 故意诱导 LLM 走错。LLM 失败 = 已记录的 LLM 边界数据点,<strong>不是要修的 bug</strong>。<br>跨版本对比这条用例的 pass 率,可观察 LLM 抗诱导能力变化。如想让 LLM 抵抗,在 skill 加防御指引。'
          : 'The user prompt intentionally misdirects the LLM. A failure here is a recorded data point about LLM\'s susceptibility to misdirection — <strong>not a bug to fix</strong>.'}</div>
       </div>`
    : '';

  const openAttr = cardKind !== 'pass' ? ' open' : '';
  return `<details class="tv-card tv-card--${cardKind}"${openAttr}>
    <summary class="tv-card-h">
      <span class="tv-verdict tv-verdict--${cardKind}">${verdictLabel}</span>
      <code class="tv-sample-id">${e(sample_id)}</code>
      <span class="tv-card-title">${e(titleSnippet)}${snapshot?.prompt && snapshot.prompt.length > 60 ? '…' : ''}</span>
      <span class="tv-card-stats">${passed}/${total} · ${durTag} · ${costTag} · ${lang === 'zh' ? '评分' : 'score'} ${compositeScore}</span>
    </summary>
    <div class="tv-card-body">
      ${tripwireBanner}
      ${diagnosticHtml}
      ${designHtml}
      ${traceHtml}
      ${summary.html}
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
    return `<div class="tv-empty-page">${lang === 'zh' ? '无 variant 或 result,无法渲染单测视角' : 'No variants or results to render'}</div>`;
  }
  const hasSnapshots = Object.keys(snapshots).length > 0;
  const fallbackBanner = hasSnapshots ? '' : `<div class="tv-warn">${lang === 'zh' ? '⚠ 该 report 缺 sampleSnapshots(早期版本生成),只能展示执行结果,无设计信息' : '⚠ Report has no sampleSnapshots (older format); only execution results shown'}</div>`;

  // 默认显示第 1 个 variant;UI 里有 selector 切换。
  const variantSections = variants.map((variant, idx) => {
    const cards = results.map((r) => {
      const variantResult = r.variants[variant];
      if (!variantResult) return '';
      return renderSampleCard(r.sample_id, snapshots[r.sample_id], variantResult, lang);
    }).filter(Boolean).join('');
    const variantStats = computeVariantStats(report, variant);
    const tripwireStat = variantStats.tripwire > 0
      ? `<span class="tv-stat tv-stat--tripwire">🪤 ${variantStats.tripwire} ${lang === 'zh' ? '诱错触发' : 'tripwire'}</span>`
      : '';
    return `<div class="tv-variant-panel" data-variant="${e(variant)}" ${idx === 0 ? '' : 'hidden'}>
      <div class="tv-variant-stats">
        <span class="tv-stat tv-stat--pass">✓ ${variantStats.passed} ${lang === 'zh' ? '通过' : 'passed'}</span>
        <span class="tv-stat tv-stat--fail">✗ ${variantStats.failed} ${lang === 'zh' ? '失败' : 'failed'}</span>
        ${tripwireStat}
        <span class="tv-stat">${lang === 'zh' ? '平均评分' : 'avg score'} ${variantStats.avgScore.toFixed(2)}/5</span>
      </div>
      ${cards}
    </div>`;
  }).join('');

  const variantTabs = variants.map((variant, idx) => `<button type="button" class="tv-vtab ${idx === 0 ? 'tv-vtab--active' : ''}" data-target="${e(variant)}" onclick="omkSwitchVariant(this)">${e(variant)}</button>`).join('');

  return `${fallbackBanner}
    <div class="tv-variant-tabs">${variantTabs}</div>
    ${variantSections}`;
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
    const verdict = sampleVerdict(v.assertions?.details);
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

/** 单测视角的 CSS。挂在 layout 的 inline <style>;用 BEM 风的 tv- 前缀避免和其他 renderer 冲突。 */
export const TEST_VIEW_CSS = `
.tv-variant-tabs { display:flex;gap:4px;margin:12px 0;border-bottom:1px solid var(--border) }
.tv-vtab { padding:8px 16px;background:transparent;border:none;cursor:pointer;color:var(--text-muted);border-bottom:2px solid transparent;font-size:14px }
.tv-vtab--active { color:var(--text-primary);border-bottom-color:var(--accent, #3b82f6);font-weight:600 }
.tv-variant-stats { display:flex;gap:16px;padding:8px 12px;background:var(--bg-surface);border-radius:var(--radius);margin-bottom:12px;font-size:13px }
.tv-stat { color:var(--text-secondary) }
.tv-stat--pass { color:#10b981 }
.tv-stat--fail { color:#ef4444 }
.tv-stat--tripwire { color:#a855f7 }
.tv-card { border:1px solid var(--border);border-radius:var(--radius);margin:8px 0;background:var(--bg-surface) }
.tv-card[open] { background:var(--bg-elevated, var(--bg-surface)) }
.tv-card--pass { border-left:3px solid #10b981 }
.tv-card--fail { border-left:3px solid #ef4444 }
/* 诱错样本(tripwire)— 紫色,与普通失败区分 */
.tv-card--tripwire { border-left:3px solid #a855f7;background:#a855f708 }
.tv-card-h { display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;font-size:14px;list-style:none }
.tv-card-h::-webkit-details-marker { display:none }
.tv-verdict { font-weight:700;font-size:11px;padding:2px 6px;border-radius:3px }
.tv-verdict--pass { background:#10b98120;color:#10b981 }
.tv-verdict--fail { background:#ef444420;color:#ef4444 }
.tv-verdict--tripwire { background:#a855f720;color:#a855f7 }
.tv-sample-id { color:var(--text-muted);font-size:12px }
.tv-card-title { flex:1;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
.tv-card-stats { color:var(--text-muted);font-size:12px;font-family:var(--font-mono, ui-monospace, monospace) }
.tv-card-body { padding:0 12px 12px }
.tv-section { margin-top:12px;padding:10px 12px;background:var(--bg-base, var(--bg-surface));border-radius:var(--radius);border:1px solid var(--border) }
.tv-section-h { font-weight:600;font-size:13px;margin-bottom:8px;color:var(--text-primary) }
.tv-section-stat { color:var(--text-muted);font-weight:400;font-size:12px;margin-left:8px }
/* 诊断区:与 Judge 评价独立(judge 在评分 tab,这里只负责"哪错了 + 怎么改")。
   fail 用红色边 + 浅红底;empty 灰色;pass 用例不渲染此 section。 */
.tv-section--diagnostic { border-left-width:4px }
.tv-diag--fail { border-left-color:#ef4444;background:#ef444408 }
.tv-diag--empty { border-left-color:var(--border);opacity:0.7 }
.tv-diag-summary { font-size:13px;line-height:1.6;color:var(--text-primary);margin:4px 0;font-weight:500 }
.tv-diag-score { background:var(--bg-surface);padding:2px 6px;border-radius:3px;font-size:11px;font-weight:600;color:var(--text-secondary);margin-left:8px;font-family:var(--font-mono, ui-monospace, monospace) }
.tv-diag-cot-body { padding:8px;background:var(--bg-surface);border-radius:3px;color:var(--text-secondary);white-space:pre-wrap;font-size:12px;margin-top:6px;line-height:1.5 }
/* rootCause pill — 5 类不同色 */
.tv-diag-rootcause { display:flex;flex-wrap:wrap;gap:4px;margin:6px 0 }
.tv-diag-rc-pill { font-size:10px;padding:2px 6px;border-radius:3px;font-family:var(--font-mono, ui-monospace, monospace);background:var(--bg-surface);color:var(--text-secondary);border:1px solid var(--border) }
.tv-diag-rc--skill_doc_unclear, .tv-diag-rc--skill_doc_missing, .tv-diag-rc--llm_misread { background:#f59e0b15;color:#f59e0b;border-color:#f59e0b40 }
.tv-diag-rc--sample_design { background:#3b82f615;color:#3b82f6;border-color:#3b82f640 }
.tv-diag-rc--tripwire_intentional { background:#a855f715;color:#a855f7;border-color:#a855f740 }
/* 诱错横幅:卡片顶部解释"这是设计性失败" */
.tv-tripwire-banner { margin-bottom:12px;padding:10px 12px;background:#a855f710;border:1px solid #a855f740;border-left:4px solid #a855f7;border-radius:var(--radius);font-size:13px;line-height:1.6 }
.tv-tripwire-banner strong { color:#a855f7;display:block;margin-bottom:4px }
.tv-tripwire-banner-body { color:var(--text-secondary) }
/* 期望 vs 实际 — 并列两行 */
.tv-diag-ea { margin-top:8px;padding:8px;background:var(--bg-surface);border-radius:3px;font-size:12px;line-height:1.5 }
.tv-diag-ea-row { margin:2px 0;color:var(--text-secondary) }
.tv-diag-ea-row strong { color:var(--text-primary);margin-right:4px }
/* 建议 — 三类(skill / sample / none)tag + 文本 */
.tv-diag-sugg { margin-top:8px;padding:8px;background:var(--bg-surface);border-radius:3px }
.tv-diag-sugg-h { font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:6px }
.tv-diag-sugg-row { font-size:12px;line-height:1.6;color:var(--text-secondary);margin:4px 0 }
.tv-diag-sugg-tag { font-size:10px;padding:2px 6px;border-radius:3px;font-family:var(--font-mono, ui-monospace, monospace);margin-right:6px;font-weight:600 }
.tv-diag-sugg-tag--skill { background:#f59e0b20;color:#f59e0b }
.tv-diag-sugg-tag--sample { background:#3b82f620;color:#3b82f6 }
.tv-diag-sugg-tag--none { background:#6b728020;color:#6b7280 }
.tv-prompt, .tv-rubric { font-size:13px;line-height:1.5;margin:6px 0 }
.tv-prompt strong, .tv-rubric strong { color:var(--text-primary);margin-right:6px }
.tv-meta-pills { margin:8px 0;display:flex;flex-wrap:wrap;gap:6px }
.tv-meta-pill { font-size:11px;padding:2px 6px;background:var(--bg-surface);border:1px solid var(--border);border-radius:3px;color:var(--text-secondary);font-family:var(--font-mono, ui-monospace, monospace) }
.tv-expected { margin-top:8px }
.tv-expected-h { font-size:12px;color:var(--text-muted);margin-bottom:4px }
.tv-expect-line { font-size:12px;font-family:var(--font-mono, ui-monospace, monospace);color:var(--text-secondary);padding:2px 0 }
.tv-collapsible { margin-top:8px;font-size:12px }
.tv-collapsible summary { cursor:pointer;color:var(--text-muted) }
.tv-mocks { margin-top:6px }
.tv-mock-line { font-size:11px;font-family:var(--font-mono, ui-monospace, monospace);padding:2px 0;display:flex;flex-wrap:wrap;gap:4px;align-items:center }
.tv-mock-idx { color:var(--text-muted);font-weight:600 }
.tv-mock-tool { background:var(--bg-surface);padding:1px 4px;border-radius:2px }
.tv-mock-match { color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;max-width:300px;white-space:nowrap }
.tv-mock-arrow { color:var(--text-muted) }
.tv-mock-return { color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;max-width:300px;white-space:nowrap }
.tv-turn { margin:6px 0;padding:6px 8px;background:var(--bg-surface);border-radius:var(--radius);border-left:2px solid var(--border) }
.tv-turn-h { font-size:12px;font-weight:600;color:var(--text-primary) }
.tv-turn-dur { color:var(--text-muted);font-weight:400;font-size:11px;margin-left:6px }
.tv-thinking { margin:4px 0;font-size:12px }
.tv-thinking summary { cursor:pointer;color:var(--text-muted);font-style:italic }
.tv-thinking-body { padding:6px 8px;background:var(--bg-base, var(--bg-surface));border-radius:3px;color:var(--text-secondary);white-space:pre-wrap;font-size:12px;margin-top:4px }
.tv-call { margin:4px 0;padding:6px 8px;background:var(--bg-base, var(--bg-surface));border-radius:3px;font-size:12px }
.tv-call--err { border-left:2px solid #ef4444 }
.tv-call-h { font-weight:600;color:var(--text-primary);margin-bottom:4px }
.tv-call details { margin:2px 0;font-size:11px }
.tv-call summary { cursor:pointer;color:var(--text-muted);padding:2px 0 }
.tv-pre { font-family:var(--font-mono, ui-monospace, monospace);font-size:11px;background:var(--bg-surface);padding:6px 8px;border-radius:3px;overflow:auto;max-height:300px;white-space:pre-wrap;margin:2px 0 }
.tv-mock-badge { font-size:11px;color:#10b981;background:#10b98115;padding:1px 4px;border-radius:2px;margin-left:6px }
.tv-trace-assert { font-size:11px;font-family:var(--font-mono, ui-monospace, monospace);padding:2px 0;margin-top:4px }
.tv-trace-assert.tv-assert--fail { color:#ef4444 }
.tv-trace-assert.tv-assert--pass { color:#10b981 }
.tv-assert { font-size:12px;font-family:var(--font-mono, ui-monospace, monospace);padding:3px 0 }
.tv-assert--pass { color:var(--text-secondary) }
.tv-assert--fail { color:#ef4444 }
.tv-assert-value { background:var(--bg-surface);padding:1px 4px;border-radius:2px;margin:0 2px }
.tv-turn-tag { font-size:10px;color:var(--text-muted);margin-left:6px;font-style:italic }
.tv-turn-tag--ok { color:#10b981 }
.tv-turn-tag--miss { color:#ef4444 }
.tv-assert-msg { font-size:11px;color:var(--text-muted);margin-left:18px;margin-top:2px }
.tv-empty, .tv-empty-page { color:var(--text-muted);font-style:italic;padding:8px;font-size:13px }
.tv-warn { color:#f59e0b;background:#f59e0b15;padding:8px 12px;border-radius:var(--radius);margin:8px 0;font-size:12px }
.tv-final { margin-top:8px }
.tv-final-h { font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px }
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
