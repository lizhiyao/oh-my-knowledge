import { measuredToolFailureRate } from '../../../observability/application.js';
import type { SkillHealthBand, SkillIndexEntry, SkillObserveSnapshot } from '../../view-models/knowledge/skill-index.js';
import type { Lang } from '../../../shared/language.js';
import type { Insight } from '../../view-models/knowledge/insight.js';
import type { HealthAssessment } from '../../view-models/knowledge/health-assessment.js';
import { healthBandTone } from '../display/tone.js';

/** green 档还要分「健康」与「良好」：同色，只有措辞能把「零待优化项」分开。 */
const LABELS: Record<Lang, Record<SkillHealthBand | 'good', string>> = {
  zh: { green: '健康', good: '良好', yellow: '待改进', red: '不健康', gray: '未评估' },
  en: { green: 'Excellent', good: 'Good', yellow: 'Fair', red: 'Unhealthy', gray: 'Unscored' },
};

function healthScore(entry: SkillIndexEntry): number | null {
  const doctor = entry.doctor;
  const doctorTotal = doctor === null ? 0 : doctor.passCount + doctor.warnCount + doctor.failCount;
  const doctorScore = doctor !== null && doctorTotal > 0
    ? ((doctor.passCount + doctor.warnCount * 0.5) / doctorTotal) * 100
    : null;
  const observeTrusted = (entry.observe?.effectiveBand ?? 'gray') !== 'gray';
  const observeScore = observeTrusted ? (1 - entry.observe!.gapRate) * 100 : null;
  const dimensions = [doctorScore, observeScore].filter((value): value is number => value !== null);
  return dimensions.length === 0
    ? null
    : Math.round(dimensions.reduce((sum, value) => sum + value, 0) / dimensions.length);
}

/**
 * 综合健康档位的唯一判定：doctor／observe 任一红或 high 洞察 → red，任一黄或 medium 洞察 → yellow，
 * 没有可信维度则 gray，其余 green。`entry.band` 与列表汇总都读这一处，页面着色读 `healthBandTone`。
 */
export function healthBand(entry: SkillIndexEntry, insights: readonly Insight[]): SkillHealthBand {
  const observeBand = entry.observe?.effectiveBand ?? 'gray';
  const high = insights.some((insight) => insight.severity === 'high');
  const medium = insights.some((insight) => insight.severity === 'medium');
  const failed = (entry.doctor?.failCount ?? 0) > 0 || observeBand === 'red';
  const warned = (entry.doctor?.warnCount ?? 0) > 0 || observeBand === 'yellow';
  if (high || failed) return 'red';
  if (medium || warned) return 'yellow';
  return healthScore(entry) === null ? 'gray' : 'green';
}

export function assessHealth(entry: SkillIndexEntry, insights: readonly Insight[], lang: Lang): HealthAssessment {
  const band = healthBand(entry, insights);
  const key = band === 'green' && insights.length > 0 ? 'good' : band;
  return { score: healthScore(entry), band, tone: healthBandTone(band), label: LABELS[lang][key] };
}

export function observedToolFailureRate(observe: SkillObserveSnapshot): number | null {
  return measuredToolFailureRate({
    stability: observe.stability ?? 'stable',
    toolCallCount: observe.toolCallCount ?? 0,
    toolResolvedCount: observe.toolResolvedCount,
    toolCancelledCount: observe.toolCancelledCount,
    toolFailureRate: observe.failureRate,
  });
}
