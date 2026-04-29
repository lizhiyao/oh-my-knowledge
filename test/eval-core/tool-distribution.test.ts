import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildVariantResult, buildVariantSummary } from '../../src/eval-core/schema.js';
import type { ExecResult, ToolCallInfo, VariantResult } from '../../src/types/index.js';

function mkToolCall(tool: string, success = true): ToolCallInfo {
  return { tool, input: {}, output: 'ok', success };
}

function mkExec(toolCalls: ToolCallInfo[]): ExecResult {
  return {
    ok: true,
    output: 'output',
    durationMs: 100, durationApiMs: 80,
    inputTokens: 10, outputTokens: 20,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    costUSD: 0.001,
    stopReason: 'end',
    numTurns: 1,
    toolCalls,
  };
}

describe('VariantResult.toolDistribution (real call count fix)', () => {
  it('single sample: per-sample toolDistribution counts each call(NOT dedup)', () => {
    const exec = mkExec([
      mkToolCall('Read'),
      mkToolCall('Read'),
      mkToolCall('Read'),
      mkToolCall('Glob'),
      mkToolCall('Bash'),
    ]);
    const r = buildVariantResult(exec, null);
    assert.deepEqual(r.toolDistribution, { Read: 3, Glob: 1, Bash: 1 });
    // toolNames 仍为 deduped 列表(用于 renderer 展示 + assertions ctx)
    assert.deepEqual([...(r.toolNames || [])].sort(), ['Bash', 'Glob', 'Read']);
    assert.equal(r.numToolCalls, 5);
  });

  it('no tool calls → toolDistribution 缺失(整个 tool 字段块 omit)', () => {
    const exec = mkExec([]);
    const r = buildVariantResult(exec, null);
    assert.equal(r.toolDistribution, undefined);
    assert.equal(r.numToolCalls, undefined);
  });
});

describe('VariantSummary.toolDistribution aggregation (real call count fix)', () => {
  function mkResult(td: Record<string, number>, numToolCalls: number, toolNames?: string[]): VariantResult {
    return {
      ok: true,
      durationMs: 100, durationApiMs: 100,
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0,
      execCostUSD: 0, judgeCostUSD: 0, costUSD: 0,
      numTurns: 1, outputPreview: 'ok',
      numToolCalls,
      numToolFailures: 0,
      toolSuccessRate: 1,
      toolDistribution: td,
      ...(toolNames !== undefined && { toolNames }),
    };
  }

  it('aggregate sums real call counts across samples (NOT sample-presence count)', () => {
    // sample 1: Read x3, Glob x1
    // sample 2: Read x5, Bash x2
    // 真 distribution: { Read: 8, Glob: 1, Bash: 2 }
    // 老 bug 行为(toolNames dedup 累加): { Read: 2, Glob: 1, Bash: 1 }
    const summary = buildVariantSummary([
      mkResult({ Read: 3, Glob: 1 }, 4),
      mkResult({ Read: 5, Bash: 2 }, 7),
    ]);
    assert.deepEqual(summary.toolDistribution, { Read: 8, Glob: 1, Bash: 2 },
      'aggregate must sum real call counts, not sample-presence');
  });

  it('legacy report fallback: result with toolNames-only(无 toolDistribution)走老语义 sample-presence', () => {
    // 模拟 v0.21 旧报告 result(没 toolDistribution 字段)— 仍按 toolNames dedup 累加,
    // 不让兼容旧报告时 crash 或语义跳变。
    const legacy = mkResult({}, 4, ['Read', 'Glob']);
    delete legacy.toolDistribution; // 抹掉  新字段模拟旧报告
    const summary = buildVariantSummary([legacy]);
    // 老语义:Read+1, Glob+1(每 sample 出现某 tool 各 +1)
    assert.deepEqual(summary.toolDistribution, { Read: 1, Glob: 1 });
  });

  it('mixed new + legacy results: 新 result 用 distribution,老 result 走 fallback', () => {
    const fresh = mkResult({ Read: 3 }, 3);
    const legacy = mkResult({}, 2, ['Read', 'Bash']);
    delete legacy.toolDistribution;
    const summary = buildVariantSummary([fresh, legacy]);
    // Read: 3 (fresh real count) + 1 (legacy presence) = 4
    // Bash: 0 + 1 = 1
    assert.deepEqual(summary.toolDistribution, { Read: 4, Bash: 1 });
  });
});
