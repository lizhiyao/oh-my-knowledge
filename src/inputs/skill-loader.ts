import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { resolve, join, relative, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractSkillHardRules, extractSkillWorkflows } from '../shared/hard-rules.js';
import type { Artifact } from '../types/index.js';

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
    return execFileSync('git', ['cat-file', 'blob', `${ref}:${filePath}`], { cwd, encoding: 'utf-8', stdio: GIT_PROBE_STDIO }).trim();
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
    return execFileSync('git', ['cat-file', 'blob', `${ref}:${filePath}`], { cwd, stdio: GIT_PROBE_STDIO }); // 无 encoding → Buffer
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
    out = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', `${ref}:${treePath}`], { cwd, encoding: 'utf-8', stdio: GIT_PROBE_STDIO });
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
  const anchor = realpathSync(nearestExistingDir(fromPath));
  const repoRoot = realpathSync(
    execFileSync('git', ['-C', anchor, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8', stdio: GIT_PROBE_STDIO }).trim(),
  );
  const absFrom = existsSync(resolve(fromPath)) ? realpathSync(resolve(fromPath)) : resolve(fromPath);
  return { repoRoot, relDir: relative(repoRoot, absFrom) };
}

/** 拼 git 仓库相对路径:始终用 `/`,空 base 直接返回 b(避免 join 产生 `.` 这类退化 tree-ish)。 */
export function gitJoin(base: string, sub: string): string {
  return base ? `${base}/${sub}` : sub;
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
  return Object.fromEntries(resolveArtifacts(skillDir, variants).map((artifact) => [artifact.name, artifact.content]));
}

/** opts for resolveArtifacts skill-isolation wiring. */
export interface ResolveArtifactsOptions {
  /** Default true. When true, baseline-kind artifacts get allowedSkills=[] auto-injected.
   *  显式 per-variant 隔离声明走 spec.allowedSkills(prepareEvaluationRun 按 spec 身份绑定),
   *  不经此处——resolveArtifacts 只认 strictBaseline 默认,隔离绑定收成单一来源。 */
  strictBaseline?: boolean;
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
  if (name.startsWith('git:')) {
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

/** variant 输入:纯 artifact 表达式字符串,或结构化的 `{expr, cwd?}`。cwd 不再编码进 expr。 */
export type VariantInput = string | { expr: string; cwd?: string };

export function resolveArtifacts(
  skillDir: string,
  variants: VariantInput[],
  opts: ResolveArtifactsOptions = {},
): Artifact[] {
  const strictBaseline = opts.strictBaseline ?? true;
  const artifacts: Artifact[] = [];
  let gitCtx: GitRepoContext | null = null;

  for (const rawVariant of variants) {
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
      const parts = variantName.slice(4).split(':');
      let ref: string;
      let name: string;
      if (parts.length === 1) {
        ref = 'HEAD';
        name = parts[0];
      } else {
        ref = parts[0];
        name = parts.slice(1).join(':');
      }
      // git 上下文锚定 skillDir 所属仓库(不是进程 cwd):从别处调用、skillDir 在另一个 repo 时也对。
      if (!gitCtx) gitCtx = resolveGitRepoContext(skillDir);
      // file-vs-dir 归类与 install 共用 classifyGitSkillRef(裸 spec 文件优先),两条路径绝不发散。
      const resolved = classifyGitSkillRef(ref, gitCtx.relDir, name, gitCtx.repoRoot);
      const content = resolved
        ? (resolved.isDir ? gitShowFile(ref, gitJoin(resolved.treePath, 'SKILL.md'), gitCtx.repoRoot) : gitShowFile(ref, resolved.fileSkillPath, gitCtx.repoRoot))
        : null;
      if (!content) {
        throw new Error(`skill not found in git ${ref}: ${name}.md or ${name}/SKILL.md`);
      }
      artifacts.push({
        name: variantName,
        kind: 'skill',
        source: 'git',
        content,
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
      artifacts.push({
        name,
        kind: 'skill',
        source: 'file-path',
        content,
        locator: filePath,
        cwd: variantCwd,
        ...(isSkillMd && { skillRoot: dirname(filePath) }),
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
        locator: mdPath,
        cwd: variantCwd,
        metadata: buildMetadata(content),
      });
    } else if (existsSync(dirSkillPath)) {
      // directory-skill:SKILL.md 引相对路径 assets,cwd 默认锚到 skill 根目录
      const content = readFileSync(dirSkillPath, 'utf-8').trim();
      artifacts.push({
        name: variantName,
        kind: 'skill',
        source: 'variant-name',
        content,
        locator: dirSkillPath,
        cwd: variantCwd,
        skillRoot: dirname(dirSkillPath),
        metadata: buildMetadata(content),
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
