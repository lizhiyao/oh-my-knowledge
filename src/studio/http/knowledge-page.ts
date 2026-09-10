import { projectDoctorsDir, projectObserveHealthDir, resolveDoctorsDir, resolveObserveHealthDir } from '../../evidence/storage/directories.js';
import { DEFAULT_OBSERVATIONS_DIR } from '../../observability/inbox/index.js';
import { buildSkillIndex } from '../application/index.js';
import { assessHealth, observedToolFailureRate } from '../application/skill-health.js';
import type { SkillIndexEntry, SkillIndexSummary } from '../view-models/skill-index.js';
import type { Insight } from '../view-models/insight.js';
import type { HealthAssessment } from '../view-models/health-assessment.js';
import type { ReportServerOptions } from './contracts.js';
import type { Lang } from '../../shared/language.js';

export interface KnowledgeRow {
  skillName: string;
  health: HealthAssessment;
  doctor: SkillIndexEntry['doctor'];
  observe: SkillIndexEntry['observe'];
  insightCount: number;
}
export type KnowledgePage =
  | { pageKind: 'index'; rows: KnowledgeRow[]; summary: SkillIndexSummary }
  | { pageKind: 'detail'; row: KnowledgeRow; insights: Insight[]; toolFailureRate: number | null };

export function loadKnowledgePage(options: ReportServerOptions, path: string, lang: Lang): KnowledgePage | undefined {
  const resolve = (value: string | (() => string) | undefined, fallback: () => string): string =>
    typeof value === 'function' ? value() : value ?? fallback();
  const index = buildSkillIndex(
    resolve(options.analysesDir, () => resolveObserveHealthDir(projectObserveHealthDir())),
    resolve(options.doctorsDir, () => resolveDoctorsDir(projectDoctorsDir())),
    options.observationsDir ?? DEFAULT_OBSERVATIONS_DIR,
    { includeObserveCards: options.includeObserveCards ?? false, includeDoctorCards: options.includeDoctorCards ?? false },
  );
  const row = (entry: SkillIndexEntry): KnowledgeRow => ({
    skillName: entry.skillName,
    health: assessHealth(entry, index.insightsBySkill.get(entry.skillName) ?? [], lang),
    doctor: entry.doctor,
    observe: entry.observe,
    insightCount: index.insightsBySkill.get(entry.skillName)?.length ?? 0,
  });
  if (path === '/knowledge') return { pageKind: 'index', rows: index.entries.map(row), summary: index.summary };
  let name: string;
  const encoded = path.slice('/knowledge/skills/'.length);
  if (!encoded || encoded.includes('/')) return undefined;
  try { name = decodeURIComponent(encoded); } catch { return undefined; }
  const entry = index.entries.find((item) => item.skillName === name);
  if (!entry) return undefined;
  return { pageKind: 'detail', row: row(entry), insights: index.insightsBySkill.get(name) ?? [], toolFailureRate: entry.observe ? observedToolFailureRate(entry.observe) : null };
}
