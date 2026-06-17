/**
 * doc ↔ code 常量漂移 gate。
 *
 * statistical-rigor.md 曾经写 bootstrap「默认 5000」,而代码默认是 1000
 * (`DEFAULT_BOOTSTRAP_SAMPLES`)。这页正是 omk 卖「auditable, not just claimed」
 * 的招牌,把审计者预期从 1000 误导成 5000(实际拿到更宽的 CI)恰好砸自己招牌。
 * 跟 `markdown-cmd-refs.test.ts`(命令/flag 漂移)同一类「文档跟不上代码」的债,
 * 这里守住文档里明确陈述的统计默认值。
 *
 * 机制:每条 check 把一个代码常量绑到陈述它的那句文档措辞(正则带一个 capture)。
 *   - capture 出来的数字跟代码常量不等 → 漂移,fail。
 *   - 正则压根没命中 → 文档措辞被改了,也 fail(强制更新本 anchor 或修文档)。
 * 不做宽泛全文数字扫描:`bootstrap 在小 N(< 30)仍有效` 的 30 是适用区间、
 * 不是默认值,naive grep 会误判 — 所以每条都按语义点对点锚定。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BOOTSTRAP_SAMPLES, DEFAULT_BOOTSTRAP_ALPHA } from '../../src/eval-core/bootstrap.js';
import { DEFAULT_SATURATION_WINDOW_SIZE, DEFAULT_CI_WIDTH_SHRINK_THRESHOLD } from '../../src/analysis/saturation.js';
import { UNDERPOWERED_MIN_SAMPLES, STABILITY_UNSTABLE_CV, DEFAULT_GATE_THRESHOLD, ENSEMBLE_STRONG_PEARSON, ENSEMBLE_DISSENT_PEARSON } from '../../src/eval-core/verdict.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

interface Check {
  /** 测试名 + 失败信息里用的标签。 */
  label: string;
  /** 相对仓库根的文档路径。 */
  file: string;
  /** 恰好一个 capture group = 文档里陈述的那个数字。 */
  pattern: RegExp;
  /** 代码侧真值常量。 */
  expected: number;
  /** capture 字符串 → 可比数值;默认 Number。百分号类需 /100。 */
  toNumber?: (s: string) => number;
}

const CHECKS: Check[] = [
  // bootstrap 默认重采样次数(en + zh)
  {
    label: 'bootstrap resamples (en)',
    file: 'docs/explanation/statistical-rigor.md',
    pattern: /resampled with replacement N times \(default (\d+)\)/,
    expected: DEFAULT_BOOTSTRAP_SAMPLES,
  },
  {
    label: 'bootstrap resamples (zh)',
    file: 'docs/zh/explanation/statistical-rigor.md',
    pattern: /有放回重采样 N 次（默认 (\d+)）/,
    expected: DEFAULT_BOOTSTRAP_SAMPLES,
  },
  // bootstrap 默认显著性水平 α(en + zh)
  {
    label: 'bootstrap alpha (en)',
    file: 'docs/explanation/statistical-rigor.md',
    pattern: /\(default (0\.\d+) → 95% CI\)/,
    expected: DEFAULT_BOOTSTRAP_ALPHA,
  },
  {
    label: 'bootstrap alpha (zh)',
    file: 'docs/zh/explanation/statistical-rigor.md',
    pattern: /（默认 (0\.\d+) → 95% CI）/,
    expected: DEFAULT_BOOTSTRAP_ALPHA,
  },
  // saturation 窗口大小(en + zh)
  {
    label: 'saturation window size (en)',
    file: 'docs/explanation/statistical-rigor.md',
    pattern: /Default window size: (\d+) consecutive measurements/,
    expected: DEFAULT_SATURATION_WINDOW_SIZE,
  },
  {
    label: 'saturation window size (zh)',
    file: 'docs/zh/explanation/statistical-rigor.md',
    pattern: /默认窗口大小：(\d+) 个连续测量/,
    expected: DEFAULT_SATURATION_WINDOW_SIZE,
  },
  // saturation bootstrap-ci-width 收敛阈值:文档以百分号陈述,代码是小数(en + zh)
  {
    label: 'saturation ci-width threshold (en)',
    file: 'docs/explanation/statistical-rigor.md',
    pattern: /threshold: (\d+)% relative shrink/,
    expected: DEFAULT_CI_WIDTH_SHRINK_THRESHOLD,
    toNumber: (s) => Number(s) / 100,
  },
  {
    label: 'saturation ci-width threshold (zh)',
    file: 'docs/zh/explanation/statistical-rigor.md',
    pattern: /相对衰减 (\d+)%/,
    expected: DEFAULT_CI_WIDTH_SHRINK_THRESHOLD,
    toNumber: (s) => Number(s) / 100,
  },
  // UNDERPOWERED 的 N 阈值:sample-design-spec 的 pre-flight power band 写死的 20(en + zh)
  {
    label: 'underpowered min N (sample-design-spec en)',
    file: 'docs/specs/sample-design-spec.md',
    pattern: /`N < (\d+)` \(only large effects detectable\)/,
    expected: UNDERPOWERED_MIN_SAMPLES,
  },
  {
    label: 'underpowered min N (sample-design-spec zh)',
    file: 'docs/zh/specs/sample-design-spec.md',
    pattern: /`N < (\d+)`（只大效应可测）/,
    expected: UNDERPOWERED_MIN_SAMPLES,
  },
  // 稳定性门控的不稳阈值:文档以百分号陈述,代码是小数(en + zh)
  {
    label: 'stability unstable CV (statistical-rigor en)',
    file: 'docs/explanation/statistical-rigor.md',
    pattern: /median CV > (\d+)%/,
    expected: STABILITY_UNSTABLE_CV,
    toNumber: (s) => Number(s) / 100,
  },
  {
    label: 'stability unstable CV (statistical-rigor zh)',
    file: 'docs/zh/explanation/statistical-rigor.md',
    pattern: /中位 CV > (\d+)%/,
    expected: STABILITY_UNSTABLE_CV,
    toNumber: (s) => Number(s) / 100,
  },
  // 门控魔数:layer-gate 阈值 + 评委一致性 Pearson 强/弱带(en + zh)
  {
    label: 'gate threshold (scoring en)',
    file: 'docs/specs/scoring.md',
    pattern: /layer-gate threshold defaults to (\d+\.\d+)/,
    expected: DEFAULT_GATE_THRESHOLD,
  },
  {
    label: 'gate threshold (scoring zh)',
    file: 'docs/zh/specs/scoring.md',
    pattern: /layer-gate threshold 默认 (\d+\.\d+)/,
    expected: DEFAULT_GATE_THRESHOLD,
  },
  {
    label: 'ensemble strong Pearson (scoring en)',
    file: 'docs/specs/scoring.md',
    pattern: /strong agreement at Pearson ≥ (\d+\.\d+)/,
    expected: ENSEMBLE_STRONG_PEARSON,
  },
  {
    label: 'ensemble strong Pearson (scoring zh)',
    file: 'docs/zh/specs/scoring.md',
    pattern: /强一致 Pearson ≥ (\d+\.\d+)/,
    expected: ENSEMBLE_STRONG_PEARSON,
  },
  {
    label: 'ensemble dissent Pearson (scoring en)',
    file: 'docs/specs/scoring.md',
    pattern: /strong disagreement at Pearson < (\d+\.\d+)/,
    expected: ENSEMBLE_DISSENT_PEARSON,
  },
  {
    label: 'ensemble dissent Pearson (scoring zh)',
    file: 'docs/zh/specs/scoring.md',
    pattern: /强分歧 Pearson < (\d+\.\d+)/,
    expected: ENSEMBLE_DISSENT_PEARSON,
  },
];

describe('doc ↔ code 常量漂移 gate', () => {
  for (const c of CHECKS) {
    it(`${c.label}:文档陈述的数值必须等于代码常量`, () => {
      const text = readFileSync(join(PROJECT_ROOT, c.file), 'utf8');
      const m = c.pattern.exec(text);
      assert.ok(
        m,
        `锚点未命中:${c.file} 里 ${c.pattern} 没匹配到。文档措辞可能改了 —— ` +
          `要么更新本测试的 pattern,要么修文档。`,
      );
      const got = (c.toNumber ?? Number)(m![1]!);
      assert.equal(
        got,
        c.expected,
        `doc-vs-code 漂移(${c.label}):${c.file} 写的是 "${m![1]}"(→ ${got}),` +
          `代码常量是 ${c.expected}。改文档或改代码使二者一致。`,
      );
    });
  }
});
