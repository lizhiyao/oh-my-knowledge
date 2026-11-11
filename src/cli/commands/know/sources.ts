import { Args, Flags } from '@oclif/core';
import { z } from 'zod';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { knowledgeOperationSchemas, type KnowledgeOperation } from '../../../knowledge/application/operations.js';
import { ResolvedSourceSelectionSchema, SourceDigestSchema } from '../../../knowledge/sources/sources.js';
import { KnowCommand, knowJsonFlag, knowWorkspaceFlag } from '../../lib/know-command.js';

const actions = ['preview', 'capture', 'show', 'search', 'updates', 'delete'] as const;
type Action = typeof actions[number];

export default class KnowSources extends KnowCommand {
  static description = bilingual({
    zh: '管理来源：预览、保存、读回、检索、检查更新和删除来源。',
    en: 'Manage sources: preview, capture, read, search, check updates, and delete sources.',
  });
  static args = { action: Args.string({ required: true, options: actions, description: bilingual({ zh: '来源管理动作。', en: 'Source management action.' }) }) };
  static flags = {
    workspace: knowWorkspaceFlag,
    scope: Flags.string({ description: bilingual({ zh: 'preview／capture／updates：可信宿主范围绑定 JSON。', en: 'preview/capture/updates: trusted host-scope binding JSON.' }) }),
    input: Flags.string({ description: bilingual({ zh: 'preview／capture／updates：选区、完整预览或变化查询 JSON。', en: 'preview/capture/updates: selection, complete preview, or update-check JSON.' }) }),
    snapshot: Flags.string({ description: bilingual({ zh: 'show／search／delete：来源 snapshot UUID。', en: 'show/search/delete: source snapshot UUID.' }) }),
    'source-version': Flags.string({ description: bilingual({ zh: '精确来源 SHA-256，须配 --snapshot。', en: 'Exact source SHA-256; requires --snapshot.' }) }),
    query: Flags.string({ description: bilingual({ zh: 'search：原文字面查询。', en: 'search: literal source query.' }) }),
    'max-bytes': Flags.integer({ min: 1024, max: 65536, description: bilingual({ zh: 'search：输出 UTF-8 字节预算。', en: 'search: output UTF-8 byte budget.' }) }),
    json: knowJsonFlag,
    lang: LANG_FLAG,
  };
  static examples = [
    '<%= config.bin %> know sources preview --workspace ./knowledge --scope ./scope.json --input ./selections.json --json',
    '<%= config.bin %> know sources capture --workspace ./knowledge --scope ./scope.json --input ./preview.json --json',
    '<%= config.bin %> know sources updates --workspace ./knowledge --scope ./scope.json --input ./source-check.json --json',
    '<%= config.bin %> know sources delete --workspace ./knowledge --snapshot <snapshot-id> --source-version sha256:<digest>',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(KnowSources);
    const action = args.action as Action;
    const allowedByAction: Record<Action, string[]> = {
      preview: ['scope', 'input'],
      capture: ['scope', 'input'],
      show: ['snapshot', 'source-version'],
      search: ['snapshot', 'source-version', 'query', 'max-bytes'],
      updates: ['scope', 'input'],
      delete: ['snapshot', 'source-version'],
    };
    const allowed = new Set([...allowedByAction[action], 'workspace', 'json', 'lang']);
    if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) {
      this.error(this.t('该来源动作不接受这些参数。', 'These flags are not accepted for this source action.'), { exit: 2 });
    }
    if (action === 'preview' || action === 'capture' || action === 'updates') this.required(flags.scope, 'scope');
    const source = () => ({
      snapshotId: this.required(flags.snapshot, 'snapshot'),
      sourceVersion: this.required(flags['source-version'], 'source-version'),
    });
    let operation: KnowledgeOperation;
    switch (action) {
      case 'preview': {
        const parsed = knowledgeOperationSchemas['preview-sources'].omit({ operation: true }).safeParse(this.input(flags.input));
        if (!parsed.success) this.error(this.t('来源选区必须是 {selections, afterDeletion?}。', 'Source selections must be {selections, afterDeletion?}.'), { exit: 2 });
        operation = { operation: 'preview-sources', ...parsed.data };
        break;
      }
      case 'capture': {
        const parsed = z.object({
          previewDigest: SourceDigestSchema,
          items: z.array(z.object({ resolvedSelection: ResolvedSourceSelectionSchema })).min(1).max(256),
          savePlan: z.object({ afterDeletion: z.enum(['reject', 'new_snapshot']) }),
        }).safeParse(this.input(flags.input));
        if (!parsed.success) this.error(this.t('capture 需要完整 sources preview 导出。', 'capture requires the complete sources preview export.'), { exit: 2 });
        operation = {
          operation: 'capture',
          selections: parsed.data.items.map(item => item.resolvedSelection),
          previewDigest: parsed.data.previewDigest,
          ...(parsed.data.savePlan.afterDeletion === 'new_snapshot' ? { afterDeletion: 'new_snapshot' as const } : {}),
        };
        break;
      }
      case 'show': operation = { operation: 'source', source: source() }; break;
      case 'search': operation = {
        operation: 'search-source', source: source(), query: this.required(flags.query, 'query'), maxBytes: flags['max-bytes'],
      }; break;
      case 'updates': {
        const parsed = knowledgeOperationSchemas['source-updates'].omit({ operation: true }).safeParse(this.input(flags.input));
        if (!parsed.success) this.error(this.t('来源变化查询需要精确 source 引用。', 'A source-update check requires an exact source reference.'), { exit: 2 });
        operation = { operation: 'source-updates', ...parsed.data };
        break;
      }
      case 'delete': operation = { operation: 'delete-source', source: source() }; break;
    }
    await this.executeKnowOperation(operation, flags);
  }
}
