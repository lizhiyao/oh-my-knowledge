import { isActiveDiagnosisLifecycle, type Diagnosis, type DiagnosisBundle, type DiagnosisSeverity, type StudioDiagnosisSummary } from './types.js';

export type { StudioDiagnosisSummary };

export function buildStudioDiagnosisSummary(bundle?: DiagnosisBundle): StudioDiagnosisSummary {
  const sourceCoverage = bundle?.sourceCoverage ?? { observe: false, doctor: false, eval: false };
  const diagnostics = Object.values(bundle?.bySkill ?? {}).flat();
  const bySeverity: Record<DiagnosisSeverity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  const bySkill: Record<string, number> = {};
  const byAudience: Record<string, number> = {};
  for (const diagnosis of diagnostics) {
    bySeverity[diagnosis.severity] += 1;
    bySkill[diagnosis.skillName] = (bySkill[diagnosis.skillName] ?? 0) + 1;
    byAudience[diagnosis.audience] = (byAudience[diagnosis.audience] ?? 0) + 1;
  }
  return {
    sourceCoverage,
    totalCount: countDiagnostics(bundle),
    partial: !sourceCoverage.doctor || !sourceCoverage.eval || !sourceCoverage.observe,
    bySeverity,
    bySkill,
    byAudience,
  };
}

export function countDiagnostics(bundle?: DiagnosisBundle): number {
  if (!bundle) return 0;
  return Object.values(bundle.bySkill).reduce((sum, values) => sum + values.length, 0);
}

export function mergeDiagnosisBundles(bundles: DiagnosisBundle[], generatedAt = new Date().toISOString()): DiagnosisBundle {
  const byStableKey = new Map<string, Diagnosis>();
  const sourceCoverage = { observe: false, doctor: false, eval: false };
  for (const bundle of bundles) {
    sourceCoverage.observe = sourceCoverage.observe || bundle.sourceCoverage.observe;
    sourceCoverage.doctor = sourceCoverage.doctor || bundle.sourceCoverage.doctor;
    sourceCoverage.eval = sourceCoverage.eval || bundle.sourceCoverage.eval;
    for (const diagnosis of Object.values(bundle.bySkill).flat()) {
      const existing = byStableKey.get(diagnosis.stableKey);
      if (!existing) {
        byStableKey.set(diagnosis.stableKey, {
          ...diagnosis,
          occurrences: [...diagnosis.occurrences],
        });
        continue;
      }
      existing.occurrences.push(...diagnosis.occurrences);
      // 累加而不是用 occurrences.length 覆盖:聚合型 Diagnosis(如 problemPattern)的
      // occurrenceCount 是「N 次真实发生」的语义,不是「N 条 source occurrence 条数」。
      // 用 length 会把 `3 次 + 4 次` 真实发生压成 `2`(两条 source 条目),Studio 排序和
      // affectedCount 显示偏小。
      existing.occurrenceCount = existing.occurrenceCount + diagnosis.occurrenceCount;
      existing.severity = severityRank(existing.severity) >= severityRank(diagnosis.severity)
        ? existing.severity
        : diagnosis.severity;
    }
  }
  const bySkill: DiagnosisBundle['bySkill'] = {};
  for (const diagnosis of byStableKey.values()) {
    bySkill[diagnosis.skillName] ??= [];
    bySkill[diagnosis.skillName].push(diagnosis);
  }
  for (const values of Object.values(bySkill)) {
    values.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.signal.localeCompare(b.signal));
  }
  return {
    schemaVersion: 1,
    generatedAt,
    sourceCoverage,
    bySkill,
  };
}

export function activeStudioDiagnostics(bundle?: DiagnosisBundle): Diagnosis[] {
  return Object.values(bundle?.bySkill ?? {})
    .flat()
    .filter((diagnosis) => isActiveDiagnosisLifecycle(diagnosis.lifecycle))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.skillName.localeCompare(b.skillName));
}

function severityRank(severity: DiagnosisSeverity): number {
  if (severity === 'high') return 4;
  if (severity === 'medium') return 3;
  if (severity === 'low') return 2;
  return 1;
}
