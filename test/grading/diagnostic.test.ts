/**
 * Diagnostic 诊断模块单测。重点:
 *   - prompt 含 skill 内容 / rubric / 期望 assertions / 实际 trace / failed details
 *   - tripwire sample 触发特殊提示(让 LLM 选 tripwire_intentional 不要乱建议改 skill)
 *   - JSON 解析失败的降级
 *   - rootCause 非法值过滤
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildDiagnosticPrompt,
  resolveDiagnosticTarget,
  runDiagnostic,
  salvagePartialJson,
} from '../../src/grading/diagnostic.js';
import type { Sample } from '../../src/types/eval.js';
import type { ToolCallInfo } from '../../src/types/executor.js';
import type { AssertionDetail } from '../../src/types/judge.js';
import type { ExecutorFn } from '../../src/types/index.js';

describe('resolveDiagnosticTarget', () => {
  it('跟随首位 judge，不对 Claude 做隐藏优先级', () => {
    assert.deepEqual(resolveDiagnosticTarget([
      { executor: 'codex', model: 'gpt-5' },
      { executor: 'claude', model: 'haiku' },
    ], 'openai-api', 'gpt-main'), {
      executor: 'codex',
      model: 'gpt-5',
    });
  });

  it('没有 judge 配置时跟随主执行器', () => {
    assert.deepEqual(resolveDiagnosticTarget([], 'openai-api', 'gpt-main'), {
      executor: 'openai-api',
      model: 'gpt-main',
    });
  });
});

const baseSample = (overrides: Partial<Sample> = {}): Sample => ({
  sample_id: 's1',
  prompt: '帮我做 X',
  rubric: '应该先做 A,再做 B',
  assertions: [
    { type: 'tool_input_contains', value: 'Bash:tag-list', weight: 1 },
    { type: 'mock_hit', value: 'Bash:1', weight: 0.5 },
  ],
  ...overrides,
});

const baseDetails: AssertionDetail[] = [
  { type: 'tool_input_contains', value: 'Bash:tag-list', weight: 1, passed: false },
  { type: 'mock_hit', value: 'Bash:1', weight: 0.5, passed: false },
];

const baseToolCalls: ToolCallInfo[] = [
  { tool: 'Bash', input: { command: 'echo wrong' }, output: 'wrong', success: true },
];

describe('buildDiagnosticPrompt', () => {
  it('includes prompt + rubric + assertions + skill content + trace + failed details', () => {
    const sample = baseSample();
    const skillContent = '# Skill\n## 调用方式\n先用 tag-list ...';
    const prompt = buildDiagnosticPrompt({
      sample,
      skillContent,
      skillName: 'my-skill',
      toolCalls: baseToolCalls,
      turns: undefined,
      fullOutput: 'final answer',
      assertionDetails: baseDetails,
      executor: (() => Promise.reject(new Error('not invoked'))) as ExecutorFn,
      model: 'haiku',
    });
    assert.ok(prompt.includes('帮我做 X'));                    // sample.prompt
    assert.ok(prompt.includes('应该先做 A,再做 B'));          // rubric
    assert.ok(prompt.includes('tool_input_contains Bash:tag-list')); // expected assertions
    assert.ok(prompt.includes('# Skill'));                      // skill content
    assert.ok(prompt.includes('echo wrong'));                   // actual tool call
    assert.ok(prompt.includes('final answer'));                 // fullOutput
    assert.ok(prompt.includes('mock_hit: Bash:1'));            // failed assertion detail
    assert.ok(prompt.includes('my-skill'));                     // skill name in header
  });

  it('inserts tripwire-specific hint when sample.tripwire=true', () => {
    const prompt = buildDiagnosticPrompt({
      sample: baseSample({ tripwire: true }),
      skillContent: 'skill',
      skillName: 'x',
      toolCalls: baseToolCalls,
      turns: undefined,
      fullOutput: 'output',
      assertionDetails: baseDetails,
      executor: (() => Promise.reject(new Error('x'))) as ExecutorFn,
      model: 'haiku',
    });
    // tripwire=true 时插入 ground-truth 提示,要求 LLM 走 tripwire_intentional 路径
    assert.ok(prompt.includes('sample.tripwire = true'), 'should include tripwire=true ground-truth hint');
    // 5 类 rootCause 列表里也有 tripwire_intentional(任何样本都有)
    assert.ok(prompt.includes('tripwire_intentional'));
  });

  it('inserts non-tripwire explicit hint for normal sample (sample.tripwire=undefined / false)', () => {
    const prompt = buildDiagnosticPrompt({
      sample: baseSample(),
      skillContent: 'skill',
      skillName: 'x',
      toolCalls: baseToolCalls,
      turns: undefined,
      fullOutput: 'output',
      assertionDetails: baseDetails,
      executor: (() => Promise.reject(new Error('x'))) as ExecutorFn,
      model: 'haiku',
    });
    // P3-2:非诱错也显式标 "sample.tripwire = false",禁止 LLM 自己识别诱错
    assert.ok(prompt.includes('sample.tripwire = false'), 'should include explicit non-tripwire ground-truth hint');
    // 不要带 tripwire=true 那段 ground-truth hint
    assert.ok(!prompt.includes('sample.tripwire = true'));
    // 但 rootCause 候选列表里仍可见(那是给所有样本看的全选)
    assert.ok(prompt.includes('tripwire_intentional'));
  });

  it('truncates very long skill content', () => {
    const skill = 'X'.repeat(20000);
    const prompt = buildDiagnosticPrompt({
      sample: baseSample(),
      skillContent: skill,
      skillName: 'x',
      toolCalls: [],
      turns: undefined,
      fullOutput: undefined,
      assertionDetails: baseDetails,
      executor: (() => Promise.reject(new Error('x'))) as ExecutorFn,
      model: 'haiku',
    });
    assert.ok(prompt.includes('skill 内容截断'), 'should hint truncation');
    assert.ok(prompt.length < 30000, 'overall prompt size kept reasonable');
  });
});

describe('runDiagnostic — JSON parse + rootCause filter', () => {
  const mkExecutor = (
    output: string,
    ok = true,
    costReportedByExecutor: boolean | undefined = undefined,
  ): ExecutorFn => () => Promise.resolve({
    ok,
    output,
    durationMs: 10, durationApiMs: 10,
    inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    costUSD: 0.001, stopReason: 'end_turn', numTurns: 1,
    ...(costReportedByExecutor === false ? { costReportedByExecutor: false } : {}),
  });

  it('parses valid JSON and returns structured result', async () => {
    const executor = mkExecutor(JSON.stringify({
      summary: 'failed because LLM skipped step 1',
      expected: 'should call tag-list first',
      actual: 'directly called search',
      rootCause: ['skill_doc_unclear', 'llm_misread'],
      suggestion: { skill: 'add a "must" before tag-list', sample: '', none: '' },
    }));
    const r = await runDiagnostic({
      sample: baseSample(),
      skillContent: null, skillName: 'x',
      toolCalls: [], turns: undefined, fullOutput: undefined,
      assertionDetails: baseDetails,
      executor, model: 'haiku',
    });
    assert.equal(r.ok, true);
    assert.equal(r.summary, 'failed because LLM skipped step 1');
    assert.deepEqual(r.rootCause, ['skill_doc_unclear', 'llm_misread']);
    assert.equal(r.suggestion.skill, 'add a "must" before tag-list');
  });

  it('propagates unreported diagnostic cost from the executor', async () => {
    const executor = mkExecutor(JSON.stringify({
      summary: 's',
      expected: 'e',
      actual: 'a',
      rootCause: [],
      suggestion: { skill: '', sample: '', none: '' },
    }), true, false);
    const result = await runDiagnostic({
      sample: baseSample(),
      skillContent: null,
      skillName: 'x',
      toolCalls: [],
      turns: undefined,
      fullOutput: undefined,
      assertionDetails: baseDetails,
      executor,
      model: 'gpt-test',
    });
    assert.equal(result.costReportedByExecutor, false);
  });

  it('strips invalid rootCause values', async () => {
    const executor = mkExecutor(JSON.stringify({
      summary: 's', expected: 'e', actual: 'a',
      rootCause: ['skill_doc_unclear', 'totally_wrong', 'sample_design'],
      suggestion: { skill: '', sample: '', none: '' },
    }));
    const r = await runDiagnostic({
      sample: baseSample(),
      skillContent: null, skillName: 'x',
      toolCalls: [], turns: undefined, fullOutput: undefined,
      assertionDetails: baseDetails,
      executor, model: 'haiku',
    });
    assert.deepEqual(r.rootCause, ['skill_doc_unclear', 'sample_design']);
  });

  it('falls back gracefully on JSON parse failure', async () => {
    const executor = mkExecutor('not valid json at all');
    const r = await runDiagnostic({
      sample: baseSample(),
      skillContent: null, skillName: 'x',
      toolCalls: [], turns: undefined, fullOutput: undefined,
      assertionDetails: baseDetails,
      executor, model: 'haiku',
    });
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('JSON parse'));
    assert.ok(r.summary.includes('not valid'));  // raw output 兜底当 summary
  });

  it('strips markdown fence wrapping (LLM 偶尔输出代码块)', async () => {
    const executor = mkExecutor('```json\n{"summary":"s","expected":"e","actual":"a","rootCause":[],"suggestion":{"skill":"","sample":"","none":""}}\n```');
    const r = await runDiagnostic({
      sample: baseSample(),
      skillContent: null, skillName: 'x',
      toolCalls: [], turns: undefined, fullOutput: undefined,
      assertionDetails: baseDetails,
      executor, model: 'haiku',
    });
    assert.equal(r.ok, true);
    assert.equal(r.summary, 's');
  });

  it('returns failed result when executor errors', async () => {
    const executor = mkExecutor('', false);
    const r = await runDiagnostic({
      sample: baseSample(),
      skillContent: null, skillName: 'x',
      toolCalls: [], turns: undefined, fullOutput: undefined,
      assertionDetails: baseDetails,
      executor, model: 'haiku',
    });
    assert.equal(r.ok, false);
  });

  it('parses workflowChecks + failureModes when LLM emits them', async () => {
    const executor = mkExecutor(JSON.stringify({
      summary: 's', expected: 'e', actual: 'a',
      workflowChecks: [
        { step: '调 code-host auth status 拿 username', passed: true, evidence: '第 [3] 步成功' },
        { step: '用变量传 namespace,不写死', passed: false, evidence: '第 [4] 步硬编码 testuser001' },
      ],
      failureModes: ['硬编码值', '工作流跳步'],
      rootCause: ['llm_misread'],
      suggestion: { skill: '', sample: '', none: '' },
    }));
    const r = await runDiagnostic({
      sample: baseSample(),
      skillContent: null, skillName: 'x',
      toolCalls: [], turns: undefined, fullOutput: undefined,
      assertionDetails: baseDetails,
      executor, model: 'haiku',
    });
    assert.equal(r.ok, true);
    assert.equal(r.workflowChecks?.length, 2);
    assert.equal(r.workflowChecks?.[0].passed, true);
    assert.equal(r.workflowChecks?.[1].passed, false);
    assert.ok(r.workflowChecks?.[1].step.includes('namespace'));
    assert.deepEqual(r.failureModes, ['硬编码值', '工作流跳步']);
  });

  it('filters out invalid failureMode values + dedupes', async () => {
    const executor = mkExecutor(JSON.stringify({
      summary: 's', expected: 'e', actual: 'a',
      workflowChecks: [],
      failureModes: ['硬编码值', 'workflow-skip', '硬编码值', '幻觉输出', '不在枚举里'],
      rootCause: [],
      suggestion: { skill: '', sample: '', none: '' },
    }));
    const r = await runDiagnostic({
      sample: baseSample(),
      skillContent: null, skillName: 'x',
      toolCalls: [], turns: undefined, fullOutput: undefined,
      assertionDetails: baseDetails,
      executor, model: 'haiku',
    });
    assert.deepEqual(r.failureModes, ['硬编码值', '幻觉输出']);
  });

  it('drops workflowCheck items without step description', async () => {
    const executor = mkExecutor(JSON.stringify({
      summary: 's', expected: 'e', actual: 'a',
      workflowChecks: [
        { step: 'OK 一步', passed: true, evidence: '' },
        { step: '', passed: false, evidence: 'step 字段空,丢' },
        { passed: true, evidence: '没 step 字段' },
      ],
      failureModes: [],
      rootCause: [],
      suggestion: { skill: '', sample: '', none: '' },
    }));
    const r = await runDiagnostic({
      sample: baseSample(),
      skillContent: null, skillName: 'x',
      toolCalls: [], turns: undefined, fullOutput: undefined,
      assertionDetails: baseDetails,
      executor, model: 'haiku',
    });
    assert.equal(r.workflowChecks?.length, 1);
    assert.equal(r.workflowChecks?.[0].step, 'OK 一步');
  });

  it('salvages partial fields when JSON gets truncated mid-string (max_tokens hit)', async () => {
    // 真实 case:LLM 写 actual 字段时被截断,引号没闭合,JSON.parse 整条挂掉。
    // 期待:salvage 至少把 summary / expected 露出来,actual 也保留截断点之前的内容。
    const truncated = `\`\`\`json
{
  "summary": "LLM 把推荐脚本误读成黑箱操作",
  "expected": "应先调 code-host pr list 收集评审人",
  "actual": "LLM 跳过了 code-host pr list,直接运行 create_pr_safely.sh 且`;
    const executor = mkExecutor(truncated);
    const r = await runDiagnostic({
      sample: baseSample(),
      skillContent: null, skillName: 'x',
      toolCalls: [], turns: undefined, fullOutput: undefined,
      assertionDetails: baseDetails,
      executor, model: 'haiku',
    });
    assert.equal(r.ok, true, 'should salvage and return ok=true');
    assert.ok(r.error?.startsWith('partial:'), `error should mark partial: ${r.error}`);
    assert.ok(r.summary.includes('黑箱'), `summary salvaged: ${r.summary}`);
    assert.ok(r.expected.includes('code-host pr list'), `expected salvaged: ${r.expected}`);
    assert.ok(r.actual.includes('create_pr_safely.sh'), `actual salvaged (truncated tail): ${r.actual}`);
  });

  it('falls back to raw-as-summary when salvage finds no fields', async () => {
    // Salvage 也救不了的场景(完全不像 JSON):走老的 ok=false 路径。
    const executor = mkExecutor('garbage no field markers at all');
    const r = await runDiagnostic({
      sample: baseSample(),
      skillContent: null, skillName: 'x',
      toolCalls: [], turns: undefined, fullOutput: undefined,
      assertionDetails: baseDetails,
      executor, model: 'haiku',
    });
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('JSON parse'));
  });
});

describe('salvagePartialJson', () => {
  it('extracts top-level string fields with closed quotes', () => {
    const blob = '{"summary": "s1", "expected": "e1", "actual": "a1"}';
    const r = salvagePartialJson(blob);
    assert.equal(r.summary, 's1');
    assert.equal(r.expected, 'e1');
    assert.equal(r.actual, 'a1');
  });

  it('extracts unterminated final string up to EOF', () => {
    const blob = '{"summary": "ok", "actual": "halfway through and';
    const r = salvagePartialJson(blob);
    assert.equal(r.summary, 'ok');
    assert.equal(r.actual, 'halfway through and');
  });

  it('handles escaped quotes/backslashes inside strings', () => {
    const blob = '{"summary": "with \\"quote\\" inside", "actual": "path\\\\to"}';
    const r = salvagePartialJson(blob);
    assert.equal(r.summary, 'with "quote" inside');
    assert.equal(r.actual, 'path\\to');
  });

  it('extracts rootCause array elements that are valid enum values', () => {
    const blob = '{"rootCause": ["skill_doc_unclear", "garbage", "llm_misread"]}';
    const r = salvagePartialJson(blob);
    assert.deepEqual(r.rootCause, ['skill_doc_unclear', 'llm_misread']);
  });

  it('extracts suggestion subfields', () => {
    const blob = '{"suggestion": {"skill": "改第三节", "sample": "", "none": ""}}';
    const r = salvagePartialJson(blob);
    assert.deepEqual(r.suggestion, { skill: '改第三节', sample: '', none: '' });
  });

  it('returns undefined fields when keys are absent', () => {
    const blob = '{"unrelated": "noise"}';
    const r = salvagePartialJson(blob);
    assert.equal(r.summary, undefined);
    assert.equal(r.rootCause, undefined);
    assert.equal(r.suggestion, undefined);
  });

  it('extracts complete workflowChecks array', () => {
    const blob = `{"workflowChecks": [
      {"step": "第一步", "passed": true, "evidence": "[1] 成功"},
      {"step": "第二步", "passed": false, "evidence": "[2] 漏调"}
    ]}`;
    const r = salvagePartialJson(blob);
    assert.equal(r.workflowChecks?.length, 2);
    assert.equal(r.workflowChecks?.[0].step, '第一步');
    assert.equal(r.workflowChecks?.[0].passed, true);
    assert.equal(r.workflowChecks?.[1].passed, false);
  });

  it('keeps complete workflowChecks when last one is truncated mid-object', () => {
    // 写到第二个对象中间被截断,第一个完整的应该保留
    const blob = `{"workflowChecks": [
      {"step": "完整一步", "passed": true, "evidence": "[1] OK"},
      {"step": "第二步被截断到这里",`;
    const r = salvagePartialJson(blob);
    assert.equal(r.workflowChecks?.length, 1);
    assert.equal(r.workflowChecks?.[0].step, '完整一步');
  });

  it('extracts failureModes filtering out non-enum values', () => {
    const blob = '{"failureModes": ["工作流跳步", "wrong-en", "幻觉输出"]}';
    const r = salvagePartialJson(blob);
    assert.deepEqual(r.failureModes, ['工作流跳步', '幻觉输出']);
  });
});
