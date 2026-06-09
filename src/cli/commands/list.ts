import { existsSync, lstatSync, readdirSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
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
  if (md.isSymbolicLink() || !md.isFile()) return null; // SKILL.md 必须是常规文件、非软链
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
          bytes += lstatSync(join(dir, e.name)).size;
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
    // 本地 file 源:守卫后再读。
    const abs = resolve(s.locator);
    if (!existsSync(abs)) return { reachable: false };
    const st = lstatSync(abs); // lstat:不跟随软链 —— 软链直接拒(防 evil.md → /dev/zero)
    if (st.isSymbolicLink()) return { reachable: false };
    if (s.isDirectorySkill) {
      if (!st.isDirectory()) return { reachable: false };
      const hash = boundedDirSkillHash(abs); // 形态校验 + 成本边界(防任意目录递归读 / 目录 DoS)
      return hash === null ? { reachable: false } : { reachable: true, hash };
    }
    if (!st.isFile() || st.size > MAX_FILE_SOURCE_BYTES) return { reachable: false }; // 非常规文件 / 超大 → 拒读
    return { reachable: true, hash: hashArtifactSource(abs, false) };
  } catch {
    return { reachable: false };
  }
}

/** CJK 全角字符按 2 列计宽,使含中文表头的列也能对齐。 */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - dispWidth(s)));
}

/** 按**显示宽度**截断(不是 code unit):逐码点累加 dispWidth,绝不切断 surrogate 对、CJK 也不溢出列。 */
function truncate(s: string, max: number): string {
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

/** 洗控制字符:managed JSON 可随仓库分发,name / sourceLabel / verdict 等字段塞进表格前必须先洗,
 *  否则换行 / 回车 / ANSI / OSC 转义会破坏表格甚至伪造后续终端输出。把 C0(含 ESC / 换行 / TAB)、DEL、
 *  C1 全替换为可见占位 —— ESC 一旦被替换,任何 ANSI/OSC 序列即失效。`--json` 路径保留原值给脚本。 */
export function sanitizeCell(s: string): string {
  // C0 (U+0000–U+001F, 含 ESC / 换行 / 回车 / TAB) + DEL (U+007F) + C1 (U+0080–U+009F) → U+FFFD;
  // ESC 一旦被替换,任何 ANSI / OSC 序列即失效。
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '\ufffd');
}

function renderTable(rows: ManagedListRow[], lang: CliLang): string {
  const headers = [
    tCli('cli.list.col_name', lang),
    tCli('cli.list.col_kind', lang),
    tCli('cli.list.col_state', lang),
    tCli('cli.list.col_verdict', lang),
    tCli('cli.list.col_evidence', lang),
    tCli('cli.list.col_source', lang),
  ];
  const cells = rows.map((r) => [
    sanitizeCell(r.name),
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
        this.log(JSON.stringify(rows, null, 2));
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
      if (rows.some((r) => r.drifted)) process.stderr.write('\n' + tCli('cli.list.drift_note', lang));
      if (rows.some((r) => !r.reachable)) process.stderr.write(tCli('cli.list.unreachable_note', lang));
      process.stderr.write(tCli('cli.list.legend', lang));
    });
  }
}
