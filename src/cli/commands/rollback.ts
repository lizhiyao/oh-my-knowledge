import { execFileSync } from 'node:child_process';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { tCli } from '../lib/i18n.js';
import { CliExit } from '../lib/cli-exit.js';
import { sanitizeCell } from '../lib/cell-format.js';
import {
  appendManagedDecision,
  globalManagedDir,
  isCurrentlyPromoted,
  loadManagedRecord,
  managedDir,
  managedRecordId,
  resolveManagedDir,
} from '../../managed/index.js';
import type { ArtifactKind } from '../../types/index.js';
import type { ManagedDecision } from '../../managed/contracts.js';

const SUPPORTED_KINDS: ArtifactKind[] = ['skill'];

/** 决定的 actor:--actor > git config user.name > $USER / $LOGNAME > unknown。git 参数无用户输入,安全。 */
function resolveActor(flagActor: string | undefined): string {
  if (flagActor && flagActor.trim()) return flagActor.trim();
  try {
    const name = execFileSync('git', ['config', 'user.name'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (name) return name;
  } catch { /* git 缺失 / 无配置 → 回退环境 */ }
  return process.env.USER || process.env.LOGNAME || 'unknown';
}

export default class Rollback extends BaseCommand {
  static description = bilingual({
    zh: '回退受管 skill 当前版本的 promoted 接受：撤销最近一次 promote，在记录里追加一条 rollback 决定（源未漂移则状态回到 measurable，源已漂移则仍 stale）。',
    en: 'Roll back a managed skill\'s current promoted acceptance: revoke the latest promote by appending a rollback decision (state returns to measurable if the source is unchanged, or stays stale if it has drifted).',
  });

  static examples = [
    { description: bilingual({ zh: '回退一个已 promoted 的 skill', en: 'Roll back a promoted skill' }), command: '<%= config.bin %> rollback review' },
    { description: bilingual({ zh: '回退并记录理由', en: 'Roll back and record a reason' }), command: '<%= config.bin %> rollback review --reason "线上发现回归"' },
  ];

  static args = {
    name: Args.string({ description: bilingual({ zh: '受管 skill 名（omk list 里的 NAME）', en: 'Managed skill name (the NAME shown by omk list)' }), required: true }),
  };

  static flags = {
    lang: LANG_FLAG,
    kind: Flags.string({ description: bilingual({ zh: 'artifact 类型（当前仅 skill）', en: 'artifact kind (only skill today)' }), default: 'skill' }),
    reason: Flags.string({ description: bilingual({ zh: '回退的理由（写入决定）', en: 'reason for the rollback (stored on the decision)' }) }),
    actor: Flags.string({ description: bilingual({ zh: '决定的 actor（默认取 git config user.name）', en: 'decision actor (defaults to git config user.name)' }) }),
    global: Flags.boolean({ description: bilingual({ zh: '操作全局受管目录而非项目 .omk/managed', en: 'operate on the global managed dir instead of project .omk/managed' }) }),
    json: Flags.boolean({ description: bilingual({ zh: '输出 JSON（版本化信封）供脚本消费', en: 'output JSON (versioned envelope) for scripts' }) }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Rollback);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const name = args.name;
      const kind = flags.kind as ArtifactKind;
      if (!SUPPORTED_KINDS.includes(kind)) {
        process.stderr.write(tCli('cli.rollback.kind_unsupported', lang, { kind: sanitizeCell(String(kind)) }) + '\n');
        throw new CliExit(1);
      }

      const dir = flags.global ? globalManagedDir() : resolveManagedDir(managedDir());
      const record = loadManagedRecord(dir, managedRecordId(kind, name));
      if (!record) {
        process.stderr.write(tCli('cli.rollback.not_managed', lang, { name: sanitizeCell(name), kind }) + '\n');
        throw new CliExit(1);
      }

      // rollback 是内容锚定的纯决定撤销:只看 record.contentHash 上的 promote/rollback 事件流,不探源、不设门禁
      // (降级永远安全)。当前未 promoted → 无可回退;若曾对当前内容 promote 过(即已回退)则幂等成功,否则报错。
      if (!isCurrentlyPromoted(record)) {
        const hadPromote = record.decisions.some((d) => d.decisionKind === 'promote' && d.contentHash === record.contentHash);
        if (hadPromote) {
          if (flags.json) this.log(JSON.stringify({ schemaVersion: 1, alreadyRolledBack: { name, contentHash: record.contentHash } }, null, 2));
          else process.stderr.write(tCli('cli.rollback.already_rolled_back', lang, { name: sanitizeCell(name) }) + '\n');
          return;
        }
        if (flags.json) this.log(JSON.stringify({ schemaVersion: 1, notPromoted: { name } }, null, 2));
        else process.stderr.write(tCli('cli.rollback.not_promoted', lang, { name: sanitizeCell(name) }) + '\n');
        throw new CliExit(1);
      }

      const reason = flags.reason?.trim();
      const decision: ManagedDecision = {
        decisionKind: 'rollback',
        actor: resolveActor(flags.actor),
        decidedAt: new Date().toISOString(),
        contentHash: record.contentHash,
        ...(reason ? { reason } : {}),
      };
      appendManagedDecision(dir, record.id, decision);

      if (flags.json) {
        this.log(JSON.stringify({
          schemaVersion: 1,
          rolledBack: { name, kind: record.kind, contentHash: record.contentHash, ...(reason ? { reason } : {}) },
        }, null, 2));
        return;
      }
      // hash 来自不可信受管 JSON,文本路径先洗(--json 路径上面已 return、保留原值)。
      this.log(tCli('cli.rollback.rolled_back', lang, { name: sanitizeCell(name), hash: sanitizeCell(record.contentHash.slice(0, 12)) }));
    });
  }
}
