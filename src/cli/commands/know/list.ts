import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { KnowCommand, knowJsonFlag, knowWorkspaceFlag } from '../../lib/know-command.js';

export default class KnowList extends KnowCommand {
  static description = bilingual({ zh: '浏览当前知识。', en: 'List current knowledge.' });
  static flags = { workspace: knowWorkspaceFlag, json: knowJsonFlag, lang: LANG_FLAG };

  async run(): Promise<void> {
    const { flags } = await this.parse(KnowList);
    await this.executeKnowOperation({ operation: 'list' }, flags);
  }
}
