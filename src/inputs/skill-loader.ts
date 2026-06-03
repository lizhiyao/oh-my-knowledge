import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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

function gitShowFile(ref: string, filePath: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${filePath}`], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function getGitRelativePath(absolutePath: string): string {
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
  return relative(gitRoot, absolutePath);
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
  /** Default true. When true, baseline-kind artifacts get allowedSkills=[] auto-injected
   *  unless overridden by variantAllowedSkills. */
  strictBaseline?: boolean;
  /** Per-variant explicit allowedSkills (from eval.yaml). Keyed by variant name (post
   *  parseVariantCwd, matches Artifact.name). Always overrides strictBaseline default. */
  variantAllowedSkills?: Record<string, string[]>;
}

/**
 * Parse variant expression, extracting optional cwd suffix.
 * Format: "name@/path/to/cwd" or just "name"
 */
export function parseVariantCwd(variant: string): { name: string; cwd?: string } {
  const atIdx = variant.indexOf('@');
  if (atIdx === -1) return { name: variant };
  return { name: variant.slice(0, atIdx), cwd: variant.slice(atIdx + 1) };
}

/** 把一个 variant 表达式规范化成稳定的物理身份,用于「同一 variant 不能既是 control 又是
 *  treatment」的判重。同一份 skill 的不同写法必须折叠成同一个 key:
 *    - `./x.md` 与 `x.md`：路径型一律 `resolve(...)` 成绝对路径。
 *    - 目录 `dir` 与 `dir/SKILL.md`：都折叠到该目录下的 SKILL.md(skill 根的稳定锚点)。
 *    - `git:` / `baseline`：本身就是稳定标识,原样返回。
 *  `@cwd` 也规范化后纳入 key —— 同一份 skill 绑不同 cwd 是不同 runtime context,不算重复。
 *  不要用派生短名判重:`v1/greeter.md` 与 `v2/greeter.md` 短名都是 greeter 却是两个 variant。 */
/** 把一个绝对路径折叠到稳定的 skill 锚点:目录型 skill 与其 `SKILL.md` 归一到同一个
 *  `dir/SKILL.md`,单文件 .md 用其绝对路径本身。供 variant 身份判重折叠等价写法。 */
function canonicalSkillAnchor(absPath: string): string {
  return existsSync(absPath) && statSync(absPath).isDirectory() ? join(absPath, 'SKILL.md') : absPath;
}

export function variantIdentity(expr: string): string {
  const { name, cwd } = parseVariantCwd(expr);
  let id: string;
  if (name.startsWith('git:')) {
    id = name;
  } else if (name === 'baseline') {
    id = 'baseline';
  } else if (name.includes('/') || /\.md$/i.test(name)) {
    id = canonicalSkillAnchor(resolve(name));
  } else {
    id = name; // 裸短名(相对 skill-dir 解析),不同短名即不同 variant
  }
  return cwd ? `${id}@${resolve(cwd)}` : id;
}

/** 从已解析的 skill 路径取短名:`SKILL.md` 取其父目录名,否则取去掉 `.md` 后缀的 basename。
 *  `variantExprToSkillName`(expr → 短名)与 `resolveArtifacts` 的 file-path 命名共用这一处,
 *  避免两份各写一遍后悄悄发散——report 键就来自 resolveArtifacts 这一支。 */
export function skillNameFromPath(filePath: string): string {
  const base = basename(filePath);
  return base === 'SKILL.md' ? basename(dirname(filePath)) : base.replace(/\.md$/i, '');
}

/** Extract short skill name from a variant expression (which may be a path). */
export function variantExprToSkillName(expr: string): string {
  const { name } = parseVariantCwd(expr);
  if (name.startsWith('git:')) return name;
  if (!name.includes('/')) return name || expr;
  return skillNameFromPath(resolve(name)) || name;
}

export function resolveArtifacts(
  skillDir: string,
  variants: string[],
  opts: ResolveArtifactsOptions = {},
): Artifact[] {
  const strictBaseline = opts.strictBaseline ?? true;
  const variantAllowedSkills = opts.variantAllowedSkills ?? {};
  const artifacts: Artifact[] = [];
  let gitRelDir: string | null = null;

  for (const rawVariant of variants) {
    const { name: variantName, cwd: variantCwd } = parseVariantCwd(rawVariant);

    if (variantName === 'baseline' && variantCwd) {
      throw new Error('baseline cannot be bound to a cwd. To express a project-level runtime context, use a custom label such as project-env@/path/to/project');
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
      if (!gitRelDir) gitRelDir = getGitRelativePath(skillDir);
      const content = gitShowFile(ref, join(gitRelDir, `${name}.md`))
        || gitShowFile(ref, join(gitRelDir, name, 'SKILL.md'));
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

  // Skill-isolation wiring.
  //   Priority: variantAllowedSkills (explicit eval.yaml) > strictBaseline default > none.
  //   strictBaseline=true 时,所有 kind:'baseline' artifact 默认 allowedSkills=[]。
  //   显式 [] 也是合法(用户主动想"完全发现")的反义靠 strictBaseline=false 表达整批关闭。
  for (const artifact of artifacts) {
    const explicit = variantAllowedSkills[artifact.name];
    if (explicit !== undefined) {
      artifact.allowedSkills = explicit;
      continue;
    }
    if (strictBaseline && artifact.kind === 'baseline') {
      artifact.allowedSkills = [];
    }
    // else leave undefined → SDK default (full discovery)
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
