import { readFileSync, existsSync, readdirSync, statSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, relative, dirname, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { extractSkillHardRules, extractSkillWorkflows } from '../shared/hard-rules.js';
import { hashArtifactSource, hashBytes, isDistributablePath } from './content-hash.js';
import { materializeIsolatedCopy } from './materialize-copy.js';
import type { Artifact, RemoteGitRef } from '../types/index.js';

function parseFrontmatterPreflight(content: string): string[] | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  const frontmatter = match[1];
  // 解析 preflight 列表：支持 YAML 数组格式
  // preflight:
  //   - cmd1
  //   - cmd2
  const preflightMatch = frontmatter.match(/^preflight:\s*\r?\n((?:\s+-\s+.+\r?\n?)+)/m);
  if (preflightMatch) {
    const items = preflightMatch[1].match(/^\s+-\s+(.+)$/gm);
    if (items) return items.map(line => line.replace(/^\s+-\s+/, '').trim()).filter(Boolean);
  }
  // 单行格式：preflight: ["cmd1", "cmd2"]
  const inlineMatch = frontmatter.match(/^preflight:\s*\[([^\]]+)\]/m);
  if (inlineMatch) {
    return inlineMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return undefined;
}

function buildMetadata(content: string): Record<string, unknown> | undefined {
  const preflight = parseFrontmatterPreflight(content);
  const hardRules = extractSkillHardRules(content);
  const workflows = extractSkillWorkflows(content);
  const metadata: Record<string, unknown> = {};
  if (preflight && preflight.length > 0) metadata.preflight = preflight;
  if (hardRules.length > 0) metadata.hardRules = hardRules;
  if (workflows.length > 0) metadata.workflows = workflows;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

// 这些是**探测**(尝试某路径是否存在),miss 是正常流程,不是错误 → 吞掉 git 的 `fatal:` stderr,
// 否则一次成功的 install/eval 也会在用户终端打印吓人的 `fatal: path ... does not exist`。
const GIT_PROBE_STDIO: ['ignore', 'pipe', 'ignore'] = ['ignore', 'pipe', 'ignore'];

// 用 `cat-file blob` 而非 `git show`:`git show <ref>:<目录>` 对**目录**会退出码 0 并打印树清单
// (`tree <ref>:path\n\nSKILL.md`),被这里当成"文件存在 + 内容"误收 —— 名字以 .md 结尾的目录会被
// classify 误判为 file-skill、物化出树清单当 skill 正文,也会让 eval 把清单文本量成 skill 内容。
// `cat-file blob` 对非 blob(tree/submodule)直接非零退出,从根上只认 blob。对真 blob 字节与 show 一致。
// 所有 git helper 收 `cwd`(默认进程 cwd):git 解析必须在**目标仓库**里跑,否则 eval 从别处调用、
// skillDir 指向另一个 repo 时,会拿进程 cwd 的 repo 与 HEAD 去解析,轻则 not_found、重则评测错内容。
// 由 resolveGitRepoContext 解出 repoRoot 后逐处显式传入。
export function gitShowFile(ref: string, filePath: string, cwd: string = process.cwd()): string | null {
  try {
    // `--` 隔断 tree-ish:ref 可能来自盘上受管记录的 locator(用户可手改 / 随仓库分发,被 omk list 等只读
    // 命令喂进来),前缀 `-` 的 ref 不得被当成 git 选项解析(与 #219 fetch 路径同口径,见
    // feedback_git_subprocess_dashdash)。加 `--` 后 dash-ref 退化为「非法 object name」fail-closed,普通 ref 输出不变。
    return execFileSync('git', ['cat-file', 'blob', '--', `${ref}:${filePath}`], { cwd, encoding: 'utf-8', stdio: GIT_PROBE_STDIO }).trim();
  } catch {
    return null;
  }
}

/**
 * 取 `<ref>:<filePath>` 的原始字节(二进制资产用,不做 utf-8 解码);不存在/非 blob/出错返回 null。
 * 同 gitShowFile 用 `cat-file blob`:对目录会非零退出,不会把树清单字节当文件内容物化。
 */
export function gitShowBytes(ref: string, filePath: string, cwd: string = process.cwd()): Buffer | null {
  try {
    return execFileSync('git', ['cat-file', 'blob', '--', `${ref}:${filePath}`], { cwd, stdio: GIT_PROBE_STDIO }); // 无 encoding → Buffer;`--` 隔断同 gitShowFile
  } catch {
    return null;
  }
}

export interface GitTreeEntry {
  /** git 文件模式:100644/100755=普通文件,120000=软链,160000=submodule。 */
  mode: string;
  /** 相对所列 tree 的路径。 */
  path: string;
}

/**
 * 递归列出 `<ref>:<treePath>` 子树下的叶子条目(blob / 软链 / submodule)。tree 不存在返回 []。
 * 用 `-z`(NUL 分隔):git 不会对含换行 / 非 ASCII 的路径做 C-quote,路径原样可回喂 git show。
 * 用 `--full-tree`:treePath 是仓库根相对路径,不受当前 cwd 前缀限制 —— 否则在仓库子目录执行时
 * `ls-tree HEAD:skills/review` 会返回空(而 gitShowFile 探测不受限,导致"探测命中→物化为空"的发散)。
 * `treePath` 为空时列整棵根 tree(`<ref>:`)。
 */
export function gitLsTreeBlobs(ref: string, treePath: string, cwd: string = process.cwd()): GitTreeEntry[] {
  let out: string;
  try {
    out = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', '--', `${ref}:${treePath}`], { cwd, encoding: 'utf-8', stdio: GIT_PROBE_STDIO });
  } catch {
    return [];
  }
  const NUL = String.fromCharCode(0);
  const entries: GitTreeEntry[] = [];
  for (const rec of out.split(NUL)) {
    // 记录格式:`<mode> <type> <object>\t<path>`(path 可含换行,故用 [\s\S])。
    const m = rec.match(/^(\d+) \S+ \S+\t([\s\S]*)$/);
    if (m) entries.push({ mode: m[1], path: m[2] });
  }
  return entries;
}

export interface GitRepoContext {
  /** 仓库根(realpath 归一,避免 macOS /var ↔ /private/var 等价路径算错)。所有 git helper 以此为 cwd。 */
  repoRoot: string;
  /** fromPath 相对仓库根的路径(realpath 归一后计算)。 */
  relDir: string;
}

/** 从 p 起向上找最近的存在目录(skillDir 可能尚不在磁盘,但仍要定位它所属的 repo)。 */
function nearestExistingDir(p: string): string {
  let cur = resolve(p);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

/**
 * 解出 `fromPath` 所属 git 仓库的上下文。**关键**:`git rev-parse` 在 `fromPath` 处执行(-C),
 * 而非进程 cwd —— 否则 eval 从别处调用、skillDir 指向另一个 repo 时,会拿进程 cwd 的 repo root 和
 * HEAD 去解析,轻则 not_found、重则评测错 repo 的同名内容。repoRoot / relDir 都 realpath 归一,
 * 消除 /var ↔ /private/var 这类等价路径导致 relative 算错。不在 git 仓库时 rev-parse 抛错,由上层转
 * not_a_git_repo。stderr 吞掉,不双重打印 `fatal:`。
 */
export function resolveGitRepoContext(fromPath: string): GitRepoContext {
  const absInput = resolve(fromPath);
  const existing = nearestExistingDir(absInput);
  const anchor = realpathSync(existing);
  const repoRoot = realpathSync(
    execFileSync('git', ['-C', anchor, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8', stdio: GIT_PROBE_STDIO }).trim(),
  );
  // 对称归一:repoRoot 经 realpath,fromPath 也必须经同源 realpath,否则 fromPath 尚不在磁盘时
  // (纯 git eval:skill 只在 HEAD、工作树已删)absFrom 保留未归一字面,在 macOS /var ↔ /private/var
  // 这类等价路径上 relative 会算出越界的 `../../..` relDir → classify 探到仓库外 → 误报 not_found。
  // 做法:realpath 最近存在祖先,再拼回尚不存在的尾段(尾段为空即 fromPath 本身存在)。
  const tail = relative(existing, absInput);
  const absFrom = tail ? join(anchor, tail) : anchor;
  return { repoRoot, relDir: relative(repoRoot, absFrom) };
}

/** 拼 git 仓库相对路径:始终用 `/`,空 base 直接返回 b(避免 join 产生 `.` 这类退化 tree-ish)。 */
export function gitJoin(base: string, sub: string): string {
  return base ? `${base}/${sub}` : sub;
}

/**
 * 解析 `git:<ref>:<spec>` —— **install 与 eval 共用此一处**,保证两侧对 ref/spec 的切分与合法性
 * 判定一致。`git:<spec>` 缺省 ref=HEAD;spec 可含 `/`(如 skills/review)。空 ref / 空 spec 都非法
 * 并返回 null:空 ref(`git::x`)会被 git 当 index/stage-0 解析,量到不可复取、依赖本地暂存区的内容,
 * 破坏 git variant 的可复现语义;空 spec(`git:HEAD:`)会退化去探 `.md`/`SKILL.md` 误命中。
 */
export function parseGitInput(input: string): { ref: string; spec: string } | null {
  const parts = input.slice('git:'.length).split(':');
  const { ref, spec } = parts.length === 1
    ? { ref: 'HEAD', spec: parts[0] }
    : { ref: parts[0], spec: parts.slice(1).join(':') };
  if (!ref || !spec) return null;
  return { ref, spec };
}

export interface GitSkillRef {
  isDir: boolean;
  /** dir-skill 的子树根(仓库相对);file-skill 为空。 */
  treePath: string;
  /** file-skill 的 .md 路径(仓库相对);dir-skill 为空。 */
  fileSkillPath: string;
  name: string;
}

/**
 * 把 git spec 解析成 dir / file skill —— **install 与 eval 共用此一处**,保证两条路径对同一
 * `git:<ref>:<spec>` 的 file-vs-dir 归类绝不发散(发散会让 eval 量文件、install 注册目录,
 * 两边对不上)。接受三种写法,与本地路径安装对称:
 *   - 显式 SKILL.md:`skills/dir/SKILL.md` → 目录-skill,name 取父目录名;
 *   - 显式 .md:`skills/foo.md` → 文件-skill;
 *   - 裸 spec:`skills/review` → **文件优先**(先试 `<spec>.md`,再试 `<spec>/SKILL.md`)。
 * 裸 spec 的文件优先必须与 eval 历史顺序一致 —— 否则同名同时存在 .md 与 dir/SKILL.md 时,
 * eval 量文件、install 注册目录,evidence 读时按 hash 门控被静默剥离、记录永久 stale。
 * `gitRelDir` 是各调用方的解析基准(install=cwd 相对仓库根、eval=skillDir 相对仓库根),作为显式
 * 参数传入,基准差异留给调用方、归类逻辑单一来源。任一探测命中即返回;都不中返回 null。
 */
export function classifyGitSkillRef(ref: string, gitRelDir: string, spec: string, cwd: string = process.cwd()): GitSkillRef | null {
  if (basename(spec) === 'SKILL.md') {
    if (gitShowFile(ref, gitJoin(gitRelDir, spec), cwd) === null) return null;
    const dirSpec = dirname(spec);
    const treePath = dirSpec === '.' ? gitRelDir : gitJoin(gitRelDir, dirSpec);
    let name = basename(dirSpec);
    if (name === '.' || name === '') name = basename(treePath) || basename(gitRelDir) || 'skill';
    return { isDir: true, treePath, fileSkillPath: '', name };
  }
  if (/\.md$/i.test(spec)) {
    const fileSkillPath = gitJoin(gitRelDir, spec);
    if (gitShowFile(ref, fileSkillPath, cwd) === null) return null;
    return { isDir: false, treePath: '', fileSkillPath, name: basename(spec).replace(/\.md$/i, '') };
  }
  if (gitShowFile(ref, gitJoin(gitRelDir, `${spec}.md`), cwd) !== null) {
    return { isDir: false, treePath: '', fileSkillPath: gitJoin(gitRelDir, `${spec}.md`), name: basename(spec) };
  }
  if (gitShowFile(ref, gitJoin(gitJoin(gitRelDir, spec), 'SKILL.md'), cwd) !== null) {
    return { isDir: true, treePath: gitJoin(gitRelDir, spec), fileSkillPath: '', name: basename(spec) };
  }
  return null;
}

/**
 * 源解析的结构化错误 —— 不依赖 CLI:以 `messageKey` 抛出,由调用方(install 走 tCli、eval 走自身
 * 中文错误)映射成本地化文案。住在 skill-loader(而非 source-resolver)是为了让共享的
 * `materializeGitSkillTree` 能抛它而不致 skill-loader → source-resolver 反向成环;source-resolver
 * re-export 以保持 install 既有 import 不破。
 */
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

/**
 * 校验 git tree 条目路径在物化目标内,越界即 fail closed(抛 SourceResolveError)。
 * 双保险:既显式拒 `..` / 空段(git tree 可被手工构造出名为 `..` 的子树),也用 resolve 兜底
 * 确认落点仍在 temp 之下(绝对路径 / 符号化逃逸)。绝不静默跳过——跳过会让物化树与真实树发散。
 */
export function assertContainedRelPath(temp: string, relPath: string): void {
  const segments = relPath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new SourceResolveError('cli.install.git_unsafe_path', { path: relPath });
  }
  const root = resolve(temp);
  const dest = resolve(temp, relPath);
  if (dest !== root && !dest.startsWith(root + sep)) {
    throw new SourceResolveError('cli.install.git_unsafe_path', { path: relPath });
  }
}

export interface MaterializedGitTree {
  /** 物化后的本地根:目录-skill 为临时目录、文件-skill 为临时 .md;喂 hashArtifactSource + 分发。 */
  localRoot: string;
  isDirectorySkill: boolean;
  name: string;
  /** 释放临时目录;调用方务必 try/finally 调用(物化只为算哈/分发,用完即删)。 */
  cleanup: () => void;
}

/**
 * 把 git 某个 ref 上的 skill(已由 `classifyGitSkillRef` 归类)逐文件物化到临时目录 ——
 * **install 与 eval 共用此一处物化**,保证两侧拿到完全一致的本地树(此前 install/eval 各写一套
 * git 解析正是四轮 bug 的根源,已靠共享 helper 收敛)。eval 仅为算整树指纹(hashArtifactSource)而
 * 物化,算完即 cleanup;install 物化后分发并登记。失败(越界路径 / 空树 / 取不到 blob)抛
 * SourceResolveError,绝不静默落空壳。
 */
export function materializeGitSkillTree(ref: string, resolved: GitSkillRef, repoRoot: string): MaterializedGitTree {
  const temp = mkdtempSync(join(tmpdir(), 'omk-git-skill-'));
  const cleanup = (): void => {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不致命
    }
  };

  try {
    if (resolved.isDir) {
      for (const entry of gitLsTreeBlobs(ref, resolved.treePath, repoRoot)) {
        // 安全边界 fail closed:git tree 可被 git mktree 手工构造出名为 `..` 的子树,`ls-tree -r` 会
        // 吐 `../evil.txt`,`join(temp, ...)` 会逃出临时目录写盘、cleanup 也删不掉。任一越界路径直接抛错,
        // 而非静默跳过——静默跳过会让物化树与真实 git tree / hash / 分发树发散。正常 checkout 永不触发。
        assertContainedRelPath(temp, entry.path);
        if (entry.mode === '120000' || entry.mode === '160000') continue; // 跳过软链 / submodule(与本地分发一致)
        if (!isDistributablePath(entry.path.split('/'))) continue; // 排除 .omk/.git/evolve 等
        const bytes = gitShowBytes(ref, gitJoin(resolved.treePath, entry.path), repoRoot);
        if (!bytes) continue;
        const dest = join(temp, entry.path);
        mkdirSync(dirname(dest), { recursive: true });
        // 保留可执行位(与本地 cpSync 一致);其余 0644。
        writeFileSync(dest, bytes, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
      }
      // 纵深防御:classify 与物化用的是两条 git 路径(gitShowFile vs ls-tree),万一发散(如 treePath 退化)
      // 导致空树,这里失败而非静默物化一个空 skill。
      if (!existsSync(join(temp, 'SKILL.md'))) {
        throw new SourceResolveError('cli.install.git_skill_not_found', { ref, name: resolved.name });
      }
      return { localRoot: temp, isDirectorySkill: true, name: resolved.name, cleanup };
    }
    const bytes = gitShowBytes(ref, resolved.fileSkillPath, repoRoot);
    if (!bytes) throw new SourceResolveError('cli.install.git_skill_not_found', { ref, name: resolved.name });
    const dest = join(temp, `${resolved.name}.md`);
    writeFileSync(dest, bytes);
    return { localRoot: dest, isDirectorySkill: false, name: resolved.name, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export interface RemoteGitCheckout {
  /** 临时 bare 仓库路径,作为 git helper 的 cwd(repoRoot)。 */
  repoRoot: string;
  /** fetch 落地后 rev-parse 出的**实际 SHA**(branch/tag 会漂,记录与重取都钉 SHA)。 */
  ref: string;
  /** 删临时 bare 仓库;调用方务必 try/finally 调用。 */
  cleanup: () => void;
}

/**
 * 远端 git URL 形态校验:接受 https(s):// / ssh:// / git:// / file:// 协议 URL、scp 形式
 * `user@host:path`、绝对本地路径(file 远端 / 测试)。明显非法(空、相对裸串)拒。
 */
export function isPlausibleGitUrl(url: string): boolean {
  if (!url) return false;
  if (/^(https?|ssh|git|file):\/\//i.test(url)) return true;
  if (/^[\w.-]+@[\w.-]+:/.test(url)) return true;
  if (/^\//.test(url)) return true;
  return false;
}

/**
 * 远端 git:clone 某 ref 到临时 bare 仓库、pin 实际 SHA —— **install 与 eval 共用此一处**,远端只是
 * 把下游 git helper(classifyGitSkillRef / materializeGitSkillTree)的 repoRoot 从「当前仓库」换成
 * 「fetch 下来的临时 bare」,其余一字不改。`git init --bare` + `git fetch --depth 1`(省带宽,只取该
 * ref 的 tip 树);ref 为 branch/tag/HEAD 通用,裸 SHA 取决于服务端是否允许 reachable-SHA fetch。
 * 认证依赖本机 git 凭证(SSH agent / credential helper),omk 不自管 token。失败 fail-closed
 * (SourceResolveError),由调用方本地化;eval 侧捕获后改抛中文 Error。
 */
export function fetchRemoteGitRef(url: string, ref: string): RemoteGitCheckout {
  if (!isPlausibleGitUrl(url)) throw new SourceResolveError('cli.install.invalid_remote_url', { url });
  const bare = mkdtempSync(join(tmpdir(), 'omk-git-remote-'));
  const cleanup = (): void => {
    try {
      rmSync(bare, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不致命
    }
  };
  try {
    execFileSync('git', ['init', '--bare', '--quiet', bare], { stdio: GIT_PROBE_STDIO });
    try {
      // `--` 隔断:git fetch 会扫描**全部** argv 找带短横的选项,不止第一个。少了 `--`,一个形如
      // `--upload-pack=<cmd>` 的 ref 会被当成选项执行任意命令(RCE)。`--` 后一切按位置参数
      // (repository + refspec)解析,恶意 ref 退化成非法 refspec、fail-closed。url 也一并护在 `--` 后。
      execFileSync(
        'git',
        ['--git-dir', bare, 'fetch', '--depth', '1', '--quiet', '--', url, `${ref}:refs/omk/fetched`],
        { stdio: GIT_PROBE_STDIO },
      );
    } catch {
      throw new SourceResolveError('cli.install.remote_fetch_failed', { url, ref });
    }
    let sha: string;
    try {
      sha = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/omk/fetched'], {
        encoding: 'utf-8',
        stdio: GIT_PROBE_STDIO,
      }).trim();
    } catch {
      throw new SourceResolveError('cli.install.remote_ref_not_found', { url, ref });
    }
    if (!sha) throw new SourceResolveError('cli.install.remote_ref_not_found', { url, ref });
    return { repoRoot: bare, ref: sha, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export function discoverVariants(skillDir: string): string[] {
  if (!existsSync(skillDir)) return [];

  const entries = readdirSync(skillDir);
  const variants: string[] = [];

  for (const entry of entries) {
    if (entry.endsWith('.md')) {
      variants.push(entry.slice(0, -3));
      continue;
    }

    const entryPath = join(skillDir, entry);
    const skillMd = join(entryPath, 'SKILL.md');
    if (statSync(entryPath).isDirectory() && existsSync(skillMd)) {
      variants.push(entry);
    }
  }

  variants.sort();
  if (variants.length === 1) {
    variants.unshift('baseline');
  }
  return variants;
}

export function discoverBatchSkills(skillDir: string): Array<{ name: string; skillPath: string; samplesPath: string }> {
  if (!existsSync(skillDir)) return [];

  const entries = readdirSync(skillDir);
  const skills: Array<{ name: string; skillPath: string; samplesPath: string }> = [];
  const warned: string[] = [];

  for (const entry of entries) {
    const entryPath = join(skillDir, entry);
    const mdMatch = entry.endsWith('.md') && !entry.endsWith('.eval-samples.json');

    if (mdMatch) {
      const name = entry.slice(0, -3);
      const candidates = [
        join(skillDir, name, '.omk'),
        join(skillDir, `${name}.eval-samples.json`),
        join(skillDir, `${name}.eval-samples.yaml`),
        join(skillDir, `${name}.eval-samples.yml`),
      ].filter(existsSync);
      if (candidates.length > 0) {
        skills.push({ name, skillPath: join(skillDir, entry), samplesPath: candidates[0] });
      } else {
        warned.push(name);
      }
      continue;
    }

    if (statSync(entryPath).isDirectory()) {
      const skillMd = join(entryPath, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      // .omk/ dir (loadSamples handles dir mode) > .omk/samples.json > eval-samples.{json,yaml,yml}
      const omkDir = join(entryPath, '.omk');
      const candidates = [
        ...(existsSync(omkDir) ? [omkDir] : []),
        join(entryPath, 'eval-samples.json'),
        join(entryPath, 'eval-samples.yaml'),
        join(entryPath, 'eval-samples.yml'),
      ];
      const samplesPath = candidates.find(existsSync);
      if (samplesPath) {
        skills.push({ name: entry, skillPath: skillMd, samplesPath });
      } else {
        warned.push(entry);
      }
    }
  }

  for (const name of warned) {
    process.stderr.write(`⚠️  skipping ${name}: paired eval-samples not found\n`);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

export function loadSkills(skillDir: string, variants: string[]): Record<string, string | null> {
  // 只取 content 映射,不执行 → 不落副本(materialize:false)。
  return Object.fromEntries(resolveArtifacts(skillDir, variants, { materialize: false }).map((artifact) => [artifact.name, artifact.content]));
}

/** opts for resolveArtifacts skill-isolation wiring. */
export interface ResolveArtifactsOptions {
  /** Default true. When true, baseline-kind artifacts get allowedSkills=[] auto-injected.
   *  显式 per-variant 隔离声明走 spec.allowedSkills(prepareEvaluationRun 按 spec 身份绑定),
   *  不经此处——resolveArtifacts 只认 strictBaseline 默认,隔离绑定收成单一来源。 */
  strictBaseline?: boolean;
  /** Default true. dir-skill 是否落地隔离副本(写 `~/.oh-my-knowledge/trees` 并设 execRoot)。
   *  只有 eval(执行隔离)需要;doctor / loadSkills 等纯读路径传 false,只算指纹与正文、不写副本。 */
  materialize?: boolean;
}

/**
 * Parse variant expression, extracting optional cwd suffix.
 * Format: "name@/path/to/cwd" or just "name"
 */
export function parseVariantCwd(variant: string): { name: string; cwd?: string } {
  // 找 name@cwd 的切分点:跳过 git 修订语法里的 `@{...}`(reflog `HEAD@{2}`、upstream
  // `main@{u}`),取第一个不是紧跟 `{` 的 `@`。这样 `git:v1@/proj`(git artifact + cwd,
  // eval.yaml 经 configVariantsToSpecs 生成的形态)仍能切出 cwd,而 `git:HEAD@{2}:x`
  // (无 cwd)不会被误拆成 name=`git:HEAD`、cwd=`{2}:x` → 下游静默评测错版本。
  let atIdx = -1;
  for (let i = variant.indexOf('@'); i !== -1; i = variant.indexOf('@', i + 1)) {
    if (variant[i + 1] !== '{') { atIdx = i; break; }
  }
  if (atIdx === -1) return { name: variant };
  return { name: variant.slice(0, atIdx), cwd: variant.slice(atIdx + 1) };
}

/** 把一个路径折叠到稳定的 skill 锚点:目录型 skill 与其 `SKILL.md` 归一到同一个
 *  `dir/SKILL.md`,单文件 .md 用其路径本身。返回路径(不解物理身份),供取短名与身份判重共用。 */
function canonicalSkillAnchor(absPath: string): string {
  return existsSync(absPath) && statSync(absPath).isDirectory() ? join(absPath, 'SKILL.md') : absPath;
}

/** 路径的稳定物理身份:存在则取 `dev:ino`(解符号链接、折叠大小写不敏感卷的等价写法、认硬链),
 *  不存在则退回原路径串。判重必须用物理身份——纯字符串 resolve 会把同一文件的软链/大小写/
 *  绝对 vs CWD 相对写法判成两个 variant,放过真重复 → 同一份 skill 自比、悄悄废掉对比保护。 */
function pathPhysicalId(p: string): string {
  try {
    const st = statSync(p);
    return `ino:${st.dev}:${st.ino}`;
  } catch {
    return p;
  }
}

/** 把一个 variant 表达式规范化成稳定的物理身份,用于「同一 variant 不能既是 control 又是
 *  treatment」的判重。同一份 skill 的不同写法必须折叠成同一个 key:
 *    - `./x.md` 与 `x.md`、符号链接、大小写不敏感卷上的等价写法:resolve 后取 `dev:ino` 物理身份。
 *    - 目录 `dir` 与 `dir/SKILL.md`：先折叠到同一锚点再取物理身份。
 *    - 裸短名(传了 `skillDir` 时):按 resolveArtifacts 的解析基准(`skillDir/name.md` 或
 *      `skillDir/name/SKILL.md`)取物理身份,这样裸名 `greeter` 与指向同一文件的 `./greeter.md`
 *      能判为重复;没传 skillDir(如纯单测)则退回字面名。
 *    - `git:` / `baseline`：本身就是稳定标识,原样返回。
 *  结构化的 `cwd`(第三参数)按物理身份纳入 key —— 同一份 skill 绑不同 cwd 是不同 runtime
 *  context,不算重复。不要用派生短名判重:`v1/greeter.md` 与 `v2/greeter.md` 短名都是 greeter
 *  却是两个 variant。 */
export function variantIdentity(expr: string, skillDir?: string, cwd?: string): string {
  // expr 已是纯 artifact 身份(@cwd 在 CLI/config 边界已剥离);cwd 结构化显式传入。
  const name = expr;
  let id: string;
  if (name.startsWith('git:') || name.startsWith('git+')) {
    // 本地 git:<ref>:<spec> 与远端 git+<url>@<sha>:<spec> 都是稳定身份串,原样作 key,绝不再 split。
    id = name;
  } else if (name === 'baseline') {
    id = 'baseline';
  } else if (name.includes('/') || /\.md$/i.test(name)) {
    id = pathPhysicalId(canonicalSkillAnchor(resolve(name)));
  } else if (skillDir) {
    // 裸短名按 resolveArtifacts 的同一基准(skillDir/name.md 或 skillDir/name/SKILL.md)解析,
    // 命不中就退回字面名(resolveArtifacts 随后会报 not found)。
    const md = join(skillDir, `${name}.md`);
    const dirMd = join(skillDir, name, 'SKILL.md');
    id = existsSync(md) ? pathPhysicalId(md) : existsSync(dirMd) ? pathPhysicalId(dirMd) : name;
  } else {
    id = name; // 无 skillDir 上下文:不同短名即不同 variant
  }
  return cwd ? `${id}@${pathPhysicalId(resolve(cwd))}` : id;
}

/** 从已解析的 skill 路径取短名:`SKILL.md` 取其父目录名,否则取去掉 `.md` 后缀的 basename。
 *  `variantExprToSkillName`(expr → 短名)与 `resolveArtifacts` 的 file-path 命名共用这一处,
 *  避免两份各写一遍后悄悄发散——report 键就来自 resolveArtifacts 这一支。 */
export function skillNameFromPath(filePath: string): string {
  const base = basename(filePath);
  return base === 'SKILL.md' ? basename(dirname(filePath)) : base.replace(/\.md$/i, '');
}

/** 从 variant 表达式(纯 artifact 身份,可能是路径)取短名。 */
export function variantExprToSkillName(expr: string): string {
  if (expr.startsWith('git:')) return expr;
  if (!expr.includes('/')) return expr;
  // 先折叠 dir↔SKILL.md 再取短名,与 resolveArtifacts 的命名一致(否则 `weird.md/` 这类
  // 以 .md 结尾的目录,两处会派生出不同短名)。
  return skillNameFromPath(canonicalSkillAnchor(resolve(expr))) || expr;
}

/** variant 输入:纯 artifact 表达式字符串、结构化 `{expr, cwd?}`、或远端 git 结构化 `{git, cwd?, name}`
 *  (url/ref/spec 分字段,绝不拼成单串再经 parseGitInput/parseVariantCwd 切分)。 */
export type VariantInput =
  | string
  | { expr: string; cwd?: string }
  | { git: RemoteGitRef; cwd?: string; name: string };

/**
 * 解析一个目录-skill 的整树指纹 + SKILL.md 正文;`materialize` 为真时另落地内容寻址隔离副本、返回执行根。
 * 本地源 localDir 是真源目录;git 源 localDir 是 materializeGitSkillTree 物化出的临时目录。
 * execRoot(副本)供 executor cwd / skillDir 锚定;skillRoot(真源)由各分支自行保留。
 * 只有 eval 路径需要副本(执行隔离);doctor / loadSkills 只需指纹与正文,materialize=false 不落副本、
 * 不写 `~/.oh-my-knowledge/trees`(避免纯读路径的副作用 I/O 与 trees 污染)。
 */
function isolateDirSkill(localDir: string, name: string, materialize: boolean): { execRoot?: string; contentHash: string; content: string } {
  const content = readFileSync(join(localDir, 'SKILL.md'), 'utf-8').trim();
  if (materialize) {
    const copy = materializeIsolatedCopy(localDir, true, name);
    return { execRoot: copy.copyRoot, contentHash: copy.contentHash, content };
  }
  return { contentHash: hashArtifactSource(localDir, true), content };
}

/**
 * 远端 git variant:fetch 到临时 bare → classify → materialize 临时树 → 隔离副本(dir,materialize 时)
 * 或单文件字节(file)。url/ref/spec 全程结构化,locator 落 `git+<url>@<sha>:<spec>` 身份串。
 * SourceResolveError(install 口径的 messageKey)在此转成 eval 的中文 Error。临时树与 bare 用完即清。
 */
function resolveRemoteGitVariant(
  input: { git: RemoteGitRef; cwd?: string; name: string },
  materialize: boolean,
  artifacts: Artifact[],
): void {
  const { url, spec } = input.git;
  const ref = input.git.ref ?? 'HEAD';
  let checkout: RemoteGitCheckout;
  try {
    checkout = fetchRemoteGitRef(url, ref);
  } catch (err) {
    if (err instanceof SourceResolveError) {
      const zh = err.messageKey === 'cli.install.invalid_remote_url'
        ? `不是合法的 git 远端 URL：${url}`
        : `从远端 ${url} 拉取 ref ${ref} 失败，请检查 URL / ref 是否存在与本机 git 凭证。`;
      throw new Error(zh);
    }
    throw err;
  }
  try {
    const resolved = classifyGitSkillRef(checkout.ref, '', spec, checkout.repoRoot);
    if (!resolved) throw new Error(`在远端 ${url} 的 ref ${ref} 下找不到 skill ${spec}（既无 ${spec}/SKILL.md 也无 ${spec}.md）。`);
    const mat = materializeGitSkillTree(checkout.ref, resolved, checkout.repoRoot);
    try {
      const locator = `git+${url}@${checkout.ref}:${spec}`;
      if (resolved.isDir) {
        const iso = isolateDirSkill(mat.localRoot, resolved.name, materialize);
        artifacts.push({
          name: input.name,
          kind: 'skill',
          source: 'git',
          content: iso.content,
          contentHash: iso.contentHash,
          locator,
          ref: checkout.ref,
          cwd: input.cwd,
          ...(iso.execRoot ? { execRoot: iso.execRoot } : {}),
        });
      } else {
        const bytes = readFileSync(mat.localRoot);
        artifacts.push({
          name: input.name,
          kind: 'skill',
          source: 'git',
          content: bytes.toString('utf-8').trim(),
          contentHash: hashArtifactSource(mat.localRoot, false),
          locator,
          ref: checkout.ref,
          cwd: input.cwd,
        });
      }
    } finally {
      mat.cleanup();
    }
  } finally {
    checkout.cleanup();
  }
}

export function resolveArtifacts(
  skillDir: string,
  variants: VariantInput[],
  opts: ResolveArtifactsOptions = {},
): Artifact[] {
  const strictBaseline = opts.strictBaseline ?? true;
  const materialize = opts.materialize ?? true;
  const artifacts: Artifact[] = [];
  let gitCtx: GitRepoContext | null = null;

  for (const rawVariant of variants) {
    // 远端 git 结构化输入:url/ref/spec 分字段,fetch 到临时 bare 后复用 classify/materialize/隔离副本,
    // URL 全程不经任何字符串切分(避开 parseGitInput 的 `:` 与 parseVariantCwd 的 `@`)。
    if (typeof rawVariant === 'object' && 'git' in rawVariant) {
      resolveRemoteGitVariant(rawVariant, materialize, artifacts);
      continue;
    }
    // 字符串即纯 expr(无 cwd);结构化对象直接取 expr/cwd。不再 split @cwd。
    const variantName = typeof rawVariant === 'string' ? rawVariant : rawVariant.expr;
    const variantCwd = typeof rawVariant === 'string' ? undefined : rawVariant.cwd;

    if (!variantName) {
      throw new Error(`variant 名不能为空。如需绑定 runtime context,用 --control-cwd / --treatment-cwd 或 eval.yaml 的 variant.cwd。`);
    }

    if (variantName === 'baseline' && variantCwd) {
      throw new Error('baseline cannot be bound to a cwd. To express a project-level runtime context, use a custom label + cwd (e.g. --treatment project-env --treatment-cwd /path).');
    }

    if (variantName === 'baseline') {
      artifacts.push({
        name: variantName,
        kind: 'baseline',
        source: 'baseline',
        content: null,
        cwd: variantCwd,
      });
      continue;
    }

    if (variantName.startsWith('git:')) {
      // 与 install 共用 parseGitInput:空 ref(`git::x`,会被 git 当 index 量本地暂存区、不可复取)/
      // 空 spec(`git:HEAD:`)一律拒,守住 git variant 的可复现语义。
      const parsed = parseGitInput(variantName);
      if (!parsed) {
        throw new Error(`无效的 git variant "${variantName}"：ref 与 skill 名都不能为空，应为 git:<ref>:<name>（如 git:HEAD:review）。`);
      }
      const { ref, spec: name } = parsed;
      // git 上下文锚定 skillDir 所属仓库(不是进程 cwd):从别处调用、skillDir 在另一个 repo 时也对。
      if (!gitCtx) gitCtx = resolveGitRepoContext(skillDir);
      // file-vs-dir 归类与 install 共用 classifyGitSkillRef(裸 spec 文件优先),两条路径绝不发散。
      const resolved = classifyGitSkillRef(ref, gitCtx.relDir, name, gitCtx.repoRoot);
      if (!resolved) {
        throw new Error(`skill not found in git ${ref}: ${name}.md or ${name}/SKILL.md`);
      }
      if (resolved.isDir) {
        // git 目录-skill 忠实执行:物化整树到临时目录 → 落地内容寻址隔离副本 → executor cwd 锚副本,
        // agent 读得到 references/ 资产、资产成为真实运行时输入。整树指纹与 install 受管记录的
        // contentHash 落同一空间 → evidence 可绑(见 docs/specs/evidence-gated-management.md §9)。
        const mat = materializeGitSkillTree(ref, resolved, gitCtx.repoRoot);
        let isolated: { execRoot?: string; contentHash: string; content: string };
        try {
          isolated = isolateDirSkill(mat.localRoot, resolved.name, materialize);
        } finally {
          mat.cleanup(); // 临时物化树只为喂副本,落地完即删
        }
        artifacts.push({
          name: variantName,
          kind: 'skill',
          source: 'git',
          content: isolated.content,
          contentHash: isolated.contentHash,
          locator: name,
          ref,
          cwd: variantCwd,
          ...(isolated.execRoot ? { execRoot: isolated.execRoot } : {}),
        });
        continue;
      }
      // git 文件-skill:单个 .md 字节(与 install 单文件分支「不 trim」一致),无资产、本就与本地 /
      // file 源同空间可绑,不走副本。
      const skillMdBytes = gitShowBytes(ref, resolved.fileSkillPath, gitCtx.repoRoot);
      const content = skillMdBytes !== null ? skillMdBytes.toString('utf-8').trim() : null;
      if (!skillMdBytes || !content) {
        throw new Error(`skill not found in git ${ref}: ${name}.md or ${name}/SKILL.md`);
      }
      artifacts.push({
        name: variantName,
        kind: 'skill',
        source: 'git',
        content,
        contentHash: hashBytes(skillMdBytes),
        locator: name,
        ref,
        cwd: variantCwd,
      });
      continue;
    }

    if (variantName.includes('/')) {
      let filePath = resolve(variantName);
      if (!existsSync(filePath)) {
        throw new Error(`skill file not found: ${filePath}`);
      }
      if (statSync(filePath).isDirectory()) {
        const skillMd = join(filePath, 'SKILL.md');
        if (!existsSync(skillMd)) {
          throw new Error(`目录下未找到 SKILL.md: ${filePath}`);
        }
        filePath = skillMd;
      }
      const content = readFileSync(filePath, 'utf-8').trim();
      const isSkillMd = basename(filePath) === 'SKILL.md';
      const name = skillNameFromPath(filePath);
      if (isSkillMd) {
        // dir-skill:落地隔离副本,执行根锚副本(agent 读 references)、整树指纹;skillRoot 仍记真源(doctor 等用)。
        const isolated = isolateDirSkill(dirname(filePath), name, materialize);
        artifacts.push({
          name,
          kind: 'skill',
          source: 'file-path',
          content: isolated.content,
          contentHash: isolated.contentHash,
          locator: filePath,
          cwd: variantCwd,
          skillRoot: dirname(filePath),
          ...(isolated.execRoot ? { execRoot: isolated.execRoot } : {}),
          metadata: buildMetadata(isolated.content),
        });
        continue;
      }
      // 裸 .md 文件-skill:单文件字节,无资产不 copy。
      artifacts.push({
        name,
        kind: 'skill',
        source: 'file-path',
        content,
        contentHash: hashArtifactSource(filePath, false),
        locator: filePath,
        cwd: variantCwd,
        metadata: buildMetadata(content),
      });
      continue;
    }

    const mdPath = join(skillDir, `${variantName}.md`);
    const dirSkillPath = join(skillDir, variantName, 'SKILL.md');
    if (existsSync(mdPath)) {
      // file-skill:单文件 .md,无 asset 概念,cwd 走默认(用户项目目录),不设 skillRoot
      const content = readFileSync(mdPath, 'utf-8').trim();
      artifacts.push({
        name: variantName,
        kind: 'skill',
        source: 'variant-name',
        content,
        contentHash: hashArtifactSource(mdPath, false),
        locator: mdPath,
        cwd: variantCwd,
        metadata: buildMetadata(content),
      });
    } else if (existsSync(dirSkillPath)) {
      // directory-skill:SKILL.md 引相对路径 assets;落地隔离副本,executor cwd 锚副本读 references,
      // skillRoot 仍记真源(doctor / dependency-checker 用)。
      const isolated = isolateDirSkill(dirname(dirSkillPath), variantName, materialize);
      artifacts.push({
        name: variantName,
        kind: 'skill',
        source: 'variant-name',
        content: isolated.content,
        contentHash: isolated.contentHash,
        locator: dirSkillPath,
        cwd: variantCwd,
        skillRoot: dirname(dirSkillPath),
        ...(isolated.execRoot ? { execRoot: isolated.execRoot } : {}),
        metadata: buildMetadata(isolated.content),
      });
    } else if (variantCwd) {
      artifacts.push({
        name: variantName,
        kind: 'baseline',
        source: 'custom',
        content: null,
        cwd: variantCwd,
      });
    } else {
      throw new Error(`skill not found: ${mdPath} or ${dirSkillPath}`);
    }
  }

  // Skill-isolation:resolveArtifacts 只负责 strictBaseline 默认——strictBaseline=true 时
  //   所有 kind:'baseline' artifact 默认 allowedSkills=[];否则保持 undefined → SDK 全量发现。
  //   per-variant 显式隔离声明(eval.yaml variants[].allowedSkills)统一走 spec.allowedSkills,
  //   由 prepareEvaluationRun 按 spec 身份绑定;batch 的 eval.yaml allowedSkills 也已在
  //   buildBatchVariantSpecs 处挂到 spec 上。隔离绑定收成单一来源,这里不再按名查。
  for (const artifact of artifacts) {
    if (strictBaseline && artifact.kind === 'baseline') {
      artifact.allowedSkills = [];
    }
  }

  ensureUniqueVariantNames(artifacts);
  return artifacts;
}

/** variant 短名的消歧路径:取「短名所源自的那一段」所在的完整路径,用来逐段往前限定。
 *  - dir/SKILL.md 或 dir-variant:skillRoot(= 那个 skill 目录,basename 即短名)
 *  - 单文件 .md:locator 去掉 .md(basename 即短名)
 *  - baseline / git variant:无可用路径(git 名本就唯一,baseline 不参与对比键),返回 null。 */
function identityPathOf(a: Artifact): string | null {
  if (a.kind !== 'skill' || a.source === 'git' || !a.locator) return null;
  return a.skillRoot ?? a.locator.replace(/\.md$/i, '');
}

/** 消歧:多个 variant resolve 出同名时(如 `v1/greeter.md` vs `v2/greeter.md` 都叫 `greeter`),
 *  用父目录逐段限定恢复唯一性。否则 `results[sample][variant]` / `summary[variant]` 按 name 键时
 *  后写覆盖前写,把对照 / 实验组的结果搅在一起、verdict 拿同名跟自己比 —— 静默破坏对比可信度。
 *  没有可用路径(baseline / git)时退化加 `#n` 序号兜底,保证返回的 name 一定两两不同。 */
export function ensureUniqueVariantNames(artifacts: Artifact[]): void {
  const groups = new Map<string, Artifact[]>();
  for (const a of artifacts) {
    const g = groups.get(a.name);
    if (g) g.push(a);
    else groups.set(a.name, [a]);
  }
  if (![...groups.values()].some((g) => g.length > 1)) return; // 无冲突,常见路径直接返回

  const used = new Set<string>();
  for (const [name, g] of groups) if (g.length === 1) used.add(name);

  for (const [name, g] of groups) {
    if (g.length === 1) continue;
    // 找能让组内全部区分、又不撞已用名的最小段深,组内统一用同一深度 → 对称标签(v1/greeter 对 v2/greeter)
    const segLists = g.map((a) => {
      const p = identityPathOf(a);
      return p ? p.split(/[\\/]+/).filter(Boolean) : null;
    });
    const maxDepth = Math.max(0, ...segLists.map((s) => s?.length ?? 0));
    let chosen: string[] | null = null;
    for (let take = 2; take <= maxDepth; take++) {
      const cands = segLists.map((s) => (s && s.length >= take ? s.slice(-take).join('/') : null));
      if (cands.includes(null)) continue;
      if (new Set(cands).size === cands.length && cands.every((c) => !used.has(c as string))) {
        chosen = cands as string[];
        break;
      }
    }
    g.forEach((a, i) => {
      const candidate = chosen ? chosen[i] : name; // 无可用路径(baseline 等)退化到原名 + #n 序号
      let unique = candidate;
      for (let n = 2; used.has(unique); n++) unique = `${candidate}#${n}`;
      a.name = unique;
      used.add(unique);
    });
  }
}
