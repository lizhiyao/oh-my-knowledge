import { resolve } from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import { bilingual, resolveLang } from '../../oclif/i18n.js';
import { CliExit } from '../../lib/cli-exit.js';

export default class ObserveIngest extends Command {
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
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      default: 'zh',
    }),
    'output-dir': Flags.string({
      description: bilingual({
        zh: '输出目录，默认 ~/.oh-my-knowledge/observations',
        en: 'Output dir, default ~/.oh-my-knowledge/observations',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveIngest);
    const lang = resolveLang(process.argv);
    try {
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
      const { buildObservationInboxReport, saveObservationInboxReport, DEFAULT_OBSERVATIONS_DIR } = await import('../../../observability/inbox.js');
      // `??` 而非 `||`:`--output-dir ''` 显式空串应当报错或走 oclif 校验,
      // 不该悄悄 fallback 到 default(`||` 把空串当 falsy 触发 fallback,掩盖 typo)。
      const outDir = resolve(flags['output-dir'] ?? DEFAULT_OBSERVATIONS_DIR);
      const { loadObservationReviewState } = await import('../../../observability/review-state.js');
      const report = buildObservationInboxReport(tracePath, { reviewState: loadObservationReviewState(outDir) });
      const path = saveObservationInboxReport(report, outDir);
      console.log(JSON.stringify(report, null, 2));
      process.stderr.write(lang === 'zh'
        ? `observe inbox 已写入: ${path}\n`
        : `observe inbox written to: ${path}\n`);
    } catch (err) {
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
        return;
      }
      throw err;
    }
  }
}
