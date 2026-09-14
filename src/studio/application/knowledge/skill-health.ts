import { measuredToolFailureRate } from '../../../observability/skill-health/analyzer.js';
import type { SkillIndexEntry, SkillObserveSnapshot } from '../../view-models/knowledge/skill-index.js';
import type { Lang } from '../../../shared/language.js';
import type { Insight } from '../../view-models/knowledge/insight.js';
import type { HealthAssessment } from '../../view-models/knowledge/health-assessment.js';

export function assessHealth(entry: SkillIndexEntry, insights: Insight[], lang: Lang): HealthAssessment {
  const doctor = entry.doctor;
  const doctorTotal = doctor === null ? 0 : doctor.passCount + doctor.warnCount + doctor.failCount;
  const doctorScore = doctor !== null && doctorTotal > 0
    ? ((doctor.passCount + doctor.warnCount * 0.5) / doctorTotal) * 100
    : null;
  const observeBand = entry.observe?.effectiveBand ?? 'gray';
  const observeTrusted = observeBand !== 'gray';
  const observeScore = observeTrusted ? (1 - entry.observe!.gapRate) * 100 : null;
  const dimensions = [doctorScore, observeScore].filter((value): value is number => value !== null);
  const score = dimensions.length === 0
    ? null
    : Math.round(dimensions.reduce((sum, value) => sum + value, 0) / dimensions.length);
  const high = insights.some((insight) => insight.severity === 'high');
  const medium = insights.some((insight) => insight.severity === 'medium');
  const failed = (doctor?.failCount ?? 0) > 0 || observeBand === 'red';
  const warned = (doctor?.warnCount ?? 0) > 0 || observeBand === 'yellow';
  if (high || failed) {
    return { score, label: lang === 'zh' ? '不健康' : 'Unhealthy', color: 'red' };
  }
  if (medium || warned) {
    return { score, label: lang === 'zh' ? '待改进' : 'Fair', color: 'yellow' };
  }
  if (score === null) {
    return { score: null, label: lang === 'zh' ? '未评估' : 'Unscored', color: 'gray' };
  }
  if (insights.length === 0) {
    return { score, label: lang === 'zh' ? '健康' : 'Excellent', color: 'green' };
  }
  return { score, label: lang === 'zh' ? '良好' : 'Good', color: 'green' };
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
