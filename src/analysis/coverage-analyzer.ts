/**
 * Knowledge coverage analyzer.
 * Computes coverage rates by comparing consumed knowledge against the full index.
 */

import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import type { ToolCallInfo } from '../executors/contracts/trace.js';
import type { AnalysisEntry } from './contracts.js';
import { toolCallQuery } from '../shared/tool-search.js';
import { isToolCallSuccess } from '../shared/tool-call-status.js';

export interface KnowledgeEntry {
  path: string;
  aliases?: string[];
  type: 'principle' | 'semantic' | 'design' | 'script' | 'code' | 'other';
  lineCount?: number;
}

export interface KnowledgeIndex {
  entries: KnowledgeEntry[];
  totalFiles: number;
  totalLines: number;
}

export interface KnowledgeConsumption {
  filesRead: string[];
  grepPatterns: Array<{ pattern: string; path?: string }>;
  bashGrepPatterns: Array<{ pattern: string; path?: string }>;
}

function classifyEntry(path: string): KnowledgeEntry['type'] {
  if (/principle/i.test(path)) return 'principle';
  if (/semantic[-_]?index/i.test(path)) return 'semantic';
  if (/design\.md/i.test(path)) return 'design';
  if (/\.sh$|scripts?\//i.test(path)) return 'script';
  if (/\.(ts|js|tsx|jsx)$/i.test(path)) return 'code';
  return 'other';
}

export function extractReferencedPaths(artifactContent: string): string[] {
  const paths = new Set<string>();
  const pathPatterns = [
    /\.(?:agents|claude|codex|gemini)\/[a-zA-Z0-9_/.-]+\.(?:md|sh)/g,
    /repos\/[a-zA-Z0-9_/-]+/g,
    /(?<![a-zA-Z0-9:/])((?:\.{1,2}\/)?(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.(?:md|sh))\b/g,
  ];

  for (const pattern of pathPatterns) {
    for (const match of artifactContent.matchAll(pattern)) {
      paths.add(match[1] ?? match[0]);
    }
  }

  for (const match of artifactContent.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (
      target
      && !/^[a-z][a-z0-9+.-]*:/i.test(target)
      && /\.(?:md|sh)$/i.test(target)
    ) {
      paths.add(target);
    }
  }

  for (const match of artifactContent.matchAll(/(?<![/\\])\b([a-zA-Z0-9_-]+\.md)\b/g)) {
    const name = match[1];
    if (/^(README|CHANGELOG|LICENSE|package)\.md$/i.test(name)) continue;
    paths.add(name);
  }

  return [...paths];
}

interface ScannedKnowledgeEntry extends KnowledgeEntry {
  realPath: string;
}

function scanKnowledgeDir(
  dir: string,
  prefix: string = '',
  visitedDirectories = new Set<string>(),
): ScannedKnowledgeEntry[] {
  if (!existsSync(dir)) return [];
  let realDir: string;
  try {
    realDir = realpathSync(dir);
    if (!statSync(realDir).isDirectory()) return [];
  } catch {
    return [];
  }
  if (visitedDirectories.has(realDir)) return [];
  visitedDirectories.add(realDir);
  const entries: ScannedKnowledgeEntry[] = [];

  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const fullPath = join(dir, name);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      entries.push(...scanKnowledgeDir(
        fullPath,
        relativePath,
        visitedDirectories,
      ));
    } else if (/\.(md|sh)$/.test(name)) {
      let lineCount: number | undefined;
      let realPath: string;
      try {
        realPath = realpathSync(fullPath);
        lineCount = readFileSync(fullPath, 'utf-8').split('\n').length;
      } catch {
        continue;
      }
      entries.push({
        path: relativePath,
        realPath,
        type: classifyEntry(relativePath),
        lineCount,
      });
    }
  }

  return entries;
}

export function buildKnowledgeIndex(cwd: string): KnowledgeIndex {
  const knowledgeDirs = [
    { dir: join(cwd, '.agents', 'skills'), prefix: '.agents/skills' },
    { dir: join(cwd, '.claude', 'knowledge'), prefix: '.claude/knowledge' },
    { dir: join(cwd, '.claude', 'skills'), prefix: '.claude/skills' },
    { dir: join(cwd, '.codex', 'skills'), prefix: '.codex/skills' },
    { dir: join(cwd, '.gemini', 'skills'), prefix: '.gemini/skills' },
  ];

  const entriesByRealPath = new Map<string, KnowledgeEntry>();
  for (const { dir, prefix } of knowledgeDirs) {
    for (const entry of scanKnowledgeDir(dir, prefix)) {
      const existing = entriesByRealPath.get(entry.realPath);
      if (existing) {
        existing.aliases = [...new Set([...(existing.aliases ?? []), entry.path])];
        continue;
      }
      const { realPath, ...knowledgeEntry } = entry;
      void realPath;
      entriesByRealPath.set(entry.realPath, knowledgeEntry);
    }
  }

  for (const instructionFile of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const instructionPath = join(cwd, instructionFile);
    if (!existsSync(instructionPath)) continue;
    let lineCount: number | undefined;
    try {
      lineCount = readFileSync(instructionPath, 'utf-8').split('\n').length;
    } catch { }
    entriesByRealPath.set(realpathSync(instructionPath), {
      path: instructionFile,
      type: 'principle',
      lineCount,
    });
  }

  const entries = [...entriesByRealPath.values()];
  const totalLines = entries.reduce((sum, entry) => sum + (entry.lineCount || 0), 0);
  return {
    entries,
    totalFiles: entries.length,
    totalLines,
  };
}

export function buildFullKnowledgeIndex(artifactContent: string | null, cwd: string | null): KnowledgeIndex {
  const entriesMap = new Map<string, KnowledgeEntry>();

  if (cwd) {
    const dirIndex = buildKnowledgeIndex(cwd);
    for (const entry of dirIndex.entries) {
      entriesMap.set(entry.path, entry);
    }
  }

  if (artifactContent) {
    const refPaths = extractReferencedPaths(artifactContent);
    for (const path of refPaths) {
      if (!entriesMap.has(path)) {
        const existing = [...entriesMap.values()].find((entry) =>
          [entry.path, ...(entry.aliases ?? [])].some((candidate) =>
            candidate.endsWith('/' + path) || candidate === path
          )
        );
        if (!existing) {
          let lineCount: number | undefined;
          if (cwd) {
            const fullPath = resolveInside(cwd, path);
            try {
              if (fullPath && existsSync(fullPath) && statSync(fullPath).isFile()) {
                lineCount = readFileSync(fullPath, 'utf-8').split('\n').length;
              }
            } catch { }
          }
          if (!cwd || resolveInside(cwd, path)) {
            entriesMap.set(path, { path, type: classifyEntry(path), lineCount });
          }
        }
      }
    }
  }

  const entries = [...entriesMap.values()];
  const totalLines = entries.reduce((sum, entry) => sum + (entry.lineCount || 0), 0);
  return {
    entries,
    totalFiles: entries.length,
    totalLines,
  };
}

function resolveInside(root: string, path: string): string | null {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, path);
  const relativePath = relative(absoluteRoot, candidate);
  return relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
    ? candidate
    : null;
}

export function extractKnowledgeConsumption(toolCalls: ToolCallInfo[]): KnowledgeConsumption {
  const filesRead: string[] = [];
  const grepPatterns: Array<{ pattern: string; path?: string }> = [];
  const bashGrepPatterns: Array<{ pattern: string; path?: string }> = [];

  for (const toolCall of toolCalls) {
    const input = toolCall.input && typeof toolCall.input === 'object'
      ? toolCall.input as Record<string, unknown>
      : {};
    const legacyInput = typeof toolCall.input === 'string' ? toolCall.input : undefined;

    switch (toolCall.tool) {
      case 'Read': {
        const filePath = typeof input.file_path === 'string' ? input.file_path : legacyInput;
        if (filePath && isToolCallSuccess(toolCall)) filesRead.push(filePath);
        break;
      }
      case 'Grep': {
        const pattern = input.pattern as string | undefined;
        const path = input.path as string | undefined;
        if (pattern) grepPatterns.push({ pattern, path });
        break;
      }
      case 'Bash': {
        const command = typeof input.command === 'string' ? input.command : legacyInput;
        if (!command) break;
        const readPath = toolCallQuery(toolCall).path;
        if (readPath && isToolCallSuccess(toolCall)) filesRead.push(readPath);
        const grepMatch = command.match(/(?:grep|rg)\s+(?:-[a-zA-Z]+\s+)*["']?([^"'\s|]+)["']?\s+([^\s|>]+)/);
        if (grepMatch) {
          bashGrepPatterns.push({ pattern: grepMatch[1], path: grepMatch[2] });
        }
        break;
      }
    }
  }

  return { filesRead: [...new Set(filesRead)], grepPatterns, bashGrepPatterns };
}

export function normalizeKnowledgePath(filePath: string, cwd?: string | null): string {
  if (cwd) {
    const relativePath = relative(resolve(cwd), resolve(cwd, filePath));
    if (
      relativePath === ''
      || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
    ) {
      return relativePath.replaceAll('\\', '/');
    }
  }
  const normalized = filePath.replaceAll('\\', '/');
  const patterns = [
    '.agents/skills/',
    '.claude/knowledge/',
    '.claude/skills/',
    '.codex/skills/',
    '.gemini/skills/',
  ];
  for (const pattern of patterns) {
    const index = normalized.indexOf(pattern);
    if (index !== -1) return normalized.slice(index);
  }
  return basename(normalized);
}

export interface CoverageEntry {
  path: string;
  type: KnowledgeEntry['type'];
  accessed: boolean;
  accessCount: number;
  lineCount?: number;
}

export interface CoverageReport {
  entries: CoverageEntry[];
  filesCovered: number;
  filesTotal: number;
  fileCoverageRate: number;
  uncoveredFiles: string[];
  grepPatternsUsed: number;
  overallRate: number;
}

/**
 * Compute knowledge coverage for a single variant across all samples.
 */
export function computeCoverage(
  results: AnalysisEntry[],
  variant: string,
  index: KnowledgeIndex,
  cwd?: string | null,
): CoverageReport {
  // Aggregate all tool calls for this variant across samples
  const allToolCalls: ToolCallInfo[] = [];
  for (const result of results) {
    const vr = result.variants?.[variant];
    if (vr?.toolCalls) allToolCalls.push(...vr.toolCalls);
  }

  const consumption = extractKnowledgeConsumption(allToolCalls);

  // Normalize consumed file paths
  const consumedNormalized = new Set(
    consumption.filesRead.map((f) => normalizeKnowledgePath(f, cwd)),
  );

  // Match index entries against consumed files
  const entries: CoverageEntry[] = index.entries.map((entry) => {
    const paths = [entry.path, ...(entry.aliases ?? [])];
    const accessed = paths.some((path) =>
      consumedNormalized.has(path)
      || [...consumedNormalized].some((consumed) => consumed.endsWith('/' + path))
    );

    const accessCount = accessed
      ? consumption.filesRead.filter((f) => {
        const norm = normalizeKnowledgePath(f, cwd);
        return paths.some((path) => norm === path || norm.endsWith('/' + path));
      }).length
      : 0;

    return {
      path: entry.path,
      type: entry.type,
      accessed,
      accessCount,
      lineCount: entry.lineCount,
    };
  });

  const filesCovered = entries.filter((e) => e.accessed).length;
  const filesTotal = entries.length;
  const fileCoverageRate = filesTotal > 0 ? Number((filesCovered / filesTotal).toFixed(2)) : 0;
  const uncoveredFiles = entries.filter((e) => !e.accessed).map((e) => e.path);
  const grepPatternsUsed = consumption.grepPatterns.length + consumption.bashGrepPatterns.length;

  // Overall rate: file coverage 60% + grep activity bonus 40%
  const grepBonus = grepPatternsUsed > 0 ? Math.min(1, grepPatternsUsed / Math.max(5, filesTotal)) : 0;
  const overallRate = Number((fileCoverageRate * 0.6 + grepBonus * 0.4).toFixed(2));

  return {
    entries,
    filesCovered,
    filesTotal,
    fileCoverageRate,
    uncoveredFiles,
    grepPatternsUsed,
    overallRate,
  };
}
