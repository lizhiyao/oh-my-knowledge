/**
 * v0.22 — CLI rendering of Sample design science coverage block for `bench diagnose`.
 *
 * Two data sources:
 *   1. samples (loaded fresh from eval-samples file) — preferred, always up-to-date
 *   2. report.analysis.sampleQuality (persisted on report) — fallback when samples
 *      file isn't accessible (老报告 / 移动过 samples 路径)
 *
 * Rendering: ASCII bar / count list, no fancy charts, lo-fi by design.
 * Returns empty string when neither source provides data.
 */

import type { Sample, SampleQualityAggregate } from '../types/index.js';
import type { CliLang } from '../cli/i18n.js';
import { tCli } from '../cli/i18n.js';
import { buildSampleQualityAggregate } from './report-diagnostics.js';

export function renderSampleDesignCoverage(
  samples: Sample[] | undefined,
  reportAggregate: SampleQualityAggregate | undefined,
  lang: CliLang,
): string {
  // Prefer fresh samples; fallback to report.analysis.sampleQuality.
  const aggregate: SampleQualityAggregate | undefined = samples && samples.length > 0
    ? buildSampleQualityAggregate(samples)
    : reportAggregate;

  if (!aggregate) return '';

  // Total samples — from samples (preferred) or sum of difficulty distribution as fallback.
  const totalSamples = samples?.length
    ?? Object.values(aggregate.difficultyDistribution).reduce((s, n) => s + n, 0);
  if (totalSamples === 0) return '';

  const lines: string[] = [];
  lines.push(`📋 ${tCli('cli.diagnose.coverage_header', lang)}`);

  // capability — sort by count desc, top 8
  const capabilityEntries = Object.entries(aggregate.capabilityCoverage)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);
  if (capabilityEntries.length > 0) {
    const formatted = capabilityEntries.map(([name, count]) => `${name} (${count})`).join(' | ');
    const declaredPct = Math.round((aggregate.sampleCountWithCapability / totalSamples) * 100);
    lines.push(`  capability:  ${formatted}    [${aggregate.sampleCountWithCapability}/${totalSamples} 声明 = ${declaredPct}%]`);
  } else {
    lines.push(`  capability:  ${tCli('cli.diagnose.coverage_unspecified', lang)} (0/${totalSamples})`);
  }

  // difficulty
  const diffParts: string[] = [];
  for (const k of ['easy', 'medium', 'hard'] as const) {
    if (aggregate.difficultyDistribution[k] > 0) diffParts.push(`${k} (${aggregate.difficultyDistribution[k]})`);
  }
  if (aggregate.difficultyDistribution.unspecified > 0) {
    diffParts.push(`unspecified (${aggregate.difficultyDistribution.unspecified})`);
  }
  lines.push(`  difficulty:  ${diffParts.join(' | ') || tCli('cli.diagnose.coverage_unspecified', lang)}`);

  // construct
  const constructEntries = Object.entries(aggregate.constructDistribution).sort(([, a], [, b]) => b - a);
  if (constructEntries.length > 0) {
    lines.push(`  construct:   ${constructEntries.map(([name, count]) => `${name} (${count})`).join(' | ')}`);
  }

  // provenance
  const provenanceEntries = Object.entries(aggregate.provenanceBreakdown).sort(([, a], [, b]) => b - a);
  if (provenanceEntries.length > 0) {
    lines.push(`  provenance:  ${provenanceEntries.map(([name, count]) => `${name} (${count})`).join(' | ')}`);
  }

  // Avg rubric length informational line.
  if (aggregate.avgRubricLength > 0) {
    lines.push(`  avgRubric:   ${aggregate.avgRubricLength} ${tCli('cli.diagnose.coverage_chars', lang)}`);
  }

  // Hint when most samples don't declare metadata yet.
  const declaredAny = aggregate.sampleCountWithCapability + aggregate.sampleCountWithDifficulty
    + aggregate.sampleCountWithConstruct + aggregate.sampleCountWithProvenance;
  if (declaredAny === 0) {
    lines.push('');
    lines.push(`  ${tCli('cli.diagnose.coverage_hint_empty', lang)}`);
  }

  lines.push('');
  return lines.join('\n');
}
