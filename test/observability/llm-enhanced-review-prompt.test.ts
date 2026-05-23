import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { readPromptDocument } from '../../src/shared/llm-prompts/index.js';
import { PROMPTS_DIR } from '../../src/observability/soft-standards.js';

// 历史 hash 锚点。llm-enhanced-review 的 runtimeAssessment 会影响 observe
// 对 goal satisfaction / behavior fit / artifact match / user feeling 的最终判定。
// 任何 prompt 字节级变化(含空白、schema、version 文本)都会让跨版本运行复盘不可比。
// 若确实要改,PR 标题 / description 必须明确标 BREAKING-COMPARABILITY。
const FROZEN_LLM_ENHANCED_REVIEW_PROMPT_HASH = '5c5c8e5bf0af8fce3ebf22d2363ca863cdb430dafd087bec19e170517cfa0b83';

describe('LLM enhanced review prompt hash byte-level freeze', () => {
  it('v2026-05-22.v7 hash matches the frozen value', () => {
    const prompt = readPromptDocument({
      dir: PROMPTS_DIR,
      fileName: 'llm-enhanced-review.prompt.md',
      id: 'llm-enhanced-review',
      version: '2026-05-22.v7',
    });

    assert.equal(
      prompt.hash,
      FROZEN_LLM_ENHANCED_REVIEW_PROMPT_HASH,
      '动了 llm-enhanced-review prompt 会让历史 runtimeAssessment / ownerSuggestions 不可比;' +
        '若确需 bump,先改 SOFT_STANDARD_PROMPT_VERSION 字符串(并新增冻结值),' +
        'PR 标题 / description 明确标 BREAKING-COMPARABILITY,再来更新此测试',
    );
  });

  it('loads prompt regardless of process.cwd() (npm-installed portability)', () => {
    // npm install -g omk 后,用户 cwd 是自己项目目录,不是 omk 包目录。
    // PROMPTS_DIR 用 import.meta.url 锁定 src/observability/prompts/ sibling 路径,
    // 不能 fallback 到 process.cwd()。这条测试模拟用户场景,锁住 portability。
    const original = process.cwd();
    try {
      process.chdir(tmpdir());
      const prompt = readPromptDocument({
        dir: PROMPTS_DIR,
        fileName: 'llm-enhanced-review.prompt.md',
        id: 'llm-enhanced-review',
        version: '2026-05-22.v7',
      });
      assert.equal(
        prompt.hash,
        FROZEN_LLM_ENHANCED_REVIEW_PROMPT_HASH,
        'prompt 必须能从任意 cwd 加载(否则 npm 用户跑 --llm-enhanced-review 必挂)',
      );
    } finally {
      process.chdir(original);
    }
  });
});
