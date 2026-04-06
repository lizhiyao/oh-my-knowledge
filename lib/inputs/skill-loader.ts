import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Artifact } from '../types.js';

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
    process.stderr.write(`⚠️  跳过 ${name}：未找到配对的 eval-samples\n`);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

export function loadSkills(skillDir: string, variants: string[]): Record<string, string | null> {
  return Object.fromEntries(resolveArtifacts(skillDir, variants).map((artifact) => [artifact.name, artifact.content]));
}

/**
 * Parse variant string, extracting optional cwd suffix.
 * Format: "name@/path/to/cwd" or just "name"
 */
function parseVariantCwd(variant: string): { name: string; cwd?: string } {
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
      throw new Error('baseline 不能绑定 cwd。若要表达项目级 runtime context，请使用自定义标签，例如 project-env@/path/to/project');
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
        throw new Error(`skill 在 git ${ref} 中未找到: ${name}.md 或 ${name}/SKILL.md`);
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
        throw new Error(`skill 文件未找到: ${filePath}`);
      }
      artifacts.push({
        name: variantName,
        kind: 'skill',
        source: 'file-path',
        content: readFileSync(filePath, 'utf-8').trim(),
        locator: filePath,
        cwd: variantCwd,
      });
      continue;
    }

    const mdPath = join(skillDir, `${variantName}.md`);
    const dirSkillPath = join(skillDir, variantName, 'SKILL.md');
    if (existsSync(mdPath)) {
      artifacts.push({
        name: variantName,
        kind: 'skill',
        source: 'variant-name',
        content: readFileSync(mdPath, 'utf-8').trim(),
        locator: mdPath,
        cwd: variantCwd,
      });
    } else if (existsSync(dirSkillPath)) {
      artifacts.push({
        name: variantName,
        kind: 'skill',
        source: 'variant-name',
        content: readFileSync(dirSkillPath, 'utf-8').trim(),
        locator: dirSkillPath,
        cwd: variantCwd,
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
      throw new Error(`skill 未找到: ${mdPath} 或 ${dirSkillPath}`);
    }
  }

  return artifacts;
}
