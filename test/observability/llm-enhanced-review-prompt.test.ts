import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readPromptDocument } from '../../src/shared/llm-prompts/index.js';

// 历史 hash 锚点。llm-enhanced-review 的 runtimeAssessment 会影响 observe
// 对 goal satisfaction / behavior fit / artifact match / user feeling 的最终判定。
// 任何 prompt 字节级变化(含空白、schema、version 文本)都会让跨版本运行复盘不可比。
// 若确实要改,PR 标题 / description 必须明确标 BREAKING-COMPARABILITY。
const FROZEN_LLM_ENHANCED_REVIEW_PROMPT_HASH = '92507c68e78891758f92c577246e4baee07317819cc857320d5e3be35fd60213';

describe('LLM enhanced review prompt hash byte-level freeze', () => {
  it('v2026-05-18.v1 hash matches the frozen value', () => {
    const prompt = readPromptDocument({
      fileName: 'llm-enhanced-review.prompt.md',
      id: 'llm-enhanced-review',
      version: '2026-05-18.v1',
    });

    assert.equal(
      prompt.hash,
      FROZEN_LLM_ENHANCED_REVIEW_PROMPT_HASH,
      '动了 llm-enhanced-review prompt 会让历史 runtimeAssessment / ownerSuggestions 不可比;' +
        '若确需 bump,先改 SOFT_STANDARD_PROMPT_VERSION 字符串(并新增冻结值),' +
        'PR 标题 / description 明确标 BREAKING-COMPARABILITY,再来更新此测试',
    );
  });
});
