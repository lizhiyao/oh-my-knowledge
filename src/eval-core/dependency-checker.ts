/**
 * Preflight dependency checker for evaluations.
 *
 * Automatically extracts external dependencies (CLI tools, file references,
 * environment variables) from skill content and sample assertions, then
 * verifies they are available before evaluation starts.
 */

import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import type { Artifact, Sample } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DependencyRequirements {
  tools?: string[];
  files?: string[];
  env?: string[];
  preflight?: string[];
}

export interface DependencyIssue {
  category: 'tool' | 'file' | 'env';
  name: string;
  hint: string;
}

export interface DependencyCheckResult {
  ok: boolean;
  missing: DependencyIssue[];
}

// ---------------------------------------------------------------------------
// Extraction — scan text for dependencies
// ---------------------------------------------------------------------------

// Match CLI tool names: xxx-cli, xxx_cli (word boundary)
const CLI_TOOL_REGEX = /\b([a-z][a-z0-9]*(?:[-_][a-z][a-z0-9]*)*-cli)\b/gi;

// Match $(xxx ...) subcommand patterns — extract the command name
const SUBCOMMAND_REGEX = /\$\(([a-z][a-z0-9]*(?:[-_][a-z][a-z0-9]*)*)\s/gi;

// Match relative file paths ending with common extensions
const FILE_PATH_REGEX = /(?:^|[\s"'`(])([a-zA-Z0-9_.][a-zA-Z0-9_./\-]*\.(?:md|json|ya?ml|txt|sh|ts|js))\b/gm;

// Match environment variable references: $XXX_YYY or ${XXX_YYY}
const ENV_VAR_REGEX = /\$\{?([A-Z][A-Z0-9_]{2,})\}?/g;

// Common system env vars to ignore
const SYSTEM_ENV_VARS = new Set([
  'HOME', 'PATH', 'USER', 'SHELL', 'LANG', 'TERM', 'PWD', 'OLDPWD',
  'TMPDIR', 'EDITOR', 'VISUAL', 'HOSTNAME', 'LOGNAME', 'DISPLAY',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'NODE_ENV', 'NODE_PATH', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX',
]);

function extractFromText(text: string): { tools: Set<string>; files: Set<string>; env: Set<string> } {
  const tools = new Set<string>();
  const files = new Set<string>();
  const env = new Set<string>();

  // CLI tools
  for (const match of text.matchAll(CLI_TOOL_REGEX)) {
    tools.add(match[1].toLowerCase());
  }

  // Subcommand patterns like $(my-cli ...)
  for (const match of text.matchAll(SUBCOMMAND_REGEX)) {
    const cmd = match[1].toLowerCase();
    // Only add if it looks like an external tool (contains hyphen or underscore)
    if (cmd.includes('-') || cmd.includes('_')) {
      tools.add(cmd);
    }
  }

  // File paths
  for (const match of text.matchAll(FILE_PATH_REGEX)) {
    const path = match[1];
    // Skip paths that look like URLs, package names, or version strings
    if (path.startsWith('http') || path.startsWith('node_modules') || /^\d/.test(path)) continue;
    // Skip very short paths that are likely not real files
    if (path.length < 5) continue;
    // Skip extension-mention patterns(`.d.ts` / `.tsx` 这种以点开头的"扩展名讨论"
    // 不是真路径,SKILL.md 里"查看 .d.ts 文件"会被误识别)
    if (path.startsWith('.')) continue;
    // Skip bare filenames without a directory segment(`index.ts` / `package.json`
    // 这种通用文件名几乎都是示例性提及,真依赖会带路径段。要声明 bare 文件
    // 走显式 requires)
    if (!path.includes('/')) continue;
    files.add(path);
  }

  // Environment variables
  for (const match of text.matchAll(ENV_VAR_REGEX)) {
    const name = match[1];
    if (!SYSTEM_ENV_VARS.has(name)) {
      env.add(name);
    }
  }

  return { tools, files, env };
}

/**
 * Extract dependencies from skill contents and sample assertions.
 */
export function extractDependencies(
  skillContents: string[],
  samples: Sample[],
): DependencyRequirements {
  const tools = new Set<string>();
  const files = new Set<string>();
  const env = new Set<string>();

  // Scan skill contents
  for (const content of skillContents) {
    if (!content) continue;
    const extracted = extractFromText(content);
    for (const t of extracted.tools) tools.add(t);
    for (const f of extracted.files) files.add(f);
    for (const e of extracted.env) env.add(e);
  }

  // Scan sample assertion values
  for (const sample of samples) {
    for (const assertion of sample.assertions || []) {
      const value = assertion.value;
      if (typeof value === 'string' && value.length > 0) {
        const extracted = extractFromText(value);
        for (const t of extracted.tools) tools.add(t);
        // Skip file extraction from assertions — too noisy (partial paths in contains checks)
        for (const e of extracted.env) env.add(e);
      }
    }
  }

  return {
    tools: tools.size > 0 ? [...tools] : undefined,
    files: files.size > 0 ? [...files] : undefined,
    env: env.size > 0 ? [...env] : undefined,
  };
}

/**
 * Extract file dependencies per artifact, keyed by the base dir each file
 * should be resolved against:
 *   - artifact.skillRoot (directory-skill: SKILL.md 自带 assets,相对路径锚到 skill 根)
 *   - artifact.cwd       (用户显式 @cwd)
 *   - defaultCwd         (其他)
 *
 * 必须用 per-artifact 分桶,否则两个 skill 各自的 assets/foo.md 在单一 cwd 下
 * 互相错位,导致大量 false-positive missing。
 */
export function extractFilesByBase(
  artifacts: Artifact[],
  defaultCwd: string,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const artifact of artifacts) {
    if (!artifact.content) continue;
    const baseDir = artifact.skillRoot || artifact.cwd || defaultCwd;
    const extracted = extractFromText(artifact.content);
    if (extracted.files.size === 0) continue;
    let bucket = map.get(baseDir);
    if (!bucket) {
      bucket = new Set<string>();
      map.set(baseDir, bucket);
    }
    for (const f of extracted.files) bucket.add(f);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Validation — check if dependencies are available
// ---------------------------------------------------------------------------

function isToolAvailable(tool: string, env?: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'pipe', timeout: 5000, env });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build an env with skill directories' node_modules/.bin prepended to PATH.
 */
function buildPreflightEnv(artifacts?: Artifact[]): NodeJS.ProcessEnv {
  if (!artifacts) return process.env;
  const extraPaths: string[] = [];
  for (const a of artifacts) {
    if (!a.locator) continue;
    const dir = dirname(a.locator);
    const nodeBin = join(dir, 'node_modules', '.bin');
    if (existsSync(nodeBin)) extraPaths.push(nodeBin);
  }
  if (extraPaths.length === 0) return process.env;
  const env = { ...process.env };
  env.PATH = [...extraPaths, env.PATH].filter(Boolean).join(delimiter);
  return env;
}

/**
 * Check if all declared dependencies are available.
 */
export async function checkDependencies(
  deps: DependencyRequirements,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<DependencyCheckResult> {
  const missing: DependencyIssue[] = [];

  // Check CLI tools
  for (const tool of deps.tools || []) {
    if (!isToolAvailable(tool, env)) {
      missing.push({
        category: 'tool',
        name: tool,
        hint: `未找到，请确认已安装并在 PATH 中`,
      });
    }
  }

  // Check files
  for (const file of deps.files || []) {
    const absPath = resolve(cwd, file);
    if (!existsSync(absPath)) {
      missing.push({
        category: 'file',
        name: file,
        hint: `文件不存在 (cwd: ${cwd})`,
      });
    }
  }

  // Check environment variables
  for (const envVar of deps.env || []) {
    if (!process.env[envVar]) {
      missing.push({
        category: 'env',
        name: envVar,
        hint: '未设置',
      });
    }
  }

  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Merge utility
// ---------------------------------------------------------------------------

function mergeRequirements(a: DependencyRequirements, b?: DependencyRequirements): DependencyRequirements {
  if (!b) return a;
  const tools = new Set([...(a.tools || []), ...(b.tools || [])]);
  const files = new Set([...(a.files || []), ...(b.files || [])]);
  const env = new Set([...(a.env || []), ...(b.env || [])]);
  const preflight = new Set([...(a.preflight || []), ...(b.preflight || [])]);
  return {
    tools: tools.size > 0 ? [...tools] : undefined,
    files: files.size > 0 ? [...files] : undefined,
    env: env.size > 0 ? [...env] : undefined,
    preflight: preflight.size > 0 ? [...preflight] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Preflight commands — execute shell commands to verify tool availability
// ---------------------------------------------------------------------------

const PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * Extract preflight commands from artifact metadata (parsed from SKILL.md frontmatter).
 */
function extractPreflightFromArtifacts(artifacts: Artifact[]): string[] {
  const commands: string[] = [];
  for (const artifact of artifacts) {
    const pf = artifact.metadata?.preflight;
    if (Array.isArray(pf)) {
      for (const cmd of pf) {
        if (typeof cmd === 'string' && cmd.trim()) commands.push(cmd.trim());
      }
    }
  }
  return commands;
}

/**
 * Run preflight commands and collect failures.
 */
function runPreflightCommands(commands: string[], cwd: string, env?: NodeJS.ProcessEnv): DependencyIssue[] {
  const issues: DependencyIssue[] = [];
  for (const cmd of commands) {
    try {
      execSync(cmd, {
        cwd,
        env: env || process.env,
        stdio: 'pipe',
        timeout: PREFLIGHT_TIMEOUT_MS,
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : 'unknown error';
      issues.push({
        category: 'tool',
        name: cmd,
        hint: `preflight 命令执行失败: ${detail}`,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Check files per base dir. Each (baseDir, [files]) bucket is resolved
 * independently so directory-skill 自带 assets 的相对路径能锚到 skill 根。
 */
function checkFilesByBase(filesByBase: Map<string, Set<string>>): DependencyIssue[] {
  const missing: DependencyIssue[] = [];
  for (const [baseDir, files] of filesByBase) {
    for (const file of files) {
      const absPath = resolve(baseDir, file);
      if (!existsSync(absPath)) {
        missing.push({
          category: 'file',
          name: file,
          hint: `文件不存在 (cwd: ${baseDir})`,
        });
      }
    }
  }
  return missing;
}

/**
 * Run preflight dependency check: auto-extract + merge explicit requires + validate + run preflight commands.
 *
 * 文件路径走 per-artifact 分桶解析(每个 skill 用自己的 skillRoot / cwd 当 base),
 * 工具 / env 变量 / preflight 命令仍全局合并。explicit requires.files 视为用户全局
 * 声明,落到 defaultCwd。
 */
export async function preflightDependencies(
  skillContents: string[],
  samples: Sample[],
  cwd: string,
  explicitRequires?: DependencyRequirements,
  artifacts?: Artifact[],
): Promise<DependencyCheckResult> {
  const env = buildPreflightEnv(artifacts);
  const autoDetected = extractDependencies(skillContents, samples);

  // 工具 / env / 显式 files / preflight 仍合并(语义不依赖 per-skill 路径锚)
  const globalDeps: DependencyRequirements = {
    tools: autoDetected.tools,
    env: autoDetected.env,
  };
  const mergedGlobal = mergeRequirements(globalDeps, explicitRequires);
  // explicit requires.files 视为用户全局声明,继续锚到 defaultCwd
  const result = await checkDependencies(mergedGlobal, cwd, env);

  // 自动检出的文件依赖按 artifact 分桶,每个 skill 用自己的 base 验证
  if (artifacts && artifacts.length > 0) {
    const filesByBase = extractFilesByBase(artifacts, cwd);
    const fileIssues = checkFilesByBase(filesByBase);
    result.missing.push(...fileIssues);
    result.ok = result.ok && fileIssues.length === 0;
  }

  // 合并 preflight 命令:来自 requires + 来自 artifact metadata
  const artifactPreflight = artifacts ? extractPreflightFromArtifacts(artifacts) : [];
  const allPreflight = [...new Set([...(mergedGlobal.preflight || []), ...artifactPreflight])];

  if (allPreflight.length > 0) {
    const preflightIssues = runPreflightCommands(allPreflight, cwd, env);
    result.missing.push(...preflightIssues);
    result.ok = result.ok && preflightIssues.length === 0;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatDependencyErrors(missing: DependencyIssue[]): string {
  const lines: string[] = ['前置依赖检查失败:\n'];

  const byCategory = { tool: [] as DependencyIssue[], file: [] as DependencyIssue[], env: [] as DependencyIssue[] };
  for (const issue of missing) {
    byCategory[issue.category].push(issue);
  }

  const labels: Record<string, string> = { tool: '工具缺失', file: '文件缺失', env: '环境变量缺失' };
  for (const [cat, issues] of Object.entries(byCategory)) {
    if (issues.length === 0) continue;
    lines.push(`  ${labels[cat]}:`);
    for (const issue of issues) {
      lines.push(`    ✗ ${issue.name} — ${issue.hint}`);
    }
    lines.push('');
  }

  lines.push('提示: 使用 --skip-preflight 跳过此检查');
  return lines.join('\n');
}
