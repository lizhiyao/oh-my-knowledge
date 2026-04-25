import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildJudgePrompt, getJudgePromptHash } from '../../src/grading/judge.js';

describe('judge prompt versioning (Phase 3a)', () => {
  it('default builds the v3-cot-length prompt', () => {
    const text = buildJudgePrompt('p', 'r', 'o', null);
    assert.match(text, /v3-cot-length/);
    assert.match(text, /长度不是质量信号/);
  });

  it('lengthDebias=false builds the legacy v2-cot prompt without the debias section', () => {
    const text = buildJudgePrompt('p', 'r', 'o', null, false);
    assert.match(text, /v2-cot/);
    assert.doesNotMatch(text, /长度不是质量信号/);
  });

  it('hashes differ between v2 and v3', () => {
    const v3 = getJudgePromptHash(true);
    const v2 = getJudgePromptHash(false);
    assert.notEqual(v3, v2, `v2 and v3 hashes should differ (v3=${v3}, v2=${v2})`);
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
