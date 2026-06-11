import { bilingual } from '../../oclif/i18n.js';
import Init from '../init.js';

/**
 * `omk eval init` —— 项目脚手架的收敛后命名(归入 eval 命名空间)。实现完全复用 Init:继承同一套
 * args / flags / run,仅覆写命令文案并关掉「改用 eval init」的收敛提示(自己就是收敛后的名字)。
 * `omk init` 作为别名长期保留,见 commands/init.ts。
 */
export default class EvalInit extends Init {
  static description = bilingual({
    zh: '初始化 omk 项目脚手架（skills/ + eval-samples.json 模板）。',
    en: 'Scaffold an omk project (skills/ + eval-samples.json templates).',
  });

  static examples = [
    {
      description: bilingual({ zh: '在当前目录初始化', en: 'Init in current directory' }),
      command: '<%= config.bin %> eval init',
    },
    {
      description: bilingual({ zh: '在指定目录初始化', en: 'Init in specified directory' }),
      command: '<%= config.bin %> eval init my-project',
    },
  ];

  protected emitRenameHint = false;
}
