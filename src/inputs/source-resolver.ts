import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDistributablePath } from '../managed/index.js';
import { classifyGitSkillRef, getGitRelativePath, gitJoin, gitLsTreeBlobs, gitShowBytes, skillNameFromPath } from './skill-loader.js';

/**
 * 安装源解析器 —— 把"各种源"物化成统一的本地形态,让 install / managed 主干**源无关**。
 * 新增一种源 = 加一个分支,install.ts 不动。本模块不依赖 CLI(不打印、不 tCli):错误以
 * `SourceResolveError(messageKey)` 抛出,由调用方(install)映射成本地化文案。
 *
 * 当前支持:`file`(本地路径)、`git`(当前仓库的某个 ref)。远端 git / URL clone 留作后续,
 * 沿同一 `ResolvedSource` 契约扩展即可。
 */

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

export class SourceResolveError extends Error {
  readonly messageKey: string;
  readonly params: Record<string, string | number>;
  constructor(messageKey: string, params: Record<string, string | number> = {}) {
    super(messageKey);
    this.name = 'SourceResolveError';
    this.messageKey = messageKey;
    this.params = params;
  }
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

/** 解析 `git:<ref>:<spec>`;`git:<spec>` 缺省 ref=HEAD。spec 可含路径(如 skills/review)。 */
function parseGitInput(input: string): { ref: string; spec: string } {
  const parts = input.slice('git:'.length).split(':');
  if (parts.length === 1) return { ref: 'HEAD', spec: parts[0] };
  return { ref: parts[0], spec: parts.slice(1).join(':') };
}

function resolveGitSource(input: string): ResolvedSource {
  const { ref, spec } = parseGitInput(input);
  // 空 spec / 空 ref 都拒:空 ref(`git::x`)会被 git 当 index/stage-0 解析,破坏"可复现、可重取"的前提。
  if (!spec || !ref) throw new SourceResolveError('cli.install.git_skill_not_found', { ref, name: spec });

  let gitRelDir: string;
  try {
    gitRelDir = getGitRelativePath(resolve('.'));
  } catch {
    throw new SourceResolveError('cli.install.not_a_git_repo', {});
  }

  const resolved = classifyGitSkillRef(ref, gitRelDir, spec);
  if (!resolved) {
    throw new SourceResolveError('cli.install.git_skill_not_found', { ref, name: spec });
  }

  const temp = mkdtempSync(join(tmpdir(), 'omk-install-git-'));
  const cleanup = (): void => {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不致命
    }
  };

  try {
    const locator = `git:${ref}:${spec}`;
    if (resolved.isDir) {
      for (const entry of gitLsTreeBlobs(ref, resolved.treePath)) {
        if (entry.mode === '120000' || entry.mode === '160000') continue; // 跳过软链 / submodule(与本地分发一致)
        if (!isDistributablePath(entry.path.split('/'))) continue; // 排除 .omk/.git/evolve 等
        const bytes = gitShowBytes(ref, gitJoin(resolved.treePath, entry.path));
        if (!bytes) continue;
        const dest = join(temp, entry.path);
        mkdirSync(dirname(dest), { recursive: true });
        // 保留可执行位(与本地 cpSync 一致);其余 0644。
        writeFileSync(dest, bytes, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
      }
      // 纵深防御:classify 与物化用的是两条 git 路径(gitShowFile vs ls-tree),万一发散(如 treePath 退化)
      // 导致空树,这里失败而非静默分发一个空 skill。
      if (!existsSync(join(temp, 'SKILL.md'))) {
        throw new SourceResolveError('cli.install.git_skill_not_found', { ref, name: spec });
      }
      return { sourceKind: 'git', localRoot: temp, name: resolved.name, isDirectorySkill: true, locator, ref, cleanup };
    }
    const bytes = gitShowBytes(ref, resolved.fileSkillPath);
    if (!bytes) throw new SourceResolveError('cli.install.git_skill_not_found', { ref, name: spec });
    const dest = join(temp, `${resolved.name}.md`);
    writeFileSync(dest, bytes);
    return { sourceKind: 'git', localRoot: dest, name: resolved.name, isDirectorySkill: false, locator, ref, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

