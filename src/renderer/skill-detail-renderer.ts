/**
 * Skill 详情页(insight-first)— 把"问题"作为一等公民,4 个 perspective 退化成
 * Insight 的证据来源。布局:
 *
 *   ╭─ skill 综合 status / 名称 / 报告统计 ──────────╮
 *   ├─ 🔴 高风险 insight 列表 ───────────────────────┤
 *   │   每条 insight = 标题 + 严重度 + 影响范围 +
 *   │   证据 row(每个 perspective 单行,显示 flagged /
 *   │   blind / silent / na)+ 建议 list                │
 *   ├─ 🟡 中风险 insight ────────────────────────────┤
 *   ├─ 🟢 低风险 insight ────────────────────────────┤
 *   ├─ ✅ 已通过 / 健康项 提示 ──────────────────────┤
 *   ├─ 🎯 行动 todo(insight 推荐去重 + 按优先级)─────┤
 *   ╰─ ▾ 逐 perspective 原始数据(默认折叠)─────────╯
 *
 * 不再分 4 张独立卡平铺,卡片内容折叠到底部。
 */
import { layout, e, DEFAULT_LANG } from './layout.js';
import type { Lang, EvaluationReport } from '../types/index.js';
import type { SkillIndexEntry, SkillDoctorSnapshot, SkillEvalSnapshot, SkillObserveSnapshot } from '../server/skill-index.js';
import type { Insight, InsightSeverity, InsightEvidence, InsightPerspective } from '../server/skill-insights.js';
import { detectInsights, flattenRecommendations } from '../server/skill-insights.js';
import type { DoctorRuleResult } from '../types/doctor.js';

const BAND_DOT: Record<'green' | 'yellow' | 'red' | 'gray', string> = {
  green: '🟢', yellow: '🟡', red: '🔴', gray: '⚪',
};

const SEVERITY_ICON: Record<InsightSeverity, string> = {
  high: '🔴',
  medium: '🟡',
  low: '🟢',
};

const SEVERITY_LABEL_ZH: Record<InsightSeverity, string> = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
};

const SEVERITY_LABEL_EN: Record<InsightSeverity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const PERSPECTIVE_ZH: Record<InsightPerspective, string> = {
  doctor: '静态体检',
  'eval-score': '评分视角',
  'eval-functional': '功能视角',
  observe: '线上观测',
};

const PERSPECTIVE_EN: Record<InsightPerspective, string> = {
  doctor: 'Static check',
  'eval-score': 'Score view',
  'eval-functional': 'Functional view',
  observe: 'Production',
};

const STATUS_ICON: Record<InsightEvidence['status'], string> = {
  flagged: '✗',
  blind: '👁',
  silent: '○',
  na: '—',
};

const STATUS_HINT_ZH: Record<InsightEvidence['status'], string> = {
  flagged: '此 perspective 报了该问题',
  blind: '盲区:本应卡住却没卡 — 改进信号',
  silent: '检查过但无信号',
  na: '未运行,无法对照',
};

const STATUS_HINT_EN: Record<InsightEvidence['status'], string> = {
  flagged: 'This perspective flagged the issue',
  blind: 'Blind spot: should have caught it but did not — signal to improve',
  silent: 'Checked but no signal',
  na: 'Not run, no comparison available',
};

function relTime(ts: string | null | undefined, lang: Lang): string {
  if (!ts) return lang === 'zh' ? '未跑' : 'never';
  try {
    const past = new Date(ts).getTime();
    const diff = Math.max(0, Date.now() - past);
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return lang === 'zh' ? `${mins} 分钟前` : `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return lang === 'zh' ? `${hours}h 前` : `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return lang === 'zh' ? `${days}d 前` : `${days}d ago`;
  } catch { return ''; }
}

// ────────── Insight 卡片渲染 ──────────

function renderEvidenceRow(ev: InsightEvidence, lang: Lang): string {
  const persp = lang === 'zh' ? PERSPECTIVE_ZH[ev.perspective] : PERSPECTIVE_EN[ev.perspective];
  const hint = lang === 'zh' ? STATUS_HINT_ZH[ev.status] : STATUS_HINT_EN[ev.status];
  return `<div class="si-ev si-ev--${ev.status}">
    <span class="si-ev-icon" title="${e(hint)}">${STATUS_ICON[ev.status]}</span>
    <span class="si-ev-perspective">${e(persp)}</span>
    <span class="si-ev-msg">${e(ev.message)}</span>
  </div>`;
}

function renderInsightCard(ins: Insight, lang: Lang): string {
  const severityIcon = SEVERITY_ICON[ins.severity];
  const severityLabel = lang === 'zh' ? SEVERITY_LABEL_ZH[ins.severity] : SEVERITY_LABEL_EN[ins.severity];
  const affectedLabel = ins.affectedCount > 0
    ? (lang === 'zh' ? `影响 ${ins.affectedCount}` : `affects ${ins.affectedCount}`)
    : '';
  return `<article class="si-insight si-insight--${ins.severity}">
    <header class="si-h">
      <span class="si-sev">${severityIcon}</span>
      <h3 class="si-title">${e(ins.title)}</h3>
      <span class="si-sev-tag si-sev-tag--${ins.severity}">${e(severityLabel)}</span>
      ${affectedLabel ? `<span class="si-affect">· ${e(affectedLabel)}</span>` : ''}
    </header>
    <section class="si-evidence">
      <div class="si-evidence-h">${lang === 'zh' ? '⛳ 证据' : '⛳ Evidence'}</div>
      ${ins.evidence.map((ev) => renderEvidenceRow(ev, lang)).join('')}
    </section>
    ${ins.recommendations.length > 0 ? `<section class="si-recs">
      <div class="si-recs-h">${lang === 'zh' ? '💡 建议' : '💡 Recommendations'}</div>
      <ul>${ins.recommendations.map((r) =>
        `<li><span class="si-rec-pri si-rec-pri--${r.priority}">${e(SEVERITY_LABEL_ZH[r.priority])}</span> ${e(r.action)}</li>`,
      ).join('')}</ul>
    </section>` : ''}
  </article>`;
}

function renderInsightGroup(insights: Insight[], severity: InsightSeverity, lang: Lang): string {
  const filtered = insights.filter((i) => i.severity === severity);
  if (filtered.length === 0) return '';
  const heading = lang === 'zh'
    ? `${SEVERITY_ICON[severity]} ${SEVERITY_LABEL_ZH[severity]} (${filtered.length})`
    : `${SEVERITY_ICON[severity]} ${SEVERITY_LABEL_EN[severity]} (${filtered.length})`;
  return `<section class="si-group si-group--${severity}">
    <h2 class="si-group-h">${heading}</h2>
    ${filtered.map((i) => renderInsightCard(i, lang)).join('')}
  </section>`;
}

// ────────── 行动 todo ──────────

function renderActionTodos(insights: Insight[], lang: Lang): string {
  const recs = flattenRecommendations(insights);
  if (recs.length === 0) {
    return `<section class="si-todos">
      <h2>${lang === 'zh' ? '🎯 行动 todo' : '🎯 Action items'}</h2>
      <p class="si-todos-empty">${lang === 'zh' ? '暂无自动 detect 出的待办。' : 'No auto-detected actions.'}</p>
    </section>`;
  }
  return `<section class="si-todos">
    <h2>${lang === 'zh' ? '🎯 行动 todo' : '🎯 Action items'}</h2>
    <p class="si-todos-note">${lang === 'zh' ? '从所有 insight 推荐去重汇总,按优先级排' : 'Deduplicated across all insights, sorted by priority'}</p>
    <ul class="si-todos-list">
      ${recs.map((r) => `<li>
        <span class="si-todos-pri si-todos-pri--${r.priority}">${e(lang === 'zh' ? SEVERITY_LABEL_ZH[r.priority] : SEVERITY_LABEL_EN[r.priority])}</span>
        <span class="si-todos-action">${e(r.action)}</span>
      </li>`).join('')}
    </ul>
  </section>`;
}

// ────────── 折叠的逐 perspective 原始数据 ──────────

function renderRuleResultLine(r: DoctorRuleResult, lang: Lang): string {
  const icon = r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : r.status === 'fail' ? '✗' : '○';
  const cls = r.status === 'pass' ? 'pass' : r.status === 'warn' ? 'warn' : r.status === 'fail' ? 'fail' : 'gray';
  return `<li class="si-rule si-rule--${cls}">
    <span class="si-rule-icon">${icon}</span>
    <code class="si-rule-id">${e(r.ruleId)}</code>
    <span class="si-rule-msg">${e(r.message)}</span>
    ${r.hint ? `<div class="si-rule-hint">💡 ${e(r.hint)}</div>` : ''}
  </li>`;
  void lang;
}

function renderDoctorRaw(snap: SkillDoctorSnapshot | null, lang: Lang): string {
  if (!snap) {
    return `<div class="si-raw-empty">${lang === 'zh' ? '⚪ 未运行 omk doctor' : '⚪ omk doctor not run'}</div>`;
  }
  return `<div class="si-raw-block">
    <div class="si-raw-meta">${snap.passCount}✓ · ${snap.warnCount}⚠ · ${snap.failCount}✗ · ${relTime(snap.timestamp, lang)}</div>
    <ul class="si-rules">${snap.results.map((r) => renderRuleResultLine(r, lang)).join('')}</ul>
  </div>`;
}

function renderEvalScoreRaw(
  snap: SkillEvalSnapshot | null,
  evalReport: EvaluationReport | null,
  langQ: string,
  lang: Lang,
): string {
  if (!snap) {
    return `<div class="si-raw-empty">${lang === 'zh' ? '⚪ 未运行 omk eval' : '⚪ omk eval not run'}</div>`;
  }
  let layered: { factScore?: number; behaviorScore?: number; judgeScore?: number } | undefined;
  if (evalReport && snap.variantName) {
    const factVals: number[] = [];
    const behaviorVals: number[] = [];
    const judgeVals: number[] = [];
    for (const r of evalReport.results) {
      const v = r.variants?.[snap.variantName];
      if (!v?.layeredScores) continue;
      if (v.layeredScores.factScore != null) factVals.push(v.layeredScores.factScore);
      if (v.layeredScores.behaviorScore != null) behaviorVals.push(v.layeredScores.behaviorScore);
      if (v.layeredScores.judgeScore != null) judgeVals.push(v.layeredScores.judgeScore);
    }
    const mean = (xs: number[]): number | undefined => xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined;
    layered = { factScore: mean(factVals), behaviorScore: mean(behaviorVals), judgeScore: mean(judgeVals) };
  }
  const fmt = (v?: number): string => v != null ? v.toFixed(2) : '—';
  return `<div class="si-raw-block">
    <div class="si-raw-meta">verdict <strong>${e(snap.verdictLevel.replace(/_/g, ' ').toUpperCase())}</strong> · ${lang === 'zh' ? '综合分' : 'composite'} ${fmt(snap.compositeScore ?? undefined)} · ${relTime(snap.timestamp, lang)}</div>
    <div class="si-raw-bars">
      <div>${lang === 'zh' ? '事实层' : 'fact'} ${fmt(layered?.factScore)}</div>
      <div>${lang === 'zh' ? '行为层' : 'behavior'} ${fmt(layered?.behaviorScore)}</div>
      <div>${lang === 'zh' ? 'LLM 评价' : 'judge'} ${fmt(layered?.judgeScore)}</div>
    </div>
    ${snap.verdictHeadline ? `<p class="si-raw-headline">${e(snap.verdictHeadline)}</p>` : ''}
    <a class="si-raw-link" href="/reports/${e(snap.reportId)}${langQ}">${lang === 'zh' ? '完整 A/B 报告 →' : 'Full A/B report →'}</a>
  </div>`;
}

function renderEvalFuncRaw(
  snap: SkillEvalSnapshot | null,
  evalReport: EvaluationReport | null,
  langQ: string,
  lang: Lang,
): string {
  if (!snap) {
    return `<div class="si-raw-empty">${lang === 'zh' ? '⚪ 未运行 omk eval' : '⚪ omk eval not run'}</div>`;
  }
  const failed: Array<{ id: string; modes: string[]; summary: string }> = [];
  if (evalReport && snap.variantName) {
    for (const r of evalReport.results) {
      const v = r.variants?.[snap.variantName];
      if (!v) continue;
      const passed = (v.assertions?.details ?? []).every((d) => d.passed);
      if (passed) continue;
      const isTripwire = (v.diagnostic?.rootCause || []).includes('tripwire_intentional')
        || evalReport.sampleSnapshots?.[r.sample_id]?.tripwire === true;
      if (isTripwire) continue;
      failed.push({
        id: r.sample_id,
        modes: (v.diagnostic?.failureModes ?? []) as string[],
        summary: v.diagnostic?.summary?.slice(0, 80) || '',
      });
    }
  }
  return `<div class="si-raw-block">
    <div class="si-raw-meta">${snap.passCount}✓ · ${snap.failCount}✗ · ${snap.tripwireCount > 0 ? `${snap.tripwireCount} ${lang === 'zh' ? '诱错' : 'tripwire'} · ` : ''}${relTime(snap.timestamp, lang)}</div>
    ${failed.length > 0 ? `<ul class="si-failed-list">${failed.slice(0, 6).map((f) =>
      `<li><code>${e(f.id)}</code> ${f.modes.map((m) => `<span class="si-mode">${e(m)}</span>`).join('')} ${f.summary ? `<span class="si-fs-summary">${e(f.summary)}${f.summary.length >= 80 ? '…' : ''}</span>` : ''}</li>`,
    ).join('')}</ul>` : ''}
    <a class="si-raw-link" href="/reports/${e(snap.reportId)}${langQ}#test-view">${lang === 'zh' ? '展开单测视角 →' : 'Open functional view →'}</a>
  </div>`;
}

function renderObserveRaw(snap: SkillObserveSnapshot | null, langQ: string, lang: Lang): string {
  if (!snap) {
    return `<div class="si-raw-empty">${lang === 'zh' ? '⚪ 未运行 omk observe' : '⚪ omk observe not run'}</div>`;
  }
  return `<div class="si-raw-block">
    <div class="si-raw-meta">${BAND_DOT[snap.healthBand]} ${snap.healthBand} · ${snap.segmentCount} ${lang === 'zh' ? '段' : 'segments'} · ${lang === 'zh' ? '工具失败率' : 'tool failure'} ${(snap.failureRate * 100).toFixed(1)}% · ${lang === 'zh' ? '知识库 gap' : 'KB gap'} ${(snap.gapRate * 100).toFixed(0)}% · ${relTime(snap.generatedAt, lang)}</div>
    <a class="si-raw-link" href="/analyses/${e(snap.analysisId)}${langQ}">${lang === 'zh' ? '完整观测报告 →' : 'Full observation report →'}</a>
  </div>`;
}

function renderRawDataSection(
  entry: SkillIndexEntry,
  evalReport: EvaluationReport | null,
  langQ: string,
  lang: Lang,
): string {
  return `<details class="si-raw-section">
    <summary>${lang === 'zh' ? '▾ 逐 perspective 原始数据' : '▾ Raw data per perspective'}</summary>
    <div class="si-raw-grid">
      <div class="si-raw-card">
        <h4>${lang === 'zh' ? '1️⃣ 静态体检 (doctor)' : '1️⃣ Static (doctor)'}</h4>
        ${renderDoctorRaw(entry.doctor, lang)}
      </div>
      <div class="si-raw-card">
        <h4>${lang === 'zh' ? '2️⃣ 评分视角' : '2️⃣ Score view'}</h4>
        ${renderEvalScoreRaw(entry.eval, evalReport, langQ, lang)}
      </div>
      <div class="si-raw-card">
        <h4>${lang === 'zh' ? '3️⃣ 功能视角' : '3️⃣ Functional view'}</h4>
        ${renderEvalFuncRaw(entry.eval, evalReport, langQ, lang)}
      </div>
      <div class="si-raw-card">
        <h4>${lang === 'zh' ? '4️⃣ 线上观测' : '4️⃣ Production observation'}</h4>
        ${renderObserveRaw(entry.observe, langQ, lang)}
      </div>
    </div>
  </details>`;
}

// ────────── CSS ──────────

const SKILL_INSIGHT_CSS = `
.si-back { display:inline-block;margin-bottom:8px;color:var(--text-muted);font-size:13px;text-decoration:none }
.si-back:hover { color:var(--text-primary) }

/* 顶部综合 */
.si-overall { display:flex;align-items:center;gap:14px;padding:18px 22px;background:var(--bg-soft);border-radius:8px;margin:8px 0 24px }
.si-overall-band { font-size:26px }
.si-overall-name { font-size:22px;font-weight:600;color:var(--text-primary) }
.si-overall-meta { color:var(--text-muted);font-size:13px;margin-left:auto }

/* Insight 列表 */
.si-empty-state { text-align:center;color:var(--text-muted);padding:40px 20px;font-size:14px }
.si-group { margin-bottom:24px }
.si-group-h { font-size:14px;font-weight:600;color:var(--text-secondary);margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid var(--border);letter-spacing:0.02em }
.si-insight { background:var(--bg-surface);padding:18px 22px;margin-bottom:12px;border-radius:8px;box-shadow:var(--shadow-sm) }
.si-insight--high { border-left:3px solid #9c4a3f }
.si-insight--medium { border-left:3px solid #b08030 }
.si-insight--low { border-left:3px solid #5e8252 }
.si-h { display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap }
.si-sev { font-size:18px }
.si-title { margin:0;font-size:16px;font-weight:600;color:var(--text-primary);flex:1;min-width:200px }
.si-sev-tag { padding:2px 8px;border-radius:11px;font-size:11px;font-weight:600 }
.si-sev-tag--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-sev-tag--medium { background:rgba(176,128,48,.12);color:#b08030 }
.si-sev-tag--low { background:rgba(94,130,82,.14);color:#5e8252 }
.si-affect { color:var(--text-muted);font-size:12.5px }

/* 证据 row */
.si-evidence { background:var(--bg-soft);padding:12px 14px;border-radius:6px;margin-bottom:10px }
.si-evidence-h { font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;letter-spacing:0.02em }
.si-ev { display:grid;grid-template-columns:24px 100px 1fr;gap:10px;align-items:start;padding:4px 0;font-size:13px;line-height:1.55 }
.si-ev-icon { text-align:center;font-weight:600;flex-shrink:0;cursor:help }
.si-ev--flagged .si-ev-icon { color:#9c4a3f }
.si-ev--blind .si-ev-icon { color:#7a6b89 }
.si-ev--silent .si-ev-icon { color:#7a9270 }
.si-ev--na .si-ev-icon { color:var(--text-muted) }
.si-ev-perspective { color:var(--text-secondary);font-weight:500 }
.si-ev-msg { color:var(--text-primary);min-width:0 }

/* 建议 */
.si-recs { padding:8px 0 0 }
.si-recs-h { font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;letter-spacing:0.02em }
.si-recs ul { margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:5px }
.si-recs li { display:flex;gap:8px;align-items:flex-start;font-size:13.5px;line-height:1.55;color:var(--text-primary) }
.si-rec-pri { padding:1px 6px;border-radius:8px;font-size:10.5px;font-weight:600;flex-shrink:0;margin-top:2px }
.si-rec-pri--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-rec-pri--medium { background:rgba(176,128,48,.12);color:#b08030 }
.si-rec-pri--low { background:rgba(94,130,82,.14);color:#5e8252 }

/* 行动 todo */
.si-todos { background:rgba(94,130,82,.04);border-left:3px solid #5e8252;padding:18px 22px;margin:24px 0 16px;border-radius:8px }
.si-todos h2 { margin:0 0 6px;font-size:16px;color:var(--text-primary) }
.si-todos-note { color:var(--text-muted);font-size:12px;margin:0 0 12px }
.si-todos-empty { color:var(--text-muted);font-size:13px;font-style:italic }
.si-todos-list { margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:8px }
.si-todos-list li { display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.6 }
.si-todos-pri { padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;flex-shrink:0;margin-top:1px }
.si-todos-pri--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-todos-pri--medium { background:rgba(176,128,48,.12);color:#b08030 }
.si-todos-pri--low { background:rgba(94,130,82,.14);color:#5e8252 }
.si-todos-action { color:var(--text-primary) }

/* 折叠的 raw 数据 */
.si-raw-section { margin-top:24px;padding:14px 18px;background:var(--bg-soft);border-radius:8px }
.si-raw-section > summary { cursor:pointer;font-size:13.5px;font-weight:600;color:var(--text-secondary);list-style:none;padding:4px 0 }
.si-raw-section > summary::-webkit-details-marker { display:none }
.si-raw-section[open] > summary { margin-bottom:14px }
.si-raw-grid { display:grid;grid-template-columns:1fr 1fr;gap:14px }
@media (max-width:760px) { .si-raw-grid { grid-template-columns:1fr } }
.si-raw-card { background:var(--bg-surface);border-radius:6px;padding:14px 16px;box-shadow:var(--shadow-sm) }
.si-raw-card h4 { margin:0 0 10px;font-size:13px;color:var(--text-primary);font-weight:600 }
.si-raw-empty { color:var(--text-muted);font-size:12.5px;font-style:italic }
.si-raw-block { font-size:13px;line-height:1.6 }
.si-raw-meta { color:var(--text-secondary);font-size:12.5px;margin-bottom:10px }
.si-raw-bars { display:flex;gap:14px;font-size:12.5px;color:var(--text-secondary);margin-bottom:8px;flex-wrap:wrap }
.si-raw-headline { font-size:12.5px;color:var(--text-secondary);font-style:italic;margin:6px 0;line-height:1.5 }
.si-raw-link { display:inline-block;margin-top:8px;color:var(--accent);font-size:12.5px;text-decoration:none;font-weight:500 }
.si-raw-link:hover { text-decoration:underline }
.si-rules { list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px }
.si-rule { display:grid;grid-template-columns:16px auto 1fr;gap:8px;font-size:12.5px;line-height:1.5;align-items:start;padding:4px 0 }
.si-rule-icon { font-weight:600;text-align:center }
.si-rule--pass .si-rule-icon { color:#5e8252 }
.si-rule--warn .si-rule-icon { color:#b08030 }
.si-rule--fail .si-rule-icon { color:#9c4a3f }
.si-rule-id { font-size:11px;background:var(--bg-soft);padding:1px 5px;border-radius:3px;color:var(--text-muted);grid-column:2 }
.si-rule-msg { color:var(--text-primary);grid-column:3 }
.si-rule-hint { grid-column:2 / 4;color:var(--text-secondary);font-size:11.5px;margin-top:2px }
.si-failed-list { margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:5px;margin-bottom:8px }
.si-failed-list li { font-size:12.5px;line-height:1.5;display:flex;flex-wrap:wrap;gap:5px;align-items:baseline }
.si-failed-list code { font-size:11px;background:var(--bg-soft);padding:1px 5px;border-radius:3px }
.si-mode { font-size:10.5px;background:rgba(176,128,48,.10);color:#b08030;padding:1px 5px;border-radius:8px }
.si-fs-summary { color:var(--text-secondary);font-size:11.5px;flex:1;min-width:0 }
`;

// ────────── 入口 ──────────

export function renderSkillDetail(
  entry: SkillIndexEntry,
  evalReport: EvaluationReport | null,
  lang: Lang = DEFAULT_LANG,
): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const insights = detectInsights(entry, evalReport);

  const reportCount = [entry.doctor, entry.eval, entry.observe].filter(Boolean).length;
  const lastTs = [entry.doctor?.timestamp, entry.eval?.timestamp, entry.observe?.generatedAt]
    .filter((s): s is string => Boolean(s)).sort().pop();

  const insightsHtml = insights.length === 0
    ? `<section class="si-empty-state">
        <p>${lang === 'zh' ? '✅ 没检测到自动可识别的问题。' : '✅ No auto-detected issues.'}</p>
        <p>${lang === 'zh' ? '展开下方"逐 perspective 原始数据"看完整报告。' : 'Expand the raw data section below to see full reports.'}</p>
      </section>`
    : [
        renderInsightGroup(insights, 'high', lang),
        renderInsightGroup(insights, 'medium', lang),
        renderInsightGroup(insights, 'low', lang),
      ].join('');

  return layout(entry.skillName, `
    <main>
      <a class="si-back" href="/${langQ}">${lang === 'zh' ? '← 返回 Skills' : '← Back to Skills'}</a>
      <div class="si-overall">
        <span class="si-overall-band">${BAND_DOT[entry.band]}</span>
        <span class="si-overall-name">${e(entry.skillName)}</span>
        <span class="si-overall-meta">
          ${lang === 'zh' ? '已有报告' : 'reports'}: ${reportCount} / 3
          · ${lang === 'zh' ? '最近活动' : 'last activity'}: ${relTime(lastTs, lang)}
          · ${lang === 'zh' ? '检测到 insight' : 'insights'}: ${insights.length}
        </span>
      </div>
      ${insightsHtml}
      ${insights.length > 0 ? renderActionTodos(insights, lang) : ''}
      ${renderRawDataSection(entry, evalReport, langQ, lang)}
    </main>
    <style>${SKILL_INSIGHT_CSS}</style>
  `, lang);
}
