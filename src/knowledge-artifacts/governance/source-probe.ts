import { existsSync, lstatSync, readdirSync, type Dirent } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { resolveInstallSource } from '../sources/install-source.js';
import { hashArtifactSource, isDistributablePath } from '../sources/content-hash.js';
import type { SourceProbe } from './list-view.js';
import type { ManagedArtifactRecord } from './contracts.js';

/**
 * 受管记录**当前源**的状态探测——`omk list`(drift / 生命周期)与 `omk promote`(门禁前先确认源未漂)共用
 * 的单一来源。两命令必须用同一套守卫与 drift 判定:否则 list 显示「未漂」而 promote 判「漂」(或反之)会
 * 互相矛盾,且安全守卫一旦各写一份必然漂掉一份。
 *
 * 本地源读取成本上限:skill 是小体量 markdown(+少量 references 资产),远超这些边界的源必是手改 / 投毒,
 * 拒读避免只读命令(读盘上可能随仓库分发的 locator)被 /dev/zero / 超大文件 / 巨型目录递归拖垮(DoS)。
 */
const MAX_FILE_SOURCE_BYTES = 8 * 1024 * 1024; // 单文件-skill 上限
const MAX_DIR_SOURCE_BYTES = 64 * 1024 * 1024; // 目录-skill 整树累计上限
const MAX_DIR_SOURCE_FILES = 4000;             // 目录-skill 文件数上限
const MAX_DIR_SOURCE_DEPTH = 64;               // 目录递归深度上限

/**
 * 目录-skill 源的**有边界**整树哈:先恢复 resolveFileSource 的形态校验(SKILL.md 存在、是常规文件、非
 * 软链 —— 否则 locator 可指向任意可读目录让递归读整棵树),再 stat-walk(只 stat 不读)按与
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
 *     不联网(快读命令不为 drift 检查发网络请求)。reachable。
 *   - 本地 git:locator `git:<ref>:<spec>` 复用 resolveInstallSource 在**仓库对象库**内重物化重哈
 *     (读取受 git 边界约束,无任意文件读 DoS)。解析不到(常因 cwd 与 install 时不同、spec 随 cwd 漂)
 *     → 抛错 → **reachable:false(未核,不当 stale)**,避免对未改动的 skill 误报漂移。
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
