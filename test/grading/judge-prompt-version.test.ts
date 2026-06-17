import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildJudgePrompt, getJudgePromptHash } from '../../src/grading/judge.js';

describe('judge prompt versioning', () => {
  it('default builds the v5-cot-toolargs-fmt-len prompt', () => {
    const text = buildJudgePrompt('p', 'r', 'o', null);
    assert.match(text, /v5-cot-toolargs-fmt-len/);
    assert.match(text, /长度不是质量信号/);
    assert.match(text, /排版与语气不是质量信号/);
  });

  it('lengthDebias=false builds the v5-cot-toolargs-fmt prompt without the length-debias section', () => {
    const text = buildJudgePrompt('p', 'r', 'o', null, false);
    // 全角 `）` 紧跟 fmt,确保是 off 版本而非 -len 变体(后者是 fmt 的超串)。
    assert.match(text, /template v5-cot-toolargs-fmt）/);
    assert.doesNotMatch(text, /长度不是质量信号/);
    // 排版 / 语气中性化始终开启,即使 length-debias 关掉也在。
    assert.match(text, /排版与语气不是质量信号/);
  });

  it('hashes differ between debias on / off', () => {
    const on = getJudgePromptHash(true);
    const off = getJudgePromptHash(false);
    assert.notEqual(on, off, `debias on/off hashes should differ (on=${on}, off=${off})`);
  });

  it('hash is deterministic across calls for the same setting', () => {
    assert.equal(getJudgePromptHash(true), getJudgePromptHash(true));
    assert.equal(getJudgePromptHash(false), getJudgePromptHash(false));
  });

  it('hash is 12 hex chars', () => {
    assert.match(getJudgePromptHash(true), /^[0-9a-f]{12}$/);
    assert.match(getJudgePromptHash(false), /^[0-9a-f]{12}$/);
  });

  it('trace summary section is independent of debias section (both can be present)', () => {
    const text = buildJudgePrompt('p', 'r', 'o', 'trace info here', true);
    assert.match(text, /## Agent 执行过程/);
    assert.match(text, /trace info here/);
    assert.match(text, /长度不是质量信号/);
  });
});
