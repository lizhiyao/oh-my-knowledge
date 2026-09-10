import { measuredToolFailureRate } from '../../observability/skill-health/analyzer.js';
import type { SkillObserveSnapshot } from '../view-models/skill-index.js';
import type { Lang } from '../../shared/language.js';
import type { Insight, SkillIndexEntry } from '../view-models/index.js';
import type { HealthAssessment } from '../view-models/health-assessment.js';
import type { SkillReportContext } from '../view-models/report-context.js';

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
    return { grade: 'unhealthy', score, label: lang === 'zh' ? '不健康' : 'Unhealthy', emoji: '🔴', color: 'red' };
  }
  if (medium || warned) {
    return { grade: 'fair', score, label: lang === 'zh' ? '待改进' : 'Fair', emoji: '🟡', color: 'yellow' };
  }
  if (score === null) {
    return { grade: 'unscored', score: null, label: lang === 'zh' ? '未评估' : 'Unscored', emoji: '⚪', color: 'gray' };
  }
  if (insights.length === 0) {
    return { grade: 'excellent', score, label: lang === 'zh' ? '健康' : 'Excellent', emoji: '🟢', color: 'green' };
  }
  return { grade: 'good', score, label: lang === 'zh' ? '良好' : 'Good', emoji: '🟢', color: 'green' };
}

function fmtHistDate(ts: string | undefined, lang: Lang): string {
  if (!ts) return '-';
  try {
    const d = new Date(ts);
    return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return ts; }
}

// Doctor 详情只链接 doctor／observe 独立事实源。Evaluation 由 Core Studio 单独呈现。
export function buildSkillContext(entry: SkillIndexEntry, currentReportId: string, insights: Insight[], lang: Lang): SkillReportContext {
  const zh = lang === 'zh';
  const amp = lang === 'zh' ? '' : `&lang=${lang}`;
  type Band = 'green' | 'yellow' | 'red' | 'gray';
  const health = assessHealth(entry, insights, lang);
  const doctor = entry.doctor;
  const doctorBand: Band = doctor
    ? doctor.failCount > 0 ? 'red' : doctor.warnCount > 0 ? 'yellow' : 'green'
    : 'gray';
  const observe = entry.observe;
  const observeBand: Band = observe?.effectiveBand ?? 'gray';
  const observeTrustworthy = observe !== null && observeBand !== 'gray';
  const history = [...entry.doctorHistory].reverse().map((snapshot) => {
    const total = snapshot.passCount + snapshot.warnCount + snapshot.failCount;
    return {
      dim: 'doctor' as const,
      dateText: fmtHistDate(snapshot.timestamp, lang),
      scoreText: total > 0 ? String(Math.round(((snapshot.passCount + snapshot.warnCount * 0.5) / total) * 100)) : '—',
      band: (snapshot.failCount > 0 ? 'red' : snapshot.warnCount > 0 ? 'yellow' : 'green') as Band,
      metaText: `${snapshot.passCount}✓ ${snapshot.warnCount}⚠ ${snapshot.failCount}✗`,
      href: `/knowledge/doctors/${encodeURIComponent(snapshot.reportId)}?skill=${encodeURIComponent(entry.skillName)}${amp}`,
      current: snapshot.reportId === currentReportId,
    };
  });
  return {
    skillName: entry.skillName,
    overall: { score: health.score, band: health.color },
    chips: [
      { dim: 'doctor', label: zh ? '体检' : 'Doctor', score: null, band: doctorBand, href: null, active: true },
      { dim: 'observe', label: zh ? '观察' : 'Observe', score: observeTrustworthy ? Math.round((1 - observe.gapRate) * 100) : null, band: observeBand, href: null, active: false },
    ],
    history,
  };
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
