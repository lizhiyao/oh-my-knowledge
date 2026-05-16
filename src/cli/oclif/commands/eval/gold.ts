import { Command, Flags } from '@oclif/core';
import { bilingual } from '../../i18n.js';

// `omk eval gold`(无 sub-sub)入口 — 打用法 + exit 1。
//
// 没这个 Command 的话 oclif 会把 eval gold 当 topic-only,bare `omk eval gold`
// 走默认 topic help 后 exit 0,跟 legacy execute() 的 CliExit(1) 行为有回归。
// 加这层薄壳让 missing sub-sub 仍然 exit 1,CI / 脚本能识别错用。
//
// `omk eval gold --help` 仍走 oclif Help class,LangAwareHelp 列出 init /
// validate / compare 三个 sub-sub。

export default class EvalGold extends Command {
  static description = bilingual({
    zh: '管理 human-gold 标注集（init / validate / compare 三个子命令）。',
    en: 'Manage human-gold annotation datasets (sub-commands: init / validate / compare).',
  });

  static flags = {
    lang: Flags.string({
      description: bilingual({
        zh: '输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。',
        en: 'Output language zh|en. Priority: CLI > OMK_LANG env > zh.',
      }),
      options: ['zh', 'en'],
      default: 'zh',
      env: 'OMK_LANG',
    }),
  };

  async run(): Promise<void> {
    await this.parse(EvalGold);
    // 委托 legacy execute(argv=[])打 usage + 抛 CliExit(1)。lang 由 legacy
    // 自己从 process.argv 解析,这里不重复抽。
    const { execute } = await import('../../../commands/eval-gold.js');
    const { CliExit } = await import('../../../cli-exit.js');
    try {
      await execute([]);
    } catch (err) {
      if (err instanceof CliExit) {
        this.exit(err.code);
      }
      throw err;
    }
    // 防御性 — execute([]) 永远 throw,但 TS 不知道
    this.exit(1);
  }
}
