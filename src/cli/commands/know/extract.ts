import { Args, Flags } from '@oclif/core';
import { z } from 'zod';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { knowledgeOperationSchemas, type KnowledgeOperation } from '../../../knowledge/application/operations.js';
import { SourceRefSchema } from '../../../knowledge/sources/sources.js';
import { KnowCommand, knowJsonFlag, knowWorkspaceFlag } from '../../lib/know-command.js';

const actions = ['prepare', 'generate', 'continue'] as const;
type Action = typeof actions[number];

export default class KnowExtract extends KnowCommand {
  static description = bilingual({
    zh: '提炼知识：准备完整请求、逐阶段确认发送，或继续尚未发送的阶段。',
    en: 'Extract knowledge: prepare complete requests, confirm each dispatch, or continue an unsent stage.',
  });
  static args = { action: Args.string({ required: true, options: actions, description: bilingual({ zh: 'prepare、generate 或 continue。', en: 'prepare, generate, or continue.' }) }) };
  static flags = {
    workspace: knowWorkspaceFlag,
    input: Flags.string({ description: bilingual({ zh: 'prepare／generate 的精确来源 JSON。', en: 'Exact-source JSON for prepare/generate.' }) }),
    id: Flags.string({ description: bilingual({ zh: 'continue：运行 UUID。', en: 'continue: run UUID.' }) }),
    generation: Flags.integer({ min: 1, description: bilingual({ zh: 'continue：已读取的日志 generation。', en: 'continue: previously read journal generation.' }) }),
    'run-id': Flags.string({ description: bilingual({ zh: 'prepare／generate：稳定运行 UUID。', en: 'prepare/generate: stable run UUID.' }) }),
    executor: Flags.string({ description: bilingual({ zh: '生成执行器，沿用运行配置。', en: 'Generation executor; defaults to runtime settings.' }) }),
    model: Flags.string({ description: bilingual({ zh: '生成模型，沿用运行配置。', en: 'Generation model; defaults to runtime settings.' }) }),
    'confirm-request': Flags.string({ description: bilingual({ zh: 'generate／continue：已核对完整请求的 requestDigest。', en: 'generate/continue: requestDigest of the inspected complete request.' }) }),
    json: knowJsonFlag,
    lang: LANG_FLAG,
  };
  static examples = [
    '<%= config.bin %> know extract prepare --workspace ./knowledge --input ./sources.json --json',
    '<%= config.bin %> know extract generate --workspace ./knowledge --input ./sources.json --confirm-request sha256:<digest>',
    '<%= config.bin %> know extract continue --workspace ./knowledge --id <run-id> --generation 5 --confirm-request sha256:<digest>',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(KnowExtract);
    const action = args.action as Action;
    const allowed = new Set(['workspace', 'executor', 'model', 'json', 'lang', ...(action === 'continue'
      ? ['id', 'generation', 'confirm-request']
      : ['input', 'run-id', ...(action === 'generate' ? ['confirm-request'] : [])])]);
    if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) {
      this.error(this.t('该提炼动作不接受这些参数。', 'These flags are not accepted for this extraction action.'), { exit: 2 });
    }
    let operation: KnowledgeOperation;
    if (action === 'continue') {
      operation = {
        operation: 'continue-stage',
        id: this.required(flags.id, 'id'),
        generation: flags.generation ?? this.error('--generation is required', { exit: 2 }),
        executor: 'configured',
        model: 'configured',
        confirmedRequestDigest: this.required(flags['confirm-request'], 'confirm-request'),
      };
    } else {
      const parsed = action === 'prepare'
        ? knowledgeOperationSchemas['prepare-generation'].omit({ operation: true, executor: true, model: true, runId: true }).safeParse(this.input(flags.input))
        : z.strictObject({ sources: z.array(SourceRefSchema).min(1).max(256) }).safeParse(this.input(flags.input));
      if (!parsed.success) this.error(this.t('提炼输入必须是完整精确的 {sources} 来源引用。', 'Extraction input must contain complete exact source references in {sources}.'), { exit: 2 });
      operation = action === 'prepare'
        ? { operation: 'prepare-generation', sources: parsed.data.sources, executor: 'configured', model: 'configured', runId: flags['run-id'] }
        : {
          operation: 'generate', sources: parsed.data.sources, executor: 'configured', model: 'configured', runId: flags['run-id'],
          confirmedRequestDigest: this.required(flags['confirm-request'], 'confirm-request'),
        };
    }
    await this.executeKnowOperation(operation, flags);
  }
}
