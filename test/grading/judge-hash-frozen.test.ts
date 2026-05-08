import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { getJudgePromptHash } from '../../src/grading/judge.js';

// 历史 hash 锚点。v0.20.0 之后任何动 buildJudgePrompt / buildTraceSummary 模板
// 字节(含标点 / 空白 / version 字符串)都会让这两个值变,从而让历史报告不可比。
// 除非显式想 bump JUDGE_PROMPT_VERSION_DEBIAS_OFF/ON,否则这两条断言必须永远通过。
//
// 历史值(已 archive,仅留底):
//   v2-cot          : fdc81b19c721
//   v3-cot-length   : 629bf3b8c41d
//
// v3-cot-toolargs / v4-cot-len-args bump 原因:buildTraceSummary 之前只给判官看
// "工具名 + 分布",wrapper-style skill(mcporter / code-host CLI / git CLI 等)的真实
// 语义调用编码在 Bash 命令字符串里(`Bash: mcporter --tool X`),判官看不到 → 错误
// 结论"只用了 Bash,跳过了指定工具"。本次加 tool input 预览修掉这个事实错误。
// BREAKING-COMPARABILITY 是诚实而非退路 — 老 hash 对应的判官会判错。
const FROZEN_HASH_DEBIAS_OFF = '9c441e9b6a73'; // v3-cot-toolargs
const FROZEN_HASH_DEBIAS_ON = 'bd1d97c86a5f';  // v4-cot-len-args

describe('judge prompt hash byte-level freeze', () => {
  it('v3-cot-toolargs (debias=false) hash matches the frozen value', () => {
    assert.equal(
      getJudgePromptHash(false),
      FROZEN_HASH_DEBIAS_OFF,
      '动了 buildJudgePrompt / buildTraceSummary 模板会让历史 v3-cot-toolargs 报告不可比;' +
        '若确需 bump,先改 JUDGE_PROMPT_VERSION_DEBIAS_OFF 字符串(并新增冻结值),' +
        '再来更新此测试',
    );
  });

  it('v4-cot-len-args (debias=true) hash matches the frozen value', () => {
    assert.equal(
      getJudgePromptHash(true),
      FROZEN_HASH_DEBIAS_ON,
      '动了 buildJudgePrompt / buildTraceSummary / LENGTH_DEBIAS_INSTRUCTION 会让历史 ' +
        'v4-cot-len-args 报告不可比;若确需 bump,先改 JUDGE_PROMPT_VERSION_DEBIAS_ON ' +
        '字符串(并新增冻结值),再来更新此测试',
    );
  });
});
