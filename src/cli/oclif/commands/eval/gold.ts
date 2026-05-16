import { Command, Flags } from '@oclif/core';
import { bilingual, resolveLang } from '../../i18n.js';

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
    }),
  };

  async run(): Promise<void> {
    await this.parse(EvalGold);
    // 直接打 legacy usage(--lang 决定语言)+ exit 1。不委托 execute(argv) 因为
    // legacy [sub, ...rest] = argv 会把 --lang 当 sub,这条 path 没业务,只打 usage。
    const lang = resolveLang(process.argv);
    const { usage } = await import('../../../commands/eval-gold.js');
    console.log(usage(lang));
    this.exit(1);
  }
}
