import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export type LegacyEvaluationLayoutKind =
  | 'legacy-reports-directory'
  | 'flat-files-in-eval-directory';

export interface LegacyEvaluationLayoutFinding {
  readonly layoutKind: LegacyEvaluationLayoutKind;
  readonly directory: string;
  readonly fileCount: number;
}

export interface LegacyEvaluationLayoutScan {
  /** Current Core roots. Top-level JSON files are unsupported flat artifacts. */
  readonly evalDirectories: readonly string[];
  /** Pre-Core `reports/` roots. Every top-level JSON file is a legacy artifact candidate. */
  readonly legacyReportsDirectories: readonly string[];
}

async function countTopLevelJsonFiles(directory: string): Promise<number> {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => (
      (entry.isFile() || entry.isSymbolicLink())
      && entry.name.endsWith('.json')
      && !entry.name.includes('.json.tmp.')
    )).length;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    // This is a non-authoritative migration hint. The Core store remains responsible
    // for errors in active roots; an unreadable obsolete sibling must not stop Studio.
    return 0;
  }
}

/**
 * Detect obsolete evaluation layouts without parsing, migrating, deleting, or accepting
 * any legacy report as Core evidence. Current Core roots contain only addressed
 * run/batch/content directories, so a top-level JSON file is necessarily unsupported.
 */
export async function detectLegacyEvaluationLayouts(
  scan: Readonly<LegacyEvaluationLayoutScan>,
): Promise<readonly LegacyEvaluationLayoutFinding[]> {
  const candidates = [
    ...scan.evalDirectories.map((directory) => ({
      layoutKind: 'flat-files-in-eval-directory' as const,
      directory: resolve(directory),
    })),
    ...scan.legacyReportsDirectories.map((directory) => ({
      layoutKind: 'legacy-reports-directory' as const,
      directory: resolve(directory),
    })),
  ];
  const unique = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    unique.set(`${candidate.layoutKind}\0${candidate.directory}`, candidate);
  }
  const findings = await Promise.all([...unique.values()].map(async (candidate) => ({
    ...candidate,
    fileCount: await countTopLevelJsonFiles(candidate.directory),
  })));
  return Object.freeze(findings
    .filter((finding) => finding.fileCount > 0)
    .sort((left, right) => (
      left.directory.localeCompare(right.directory)
      || left.layoutKind.localeCompare(right.layoutKind)
    ))
    .map((finding) => Object.freeze(finding)));
}
