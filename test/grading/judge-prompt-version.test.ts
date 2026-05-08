import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildJudgePrompt, getJudgePromptHash } from '../../src/grading/judge.js';

describe('judge prompt versioning', () => {
  it('default builds the v4-cot-len-args prompt', () => {
    const text = buildJudgePrompt('p', 'r', 'o', null);
    assert.match(text, /v4-cot-len-args/);
    assert.match(text, /长度不是质量信号/);
  });

  it('lengthDebias=false builds the v3-cot-toolargs prompt without the debias section', () => {
    const text = buildJudgePrompt('p', 'r', 'o', null, false);
    assert.match(text, /v3-cot-toolargs/);
    assert.doesNotMatch(text, /长度不是质量信号/);
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
