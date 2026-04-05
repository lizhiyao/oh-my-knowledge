import { analyzeResults } from '../analyzer.js';
import { computeReportCoverage } from '../coverage-analyzer.js';
import { applyBlindMode } from '../evaluation-core.js';
import type { Artifact, Report, VariantResult } from '../types.js';

type EvaluationResults = Record<string, Record<string, VariantResult>>;

export function finalizeEvaluationReport({
  report,
  results,
  artifacts,
  variantNames,
  blind,
  samplesPath,
}: {
  report: Report;
  results: EvaluationResults;
  artifacts: Artifact[];
  variantNames: string[];
  blind: boolean;
  samplesPath: string;
}): Report {
  report.analysis = analyzeResults(report);

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

  if (blind) {
    applyBlindMode(report, variantNames, `${variantNames.join(',')}:${samplesPath}`);
  }

  return report;
}
