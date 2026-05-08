/**
 * Diagnostic 诊断模块单测。重点:
 *   - prompt 含 skill 内容 / rubric / 期望 assertions / 实际 trace / failed details
 *   - tripwire sample 触发特殊提示(让 LLM 选 tripwire_intentional 不要乱建议改 skill)
 *   - JSON 解析失败的降级
 *   - rootCause 非法值过滤
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildDiagnosticPrompt, runDiagnostic } from '../../src/grading/diagnostic.js';
import type { Sample } from '../../src/types/eval.js';
import type { ToolCallInfo } from '../../src/types/executor.js';
import type { AssertionDetail } from '../../src/types/judge.js';
import type { ExecutorFn } from '../../src/types/index.js';

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
    // 顶部专用 hint 段(强调"此 sample 标记为诱错样本")
    assert.ok(prompt.includes('此 sample 标记为诱错样本'), 'should include tripwire-specific top hint');
    // 5 类 rootCause 列表里也有 tripwire_intentional(任何样本都有)
    assert.ok(prompt.includes('tripwire_intentional'));
  });

  it('does NOT insert tripwire-specific top hint for normal sample', () => {
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
    // 顶部专用 hint 不该出现(避免误导 LLM 把普通 sample 当诱错样本处理)
    assert.ok(!prompt.includes('此 sample 标记为诱错样本'));
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
  const mkExecutor = (output: string, ok = true): ExecutorFn => () => Promise.resolve({
    ok,
    output,
    durationMs: 10, durationApiMs: 10,
    inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    costUSD: 0.001, stopReason: 'end_turn', numTurns: 1,
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
});
