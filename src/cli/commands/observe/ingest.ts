import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { CliExit } from '../../lib/cli-exit.js';

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
        zh: '输出目录，默认 .omk/observe-inbox（项目级，相对于 cwd）。',
        en: 'Output dir, default .omk/observe-inbox (project-local, relative to cwd).',
      }),
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
      const { buildObservationInboxReport, saveObservationInboxReport, DEFAULT_OBSERVATIONS_DIR } = await import('../../../observability/inbox.js');
      const outDir = resolve(outDirRaw ?? DEFAULT_OBSERVATIONS_DIR);
      const { loadObservationReviewState } = await import('../../../observability/review-state.js');
      const { buildObserveDiagnosticsFromReport } = await import('../../../diagnosis/observe-producer.js');
      const report = buildObservationInboxReport(tracePath, { reviewState: loadObservationReviewState(outDir) });
      report.diagnostics = buildObserveDiagnosticsFromReport(report);
      const path = saveObservationInboxReport(report, outDir);
      console.log(JSON.stringify(report, null, 2));
      process.stderr.write(lang === 'zh'
        ? `observe inbox 已写入: ${path}\n`
        : `observe inbox written to: ${path}\n`);
    });
  }
}
