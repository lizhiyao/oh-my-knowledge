import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildJudgePrompt } from '../../src/grading/judge.js';

/**
 * Defensive test (R11 from sample-design plan).
 *
 * Sample design metadata fields (capability / difficulty / construct / provenance /
 * llm-generated / human / production-trace) are PURE DOCUMENTATION — they must NEVER
 * leak into the judge prompt because:
 *  - They'd let evaluator (judge) see "this sample is testing necessity" → bias scoring
 *  - They'd violate construct validity (judge should be blind to test design intent)
 *  - They'd change judge prompt hash, breaking cross-version comparability
 *
 * `buildJudgePrompt(prompt, rubric, output, traceSummary, lengthDebias)` signature does
 * NOT take a Sample object, so structurally these fields can't leak — but a future
 * refactor might add `sample` as a param "for context", and that's where the regression
 * would hit. This test pins the interface: judge prompt output must not contain any
 * sample-metadata token strings.
 */

describe('buildJudgePrompt — sample metadata isolation', () => {
  // Use prompts/rubrics that DELIBERATELY contain "necessity" / "capability" / etc as
  // generic English/Chinese words, to make sure the assertion isn't fragile to that.
  // We assert specific TOKENS (字段名 + enum 值) don't appear, not generic dictionary words.
  const PROMPT_FORBIDDEN_TOKENS = [
    'capability:',          // type field name
    'difficulty:',
    'construct:',
    'provenance:',
    'sampleId:',
    '"capability"',         // JSON-style key (double-quoted)
    '"difficulty"',
    '"construct"',
    '"provenance"',
    "'capability'",         // single-quoted (less common but possible)
    '"llm-generated"',      // unique enum values that wouldn't appear naturally
    '"production-trace"',
  ];

  function assertNoForbiddenTokens(judgePrompt: string): void {
    for (const tok of PROMPT_FORBIDDEN_TOKENS) {
      assert.equal(
        judgePrompt.includes(tok),
        false,
        `judge prompt should NOT contain sample-metadata token "${tok}", but it does`,
      );
    }
  }

  it('default (lengthDebias=true) judge prompt contains no sample-metadata tokens', () => {
    const p = buildJudgePrompt('用户问题', '评分标准', 'AI 回答', null, true);
    assertNoForbiddenTokens(p);
  });

  it('lengthDebias=false (legacy v2-cot path) also clean', () => {
    const p = buildJudgePrompt('用户问题', '评分标准', 'AI 回答', null, false);
    assertNoForbiddenTokens(p);
  });

  it('with traceSummary present, still clean', () => {
    const p = buildJudgePrompt('q', 'r', 'o', '一些工具调用记录', true);
    assertNoForbiddenTokens(p);
  });

  it('even when prompt itself contains the words "capability" or "difficulty", judge prompt does not introduce metadata tokens', () => {
    // 用户的 prompt 里出现 "capability" 是合法的(用户写的题面),judge prompt 不应额外加 metadata 字段名
    const userPrompt = 'Discuss the capability of this system on hard difficulty levels';
    const p = buildJudgePrompt(userPrompt, 'rubric', 'output', null, true);
    // userPrompt 字面会被引入 judge prompt(因为是输入),但 metadata 字段名不应出现
    assert.ok(p.includes('capability'), 'user prompt verbatim should be in judge prompt');
    // 但不应有 "capability:" 这种字段-赋值格式(那是 metadata 字段格式标志)
    assert.ok(!p.includes('capability:'), 'metadata-style "capability:" must not appear');
    assert.ok(!p.includes('"capability"'), 'JSON-style "capability" key must not appear');
  });
});
