import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  isFailedSearchTool,
  extractFailedSearchSignals,
  extractMarkerSignals,
  extractHedgingSignals,
  extractRepeatedFailureSignals,
  extractGapSignalsFromSample,
  computeGapReport,
  applyHedgingClassifier,
} from '../../src/analysis/gap-analyzer.js';
import { clearHedgingCache } from '../../src/analysis/hedging-classifier.js';
import type { ExecResult, ExecutorFn, ToolCallInfo, TurnInfo, VariantResult, ResultEntry } from '../../src/types/index.js';

// ---------- Helpers for building test fixtures ----------

function tc(tool: string, input: unknown, output: string, success = true): ToolCallInfo {
  return { tool, input, output, success };
}

function turn(role: 'assistant' | 'tool', content: string, toolCalls?: ToolCallInfo[]): TurnInfo {
  return { role, content, toolCalls };
}

function vr(opts: Partial<VariantResult> & { ok?: boolean } = {}): VariantResult {
  return {
    ok: true,
    durationMs: 100,
    durationApiMs: 100,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    execCostUSD: 0,
    judgeCostUSD: 0,
    costUSD: 0,
    numTurns: 1,
    outputPreview: null,
    ...opts,
  } as VariantResult;
}

// ---------- isFailedSearchTool ----------

describe('isFailedSearchTool', () => {
  it('flags failed Read', () => {
    assert.equal(isFailedSearchTool(tc('Read', { file_path: '/nope.md' }, 'File not found', false)), true);
  });

  it('does not flag successful Read', () => {
    assert.equal(isFailedSearchTool(tc('Read', { file_path: '/x.md' }, 'file content', true)), false);
  });

  it('flags failed Grep', () => {
    assert.equal(isFailedSearchTool(tc('Grep', { pattern: 'foo' }, '', false)), true);
  });

  it('flags Grep with empty output even when success', () => {
    assert.equal(isFailedSearchTool(tc('Grep', { pattern: 'foo' }, '', true)), true);
  });

  it('flags Grep with "No matches found"', () => {
    assert.equal(isFailedSearchTool(tc('Grep', { pattern: 'foo' }, 'No matches found', true)), true);
  });

  it('does not flag successful Grep with actual matches', () => {
    assert.equal(isFailedSearchTool(tc('Grep', { pattern: 'foo' }, 'src/foo.ts:10: foo', true)), false);
  });

  it('flags Bash grep with empty output', () => {
    assert.equal(isFailedSearchTool(tc('Bash', { command: 'grep -r foo /src' }, '', true)), true);
  });

  it('flags Bash rg with failure', () => {
    assert.equal(isFailedSearchTool(tc('Bash', { command: 'rg foo' }, '', false)), true);
  });

  it('does not flag Bash without grep/rg/find', () => {
    assert.equal(isFailedSearchTool(tc('Bash', { command: 'ls -la' }, '', false)), false);
  });

  it('does not flag Write or other non-search tools', () => {
    assert.equal(isFailedSearchTool(tc('Write', { file_path: '/x.md' }, '', false)), false);
  });
});

// ---------- extractFailedSearchSignals ----------

describe('extractFailedSearchSignals', () => {
  it('extracts one signal per unique failed search', () => {
    const calls = [
      tc('Grep', { pattern: 'foo' }, '', false),
      tc('Read', { file_path: '/a.md' }, 'ok', true),
      tc('Grep', { pattern: 'bar' }, 'No matches found', true),
    ];
    const signals = extractFailedSearchSignals(calls);
    assert.equal(signals.length, 2);
    assert.equal(signals[0].type, 'failed_search');
    assert.ok(signals[0].context.includes('foo'));
    assert.ok(signals[1].context.includes('bar'));
  });

  it('dedupes consecutive identical failed searches', () => {
    const calls = [
      tc('Grep', { pattern: 'foo' }, '', false),
      tc('Grep', { pattern: 'foo' }, '', false),
      tc('Grep', { pattern: 'foo' }, '', false),
    ];
    const signals = extractFailedSearchSignals(calls);
    assert.equal(signals.length, 1);
  });

  it('does not dedupe non-consecutive identical signals', () => {
    const calls = [
      tc('Grep', { pattern: 'foo' }, '', false),
      tc('Grep', { pattern: 'bar' }, '', false),
      tc('Grep', { pattern: 'foo' }, '', false),
    ];
    const signals = extractFailedSearchSignals(calls);
    assert.equal(signals.length, 3);
  });

  it('returns empty array when no failures', () => {
    const calls = [
      tc('Read', { file_path: '/a.md' }, 'ok', true),
      tc('Grep', { pattern: 'foo' }, 'match', true),
    ];
    assert.equal(extractFailedSearchSignals(calls).length, 0);
  });
});

// ---------- extractMarkerSignals ----------

describe('extractMarkerSignals', () => {
  it('catches Chinese 【推断】 marker', () => {
    const signals = extractMarkerSignals('这里我要【推断】一下，数据大概是这样');
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, 'explicit_marker');
  });

  it('catches 【知识缺口】 and 【未知】', () => {
    const s1 = extractMarkerSignals('【知识缺口】这个接口没文档');
    const s2 = extractMarkerSignals('价格字段【未知】');
    assert.equal(s1.length, 1);
    assert.equal(s2.length, 1);
  });

  it('catches English [inferred] and [unknown] (case-insensitive)', () => {
    const s1 = extractMarkerSignals('The answer [INFERRED] from context.');
    const s2 = extractMarkerSignals('This field is [unknown].');
    assert.equal(s1.length, 1);
    assert.equal(s2.length, 1);
  });

  it('catches multiple markers in the same text', () => {
    const text = '【推断】 first part, and then 【知识缺口】 next.';
    const signals = extractMarkerSignals(text);
    assert.equal(signals.length, 2);
  });

  it('returns empty for text without markers', () => {
    assert.equal(extractMarkerSignals('normal agent output').length, 0);
  });

  it('handles empty string', () => {
    assert.equal(extractMarkerSignals('').length, 0);
  });
});

// ---------- extractHedgingSignals ----------

describe('extractHedgingSignals', () => {
  it('catches 我不确定', () => {
    const signals = extractHedgingSignals('我不确定这个数据来自哪里');
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, 'hedging');
  });

  it('catches 需要查证', () => {
    assert.equal(extractHedgingSignals('这个需要查证一下').length, 1);
  });

  it("catches English \"I'm not sure\"", () => {
    assert.equal(extractHedgingSignals("I'm not sure where this comes from").length, 1);
  });

  it('emits at most one hedging signal per text even with multiple hedges', () => {
    const text = '我不确定这个数据，需要查证，无法确认';
    const signals = extractHedgingSignals(text);
    // Spec §4.3: one hedging signal per sample is enough
    assert.equal(signals.length, 1);
  });

  it('returns empty for clean text', () => {
    assert.equal(extractHedgingSignals('这是一个确定的答案').length, 0);
  });
});

// ---------- extractRepeatedFailureSignals ----------

describe('extractRepeatedFailureSignals', () => {
  it('emits signal after 3 consecutive failed same-tool searches', () => {
    const turns: TurnInfo[] = [
      turn('assistant', '', [
        tc('Grep', { pattern: 'a' }, '', false),
        tc('Grep', { pattern: 'b' }, '', false),
        tc('Grep', { pattern: 'c' }, '', false),
      ]),
    ];
    const signals = extractRepeatedFailureSignals(turns);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, 'repeated_failure');
    assert.ok(signals[0].context.includes('Grep'));
  });

  it('does not emit with only 2 failures', () => {
    const turns: TurnInfo[] = [
      turn('assistant', '', [
        tc('Grep', { pattern: 'a' }, '', false),
        tc('Grep', { pattern: 'b' }, '', false),
      ]),
    ];
    assert.equal(extractRepeatedFailureSignals(turns).length, 0);
  });

  it('resets run when a different tool intervenes', () => {
    const turns: TurnInfo[] = [
      turn('assistant', '', [
        tc('Grep', { pattern: 'a' }, '', false),
        tc('Grep', { pattern: 'b' }, '', false),
        tc('Read', { file_path: '/x.md' }, 'ok', true),
        tc('Grep', { pattern: 'c' }, '', false),
      ]),
    ];
    // Grep run of 2, then broken by Read, then 1 more — none reach 3
    assert.equal(extractRepeatedFailureSignals(turns).length, 0);
  });

  it('resets run when a success intervenes', () => {
    const turns: TurnInfo[] = [
      turn('assistant', '', [
        tc('Grep', { pattern: 'a' }, '', false),
        tc('Grep', { pattern: 'b' }, 'match found', true), // success breaks run
        tc('Grep', { pattern: 'c' }, '', false),
        tc('Grep', { pattern: 'd' }, '', false),
      ]),
    ];
    assert.equal(extractRepeatedFailureSignals(turns).length, 0);
  });

  it('does not double-count within the same run', () => {
    const turns: TurnInfo[] = [
      turn('assistant', '', [
        tc('Grep', { pattern: 'a' }, '', false),
        tc('Grep', { pattern: 'b' }, '', false),
        tc('Grep', { pattern: 'c' }, '', false),
        tc('Grep', { pattern: 'd' }, '', false),
        tc('Grep', { pattern: 'e' }, '', false),
      ]),
    ];
    // 5 consecutive failures should still emit exactly 1 signal
    assert.equal(extractRepeatedFailureSignals(turns).length, 1);
  });

  it('handles empty/missing turns', () => {
    assert.equal(extractRepeatedFailureSignals(undefined).length, 0);
    assert.equal(extractRepeatedFailureSignals([]).length, 0);
  });
});

// ---------- extractGapSignalsFromSample ----------

describe('extractGapSignalsFromSample', () => {
  it('aggregates all four signal types and attaches sampleId', () => {
    const variantResult = vr({
      turns: [
        turn('assistant', '我不确定这个字段的定义，【推断】可能是 user_id', [
          tc('Grep', { pattern: 'user_id_schema' }, '', false),
        ]),
      ],
    });
    const signals = extractGapSignalsFromSample(variantResult, 's001');
    const types = new Set(signals.map((s) => s.type));
    assert.ok(types.has('failed_search'));
    assert.ok(types.has('explicit_marker'));
    assert.ok(types.has('hedging'));
    for (const s of signals) assert.equal(s.sampleId, 's001');
  });

  it('falls back to top-level toolCalls when turns missing', () => {
    const variantResult = vr({
      toolCalls: [tc('Grep', { pattern: 'x' }, '', false)],
    });
    const signals = extractGapSignalsFromSample(variantResult, 's002');
    assert.ok(signals.some((s) => s.type === 'failed_search'));
  });

  it('returns empty for clean execution', () => {
    const variantResult = vr({
      turns: [
        turn('assistant', '直接输出了答案', [
          tc('Read', { file_path: '/x.md' }, 'ok', true),
        ]),
      ],
    });
    assert.equal(extractGapSignalsFromSample(variantResult, 's003').length, 0);
  });
});

// ---------- computeGapReport ----------

describe('computeGapReport', () => {
  it('computes gap rate as samples with gap / successful samples', () => {
    const results: ResultEntry[] = [
      {
        sample_id: 's001',
        variants: {
          v1: vr({
            turns: [turn('assistant', '', [tc('Grep', { pattern: 'x' }, '', false)])],
          }),
        },
      },
      {
        sample_id: 's002',
        variants: {
          v1: vr({ turns: [turn('assistant', 'clean', [])] }),
        },
      },
      {
        sample_id: 's003',
        variants: {
          v1: vr({ turns: [turn('assistant', '【推断】', [])] }),
        },
      },
    ];
    const report = computeGapReport(results, 'v1');
    assert.equal(report.sampleCount, 3);
    assert.equal(report.samplesWithGap, 2);
    assert.equal(report.gapRate, 0.6667);
  });

  it('excludes failed samples (ok: false) from denominator', () => {
    const results: ResultEntry[] = [
      {
        sample_id: 's001',
        variants: { v1: vr({ ok: false, error: 'timeout' }) },
      },
      {
        sample_id: 's002',
        variants: { v1: vr({ turns: [turn('assistant', 'clean', [])] }) },
      },
    ];
    const report = computeGapReport(results, 'v1');
    assert.equal(report.sampleCount, 1);
    assert.equal(report.samplesWithGap, 0);
    assert.equal(report.gapRate, 0);
  });

  it('same sample multiple signals only counts as 1 sample-with-gap', () => {
    const results: ResultEntry[] = [
      {
        sample_id: 's001',
        variants: {
          v1: vr({
            turns: [
              turn('assistant', '我不确定。【推断】这个字段可能是 user_id', [
                tc('Grep', { pattern: 'user_id_schema' }, '', false),
              ]),
            ],
          }),
        },
      },
    ];
    const report = computeGapReport(results, 'v1');
    assert.equal(report.samplesWithGap, 1);
    // But the signals array still lists all extracted signals
    assert.ok(report.signals.length >= 3);
  });

  it('fills byType classification counts', () => {
    const results: ResultEntry[] = [
      {
        sample_id: 's001',
        variants: {
          v1: vr({
            turns: [turn('assistant', '', [tc('Grep', { pattern: 'x' }, '', false)])],
          }),
        },
      },
      {
        sample_id: 's002',
        variants: { v1: vr({ turns: [turn('assistant', '【推断】', [])] }) },
      },
    ];
    const report = computeGapReport(results, 'v1');
    assert.equal(report.byType.failed_search, 1);
    assert.equal(report.byType.explicit_marker, 1);
    assert.equal(report.byType.hedging, 0);
    assert.equal(report.byType.repeated_failure, 0);
  });

  it('handles empty results', () => {
    const report = computeGapReport([], 'v1');
    assert.equal(report.sampleCount, 0);
    assert.equal(report.samplesWithGap, 0);
    assert.equal(report.gapRate, 0);
  });

  it('testSetPath and testSetHash default to null (caller fills)', () => {
    const report = computeGapReport([], 'v1');
    assert.equal(report.testSetPath, null);
    assert.equal(report.testSetHash, null);
  });

  // ---------- v0.2 严重度加权 (SIGNAL_WEIGHTS + weightedGapRate) ----------

  it('v0.2: 每个 signal 自带 weight (strong 1.0 / weak 0.5)', () => {
    const results: ResultEntry[] = [
      {
        sample_id: 's001',
        variants: {
          v1: vr({
            turns: [
              turn('assistant', '我不确定。【推断】', [
                tc('Grep', { pattern: 'x' }, '', false),
              ]),
            ],
          }),
        },
      },
    ];
    const report = computeGapReport(results, 'v1');
    // 3 signals: failed_search(1.0) + explicit_marker(0.5) + hedging(0.5)
    const byType = report.signals.reduce((acc, s) => {
      acc[s.type] = s.weight;
      return acc;
    }, {} as Record<string, number>);
    assert.equal(byType.failed_search, 1.0);
    assert.equal(byType.explicit_marker, 0.5);
    assert.equal(byType.hedging, 0.5);
  });

  it('v0.2: weightedGapRate 按用例最强信号聚合', () => {
    // 3 个用例:1 个 failed_search(强,权重 1.0)、1 个 hedging(弱,权重 0.5)、1 个无信号
    // gapRate = 2/3 ≈ 0.6667
    // weightedGapRate = (1.0 + 0.5 + 0) / 3 ≈ 0.5000
    const results: ResultEntry[] = [
      {
        sample_id: 's001',
        variants: { v1: vr({ turns: [turn('assistant', '', [tc('Grep', { pattern: 'x' }, '', false)])] }) },
      },
      {
        sample_id: 's002',
        variants: { v1: vr({ turns: [turn('assistant', '我不确定', [])] }) },
      },
      {
        sample_id: 's003',
        variants: { v1: vr({ turns: [turn('assistant', 'clean', [])] }) },
      },
    ];
    const report = computeGapReport(results, 'v1');
    assert.equal(report.gapRate, 0.6667);
    assert.equal(report.weightedGapRate, 0.5);
    // 永远 weighted ≤ raw(软信号只会拉低 weight)
    assert.ok(report.weightedGapRate <= report.gapRate);
  });

  it('v0.2: 同一用例多信号时取最强权重(不是累加)', () => {
    // 一个用例同时有 hedging(0.5) + failed_search(1.0) → sample weight = 1.0 而不是 1.5
    const results: ResultEntry[] = [
      {
        sample_id: 's001',
        variants: {
          v1: vr({
            turns: [
              turn('assistant', '我不确定这个数据来自哪里', [
                tc('Grep', { pattern: 'missing' }, '', false),
              ]),
            ],
          }),
        },
      },
    ];
    const report = computeGapReport(results, 'v1');
    // 用例内聚合取 max(1.0, 0.5) = 1.0
    assert.equal(report.weightedGapRate, 1.0);
  });

  it('v0.2: 全弱信号时 weightedGapRate 显著低于 gapRate', () => {
    // 4 个用例全是 hedging(弱,0.5)
    // gapRate = 4/4 = 1.0 (100% 触发信号)
    // weightedGapRate = 4*0.5 / 4 = 0.5 (加权严重度只到 50%)
    // 读者据此判断:100% 触发率但加权只到一半,大概率是软信号噪声,该复核
    const results: ResultEntry[] = Array.from({ length: 4 }, (_, i) => ({
      sample_id: `s${i + 1}`,
      variants: { v1: vr({ turns: [turn('assistant', '我不确定', [])] }) },
    }));
    const report = computeGapReport(results, 'v1');
    assert.equal(report.gapRate, 1.0);
    assert.equal(report.weightedGapRate, 0.5);
  });

  it('v0.2: 空 report 时 weightedGapRate === 0 不崩', () => {
    const report = computeGapReport([], 'v1');
    assert.equal(report.weightedGapRate, 0);
  });
});

// ---------- v0.2 hedging classifier 集成 ----------

function makeMockExec(jsonOutput: string, costUSD = 0.001): ExecutorFn {
  return async (): Promise<ExecResult> => ({
    ok: true,
    output: jsonOutput,
    durationMs: 10,
    durationApiMs: 10,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD,
    stopReason: 'end_turn',
    numTurns: 1,
  });
}

describe('applyHedgingClassifier (v0.2)', () => {
  it('classifier 剔除假阳 hedging:byType.hedging 减少, gapRate 重算', async () => {
    clearHedgingCache();
    // 4 个用例全只有 hedging,classifier 判 2 个真不确定 / 2 个业务推理
    const results: ResultEntry[] = [
      { sample_id: 's1', variants: { v1: vr({ turns: [turn('assistant', '我不确定数据库结构', [])] }) } },
      { sample_id: 's2', variants: { v1: vr({ turns: [turn('assistant', '没有足够信息回答', [])] }) } },
      { sample_id: 's3', variants: { v1: vr({ turns: [turn('assistant', '需要查证一下', [])] }) } },
      { sample_id: 's4', variants: { v1: vr({ turns: [turn('assistant', '无法确认这条', [])] }) } },
    ];
    const before = computeGapReport(results, 'v1');
    assert.equal(before.byType.hedging, 4);
    assert.equal(before.samplesWithGap, 4);

    const verdictJson = JSON.stringify([
      { id: 1, isUncertainty: true, confidence: 0.9, reason: 'real unsure' },
      { id: 2, isUncertainty: false, confidence: 0.8, reason: 'business analysis' },
      { id: 3, isUncertainty: true, confidence: 0.85, reason: 'needs to verify' },
      { id: 4, isUncertainty: false, confidence: 0.8, reason: 'multi-possibility' },
    ]);
    const result = await applyHedgingClassifier(before, makeMockExec(verdictJson));
    assert.equal(result.report.byType.hedging, 2);
    assert.equal(result.report.samplesWithGap, 2);
    assert.equal(result.report.gapRate, 0.5);
    assert.equal(result.report.weightedGapRate, 0.25);  // 2 个 sample x 0.5 weight / 4
    assert.ok(result.costUSD > 0);
    // 保留下的 hedging signal 都挂上了 classifierVerdict
    for (const s of result.report.signals) {
      assert.ok(s.classifierVerdict, '保留的 hedging 应有 classifierVerdict');
      assert.equal(s.classifierVerdict.isUncertainty, true);
    }
  });

  it('classifier 失败降级:hedging 全保留, byType / weightedGapRate 不变', async () => {
    clearHedgingCache();
    const results: ResultEntry[] = [
      { sample_id: 's1', variants: { v1: vr({ turns: [turn('assistant', '我不确定', [])] }) } },
      { sample_id: 's2', variants: { v1: vr({ turns: [turn('assistant', '需要查证', [])] }) } },
    ];
    const before = computeGapReport(results, 'v1');
    const failExec: ExecutorFn = async (): Promise<ExecResult> => ({
      ok: false,
      output: null,
      error: 'rate limited',
      durationMs: 5,
      durationApiMs: 5,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0,
      stopReason: 'error',
      numTurns: 0,
    });
    const result = await applyHedgingClassifier(before, failExec);
    assert.equal(result.report.byType.hedging, before.byType.hedging);
    assert.equal(result.report.weightedGapRate, before.weightedGapRate);
    // 但保留下的 signal 仍有 classifierVerdict, reason 标 failed (供调试)
    for (const s of result.report.signals) {
      assert.match(s.classifierVerdict!.reason, /classifier failed/);
    }
  });

  it('不影响其他 type signal:classifier 只过滤 hedging', async () => {
    clearHedgingCache();
    // 一个 sample 同时有 failed_search + hedging,classifier 判 hedging 假阳
    const results: ResultEntry[] = [
      {
        sample_id: 's1',
        variants: {
          v1: vr({
            turns: [turn('assistant', '我不确定哪里出错 ' + '#'.repeat(20), [
              tc('Grep', { pattern: 'foo' }, 'No matches found', true),
            ])],
          }),
        },
      },
    ];
    const before = computeGapReport(results, 'v1');
    assert.equal(before.byType.failed_search, 1);
    assert.equal(before.byType.hedging, 1);

    const verdictJson = JSON.stringify([
      { id: 1, isUncertainty: false, confidence: 0.8, reason: 'business' },
    ]);
    const result = await applyHedgingClassifier(before, makeMockExec(verdictJson));
    // hedging 被剔, failed_search 还在; sample 仍有 gap (failed_search 撑起来)
    assert.equal(result.report.byType.hedging, 0);
    assert.equal(result.report.byType.failed_search, 1);
    assert.equal(result.report.samplesWithGap, 1);
    // weightedGapRate 用 failed_search 权重 1.0,sample 数 1 → 1.0
    assert.equal(result.report.weightedGapRate, 1.0);
  });

  it('无 hedging signal 时直接返回原 report,不调 executor', async () => {
    clearHedgingCache();
    const results: ResultEntry[] = [
      {
        sample_id: 's1',
        variants: {
          v1: vr({ turns: [turn('assistant', '已找到', [tc('Grep', { pattern: 'x' }, '', true)])] }),
        },
      },
    ];
    const before = computeGapReport(results, 'v1');
    assert.equal(before.byType.hedging, 0);
    let called = false;
    const exec: ExecutorFn = async () => { called = true; throw new Error('should not be called'); };
    const result = await applyHedgingClassifier(before, exec);
    assert.equal(called, false);
    assert.equal(result.costUSD, 0);
    assert.deepEqual(result.report, before);
  });
});
