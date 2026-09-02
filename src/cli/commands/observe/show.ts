import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { CliExit } from '../../lib/cli-exit.js';

export default class ObserveShow extends BaseCommand {
  static description = bilingual({
    zh: '展开 observation inbox 中某条 item 的详情。',
    en: 'Show details of a specific observation inbox item.',
  });

  static args = {
    inboxId: Args.string({
      description: bilingual({
        zh: 'inbox item ID。',
        en: 'Inbox item ID.',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    'input-dir': Flags.string({
      description: bilingual({
        zh: 'inbox 数据目录',
        en: 'Inbox data dir',
      }),
    }),
    global: Flags.boolean({
      description: bilingual({
        zh: '直接读取全局 ~/.oh-my-knowledge/observe/inbox（跳过项目级与兜底）。',
        en: 'Read directly from global ~/.oh-my-knowledge/observe/inbox (skip project-local and fallback).',
      }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveShow);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const id = args.inboxId;
      if (!id) {
        console.error(lang === 'zh' ? '用法：omk observe show <inbox_id> [--input-dir <path>]' : 'Usage: omk observe show <inbox_id> [--input-dir <path>]');
        throw new CliExit(1);
      }
      const { findObservationInboxItem, formatObservationShow, DEFAULT_OBSERVATIONS_DIR, DEFAULT_GLOBAL_OBSERVATIONS_DIR } = await import('../../../observability/inbox/index.js');
      // 显式 --input-dir 最高;否则 --global 直读全局、默认读项目(空则 findObservationInboxItem 兜底全局)。与 observe inbox 同口径。
      const dir = flags['input-dir']
        ? resolve(flags['input-dir'])
        : (flags.global ? DEFAULT_GLOBAL_OBSERVATIONS_DIR : DEFAULT_OBSERVATIONS_DIR);
      const item = findObservationInboxItem(id, dir);
      if (!item) {
        console.error(lang === 'zh' ? `未找到 observation：${id}` : `Observation not found: ${id}`);
        throw new CliExit(1);
      }
      console.log(formatObservationShow(item));
    });
  }
}
