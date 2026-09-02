import { Flags } from '@oclif/core';
import { BaseCommand } from '../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { CliExit } from '../lib/cli-exit.js';
import {
  applyLayoutMigration,
  planGlobalLayoutMigration,
  planProjectLayoutMigration,
  type LayoutMigrationPlan,
} from '../lib/layout-migration.js';

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function renderPlan(plan: LayoutMigrationPlan, lang: 'zh' | 'en'): string {
  const lines = [lang === 'zh'
    ? `OMK v2 目录迁移预览（${plan.scope === 'global' ? '全局' : '项目'}）：`
    : `OMK v2 layout migration preview (${plan.scope}):`];
  for (const action of plan.actions) {
    const source = action.source ?? (lang === 'zh' ? '生成' : 'generate');
    lines.push(`  ${action.actionKind}  ${source} → ${action.target}`);
  }
  lines.push(lang === 'zh'
    ? `共 ${plan.actions.length} 项，涉及 ${bytes(plan.actions.reduce((sum, action) => sum + action.size, 0))}。`
    : `${plan.actions.length} action(s), ${bytes(plan.actions.reduce((sum, action) => sum + action.size, 0))}.`);
  if (plan.skipped.length > 0) {
    lines.push(lang === 'zh' ? '保留未识别路径：' : 'Unrecognized paths retained:');
    for (const path of plan.skipped) lines.push(`  ${path}`);
  }
  if (plan.conflicts.length > 0) {
    lines.push(lang === 'zh' ? '目标冲突：' : 'Target conflicts:');
    for (const conflict of plan.conflicts) lines.push(`  ${conflict}`);
  }
  return `${lines.join('\n')}\n`;
}

export default class Migrate extends BaseCommand {
  static description = bilingual({
    zh: '把旧版 OMK 存储目录迁移到领域化的 v2 布局；迁移前会完整检查冲突。',
    en: 'Migrate legacy OMK storage into the domain-oriented v2 layout after a full conflict preflight.',
  });

  static examples = [
    {
      description: bilingual({ zh: '预览当前项目迁移', en: 'Preview project migration' }),
      command: '<%= config.bin %> migrate --dry-run',
    },
    {
      description: bilingual({ zh: '迁移当前项目', en: 'Migrate the current project' }),
      command: '<%= config.bin %> migrate',
    },
    {
      description: bilingual({ zh: '迁移全局存储', en: 'Migrate global storage' }),
      command: '<%= config.bin %> migrate --global',
    },
  ];

  static flags = {
    lang: LANG_FLAG,
    'dry-run': Flags.boolean({
      description: bilingual({ zh: '只显示迁移计划，不修改文件', en: 'Show the migration plan without changing files' }),
      default: false,
    }),
    global: Flags.boolean({
      description: bilingual({ zh: '迁移全局 ~/.oh-my-knowledge', en: 'Migrate global ~/.oh-my-knowledge storage' }),
      default: false,
    }),
    json: Flags.boolean({
      description: bilingual({ zh: '输出机器可读 JSON', en: 'Print machine-readable JSON' }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Migrate);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const plan = flags.global
        ? planGlobalLayoutMigration()
        : planProjectLayoutMigration();
      if (!flags.json) process.stdout.write(renderPlan(plan, lang));
      if (plan.conflicts.length > 0) {
        if (flags.json) this.log(JSON.stringify({ plan }, null, 2));
        process.stderr.write(lang === 'zh'
          ? '迁移未执行：请先处理全部目标冲突。\n'
          : 'Migration was not applied; resolve every target conflict first.\n');
        throw new CliExit(1);
      }
      if (flags['dry-run']) {
        if (flags.json) this.log(JSON.stringify({ plan }, null, 2));
        return;
      }
      const result = applyLayoutMigration(plan);
      if (flags.json) this.log(JSON.stringify({ plan, result }, null, 2));
      else process.stdout.write(lang === 'zh'
        ? `迁移完成：移动 ${result.movedFiles} 个文件，去重 ${result.removedDuplicates} 个文件，生成 ${result.writtenFiles} 个 manifest。\n`
        : `Migration complete: moved ${result.movedFiles}, deduplicated ${result.removedDuplicates}, wrote ${result.writtenFiles} manifest(s).\n`);
    });
  }
}
