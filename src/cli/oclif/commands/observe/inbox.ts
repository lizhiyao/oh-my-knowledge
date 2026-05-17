// oclif 版 observe inbox — 透传 argv 给生产 executeInbox()。

import { Command, Flags } from '@oclif/core';
import { bilingual } from '../../i18n.js';
import { runLegacyCommand } from '../../run-legacy.js';

export default class ObserveInbox extends Command {
  static description = bilingual({
    zh: '查询 observation inbox(skill 调用洞察）。',
    en: 'Query observation inbox (skill invocation insights).',
  });

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      default: 'zh',
    }),
    'input-dir': Flags.string({
      description: bilingual({
        zh: 'inbox 数据目录，默认 ~/.oh-my-knowledge/observations',
        en: 'Inbox data dir, default ~/.oh-my-knowledge/observations',
      }),
    }),
    skill: Flags.string({
      description: bilingual({ zh: '只看指定 skill', en: 'Filter to specific skill' }),
    }),
    limit: Flags.string({
      description: bilingual({ zh: '限制条数，默认 20', en: 'Result limit, default 20' }),
    }),
    explore: Flags.string({
      description: bilingual({
        zh: '抽样 N 条 medium/low 长尾（replaces limit）',
        en: 'Sample N medium/low long-tail items (replaces limit)',
      }),
    }),
    'include-noise': Flags.boolean({
      description: bilingual({
        zh: 'explore 时也包含 noise 桶',
        en: 'Include noise bucket in explore',
      }),
      default: false,
    }),
    'by-skill': Flags.boolean({
      description: bilingual({
        zh: '按 skill 聚合输出',
        en: 'Aggregate output by skill',
      }),
      default: false,
    }),
    json: Flags.boolean({
      description: bilingual({ zh: 'JSON 格式输出', en: 'JSON output' }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    await this.parse(ObserveInbox);
    await runLegacyCommand(this, async () => {
      const { executeInbox } = await import('../../../commands/observe.js');
      await executeInbox(this.argv);
    });
  }
}
