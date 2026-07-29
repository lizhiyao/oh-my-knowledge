/**
 * Fact checker — extracts verifiable claims from agent output and validates them.
 * Currently supports file/directory path verification via fs.existsSync.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

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

export interface FactCheckEvidence {
  /** Shared sample fixture root. Arm-specific execution directories must not be used. */
  cwd?: string;
  /** Facts supplied to both arms in the sample context. */
  context?: string;
  /** Declarative fixture paths from sample.environment.files_available. */
  declaredFiles?: string[];
}

// Patterns that look like file/directory paths in agent output
const PATH_PATTERNS = [
  // Explicit code paths: repos/xxx, src/xxx, lib/xxx, packages/xxx
  /(?:repos|src|lib|packages|dist|test|components)\/[a-zA-Z0-9_/.@-]+/g,
  // Agent configuration and skill paths across supported trace sources.
  /\.(?:agents|claude|codex|gemini)\/[a-zA-Z0-9_/.@-]+/g,
  // Paths with file extensions mentioned in text
  /(?<![a-zA-Z0-9_./-])[a-zA-Z0-9_/-]+\.(?:ts|js|tsx|jsx|md|json|yaml|yml|sh)\b(?!\s*\()/g,
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

// Product/runtime names that happen to end in a supported source extension.
const NON_PATH_REFERENCES = new Set([
  'node.js',
]);

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
      if (
        path.length > 3
        && !NON_PATH_REFERENCES.has(path.toLowerCase())
        && !IGNORE_PATTERNS.some((p) => p.test(path))
      ) {
        paths.add(path);
      }
    }
  }

  return [...paths];
}

function normalizeEvidencePath(path: string): string {
  return path
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\\/g, '/')
    .replace(/^(?:\$SKILL_DIR|~)\//, '')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function isRootedEvidencePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:\//.test(path);
}

function refersToSamePath(left: string, right: string): boolean {
  const a = normalizeEvidencePath(left);
  const b = normalizeEvidencePath(right);
  return a === b
    || (isRootedEvidencePath(a) && !isRootedEvidencePath(b) && a.endsWith(`/${b}`))
    || (isRootedEvidencePath(b) && !isRootedEvidencePath(a) && b.endsWith(`/${a}`));
}

/**
 * Check file-path facts against sample-level evidence shared by every arm.
 *
 * A string keeps the legacy direct-filesystem API for callers outside the
 * evaluation pipeline. The pipeline passes structured evidence and deliberately
 * excludes each artifact's execution cwd, because that directory is not a
 * comparable source of truth across control and treatment arms.
 */
export function checkFacts(
  output: string,
  evidence: string | FactCheckEvidence,
): FactCheckResult {
  const pathClaims = extractPathClaims(output);
  const sources: FactCheckEvidence = typeof evidence === 'string'
    ? { cwd: evidence }
    : evidence;
  const root = sources.cwd ? resolve(sources.cwd) : null;
  const contextClaims = sources.context
    ? extractPathClaims(sources.context)
    : [];
  const declaredFiles = sources.declaredFiles ?? [];

  const claims = pathClaims.flatMap<FactClaim>((path) => {
    if (declaredFiles.some((declared) => refersToSamePath(path, declared))) {
      return [{
        type: 'file-path',
        value: path,
        verified: true,
        evidence: 'source=context(sample.environment.files_available)',
      }];
    }

    if (root) {
      const fullPath = resolve(root, path);
      const relativePath = relative(root, fullPath);
      const insideCwd = relativePath === ''
        || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
      const exists = insideCwd && existsSync(fullPath);
      return [{
        type: 'file-path',
        value: path,
        verified: exists,
        evidence: insideCwd
          ? `source=runtime-filesystem; ${fullPath} ${exists ? 'exists' : 'not found'}`
          : `source=runtime-filesystem; ${path} is outside the evaluation cwd`,
      }];
    }

    if (contextClaims.some((contextPath) => refersToSamePath(path, contextPath))) {
      return [{
        type: 'file-path',
        value: path,
        verified: true,
        evidence: 'source=context(sample.context)',
      }];
    }

    // Without a shared fixture, absence from context is unknown rather than false.
    return [];
  });

  const verifiedCount = claims.filter((c) => c.verified).length;
  const totalCount = claims.length;
  const verifiedRate = totalCount > 0 ? Number((verifiedCount / totalCount).toFixed(2)) : 1;

  return { claims, verifiedCount, totalCount, verifiedRate };
}
