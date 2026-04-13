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
} from '../../src/analysis/gap-analyzer.js';
import type { ToolCallInfo, TurnInfo, VariantResult, ResultEntry } from '../../src/types.js';

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
});
