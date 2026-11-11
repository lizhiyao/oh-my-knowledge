import { Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { KnowCommand, knowJsonFlag, knowWorkspaceFlag } from '../../lib/know-command.js';

export default class KnowRetrieve extends KnowCommand {
  static description = bilingual({ zh: '按任务检索可复用知识。', en: 'Retrieve reusable knowledge for a task.' });
  static flags = {
    workspace: knowWorkspaceFlag,
    query: Flags.string({ description: bilingual({ zh: '任务问题或检索词。', en: 'Task question or retrieval terms.' }) }),
    'max-bytes': Flags.integer({ min: 1024, max: 1048576, description: bilingual({ zh: '输出 UTF-8 字节预算。', en: 'Output UTF-8 byte budget.' }) }),
    'include-candidates': Flags.boolean({ description: bilingual({ zh: '显式纳入未保留候选，不表示内容已证实。', en: 'Explicitly include unretained candidates without verifying truth.' }) }),
    snapshot: Flags.string({ description: bilingual({ zh: '来源 snapshot UUID，须配 --source-version。', en: 'Source snapshot UUID; requires --source-version.' }) }),
    'source-version': Flags.string({ description: bilingual({ zh: '精确来源 SHA-256，须配 --snapshot。', en: 'Exact source SHA-256; requires --snapshot.' }) }),
    analysis: Flags.string({ description: bilingual({ zh: '实体分析 UUID。', en: 'Entity analysis UUID.' }) }),
    'entity-revision': Flags.string({ description: bilingual({ zh: '实体分析修订 UUID。', en: 'Entity analysis revision UUID.' }) }),
    'entity-id': Flags.string({ description: bilingual({ zh: '精确实体 ID，须配 --analysis 和 --entity-revision。', en: 'Exact entity ID; requires --analysis and --entity-revision.' }) }),
    format: Flags.string({ options: ['json', 'text'], description: bilingual({ zh: '输出 JSON 或正文阅读视图。', en: 'Output JSON or the text reading view.' }) }),
    json: knowJsonFlag,
    lang: LANG_FLAG,
  };
  static examples = ['<%= config.bin %> know retrieve --workspace ./knowledge --query "初始化时的条件是什么？" --format text'];

  async run(): Promise<void> {
    const { flags } = await this.parse(KnowRetrieve);
    if (flags.format === 'text' && flags.json) this.error(this.t('--format text 不可与 --json 同用。', '--format text cannot be combined with --json.'), { exit: 2 });
    await this.executeKnowOperation({
      operation: 'retrieve',
      query: this.required(flags.query, 'query'),
      maxBytes: flags['max-bytes'],
      includeCandidates: flags['include-candidates'],
      snapshot: flags.snapshot,
      sourceVersion: flags['source-version'],
      analysisId: flags.analysis,
      entityRevisionId: flags['entity-revision'],
      entityId: flags['entity-id'],
      ...(flags.format === undefined ? {} : { format: flags.format as 'json' | 'text' }),
    }, { ...flags, format: flags.format as 'json' | 'text' | undefined });
  }
}
