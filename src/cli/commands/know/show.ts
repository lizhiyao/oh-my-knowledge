import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { KnowCommand, knowJsonFlag, knowWorkspaceFlag } from '../../lib/know-command.js';

const actions = ['knowledge', 'entities', 'relations', 'relation', 'graph'] as const;
type Action = typeof actions[number];

export default class KnowShow extends KnowCommand {
  static description = bilingual({ zh: '按精确身份读回知识、实体、关系或图。', en: 'Read exact knowledge, entities, relations, or graph projections.' });
  static args = { action: Args.string({ default: 'knowledge', options: actions, description: bilingual({ zh: '读取的资源类型。', en: 'Resource type to read.' }) }) };
  static flags = {
    workspace: knowWorkspaceFlag,
    id: Flags.string({ description: bilingual({ zh: '知识或关系 ID。', en: 'Knowledge or relation ID.' }) }),
    revision: Flags.string({ description: bilingual({ zh: '精确修订 ID。', en: 'Exact revision ID.' }) }),
    'body-digest': Flags.string({ description: bilingual({ zh: 'relations：精确正文 SHA-256。', en: 'relations: exact body SHA-256.' }) }),
    analysis: Flags.string({ description: bilingual({ zh: 'entities：实体分析 UUID；省略时查询目录。', en: 'entities: analysis UUID; omit to query the catalog.' }) }),
    'entity-revision': Flags.string({ description: bilingual({ zh: 'entities：实体分析修订 UUID。', en: 'entities: entity analysis revision UUID.' }) }),
    query: Flags.string({ description: bilingual({ zh: 'entities：目录查询。', en: 'entities: catalog query.' }) }),
    'identity-status': Flags.string({ options: ['all', 'proposed', 'unresolved'], description: bilingual({ zh: 'entities：身份状态筛选。', en: 'entities: identity-status filter.' }) }),
    'source-status': Flags.string({ options: ['all', 'available', 'unavailable'], description: bilingual({ zh: 'entities：来源可读状态筛选。', en: 'entities: source availability filter.' }) }),
    page: Flags.integer({ min: 1, max: 100000, description: bilingual({ zh: 'entities：页码。', en: 'entities: page number.' }) }),
    'page-size': Flags.integer({ min: 1, max: 100, description: bilingual({ zh: 'entities：每页条数。', en: 'entities: page size.' }) }),
    input: Flags.string({ description: bilingual({ zh: 'graph：可选范围 JSON，仅含 knowledgeIds／includeHistory。', en: 'graph: optional scope JSON with knowledgeIds/includeHistory only.' }) }),
    json: knowJsonFlag,
    lang: LANG_FLAG,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(KnowShow);
    const action = args.action as Action;
    const allowedByAction: Record<Action, string[]> = {
      knowledge: ['id', 'revision'],
      entities: ['analysis', 'entity-revision', 'query', 'identity-status', 'source-status', 'page', 'page-size'],
      relations: ['id', 'revision', 'body-digest'],
      relation: ['id', 'revision'],
      graph: ['input'],
    };
    const allowed = new Set([...allowedByAction[action], 'workspace', 'json', 'lang']);
    if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) {
      this.error(this.t('该读取动作不接受这些参数。', 'These flags are not accepted for this read action.'), { exit: 2 });
    }
    if (action === 'graph') {
      this.executeKnowGraph(flags.input ? this.input(flags.input) : {}, flags.workspace);
      return;
    }
    if (action === 'relations') {
      this.executeKnowRelation({ operation: 'relations', bodyRef: {
        knowledgeId: this.required(flags.id, 'id'),
        revisionId: this.required(flags.revision, 'revision'),
        bodyDigest: this.required(flags['body-digest'], 'body-digest'),
      } }, flags.workspace);
      return;
    }
    if (action === 'relation') {
      this.executeKnowRelation({
        operation: 'relation', relationId: this.required(flags.id, 'id'),
        ...(flags.revision ? { relationRevisionId: flags.revision } : {}),
      }, flags.workspace);
      return;
    }
    await this.executeKnowOperation(action === 'knowledge'
      ? { operation: 'show', id: this.required(flags.id, 'id'), revision: flags.revision }
      : flags.analysis
        ? { operation: 'entities', analysisId: flags.analysis, revision: flags['entity-revision'] }
        : {
          operation: 'entity-catalog', query: flags.query,
          identityStatus: flags['identity-status'] as 'all' | 'proposed' | 'unresolved' | undefined,
          sourceStatus: flags['source-status'] as 'all' | 'available' | 'unavailable' | undefined,
          page: flags.page, pageSize: flags['page-size'],
        }, flags);
  }
}
