import { resolve } from 'node:path';
import { CliExit } from '../cli-exit.js';
import { langFromArgv, type CliLang } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { GitInfo, ReportStore, VariantSummary } from '../../types/index.js';
import { requireEvaluationReport } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const { values, positionals } = parseArgsStrictOrExit({
    args: argv,
    allowPositionals: true,
    options: {
      ...COMMON_OPTIONS,
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      'regressions-only': { type: 'boolean', default: false },
      threshold: { type: 'string' },
      variant: { type: 'string' },
      top: { type: 'string' },
    },
  });

  if (positionals.length === 0) {
    console.error(usage(lang));
    throw new CliExit(1);
  }

  const { createFileStore } = await import('../../server/report-store.js');
  const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));

  if (positionals.length === 1) {
    await runSampleLevelDiff(positionals[0], store, values, lang);
    return;
  }

  if (positionals.length > 2) {
    console.error(usage(lang));
    throw new CliExit(1);
  }

  const [id1, id2] = positionals;
  const r1 = requireEvaluationReport(await store.get(id1), id1, lang);
  const r2 = requireEvaluationReport(await store.get(id2), id2, lang);

  console.log(`\n  Diff: ${id1} → ${id2}\n`);
  const g1: GitInfo | null | undefined = r1.meta?.gitInfo;
  const g2: GitInfo | null | undefined = r2.meta?.gitInfo;
  if (g1 || g2) {
    console.log(`  Git:  ${g1?.commitShort || '?'}${g1?.dirty ? '*' : ''} (${g1?.branch || '?'}) → ${g2?.commitShort || '?'}${g2?.dirty ? '*' : ''} (${g2?.branch || '?'})`);
  }

  const { crossReportComparabilityWarnings, formatComparabilityWarnings } = await import('../../eval-core/comparability.js');
  const comparability = formatComparabilityWarnings(crossReportComparabilityWarnings(r1, r2), lang);
  if (comparability) process.stderr.write(`\n${comparability}\n\n`);

  const variants = [...new Set([...(r1.meta?.variants || []), ...(r2.meta?.variants || [])])];
  for (const variant of variants) {
    const s1: VariantSummary | undefined = r1.summary?.[variant];
    const s2: VariantSummary | undefined = r2.summary?.[variant];
    if (!s1 && !s2) continue;

    console.log(`\n  [${variant}]`);
    const score1: number | string = s1?.avgCompositeScore ?? '-';
    const score2: number | string = s2?.avgCompositeScore ?? '-';
    const scoreDelta = typeof score1 === 'number' && typeof score2 === 'number'
      ? ` (${score2 > score1 ? '+' : ''}${(score2 - score1).toFixed(2)})`
      : '';
    console.log(`    Score:   ${score1} → ${score2}${scoreDelta}`);
    console.log(`    Turns:   ${s1?.avgNumTurns ?? '-'} → ${s2?.avgNumTurns ?? '-'}`);

    if (s1?.avgToolCalls != null || s2?.avgToolCalls != null) {
      console.log(`    Tools:   ${s1?.avgToolCalls ?? '-'} → ${s2?.avgToolCalls ?? '-'}`);
      const sr1 = s1?.toolSuccessRate != null ? `${(s1.toolSuccessRate * 100).toFixed(0)}%` : '-';
      const sr2 = s2?.toolSuccessRate != null ? `${(s2.toolSuccessRate * 100).toFixed(0)}%` : '-';
      console.log(`    ToolOK:  ${sr1} → ${sr2}`);
    }

    const cost1 = s1?.avgCostPerSample ?? 0;
    const cost2 = s2?.avgCostPerSample ?? 0;
    const reported1 = s1?.execCostReported !== false;
    const reported2 = s2?.execCostReported !== false;
    const fmtCost = (cost: number, reported: boolean): string => reported ? `$${cost.toFixed(4)}` : '—';
    const costPct = reported1 && reported2 && cost1 > 0
      ? ` (${cost2 > cost1 ? '+' : ''}${(((cost2 - cost1) / cost1) * 100).toFixed(0)}%)`
      : '';
    console.log(`    Cost:    ${fmtCost(cost1, reported1)} → ${fmtCost(cost2, reported2)}${costPct}`);

    const h1 = r1.meta?.artifactHashes?.[variant];
    const h2 = r2.meta?.artifactHashes?.[variant];
    if (h1 && h2 && h1 !== h2) {
      console.log(`    Skill:   ${h1.slice(0, 8)} → ${h2.slice(0, 8)} (changed)`);
    }
  }
  console.log('');
}

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
    rows.push({
      id: entry.sample_id,
      cFact: c.layeredScores?.factScore,
      tFact: t.layeredScores?.factScore,
      cBeh: c.layeredScores?.behaviorScore,
      tBeh: t.layeredScores?.behaviorScore,
      cJudge: c.layeredScores?.judgeScore,
      tJudge: t.layeredScores?.judgeScore,
      cComp,
      tComp,
      delta: Number((tComp - cComp).toFixed(3)),
    });
  }

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

  const fmtLayer = (a: number | undefined, b: number | undefined): string => {
    const av = typeof a === 'number' ? a.toFixed(2) : '—';
    const bv = typeof b === 'number' ? b.toFixed(2) : '—';
    return `${av} → ${bv}`.padEnd(15);
  };
  for (const row of filtered) {
    const sign = row.delta > 0 ? '+' : '';
    console.log(
      `  ${row.id.slice(0, 18).padEnd(20)}`
      + `${`${sign}${row.delta.toFixed(2)}`.padEnd(7)}`
      + `${`${row.cComp.toFixed(2)} → ${row.tComp.toFixed(2)}`.padEnd(17)}`
      + `${fmtLayer(row.cFact, row.tFact)} ${fmtLayer(row.cBeh, row.tBeh)} ${fmtLayer(row.cJudge, row.tJudge)}`,
    );
  }
  console.log('');
  console.log(`  Showing ${filtered.length} of ${rows.length} samples · sorted by |Δ|`);
  if (regressionsOnly) {
    const total = rows.length;
    const regressions = rows.filter((r) => r.delta < threshold).length;
    console.log(`  Regression rate: ${regressions}/${total} samples (${total > 0 ? ((regressions / total) * 100).toFixed(0) : 0}%)`);
  }
  console.log('');
}

function usage(lang: CliLang): string {
  return lang === 'zh'
    ? [
        '用法：',
        '  omk export diff <report-id> [--variant <name>] [--regressions-only] [--top <n>]',
        '  omk export diff <report-id-a> <report-id-b>',
      ].join('\n')
    : [
        'Usage:',
        '  omk export diff <report-id> [--variant <name>] [--regressions-only] [--top <n>]',
        '  omk export diff <report-id-a> <report-id-b>',
      ].join('\n');
}
