/**
 * Knowledge index parser.
 * Extracts the knowledge boundary of a skill/artifact by parsing its content
 * for referenced files and scanning knowledge directories.
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

/**
 * Classify a knowledge file by its path.
 */
function classifyEntry(path: string): KnowledgeEntry['type'] {
  if (/principle/i.test(path)) return 'principle';
  if (/semantic[-_]?index/i.test(path)) return 'semantic';
  if (/design\.md/i.test(path)) return 'design';
  if (/\.sh$|scripts?\//i.test(path)) return 'script';
  if (/\.(ts|js|tsx|jsx)$/i.test(path)) return 'code';
  return 'other';
}

/**
 * Extract file paths referenced in artifact/skill content.
 * Looks for .md files, .claude/ paths, .aima/ paths, etc.
 */
export function extractReferencedPaths(artifactContent: string): string[] {
  const paths = new Set<string>();

  // Match explicit file paths like .claude/knowledge/domain-principles.md
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

  // Match standalone .md references like "semantic-index.md", "design.md"
  for (const match of artifactContent.matchAll(/\b([a-zA-Z0-9_-]+\.md)\b/g)) {
    const name = match[1];
    // Skip common non-knowledge files
    if (/^(README|CHANGELOG|LICENSE|package)\.md$/i.test(name)) continue;
    paths.add(name);
  }

  return [...paths];
}

/**
 * Scan a directory for knowledge files (.md, .sh).
 */
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
      } catch { /* skip */ }
      entries.push({
        path: relativePath,
        type: classifyEntry(relativePath),
        lineCount,
      });
    }
  }

  return entries;
}

/**
 * Build a knowledge index for a given cwd (project directory).
 * Scans .claude/knowledge/, .claude/skills/, .aima/skills/ if they exist.
 */
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

  // Also check for CLAUDE.md at project root
  const claudeMd = join(cwd, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    let lineCount: number | undefined;
    try { lineCount = readFileSync(claudeMd, 'utf-8').split('\n').length; } catch { /* skip */ }
    entries.push({ path: 'CLAUDE.md', type: 'principle', lineCount });
  }

  const totalLines = entries.reduce((s, e) => s + (e.lineCount || 0), 0);

  return {
    entries,
    totalFiles: entries.length,
    totalLines,
  };
}

/**
 * Build a knowledge index from both artifact references and directory scanning.
 */
export function buildFullKnowledgeIndex(artifactContent: string | null, cwd: string | null): KnowledgeIndex {
  const entriesMap = new Map<string, KnowledgeEntry>();

  // 1. Scan directories if cwd is provided
  if (cwd) {
    const dirIndex = buildKnowledgeIndex(cwd);
    for (const entry of dirIndex.entries) {
      entriesMap.set(entry.path, entry);
    }
  }

  // 2. Add paths referenced in artifact content (may include files outside scanned dirs)
  if (artifactContent) {
    const refPaths = extractReferencedPaths(artifactContent);
    for (const path of refPaths) {
      if (!entriesMap.has(path)) {
        // Check if any existing entry matches by filename
        const existing = [...entriesMap.values()].find((e) => e.path.endsWith('/' + path) || e.path === path);
        if (!existing) {
          entriesMap.set(path, { path, type: classifyEntry(path) });
        }
      }
    }
  }

  const entries = [...entriesMap.values()];
  const totalLines = entries.reduce((s, e) => s + (e.lineCount || 0), 0);

  return {
    entries,
    totalFiles: entries.length,
    totalLines,
  };
}
