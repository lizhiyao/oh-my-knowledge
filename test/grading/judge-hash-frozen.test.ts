import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { getJudgePromptHash } from '../../src/grading/judge.js';

// 历史 hash 锚点。任何动 buildJudgePrompt / buildTraceSummary / LENGTH_DEBIAS_INSTRUCTION /
// PRESENTATION_NEUTRALITY_INSTRUCTION 模板字节(含标点 / 空白 / version 字符串)都会让这两个值变,
// 从而让历史报告不可比。除非显式想 bump JUDGE_PROMPT_VERSION_DEBIAS_OFF/ON,否则这两条断言必须永远通过。
//
// 历史值(已 archive,仅留底):
//   v2-cot          : fdc81b19c721
//   v3-cot-length   : 629bf3b8c41d
//   v3-cot-toolargs : 9c441e9b6a73   (off,加 tool input 预览)
//   v4-cot-len-args : bd1d97c86a5f   (on, 加 tool input 预览)
//
// v5-cot-toolargs-fmt / v5-cot-toolargs-fmt-len bump 原因:judge prompt 此前只显式去偏「长度」,
// 未管「排版 / 语气」。研究表明 LLM 评委还隐性偏向排版精致(format / markdown bias)与语气自信、
// 自我表扬的回答(谄媚 / 权威偏置)。本次加始终开启的排版 / 语气中性化指令,并借机把命名统一成
// 单一主序号 v5 + feature 后缀。BREAKING-COMPARABILITY 是诚实而非退路 — 老 hash 对应的评委去偏更弱。
const FROZEN_HASH_DEBIAS_OFF = '74be4a6a2439'; // v5-cot-toolargs-fmt
const FROZEN_HASH_DEBIAS_ON = 'bb393197cd41';  // v5-cot-toolargs-fmt-len

describe('judge prompt hash byte-level freeze', () => {
  it('v5-cot-toolargs-fmt (debias=false) hash matches the frozen value', () => {
    assert.equal(
      getJudgePromptHash(false),
      FROZEN_HASH_DEBIAS_OFF,
      '动了 buildJudgePrompt / buildTraceSummary / PRESENTATION_NEUTRALITY_INSTRUCTION 模板会让历史 ' +
        'v5-cot-toolargs-fmt 报告不可比;若确需 bump,先改 JUDGE_PROMPT_VERSION_DEBIAS_OFF 字符串' +
        '(并新增冻结值),再来更新此测试',
    );
  });

  it('v5-cot-toolargs-fmt-len (debias=true) hash matches the frozen value', () => {
    assert.equal(
      getJudgePromptHash(true),
      FROZEN_HASH_DEBIAS_ON,
      '动了 buildJudgePrompt / buildTraceSummary / LENGTH_DEBIAS_INSTRUCTION / ' +
        'PRESENTATION_NEUTRALITY_INSTRUCTION 会让历史 v5-cot-toolargs-fmt-len 报告不可比;若确需 bump,' +
        '先改 JUDGE_PROMPT_VERSION_DEBIAS_ON 字符串(并新增冻结值),再来更新此测试',
    );
  });
});
