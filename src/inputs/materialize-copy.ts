import { mkdtempSync, mkdirSync, cpSync, copyFileSync, existsSync, renameSync, rmSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { hashArtifactSource, distributableCopyFilter } from './content-hash.js';

/**
 * 内容寻址隔离副本 —— eval 把任意源(本地目录-skill / 本地单文件-skill / 本地 git ref / 远端 git)
 * 在测量前落地成的那一份。executor 的 cwd 锚到 copyRoot,被测 agent 在隔离副本里跑、不碰用户真实
 * 目录,references/ 资产成为真实运行时输入。路径按 contentHash 命名 → 同内容同路径 → task.cwd
 * 稳定 → cache key / runtime fingerprint 稳定。
 */
export interface IsolatedCopy {
  /** 副本根:目录-skill 为目录 `<treesDir>/<hash>`、单文件-skill 为 `<treesDir>/<hash>/<name>.md`。 */
  copyRoot: string;
  /** = hashArtifactSource(copyRoot, isDirectorySkill);与 install 受管记录的 contentHash 同空间。 */
  contentHash: string;
  isDirectorySkill: boolean;
}

/** 隔离副本根目录(与 managed / isolated-cwd / reports 同 home-dir 模式)。
 *  `OMK_TREES_DIR` 可重定位(测试隔离 / 用户迁移)。 */
export function treesDir(): string {
  return process.env.OMK_TREES_DIR || join(homedir(), '.oh-my-knowledge', 'trees');
}

/** 内容寻址副本默认上限(distinct 内容版本数);超出按 LRU(mtime)淘汰。
 *  `OMK_TREES_MAX_ENTRIES` 调整:0 / 负数 = 不限。 */
const DEFAULT_TREES_MAX_ENTRIES = 200;
/** 淘汰宽限:mtime 在此窗口内(近期物化 / 命中触碰)的副本一律不动 —— 兜底「正在跑的 eval 的 cwd 不被删」。
 *  取 24h:没有 eval 会跑这么久,active run 的副本恒在窗口内、绝不被淘汰;只有久未用的才回收。 */
const TREES_GRACE_MS = 24 * 60 * 60 * 1000;

function treesCap(): number {
  const raw = process.env.OMK_TREES_MAX_ENTRIES;
  if (raw == null || raw === '') return DEFAULT_TREES_MAX_ENTRIES;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TREES_MAX_ENTRIES;
  if (n <= 0) return Infinity;
  return Math.floor(n);
}

/**
 * 内容寻址副本的 LRU 回收:`<treesDir>/<hash>` 数超过上限时,按 mtime 从旧到新淘汰,直到回到上限内;
 * **跳过** mtime 在 grace 窗口内的副本(近期用过、可能是正在跑的 eval 的 cwd,删了会断 active run)。
 * 因此是「软上限」—— 一次性物化的大批新副本会暂时超限,待其老化出 grace 后再被回收。`.tmp-` 暂存不计、不删。
 * materializeIsolatedCopy 命中走 utimes 触碰(LRU touch)、未命中落盘后调本函数;也可独立调用(测试 / 后续 GC)。
 */
export function pruneTreesDir(opts: { maxEntries?: number; graceMs?: number } = {}): void {
  const cap = opts.maxEntries ?? treesCap();
  if (!Number.isFinite(cap)) return;
  const graceMs = opts.graceMs ?? TREES_GRACE_MS;
  const root = treesDir();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return; // 目录不存在 = 无可回收
  }
  const dirs = names
    .filter((n) => !n.startsWith('.')) // 排除 .tmp- 暂存
    .map((n) => {
      try {
        return { path: join(root, n), mtimeMs: statSync(join(root, n)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtimeMs: number } => x !== null);
  if (dirs.length <= cap) return;
  dirs.sort((a, b) => a.mtimeMs - b.mtimeMs); // 最旧在前
  const cutoff = Date.now() - graceMs;
  let removable = dirs.length - cap;
  for (const d of dirs) {
    if (removable <= 0) break;
    if (d.mtimeMs > cutoff) continue; // grace 内:近期用过 / 可能是 active cwd,保护
    try {
      rmSync(d.path, { recursive: true, force: true });
      removable--;
    } catch {
      // 删除失败(权限 / 并发)不致命,跳过
    }
  }
}

/**
 * 把一棵已在盘的本地源树(目录或单 .md)落地成内容寻址隔离副本。
 *   - 先从**源**算整树 / 单文件指纹(`hashArtifactSource` 与副本同 filter → 同 hash),不必先 copy
 *   - `<treesDir>/<hash>` 已存在 → 内容寻址命中,直接复用、**零 copy**(同 hash 内容必然相同)
 *   - 未命中 → 物化到同卷临时目录 `<treesDir>/.tmp-xxx`(目录-skill 用 install 同一 distributable
 *     filter;单文件-skill copyFile 到 `<tmp>/<name>.md`,使 `<hash>` 恒为目录、消歧),再原子
 *     `rename` 到 `<hash>`;rename 撞 EEXIST/ENOTEMPTY(并发已落同 hash)即删临时复用。
 * 物化只发生一次/variant(resolveArtifacts 解析期),不随 sample 数放大。
 */
export function materializeIsolatedCopy(localRoot: string, isDirectorySkill: boolean, name: string): IsolatedCopy {
  const root = treesDir();
  const contentHash = hashArtifactSource(localRoot, isDirectorySkill);
  const target = join(root, contentHash);
  const copyRoot = isDirectorySkill ? target : join(target, `${name}.md`);
  if (existsSync(target)) {
    // 命中:零 copy。utimes 触碰 mtime 作 LRU 标记(并把它移出 prune 的淘汰窗口)。
    try {
      const now = new Date();
      utimesSync(target, now, now);
    } catch {
      // 触碰失败不致命
    }
    return { copyRoot, contentHash, isDirectorySkill };
  }

  mkdirSync(root, { recursive: true });
  const tmp = mkdtempSync(join(root, '.tmp-'));
  try {
    if (isDirectorySkill) {
      cpSync(localRoot, tmp, { recursive: true, filter: distributableCopyFilter(localRoot) });
    } else {
      copyFileSync(localRoot, join(tmp, `${name}.md`));
    }
    renameSync(tmp, target);
    pruneTreesDir(); // 落盘新副本后回收超限的旧副本(LRU + grace 保护 active run)
    return { copyRoot, contentHash, isDirectorySkill };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    // 并发竞态:另一进程已先 rename 到 target(非空)→ EEXIST/ENOTEMPTY;内容相同,复用。
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return { copyRoot, contentHash, isDirectorySkill };
    throw err;
  }
}
