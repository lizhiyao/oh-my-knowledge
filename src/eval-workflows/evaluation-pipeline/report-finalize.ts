/**
 * Report 最终化 —— task execution 结果 → 完整 Report。
 *
 * `executeTasks` 出来的是裸结果(results / totalCostUSD),`aggregateReport` 把
 * 它们包成 Report 骨架。`finalizeEvaluationReport` 在这之上挂三层后置分析:
 *   - `report.analysis` 主体: diagnostics + sampleQuality(传入 samples 用于
 *     capability / difficulty / construct / provenance 覆盖率聚合)
 *   - 可选 coverage: 仅当结果里含 tool trace 数据时计算
 *   - 可选 gapReports: 文本信号(markers / hedging)始终适用,与 tool trace 无关;
 *     带上 testSetHash 水印(spec §7.1 强制要求)
 *
 * 仅被 orchestrator 调用;独立拆出主要为让 orchestrator 的 try-finally 主干
 * 看起来纯粹是「执行→收尾」时序。
 */

import { analyzeResults } from '../../analysis/report-diagnostics.js';
import { computeReportCoverage } from '../../analysis/coverage-analyzer.js';
import { computeReportGapRates } from '../../analysis/gap-analyzer.js';
import { computeHoldoutBreakdown } from '../../eval-core/holdout.js';
import type { Artifact, Report, Sample, VariantResult } from '../../types/index.js';
import { computeTestSetHash } from './test-set-hash.js';

type EvaluationResults = Record<string, Record<string, VariantResult>>;

export function finalizeEvaluationReport({
  report,
  results,
  artifacts,
  variantNames,
  samplesPath,
  samplesSourceFiles,
  samples,
}: {
  report: Report;
  results: EvaluationResults;
  artifacts: Artifact[];
  variantNames: string[];
  samplesPath: string;
  /** 目录模式下,bundle 内所有源文件;单文件模式下 [samplesPath]。computeTestSetHash 用。 */
  samplesSourceFiles?: string[];
  samples: Sample[];
}): Report {
  // pass samples so analyzeResults can populate analysis.sampleQuality
  // (capability/difficulty/construct/provenance coverage aggregate). Without
  // samples, analysis.sampleQuality is omitted (老报告读取仍可工作).
  report.analysis = analyzeResults(report, { samples });

  const hasToolData = Object.values(results).some((sampleResults) => (
    Object.values(sampleResults).some((variantResult) => variantResult.toolCalls && variantResult.toolCalls.length > 0)
  ));
  if (hasToolData) {
    const artifactContents = Object.fromEntries(artifacts.map((artifact) => [artifact.name, artifact.content]));
    const artifactCwds = Object.fromEntries(artifacts.map((artifact) => [artifact.name, artifact.cwd || null]));
    const coverage = computeReportCoverage(report, artifactContents, artifactCwds);
    if (Object.keys(coverage).length > 0) {
      report.analysis!.coverage = coverage;
    }
  }

  // Gap rate computation runs on every successful report regardless of whether
  // tool trace data is present — text-based signals (markers, hedging) still
  // apply. The samples-file SHA is the mandatory watermark required by spec §7.1.
  // The same hash watermarks the opt-in holdout breakdown below, so it is computed
  // once and shared (both coverage-class numbers must carry the same test-set id).
  const holdoutRatio = report.meta?.request?.holdoutRatio ?? 0;
  const gapReports = computeReportGapRates(report.results, variantNames);
  const needsWatermark = Object.keys(gapReports).length > 0 || holdoutRatio > 0;
  const testSetHash = needsWatermark ? computeTestSetHash(samplesPath, samplesSourceFiles) : null;
  if (Object.keys(gapReports).length > 0) {
    for (const variant of variantNames) {
      const gr = gapReports[variant];
      if (!gr) continue;
      gr.testSetPath = samplesPath;
      gr.testSetHash = testSetHash;
    }
    report.analysis!.gapReports = gapReports;
  }

  // Opt-in train/holdout generalization breakdown (`omk eval --holdout-ratio`).
  // Post-hoc over report.results — never perturbs the headline composite or the
  // bootstrap CI. A large train − holdout gap is the overfitting signal the verdict
  // overfitting gate reads (src/eval-core/verdict.ts); absent on default runs.
  if (holdoutRatio > 0) {
    const holdout = computeHoldoutBreakdown(report, variantNames, holdoutRatio);
    holdout.testSetPath = samplesPath;
    holdout.testSetHash = testSetHash;
    report.analysis!.holdout = holdout;
  }

  return report;
}
