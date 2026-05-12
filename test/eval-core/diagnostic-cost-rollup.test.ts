import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildVariantResult, buildVariantSummary } from '../../src/eval-core/schema.js';
import type { DiagnosticResult } from '../../src/types/judge.js';
import type { ExecResult, GradeResult, VariantResult } from '../../src/types/index.js';

// 锁住 diagnostic 成本三层对齐契约(PR #95 reviewer 2026-05-11 顶部 issue-comment
// 列出的 🟡 第二条 P2 ship-blocker:"diagnostic 成本只进 meta.totalCostUSD,
// 不进 variant/sample cost,成本口径会不一致,budget 也漏算 diagnostic")。
//
// 三层语义对应:
//   - VariantResult.costUSD     = execCostUSD + judgeCostUSD + diagnosticCostUSD
//     (buildVariantResult 给出 exec + judge 的初值;evaluation-execution.ts
//      的 executeTask 在 diagnostic 跑完成功且 cost > 0 时把 diagnostic.costUSD
//      加回 entry 的 costUSD 跟 diagnosticCostUSD,这是测得的契约。)
//   - VariantSummary.totalCostUSD          = sum(ok-sample 的 entry.costUSD)
//   - VariantSummary.totalDiagnosticCostUSD = sum(ok-sample 的 entry.diagnosticCostUSD)
//     字段在没有任一 entry 携带 diagnosticCostUSD 时整段省略(optional,跟其他
//     "不报告时缺位"语义一致 — 旧报告 roundtrip 不会平白多出一个新字段)。
//   - meta.totalCostUSD 是 runner 的累计,跟 summary.totalCostUSD 在"summary 仅
//     算 ok-sample / meta 算全量"这一既有差异下各自一致 — 那条差异跟 diagnostic
//     无关,是历史 ok-filter 行为(参见 schema.ts buildVariantSummary 实现注释)。
//
// 测试做的是 schema 这一层"entry.diagnosticCostUSD 进 summary.totalDiagnosticCostUSD,
// entry.costUSD 已经把 diagnostic 包进去后 summary.totalCostUSD 也跟着"的契约;
// runner 那一侧"diagnostic 跑完触发 entry.costUSD += diagnostic.costUSD"的写入
// 动作在 evaluation-execution.ts 里逐字写出且 yarn build / lint 把握住类型,这一层
// 测试到 schema 边界足够把"reviewer 关心的总值不分裂"语义钉死。

function mkExec(opts: Partial<ExecResult> = {}): ExecResult {
  return {
    ok: true,
    output: 'out',
    durationMs: 100, durationApiMs: 80,
    inputTokens: 10, outputTokens: 20,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    costUSD: 0.001,
    stopReason: 'end',
    numTurns: 1,
    ...opts,
  };
}

function mkGrade(opts: Partial<GradeResult> = {}): GradeResult {
  return {
    compositeScore: 3,
    judgeCostUSD: 0.0005,
    ...opts,
  };
}

function mkDiagnostic(costUSD: number): DiagnosticResult {
  return {
    ok: true,
    summary: 's',
    expected: 'e',
    actual: 'a',
    rootCause: [],
    suggestion: { skill: '', sample: '', none: '' },
    costUSD,
  };
}

/** Mirror executeTasks 一侧 "diagnostic 跑完成功 → entry.costUSD += diag.costUSD" 那一段。
 *  把这一行单独拎出来当 helper 是为了让 schema-side 单测能独立断言三层是否对齐,
 *  不依赖 runner 的动态 import 链(同等等价于 evaluation-execution.ts 里的
 *  "if (typeof diagnostic.costUSD === 'number' && diagnostic.costUSD > 0)" 块)。 */
function applyDiagnosticCost(entry: VariantResult, diag: DiagnosticResult): void {
  if (typeof diag.costUSD === 'number' && diag.costUSD > 0) {
    entry.diagnosticCostUSD = diag.costUSD;
    entry.costUSD = (entry.costUSD || 0) + diag.costUSD;
  }
}

describe('diagnostic 成本三层对齐: entry → summary', () => {
  it('buildVariantResult 初值 = exec + judge,diagnosticCostUSD 字段缺位(runner 还没跑 diagnostic)', () => {
    const exec = mkExec({ costUSD: 0.01 });
    const grade = mkGrade({ judgeCostUSD: 0.002 });
    const r = buildVariantResult(exec, grade);
    assert.equal(r.execCostUSD, 0.01);
    assert.equal(r.judgeCostUSD, 0.002);
    assert.equal(r.costUSD, 0.012);
    assert.equal(r.diagnosticCostUSD, undefined);
  });

  it('runner 把 diagnostic.costUSD 写回 entry 后 entry.costUSD 含三段合计', () => {
    const exec = mkExec({ costUSD: 0.01 });
    const grade = mkGrade({ judgeCostUSD: 0.002 });
    const r = buildVariantResult(exec, grade);

    const diag = mkDiagnostic(0.0007);
    applyDiagnosticCost(r, diag);

    assert.equal(r.diagnosticCostUSD, 0.0007);
    // 用 Number((...).toFixed(6)) 跟 schema reducer 取整一致,避免浮点尾误差。
    assert.equal(Number(r.costUSD.toFixed(6)), Number((0.01 + 0.002 + 0.0007).toFixed(6)));
  });

  it('diagnostic.costUSD = 0 / undefined 时 entry 不写 diagnosticCostUSD 字段(避免 0 跟 missing 混)', () => {
    const exec = mkExec({ costUSD: 0.01 });
    const grade = mkGrade({ judgeCostUSD: 0.002 });
    const r = buildVariantResult(exec, grade);

    applyDiagnosticCost(r, mkDiagnostic(0));
    assert.equal(r.diagnosticCostUSD, undefined);

    const diagNoCost: DiagnosticResult = {
      ok: false,
      error: 'executor failed',
      summary: '', expected: '', actual: '',
      rootCause: [],
      suggestion: { skill: '', sample: '', none: '' },
    };
    applyDiagnosticCost(r, diagNoCost);
    assert.equal(r.diagnosticCostUSD, undefined);
  });
});

describe('diagnostic 成本三层对齐: summary 聚合', () => {
  /** 构造一个携带 diagnostic 成本的 ok-sample entry。 */
  function entryWithDiag(execCost: number, judgeCost: number, diagCost: number): VariantResult {
    const exec = mkExec({ costUSD: execCost });
    const grade = mkGrade({ judgeCostUSD: judgeCost });
    const r = buildVariantResult(exec, grade);
    if (diagCost > 0) applyDiagnosticCost(r, mkDiagnostic(diagCost));
    return r;
  }

  it('totalDiagnosticCostUSD 等于 ok-sample 的 diagnosticCostUSD 之和', () => {
    const entries = [
      entryWithDiag(0.01, 0.001, 0.0003), // sample 触发 diagnostic
      entryWithDiag(0.012, 0.001, 0.0004), // sample 触发 diagnostic
      entryWithDiag(0.008, 0.001, 0), // sample 没触发 diagnostic
    ];
    const s = buildVariantSummary(entries);
    assert.equal(s.totalDiagnosticCostUSD, Number((0.0003 + 0.0004).toFixed(6)));
  });

  it('totalCostUSD 含三段合计(diagnostic 进 entry.costUSD 后自动累进)', () => {
    const entries = [
      entryWithDiag(0.01, 0.001, 0.0003),
      entryWithDiag(0.02, 0.002, 0.0005),
    ];
    const s = buildVariantSummary(entries);
    const expected = (0.01 + 0.001 + 0.0003) + (0.02 + 0.002 + 0.0005);
    assert.equal(Number(s.totalCostUSD.toFixed(6)), Number(expected.toFixed(6)));
    // 同时 totalExecCostUSD 跟 totalJudgeCostUSD 维持原语义,只算各自的一段。
    assert.equal(Number(s.totalExecCostUSD.toFixed(6)), Number((0.01 + 0.02).toFixed(6)));
    assert.equal(Number(s.totalJudgeCostUSD.toFixed(6)), Number((0.001 + 0.002).toFixed(6)));
    // 三段加和等于 totalCostUSD,reviewer 要求的"语义一致"在这一行成立。
    assert.equal(
      Number((s.totalExecCostUSD + s.totalJudgeCostUSD + (s.totalDiagnosticCostUSD ?? 0)).toFixed(6)),
      Number(s.totalCostUSD.toFixed(6)),
    );
  });

  it('avgCostPerSample 是按 entry.costUSD(含 diagnostic)算的均值,跟 totalCostUSD 配套', () => {
    const entries = [
      entryWithDiag(0.01, 0.001, 0.0003),
      entryWithDiag(0.01, 0.001, 0.0003),
    ];
    const s = buildVariantSummary(entries);
    assert.equal(Number(s.avgCostPerSample.toFixed(6)), Number((0.01 + 0.001 + 0.0003).toFixed(6)));
  });

  it('全部 entry 无 diagnostic 时 summary 整段省略 totalDiagnosticCostUSD 字段(旧报告 roundtrip 不变形)', () => {
    const entries = [
      entryWithDiag(0.01, 0.001, 0),
      entryWithDiag(0.015, 0.001, 0),
    ];
    const s = buildVariantSummary(entries);
    assert.equal('totalDiagnosticCostUSD' in s, false,
      'totalDiagnosticCostUSD 应在无任何 entry 携带 diagnostic 成本时缺位,而不是 0');
  });

  it('per-sample budget 的 cap 检查路径会拿三段合计的 entry.costUSD 比上限(契约文档,不动 runner 的运行行为)', () => {
    // 这条单测的核心目的是"把 reviewer 关心的 budget 跟 diagnostic 的关系白纸黑字钉
    // 死":只要 runner 在 budget perSampleUSD 检查之前把 diagnostic.costUSD 加回
    // entry.costUSD(evaluation-execution.ts 里的契约,见同一文件 line 322 周围),
    // 那 cap 检查 `entry.costUSD > perSampleUSD` 自动把 diagnostic 算进去 — 跟
    // 反之"diagnostic 只进 totalCostUSD"的旧行为(reviewer 在 5/11 CR 里说"也不
    // 参与 per-sample budget")相反。
    const exec = mkExec({ costUSD: 0.2 });
    const grade = mkGrade({ judgeCostUSD: 0.05 });
    const entry = buildVariantResult(exec, grade);
    // pre-diag entry.costUSD = 0.25,假设 perSampleUSD cap = 0.3,本应过关。
    assert.ok(entry.costUSD <= 0.3, 'pre-diag cost 在 cap 内');

    applyDiagnosticCost(entry, mkDiagnostic(0.08));
    // post-diag entry.costUSD = 0.33 > 0.3,runner 端 cap 检查在新 entry.costUSD
    // 上跑就会标 overrun。这一行替代"找一个 fake judgeExecutors.claude 去 stub
    // 动态 import 的 runDiagnostic 流水"那种重量级 e2e,等价覆盖到契约的语义点。
    assert.ok(entry.costUSD > 0.3, 'post-diag cost 跨过 cap,runner 该认定 budget overrun');
    assert.equal(entry.diagnosticCostUSD, 0.08);
  });
});
