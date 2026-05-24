import { describe, it, expect } from 'vitest';
import { isSemverGt } from '../../src/cli/lib/update-check.js';

describe('isSemverGt', () => {
  it('正确比较 major / minor / patch', () => {
    expect(isSemverGt('1.0.0', '0.99.99')).toBe(true);
    expect(isSemverGt('0.32.0', '0.31.9')).toBe(true);
    expect(isSemverGt('0.31.1', '0.31.0')).toBe(true);
    expect(isSemverGt('0.31.0', '0.31.0')).toBe(false);
    expect(isSemverGt('0.31.0', '0.32.0')).toBe(false);
    expect(isSemverGt('0.31.0', '1.0.0')).toBe(false);
  });

  it('release > prerelease(同 MAJOR.MINOR.PATCH)', () => {
    expect(isSemverGt('0.32.0', '0.32.0-rc.1')).toBe(true);
    expect(isSemverGt('0.32.0-rc.1', '0.32.0')).toBe(false);
  });

  it('prerelease 之间数字段按数字比较', () => {
    expect(isSemverGt('0.32.0-rc.2', '0.32.0-rc.1')).toBe(true);
    expect(isSemverGt('0.32.0-rc.10', '0.32.0-rc.2')).toBe(true);
    expect(isSemverGt('0.32.0-rc.2', '0.32.0-rc.10')).toBe(false);
  });

  it('regression: 本地 dev rc 高于 registry 时不应判 registry > 本地', () => {
    // 这是 #149 暴露的「本地 0.32.0-rc 跑出来看到 registry 0.31.0 提示降级」场景
    expect(isSemverGt('0.31.0', '0.32.0-rc.1')).toBe(false);
    expect(isSemverGt('0.31.0', '0.32.0')).toBe(false);
  });

  it('容忍 v 前缀', () => {
    expect(isSemverGt('v1.0.0', '0.99.0')).toBe(true);
    expect(isSemverGt('1.0.0', 'v0.99.0')).toBe(true);
  });

  it('忽略 build metadata(+xxx)', () => {
    expect(isSemverGt('1.0.0+build.1', '1.0.0')).toBe(false);
    expect(isSemverGt('1.0.0', '1.0.0+build.1')).toBe(false);
  });

  it('非法字符串 fail-safe 返回 false', () => {
    expect(isSemverGt('', '1.0.0')).toBe(false);
    expect(isSemverGt('1.0.0', '')).toBe(false);
    expect(isSemverGt('not-a-version', '1.0.0')).toBe(false);
    expect(isSemverGt('1.0.0', 'not-a-version')).toBe(false);
  });
});
