/**
 * Skill 详情页(insight-first + 受众分区)— 把"问题"作为一等公民,按"该谁修"分区。
 *
 * 布局:
 *   ╭─ 综合 status / 名称 / 报告统计 ──────────╮
 *   ├─ 📝 改我的 skill (audience=skill-author) ──╮
 *   │   每条 insight = 用户语标题 + 严重度 + 影响范围
 *   │   + 证据 row(perspective + ✗👁○— + 一句话)
 *   │   + 现象证据(展开看真实 prompt / LLM 输出 / 工具调用)
 *   │   + 推荐 list(可粘贴 patch 代码块)              │
 *   ├─ 🔧 改我的 sample (audience=sample-author) ─┤
 *   ├─ ⚙️ omk 工具反馈(默认折叠,普通用户可忽略)─┤
 *   ├─ 🎯 行动 todo(按 audience 分桶汇总)──────┤
 *   ╰─ ▾ 逐 perspective 原始数据(默认折叠)────╯
 */
import { layout, e, DEFAULT_LANG } from './layout.js';
import type { Lang, EvaluationReport } from '../types/index.js';
import type { SkillIndexEntry, SkillDoctorSnapshot, SkillEvalSnapshot, SkillObserveSnapshot } from '../server/skill-index.js';
import type { Insight, InsightSeverity, InsightEvidence, InsightPerspective, InsightAudience, InsightIllustration, InsightPatch } from '../server/skill-insights.js';
import { detectInsights, flattenRecommendations, groupInsightsByAudience } from '../server/skill-insights.js';
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
const STATUS_HINT_ZH: Record<InsightEvidence['status'], string> = {
  flagged: '此 perspective 报了该问题',
  blind: '盲区:本应该看到却没卡 — 改进信号',
  silent: '检查过但无信号',
  na: '未运行,无法对照',
};
const STATUS_HINT_EN: Record<InsightEvidence['status'], string> = {
  flagged: 'This perspective flagged the issue',
  blind: 'Blind spot: should have caught but did not',
  silent: 'Checked but no signal',
  na: 'Not run',
};

const AUDIENCE_INFO_ZH: Record<InsightAudience, { icon: string; title: string; subtitle: string }> = {
  'skill-author': {
    icon: '📝',
    title: '改我的 skill',
    subtitle: 'skill 文档需要调整 — 主要改 SKILL.md',
  },
  'sample-author': {
    icon: '🔧',
    title: '改我的 sample',
    subtitle: 'sample / mock 设计需要调整 — 主要改 samples.json,不动 skill',
  },
  'omk-maintainer': {
    icon: '⚙️',
    title: 'omk 工具反馈',
    subtitle: '这部分是给 omk 维护者的待办(doctor 加规则等),普通 skill 开发者可忽略',
  },
};
const AUDIENCE_INFO_EN: Record<InsightAudience, { icon: string; title: string; subtitle: string }> = {
  'skill-author': { icon: '📝', title: 'Changes to my skill', subtitle: 'Update SKILL.md content' },
  'sample-author': { icon: '🔧', title: 'Changes to my sample', subtitle: 'Update samples.json (mocks / environment), skill stays unchanged' },
  'omk-maintainer': { icon: '⚙️', title: 'omk tool feedback', subtitle: 'Action items for the omk maintainers (e.g., add doctor rules); regular skill authors may skip' },
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

function relTime(ts: string | null | undefined, lang: Lang): string {
  if (!ts) return lang === 'zh' ? '未跑' : 'never';
  try {
    const past = new Date(ts).getTime();
    const diff = Math.max(0, Date.now() - past);
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return lang === 'zh' ? `${mins} 分钟前` : `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return lang === 'zh' ? `${hours}h 前` : `${hours}h ago`;
    return lang === 'zh' ? `${Math.floor(hours / 24)}d 前` : `${Math.floor(hours / 24)}d ago`;
  } catch { return ''; }
}

// ────────── Insight 渲染 ──────────

function renderIllustration(ill: InsightIllustration, lang: Lang): string {
  const promptLine = ill.samplePrompt
    ? `<div class="si-ill-row"><span class="si-ill-label">${lang === 'zh' ? '用户 prompt' : 'user prompt'}</span><span class="si-ill-text">${e(ill.samplePrompt)}${ill.samplePrompt.length >= 200 ? '…' : ''}</span></div>`
    : '';
  const outputLine = ill.llmOutput
    ? `<div class="si-ill-row"><span class="si-ill-label">${lang === 'zh' ? 'LLM 输出' : 'LLM output'}</span><span class="si-ill-text">${e(ill.llmOutput)}${ill.llmOutput.length >= 200 ? '…' : ''}</span></div>`
    : '';
  const toolsLine = ill.toolCalls && ill.toolCalls.length > 0
    ? `<div class="si-ill-row"><span class="si-ill-label">${lang === 'zh' ? 'LLM 调用' : 'tool calls'}</span><ul class="si-ill-tools">${ill.toolCalls.map((tc) => `<li>${e(tc)}</li>`).join('')}</ul></div>`
    : '';
  const failLine = ill.failedAssertion
    ? `<div class="si-ill-row"><span class="si-ill-label">${lang === 'zh' ? '断言失败' : 'failed assertion'}</span><code class="si-ill-fail">${e(ill.failedAssertion)}</code></div>`
    : '';
  return `<div class="si-illustration">
    <div class="si-ill-h"><code>${e(ill.sampleId)}</code></div>
    ${promptLine}${outputLine}${toolsLine}${failLine}
  </div>`;
}

function renderEvidenceRow(ev: InsightEvidence, lang: Lang): string {
  const persp = lang === 'zh' ? PERSPECTIVE_ZH[ev.perspective] : PERSPECTIVE_EN[ev.perspective];
  const hint = lang === 'zh' ? STATUS_HINT_ZH[ev.status] : STATUS_HINT_EN[ev.status];
  const illsHtml = ev.illustrations && ev.illustrations.length > 0
    ? `<details class="si-ev-ill-toggle">
        <summary>${lang === 'zh' ? '展开看 LLM 实际是怎么错的' : 'Show what LLM actually did'}</summary>
        <div class="si-ev-ill-body">${ev.illustrations.map((i) => renderIllustration(i, lang)).join('')}</div>
       </details>`
    : '';
  return `<div class="si-ev si-ev--${ev.status}">
    <div class="si-ev-line">
      <span class="si-ev-icon" title="${e(hint)}">${STATUS_ICON[ev.status]}</span>
      <span class="si-ev-perspective">${e(persp)}</span>
      <span class="si-ev-msg">${e(ev.message)}</span>
    </div>
    ${illsHtml}
  </div>`;
}

function renderPatch(patch: InsightPatch, lang: Lang): string {
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

function renderInsightCard(ins: Insight, lang: Lang): string {
  const sevIcon = SEVERITY_ICON[ins.severity];
  const sevLabel = lang === 'zh' ? SEVERITY_LABEL_ZH[ins.severity] : SEVERITY_LABEL_EN[ins.severity];
  const affect = ins.affectedCount > 0
    ? (lang === 'zh' ? `影响 ${ins.affectedCount}` : `affects ${ins.affectedCount}`)
    : '';

  return `<article class="si-insight si-insight--${ins.severity}">
    <header class="si-h">
      <span class="si-sev">${sevIcon}</span>
      <h3 class="si-title">${e(ins.title)}</h3>
      <span class="si-sev-tag si-sev-tag--${ins.severity}">${e(sevLabel)}</span>
      ${affect ? `<span class="si-affect">· ${e(affect)}</span>` : ''}
    </header>
    ${ins.description ? `<p class="si-desc">${e(ins.description)}</p>` : ''}
    <section class="si-evidence">
      <div class="si-evidence-h">${lang === 'zh' ? '⛳ 证据' : '⛳ Evidence'}</div>
      ${ins.evidence.map((ev) => renderEvidenceRow(ev, lang)).join('')}
    </section>
    ${ins.recommendations.length > 0 ? `<section class="si-recs">
      <div class="si-recs-h">${lang === 'zh' ? '💡 建议' : '💡 Recommendations'}</div>
      <ul>${ins.recommendations.map((r) => `<li>
        <div class="si-rec-line">
          <span class="si-rec-pri si-rec-pri--${r.priority}">${e(lang === 'zh' ? SEVERITY_LABEL_ZH[r.priority] : SEVERITY_LABEL_EN[r.priority])}</span>
          <span class="si-rec-action">${e(r.action)}</span>
        </div>
        ${r.patch ? renderPatch(r.patch, lang) : ''}
      </li>`).join('')}</ul>
    </section>` : ''}
  </article>`;
}

// ────────── 受众分区 ──────────

function renderAudienceSection(
  audience: InsightAudience,
  insights: Insight[],
  lang: Lang,
  collapsed: boolean,
): string {
  const info = lang === 'zh' ? AUDIENCE_INFO_ZH[audience] : AUDIENCE_INFO_EN[audience];
  const count = insights.length;
  if (count === 0) return '';
  const innerHtml = insights.map((ins) => renderInsightCard(ins, lang)).join('');

  if (collapsed) {
    return `<details class="si-audience si-audience--${audience}">
      <summary class="si-audience-h">
        <span class="si-audience-icon">${info.icon}</span>
        <span class="si-audience-title">${e(info.title)}</span>
        <span class="si-audience-count">${count}</span>
        <span class="si-audience-sub">${e(info.subtitle)}</span>
      </summary>
      <div class="si-audience-body">${innerHtml}</div>
    </details>`;
  }
  return `<section class="si-audience si-audience--${audience} si-audience--open">
    <div class="si-audience-h">
      <span class="si-audience-icon">${info.icon}</span>
      <span class="si-audience-title">${e(info.title)}</span>
      <span class="si-audience-count">${count}</span>
      <span class="si-audience-sub">${e(info.subtitle)}</span>
    </div>
    <div class="si-audience-body">${innerHtml}</div>
  </section>`;
}

// ────────── 行动 todo(按受众分桶) ──────────

function renderActionTodos(insights: Insight[], lang: Lang): string {
  if (insights.length === 0) return '';
  const grouped = groupInsightsByAudience(insights);
  const buckets: Array<{ audience: InsightAudience; recs: ReturnType<typeof flattenRecommendations> }> = [];
  for (const aud of ['skill-author', 'sample-author', 'omk-maintainer'] as InsightAudience[]) {
    const audInsights = grouped[aud];
    if (audInsights.length === 0) continue;
    const recs = flattenRecommendations(audInsights);
    if (recs.length > 0) buckets.push({ audience: aud, recs });
  }
  if (buckets.length === 0) return '';

  return `<section class="si-todos">
    <h2>${lang === 'zh' ? '🎯 行动 todo' : '🎯 Action items'}</h2>
    <p class="si-todos-note">${lang === 'zh' ? '按受众分桶,各组内按优先级排' : 'Bucketed by audience, sorted by priority'}</p>
    ${buckets.map(({ audience, recs }) => {
      const info = lang === 'zh' ? AUDIENCE_INFO_ZH[audience] : AUDIENCE_INFO_EN[audience];
      return `<div class="si-todos-bucket">
        <h3 class="si-todos-bucket-h">${info.icon} ${e(info.title)} <span class="si-todos-bucket-count">${recs.length}</span></h3>
        <ul class="si-todos-list">
          ${recs.map((r) => `<li>
            <span class="si-todos-pri si-todos-pri--${r.priority}">${e(lang === 'zh' ? SEVERITY_LABEL_ZH[r.priority] : SEVERITY_LABEL_EN[r.priority])}</span>
            <span class="si-todos-action">${e(r.action)}</span>
          </li>`).join('')}
        </ul>
      </div>`;
    }).join('')}
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
  if (!snap) return `<div class="si-raw-empty">${lang === 'zh' ? '⚪ 未运行 omk doctor' : '⚪ omk doctor not run'}</div>`;
  return `<div class="si-raw-block">
    <div class="si-raw-meta">${snap.passCount}✓ · ${snap.warnCount}⚠ · ${snap.failCount}✗ · ${relTime(snap.timestamp, lang)}</div>
    <ul class="si-rules">${snap.results.map((r) => renderRuleResultLine(r, lang)).join('')}</ul>
  </div>`;
}

function renderEvalScoreRaw(snap: SkillEvalSnapshot | null, evalReport: EvaluationReport | null, langQ: string, lang: Lang): string {
  if (!snap) return `<div class="si-raw-empty">${lang === 'zh' ? '⚪ 未运行 omk eval' : '⚪ omk eval not run'}</div>`;
  let layered: { factScore?: number; behaviorScore?: number; judgeScore?: number } | undefined;
  if (evalReport && snap.variantName) {
    const fact: number[] = [], behav: number[] = [], judge: number[] = [];
    for (const r of evalReport.results) {
      const v = r.variants?.[snap.variantName];
      if (!v?.layeredScores) continue;
      if (v.layeredScores.factScore != null) fact.push(v.layeredScores.factScore);
      if (v.layeredScores.behaviorScore != null) behav.push(v.layeredScores.behaviorScore);
      if (v.layeredScores.judgeScore != null) judge.push(v.layeredScores.judgeScore);
    }
    const mean = (xs: number[]): number | undefined => xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined;
    layered = { factScore: mean(fact), behaviorScore: mean(behav), judgeScore: mean(judge) };
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

function renderEvalFuncRaw(snap: SkillEvalSnapshot | null, langQ: string, lang: Lang): string {
  if (!snap) return `<div class="si-raw-empty">${lang === 'zh' ? '⚪ 未运行 omk eval' : '⚪ omk eval not run'}</div>`;
  return `<div class="si-raw-block">
    <div class="si-raw-meta">${snap.passCount}✓ · ${snap.failCount}✗ · ${snap.tripwireCount > 0 ? `${snap.tripwireCount} ${lang === 'zh' ? '诱错' : 'tripwire'} · ` : ''}${relTime(snap.timestamp, lang)}</div>
    <a class="si-raw-link" href="/reports/${e(snap.reportId)}${langQ}#test-view">${lang === 'zh' ? '展开单测视角 →' : 'Open functional view →'}</a>
  </div>`;
}

function renderObserveRaw(snap: SkillObserveSnapshot | null, langQ: string, lang: Lang): string {
  if (!snap) return `<div class="si-raw-empty">${lang === 'zh' ? '⚪ 未运行 omk observe' : '⚪ omk observe not run'}</div>`;
  return `<div class="si-raw-block">
    <div class="si-raw-meta">${BAND_DOT[snap.healthBand]} ${snap.healthBand} · ${snap.segmentCount} ${lang === 'zh' ? '段' : 'segments'} · ${lang === 'zh' ? '工具失败率' : 'tool failure'} ${(snap.failureRate * 100).toFixed(1)}% · ${lang === 'zh' ? '知识库 gap' : 'KB gap'} ${(snap.gapRate * 100).toFixed(0)}% · ${relTime(snap.generatedAt, lang)}</div>
    <a class="si-raw-link" href="/analyses/${e(snap.analysisId)}${langQ}">${lang === 'zh' ? '完整观测报告 →' : 'Full observation report →'}</a>
  </div>`;
}

function renderRawDataSection(entry: SkillIndexEntry, evalReport: EvaluationReport | null, langQ: string, lang: Lang): string {
  return `<details class="si-raw-section">
    <summary>${lang === 'zh' ? '▾ 逐 perspective 原始数据' : '▾ Raw data per perspective'}</summary>
    <div class="si-raw-grid">
      <div class="si-raw-card"><h4>${lang === 'zh' ? '1️⃣ 静态体检 (doctor)' : '1️⃣ Static (doctor)'}</h4>${renderDoctorRaw(entry.doctor, lang)}</div>
      <div class="si-raw-card"><h4>${lang === 'zh' ? '2️⃣ 评分视角' : '2️⃣ Score view'}</h4>${renderEvalScoreRaw(entry.eval, evalReport, langQ, lang)}</div>
      <div class="si-raw-card"><h4>${lang === 'zh' ? '3️⃣ 功能视角' : '3️⃣ Functional view'}</h4>${renderEvalFuncRaw(entry.eval, langQ, lang)}</div>
      <div class="si-raw-card"><h4>${lang === 'zh' ? '4️⃣ 线上观测' : '4️⃣ Production observation'}</h4>${renderObserveRaw(entry.observe, langQ, lang)}</div>
    </div>
  </details>`;
}

// ────────── CSS ──────────

const SKILL_INSIGHT_CSS = `
.si-back { display:inline-block;margin-bottom:8px;color:var(--text-muted);font-size:13px;text-decoration:none }
.si-back:hover { color:var(--text-primary) }

.si-overall { display:flex;align-items:center;gap:14px;padding:18px 22px;background:var(--bg-soft);border-radius:8px;margin:8px 0 24px }
.si-overall-band { font-size:26px }
.si-overall-name { font-size:22px;font-weight:600;color:var(--text-primary) }
.si-overall-meta { color:var(--text-muted);font-size:13px;margin-left:auto }

/* 受众分区 */
.si-audience { margin-bottom:22px }
.si-audience-h { display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;color:var(--text-primary);padding:10px 14px;background:var(--bg-soft);border-radius:6px;cursor:default;margin-bottom:14px;list-style:none }
.si-audience-h::-webkit-details-marker { display:none }
.si-audience--open > .si-audience-h { cursor:default }
details.si-audience > summary.si-audience-h { cursor:pointer }
details.si-audience > summary.si-audience-h::before { content:'▸';color:var(--text-muted);margin-right:4px;display:inline-block;width:14px;font-size:12px }
details.si-audience[open] > summary.si-audience-h::before { content:'▾' }
.si-audience-icon { font-size:18px }
.si-audience-title { color:var(--text-primary) }
.si-audience-count { padding:2px 8px;border-radius:10px;background:var(--bg-surface);font-size:12px;font-weight:600;color:var(--text-secondary) }
.si-audience-sub { color:var(--text-muted);font-size:12px;font-weight:normal;margin-left:auto }
.si-audience-body { display:flex;flex-direction:column;gap:12px }

/* Insight 卡 */
.si-empty-state { text-align:center;color:var(--text-muted);padding:40px 20px;font-size:14px }
.si-insight { background:var(--bg-surface);padding:18px 22px;border-radius:8px;box-shadow:var(--shadow-sm) }
.si-insight--high { border-left:3px solid #9c4a3f }
.si-insight--medium { border-left:3px solid #b08030 }
.si-insight--low { border-left:3px solid #5e8252 }
.si-h { display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap }
.si-sev { font-size:18px }
.si-title { margin:0;font-size:16px;font-weight:600;color:var(--text-primary);flex:1;min-width:200px }
.si-sev-tag { padding:2px 8px;border-radius:11px;font-size:11px;font-weight:600 }
.si-sev-tag--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-sev-tag--medium { background:rgba(176,128,48,.12);color:#b08030 }
.si-sev-tag--low { background:rgba(94,130,82,.14);color:#5e8252 }
.si-affect { color:var(--text-muted);font-size:12.5px }
.si-desc { color:var(--text-secondary);font-size:13.5px;line-height:1.6;margin:6px 0 12px }

/* 证据 */
.si-evidence { background:var(--bg-soft);padding:12px 14px;border-radius:6px;margin-bottom:12px }
.si-evidence-h { font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;letter-spacing:0.02em }
.si-ev { padding:4px 0;font-size:13px;line-height:1.55 }
.si-ev-line { display:grid;grid-template-columns:24px 100px 1fr;gap:10px;align-items:start }
.si-ev-icon { text-align:center;font-weight:600;cursor:help }
.si-ev--flagged .si-ev-icon { color:#9c4a3f }
.si-ev--blind .si-ev-icon { color:#7a6b89 }
.si-ev--silent .si-ev-icon { color:#7a9270 }
.si-ev--na .si-ev-icon { color:var(--text-muted) }
.si-ev-perspective { color:var(--text-secondary);font-weight:500 }
.si-ev-msg { color:var(--text-primary) }

/* 现象证据(illustration) */
.si-ev-ill-toggle { margin-top:6px;margin-left:34px }
.si-ev-ill-toggle > summary { cursor:pointer;font-size:12px;color:var(--accent);list-style:none;padding:2px 0 }
.si-ev-ill-toggle > summary::-webkit-details-marker { display:none }
.si-ev-ill-toggle > summary::before { content:'▸ ';color:var(--text-muted) }
.si-ev-ill-toggle[open] > summary::before { content:'▾ ' }
.si-ev-ill-body { padding:8px 0 4px;display:flex;flex-direction:column;gap:10px }
.si-illustration { background:var(--bg-surface);border-left:2px solid var(--border);padding:8px 12px;border-radius:4px;font-size:12px;line-height:1.6 }
.si-ill-h { margin-bottom:6px }
.si-ill-h code { background:var(--bg-soft);padding:1px 5px;border-radius:3px;font-size:11px }
.si-ill-row { display:grid;grid-template-columns:90px 1fr;gap:8px;align-items:start;margin-bottom:4px }
.si-ill-label { color:var(--text-muted);font-size:11px;font-weight:500;letter-spacing:0.02em }
.si-ill-text { color:var(--text-primary);font-family:"SF Mono",Menlo,monospace;font-size:11.5px;background:var(--bg-soft);padding:4px 8px;border-radius:3px;white-space:pre-wrap;word-break:break-word }
.si-ill-tools { margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:2px }
.si-ill-tools li { font-family:"SF Mono",Menlo,monospace;font-size:11px;background:var(--bg-soft);padding:2px 6px;border-radius:3px }
.si-ill-fail { font-size:11px;background:rgba(156,74,63,.10);color:#9c4a3f;padding:2px 6px;border-radius:3px }

/* 推荐 */
.si-recs { padding:0 }
.si-recs-h { font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;letter-spacing:0.02em }
.si-recs ul { margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:10px }
.si-recs li { font-size:13.5px;line-height:1.55 }
.si-rec-line { display:flex;gap:8px;align-items:flex-start }
.si-rec-pri { padding:1px 7px;border-radius:8px;font-size:10.5px;font-weight:600;flex-shrink:0;margin-top:1px }
.si-rec-pri--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-rec-pri--medium { background:rgba(176,128,48,.12);color:#b08030 }
.si-rec-pri--low { background:rgba(94,130,82,.14);color:#5e8252 }
.si-rec-action { color:var(--text-primary);flex:1 }

/* Patch 代码块 */
.si-patch { margin-top:6px;margin-left:24px }
.si-patch > summary { cursor:pointer;font-size:11.5px;color:var(--accent);list-style:none;padding:2px 0 }
.si-patch > summary::-webkit-details-marker { display:none }
.si-patch > summary::before { content:'▸ ';color:var(--text-muted) }
.si-patch[open] > summary::before { content:'▾ ' }
.si-patch-body { padding:6px 0 4px }
.si-patch-meta { display:flex;gap:8px;margin-bottom:6px;font-size:11px;color:var(--text-muted);align-items:center }
.si-patch-target { font-weight:600;color:var(--text-secondary) }
.si-patch-loc { font-family:"SF Mono",Menlo,monospace }
.si-patch-snippet { background:var(--bg-soft);padding:10px 12px;border-radius:4px;border-left:2px solid var(--accent);font-size:11.5px;line-height:1.55;overflow-x:auto;margin:0 }
.si-patch-snippet code { font-family:"SF Mono",Menlo,monospace;color:var(--text-primary);white-space:pre;display:block }

/* 行动 todo */
.si-todos { background:rgba(94,130,82,.04);border-left:3px solid #5e8252;padding:18px 22px;margin:24px 0 16px;border-radius:8px }
.si-todos h2 { margin:0 0 6px;font-size:16px;color:var(--text-primary) }
.si-todos-note { color:var(--text-muted);font-size:12px;margin:0 0 14px }
.si-todos-bucket { margin-bottom:14px }
.si-todos-bucket-h { display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;color:var(--text-primary);margin:0 0 8px }
.si-todos-bucket-count { padding:1px 7px;background:var(--bg-surface);border-radius:8px;font-size:11px;color:var(--text-secondary);font-weight:500 }
.si-todos-list { margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:6px }
.si-todos-list li { display:flex;gap:10px;align-items:flex-start;font-size:13.5px;line-height:1.55 }
.si-todos-pri { padding:1px 7px;border-radius:8px;font-size:10.5px;font-weight:600;flex-shrink:0;margin-top:1px }
.si-todos-pri--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-todos-pri--medium { background:rgba(176,128,48,.12);color:#b08030 }
.si-todos-pri--low { background:rgba(94,130,82,.14);color:#5e8252 }
.si-todos-action { color:var(--text-primary) }

/* Raw 数据 */
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
`;

export function renderSkillDetail(
  entry: SkillIndexEntry,
  evalReport: EvaluationReport | null,
  lang: Lang = DEFAULT_LANG,
): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const insights = detectInsights(entry, evalReport);
  const grouped = groupInsightsByAudience(insights);

  const reportCount = [entry.doctor, entry.eval, entry.observe].filter(Boolean).length;
  const lastTs = [entry.doctor?.timestamp, entry.eval?.timestamp, entry.observe?.generatedAt]
    .filter((s): s is string => Boolean(s)).sort().pop();

  const skillAuthorSection = renderAudienceSection('skill-author', grouped['skill-author'], lang, false);
  const sampleAuthorSection = renderAudienceSection('sample-author', grouped['sample-author'], lang, false);
  const omkSection = renderAudienceSection('omk-maintainer', grouped['omk-maintainer'], lang, true);

  const insightsHtml = insights.length === 0
    ? `<section class="si-empty-state">
        <p>${lang === 'zh' ? '✅ 没检测到自动可识别的问题。' : '✅ No auto-detected issues.'}</p>
      </section>`
    : skillAuthorSection + sampleAuthorSection + omkSection;

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
