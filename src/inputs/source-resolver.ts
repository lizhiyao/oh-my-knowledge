import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isDistributablePath } from '../managed/index.js';
import { getGitRelativePath, gitLsTreeBlobs, gitShowBytes, gitShowFile, skillNameFromPath } from './skill-loader.js';

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
  if (isDir && !existsSync(join(abs, 'SKILL.md'))) {
    throw new SourceResolveError('cli.install.skillmd_missing', { path: abs });
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
  if (!spec) throw new SourceResolveError('cli.install.git_skill_not_found', { ref, name: spec });

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
        const bytes = gitShowBytes(ref, join(resolved.treePath, entry.path));
        if (!bytes) continue;
        const dest = join(temp, entry.path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
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

interface GitSkillRef {
  isDir: boolean;
  /** dir-skill 的子树根(仓库相对);file-skill 为空。 */
  treePath: string;
  /** file-skill 的 .md 路径(仓库相对);dir-skill 为空。 */
  fileSkillPath: string;
  name: string;
}

/**
 * 把 git spec 解析成 dir / file skill —— 与本地路径安装对称,接受三种写法:
 *   - 显式 SKILL.md:`skills/dir/SKILL.md` → 目录-skill,name 取父目录名;
 *   - 显式 .md:`skills/foo.md` → 文件-skill;
 *   - 裸 spec:`skills/review` → 先试 `<spec>/SKILL.md`(目录),再试 `<spec>.md`(文件)。
 * 任一探测命中即返回;都不中返回 null。
 */
function classifyGitSkillRef(ref: string, gitRelDir: string, spec: string): GitSkillRef | null {
  if (basename(spec) === 'SKILL.md') {
    if (gitShowFile(ref, join(gitRelDir, spec)) === null) return null;
    const dirSpec = dirname(spec);
    let name = basename(dirSpec);
    if (name === '.' || name === '') name = basename(gitRelDir) || 'skill';
    return { isDir: true, treePath: join(gitRelDir, dirSpec), fileSkillPath: '', name };
  }
  if (/\.md$/i.test(spec)) {
    const fileSkillPath = join(gitRelDir, spec);
    if (gitShowFile(ref, fileSkillPath) === null) return null;
    return { isDir: false, treePath: '', fileSkillPath, name: basename(spec).replace(/\.md$/i, '') };
  }
  if (gitShowFile(ref, join(gitRelDir, spec, 'SKILL.md')) !== null) {
    return { isDir: true, treePath: join(gitRelDir, spec), fileSkillPath: '', name: basename(spec) };
  }
  if (gitShowFile(ref, join(gitRelDir, `${spec}.md`)) !== null) {
    return { isDir: false, treePath: '', fileSkillPath: join(gitRelDir, `${spec}.md`), name: basename(spec) };
  }
  return null;
}
