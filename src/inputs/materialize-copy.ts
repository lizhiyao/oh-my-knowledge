import { mkdtempSync, mkdirSync, cpSync, copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
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
 *  `OMK_TREES_DIR` 可重定位(测试隔离 / 用户迁移 / 后续 GC 命令复用)。 */
export function treesDir(): string {
  return process.env.OMK_TREES_DIR || join(homedir(), '.oh-my-knowledge', 'trees');
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
  if (existsSync(target)) return { copyRoot, contentHash, isDirectorySkill }; // 命中:零 copy

  mkdirSync(root, { recursive: true });
  const tmp = mkdtempSync(join(root, '.tmp-'));
  try {
    if (isDirectorySkill) {
      cpSync(localRoot, tmp, { recursive: true, filter: distributableCopyFilter(localRoot) });
    } else {
      copyFileSync(localRoot, join(tmp, `${name}.md`));
    }
    renameSync(tmp, target);
    return { copyRoot, contentHash, isDirectorySkill };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    // 并发竞态:另一进程已先 rename 到 target(非空)→ EEXIST/ENOTEMPTY;内容相同,复用。
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return { copyRoot, contentHash, isDirectorySkill };
    throw err;
  }
}
