import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { findSlowTestFiles, parseTop } from '../../scripts/test-profile.js';

describe('test-profile', () => {
  it('默认展示 15 个慢文件，并允许覆盖数量', () => {
    assert.equal(parseTop([]), 15);
    assert.equal(parseTop(['--top', '8']), 8);
    assert.equal(parseTop(['--help']), undefined);
  });

  it('拒绝无效参数', () => {
    assert.throws(() => parseTop(['--top', '0']), /用法/);
    assert.throws(() => parseTop(['--runs', '3']), /用法/);
  });

  it('按单次文件耗时排序并截取慢项', () => {
    const result = findSlowTestFiles({
      success: true,
      testResults: [
        { name: `${process.cwd()}/test/fast.test.ts`, startTime: 100, endTime: 110 },
        { name: `${process.cwd()}/test/slow.test.ts`, startTime: 100, endTime: 150 },
      ],
    }, 1);

    assert.deepEqual(result, [{ file: 'test/slow.test.ts', durationMs: 50 }]);
  });
});
