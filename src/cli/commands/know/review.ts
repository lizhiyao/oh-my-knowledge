import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { knowledgeOperationSchemas, type KnowledgeOperation } from '../../../knowledge/application/operations.js';
import type { KnowledgeReviewOperation } from '../../../knowledge/application/review-operations.js';
import { KnowCommand, knowJsonFlag, knowWorkspaceFlag } from '../../lib/know-command.js';

const actions = [
  'retain', 'discard', 'status', 'content', 'coverage', 'record-use',
  'source-prepare', 'source-ledger', 'source-coverage', 'source-decide', 'associations', 'relation',
] as const;
type Action = typeof actions[number];

export default class KnowReview extends KnowCommand {
  static description = bilingual({ zh: '复核知识、记录保留或使用反馈，并核对来源覆盖。', en: 'Review knowledge, record retention or use feedback, and inspect source coverage.' });
  static args = { action: Args.string({ required: true, options: actions, description: bilingual({ zh: '复核动作。', en: 'Review action.' }) }) };
  static flags = {
    workspace: knowWorkspaceFlag,
    id: Flags.string({ description: bilingual({ zh: '知识、来源清单或覆盖记录 ID。', en: 'Knowledge, source-ledger, or coverage ID.' }) }),
    revision: Flags.string({ description: bilingual({ zh: '精确修订 ID。', en: 'Exact revision ID.' }) }),
    'body-digest': Flags.string({ description: bilingual({ zh: 'status：精确正文 SHA-256。', en: 'status: exact body SHA-256.' }) }),
    'projection-revision': Flags.string({ description: bilingual({ zh: 'status：精确关联投影修订。', en: 'status: exact association projection revision.' }) }),
    generation: Flags.integer({ min: 0, description: bilingual({ zh: '预先读取的 generation。', en: 'Previously read generation.' }) }),
    choice: Flags.string({ options: ['accept', 'reject'], description: bilingual({ zh: 'associations：接受或拒绝派生修订。', en: 'associations: accept or reject the derived revision.' }) }),
    reason: Flags.string({ description: bilingual({ zh: '保留、舍弃或复核理由。', en: 'Retention, discard, or review reason.' }) }),
    input: Flags.string({ description: bilingual({ zh: '完整复核、来源决定或准备输入 JSON。', en: 'Complete review, source-decision, or preparation JSON.' }) }),
    'run-id': Flags.string({ description: bilingual({ zh: 'source-prepare：稳定运行 UUID。', en: 'source-prepare: stable run UUID.' }) }),
    executor: Flags.string({ description: bilingual({ zh: 'source-prepare：执行器。', en: 'source-prepare: executor.' }) }),
    model: Flags.string({ description: bilingual({ zh: 'source-prepare：模型。', en: 'source-prepare: model.' }) }),
    json: knowJsonFlag,
    lang: LANG_FLAG,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(KnowReview);
    const action = args.action as Action;
    const allowedByAction: Record<Action, string[]> = {
      retain: ['id', 'revision', 'generation', 'reason'],
      discard: ['id', 'revision', 'generation', 'reason'],
      status: ['id', 'revision', 'body-digest', 'projection-revision'],
      content: ['input'],
      coverage: ['input'],
      'record-use': ['input'],
      'source-prepare': ['input', 'run-id', 'executor', 'model'],
      'source-ledger': ['id', 'revision'],
      'source-coverage': ['id', 'revision'],
      'source-decide': ['input'],
      associations: ['id', 'revision', 'generation', 'choice', 'reason'],
      relation: ['input'],
    };
    const allowed = new Set([...allowedByAction[action], 'workspace', 'json', 'lang']);
    if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) {
      this.error(this.t('该复核动作不接受这些参数。', 'These flags are not accepted for this review action.'), { exit: 2 });
    }
    if (action === 'relation') {
      this.executeKnowRelation({ ...this.inputObject(flags.input), operation: 'review-relation' } as never, flags.workspace);
      return;
    }
    if (action === 'content' || action === 'coverage' || action === 'record-use') {
      const reviewOperation = { content: 'review-content', coverage: 'review-coverage', 'record-use': 'record-use' }[action];
      this.executeKnowReview({ ...this.inputObject(flags.input), operation: reviewOperation } as KnowledgeReviewOperation, flags.workspace);
      return;
    }
    let operation: KnowledgeOperation;
    if (action === 'status') {
      this.executeKnowReview({ operation: 'review-status', bodyRef: {
        knowledgeId: this.required(flags.id, 'id'), revisionId: this.required(flags.revision, 'revision'),
        bodyDigest: this.required(flags['body-digest'], 'body-digest'),
      }, ...(flags['projection-revision'] ? { projectionRevisionId: flags['projection-revision'] } : {}) }, flags.workspace);
      return;
    }
    if (action === 'retain' || action === 'discard') {
      operation = {
        operation: 'maintain', id: this.required(flags.id, 'id'), revision: this.required(flags.revision, 'revision'),
        generation: flags.generation ?? this.error('--generation is required', { exit: 2 }), choice: action,
        reason: this.required(flags.reason, 'reason'),
      };
    } else if (action === 'associations') {
      operation = {
        operation: 'review-associations', id: this.required(flags.id, 'id'), revision: this.required(flags.revision, 'revision'),
        generation: flags.generation ?? this.error('--generation is required', { exit: 2 }),
        choice: this.required(flags.choice, 'choice') as 'accept' | 'reject', reason: this.required(flags.reason, 'reason'),
      };
    } else if (action === 'source-prepare') {
      const parsed = knowledgeOperationSchemas['prepare-source-review'].omit({ operation: true, executor: true, model: true, runId: true })
        .safeParse(this.input(flags.input));
      if (!parsed.success) this.error(this.t('来源复核准备需要完整 sources 与精确 bodyRefs。', 'Source-review preparation requires complete sources and exact bodyRefs.'), { exit: 2 });
      operation = { operation: 'prepare-source-review', ...parsed.data, executor: 'configured', model: 'configured', runId: flags['run-id'] };
    } else if (action === 'source-decide') {
      operation = { operation: 'review-source-coverage', command: this.inputObject(flags.input) } as KnowledgeOperation;
    } else {
      operation = {
        operation: action === 'source-ledger' ? 'source-ledger' : 'source-coverage-status',
        id: this.required(flags.id, 'id'), revision: flags.revision,
      };
    }
    await this.executeKnowOperation(operation, { ...flags, actualActor: ['retain', 'discard', 'associations'].includes(action) });
  }
}
