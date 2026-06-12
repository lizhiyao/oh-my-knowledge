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
import type {
  Lang,
  EvaluationReport,
  DoctorRuleResult,
  SkillIndexEntry,
  SkillDoctorSnapshot,
  SkillEvalSnapshot,
  SkillObserveSnapshot,
  Insight,
  InsightIllustration,
} from '../types/index.js';


// v6 之前的 insight × audience × 三视角 抽象在 v7 详情页砍掉了,只保留 sample 维度
// (renderEvalSection 直接读 evalReport.results,不再走 detectInsights / audience 分组)。
// 相关常量(SEVERITY_ICON / AUDIENCE_INFO_* / PATCH_TARGET_*)等以后做调试 UI
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

/** Underpowered observe (very few segments) must not paint a hard red/yellow band — the
 *  analyzer's confidence guard means the band is indicative only, so Studio treats it as
 *  a neutral (gray) signal with a caveat rather than a hard health verdict. */
function effectiveObserveBand(observe: SkillObserveSnapshot | null): 'green' | 'yellow' | 'red' | 'gray' {
  if (!observe) return 'gray';
  return observe.confidence === 'underpowered' ? 'gray' : observe.healthBand;
}

export function assessHealth(entry: SkillIndexEntry, insights: Insight[], lang: Lang): HealthAssessment {
  // underpowered observe 的色带仅供参考,不能算作一个「可信维度」:否则只有 observe、且段数过少时,
  // 要么被 hasFail 硬标红,要么在去掉 band 惩罚后从 excellent 兜底翻成硬绿「健康」—— 两个方向都是
  // 拿低 N 数据下硬结论。没有任何可信维度时,诚实口径是中性灰「未评估」,把判断权交回给 Diagnosis 信号。
  const obsTrustworthy = entry.observe != null && entry.observe.confidence !== 'underpowered';
  const ran = [entry.doctor, entry.eval, obsTrustworthy ? entry.observe : null].filter(Boolean).length;
  // 没有任何可信维度时,如果 Diagnosis 已经给出 high/medium 信号(例如只跑了 `omk observe ingest`
  // 拿到 `skill_md_not_found`),仍然要把卡片标红/黄,而不是落到灰色「未评估」。
  // 否则 Diagnosis 作为 Studio 数据源的价值会被 UI 口径吞掉:红色筛选筛不到,
  // 用户看不到「这个 skill 有待优化项,但卡片仍灰」的矛盾态。
  const highCount = insights.filter((i) => i.severity === 'high').length;
  const medCount = insights.filter((i) => i.severity === 'medium').length;
  if (ran === 0) {
    if (highCount > 0) {
      return { grade: 'unhealthy', score: null, label: lang === 'zh' ? '不健康' : 'Unhealthy', emoji: '🔴', color: 'red' };
    }
    if (medCount > 0) {
      return { grade: 'fair', score: null, label: lang === 'zh' ? '待改进' : 'Fair', emoji: '🟡', color: 'yellow' };
    }
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
  if (entry.observe && obsTrustworthy) {
    // underpowered observe 不进参考分:低 N 的 coverage / band 都仅供参考,平均进硬分会污染口径。
    const coverage = (1 - entry.observe.gapRate) * 100;
    const obsBand = effectiveObserveBand(entry.observe);
    const bandMul = obsBand === 'red' ? 0.6 : obsBand === 'yellow' ? 0.85 : 1;
    observePct = coverage * bandMul;
  }
  const dims = [doctorPct, evalPct, observePct].filter((x): x is number => x != null);
  const score = dims.length > 0 ? Math.round(dims.reduce((s, x) => s + x, 0) / dims.length) : null;

  const hasFail = (entry.doctor != null && entry.doctor.failCount > 0)
    || (entry.eval != null && entry.eval.failCount > 0)
    || (effectiveObserveBand(entry.observe) === 'red');
  const hasWarn = (entry.doctor != null && entry.doctor.warnCount > 0)
    || (entry.eval != null && entry.eval.compositeScore != null && entry.eval.compositeScore < 3.5)
    || (effectiveObserveBand(entry.observe) === 'yellow');
  if (highCount > 0 || hasFail) {
    return { grade: 'unhealthy', score, label: lang === 'zh' ? '不健康' : 'Unhealthy', emoji: '🔴', color: 'red' };
  }
  if (medCount > 0 || hasWarn) {
    return { grade: 'fair', score, label: lang === 'zh' ? '待改进' : 'Fair', emoji: '🟡', color: 'yellow' };
  }
  if (insights.length === 0 && !hasWarn) {
    return { grade: 'excellent', score, label: lang === 'zh' ? '健康' : 'Excellent', emoji: '🟢', color: 'green' };
  }
  return { grade: 'good', score, label: lang === 'zh' ? '良好' : 'Good', emoji: '🟢', color: 'green' };
}

// ────────── Hero:健康等级 + 名称 + 摘要 ──────────

function scoreGrade(score: number): string {
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}

function scoreColor2(score: number): string {
  return score >= 100 ? '#1f9d63' : score >= 60 ? '#d97706' : '#dc2626';
}

function renderHero(entry: SkillIndexEntry, insights: Insight[], lastTs: string | undefined, _reportCount: number, lang: Lang): string {
  const h = assessHealth(entry, insights, lang);
  const zh = lang === 'zh';
  const color = h.score != null ? scoreColor2(h.score) : '#9ca3af';
  const grade = h.score != null ? scoreGrade(h.score) : '—';
  const gradeLabel = h.score != null
    ? (h.score >= 70 ? (zh ? '通过' : 'Pass') : h.score >= 50 ? (zh ? '待改进' : 'Fair') : (zh ? '不合格' : 'Fail'))
    : '';
  const size = 96, sw = 7, r = (size - sw) / 2, c = 2 * Math.PI * r;
  const offset = c * (1 - (h.score ?? 0) / 100);

  return `<div class="sd-hero">
    <div class="sd-hero-left">
      <h1 class="sd-hero-name">${e(entry.skillName)}</h1>
      <div class="sd-hero-meta">${zh ? '最后更新' : 'Updated'} ${relTime(lastTs, lang)}</div>
    </div>
    <div class="sd-hero-score">
      <div style="position:relative;width:${size}px;height:${size}px">
        <svg width="${size}" height="${size}">
          <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#edf0f7" stroke-width="${sw}"/>
          ${h.score != null ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}"
            stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
            stroke-linecap="round" transform="rotate(-90 ${size / 2} ${size / 2})" style="transition:stroke-dashoffset .6s"/>` : ''}
        </svg>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
          <span style="font-size:28px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;color:${color}">${h.score ?? '—'}</span>
        </div>
      </div>
      <div class="sd-hero-grade">
        <div class="sd-hero-grade-label">${zh ? '综合健康分' : 'Health Score'}</div>
        <div class="sd-hero-grade-value" style="color:${color}"><strong>${grade}</strong> <span>${gradeLabel}</span></div>
        <div class="sd-hero-grade-hint">${zh ? '综合 = (健康体检 + 用例评测) / 2' : 'Score = (Doctor + Eval) / 2'}</div>
      </div>
    </div>
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
        <div class="si-sb-label">💡 ${lang === 'zh' ? '建议(针对这条用例)' : 'Suggestion (per-sample)'}</div>
        <div class="si-sb-text">${sugParts.join('')}</div>
      </div>`
    : `<div class="si-sb-block si-sb-block--suggest si-sb-block--empty">
        <div class="si-sb-label">💡 ${lang === 'zh' ? '建议(针对这条用例)' : 'Suggestion (per-sample)'}</div>
        <div class="si-sb-text si-sb-empty">${lang === 'zh' ? '诊断 LLM 没给出针对这条用例的建议(可能输出截断或用例本身是诱错样本,无需改动)' : 'Diagnostic LLM did not return a per-sample suggestion'}</div>
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
.si-back { display:inline-block;margin-bottom:12px;color:var(--text-muted);font-size:13px;text-decoration:none }
.si-back:hover { color:var(--text-primary) }

/* Hero — skill 名 + 综合分圆环 + 等级 */
.sd-hero { display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px 24px;background:#fff;border:1px solid #e4e8f1;border-radius:12px;box-shadow:0 8px 24px rgba(31,41,55,4%);margin-bottom:16px }
@media(max-width:640px){ .sd-hero { flex-direction:column;text-align:center } }
.sd-hero-left { display:flex;flex-direction:column;gap:4px;min-width:0 }
.sd-hero-name { margin:0;font-size:18px;font-weight:700;color:#182033 }
.sd-hero-meta { font-size:12px;color:#637083 }
.sd-hero-score { display:flex;align-items:center;gap:16px }
.sd-hero-grade { display:flex;flex-direction:column;gap:2px }
.sd-hero-grade-label { font-size:12px;color:#637083;font-weight:500 }
.sd-hero-grade-value { display:flex;align-items:baseline;gap:6px;font-size:24px;font-weight:800;line-height:1 }
.sd-hero-grade-value span { font-size:12px;font-weight:500;color:#637083 }
.sd-hero-grade-hint { font-size:11px;color:#94a3b8 }

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
.si-empty-h { display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(31,157,99,.08);border-left:3px solid #1f9d63;border-radius:6px }
.si-empty-emoji { font-size:22px;line-height:1 }
.si-empty-title { font-size:14px;font-weight:600;color:var(--text-primary) }
.si-empty-section-h { font-size:11.5px;font-weight:600;color:var(--text-muted);letter-spacing:0.04em;margin-bottom:6px;text-transform:uppercase }
.si-empty-list { margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px }
.si-empty-list li { display:grid;grid-template-columns:18px 1fr;gap:8px;align-items:start;font-size:13px;line-height:1.55;color:var(--text-primary) }
.si-empty-list code { background:var(--bg-soft);padding:1px 6px;border-radius:3px;font-family:"SF Mono",Menlo,monospace;font-size:11.5px;color:var(--text-primary) }
.si-empty-icon { font-weight:700;text-align:center }
.si-empty-list--pass .si-empty-icon { color:#1f9d63 }
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
.si-row-sev--high { background:rgba(220,38,38,.16);color:#dc2626 }
.si-row-sev--medium { background:rgba(217,119,6,.14);color:#d97706 }
.si-row-sev--low { background:rgba(31,157,99,.16);color:#1f9d63 }
.si-row-title { font-size:13.5px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
.si-row-meta { font-size:11px;color:var(--text-muted);font-variant-numeric:tabular-nums }
.si-row-arrow { color:var(--text-muted);font-size:14px;font-weight:300 }
.si-row--high { border-left:3px solid #dc2626;padding-left:7px }

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
.si-trend-fallback-msg { font-size:13px;font-weight:600;color:#dc2626 }
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
.si-stagecard--green   { border-left-color:#1f9d63 }
.si-stagecard--yellow  { border-left-color:#d97706 }
.si-stagecard--red     { border-left-color:#dc2626 }
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
.si-failure-item { background:rgba(220,38,38,.04);border-radius:5px;margin-bottom:8px;border-left:3px solid #dc2626 }
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
.si-failure-id { font-size:12.5px;font-weight:600;color:#dc2626;background:var(--bg-soft);padding:2px 8px;border-radius:3px;font-family:"SF Mono",Menlo,monospace }
.si-failure-modes { display:flex;gap:4px;flex-wrap:wrap }
.si-failure-mode { font-size:12px;color:#d97706;background:rgba(217,119,6,.14);padding:2px 8px;border-radius:8px;font-weight:500;white-space:nowrap }
.si-failure-trace { font-size:12px;color:var(--accent);text-decoration:none;font-weight:500;white-space:nowrap }
.si-failure-trace:hover { text-decoration:underline }

/* 通过 / 诱错 sample 紧凑行 */
.si-pass-item { display:flex;gap:10px;align-items:center;padding:5px 8px;border-radius:4px;font-size:14px;line-height:1.5 }
.si-pass-item:hover { background:var(--bg-soft) }
.si-pass-card { background:var(--bg-surface);border-radius:5px;margin-bottom:6px;border-left:3px solid #1f9d63 }
.si-pass-card > summary { list-style:none;cursor:pointer;user-select:none }
.si-pass-card > summary::-webkit-details-marker { display:none }
.si-pass-head { display:flex;flex-direction:column;gap:4px;padding:8px 12px }
.si-pass-row1 { display:flex;align-items:center;gap:8px;flex-wrap:wrap }
.si-pass-row1::before { content:'▸ ';color:var(--text-muted);font-size:11px;margin-right:-4px }
details.si-pass-card[open] > summary > .si-pass-row1::before { content:'▾ ' }
.si-pass-id { font-size:12px;font-weight:600;color:#1f9d63;background:var(--bg-soft);padding:2px 8px;border-radius:3px;font-family:"SF Mono",Menlo,monospace;flex-shrink:0 }
.si-pass-score { font-size:12px;font-weight:600;color:#1f9d63;background:rgba(31,157,99,.1);padding:1px 7px;border-radius:10px }
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
.se-score-fill--good { background:#1f9d63 }
.se-score-fill--mid { background:#d97706 }
.se-score-fill--low { background:#dc2626 }
.se-score-val { font-size:16px;font-weight:600;color:var(--text-primary) }
.se-score-max { font-size:12px;font-weight:400;color:var(--text-muted) }
.si-pass-preview { flex:1;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0 }
.si-failure-trace:hover { text-decoration:underline }
.si-failure-detail { padding:0 12px 10px;border-top:1px solid var(--border) }
.si-failure-detail .si-illustration { border-left:none;background:transparent;padding:8px 0 0 0 }
.si-failure-no-detail { padding:6px 0;font-size:13px;color:var(--text-muted);font-style:italic }

/* 三栏摘要卡 v2 */
.si-scard-v2 { background:var(--bg-surface);border-radius:var(--radius);box-shadow:var(--shadow-sm);padding:16px 20px;display:flex;flex-direction:column;gap:8px;text-decoration:none;color:var(--text-primary);transition:box-shadow .15s,transform .12s }
.si-scard-v2:hover { box-shadow:var(--shadow-md);transform:translateY(-1px);text-decoration:none }
.si-scard-v2-h { display:flex;align-items:center;gap:8px }
.si-scard-v2-icon { font-size:16px }
.si-scard-v2-title { font-size:13px;font-weight:600;color:var(--text-secondary);flex:1 }
.si-scard-v2-score { font-size:22px;font-weight:700;font-variant-numeric:tabular-nums }
.si-scard-v2-stat { font-size:13px;color:var(--text-secondary);line-height:1.5;flex:1 }
.si-scard-v2-link { font-size:12px;color:var(--accent);font-weight:500;margin-top:auto;padding-top:8px;border-top:1px solid var(--border) }

/* 三视角 section(下方主体) */
.si-sect { background:var(--bg-surface);border-radius:8px;padding:14px 18px;box-shadow:var(--shadow-sm);margin-bottom:14px;border-left:4px solid var(--border);scroll-margin-top:16px }
.si-sect--green   { border-left-color:#1f9d63 }
.si-sect--yellow  { border-left-color:#d97706 }
.si-sect--red     { border-left-color:#dc2626 }
.si-sect--gray    { border-left-color:var(--border) }
.si-sect-h { display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px;flex-wrap:wrap }
.si-sect-title { font-size:15px;font-weight:600;color:var(--text-primary) }
.si-sect-meta { font-size:11.5px;color:var(--text-muted);font-variant-numeric:tabular-nums }
.si-sect-body { display:flex;flex-direction:column;gap:6px }
.si-sect-empty { font-size:13px;color:var(--text-muted);font-style:italic;padding:8px 0 }
.si-sect-line { font-size:14px;color:var(--text-secondary);margin-bottom:4px }
.si-sect-allpass { font-size:14px;color:#1f9d63;padding:6px 10px;background:rgba(31,157,99,.07);border-radius:4px }
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
.sd-dim--err { border-color:rgba(220,38,38,.3) }
.sd-dim--warn { border-color:rgba(217,119,6,.3) }
.sd-dim--pass { border-color:rgba(31,157,99,.25);background:rgba(31,157,99,.04) }
.sd-dim--skip { border-color:var(--border);opacity:.6 }
.sd-dim > summary { list-style:none;cursor:pointer }
.sd-dim > summary::-webkit-details-marker { display:none }
.sd-dim-header { display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:14px }
.sd-dim-dot { flex-shrink:0;font-size:10px;line-height:1 }
.sd-dim-name { font-weight:600;color:var(--text-primary);flex:1;min-width:0 }
.sd-dim-badges { display:flex;gap:6px;flex-shrink:0 }
.sd-badge { font-size:12px;padding:1px 7px;border-radius:10px;font-weight:500 }
.sd-badge--err { background:rgba(220,38,38,.1);color:#dc2626 }
.sd-badge--warn { background:rgba(217,119,6,.1);color:#d97706 }
.sd-dim-body { padding:0 12px 10px;display:flex;flex-direction:column;gap:6px }
.sd-item { padding:8px 10px;border-radius:4px;font-size:14px;line-height:1.6 }
.sd-item--err { background:rgba(220,38,38,.05);border-left:2px solid #dc2626 }
.sd-item--warn { background:rgba(217,119,6,.05);border-left:2px solid #d97706 }
.sd-item-desc { color:var(--text-primary);word-break:break-word }
.sd-item-sug { margin-top:4px;font-size:13px;color:var(--text-secondary);padding:4px 8px;background:rgba(31,157,99,.05);border-radius:4px;word-break:break-word }
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
.si-sb-block--expected { background:rgba(31,157,99,.06) }
.si-sb-block--actual   { background:rgba(217,119,6,.07) }
.si-sb-block--suggest  { background:rgba(122,107,137,.07) }
.si-sb-label { font-size:12px;font-weight:700;color:var(--text-secondary);letter-spacing:0.02em;margin-bottom:5px }
.si-sb-block--expected .si-sb-label { color:#1f9d63 }
.si-sb-block--actual   .si-sb-label { color:#d97706 }
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
.si-diff-row--expected { background:rgba(31,157,99,.07);border-left:3px solid #1f9d63 }
.si-diff-row--actual   { background:rgba(217,119,6,.08);border-left:3px solid #d97706 }
.si-diff-row--failed   { background:rgba(220,38,38,.07);border-left:3px solid #dc2626 }
.si-diff-icon { font-size:14px;line-height:1.5 }
.si-diff-label { font-size:11.5px;font-weight:700;letter-spacing:0.04em;color:var(--text-secondary);padding-top:2px }
.si-diff-row--expected .si-diff-label { color:#1f9d63 }
.si-diff-row--actual   .si-diff-label { color:#d97706 }
.si-diff-row--failed   .si-diff-label { color:#dc2626 }
.si-diff-text { color:var(--text-primary);font-size:13px;word-break:break-word }
.si-diff-text--mono { font-family:"SF Mono",Menlo,monospace;font-size:12px;background:var(--bg-surface);padding:2px 7px;border-radius:3px;width:fit-content }
/* 原始 prompt/output 降级到二级折叠 */
.si-diff-raw { margin-top:6px;border-top:1px dashed var(--border);padding-top:8px }
.si-diff-raw > summary { cursor:pointer;font-size:11.5px;color:var(--text-muted);user-select:none;list-style:none }
.si-diff-raw > summary::-webkit-details-marker { display:none }
.si-diff-raw > summary:hover { color:var(--text-secondary) }
.si-diff-raw-body { padding:6px 0 }

/* 占位符标识 */
.si-placeholder { background:rgba(217,119,6,.20);color:#7a5810;padding:1px 4px;border-radius:3px;font-weight:600;font-style:italic }
.si-rec-patch-hint { font-size:11.5px;color:#7a5810;background:rgba(217,119,6,.10);padding:6px 10px;border-radius:4px;margin-bottom:6px;line-height:1.5 }
.si-rec-patch-hint .si-placeholder { background:rgba(217,119,6,.30) }

/* 第一条建议的"⭐ 推荐先做"标记 */
.si-rec-item--primary { border-left-color:#1f9d63;background:rgba(31,157,99,.06) }
.si-rec-star { font-size:10.5px;font-weight:700;color:#1f9d63;background:rgba(31,157,99,.16);padding:2px 8px;border-radius:9px;letter-spacing:0.02em;flex-shrink:0 }

/* 建议 + patch 直接铺(去掉 details 折叠)*/
.si-recs { margin:14px 0 }
.si-recs-h { font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:10px }
.si-rec-item { background:var(--bg-soft);border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:3px solid var(--accent) }
.si-rec-item:last-child { margin-bottom:0 }
.si-rec-head { display:flex;align-items:flex-start;gap:8px;margin-bottom:8px }
.si-rec-num { font-size:11px;font-weight:700;color:var(--text-muted);background:var(--bg-surface);padding:1px 7px;border-radius:9px;flex-shrink:0;margin-top:1px;font-variant-numeric:tabular-nums }
.si-rec-pri { padding:1px 7px;border-radius:8px;font-size:10.5px;font-weight:600;flex-shrink:0;margin-top:1px }
.si-rec-pri--high { background:rgba(220,38,38,.14);color:#dc2626 }
.si-rec-pri--medium { background:rgba(217,119,6,.12);color:#d97706 }
.si-rec-pri--low { background:rgba(31,157,99,.14);color:#1f9d63 }
.si-rec-action { flex:1;color:var(--text-primary);font-size:13px;line-height:1.55 }
.si-rec-patch { margin-left:0 }
.si-rec-patch-meta { display:flex;gap:8px;align-items:center;font-size:11px;color:var(--text-muted);margin-bottom:5px;flex-wrap:wrap }
.si-rec-patch-target { font-weight:600;color:var(--text-secondary) }
.si-rec-patch-loc { font-family:"SF Mono",Menlo,monospace;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
.si-rec-patch-copy { background:var(--accent);color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;font-weight:500;transition:background .1s;flex-shrink:0 }
.si-rec-patch-copy:hover { background:var(--accent-hover) }
.si-rec-patch-copy.copied { background:#1f9d63 }
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
.si-sev-tag--high { background:rgba(220,38,38,.14);color:#dc2626 }
.si-sev-tag--medium { background:rgba(217,119,6,.12);color:#d97706 }
.si-sev-tag--low { background:rgba(31,157,99,.14);color:#1f9d63 }

/* 证据 */
.si-evidence { background:var(--bg-soft);padding:10px 12px;border-radius:6px;margin-bottom:12px }
.si-evidence-h { font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px }
.si-ev { padding:4px 0;font-size:13px;line-height:1.55 }
.si-ev-line { display:grid;grid-template-columns:24px 100px 1fr;gap:10px;align-items:start }
.si-ev-icon { text-align:center;font-weight:600 }
.si-ev--flagged .si-ev-icon { color:#dc2626 }
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
.si-ill-text--mono { font-family:"SF Mono",Menlo,monospace;background:rgba(220,38,38,.10);color:#dc2626 }
.si-ill-tools { margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:2px }
.si-ill-tools li { font-family:"SF Mono",Menlo,monospace;font-size:10.5px;background:var(--bg-soft);padding:2px 5px;border-radius:3px }

/* 推荐 */
.si-recs ul { margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px }
.si-recs li { font-size:13px;line-height:1.55 }
.si-rec-line { display:flex;gap:8px;align-items:flex-start }
.si-rec-pri { padding:1px 7px;border-radius:8px;font-size:10.5px;font-weight:600;flex-shrink:0;margin-top:1px }
.si-rec-pri--high { background:rgba(220,38,38,.14);color:#dc2626 }
.si-rec-pri--medium { background:rgba(217,119,6,.12);color:#d97706 }
.si-rec-pri--low { background:rgba(31,157,99,.14);color:#1f9d63 }
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
.si-rule--warn { background:rgba(217,119,6,.07) }
.si-rule--fail { background:rgba(220,38,38,.08) }
.si-rule-icon { flex-shrink:0;font-weight:700;width:16px;text-align:center;font-size:14px }
.si-rule--pass .si-rule-icon { color:#1f9d63 }
.si-rule--warn .si-rule-icon { color:#d97706 }
.si-rule--fail .si-rule-icon { color:#dc2626 }
.si-rule-body { flex:1;min-width:0 }
.si-rule-id { font-size:11px;color:var(--text-muted);background:var(--bg-soft);padding:1px 5px;border-radius:3px;margin-right:6px }
.si-rule-msg { color:var(--text-primary) }
.si-rule-hint { font-size:12px;color:var(--text-secondary);margin-top:3px;line-height:1.55 }

/* Sample list (eval modal — 全部用例清单)。复用 si-history-row 大部分样式,只重写 grid */
.si-sample-list { max-height:340px;overflow-y:auto }
.si-sample-row { grid-template-columns:18px 100px 56px 1fr auto !important;gap:8px !important }
.si-sample-row--pass { background:rgba(31,157,99,.06) }
.si-sample-row--fail { background:rgba(220,38,38,.06);border-left:2px solid #dc2626 }
.si-sample-row--tripwire { background:rgba(122,107,137,.06);border-left:2px solid #7a6b89 }
.si-sample-icon { font-weight:700;text-align:center;font-size:13px }
.si-sample-icon--pass { color:#1f9d63 }
.si-sample-icon--fail { color:#dc2626 }
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
.si-history-status--green { background:rgba(31,157,99,.18);color:#1f9d63 }
.si-history-status--yellow { background:rgba(217,119,6,.16);color:#d97706 }
.si-history-status--red { background:rgba(220,38,38,.18);color:#dc2626 }
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
.si-layer-fill--pass { background:#1f9d63 }
.si-layer-fill--warn { background:#d97706 }
.si-layer-fill--fail { background:#dc2626 }
.si-layer-num { font-variant-numeric:tabular-nums;font-weight:600;text-align:right;font-size:12px }
.si-layer-num--pass { color:#1f9d63 }
.si-layer-num--warn { color:#d97706 }
.si-layer-num--fail { color:#dc2626 }
.si-eval-link { display:inline-block;color:var(--accent);font-size:12.5px;text-decoration:none;font-weight:500 }
.si-eval-link:hover { text-decoration:underline }
.si-failed-list { margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px }
.si-failed-list li { font-size:12.5px;line-height:1.55;display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding:8px 10px;border-radius:4px;background:rgba(220,38,38,.06);border-left:2px solid #dc2626 }
.si-fs-id { font-size:11px;background:var(--bg-surface);padding:1px 5px;border-radius:3px;color:#dc2626;font-weight:600 }
.si-fs-mode { font-size:10.5px;color:#d97706;background:rgba(217,119,6,.14);padding:1px 6px;border-radius:8px;font-weight:500 }
.si-fs-summary { color:var(--text-secondary);font-size:12px;flex-basis:100% }

/* Eval history table */
.si-eval-history-table { width:100%;border-collapse:collapse;font-size:13px;margin-top:8px }
.si-eval-history-table th { text-align:left;padding:6px 10px;border-bottom:2px solid var(--border);color:var(--text-muted);font-weight:500 }
.si-eval-history-table td { padding:6px 10px;border-bottom:1px solid var(--border-soft) }
.si-eval-history-table tr:hover td { background:var(--bg-soft) }
.si-eval-history-table a { color:var(--link);text-decoration:none;font-size:12px }
.si-eval-history-table a:hover { text-decoration:underline }
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

/** doctor section:展示告警 / 失败规则;通过的规则折叠到底部 */
function renderDoctorSection(snap: SkillDoctorSnapshot | null, history: SkillDoctorSnapshot[], skillName: string, lang: Lang): string {
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
    <a class="si-sect-link" href="/doctors/${e(snap.reportId)}?skill=${encodeURIComponent(skillName)}${lang === DEFAULT_LANG ? '' : `&lang=${lang}`}">${lang === 'zh' ? '完整体检报告 →' : 'Full doctor report →'}</a>
    ${renderDoctorHistory(history, lang)}
  </section>`;
}

/** eval history: 历史评测记录列表（折叠） */
function renderEvalHistory(history: SkillEvalSnapshot[], langQ: string, lang: Lang): string {
  if (history.length < 2) return '';
  const rows = [...history].reverse().map((h) => {
    const date = h.timestamp ? new Date(h.timestamp).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
    const score = h.compositeScore != null ? h.compositeScore.toFixed(2) : '-';
    const status = h.failCount === 0 ? '✅' : `❌ ${h.failCount} fail`;
    const link = `<a href="/reports/${e(h.reportId)}${langQ}">${e(h.reportId)}</a>`;
    return `<tr><td>${date}</td><td>${score}</td><td>${h.passCount}/${h.totalSamples}</td><td>${status}</td><td>${link}</td></tr>`;
  }).join('\n');
  return `<details class="si-sect-fold">
    <summary>${lang === 'zh' ? `▸ 历史评测记录 (${history.length} 次)` : `▸ Eval history (${history.length} runs)`}</summary>
    <div class="si-sect-fold-body">
      <table class="si-eval-history-table">
        <thead><tr><th>${lang === 'zh' ? '时间' : 'Time'}</th><th>${lang === 'zh' ? '分数' : 'Score'}</th><th>${lang === 'zh' ? '通过' : 'Pass'}</th><th>${lang === 'zh' ? '状态' : 'Status'}</th><th>${lang === 'zh' ? '报告' : 'Report'}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </details>`;
}

/** doctor history: 历史检查记录列表（折叠） */
function renderDoctorHistory(history: SkillDoctorSnapshot[], lang: Lang): string {
  if (history.length < 2) return '';
  const rows = [...history].reverse().map((h) => {
    const date = h.timestamp ? new Date(h.timestamp).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
    const statusIcon = h.status === 'pass' ? '✅' : h.status === 'warn' ? '⚠️' : '❌';
    const detail = `${h.passCount}✓ ${h.warnCount}⚠ ${h.failCount}✗`;
    return `<tr><td>${date}</td><td>${statusIcon} ${e(h.status)}</td><td>${detail}</td></tr>`;
  }).join('\n');
  return `<details class="si-sect-fold">
    <summary>${lang === 'zh' ? `▸ 历史检查记录 (${history.length} 次)` : `▸ Doctor history (${history.length} runs)`}</summary>
    <div class="si-sect-fold-body">
      <table class="si-eval-history-table">
        <thead><tr><th>${lang === 'zh' ? '时间' : 'Time'}</th><th>${lang === 'zh' ? '状态' : 'Status'}</th><th>${lang === 'zh' ? '明细' : 'Detail'}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </details>`;
}

/** eval section:失败 sample 列表(默认折叠,展开看 prompt/期望/实际/建议) */
function renderEvalSection(
  snap: SkillEvalSnapshot | null,
  evalReport: EvaluationReport | null,
  history: SkillEvalSnapshot[],
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
      ${renderEvalHistory(history, langQ, lang)}
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

  const obsCaveat = snap.confidence === 'underpowered'
    ? (lang === 'zh' ? ' · ⚠ 样本不足，色带仅供参考' : ' · ⚠ low N, band indicative')
    : '';
  return `<section id="section-observe" class="si-sect si-sect--${effectiveObserveBand(snap)}">
    <div class="si-sect-h">
      <span class="si-sect-title">👁 ${lang === 'zh' ? '线上观测 (observe)' : 'Live stability (observe)'}</span>
      <span class="si-sect-meta">${snap.segmentCount} ${lang === 'zh' ? '段' : 'segs'} · gap ${gapPct}% · ${lang === 'zh' ? '工具失败率' : 'tool fail'} ${failPct}% · ${relTime(snap.generatedAt, lang)}${obsCaveat}</span>
    </div>
    <div class="si-sect-body">
      ${body}
      <a class="si-sect-link" href="/observe-health/${e(snap.analysisId)}${langQ}">${lang === 'zh' ? '完整观测报告 →' : 'Full observation report →'}</a>
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
      <a class="si-back" href="/${langQ}">${lang === 'zh' ? '← 返回 Skill 列表' : '← Back to Skills'}</a>
      ${renderHero(entry, insights, lastTs, reportCount, lang)}
      ${renderDoctorSection(entry.doctor, entry.doctorHistory, entry.skillName, lang)}
      ${renderEvalSection(entry.eval, evalReport, entry.evalHistory, langQ, lang)}
      ${renderObserveSection(entry.observe, langQ, lang)}
    </main>
    <style>${SKILL_DETAIL_CSS}</style>
    ${TREND_INIT_SCRIPT}
  `, lang);
}
