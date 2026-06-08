import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { classifyGitSkillRef, parseGitInput, resolveGitRepoContext, materializeGitSkillTree, skillNameFromPath, SourceResolveError } from './skill-loader.js';
import { fetchRemoteGitRef } from './git-remote.js';

/**
 * 安装源解析器 —— 把"各种源"物化成统一的本地形态,让 install / managed 主干**源无关**。
 * 新增一种源 = 加一个分支,install.ts 不动。本模块不依赖 CLI(不打印、不 tCli):错误以
 * `SourceResolveError(messageKey)` 抛出,由调用方(install)映射成本地化文案。
 *
 * 当前支持:`file`(本地路径)、`git`(当前仓库的某个 ref)、远端 git(URL + ref,fetch 到临时 bare)。
 * 三者沿同一 `ResolvedSource` 契约,install / managed 主干源无关。
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
  /** 记录身份:file=绝对路径;本地 git=`git:<ref>:<spec>`;远端 git=`git+<url>@<sha>:<spec>`
   *  (均非临时物化路径;远端身份串仅作记录/相等比较,绝不回喂 parseGitInput 的 `:` 切分)。 */
  locator: string;
  /** git 来源的 ref;远端为 fetch 后 pin 的实际 SHA。 */
  ref?: string;
  /** 远端 git 的 URL(本地源 / 本地 git 无)。供受管记录结构化存、drift 重取,不挤进 locator 再 split。 */
  url?: string;
  /** 释放临时资源(git 删临时目录 / 远端另删 bare);file 源为 noop。 */
  cleanup: () => void;
}

const noop = (): void => {};

export function resolveInstallSource(input: string): ResolvedSource {
  if (input.startsWith('git:')) return resolveGitSource(input);
  return resolveFileSource(input);
}

/**
 * 远端 git 源:`<url>` + `<ref>` + repo 相对 `<spec>`(三者结构化传入,URL 不经任何字符串切分,
 * 避开 `parseGitInput` 的 `:` 与 `parseVariantCwd` 的 `@`)。fetch 到临时 bare → 复用既有
 * classifyGitSkillRef / materializeGitSkillTree(repoRoot 换成 bare)。locator 落 `git+<url>@<sha>:<spec>`
 * 仅作记录身份;url 另以结构化字段携带,供 drift 重取。失败 fail-closed 并清临时资源。
 */
export function resolveRemoteGitSource(url: string, ref: string, spec: string): ResolvedSource {
  const checkout = fetchRemoteGitRef(url, ref);
  try {
    // 远端 URL 指向仓库根,spec 是仓库相对路径 → gitRelDir 为空。
    const resolved = classifyGitSkillRef(checkout.ref, '', spec, checkout.repoRoot);
    if (!resolved) throw new SourceResolveError('cli.install.remote_skill_not_found', { url, ref: checkout.ref, name: spec });
    const mat = materializeGitSkillTree(checkout.ref, resolved, checkout.repoRoot);
    return {
      sourceKind: 'git',
      localRoot: mat.localRoot,
      name: mat.name,
      isDirectorySkill: mat.isDirectorySkill,
      locator: `git+${url}@${checkout.ref}:${spec}`,
      ref: checkout.ref,
      url,
      cleanup: () => {
        mat.cleanup();
        checkout.cleanup();
      },
    };
  } catch (err) {
    checkout.cleanup();
    throw err;
  }
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

