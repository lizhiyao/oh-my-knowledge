import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { bootstrapMeanCI, bootstrapDiffCI, bootstrapPairedDiffCI, bootstrapWithMetric, DEFAULT_BOOTSTRAP_SEED } from '../../src/eval-core/bootstrap.js';

describe('bootstrapMeanCI', () => {
  it('CI on a tight sample contains the true mean', () => {
    // True mean is exactly 4. Bootstrap CI must contain it.
    const scores = [3, 4, 5, 4, 3, 5, 4, 4, 3, 5];
    const ci = bootstrapMeanCI(scores, 0.05, 1000, 42);
    assert.ok(ci.low <= 4 && 4 <= ci.high, `CI [${ci.low}, ${ci.high}] should contain 4`);
    assert.equal(ci.estimate, 4);
    assert.equal(ci.samples, 1000);
  });

  it('skewed distribution: bootstrap CI is wider on the longer tail than t-test would assume', () => {
    // Right-skewed: most values low, a few high. Bootstrap should reflect asymmetry.
    const scores = [1, 1, 1, 2, 2, 2, 3, 3, 5, 5];
    const ci = bootstrapMeanCI(scores, 0.05, 2000, 7);
    // Mean is 2.5. Distribution is right-skewed so high tail of CI > 2.5 + (2.5 - low).
    const lowTail = ci.estimate - ci.low;
    const highTail = ci.high - ci.estimate;
    assert.ok(highTail >= lowTail, `right-skewed sample should have right tail >= left tail (got ${lowTail} vs ${highTail})`);
  });

  it('N=2 boundary: CI is well-defined and bracketed by min/max', () => {
    const ci = bootstrapMeanCI([3, 5], 0.05, 500, 1);
    assert.ok(ci.low >= 3 && ci.high <= 5, `CI [${ci.low}, ${ci.high}] must lie in [3, 5]`);
    assert.equal(ci.estimate, 4);
  });

  it('N=1 boundary: returns the single value as both bounds', () => {
    const ci = bootstrapMeanCI([4.5], 0.05, 100, 1);
    assert.equal(ci.low, 4.5);
    assert.equal(ci.high, 4.5);
    assert.equal(ci.estimate, 4.5);
  });

  it('N=0 returns zeros without crashing', () => {
    const ci = bootstrapMeanCI([], 0.05, 100, 1);
    assert.equal(ci.low, 0);
    assert.equal(ci.high, 0);
    assert.equal(ci.estimate, 0);
    assert.equal(ci.samples, 0);
  });

  it('seeded calls are deterministic across runs', () => {
    const scores = [3, 4, 5, 4, 3];
    const a = bootstrapMeanCI(scores, 0.05, 500, 12345);
    const b = bootstrapMeanCI(scores, 0.05, 500, 12345);
    assert.deepEqual(a, b, 'same seed should give identical CI');
  });

  it('未传 seed 也确定:默认退 DEFAULT_BOOTSTRAP_SEED(同一 eval 两跑 CI 相同,非 Math.random)', () => {
    const scores = [3, 4, 5, 4, 3, 2, 5, 4];
    const a = bootstrapMeanCI(scores, 0.05, 500);
    const b = bootstrapMeanCI(scores, 0.05, 500);
    assert.deepEqual(a, b, '无 seed 两跑应逐字节相同(默认确定性)');
    const explicit = bootstrapMeanCI(scores, 0.05, 500, DEFAULT_BOOTSTRAP_SEED);
    assert.deepEqual(a, explicit, '默认种子等价于显式传 DEFAULT_BOOTSTRAP_SEED');
  });

  it('N=1000 samples completes well under 1 second', () => {
    const scores = Array.from({ length: 50 }, (_, i) => 3 + (i % 3));
    const start = Date.now();
    bootstrapMeanCI(scores, 0.05, 1000);
    const ms = Date.now() - start;
    assert.ok(ms < 1000, `1000 bootstrap samples took ${ms}ms, expected < 1000ms`);
  });
});

describe('bootstrapDiffCI', () => {
  it('clearly different distributions: significant=true, 0 outside CI', () => {
    const control = [3, 3, 4, 3, 3];      // mean 3.2
    const treatment = [5, 5, 4, 5, 5];    // mean 4.8 — clear improvement
    const ci = bootstrapDiffCI(control, treatment, 0.05, 1000, 99);
    assert.ok(ci.significant, 'large clean difference should be significant');
    assert.ok(ci.low > 0, `diff CI low ${ci.low} should be > 0 when treatment > control`);
    assert.ok(ci.estimate > 0, `estimate ${ci.estimate} should be positive (treatment - control)`);
  });

  it('identical distributions: significant=false, 0 inside CI', () => {
    const control = [3, 4, 5, 4, 3];
    const treatment = [3, 4, 5, 4, 3]; // same data → diff is 0 with no spread
    const ci = bootstrapDiffCI(control, treatment, 0.05, 1000, 7);
    assert.ok(!ci.significant, 'identical samples should not be significant');
    assert.ok(ci.low <= 0 && 0 <= ci.high, `0 must be inside [${ci.low}, ${ci.high}]`);
  });

  it('treatment worse than control: significant=true, CI entirely negative', () => {
    const control = [5, 5, 5, 4, 5];
    const treatment = [2, 2, 3, 2, 2];
    const ci = bootstrapDiffCI(control, treatment, 0.05, 1000, 13);
    assert.ok(ci.significant, 'large negative difference should be significant');
    assert.ok(ci.high < 0, `diff CI high ${ci.high} should be < 0 when treatment < control`);
  });

  it('overlapping but distinct: small effect needs wider CI to call significant', () => {
    // Tiny difference; CI may or may not include 0 depending on N
    const control = [3, 4, 4, 3, 4];     // mean 3.6
    const treatment = [4, 4, 4, 4, 4];   // mean 4.0 — small effect
    const ci = bootstrapDiffCI(control, treatment, 0.05, 1000, 21);
    // Whether significant or not, the estimate should be ~0.4
    assert.ok(Math.abs(ci.estimate - 0.4) < 0.001, `estimate ${ci.estimate} should be close to 0.4`);
  });

  it('未传 seed 的 diff CI 也确定(significant 不会 run-to-run 翻,verdict 可复现)', () => {
    const a = bootstrapDiffCI([3, 4, 5, 4], [4, 5, 6, 5], 0.05, 500);
    const b = bootstrapDiffCI([3, 4, 5, 4], [4, 5, 6, 5], 0.05, 500);
    assert.deepEqual(a, b, '无 seed diff CI 两跑相同 → significant 确定 → verdict 不翻');
  });

  it('seeded diff CI is deterministic', () => {
    const a = bootstrapDiffCI([3, 4, 5], [4, 5, 6], 0.05, 500, 555);
    const b = bootstrapDiffCI([3, 4, 5], [4, 5, 6], 0.05, 500, 555);
    assert.deepEqual(a, b);
  });
});

describe('bootstrapPairedDiffCI', () => {
  const width = (ci: { low: number; high: number }): number => ci.high - ci.low;

  it('正相关配对数据:配对 CI 明显窄于独立重采样(收回被独立法浪费的功效)', () => {
    // b = a + 0.5,每对差恒为 0.5(完全正相关)。配对:重采样后均值恒 0.5 → CI 退化到点 [0.5,0.5];
    // 独立:分别重采样 a / b,mean(b)-mean(a) 有抽样波动 → CI 有宽度。这是配对收紧功效的极限演示。
    const a = [1, 2, 3, 4, 5, 2, 4, 3];
    const b = a.map((x) => x + 0.5);
    const pairs = a.map((x, i) => ({ a: x, b: b[i] }));
    const paired = bootstrapPairedDiffCI(pairs, 0.05, 1000, 42);
    const unpaired = bootstrapDiffCI(a, b, 0.05, 1000, 42);
    assert.ok(width(paired) < width(unpaired), `配对 CI 宽 ${width(paired)} 应 < 独立 ${width(unpaired)}`);
    assert.equal(paired.estimate, 0.5, '点估计 = 平均每对差');
    assert.equal(paired.low, 0.5);
    assert.equal(paired.high, 0.5);
    assert.ok(paired.significant, '恒正差 → 0 在 CI 外 → 显著');
  });

  it('点估计 = 配对均值差 = 差的均值,与独立法一致(只 CI 收紧,不动点估计)', () => {
    const pairs = [{ a: 3, b: 4 }, { a: 4, b: 4 }, { a: 5, b: 7 }, { a: 2, b: 3 }];
    const paired = bootstrapPairedDiffCI(pairs, 0.05, 500, 7);
    // mean(b)-mean(a) = (4+4+7+3)/4 - (3+4+5+2)/4 = 4.5 - 3.5 = 1.0
    assert.equal(paired.estimate, 1);
  });

  it('near-zero:CI 舍入后含 0 → significant=false,绝不出现「low:0 但 significant:true」自相矛盾', () => {
    // 恒定的极小正差 0.00003 → raw CI [0.00003, 0.00003] → 舍入到 [0, 0](含 0)。significant 须按持久
    // (舍入)边界判 = false;若按 raw 判会得 true,落成自相矛盾的 {low:0, significant:true}(复审 P2)。
    const pairs = Array.from({ length: 6 }, () => ({ a: 1, b: 1.00003 }));
    const ci = bootstrapPairedDiffCI(pairs, 0.05, 500);
    assert.equal(ci.low, 0);
    assert.equal(ci.high, 0);
    assert.equal(ci.significant, false, '持久 CI 含 0 → significant 必须 false(与边界一致)');
  });

  it('不变量:significant 恒与持久(舍入)边界一致(任意数据都不自相矛盾)', () => {
    const datasets = [
      Array.from({ length: 8 }, (_, i) => ({ a: i, b: i + 0.5 })),       // 稳定正差
      Array.from({ length: 8 }, (_, i) => ({ a: i, b: i + (i % 2 ? 1 : -1) })), // 跨 0
      Array.from({ length: 6 }, () => ({ a: 2, b: 2 })),                  // 零差
    ];
    for (const pairs of datasets) {
      const ci = bootstrapPairedDiffCI(pairs, 0.05, 500);
      assert.equal(ci.significant, !(ci.low <= 0 && 0 <= ci.high), `significant 须与返回的 low/high 一致:${JSON.stringify(ci)}`);
    }
  });

  it('默认确定性 + 空输入安全', () => {
    const pairs = [{ a: 3, b: 4 }, { a: 4, b: 4 }, { a: 5, b: 7 }];
    assert.deepEqual(bootstrapPairedDiffCI(pairs, 0.05, 500), bootstrapPairedDiffCI(pairs, 0.05, 500));
    assert.deepEqual(bootstrapPairedDiffCI(pairs, 0.05, 500), bootstrapPairedDiffCI(pairs, 0.05, 500, DEFAULT_BOOTSTRAP_SEED));
    assert.deepEqual(bootstrapPairedDiffCI([], 0.05, 500), { low: 0, high: 0, estimate: 0, samples: 0, significant: false });
  });

  it('更小的 α → 更宽的 CI(Bonferroni 校正的算术地基:α/K < α 必然撑宽区间,点估计不动)', () => {
    // 多重比较把每对的 α 从 0.05 收到 α/K。同一份数据、同一(默认)种子下,重采样分布逐字节相同,只是取的
    // 分位更极端(α/2=0.025 取 1.25/98.75% vs 0.05 取 2.5/97.5%)→ CI 必然不窄于 α=0.05,通常更宽。
    const pairs = Array.from({ length: 8 }, (_, i) => ({ a: 0, b: [1, 2, 0, 3, 1, 2, 0, 3][i] }));
    const wide = bootstrapPairedDiffCI(pairs, 0.025, 1000); // 模拟 K=2 的 α/K
    const narrow = bootstrapPairedDiffCI(pairs, 0.05, 1000); // 名义 α
    const width = (ci: { low: number; high: number }): number => ci.high - ci.low;
    assert.ok(width(wide) > width(narrow), `α/K(0.025)的 CI 宽 ${width(wide)} 应 > 名义 α(0.05)的 ${width(narrow)}`);
    assert.equal(wide.estimate, narrow.estimate, '点估计与 α 无关,不应变');
  });
});

describe('bootstrapWithMetric', () => {
  it('stddev metric: CI brackets the original stddev', () => {
    const scores = [3, 4, 5, 4, 3, 4, 5, 3, 4, 5];
    const stddev = (arr: number[]): number => {
      if (arr.length < 2) return 0;
      const m = arr.reduce((s, x) => s + x, 0) / arr.length;
      return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
    };
    const ci = bootstrapWithMetric(scores, stddev, 0.05, 1000, 42);
    const trueStd = stddev(scores);
    // CI should contain the original stddev (which is itself a bootstrap point estimate)
    assert.ok(ci.low <= trueStd + 0.01 && ci.high >= trueStd - 0.01,
      `CI [${ci.low}, ${ci.high}] should bracket original stddev ${trueStd}`);
  });
});
