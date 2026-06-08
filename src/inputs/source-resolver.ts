import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { classifyGitSkillRef, parseGitInput, resolveGitRepoContext, materializeGitSkillTree, skillNameFromPath, SourceResolveError } from './skill-loader.js';

/**
 * 安装源解析器 —— 把"各种源"物化成统一的本地形态,让 install / managed 主干**源无关**。
 * 新增一种源 = 加一个分支,install.ts 不动。本模块不依赖 CLI(不打印、不 tCli):错误以
 * `SourceResolveError(messageKey)` 抛出,由调用方(install)映射成本地化文案。
 *
 * 当前支持:`file`(本地路径)、`git`(当前仓库的某个 ref)。远端 git / URL clone 留作后续,
 * 沿同一 `ResolvedSource` 契约扩展即可。
 */

// SourceResolveError 住在 skill-loader(让共享 materializeGitSkillTree 能抛它而不成环);此处 re-export
// 保持 install 既有 import 不破。
export { SourceResolveError } from './skill-loader.js';

export type SourceKind = 'file' | 'git';

export interface ResolvedSource {
  sourceKind: SourceKind;
  /** 物化后的本地根:目录-skill 为目录、文件-skill 为 .md;喂 hashArtifactSource + 分发。 */
  localRoot: string;
  /** skill 短名(分发落点 / 记录 name)。 */
  name: string;
  isDirectorySkill: boolean;
  /** 记录身份:file=绝对路径;git=`git:<ref>:<spec>`(非临时物化路径)。 */
  locator: string;
  ref?: string;
  /** 释放临时资源(git 删临时目录);file 源为 noop。 */
  cleanup: () => void;
}

const noop = (): void => {};

export function resolveInstallSource(input: string): ResolvedSource {
  if (input.startsWith('git:')) return resolveGitSource(input);
  return resolveFileSource(input);
}

function resolveFileSource(input: string): ResolvedSource {
  const abs = resolve(input);
  if (!existsSync(abs)) throw new SourceResolveError('cli.install.path_not_found', { path: abs });
  const isDir = statSync(abs).isDirectory();
  if (isDir) {
    const skillMd = join(abs, 'SKILL.md');
    if (!existsSync(skillMd)) {
      throw new SourceResolveError('cli.install.skillmd_missing', { path: abs });
    }
    // 软链 SKILL.md 会被分发跳过(与 git 物化、cpSync 的软链策略一致)→ 装出空壳。指向真源,让记录落在真源上。
    if (lstatSync(skillMd).isSymbolicLink()) {
      throw new SourceResolveError('cli.install.skillmd_is_symlink', { target: realpathSync(skillMd) });
    }
  }
  if (!isDir && !/\.md$/i.test(abs)) {
    throw new SourceResolveError('cli.install.not_a_skill', { path: abs });
  }
  const name = isDir ? skillNameFromPath(join(abs, 'SKILL.md')) : skillNameFromPath(abs);
  return { sourceKind: 'file', localRoot: abs, name, isDirectorySkill: isDir, locator: abs, cleanup: noop };
}

function resolveGitSource(input: string): ResolvedSource {
  // 空 spec / 空 ref 由共享 parseGitInput 拒(返回 null):空 ref(`git::x`)会被 git 当 index/stage-0
  // 解析,破坏"可复现、可重取"的前提;eval 与 install 经同一 helper 判定一致。
  const parsed = parseGitInput(input);
  if (!parsed) throw new SourceResolveError('cli.install.git_skill_not_found', { ref: '', name: input });
  const { ref, spec } = parsed;

  let ctx;
  try {
    ctx = resolveGitRepoContext(resolve('.'));
  } catch {
    throw new SourceResolveError('cli.install.not_a_git_repo', {});
  }

  const resolved = classifyGitSkillRef(ref, ctx.relDir, spec, ctx.repoRoot);
  if (!resolved) {
    throw new SourceResolveError('cli.install.git_skill_not_found', { ref, name: spec });
  }

  // 物化复用共享 materializeGitSkillTree(install 与 eval 同一条物化路径);install 只需在其上补
  // locator / sourceKind 包成 ResolvedSource。
  const mat = materializeGitSkillTree(ref, resolved, ctx.repoRoot);
  return {
    sourceKind: 'git',
    localRoot: mat.localRoot,
    name: mat.name,
    isDirectorySkill: mat.isDirectorySkill,
    locator: `git:${ref}:${spec}`,
    ref,
    cleanup: mat.cleanup,
  };
}

