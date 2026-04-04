import type { Report, ReportMeta, ReportStore, VariantSummary } from './types.js';

export interface RunListItem {
  id: string;
  meta: ReportMeta;
  summary: Report['summary'];
}

export interface TrendPoint {
  reportId: string;
  timestamp: string;
  avgCompositeScore: number | null;
  avgNumTurns: number | null;
  avgCostPerSample: number | null;
  artifactHash: string | null;
  gitCommitShort: string | null;
  gitBranch: string | null;
}

export interface TrendQueryResult {
  variant: string;
  points: TrendPoint[];
  runs: Report[];
}

export async function queryRunList(reportStore: ReportStore): Promise<RunListItem[]> {
  return (await reportStore.list()).map((report) => ({
    id: report.id,
    meta: report.meta,
    summary: report.summary,
  }));
}

export async function queryRun(reportStore: ReportStore, id: string): Promise<Report | null> {
  return reportStore.get(id);
}

export async function queryTrend(reportStore: ReportStore, variantName: string): Promise<TrendQueryResult> {
  const runs = await reportStore.findByVariant(variantName);
  const points: TrendPoint[] = runs.map((report) => {
    const summary: Partial<VariantSummary> = report.summary?.[variantName] || {};
    const meta: ReportMeta = report.meta;
    return {
      reportId: report.id,
      timestamp: meta.timestamp,
      avgCompositeScore: summary.avgCompositeScore ?? null,
      avgNumTurns: summary.avgNumTurns ?? null,
      avgCostPerSample: summary.avgCostPerSample ?? null,
      artifactHash: meta.artifactHashes?.[variantName] || null,
      gitCommitShort: meta.gitInfo?.commitShort || null,
      gitBranch: meta.gitInfo?.branch || null,
    };
  });

  return {
    variant: variantName,
    points,
    runs,
  };
}
