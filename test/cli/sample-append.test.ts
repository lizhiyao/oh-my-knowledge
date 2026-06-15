import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mergeAppendSamples } from '../../src/cli/commands/sample.js';
import type { Sample } from '../../src/types/eval.js';

const s = (id: string, prompt = 'p'): Sample => ({ sample_id: id, prompt }) as Sample;
const ids = (arr: Sample[]): string[] => arr.map((x) => x.sample_id);

describe('mergeAppendSamples (--append 合并 + id 去重)', () => {
  it('无冲突:已有 + 新用例顺序拼接,id 不变', () => {
    const merged = mergeAppendSamples([s('a'), s('b')], [s('c'), s('d')]);
    assert.deepEqual(ids(merged), ['a', 'b', 'c', 'd']);
  });

  it('撞 id:已有原样保留,新用例改名加 -2 后缀', () => {
    const merged = mergeAppendSamples([s('s001'), s('s002')], [s('s001'), s('s003')]);
    assert.deepEqual(ids(merged), ['s001', 's002', 's001-2', 's003']);
  });

  it('同批多条撞同一 id:依次 -2 / -3', () => {
    const merged = mergeAppendSamples([s('s001')], [s('s001'), s('s001')]);
    assert.deepEqual(ids(merged), ['s001', 's001-2', 's001-3']);
  });

  it('已有已含 -2 后缀:新用例跳到 -3,不二次相撞', () => {
    const merged = mergeAppendSamples([s('s001'), s('s001-2')], [s('s001')]);
    assert.deepEqual(ids(merged), ['s001', 's001-2', 's001-3']);
  });

  it('改名时保留其它字段,只换 sample_id', () => {
    const merged = mergeAppendSamples([s('x', 'old')], [s('x', 'new-prompt')]);
    assert.equal(merged.length, 2);
    assert.equal(merged[1].sample_id, 'x-2');
    assert.equal(merged[1].prompt, 'new-prompt');
  });

  it('已有为空:新用例原样返回', () => {
    const merged = mergeAppendSamples([], [s('a'), s('b')]);
    assert.deepEqual(ids(merged), ['a', 'b']);
  });
});
