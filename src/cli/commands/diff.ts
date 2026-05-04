import { CliExit } from '../cli-exit.js';
import { resolve } from 'node:path';
import { tCli, langFromArgv, type CliLang } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { ReportStore, GitInfo, VariantSummary } from '../../types/index.js';
import { requireEvaluationReport } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  // Flag-aware split: separate positional report IDs from flags so we can support
  //   omk bench diff <id>                      — within-report sample-level
  //   omk bench diff <id1> <id2>               — cross-report variant-level (legacy)
  // both with optional --regressions-only / --threshold / --variant flags.
  const positional: string[] = [];
  const flagArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flagArgs.push(a);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flagArgs.push(next);
        i++;
      }
    } else {
      positional.push(a);
    }
  }

  if (positional.length === 0) {
    console.error(tCli('cli.help.diff_usage', lang));
    throw new CliExit(positional.length === 0 ? 1 : 0);
  }

  const { values } = parseArgsStrictOrExit({
    args: flagArgs,
    options: {
      ...COMMON_OPTIONS,
      'regressions-only': { type: 'boolean', default: false },
      threshold: { type: 'string' },
      variant: { type: 'string' },
      top: { type: 'string' },
    },
  });

  const { createFileStore } = await import('../../server/report-store.js');
  const store: ReportStore = createFileStore(resolve(DEFAULT_REPORTS_DIR));

  if (positional.length === 1) {
    await runSampleLevelDiff(positional[0], store, values, lang);
    return;
  }

  const [id1, id2]: string[] = positional;
  const r1 = requireEvaluationReport(await store.get(id1), id1, lang);
  const r2 = requireEvaluationReport(await store.get(id2), id2, lang);

  console.log(`\n  Diff: ${id1} → ${id2}\n`);

  // Git info — r1/r2 are guaranteed non-null after CliExit guards above
  const g1: GitInfo | null | undefined = r1.meta?.gitInfo;
  const g2: GitInfo | null | undefined = r2.meta?.gitInfo;
  if (g1 || g2) {
    console.log(`  Git:  ${g1?.commitShort || '?'}${g1?.dirty ? '*' : ''} (${g1?.branch || '?'}) → ${g2?.commitShort || '?'}${g2?.dirty ? '*' : ''} (${g2?.branch || '?'})`);
  }

  const { crossReportComparabilityWarnings, formatComparabilityWarnings } = await import('../../eval-core/comparability.js');
  const comparability = formatComparabilityWarnings(crossReportComparabilityWarnings(r1, r2), lang);
  if (comparability) process.stderr.write(`\n${comparability}\n\n`);

  // Per-variant comparison
  const variants: string[] = [...new Set([...(r1.meta?.variants || []), ...(r2.meta?.variants || [])])];
  for (const v of variants) {
    const s1: VariantSummary | undefined = r1.summary?.[v];
    const s2: VariantSummary | undefined = r2.summary?.[v];
    if (!s1 && !s2) continue;

    console.log(`\n  [${v}]`);

    const score1: number | string = s1?.avgCompositeScore ?? '-';
    const score2: number | string = s2?.avgCompositeScore ?? '-';
    const scoreDelta: string = typeof score1 === 'number' && typeof score2 === 'number'
      ? ` (${score2 > score1 ? '+' : ''}${(score2 - score1).toFixed(2)})`
      : '';
    console.log(`    Score:   ${score1} → ${score2}${scoreDelta}`);

    const turns1: number | string = s1?.avgNumTurns ?? '-';
    const turns2: number | string = s2?.avgNumTurns ?? '-';
    console.log(`    Turns:   ${turns1} → ${turns2}`);

    // Tool calls comparison (agent metrics)
    if (s1?.avgToolCalls != null || s2?.avgToolCalls != null) {
      const tc1: number | string = s1?.avgToolCalls ?? '-';
      const tc2: number | string = s2?.avgToolCalls ?? '-';
      console.log(`    Tools:   ${tc1} → ${tc2}`);
      const sr1 = s1?.toolSuccessRate != null ? `${(s1.toolSuccessRate * 100).toFixed(0)}%` : '-';
      const sr2 = s2?.toolSuccessRate != null ? `${(s2.toolSuccessRate * 100).toFixed(0)}%` : '-';
      console.log(`    ToolOK:  ${sr1} → ${sr2}`);
    }

    const cost1: number = s1?.avgCostPerSample ?? 0;
    const cost2: number = s2?.avgCostPerSample ?? 0;
    const reported1 = s1?.execCostReported !== false;
    const reported2 = s2?.execCostReported !== false;
    const fmt = (c: number, r: boolean): string => r ? `$${c.toFixed(4)}` : '—';
    // 任一边 not reported 就不报增减百分比(没意义)
    const costPct: string = (reported1 && reported2 && cost1 > 0)
      ? ` (${cost2 > cost1 ? '+' : ''}${(((cost2 - cost1) / cost1) * 100).toFixed(0)}%)`
      : '';
    console.log(`    Cost:    ${fmt(cost1, reported1)} → ${fmt(cost2, reported2)}${costPct}`);

    // Skill hash change
    const h1: string | undefined = r1.meta?.artifactHashes?.[v];
    const h2: string | undefined = r2.meta?.artifactHashes?.[v];
    if (h1 && h2 && h1 !== h2) {
      console.log(`    Skill:   ${h1.slice(0, 8)} → ${h2.slice(0, 8)} (changed)`);
    }
  }

  console.log('');
}

/**
 * Within-report sample-level diff. Compares two variants' scores on
 * each shared sample and surfaces the worst regressions / biggest wins.
 *
 * Default focus is variants[0] (control) vs variants[1] (treatment), but
 * `--variant` overrides which variant is the "treatment" side.
 */
async function runSampleLevelDiff(
  reportId: string,
  store: ReportStore,
  flags: Record<string, string | boolean | undefined>,
  lang: CliLang,
): Promise<void> {
  const report = requireEvaluationReport(await store.get(reportId), reportId, lang);
  const { reportComparabilityWarnings, formatComparabilityWarnings } = await import('../../eval-core/comparability.js');
  const comparability = formatComparabilityWarnings(reportComparabilityWarnings(report), lang);
  if (comparability) process.stderr.write(`\n${comparability}\n\n`);
  const variants = report.meta?.variants ?? [];
  if (variants.length < 2) {
    console.error('Sample-level diff needs at least 2 variants in the report.');
    throw new CliExit(1);
  }
  const control = variants[0];
  const treatment = (flags.variant as string | undefined) ?? variants[1];
  if (!variants.includes(treatment)) {
    console.error(`Variant "${treatment}" not in report. Available: ${variants.join(', ')}`);
    throw new CliExit(1);
  }

  const threshold = flags.threshold != null ? Number(flags.threshold) : 0;
  const regressionsOnly = Boolean(flags['regressions-only']);
  const topN = flags.top != null ? Math.max(1, Number(flags.top) || 0) : undefined;

  const rows: Array<{ id: string; cFact?: number; tFact?: number; cBeh?: number; tBeh?: number; cJudge?: number; tJudge?: number; cComp: number; tComp: number; delta: number }> = [];
  for (const entry of report.results ?? []) {
    const c = entry.variants?.[control];
    const t = entry.variants?.[treatment];
    if (!c || !t) continue;
    const cComp = c.compositeScore ?? c.llmScore ?? 0;
    const tComp = t.compositeScore ?? t.llmScore ?? 0;
    const delta = Number((tComp - cComp).toFixed(3));
    rows.push({
      id: entry.sample_id,
      cFact: c.layeredScores?.factScore, tFact: t.layeredScores?.factScore,
      cBeh: c.layeredScores?.behaviorScore, tBeh: t.layeredScores?.behaviorScore,
      cJudge: c.layeredScores?.judgeScore, tJudge: t.layeredScores?.judgeScore,
      cComp, tComp, delta,
    });
  }

  // Sort by |delta| desc so the most impactful rows surface first.
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  let filtered = rows;
  if (regressionsOnly) filtered = filtered.filter((r) => r.delta < threshold);
  if (topN !== undefined) filtered = filtered.slice(0, topN);

  console.log(`\n  Sample-level diff: ${treatment} vs ${control} (report ${reportId})`);
  if (regressionsOnly) console.log(`  Filter: regressions only (Δ < ${threshold})`);
  console.log('');
  console.log('  sample_id           Δ      composite (c→t)   fact (c→t)     behavior (c→t)   judge (c→t)');
  console.log('  ' + '-'.repeat(100));

  if (filtered.length === 0) {
    console.log(regressionsOnly ? '  (no regressions found)' : '  (no shared samples)');
    console.log('');
    return;
  }

  const fmt = (a: number | undefined, b: number | undefined): string => {
    const av = typeof a === 'number' ? a.toFixed(2) : '—';
    const bv = typeof b === 'number' ? b.toFixed(2) : '—';
    return `${av} → ${bv}`.padEnd(15);
  };
  for (const r of filtered) {
    const sign = r.delta > 0 ? '+' : '';
    const idCol = r.id.slice(0, 18).padEnd(20);
    const deltaCol = `${sign}${r.delta.toFixed(2)}`.padEnd(7);
    const compCol = `${r.cComp.toFixed(2)} → ${r.tComp.toFixed(2)}`.padEnd(17);
    console.log(`  ${idCol}${deltaCol}${compCol}${fmt(r.cFact, r.tFact)} ${fmt(r.cBeh, r.tBeh)} ${fmt(r.cJudge, r.tJudge)}`);
  }
  console.log('');
  console.log(`  Showing ${filtered.length} of ${rows.length} samples · sorted by |Δ|`);
  if (regressionsOnly) {
    const total = rows.length;
    const reg = rows.filter((r) => r.delta < threshold).length;
    console.log(`  Regression rate: ${reg}/${total} samples (${total > 0 ? ((reg / total) * 100).toFixed(0) : 0}%)`);
  }
  console.log('');
}
