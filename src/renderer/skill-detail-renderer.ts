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
  SkillGraphSnapshot,
  SkillGraphNodePreview,
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

/* Skill Map：以 SKILL.md 为根的轻量知识图，不暴露完整 graph JSON 拓扑 */
.sm-sect { border-left-color:#4f46e5 }
.sm-body { display:flex;flex-direction:column;gap:10px }
.sm-toolbar { display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:8px 10px;border:1px solid #e4e8f1;border-radius:8px;background:#fff }
.sm-tools,.sm-toggles { display:flex;align-items:center;gap:6px;flex-wrap:wrap }
.sm-tool { min-width:30px;height:28px;padding:0 9px;border:1px solid #dbe2ee;border-radius:6px;background:#fff;color:#384255;font-size:13px;font-weight:700;cursor:pointer }
.sm-tool:hover { background:#f7f8ff;border-color:#c7d2fe }
.sm-zoom-label { min-width:44px;text-align:center;font-size:11.5px;color:#637083;font-variant-numeric:tabular-nums }
.sm-toggle { display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:1px solid #dbe2ee;border-radius:14px;background:#fff;color:#384255;font-size:11.5px;cursor:pointer;user-select:none }
.sm-toggle input { margin:0;accent-color:#4f46e5 }
.sm-canvas { position:relative;height:min(68vh,620px);min-height:520px;padding:0;background:
  linear-gradient(90deg,rgba(31,157,99,.045) 0%,rgba(31,157,99,.026) 39%,transparent 39%,transparent 58%,rgba(79,70,229,.026) 58%,rgba(79,70,229,.045) 100%),
  linear-gradient(rgba(148,163,184,.075) 1px,transparent 1px),
  linear-gradient(90deg,rgba(148,163,184,.06) 1px,transparent 1px),
  linear-gradient(#fff,#fbfcff);background-size:auto,28px 28px,28px 28px,auto;background-position:0 0;border:1px solid #e4e8f1;border-radius:8px;overflow:auto;overscroll-behavior:contain }
.sm-graph-stage { position:relative;width:1100px;height:560px }
.sm-graph { position:absolute;left:0;top:0;width:1100px;height:560px;transform-origin:0 0;transition:transform .12s ease }
.sm-graph [hidden] { display:none !important }
.sm-svg { position:absolute;inset:0;width:100%;height:100%;pointer-events:none }
.sm-edge { fill:none;stroke:#d8e0ec;stroke-width:1.45;stroke-linecap:round;opacity:.86;vector-effect:non-scaling-stroke }
.sm-edge--definition { stroke:#a9cfc4 }
.sm-edge--measurement { stroke:#bbc7ff }
.sm-node { position:absolute;z-index:1;box-sizing:border-box;transform:translate(-50%,-50%);width:148px;min-height:54px;padding:8px 10px;border:1px solid #d8deea;border-radius:7px;background:rgba(255,255,255,.96);box-shadow:0 8px 20px rgba(31,41,55,6%);display:flex;flex-direction:column;justify-content:center;gap:4px;text-align:center;backdrop-filter:blur(4px) }
.sm-node[data-sm-draggable="1"] { cursor:grab;touch-action:none;user-select:none }
.sm-node[data-sm-draggable="1"].is-dragging { cursor:grabbing;z-index:3;box-shadow:0 16px 34px rgba(31,41,55,14%) }
.sm-node[data-sm-more-toggle] { cursor:pointer;user-select:none }
.sm-node[data-sm-draggable="1"][data-sm-more-toggle] { cursor:grab }
.sm-node[data-sm-draggable="1"][data-sm-more-toggle].is-dragging { cursor:grabbing }
.sm-node[data-sm-more-toggle]:hover,.sm-node[data-sm-more-toggle]:focus-visible { border-color:#9fbfb5;background:#f1fbf7;outline:none }
.sm-node--skill { width:172px;min-height:86px;border-color:#4f46e5;background:linear-gradient(180deg,#fff 0%,#f7f8ff 100%);box-shadow:0 16px 34px rgba(79,70,229,14%);outline:4px solid rgba(79,70,229,.07) }
.sm-node--definition { border-color:#b7d8cf;background:#f4fbf8 }
.sm-node--measurement { border-color:#c7d2fe;background:#f7f8ff }
.sm-node--ok { border-color:rgba(31,157,99,.38);background:rgba(31,157,99,.06) }
.sm-node--warning { border-color:rgba(217,119,6,.38);background:rgba(217,119,6,.07) }
.sm-node--failed { border-color:rgba(220,38,38,.38);background:rgba(220,38,38,.06) }
.sm-node--pending,.sm-node--more { border-style:dashed;background:rgba(248,249,251,.94);color:#637083 }
.sm-node--coverage-declared { border-color:rgba(31,157,99,.42);box-shadow:0 10px 24px rgba(31,157,99,.08) }
.sm-node--coverage-undeclared { border-style:dashed;background:rgba(248,249,251,.94);color:#637083 }
.sm-node-title { font-size:12.2px;font-weight:700;color:#182033;line-height:1.28;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden }
.sm-node--skill .sm-node-title { font-size:15px;line-height:1.2 }
.sm-node-meta { font-size:10.5px;color:#637083;line-height:1.35;word-break:break-word }
.sm-node--skill .sm-node-meta { font-size:11.5px }
.sm-node-kind { font-size:9.5px;text-transform:uppercase;letter-spacing:0;color:#8792a4;font-family:"SF Mono",Menlo,monospace;line-height:1 }
.sm-stage-rail { display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:center;gap:8px;padding:10px 12px;border:1px solid #e4e8f1;border-radius:8px;background:#fff }
.sm-stage-card { min-height:50px;padding:9px 11px;border:1px solid #dbe2ee;border-radius:8px;background:#fbfcff;text-align:center;display:flex;flex-direction:column;justify-content:center;gap:3px }
.sm-stage-card--ok { border-color:rgba(31,157,99,.38);background:rgba(31,157,99,.06) }
.sm-stage-card--warning { border-color:rgba(217,119,6,.38);background:rgba(217,119,6,.07) }
.sm-stage-card--failed { border-color:rgba(220,38,38,.38);background:rgba(220,38,38,.06) }
.sm-stage-card--pending { border-style:dashed;color:#637083;background:#f8f9fb }
.sm-stage-k { font-size:10px;text-transform:uppercase;letter-spacing:0;color:#7b8798;font-family:"SF Mono",Menlo,monospace;line-height:1 }
.sm-stage-v { font-size:13px;font-weight:700;color:#182033;line-height:1.35 }
.sm-stage-arrow { color:#b8c5d8;font-size:18px;line-height:1;text-align:center }
.sm-card { border:1px solid #e4e8f1;border-radius:8px;background:#fff;overflow:hidden }
.sm-card > summary { cursor:pointer;list-style:none;padding:10px 12px;font-size:12.5px;font-weight:600;color:#4f46e5;user-select:none }
.sm-card > summary::-webkit-details-marker { display:none }
.sm-card > summary::before { content:'▸ ';color:#94a3b8;font-size:10px }
.sm-card[open] > summary::before { content:'▾ ' }
.sm-card textarea { width:100%;min-height:260px;border:0;border-top:1px solid #e4e8f1;background:#fbfcff;padding:12px;font-family:"SF Mono",Menlo,monospace;font-size:11.5px;line-height:1.55;color:#182033;resize:vertical;box-sizing:border-box }
@media(max-width:900px){
  .sm-toolbar { align-items:flex-start }
  .sm-stage-rail { grid-template-columns:1fr;gap:6px }
  .sm-stage-arrow { transform:rotate(90deg);font-size:16px }
  .sm-canvas { height:620px;min-height:620px }
  .sm-node { width:142px }
  .sm-node--skill { width:168px }
}

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

const SKILL_MAP_INIT_SCRIPT = `
<script>
(function(){
  function clamp(value, min, max){
    return Math.max(min, Math.min(max, value));
  }
  function initSkillMap(map){
    var viewport = map.querySelector('[data-sm-viewport]');
    var stage = map.querySelector('[data-sm-graph-stage]');
    var graph = map.querySelector('[data-sm-graph]');
    var label = map.querySelector('[data-sm-zoom-label]');
    if (!viewport || !stage || !graph) return;
    var baseWidth = Number(map.getAttribute('data-sm-base-width')) || 1100;
    var baseHeight = Number(map.getAttribute('data-sm-base-height')) || 560;
    var rootX = Number(map.getAttribute('data-sm-root-x')) || 470;
    var rootY = Number(map.getAttribute('data-sm-root-y')) || 260;
    var zoom = 1;
    var dragState = null;
    var suppressMoreClickUntil = 0;

    function edgePoint(fromX, fromY, toX, toY, box){
      var dx = toX - fromX;
      var dy = toY - fromY;
      if (!dx && !dy) return { x: fromX, y: fromY };
      var halfW = Math.max(1, (box.width || 154) / 2);
      var halfH = Math.max(1, (box.height || 58) / 2);
      var scaleX = dx === 0 ? Infinity : halfW / Math.abs(dx);
      var scaleY = dy === 0 ? Infinity : halfH / Math.abs(dy);
      var scale = Math.min(scaleX, scaleY);
      return { x: fromX + dx * scale, y: fromY + dy * scale };
    }

    function nodeBox(node, fallbackWidth, fallbackHeight){
      return {
        width: node && node.offsetWidth ? node.offsetWidth : fallbackWidth,
        height: node && node.offsetHeight ? node.offsetHeight : fallbackHeight
      };
    }

    function nodeCenter(node, fallbackX, fallbackY){
      if (!node) return { x: fallbackX, y: fallbackY };
      return {
        x: Number(node.getAttribute('data-sm-x')) || parseFloat(node.style.left) || fallbackX,
        y: Number(node.getAttribute('data-sm-y')) || parseFloat(node.style.top) || fallbackY
      };
    }

    function pathData(fromX, fromY, toX, toY, fromBox, toBox){
      var start = edgePoint(fromX, fromY, toX, toY, fromBox);
      var end = edgePoint(toX, toY, fromX, fromY, toBox);
      var sx = start.x;
      var sy = start.y;
      var tx = end.x;
      var ty = end.y;
      var dx = Math.abs(tx - sx);
      var c1x = sx + (tx >= sx ? dx * 0.45 : -dx * 0.45);
      var c2x = tx - (tx >= sx ? dx * 0.45 : -dx * 0.45);
      return 'M ' + sx + ' ' + sy + ' C ' + c1x + ' ' + sy + ', ' + c2x + ' ' + ty + ', ' + tx + ' ' + ty;
    }

    function setNodePosition(node, x, y){
      node.setAttribute('data-sm-x', String(Math.round(x * 10) / 10));
      node.setAttribute('data-sm-y', String(Math.round(y * 10) / 10));
      node.style.left = x + 'px';
      node.style.top = y + 'px';
    }

    function updateEdgesForNode(nodeId, x, y){
      map.querySelectorAll('[data-sm-edge-to]').forEach(function(edge){
        if (edge.getAttribute('data-sm-edge-to') !== nodeId) return;
        var fromNodeId = edge.getAttribute('data-sm-edge-from-node');
        var fromNode = fromNodeId ? graph.querySelector('[data-sm-node-id="' + fromNodeId + '"]') : graph.querySelector('[data-sm-root]');
        var toNode = graph.querySelector('[data-sm-node-id="' + nodeId + '"]');
        var fromCenter = nodeCenter(fromNode, rootX, rootY);
        edge.setAttribute('d', pathData(
          fromCenter.x,
          fromCenter.y,
          x,
          y,
          nodeBox(fromNode, 184, 108),
          nodeBox(toNode, 154, 58)
        ));
      });
    }

    function updateEdgesFromNode(nodeId, x, y){
      map.querySelectorAll('[data-sm-edge-from-node]').forEach(function(edge){
        if (edge.getAttribute('data-sm-edge-from-node') !== nodeId) return;
        var toId = edge.getAttribute('data-sm-edge-to');
        var toNode = toId ? graph.querySelector('[data-sm-node-id="' + toId + '"]') : null;
        if (!toNode) return;
        var toCenter = nodeCenter(toNode, 0, 0);
        edge.setAttribute('data-sm-edge-from-x', String(Math.round(x * 10) / 10));
        edge.setAttribute('data-sm-edge-from-y', String(Math.round(y * 10) / 10));
        edge.setAttribute('d', pathData(
          x,
          y,
          toCenter.x,
          toCenter.y,
          nodeBox(graph.querySelector('[data-sm-node-id="' + nodeId + '"]'), 154, 58),
          nodeBox(toNode, 154, 58)
        ));
      });
    }

    function refreshEdges(){
      map.querySelectorAll('[data-sm-edge-to]').forEach(function(edge){
        var toId = edge.getAttribute('data-sm-edge-to');
        var toNode = toId ? graph.querySelector('[data-sm-node-id="' + toId + '"]') : null;
        if (!toNode) return;
        var toCenter = nodeCenter(toNode, 0, 0);
        updateEdgesForNode(toId, toCenter.x, toCenter.y);
      });
    }

    function resetNodePositions(){
      graph.querySelectorAll('[data-sm-draggable="1"]').forEach(function(node){
        var nodeId = node.getAttribute('data-sm-node-id');
        var originX = Number(node.getAttribute('data-sm-origin-x')) || Number(node.getAttribute('data-sm-x')) || parseFloat(node.style.left) || 0;
        var originY = Number(node.getAttribute('data-sm-origin-y')) || Number(node.getAttribute('data-sm-y')) || parseFloat(node.style.top) || 0;
        setNodePosition(node, originX, originY);
        if (nodeId) updateEdgesForNode(nodeId, originX, originY);
        if (nodeId) updateEdgesFromNode(nodeId, originX, originY);
      });
    }

    function applyZoom(){
      stage.style.width = Math.ceil(baseWidth * zoom) + 'px';
      stage.style.height = Math.ceil(baseHeight * zoom) + 'px';
      graph.style.transform = 'scale(' + zoom + ')';
      if (label) label.textContent = Math.round(zoom * 100) + '%';
    }

    function setZoom(nextZoom, anchorX, anchorY){
      var oldZoom = zoom;
      var x = anchorX == null ? viewport.clientWidth / 2 : anchorX;
      var y = anchorY == null ? viewport.clientHeight / 2 : anchorY;
      var graphX = (viewport.scrollLeft + x) / oldZoom;
      var graphY = (viewport.scrollTop + y) / oldZoom;
      zoom = clamp(nextZoom, 0.65, 1.8);
      applyZoom();
      viewport.scrollLeft = Math.max(0, graphX * zoom - x);
      viewport.scrollTop = Math.max(0, graphY * zoom - y);
    }

    function centerRoot(){
      var rootNode = graph.querySelector('[data-sm-root]');
      var rootCenter = nodeCenter(rootNode, rootX, rootY);
      var scaledRootX = rootCenter.x * zoom;
      var scaledRootY = rootCenter.y * zoom;
      viewport.scrollLeft = Math.max(0, scaledRootX - viewport.clientWidth / 2);
      viewport.scrollTop = Math.max(0, scaledRootY - viewport.clientHeight / 2);
    }

    function layerEnabled(layer){
      var input = map.querySelector('[data-sm-toggle-layer="' + layer + '"]');
      return !input || input.checked;
    }

    function overflowGroupExpanded(group){
      if (!group) return true;
      var toggle = map.querySelector('[data-sm-more-toggle="' + group + '"]');
      return !!toggle && toggle.getAttribute('aria-expanded') === 'true';
    }

    function updateVisibility(){
      var showLeaves = true;
      var leafToggle = map.querySelector('[data-sm-toggle-leaves]');
      if (leafToggle) showLeaves = leafToggle.checked;
      var layers = {
        definition: layerEnabled('definition'),
        measurement: layerEnabled('measurement')
      };
      map.querySelectorAll('[data-sm-layer]').forEach(function(el){
        var layer = el.getAttribute('data-sm-layer');
        var isLeaf = el.getAttribute('data-sm-leaf') === '1';
        var overflowGroup = el.getAttribute('data-sm-overflow-group');
        var shouldHide = !layers[layer] || (isLeaf && !showLeaves) || !overflowGroupExpanded(overflowGroup);
        el.setAttribute('data-sm-filter-hidden', shouldHide ? '1' : '0');
        el.hidden = shouldHide;
        el.toggleAttribute('hidden', shouldHide);
        el.setAttribute('aria-hidden', shouldHide ? 'true' : 'false');
        el.style.display = shouldHide ? 'none' : '';
      });
      map.querySelectorAll('[data-sm-edge-to]').forEach(function(edge){
        var toId = edge.getAttribute('data-sm-edge-to');
        var fromId = edge.getAttribute('data-sm-edge-from-node');
        var toNode = toId ? graph.querySelector('[data-sm-node-id="' + toId + '"]') : null;
        var fromNode = fromId ? graph.querySelector('[data-sm-node-id="' + fromId + '"]') : null;
        var filterHidden = edge.getAttribute('data-sm-filter-hidden') === '1';
        var endpointHidden = (toNode && toNode.hidden) || (fromNode && fromNode.hidden);
        var shouldHideEdge = filterHidden || endpointHidden;
        edge.hidden = shouldHideEdge;
        edge.toggleAttribute('hidden', shouldHideEdge);
        edge.setAttribute('aria-hidden', shouldHideEdge ? 'true' : 'false');
        edge.style.display = shouldHideEdge ? 'none' : '';
      });
    }

    function setMoreExpanded(toggle, expanded){
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      var nextLabel = expanded
        ? toggle.getAttribute('data-sm-expanded-label')
        : toggle.getAttribute('data-sm-collapsed-label');
      var title = toggle.querySelector('.sm-node-title');
      if (title && nextLabel) title.textContent = nextLabel;
      if (nextLabel) toggle.setAttribute('title', nextLabel);
      updateVisibility();
      refreshEdges();
    }

    function collapseMoreGroups(){
      map.querySelectorAll('[data-sm-more-toggle]').forEach(function(toggle){
        setMoreExpanded(toggle, false);
      });
    }

    map.querySelectorAll('[data-sm-action]').forEach(function(button){
      button.addEventListener('click', function(){
        var action = button.getAttribute('data-sm-action');
        if (action === 'zoom-in') setZoom(zoom + 0.15);
        if (action === 'zoom-out') setZoom(zoom - 0.15);
        if (action === 'reset') {
          zoom = 1;
          collapseMoreGroups();
          resetNodePositions();
          applyZoom();
          centerRoot();
        }
      });
    });

    map.querySelectorAll('[data-sm-toggle-layer], [data-sm-toggle-leaves]').forEach(function(input){
      input.addEventListener('change', updateVisibility);
    });

    graph.querySelectorAll('[data-sm-more-toggle]').forEach(function(toggle){
      toggle.addEventListener('click', function(ev){
        if (Date.now() < suppressMoreClickUntil) {
          ev.preventDefault();
          return;
        }
        ev.preventDefault();
        setMoreExpanded(toggle, toggle.getAttribute('aria-expanded') !== 'true');
      });
      toggle.addEventListener('keydown', function(ev){
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        setMoreExpanded(toggle, toggle.getAttribute('aria-expanded') !== 'true');
      });
    });

    graph.querySelectorAll('[data-sm-draggable="1"]').forEach(function(node){
      node.addEventListener('pointerdown', function(ev){
        if (ev.button != null && ev.button !== 0) return;
        if (node.hidden) return;
        var nodeId = node.getAttribute('data-sm-node-id');
        if (!nodeId) return;
        ev.preventDefault();
        dragState = {
          node: node,
          nodeId: nodeId,
          pointerId: ev.pointerId,
          startClientX: ev.clientX,
          startClientY: ev.clientY,
          startX: Number(node.getAttribute('data-sm-x')) || parseFloat(node.style.left) || 0,
          startY: Number(node.getAttribute('data-sm-y')) || parseFloat(node.style.top) || 0,
          moved: false
        };
        node.classList.add('is-dragging');
        node.setPointerCapture(ev.pointerId);
      });

      node.addEventListener('pointermove', function(ev){
        if (!dragState || dragState.node !== node) return;
        ev.preventDefault();
        var deltaX = ev.clientX - dragState.startClientX;
        var deltaY = ev.clientY - dragState.startClientY;
        if (Math.sqrt(deltaX * deltaX + deltaY * deltaY) > 3) dragState.moved = true;
        var nextX = clamp(dragState.startX + deltaX / zoom, 52, baseWidth - 52);
        var nextY = clamp(dragState.startY + deltaY / zoom, 36, baseHeight - 36);
        setNodePosition(node, nextX, nextY);
        updateEdgesForNode(dragState.nodeId, nextX, nextY);
        updateEdgesFromNode(dragState.nodeId, nextX, nextY);
      });

      function finishDrag(ev){
        if (!dragState || dragState.node !== node) return;
        var wasMoved = dragState.moved;
        var isMoreToggle = node.hasAttribute('data-sm-more-toggle');
        node.classList.remove('is-dragging');
        if (node.hasPointerCapture && node.hasPointerCapture(dragState.pointerId)) {
          node.releasePointerCapture(dragState.pointerId);
        }
        dragState = null;
        if (!wasMoved && isMoreToggle) {
          suppressMoreClickUntil = Date.now() + 300;
          setMoreExpanded(node, node.getAttribute('aria-expanded') !== 'true');
        } else if (wasMoved && isMoreToggle) {
          suppressMoreClickUntil = Date.now() + 300;
        }
      }

      node.addEventListener('pointerup', finishDrag);
      node.addEventListener('pointercancel', finishDrag);
    });

    viewport.addEventListener('wheel', function(ev){
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      var rect = viewport.getBoundingClientRect();
      var delta = ev.deltaY < 0 ? 0.12 : -0.12;
      setZoom(zoom + delta, ev.clientX - rect.left, ev.clientY - rect.top);
    }, { passive: false });

    applyZoom();
    updateVisibility();
    requestAnimationFrame(function(){
      refreshEdges();
      centerRoot();
    });
  }

  function init(){
    document.querySelectorAll('[data-sm-map]').forEach(initSkillMap);
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
    // 卡片来源无逐样本通过数:状态 / 通过列都给「—」,不显误导的 ✅ 与 0/N。
    const status = h.resultsStripped ? '—' : h.failCount === 0 ? '✅' : `❌ ${h.failCount} fail`;
    const passCell = h.resultsStripped ? '—' : `${h.passCount}/${h.totalSamples}`;
    const link = `<a href="/reports/${e(h.reportId)}${langQ}">${e(h.reportId)}</a>`;
    return `<tr><td>${date}</td><td>${score}</td><td>${passCell}</td><td>${status}</td><td>${link}</td></tr>`;
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
  // 别项目索引卡片(resultsStripped)pass/fail 被剥成 0:不能让 failCount===0 误判绿带「全通过」。
  // 卡片可信信号只有 compositeScore,据它定带(>=4 绿 / >=3 黄 / 否则红,与 renderScoreBar 阈值一致);无分时中性灰。
  const sectBand = snap.resultsStripped
    ? (snap.compositeScore == null ? 'gray' : snap.compositeScore >= 4 ? 'green' : snap.compositeScore >= 3 ? 'yellow' : 'red')
    : snap.failCount === 0 ? 'green' : snap.passCount === 0 ? 'red' : 'yellow';

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

  const failedHeading = snap.resultsStripped
    // 卡片来源无逐样本数据:既不能显「失败」也不能显「全通过」,给出「明细在源项目」占位。
    ? `<div class="si-sect-line">${lang === 'zh' ? '逐样本明细需在源项目查看' : 'per-sample details available in source project'}</div>`
    : failedSamples.length > 0
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
      <span class="si-sect-meta">${snap.totalSamples} ${lang === 'zh' ? '用例' : 'samples'} · ${snap.resultsStripped ? (lang === 'zh' ? '明细在源项目' : 'details in source project') : `${pct}% ${lang === 'zh' ? '通过' : 'pass'}`}${snap.compositeScore != null ? ` · ${snap.compositeScore.toFixed(2)}/5` : ''} · ${relTime(snap.timestamp, lang)}</span>
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

function skillMapBand(entry: SkillIndexEntry): 'green' | 'yellow' | 'red' | 'gray' {
  if (entry.doctor?.failCount || entry.eval?.failCount) return 'red';
  if (entry.doctor?.warnCount || (entry.eval?.compositeScore != null && entry.eval.compositeScore < 3.5)) return 'yellow';
  if (entry.doctor || entry.eval || entry.observe) return 'green';
  return 'gray';
}

function stageText(entry: SkillIndexEntry, stage: 'doctor' | 'eval' | 'observe', lang: Lang): string {
  const zh = lang === 'zh';
  if (stage === 'doctor') {
    if (!entry.doctor) return zh ? '未体检' : 'not checked';
    if (entry.doctor.failCount > 0) return zh ? '未通过' : 'failed';
    if (entry.doctor.warnCount > 0) return zh ? '有警告' : 'warnings';
    return zh ? '已通过' : 'passed';
  }
  if (stage === 'eval') {
    if (!entry.eval) return zh ? '未测量' : 'not measured';
    if (entry.eval.resultsStripped) return entry.eval.compositeScore != null ? `${entry.eval.compositeScore.toFixed(2)}/5` : (zh ? '已测量' : 'measured');
    return zh
      ? `${entry.eval.passCount}/${entry.eval.totalSamples} 用例通过`
      : `${entry.eval.passCount}/${entry.eval.totalSamples} samples pass`;
  }
  if (!entry.observe) return zh ? '未观察' : 'not observed';
  return zh
    ? `${entry.observe.segmentCount} 段，gap ${Math.round(entry.observe.gapRate * 100)}%`
    : `${entry.observe.segmentCount} segments, gap ${Math.round(entry.observe.gapRate * 100)}%`;
}

function mermaidCardLabel(label: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '\\': '&#92;',
    '"': '&quot;',
    '[': '&#91;',
    ']': '&#93;',
    '(': '&#40;',
    ')': '&#41;',
    '{': '&#123;',
    '}': '&#125;',
    '|': '&#124;',
    '#': '&#35;',
    ';': '&#59;',
    '<': '&lt;',
    '>': '&gt;',
  };
  return label
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[&\\"[\](){}|#;<>]/g, (ch) => entities[ch] ?? ch);
}

function markdownInline(value: string | undefined): string {
  if (!value) return '`unknown`';
  return `\`${value.replaceAll('`', '\\`')}\``;
}

function sourceCommandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

const DEFINITION_PREVIEW_KINDS = new Set([
  'frontmatter',
  'reference',
  'script',
  'hard_rule',
  'workflow',
  'workflow_node',
]);

const MEASUREMENT_PREVIEW_KINDS = new Set([
  'sample',
  'assertion',
  'diagnostic',
]);

function nodeKindLabel(kind: string, lang: Lang): string {
  const zh = lang === 'zh';
  const labels: Record<string, [string, string]> = {
    frontmatter: ['meta', 'meta'],
    reference: ['ref', 'ref'],
    script: ['script', 'script'],
    tool: ['tool', 'tool'],
    preflight: ['preflight', 'preflight'],
    hard_rule: ['rule', 'rule'],
    workflow: ['workflow', 'workflow'],
    workflow_node: ['step', 'step'],
    sample: ['sample', 'sample'],
    assertion: ['assert', 'assert'],
    diagnostic: ['diag', 'diag'],
    doctor_rule_result: ['doctor', 'doctor'],
    eval_result: ['eval', 'eval'],
    trace_session: ['observe', 'observe'],
    more: ['more', 'more'],
  };
  const pair = labels[kind] ?? [kind, kind];
  return zh ? pair[0] : pair[1];
}

function graphNodeDisplayLabel(node: SkillGraphNodePreview, lang: Lang): string {
  const zh = lang === 'zh';
  switch (node.nodeKind) {
    case 'workflow':
      return `${zh ? 'workflow' : 'workflow'}: ${node.label}`;
    case 'hard_rule':
      return `${zh ? 'rule' : 'rule'}: ${node.label}`;
    case 'tool':
      return `${zh ? 'tool' : 'tool'}: ${node.label}`;
    case 'sample':
      return `${zh ? 'sample' : 'sample'}: ${node.label}`;
    case 'diagnostic':
      return node.label.startsWith('diagnostic') ? node.label : `${zh ? 'diagnostic' : 'diagnostic'}: ${node.label}`;
    default:
      return node.label;
  }
}

function graphNodeMapLabel(node: SkillGraphNodePreview): string {
  switch (node.nodeKind) {
    case 'workflow':
    case 'hard_rule':
    case 'tool':
    case 'sample':
      return node.label;
    case 'assertion':
      return node.label.replace(/^assertion:\s*/i, '');
    case 'diagnostic':
      return node.label.replace(/^diagnostic:\s*/i, '');
    default:
      return node.label;
  }
}

function previewNodes(
  nodes: SkillGraphNodePreview[] | undefined,
  allowedKinds: Set<string>,
  limit: number,
): { visible: SkillGraphNodePreview[]; hiddenCount: number } {
  const filtered = (nodes ?? []).filter((node) => allowedKinds.has(node.nodeKind));
  return { visible: filtered.slice(0, limit), hiddenCount: Math.max(0, filtered.length - limit) };
}

interface SkillMapPositionedNode {
  id: string;
  node: SkillGraphNodePreview;
  layer: 'definition' | 'measurement';
  x: number;
  y: number;
  edgeFrom?: { x: number; y: number };
  overflowGroup?: 'definition' | 'measurement';
  moreToggle?: {
    group: 'definition' | 'measurement';
    collapsedLabel: string;
    expandedLabel: string;
  };
}

const SKILL_MAP_WIDTH = 1100;
const SKILL_MAP_HEIGHT = 560;
const SKILL_MAP_ROOT_ID = 'skill-root';
const SKILL_MAP_ROOT = { x: 470, y: 260 };
const SKILL_MAP_ROOT_SIZE = { width: 172, height: 86 };
const SKILL_MAP_NODE_SIZE = { width: 148, height: 54 };
const SKILL_MAP_DEFINITION_COORDS = [
  { x: 170, y: 112 },
  { x: 140, y: 255 },
  { x: 220, y: 420 },
  { x: 392, y: 112 },
  { x: 382, y: 425 },
  { x: 312, y: 190 },
  { x: 310, y: 328 },
];
const SKILL_MAP_MEASUREMENT_COORDS = [
  { x: 720, y: 105 },
  { x: 920, y: 165 },
  { x: 750, y: 275 },
  { x: 948, y: 318 },
  { x: 770, y: 430 },
  { x: 960, y: 430 },
];
const SKILL_MAP_NODE_MARGIN = { x: 92, y: 48 };
const SKILL_MAP_STATUS_CLASSES = new Set(['ok', 'warning', 'failed', 'skipped', 'unknown', 'not_measured']);

function graphNodeStatusClass(node: SkillGraphNodePreview): string {
  return node.status && SKILL_MAP_STATUS_CLASSES.has(node.status) ? ` sm-node--${node.status}` : '';
}

function graphNodeCoverageClass(node: SkillGraphNodePreview): string {
  if (node.coverage === 'declared') return ' sm-node--coverage-declared';
  if (node.coverage === 'undeclared') return ' sm-node--coverage-undeclared';
  return '';
}

function graphNodeCoverageLabel(node: SkillGraphNodePreview, lang: Lang): string {
  if (node.coverage === 'declared') return lang === 'zh' ? '已声明覆盖关系' : 'declared coverage';
  if (node.coverage === 'undeclared') return lang === 'zh' ? '未声明覆盖关系' : 'coverage not declared';
  return '';
}

function positionedNodeStyle(node: Pick<SkillMapPositionedNode, 'x' | 'y'>): string {
  return `left:${node.x}px;top:${node.y}px`;
}

function renderSkillMapNode(item: SkillMapPositionedNode, lang: Lang): string {
  const title = graphNodeMapLabel(item.node);
  const coverageLabel = graphNodeCoverageLabel(item.node, lang);
  const fullTitle = [graphNodeDisplayLabel(item.node, lang), coverageLabel].filter(Boolean).join(' · ');
  const kindClass = item.node.nodeKind === 'more' ? ' sm-node--more' : '';
  const leaf = item.layer === 'definition' || item.layer === 'measurement' ? ' data-sm-leaf="1"' : '';
  const draggable = item.layer === 'definition' || item.layer === 'measurement' ? ' data-sm-draggable="1"' : '';
  const overflow = item.overflowGroup ? ` data-sm-overflow-group="${item.overflowGroup}" hidden aria-hidden="true"` : '';
  const moreToggle = item.moreToggle
    ? ` data-sm-more-toggle="${item.moreToggle.group}" data-sm-collapsed-label="${e(item.moreToggle.collapsedLabel)}" data-sm-expanded-label="${e(item.moreToggle.expandedLabel)}" role="button" tabindex="0" aria-expanded="false"`
    : '';
  return `<div class="sm-node sm-node--${item.layer}${kindClass}${graphNodeStatusClass(item.node)}${graphNodeCoverageClass(item.node)}" data-sm-node-id="${e(item.id)}" data-sm-layer="${item.layer}" data-sm-x="${item.x}" data-sm-y="${item.y}" data-sm-origin-x="${item.x}" data-sm-origin-y="${item.y}"${leaf}${draggable}${overflow}${moreToggle} style="${positionedNodeStyle(item)}" title="${e(fullTitle)}">
    <div class="sm-node-kind">${e(nodeKindLabel(item.node.nodeKind, lang))}</div>
    <div class="sm-node-title">${e(title)}</div>
  </div>`;
}

function edgePoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
  box: { width: number; height: number },
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const scale = Math.min(
    dx === 0 ? Infinity : box.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.height / 2 / Math.abs(dy),
  );
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

function skillMapPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromBox: { width: number; height: number },
  toBox: { width: number; height: number },
): string {
  const start = edgePoint(from, to, fromBox);
  const end = edgePoint(to, from, toBox);
  const dx = Math.abs(end.x - start.x);
  const c1x = start.x + (end.x >= start.x ? dx * 0.45 : -dx * 0.45);
  const c2x = end.x - (end.x >= start.x ? dx * 0.45 : -dx * 0.45);
  return `M ${start.x} ${start.y} C ${c1x} ${start.y}, ${c2x} ${end.y}, ${end.x} ${end.y}`;
}

function renderSkillMapEdges(nodes: SkillMapPositionedNode[], dimensions: { width: number; height: number }): string {
  const rootEdges = nodes
    .map((node) => {
      const from = node.edgeFrom ?? SKILL_MAP_ROOT;
      const fromBox = node.edgeFrom ? SKILL_MAP_NODE_SIZE : SKILL_MAP_ROOT_SIZE;
      const overflow = node.overflowGroup ? ` data-sm-overflow-group="${node.overflowGroup}" hidden aria-hidden="true"` : '';
      const fromNodeId = node.overflowGroup ? `${node.overflowGroup}-more` : SKILL_MAP_ROOT_ID;
      return `<path class="sm-edge sm-edge--${node.layer}" data-sm-layer="${node.layer}" data-sm-leaf="1" data-sm-edge-to="${e(node.id)}" data-sm-edge-from-node="${e(fromNodeId)}" data-sm-edge-from-x="${from.x}" data-sm-edge-from-y="${from.y}"${overflow} d="${skillMapPath(from, node, fromBox, SKILL_MAP_NODE_SIZE)}"></path>`;
    })
    .join('');
  return `<svg class="sm-svg" viewBox="0 0 ${dimensions.width} ${dimensions.height}" aria-hidden="true">${rootEdges}</svg>`;
}

function moreNode(label: string): SkillGraphNodePreview {
  return { nodeKind: 'more', label };
}

function overflowNodePosition(layer: 'definition' | 'measurement', index: number): { x: number; y: number } {
  const columns = layer === 'definition' ? [112, 270, 428] : [720, 880, 1040];
  const startY = layer === 'definition' ? 500 : 560;
  return {
    x: columns[index % columns.length],
    y: startY + Math.floor(index / columns.length) * 98,
  };
}

function skillMapDimensions(nodes: SkillMapPositionedNode[]): { width: number; height: number } {
  return {
    width: Math.max(SKILL_MAP_WIDTH, ...nodes.map((node) => node.x + SKILL_MAP_NODE_MARGIN.x)),
    height: Math.max(SKILL_MAP_HEIGHT, ...nodes.map((node) => node.y + SKILL_MAP_NODE_MARGIN.y)),
  };
}

function renderSkillStageRail(entry: SkillIndexEntry, lang: Lang): string {
  const doctorStatus = entry.doctor?.failCount ? 'failed' : entry.doctor?.warnCount ? 'warning' : entry.doctor ? 'ok' : 'pending';
  const evalStatus = entry.eval?.failCount ? 'failed' : entry.eval ? 'ok' : 'pending';
  const observeStatus = entry.observe ? (entry.observe.healthBand === 'red' ? 'failed' : entry.observe.healthBand === 'yellow' ? 'warning' : 'ok') : 'pending';
  const card = (key: string, value: string, status: string): string => `<div class="sm-stage-card sm-stage-card--${status}">
    <div class="sm-stage-k">${e(key)}</div>
    <div class="sm-stage-v">${e(value)}</div>
  </div>`;
  return `<div class="sm-stage-rail" aria-label="${lang === 'zh' ? '三阶段状态' : 'Stage status'}">
    ${card('doctor', stageText(entry, 'doctor', lang), doctorStatus)}
    <div class="sm-stage-arrow">→</div>
    ${card('eval', stageText(entry, 'eval', lang), evalStatus)}
    <div class="sm-stage-arrow">→</div>
    ${card('observe', stageText(entry, 'observe', lang), observeStatus)}
  </div>`;
}

function orderedPreviewNodes(
  nodes: SkillGraphNodePreview[] | undefined,
  allowedKinds: Set<string>,
  priority: Record<string, number>,
): SkillGraphNodePreview[] {
  return (nodes ?? [])
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => allowedKinds.has(node.nodeKind))
    .sort((a, b) => (priority[a.node.nodeKind] ?? 99) - (priority[b.node.nodeKind] ?? 99) || a.index - b.index)
    .map(({ node }) => node);
}

function applyDefinitionCoverageDeclarations(
  nodes: SkillGraphNodePreview[] | undefined,
  declaredStableKeys: string[] | undefined,
): SkillGraphNodePreview[] | undefined {
  if (!nodes) return undefined;
  if (!declaredStableKeys || declaredStableKeys.length === 0) return nodes;
  const declared = new Set(declaredStableKeys);
  return nodes.map((node) => {
    if (!node.stableKey || !DEFINITION_PREVIEW_KINDS.has(node.nodeKind)) return node;
    return { ...node, coverage: declared.has(node.stableKey) ? 'declared' : 'undeclared' };
  });
}

function skillMapCoverageDeclarationSummary(
  doctor: NonNullable<SkillGraphSnapshot['doctor']> | undefined,
  evalGraph: NonNullable<SkillGraphSnapshot['eval']> | undefined,
  lang: Lang,
): string | null {
  const declaredKeys = new Set(evalGraph?.declaredCoverageStableKeys ?? []);
  if (!doctor || declaredKeys.size === 0) return null;
  const coverable = doctor.definitionNodes.filter((node) => node.stableKey && DEFINITION_PREVIEW_KINDS.has(node.nodeKind));
  if (coverable.length === 0) return null;
  const declaredCount = coverable.filter((node) => node.stableKey && declaredKeys.has(node.stableKey)).length;
  return lang === 'zh'
    ? `声明锚点 ${declaredCount}/${coverable.length}`
    : `declared anchors ${declaredCount}/${coverable.length}`;
}

function renderSkillEvidenceMarkdown(entry: SkillIndexEntry, lang: Lang): string {
  const zh = lang === 'zh';
  const graph = entry.graph;
  const doctor = graph?.doctor;
  const evalGraph = graph?.eval;
  const source = graph?.sourceLocator ?? entry.skillName;
  const sourceArg = sourceCommandArg(source);
  const doctorStatus = stageText(entry, 'doctor', lang);
  const evalStatus = stageText(entry, 'eval', lang);
  const observeStatus = stageText(entry, 'observe', lang);
  const stepSeparator = zh ? '：' : ':';
  const summary = zh
    ? `这个 skill 当前处于「doctor ${doctorStatus}，eval ${evalStatus}，observe ${observeStatus}」状态。`
    : `Current state: doctor ${doctorStatus}, eval ${evalStatus}, observe ${observeStatus}.`;
  const nextSteps = [
    !entry.doctor ? `- ${zh ? '体检结构' : 'Check structure'}${stepSeparator} \`omk doctor ${sourceArg}\`` : '',
    !entry.eval ? `- ${zh ? '测量效果' : 'Measure impact'}${stepSeparator} \`omk eval --control baseline --treatment ${sourceArg}\`` : '',
    !entry.observe ? `- ${zh ? '接入观察' : 'Add observation'}${stepSeparator} \`omk observe ingest <trace-dir>\`` : '',
  ].filter(Boolean);
  const coverageSummary = skillMapCoverageDeclarationSummary(doctor, evalGraph, lang);
  const definitionPreview = previewNodes(applyDefinitionCoverageDeclarations(doctor?.definitionNodes, evalGraph?.declaredCoverageStableKeys), DEFINITION_PREVIEW_KINDS, 8);
  const measurementPreview = previewNodes(evalGraph?.measurementNodes, MEASUREMENT_PREVIEW_KINDS, 8);
  const previewMermaidLines = [
    ...definitionPreview.visible.flatMap((node, index) => [
      `  def_${index}["${mermaidCardLabel(graphNodeDisplayLabel(node, lang))}"]`,
      `  skill --> def_${index}`,
    ]),
    ...measurementPreview.visible.flatMap((node, index) => [
      `  measure_${index}["${mermaidCardLabel(graphNodeDisplayLabel(node, lang))}"]`,
      `  skill --> measure_${index}`,
    ]),
  ];

  return [
    `## Skill Evidence Card：${entry.skillName}`,
    '',
    summary,
    '',
    '```mermaid',
    'flowchart LR',
    `  skill["SKILL.md: ${mermaidCardLabel(entry.skillName)}"]`,
    `  doctor["doctor: ${mermaidCardLabel(doctorStatus)}"]`,
    `  eval["eval: ${mermaidCardLabel(evalStatus)}"]`,
    `  observe["observe: ${mermaidCardLabel(observeStatus)}"]`,
    ...previewMermaidLines,
    '  doctor --> eval',
    '  eval --> observe',
    '```',
    '',
    zh ? '### 三阶段状态' : '### Stage Status',
    '',
    `| ${zh ? '阶段' : 'Stage'} | ${zh ? '状态' : 'Status'} | ${zh ? '证据' : 'Evidence'} |`,
    '| --- | --- | --- |',
    `| doctor | ${doctorStatus} | ${doctor ? `${doctor.nodeCount} nodes / ${doctor.edgeCount} edges` : (zh ? '无 graph' : 'no graph')} |`,
    `| eval | ${evalStatus} | ${evalGraph ? `${zh ? 'variant 子图' : 'variant subgraph'}: ${evalGraph.nodeCount} nodes / ${evalGraph.edgeCount} edges` : (zh ? '无 graph' : 'no graph')} |`,
    `| observe | ${observeStatus} | ${zh ? '未接 production graph' : 'production graph not connected'} |`,
    ...(coverageSummary ? ['', zh ? '### 声明锚点' : '### Declared Anchors', '', coverageSummary] : []),
    '',
    zh ? '### 关键计数' : '### Key Counts',
    '',
    '| references | scripts | workflows | workflow nodes | samples | failed samples |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${doctor?.references ?? 0} | ${doctor?.scripts ?? 0} | ${doctor?.workflows ?? 0} | ${doctor?.workflowNodes ?? 0} | ${entry.eval?.totalSamples ?? 0} | ${entry.eval?.failCount ?? 0} |`,
    ...(nextSteps.length > 0 ? ['', zh ? '### 下一步' : '### Next Steps', '', ...nextSteps] : []),
    '',
    zh ? '### 复现信息' : '### Reproduction',
    '',
    `- source：${markdownInline(source)}`,
    `- artifactHash：${markdownInline(graph?.artifactHash)}`,
    `- binding：${markdownInline(graph?.bindingStrength)}`,
    `- doctorGraphId：${markdownInline(doctor?.graphId)}`,
    `- evalGraphId：${markdownInline(evalGraph?.graphId)}`,
    '',
  ].join('\n');
}

function renderSkillMapSection(entry: SkillIndexEntry, lang: Lang): string {
  const graph = entry.graph;
  if (!graph) return '';
  const zh = lang === 'zh';
  const doctor = graph.doctor;
  const evalGraph = graph.eval;
  const band = skillMapBand(entry);
  const markdown = renderSkillEvidenceMarkdown(entry, lang);
  const definitionNodesWithCoverageDeclarations = applyDefinitionCoverageDeclarations(doctor?.definitionNodes, evalGraph?.declaredCoverageStableKeys);
  const coverageSummary = skillMapCoverageDeclarationSummary(doctor, evalGraph, lang);
  const definitionCandidates = orderedPreviewNodes(definitionNodesWithCoverageDeclarations, DEFINITION_PREVIEW_KINDS, {
    reference: 1,
    script: 2,
    workflow: 3,
    hard_rule: 4,
    frontmatter: 5,
    workflow_node: 6,
  });
  const measurementCandidates = orderedPreviewNodes(evalGraph?.measurementNodes, MEASUREMENT_PREVIEW_KINDS, {
    sample: 1,
    diagnostic: 2,
    assertion: 3,
  });
  const definitionLimit = SKILL_MAP_DEFINITION_COORDS.length - 1;
  const measurementLimit = SKILL_MAP_MEASUREMENT_COORDS.length - 1;
  const definitionVisible = definitionCandidates.slice(0, definitionLimit);
  const definitionOverflow = definitionCandidates.slice(definitionLimit);
  const measurementVisible = measurementCandidates.slice(0, measurementLimit);
  const measurementOverflow = measurementCandidates.slice(measurementLimit);
  const definitionMorePosition = SKILL_MAP_DEFINITION_COORDS[SKILL_MAP_DEFINITION_COORDS.length - 1];
  const measurementMorePosition = SKILL_MAP_MEASUREMENT_COORDS[SKILL_MAP_MEASUREMENT_COORDS.length - 1];
  const definitionNodes: SkillMapPositionedNode[] = [
    ...definitionVisible.map((node, index) => ({
      id: `definition-${index}`,
      node,
      layer: 'definition' as const,
      ...SKILL_MAP_DEFINITION_COORDS[index],
    })),
    ...(definitionOverflow.length > 0 ? [{
      id: 'definition-more',
      node: moreNode(`+ ${definitionOverflow.length} ${zh ? '更多结构节点' : 'more structure nodes'}`),
      layer: 'definition' as const,
      moreToggle: {
        group: 'definition' as const,
        collapsedLabel: `+ ${definitionOverflow.length} ${zh ? '更多结构节点' : 'more structure nodes'}`,
        expandedLabel: zh ? '收起结构节点' : 'collapse structure nodes',
      },
      ...definitionMorePosition,
    }] : []),
    ...definitionOverflow.map((node, index) => ({
      id: `definition-overflow-${index}`,
      node,
      layer: 'definition' as const,
      edgeFrom: definitionMorePosition,
      overflowGroup: 'definition' as const,
      ...overflowNodePosition('definition', index),
    })),
  ];
  const measurementNodes: SkillMapPositionedNode[] = [
    ...measurementVisible.map((node, index) => ({
      id: `measurement-${index}`,
      node,
      layer: 'measurement' as const,
      ...SKILL_MAP_MEASUREMENT_COORDS[index],
    })),
    ...(measurementOverflow.length > 0 ? [{
      id: 'measurement-more',
      node: moreNode(`+ ${measurementOverflow.length} ${zh ? '更多测量节点' : 'more measurement nodes'}`),
      layer: 'measurement' as const,
      moreToggle: {
        group: 'measurement' as const,
        collapsedLabel: `+ ${measurementOverflow.length} ${zh ? '更多测量节点' : 'more measurement nodes'}`,
        expandedLabel: zh ? '收起测量节点' : 'collapse measurement nodes',
      },
      ...measurementMorePosition,
    }] : []),
    ...measurementOverflow.map((node, index) => ({
      id: `measurement-overflow-${index}`,
      node,
      layer: 'measurement' as const,
      edgeFrom: measurementMorePosition,
      overflowGroup: 'measurement' as const,
      ...overflowNodePosition('measurement', index),
    })),
  ];
  const mapNodes = [...definitionNodes, ...measurementNodes];
  const mapDimensions = skillMapDimensions(mapNodes);
  const topMeta = [
    coverageSummary,
    !coverageSummary && doctor ? `${doctor.nodeCount} ${zh ? '结构节点' : 'definition nodes'}` : '',
    evalGraph ? `${evalGraph.samples} ${zh ? '用例' : 'samples'}` : '',
  ].filter(Boolean).join(' · ');
  return `<section id="section-skill-map" class="si-sect si-sect--${band} sm-sect">
    <div class="si-sect-h">
      <span class="si-sect-title">🗺 ${zh ? 'Skill Map' : 'Skill Map'}</span>
      <span class="si-sect-meta">${e(topMeta || (zh ? '图谱数据未生成' : 'graph data missing'))}</span>
    </div>
    <div class="sm-body" data-sm-map data-sm-base-width="${mapDimensions.width}" data-sm-base-height="${mapDimensions.height}" data-sm-root-x="${SKILL_MAP_ROOT.x}" data-sm-root-y="${SKILL_MAP_ROOT.y}">
      ${renderSkillStageRail(entry, lang)}
      <div class="sm-toolbar" aria-label="${zh ? 'Skill Map 控制' : 'Skill Map controls'}">
        <div class="sm-tools">
          <button class="sm-tool" type="button" data-sm-action="zoom-out" title="${zh ? '缩小' : 'Zoom out'}">−</button>
          <span class="sm-zoom-label" data-sm-zoom-label>100%</span>
          <button class="sm-tool" type="button" data-sm-action="zoom-in" title="${zh ? '放大' : 'Zoom in'}">+</button>
          <button class="sm-tool" type="button" data-sm-action="reset" title="${zh ? '重置视图' : 'Reset view'}">${zh ? '重置' : 'Reset'}</button>
        </div>
        <div class="sm-toggles">
          <label class="sm-toggle"><input type="checkbox" data-sm-toggle-layer="definition" checked> ${zh ? '定义' : 'Definition'}</label>
          <label class="sm-toggle"><input type="checkbox" data-sm-toggle-layer="measurement" checked> ${zh ? '测量' : 'Measurement'}</label>
          <label class="sm-toggle"><input type="checkbox" data-sm-toggle-leaves checked> ${zh ? '叶子节点' : 'Leaf nodes'}</label>
        </div>
      </div>
      <div class="sm-canvas" data-sm-viewport aria-label="Skill Map">
        <div class="sm-graph-stage" data-sm-graph-stage style="width:${mapDimensions.width}px;height:${mapDimensions.height}px">
          <div class="sm-graph" data-sm-graph style="width:${mapDimensions.width}px;height:${mapDimensions.height}px">
            ${renderSkillMapEdges(mapNodes, mapDimensions)}
            <div class="sm-node sm-node--skill" data-sm-root data-sm-node-id="${SKILL_MAP_ROOT_ID}" data-sm-x="${SKILL_MAP_ROOT.x}" data-sm-y="${SKILL_MAP_ROOT.y}" data-sm-origin-x="${SKILL_MAP_ROOT.x}" data-sm-origin-y="${SKILL_MAP_ROOT.y}" data-sm-draggable="1" style="${positionedNodeStyle(SKILL_MAP_ROOT)}">
              <div class="sm-node-title">SKILL.md</div>
              <div class="sm-node-meta">${e(entry.skillName)}</div>
            </div>
            ${mapNodes.map((node) => renderSkillMapNode(node, lang)).join('')}
          </div>
        </div>
      </div>
      <details class="sm-card">
        <summary>${zh ? '复制 Markdown Evidence Card' : 'Copy Markdown Evidence Card'}</summary>
        <textarea readonly>${e(markdown)}</textarea>
      </details>
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
      ${renderSkillMapSection(entry, lang)}
      ${renderDoctorSection(entry.doctor, entry.doctorHistory, entry.skillName, lang)}
      ${renderEvalSection(entry.eval, evalReport, entry.evalHistory, langQ, lang)}
      ${renderObserveSection(entry.observe, langQ, lang)}
    </main>
    <style>${SKILL_DETAIL_CSS}</style>
    ${TREND_INIT_SCRIPT}
    ${SKILL_MAP_INIT_SCRIPT}
  `, lang);
}
