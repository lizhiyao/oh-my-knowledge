/**
 * Knowledge coverage analyzer.
 * Computes coverage rates by comparing consumed knowledge against the full index.
 */

import type { ToolCallInfo, ResultEntry, Report } from './types.js';
import type { KnowledgeIndex, KnowledgeEntry } from './knowledge-index.js';
import { extractKnowledgeConsumption, normalizeKnowledgePath } from './knowledge-tracker.js';
import { buildFullKnowledgeIndex } from './knowledge-index.js';

export interface CoverageEntry {
  path: string;
  type: KnowledgeEntry['type'];
  accessed: boolean;
  accessCount: number;
  lineCount?: number;
}

export interface CoverageReport {
  entries: CoverageEntry[];
  filesCovered: number;
  filesTotal: number;
  fileCoverageRate: number;
  uncoveredFiles: string[];
  grepPatternsUsed: number;
  overallRate: number;
}

/**
 * Compute knowledge coverage for a single variant across all samples.
 */
export function computeCoverage(
  results: ResultEntry[],
  variant: string,
  index: KnowledgeIndex,
  cwd?: string | null,
): CoverageReport {
  // Aggregate all tool calls for this variant across samples
  const allToolCalls: ToolCallInfo[] = [];
  for (const result of results) {
    const vr = result.variants?.[variant];
    if (vr?.toolCalls) allToolCalls.push(...vr.toolCalls);
  }

  const consumption = extractKnowledgeConsumption(allToolCalls);

  // Normalize consumed file paths
  const consumedNormalized = new Set(
    consumption.filesRead.map((f) => normalizeKnowledgePath(f, cwd)),
  );

  // Match index entries against consumed files
  const entries: CoverageEntry[] = index.entries.map((entry) => {
    // Check if this entry was accessed — match by exact path or by filename
    const accessed = consumedNormalized.has(entry.path) ||
      [...consumedNormalized].some((consumed) =>
        consumed.endsWith('/' + entry.path) || consumed.endsWith(entry.path),
      );

    const accessCount = accessed
      ? consumption.filesRead.filter((f) => {
        const norm = normalizeKnowledgePath(f, cwd);
        return norm === entry.path || norm.endsWith('/' + entry.path) || norm.endsWith(entry.path);
      }).length
      : 0;

    return {
      path: entry.path,
      type: entry.type,
      accessed,
      accessCount,
      lineCount: entry.lineCount,
    };
  });

  const filesCovered = entries.filter((e) => e.accessed).length;
  const filesTotal = entries.length;
  const fileCoverageRate = filesTotal > 0 ? Number((filesCovered / filesTotal).toFixed(2)) : 0;
  const uncoveredFiles = entries.filter((e) => !e.accessed).map((e) => e.path);
  const grepPatternsUsed = consumption.grepPatterns.length + consumption.bashGrepPatterns.length;

  // Overall rate: file coverage 60% + grep activity bonus 40%
  const grepBonus = grepPatternsUsed > 0 ? Math.min(1, grepPatternsUsed / Math.max(5, filesTotal)) : 0;
  const overallRate = Number((fileCoverageRate * 0.6 + grepBonus * 0.4).toFixed(2));

  return {
    entries,
    filesCovered,
    filesTotal,
    fileCoverageRate,
    uncoveredFiles,
    grepPatternsUsed,
    overallRate,
  };
}

/**
 * Compute coverage reports for all variants in a report.
 * Returns a map of variant → CoverageReport.
 */
export function computeReportCoverage(
  report: Report,
  artifactContents: Record<string, string | null>,
  cwds: Record<string, string | null>,
): Record<string, CoverageReport> {
  const coverageMap: Record<string, CoverageReport> = {};

  for (const variant of report.meta.variants) {
    const content = artifactContents[variant] || null;
    const cwd = cwds[variant] || null;

    // Build knowledge index for this variant
    const index = buildFullKnowledgeIndex(content, cwd);
    if (index.totalFiles === 0) continue;

    coverageMap[variant] = computeCoverage(report.results, variant, index, cwd);
  }

  return coverageMap;
}
