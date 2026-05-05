import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CliExit } from '../cli-exit.js';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { EvaluationReport, ReportDocument, VariantSummary } from '../../types/index.js';
import { execute as diff } from './export-diff.js';
import { execute as saturation } from './export-saturation.js';
import { execute as verdictCommand } from './export-verdict.js';

type ExportFormat = 'html' | 'markdown' | 'github-summary';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const [sub, ...rest] = argv;
  if (sub === 'diff') {
    await diff(rest);
    return;
  }
  if (sub === 'verdict') {
    await verdictCommand(rest);
    return;
  }
  if (sub === 'saturation') {
    await saturation(rest);
    return;
  }

  const { values, positionals } = parseArgsStrictOrExit({
    args: argv,
    allowPositionals: true,
    options: {
      ...COMMON_OPTIONS,
      format: { type: 'string', default: 'html' },
      out: { type: 'string' },
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
    },
  });

  const id = positionals[0];
  if (!id) {
    console.log(tCli('cli.help.export', lang).trim());
    throw new CliExit(1);
  }

  const format = String(values.format) as ExportFormat;
  if (!['html', 'markdown', 'github-summary'].includes(format)) {
    console.error(lang === 'zh'
      ? `不支持的导出格式：${String(values.format)}。可用格式：html / markdown / github-summary。`
      : `Unsupported export format: ${String(values.format)}. Available: html / markdown / github-summary.`);
    throw new CliExit(2);
  }

  const { createFileStore } = await import('../../server/report-store.js');
  const store = createFileStore(resolve(values['reports-dir'] as string));
  const report = await store.get(id);
  if (!report) {
    console.error(tCli('cli.common.report_not_found', lang, { id }));
    throw new CliExit(1);
  }

  if (format === 'html') {
    const { renderReportDocumentDetail } = await import('../../renderer/html-renderer.js');
    const outPath = resolve((values.out as string | undefined) ?? `${id}.html`);
    writeFileSync(outPath, renderReportDocumentDetail(report));
    console.log(lang === 'zh' ? `已导出 HTML：${outPath}` : `HTML exported to: ${outPath}`);
    return;
  }

  const verdict = report.kind === 'evaluation' ? await renderVerdict(report) : 'n/a';
  const body = format === 'github-summary'
    ? renderGithubSummary(report, lang, verdict)
    : renderMarkdown(report, lang, verdict);
  const out = values.out as string | undefined;
  if (out) {
    const outPath = resolve(out);
    writeFileSync(outPath, body);
    console.log(lang === 'zh' ? `已导出：${outPath}` : `Exported to: ${outPath}`);
    return;
  }
  console.log(body);
}

async function renderVerdict(report: EvaluationReport): Promise<string> {
  const { computeVerdict } = await import('../../eval-core/verdict.js');
  return computeVerdict(report).headline;
}

function renderGithubSummary(report: ReportDocument, lang: 'zh' | 'en', verdict: string): string {
  if (report.kind !== 'evaluation') {
    return renderBatchMarkdown(report, lang);
  }
  const lines = [
    lang === 'zh' ? '## omk 评测摘要' : '## omk Evaluation Summary',
    '',
    `- ${lang === 'zh' ? '报告' : 'Report'}：\`${report.id}\``,
    `- ${lang === 'zh' ? '结论' : 'Verdict'}：${verdict}`,
    `- ${lang === 'zh' ? '样本数' : 'Samples'}：${report.meta.sampleCount}`,
    `- ${lang === 'zh' ? '模型' : 'Model'}：${report.meta.executor}:${report.meta.model}`,
    `- ${lang === 'zh' ? '版本' : 'Variants'}：${report.meta.variants.join(' / ')}`,
    '',
    renderVariantTable(report, lang),
    '',
    renderAuditBlock(report, lang),
  ];
  return lines.join('\n').trim();
}

function renderMarkdown(report: ReportDocument, lang: 'zh' | 'en', verdict: string): string {
  if (report.kind !== 'evaluation') {
    return renderBatchMarkdown(report, lang);
  }
  const lines = [
    `# ${lang === 'zh' ? 'omk 评测报告' : 'omk Evaluation Report'}：${report.id}`,
    '',
    `- ${lang === 'zh' ? '结论' : 'Verdict'}：${verdict}`,
    `- ${lang === 'zh' ? '时间' : 'Timestamp'}：${report.meta.timestamp}`,
    `- ${lang === 'zh' ? '样本数' : 'Samples'}：${report.meta.sampleCount}`,
    `- ${lang === 'zh' ? '执行器' : 'Executor'}：${report.meta.executor}`,
    `- ${lang === 'zh' ? '模型' : 'Model'}：${report.meta.model}`,
    '',
    `## ${lang === 'zh' ? '版本摘要' : 'Variant Summary'}`,
    '',
    renderVariantTable(report, lang),
    '',
    `## ${lang === 'zh' ? '审计信息' : 'Audit Evidence'}`,
    '',
    renderAuditBlock(report, lang),
  ];
  return lines.join('\n').trim();
}

function renderBatchMarkdown(report: ReportDocument, lang: 'zh' | 'en'): string {
  return [
    `# ${lang === 'zh' ? 'omk 批量评测报告' : 'omk Batch Evaluation Report'}：${report.id}`,
    '',
    `- ${lang === 'zh' ? '类型' : 'Kind'}：${report.kind}`,
    `- ${lang === 'zh' ? '时间' : 'Timestamp'}：${report.meta?.timestamp ?? 'n/a'}`,
  ].join('\n');
}

function renderVariantTable(report: EvaluationReport, lang: 'zh' | 'en'): string {
  const header = lang === 'zh'
    ? '| 版本 | 样本 | 成功 | 综合分 | 成本 |\n|---|---:|---:|---:|---:|'
    : '| Variant | Samples | Success | Score | Cost |\n|---|---:|---:|---:|---:|';
  const rows = Object.entries(report.summary ?? {}).map(([variant, s]) => {
    const summary = s as VariantSummary;
    const score = summary.avgCompositeScore != null ? summary.avgCompositeScore.toFixed(2) : '-';
    const cost = summary.totalCostUSD != null ? `$${summary.totalCostUSD.toFixed(4)}` : '-';
    return `| ${variant} | ${summary.totalSamples} | ${summary.successCount} | ${score} | ${cost} |`;
  });
  return [header, ...rows].join('\n');
}

function renderAuditBlock(report: EvaluationReport, lang: 'zh' | 'en'): string {
  const hashes = Object.entries(report.meta.artifactHashes ?? {})
    .map(([name, hash]) => `  - ${name}: \`${hash}\``)
    .join('\n') || (lang === 'zh' ? '  - 未记录' : '  - not recorded');
  return [
    `- ${lang === 'zh' ? 'CLI 版本' : 'CLI version'}：${report.meta.cliVersion}`,
    `- ${lang === 'zh' ? 'Node 版本' : 'Node version'}：${report.meta.nodeVersion}`,
    `- ${lang === 'zh' ? '评委提示词指纹' : 'Judge prompt hash'}：${report.meta.judgePromptHash ?? 'n/a'}`,
    `- ${lang === 'zh' ? '样本指纹数量' : 'Sample fingerprints'}：${Object.keys(report.meta.sampleHashes ?? {}).length}`,
    `- ${lang === 'zh' ? 'artifact 指纹' : 'Artifact fingerprints'}：\n${hashes}`,
  ].join('\n');
}
