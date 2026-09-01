import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { CliExit } from '../../lib/cli-exit.js';
import { shellQuoteArg } from '../../../shared/shell-quote.js';
import type { ObservationInboxReport } from '../../../observability/contracts/inbox.js';

export function formatIngestSummary(report: ObservationInboxReport, lang: 'zh' | 'en'): string {
  const severityCounts = {
    high: 0,
    medium: 0,
    low: 0,
    noise: 0,
  };
  for (const item of report.items) severityCounts[item.severity]++;

  const sessions = report.meta.sessionCount ?? 0;
  if (lang === 'zh') {
    return `observe inbox：会话 ${sessions} · 片段 ${report.meta.segmentCount} · 信号 ${report.meta.itemCount}（高 ${severityCounts.high} / 中 ${severityCounts.medium} / 低 ${severityCounts.low} / 噪声 ${severityCounts.noise}）`;
  }
  return `observe inbox: ${sessions} sessions · ${report.meta.segmentCount} segments · ${report.meta.itemCount} signals (high ${severityCounts.high} / medium ${severityCounts.medium} / low ${severityCounts.low} / noise ${severityCounts.noise})`;
}

export default class ObserveIngest extends BaseCommand {
  static description = bilingual({
    zh: '把 trace 目录 ingest 成 observation inbox 报告。',
    en: 'Ingest trace dir into observation inbox report.',
  });

  static args = {
    traceDir: Args.string({
      description: bilingual({
        zh: 'trace 目录路径。',
        en: 'Trace dir path.',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    'output-dir': Flags.string({
      description: bilingual({
        zh: '输出目录，默认 .omk/observe-inbox（项目级，相对于 cwd；--global 写全局）。',
        en: 'Output dir, default .omk/observe-inbox (project-local, relative to cwd; --global writes global).',
      }),
    }),
    global: Flags.boolean({
      description: bilingual({
        zh: '写入全局 ~/.oh-my-knowledge/observe-inbox，而非项目 .omk/observe-inbox。',
        en: 'Write to global ~/.oh-my-knowledge/observe-inbox instead of project .omk/observe-inbox.',
      }),
      default: false,
    }),
    json: Flags.boolean({
      description: bilingual({
        zh: '把完整 observation inbox 报告输出到 stdout；默认只输出摘要。',
        en: 'Print the full observation inbox report to stdout; defaults to a concise summary.',
      }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveIngest);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const dir = args.traceDir;
      if (!dir) {
        // oclif Args.required:true 已经保证非空,这里仍兜底防御。
        throw new CliExit(1);
      }
      const tracePath = resolve(dir);
      const { existsSync } = await import('node:fs');
      if (!existsSync(tracePath)) {
        console.error(lang === 'zh'
          ? `trace 路径不存在: ${tracePath}`
          : `Trace path does not exist: ${tracePath}`);
        throw new CliExit(1);
      }
      // `--output-dir ''` 显式空串拒绝:`resolve('')` 在 Node 里等价于 `process.cwd()`,
      // 没拦住就会让 shell 里没展开的变量(`--output-dir "$DIR"` 而 `$DIR` 未设)把
      // observation 报告写到任意 cwd。oclif `Flags.string({})` 没拦空串,这里业务侧
      // 显式判 + exit 2(POSIX usage error 约定),跟其它 parse error 行为一致。
      const outDirRaw = flags['output-dir'];
      if (outDirRaw !== undefined && outDirRaw.trim() === '') {
        console.error(lang === 'zh'
          ? '错误：--output-dir 不能为空字符串。'
          : 'Error: --output-dir must not be an empty string.');
        throw new CliExit(2);
      }
      const {
        buildObservationInboxReport,
        compactObservationInboxReport,
        saveObservationInboxReport,
        DEFAULT_PROJECT_OBSERVATIONS_DIR,
        DEFAULT_GLOBAL_OBSERVATIONS_DIR,
      } = await import('../../../observability/inbox.js');
      // 显式 --output-dir 最高;否则 --global 写全局、默认写项目(读侧 loadObservationInboxReports 会从项目兜底到全局)。
      const defaultDir = flags.global ? DEFAULT_GLOBAL_OBSERVATIONS_DIR : DEFAULT_PROJECT_OBSERVATIONS_DIR;
      const outDir = resolve(outDirRaw ?? defaultDir);
      const { loadObservationReviewState } = await import('../../../observability/review-state.js');
      const { buildObserveDiagnosticsFromReport } = await import('../../../diagnosis/observe-producer.js');
      const report = buildObservationInboxReport(tracePath, { reviewState: loadObservationReviewState(outDir) });
      report.diagnostics = buildObserveDiagnosticsFromReport(report);
      const path = saveObservationInboxReport(report, outDir);
      console.log(flags.json
        ? JSON.stringify(compactObservationInboxReport(report), null, 2)
        : formatIngestSummary(report, lang));
      const { traceIngestionNotices } = await import('../../../observability/trace/ingestion.js');
      for (const notice of traceIngestionNotices(report.meta.ingestion, lang)) {
        process.stderr.write(`${notice.text}\n`);
      }
      const inboxCommand = `omk observe inbox --input-dir ${shellQuoteArg(outDir)}`;
      const sampleCommand = `omk sample --from-traces --observations-dir ${shellQuoteArg(outDir)}`;
      process.stderr.write(lang === 'zh'
        ? `observe inbox 已写入：${path}\n下一步：${inboxCommand}\n确认高风险或抽样信号后，可生成评测用例草稿：${sampleCommand}\n`
        : `observe inbox written to: ${path}\nNext: ${inboxCommand}\nAfter confirming high-risk / sampled signals, draft regression samples: ${sampleCommand}\n`);
    });
  }
}
