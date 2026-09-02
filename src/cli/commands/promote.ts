import { execFileSync } from 'node:child_process';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { tCli, type CliLang } from '../lib/i18n.js';
import { CliExit } from '../lib/cli-exit.js';
import { sanitizeCell } from '../lib/cell-format.js';
import {
  appendManagedDecision,
  evaluatePromoteGate,
  globalManagedDir,
  isCurrentlyPromoted,
  loadManagedRecord,
  probeSourceState,
  managedDir,
  managedRecordId,
  resolveManagedDir,
  type PromoteBlock,
} from '../../knowledge-artifacts/governance/index.js';
import type { ArtifactKind } from '../../knowledge-artifacts/contracts.js';
import type { ManagedArtifactRecord, ManagedDecision } from '../../knowledge-artifacts/governance/contracts.js';
import type { PromoteMessageKey } from '../lib/i18n-dict/promote.js';

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

/** 洗 detail 里来自受管 JSON 的不可信值(verdict / judgePromptHash),文本输出防 ANSI/OSC 注入。 */
function safeDetail(detail: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!detail) return undefined;
  return Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, sanitizeCell(v)]));
}

/** blockKind → i18n key(细节 detail 作为 tCli params,文本路径经 safeDetail 洗白)。 */
const BLOCK_KEY: Record<PromoteBlock['blockKind'], PromoteMessageKey> = {
  drifted: 'cli.promote.drifted',
  no_current_evidence: 'cli.promote.no_current_evidence',
  verdict_blocked: 'cli.promote.verdict_blocked',
};

export default class Promote extends BaseCommand {
  static description = bilingual({
    zh: '把受管 skill 的当前版本按证据门禁「接受」为 promoted：默认仅放行 verdict=PROGRESS,在记录里追加一条带证据指针的人工决定。',
    en: 'Accept a managed skill\'s current version as promoted, gated on evidence: by default only verdict=PROGRESS passes; appends a human decision with an evidence pointer to the record.',
  });

  static examples = [
    { description: bilingual({ zh: 'promote 一个证据达标的 skill', en: 'Promote a skill whose evidence passes the gate' }), command: '<%= config.bin %> promote review' },
    { description: bilingual({ zh: '接受 CAUTIOUS 结果（显式放宽门禁）', en: 'Accept a CAUTIOUS result (explicitly loosen the gate)' }), command: '<%= config.bin %> promote review --accept-cautious' },
    { description: bilingual({ zh: '越门 promote 并记录理由（人工 override）', en: 'Override the gate and record a reason (human override)' }), command: '<%= config.bin %> promote review --force --reason "已人工复核"' },
  ];

  static args = {
    name: Args.string({ description: bilingual({ zh: '受管 skill 名（omk list 里的 NAME）', en: 'Managed skill name (the NAME shown by omk list)' }), required: true }),
  };

  static flags = {
    lang: LANG_FLAG,
    kind: Flags.string({ description: bilingual({ zh: 'artifact 类型（当前仅 skill）', en: 'artifact kind (only skill today)' }), default: 'skill' }),
    'accept-cautious': Flags.boolean({ description: bilingual({ zh: '把 CAUTIOUS 也算可接受（默认仅 PROGRESS）', en: 'also accept CAUTIOUS (default PROGRESS only)' }) }),
    force: Flags.boolean({ description: bilingual({ zh: '越过可越门拦截强制 promote，记为人工 override 决定（无当前证据或源 hash 已变时仍拒）', en: 'override forceable gate blocks and force-promote, recorded as a human override (still refused with no current evidence or changed source hash)' }) }),
    reason: Flags.string({ description: bilingual({ zh: 'promote / 越门的理由（写入决定）', en: 'reason for the promotion / override (stored on the decision)' }) }),
    actor: Flags.string({ description: bilingual({ zh: '决定的 actor（默认取 git config user.name）', en: 'decision actor (defaults to git config user.name)' }) }),
    global: Flags.boolean({ description: bilingual({ zh: '操作全局受管目录而非项目 .omk/governance/managed', en: 'operate on the global managed dir instead of project .omk/governance/managed' }) }),
    json: Flags.boolean({ description: bilingual({ zh: '输出 JSON（版本化信封）供脚本消费', en: 'output JSON (versioned envelope) for scripts' }) }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Promote);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const name = args.name;
      const kind = flags.kind as ArtifactKind;
      if (!SUPPORTED_KINDS.includes(kind)) {
        process.stderr.write(tCli('cli.promote.kind_unsupported', lang, { kind: sanitizeCell(String(kind)) }) + '\n');
        throw new CliExit(1);
      }

      const dir = flags.global ? globalManagedDir() : resolveManagedDir(managedDir());
      const record = loadManagedRecord(dir, managedRecordId(kind, name));
      if (!record) {
        process.stderr.write(tCli('cli.promote.not_managed', lang, { name: sanitizeCell(name), kind }) + '\n');
        throw new CliExit(1);
      }

      const probe = probeSourceState(record);
      const currentContentHash = probe.reachable ? probe.hash : undefined;
      const sourceHashMismatch = probe.reachable && currentContentHash !== record.contentHash;

      // 幂等：当前内容已 promote 过 → 无操作成功退出，不堆冗余事件。与 list 的不可达分支同口径：
      // 源不可达不代表内容已变；只有源可达且 hash 已变时，才不把旧 promote 当作当前 no-op。
      const alreadyPromoted = !sourceHashMismatch && isCurrentlyPromoted(record);
      if (alreadyPromoted) {
        if (flags.json) this.log(JSON.stringify({ schemaVersion: 1, alreadyPromoted: { name, contentHash: record.contentHash } }, null, 2));
        else process.stderr.write(tCli('cli.promote.already_promoted', lang, { name: sanitizeCell(name) }) + '\n');
        return;
      }

      const gate = evaluatePromoteGate({ record, currentContentHash, acceptCautious: flags['accept-cautious'] });

      // 拦截：无当前证据 force 也越不过；源可达但 hash 已变也不可越门，因为 decision 仍锚在
      // record.contentHash，越过去后 list 仍会按当前源 hash 判 stale。源不可达则可作为人工未核越门。
      const forceable = gate.evidence !== undefined && !sourceHashMismatch;
      const reason = flags.reason?.trim();
      if (!gate.ok && flags.force && forceable && !reason) {
        if (flags.json) this.log(JSON.stringify({ schemaVersion: 1, blocked: { name, reasons: [{ blockKind: 'force_reason_required' }] } }, null, 2));
        else process.stderr.write(tCli('cli.promote.force_reason_required', lang) + '\n');
        throw new CliExit(1);
      }
      if (!gate.ok && !(flags.force && forceable)) {
        this.emitBlocked(name, gate, lang, flags.json, forceable);
        throw new CliExit(1);
      }

      // 通过 或 force 越门:写决定。
      const overridden = !gate.ok; // 走到这里且未提前 return,说明是 force 越门
      const evidence = gate.evidence!; // forceable 已保证非空(无证据分支在上面已拦)
      const decision: ManagedDecision = {
        decisionKind: 'promote',
        actor: resolveActor(flags.actor),
        decidedAt: new Date().toISOString(),
        contentHash: record.contentHash,
        runId: evidence.runId,
        ...(reason ? { reason } : {}),
        ...(overridden ? { override: { verdict: evidence.verdict ?? 'UNKNOWN', overriddenBlocks: gate.blocked.map((b) => b.blockKind) } } : {}),
      };
      appendManagedDecision(dir, record.id, decision);

      this.emitPromoted(name, record, evidence.verdict, evidence.runId, overridden, lang, flags.json);
    });
  }

  private emitBlocked(name: string, gate: ReturnType<typeof evaluatePromoteGate>, lang: CliLang, json: boolean, forceable: boolean): void {
    if (json) {
      this.log(JSON.stringify({ schemaVersion: 1, blocked: { name, reasons: gate.blocked.map((b) => ({ blockKind: b.blockKind, ...(b.detail ? { detail: b.detail } : {}) })) } }, null, 2));
      return;
    }
    process.stderr.write(tCli('cli.promote.blocked_header', lang, { name: sanitizeCell(name) }) + '\n');
    // detail 里的 verdict 来自不可信受管 JSON，文本路径先洗（与 list 同口径，防 ANSI/OSC 注入）。
    for (const b of gate.blocked) process.stderr.write(tCli(BLOCK_KEY[b.blockKind], lang, safeDetail(b.detail)) + '\n');
    // 有可锚定证据(非「无证据」终态)才提示 --force 可越门。
    if (forceable) process.stderr.write(tCli('cli.promote.force_hint', lang) + '\n');
  }

  private emitPromoted(name: string, record: ManagedArtifactRecord, verdict: string | undefined, runId: string, overridden: boolean, lang: CliLang, json: boolean): void {
    const hash = record.contentHash;
    if (json) {
      this.log(JSON.stringify({
        schemaVersion: 1,
        promoted: { name, kind: record.kind, contentHash: hash, runId, verdict: verdict ?? null, override: overridden },
      }, null, 2));
      return;
    }
    // hash / verdict / runId 来自不可信受管 JSON，文本路径先洗（--json 路径上面已 return、保留原值）。
    const short = sanitizeCell(hash.slice(0, 12));
    const safeVerdict = sanitizeCell(verdict ?? 'UNKNOWN');
    const safeName = sanitizeCell(name);
    if (overridden) this.log(tCli('cli.promote.forced_override', lang, { name: safeName, hash: short, verdict: safeVerdict }));
    else this.log(tCli('cli.promote.promoted', lang, { name: safeName, hash: short, verdict: safeVerdict, runId: sanitizeCell(runId) }));
  }
}
