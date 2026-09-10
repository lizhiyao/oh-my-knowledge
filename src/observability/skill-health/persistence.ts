import { indexObserveWrite } from '../../evidence/storage/discovery-index.js';
import { runFileSuffix } from '../../evidence/storage/file-names.js';
import { writeMeasurementReportBundle } from '../../evidence/storage/report-bundle.js';
import type { SkillHealthReport } from './analyzer.js';

/**
 * observe health 报告落盘：id 加 4 位随机段，根治「同秒两次 omk observe 覆盖」的数据丢失。
 * 每份报告使用自包含 bundle，权威正文固定为 report.json。
 * 落盘后 best-effort 追加全局轻卡片,让 studio 跨项目聚合。
 */
export function persistObserveHealthReport(report: SkillHealthReport, outDir: string): { id: string; jsonPath: string } {
  const id = runFileSuffix();
  const { reportPath: jsonPath } = writeMeasurementReportBundle({
    rootDir: outDir,
    measurementDomain: 'observe-health',
    recordId: id,
    reportId: id,
    createdAt: report.meta.generatedAt,
    report,
  });
  indexObserveWrite(report, jsonPath, outDir, id);
  return { id, jsonPath };
}

/**
 * SkillHealthReport → managed 反哺的结构化最小入参(#235)。纯映射、可单测 —— 把「observe 报告 →
 * ObserveReportView」这段层间胶水从 CLI 副作用里拆出来,免得 healthBand 取错字段 / observedAt 取错时刻
 * 这类映射 bug 无人验。`observedAt` 取**流量窗口结束时刻**(timeRange.to,空则退 generatedAt),不是「此刻」
 * 的 generatedAt —— 否则 latest-wins 会把所有观测当成一样新(见 ManagedObservation.observedAt)。
 * `healthBand` 由 observability 的 `healthBandOf` 逐 skill 算(阈值单一来源,注入以保可测)。
 */
export function buildObserveReportView(
  report: SkillHealthReport,
  reportId: string,
  healthBandOf: (weightedGapRate: number) => 'green' | 'yellow' | 'red',
): import('../../knowledge-artifacts/governance/observe-feedback.js').ObserveReportView {
  return {
    reportId,
    observedAt: report.meta.timeRange?.to || report.meta.generatedAt,
    skills: Object.values(report.bySkill).map((s) => ({
      skillName: s.skillName,
      segmentCount: s.segmentCount,
      gapRate: s.gap.gapRate,
      weightedGapRate: s.gap.weightedGapRate,
      confidence: s.confidence,
      healthBand: healthBandOf(s.gap.weightedGapRate),
      gapByType: s.gap.byType,
    })),
  };
}

