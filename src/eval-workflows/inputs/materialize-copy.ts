import { mkdtempSync, mkdirSync, cpSync, copyFileSync, existsSync, renameSync, rmSync, readdirSync, statSync, utimesSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  hashArtifactSource,
  distributableCopyFilter,
} from '../../knowledge-artifacts/sources/content-hash.js';
import { DEFAULT_TREES_DIR } from '../../measurement-artifacts/default-dirs.js';

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

/** 隔离副本根目录 —— 可重生 scratch,收在 state/ 子树下(见 default-dirs)。
 *  `OMK_TREES_DIR` 可重定位(测试隔离 / 用户迁移)。 */
export function treesDir(): string {
  return process.env.OMK_TREES_DIR || DEFAULT_TREES_DIR;
}

/** 内容寻址副本默认上限(distinct 内容版本数);超出按 LRU(mtime)淘汰。
 *  `OMK_TREES_MAX_ENTRIES` 调整:0 / 负数 = 不限。 */
const DEFAULT_TREES_MAX_ENTRIES = 200;
/** 淘汰宽限:mtime 在此窗口内的副本不动。这是**第二道**保护(覆盖物化→落锁那几毫秒的窗口);
 *  真正挡住「删掉正在跑的 eval 的 cwd」靠下面的 pid 占用锁,不靠「没有 eval 跑这么久」的假设。 */
const TREES_GRACE_MS = 60 * 60 * 1000;

function treesCap(): number {
  const raw = process.env.OMK_TREES_MAX_ENTRIES;
  if (raw == null || raw === '') return DEFAULT_TREES_MAX_ENTRIES;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TREES_MAX_ENTRIES;
  if (n <= 0) return Infinity;
  return Math.floor(n);
}

/** 占用锁目录:`<treesDir>/.locks/<hash>.<pid>`。dotfile → 不计入 cap、不被当副本删。 */
function locksDir(): string {
  return join(treesDir(), '.locks');
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 信号 0:只探活、不真发信号
    return true;
  } catch (err) {
    // EPERM = 进程存在但无权限(仍算活);ESRCH = 不存在
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 标记本进程正在用某内容寻址副本作 executor cwd —— 落一个 `<treesDir>/.locks/<hash>.<pid>` 占用锁。
 * pruneTreesDir 见到**活 pid** 的锁就绝不删对应副本(真实跨进程 liveness,不靠 mtime 猜)。进程崩溃也安全:
 * 锁不显式回收,prune 惰性按 pid 探活清理死锁。同 hash 同 pid 幂等(覆盖写)。
 */
function markCopyInUse(contentHash: string): void {
  try {
    const dir = locksDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${contentHash}.${process.pid}`), '');
  } catch {
    // 落锁失败不致命:还有 grace 窗口兜底
  }
  reapDeadLocks(); // 每次落锁顺带清死 pid 的锁 —— 不依赖 prune(prune 仅 cache-miss + 超上限才跑,
  //                  under-cap 的常见情形下永不触发,死锁会无界堆积)。readdir 小目录,开销可忽略。
}

/** 扫 `.locks/`:删掉死 pid 的锁、返回被**活进程**占用的 hash 集合。每次物化(markCopyInUse)无条件调用,
 *  保证死锁惰性回收的路径始终可达;pruneTreesDir 也用其返回的 live 集合保护 active cwd。 */
function reapDeadLocks(): Set<string> {
  const dir = locksDir();
  const live = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return live; // 无锁目录
  }
  for (const name of names) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) continue;
    const hash = name.slice(0, dot);
    const pid = Number(name.slice(dot + 1));
    if (isPidAlive(pid)) {
      live.add(hash);
    } else {
      try {
        unlinkSync(join(dir, name)); // 死 pid 的锁惰性回收
      } catch {
        // 清理失败不致命
      }
    }
  }
  return live;
}

/**
 * 内容寻址副本的 LRU 回收:`<treesDir>/<hash>` 数超过上限时,按 mtime 从旧到新淘汰,直到回到上限内。
 * **绝不删**被活进程占用的副本(`.locks/<hash>.<pid>` 且 pid 在世)—— 这才是「正在跑的 eval 的 cwd 不被删」
 * 的真实保证(不靠 mtime 当 liveness)。grace 窗口是第二道兜底。软上限:被占用/grace 内的大批新副本会暂时
 * 超限,待其释放/老化后回收。`.tmp-` 暂存与 `.locks` 不计、不删。
 * materializeIsolatedCopy 命中走 utimes 触碰(LRU touch)+ 落锁;未命中落盘后落锁并调本函数;也可独立调用。
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
    .filter((n) => !n.startsWith('.')) // 排除 .tmp- 暂存与 .locks
    .map((n) => {
      try {
        return { path: join(root, n), mtimeMs: statSync(join(root, n)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtimeMs: number } => x !== null);
  if (dirs.length <= cap) return;
  const locked = reapDeadLocks();
  dirs.sort((a, b) => a.mtimeMs - b.mtimeMs); // 最旧在前
  const cutoff = Date.now() - graceMs;
  let removable = dirs.length - cap;
  for (const d of dirs) {
    if (removable <= 0) break;
    if (locked.has(basename(d.path))) continue; // 活进程占用(可能是 active cwd),绝不删
    if (d.mtimeMs > cutoff) continue; // grace 内:第二道兜底
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
    // 命中:零 copy。utimes 触碰 mtime 作 LRU 标记 + 落 pid 占用锁(本进程将拿它当 cwd,prune 不许删)。
    try {
      const now = new Date();
      utimesSync(target, now, now);
    } catch {
      // 触碰失败不致命
    }
    markCopyInUse(contentHash);
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
    markCopyInUse(contentHash); // 先落占用锁,再 prune —— 保证本进程刚落的副本绝不被自己的 prune 删
    pruneTreesDir(); // 回收超限的旧副本(跳过活进程占用 + grace)
    return { copyRoot, contentHash, isDirectorySkill };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    // 并发竞态:另一进程已先 rename 到 target(非空)→ EEXIST/ENOTEMPTY;内容相同,复用。
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return { copyRoot, contentHash, isDirectorySkill };
    throw err;
  }
}
