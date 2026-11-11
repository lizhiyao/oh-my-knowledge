import { BaseCommand } from '../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';

export default class KnowTopic extends BaseCommand {
  static description = bilingual({
    zh: '知识工作：list／retrieve／show／sources／extract／revise／review／runs／migrate。',
    en: 'Knowledge work: list / retrieve / show / sources / extract / revise / review / runs / migrate.',
  });
  static flags = { lang: LANG_FLAG };

  async run(): Promise<void> {
    await this.parse(KnowTopic);
    const loaded = this.config.findCommand(this.id!, { must: true });
    const HelpClass = (await import('../../oclif/help.js')).default;
    await new HelpClass(this.config).showCommandHelp(loaded);
    this.exit(1);
  }
}
