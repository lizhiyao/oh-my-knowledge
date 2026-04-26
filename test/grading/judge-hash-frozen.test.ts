import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { getJudgePromptHash } from '../../src/grading/judge.js';

// 历史 hash 锚点。v0.20.0 之后任何动 buildJudgePrompt 模板字节(包括标点 / 空白
// / version 字符串)都会让这两个值变,从而让历史报告不可比。除非显式想 bump
// JUDGE_PROMPT_VERSION_DEBIAS_OFF/ON,否则这两条断言必须永远通过。
const FROZEN_HASH_DEBIAS_OFF = 'fdc81b19c721'; // v2-cot
const FROZEN_HASH_DEBIAS_ON = '629bf3b8c41d';  // v3-cot-length

describe('judge prompt hash byte-level freeze', () => {
  it('v2-cot (debias=false) hash matches the frozen value', () => {
    assert.equal(
      getJudgePromptHash(false),
      FROZEN_HASH_DEBIAS_OFF,
      '动了 buildJudgePrompt 模板会让历史 v2-cot 报告不可比;若确需 bump,先改 ' +
        'JUDGE_PROMPT_VERSION_DEBIAS_OFF 字符串(并新增冻结值),再来更新此测试',
    );
  });

  it('v3-cot-length (debias=true) hash matches the frozen value', () => {
    assert.equal(
      getJudgePromptHash(true),
      FROZEN_HASH_DEBIAS_ON,
      '动了 buildJudgePrompt 模板或 LENGTH_DEBIAS_INSTRUCTION 会让历史 v3-cot-length ' +
        '报告不可比;若确需 bump,先改 JUDGE_PROMPT_VERSION_DEBIAS_ON 字符串(并新增 ' +
        '冻结值),再来更新此测试',
    );
  });
});
