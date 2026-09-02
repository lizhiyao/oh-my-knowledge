import { Flags } from '@oclif/core';
import { BaseCommand } from '../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { CliExit } from '../lib/cli-exit.js';
import {
  applyClean,
  planClean,
  type CleanCategory,
} from '../../omk-layout/clean.js';

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export default class Clean extends BaseCommand {
  static description = bilingual({
    zh: '按生命周期安全清理 OMK 项目或全局存储；默认只删除可重建的 state。',
    en: 'Safely clean project or global OMK storage by lifecycle; only reproducible state is removed by default.',
  });

  static examples = [
    { description: bilingual({ zh: '预览默认清理', en: 'Preview the default cleanup' }), command: '<%= config.bin %> clean --dry-run' },
    { description: bilingual({ zh: '只清理可重建 state', en: 'Clean reproducible state only' }), command: '<%= config.bin %> clean' },
    { description: bilingual({ zh: '清理历史报告', en: 'Clean historical reports' }), command: '<%= config.bin %> clean --reports' },
    { description: bilingual({ zh: '清理全部非治理本地数据', en: 'Clean all non-governance local data' }), command: '<%= config.bin %> clean --all --force' },
  ];

  static flags = {
    lang: LANG_FLAG,
    'dry-run': Flags.boolean({
      description: bilingual({ zh: '只显示将删除的路径与空间', en: 'Show paths and space without deleting' }),
      default: false,
    }),
    global: Flags.boolean({
      description: bilingual({ zh: '清理全局 ~/.oh-my-knowledge', en: 'Clean global ~/.oh-my-knowledge storage' }),
      default: false,
    }),
    reports: Flags.boolean({
      description: bilingual({ zh: '清理 eval、doctor 和 observe health 报告', en: 'Clean eval, doctor, and observe health reports' }),
      default: false,
    }),
    observations: Flags.boolean({
      description: bilingual({ zh: '清理 observation inbox、草稿和归档，必须配合 --force', en: 'Clean observation inbox, drafts, and archive; requires --force' }),
      default: false,
    }),
    backups: Flags.boolean({
      description: bilingual({ zh: '清理 doctor fix 备份', en: 'Clean doctor fix backups' }),
      default: false,
    }),
    governance: Flags.boolean({
      description: bilingual({ zh: '清理 managed 治理记录，必须配合 --force', en: 'Clean managed governance records; requires --force' }),
      default: false,
    }),
    all: Flags.boolean({
      description: bilingual({ zh: '清理 state、报告、observation 和备份，不包含治理记录', en: 'Clean state, reports, observations, and backups; excludes governance' }),
      default: false,
    }),
    force: Flags.boolean({
      description: bilingual({ zh: '确认删除敏感或不可重建的数据', en: 'Confirm deletion of sensitive or non-reproducible data' }),
      default: false,
    }),
    json: Flags.boolean({
      description: bilingual({ zh: '输出机器可读 JSON', en: 'Print machine-readable JSON' }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Clean);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const selected: CleanCategory[] = [
        ...(flags.all ? ['state', 'reports', 'observations', 'backups'] as const : []),
        ...(flags.reports ? ['reports' as const] : []),
        ...(flags.observations ? ['observations' as const] : []),
        ...(flags.backups ? ['backups' as const] : []),
        ...(flags.governance ? ['governance' as const] : []),
      ];
      const plan = planClean({
        scope: flags.global ? 'global' : 'project',
        categories: selected.length > 0 ? selected : ['state'],
      });
      if (!flags.json) {
        process.stdout.write(lang === 'zh' ? 'OMK 清理预览：\n' : 'OMK cleanup preview:\n');
        for (const target of plan.targets) {
          process.stdout.write(`  ${target.category}  ${target.path}  ${bytes(target.bytes)}\n`);
        }
        process.stdout.write(lang === 'zh'
          ? `共 ${plan.targets.length} 个目录，预计释放 ${bytes(plan.totalBytes)}。\n`
          : `${plan.targets.length} directories, ${bytes(plan.totalBytes)} reclaimable.\n`);
      }
      if (flags['dry-run']) {
        if (flags.json) this.log(JSON.stringify({ plan }, null, 2));
        return;
      }
      if (plan.requiresForce && !flags.force) {
        process.stderr.write(lang === 'zh'
          ? '拒绝删除 observation 或治理数据：请检查预览后显式传入 --force。\n'
          : 'Refusing to delete observations or governance data without --force.\n');
        throw new CliExit(2);
      }
      const removed = applyClean(plan);
      if (flags.json) this.log(JSON.stringify({ plan, result: { removed } }, null, 2));
      else process.stdout.write(lang === 'zh'
          ? `清理完成：删除 ${removed} 个目录。\n`
          : `Cleanup complete: removed ${removed} directories.\n`);
    });
  }
}
