import type { Lang } from '../../shared/language.js';
import type { KnowledgeQuery } from '../application/knowledge-query.js';
import { assessHealth, observedToolFailureRate } from '../application/skill-health.js';
import type { HealthAssessment } from '../view-models/health-assessment.js';
import type { Insight } from '../view-models/insight.js';
import type { SkillIndexEntry, SkillIndexSummary } from '../view-models/skill-index.js';

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

export function loadKnowledgePage(query: KnowledgeQuery, path: string, lang: Lang): KnowledgePage | undefined {
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
  return { pageKind: 'detail', row: row(entry), insights: index.insightsBySkill.get(name) ?? [], toolFailureRate: entry.observe ? observedToolFailureRate(entry.observe) : null };
}
