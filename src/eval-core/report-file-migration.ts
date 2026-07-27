import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { doctorReportFileStem, isReportFileName, reportFilePath, stripDomainPrefix } from './artifact-file-names.js';

export type LegacyReportDomain = 'report' | 'doctor' | 'observe-health' | 'observe-inbox';

function legacyJsonStem(fileName: string): string | null {
  if (!fileName.endsWith('.json')) return null;
  if (isReportFileName(fileName)) return null;
  if (fileName.includes('.json.tmp.')) return null;
  return fileName.slice(0, -'.json'.length);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeObserveHealthReport(value: Record<string, unknown>): boolean {
  return isObject(value.meta) && isObject(value.bySkill) && isObject(value.overall);
}

function targetStemForLegacyReport(domain: LegacyReportDomain, fileName: string, data: unknown): string | null {
  const fileStem = legacyJsonStem(fileName);
  if (!fileStem || !isObject(data)) return null;

  if (domain === 'report') {
    const kind = data.kind;
    return (kind === 'evaluation' || kind === 'batch-evaluation') && typeof data.id === 'string' && data.id
      ? data.id
      : null;
  }

  if (domain === 'doctor') {
    if (data.kind !== 'doctor' || typeof data.id !== 'string' || !Array.isArray(data.skills) || data.skills.length !== 1) return null;
    const skill = data.skills[0];
    return isObject(skill) && typeof skill.skillName === 'string' && skill.skillName
      ? doctorReportFileStem(skill.skillName, data.id)
      : null;
  }

  if (domain === 'observe-health') {
    if (data.kind !== 'observe-health' && !looksLikeObserveHealthReport(data)) return null;
    return stripDomainPrefix(fileStem.replace(/-observe-health$/, ''), 'observe-health');
  }

  if (data.kind !== 'observe-inbox') return null;
  return stripDomainPrefix(fileStem.replace(/-observe-inbox$/, ''), 'observe-inbox');
}

/**
 * One-shot migration for pre-`.report.json` run artifacts.
 *
 * This is deliberately scoped to measurement report directories. It does not make
 * bare `.json` a normal reader format again; it just renames known legacy report
 * files into the canonical name so old local data can be discovered, rotated, and
 * eventually garbage-collected by the new code paths.
 */
export function migrateLegacyReportFiles(dir: string, domain: LegacyReportDomain): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!legacyJsonStem(file)) continue;
    const sourcePath = join(dir, file);
    let targetStem: string | null = null;
    let sourceData: unknown;
    try {
      sourceData = JSON.parse(readFileSync(sourcePath, 'utf-8'));
      targetStem = targetStemForLegacyReport(domain, file, sourceData);
    } catch {
      continue;
    }
    if (!targetStem) continue;

    const targetPath = reportFilePath(dir, targetStem);
    try {
      if (existsSync(targetPath)) {
        const targetData: unknown = JSON.parse(readFileSync(targetPath, 'utf-8'));
        if (isDeepStrictEqual(sourceData, targetData)) unlinkSync(sourcePath);
      } else {
        renameSync(sourcePath, targetPath);
      }
    } catch {
      // Best-effort migration only. Readers will ignore the legacy file if it remains.
    }
  }
}
