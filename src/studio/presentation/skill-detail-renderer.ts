import { DEFAULT_LANG, e, layout } from './layout.js';
import type { Lang } from '../../shared/language.js';
import type { Insight, SkillIndexEntry } from '../view-models/index.js';

export type HealthGrade = 'excellent' | 'good' | 'fair' | 'unhealthy' | 'unscored';

export interface HealthAssessment {
  grade: HealthGrade;
  score: number | null;
  label: string;
  emoji: string;
  color: 'green' | 'yellow' | 'red' | 'gray';
}

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

function doctorSection(entry: SkillIndexEntry, lang: Lang): string {
  const doctor = entry.doctor;
  if (doctor === null) return `<section class="sd-card"><h2>${lang === 'zh' ? '健康体检' : 'Doctor'}</h2><p class="sd-muted">${lang === 'zh' ? '尚未运行。' : 'Not run yet.'}</p></section>`;
  const rows = doctor.results.map((result) => `<li class="sd-rule sd-rule--${result.status}"><strong>${e(result.ruleId)}</strong><span>${e(result.message)}</span></li>`).join('');
  return `<section class="sd-card"><h2>${lang === 'zh' ? '健康体检' : 'Doctor'}</h2><p>${doctor.passCount}✓　${doctor.warnCount}⚠　${doctor.failCount}✗</p><ul class="sd-rules">${rows}</ul></section>`;
}

function observeSection(entry: SkillIndexEntry, lang: Lang): string {
  const observe = entry.observe;
  if (observe === null) return `<section class="sd-card"><h2>${lang === 'zh' ? '生产观察' : 'Observe'}</h2><p class="sd-muted">${lang === 'zh' ? '尚无生产观测。' : 'No production observations yet.'}</p></section>`;
  const confidence = observe.confidence === 'underpowered'
    ? (lang === 'zh' ? '样本不足，仅供参考' : 'Underpowered; indicative only')
    : observe.confidence;
  return `<section class="sd-card"><h2>${lang === 'zh' ? '生产观察' : 'Observe'}</h2><dl class="sd-metrics"><div><dt>${lang === 'zh' ? '知识缺口' : 'Knowledge gap'}</dt><dd>${(observe.gapRate * 100).toFixed(1)}%</dd></div><div><dt>${lang === 'zh' ? '工具失败' : 'Tool failures'}</dt><dd>${(observe.failureRate * 100).toFixed(1)}%</dd></div><div><dt>${lang === 'zh' ? '片段数' : 'Segments'}</dt><dd>${observe.segmentCount}</dd></div><div><dt>${lang === 'zh' ? '可信度' : 'Confidence'}</dt><dd>${e(confidence)}</dd></div></dl></section>`;
}

function insightSection(insights: Insight[], lang: Lang): string {
  if (insights.length === 0) return `<section class="sd-card"><h2>${lang === 'zh' ? '待优化项' : 'Findings'}</h2><p class="sd-muted">${lang === 'zh' ? '当前没有活跃问题。' : 'No active findings.'}</p></section>`;
  const rows = insights.map((insight) => `<li class="sd-insight sd-insight--${insight.severity}"><div><strong>${e(insight.title)}</strong><span>${e(insight.description ?? '')}</span></div><small>${e(insight.audience)} · ${e(insight.severity)}</small></li>`).join('');
  return `<section class="sd-card"><h2>${lang === 'zh' ? '待优化项' : 'Findings'}</h2><ul class="sd-insights">${rows}</ul></section>`;
}

export function renderSkillDetail(
  entry: SkillIndexEntry,
  lang: Lang = DEFAULT_LANG,
  insights: Insight[] = [],
): string {
  const health = assessHealth(entry, insights, lang);
  const langQ = lang === DEFAULT_LANG ? '' : '?lang=en';
  return layout(`${entry.skillName} · OMK`, `<main class="sd-main"><nav><a href="/knowledge${langQ}">← ${lang === 'zh' ? '知识工作台' : 'Knowledge'}</a></nav><header class="sd-hero sd-hero--${health.color}"><div><p>${lang === 'zh' ? '知识健康' : 'Knowledge health'}</p><h1>${e(entry.skillName)}</h1></div><div class="sd-score"><strong>${health.score ?? '—'}</strong><span>${e(health.label)}</span></div></header><div class="sd-grid">${doctorSection(entry, lang)}${observeSection(entry, lang)}</div>${insightSection(insights, lang)}</main><style>${CSS}</style>`, lang);
}

const CSS = `
.sd-main{max-width:980px;margin:0 auto;padding:24px}.sd-main nav{margin-bottom:14px}.sd-main nav a{color:var(--text-muted);text-decoration:none}.sd-hero{display:flex;justify-content:space-between;align-items:center;padding:22px 26px;background:#fff;border:1px solid var(--border);border-left:5px solid #9ca3af;border-radius:12px;margin-bottom:16px}.sd-hero--green{border-left-color:#1f9d63}.sd-hero--yellow{border-left-color:#d97706}.sd-hero--red{border-left-color:#dc2626}.sd-hero p{margin:0 0 5px;color:var(--text-muted);font-size:12px}.sd-hero h1{margin:0;font-size:25px}.sd-score{display:flex;align-items:baseline;gap:10px}.sd-score strong{font-size:36px}.sd-score span{color:var(--text-muted)}.sd-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.sd-card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:16px}.sd-card h2{font-size:15px;margin:0 0 12px}.sd-muted{color:var(--text-muted)}.sd-rules,.sd-insights{list-style:none;padding:0;margin:0}.sd-rule,.sd-insight{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid #eef1f6}.sd-rule span,.sd-insight span{display:block;color:var(--text-muted);font-size:12px;margin-top:3px}.sd-rule--fail strong,.sd-insight--high strong{color:#dc2626}.sd-rule--warn strong,.sd-insight--medium strong{color:#d97706}.sd-metrics{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0}.sd-metrics div{padding:10px;background:#f8f9fd;border-radius:8px}.sd-metrics dt{font-size:12px;color:var(--text-muted)}.sd-metrics dd{margin:5px 0 0;font-weight:700}.sd-insight small{white-space:nowrap;color:var(--text-muted)}@media(max-width:700px){.sd-grid{grid-template-columns:1fr}.sd-hero{align-items:flex-start}.sd-score{flex-direction:column;gap:2px}}
`;
