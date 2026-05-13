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
import type { Lang, EvaluationReport } from '../types/index.js';
import type { SkillIndexEntry, SkillDoctorSnapshot, SkillEvalSnapshot, SkillObserveSnapshot } from '../server/skill-index.js';
import type { Insight, InsightIllustration } from '../server/skill-insights.js';
import type { DoctorRuleResult } from '../types/doctor.js';

const BAND_DOT: Record<'green' | 'yellow' | 'red' | 'gray', string> = {
  green: '🟢', yellow: '🟡', red: '🔴', gray: '⚪',
};

// v6 之前的 insight × audience × 三视角 抽象在 v7 详情页砍掉了,只保留 sample 维度
// (renderEvalSection 直接读 evalReport.results,不再走 detectInsights / audience 分组)。
// 相关常量(SEVERITY_ICON / AUDIENCE_INFO_* / PATCH_TARGET_*)等以后做诊断 / 调试 UI
// 需要时再恢复。


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
    || (entry.eval != null && entry.eval.failCount > 0)
    || (entry.observe != null && entry.observe.healthBand === 'red');
  const hasWarn = (entry.doctor != null && entry.doctor.warnCount > 0)
    || (entry.eval != null && entry.eval.compositeScore != null && entry.eval.compositeScore < 3.5)
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

function renderHealthSummary(entry: SkillIndexEntry, _insights: Insight[], lang: Lang): string {
  // v7:不再依赖 insights(那是上层 detector 抽象),直接基于 entry 实际告警状态拼摘要。
  const issues: string[] = [];
  if (entry.doctor) {
    if (entry.doctor.failCount > 0) issues.push(lang === 'zh' ? `doctor ${entry.doctor.failCount} 项不通过` : `doctor ${entry.doctor.failCount} fail`);
    else if (entry.doctor.warnCount > 0) issues.push(lang === 'zh' ? `doctor ${entry.doctor.warnCount} 项告警` : `doctor ${entry.doctor.warnCount} warn`);
  }
  if (entry.eval) {
    const total = entry.eval.passCount + entry.eval.failCount;
    if (total > 0) {
      const pct = Math.round((entry.eval.passCount / total) * 100);
      if (entry.eval.failCount > 0) issues.push(lang === 'zh' ? `eval 通过率 ${pct}%(${entry.eval.failCount} 条挂)` : `eval ${pct}% pass (${entry.eval.failCount} fail)`);
    }
  }
  if (entry.observe && entry.observe.healthBand !== 'green') {
    issues.push(lang === 'zh' ? `observe ${BAND_DOT[entry.observe.healthBand]}` : `observe ${BAND_DOT[entry.observe.healthBand]}`);
  }

  if (issues.length === 0) {
    const ran = [entry.doctor, entry.eval, entry.observe].filter(Boolean).length;
    if (ran === 0) return lang === 'zh' ? '尚未运行任何检查' : 'No checks run yet';
    return lang === 'zh' ? '✅ 三视角全绿,无告警' : '✅ All three views green';
  }
  return issues.join('，');
}

// ────────── 左栏:问题列表 ──────────

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
  const labelDoctor = lang === 'zh' ? '🩺 健康度' : '🩺 Structure';
  const labelEval = lang === 'zh' ? '🧪 评测结果' : '🧪 Test score';
  const labelObserve = lang === 'zh' ? '👁 线上观测' : '👁 Live stability';

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
  </div>`;
}


// ────────── Modal:单条 insight 详情(v6 sample 视角)──────────

interface FailedSampleDetail {
  sampleId: string;
  diagnosticSummary: string;
  /** 用户给 LLM 的 prompt(从 sampleSnapshots 取,modal 直接展示给用户看"考的啥") */
  prompt: string;
  /** rubric / assertion 期望的具体行为(diagnostic LLM 写的一段). */
  expected: string;
  /** LLM 实际做了什么(diagnostic LLM 写的一段). */
  actual: string;
  /** per-sample 建议(diagnostic LLM 针对这一条 sample 写的具体改法,不是 detector 通用模板) */
  suggestionSkill: string;
  suggestionSample: string;
  failureModes: string[];
  illustration: InsightIllustration | null;
}

/** 给一个 insight,从 stageRefs.evalSampleIds + evalReport 拿完整的失败样本详情。
 *  illustration 是 detector 挑出的(最多 2 条)代表性样本,带 prompt/output/工具调用;
 *  diagnostic.expected / actual 是诊断 LLM 写的"期望 vs 实际"对照,用户最想看的。 */
function renderSampleBody(s: FailedSampleDetail, lang: Lang): string {
  const block = (icon: string, label: string, text: string, cls = ''): string => {
    if (!text || !text.trim()) return '';
    return `<div class="si-sb-block si-sb-block--${cls}">
      <div class="si-sb-label">${icon} ${e(label)}</div>
      <div class="si-sb-text">${e(text)}</div>
    </div>`;
  };
  // 拼 suggestion:skill / sample 两段都可能空,只显示有的。
  // diagnostic LLM 偶尔会输出截断的垃圾(如单字"在"),用最小长度 8 字符过滤。
  const isMeaningful = (text: string): boolean => text.trim().length >= 8;
  const sugParts: string[] = [];
  if (isMeaningful(s.suggestionSkill)) {
    sugParts.push(`<div class="si-sb-sugrow"><span class="si-sb-sugtag">改 SKILL.md</span><span>${e(s.suggestionSkill)}</span></div>`);
  }
  if (isMeaningful(s.suggestionSample)) {
    sugParts.push(`<div class="si-sb-sugrow"><span class="si-sb-sugtag">改 sample</span><span>${e(s.suggestionSample)}</span></div>`);
  }
  const suggestionBlock = sugParts.length > 0
    ? `<div class="si-sb-block si-sb-block--suggest">
        <div class="si-sb-label">💡 ${lang === 'zh' ? '建议(针对这条样本)' : 'Suggestion (per-sample)'}</div>
        <div class="si-sb-text">${sugParts.join('')}</div>
      </div>`
    : `<div class="si-sb-block si-sb-block--suggest si-sb-block--empty">
        <div class="si-sb-label">💡 ${lang === 'zh' ? '建议(针对这条样本)' : 'Suggestion (per-sample)'}</div>
        <div class="si-sb-text si-sb-empty">${lang === 'zh' ? '诊断 LLM 没给出针对这条样本的建议(可能输出截断或样本本身是诱错样本,无需改动)' : 'Diagnostic LLM did not return a per-sample suggestion'}</div>
      </div>`;
  return `<div class="si-sb">
    ${block('📝', lang === 'zh' ? '用例 prompt' : 'Prompt', s.prompt, 'prompt')}
    ${block('🎯', lang === 'zh' ? '期望' : 'Expected', s.expected, 'expected')}
    ${block('⚠️', lang === 'zh' ? '实际' : 'Actual', s.actual, 'actual')}
    ${suggestionBlock}
  </div>`;
}

/** 失败用例 section v6:默认全折叠,每条 summary 完整展示一行;
 *  点开看 prompt / 期望 / 实际 / per-sample 建议 */
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
.si-trend-empty { padding:24px;text-align:center;color:var(--text-muted);font-size:13px;display:flex;align-items:center;justify-content:center;min-height:200px }
/* chart.js responsive 要求父容器有确定的高度,否则 canvas 会无限拉高(每次 resize 让父元素变大,触发新 resize)。
   用 position:relative + 固定 height,让 canvas 在内部以 absolute 填充。 */
.si-trend-canvas-wrap { position:relative;width:100%;height:200px }
.si-trend-canvas-wrap > canvas { position:absolute;left:0;top:0;width:100% !important;height:100% !important }
.si-trend-hint { font-size:10.5px;color:var(--text-muted);text-align:center;margin-top:6px;font-style:italic }
.si-trend-fallback { position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:var(--bg-soft);border-radius:6px;padding:14px;text-align:center }
.si-trend-fallback-icon { font-size:24px;line-height:1 }
.si-trend-fallback-msg { font-size:13px;font-weight:600;color:#9c4a3f }
.si-trend-fallback-hint { font-size:11px;color:var(--text-muted);max-width:80% }

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

/* ── Insight modal v4:极简 — 只展示问题 + 解决 ──────────
 * 顺序:title + desc(问题) → 失败用例(具体哪些用例 + 错因) → 怎么改(建议 + patch)
 * 删:严重度 tag / audience tag / 影响数 / 主推动作卡 / 三视角折叠
 * 第一条 recommendation 加 ⭐ 推荐标记
 */

/* 失败用例 section(sample 视角主信息)*/
.si-failures { margin:14px 0;padding:12px 14px;background:var(--bg-soft);border-radius:6px }
.si-failures-h { font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:10px }
.si-failure-item { background:rgba(156,74,63,.04);border-radius:5px;margin-bottom:8px;border-left:3px solid #9c4a3f }
.si-failure-item:last-child { margin-bottom:0 }
/* 两行布局:第一行 id + tags + 右对齐 trace;第二行 summary 独占 */
.si-failure-head { display:flex;flex-direction:column;gap:6px;padding:10px 12px;cursor:default }
details.si-failure-item > summary.si-failure-head { cursor:pointer;list-style:none;user-select:none }
details.si-failure-item > summary.si-failure-head::-webkit-details-marker { display:none }
.si-failure-row1 { display:flex;align-items:center;gap:8px;flex-wrap:wrap }
.si-failure-row1::before { content:'▸ ';color:var(--text-muted);font-size:11px;margin-right:-4px }
details.si-failure-item[open] > summary > .si-failure-row1::before { content:'▾ ' }
.si-failure-row2 { font-size:14px;color:var(--text-secondary);line-height:1.55;padding-left:16px;white-space:pre-wrap;word-break:break-word }
.si-failure-spacer { flex:1 }
.si-failure-id { font-size:12.5px;font-weight:600;color:#9c4a3f;background:var(--bg-soft);padding:2px 8px;border-radius:3px;font-family:"SF Mono",Menlo,monospace }
.si-failure-modes { display:flex;gap:4px;flex-wrap:wrap }
.si-failure-mode { font-size:12px;color:#b08030;background:rgba(176,128,48,.14);padding:2px 8px;border-radius:8px;font-weight:500;white-space:nowrap }
.si-failure-trace { font-size:12px;color:var(--accent);text-decoration:none;font-weight:500;white-space:nowrap }
.si-failure-trace:hover { text-decoration:underline }

/* 通过 / 诱错 sample 紧凑行 */
.si-pass-item { display:flex;gap:10px;align-items:center;padding:5px 8px;border-radius:4px;font-size:14px;line-height:1.5 }
.si-pass-item:hover { background:var(--bg-soft) }
.si-pass-card { background:var(--bg-surface);border-radius:5px;margin-bottom:6px;border-left:3px solid #5e8252 }
.si-pass-card > summary { list-style:none;cursor:pointer;user-select:none }
.si-pass-card > summary::-webkit-details-marker { display:none }
.si-pass-head { display:flex;flex-direction:column;gap:4px;padding:8px 12px }
.si-pass-row1 { display:flex;align-items:center;gap:8px;flex-wrap:wrap }
.si-pass-row1::before { content:'▸ ';color:var(--text-muted);font-size:11px;margin-right:-4px }
details.si-pass-card[open] > summary > .si-pass-row1::before { content:'▾ ' }
.si-pass-id { font-size:12px;font-weight:600;color:#5e8252;background:var(--bg-soft);padding:2px 8px;border-radius:3px;font-family:"SF Mono",Menlo,monospace;flex-shrink:0 }
.si-pass-score { font-size:12px;font-weight:600;color:#5e8252;background:rgba(94,130,82,.1);padding:1px 7px;border-radius:10px }
.si-pass-prompt-preview { font-size:13px;color:var(--text-secondary);padding-left:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis }
.si-pass-body { padding:0 12px 10px 28px;display:flex;flex-direction:column;gap:8px }
.si-pass-section { }
.si-pass-label { font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:4px }
.si-pass-content { font-size:14px;color:var(--text-primary);line-height:1.6;white-space:pre-wrap;word-break:break-word;background:var(--bg-soft);padding:8px 12px;border-radius:4px }
.si-sample-dot { font-size:10px;line-height:1;flex-shrink:0 }
.se-scores { margin-bottom:12px;padding:12px 14px;background:var(--bg-soft);border-radius:8px }
.se-scores-hero { display:flex;align-items:baseline;gap:8px;margin-bottom:10px }
.se-hero-label { font-size:14px;font-weight:600;color:var(--text-primary) }
.se-hero-val { font-size:28px;font-weight:700;color:var(--text-primary);line-height:1 }
.se-hero-max { font-size:14px;font-weight:400;color:var(--text-muted) }
.se-hero-link { font-size:12px;color:var(--accent);text-decoration:none;font-weight:500;margin-left:auto }
.se-hero-link:hover { text-decoration:underline }
.se-scores-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:8px }
@media(max-width:600px) { .se-scores-grid { grid-template-columns:repeat(2,1fr) } }
.se-score-card { padding:8px 10px;background:var(--bg-surface);border-radius:6px }
.se-score-label { font-size:12px;color:var(--text-muted);margin-bottom:4px }
.se-score-bar { height:4px;background:var(--border);border-radius:2px;overflow:hidden;margin-bottom:4px }
.se-score-fill { height:100%;border-radius:2px }
.se-score-fill--good { background:#5e8252 }
.se-score-fill--mid { background:#b08030 }
.se-score-fill--low { background:#9c4a3f }
.se-score-val { font-size:16px;font-weight:600;color:var(--text-primary) }
.se-score-max { font-size:12px;font-weight:400;color:var(--text-muted) }
.si-pass-preview { flex:1;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0 }
.si-failure-trace:hover { text-decoration:underline }
.si-failure-detail { padding:0 12px 10px;border-top:1px solid var(--border) }
.si-failure-detail .si-illustration { border-left:none;background:transparent;padding:8px 0 0 0 }
.si-failure-no-detail { padding:6px 0;font-size:13px;color:var(--text-muted);font-style:italic }

/* v7:顶部全景区 — 左 3 个 donut ring + 右趋势图,两栏同高 */
.si-overview { display:grid;grid-template-columns:3fr 2fr;gap:18px;margin:10px 0 22px;align-items:stretch }
@media(max-width:880px){ .si-overview { grid-template-columns:1fr } }
.si-overview-cards { background:var(--bg-surface);border-radius:10px;padding:18px 14px;box-shadow:var(--shadow-sm);display:flex;align-items:center;justify-content:space-around;gap:8px }
.si-overview-trend { background:var(--bg-surface);border-radius:10px;padding:14px 16px;box-shadow:var(--shadow-sm);display:flex;flex-direction:column }

/* 三视角 ring + label(锚定到下面对应 section);内容自身居中,被 cards 容器垂直拉伸时上下留白对称 */
.si-vs { flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px;padding:8px 4px;text-decoration:none;color:var(--text-primary);border-radius:8px;transition:background .15s }
.si-vs:hover { background:var(--bg-soft);text-decoration:none }
.si-ring { display:block }
.si-vs-h { display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;justify-content:center;margin-top:4px }
.si-vs-icon { font-size:15px;line-height:1 }
.si-vs-label { font-size:13.5px;font-weight:600;color:var(--text-primary) }
.si-vs-sublabel { font-size:11px;color:var(--text-muted) }
.si-vs-stat { font-size:12.5px;color:var(--text-secondary);font-variant-numeric:tabular-nums;line-height:1.45 }
.si-vs-spark { display:block;margin-top:2px }
@media(max-width:560px){
  .si-overview-cards { flex-direction:column;align-items:stretch }
  .si-vs { flex-direction:row;justify-content:flex-start;text-align:left;gap:14px;align-items:center }
  .si-vs-h, .si-vs-stat, .si-vs-spark { margin:0 }
}

/* 三视角 section(下方主体) */
.si-sect { background:var(--bg-surface);border-radius:8px;padding:14px 18px;box-shadow:var(--shadow-sm);margin-bottom:14px;border-left:4px solid var(--border);scroll-margin-top:16px }
.si-sect--green   { border-left-color:#5e8252 }
.si-sect--yellow  { border-left-color:#b08030 }
.si-sect--red     { border-left-color:#9c4a3f }
.si-sect--gray    { border-left-color:var(--border) }
.si-sect-h { display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px;flex-wrap:wrap }
.si-sect-title { font-size:15px;font-weight:600;color:var(--text-primary) }
.si-sect-meta { font-size:11.5px;color:var(--text-muted);font-variant-numeric:tabular-nums }
.si-sect-body { display:flex;flex-direction:column;gap:6px }
.si-sect-empty { font-size:13px;color:var(--text-muted);font-style:italic;padding:8px 0 }
.si-sect-line { font-size:14px;color:var(--text-secondary);margin-bottom:4px }
.si-sect-allpass { font-size:14px;color:#5e8252;padding:6px 10px;background:rgba(94,130,82,.07);border-radius:4px }
.si-sect-link { display:inline-block;margin-top:8px;font-size:12px;color:var(--accent);text-decoration:none;font-weight:500 }
.si-sect-link:hover { text-decoration:underline }
.si-sect-fold { margin-top:8px;border-top:1px dashed var(--border);padding-top:6px }
.si-sect-fold > summary { cursor:pointer;font-size:11.5px;color:var(--text-muted);user-select:none;list-style:none;padding:4px 0 }
.si-sect-fold > summary::-webkit-details-marker { display:none }
.si-sect-fold > summary:hover { color:var(--text-secondary) }
.si-sect-fold-body { padding-top:6px;display:flex;flex-direction:column;gap:5px }
.si-sect-skipped { font-size:11px;color:var(--text-muted);font-style:italic;margin-top:6px }

/* doctor 规则展示(用在 doctor section 和 observe section) */
.sd-grid { display:flex;flex-direction:column;gap:4px }
.sd-dim { border-radius:6px;border:1px solid var(--border);overflow:hidden }
.sd-dim--err { border-color:rgba(156,74,63,.3) }
.sd-dim--warn { border-color:rgba(176,128,48,.3) }
.sd-dim--pass { border-color:rgba(94,130,82,.25);background:rgba(94,130,82,.04) }
.sd-dim--skip { border-color:var(--border);opacity:.6 }
.sd-dim > summary { list-style:none;cursor:pointer }
.sd-dim > summary::-webkit-details-marker { display:none }
.sd-dim-header { display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:14px }
.sd-dim-dot { flex-shrink:0;font-size:10px;line-height:1 }
.sd-dim-name { font-weight:600;color:var(--text-primary);flex:1;min-width:0 }
.sd-dim-badges { display:flex;gap:6px;flex-shrink:0 }
.sd-badge { font-size:12px;padding:1px 7px;border-radius:10px;font-weight:500 }
.sd-badge--err { background:rgba(156,74,63,.1);color:#9c4a3f }
.sd-badge--warn { background:rgba(176,128,48,.1);color:#b08030 }
.sd-dim-body { padding:0 12px 10px;display:flex;flex-direction:column;gap:6px }
.sd-item { padding:8px 10px;border-radius:4px;font-size:14px;line-height:1.6 }
.sd-item--err { background:rgba(156,74,63,.05);border-left:2px solid #9c4a3f }
.sd-item--warn { background:rgba(176,128,48,.05);border-left:2px solid #b08030 }
.sd-item-desc { color:var(--text-primary);word-break:break-word }
.sd-item-sug { margin-top:4px;font-size:13px;color:var(--text-secondary);padding:4px 8px;background:rgba(94,130,82,.05);border-radius:4px;word-break:break-word }
.sd-warn-fold { margin-top:6px }
.sd-warn-list { display:flex;flex-direction:column;gap:6px;margin-top:6px }
.sd-warn-toggle { cursor:pointer;font-size:13px;color:var(--text-muted);user-select:none;list-style:none;padding:2px 0 }
.sd-warn-toggle::-webkit-details-marker { display:none }
.sd-warn-toggle::before { content:'▸ ';font-size:10px }
details[open] > .sd-warn-toggle::before { content:'▾ ' }
.sd-warn-toggle:hover { color:var(--text-secondary) }
.sd-pass-fold { margin-top:6px }
.sd-pass-fold > .sd-dim + .sd-dim { margin-top:4px }
.sd-pass-toggle { cursor:pointer;font-size:13px;color:var(--text-muted);user-select:none;list-style:none;padding:6px 0 }
.sd-pass-toggle::-webkit-details-marker { display:none }
.sd-pass-toggle:hover { color:var(--text-secondary) }
.si-rule-hint { margin-top:4px;font-size:12px;color:var(--text-secondary);line-height:1.55 }

/* 单条 sample 展开后的 4 段(modal v6:用例 prompt / 期望 / 实际 / 建议)*/
.si-sb { display:flex;flex-direction:column;gap:10px;padding:10px 0 }
.si-sb-block { padding:10px 12px;border-radius:5px;background:var(--bg-soft) }
.si-sb-block--prompt   { background:var(--bg-soft) }
.si-sb-block--expected { background:rgba(94,130,82,.06) }
.si-sb-block--actual   { background:rgba(176,128,48,.07) }
.si-sb-block--suggest  { background:rgba(122,107,137,.07) }
.si-sb-label { font-size:12px;font-weight:700;color:var(--text-secondary);letter-spacing:0.02em;margin-bottom:5px }
.si-sb-block--expected .si-sb-label { color:#5e8252 }
.si-sb-block--actual   .si-sb-label { color:#b08030 }
.si-sb-block--suggest  .si-sb-label { color:#7a6b89 }
.si-sb-text { font-size:13px;color:var(--text-primary);line-height:1.6;white-space:pre-wrap;word-break:break-word }
.si-sb-block--prompt .si-sb-text { font-family:"SF Mono",Menlo,monospace;font-size:12.5px;max-height:200px;overflow-y:auto }
.si-sb-sugrow { display:grid;grid-template-columns:90px 1fr;gap:8px;padding:4px 0;align-items:start }
.si-sb-sugrow:not(:first-child) { border-top:1px dashed var(--border) }
.si-sb-sugtag { font-size:11px;color:#7a6b89;background:var(--bg-surface);padding:2px 8px;border-radius:8px;font-weight:600;width:fit-content;height:fit-content }
.si-sb-block--empty { opacity:.75 }
.si-sb-empty { color:var(--text-muted);font-style:italic;font-size:12.5px }

/* 单条 sample 的"期望 vs 实际 vs 卡在哪"diff 对照视图(已被 v6 sb 视图替代,保留 placeholder)*/
.si-diff { display:flex;flex-direction:column;gap:8px;padding:10px 0 }
.si-diff-row { display:grid;grid-template-columns:24px 50px 1fr;gap:10px;align-items:start;padding:8px 12px;border-radius:5px;line-height:1.55 }
.si-diff-row--expected { background:rgba(94,130,82,.07);border-left:3px solid #5e8252 }
.si-diff-row--actual   { background:rgba(176,128,48,.08);border-left:3px solid #b08030 }
.si-diff-row--failed   { background:rgba(156,74,63,.07);border-left:3px solid #9c4a3f }
.si-diff-icon { font-size:14px;line-height:1.5 }
.si-diff-label { font-size:11.5px;font-weight:700;letter-spacing:0.04em;color:var(--text-secondary);padding-top:2px }
.si-diff-row--expected .si-diff-label { color:#5e8252 }
.si-diff-row--actual   .si-diff-label { color:#b08030 }
.si-diff-row--failed   .si-diff-label { color:#9c4a3f }
.si-diff-text { color:var(--text-primary);font-size:13px;word-break:break-word }
.si-diff-text--mono { font-family:"SF Mono",Menlo,monospace;font-size:12px;background:var(--bg-surface);padding:2px 7px;border-radius:3px;width:fit-content }
/* 原始 prompt/output 降级到二级折叠 */
.si-diff-raw { margin-top:6px;border-top:1px dashed var(--border);padding-top:8px }
.si-diff-raw > summary { cursor:pointer;font-size:11.5px;color:var(--text-muted);user-select:none;list-style:none }
.si-diff-raw > summary::-webkit-details-marker { display:none }
.si-diff-raw > summary:hover { color:var(--text-secondary) }
.si-diff-raw-body { padding:6px 0 }

/* 占位符标识 */
.si-placeholder { background:rgba(176,128,48,.20);color:#7a5810;padding:1px 4px;border-radius:3px;font-weight:600;font-style:italic }
.si-rec-patch-hint { font-size:11.5px;color:#7a5810;background:rgba(176,128,48,.10);padding:6px 10px;border-radius:4px;margin-bottom:6px;line-height:1.5 }
.si-rec-patch-hint .si-placeholder { background:rgba(176,128,48,.30) }

/* 第一条建议的"⭐ 推荐先做"标记 */
.si-rec-item--primary { border-left-color:#5e8252;background:rgba(94,130,82,.06) }
.si-rec-star { font-size:10.5px;font-weight:700;color:#5e8252;background:rgba(94,130,82,.16);padding:2px 8px;border-radius:9px;letter-spacing:0.02em;flex-shrink:0 }

/* 建议 + patch 直接铺(去掉 details 折叠)*/
.si-recs { margin:14px 0 }
.si-recs-h { font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:10px }
.si-rec-item { background:var(--bg-soft);border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:3px solid var(--accent) }
.si-rec-item:last-child { margin-bottom:0 }
.si-rec-head { display:flex;align-items:flex-start;gap:8px;margin-bottom:8px }
.si-rec-num { font-size:11px;font-weight:700;color:var(--text-muted);background:var(--bg-surface);padding:1px 7px;border-radius:9px;flex-shrink:0;margin-top:1px;font-variant-numeric:tabular-nums }
.si-rec-pri { padding:1px 7px;border-radius:8px;font-size:10.5px;font-weight:600;flex-shrink:0;margin-top:1px }
.si-rec-pri--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-rec-pri--medium { background:rgba(176,128,48,.12);color:#b08030 }
.si-rec-pri--low { background:rgba(94,130,82,.14);color:#5e8252 }
.si-rec-action { flex:1;color:var(--text-primary);font-size:13px;line-height:1.55 }
.si-rec-patch { margin-left:0 }
.si-rec-patch-meta { display:flex;gap:8px;align-items:center;font-size:11px;color:var(--text-muted);margin-bottom:5px;flex-wrap:wrap }
.si-rec-patch-target { font-weight:600;color:var(--text-secondary) }
.si-rec-patch-loc { font-family:"SF Mono",Menlo,monospace;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
.si-rec-patch-copy { background:var(--accent);color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;font-weight:500;transition:background .1s;flex-shrink:0 }
.si-rec-patch-copy:hover { background:var(--accent-hover) }
.si-rec-patch-copy.copied { background:#5e8252 }
.si-rec-patch-snippet { background:var(--bg-surface);padding:10px 12px;border-radius:4px;border-left:2px solid var(--accent);font-size:11.5px;line-height:1.55;overflow-x:auto;margin:0 }
.si-rec-patch-snippet code { font-family:"SF Mono",Menlo,monospace;color:var(--text-primary);white-space:pre;display:block }

/* 三视角细节折叠(底部)*/
.si-modal-detail { margin-top:14px;border-top:1px solid var(--border);padding-top:10px }
.si-modal-detail > summary { cursor:pointer;font-size:12px;font-weight:600;color:var(--text-secondary);user-select:none;list-style:none;padding:4px 0 }
.si-modal-detail > summary::-webkit-details-marker { display:none }
.si-modal-detail > summary:hover { color:var(--text-primary) }
.si-modal-detail-body { margin-top:8px;padding:8px 10px;background:var(--bg-soft);border-radius:5px }

/* Modal 内的样式(沿用 modal-overlay/modal-content,只补本页特有的)*/
.si-modal { max-width:760px;width:90% }
.si-modal-h { display:flex;align-items:center;gap:10px;flex-wrap:wrap }
.si-modal-num { font-size:12px;font-weight:700;color:var(--text-muted);background:var(--bg-soft);padding:2px 8px;border-radius:4px }
.si-modal-sev { font-size:18px }
.si-modal-title { margin:0;font-size:17px;font-weight:600;color:var(--text-primary) }
/* si-modal-tags / si-modal-affect / si-aud-tag — modal v4 极简后不再使用,保留 placeholder 防回退 */
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
<script src="/static/chart.js" onerror="window.__omkChartLoadError=true"></script>
<script>
(function(){
  var L = (document.documentElement.dataset.lang || 'zh');
  function showFallback(canvas, msg){
    if (!canvas) return;
    var wrap = canvas.parentElement;
    if (!wrap || wrap.dataset.omkFallback === '1') return;
    wrap.dataset.omkFallback = '1'; // 防止异步路径多次写入
    wrap.innerHTML = '<div class="si-trend-fallback">' +
      '<div class="si-trend-fallback-icon">📉</div>' +
      '<div class="si-trend-fallback-msg">' + msg + '</div>' +
      '<div class="si-trend-fallback-hint">' + (L === 'en' ? 'Check browser console for details.' : '数据仍可从下方指标速览看,或在浏览器控制台看具体错误。') + '</div>' +
      '</div>';
  }
  // 异步兜底:Chart 内部 RAF / setTimeout 抛错会冒泡到 window.error,这里捕获后
  // 把 trend canvas 区域降级,不让"图表 init 看似成功但渲染失败"留出空白。
  window.addEventListener('error', function(ev){
    var canvas = document.getElementById('trend-chart');
    if (!canvas) return;
    var msg = (ev && ev.message) || '';
    if (/chart/i.test(msg) || (ev.filename && /chart\\.js$/i.test(ev.filename))) {
      showFallback(canvas, L === 'en' ? 'Trend chart error' : '趋势图渲染异常');
    }
  });
  function init(){
    var canvas = document.getElementById('trend-chart');
    if (!canvas) return;
    if (window.__omkChartLoadError || !window.Chart) {
      showFallback(canvas, L === 'en' ? 'Chart failed to load' : '趋势图加载失败');
      return;
    }
    var raw = canvas.getAttribute('data-chart');
    var rawLinks = canvas.getAttribute('data-links');
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      var links = rawLinks ? JSON.parse(rawLinks) : null;
      // 防御:dataset data 长度跟 labels 严重不一致直接降级,别让 chart 静默画空 canvas
      if (data && Array.isArray(data.labels) && Array.isArray(data.datasets)) {
        var bad = data.datasets.some(function(ds){
          return !Array.isArray(ds.data) || ds.data.length !== data.labels.length;
        });
        if (bad) {
          showFallback(canvas, L === 'en' ? 'Chart data format error' : '趋势图数据格式异常');
          return;
        }
      }
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
                  if (url) lines.push(L === 'en' ? '→ Click to view report' : '→ 点击看那期报告');
                }
                return lines;
              }
            } }
          },
          scales: {
            y: { min: 0, max: 100, ticks: { callback: function(v){ return v === 0 || v === 100 ? v + '%' : ''; }, color: '#a8a8a8', font: { size: 10 }, stepSize: 25 }, grid: { color: 'rgba(58,58,58,.06)' } },
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
    } catch(e) {
      console.warn('trend chart init failed:', e);
      showFallback(canvas, L === 'en' ? 'Trend chart error' : '趋势图渲染异常');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
</script>`;

// ────────── v7:三视角顶层全景 + 各 section 直铺 ──────────

/** 紧凑 inline sparkline(供顶部速览卡每张里用,显示该视角历史走向)。
 *  values 是 0-100 归一化数组(空数组返回占位)。 */
function renderInlineSpark(values: number[], color: string): string {
  if (!values || values.length === 0) {
    return `<svg class="si-vs-spark" width="80" height="22" viewBox="0 0 80 22" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="55%" text-anchor="middle" fill="#a8a8a8" font-size="9">no data</text></svg>`;
  }
  const w = 80, h = 22, pad = 2;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 100);
  const range = (max - min) || 1;
  const dx = values.length > 1 ? (w - 2 * pad) / (values.length - 1) : 0;
  const pts = values.map((v, i) => {
    const x = pad + i * dx;
    const y = pad + (h - 2 * pad) * (1 - (v - min) / range);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="si-vs-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/** Donut ring SVG:中央显示百分比,弧色按 band。半径 38,周长 ~239。 */
function renderDonutRing(pct: number | null, color: string, label: string): string {
  const r = 38, c = 2 * Math.PI * r;
  const safePct = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const dashOffset = c * (1 - safePct / 100);
  const centerText = pct == null ? '—' : `${Math.round(safePct)}%`;
  return `<svg class="si-ring" width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${e(label)}">
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--bg-soft)" stroke-width="8"/>
    ${pct != null ? `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="8"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"
      stroke-linecap="round" transform="rotate(-90 50 50)"/>` : ''}
    <text x="50" y="56" text-anchor="middle" font-size="19" font-weight="700" fill="${pct == null ? 'var(--text-muted)' : color}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${centerText}</text>
  </svg>`;
}

/** 三视角顶部全景:3 个 Apple-watch 风 donut ring,每个 ring 下面带 emoji + label + 状态 + sparkline */
function renderViewSummaryCards(entry: SkillIndexEntry, lang: Lang): string {
  // doctor
  const docBand: 'green' | 'yellow' | 'red' | 'gray' = entry.doctor
    ? (entry.doctor.status === 'fail' ? 'red' : entry.doctor.status === 'warn' ? 'yellow' : 'green') : 'gray';
  const docColor = docBand === 'green' ? '#5e8252' : docBand === 'yellow' ? '#b08030' : docBand === 'red' ? '#9c4a3f' : '#a8a8a8';
  const docPct = entry.doctor && (entry.doctor.passCount + entry.doctor.warnCount + entry.doctor.failCount) > 0
    ? (entry.doctor.passCount / (entry.doctor.passCount + entry.doctor.warnCount + entry.doctor.failCount)) * 100
    : null;
  const docPassRates = entry.doctorHistory.map((h) => {
    const tot = h.passCount + h.warnCount + h.failCount;
    return tot > 0 ? (h.passCount / tot) * 100 : 0;
  });
  const docStat = entry.doctor
    ? `${entry.doctor.passCount}✓ ${entry.doctor.warnCount}⚠ ${entry.doctor.failCount}✗`
    : (lang === 'zh' ? '未运行' : 'not run');

  // eval
  const evalBand: 'green' | 'yellow' | 'red' | 'gray' = entry.eval
    ? (entry.eval.failCount === 0 ? 'green' : entry.eval.passCount === 0 ? 'red' : 'yellow') : 'gray';
  const evalColor = evalBand === 'green' ? '#5e8252' : evalBand === 'yellow' ? '#b08030' : evalBand === 'red' ? '#9c4a3f' : '#a8a8a8';
  const evalPct = entry.eval && entry.eval.compositeScore != null
    ? (entry.eval.compositeScore / 5) * 100
    : null;
  const evalCompositeRates = entry.evalHistory.map((h) => (h.compositeScore ?? 0) / 5 * 100);
  const evalStat = entry.eval && (entry.eval.passCount + entry.eval.failCount) > 0
    ? `${entry.eval.totalSamples} ${lang === 'zh' ? '用例' : 'samples'} · ${Math.round((entry.eval.passCount / (entry.eval.passCount + entry.eval.failCount)) * 100)}%${entry.eval.compositeScore != null ? ` · ${entry.eval.compositeScore.toFixed(2)}/5` : ''}`
    : (lang === 'zh' ? '未运行' : 'not run');

  // observe
  const obsBand: 'green' | 'yellow' | 'red' | 'gray' = entry.observe?.healthBand ?? 'gray';
  const obsColor = obsBand === 'green' ? '#5e8252' : obsBand === 'yellow' ? '#b08030' : obsBand === 'red' ? '#9c4a3f' : '#a8a8a8';
  const obsPct = entry.observe ? (1 - entry.observe.gapRate) * 100 : null;
  const obsStabilityRates = entry.observeHistory.map((h) => (1 - h.gapRate) * 100);
  const obsStat = entry.observe
    ? `${entry.observe.segmentCount} ${lang === 'zh' ? '段' : 'segs'} · ${((1 - entry.observe.gapRate) * 100).toFixed(0)}% ${lang === 'zh' ? '稳定' : 'stable'}`
    : (lang === 'zh' ? '未运行' : 'not run');

  const node = (icon: string, label: string, sublabel: string, band: string, pct: number | null, color: string, stat: string, sparkRates: number[], anchor: string): string => `<a class="si-vs si-vs--${band}" href="#${anchor}">
    ${renderDonutRing(pct, color, `${label} ${sublabel}`)}
    <div class="si-vs-h">
      <span class="si-vs-icon">${icon}</span>
      <span class="si-vs-label">${e(label)}</span>
      <span class="si-vs-sublabel">${e(sublabel)}</span>
    </div>
    <div class="si-vs-stat">${e(stat)}</div>
    ${renderInlineSpark(sparkRates, color)}
  </a>`;

  return `${node('🩺', lang === 'zh' ? '健康度' : 'Structure', '(doctor)', docBand, docPct, docColor, docStat, docPassRates, 'section-doctor')}
    ${node('🧪', lang === 'zh' ? '评测结果' : 'Test score', '(eval)', evalBand, evalPct, evalColor, evalStat, evalCompositeRates, 'section-eval')}
    ${node('👁', lang === 'zh' ? '线上观测' : 'Live stability', '(observe)', obsBand, obsPct, obsColor, obsStat, obsStabilityRates, 'section-observe')}`;
}

/** doctor section:展示告警 / 失败规则;通过的规则折叠到底部 */
function renderDoctorSection(snap: SkillDoctorSnapshot | null, lang: Lang): string {
  if (!snap) {
    return `<section id="section-doctor" class="si-sect si-sect--gray">
      <div class="si-sect-h">🩺 ${lang === 'zh' ? '健康度 (doctor)' : 'Structure (doctor)'}</div>
      <div class="si-sect-empty">${lang === 'zh' ? '未运行 omk doctor' : 'doctor not run yet'}</div>
    </section>`;
  }

  type Finding = { level: string; description?: string; suggestion?: string };
  const getDet = (r: DoctorRuleResult) => r.detail as { displayName?: string; level?: string; findings?: Finding[] } | undefined;

  const SORT_ORDER: Record<string, number> = { fail: 0, warn: 1, skipped: 2, pass: 3 };
  const dims = snap.results
    .filter((r) => !r.ruleId.endsWith(':_summary'))
    .sort((a, b) => (SORT_ORDER[a.status] ?? 9) - (SORT_ORDER[b.status] ?? 9));

  const STATUS_CFG: Record<string, { dot: string; label: string; cls: string }> = {
    fail: { dot: '🔴', label: lang === 'zh' ? '不通过' : 'fail', cls: 'err' },
    warn: { dot: '🟡', label: lang === 'zh' ? '告警' : 'warn', cls: 'warn' },
    pass: { dot: '🟢', label: lang === 'zh' ? '通过' : 'pass', cls: 'pass' },
    skipped: { dot: '⚪', label: lang === 'zh' ? '跳过' : 'skip', cls: 'skip' },
  };

  const renderDimRow = (r: DoctorRuleResult): string => {
    const det = getDet(r);
    const name = det?.displayName ?? r.ruleId;
    const cfg = STATUS_CFG[r.status] ?? STATUS_CFG.pass;
    const findings = det?.findings ?? [];
    const errors = findings.filter((f) => f.level === '错误');
    const warnings = findings.filter((f) => f.level === '警告');
    const hasDetails = errors.length > 0 || warnings.length > 0;

    const badge = (count: number, type: 'err' | 'warn'): string => {
      if (!count) return '';
      const label = type === 'err' ? (lang === 'zh' ? '错误' : 'err') : (lang === 'zh' ? '警告' : 'warn');
      return `<span class="sd-badge sd-badge--${type}">${count} ${label}</span>`;
    };

    const header = `<div class="sd-dim-header">
      <span class="sd-dim-dot">${cfg.dot}</span>
      <span class="sd-dim-name">${e(name)}</span>
      <span class="sd-dim-badges">${badge(errors.length, 'err')}${badge(warnings.length, 'warn')}</span>
    </div>`;

    if (!hasDetails) return `<div class="sd-dim sd-dim--${cfg.cls}">${header}</div>`;

    let body = '';
    if (errors.length > 0) {
      body += errors.map((f) => `<div class="sd-item sd-item--err">
        <div class="sd-item-desc">❌ ${e(f.description ?? '')}</div>
        ${f.suggestion ? `<div class="sd-item-sug">💡 ${e(f.suggestion)}</div>` : ''}
      </div>`).join('');
    }
    if (warnings.length > 0) {
      body += `<details class="sd-warn-fold"><summary class="sd-warn-toggle">${lang === 'zh' ? `${warnings.length} 条警告` : `${warnings.length} warning(s)`}</summary>`;
      body += `<div class="sd-warn-list">${warnings.map((f) => `<div class="sd-item sd-item--warn">
        <div class="sd-item-desc">⚠️ ${e(f.description ?? '')}</div>
        ${f.suggestion ? `<div class="sd-item-sug">💡 ${e(f.suggestion)}</div>` : ''}
      </div>`).join('')}</div>`;
      body += `</details>`;
    }

    return `<details class="sd-dim sd-dim--${cfg.cls}" ${errors.length > 0 ? 'open' : ''}>
      <summary>${header}</summary>
      <div class="sd-dim-body">${body}</div>
    </details>`;
  };

  return `<section id="section-doctor" class="si-sect si-sect--${snap.status === 'fail' ? 'red' : snap.status === 'warn' ? 'yellow' : 'green'}">
    <div class="si-sect-h">
      <span class="si-sect-title">🩺 ${lang === 'zh' ? '健康度 (doctor)' : 'Structure (doctor)'}</span>
      <span class="si-sect-meta">${snap.passCount}✓ ${snap.warnCount}⚠ ${snap.failCount}✗ · ${relTime(snap.timestamp, lang)}</span>
    </div>
    <div class="sd-grid">
      ${dims.filter((r) => r.status === 'fail' || r.status === 'warn').map(renderDimRow).join('')}
      ${dims.filter((r) => r.status === 'pass' || r.status === 'skipped').length > 0
        ? `<details class="sd-pass-fold"><summary class="sd-pass-toggle">${lang === 'zh'
            ? `▸ ${dims.filter((r) => r.status === 'pass' || r.status === 'skipped').length} 项通过`
            : `▸ ${dims.filter((r) => r.status === 'pass' || r.status === 'skipped').length} passed`}</summary>
          ${dims.filter((r) => r.status === 'pass' || r.status === 'skipped').map(renderDimRow).join('')}
        </details>`
        : ''}
    </div>
  </section>`;
}

/** eval section:失败 sample 列表(默认折叠,展开看 prompt/期望/实际/建议) */
function renderEvalSection(
  snap: SkillEvalSnapshot | null,
  evalReport: EvaluationReport | null,
  langQ: string,
  lang: Lang,
): string {
  if (!snap) {
    return `<section id="section-eval" class="si-sect si-sect--gray">
      <div class="si-sect-h">🧪 ${lang === 'zh' ? '评测结果 (eval)' : 'Test score (eval)'}</div>
      <div class="si-sect-empty">${lang === 'zh' ? '未运行 omk eval' : 'eval not run yet'}</div>
    </section>`;
  }

  // 收集所有 sample 详情(分 failed / passed / tripwire 三类)
  interface SampleListEntry { sampleId: string; prompt: string; promptPreview: string; score?: number | null; rubric?: string; output?: string }
  const failedSamples: FailedSampleDetail[] = [];
  const passedSamples: SampleListEntry[] = [];
  const tripwireSamples: SampleListEntry[] = [];
  if (evalReport && snap.variantName) {
    const variant = snap.variantName;
    for (const r of evalReport.results) {
      const v = r.variants?.[variant];
      if (!v) continue;
      const sid = r.sample_id;
      const prompt = evalReport.sampleSnapshots?.[sid]?.prompt ?? '';
      const promptPreview = prompt.slice(0, 80).replace(/\n+/g, ' ');
      const passed = (v.assertions?.details ?? []).every((d) => d.passed);
      const isTripwire = (v.diagnostic?.rootCause ?? []).includes('tripwire_intentional')
        || evalReport.sampleSnapshots?.[sid]?.tripwire === true;
      if (isTripwire) {
        tripwireSamples.push({ sampleId: sid, prompt, promptPreview });
      } else if (passed) {
        passedSamples.push({
          sampleId: sid, prompt, promptPreview, score: v.compositeScore ?? null,
          rubric: evalReport.sampleSnapshots?.[sid]?.rubric ?? '',
          output: v.outputPreview ?? '',
        });
      } else {
        failedSamples.push({
          sampleId: sid,
          diagnosticSummary: v.diagnostic?.summary ?? '',
          prompt,
          expected: v.diagnostic?.expected ?? '',
          actual: v.diagnostic?.actual ?? '',
          suggestionSkill: v.diagnostic?.suggestion?.skill ?? '',
          suggestionSample: v.diagnostic?.suggestion?.sample ?? '',
          failureModes: (v.diagnostic?.failureModes ?? []) as string[],
          illustration: null,
        });
      }
    }
  }

  const total = snap.passCount + snap.failCount;
  const pct = total > 0 ? Math.round((snap.passCount / total) * 100) : 0;
  const sectBand = snap.failCount === 0 ? 'green' : snap.passCount === 0 ? 'red' : 'yellow';

  const failedBlock = failedSamples.length > 0
    ? failedSamples.map((s) => {
        const summary = s.diagnosticSummary || (lang === 'zh' ? '(无诊断摘要)' : '(no summary)');
        const modes = s.failureModes.length > 0
          ? `<span class="si-failure-modes">${s.failureModes.map((m) => `<span class="si-failure-mode">${e(m)}</span>`).join('')}</span>`
          : '';
        const traceLink = `<a class="si-failure-trace" href="/reports/${e(snap.reportId)}${langQ}#sample-${e(s.sampleId)}" onclick="event.stopPropagation()">${lang === 'zh' ? '完整 trace →' : 'full trace →'}</a>`;
        return `<details class="si-failure-item">
          <summary class="si-failure-head">
            <div class="si-failure-row1">
              <span class="si-sample-dot si-sample-dot--fail">🔴</span>
              <code class="si-failure-id">${e(s.sampleId)}</code>
              ${modes}
              <span class="si-failure-spacer"></span>
              ${traceLink}
            </div>
            <div class="si-failure-row2">${e(summary)}</div>
          </summary>
          <div class="si-failure-detail">${renderSampleBody(s, lang)}</div>
        </details>`;
      }).join('')
    : '';

  // 通过 sample: 可展开看 prompt 全文 + 得分 + trace 链接
  const renderPassedSample = (s: SampleListEntry): string => {
    const traceLink = `<a class="si-failure-trace" href="/reports/${e(snap.reportId)}${langQ}#sample-${e(s.sampleId)}" onclick="event.stopPropagation()">${lang === 'zh' ? '完整 trace →' : 'full trace →'}</a>`;
    const scoreText = s.score != null ? `${s.score.toFixed(1)}/5` : '';
    return `<details class="si-pass-card">
      <summary class="si-pass-head">
        <div class="si-pass-row1">
          <span class="si-sample-dot">🟢</span>
          <code class="si-pass-id">${e(s.sampleId)}</code>
          ${scoreText ? `<span class="si-pass-score">${scoreText}</span>` : ''}
          <span class="si-failure-spacer"></span>
          ${traceLink}
        </div>
        <div class="si-pass-prompt-preview">${e(s.promptPreview)}${s.prompt.length > 80 ? '…' : ''}</div>
      </summary>
      <div class="si-pass-body">
        <div class="si-pass-section">
          <div class="si-pass-label">${lang === 'zh' ? '📝 用例 Prompt' : '📝 Prompt'}</div>
          <div class="si-pass-content">${e(s.prompt)}</div>
        </div>
        ${s.rubric ? `<div class="si-pass-section">
          <div class="si-pass-label">${lang === 'zh' ? '🎯 期望' : '🎯 Expected'}</div>
          <div class="si-pass-content">${e(s.rubric)}</div>
        </div>` : ''}
        ${s.output ? `<div class="si-pass-section">
          <div class="si-pass-label">${lang === 'zh' ? '✅ 实际输出' : '✅ Actual'}</div>
          <div class="si-pass-content">${e(s.output)}</div>
        </div>` : ''}
      </div>
    </details>`;
  };
  const passedFold = passedSamples.length > 0
    ? `<details class="si-sect-fold">
        <summary>${lang === 'zh' ? `▸ 已通过 ${passedSamples.length} 条用例` : `▸ ${passedSamples.length} samples passed`}</summary>
        <div class="si-sect-fold-body">${passedSamples.map(renderPassedSample).join('')}</div>
      </details>`
    : '';
  const tripwireFold = tripwireSamples.length > 0
    ? `<details class="si-sect-fold">
        <summary>${lang === 'zh' ? `▸ 诱错样本 ${tripwireSamples.length} 条(按设计应该失败)` : `▸ ${tripwireSamples.length} tripwire samples (designed to fail)`}</summary>
        <div class="si-sect-fold-body">${tripwireSamples.map(renderPassedSample).join('')}</div>
      </details>`
    : '';

  const failedHeading = failedSamples.length > 0
    ? `<div class="si-sect-line">${lang === 'zh' ? `${failedSamples.length} 条用例失败:` : `${failedSamples.length} samples failed:`}</div>`
    : `<div class="si-sect-allpass">✓ ${lang === 'zh' ? '所有用例通过' : 'all samples pass'}</div>`;

  // 综合得分 + 六维雷达
  const variantSummary = evalReport?.summary?.[snap.variantName];
  const scoreCard = (label: string, value: number | null | undefined, max: number): string => {
    if (value == null) return '';
    const pctW = Math.round((value / max) * 100);
    const cls = pctW >= 80 ? 'good' : pctW >= 60 ? 'mid' : 'low';
    return `<div class="se-score-card">
      <div class="se-score-label">${e(label)}</div>
      <div class="se-score-bar"><div class="se-score-fill se-score-fill--${cls}" style="width:${pctW}%"></div></div>
      <div class="se-score-val">${value.toFixed(2)}<span class="se-score-max">/${max}</span></div>
    </div>`;
  };
  const scoreSummary = variantSummary ? `<div class="se-scores">
    <div class="se-scores-hero">
      <div class="se-hero-label">${lang === 'zh' ? '综合得分' : 'Composite'}</div>
      <div class="se-hero-val">${(variantSummary.avgCompositeScore ?? 0).toFixed(2)}<span class="se-hero-max">/5</span></div>
      <a class="se-hero-link" href="/reports/${e(snap.reportId)}${langQ}">${lang === 'zh' ? '查看详情 →' : 'Details →'}</a>
    </div>
    <div class="se-scores-grid">
      ${scoreCard(lang === 'zh' ? '事实 / Fact' : 'Fact', variantSummary.avgFactScore, 5)}
      ${scoreCard(lang === 'zh' ? '行为 / Behavior' : 'Behavior', variantSummary.avgAssertionScore, 5)}
      ${scoreCard(lang === 'zh' ? 'LLM 评价 / Judge' : 'Judge', variantSummary.avgJudgeScore, 5)}
      ${scoreCard(lang === 'zh' ? '工具成功率' : 'Tool success', variantSummary.toolSuccessRate != null ? variantSummary.toolSuccessRate * 100 : null, 100)}
      ${scoreCard(lang === 'zh' ? 'Trace 覆盖率' : 'Trace coverage', variantSummary.traceCoverageRate != null ? variantSummary.traceCoverageRate * 100 : null, 100)}
      ${scoreCard(lang === 'zh' ? '平均轮次' : 'Avg turns', variantSummary.avgNumTurns, 20)}
    </div>
  </div>` : '';

  return `<section id="section-eval" class="si-sect si-sect--${sectBand}">
    <div class="si-sect-h">
      <span class="si-sect-title">🧪 ${lang === 'zh' ? '评测结果 (eval)' : 'Test score (eval)'}</span>
      <span class="si-sect-meta">${snap.totalSamples} ${lang === 'zh' ? '用例' : 'samples'} · ${pct}% ${lang === 'zh' ? '通过' : 'pass'}${snap.compositeScore != null ? ` · ${snap.compositeScore.toFixed(2)}/5` : ''} · ${relTime(snap.timestamp, lang)}</span>
    </div>
    <div class="si-sect-body">
      ${scoreSummary}
      ${failedHeading}
      ${failedBlock}
      ${passedFold}
      ${tripwireFold}
      <a class="si-sect-link" href="/reports/${e(snap.reportId)}${langQ}">${lang === 'zh' ? '完整 A/B 报告 →' : 'Full A/B report →'}</a>
    </div>
  </section>`;
}

/** observe section:展示异常指标(gap / 工具失败率) */
function renderObserveSection(
  snap: SkillObserveSnapshot | null,
  langQ: string,
  lang: Lang,
): string {
  if (!snap) {
    return `<section id="section-observe" class="si-sect si-sect--gray">
      <div class="si-sect-h">👁 ${lang === 'zh' ? '线上观测 (observe)' : 'Live stability (observe)'}</div>
      <div class="si-sect-empty">${lang === 'zh' ? '未跑 omk observe' : 'observe not run yet'}</div>
    </section>`;
  }
  const gapPct = (snap.gapRate * 100).toFixed(0);
  const failPct = (snap.failureRate * 100).toFixed(1);

  const alerts: string[] = [];
  if (snap.gapRate >= 0.2) {
    alerts.push(`<div class="si-rule si-rule--warn">
      <div class="si-rule-head">
        <span class="si-rule-icon">⚠</span>
        <code class="si-rule-id">${lang === 'zh' ? '知识库 gap' : 'KB gap'}</code>
        <span class="si-rule-msg">${gapPct}% ${lang === 'zh' ? '段命中知识库 gap — LLM 找不到该读哪段' : 'segments hit knowledge gap'}</span>
      </div>
    </div>`);
  }
  if (snap.failureRate >= 0.2) {
    alerts.push(`<div class="si-rule si-rule--warn">
      <div class="si-rule-head">
        <span class="si-rule-icon">⚠</span>
        <code class="si-rule-id">${lang === 'zh' ? '工具失败率' : 'tool fail rate'}</code>
        <span class="si-rule-msg">${failPct}% ${lang === 'zh' ? '工具调用失败 — 可能环境问题或 skill 让 LLM 走错路径' : 'tool calls failing'}</span>
      </div>
    </div>`);
  }

  const body = alerts.length > 0
    ? alerts.join('')
    : `<div class="si-sect-allpass">✓ ${lang === 'zh' ? '生产观测健康' : 'production observation healthy'}</div>`;

  return `<section id="section-observe" class="si-sect si-sect--${snap.healthBand}">
    <div class="si-sect-h">
      <span class="si-sect-title">👁 ${lang === 'zh' ? '线上观测 (observe)' : 'Live stability (observe)'}</span>
      <span class="si-sect-meta">${snap.segmentCount} ${lang === 'zh' ? '段' : 'segs'} · gap ${gapPct}% · ${lang === 'zh' ? '工具失败率' : 'tool fail'} ${failPct}% · ${relTime(snap.generatedAt, lang)}</span>
    </div>
    <div class="si-sect-body">
      ${body}
      <a class="si-sect-link" href="/analyses/${e(snap.analysisId)}${langQ}">${lang === 'zh' ? '完整观测报告 →' : 'Full observation report →'}</a>
    </div>
  </section>`;
}

// ────────── 主入口 ──────────

export function renderSkillDetail(
  entry: SkillIndexEntry,
  evalReport: EvaluationReport | null,
  lang: Lang = DEFAULT_LANG,
  insights: Insight[] = [],
): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const reportCount = [entry.doctor, entry.eval, entry.observe].filter(Boolean).length;
  const lastTs = [entry.doctor?.timestamp, entry.eval?.timestamp, entry.observe?.generatedAt]
    .filter((s): s is string => Boolean(s)).sort().pop();

  return layout(entry.skillName, `
    <main>
      <a class="si-back" href="/${langQ}">${lang === 'zh' ? '← 返回 Skills' : '← Back to Skills'}</a>
      ${renderHero(entry, insights, lastTs, reportCount, lang)}

      <div class="si-overview">
        <section class="si-overview-cards" aria-label="${lang === 'zh' ? '三视角速览' : 'View summary'}">
          ${renderViewSummaryCards(entry, lang)}
        </section>
        <section class="si-overview-trend">
          <div class="si-trend-h">📈 ${lang === 'zh' ? '健康趋势(0-100%)' : 'Trend (0-100%)'}</div>
          ${renderTrendChart(entry, langQ, lang)}
        </section>
      </div>

      ${renderDoctorSection(entry.doctor, lang)}
      ${renderEvalSection(entry.eval, evalReport, langQ, lang)}
      ${renderObserveSection(entry.observe, langQ, lang)}
    </main>
    <style>${SKILL_DETAIL_CSS}</style>
    ${TREND_INIT_SCRIPT}
  `, lang);
}
