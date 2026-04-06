/**
 * Knowledge coverage analyzer.
 * Computes coverage rates by comparing consumed knowledge against the full index.
 */

import { basename, join, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { ToolCallInfo, ResultEntry, Report } from '../types.js';

export interface KnowledgeEntry {
  path: string;
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
    /(?:\.claude|\.aima)\/[a-zA-Z0-9_/.-]+\.md/g,
    /(?:\.claude|\.aima)\/[a-zA-Z0-9_/.-]+\.sh/g,
    /repos\/[a-zA-Z0-9_/-]+/g,
  ];

  for (const pattern of pathPatterns) {
    for (const match of artifactContent.matchAll(pattern)) {
      paths.add(match[0]);
    }
  }

  for (const match of artifactContent.matchAll(/\b([a-zA-Z0-9_-]+\.md)\b/g)) {
    const name = match[1];
    if (/^(README|CHANGELOG|LICENSE|package)\.md$/i.test(name)) continue;
    paths.add(name);
  }

  return [...paths];
}

function scanKnowledgeDir(dir: string, prefix: string = ''): KnowledgeEntry[] {
  if (!existsSync(dir)) return [];
  const entries: KnowledgeEntry[] = [];

  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const fullPath = join(dir, name);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      entries.push(...scanKnowledgeDir(fullPath, relativePath));
    } else if (/\.(md|sh)$/.test(name)) {
      let lineCount: number | undefined;
      try {
        lineCount = readFileSync(fullPath, 'utf-8').split('\n').length;
      } catch { }
      entries.push({
        path: relativePath,
        type: classifyEntry(relativePath),
        lineCount,
      });
    }
  }

  return entries;
}

export function buildKnowledgeIndex(cwd: string): KnowledgeIndex {
  const knowledgeDirs = [
    { dir: join(cwd, '.claude', 'knowledge'), prefix: '.claude/knowledge' },
    { dir: join(cwd, '.claude', 'skills'), prefix: '.claude/skills' },
    { dir: join(cwd, '.aima', 'skills'), prefix: '.aima/skills' },
  ];

  const entries: KnowledgeEntry[] = [];
  for (const { dir, prefix } of knowledgeDirs) {
    entries.push(...scanKnowledgeDir(dir, prefix));
  }

  const claudeMd = join(cwd, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    let lineCount: number | undefined;
    try {
      lineCount = readFileSync(claudeMd, 'utf-8').split('\n').length;
    } catch { }
    entries.push({ path: 'CLAUDE.md', type: 'principle', lineCount });
  }

  const totalLines = entries.reduce((sum, entry) => sum + (entry.lineCount || 0), 0);
  return {
    entries,
    totalFiles: entries.length,
    totalLines,
  };
}

export function buildFullKnowledgeIndex(artifactContent: string | null, cwd: string | null): KnowledgeIndex {
  const entriesMap = new Map<string, KnowledgeEntry>();

  if (artifactContent) {
    if (cwd) {
      const knowledgeDir = join(cwd, '.claude', 'knowledge');
      for (const entry of scanKnowledgeDir(knowledgeDir, '.claude/knowledge')) {
        entriesMap.set(entry.path, entry);
      }
      const claudeMd = join(cwd, 'CLAUDE.md');
      if (existsSync(claudeMd)) {
        let lineCount: number | undefined;
        try {
          lineCount = readFileSync(claudeMd, 'utf-8').split('\n').length;
        } catch { }
        entriesMap.set('CLAUDE.md', { path: 'CLAUDE.md', type: 'principle', lineCount });
      }
    }

    const refPaths = extractReferencedPaths(artifactContent);
    for (const path of refPaths) {
      if (!entriesMap.has(path)) {
        const existing = [...entriesMap.values()].find((entry) => entry.path.endsWith('/' + path) || entry.path === path);
        if (!existing) {
          let lineCount: number | undefined;
          if (cwd) {
            const fullPath = resolve(cwd, path);
            try {
              if (existsSync(fullPath) && statSync(fullPath).isFile()) {
                lineCount = readFileSync(fullPath, 'utf-8').split('\n').length;
              }
            } catch { }
          }
          entriesMap.set(path, { path, type: classifyEntry(path), lineCount });
        }
      }
    }
  } else if (cwd) {
    const dirIndex = buildKnowledgeIndex(cwd);
    for (const entry of dirIndex.entries) {
      entriesMap.set(entry.path, entry);
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

export function extractKnowledgeConsumption(toolCalls: ToolCallInfo[]): KnowledgeConsumption {
  const filesRead: string[] = [];
  const grepPatterns: Array<{ pattern: string; path?: string }> = [];
  const bashGrepPatterns: Array<{ pattern: string; path?: string }> = [];

  for (const toolCall of toolCalls) {
    const input = toolCall.input as Record<string, unknown> | null;
    if (!input) continue;

    switch (toolCall.tool) {
      case 'Read': {
        const filePath = input.file_path as string | undefined;
        if (filePath) filesRead.push(filePath);
        break;
      }
      case 'Grep': {
        const pattern = input.pattern as string | undefined;
        const path = input.path as string | undefined;
        if (pattern) grepPatterns.push({ pattern, path });
        break;
      }
      case 'Bash': {
        const command = input.command as string | undefined;
        if (!command) break;
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
  if (cwd && filePath.startsWith(cwd)) {
    const relative = filePath.slice(cwd.endsWith('/') ? cwd.length : cwd.length + 1);
    return relative;
  }
  const patterns = ['.claude/knowledge/', '.claude/skills/', '.aima/skills/'];
  for (const pattern of patterns) {
    const index = filePath.indexOf(pattern);
    if (index !== -1) return filePath.slice(index);
  }
  return basename(filePath);
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
  results: ResultEntry[],
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
    // Check if this entry was accessed — match by exact path or by filename
    const accessed = consumedNormalized.has(entry.path) ||
      [...consumedNormalized].some((consumed) =>
        consumed.endsWith('/' + entry.path) || consumed.endsWith(entry.path),
      );

    const accessCount = accessed
      ? consumption.filesRead.filter((f) => {
        const norm = normalizeKnowledgePath(f, cwd);
        return norm === entry.path || norm.endsWith('/' + entry.path) || norm.endsWith(entry.path);
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

/**
 * Compute coverage reports for all variants in a report.
 * Returns a map of variant → CoverageReport.
 */
export function computeReportCoverage(
  report: Report,
  artifactContents: Record<string, string | null>,
  cwds: Record<string, string | null>,
): Record<string, CoverageReport> {
  const coverageMap: Record<string, CoverageReport> = {};

  for (const variant of report.meta.variants) {
    const content = artifactContents[variant] || null;
    const cwd = cwds[variant] || null;

    // Build knowledge index for this variant
    const index = buildFullKnowledgeIndex(content, cwd);
    if (index.totalFiles === 0) continue;

    coverageMap[variant] = computeCoverage(report.results, variant, index, cwd);
  }

  return coverageMap;
}
