import { existsSync, lstatSync, readdirSync, type Dirent } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { tCli } from '../lib/i18n.js';
import { resolveInstallSource } from '../../inputs/source-resolver.js';
import {
  buildManagedListRows,
  globalManagedDir,
  hashArtifactSource,
  isDistributablePath,
  loadAllManagedRecords,
  managedDir,
  resolveManagedDir,
  type ManagedListRow,
  type SourceProbe,
} from '../../managed/index.js';
import type { ManagedArtifactRecord } from '../../types/index.js';
import type { CliLang } from '../lib/i18n.js';

// 本地源读取成本上限。skill 是小体量 markdown(+少量 references 资产),远超这些边界的源必是手改 /
// 投毒,拒读避免 `omk list`(只读命令,读盘上可能随仓库分发的 locator)被 /dev/zero / 超大文件 / 巨型
// 目录递归拖垮(DoS)。
const MAX_FILE_SOURCE_BYTES = 8 * 1024 * 1024; // 单文件-skill 上限
const MAX_DIR_SOURCE_BYTES = 64 * 1024 * 1024; // 目录-skill 整树累计上限
const MAX_DIR_SOURCE_FILES = 4000;             // 目录-skill 文件数上限
const MAX_DIR_SOURCE_DEPTH = 64;               // 目录递归深度上限

/**
 * 目录-skill 源的**有边界**整树哈:先恢复 resolveFileSource 的形态校验(SKILL.md 存在、是常规文件、非
 * 软链 —— 否则 locator 可指向任意可读目录让 list 递归读整棵树),再 stat-walk(只 stat 不读)按与
 * hashArtifactSource 同一 `isDistributablePath` 过滤累计 文件数 / 字节 / 深度,超界即返回 null(unreachable),
 * 把单文件 DoS 不再换成目录递归 DoS。通过后才真正 hashArtifactSource。返回 null = 拒读 / 非法 skill 目录。
 */
function boundedDirSkillHash(abs: string): string | null {
  const skillMd = join(abs, 'SKILL.md');
  let md: ReturnType<typeof lstatSync>;
  try {
    md = lstatSync(skillMd);
  } catch {
    return null; // 无 SKILL.md → 不是 skill 目录,拒
  }
  if (md.isSymbolicLink() || !md.isFile() || md.nlink !== 1) return null; // SKILL.md 必须是常规、非软链、非硬链
  let files = 0;
  let bytes = 0;
  const within = (dir: string, segs: string[], depth: number): boolean => {
    if (depth > MAX_DIR_SOURCE_DEPTH) return false;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const ns = [...segs, e.name];
      if (!isDistributablePath(ns)) continue; // 与 hashArtifactSource 读取范围一致
      if (e.isDirectory()) {
        if (!within(join(dir, e.name), ns, depth + 1)) return false;
      } else if (e.isFile()) { // 软链 Dirent 既非 isFile 也非 isDirectory → 天然跳过
        if (++files > MAX_DIR_SOURCE_FILES) return false;
        try {
          const fst = lstatSync(join(dir, e.name));
          if (fst.nlink !== 1) return false; // 硬链(nlink>1)可在树内别名树外敏感 inode → 拒读整树
          bytes += fst.size;
        } catch {
          return false;
        }
        if (bytes > MAX_DIR_SOURCE_BYTES) return false;
      }
    }
    return true;
  };
  if (!within(abs, [], 0)) return null;
  return hashArtifactSource(abs, true);
}

/**
 * 探测一条受管记录**当前源**的状态(三态,喂 buildManagedListRow 判 drift / 生命周期)。
 *   - 远端 git(带 url):源身份钉不可变 SHA(install 时 pin),内容恒定 → 直接取 record.contentHash,
 *     不联网(list 是快读命令,不为 drift 检查发网络请求)。reachable。
 *   - 本地 git:locator `git:<ref>:<spec>` 复用 resolveInstallSource 在**仓库对象库**内重物化重哈
 *     (读取受 git 边界约束,无任意文件读 DoS)。解析不到(常因 `omk list` 的 cwd 与 install 时不同、
 *     spec 随 cwd 漂)→ 抛错 → **reachable:false(未核,不当 stale)**,避免对未改动的 skill 误报漂移。
 *   - 本地 file:locator 是绝对路径,但受管 JSON **用户可手改 / 随仓库分发**(无 install、无 opt-in 即被
 *     loadAllManagedRecords 读到)。只读命令绝不盲读任意路径:**拒软链、只读常规文件 / 真目录、单文件
 *     设 size cap**(挡 `evil.md → /dev/zero` 这类 readFileSync 无界 DoS 与项目外任意读)。守卫不过 →
 *     reachable:false。目录-skill 整树哈本就跳软链(hashArtifactSource 用 isFile() 过滤)。
 */
export function probeSourceState(record: ManagedArtifactRecord): SourceProbe {
  const s = record.source;
  if (s.sourceKind === 'git' && s.url) return { reachable: true, hash: record.contentHash };
  try {
    if (s.sourceKind === 'git') {
      const resolved = resolveInstallSource(s.locator);
      try {
        return { reachable: true, hash: hashArtifactSource(resolved.localRoot, resolved.isDirectorySkill) };
      } finally {
        resolved.cleanup();
      }
    }
    // 本地 file 源:守卫后再读。locator 必须是 install 实际写出的形态(绝对路径) —— 受管 JSON 随仓库
    // 分发、无 opt-in 即被读到,相对 locator 不是 install 产物,拒,避免按 cwd 解析到项目外。
    if (!isAbsolute(s.locator)) return { reachable: false };
    const abs = resolve(s.locator);
    if (!existsSync(abs)) return { reachable: false };
    const st = lstatSync(abs); // lstat:不跟随软链 —— 软链直接拒(防 evil.md → /dev/zero)
    if (st.isSymbolicLink()) return { reachable: false };
    if (s.isDirectorySkill) {
      if (!st.isDirectory()) return { reachable: false };
      const hash = boundedDirSkillHash(abs); // 形态校验 + 成本边界(防任意目录递归读 / 目录 DoS)
      return hash === null ? { reachable: false } : { reachable: true, hash };
    }
    // 单文件-skill:恢复 install(resolveFileSource)的形态约束 —— 必须是 `.md` 常规文件、非硬链、≤ size cap。
    // 否则攻击者可写 locator:`/etc/passwd` / `~/.ssh/id_rsa`(非 .md 直接拒),或用 `.md` 命名的**硬链**别名
    // 树外敏感文件绕过扩展名 / 软链守卫(lstat 分不出硬链)→ 诱 list 把任意本地文件读进进程参与 hash。install
    // 写出的是 nlink=1 的全新副本,拒 nlink>1 不误伤合法源。非 install 形态一律 reachable:false。
    if (!/\.md$/i.test(abs) || !st.isFile() || st.nlink !== 1 || st.size > MAX_FILE_SOURCE_BYTES) return { reachable: false };
    return { reachable: true, hash: hashArtifactSource(abs, false) };
  } catch {
    return { reachable: false };
  }
}

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
    // 不可达 → 标「?」(drift 未核),绝不冒充 stale;reachable 且漂移才 stale ⚠️。
    !r.reachable ? `${r.state} ?` : r.state === 'stale' ? 'stale ⚠️' : r.state,
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
