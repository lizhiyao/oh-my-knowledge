import { tCli, type CliLang } from '../i18n.js';
import type { EvaluationReport, ReportDocument } from '../../types/index.js';

export interface EvalResult {
  report: ReportDocument;
  filePath: string | null;
}

export interface ReportServer {
  start: () => Promise<string>;
}

export function requireEvaluationReport(report: ReportDocument | null, id: string, lang: CliLang): EvaluationReport {
  if (!report) {
    console.error(tCli('cli.common.report_not_found', lang, { id }));
    process.exit(1);
  }
  if (report.kind === 'batch-evaluation') {
    console.error(lang === 'zh'
      ? `报告 ${id} 是 BatchEvaluationReport。该命令需要单次 EvaluationReport；请使用其中的 child reportId。`
      : `Report ${id} is a BatchEvaluationReport. This command requires an EvaluationReport; use a child reportId from the batch.`);
    process.exit(1);
  }
  return report;
}

export function parseLastWindow(spec: string): string | null {
  // "7d" / "24h" / "30m" → ISO timestamp (from = now - spec)
  const m = /^(\d+)([dhm])$/.exec(spec);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === 'd' ? n * 86400_000 : unit === 'h' ? n * 3600_000 : n * 60_000;
  return new Date(Date.now() - ms).toISOString();
}
