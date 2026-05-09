/**
 * Skill 详情页(timeline + 问题汇总)— 把 omk 工作流叙事还原:
 *
 *   ╭─ skill 综合 status ─────────────────────────────╮
 *   ├─ ① Doctor 静态体检(展示所有 rule 结果) ───────╮
 *   │   每条 rule 旁挂 [#N] 徽章 → 跳到底部对应 insight│
 *   │                  ↓                                │
 *   ├─ ② Eval 评测(评分视角 + 功能视角失败 sample) ──┤
 *   │   每条失败 sample 旁挂 [#N]                      │
 *   │                  ↓                                │
 *   ├─ ③ Observe 线上观测(健康指标 + 跨阶段对照) ────┤
 *   │                                                   │
 *   ├─ SKILL 本身的问题一览(按 audience 分区) ─────┤
 *   │   每条 insight 标"阶段印证: doctor⚠ + eval-s003✗"│
 *   ╰─────────────────────────────────────────────────╯
 *
 * 跟 v4 的核心差别:
 *   - timeline 不再是"原始数据"折叠到底部,而是顶层叙事
 *   - 每个阶段元素(rule / failed sample / health metric)挂 [#N] 徽章
 *     直接连到底部 insight,可视化"问题在哪条流水线上"
 *   - 底部 insight 是 cross-cutting 汇总,不再是"主体"
 */
import { layout, e, DEFAULT_LANG } from './layout.js';
import type { Lang, EvaluationReport, VariantResult } from '../types/index.js';
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

const AUDIENCE_INFO_ZH: Record<InsightAudience, { icon: string; title: string; subtitle: string }> = {
  'skill-author': { icon: '📝', title: 'Skill 优化项', subtitle: 'skill 文档需要调整,主要改 SKILL.md' },
  'sample-author': { icon: '🔧', title: '用例优化项', subtitle: 'sample / mock 设计需要调整,改 samples.json,不动 skill' },
  'omk-maintainer': { icon: '⚙️', title: '工具反馈', subtitle: '给 omk 维护者的待办,普通用户可忽略' },
};
const AUDIENCE_INFO_EN: Record<InsightAudience, { icon: string; title: string; subtitle: string }> = {
  'skill-author': { icon: '📝', title: 'Skill optimization', subtitle: 'Update SKILL.md content' },
  'sample-author': { icon: '🔧', title: 'Sample optimization', subtitle: 'Update samples.json (skill stays unchanged)' },
  'omk-maintainer': { icon: '⚙️', title: 'Tool feedback', subtitle: 'For omk maintainers; skill authors may skip' },
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

// ────────── Sparkline + Flow chart helpers ──────────

interface SparklineOpts {
  width?: number;
  height?: number;
  color?: string;
  /** 强制 y 轴范围。默认按数据自动算 min/max。 */
  yMin?: number;
  yMax?: number;
  /** 把数据点之间的下方区域填色(area chart)。 */
  fillArea?: boolean;
}

function renderSparkline(values: number[], opts: SparklineOpts = {}): string {
  if (values.length === 0) {
    return `<svg class="si-spark si-spark--empty" width="${opts.width ?? 120}" height="${opts.height ?? 28}" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="50%" text-anchor="middle" dy=".35em" fill="#a8a8a8" font-size="10">no data</text></svg>`;
  }
  const w = opts.width ?? 120;
  const h = opts.height ?? 28;
  const pad = 3;
  const color = opts.color ?? '#5a7a93';
  const min = opts.yMin ?? Math.min(...values);
  const max = opts.yMax ?? Math.max(...values);
  const range = (max - min) || 1;
  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const dx = values.length > 1 ? innerW / (values.length - 1) : 0;
  const points = values.map((v, i) => {
    const x = pad + i * dx;
    const y = pad + innerH * (1 - (v - min) / range);
    return [x, y] as const;
  });
  const polyPts = points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const areaPath = opts.fillArea
    ? `M ${points[0][0].toFixed(1)},${(h - pad).toFixed(1)} ` +
      points.map((p) => `L ${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') +
      ` L ${points[points.length - 1][0].toFixed(1)},${(h - pad).toFixed(1)} Z`
    : '';
  const lastIdx = values.length - 1;
  return `<svg class="si-spark" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
    ${opts.fillArea ? `<path d="${areaPath}" fill="${color}" fill-opacity="0.10"/>` : ''}
    <polyline points="${polyPts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${points.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === lastIdx ? 2.5 : 1.5}" fill="${color}" ${i === lastIdx ? `stroke="white" stroke-width="1"` : ''}/>`).join('')}
  </svg>`;
}

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

// ────────── insight 编号 + 反查 ──────────

interface InsightIndex {
  /** insight 编号(1-based) */
  byInsightId: Map<string, number>;
  /** doctor ruleId → 关联的 insight 编号集合 */
  byDoctorRule: Map<string, Set<number>>;
  /** eval sample id → 关联的 insight 编号集合 */
  byEvalSample: Map<string, Set<number>>;
  /** observe ref → 关联的 insight 编号集合 */
  byObserveRef: Map<string, Set<number>>;
  /** insight 编号 → insight 对象(渲染 badge tooltip 用) */
  byNumber: Map<number, Insight>;
}

function buildInsightIndex(insights: Insight[]): InsightIndex {
  const idx: InsightIndex = {
    byInsightId: new Map(),
    byDoctorRule: new Map(),
    byEvalSample: new Map(),
    byObserveRef: new Map(),
    byNumber: new Map(),
  };
  insights.forEach((ins, i) => {
    const num = i + 1;
    idx.byInsightId.set(ins.id, num);
    idx.byNumber.set(num, ins);
    const refs = ins.stageRefs;
    if (!refs) return;
    for (const r of refs.doctorRuleIds ?? []) {
      if (!idx.byDoctorRule.has(r)) idx.byDoctorRule.set(r, new Set());
      idx.byDoctorRule.get(r)!.add(num);
    }
    for (const s of refs.evalSampleIds ?? []) {
      if (!idx.byEvalSample.has(s)) idx.byEvalSample.set(s, new Set());
      idx.byEvalSample.get(s)!.add(num);
    }
    for (const o of refs.observeRefs ?? []) {
      if (!idx.byObserveRef.has(o)) idx.byObserveRef.set(o, new Set());
      idx.byObserveRef.get(o)!.add(num);
    }
  });
  return idx;
}

function renderInsightBadges(numbers: Set<number> | undefined, idx: InsightIndex): string {
  if (!numbers || numbers.size === 0) return '';
  return [...numbers].sort((a, b) => a - b).map((n) => {
    const ins = idx.byNumber.get(n);
    const tip = ins ? `${ins.title}` : `#${n}`;
    return `<a class="si-badge si-badge--${ins?.severity ?? 'low'}" href="#insight-${n}" title="${e(tip)}">#${n}</a>`;
  }).join('');
}

// ────────── ① Doctor stage ──────────

function renderRuleResult(r: DoctorRuleResult, idx: InsightIndex, lang: Lang): string {
  const icon = r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : r.status === 'fail' ? '✗' : '○';
  const cls = r.status === 'pass' ? 'pass' : r.status === 'warn' ? 'warn' : r.status === 'fail' ? 'fail' : 'gray';
  const badges = renderInsightBadges(idx.byDoctorRule.get(r.ruleId), idx);
  return `<li class="si-rule si-rule--${cls}">
    <span class="si-rule-icon">${icon}</span>
    <div class="si-rule-body">
      <code class="si-rule-id">${e(r.ruleId)}</code>
      <span class="si-rule-msg">${e(r.message)}</span>
      ${badges ? `<span class="si-rule-badges">${badges}</span>` : ''}
      ${r.hint ? `<div class="si-rule-hint">💡 ${e(r.hint)}</div>` : ''}
    </div>
  </li>`;
  void lang;
}

// ────────── 顶部水平流程图 ──────────

interface FlowNodeData {
  num: number;
  icon: string;
  name: string;
  band: 'green' | 'yellow' | 'red' | 'gray';
  statusText: string;
  timeText: string;
  badges: Set<number>;
  anchor: string;
}

function renderFlowChart(nodes: FlowNodeData[], idx: InsightIndex, lang: Lang): string {
  return `<section class="si-flow">
    <div class="si-flow-h">${lang === 'zh' ? '流程概览' : 'Pipeline overview'}</div>
    <div class="si-flow-body">
      ${nodes.map((n, i) => `
        <a class="si-flow-node si-flow-node--${n.band}" href="#${e(n.anchor)}">
          <div class="si-flow-num">${n.num}</div>
          <div class="si-flow-icon">${n.icon}</div>
          <div class="si-flow-name">${e(n.name)}</div>
          <div class="si-flow-status">${e(n.statusText)}</div>
          <div class="si-flow-time">${e(n.timeText)}</div>
          ${n.badges.size > 0 ? `<div class="si-flow-badges">${renderInsightBadges(n.badges, idx)}</div>` : ''}
        </a>
        ${i < nodes.length - 1 ? `<div class="si-flow-arrow">→</div>` : ''}
      `).join('')}
    </div>
  </section>`;
}

function renderDoctorStage(snap: SkillDoctorSnapshot | null, history: SkillDoctorSnapshot[], idx: InsightIndex, lang: Lang): string {
  if (!snap) {
    return `<section id="stage-doctor" class="si-stage si-stage--gray">
      <header class="si-stage-h">
        <span class="si-stage-num">1️⃣</span>
        <h2>${lang === 'zh' ? 'Doctor 静态体检' : 'Doctor (static check)'}</h2>
        <span class="si-stage-status si-stage-status--gray">${lang === 'zh' ? '⚪ 未运行' : '⚪ not run'}</span>
      </header>
      <p class="si-stage-purpose">${lang === 'zh' ? '在跑评测前先做基础检查:文件能不能读、元数据齐不齐、引用的依赖在不在,把规范问题先排掉' : 'Run basic checks before evaluation: file readable, metadata complete, dependencies declared'}</p>
      <p class="si-stage-empty">${lang === 'zh' ? '运行 omk doctor 后这里会显示静态体检结果。' : 'Run omk doctor to populate static check results.'}</p>
    </section>`;
  }
  const statusCls = snap.status === 'fail' ? 'red' : snap.status === 'warn' ? 'yellow' : 'green';
  const statusText = snap.status === 'fail'
    ? (lang === 'zh' ? '✗ 有失败' : '✗ failures')
    : snap.status === 'warn' ? (lang === 'zh' ? '⚠ 有警告' : '⚠ warnings')
    : (lang === 'zh' ? '✓ 全部通过' : '✓ all pass');

  // 趋势:历史 pass rate (pass / total rules) 百分比
  const passRates = history.map((h) => {
    const total = h.passCount + h.warnCount + h.failCount;
    return total > 0 ? (h.passCount / total) * 100 : 0;
  });
  const sparkColor = statusCls === 'green' ? '#5e8252' : statusCls === 'yellow' ? '#b08030' : '#9c4a3f';
  const trendText = history.length >= 2
    ? `${passRates[0].toFixed(0)}% → ${passRates[passRates.length - 1].toFixed(0)}%`
    : `${passRates[0]?.toFixed(0) ?? '—'}%`;

  return `<section id="stage-doctor" class="si-stage si-stage--${statusCls}">
    <header class="si-stage-h">
      <span class="si-stage-num">1️⃣</span>
      <h2>${lang === 'zh' ? 'Doctor 静态体检' : 'Doctor (static check)'}</h2>
      <span class="si-stage-status si-stage-status--${statusCls}">${statusText}</span>
      <span class="si-stage-time">${relTime(snap.timestamp, lang)}</span>
    </header>
    <p class="si-stage-purpose">${lang === 'zh' ? '在跑评测前先做基础检查:文件能不能读、元数据齐不齐、引用的依赖在不在,把规范问题先排掉' : 'Run basic checks before evaluation: file readable, metadata complete, dependencies declared'}</p>
    ${history.length >= 2 ? `<div class="si-trend">
      <div class="si-trend-label">${lang === 'zh' ? '通过率趋势' : 'Pass-rate trend'}<span class="si-trend-detail">(${history.length} ${lang === 'zh' ? '次体检' : 'checks'})</span></div>
      ${renderSparkline(passRates, { color: sparkColor, yMin: 0, yMax: 100, fillArea: true })}
      <div class="si-trend-text">${e(trendText)}</div>
    </div>` : ''}
    <div class="si-stage-stats">${snap.passCount} ✓ · ${snap.warnCount} ⚠ · ${snap.failCount} ✗</div>
    <ul class="si-rules">${snap.results.map((r) => renderRuleResult(r, idx, lang)).join('')}</ul>
  </section>`;
}

// ────────── ② Eval stage ──────────

interface FailedSampleRow {
  sampleId: string;
  modes: string[];
  diagSummary: string;
}

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
      diagSummary: v.diagnostic?.summary?.slice(0, 100) ?? '',
    });
  }
  return out;
}

function renderEvalStage(
  snap: SkillEvalSnapshot | null,
  history: SkillEvalSnapshot[],
  evalReport: EvaluationReport | null,
  idx: InsightIndex,
  langQ: string,
  lang: Lang,
): string {
  if (!snap) {
    return `<section id="stage-eval" class="si-stage si-stage--gray">
      <header class="si-stage-h">
        <span class="si-stage-num">2️⃣</span>
        <h2>${lang === 'zh' ? 'Eval 评测' : 'Eval'}</h2>
        <span class="si-stage-status si-stage-status--gray">${lang === 'zh' ? '⚪ 未运行' : '⚪ not run'}</span>
      </header>
      <p class="si-stage-purpose">${lang === 'zh' ? '用 LLM 实跑用例,既给 skill 整体打分(能否上线),也定位每条用例失败的原因' : 'Run samples with LLM: score the skill (ship-ready?) AND pinpoint why each sample failed'}</p>
    </section>`;
  }
  const verdictCls = snap.verdictLevel === 'ship' || snap.verdictLevel === 'progress' || snap.verdictLevel === 'ship_with_caveat' ? 'green'
    : snap.verdictLevel === 'no_ship' || snap.verdictLevel === 'regress' ? 'red'
    : snap.verdictLevel === 'neutral' ? 'yellow' : 'gray';

  let layered: { factScore?: number; behaviorScore?: number; judgeScore?: number } | undefined;
  let failedSamples: FailedSampleRow[] = [];
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
  }

  const renderLayer = (label: string, val?: number): string => {
    if (val == null) return `<div class="si-layer"><span>${e(label)}</span><span class="si-layer-num">—</span></div>`;
    const cls = val >= 4 ? 'pass' : val >= 3 ? 'warn' : 'fail';
    const w = Math.round((val / 5) * 100);
    return `<div class="si-layer">
      <span class="si-layer-lbl">${e(label)}</span>
      <div class="si-layer-bar"><div class="si-layer-fill si-layer-fill--${cls}" style="width:${w}%"></div></div>
      <span class="si-layer-num si-layer-num--${cls}">${val.toFixed(2)}</span>
    </div>`;
  };

  // 趋势:历史综合分
  const compositeHistory = history.map((h) => h.compositeScore ?? 0);
  const sparkColor = verdictCls === 'green' ? '#5e8252' : verdictCls === 'yellow' ? '#b08030' : verdictCls === 'red' ? '#9c4a3f' : '#a8a8a8';
  const trendText = history.length >= 2
    ? `${compositeHistory[0].toFixed(1)} → ${compositeHistory[compositeHistory.length - 1].toFixed(1)}`
    : `${compositeHistory[0]?.toFixed(2) ?? '—'}`;

  return `<section id="stage-eval" class="si-stage si-stage--${verdictCls}">
    <header class="si-stage-h">
      <span class="si-stage-num">2️⃣</span>
      <h2>${lang === 'zh' ? 'Eval 评测' : 'Eval'}</h2>
      <span class="si-stage-status si-stage-status--${verdictCls}">${e(snap.verdictLevel.replace(/_/g, ' ').toUpperCase())}</span>
      <span class="si-stage-time">${relTime(snap.timestamp, lang)}</span>
    </header>
    <p class="si-stage-purpose">${lang === 'zh' ? '用 LLM 实跑用例,既给 skill 整体打分(能否上线),也定位每条用例失败的原因' : 'Run samples with LLM: score the skill (ship-ready?) AND pinpoint why each sample failed'}</p>
    ${history.length >= 2 ? `<div class="si-trend">
      <div class="si-trend-label">${lang === 'zh' ? '综合分趋势' : 'Composite trend'}<span class="si-trend-detail">(${history.length} ${lang === 'zh' ? '次评测' : 'runs'})</span></div>
      ${renderSparkline(compositeHistory, { color: sparkColor, yMin: 0, yMax: 5, fillArea: true })}
      <div class="si-trend-text">${e(trendText)}</div>
    </div>` : ''}

    <div class="si-eval-block">
      <h3 class="si-eval-h">📊 ${lang === 'zh' ? '评分视角' : 'Score view'}</h3>
      <div class="si-eval-score-row">
        <div class="si-eval-composite">${snap.compositeScore != null ? snap.compositeScore.toFixed(2) : '—'}<span class="si-eval-composite-sub">/5 ${lang === 'zh' ? '综合' : 'composite'}</span></div>
        ${snap.verdictHeadline ? `<p class="si-eval-headline">${e(snap.verdictHeadline)}</p>` : ''}
      </div>
      <div class="si-layers">
        ${renderLayer(lang === 'zh' ? '事实层' : 'fact', layered?.factScore)}
        ${renderLayer(lang === 'zh' ? '行为层' : 'behavior', layered?.behaviorScore)}
        ${renderLayer(lang === 'zh' ? 'LLM 评价' : 'judge', layered?.judgeScore)}
      </div>
      <a class="si-eval-link" href="/reports/${e(snap.reportId)}${langQ}">${lang === 'zh' ? '完整 A/B 报告 →' : 'Full A/B report →'}</a>
    </div>

    <div class="si-eval-block">
      <h3 class="si-eval-h">✅ ${lang === 'zh' ? '功能视角' : 'Functional view'}</h3>
      <div class="si-eval-pf">
        <span class="si-eval-pass">${snap.passCount} ✓ ${lang === 'zh' ? '通过' : 'pass'}</span>
        <span class="si-eval-fail">${snap.failCount} ✗ ${lang === 'zh' ? '失败' : 'fail'}</span>
        ${snap.tripwireCount > 0 ? `<span class="si-eval-trip">${snap.tripwireCount} ${lang === 'zh' ? '诱错' : 'tripwire'}</span>` : ''}
      </div>
      ${failedSamples.length > 0 ? `<div class="si-failed">
        <h4 class="si-failed-h">${lang === 'zh' ? '失败 sample(每条标对应问题编号 ↓)' : 'Failed samples (each tagged with insight # ↓)'}</h4>
        <ul class="si-failed-list">
          ${failedSamples.map((f) => `<li>
            <code class="si-fs-id">${e(f.sampleId)}</code>
            ${f.modes.length > 0 ? f.modes.map((m) => `<span class="si-fs-mode">${e(m)}</span>`).join('') : ''}
            ${f.diagSummary ? `<span class="si-fs-summary">${e(f.diagSummary)}${f.diagSummary.length >= 100 ? '…' : ''}</span>` : ''}
            ${renderInsightBadges(idx.byEvalSample.get(f.sampleId), idx)}
          </li>`).join('')}
        </ul>
      </div>` : ''}
      <a class="si-eval-link" href="/reports/${e(snap.reportId)}${langQ}#test-view">${lang === 'zh' ? '展开单测视角 →' : 'Open functional view →'}</a>
    </div>
  </section>`;
}

// ────────── ③ Observe stage ──────────

function renderObserveStage(
  snap: SkillObserveSnapshot | null,
  history: SkillObserveSnapshot[],
  doctor: SkillDoctorSnapshot | null,
  evalSnap: SkillEvalSnapshot | null,
  idx: InsightIndex,
  langQ: string,
  lang: Lang,
): string {
  if (!snap) {
    return `<section id="stage-observe" class="si-stage si-stage--gray">
      <header class="si-stage-h">
        <span class="si-stage-num">3️⃣</span>
        <h2>${lang === 'zh' ? 'Observe 线上观测' : 'Observe (production)'}</h2>
        <span class="si-stage-status si-stage-status--gray">${lang === 'zh' ? '⚪ 未运行' : '⚪ not run'}</span>
      </header>
      <p class="si-stage-purpose">${lang === 'zh' ? '接入真实用户的使用记录,看 skill 上线后跑得稳不稳、哪些内容真的被用到了' : 'Ingest real user sessions: stability in production, which content actually gets used'}</p>
      <p class="si-stage-empty">${lang === 'zh' ? '运行 omk observe <trace-dir> 后这里会显示生产健康度。' : 'Run omk observe <trace-dir> to populate.'}</p>
    </section>`;
  }
  const failPct = (snap.failureRate * 100).toFixed(1);
  const gapPct = (snap.gapRate * 100).toFixed(0);

  // 跨阶段对照:doctor 警告了什么、生产是否同源踩
  const crossNotes: string[] = [];
  const depWarn = doctor?.results.find((r) => r.ruleId === 'dependencies_present' && r.status !== 'pass' && r.status !== 'skipped');
  if (depWarn && snap.gapRate > 0) {
    crossNotes.push(lang === 'zh'
      ? `↔ doctor 警告的「前置依赖」问题,生产 ${gapPct}% 段也踩到 (跟 doctor 同源)`
      : `↔ Production confirms doctor's dependencies warning (${gapPct}% gap)`);
  }
  if (evalSnap && snap.failureRate < 0.05 && evalSnap.compositeScore != null && evalSnap.compositeScore >= 4) {
    crossNotes.push(lang === 'zh'
      ? `↔ eval 综合分 ${evalSnap.compositeScore.toFixed(2)} 跟生产稳定性一致(高分 + 低失败率)`
      : `↔ Eval score ${evalSnap.compositeScore.toFixed(2)} aligns with production stability`);
  }

  const observeBadges = renderInsightBadges(
    new Set([...(idx.byObserveRef.get('high-failure-rate') ?? []), ...(idx.byObserveRef.get('gap') ?? []), ...(idx.byObserveRef.get('uncovered-files') ?? [])]),
    idx,
  );

  // 趋势:gap rate 历史(越低越好,直接展示"未访问的比例")
  const gapHistory = history.map((h) => h.gapRate * 100);
  const sparkColor = snap.healthBand === 'green' ? '#5e8252' : snap.healthBand === 'yellow' ? '#b08030' : '#9c4a3f';
  const trendText = history.length >= 2
    ? `${gapHistory[0].toFixed(0)}% → ${gapHistory[gapHistory.length - 1].toFixed(0)}%`
    : `${gapHistory[0]?.toFixed(0) ?? '—'}%`;

  return `<section id="stage-observe" class="si-stage si-stage--${snap.healthBand}">
    <header class="si-stage-h">
      <span class="si-stage-num">3️⃣</span>
      <h2>${lang === 'zh' ? 'Observe 线上观测' : 'Observe (production)'}</h2>
      <span class="si-stage-status si-stage-status--${snap.healthBand}">${BAND_DOT[snap.healthBand]} ${snap.healthBand}</span>
      <span class="si-stage-time">${relTime(snap.generatedAt, lang)}</span>
    </header>
    <p class="si-stage-purpose">${lang === 'zh' ? '接入真实用户的使用记录,看 skill 上线后跑得稳不稳、哪些内容真的被用到了' : 'Ingest real user sessions: stability in production, which content actually gets used'}</p>
    ${history.length >= 2 ? `<div class="si-trend">
      <div class="si-trend-label">${lang === 'zh' ? '知识库 gap 趋势' : 'KB gap trend'}<span class="si-trend-detail">(${history.length} ${lang === 'zh' ? '次观测' : 'snapshots'};数值越低越好)</span></div>
      ${renderSparkline(gapHistory, { color: sparkColor, yMin: 0, yMax: Math.max(50, ...gapHistory), fillArea: true })}
      <div class="si-trend-text">${e(trendText)}</div>
    </div>` : ''}
    <div class="si-stage-stats">
      ${snap.segmentCount} ${lang === 'zh' ? '段' : 'segments'}
      · ${lang === 'zh' ? '工具失败率' : 'tool fail'} ${failPct}%
      · ${lang === 'zh' ? '知识库 gap' : 'KB gap'} ${gapPct}%
      ${observeBadges ? `<span class="si-stage-badges">${observeBadges}</span>` : ''}
    </div>
    ${crossNotes.length > 0 ? `<ul class="si-observe-cross">
      ${crossNotes.map((n) => `<li>${e(n)}</li>`).join('')}
    </ul>` : ''}
    <a class="si-eval-link" href="/analyses/${e(snap.analysisId)}${langQ}">${lang === 'zh' ? '完整观测报告 →' : 'Full observation report →'}</a>
  </section>`;
}

// ────────── 底部:SKILL 本身的问题一览 ──────────

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
  const hint = ev.status === 'flagged' ? (lang === 'zh' ? '此 perspective 报了该问题' : 'flagged')
    : ev.status === 'blind' ? (lang === 'zh' ? '盲区:本应卡却没卡' : 'blind spot')
    : ev.status === 'silent' ? (lang === 'zh' ? '检查过但无信号' : 'no signal')
    : (lang === 'zh' ? '未运行' : 'not run');
  const illsHtml = ev.illustrations && ev.illustrations.length > 0
    ? `<details class="si-ev-ill">
        <summary>${lang === 'zh' ? '展开看 LLM 实际是怎么错的' : 'Show what LLM did'}</summary>
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

function renderStageImprintLine(ins: Insight, lang: Lang): string {
  const refs = ins.stageRefs;
  if (!refs) return '';
  const parts: string[] = [];
  if (refs.doctorRuleIds && refs.doctorRuleIds.length > 0) {
    parts.push(lang === 'zh'
      ? `doctor ⚠ <code>${e(refs.doctorRuleIds.join(', '))}</code>`
      : `doctor ⚠ <code>${e(refs.doctorRuleIds.join(', '))}</code>`);
  }
  if (refs.evalSampleIds && refs.evalSampleIds.length > 0) {
    parts.push(lang === 'zh'
      ? `eval ✗ <code>${e(refs.evalSampleIds.slice(0, 5).join(', '))}${refs.evalSampleIds.length > 5 ? '...' : ''}</code>`
      : `eval ✗ <code>${e(refs.evalSampleIds.slice(0, 5).join(', '))}${refs.evalSampleIds.length > 5 ? '...' : ''}</code>`);
  }
  if (refs.observeRefs && refs.observeRefs.length > 0) {
    const obsLabels: Record<string, string> = lang === 'zh'
      ? { 'high-failure-rate': '生产失败率高', 'gap': '生产 gap', 'uncovered-files': '生产未覆盖文件' }
      : { 'high-failure-rate': 'high prod failure', 'gap': 'prod gap', 'uncovered-files': 'uncovered files' };
    parts.push(`observe ⚠ ${refs.observeRefs.map((r) => obsLabels[r] ?? r).join(' / ')}`);
  }
  if (parts.length === 0) return '';
  return `<div class="si-imprint">${lang === 'zh' ? '阶段印证:' : 'Stage imprint:'} ${parts.join(' · ')}</div>`;
}

function renderInsightItem(ins: Insight, num: number, lang: Lang): string {
  const sevIcon = SEVERITY_ICON[ins.severity];
  const sevLabel = lang === 'zh' ? SEVERITY_LABEL_ZH[ins.severity] : SEVERITY_LABEL_EN[ins.severity];
  return `<article id="insight-${num}" class="si-insight si-insight--${ins.severity}">
    <header class="si-h">
      <span class="si-num">#${num}</span>
      <span class="si-sev">${sevIcon}</span>
      <h3 class="si-title">${e(ins.title)}</h3>
      <span class="si-sev-tag si-sev-tag--${ins.severity}">${e(sevLabel)}</span>
      ${ins.affectedCount > 0 ? `<span class="si-affect">· ${lang === 'zh' ? '影响' : 'affects'} ${ins.affectedCount}</span>` : ''}
    </header>
    ${ins.description ? `<p class="si-desc">${e(ins.description)}</p>` : ''}
    ${renderStageImprintLine(ins, lang)}
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

function renderSummarySection(insights: Insight[], idx: InsightIndex, lang: Lang): string {
  if (insights.length === 0) {
    return `<section class="si-summary-empty">
      <h2>${lang === 'zh' ? 'SKILL 本身的问题一览' : 'Skill-level Issues'}</h2>
      <p>${lang === 'zh' ? '✅ 没检测到自动可识别的问题。' : '✅ No auto-detected issues.'}</p>
    </section>`;
  }
  const grouped = groupInsightsByAudience(insights);
  const renderGroup = (audience: InsightAudience, collapsed: boolean): string => {
    const list = grouped[audience];
    if (list.length === 0) return '';
    const info = lang === 'zh' ? AUDIENCE_INFO_ZH[audience] : AUDIENCE_INFO_EN[audience];
    const inner = list.map((ins) => renderInsightItem(ins, idx.byInsightId.get(ins.id) ?? 0, lang)).join('');
    if (collapsed) {
      return `<details class="si-aud si-aud--${audience}">
        <summary class="si-aud-h">
          <span class="si-aud-icon">${info.icon}</span>
          <span class="si-aud-title">${e(info.title)}</span>
          <span class="si-aud-count">${list.length}</span>
          <span class="si-aud-sub">${e(info.subtitle)}</span>
        </summary>
        <div class="si-aud-body">${inner}</div>
      </details>`;
    }
    return `<section class="si-aud si-aud--${audience} si-aud--open">
      <div class="si-aud-h">
        <span class="si-aud-icon">${info.icon}</span>
        <span class="si-aud-title">${e(info.title)}</span>
        <span class="si-aud-count">${list.length}</span>
        <span class="si-aud-sub">${e(info.subtitle)}</span>
      </div>
      <div class="si-aud-body">${inner}</div>
    </section>`;
  };

  return `<section class="si-summary">
    <header class="si-summary-h">
      <h2>${lang === 'zh' ? 'SKILL 本身的问题一览' : 'Skill-level Issues'}</h2>
      <p class="si-summary-sub">${lang === 'zh' ? '上面 timeline 里 [#N] 徽章对应这里的编号' : 'Numbered links from the timeline above point here'}</p>
    </header>
    ${renderGroup('skill-author', false)}
    ${renderGroup('sample-author', false)}
    ${renderGroup('omk-maintainer', true)}
  </section>`;
}

function renderActionTodos(insights: Insight[], lang: Lang): string {
  if (insights.length === 0) return '';
  const grouped = groupInsightsByAudience(insights);
  const buckets: Array<{ audience: InsightAudience; recs: ReturnType<typeof flattenRecommendations> }> = [];
  for (const aud of ['skill-author', 'sample-author', 'omk-maintainer'] as InsightAudience[]) {
    if (grouped[aud].length === 0) continue;
    const recs = flattenRecommendations(grouped[aud]);
    if (recs.length > 0) buckets.push({ audience: aud, recs });
  }
  if (buckets.length === 0) return '';
  return `<section class="si-todos">
    <h2>${lang === 'zh' ? '🎯 优化清单' : '🎯 Optimization list'}</h2>
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

// ────────── CSS ──────────

const SKILL_DETAIL_CSS = `
.si-back { display:inline-block;margin-bottom:8px;color:var(--text-muted);font-size:13px;text-decoration:none }
.si-back:hover { color:var(--text-primary) }

.si-overall { display:flex;align-items:center;gap:14px;padding:18px 22px;background:var(--bg-soft);border-radius:8px;margin:8px 0 16px }
.si-overall-band { font-size:26px }
.si-overall-name { font-size:22px;font-weight:600;color:var(--text-primary) }
.si-overall-meta { color:var(--text-muted);font-size:13px;margin-left:auto }

/* 顶部流程图 */
.si-flow { background:var(--bg-surface);border-radius:8px;padding:18px 22px;margin:8px 0 24px;box-shadow:var(--shadow-sm) }
.si-flow-h { font-size:12px;color:var(--text-secondary);font-weight:600;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:14px }
.si-flow-body { display:flex;align-items:stretch;gap:8px;flex-wrap:nowrap }
.si-flow-node { flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:14px 10px;background:var(--bg-soft);border-radius:8px;text-decoration:none;color:var(--text-primary);transition:transform .12s,box-shadow .12s;border-top:4px solid var(--border);min-width:0 }
.si-flow-node:hover { transform:translateY(-2px);box-shadow:var(--shadow-md) }
.si-flow-node--green { border-top-color:#5e8252;background:rgba(94,130,82,.06) }
.si-flow-node--yellow { border-top-color:#b08030;background:rgba(176,128,48,.06) }
.si-flow-node--red { border-top-color:#9c4a3f;background:rgba(156,74,63,.06) }
.si-flow-node--gray { border-top-color:var(--border) }
.si-flow-num { font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em }
.si-flow-icon { font-size:24px;line-height:1 }
.si-flow-name { font-size:14px;font-weight:600;color:var(--text-primary) }
.si-flow-status { font-size:12.5px;color:var(--text-secondary);font-variant-numeric:tabular-nums }
.si-flow-time { font-size:11px;color:var(--text-muted) }
.si-flow-badges { margin-top:4px;display:flex;gap:3px;flex-wrap:wrap;justify-content:center }
.si-flow-arrow { display:flex;align-items:center;color:var(--text-muted);font-size:20px;font-weight:300;line-height:1;flex-shrink:0 }

/* Sparkline trend */
.si-trend { display:flex;align-items:center;gap:12px;padding:8px 12px;background:var(--bg-soft);border-radius:6px;margin-bottom:12px;flex-wrap:wrap }
.si-trend-label { font-size:11.5px;color:var(--text-secondary);font-weight:500;letter-spacing:0.02em;display:flex;align-items:center;gap:6px;flex-shrink:0 }
.si-trend-detail { color:var(--text-muted);font-weight:normal;font-size:10.5px }
.si-spark { display:block;flex-shrink:0 }
.si-trend-text { font-size:11.5px;color:var(--text-secondary);font-variant-numeric:tabular-nums;font-family:"SF Mono",Menlo,monospace }

/* Stage 卡(视觉强化:色带 6px,warn/fail 加微弱填充背景)*/
.si-stage { background:var(--bg-surface);padding:18px 22px;border-radius:8px;box-shadow:var(--shadow-sm);margin-bottom:8px;position:relative }
.si-stage--green   { border-left:6px solid #5e8252 }
.si-stage--yellow  { border-left:6px solid #b08030;background:linear-gradient(to right,rgba(176,128,48,.04) 0%,var(--bg-surface) 30%) }
.si-stage--red     { border-left:6px solid #9c4a3f;background:linear-gradient(to right,rgba(156,74,63,.05) 0%,var(--bg-surface) 30%) }
.si-stage--gray    { border-left:6px solid var(--border) }
.si-stage-h { display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap }
.si-stage-num { font-size:18px }
.si-stage-h h2 { margin:0;font-size:16px;font-weight:600;color:var(--text-primary) }
.si-stage-status { padding:3px 10px;border-radius:11px;font-size:12px;font-weight:600 }
.si-stage-status--green { background:rgba(94,130,82,.14);color:#5e8252 }
.si-stage-status--yellow { background:rgba(176,128,48,.12);color:#b08030 }
.si-stage-status--red { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-stage-status--gray { background:var(--bg-soft);color:var(--text-muted) }
.si-stage-time { color:var(--text-muted);font-size:12px;margin-left:auto }
.si-stage-purpose { color:var(--text-secondary);font-size:12.5px;line-height:1.6;margin:0 0 10px;font-style:italic }
.si-stage-stats { color:var(--text-secondary);font-size:13px;margin-bottom:12px;display:flex;gap:14px;flex-wrap:wrap;align-items:center }
.si-stage-badges { margin-left:auto;display:flex;gap:4px }
.si-stage-empty { color:var(--text-muted);font-size:13px;font-style:italic }

/* Stage 间箭头 */
.si-stage + .si-arrow { display:flex;justify-content:center;color:var(--text-muted);font-size:18px;line-height:1;margin:6px 0;font-family:monospace }

/* Doctor rule list(在 stage 内 — warn/fail 行加底色突出)*/
.si-rules { list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px }
.si-rule { display:flex;gap:10px;font-size:13.5px;line-height:1.55;align-items:flex-start;padding:8px 10px;border-radius:4px;transition:background .1s }
.si-rule--warn { background:rgba(176,128,48,.07) }
.si-rule--fail { background:rgba(156,74,63,.08) }
.si-rule-icon { flex-shrink:0;font-weight:700;width:16px;text-align:center;margin-top:1px;font-size:14px }
.si-rule--pass .si-rule-icon { color:#5e8252 }
.si-rule--warn .si-rule-icon { color:#b08030 }
.si-rule--fail .si-rule-icon { color:#9c4a3f }
.si-rule-body { flex:1;min-width:0 }
.si-rule-id { font-size:11px;color:var(--text-muted);background:var(--bg-soft);padding:1px 5px;border-radius:3px;margin-right:6px }
.si-rule-msg { color:var(--text-primary) }
.si-rule--warn .si-rule-msg, .si-rule--fail .si-rule-msg { font-weight:500 }
.si-rule-badges { margin-left:6px }
.si-rule-hint { font-size:12.5px;color:var(--text-secondary);margin-top:3px;line-height:1.55 }

/* Eval block(在 eval stage 内) */
.si-eval-block { background:var(--bg-soft);padding:12px 14px;border-radius:6px;margin-bottom:10px }
.si-eval-block:last-child { margin-bottom:0 }
.si-eval-h { margin:0 0 10px;font-size:13.5px;font-weight:600;color:var(--text-primary) }
.si-eval-score-row { display:flex;gap:14px;align-items:flex-end;margin-bottom:10px }
.si-eval-composite { font-size:32px;font-weight:700;color:var(--text-primary);font-variant-numeric:tabular-nums;line-height:1 }
.si-eval-composite-sub { font-size:12px;color:var(--text-muted);margin-left:6px;font-weight:normal }
.si-eval-headline { color:var(--text-secondary);font-size:12.5px;line-height:1.5;margin:0 0 0;font-style:italic }
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
.si-eval-pf { display:flex;gap:14px;font-size:13.5px;margin-bottom:10px }
.si-eval-pass { color:#5e8252;font-weight:600 }
.si-eval-fail { color:#9c4a3f;font-weight:600 }
.si-eval-trip { color:#7a6b89;font-weight:600 }
.si-failed { margin-bottom:10px }
.si-failed-h { font-size:12px;font-weight:600;color:var(--text-secondary);margin:0 0 8px }
.si-failed-list { margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px }
.si-failed-list li { font-size:12.5px;line-height:1.5;display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding:6px 10px;border-radius:4px;background:rgba(156,74,63,.06);border-left:2px solid #9c4a3f }
.si-fs-id { font-size:11px;background:var(--bg-surface);padding:1px 5px;border-radius:3px;color:#9c4a3f;font-weight:600 }
.si-fs-mode { font-size:10.5px;color:#b08030;background:rgba(176,128,48,.14);padding:1px 6px;border-radius:8px;font-weight:500 }
.si-fs-summary { color:var(--text-secondary);font-size:12px;flex:1;min-width:0 }

/* Observe cross-stage notes */
.si-observe-cross { margin:0 0 10px;padding:0;list-style:none }
.si-observe-cross li { font-size:12.5px;color:var(--text-secondary);padding:4px 0;line-height:1.55 }

/* Insight 编号徽章(挂在 timeline 内元素旁 — 加大加阴影更醒目)*/
.si-badge { display:inline-block;padding:2px 8px;border-radius:10px;font-size:11.5px;font-weight:700;text-decoration:none;margin-left:5px;font-variant-numeric:tabular-nums;box-shadow:0 1px 2px rgba(58,58,58,.08);border:1px solid transparent }
.si-badge--high { background:rgba(156,74,63,.18);color:#9c4a3f;border-color:rgba(156,74,63,.25) }
.si-badge--medium { background:rgba(176,128,48,.16);color:#b08030;border-color:rgba(176,128,48,.22) }
.si-badge--low { background:rgba(94,130,82,.18);color:#5e8252;border-color:rgba(94,130,82,.22) }
.si-badge:hover { text-decoration:none;transform:translateY(-1px);box-shadow:0 2px 4px rgba(58,58,58,.12) }

/* 底部 SKILL 问题汇总 */
.si-summary { margin-top:32px }
.si-summary-h { padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:16px }
.si-summary-h h2 { margin:0;font-size:18px;color:var(--text-primary) }
.si-summary-sub { color:var(--text-muted);font-size:12px;margin:4px 0 0 }
.si-summary-empty { margin-top:32px;text-align:center;color:var(--text-muted);padding:20px }
.si-summary-empty h2 { font-size:16px;color:var(--text-primary);margin-bottom:8px }

.si-aud { margin-bottom:16px }
.si-aud-h { display:flex;align-items:center;gap:10px;font-size:14.5px;font-weight:600;color:var(--text-primary);padding:10px 14px;background:var(--bg-soft);border-radius:6px;margin-bottom:12px;list-style:none }
.si-aud-h::-webkit-details-marker { display:none }
details.si-aud > summary.si-aud-h { cursor:pointer }
details.si-aud > summary.si-aud-h::before { content:'▸';color:var(--text-muted);margin-right:4px;font-size:12px }
details.si-aud[open] > summary.si-aud-h::before { content:'▾' }
.si-aud-icon { font-size:18px }
.si-aud-count { padding:2px 8px;border-radius:10px;background:var(--bg-surface);font-size:12px;color:var(--text-secondary);font-weight:500 }
.si-aud-sub { color:var(--text-muted);font-size:12px;font-weight:normal;margin-left:auto }
.si-aud-body { display:flex;flex-direction:column;gap:12px }

/* Insight 卡 */
.si-insight { background:var(--bg-surface);padding:18px 22px;border-radius:8px;box-shadow:var(--shadow-sm) }
.si-insight--high { border-left:3px solid #9c4a3f }
.si-insight--medium { border-left:3px solid #b08030 }
.si-insight--low { border-left:3px solid #5e8252 }
.si-h { display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap }
.si-num { background:var(--bg-soft);padding:2px 8px;border-radius:4px;font-size:11.5px;font-weight:700;color:var(--text-secondary);font-variant-numeric:tabular-nums }
.si-sev { font-size:18px }
.si-title { margin:0;font-size:15.5px;font-weight:600;color:var(--text-primary);flex:1;min-width:200px }
.si-sev-tag { padding:2px 8px;border-radius:11px;font-size:11px;font-weight:600 }
.si-sev-tag--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-sev-tag--medium { background:rgba(176,128,48,.12);color:#b08030 }
.si-sev-tag--low { background:rgba(94,130,82,.14);color:#5e8252 }
.si-affect { color:var(--text-muted);font-size:12.5px }
.si-desc { color:var(--text-secondary);font-size:13px;line-height:1.6;margin:6px 0 8px }

/* 阶段印证行 */
.si-imprint { background:var(--bg-soft);padding:6px 10px;border-radius:4px;font-size:12px;color:var(--text-secondary);margin-bottom:10px;line-height:1.6 }
.si-imprint code { background:var(--bg-surface);padding:1px 5px;border-radius:3px;font-size:11px;margin:0 2px }

/* 证据 */
.si-evidence { background:var(--bg-soft);padding:10px 12px;border-radius:6px;margin-bottom:10px }
.si-evidence-h { font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px }
.si-ev { padding:3px 0;font-size:12.5px;line-height:1.55 }
.si-ev-line { display:grid;grid-template-columns:24px 100px 1fr;gap:10px;align-items:start }
.si-ev-icon { text-align:center;font-weight:600;cursor:help }
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
.si-ill-text { color:var(--text-primary);font-family:"SF Mono",Menlo,monospace;font-size:11px;background:var(--bg-soft);padding:3px 6px;border-radius:3px;white-space:pre-wrap;word-break:break-word }
.si-ill-tools { margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:2px }
.si-ill-tools li { font-family:"SF Mono",Menlo,monospace;font-size:10.5px;background:var(--bg-soft);padding:2px 5px;border-radius:3px }
.si-ill-fail { font-size:10.5px;background:rgba(156,74,63,.10);color:#9c4a3f;padding:2px 5px;border-radius:3px }

/* 推荐 */
.si-recs ul { margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px }
.si-recs li { font-size:13px;line-height:1.55 }
.si-rec-line { display:flex;gap:8px;align-items:flex-start }
.si-rec-pri { padding:1px 6px;border-radius:8px;font-size:10.5px;font-weight:600;flex-shrink:0;margin-top:1px }
.si-rec-pri--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-rec-pri--medium { background:rgba(176,128,48,.12);color:#b08030 }
.si-rec-pri--low { background:rgba(94,130,82,.14);color:#5e8252 }
.si-rec-action { color:var(--text-primary);flex:1 }
.si-recs-h { font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px }
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

/* 行动 todo */
.si-todos { background:rgba(94,130,82,.04);border-left:3px solid #5e8252;padding:18px 22px;margin:24px 0 16px;border-radius:8px }
.si-todos h2 { margin:0 0 6px;font-size:16px;color:var(--text-primary) }
.si-todos-note { color:var(--text-muted);font-size:12px;margin:0 0 14px }
.si-todos-bucket { margin-bottom:14px }
.si-todos-bucket-h { display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;color:var(--text-primary);margin:0 0 8px }
.si-todos-bucket-count { padding:1px 7px;background:var(--bg-surface);border-radius:8px;font-size:11px;color:var(--text-secondary);font-weight:500 }
.si-todos-list { margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px }
.si-todos-list li { display:flex;gap:10px;align-items:flex-start;font-size:13.5px;line-height:1.55 }
.si-todos-pri { padding:1px 7px;border-radius:8px;font-size:10.5px;font-weight:600;flex-shrink:0;margin-top:1px }
.si-todos-pri--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.si-todos-pri--medium { background:rgba(176,128,48,.12);color:#b08030 }
.si-todos-pri--low { background:rgba(94,130,82,.14);color:#5e8252 }
.si-todos-action { color:var(--text-primary) }
`;

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

      ${renderFlowChart([
        {
          num: 1, icon: '🩺',
          name: lang === 'zh' ? 'Doctor' : 'Doctor',
          band: entry.doctor ? (entry.doctor.status === 'fail' ? 'red' : entry.doctor.status === 'warn' ? 'yellow' : 'green') : 'gray',
          statusText: entry.doctor
            ? `${entry.doctor.passCount}✓ ${entry.doctor.warnCount}⚠ ${entry.doctor.failCount}✗`
            : (lang === 'zh' ? '未运行' : 'not run'),
          timeText: relTime(entry.doctor?.timestamp, lang),
          badges: new Set([...idx.byDoctorRule.values()].flatMap((s) => [...s])),
          anchor: 'stage-doctor',
        },
        {
          num: 2, icon: '🧪',
          name: lang === 'zh' ? 'Eval' : 'Eval',
          band: entry.eval
            ? (entry.eval.failCount === 0 ? 'green' : entry.eval.passCount === 0 ? 'red' : 'yellow')
            : 'gray',
          statusText: entry.eval
            ? `${entry.eval.passCount}/${entry.eval.passCount + entry.eval.failCount} ${lang === 'zh' ? '通过' : 'pass'}`
            : (lang === 'zh' ? '未运行' : 'not run'),
          timeText: relTime(entry.eval?.timestamp, lang),
          badges: new Set([...idx.byEvalSample.values()].flatMap((s) => [...s])),
          anchor: 'stage-eval',
        },
        {
          num: 3, icon: '👁',
          name: lang === 'zh' ? 'Observe' : 'Observe',
          band: entry.observe?.healthBand ?? 'gray',
          statusText: entry.observe
            ? `${(entry.observe.gapRate * 100).toFixed(0)}% gap`
            : (lang === 'zh' ? '未运行' : 'not run'),
          timeText: relTime(entry.observe?.generatedAt, lang),
          badges: new Set([...idx.byObserveRef.values()].flatMap((s) => [...s])),
          anchor: 'stage-observe',
        },
      ], idx, lang)}

      ${renderDoctorStage(entry.doctor, entry.doctorHistory, idx, lang)}
      <div class="si-arrow">↓</div>
      ${renderEvalStage(entry.eval, entry.evalHistory, evalReport, idx, langQ, lang)}
      <div class="si-arrow">↓</div>
      ${renderObserveStage(entry.observe, entry.observeHistory, entry.doctor, entry.eval, idx, langQ, lang)}

      ${renderSummarySection(insights, idx, lang)}
      ${insights.length > 0 ? renderActionTodos(insights, lang) : ''}
    </main>
    <style>${SKILL_DETAIL_CSS}</style>
  `, lang);
}
