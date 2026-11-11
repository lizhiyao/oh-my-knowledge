import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import type { KnowledgeOperation } from '../../../knowledge/application/operations.js';
import { KnowCommand, knowJsonFlag, knowWorkspaceFlag } from '../../lib/know-command.js';

const actions = ['knowledge', 'entities', 'associations', 'propose-relation', 'withdraw-relation'] as const;
type Action = typeof actions[number];

export default class KnowRevise extends KnowCommand {
  static description = bilingual({ zh: '修订知识及其实体、关联和关系。', en: 'Revise knowledge and its entities, associations, and relations.' });
  static args = { action: Args.string({ default: 'knowledge', options: actions, description: bilingual({ zh: '修订的资源类型。', en: 'Resource type to revise.' }) }) };
  static flags = {
    workspace: knowWorkspaceFlag,
    id: Flags.string({ description: bilingual({ zh: '知识 ID。', en: 'Knowledge ID.' }) }),
    revision: Flags.string({ description: bilingual({ zh: '当前精确修订 ID。', en: 'Current exact revision ID.' }) }),
    generation: Flags.integer({ min: 0, description: bilingual({ zh: '预先读取的 generation，防并发覆盖。', en: 'Previously read generation, preventing concurrent overwrite.' }) }),
    'body-digest': Flags.string({ description: bilingual({ zh: 'associations：精确正文 SHA-256。', en: 'associations: exact body SHA-256.' }) }),
    analysis: Flags.string({ description: bilingual({ zh: 'entities：实体分析 UUID。', en: 'entities: entity analysis UUID.' }) }),
    'entity-revision': Flags.string({ description: bilingual({ zh: 'entities：实体分析修订 UUID。', en: 'entities: entity analysis revision UUID.' }) }),
    input: Flags.string({ description: bilingual({ zh: '完整修订或关系草稿 JSON。', en: 'Complete revision or relation draft JSON.' }) }),
    reason: Flags.string({ description: bilingual({ zh: '修订理由。', en: 'Revision reason.' }) }),
    json: knowJsonFlag,
    lang: LANG_FLAG,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(KnowRevise);
    const action = args.action as Action;
    const allowedByAction: Record<Action, string[]> = {
      knowledge: ['id', 'revision', 'generation', 'input', 'reason'],
      entities: ['analysis', 'entity-revision', 'generation', 'input', 'reason'],
      associations: ['id', 'revision', 'body-digest', 'generation', 'input', 'reason'],
      'propose-relation': ['input'],
      'withdraw-relation': ['input'],
    };
    const allowed = new Set([...allowedByAction[action], 'workspace', 'json', 'lang']);
    if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) {
      this.error(this.t('该修订动作不接受这些参数。', 'These flags are not accepted for this revision action.'), { exit: 2 });
    }
    if (action === 'propose-relation' || action === 'withdraw-relation') {
      this.executeKnowRelation({ ...this.inputObject(flags.input), operation: action } as never, flags.workspace);
      return;
    }
    const generation = flags.generation ?? this.error('--generation is required', { exit: 2 });
    let operation: KnowledgeOperation;
    if (action === 'entities') {
      operation = {
        operation: 'correct-entities', analysisId: this.required(flags.analysis, 'analysis'),
        revision: this.required(flags['entity-revision'], 'entity-revision'), generation,
        draft: this.input(flags.input), reason: this.required(flags.reason, 'reason'),
      };
    } else if (action === 'associations') {
      operation = {
        operation: 'apply-associations', id: this.required(flags.id, 'id'), revision: this.required(flags.revision, 'revision'),
        bodyDigest: this.required(flags['body-digest'], 'body-digest'), generation,
        draft: this.input(flags.input), reason: this.required(flags.reason, 'reason'),
      };
    } else {
      operation = {
        operation: 'revise', id: this.required(flags.id, 'id'), revision: this.required(flags.revision, 'revision'),
        generation, draft: this.input(flags.input), reason: this.required(flags.reason, 'reason'),
      };
    }
    await this.executeKnowOperation(operation, { ...flags, actualActor: true });
  }
}
