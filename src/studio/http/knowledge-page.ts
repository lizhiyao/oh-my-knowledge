import type { Lang } from '../../shared/language.js';
import type { KnowledgeQuery } from '../application/knowledge-query.js';
import { assessHealth, observedToolFailureRate } from '../application/skill-health.js';
import type { HealthAssessment } from '../view-models/health-assessment.js';
import type { Insight } from '../view-models/insight.js';
import type { SkillDoctorSnapshot, SkillIndexEntry, SkillIndexSummary } from '../view-models/skill-index.js';

export interface KnowledgeRow {
  skillName: string;
  health: HealthAssessment;
  doctor: SkillIndexEntry['doctor'];
  observe: SkillIndexEntry['observe'];
  insightCount: number;
}

/** 历次体检的列表项：只带时间与计数，逐条规则按需在选中时随 doctorRun 下发。 */
export type DoctorRunSummary = Omit<SkillDoctorSnapshot, 'results'>;

export type KnowledgePage =
  | { pageKind: 'index'; rows: KnowledgeRow[]; summary: SkillIndexSummary }
  | {
    pageKind: 'detail';
    row: KnowledgeRow;
    insights: Insight[];
    toolFailureRate: number | null;
    /** 该 skill 的全部体检轮次，最近一次在前。 */
    doctorRuns: DoctorRunSummary[];
    /** `?doctorRun=` 选中的历史轮次；null = 呈现 `row.doctor`（当前最新那次）。 */
    doctorRun: SkillDoctorSnapshot | null;
  };

function toRunSummary(snapshot: SkillDoctorSnapshot): DoctorRunSummary {
  return {
    reportId: snapshot.reportId,
    timestamp: snapshot.timestamp,
    status: snapshot.status,
    passCount: snapshot.passCount,
    warnCount: snapshot.warnCount,
    failCount: snapshot.failCount,
  };
}

export function loadKnowledgePage(
  query: KnowledgeQuery,
  path: string,
  lang: Lang,
  doctorRunId?: string | null,
): KnowledgePage | undefined {
  const index = query.read();
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
  // doctorHistory 升序（最早 → 最近）；页面按「最近一次在前」呈现，与体检／评测历史的读法一致。
  const history = [...entry.doctorHistory].reverse();
  const selected = doctorRunId && doctorRunId !== entry.doctor?.reportId
    ? history.find((snapshot) => snapshot.reportId === doctorRunId)
    : undefined;
  return {
    pageKind: 'detail',
    row: row(entry),
    insights: index.insightsBySkill.get(name) ?? [],
    toolFailureRate: entry.observe ? observedToolFailureRate(entry.observe) : null,
    doctorRuns: history.map(toRunSummary),
    doctorRun: selected ?? null,
  };
}
