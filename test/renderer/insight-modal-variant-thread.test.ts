import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { collectFailedSamplesForInsight } from '../../src/renderer/skill-detail-renderer.js';
import type { Insight } from '../../src/server/skill-insights.js';
import type { EvaluationReport } from '../../src/types/report.js';

/**
 * P1 回归测 — PR #95 reviewer 5/11 CR 的 "insight modal 在 multi-treatment 报告
 * 下永远显示第一个非 baseline variant 的 diagnostic" ship-blocker。
 *
 * pre-fix 行为:`collectFailedSamplesForInsight(ins, evalReport)` 函数体里那行
 *   const variant = evalReport.meta.variants?.find((v) => v !== 'baseline');
 * 硬拿 variants 数组里第一个非 baseline 的 name,所以一份 baseline + skill-a +
 * skill-b 三 variant 的报告下,不管 URL 是 /skills/skill-a 还是 /skills/skill-b,
 * modal 里的 diagnostic.expected / actual / summary / failureModes 文本永远来自
 * skill-a(数组里第一个非 baseline 的那一个)——把 skill-b 的作者引导到 skill-a 的
 * 诊断里去改错对象,reviewer 说"比统计错更危险因为直接误导改错对象"。
 *
 * fix 行为:函数签名加第 3 形参 currentVariant: string | null,从顶层 batch map
 * 入口的 entry.eval?.variantName ?? null 沿 wrapper renderInsightModal 透下来。
 * 函数体改成 `const variant = currentVariant ?? evalReport.meta.variants?.find(...);`
 * 优先 currentVariant,缺失才走原 fallback——保证单 treatment 老报告(只有 baseline
 * 加一个 treatment 的 pre-multi-treatment 场景)行为跟修法前一致。同时把函数前面
 * 加上 export keyword 让本测试文件能直接 import 做白盒契约测,跟 src/server/
 * skill-index.ts:51 的 _resetSkillIndexCache 的 "for-test export" 风格一致。
 *
 * 测试 contract 7 个 case 覆盖:
 *   1. currentVariant='skill-b' → diagnostic 来自 skill-b 不是 skill-a(核心 P1)
 *   2. currentVariant='skill-a' → diagnostic 来自 skill-a(跟 case 1 形成对照,
 *      verify 是"按 currentVariant 选"而不是"按数组里 first 非 baseline 选")
 *   3. currentVariant=null → fallback 到 first non-baseline 即 skill-a
 *      (backward-compat:单 treatment 老报告的行为不变)
 *   4. evalReport=null → 空返回(既有 early-return path 不受新形参影响)
 *   5. ins.stageRefs.evalSampleIds=[] → 空返回(既有 early-return path 同上)
 *   6. variants=['baseline'] 且 currentVariant=null → 空(没 fallback 目标,
 *      `if (!variant) return []` 触发)
 *   7. currentVariant='bogus' 是个不在 variants 数组里的字符串
 *      → results.variants['bogus']=undefined → 函数走 `vr?.diagnostic?.x ?? ''`
 *      链不抛错,返回 1 条 sample row 但 diagnostic 字段全空(防御性)。
 *
 * EvaluationReport 上 ReportMeta 的 required 字段众多(cliVersion / nodeVersion /
 * judgePromptHash / executorRuntime / artifactHashes / sampleHashes 等),
 * 这条契约测里跟我们要测的函数行为无关 —— 走仓内既有 test/eval-core/verdict.test.ts
 * 的 `as Report` cast 风格,partial 字面 cast 到声明类型,runtime 端
 * collectFailedSamplesForInsight 只读 meta.variants 跟 results[].variants[name]
 * .diagnostic.* 这两路,其他字段 undefined 不影响 contract。
 */

interface DiagShape {
  expected: string;
  actual: string;
  summary: string;
  failureModes: string[];
}

function mkReport(
  variants: readonly string[],
  sampleId: string,
  perVariantDiag: Record<string, DiagShape>,
): EvaluationReport {
  const variantResultsByName: Record<string, unknown> = {};
  for (const v of variants) {
    const d = perVariantDiag[v];
    if (!d) {
      // baseline 跟没 diagnostic 数据的 variant 走 minimal shape
      variantResultsByName[v] = { ok: true };
      continue;
    }
    variantResultsByName[v] = {
      ok: true,
      diagnostic: {
        ok: true,
        summary: d.summary,
        expected: d.expected,
        actual: d.actual,
        failureModes: d.failureModes,
      },
    };
  }
  return {
    kind: 'evaluation',
    id: 'r-test',
    meta: { variants: [...variants], timestamp: '2026-05-12T00:00:00Z' },
    summary: {},
    sampleSnapshots: [],
    analysis: undefined,
    results: [{ sample_id: sampleId, variants: variantResultsByName }],
  } as unknown as EvaluationReport;
}

function mkInsight(sampleIds: readonly string[]): Insight {
  return {
    id: 'ins-test',
    severity: 'high',
    title: 'test insight referencing the given sample ids',
    summary: 'a test insight built for the P1 multi-variant contract test',
    evidence: [],
    recommendations: [],
    stageRefs: {
      evalSampleIds: [...sampleIds],
      doctorRuleIds: [],
      observeAnalysisIds: [],
    },
  } as unknown as Insight;
}

describe('collectFailedSamplesForInsight — currentVariant thread-through (PR #95 reviewer 5/11 P1 ship-blocker regression)', () => {
  const variants = ['baseline', 'skill-a', 'skill-b'] as const;
  const diagnostics: Record<string, DiagShape> = {
    'skill-a': {
      expected: 'EXPECTED_FROM_SKILL_A',
      actual: 'ACTUAL_FROM_SKILL_A',
      summary: 'SUMMARY_FROM_SKILL_A',
      failureModes: ['mode_a'],
    },
    'skill-b': {
      expected: 'EXPECTED_FROM_SKILL_B',
      actual: 'ACTUAL_FROM_SKILL_B',
      summary: 'SUMMARY_FROM_SKILL_B',
      failureModes: ['mode_b'],
    },
  };

  it('case 1: currentVariant="skill-b" → diagnostic 字段来自 skill-b 不是 skill-a (核心 P1: pre-fix 时 hard-coded find 永远拿 array[1]=skill-a 即 first-non-baseline)', () => {
    const out = collectFailedSamplesForInsight(
      mkInsight(['s001']),
      mkReport(variants, 's001', diagnostics),
      'skill-b',
    );
    assert.equal(out.length, 1, 'one sample row');
    assert.equal(out[0].sampleId, 's001');
    assert.equal(
      out[0].expected,
      'EXPECTED_FROM_SKILL_B',
      'expected text must come from skill-b not skill-a',
    );
    assert.equal(out[0].actual, 'ACTUAL_FROM_SKILL_B');
    assert.equal(out[0].diagnosticSummary, 'SUMMARY_FROM_SKILL_B');
    assert.deepEqual(out[0].failureModes, ['mode_b']);
    // 反向断言:skill-a 的字面 token 不应出现在 skill-b 的 modal 数据里(防止
    // 实现细节上 fallback 跟 currentVariant 同时存在时把两边数据拼到一起的回归)
    assert.doesNotMatch(out[0].expected, /SKILL_A/);
    assert.doesNotMatch(out[0].actual, /SKILL_A/);
    assert.doesNotMatch(out[0].diagnosticSummary, /SKILL_A/);
  });

  it('case 2: currentVariant="skill-a" → diagnostic 字段来自 skill-a (跟 case 1 形成对照,verify 是"按 currentVariant 名 key 索引"而不是"按数组顺序 first-non-baseline 索引")', () => {
    const out = collectFailedSamplesForInsight(
      mkInsight(['s001']),
      mkReport(variants, 's001', diagnostics),
      'skill-a',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].sampleId, 's001');
    assert.equal(out[0].expected, 'EXPECTED_FROM_SKILL_A');
    assert.equal(out[0].actual, 'ACTUAL_FROM_SKILL_A');
    assert.equal(out[0].diagnosticSummary, 'SUMMARY_FROM_SKILL_A');
    assert.deepEqual(out[0].failureModes, ['mode_a']);
    // case 1 跟 case 2 合起来证明 fix 是按 currentVariant 字符串名做 key 索引,
    // 不是按数组里的位置选 — 这正是 reviewer 给的 fix contract。
  });

  it('case 3: currentVariant=null → fallback 到 evalReport.meta.variants 里第一个非 baseline 的那个 (backward-compat:单 treatment 老报告这条 fallback 路径维持 pre-fix 行为)', () => {
    const out = collectFailedSamplesForInsight(
      mkInsight(['s001']),
      mkReport(variants, 's001', diagnostics),
      null,
    );
    // ['baseline','skill-a','skill-b'].find(v => v !== 'baseline') === 'skill-a'
    assert.equal(out.length, 1);
    assert.equal(
      out[0].expected,
      'EXPECTED_FROM_SKILL_A',
      'currentVariant=null falls back to array.find(v !== "baseline") which is "skill-a" by array order',
    );
  });

  it('case 4: evalReport=null → 空返回(既有 early-return,跟新形参 currentVariant 是 null 或者非 null 都无关)', () => {
    const outWithNonNullVariant = collectFailedSamplesForInsight(
      mkInsight(['s001']),
      null,
      'skill-b',
    );
    assert.deepEqual(outWithNonNullVariant, []);
    const outWithNullVariant = collectFailedSamplesForInsight(
      mkInsight(['s001']),
      null,
      null,
    );
    assert.deepEqual(outWithNullVariant, []);
  });

  it('case 5: ins.stageRefs.evalSampleIds=[] → 空返回(既有 early-return path,无 sample id 也没东西可查)', () => {
    const out = collectFailedSamplesForInsight(
      mkInsight([]),
      mkReport(variants, 's001', diagnostics),
      'skill-b',
    );
    assert.deepEqual(out, []);
  });

  it('case 6: variants=["baseline"] 且 currentVariant=null → 空("if (!variant) return []" 触发,没有任何 treatment variant 可以 fallback 到)', () => {
    const out = collectFailedSamplesForInsight(
      mkInsight(['s001']),
      mkReport(['baseline'] as const, 's001', {}),
      null,
    );
    assert.deepEqual(out, []);
  });

  it('case 7: currentVariant="bogus-variant-that-does-not-exist" → 返回 1 条 sample row 但 diagnostic 字段全空字符串(防御性:不抛错,fall 到 vr?.diagnostic?.field ?? "" 的 nullish-coalescing 默认值)', () => {
    // 这是个 edge — currentVariant 字面理论上应当来自 entry.eval?.variantName,
    // 是 entry 在 SkillIndex build 时从 evaluation report 的某个真实 variant 取的
    // 字符串,不会是 nonexistent。但 prod 端偶发 race condition(报告刚跑完
    // entry.eval 已更新但 evalReport 的 variants 在内存里是 stale state) 时这种
    // 不一致是可能的,函数体应当 gracefully 返回"有 sample id 但 diagnostic 空"
    // 而不是抛 TypeError on undefined.diagnostic。
    const out = collectFailedSamplesForInsight(
      mkInsight(['s001']),
      mkReport(variants, 's001', diagnostics),
      'bogus-variant-that-does-not-exist',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].sampleId, 's001');
    assert.equal(out[0].expected, '', 'nonexistent variant key → diagnostic.expected 走 "" default');
    assert.equal(out[0].actual, '');
    assert.equal(out[0].diagnosticSummary, '');
    assert.deepEqual(out[0].failureModes, []);
    assert.equal(out[0].illustration, null);
  });

  it('case 8(bonus): multi-sample insight,每条 sample 在 currentVariant 选定的 variant 下各自取自己的 diagnostic 文本,sample 之间不交叉(verify 函数体里 sampleIds.map 的逐条 lookup 行为)', () => {
    // 拓展 mkReport 不够灵活——这个 case 直接写一个含两条 sample 的 evalReport,
    // 每条 sample 在 skill-b 下有独立 diagnostic;断言两条都拿到自己那一份不互窜。
    const evalReport = {
      kind: 'evaluation',
      id: 'r-multi-sample',
      meta: { variants: ['baseline', 'skill-a', 'skill-b'], timestamp: '2026-05-12T00:00:00Z' },
      summary: {},
      sampleSnapshots: [],
      analysis: undefined,
      results: [
        {
          sample_id: 's-alpha',
          variants: {
            baseline: { ok: true },
            'skill-a': { ok: true, diagnostic: { ok: true, summary: 'a-alpha', expected: 'e-alpha-A', actual: 'r-alpha-A', failureModes: [] } },
            'skill-b': { ok: true, diagnostic: { ok: true, summary: 'b-alpha', expected: 'e-alpha-B', actual: 'r-alpha-B', failureModes: ['alpha-mode'] } },
          },
        },
        {
          sample_id: 's-beta',
          variants: {
            baseline: { ok: true },
            'skill-a': { ok: true, diagnostic: { ok: true, summary: 'a-beta', expected: 'e-beta-A', actual: 'r-beta-A', failureModes: [] } },
            'skill-b': { ok: true, diagnostic: { ok: true, summary: 'b-beta', expected: 'e-beta-B', actual: 'r-beta-B', failureModes: ['beta-mode'] } },
          },
        },
      ],
    } as unknown as EvaluationReport;
    const insight = mkInsight(['s-alpha', 's-beta']);
    const out = collectFailedSamplesForInsight(insight, evalReport, 'skill-b');
    assert.equal(out.length, 2, 'two sample rows in insight, both should resolve');
    const alpha = out.find((r) => r.sampleId === 's-alpha');
    const beta = out.find((r) => r.sampleId === 's-beta');
    assert.ok(alpha, 'alpha row exists');
    assert.ok(beta, 'beta row exists');
    // skill-b variant 下的字面对应 sample 而不是另一条 sample 的 diagnostic
    assert.equal(alpha!.expected, 'e-alpha-B');
    assert.equal(alpha!.actual, 'r-alpha-B');
    assert.equal(alpha!.diagnosticSummary, 'b-alpha');
    assert.deepEqual(alpha!.failureModes, ['alpha-mode']);
    assert.equal(beta!.expected, 'e-beta-B');
    assert.equal(beta!.actual, 'r-beta-B');
    assert.equal(beta!.diagnosticSummary, 'b-beta');
    assert.deepEqual(beta!.failureModes, ['beta-mode']);
    // alpha 跟 beta 之间字面 token 互相不串(防止 sample 维度跟 variant 维度同时
    // hard-coded 取错位的复合 bug)。
    assert.doesNotMatch(alpha!.expected, /beta/);
    assert.doesNotMatch(beta!.expected, /alpha/);
  });
});
