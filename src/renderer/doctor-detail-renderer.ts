/**
 * Doctor 报告详情页 — 逐条规则的健康检查结果。
 *
 * 主次：Hero 综合健康分 → 统计条（通过/警告/失败）→ 规则列表（失败/警告高亮在前，
 * 通过项折叠）。每条规则展开显示 finding 描述 + 修复建议。
 */
import { reportShell, healthColor, type SkillReportContext } from './report-shell.js';
import { icon as svgIcon } from './icons.js';
import { e, DEFAULT_LANG } from './layout.js';
import type { Lang } from '../shared/language.js';
import type { DoctorReport, DoctorSkillReport, DoctorRuleResult } from '../doctor/contracts.js';

interface Finding { level?: string; description?: string; suggestion?: string; support?: { k?: number; n?: number } }
interface SummarySamples { requested?: number; succeeded?: number; concurrency?: number; degraded?: boolean }
interface SummaryDetail { samples?: SummarySamples }
function getDetail(r: DoctorRuleResult): { displayName?: string; level?: string; findings?: Finding[] } {
  return (r.detail ?? {}) as { displayName?: string; level?: string; findings?: Finding[] };
}

const SORT_ORDER: Record<string, number> = { fail: 0, warn: 1, pass: 2, skipped: 3 };

function fmtTs(ts: string): string {
  try {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return ts; }
}

function renderRuleCard(r: DoctorRuleResult, lang: Lang, forceOpen = false): string {
  const det = getDetail(r);
  const name = det.displayName ?? r.ruleId;
  const findings = det.findings ?? [];
  const errors = findings.filter((f) => f.level === '错误');
  const warns = findings.filter((f) => f.level === '警告');
  const tips = findings.filter((f) => f.level === '建议');
  const cardCls = r.status === 'fail' ? 'fail' : r.status === 'warn' ? 'warn' : 'pass';
  const dotCls = r.status === 'fail' ? 'fail' : r.status === 'warn' ? 'warn' : r.status === 'skipped' ? 'skip' : 'pass';

  const badges: string[] = [];
  if (errors.length) badges.push(`<span class="rs-badge rs-badge--fail">${errors.length} ${lang === 'zh' ? '错误' : 'err'}</span>`);
  if (warns.length) badges.push(`<span class="rs-badge rs-badge--warn">${warns.length} ${lang === 'zh' ? '警告' : 'warn'}</span>`);
  if (!errors.length && !warns.length) badges.push(`<span class="rs-badge rs-badge--pass">${lang === 'zh' ? '通过' : 'pass'}</span>`);

  const head = `<span class="rs-card-dot rs-card-dot--${dotCls}"></span><span class="rs-card-name">${e(name)}</span><span class="rs-card-badges">${badges.join('')}</span>`;

  const allFindings = [...errors, ...warns, ...tips];
  if (allFindings.length === 0) {
    return `<div class="rs-card rs-card--${cardCls}"><div class="rs-card-head" style="cursor:default">${head}</div></div>`;
  }

  const findingHtml = allFindings.map((f) => {
    const isErr = f.level === '错误';
    const mIcon = isErr
      ? svgIcon('x', { size: 14, style: 'color:#dc2626;vertical-align:-2px;margin-right:5px' })
      : svgIcon('warn', { size: 14, style: `color:${f.level === '警告' ? '#d97706' : '#637083'};vertical-align:-2px;margin-right:5px` });
    // 多采样支持度 k/n:仅 n>1 时展示(单次采样无意义)。k<n 用偏灰提示"非每次都报"。
    const sup = f.support;
    const supportTitle = sup && typeof sup.n === 'number' && typeof sup.k === 'number'
      ? (lang === 'zh'
        ? `${sup.n} 次采样里有 ${sup.k} 次报了这条`
        : `Reported by ${sup.k} of ${sup.n} samples`)
      : '';
    const supBadge = sup && typeof sup.n === 'number' && sup.n > 1 && typeof sup.k === 'number'
      ? `<span class="rs-badge rs-badge--${sup.k >= sup.n ? 'pass' : 'warn'}" title="${e(supportTitle)}" style="margin-left:6px">${sup.k}/${sup.n}</span>`
      : '';
    return `<div class="rs-finding rs-finding--${isErr ? 'err' : 'warn'}">
      <div class="rs-finding-desc">${mIcon}${e(f.description ?? '')}${supBadge}</div>
      ${f.suggestion ? `<div class="rs-finding-sug">${svgIcon('bulb', { size: 13, style: 'vertical-align:-2px;margin-right:5px' })}${e(f.suggestion)}</div>` : ''}
    </div>`;
  }).join('');

  return `<details class="rs-card rs-card--${cardCls}" ${errors.length || forceOpen ? 'open' : ''}>
    <summary class="rs-card-head">${head}</summary>
    <div class="rs-card-body">${findingHtml}</div>
  </details>`;
}

function renderSampleDegradedAlert(summary: DoctorRuleResult | undefined, lang: Lang): string {
  const samples = (summary?.detail as SummaryDetail | undefined)?.samples;
  if (!samples || samples.degraded !== true) return '';
  const requested = typeof samples.requested === 'number' ? samples.requested : 0;
  const succeeded = typeof samples.succeeded === 'number' ? samples.succeeded : 0;
  if (requested <= 1 || succeeded >= requested) return '';
  const title = lang === 'zh' ? '共识置信降级' : 'Consensus confidence degraded';
  const body = lang === 'zh'
    ? `本次只成功解析 ${succeeded}/${requested} 次采样，finding 支持度仅基于成功样本。建议重跑，或在限流场景下降低并发。`
    : `Only ${succeeded}/${requested} samples parsed successfully. Finding support is based on successful samples only. Re-run or lower concurrency if rate-limited.`;
  return `<div class="rs-alert rs-alert--warn">
    <div class="rs-alert-title">${e(title)}</div>
    <div class="rs-alert-body">${e(body)}</div>
  </div>`;
}

function renderSkillBlock(sk: DoctorSkillReport, lang: Lang): string {
  const summary = sk.results.find((r) => r.ruleId.endsWith(':_summary'));
  const rules = sk.results.filter((r) => !r.ruleId.endsWith(':_summary'));
  const pass = rules.filter((r) => r.status === 'pass').length;
  const warn = rules.filter((r) => r.status === 'warn').length;
  const fail = rules.filter((r) => r.status === 'fail').length;
  const total = rules.length;
  const sorted = [...rules].sort((a, b) => (SORT_ORDER[a.status] ?? 9) - (SORT_ORDER[b.status] ?? 9));
  const issues = sorted.filter((r) => r.status === 'fail' || r.status === 'warn');
  const oks = sorted.filter((r) => r.status === 'pass' || r.status === 'skipped');
  const zh = lang === 'zh';

  const stats = `<div class="rs-stats">
    <div class="rs-stat rs-stat--pass"><span class="rs-stat-num">${pass}</span><span class="rs-stat-label">${zh ? '通过' : 'Pass'}</span></div>
    <div class="rs-stat rs-stat--warn"><span class="rs-stat-num">${warn}</span><span class="rs-stat-label">${zh ? '警告' : 'Warn'}</span></div>
    <div class="rs-stat rs-stat--fail"><span class="rs-stat-num">${fail}</span><span class="rs-stat-label">${zh ? '失败' : 'Fail'}</span></div>
    <div class="rs-stat rs-stat--total"><span class="rs-stat-num">${total}</span><span class="rs-stat-label">${zh ? '规则总数' : 'Rules'}</span></div>
  </div>`;

  const issuesHtml = issues.length
    ? `<div class="rs-panel"><div class="rs-panel-title">${zh ? '待处理项' : 'Issues'} <small>${issues.length}</small></div>${issues.map((r, i) => renderRuleCard(r, lang, i === 0)).join('')}</div>`
    : `<div class="rs-panel"><div class="rs-empty">${zh ? '✓ 所有规则通过，无待处理项' : '✓ All rules passed'}</div></div>`;

  const oksHtml = oks.length
    ? `<div class="rs-panel"><details class="rs-fold"><summary>${zh ? `展开 ${oks.length} 条通过的规则` : `Show ${oks.length} passed rules`}</summary>${oks.map((r) => renderRuleCard(r, lang)).join('')}</details></div>`
    : '';

  return renderSampleDegradedAlert(summary, lang) + stats + issuesHtml + oksHtml;
}

export function renderDoctorDetail(report: DoctorReport, skillName: string, langQ: string, lang: Lang = DEFAULT_LANG, skillContext?: SkillReportContext): string {
  const zh = lang === 'zh';
  // 优先展示点进来的 skill；找不到就展示全部
  const targetSkill = report.skills.find((s) => s.skillName === skillName) ?? report.skills[0];
  const rules = (targetSkill?.results ?? []).filter((r) => !r.ruleId.endsWith(':_summary'));
  const pass = rules.filter((r) => r.status === 'pass').length;
  const warn = rules.filter((r) => r.status === 'warn').length;
  const total = rules.length;
  const score = total > 0 ? Math.round(((pass + warn * 0.5) / total) * 100) : null;
  // 与 eval「综合分 / 5」统一成「X分 / 满分」形式;圆心显原生分数,等级由颜色传达。
  const scoreLabel = zh ? '健康分 / 100' : 'Health / 100';

  const body = targetSkill
    ? renderSkillBlock(targetSkill, lang)
    : `<div class="rs-panel"><div class="rs-empty">${zh ? '报告无 skill 数据' : 'No skill data'}</div></div>`;

  return reportShell({
    dim: 'doctor',
    icon: '🩺',
    kindTitle: zh ? '健康体检报告' : 'Doctor Report',
    skillName: targetSkill?.skillName ?? skillName,
    metaItems: [`${svgIcon('clock', { size: 13 })} ${e(fmtTs(report.timestamp))}`, `${svgIcon('chip', { size: 13 })} ${e(report.model)}`, e(report.id)],
    // Hero 展示「综合健康」总分(跨维度,与首页同口径),切 tab 不变;本次体检明细(规则/计数)在 body。
    // 无 skillContext 时回退显本次体检健康分。
    score: skillContext ? skillContext.overall.score : score,
    scoreText: skillContext && skillContext.overall.score != null ? String(skillContext.overall.score) : undefined,
    ringColor: skillContext ? healthColor(skillContext.overall.score) : undefined,
    scoreLabel: skillContext ? (zh ? '综合健康' : 'Health') : scoreLabel,
    backHref: `/${langQ}`,
    backLabel: zh ? '返回列表' : 'Back to list',
    body,
    skillContext,
  }, lang);
}
