import { Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { tCli } from '../lib/i18n.js';
import { probeSourceState } from '../lib/source-probe.js';
import {
  buildManagedListRows,
  globalManagedDir,
  loadAllManagedRecords,
  managedDir,
  resolveManagedDir,
  type ManagedListRow,
} from '../../managed/index.js';
import type { CliLang } from '../lib/i18n.js';

// 源探测(含 DoS / 软硬链 / 投毒守卫)已抽到 ../lib/source-probe.js,promote 复用同一套守卫与 drift 判定。
// 此处 re-export 保持既有 import 入口不破(test/cli/list-probe.test.ts 仍从本文件取 probeSourceState)。
export { probeSourceState };

/** CJK 全角字符按 2 列计宽,使含中文表头的列也能对齐。 */
export function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - dispWidth(s)));
}

/** 按**显示宽度**截断(不是 code unit):逐码点累加 dispWidth,绝不切断 surrogate 对、CJK 也不溢出列。 */
export function truncate(s: string, max: number): string {
  if (dispWidth(s) <= max) return s;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = dispWidth(ch);
    if (w + cw > max - 1) break; // 留 1 列给省略号
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** 洗不可信显示字符:managed JSON 可随仓库分发,name / sourceLabel / verdict 等字段塞进表格前必须先洗,
 *  否则会破坏表格甚至伪造终端输出。一律映射到可见 U+FFFD(--json 路径保留原值给脚本)。
 *  用 Unicode **属性类**而非手列码点 —— 手列清单天然有缺口(BiDi、U+2028 / 2029、Tags 块都曾漏一轮补一轮),
 *  属性类一次覆盖整类、新码点自动纳入:
 *    - `\p{Cc}` 控制符(C0 / C1 / DEL,含 ESC / 换行 / 回车 / TAB)→ 杀 ANSI / OSC 转义与终端控制;
 *    - `\p{Cf}` 格式符(BiDi 重排 / 隔离、零宽、joiners、BOM、Tags、interlinear)→ 防 Trojan-Source 视觉伪造与零宽隐藏 / 分割;
 *    - `\p{Zl}` / `\p{Zp}` 行 / 段分隔(U+2028 / 2029)→ LF 的 Unicode 孪生,防换行伪造表格行;
 *    - `\p{Mn}` / `\p{Me}` 非间距 / 封闭组合附加符 → 变可见,避免零前进宽度令 dispWidth 与终端列错位
 *      (间距组合符 `\p{Mc}` 合法占 1 列,保留);
 *    - Hangul filler(U+115F / U+1160 / U+3164,属 Lo 不在上述任何类)→ 零宽显示诡计,补列。 */
export function sanitizeCell(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Mn}\p{Me}ᅟᅠㅤ]/gu, '�');
}

export function renderTable(rows: ManagedListRow[], lang: CliLang): string {
  const headers = [
    tCli('cli.list.col_name', lang),
    tCli('cli.list.col_kind', lang),
    tCli('cli.list.col_state', lang),
    tCli('cli.list.col_verdict', lang),
    tCli('cli.list.col_evidence', lang),
    tCli('cli.list.col_source', lang),
  ];
  const cells = rows.map((r) => [
    truncate(sanitizeCell(r.name), 40), // name 与 source 同为用户可控、可超长 → 同样按显示宽度截断,防撑爆表宽
    r.kind, // ArtifactKind 枚举(validator 已收窄),无需洗
    // 不可达 → 标「?」(drift 未核),绝不冒充 stale;reachable 且漂移才 stale ⚠️;已人工接受标 promoted ✓。
    !r.reachable ? `${r.state} ?` : r.state === 'stale' ? 'stale ⚠️' : r.state === 'promoted' ? 'promoted ✓' : r.state,
    r.latestVerdict ? sanitizeCell(r.latestVerdict) : '—',
    `${r.currentEvidenceCount}/${r.totalEvidenceCount}`,
    truncate(sanitizeCell(r.sourceLabel), 48),
  ]);
  const widths = headers.map((h, i) => Math.max(dispWidth(h), ...cells.map((c) => dispWidth(c[i]))));
  const line = (c: string[]): string => c.map((v, i) => pad(v, widths[i])).join('  ').trimEnd();
  return [line(headers), ...cells.map(line)].join('\n');
}

export default class List extends BaseCommand {
  static description = bilingual({
    zh: '列出受管 skill 及其证据状态：生命周期（installed / measurable / stale）、最新 verdict、证据数、源。',
    en: 'List managed skills with evidence status: lifecycle (installed / measurable / stale), latest verdict, evidence count, source.',
  });

  static examples = [
    { description: bilingual({ zh: '列出当前项目的受管 skill', en: 'List managed skills in the current project' }), command: '<%= config.bin %> list' },
    { description: bilingual({ zh: '列出全局受管 skill', en: 'List globally managed skills' }), command: '<%= config.bin %> list --global' },
    { description: bilingual({ zh: '机器可读 JSON 输出', en: 'Machine-readable JSON output' }), command: '<%= config.bin %> list --json' },
  ];

  static flags = {
    lang: LANG_FLAG,
    global: Flags.boolean({
      description: bilingual({ zh: '看全局受管目录（~/.oh-my-knowledge/managed）而非项目 .omk/managed', en: 'Show the global managed dir (~/.oh-my-knowledge/managed) instead of project .omk/managed' }),
    }),
    json: Flags.boolean({
      description: bilingual({ zh: '输出 JSON（含完整可比性 marker），供脚本消费', en: 'Output JSON (with full comparability markers) for scripts' }),
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(List);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const dir = flags.global ? globalManagedDir() : resolveManagedDir(managedDir());
      const records = loadAllManagedRecords(dir);
      const rows = buildManagedListRows(records, probeSourceState);

      if (flags.json) {
        // 版本化信封 —— 与 eval / doctor / diagnosis 等机读出口一致(都带 schemaVersion),让未来字段增删 /
        // 改名是可检测的版本 bump,而非脚本静默 break。rows 的逐行形态见 ManagedListRow。
        this.log(JSON.stringify({ schemaVersion: 1, rows }, null, 2));
        return;
      }

      if (rows.length === 0) {
        process.stderr.write(tCli('cli.list.empty', lang));
        process.stderr.write(tCli('cli.list.empty_hint', lang));
        return;
      }

      const scope = dir === globalManagedDir()
        ? (lang === 'zh' ? '全局' : 'global')
        : (lang === 'zh' ? '项目' : 'project');
      process.stderr.write(tCli('cli.list.header', lang, { scope, count: rows.length }));
      this.log(renderTable(rows, lang));
      // 注脚块前留一行空白(无论先触发哪条 note);空行挂在块上而非 drift 分支,避免只 unreachable 时丢分隔。
      const hasDrift = rows.some((r) => r.drifted);
      const hasUnreachable = rows.some((r) => !r.reachable);
      if (hasDrift || hasUnreachable) process.stderr.write('\n');
      if (hasDrift) process.stderr.write(tCli('cli.list.drift_note', lang));
      if (hasUnreachable) process.stderr.write(tCli('cli.list.unreachable_note', lang));
      process.stderr.write(tCli('cli.list.legend', lang));
    });
  }
}
