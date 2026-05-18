/**
 * doctor HTML 报告渲染器。
 *
 * 输出 single-file HTML(JSON inline,CSS/JS 内嵌,无外部依赖),双击可看,
 * 不需 http server。专为 LLM 健康度审计报告设计 — 重点展示 composer group 内的
 * 维度结果,但也兼容显示静态 rule 段。
 *
 * 排序约定:
 *   - 维度卡片按 fail → warn → pass → skipped(STATUS_RANK)排
 *   - 每个维度卡片内的 finding 按 错误 → 警告 → 建议 排
 *   - skill 级别按 outcome (failed / warnings_only / passed) 排
 *
 * 前端交互:
 *   - 顶部 filter pills:全部 / 仅失败 / 仅警告 / 仅通过 — 切换时 dim card 显隐
 *   - 维度卡片头部点击折叠/展开 findings 区
 */

import type {
  DoctorReport,
  DoctorRuleResult,
  DoctorRuleStatus,
} from '../types/index.js';
import { CLI_DICT, type CliMessageKey } from '../cli/lib/i18n-dict.js';
import { tCli, type CliLang } from '../cli/lib/i18n.js';

const STATUS_RANK: Record<DoctorRuleStatus, number> = {
  fail: 0, warn: 1, pass: 2, skipped: 3,
};
const FINDING_RANK: Record<string, number> = { '错误': 0, '警告': 1, '建议': 2 };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLabel(result: DoctorRuleResult, lang: CliLang): string {
  if (result.labelKey in CLI_DICT) return tCli(result.labelKey as CliMessageKey, lang);
  return result.ruleId;
}

interface Finding {
  level: '错误' | '警告' | '建议';
  subtype?: string;
  evidence?: string;
  description?: string;
}

function getDimDetail(r: DoctorRuleResult): { findings: Finding[]; suggestions: string[]; level?: string; missing?: boolean } {
  const d = (r.detail ?? {}) as Record<string, unknown>;
  const findings = Array.isArray(d.findings) ? (d.findings as Finding[]) : [];
  const suggestions = Array.isArray(d.suggestions)
    ? (d.suggestions as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  return {
    findings: [...findings].sort((a, b) => (FINDING_RANK[a.level] ?? 9) - (FINDING_RANK[b.level] ?? 9)),
    suggestions,
    level: typeof d.level === 'string' ? d.level : undefined,
    missing: d.missing === true,
  };
}

function getSummaryDetail(r: DoctorRuleResult | undefined): {
  overall?: string; topSuggestions: string[]; dimensionLevelCount?: Record<string, number>; findingCountByLevel?: Record<string, number>;
} {
  if (!r) return { topSuggestions: [] };
  const d = (r.detail ?? {}) as Record<string, unknown>;
  return {
    overall: typeof d.overall === 'string' ? d.overall : undefined,
    topSuggestions: Array.isArray(d.topSuggestions)
      ? (d.topSuggestions as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    dimensionLevelCount: typeof d.dimensionLevelCount === 'object' && d.dimensionLevelCount !== null
      ? d.dimensionLevelCount as Record<string, number>
      : undefined,
    findingCountByLevel: typeof d.findingCountByLevel === 'object' && d.findingCountByLevel !== null
      ? d.findingCountByLevel as Record<string, number>
      : undefined,
  };
}

function renderDimCard(r: DoctorRuleResult, lang: CliLang): string {
  const label = renderLabel(r, lang);
  const status = r.status;
  const detail = getDimDetail(r);
  const findingsHtml = detail.findings.length === 0
    ? `<div class="empty">${lang === 'zh' ? '无 finding' : 'no findings'}</div>`
    : detail.findings.map((f) => `
      <div class="finding finding-${f.level === '错误' ? 'err' : f.level === '警告' ? 'warn' : 'sug'}">
        <div class="finding-head">
          <span class="finding-level">${escapeHtml(f.level)}</span>
          ${f.subtype ? `<span class="finding-subtype">${escapeHtml(f.subtype)}</span>` : ''}
          <span class="finding-desc">${escapeHtml(f.description ?? '')}</span>
        </div>
        ${f.evidence ? `<div class="finding-evidence">${escapeHtml(f.evidence)}</div>` : ''}
      </div>`).join('');
  const sugsHtml = detail.suggestions.length === 0 ? '' : `
    <div class="dim-sugs">
      <div class="sugs-title">${lang === 'zh' ? '建议' : 'suggestions'}</div>
      <ul>${detail.suggestions.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
    </div>`;
  const dimIdHint = (r.detail as { dimensionId?: string } | undefined)?.dimensionId ?? r.ruleId.split(':')[1] ?? '';
  return `
    <div class="dim-card status-${status}" data-status="${status}" data-dimid="${escapeHtml(dimIdHint)}">
      <div class="dim-head" onclick="this.parentElement.classList.toggle('open')">
        <span class="dim-status">${escapeHtml(detail.level ?? status)}</span>
        <span class="dim-name">${escapeHtml(label)}</span>
        <span class="dim-counts">
          <span class="badge badge-err">${detail.findings.filter((f) => f.level === '错误').length}</span>
          <span class="badge badge-warn">${detail.findings.filter((f) => f.level === '警告').length}</span>
          <span class="badge badge-sug">${detail.findings.filter((f) => f.level === '建议').length}</span>
        </span>
        <span class="dim-toggle">▸</span>
      </div>
      <div class="dim-body">
        ${detail.missing ? `<div class="dim-missing">⚠ ${escapeHtml(r.message)}</div>` : ''}
        <div class="dim-findings">${findingsHtml}</div>
        ${sugsHtml}
      </div>
    </div>`;
}

function renderStaticRule(r: DoctorRuleResult, lang: CliLang): string {
  return `
    <div class="rule-row status-${r.status}">
      <span class="rule-status">${r.status.toUpperCase()}</span>
      <span class="rule-label">${escapeHtml(renderLabel(r, lang))}</span>
      <span class="rule-msg">${escapeHtml(r.message)}</span>
      ${r.hint ? `<div class="rule-hint">💡 ${escapeHtml(r.hint)}</div>` : ''}
    </div>`;
}

interface SegmentedSkill {
  staticRules: DoctorRuleResult[];
  /** key = groupId */
  groups: Map<string, DoctorRuleResult[]>;
}

function segmentSkillResults(skill: { results: DoctorRuleResult[] }): SegmentedSkill {
  const staticRules: DoctorRuleResult[] = [];
  const groups = new Map<string, DoctorRuleResult[]>();
  for (const r of skill.results) {
    if (!r.groupId) { staticRules.push(r); continue; }
    let arr = groups.get(r.groupId);
    if (!arr) { arr = []; groups.set(r.groupId, arr); }
    arr.push(r);
  }
  return { staticRules, groups };
}

function renderGroup(groupId: string, results: DoctorRuleResult[], lang: CliLang): string {
  const summaryRow = results.find((r) => r.ruleId.endsWith(':_summary'));
  const dimRows = results.filter((r) => !r.ruleId.endsWith(':_summary'));
  dimRows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  const groupLabel = summaryRow ? renderLabel(summaryRow, lang) : groupId;
  const summary = getSummaryDetail(summaryRow);
  const totalsLine = summary.dimensionLevelCount && summary.findingCountByLevel
    ? `<div class="group-totals">
        <span>${lang === 'zh' ? '维度' : 'dims'}: ✗${summary.dimensionLevelCount['不健康'] ?? 0} ⚠${summary.dimensionLevelCount['亚健康'] ?? 0} ✓${summary.dimensionLevelCount['健康'] ?? 0} ⊙${summary.dimensionLevelCount['不适用'] ?? 0}</span>
        <span>findings: ✗${summary.findingCountByLevel['错误'] ?? 0} ⚠${summary.findingCountByLevel['警告'] ?? 0} ·${summary.findingCountByLevel['建议'] ?? 0}</span>
       </div>`
    : '';
  const topSugsHtml = summary.topSuggestions.length === 0 ? '' : `
    <div class="group-top">
      <div class="top-title">★ ${lang === 'zh' ? 'Top 改进建议' : 'Top suggestions'}</div>
      <ol>${summary.topSuggestions.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
    </div>`;
  const cardsHtml = dimRows.map((r) => renderDimCard(r, lang)).join('');
  return `
    <section class="group" data-group="${escapeHtml(groupId)}">
      <header class="group-head">
        <h2>${escapeHtml(groupLabel)}${summary.overall ? ` <span class="group-overall">${escapeHtml(summary.overall)}</span>` : ''}</h2>
        ${totalsLine}
      </header>
      ${topSugsHtml}
      <div class="filter-pills">
        <button class="pill active" data-filter="all">${lang === 'zh' ? '全部' : 'All'}</button>
        <button class="pill" data-filter="fail">${lang === 'zh' ? '仅失败' : 'Fail only'}</button>
        <button class="pill" data-filter="warn">${lang === 'zh' ? '仅警告' : 'Warn only'}</button>
        <button class="pill" data-filter="pass">${lang === 'zh' ? '仅通过' : 'Pass only'}</button>
        <button class="pill" data-filter="skipped">${lang === 'zh' ? '跳过' : 'Skipped'}</button>
      </div>
      <div class="dim-grid">${cardsHtml}</div>
    </section>`;
}

function renderSkill(skill: { skillName: string; skillPath: string; status: string; results: DoctorRuleResult[] }, lang: CliLang): string {
  const seg = segmentSkillResults(skill);
  const staticHtml = seg.staticRules.map((r) => renderStaticRule(r, lang)).join('');
  const groupsHtml = [...seg.groups.entries()].map(([gid, results]) => renderGroup(gid, results, lang)).join('');
  return `
    <article class="skill skill-${skill.status}">
      <header class="skill-head">
        <h1>${escapeHtml(skill.skillName)}</h1>
        <span class="skill-status">${skill.status.toUpperCase()}</span>
        <span class="skill-path">${escapeHtml(skill.skillPath)}</span>
      </header>
      ${seg.staticRules.length > 0 ? `<div class="static-rules">${staticHtml}</div>` : ''}
      ${groupsHtml}
    </article>`;
}

function renderHeader(report: DoctorReport, lang: CliLang): string {
  const totals = report.totals;
  const isZh = lang === 'zh';
  return `
    <header class="report-head">
      <h1>${isZh ? 'omk doctor 健康检查报告' : 'omk doctor Health Check Report'}</h1>
      <div class="meta">
        <span class="outcome outcome-${report.outcome}">${report.outcome.toUpperCase()}</span>
        <span>${isZh ? 'Skill 总览' : 'Skills'}: ✗${totals.fail} ⚠${totals.warn} ✓${totals.pass}</span>
        <span>${isZh ? '生成于' : 'Generated'}: ${escapeHtml(report.timestamp)}</span>
        <span>${isZh ? '工作目录' : 'CWD'}: <code>${escapeHtml(report.cwd)}</code></span>
        <span>executor: ${escapeHtml(report.executorName)} / ${escapeHtml(report.model)}</span>
      </div>
    </header>`;
}

const CSS = `
  /* doctor 报告 — 跟 omk studio 主页面用同一套潘通哑色调浅色主题。
     之前是孤立的 CSS 块(自带荧光红绿黄),v0.30 起统一,跨页一致。 */
  :root {
    --c-fail: #9c4a3f; --c-warn: #b08030; --c-pass: #5e8252; --c-skip: #a8a8a8;
    --c-fail-bg: rgba(156,74,63,.10); --c-warn-bg: rgba(176,128,48,.10);
    --c-pass-bg: rgba(94,130,82,.10); --c-skip-bg: rgba(58,58,58,.04);
    --c-bg: #fbfaf7; --c-card: #ffffff; --c-border: #e8e3da; --c-text: #3a3a3a;
    --c-muted: #7a7a7a; --c-soft: rgba(58,58,58,.04);
    --c-shadow: 0 1px 3px rgba(58,58,58,.06);
    --c-shadow-md: 0 2px 8px rgba(58,58,58,.10);
  }
  * { box-sizing: border-box; }
  body { font: 14.5px/1.7 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
         color: var(--c-text); background: var(--c-bg); margin: 0; padding: 0; }
  code { font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-size: 13px;
         background: var(--c-soft); padding: 2px 6px; border-radius: 3px; color: var(--c-text); }
  .container { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }

  .report-head { background: var(--c-card); padding: 22px 26px; border-radius: 8px;
                 box-shadow: var(--c-shadow); margin-bottom: 24px; }
  .report-head h1 { margin: 0 0 10px; font-size: 22px; font-weight: 600; line-height: 1.3; }
  .report-head .meta { display: flex; gap: 18px; flex-wrap: wrap; color: var(--c-muted); font-size: 13px; }
  .outcome { font-weight: 600; padding: 3px 12px; border-radius: 4px; font-size: 13px; }
  .outcome-failed { color: var(--c-fail); background: var(--c-fail-bg); }
  .outcome-warnings_only { color: var(--c-warn); background: var(--c-warn-bg); }
  .outcome-passed { color: var(--c-pass); background: var(--c-pass-bg); }

  .skill { background: var(--c-card); border-radius: 8px; padding: 22px 26px;
           margin-bottom: 16px; box-shadow: var(--c-shadow); }
  .skill-head { display: flex; align-items: center; gap: 12px; margin-bottom: 18px;
                border-bottom: 1px solid var(--c-border); padding-bottom: 14px; }
  .skill-head h1 { margin: 0; font-size: 18px; font-weight: 600; }
  .skill-status { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 4px; letter-spacing: 0.02em; }
  .skill-fail .skill-status { background: var(--c-fail-bg); color: var(--c-fail); }
  .skill-warn .skill-status { background: var(--c-warn-bg); color: var(--c-warn); }
  .skill-pass .skill-status { background: var(--c-pass-bg); color: var(--c-pass); }
  .skill-path { font-family: "SF Mono", Menlo, monospace; color: var(--c-muted); font-size: 12px; }

  .static-rules { margin-bottom: 16px; }
  .rule-row { padding: 10px 14px; border-left: 3px solid; margin-bottom: 6px;
              background: var(--c-soft); border-radius: 0 4px 4px 0; font-size: 14px; line-height: 1.6; }
  .rule-row.status-fail { border-color: var(--c-fail); }
  .rule-row.status-warn { border-color: var(--c-warn); }
  .rule-row.status-pass { border-color: var(--c-pass); }
  .rule-row.status-skipped { border-color: var(--c-skip); }
  .rule-status { font-weight: 600; font-size: 12px; margin-right: 8px; letter-spacing: 0.02em; }
  .rule-row.status-fail .rule-status { color: var(--c-fail); }
  .rule-row.status-warn .rule-status { color: var(--c-warn); }
  .rule-row.status-pass .rule-status { color: var(--c-pass); }
  .rule-row.status-skipped .rule-status { color: var(--c-skip); }
  .rule-label { font-weight: 600; margin-right: 8px; }
  .rule-msg { color: var(--c-muted); }
  .rule-hint { margin-top: 6px; font-size: 13px; color: var(--c-muted); line-height: 1.6; }

  .group { margin-top: 24px; padding: 18px; background: var(--c-soft); border-radius: 6px; }
  .group-head h2 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
  .group-overall { font-size: 12px; padding: 3px 10px; border-radius: 4px;
                   background: var(--c-fail-bg); color: var(--c-fail); margin-left: 8px; font-weight: 600; }
  .group-totals { display: flex; gap: 18px; color: var(--c-muted); font-size: 13px; margin-bottom: 14px; }
  .group-top { background: var(--c-warn-bg); border-left: 4px solid var(--c-warn); padding: 14px 18px;
               border-radius: 0 4px 4px 0; margin-bottom: 14px; font-size: 14px; line-height: 1.7; }
  .group-top .top-title { font-weight: 600; margin-bottom: 6px; color: var(--c-warn); }
  .group-top ol { margin: 0; padding-left: 22px; }

  .filter-pills { display: flex; gap: 6px; margin: 14px 0; }
  .pill { border: 1px solid var(--c-border); background: var(--c-card); padding: 6px 14px;
          border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--c-muted);
          font-family: inherit; outline: none; appearance: none; -webkit-appearance: none;
          transition: border-color .15s, color .15s, background .15s; }
  .pill:hover { color: var(--c-text); border-color: var(--c-muted); }
  .pill.active { background: var(--c-text); color: var(--c-card); border-color: var(--c-text); }

  .dim-grid { display: grid; gap: 10px; }
  .dim-card { background: var(--c-card); border: 1px solid var(--c-border); border-left-width: 4px;
              border-radius: 6px; transition: box-shadow .15s; }
  .dim-card:hover { box-shadow: var(--c-shadow-md); }
  .dim-card.status-fail { border-left-color: var(--c-fail); }
  .dim-card.status-warn { border-left-color: var(--c-warn); }
  .dim-card.status-pass { border-left-color: var(--c-pass); }
  .dim-card.status-skipped { border-left-color: var(--c-skip); }
  .dim-head { display: flex; align-items: center; gap: 12px; padding: 14px 18px;
              cursor: pointer; user-select: none; }
  .dim-status { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 4px;
                background: var(--c-soft); letter-spacing: 0.02em; }
  .status-fail .dim-status { background: var(--c-fail-bg); color: var(--c-fail); }
  .status-warn .dim-status { background: var(--c-warn-bg); color: var(--c-warn); }
  .status-pass .dim-status { background: var(--c-pass-bg); color: var(--c-pass); }
  .status-skipped .dim-status { background: var(--c-skip-bg); color: var(--c-skip); }
  .dim-name { font-weight: 600; flex: 1; font-size: 14.5px; }
  .dim-counts { display: flex; gap: 4px; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 3px; min-width: 20px;
           text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
  .badge-err { background: var(--c-fail-bg); color: var(--c-fail); }
  .badge-warn { background: var(--c-warn-bg); color: var(--c-warn); }
  .badge-sug { background: var(--c-soft); color: var(--c-muted); }
  .dim-toggle { color: var(--c-muted); transition: transform .15s; font-size: 18px; }
  .dim-card.open .dim-toggle { transform: rotate(90deg); }

  .dim-body { display: none; padding: 0 18px 18px; border-top: 1px solid var(--c-border); }
  .dim-card.open .dim-body { display: block; }
  .dim-missing { background: var(--c-warn-bg); color: var(--c-warn); padding: 10px 14px;
                 border-radius: 4px; margin: 14px 0; font-size: 14px; line-height: 1.7; }

  .dim-findings { margin-top: 14px; }
  .finding { margin-bottom: 10px; padding: 12px 14px; border-radius: 4px; background: var(--c-soft);
             border-left: 3px solid; line-height: 1.7; }
  .finding-err { border-color: var(--c-fail); }
  .finding-warn { border-color: var(--c-warn); }
  .finding-sug { border-color: var(--c-skip); }
  .finding-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .finding-level { font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 3px; letter-spacing: 0.02em; }
  .finding-err .finding-level { background: var(--c-fail-bg); color: var(--c-fail); }
  .finding-warn .finding-level { background: var(--c-warn-bg); color: var(--c-warn); }
  .finding-sug .finding-level { background: var(--c-soft); color: var(--c-muted); }
  .finding-subtype { font-size: 12px; padding: 2px 10px; background: var(--c-card); border: 1px solid var(--c-border);
                     border-radius: 3px; color: var(--c-muted); font-family: "SF Mono", Menlo, monospace; }
  .finding-desc { flex: 1; font-size: 14px; }
  .finding-evidence { margin-top: 6px; font-family: "SF Mono", Menlo, monospace; font-size: 12.5px;
                      color: var(--c-muted); padding: 6px 10px; background: var(--c-card); border-radius: 3px;
                      border-left: 2px solid var(--c-border); line-height: 1.6; }

  .dim-sugs { margin-top: 14px; padding: 12px 16px; background: rgba(90,122,147,.06); border-radius: 4px;
              border-left: 3px solid #5a7a93; }
  .dim-sugs .sugs-title { font-weight: 600; font-size: 13px; color: #5a7a93; margin-bottom: 6px; letter-spacing: 0.02em; }
  .dim-sugs ul { margin: 0; padding-left: 22px; }
  .dim-sugs li { font-size: 14px; line-height: 1.7; margin: 4px 0; }

  .empty { color: var(--c-muted); font-style: italic; padding: 10px 0; font-size: 14px; }
`;

const JS = `
(function() {
  // Filter pills: hide dim cards not matching filter (within same group)
  document.querySelectorAll('.group').forEach(function(group) {
    var pills = group.querySelectorAll('.pill');
    pills.forEach(function(pill) {
      pill.addEventListener('click', function() {
        pills.forEach(function(p) { p.classList.remove('active'); });
        pill.classList.add('active');
        var filter = pill.getAttribute('data-filter');
        group.querySelectorAll('.dim-card').forEach(function(card) {
          var status = card.getAttribute('data-status');
          card.style.display = (filter === 'all' || filter === status) ? '' : 'none';
        });
      });
    });
  });

  // Auto-open dim cards with status fail/warn (collapsed by default for pass/skipped)
  document.querySelectorAll('.dim-card.status-fail').forEach(function(c) { c.classList.add('open'); });
})();
`;

export function renderDoctorReportHtml(report: DoctorReport, lang: CliLang = 'zh'): string {
  // 按 outcome 排序 skill: failed > warnings > passed
  const skillsSorted = [...report.skills].sort((a, b) => {
    const rank: Record<string, number> = { fail: 0, warn: 1, pass: 2 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
  });
  const skillsHtml = skillsSorted.map((s) => renderSkill(s, lang)).join('');
  const dataInline = JSON.stringify(report);
  const title = lang === 'zh' ? 'omk doctor 健康检查报告' : 'omk doctor Health Check Report';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="container">
${renderHeader(report, lang)}
${skillsHtml}
</div>
<script type="application/json" id="doctor-report-data">${escapeHtml(dataInline)}</script>
<script>${JS}</script>
</body>
</html>`;
}
