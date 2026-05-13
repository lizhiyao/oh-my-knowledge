/**
 * --effort flag (eval) 的解析单测。
 *
 * 验证:
 *   - 默认值 'low'(parseRunConfig 兜底)
 *   - 显式 --effort medium / high / xhigh / max 透传
 *   - 非法值 throw,且 message 含 valid set
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseRunConfig } from '../../src/cli/parse-run-config.js';

const BASE_ARGV = [
  '--skill-dir', 'examples/code-review/skills',
  '--control', 'baseline',
  '--treatment', 'v1',
  '--dry-run',
];

describe('--effort flag', () => {
  it('defaults to "low" when not specified', () => {
    const { config } = parseRunConfig(BASE_ARGV);
    assert.equal(config.effort, 'low');
  });

  it('accepts explicit --effort high', () => {
    const { config } = parseRunConfig([...BASE_ARGV, '--effort', 'high']);
    assert.equal(config.effort, 'high');
  });

  it('accepts all 5 effort levels', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const { config } = parseRunConfig([...BASE_ARGV, '--effort', level]);
      assert.equal(config.effort, level);
    }
  });

  it('throws on invalid effort value with helpful message', () => {
    assert.throws(
      () => parseRunConfig([...BASE_ARGV, '--effort', 'turbo']),
      /must be one of low\/medium\/high\/xhigh\/max.*turbo/,
    );
  });
});
