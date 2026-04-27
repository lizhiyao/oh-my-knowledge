import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
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
  if (!preflight || preflight.length === 0) return undefined;
  return { preflight };
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

export function discoverEachSkills(skillDir: string): Array<{ name: string; skillPath: string; samplesPath: string }> {
  if (!existsSync(skillDir)) return [];

  const entries = readdirSync(skillDir);
  const skills: Array<{ name: string; skillPath: string; samplesPath: string }> = [];
  const warned: string[] = [];

  for (const entry of entries) {
    const entryPath = join(skillDir, entry);
    const mdMatch = entry.endsWith('.md') && !entry.endsWith('.eval-samples.json');

    if (mdMatch) {
      const name = entry.slice(0, -3);
      const samplesPath = join(skillDir, `${name}.eval-samples.json`);
      if (existsSync(samplesPath)) {
        skills.push({ name, skillPath: join(skillDir, entry), samplesPath });
      } else {
        warned.push(name);
      }
      continue;
    }

    if (statSync(entryPath).isDirectory()) {
      const skillMd = join(entryPath, 'SKILL.md');
      const samplesPath = join(entryPath, 'eval-samples.json');
      if (existsSync(skillMd) && existsSync(samplesPath)) {
        skills.push({ name: entry, skillPath: skillMd, samplesPath });
      } else if (existsSync(skillMd)) {
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

/**
 * Parse variant expression, extracting optional cwd suffix.
 * Format: "name@/path/to/cwd" or just "name"
 */
export function parseVariantCwd(variant: string): { name: string; cwd?: string } {
  const atIdx = variant.indexOf('@');
  if (atIdx === -1) return { name: variant };
  return { name: variant.slice(0, atIdx), cwd: variant.slice(atIdx + 1) };
}

export function resolveArtifacts(skillDir: string, variants: string[]): Artifact[] {
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
      const filePath = resolve(variantName);
      if (!existsSync(filePath)) {
        throw new Error(`skill file not found: ${filePath}`);
      }
      const content = readFileSync(filePath, 'utf-8').trim();
      artifacts.push({
        name: variantName,
        kind: 'skill',
        source: 'file-path',
        content,
        locator: filePath,
        cwd: variantCwd,
        metadata: buildMetadata(content),
      });
      continue;
    }

    const mdPath = join(skillDir, `${variantName}.md`);
    const dirSkillPath = join(skillDir, variantName, 'SKILL.md');
    if (existsSync(mdPath)) {
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
      const content = readFileSync(dirSkillPath, 'utf-8').trim();
      artifacts.push({
        name: variantName,
        kind: 'skill',
        source: 'variant-name',
        content,
        locator: dirSkillPath,
        cwd: variantCwd,
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

  return artifacts;
}
