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
