import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildPowerWarnings } from '../../src/eval-workflows/evaluation-pipeline.js';

describe('buildPowerWarnings', () => {
  it('n < 5: 探索级警告', () => {
    const w = buildPowerWarnings(3, 1);
    assert.equal(w.length, 2);  // n + repeat
    assert.match(w[0], /N=3 < 5/);
    assert.match(w[0], /exploration-only/);
  });

  it('5 ≤ n < 20: 大效应警告', () => {
    const w = buildPowerWarnings(10, 1);
    assert.equal(w.length, 2);
    assert.match(w[0], /N=10 < 20/);
    assert.match(w[0], /large-effect-only/);
  });

  it('n ≥ 20: 不报 n 警告(只剩 repeat=1)', () => {
    const w = buildPowerWarnings(20, 1);
    assert.equal(w.length, 1);
    assert.match(w[0], /--repeat=1/);
  });

  it('repeat=1: 稳定性测不到警告', () => {
    const w = buildPowerWarnings(30, 1);
    assert.equal(w.length, 1);
    assert.match(w[0], /single-run cannot measure stability/);
  });

  it('repeat ≥ 2: 不报 repeat 警告', () => {
    const w = buildPowerWarnings(30, 3);
    assert.equal(w.length, 0);
  });

  it('两条警告同时报(小 n + 单轮)', () => {
    const w = buildPowerWarnings(3, 1);
    assert.equal(w.length, 2);
    assert.match(w[0], /N=3/);
    assert.match(w[1], /--repeat=1/);
  });

  it('完美配置(n=30, repeat=3)无警告', () => {
    const w = buildPowerWarnings(30, 3);
    assert.equal(w.length, 0);
  });

  it('边界:n=4(<5) 触发探索级,n=5(≥5) 触发大效应级', () => {
    assert.match(buildPowerWarnings(4, 3)[0], /< 5/);
    assert.match(buildPowerWarnings(5, 3)[0], /< 20/);
  });

  it('边界:n=19(<20) 触发大效应级,n=20(≥20) 不报 n 警告', () => {
    assert.equal(buildPowerWarnings(19, 3).length, 1);
    assert.equal(buildPowerWarnings(20, 3).length, 0);
  });
});
