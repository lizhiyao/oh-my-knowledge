/**
 * 跨域展示口径（绝对时间、百分比、时长）锁在唯一 owner 上。
 *
 * 这三件事原先在 application 与 web 两侧各有一份写法——整数／一位小数／全角百分号并存，
 * `slice(0,19)`／`slice(0,16)`／直出 ISO 并存，四种耗时格式并存——同一取值因此在列表与详情
 * 读成两个数。这里锁口径本身，页面上渲染出什么由 `test/studio/web` 下的用例负责。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  displayTime,
  formatDuration,
  formatPercent,
  formatPercentDelta,
} from '../../../src/studio/application/display/format.js';

describe('绝对时间', () => {
  it('按显式精度交出读数，缺值统一占位', () => {
    assert.equal(displayTime('2026-09-15T08:30:00Z'), '2026-09-15 08:30:00 UTC');
    assert.equal(displayTime('2026-09-15T08:30:00Z', 'minute'), '2026-09-15 08:30 UTC');
    assert.equal(displayTime('2026-09-15T08:30:00Z', 'day'), '2026-09-15');
    assert.equal(displayTime('2026-09-15T08:30:00Z', 'clock'), '08:30:00');
    assert.equal(displayTime(undefined), '—');
    assert.equal(displayTime(''), '—');
  });

  it('外部偏移原样保留，不标成 UTC，也不按服务器时区重算', () => {
    assert.equal(displayTime('2026-09-15T08:30:00+08:00', 'minute'), '2026-09-15 08:30+08:00');
    assert.equal(displayTime('2026-09-15T08:30:00.123Z'), '2026-09-15 08:30:00 UTC');
    assert.equal(displayTime('2026-09-15 08:30:00'), '2026-09-15 08:30:00');
    // 不是时间戳的值（人工登记的文本）不丢掉，只把 `T` 换成空格。
    assert.equal(displayTime('running'), 'running');
  });
});

describe('百分比', () => {
  it('最多一位小数，整数不补 .0，百分号一律半角', () => {
    assert.equal(formatPercent(0.4), '40%');
    assert.equal(formatPercent(0.125), '12.5%');
    assert.equal(formatPercent(1), '100%');
    assert.equal(formatPercent(0), '0%');
  });

  it('未测得不给 0%', () => {
    assert.equal(formatPercent(null), '—');
    assert.equal(formatPercent(undefined), '—');
    assert.equal(formatPercent(Number.NaN), '—');
  });

  it('差值正数带 +，0 附近不出现 -0', () => {
    assert.equal(formatPercentDelta(-0.25), '-25%');
    assert.equal(formatPercentDelta(0.6), '+60%');
    assert.equal(formatPercentDelta(0), '0%');
    assert.equal(formatPercentDelta(-0.0001), '0%');
    assert.equal(formatPercentDelta(null), '—');
  });
});

describe('时长', () => {
  it('按量级换单位，缺席按 0 处理', () => {
    for (const [ms, text] of [
      [0, '0ms'], [999, '999ms'], [1000, '1s'], [1500, '1.5s'],
      [60_000, '1m'], [90_000, '1m30s'], [1_800_000, '30m'],
    ] as const) {
      assert.equal(formatDuration(ms), text, `${ms}ms`);
    }
    assert.equal(formatDuration(undefined), '0ms');
    assert.equal(formatDuration(null), '0ms');
  });

  it('秒向分钟进位，不渲染出 "1m60s" 这种不存在的时刻', () => {
    assert.equal(formatDuration(119_999), '2m');
    assert.equal(formatDuration(1_799_999), '30m');
  });

  it('不引入小时档：一小时以上的运行仍以分钟计数，与预算读数同口径', () => {
    assert.equal(formatDuration(3_600_000), '60m');
    assert.equal(formatDuration(5_400_000), '90m');
  });
});
