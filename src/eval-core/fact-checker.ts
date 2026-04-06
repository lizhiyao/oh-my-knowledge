/**
 * Fact checker — extracts verifiable claims from agent output and validates them.
 * Currently supports file/directory path verification via fs.existsSync.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface FactClaim {
  type: 'file-path';
  value: string;
  verified: boolean;
  evidence?: string;
}

export interface FactCheckResult {
  claims: FactClaim[];
  verifiedCount: number;
  totalCount: number;
  verifiedRate: number;
}

// Patterns that look like file/directory paths in agent output
const PATH_PATTERNS = [
  // Explicit code paths: repos/xxx, src/xxx, lib/xxx, packages/xxx
  /(?:repos|src|lib|packages|dist|test|components)\/[a-zA-Z0-9_/.@-]+/g,
  // .claude / .aima paths
  /\.(?:claude|aima)\/[a-zA-Z0-9_/.@-]+/g,
  // Paths with file extensions mentioned in text
  /[a-zA-Z0-9_/-]+\.(?:ts|js|tsx|jsx|md|json|yaml|yml|sh)\b/g,
];

// Paths to ignore (too generic or always present)
const IGNORE_PATTERNS = [
  /^package\.json$/,
  /^tsconfig\.json$/,
  /^node_modules\//,
  /^dist\//,
  /^\.git\//,
  /^index\.\w+$/,
];

/**
 * Extract file path claims from agent output text.
 */
export function extractPathClaims(output: string): string[] {
  const paths = new Set<string>();

  for (const pattern of PATH_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    for (const match of output.matchAll(pattern)) {
      let path = match[0];
      // Clean trailing punctuation
      path = path.replace(/[.,;:!?）)]+$/, '');
      // Clean trailing backtick/quote
      path = path.replace(/[`'"]+$/, '');
      if (path.length > 3 && !IGNORE_PATTERNS.some((p) => p.test(path))) {
        paths.add(path);
      }
    }
  }

  return [...paths];
}

/**
 * Check facts in agent output by verifying file paths exist in cwd.
 */
export function checkFacts(output: string, cwd: string): FactCheckResult {
  const pathClaims = extractPathClaims(output);

  const claims: FactClaim[] = pathClaims.map((path) => {
    const fullPath = resolve(cwd, path);
    const exists = existsSync(fullPath);
    return {
      type: 'file-path',
      value: path,
      verified: exists,
      ...(!exists && { evidence: `${fullPath} not found` }),
    };
  });

  const verifiedCount = claims.filter((c) => c.verified).length;
  const totalCount = claims.length;
  const verifiedRate = totalCount > 0 ? Number((verifiedCount / totalCount).toFixed(2)) : 1;

  return { claims, verifiedCount, totalCount, verifiedRate };
}
