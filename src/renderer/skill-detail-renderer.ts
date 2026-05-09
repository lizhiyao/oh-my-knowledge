/**
 * Skill 详情页 — 问题优先,扁平 1-2 屏。
 *
 *   ┌─ skill 名 + band + 健康摘要一句话 ──────────────┐
 *   │ 关键问题(按受众分组,默认全展开)│ 健康趋势(chart.js 折线)│
 *   │ #1 [高 / Skill] 标题 …          │ ─── 三条线 ──────────  │
 *   │ #2 [高 / Skill] 标题 …          │ 🩺 Doctor 7✓ 1⚠       │
 *   │ #3 [中 / 用例]  标题 …          │ 🧪 Eval   80%         │
 *   │   单条点击 → modal              │ 👁 Observe 稳定        │
 *   │                                 │   阶段卡点击 → modal   │
 *   └────────────────────────────────────────────────────────┘
 *   隐藏 modal:每条 insight 一个 + 3 个阶段全量明细各一个
 */
import { layout, e, DEFAULT_LANG } from './layout.js';
import type { Lang, EvaluationReport, VariantResult } from '../types/index.js';
import type { SkillIndexEntry, SkillDoctorSnapshot, SkillEvalSnapshot, SkillObserveSnapshot } from '../server/skill-index.js';
import type { Insight, InsightSeverity, InsightEvidence, InsightPerspective, InsightAudience, InsightIllustration, InsightPatch } from '../server/skill-insights.js';
import { detectInsights, groupInsightsByAudience } from '../server/skill-insights.js';
import type { DoctorRuleResult } from '../types/doctor.js';

const BAND_DOT: Record<'green' | 'yellow' | 'red' | 'gray', string> = {
  green: '🟢', yellow: '🟡', red: '🔴', gray: '⚪',
};
const SEVERITY_ICON: Record<InsightSeverity, string> = { high: '🔴', medium: '🟡', low: '🟢' };
const SEVERITY_LABEL_ZH: Record<InsightSeverity, string> = { high: '高', medium: '中', low: '低' };
const SEVERITY_LABEL_EN: Record<InsightSeverity, string> = { high: 'High', medium: 'Med', low: 'Low' };

const PERSPECTIVE_ZH: Record<InsightPerspective, string> = {
  doctor: '静态体检', 'eval-score': '评分视角', 'eval-functional': '功能视角', observe: '线上观测',
};
const PERSPECTIVE_EN: Record<InsightPerspective, string> = {
  doctor: 'Static check', 'eval-score': 'Score view', 'eval-functional': 'Functional view', observe: 'Production',
};

const STATUS_ICON: Record<InsightEvidence['status'], string> = {
  flagged: '✗', blind: '👁', silent: '○', na: '—',
};

const AUDIENCE_INFO_ZH: Record<InsightAudience, { icon: string; title: string; subtitle: string }> = {
  'skill-author': { icon: '📝', title: 'Skill 优化项', subtitle: '改 SKILL.md 内容' },
  'sample-author': { icon: '🔧', title: '用例优化项', subtitle: '改 samples.json,不动 skill' },
  'omk-maintainer': { icon: '⚙️', title: '工具反馈', subtitle: '给 omk 维护者' },
};
const AUDIENCE_INFO_EN: Record<InsightAudience, { icon: string; title: string; subtitle: string }> = {
  'skill-author': { icon: '📝', title: 'Skill optimization', subtitle: 'Update SKILL.md' },
  'sample-author': { icon: '🔧', title: 'Sample optimization', subtitle: 'Update samples.json' },
  'omk-maintainer': { icon: '⚙️', title: 'Tool feedback', subtitle: 'For omk maintainers' },
};

const PATCH_TARGET_ZH: Record<InsightPatch['target'], string> = {
  skill: 'SKILL.md',
  'sample-environment': 'samples.json (environment)',
  'sample-mocks': 'samples.json (mocks)',
  'doctor-rule': 'omk doctor rule (omk 仓库)',
};
const PATCH_TARGET_EN: Record<InsightPatch['target'], string> = {
  skill: 'SKILL.md',
  'sample-environment': 'samples.json (environment)',
  'sample-mocks': 'samples.json (mocks)',
  'doctor-rule': 'omk doctor rule (omk repo)',
};

interface InsightIndex {
  byInsightId: Map<string, number>;
  byNumber: Map<number, Insight>;
}

function buildInsightIndex(insights: Insight[]): InsightIndex {
  const idx: InsightIndex = { byInsightId: new Map(), byNumber: new Map() };
  insights.forEach((ins, i) => {
    const num = i + 1;
    idx.byInsightId.set(ins.id, num);
    idx.byNumber.set(num, ins);
  });
  return idx;
}

function relTime(ts: string | null | undefined, lang: Lang): string {
  if (!ts) return lang === 'zh' ? '未跑' : 'never';
  try {
    const past = new Date(ts).getTime();
    const diff = Math.max(0, Date.now() - past);
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return lang === 'zh' ? `${mins} 分钟前` : `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return lang === 'zh' ? `${hours} 小时前` : `${hours}h ago`;
    return lang === 'zh' ? `${Math.floor(hours / 24)} 天前` : `${Math.floor(hours / 24)}d ago`;
  } catch { return ''; }
}

function fmtDateShort(ts: string | null | undefined): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  } catch { return ''; }
}

// ────────── 健康等级评估 ──────────

export type HealthGrade = 'excellent' | 'good' | 'fair' | 'unhealthy' | 'unscored';

export interface HealthAssessment {
  grade: HealthGrade;
  /** 0-100 参考分,各维度归一平均;无任何维度跑过时为 null。 */
  score: number | null;
  label: string;
  emoji: string;
  color: 'green' | 'yellow' | 'red' | 'gray';
}

export function assessHealth(entry: SkillIndexEntry, insights: Insight[], lang: Lang): HealthAssessment {
  const ran = [entry.doctor, entry.eval, entry.observe].filter(Boolean).length;
  if (ran === 0) {
    return { grade: 'unscored', score: null, label: lang === 'zh' ? '未评估' : 'Unscored', emoji: '⚪', color: 'gray' };
  }

  let doctorPct: number | null = null;
  if (entry.doctor) {
    const total = entry.doctor.passCount + entry.doctor.warnCount + entry.doctor.failCount;
    doctorPct = total > 0
      ? ((entry.doctor.passCount + entry.doctor.warnCount * 0.5) / total) * 100
      : 100;
  }
  let evalPct: number | null = null;
  if (entry.eval) {
    if (entry.eval.compositeScore != null) {
      evalPct = (entry.eval.compositeScore / 5) * 100;
    } else {
      const total = entry.eval.passCount + entry.eval.failCount;
      if (total > 0) evalPct = (entry.eval.passCount / total) * 100;
    }
  }
  let observePct: number | null = null;
  if (entry.observe) {
    const coverage = (1 - entry.observe.gapRate) * 100;
    const bandMul = entry.observe.healthBand === 'red' ? 0.6 : entry.observe.healthBand === 'yellow' ? 0.85 : 1;
    observePct = coverage * bandMul;
  }
  const dims = [doctorPct, evalPct, observePct].filter((x): x is number => x != null);
  const score = dims.length > 0 ? Math.round(dims.reduce((s, x) => s + x, 0) / dims.length) : null;

  const hasFail = (entry.doctor != null && entry.doctor.failCount > 0)
    || (entry.eval != null && entry.eval.passCount === 0 && entry.eval.failCount > 0)
    || (entry.observe != null && entry.observe.healthBand === 'red');
  const hasWarn = (entry.doctor != null && entry.doctor.warnCount > 0)
    || (entry.eval != null && entry.eval.compositeScore != null && entry.eval.compositeScore < 4)
    || (entry.observe != null && entry.observe.healthBand === 'yellow');
  const high = insights.filter((i) => i.severity === 'high').length;
  const med = insights.filter((i) => i.severity === 'medium').length;

  if (high > 0 || hasFail) {
    return { grade: 'unhealthy', score, label: lang === 'zh' ? '不健康' : 'Unhealthy', emoji: '🔴', color: 'red' };
  }
  if (med > 0 || hasWarn) {
    return { grade: 'fair', score, label: lang === 'zh' ? '待改进' : 'Fair', emoji: '🟡', color: 'yellow' };
  }
  if (insights.length === 0 && !hasWarn) {
    return { grade: 'excellent', score, label: lang === 'zh' ? '健康' : 'Excellent', emoji: '🟢', color: 'green' };
  }
  return { grade: 'good', score, label: lang === 'zh' ? '良好' : 'Good', emoji: '🟢', color: 'green' };
}

// ────────── Hero:健康等级 + 名称 + 摘要 ──────────

function renderHero(entry: SkillIndexEntry, insights: Insight[], lastTs: string | undefined, reportCount: number, lang: Lang): string {
  const h = assessHealth(entry, insights, lang);
  const scoreTip = lang === 'zh'
    ? '参考分:doctor 通过率、eval 综合分、observe 稳定度归一到 0-100 后取平均(warn/告警按 0.5 折算)。同一 skill 跨时间可比;不同 skill 之间因 sample 难度不同不严格可比'
    : 'Reference score: average of doctor pass-rate, eval composite, and observe stability normalized to 0-100. Comparable within a skill over time; not strictly comparable across skills (sample difficulty differs)';
  const scoreBlock = h.score != null
    ? `<span class="si-hero-score" title="${e(scoreTip)}"><span class="si-hero-score-num">${h.score}</span><span class="si-hero-score-unit">/100</span></span>`
    : `<span class="si-hero-score si-hero-score--empty" title="${e(scoreTip)}">—</span>`;

  return `<div class="si-hero">
    <div class="si-hero-grade si-hero-grade--${h.color}">
      <span class="si-hero-grade-emoji">${h.emoji}</span>
      <span class="si-hero-grade-label">${e(h.label)}</span>
      ${scoreBlock}
    </div>
    <div class="si-hero-info">
      <div class="si-hero-name">${e(entry.skillName)}</div>
      <div class="si-hero-summary">${renderHealthSummary(entry, insights, lang)}</div>
    </div>
    <div class="si-hero-meta">${reportCount}/3 · ${relTime(lastTs, lang)}</div>
  </div>`;
}

function renderHealthSummary(entry: SkillIndexEntry, insights: Insight[], lang: Lang): string {
  const parts: string[] = [];
  const high = insights.filter((i) => i.severity === 'high').length;
  const med = insights.filter((i) => i.severity === 'medium').length;

  if (high === 0 && med === 0 && insights.length === 0) {
    parts.push(lang === 'zh' ? '✅ 未检测到自动可识别的问题' : '✅ No auto-detected issues');
  } else if (high > 0) {
    parts.push(lang === 'zh' ? `检出 ${insights.length} 个待优化(其中 ${high} 个高优)` : `${insights.length} issues (${high} high)`);
  } else {
    parts.push(lang === 'zh' ? `检出 ${insights.length} 个待优化` : `${insights.length} issues`);
  }

  if (entry.doctor) {
    if (entry.doctor.failCount > 0) parts.push(lang === 'zh' ? `doctor ${entry.doctor.failCount} 项不通过` : `doctor ${entry.doctor.failCount} fail`);
    else if (entry.doctor.warnCount > 0) parts.push(lang === 'zh' ? `doctor ${entry.doctor.warnCount} 项告警` : `doctor ${entry.doctor.warnCount} warn`);
  }
  if (entry.eval) {
    const total = entry.eval.passCount + entry.eval.failCount;
    if (total > 0) {
      const pct = Math.round((entry.eval.passCount / total) * 100);
      parts.push(lang === 'zh' ? `eval 通过率 ${pct}%` : `eval ${pct}% pass`);
    }
  }
  if (entry.observe) {
    parts.push(lang === 'zh' ? `observe ${BAND_DOT[entry.observe.healthBand]}` : `observe ${BAND_DOT[entry.observe.healthBand]}`);
  }
  return parts.join('，');
}

// ────────── 左栏:问题列表 ──────────

function renderInsightRow(ins: Insight, num: number, lang: Lang): string {
  const sevLabel = lang === 'zh' ? SEVERITY_LABEL_ZH[ins.severity] : SEVERITY_LABEL_EN[ins.severity];
  return `<button type="button" class="si-row si-row--${ins.severity}" onclick="openModal('insight-${num}')">
    <span class="si-row-num">#${num}</span>
    <span class="si-row-sev si-row-sev--${ins.severity}">${e(sevLabel)}</span>
    <span class="si-row-title">${e(ins.title)}</span>
    ${ins.affectedCount > 0 ? `<span class="si-row-meta">×${ins.affectedCount}</span>` : ''}
    <span class="si-row-arrow">›</span>
  </button>`;
}

function renderInsightListEmpty(entry: SkillIndexEntry, lang: Lang): string {
  const passed: string[] = [];
  const suggestions: string[] = [];

  if (entry.doctor) {
    const total = entry.doctor.passCount + entry.doctor.warnCount + entry.doctor.failCount;
    passed.push(lang === 'zh' ? `Doctor ${entry.doctor.passCount}/${total} 通过` : `Doctor ${entry.doctor.passCount}/${total} pass`);
  } else {
    suggestions.push(lang === 'zh' ? '跑 <code>omk doctor</code> 做静态体检' : 'Run <code>omk doctor</code> for static checks');
  }
  if (entry.eval) {
    const total = entry.eval.passCount + entry.eval.failCount;
    const pct = total > 0 ? Math.round((entry.eval.passCount / total) * 100) : 0;
    const score = entry.eval.compositeScore != null ? `(${entry.eval.compositeScore.toFixed(2)}/5)` : '';
    passed.push(lang === 'zh' ? `Eval 通过率 ${pct}% ${score}` : `Eval ${pct}% pass ${score}`);
  } else {
    suggestions.push(lang === 'zh' ? '跑 <code>omk eval</code> 评测 skill 表现' : 'Run <code>omk eval</code> to score the skill');
  }
  if (entry.observe) {
    passed.push(lang === 'zh'
      ? `Observe ${entry.observe.segmentCount} 段,稳定度 ${((1 - entry.observe.gapRate) * 100).toFixed(0)}%`
      : `Observe ${entry.observe.segmentCount} segs, ${((1 - entry.observe.gapRate) * 100).toFixed(0)}% stable`);
  } else {
    suggestions.push(lang === 'zh' ? '跑 <code>omk observe &lt;trace-dir&gt;</code> 接生产数据' : 'Run <code>omk observe</code> on production traces');
  }

  const evalLow = entry.eval && entry.eval.totalSamples < 5;
  if (evalLow) {
    suggestions.push(lang === 'zh'
      ? `当前只有 ${entry.eval!.totalSamples} 个 sample,加到 ≥ 5 提高代表性`
      : `Only ${entry.eval!.totalSamples} samples — add more (≥ 5) for better coverage`);
  }
  const trendPoints = entry.doctorHistory.length + entry.evalHistory.length + entry.observeHistory.length;
  if (trendPoints >= 3) {
    suggestions.push(lang === 'zh' ? '看右侧趋势曲线,确认健康度在长期保持' : 'Check the trend chart on the right to confirm long-term stability');
  }
  // 三个 perspective 都跑过且没有其他建议时,fallback 一条引导,避免左下空白
  if (suggestions.length === 0) {
    suggestions.push(lang === 'zh'
      ? '保持现状即可。建议在每次发版或调整 SKILL.md 后再跑一轮确认无回退'
      : 'Keep going. Re-run after each release or SKILL.md change to confirm no regression');
  }

  return `<div class="si-empty">
    <div class="si-empty-h">
      <span class="si-empty-emoji">✨</span>
      <span class="si-empty-title">${lang === 'zh' ? '当前没有自动检测到的待优化项' : 'No auto-detected issues right now'}</span>
    </div>
    ${passed.length > 0 ? `<div class="si-empty-section">
      <div class="si-empty-section-h">${lang === 'zh' ? '已完成的检查' : 'Checks completed'}</div>
      <ul class="si-empty-list si-empty-list--pass">
        ${passed.map((p) => `<li><span class="si-empty-icon">✓</span><span>${p}</span></li>`).join('')}
      </ul>
    </div>` : ''}
    ${suggestions.length > 0 ? `<div class="si-empty-section">
      <div class="si-empty-section-h">${lang === 'zh' ? '还可以补充' : 'Could still do'}</div>
      <ul class="si-empty-list si-empty-list--next">
        ${suggestions.map((s) => `<li><span class="si-empty-icon">→</span><span>${s}</span></li>`).join('')}
      </ul>
    </div>` : ''}
  </div>`;
}

function renderInsightList(insights: Insight[], idx: InsightIndex, entry: SkillIndexEntry, lang: Lang): string {
  if (insights.length === 0) {
    return renderInsightListEmpty(entry, lang);
  }
  const grouped = groupInsightsByAudience(insights);
  const order: InsightAudience[] = ['skill-author', 'sample-author', 'omk-maintainer'];
  const sections = order.map((aud) => {
    const list = grouped[aud];
    if (list.length === 0) return '';
    const info = lang === 'zh' ? AUDIENCE_INFO_ZH[aud] : AUDIENCE_INFO_EN[aud];
    return `<div class="si-aud">
      <div class="si-aud-h">
        <span class="si-aud-icon">${info.icon}</span>
        <span class="si-aud-title">${e(info.title)}</span>
        <span class="si-aud-count">${list.length}</span>
        <span class="si-aud-sub">${e(info.subtitle)}</span>
      </div>
      <div class="si-aud-rows">${list.map((ins) => renderInsightRow(ins, idx.byInsightId.get(ins.id) ?? 0, lang)).join('')}</div>
    </div>`;
  }).join('');
  return sections;
}

// ────────── 右栏:趋势大图 + 阶段卡 ──────────

interface TrendDatum {
  x: string;
  doctorPct: number | null;
  evalPct: number | null;
  observePct: number | null;
  /** 该时间点 doctor 报告 id(无对应单独页面,记下供 tooltip 用)。 */
  doctorReportId: string | null;
  evalReportId: string | null;
  observeAnalysisId: string | null;
}

function buildTrendData(entry: SkillIndexEntry): TrendDatum[] {
  const dateMap = new Map<string, TrendDatum>();
  const dateOf = (ts: string): string => ts.slice(0, 10);
  const get = (date: string): TrendDatum => {
    if (!dateMap.has(date)) {
      dateMap.set(date, { x: date, doctorPct: null, evalPct: null, observePct: null, doctorReportId: null, evalReportId: null, observeAnalysisId: null });
    }
    return dateMap.get(date)!;
  };
  for (const h of entry.doctorHistory) {
    const total = h.passCount + h.warnCount + h.failCount;
    const d = get(dateOf(h.timestamp));
    d.doctorPct = total > 0 ? (h.passCount / total) * 100 : null;
    d.doctorReportId = h.reportId;
  }
  for (const h of entry.evalHistory) {
    const c = h.compositeScore;
    const d = get(dateOf(h.timestamp));
    d.evalPct = c != null ? (c / 5) * 100 : null;
    d.evalReportId = h.reportId;
  }
  for (const h of entry.observeHistory) {
    const d = get(dateOf(h.generatedAt));
    d.observePct = (1 - h.gapRate) * 100;
    d.observeAnalysisId = h.analysisId;
  }
  return Array.from(dateMap.values()).sort((a, b) => a.x.localeCompare(b.x));
}

function renderTrendChart(entry: SkillIndexEntry, langQ: string, lang: Lang): string {
  const data = buildTrendData(entry);
  const labelDoctor = lang === 'zh' ? '🩺 结构规范' : '🩺 Structure';
  const labelEval = lang === 'zh' ? '🧪 实测得分' : '🧪 Test score';
  const labelObserve = lang === 'zh' ? '👁 线上稳定' : '👁 Live stability';

  if (data.length < 2) {
    return `<div class="si-trend-empty">${lang === 'zh' ? '📈 还没有足够的历史数据画趋势(至少 2 个时间点)' : '📈 Need at least 2 data points for trend'}</div>`;
  }
  const linksDoctor = data.map(() => null);
  const linksEval = data.map((d) => d.evalReportId ? `/reports/${d.evalReportId}${langQ}` : null);
  const linksObserve = data.map((d) => d.observeAnalysisId ? `/analyses/${d.observeAnalysisId}${langQ}` : null);
  const explainDoctor = lang === 'zh' ? 'omk doctor 通过率' : 'omk doctor pass-rate';
  const explainEval = lang === 'zh' ? 'omk eval 综合分(归一)' : 'omk eval composite (normalized)';
  const explainObserve = lang === 'zh' ? 'omk observe 真实使用稳定度' : 'omk observe production stability';
  const json = JSON.stringify({
    labels: data.map((d) => fmtDateShort(d.x)),
    datasets: [
      { label: labelDoctor, data: data.map((d) => d.doctorPct), borderColor: '#5e8252', backgroundColor: 'rgba(94,130,82,.1)', tension: 0.3, spanGaps: true, _hint: explainDoctor },
      { label: labelEval, data: data.map((d) => d.evalPct), borderColor: '#5a7a93', backgroundColor: 'rgba(90,122,147,.1)', tension: 0.3, spanGaps: true, _hint: explainEval },
      { label: labelObserve, data: data.map((d) => d.observePct), borderColor: '#b08030', backgroundColor: 'rgba(176,128,48,.1)', tension: 0.3, spanGaps: true, _hint: explainObserve },
    ],
  });
  const links = JSON.stringify([linksDoctor, linksEval, linksObserve]);
  return `<div class="si-trend-canvas-wrap">
    <canvas id="trend-chart" data-chart='${json.replace(/'/g, '&#39;')}' data-links='${links.replace(/'/g, '&#39;')}'></canvas>
  </div>
  <div class="si-trend-hint">${lang === 'zh' ? '点击实测得分 / 线上稳定的数据点跳到那期报告(结构规范无对应详情页)' : 'Click a Test score / Live stability point to open that report'}</div>`;
}

function renderStageCards(entry: SkillIndexEntry, lang: Lang): string {
  const card = (params: {
    icon: string; name: string; modalId: string; band: 'green' | 'yellow' | 'red' | 'gray'; statusText: string; metaText: string;
  }): string => `<button type="button" class="si-stagecard si-stagecard--${params.band}" onclick="openModal('${params.modalId}')">
    <span class="si-stagecard-icon">${params.icon}</span>
    <span class="si-stagecard-body">
      <span class="si-stagecard-name">${e(params.name)}</span>
      <span class="si-stagecard-status">${e(params.statusText)}</span>
    </span>
    <span class="si-stagecard-meta">${e(params.metaText)}</span>
    <span class="si-stagecard-arrow">›</span>
  </button>`;

  const doctorBand: 'green' | 'yellow' | 'red' | 'gray' = entry.doctor
    ? (entry.doctor.status === 'fail' ? 'red' : entry.doctor.status === 'warn' ? 'yellow' : 'green') : 'gray';
  const evalBand: 'green' | 'yellow' | 'red' | 'gray' = entry.eval
    ? (entry.eval.failCount === 0 ? 'green' : entry.eval.passCount === 0 ? 'red' : 'yellow') : 'gray';
  const observeBand: 'green' | 'yellow' | 'red' | 'gray' = entry.observe?.healthBand ?? 'gray';

  const nameDoctor = lang === 'zh' ? '结构规范 (doctor)' : 'Structure (doctor)';
  const nameEval = lang === 'zh' ? '实测得分 (eval)' : 'Test score (eval)';
  const nameObserve = lang === 'zh' ? '线上稳定 (observe)' : 'Live stability (observe)';

  return `<div class="si-stagecards">
    ${card({
      icon: '🩺', name: nameDoctor, modalId: 'modal-doctor', band: doctorBand,
      statusText: entry.doctor ? `${entry.doctor.passCount}✓ ${entry.doctor.warnCount}⚠ ${entry.doctor.failCount}✗` : (lang === 'zh' ? '未运行' : 'not run'),
      metaText: relTime(entry.doctor?.timestamp, lang),
    })}
    ${card({
      icon: '🧪', name: nameEval, modalId: 'modal-eval', band: evalBand,
      statusText: entry.eval && (entry.eval.passCount + entry.eval.failCount) > 0
        ? `${entry.eval.totalSamples} ${lang === 'zh' ? '用例' : 'samples'} · ${Math.round((entry.eval.passCount / (entry.eval.passCount + entry.eval.failCount)) * 100)}% ${lang === 'zh' ? '通过' : 'pass'}${entry.eval.compositeScore != null ? ` · ${entry.eval.compositeScore.toFixed(2)}/5` : ''}`
        : (lang === 'zh' ? '未运行' : 'not run'),
      metaText: relTime(entry.eval?.timestamp, lang),
    })}
    ${card({
      icon: '👁', name: nameObserve, modalId: 'modal-observe', band: observeBand,
      statusText: entry.observe ? `${(entry.observe.gapRate * 100).toFixed(0)}% gap · ${entry.observe.segmentCount} ${lang === 'zh' ? '段' : 'segs'}` : (lang === 'zh' ? '未运行' : 'not run'),
      metaText: relTime(entry.observe?.generatedAt, lang),
    })}
  </div>`;
}

// ────────── Modal:单条 insight 详情 ──────────

function renderIllustration(ill: InsightIllustration, lang: Lang): string {
  const row = (label: string, val: string, mono = false): string => `<div class="si-ill-row">
    <span class="si-ill-label">${e(label)}</span>
    <span class="si-ill-text${mono ? ' si-ill-text--mono' : ''}">${e(val)}</span>
  </div>`;
  const lines: string[] = [];
  if (ill.samplePrompt) lines.push(row(lang === 'zh' ? '用户 prompt' : 'prompt', ill.samplePrompt));
  if (ill.llmOutput) lines.push(row(lang === 'zh' ? 'LLM 输出' : 'output', ill.llmOutput));
  if (ill.toolCalls && ill.toolCalls.length > 0) {
    lines.push(`<div class="si-ill-row">
      <span class="si-ill-label">${lang === 'zh' ? '工具调用' : 'tool calls'}</span>
      <ul class="si-ill-tools">${ill.toolCalls.map((tc) => `<li>${e(tc)}</li>`).join('')}</ul>
    </div>`);
  }
  if (ill.failedAssertion) lines.push(row(lang === 'zh' ? '失败断言' : 'failed', ill.failedAssertion, true));
  return `<div class="si-illustration">
    <div class="si-ill-h"><code>${e(ill.sampleId)}</code></div>
    ${lines.join('')}
  </div>`;
}

function renderEvidenceBlock(ev: InsightEvidence, lang: Lang): string {
  const persp = lang === 'zh' ? PERSPECTIVE_ZH[ev.perspective] : PERSPECTIVE_EN[ev.perspective];
  const ills = ev.illustrations && ev.illustrations.length > 0
    ? `<details class="si-ev-ill"><summary>${lang === 'zh' ? '展开实际现场' : 'Show what happened'}</summary>
       <div class="si-ev-ill-body">${ev.illustrations.map((i) => renderIllustration(i, lang)).join('')}</div></details>`
    : '';
  return `<div class="si-ev si-ev--${ev.status}">
    <div class="si-ev-line">
      <span class="si-ev-icon">${STATUS_ICON[ev.status]}</span>
      <span class="si-ev-perspective">${e(persp)}</span>
      <span class="si-ev-msg">${e(ev.message)}</span>
    </div>
    ${ills}
  </div>`;
}

function renderPatchBlock(patch: InsightPatch, lang: Lang): string {
  const targetLabel = lang === 'zh' ? PATCH_TARGET_ZH[patch.target] : PATCH_TARGET_EN[patch.target];
  return `<details class="si-patch">
    <summary>${lang === 'zh' ? '📋 可粘贴片段' : '📋 Paste-ready snippet'}</summary>
    <div class="si-patch-body">
      <div class="si-patch-meta">
        <span class="si-patch-target">${e(targetLabel)}</span>
        <span class="si-patch-loc">${e(patch.location)}</span>
      </div>
      <pre class="si-patch-snippet"><code>${e(patch.snippet)}</code></pre>
    </div>
  </details>`;
}

function renderInsightModal(ins: Insight, num: number, lang: Lang): string {
  const sevIcon = SEVERITY_ICON[ins.severity];
  const sevLabel = lang === 'zh' ? SEVERITY_LABEL_ZH[ins.severity] : SEVERITY_LABEL_EN[ins.severity];
  const audInfo = lang === 'zh' ? AUDIENCE_INFO_ZH[ins.audience] : AUDIENCE_INFO_EN[ins.audience];
  return `<div id="insight-${num}" class="modal-overlay" onclick="if(event.target===this)closeModal('insight-${num}')">
    <div class="modal-content si-modal">
      <div class="modal-header">
        <div class="si-modal-h">
          <span class="si-modal-num">#${num}</span>
          <span class="si-modal-sev">${sevIcon}</span>
          <h3 class="si-modal-title">${e(ins.title)}</h3>
        </div>
        <button class="modal-close" onclick="closeModal('insight-${num}')">✕</button>
      </div>
      <div class="si-modal-tags">
        <span class="si-sev-tag si-sev-tag--${ins.severity}">${e(sevLabel)}</span>
        <span class="si-aud-tag">${audInfo.icon} ${e(audInfo.title)}</span>
        ${ins.affectedCount > 0 ? `<span class="si-modal-affect">${lang === 'zh' ? '影响' : 'affects'} ${ins.affectedCount}</span>` : ''}
      </div>
      ${ins.description ? `<p class="si-modal-desc">${e(ins.description)}</p>` : ''}
      <section class="si-evidence">
        <div class="si-evidence-h">${lang === 'zh' ? '⛳ 证据' : '⛳ Evidence'}</div>
        ${ins.evidence.map((ev) => renderEvidenceBlock(ev, lang)).join('')}
      </section>
      ${ins.recommendations.length > 0 ? `<section class="si-recs">
        <div class="si-recs-h">${lang === 'zh' ? '💡 建议' : '💡 Recommendations'}</div>
        <ul>${ins.recommendations.map((r) => `<li>
          <div class="si-rec-line">
            <span class="si-rec-pri si-rec-pri--${r.priority}">${e(lang === 'zh' ? SEVERITY_LABEL_ZH[r.priority] : SEVERITY_LABEL_EN[r.priority])}</span>
            <span class="si-rec-action">${e(r.action)}</span>
          </div>
          ${r.patch ? renderPatchBlock(r.patch, lang) : ''}
        </li>`).join('')}</ul>
      </section>` : ''}
    </div>
  </div>`;
}

// ────────── Modal:阶段全量明细 ──────────

function renderRuleResult(r: DoctorRuleResult): string {
  const icon = r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : r.status === 'fail' ? '✗' : '○';
  const cls = r.status === 'pass' ? 'pass' : r.status === 'warn' ? 'warn' : r.status === 'fail' ? 'fail' : 'gray';
  return `<li class="si-rule si-rule--${cls}">
    <span class="si-rule-icon">${icon}</span>
    <div class="si-rule-body">
      <code class="si-rule-id">${e(r.ruleId)}</code>
      <span class="si-rule-msg">${e(r.message)}</span>
      ${r.hint ? `<div class="si-rule-hint">💡 ${e(r.hint)}</div>` : ''}
    </div>
  </li>`;
}

function renderDoctorHistorySection(snap: SkillDoctorSnapshot | null, history: SkillDoctorSnapshot[], lang: Lang): string {
  const older = snap ? history.filter((h) => h.reportId !== snap.reportId) : history;
  if (older.length === 0) return '';
  return `<details class="si-history">
    <summary>${lang === 'zh' ? `📅 历史体检 ${older.length} 期` : `📅 History (${older.length})`}</summary>
    <ul class="si-history-list">
      ${[...older].reverse().map((h) => {
        const total = h.passCount + h.warnCount + h.failCount;
        const cls = h.status === 'fail' ? 'red' : h.status === 'warn' ? 'yellow' : 'green';
        return `<li><button type="button" class="si-history-row" onclick="openModal('modal-doctor-h-${e(h.reportId)}')">
          <span class="si-history-date">${fmtDateShort(h.timestamp)}</span>
          <span class="si-history-meta">${h.passCount}/${total} ✓ · ${h.warnCount} ⚠ · ${h.failCount} ✗</span>
          <span class="si-history-status si-history-status--${cls}">${e(h.status)}</span>
          <span class="si-history-arrow">›</span>
        </button></li>`;
      }).join('')}
    </ul>
  </details>`;
}

function renderDoctorHistoryModals(snap: SkillDoctorSnapshot | null, history: SkillDoctorSnapshot[], lang: Lang): string {
  const older = snap ? history.filter((h) => h.reportId !== snap.reportId) : history;
  return older.map((h) => {
    const id = `modal-doctor-h-${h.reportId}`;
    return `<div id="${e(id)}" class="modal-overlay" onclick="if(event.target===this)closeModal('${e(id)}')">
      <div class="modal-content si-modal">
        <div class="modal-header">
          <h3 class="si-modal-title">🩺 ${lang === 'zh' ? 'Doctor 历史' : 'Doctor history'} · ${fmtDateShort(h.timestamp)}</h3>
          <button class="modal-close" onclick="closeModal('${e(id)}')">✕</button>
        </div>
        <div class="si-modal-stats">${h.passCount} ✓ · ${h.warnCount} ⚠ · ${h.failCount} ✗ · ${relTime(h.timestamp, lang)}</div>
        <ul class="si-rules">${h.results.map((r) => renderRuleResult(r)).join('')}</ul>
      </div>
    </div>`;
  }).join('');
}

function renderDoctorModal(snap: SkillDoctorSnapshot | null, history: SkillDoctorSnapshot[], lang: Lang): string {
  const body = snap ? `
    <div class="si-modal-stats">${snap.passCount} ✓ · ${snap.warnCount} ⚠ · ${snap.failCount} ✗ · ${relTime(snap.timestamp, lang)}</div>
    <ul class="si-rules">${snap.results.map((r) => renderRuleResult(r)).join('')}</ul>
  ` : `<p class="si-modal-empty">${lang === 'zh' ? '运行 omk doctor 后这里会显示静态体检的所有规则结果。' : 'Run omk doctor to populate.'}</p>`;
  return `<div id="modal-doctor" class="modal-overlay" onclick="if(event.target===this)closeModal('modal-doctor')">
    <div class="modal-content si-modal">
      <div class="modal-header">
        <h3 class="si-modal-title">🩺 ${lang === 'zh' ? 'Doctor 静态体检' : 'Doctor (static check)'}</h3>
        <button class="modal-close" onclick="closeModal('modal-doctor')">✕</button>
      </div>
      <p class="si-modal-purpose">${lang === 'zh' ? '在跑评测前先做基础检查:文件能不能读、元数据齐不齐、引用的依赖在不在。' : 'Pre-eval static checks: file readable, metadata complete, dependencies declared.'}</p>
      ${body}
      ${renderDoctorHistorySection(snap, history, lang)}
    </div>
  </div>`;
}

interface FailedSampleRow { sampleId: string; modes: string[]; diagSummary: string }

function collectFailedSamples(report: EvaluationReport, variant: string): FailedSampleRow[] {
  const out: FailedSampleRow[] = [];
  for (const r of report.results) {
    const v: VariantResult | undefined = r.variants?.[variant];
    if (!v) continue;
    const passed = (v.assertions?.details ?? []).every((d) => d.passed);
    if (passed) continue;
    const isTripwire = (v.diagnostic?.rootCause ?? []).includes('tripwire_intentional')
      || report.sampleSnapshots?.[r.sample_id]?.tripwire === true;
    if (isTripwire) continue;
    out.push({
      sampleId: r.sample_id,
      modes: (v.diagnostic?.failureModes ?? []) as string[],
      diagSummary: v.diagnostic?.summary?.slice(0, 200) ?? '',
    });
  }
  return out;
}

interface SampleListRow {
  sampleId: string;
  kind: 'pass' | 'fail' | 'tripwire';
  composite: number | null;
  description: string;
}

function collectAllSamples(report: EvaluationReport, variant: string): SampleListRow[] {
  const out: SampleListRow[] = [];
  for (const r of report.results) {
    const v: VariantResult | undefined = r.variants?.[variant];
    if (!v) continue;
    const passed = (v.assertions?.details ?? []).every((d) => d.passed);
    const isTripwire = (v.diagnostic?.rootCause ?? []).includes('tripwire_intentional')
      || report.sampleSnapshots?.[r.sample_id]?.tripwire === true;
    const kind: SampleListRow['kind'] = isTripwire ? 'tripwire' : passed ? 'pass' : 'fail';
    const layered = v.layeredScores ?? {};
    const parts = [layered.factScore, layered.behaviorScore, layered.judgeScore].filter((x): x is number => x != null);
    const composite = parts.length > 0 ? parts.reduce((s, x) => s + x, 0) / parts.length : null;
    const promptSnippet = report.sampleSnapshots?.[r.sample_id]?.prompt?.slice(0, 70).replace(/\n+/g, ' ') ?? '';
    out.push({ sampleId: r.sample_id, kind, composite, description: promptSnippet });
  }
  return out;
}

function renderSampleListSection(samples: SampleListRow[], reportId: string, langQ: string, lang: Lang): string {
  const passCount = samples.filter((s) => s.kind === 'pass').length;
  const failCount = samples.filter((s) => s.kind === 'fail').length;
  const tripCount = samples.filter((s) => s.kind === 'tripwire').length;
  const summary = lang === 'zh'
    ? `${samples.length} 条 (${passCount} ✓ ${failCount} ✗${tripCount > 0 ? ` ${tripCount} ⚡` : ''})`
    : `${samples.length} (${passCount} ✓ ${failCount} ✗${tripCount > 0 ? ` ${tripCount} ⚡` : ''})`;
  const iconOf = (k: SampleListRow['kind']): string => k === 'pass' ? '✓' : k === 'tripwire' ? '⚡' : '✗';
  return `<details class="si-history" open>
    <summary>${lang === 'zh' ? `📝 全部用例 ${summary}` : `📝 All samples ${summary}`}</summary>
    <ul class="si-history-list si-sample-list">
      ${samples.map((s) => `<li><a class="si-history-row si-sample-row si-sample-row--${s.kind}" href="/reports/${e(reportId)}${langQ}#sample-${e(s.sampleId)}">
        <span class="si-sample-icon si-sample-icon--${s.kind}">${iconOf(s.kind)}</span>
        <code class="si-sample-id">${e(s.sampleId)}</code>
        <span class="si-sample-score">${s.composite != null ? s.composite.toFixed(2) + '/5' : '—'}</span>
        <span class="si-sample-desc">${e(s.description)}${s.description.length >= 70 ? '…' : ''}</span>
        <span class="si-history-arrow">›</span>
      </a></li>`).join('')}
    </ul>
  </details>`;
}

function renderEvalHistorySection(snap: SkillEvalSnapshot | null, history: SkillEvalSnapshot[], langQ: string, lang: Lang): string {
  const older = snap ? history.filter((h) => h.reportId !== snap.reportId) : history;
  if (older.length === 0) return '';
  return `<details class="si-history">
    <summary>${lang === 'zh' ? `📅 历史评测 ${older.length} 期` : `📅 History (${older.length})`}</summary>
    <ul class="si-history-list">
      ${[...older].reverse().map((h) => {
        const total = h.passCount + h.failCount;
        const pct = total > 0 ? Math.round((h.passCount / total) * 100) : 0;
        const cls = h.failCount === 0 ? 'green' : h.passCount === 0 ? 'red' : 'yellow';
        return `<li><a class="si-history-row" href="/reports/${e(h.reportId)}${langQ}">
          <span class="si-history-date">${fmtDateShort(h.timestamp)}</span>
          <span class="si-history-meta">${h.compositeScore != null ? h.compositeScore.toFixed(2) : '—'}/5 · ${pct}% ${lang === 'zh' ? '通过' : 'pass'}</span>
          <span class="si-history-status si-history-status--${cls}">${e(h.verdictLevel)}</span>
          <span class="si-history-arrow">›</span>
        </a></li>`;
      }).join('')}
    </ul>
  </details>`;
}

function renderEvalModal(snap: SkillEvalSnapshot | null, history: SkillEvalSnapshot[], evalReport: EvaluationReport | null, langQ: string, lang: Lang): string {
  if (!snap) {
    return `<div id="modal-eval" class="modal-overlay" onclick="if(event.target===this)closeModal('modal-eval')">
      <div class="modal-content si-modal">
        <div class="modal-header">
          <h3 class="si-modal-title">🧪 ${lang === 'zh' ? 'Eval 评测' : 'Eval'}</h3>
          <button class="modal-close" onclick="closeModal('modal-eval')">✕</button>
        </div>
        <p class="si-modal-empty">${lang === 'zh' ? '运行 omk eval 后这里会显示评分和失败用例明细。' : 'Run omk eval to populate.'}</p>
      </div>
    </div>`;
  }
  let layered: { factScore?: number; behaviorScore?: number; judgeScore?: number } | undefined;
  let failedSamples: FailedSampleRow[] = [];
  let allSamples: SampleListRow[] = [];
  if (evalReport && snap.variantName) {
    const factVals: number[] = [], behavVals: number[] = [], judgeVals: number[] = [];
    for (const r of evalReport.results) {
      const v = r.variants?.[snap.variantName];
      if (!v?.layeredScores) continue;
      if (v.layeredScores.factScore != null) factVals.push(v.layeredScores.factScore);
      if (v.layeredScores.behaviorScore != null) behavVals.push(v.layeredScores.behaviorScore);
      if (v.layeredScores.judgeScore != null) judgeVals.push(v.layeredScores.judgeScore);
    }
    const mean = (xs: number[]): number | undefined => xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined;
    layered = { factScore: mean(factVals), behaviorScore: mean(behavVals), judgeScore: mean(judgeVals) };
    failedSamples = collectFailedSamples(evalReport, snap.variantName);
    allSamples = collectAllSamples(evalReport, snap.variantName);
  }

  const renderLayer = (label: string, val?: number): string => {
    if (val == null) return `<div class="si-layer"><span class="si-layer-lbl">${e(label)}</span><span class="si-layer-num">—</span></div>`;
    const cls = val >= 4 ? 'pass' : val >= 3 ? 'warn' : 'fail';
    const w = Math.round((val / 5) * 100);
    return `<div class="si-layer">
      <span class="si-layer-lbl">${e(label)}</span>
      <div class="si-layer-bar"><div class="si-layer-fill si-layer-fill--${cls}" style="width:${w}%"></div></div>
      <span class="si-layer-num si-layer-num--${cls}">${val.toFixed(2)}</span>
    </div>`;
  };

  return `<div id="modal-eval" class="modal-overlay" onclick="if(event.target===this)closeModal('modal-eval')">
    <div class="modal-content si-modal">
      <div class="modal-header">
        <h3 class="si-modal-title">🧪 ${lang === 'zh' ? 'Eval 评测' : 'Eval'}</h3>
        <button class="modal-close" onclick="closeModal('modal-eval')">✕</button>
      </div>
      <p class="si-modal-purpose">${lang === 'zh' ? '用 LLM 实跑用例,既给 skill 整体打分(能否上线),也定位每条用例失败的原因。' : 'Run samples with LLM: score the skill, pinpoint why each failed.'}</p>
      <div class="si-modal-stats">${snap.passCount} ✓ · ${snap.failCount} ✗${snap.tripwireCount > 0 ? ` · ${snap.tripwireCount} ${lang === 'zh' ? '诱错' : 'tripwire'}` : ''} · ${relTime(snap.timestamp, lang)}</div>

      <div class="si-eval-block">
        <div class="si-eval-h">📊 ${lang === 'zh' ? '评分视角' : 'Score view'}</div>
        <div class="si-eval-score-row">
          <div class="si-eval-composite">${snap.compositeScore != null ? snap.compositeScore.toFixed(2) : '—'}<span class="si-eval-composite-sub">/5</span></div>
          ${snap.verdictHeadline ? `<p class="si-eval-headline">${e(snap.verdictHeadline)}</p>` : ''}
        </div>
        <div class="si-layers">
          ${renderLayer(lang === 'zh' ? '事实层' : 'fact', layered?.factScore)}
          ${renderLayer(lang === 'zh' ? '行为层' : 'behavior', layered?.behaviorScore)}
          ${renderLayer(lang === 'zh' ? 'LLM 评价' : 'judge', layered?.judgeScore)}
        </div>
        <a class="si-eval-link" href="/reports/${e(snap.reportId)}${langQ}">${lang === 'zh' ? '完整 A/B 报告 →' : 'Full A/B report →'}</a>
      </div>

      ${failedSamples.length > 0 ? `<div class="si-eval-block">
        <div class="si-eval-h">✅ ${lang === 'zh' ? '功能视角失败用例' : 'Failed samples'}</div>
        <ul class="si-failed-list">
          ${failedSamples.map((f) => `<li>
            <code class="si-fs-id">${e(f.sampleId)}</code>
            ${f.modes.map((m) => `<span class="si-fs-mode">${e(m)}</span>`).join('')}
            ${f.diagSummary ? `<div class="si-fs-summary">${e(f.diagSummary)}${f.diagSummary.length >= 200 ? '…' : ''}</div>` : ''}
          </li>`).join('')}
        </ul>
        <a class="si-eval-link" href="/reports/${e(snap.reportId)}${langQ}#test-view">${lang === 'zh' ? '展开单测视角 →' : 'Open functional view →'}</a>
      </div>` : ''}
      ${allSamples.length > 0 ? renderSampleListSection(allSamples, snap.reportId, langQ, lang) : ''}
      ${renderEvalHistorySection(snap, history, langQ, lang)}
    </div>
  </div>`;
}

function renderObserveHistorySection(snap: SkillObserveSnapshot | null, history: SkillObserveSnapshot[], langQ: string, lang: Lang): string {
  const older = snap ? history.filter((h) => h.analysisId !== snap.analysisId) : history;
  if (older.length === 0) return '';
  return `<details class="si-history">
    <summary>${lang === 'zh' ? `📅 历史观测 ${older.length} 期` : `📅 History (${older.length})`}</summary>
    <ul class="si-history-list">
      ${[...older].reverse().map((h) => `<li><a class="si-history-row" href="/analyses/${e(h.analysisId)}${langQ}">
        <span class="si-history-date">${fmtDateShort(h.generatedAt)}</span>
        <span class="si-history-meta">${h.segmentCount} ${lang === 'zh' ? '段' : 'segs'} · gap ${(h.gapRate * 100).toFixed(0)}% · fail ${(h.failureRate * 100).toFixed(1)}%</span>
        <span class="si-history-status si-history-status--${h.healthBand}">${e(h.healthBand)}</span>
        <span class="si-history-arrow">›</span>
      </a></li>`).join('')}
    </ul>
  </details>`;
}

function renderObserveModal(snap: SkillObserveSnapshot | null, history: SkillObserveSnapshot[], langQ: string, lang: Lang): string {
  const body = snap ? `
    <div class="si-modal-stats">
      ${snap.segmentCount} ${lang === 'zh' ? '段' : 'segments'} ·
      ${lang === 'zh' ? '工具失败率' : 'tool fail'} ${(snap.failureRate * 100).toFixed(1)}% ·
      ${lang === 'zh' ? '知识库 gap' : 'KB gap'} ${(snap.gapRate * 100).toFixed(0)}% ·
      ${relTime(snap.generatedAt, lang)}
    </div>
    <a class="si-eval-link" href="/analyses/${e(snap.analysisId)}${langQ}">${lang === 'zh' ? '完整观测报告 →' : 'Full observation report →'}</a>
  ` : `<p class="si-modal-empty">${lang === 'zh' ? '运行 omk observe &lt;trace-dir&gt; 后这里会显示生产健康度。' : 'Run omk observe <trace-dir> to populate.'}</p>`;
  return `<div id="modal-observe" class="modal-overlay" onclick="if(event.target===this)closeModal('modal-observe')">
    <div class="modal-content si-modal">
      <div class="modal-header">
        <h3 class="si-modal-title">👁 ${lang === 'zh' ? 'Observe 线上观测' : 'Observe (production)'}</h3>
        <button class="modal-close" onclick="closeModal('modal-observe')">✕</button>
      </div>
      <p class="si-modal-purpose">${lang === 'zh' ? '接入真实用户的使用记录,看 skill 上线后跑得稳不稳、哪些内容真的被用到了。' : 'Real-world usage: stability + coverage in production.'}</p>
      ${body}
      ${renderObserveHistorySection(snap, history, langQ, lang)}
    </div>
  </div>`;
}

// ────────── CSS ──────────

const SKILL_DETAIL_CSS = `
.si-back { display:inline-block;margin-bottom:8px;color:var(--text-muted);font-size:13px;text-decoration:none }
.si-back:hover { color:var(--text-primary) }

/* Hero — grade 卡 + 信息块,grid 布局让 grade 卡固定宽度 */
.si-hero { display:grid;grid-template-columns:auto 1fr auto;gap:18px;align-items:center;padding:14px 18px;background:var(--bg-surface);border-radius:8px;box-shadow:var(--shadow-sm);margin:8px 0 14px }
@media(max-width:640px){ .si-hero { grid-template-columns:auto 1fr;gap:12px } .si-hero-meta { grid-column:1/-1;text-align:right } }

/* 健康等级卡 — 左侧色卡,emoji + 等级 + 参考分纵向堆叠 */
.si-hero-grade { display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:96px;padding:10px 14px;border-radius:8px;background:var(--bg-soft);border-left:4px solid var(--border) }
.si-hero-grade--green { border-left-color:#5e8252;background:rgba(94,130,82,.08) }
.si-hero-grade--yellow { border-left-color:#b08030;background:rgba(176,128,48,.08) }
.si-hero-grade--red { border-left-color:#9c4a3f;background:rgba(156,74,63,.08) }
.si-hero-grade--gray { border-left-color:var(--border);background:var(--bg-soft) }
.si-hero-grade-emoji { font-size:20px;line-height:1 }
.si-hero-grade-label { font-size:13px;font-weight:600;color:var(--text-primary);letter-spacing:0.02em }
.si-hero-score { font-variant-numeric:tabular-nums;cursor:help;display:flex;align-items:baseline;gap:1px;margin-top:1px }
.si-hero-score-num { font-size:22px;font-weight:700;line-height:1 }
.si-hero-grade--green  .si-hero-score-num { color:#5e8252 }
.si-hero-grade--yellow .si-hero-score-num { color:#b08030 }
.si-hero-grade--red    .si-hero-score-num { color:#9c4a3f }
.si-hero-grade--gray   .si-hero-score-num { color:var(--text-muted) }
.si-hero-score-unit { font-size:11px;color:var(--text-muted);font-weight:500 }
.si-hero-score--empty { font-size:18px;color:var(--text-muted) }

.si-hero-info { display:flex;flex-direction:column;gap:4px;min-width:0 }
.si-hero-name { font-size:20px;font-weight:600;color:var(--text-primary);line-height:1.3 }
.si-hero-summary { color:var(--text-secondary);font-size:13px;line-height:1.5 }
.si-hero-meta { color:var(--text-muted);font-size:12px;font-variant-numeric:tabular-nums;align-self:center }

/* 主网格:左 6/12 右 6/12,移动端单列 */
.si-grid { display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start }
@media(max-width:880px){ .si-grid { grid-template-columns:1fr } }

/* 左栏:问题列表 */
.si-list { background:var(--bg-surface);border-radius:8px;padding:12px 14px;box-shadow:var(--shadow-sm) }

/* 空态 — 不喊"恭喜",用已有数据证明它健康 + 给可补充的下一步,有视觉重量 */
.si-empty { display:flex;flex-direction:column;gap:14px;padding:6px 4px }
.si-empty-h { display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(94,130,82,.08);border-left:3px solid #5e8252;border-radius:6px }
.si-empty-emoji { font-size:22px;line-height:1 }
.si-empty-title { font-size:14px;font-weight:600;color:var(--text-primary) }
.si-empty-section-h { font-size:11.5px;font-weight:600;color:var(--text-muted);letter-spacing:0.04em;margin-bottom:6px;text-transform:uppercase }
.si-empty-list { margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px }
.si-empty-list li { display:grid;grid-template-columns:18px 1fr;gap:8px;align-items:start;font-size:13px;line-height:1.55;color:var(--text-primary) }
.si-empty-list code { background:var(--bg-soft);padding:1px 6px;border-radius:3px;font-family:"SF Mono",Menlo,monospace;font-size:11.5px;color:var(--text-primary) }
.si-empty-icon { font-weight:700;text-align:center }
.si-empty-list--pass .si-empty-icon { color:#5e8252 }
.si-empty-list--next .si-empty-icon { color:var(--accent) }
.si-aud { margin-bottom:12px }
.si-aud:last-child { margin-bottom:0 }
.si-aud-h { display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--bg-soft);border-radius:5px;margin-bottom:6px }
.si-aud-icon { font-size:14px }
.si-aud-title { font-size:13px;font-weight:600;color:var(--text-primary) }
.si-aud-count { padding:1px 7px;border-radius:9px;background:var(--bg-surface);font-size:11px;color:var(--text-secondary);font-weight:600 }
.si-aud-sub { color:var(--text-muted);font-size:11px;margin-left:auto }
.si-aud-rows { display:flex;flex-direction:column;gap:3px }

.si-row { all:unset;cursor:pointer;display:grid;grid-template-columns:auto auto 1fr auto auto;gap:8px;align-items:center;padding:8px 10px;border-radius:5px;border:1px solid transparent;transition:border-color .12s,background .12s;text-align:left }
.si-row:hover { border-color:var(--border-hover);background:var(--bg-soft) }
.si-row:focus-visible { outline:2px solid var(--accent);outline-offset:1px }
.si-row-num { font-size:11px;font-weight:700;color:var(--text-muted);font-variant-numeric:tabular-nums;background:var(--bg-soft);padding:1px 6px;border-radius:3px;min-width:28px;text-align:center }
.si-row-sev { font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:8px;letter-spacing:0.02em }
.si-row-sev--high { background:rgba(156,74,63,.16);color:#9c4a3f }
.si-row-sev--medium { background:rgba(176,128,48,.14);color:#b08030 }
.si-row-sev--low { background:rgba(94,130,82,.16);color:#5e8252 }
.si-row-title { font-size:13.5px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
.si-row-meta { font-size:11px;color:var(--text-muted);font-variant-numeric:tabular-nums }
.si-row-arrow { color:var(--text-muted);font-size:14px;font-weight:300 }
.si-row--high { border-left:3px solid #9c4a3f;padding-left:7px }

/* 右栏 */
.si-right { display:flex;flex-direction:column;gap:12px }
.si-trend { background:var(--bg-surface);border-radius:8px;padding:14px 16px;box-shadow:var(--shadow-sm) }
.si-trend-h { display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px }
.si-trend-empty { padding:24px;text-align:center;color:var(--text-muted);font-size:13px }
/* chart.js responsive 要求父容器有确定的高度,否则 canvas 会无限拉高(每次 resize 让父元素变大,触发新 resize)。
   用 position:relative + 固定 height,让 canvas 在内部以 absolute 填充。 */
.si-trend-canvas-wrap { position:relative;width:100%;height:240px }
.si-trend-canvas-wrap > canvas { position:absolute;left:0;top:0;width:100% !important;height:100% !important }
.si-trend-hint { font-size:10.5px;color:var(--text-muted);text-align:center;margin-top:6px;font-style:italic }

/* 三视角当前状态区:跟趋势图区域并列,加标题让用户一眼知道这是"当前快照速览" */
.si-stages-block { background:var(--bg-surface);border-radius:8px;padding:12px 14px;box-shadow:var(--shadow-sm) }
.si-stages-h { display:flex;flex-direction:column;gap:1px;margin-bottom:10px }
.si-stages-title { font-size:13px;font-weight:600;color:var(--text-primary) }
.si-stages-sub { font-size:11px;color:var(--text-muted);font-style:italic }
.si-stagecards { display:flex;flex-direction:column;gap:8px }
.si-stages-block .si-stagecard { box-shadow:none;background:var(--bg-soft) }
.si-stages-block .si-stagecard:hover { box-shadow:var(--shadow-sm) }
.si-stagecard { all:unset;cursor:pointer;display:grid;grid-template-columns:32px 1fr auto auto;gap:10px;align-items:center;padding:10px 14px;background:var(--bg-surface);border-radius:7px;box-shadow:var(--shadow-sm);transition:transform .12s,box-shadow .12s;border-left:4px solid var(--border) }
.si-stagecard:hover { transform:translateX(2px);box-shadow:var(--shadow-md) }
.si-stagecard:focus-visible { outline:2px solid var(--accent);outline-offset:1px }
.si-stagecard--green   { border-left-color:#5e8252 }
.si-stagecard--yellow  { border-left-color:#b08030 }
.si-stagecard--red     { border-left-color:#9c4a3f }
.si-stagecard--gray    { border-left-color:var(--border) }
.si-stagecard-icon { font-size:22px;line-height:1 }
.si-stagecard-body { display:flex;flex-direction:column;gap:2px }
.si-stagecard-name { font-size:14px;font-weight:600;color:var(--text-primary) }
.si-stagecard-status { font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums }
.si-stagecard-meta { font-size:11px;color:var(--text-muted);font-variant-numeric:tabular-nums }
.si-stagecard-arrow { color:var(--text-muted);font-size:16px;font-weight:300 }

/* Modal 内的样式(沿用 modal-overlay/modal-content,只补本页特有的)*/
.si-modal { max-width:760px;width:90% }
.si-modal-h { display:flex;align-items:center;gap:10px;flex-wrap:wrap }
.si-modal-num { font-size:12px;font-weight:700;color:var(--text-muted);background:var(--bg-soft);padding:2px 8px;border-radius:4px }
.si-modal-sev { font-size:18px }
.si-modal-title { margin:0;font-size:17px;font-weight:600;color:var(--text-primary) }
.si-modal-tags { display:flex;gap:8px;align-items:center;margin:6px 0 10px;flex-wrap:wrap }
.si-modal-affect { font-size:11.5px;color:var(--text-muted) }
.si-aud-tag { font-size:11.5px;color:var(--text-secondary);background:var(--bg-soft);padding:2px 8px;border-radius:8px }
.si-modal-desc { color:var(--text-secondary);font-size:13px;line-height:1.6;margin:0 0 14px }
.si-modal-purpose { color:var(--text-secondary);font-size:13px;line-height:1.6;margin:6px 0 12px;font-style:italic }
.si-modal-stats { color:var(--text-secondary);font-size:13px;margin-bottom:14px;padding:8px 12px;background:var(--bg-soft);border-radius:5px;font-variant-numeric:tabular-nums }
.si-modal-empty { color:var(--text-muted);font-size:13px;padding:18px;text-align:center;font-style:italic }

.si-sev-tag { padding:2px 9px;border-radius:11px;font-size:11px;font-weight:600 }
.si-sev-tag--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-sev-tag--medium { background:rgba(176,128,48,.12);color:#b08030 }
.si-sev-tag--low { background:rgba(94,130,82,.14);color:#5e8252 }

/* 证据 */
.si-evidence { background:var(--bg-soft);padding:10px 12px;border-radius:6px;margin-bottom:12px }
.si-evidence-h { font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px }
.si-ev { padding:4px 0;font-size:13px;line-height:1.55 }
.si-ev-line { display:grid;grid-template-columns:24px 100px 1fr;gap:10px;align-items:start }
.si-ev-icon { text-align:center;font-weight:600 }
.si-ev--flagged .si-ev-icon { color:#9c4a3f }
.si-ev--blind .si-ev-icon { color:#7a6b89 }
.si-ev--silent .si-ev-icon { color:#7a9270 }
.si-ev--na .si-ev-icon { color:var(--text-muted) }
.si-ev-perspective { color:var(--text-secondary);font-weight:500 }
.si-ev-msg { color:var(--text-primary) }
.si-ev-ill { margin-top:4px;margin-left:34px }
.si-ev-ill > summary { cursor:pointer;font-size:11.5px;color:var(--accent);list-style:none;padding:2px 0 }
.si-ev-ill > summary::-webkit-details-marker { display:none }
.si-ev-ill > summary::before { content:'▸ ';color:var(--text-muted) }
.si-ev-ill[open] > summary::before { content:'▾ ' }
.si-ev-ill-body { padding:6px 0;display:flex;flex-direction:column;gap:8px }
.si-illustration { background:var(--bg-surface);border-left:2px solid var(--border);padding:6px 10px;border-radius:4px;font-size:11.5px }
.si-ill-h { margin-bottom:4px }
.si-ill-h code { background:var(--bg-soft);padding:1px 5px;border-radius:3px;font-size:11px }
.si-ill-row { display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:start;margin-bottom:3px }
.si-ill-label { color:var(--text-muted);font-size:10.5px;font-weight:500 }
.si-ill-text { color:var(--text-primary);font-size:11.5px;background:var(--bg-soft);padding:3px 6px;border-radius:3px;white-space:pre-wrap;word-break:break-word }
.si-ill-text--mono { font-family:"SF Mono",Menlo,monospace;background:rgba(156,74,63,.10);color:#9c4a3f }
.si-ill-tools { margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:2px }
.si-ill-tools li { font-family:"SF Mono",Menlo,monospace;font-size:10.5px;background:var(--bg-soft);padding:2px 5px;border-radius:3px }

/* 推荐 */
.si-recs ul { margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px }
.si-recs li { font-size:13px;line-height:1.55 }
.si-rec-line { display:flex;gap:8px;align-items:flex-start }
.si-rec-pri { padding:1px 7px;border-radius:8px;font-size:10.5px;font-weight:600;flex-shrink:0;margin-top:1px }
.si-rec-pri--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-rec-pri--medium { background:rgba(176,128,48,.12);color:#b08030 }
.si-rec-pri--low { background:rgba(94,130,82,.14);color:#5e8252 }
.si-rec-action { color:var(--text-primary);flex:1 }
.si-recs-h { font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;margin-top:0 }
.si-patch { margin-top:6px;margin-left:24px }
.si-patch > summary { cursor:pointer;font-size:11.5px;color:var(--accent);list-style:none;padding:2px 0 }
.si-patch > summary::-webkit-details-marker { display:none }
.si-patch > summary::before { content:'▸ ';color:var(--text-muted) }
.si-patch[open] > summary::before { content:'▾ ' }
.si-patch-body { padding:6px 0 }
.si-patch-meta { display:flex;gap:8px;margin-bottom:6px;font-size:11px;color:var(--text-muted);align-items:center }
.si-patch-target { font-weight:600;color:var(--text-secondary) }
.si-patch-loc { font-family:"SF Mono",Menlo,monospace }
.si-patch-snippet { background:var(--bg-soft);padding:10px 12px;border-radius:4px;border-left:2px solid var(--accent);font-size:11.5px;line-height:1.55;overflow-x:auto;margin:0 }
.si-patch-snippet code { font-family:"SF Mono",Menlo,monospace;color:var(--text-primary);white-space:pre;display:block }

/* Modal 内的 doctor rule list */
.si-rules { list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px }
.si-rule { display:flex;gap:10px;font-size:13px;line-height:1.55;align-items:flex-start;padding:8px 10px;border-radius:4px }
.si-rule--warn { background:rgba(176,128,48,.07) }
.si-rule--fail { background:rgba(156,74,63,.08) }
.si-rule-icon { flex-shrink:0;font-weight:700;width:16px;text-align:center;font-size:14px }
.si-rule--pass .si-rule-icon { color:#5e8252 }
.si-rule--warn .si-rule-icon { color:#b08030 }
.si-rule--fail .si-rule-icon { color:#9c4a3f }
.si-rule-body { flex:1;min-width:0 }
.si-rule-id { font-size:11px;color:var(--text-muted);background:var(--bg-soft);padding:1px 5px;border-radius:3px;margin-right:6px }
.si-rule-msg { color:var(--text-primary) }
.si-rule-hint { font-size:12px;color:var(--text-secondary);margin-top:3px;line-height:1.55 }

/* Sample list (eval modal — 全部用例清单)。复用 si-history-row 大部分样式,只重写 grid */
.si-sample-list { max-height:340px;overflow-y:auto }
.si-sample-row { grid-template-columns:18px 100px 56px 1fr auto !important;gap:8px !important }
.si-sample-row--pass { background:rgba(94,130,82,.06) }
.si-sample-row--fail { background:rgba(156,74,63,.06);border-left:2px solid #9c4a3f }
.si-sample-row--tripwire { background:rgba(122,107,137,.06);border-left:2px solid #7a6b89 }
.si-sample-icon { font-weight:700;text-align:center;font-size:13px }
.si-sample-icon--pass { color:#5e8252 }
.si-sample-icon--fail { color:#9c4a3f }
.si-sample-icon--tripwire { color:#7a6b89 }
.si-sample-id { font-size:11px;color:var(--text-secondary);background:transparent;padding:0;font-family:"SF Mono",Menlo,monospace;font-weight:600 }
.si-sample-score { font-variant-numeric:tabular-nums;font-size:12px;color:var(--text-secondary);font-weight:600;text-align:right }
.si-sample-desc { color:var(--text-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0 }
@media(max-width:640px){
  .si-sample-row { grid-template-columns:18px 1fr auto !important }
  .si-sample-id { grid-column:2/3 }
  .si-sample-score, .si-sample-desc { display:none }
}

/* History section in stage modals */
.si-history { margin-top:14px;border-top:1px solid var(--border);padding-top:10px }
.si-history > summary { cursor:pointer;list-style:none;padding:6px 4px;font-size:12.5px;font-weight:600;color:var(--text-secondary);user-select:none;display:flex;align-items:center;gap:6px }
.si-history > summary::-webkit-details-marker { display:none }
.si-history > summary::before { content:'▸ ';color:var(--text-muted);font-size:11px }
.si-history[open] > summary::before { content:'▾ ' }
.si-history > summary:hover { color:var(--text-primary) }
.si-history-list { margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px }
.si-history-list li { padding:0;background:transparent }
/* 整行可点击:eval/observe 用 <a>,doctor 历史用 <button>(走 inline modal),样式完全一致 */
.si-history-row { all:unset;cursor:pointer;display:grid;grid-template-columns:64px 1fr auto auto;gap:10px;align-items:center;padding:7px 10px;background:var(--bg-soft);border-radius:5px;font-size:12.5px;line-height:1.45;transition:background .12s,transform .12s;text-align:left;width:100%;box-sizing:border-box;color:var(--text-primary) }
.si-history-row:hover { background:var(--bg-elevated);transform:translateX(2px) }
.si-history-row:focus-visible { outline:2px solid var(--accent);outline-offset:1px }
.si-history-date { font-variant-numeric:tabular-nums;font-weight:600;color:var(--text-secondary) }
.si-history-meta { color:var(--text-secondary);font-variant-numeric:tabular-nums }
.si-history-status { font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:8px;letter-spacing:0.02em;justify-self:end }
.si-history-status--green { background:rgba(94,130,82,.18);color:#5e8252 }
.si-history-status--yellow { background:rgba(176,128,48,.16);color:#b08030 }
.si-history-status--red { background:rgba(156,74,63,.18);color:#9c4a3f }
.si-history-arrow { color:var(--text-muted);font-size:14px;font-weight:300 }
@media(max-width:640px){
  .si-history-row { grid-template-columns:56px 1fr auto;gap:6px }
  .si-history-arrow { display:none }
}

/* Eval modal blocks */
.si-eval-block { background:var(--bg-soft);padding:12px 14px;border-radius:6px;margin-bottom:12px }
.si-eval-block:last-child { margin-bottom:0 }
.si-eval-h { margin:0 0 10px;font-size:13px;font-weight:600;color:var(--text-primary) }
.si-eval-score-row { display:flex;gap:14px;align-items:flex-end;margin-bottom:10px }
.si-eval-composite { font-size:30px;font-weight:700;color:var(--text-primary);font-variant-numeric:tabular-nums;line-height:1 }
.si-eval-composite-sub { font-size:11.5px;color:var(--text-muted);margin-left:4px;font-weight:normal }
.si-eval-headline { color:var(--text-secondary);font-size:12.5px;line-height:1.5;margin:0;font-style:italic }
.si-layers { display:flex;flex-direction:column;gap:5px;margin-bottom:8px }
.si-layer { display:grid;grid-template-columns:80px 1fr 50px;gap:10px;align-items:center;font-size:12.5px }
.si-layer-lbl { color:var(--text-secondary) }
.si-layer-bar { background:var(--bg-surface);border-radius:4px;height:8px;overflow:hidden }
.si-layer-fill { height:100%;border-radius:4px }
.si-layer-fill--pass { background:#5e8252 }
.si-layer-fill--warn { background:#b08030 }
.si-layer-fill--fail { background:#9c4a3f }
.si-layer-num { font-variant-numeric:tabular-nums;font-weight:600;text-align:right;font-size:12px }
.si-layer-num--pass { color:#5e8252 }
.si-layer-num--warn { color:#b08030 }
.si-layer-num--fail { color:#9c4a3f }
.si-eval-link { display:inline-block;color:var(--accent);font-size:12.5px;text-decoration:none;font-weight:500 }
.si-eval-link:hover { text-decoration:underline }
.si-failed-list { margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px }
.si-failed-list li { font-size:12.5px;line-height:1.55;display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding:8px 10px;border-radius:4px;background:rgba(156,74,63,.06);border-left:2px solid #9c4a3f }
.si-fs-id { font-size:11px;background:var(--bg-surface);padding:1px 5px;border-radius:3px;color:#9c4a3f;font-weight:600 }
.si-fs-mode { font-size:10.5px;color:#b08030;background:rgba(176,128,48,.14);padding:1px 6px;border-radius:8px;font-weight:500 }
.si-fs-summary { color:var(--text-secondary);font-size:12px;flex-basis:100% }
`;

// ────────── chart.js init script ──────────

const TREND_INIT_SCRIPT = `
<script src="/static/chart.js"></script>
<script>
(function(){
  function init(){
    var canvas = document.getElementById('trend-chart');
    if (!canvas || !window.Chart) return;
    var raw = canvas.getAttribute('data-chart');
    var rawLinks = canvas.getAttribute('data-links');
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      var links = rawLinks ? JSON.parse(rawLinks) : null;
      new Chart(canvas, {
        type: 'line',
        data: data,
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 }, color: '#7a7a7a' } },
            tooltip: { callbacks: {
              label: function(ctx){ return ctx.dataset.label + ': ' + (ctx.parsed.y == null ? '—' : ctx.parsed.y.toFixed(1) + '%'); },
              afterLabel: function(ctx){
                var hint = ctx.dataset._hint || '';
                var lines = hint ? [hint] : [];
                if (links) {
                  var url = links[ctx.datasetIndex] && links[ctx.datasetIndex][ctx.dataIndex];
                  if (url) lines.push('→ 点击看那期报告');
                }
                return lines;
              }
            } }
          },
          scales: {
            y: { min: 0, max: 100, ticks: { callback: function(v){ return v + '%'; }, color: '#a8a8a8', font: { size: 10 } }, grid: { color: 'rgba(58,58,58,.06)' } },
            x: { ticks: { color: '#a8a8a8', font: { size: 10 } }, grid: { display: false } }
          },
          elements: { point: { radius: 3, hoverRadius: 5 } },
          onClick: function(_evt, elements){
            if (!links || !elements || elements.length === 0) return;
            var el = elements[0];
            var url = links[el.datasetIndex] && links[el.datasetIndex][el.index];
            if (url) window.location.href = url;
          },
          onHover: function(evt, elements){
            if (!links) return;
            var any = elements && elements.some(function(el){ return links[el.datasetIndex] && links[el.datasetIndex][el.index]; });
            evt.native.target.style.cursor = any ? 'pointer' : 'default';
          }
        }
      });
    } catch(e) { console.warn('trend chart init failed:', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
</script>`;

// ────────── 主入口 ──────────

export function renderSkillDetail(
  entry: SkillIndexEntry,
  evalReport: EvaluationReport | null,
  lang: Lang = DEFAULT_LANG,
): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const insights = detectInsights(entry, evalReport);
  const idx = buildInsightIndex(insights);
  const reportCount = [entry.doctor, entry.eval, entry.observe].filter(Boolean).length;
  const lastTs = [entry.doctor?.timestamp, entry.eval?.timestamp, entry.observe?.generatedAt]
    .filter((s): s is string => Boolean(s)).sort().pop();

  const insightModals = insights.map((ins) => renderInsightModal(ins, idx.byInsightId.get(ins.id) ?? 0, lang)).join('');

  return layout(entry.skillName, `
    <main>
      <a class="si-back" href="/${langQ}">${lang === 'zh' ? '← 返回 Skills' : '← Back to Skills'}</a>
      ${renderHero(entry, insights, lastTs, reportCount, lang)}

      <div class="si-grid">
        <section class="si-list" aria-label="${lang === 'zh' ? '问题列表' : 'Issues'}">
          ${renderInsightList(insights, idx, entry, lang)}
        </section>
        <section class="si-right">
          <div class="si-trend">
            <div class="si-trend-h">📈 ${lang === 'zh' ? '健康趋势(0-100%,越高越好)' : 'Health trend (0-100%, higher is better)'}</div>
            ${renderTrendChart(entry, langQ, lang)}
          </div>
          <div class="si-stages-block">
            <div class="si-stages-h">
              <span class="si-stages-title">🔍 ${lang === 'zh' ? '三视角当前状态' : 'Current state by perspective'}</span>
              <span class="si-stages-sub">${lang === 'zh' ? '最新一份的速览,点击看完整数据' : 'Latest snapshot — click for full details'}</span>
            </div>
            ${renderStageCards(entry, lang)}
          </div>
        </section>
      </div>

      ${insightModals}
      ${renderDoctorModal(entry.doctor, entry.doctorHistory, lang)}
      ${renderDoctorHistoryModals(entry.doctor, entry.doctorHistory, lang)}
      ${renderEvalModal(entry.eval, entry.evalHistory, evalReport, langQ, lang)}
      ${renderObserveModal(entry.observe, entry.observeHistory, langQ, lang)}
    </main>
    <style>${SKILL_DETAIL_CSS}</style>
    ${TREND_INIT_SCRIPT}
  `, lang);
}
