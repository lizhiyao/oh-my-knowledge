/**
 * Knowledge consumption tracker.
 * Extracts which knowledge files were read and which patterns were searched
 * from agent tool calls during evaluation.
 */

import { basename } from 'node:path';
import type { ToolCallInfo } from './types.js';

export interface KnowledgeConsumption {
  filesRead: string[];
  grepPatterns: Array<{ pattern: string; path?: string }>;
  bashGrepPatterns: Array<{ pattern: string; path?: string }>;
}

/**
 * Extract knowledge consumption data from tool calls.
 * Parses Read/Grep/Bash tool inputs to determine what files and patterns were accessed.
 */
export function extractKnowledgeConsumption(toolCalls: ToolCallInfo[]): KnowledgeConsumption {
  const filesRead: string[] = [];
  const grepPatterns: Array<{ pattern: string; path?: string }> = [];
  const bashGrepPatterns: Array<{ pattern: string; path?: string }> = [];

  for (const tc of toolCalls) {
    const input = tc.input as Record<string, unknown> | null;
    if (!input) continue;

    switch (tc.tool) {
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
        // Extract grep/rg patterns from bash commands
        const cmd = input.command as string | undefined;
        if (!cmd) break;
        const grepMatch = cmd.match(/(?:grep|rg)\s+(?:-[a-zA-Z]+\s+)*["']?([^"'\s|]+)["']?\s+([^\s|>]+)/);
        if (grepMatch) {
          bashGrepPatterns.push({ pattern: grepMatch[1], path: grepMatch[2] });
        }
        break;
      }
    }
  }

  return { filesRead: [...new Set(filesRead)], grepPatterns, bashGrepPatterns };
}

/**
 * Normalize a file path to just the knowledge-relative portion.
 * e.g. "/Users/x/Projects/workspace/.claude/knowledge/domain-principles.md"
 *   → ".claude/knowledge/domain-principles.md"
 */
export function normalizeKnowledgePath(filePath: string, cwd?: string | null): string {
  if (cwd && filePath.startsWith(cwd)) {
    const relative = filePath.slice(cwd.endsWith('/') ? cwd.length : cwd.length + 1);
    return relative;
  }
  // Try common knowledge path patterns
  const patterns = ['.claude/knowledge/', '.claude/skills/', '.aima/skills/'];
  for (const p of patterns) {
    const idx = filePath.indexOf(p);
    if (idx !== -1) return filePath.slice(idx);
  }
  return basename(filePath);
}
