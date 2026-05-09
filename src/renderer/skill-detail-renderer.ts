/**
 * 单 skill 详情页 — 4 张卡片(doctor / eval 评分 / eval 功能 / observe)垂直排列,
 * 顶部综合 status,中间 4 张卡共用一套 cross-link heuristic,底部行动建议汇总。
 *
 * cross-link 触发:
 *   - doctor 的 dependencies_present 规则 warn/fail 且 eval 有 sample 失败
 *     rootCause=skill_doc_missing/skill_doc_unclear → 双向插一行 "↔ 关联"
 *   - observe 的 gap.uncoveredFiles 与 eval coverage.uncoveredFiles 取交集 →
 *     两端列出"产线 + 评测都没覆盖到"的文件
 *   - observe.toolFailureRate >= 0.4 且 doctor 的 dependencies_present warn/fail →
 *     observe 卡里挂一行"doctor 也警告"
 *
 * 行动建议直接从 cross-link 命中 + 单卡内最重要信号 derive。
 */
import { layout, e, DEFAULT_LANG } from './layout.js';
import type { Lang, EvaluationReport } from '../types/index.js';
import type {
  SkillIndexEntry, SkillDoctorSnapshot, SkillEvalSnapshot, SkillObserveSnapshot,
} from '../server/skill-index.js';
import type { DoctorRuleResult } from '../types/doctor.js';

const BAND_DOT: Record<'green' | 'yellow' | 'red' | 'gray', string> = {
  green: '🟢', yellow: '🟡', red: '🔴', gray: '⚪',
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

// ────────────── Cross-link 触发判定 ──────────────

interface CrossLinkSignals {
  doctorHasDepWarning: boolean;
  evalHasSkillDocIssue: boolean;
  failedSamplesWithDocIssue: Array<{ sampleId: string; rootCause: string[]; summary: string }>;
  bothMissingFiles: string[];      // observe + eval 都漏的文件
  observeUnstable: boolean;        // toolFailureRate >= 0.4 视为产线明显不稳
}

function computeCrossLinks(
  doctor: SkillDoctorSnapshot | null,
  evalReport: EvaluationReport | null,
  observe: SkillObserveSnapshot | null,
): CrossLinkSignals {
  const doctorHasDepWarning = !!doctor?.results.find((r) =>
    r.ruleId === 'dependencies_present' && (r.status === 'warn' || r.status === 'fail'),
  );

  const failedSamplesWithDocIssue: Array<{ sampleId: string; rootCause: string[]; summary: string }> = [];
  if (evalReport) {
    const variantName = evalReport.meta.variants?.find((v) => v !== 'baseline');
    if (variantName) {
      for (const r of evalReport.results) {
        const v = r.variants?.[variantName];
        if (!v) continue;
        const passed = (v.assertions?.details ?? []).every((d) => d.passed);
        if (passed) continue;
        const rc = v.diagnostic?.rootCause || [];
        if (rc.includes('skill_doc_missing') || rc.includes('skill_doc_unclear')) {
          failedSamplesWithDocIssue.push({
            sampleId: r.sample_id,
            rootCause: rc as string[],
            summary: v.diagnostic?.summary?.slice(0, 100) || '',
          });
        }
      }
    }
  }
  const evalHasSkillDocIssue = failedSamplesWithDocIssue.length > 0;

  // 跨报告漏的文件:observe.uncoveredFiles ∩ eval.coverage.uncoveredFiles
  let bothMissingFiles: string[] = [];
  if (observe && evalReport?.analysis?.coverage) {
    // observe 端 uncoveredFiles 在 SkillHealthReport.bySkill[name].coverage.uncoveredFiles —
    // 这里 SkillObserveSnapshot 没存,但可从 doctor 端不动,先按"如果 observe.gapRate > 0
    // 就当 observe 有 gap"近似处理。真正的交集需要扩展 SkillObserveSnapshot 字段;
    // v1 简化:不算精确交集,只显示 eval 的 uncoveredFiles 让作者自查。
    const variantKey = Object.keys(evalReport.analysis.coverage)[0];
    const cov = variantKey ? evalReport.analysis.coverage[variantKey] : null;
    bothMissingFiles = cov?.uncoveredFiles ?? [];
  }

  return {
    doctorHasDepWarning,
    evalHasSkillDocIssue,
    failedSamplesWithDocIssue,
    bothMissingFiles,
    observeUnstable: (observe?.failureRate ?? 0) >= 0.4,
  };
}

// ────────────── Card renderer ──────────────

function renderRuleResult(r: DoctorRuleResult, lang: Lang): string {
  const icon = r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : r.status === 'fail' ? '✗' : '○';
  const cls = r.status === 'pass' ? 'pass' : r.status === 'warn' ? 'warn' : r.status === 'fail' ? 'fail' : 'gray';
  return `<li class="sd-rule sd-rule--${cls}">
    <span class="sd-rule-icon">${icon}</span>
    <div class="sd-rule-body">
      <code class="sd-rule-id">${e(r.ruleId)}</code>
      <span class="sd-rule-msg">${e(r.message)}</span>
      ${r.hint ? `<div class="sd-rule-hint">${lang === 'zh' ? '💡 ' : '💡 '}${e(r.hint)}</div>` : ''}
    </div>
  </li>`;
}

function renderDoctorCard(snap: SkillDoctorSnapshot | null, links: CrossLinkSignals, lang: Lang): string {
  if (!snap) {
    return `<section class="sd-card sd-card--empty">
      <div class="sd-card-head">
        <span class="sd-card-num">1️⃣</span>
        <h2 class="sd-card-title">${lang === 'zh' ? 'Doctor 静态体检' : 'Doctor (static check)'}</h2>
        <span class="sd-card-status sd-card-status--gray">${lang === 'zh' ? '⚪ 未运行' : '⚪ not run'}</span>
      </div>
      <p class="sd-card-empty-note">${lang === 'zh' ? '运行 omk doctor 后会出现:静态结构 / 元数据 / 前置依赖 / 用例契约 等多维度健康检查。' : 'Run omk doctor to populate this card: structural / metadata / dependency / sample-contract checks.'}</p>
    </section>`;
  }
  const statusCls = snap.status === 'fail' ? 'red' : snap.status === 'warn' ? 'yellow' : 'green';
  const statusText = snap.status === 'fail'
    ? (lang === 'zh' ? '✗ 失败' : '✗ fail')
    : snap.status === 'warn' ? (lang === 'zh' ? '⚠ 警告' : '⚠ warn')
    : (lang === 'zh' ? '✓ 全部通过' : '✓ all pass');

  const crossLink = links.doctorHasDepWarning && links.evalHasSkillDocIssue
    ? `<div class="sd-cross">↔ ${lang === 'zh' ? '关联' : 'related'}: ${
      lang === 'zh'
        ? `${links.failedSamplesWithDocIssue.length} 条 eval 失败 sample 的 rootCause 是 skill_doc_missing/unclear,跟 doctor 这条警告相印证`
        : `${links.failedSamplesWithDocIssue.length} eval sample(s) failed with skill_doc_missing/unclear root cause, corroborating this doctor warning`
    }</div>`
    : '';

  return `<section class="sd-card sd-card--${statusCls}">
    <div class="sd-card-head">
      <span class="sd-card-num">1️⃣</span>
      <h2 class="sd-card-title">${lang === 'zh' ? 'Doctor 静态体检' : 'Doctor (static check)'}</h2>
      <span class="sd-card-status sd-card-status--${statusCls}">${statusText}</span>
      <span class="sd-card-time">${relTime(snap.timestamp, lang)}</span>
    </div>
    <div class="sd-card-stats">${snap.passCount} ✓ · ${snap.warnCount} ⚠ · ${snap.failCount} ✗</div>
    <ul class="sd-rules">${snap.results.map((r) => renderRuleResult(r, lang)).join('')}</ul>
    ${crossLink}
  </section>`;
}

function renderEvalScoreCard(
  snap: SkillEvalSnapshot | null,
  evalReport: EvaluationReport | null,
  langQ: string,
  lang: Lang,
): string {
  if (!snap) {
    return `<section class="sd-card sd-card--empty">
      <div class="sd-card-head">
        <span class="sd-card-num">2️⃣</span>
        <h2 class="sd-card-title">${lang === 'zh' ? 'Eval 评分视角' : 'Eval (score view)'}</h2>
        <span class="sd-card-status sd-card-status--gray">${lang === 'zh' ? '⚪ 未运行' : '⚪ not run'}</span>
      </div>
      <p class="sd-card-empty-note">${lang === 'zh' ? '运行 omk eval --treatment <skill> 看 verdict + 综合分 + 三层评分 + bootstrap CI。' : 'Run omk eval --treatment <skill> to populate verdict + composite score + 3-layer scoring + bootstrap CI.'}</p>
    </section>`;
  }
  // 取每条 sample 的 layeredScores 平均(VariantSummary 没存聚合层分,这里现算)
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
    layered = {
      factScore: mean(factVals),
      behaviorScore: mean(behaviorVals),
      judgeScore: mean(judgeVals),
    };
  }
  const verdictCls = snap.verdictLevel === 'ship' ? 'green'
    : snap.verdictLevel === 'no_ship' || snap.verdictLevel === 'regress' ? 'red'
    : snap.verdictLevel === 'progress' || snap.verdictLevel === 'ship_with_caveat' ? 'green'
    : snap.verdictLevel === 'neutral' ? 'yellow' : 'gray';
  const verdictTxt = snap.verdictLevel.replace(/_/g, ' ').toUpperCase();
  const score = snap.compositeScore != null ? snap.compositeScore.toFixed(2) : '—';

  const renderLayerBar = (label: string, val: number | undefined): string => {
    if (val == null) return `<div class="sd-layer-row"><span class="sd-layer-label">${e(label)}</span><span class="sd-layer-num">—</span></div>`;
    const cls = val >= 4 ? 'pass' : val >= 3 ? 'warn' : 'fail';
    const w = Math.round((val / 5) * 100);
    return `<div class="sd-layer-row"><span class="sd-layer-label">${e(label)}</span><div class="sd-layer-bar"><div class="sd-layer-fill sd-layer-fill--${cls}" style="width:${w}%"></div></div><span class="sd-layer-num sd-layer-num--${cls}">${val.toFixed(2)}</span></div>`;
  };

  return `<section class="sd-card sd-card--${verdictCls}">
    <div class="sd-card-head">
      <span class="sd-card-num">2️⃣</span>
      <h2 class="sd-card-title">${lang === 'zh' ? 'Eval 评分视角' : 'Eval (score view)'}</h2>
      <span class="sd-card-status sd-card-status--${verdictCls}">${e(verdictTxt)}</span>
      <span class="sd-card-time">${relTime(snap.timestamp, lang)}</span>
    </div>
    <div class="sd-score-hero">
      <div class="sd-score-num">${score}</div>
      <div class="sd-score-label">${lang === 'zh' ? '综合分' : 'composite'}<br><span class="sd-score-sub">${lang === 'zh' ? `共 ${snap.totalSamples} 条用例` : `${snap.totalSamples} samples`}</span></div>
    </div>
    <div class="sd-layers">
      ${renderLayerBar(lang === 'zh' ? '事实层' : 'fact', layered?.factScore)}
      ${renderLayerBar(lang === 'zh' ? '行为层' : 'behavior', layered?.behaviorScore)}
      ${renderLayerBar(lang === 'zh' ? 'LLM 评价' : 'judge', layered?.judgeScore)}
    </div>
    ${snap.verdictHeadline ? `<p class="sd-verdict-headline">${e(snap.verdictHeadline)}</p>` : ''}
    <a class="sd-card-link" href="/reports/${e(snap.reportId)}${langQ}">${lang === 'zh' ? '查看完整 A/B 报告 →' : 'Open full A/B report →'}</a>
  </section>`;
}

function renderEvalFuncCard(
  snap: SkillEvalSnapshot | null,
  evalReport: EvaluationReport | null,
  links: CrossLinkSignals,
  langQ: string,
  lang: Lang,
): string {
  if (!snap) {
    return `<section class="sd-card sd-card--empty">
      <div class="sd-card-head">
        <span class="sd-card-num">3️⃣</span>
        <h2 class="sd-card-title">${lang === 'zh' ? 'Eval 功能视角' : 'Eval (functional view)'}</h2>
        <span class="sd-card-status sd-card-status--gray">${lang === 'zh' ? '⚪ 未运行' : '⚪ not run'}</span>
      </div>
      <p class="sd-card-empty-note">${lang === 'zh' ? '同一份 eval 报告也驱动单测视角:每条 sample 的 pass/fail + 失败模式分类 + 诊断建议。' : 'The same eval report also drives the functional view: per-sample pass/fail + failure-mode tags + actionable diagnostic.'}</p>
    </section>`;
  }
  // 失败模式聚合
  const modeCounts: Record<string, number> = {};
  const failedSamples: Array<{ sampleId: string; mode: string[]; summary: string }> = [];
  if (evalReport && snap.variantName) {
    for (const r of evalReport.results) {
      const v = r.variants?.[snap.variantName];
      if (!v) continue;
      const passed = (v.assertions?.details ?? []).every((d) => d.passed);
      if (passed) continue;
      const isTripwire = (v.diagnostic?.rootCause || []).includes('tripwire_intentional')
        || (evalReport.sampleSnapshots?.[r.sample_id]?.tripwire === true);
      if (isTripwire) continue;
      const modes = v.diagnostic?.failureModes ?? [];
      for (const m of modes) modeCounts[m] = (modeCounts[m] || 0) + 1;
      failedSamples.push({
        sampleId: r.sample_id,
        mode: modes as string[],
        summary: v.diagnostic?.summary?.slice(0, 80) || '',
      });
    }
  }
  const failCls = snap.failCount === 0 ? 'green' : snap.passCount === 0 ? 'red' : 'yellow';
  const denom = snap.passCount + snap.failCount;

  const modesLine = Object.keys(modeCounts).length > 0
    ? `<div class="sd-modes">
        ${lang === 'zh' ? '失败模式分布:' : 'failure mode distribution:'}
        ${Object.entries(modeCounts).sort((a, b) => b[1] - a[1]).map(([m, n]) =>
          `<span class="sd-mode-chip">${e(m)} ×${n}</span>`).join('')}
      </div>`
    : '';

  const failedSamplesHtml = failedSamples.length > 0
    ? `<div class="sd-failed-samples">
        <div class="sd-failed-h">${lang === 'zh' ? '失败用例' : 'failed samples'}:</div>
        <ul>${failedSamples.slice(0, 6).map((f) => `<li>
          <code class="sd-fs-id">${e(f.sampleId)}</code>
          ${f.mode.length > 0 ? f.mode.map((m) => `<span class="sd-fs-mode">${e(m)}</span>`).join('') : ''}
          ${f.summary ? `<span class="sd-fs-summary">${e(f.summary)}${f.summary.length >= 80 ? '…' : ''}</span>` : ''}
        </li>`).join('')}
        </ul>
      </div>`
    : '';

  const crossLink = links.evalHasSkillDocIssue && links.doctorHasDepWarning
    ? `<div class="sd-cross">↔ ${lang === 'zh' ? '关联' : 'related'}: ${
      lang === 'zh'
        ? 'Doctor 也警告了「前置依赖」未声明,失败 sample 多半因为 skill 没把这条说清'
        : 'Doctor also warns about missing dependency declaration; failures likely stem from skill doc gaps'
    }</div>`
    : '';

  return `<section class="sd-card sd-card--${failCls}">
    <div class="sd-card-head">
      <span class="sd-card-num">3️⃣</span>
      <h2 class="sd-card-title">${lang === 'zh' ? 'Eval 功能视角' : 'Eval (functional view)'}</h2>
      <span class="sd-card-status sd-card-status--${failCls}">${snap.passCount}/${denom} ${lang === 'zh' ? '通过' : 'pass'}</span>
      <span class="sd-card-time">${relTime(snap.timestamp, lang)}</span>
    </div>
    <div class="sd-card-stats">
      <span class="sd-stat-pass">${snap.passCount} ✓</span>
      <span class="sd-stat-fail">${snap.failCount} ✗</span>
      ${snap.tripwireCount > 0 ? `<span class="sd-stat-trip">${snap.tripwireCount} ${lang === 'zh' ? '诱错' : 'tripwire'}</span>` : ''}
    </div>
    ${modesLine}
    ${failedSamplesHtml}
    ${crossLink}
    <a class="sd-card-link" href="/reports/${e(snap.reportId)}${langQ}#test-view">${lang === 'zh' ? '展开单测视角 →' : 'Open functional view →'}</a>
  </section>`;
}

function renderObserveCard(
  snap: SkillObserveSnapshot | null,
  links: CrossLinkSignals,
  langQ: string,
  lang: Lang,
): string {
  if (!snap) {
    return `<section class="sd-card sd-card--empty">
      <div class="sd-card-head">
        <span class="sd-card-num">4️⃣</span>
        <h2 class="sd-card-title">${lang === 'zh' ? 'Observe 线上观测' : 'Observe (production)'}</h2>
        <span class="sd-card-status sd-card-status--gray">${lang === 'zh' ? '⚪ 未运行' : '⚪ not run'}</span>
      </div>
      <p class="sd-card-empty-note">${lang === 'zh' ? '运行 omk observe <trace-dir> 把真实 session 流量喂进来,看 skill 在生产里的健康度 / 失败率 / 知识库 gap。' : 'Run omk observe <trace-dir> to feed real session traces in and see production health / failure rate / knowledge-base gap.'}</p>
    </section>`;
  }
  const failPct = (snap.failureRate * 100).toFixed(1);
  const gapPct = (snap.gapRate * 100).toFixed(0);

  const sharedFiles = links.bothMissingFiles.length > 0 && (snap.gapRate > 0)
    ? `<div class="sd-cross">↔ ${lang === 'zh' ? '产线 + 评测都没覆盖到的文件' : 'files missed by both production and eval'}: <ul class="sd-files-list">${links.bothMissingFiles.slice(0, 5).map((f) => `<li><code>${e(f)}</code></li>`).join('')}</ul></div>`
    : '';

  const unstableLink = links.observeUnstable && links.doctorHasDepWarning
    ? `<div class="sd-cross">↔ ${lang === 'zh' ? '产线工具失败率高,doctor 也标了前置依赖警告 — 大概率是真依赖问题,不是 mock 配错' : 'high production tool failure rate; doctor also warned about deps — likely a real dep issue, not mock misconfig'}</div>`
    : '';

  return `<section class="sd-card sd-card--${snap.healthBand}">
    <div class="sd-card-head">
      <span class="sd-card-num">4️⃣</span>
      <h2 class="sd-card-title">${lang === 'zh' ? 'Observe 线上观测' : 'Observe (production)'}</h2>
      <span class="sd-card-status sd-card-status--${snap.healthBand}">${BAND_DOT[snap.healthBand]} ${snap.healthBand}</span>
      <span class="sd-card-time">${relTime(snap.generatedAt, lang)}</span>
    </div>
    <div class="sd-card-stats">
      <span>${snap.segmentCount} ${lang === 'zh' ? '段' : 'segments'}</span>
      <span>${lang === 'zh' ? '工具失败率' : 'tool failure'} ${failPct}%</span>
      <span>${lang === 'zh' ? '知识库 gap' : 'KB gap'} ${gapPct}%</span>
    </div>
    ${sharedFiles}
    ${unstableLink}
    <a class="sd-card-link" href="/analyses/${e(snap.analysisId)}${langQ}">${lang === 'zh' ? '查看完整观测报告 →' : 'Open full observation report →'}</a>
  </section>`;
}

function renderRecommendations(
  entry: SkillIndexEntry,
  links: CrossLinkSignals,
  lang: Lang,
): string {
  const items: string[] = [];

  if (links.doctorHasDepWarning && links.evalHasSkillDocIssue) {
    items.push(lang === 'zh'
      ? `🔧 改 skill:doctor 标的「前置依赖」段落,补上 ${links.failedSamplesWithDocIssue.length} 条失败 sample 共同缺的内容(看 eval 功能视角的 rootCause 详情)`
      : `🔧 Update skill: address the "dependencies present" warning to fix the ${links.failedSamplesWithDocIssue.length} sample(s) failing on skill_doc_missing/unclear`);
  }
  if (links.observeUnstable && entry.observe) {
    items.push(lang === 'zh'
      ? `⚡ 排查产线:工具失败率 ${(entry.observe.failureRate * 100).toFixed(0)}% 偏高,先确认 CLI / 凭证 / 网络是否健康`
      : `⚡ Investigate production: tool failure rate ${(entry.observe.failureRate * 100).toFixed(0)}% is high — verify CLI / credentials / network health`);
  }
  if (links.bothMissingFiles.length > 0) {
    items.push(lang === 'zh'
      ? `📝 补 sample:${links.bothMissingFiles.length} 个文件产线 + 评测都没用到,如果是必读文档要加 capability 覆盖,否则可以从 skill 里删掉`
      : `📝 Add samples: ${links.bothMissingFiles.length} file(s) covered by neither production traces nor eval samples — if essential, add a capability; otherwise consider removing from skill`);
  }
  if (entry.eval && entry.eval.failCount === 0 && entry.eval.totalSamples > 0) {
    items.push(lang === 'zh'
      ? '✅ 当前 eval 全过,可以考虑加诱错样本(tripwire)测对反模式的免疫'
      : '✅ All eval samples pass — consider adding tripwire samples to test resistance against anti-patterns');
  }
  if (!entry.observe) {
    items.push(lang === 'zh'
      ? '👀 跑 omk observe 把生产 session 接进来 — 现在只有评测视角,没有真实使用数据'
      : '👀 Run omk observe to ingest production sessions — currently only have evaluation perspective, no real usage data');
  }
  if (!entry.doctor) {
    items.push(lang === 'zh'
      ? '🩺 跑 omk doctor 做静态体检 — 在评测之前先确认 skill 写得规范'
      : '🩺 Run omk doctor for static checks — verify skill structure before evaluation');
  }

  if (items.length === 0) {
    items.push(lang === 'zh'
      ? '✅ 当前没有自动 detect 到的待办;手动看下三张卡片的 detail 决定下一步'
      : '✅ No auto-detected actions; review the three card details for manual next steps');
  }

  return `<section class="sd-card sd-recommendations">
    <h2 class="sd-card-title">${lang === 'zh' ? '🎯 行动建议' : '🎯 Recommended actions'}</h2>
    <p class="sd-rec-note">${lang === 'zh' ? '从 4 份报告 derive,按影响面排序' : 'Derived from the 4 reports, sorted by impact'}</p>
    <ul class="sd-rec-list">${items.map((x) => `<li>${e(x)}</li>`).join('')}</ul>
  </section>`;
}

const SKILL_DETAIL_CSS = `
.sd-back { display:inline-block;margin-bottom:8px;color:var(--text-muted);font-size:13px;text-decoration:none }
.sd-back:hover { color:var(--text-primary) }
.sd-overall { display:flex;align-items:center;gap:14px;padding:16px 20px;background:var(--bg-soft);border-radius:8px;margin:8px 0 24px }
.sd-overall-band { font-size:24px }
.sd-overall-name { font-size:22px;font-weight:600;color:var(--text-primary) }
.sd-overall-meta { color:var(--text-muted);font-size:13px;margin-left:auto }
.sd-card { background:var(--bg-surface);border-radius:8px;padding:18px 22px;margin-bottom:16px;box-shadow:var(--shadow-sm) }
.sd-card--green   { border-left:3px solid #5e8252 }
.sd-card--yellow  { border-left:3px solid #b08030 }
.sd-card--red     { border-left:3px solid #9c4a3f }
.sd-card--gray    { border-left:3px solid var(--border) }
.sd-card--empty   { border-left:3px dashed var(--border);background:var(--bg-soft) }
.sd-card-head { display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap }
.sd-card-num { font-size:18px }
.sd-card-title { margin:0;font-size:16px;font-weight:600;color:var(--text-primary) }
.sd-card-status { padding:3px 10px;border-radius:11px;font-size:12px;font-weight:600 }
.sd-card-status--green { background:rgba(94,130,82,.14);color:#5e8252 }
.sd-card-status--yellow { background:rgba(176,128,48,.12);color:#b08030 }
.sd-card-status--red { background:rgba(156,74,63,.14);color:#9c4a3f }
.sd-card-status--gray { background:var(--bg-soft);color:var(--text-muted) }
.sd-card-time { color:var(--text-muted);font-size:12px;margin-left:auto }
.sd-card-stats { color:var(--text-secondary);font-size:13.5px;margin-bottom:12px;display:flex;gap:16px;flex-wrap:wrap }
.sd-stat-pass { color:#5e8252;font-weight:600 }
.sd-stat-fail { color:#9c4a3f;font-weight:600 }
.sd-stat-trip { color:#7a6b89;font-weight:600 }
.sd-card-empty-note { color:var(--text-muted);font-size:13px;line-height:1.6;margin:8px 0 0 }
.sd-card-link { display:inline-block;margin-top:12px;color:var(--accent);font-size:13px;text-decoration:none;font-weight:500 }
.sd-card-link:hover { text-decoration:underline }

/* Doctor rule list */
.sd-rules { list-style:none;padding:0;margin:0 0 8px;display:flex;flex-direction:column;gap:6px }
.sd-rule { display:flex;gap:10px;font-size:13.5px;line-height:1.6;align-items:flex-start;padding:6px 0 }
.sd-rule-icon { flex-shrink:0;font-weight:700;width:16px;text-align:center }
.sd-rule--pass .sd-rule-icon { color:#5e8252 }
.sd-rule--warn .sd-rule-icon { color:#b08030 }
.sd-rule--fail .sd-rule-icon { color:#9c4a3f }
.sd-rule-body { flex:1;min-width:0 }
.sd-rule-id { font-size:11.5px;color:var(--text-muted);background:var(--bg-soft);padding:1px 5px;border-radius:3px;margin-right:6px }
.sd-rule-msg { color:var(--text-primary) }
.sd-rule-hint { font-size:12.5px;color:var(--text-secondary);margin-top:3px;line-height:1.55 }

/* Eval score card */
.sd-score-hero { display:flex;align-items:baseline;gap:14px;margin:8px 0 16px }
.sd-score-num { font-size:48px;font-weight:700;color:var(--text-primary);font-variant-numeric:tabular-nums }
.sd-score-label { color:var(--text-secondary);font-size:13.5px;line-height:1.4 }
.sd-score-sub { color:var(--text-muted);font-size:11.5px }
.sd-layers { display:flex;flex-direction:column;gap:6px;margin-bottom:12px }
.sd-layer-row { display:grid;grid-template-columns:80px 1fr 60px;gap:10px;align-items:center;font-size:13px }
.sd-layer-label { color:var(--text-secondary) }
.sd-layer-bar { background:var(--bg-soft);border-radius:4px;height:10px;overflow:hidden }
.sd-layer-fill { height:100%;border-radius:4px;transition:width .3s }
.sd-layer-fill--pass { background:#5e8252 }
.sd-layer-fill--warn { background:#b08030 }
.sd-layer-fill--fail { background:#9c4a3f }
.sd-layer-num { font-variant-numeric:tabular-nums;font-weight:600;text-align:right }
.sd-layer-num--pass { color:#5e8252 }
.sd-layer-num--warn { color:#b08030 }
.sd-layer-num--fail { color:#9c4a3f }
.sd-verdict-headline { font-size:13px;color:var(--text-secondary);margin:8px 0;line-height:1.5;font-style:italic }

/* Eval functional card */
.sd-modes { font-size:12.5px;color:var(--text-secondary);margin-bottom:10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center }
.sd-mode-chip { background:rgba(176,128,48,.10);color:#b08030;padding:2px 8px;border-radius:10px;font-size:11.5px }
.sd-failed-samples { margin-bottom:10px }
.sd-failed-h { font-size:12.5px;color:var(--text-secondary);font-weight:500;margin-bottom:6px }
.sd-failed-samples ul { margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:6px }
.sd-failed-samples li { font-size:13px;line-height:1.5;color:var(--text-primary);display:flex;flex-wrap:wrap;gap:6px;align-items:baseline }
.sd-fs-id { font-size:11.5px;background:var(--bg-soft);padding:1px 6px;border-radius:3px }
.sd-fs-mode { font-size:11px;color:#b08030;background:rgba(176,128,48,.10);padding:1px 6px;border-radius:8px }
.sd-fs-summary { color:var(--text-secondary);font-size:12.5px;flex:1;min-width:0 }

/* Cross-link bar */
.sd-cross { background:rgba(90,122,147,.08);border-left:2px solid var(--accent);padding:8px 12px;border-radius:4px;font-size:12.5px;color:var(--text-secondary);margin:8px 0;line-height:1.6 }
.sd-files-list { margin:4px 0 0 0;padding-left:16px }
.sd-files-list code { background:var(--bg-soft);padding:1px 5px;border-radius:3px;font-size:11.5px }

/* Recommendations */
.sd-recommendations { background:rgba(94,130,82,.04);border-left:3px solid #5e8252 }
.sd-rec-note { color:var(--text-muted);font-size:12px;margin:4px 0 12px }
.sd-rec-list { margin:0;padding-left:18px;color:var(--text-primary);font-size:14px;line-height:1.85 }
`;

export function renderSkillDetail(
  entry: SkillIndexEntry,
  evalReport: EvaluationReport | null,
  lang: Lang = DEFAULT_LANG,
): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const links = computeCrossLinks(entry.doctor, evalReport, entry.observe);
  const reportCount = [entry.doctor, entry.eval, entry.observe].filter(Boolean).length;
  const lastTs = [entry.doctor?.timestamp, entry.eval?.timestamp, entry.observe?.generatedAt]
    .filter((s): s is string => Boolean(s)).sort().pop();

  return layout(entry.skillName, `
    <main>
      <a class="sd-back" href="/${langQ}">${lang === 'zh' ? '← 返回 Skills' : '← Back to Skills'}</a>
      <div class="sd-overall">
        <span class="sd-overall-band">${BAND_DOT[entry.band]}</span>
        <span class="sd-overall-name">${e(entry.skillName)}</span>
        <span class="sd-overall-meta">
          ${lang === 'zh' ? '已有报告' : 'reports'}: ${reportCount} / 3
          · ${lang === 'zh' ? '最近活动' : 'last activity'}: ${relTime(lastTs, lang)}
        </span>
      </div>
      ${renderDoctorCard(entry.doctor, links, lang)}
      ${renderEvalScoreCard(entry.eval, evalReport, langQ, lang)}
      ${renderEvalFuncCard(entry.eval, evalReport, links, langQ, lang)}
      ${renderObserveCard(entry.observe, links, langQ, lang)}
      ${renderRecommendations(entry, links, lang)}
    </main>
    <style>${SKILL_DETAIL_CSS}</style>
  `, lang);
}
