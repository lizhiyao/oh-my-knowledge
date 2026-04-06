import { e, fmtNum, fmtCost, fmtDuration, COLORS, t } from './layout.js';
import type { AnalysisResult, Insight, KnowledgeCoverage, Lang, VariantSummary } from '../types.js';

export function renderSummaryCards(variants: string[], summary: Record<string, VariantSummary>, lang: Lang): string {
  // Build comparison table: variants as rows, dimensions as columns
  const headerCols = [
    { key: 'dimQuality', label: t('dimQuality', lang) },
    { key: 'dimCost', label: t('dimCost', lang) },
    { key: 'dimEfficiency', label: t('dimEfficiency', lang) },
    { key: 'dimStability', label: t('dimStability', lang) },
  ];

  const thead = `<tr><th data-i18n="variants">${t('variants', lang)}</th>${headerCols.map((c) => `<th data-i18n="${c.key}">${c.label}</th>`).join('')}</tr>`;

  const rows = variants.map((v, i) => {
    const s = summary[v] || {} as VariantSummary;
    const color = COLORS[i % COLORS.length];

    // Quality — show composite + layered breakdown
    const score = s.avgCompositeScore ?? s.avgLlmScore ?? '-';
    const factLabel = lang === 'zh' ? '事实' : 'Fact';
    const behaviorLabel = lang === 'zh' ? '行为' : 'Behavior';
    const qualityLabel = lang === 'zh' ? '质量' : 'Quality';

    const layeredDetailParts: string[] = [];
    const hintParts: string[] = [];

    if (s.avgFactScore != null) {
      layeredDetailParts.push(`<span>${factLabel}: ${s.avgFactScore}</span>`);
      hintParts.push(`${factLabel}: ${s.avgFactScore}`);
    }
    if (s.avgBehaviorScore != null) {
      layeredDetailParts.push(`<span>${behaviorLabel}: ${s.avgBehaviorScore}</span>`);
      hintParts.push(`${behaviorLabel}: ${s.avgBehaviorScore}`);
    }
    if (s.avgFactVerifiedRate != null) {
      const pct = Math.round(s.avgFactVerifiedRate * 100);
      layeredDetailParts.push(`<span>${lang === 'zh' ? '事实验证' : 'Verified'}: ${pct}%</span>`);
      hintParts.push(`${lang === 'zh' ? '事实验证' : 'Verified'}: ${pct}%`);
    }
    if (s.avgQualityScore != null) {
      layeredDetailParts.push(`<span>${qualityLabel}: ${s.avgQualityScore}</span>`);
      hintParts.push(`${qualityLabel}: ${s.avgQualityScore}`);
    }

    if (layeredDetailParts.length === 0) {
      // Fallback to old style if no layered scores
      if (s.minCompositeScore != null) { layeredDetailParts.push(`${s.minCompositeScore}~${s.maxCompositeScore}`); hintParts.push(`${s.minCompositeScore}~${s.maxCompositeScore}`); }
      if (s.avgAssertionScore != null) { layeredDetailParts.push(`${t('assertions', lang)}: ${s.avgAssertionScore}`); hintParts.push(`${t('assertions', lang)}: ${s.avgAssertionScore}`); }
      if (s.avgLlmScore != null) { layeredDetailParts.push(`${t('llmJudge', lang)}: ${s.avgLlmScore}`); hintParts.push(`${t('llmJudge', lang)}: ${s.avgLlmScore}`); }
    }

    const scoreNum = typeof score === 'number' ? score : 0;
    const scoreColor = scoreNum >= 4 ? 'var(--green)' : scoreNum >= 3 ? 'var(--yellow)' : scoreNum > 0 ? 'var(--red)' : 'var(--text-primary)';
    const qualityCell = `<td class="summary-cell"><div class="summary-value summary-value-primary" style="color:${scoreColor}">${score}</div><div class="summary-detail">${layeredDetailParts.join(' · ')}</div></td>`;

    // Cost — only show execution cost (judge cost is tool overhead, not skill cost)
    const execCost = s.totalExecCostUSD || 0;
    const hasCost = execCost > 0 || (s.avgTotalTokens || 0) > 0;
    const costCell = hasCost
      ? `<td class="summary-cell"><div class="summary-value">${fmtCost(execCost)}</div><div class="summary-detail">${fmtNum(s.avgTotalTokens)} tokens/${t('tokPerReq', lang).replace('tokens/', '')}</div></td>`
      : `<td class="summary-cell"><span style="color:var(--text-muted)">N/A</span></td>`;

    // Efficiency
    const effDetails: string[] = [];
    if ((s.avgNumTurns || 0) > 0) effDetails.push(`${s.avgNumTurns} ${t('turnsPerReq', lang)}`);
    if (s.avgToolCalls != null && s.avgToolCalls > 0) {
      const srPct = s.toolSuccessRate != null ? ` (${(s.toolSuccessRate * 100).toFixed(0)}% OK)` : '';
      effDetails.push(`${s.avgToolCalls} tools/req${srPct}`);
    }
    const totalDurationMs = (s.avgDurationMs || 0) * (s.successCount || 0);
    if (totalDurationMs > 0) effDetails.push(`${lang === 'zh' ? '总计' : 'total'} ${fmtDuration(totalDurationMs)}`);
    const effDetail = effDetails.length > 0 ? `<div class="summary-detail">${effDetails.join(' · ')}</div>` : '';
    const avgLabel = lang === 'zh' ? '次' : 'req';
    const effCell = `<td class="summary-cell"><div class="summary-value">${fmtDuration(s.avgDurationMs)}<span class="summary-unit">/${avgLabel}</span></div>${effDetail}</td>`;

    // Stability: primary = score range, detail = success rate + CV
    const total = s.totalSamples || 0;
    const successCount = s.successCount || 0;
    const successRate = total > 0 ? Number((successCount / total * 100).toFixed(1)) : 0;

    let stabValue: string;
    let stabColor: string;
    if (s.minCompositeScore != null && s.maxCompositeScore != null) {
      const spread = s.maxCompositeScore - s.minCompositeScore;
      stabValue = s.minCompositeScore === s.maxCompositeScore
        ? `${s.minCompositeScore}`
        : `${s.minCompositeScore}~${s.maxCompositeScore}`;
      stabColor = spread <= 0.5 ? 'var(--green)' : spread <= 2 ? 'var(--yellow)' : 'var(--red)';
    } else {
      stabValue = `${successRate}%`;
      stabColor = successRate === 100 ? 'var(--green)' : successRate >= 90 ? 'var(--yellow)' : 'var(--red)';
    }

    const stabDetails: string[] = [];
    if ((s.errorCount || 0) > 0) {
      stabDetails.push(`<span style="color:var(--red)">${s.errorCount} ${t('errors', lang)}</span>`);
    }
    stabDetails.push(`${t('successRate', lang)} ${successRate}%`);
    if (s.scoreCV != null) {
      const cvPct = (s.scoreCV * 100).toFixed(0);
      stabDetails.push(`${lang === 'zh' ? '变异系数' : 'CV'} ${cvPct}%`);
    }
    const stabDetail = `<div class="summary-detail">${stabDetails.join(' · ')}</div>`;
    const stabCell = `<td class="summary-cell"><div class="summary-value" style="color:${stabColor}">${stabValue}</div>${stabDetail}</td>`;

    return `<tr><td style="border-left:3px solid ${color};padding-left:12px"><strong>${e(v)}</strong></td>${qualityCell}${costCell}${effCell}${stabCell}</tr>`;
  }).join('');

  const guideModalId = 'guide-four-dims';
  const guideTitle = lang === 'zh' ? '如何阅读四维对比？' : 'How to read this table?';
  const guideIntro = lang === 'zh'
    ? '每行是一个实验分组（Variant），四列分别衡量不同维度：'
    : 'Each row is a Variant. Four columns measure different dimensions:';
  const icon = (emoji: string) => `<span aria-hidden="true">${emoji}</span>`;
  const dim = 'style="padding:8px 0 4px;border-top:1px solid var(--border);color:var(--text-primary)"';
  const dimDesc = 'style="padding:8px 0 4px;border-top:1px solid var(--border);color:var(--text-secondary)"';
  const dimFirst = 'style="padding:4px 0 4px;color:var(--text-primary)"';
  const dimFirstDesc = 'style="padding:4px 0 4px;color:var(--text-secondary)"';
  const sub = 'style="padding:2px 0 2px 28px;font-size:12px;color:var(--text-secondary);font-weight:500"';
  const subDesc = 'style="padding:2px 0;font-size:12px;color:var(--text-muted)"';
  const guideRows = lang === 'zh' ? `
    <tr><td ${dimFirst}>${icon('📊')} <strong>质量</strong></td><td ${dimFirstDesc}>三层评分的等权平均值（1-5 分），计算公式：(事实 + 行为 + 质量) ÷ 3</td></tr>
    <tr><td ${sub}>事实性</td><td ${subDesc}>输出中的事实声明是否正确（关键词匹配、格式校验等断言）</td></tr>
    <tr><td ${sub}>行为合规</td><td ${subDesc}>执行过程是否合规（工具调用路径、轮次限制、成本约束等断言）</td></tr>
    <tr><td ${sub}>质量</td><td ${subDesc}>LLM 评委对输出整体质量的主观评分</td></tr>
    <tr><td ${dim}>${icon('💰')} <strong>成本</strong></td><td ${dimDesc}>API 调用费用（仅执行成本，不含评分成本）</td></tr>
    <tr><td ${dim}>${icon('⚡')} <strong>效率</strong></td><td ${dimDesc}>单次评测的平均耗时，含轮次和工具调用统计</td></tr>
    <tr><td ${dim}>${icon('🛡️')} <strong>稳定性</strong></td><td ${dimDesc}>多个样本间分数的波动程度</td></tr>
    <tr><td ${sub}>分数范围</td><td ${subDesc}>所有样本中的最低分 ~ 最高分，范围越窄越稳定</td></tr>
    <tr><td ${sub}>成功率</td><td ${subDesc}>评测任务成功完成的比例，失败包括超时、API 错误等</td></tr>
    <tr><td ${sub}>变异系数</td><td ${subDesc}>质量分数的标准差 ÷ 质量分数的平均值，衡量分数波动程度。越低越稳定，0% = 所有样本得分一致</td></tr>
  ` : `
    <tr><td ${dimFirst}>${icon('📊')} <strong>Quality</strong></td><td ${dimFirstDesc}>Equal-weight average of three layers (1-5): (Fact + Behavior + Quality) ÷ 3</td></tr>
    <tr><td ${sub}>Factual</td><td ${subDesc}>Are factual claims correct (keyword matching, format validation assertions)</td></tr>
    <tr><td ${sub}>Behavioral</td><td ${subDesc}>Is execution compliant (tool paths, turn limits, cost constraints)</td></tr>
    <tr><td ${sub}>Quality</td><td ${subDesc}>LLM judge subjective score on output quality</td></tr>
    <tr><td ${dim}>${icon('💰')} <strong>Cost</strong></td><td ${dimDesc}>API expense (execution only, excludes judge cost)</td></tr>
    <tr><td ${dim}>${icon('⚡')} <strong>Efficiency</strong></td><td ${dimDesc}>Average time per evaluation, with turn and tool call stats</td></tr>
    <tr><td ${dim}>${icon('🛡️')} <strong>Stability</strong></td><td ${dimDesc}>Score variance across samples</td></tr>
    <tr><td ${sub}>Score range</td><td ${subDesc}>Min ~ Max score across all samples. Narrower = more stable</td></tr>
    <tr><td ${sub}>Success rate</td><td ${subDesc}>Percentage of tasks completed successfully (failures include timeouts, API errors)</td></tr>
    <tr><td ${sub}>CV</td><td ${subDesc}>Coefficient of Variation = StdDev ÷ Mean. Lower is more stable, 0% = identical scores</td></tr>
  `;

  return `
    <h2 data-i18n="dimQuality" style="display:flex;align-items:center;gap:4px">${t('reportTitle', lang) === t('reportTitle', 'zh') ? '四维对比' : 'Comparison'} <span class="hint hint-click" tabindex="0" onclick="document.getElementById('${guideModalId}').style.display='flex'" aria-label="${e(guideTitle)}">?</span></h2>
    <div id="${guideModalId}" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="${guideModalId}-title" onclick="if(event.target===this)this.style.display='none'">
      <div class="modal-content">
        <div class="modal-header">
          <strong id="${guideModalId}-title" style="font-size:1rem">${e(guideTitle)}</strong>
          <button class="modal-close" onclick="document.getElementById('${guideModalId}').style.display='none'" aria-label="${lang === 'zh' ? '关闭' : 'Close'}">✕</button>
        </div>
        <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 16px">${e(guideIntro)}</p>
        <table class="modal-table"><tbody>${guideRows}</tbody></table>
      </div>
    </div>
    <div class="table-wrap">
    <table class="summary-table">
      <thead>${thead}</thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}

const CONCLUSION_TYPES = new Set([
  'efficiency_gap', 'tool_count_gap', 'high_cost_sample',
]);

function isConclusion(insight: Insight): boolean {
  return CONCLUSION_TYPES.has(insight.type);
}

function severityDot(severity: string): string {
  const color: Record<string, string> = {
    error: 'var(--red)',
    warning: 'var(--yellow)',
    info: 'var(--accent)',
  };
  return `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${color[severity] || 'var(--text-muted)'};margin-right:8px;flex-shrink:0;margin-top:6px"></span>`;
}

function renderSummaryStructured(summary: string): string {
  const markerRegex = /【([^】]+)】/g;
  const markers: Array<{ label: string; start: number; contentStart: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = markerRegex.exec(summary)) !== null) {
    markers.push({ label: match[1], start: match.index, contentStart: match.index + match[0].length });
  }

  const sections: Array<{ label: string; content: string }> = [];
  for (let i = 0; i < markers.length; i++) {
    const end = i + 1 < markers.length ? markers[i + 1].start : summary.length;
    sections.push({ label: markers[i].label, content: summary.slice(markers[i].contentStart, end).trim() });
  }

  if (sections.length === 0) {
    return `<div style="padding:14px 18px;font-size:13px;line-height:1.8;color:var(--text-secondary);background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border)">${e(summary)}</div>`;
  }

  const sectionHtml = sections.map((section) => `
      <div style="display:flex;gap:12px;align-items:baseline">
        <span style="flex-shrink:0;font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:0.03em;min-width:56px">${e(section.label)}</span>
        <span style="color:var(--text-secondary);font-size:13px;line-height:1.7">${e(section.content)}</span>
      </div>`).join('');

  return `
    <div style="padding:14px 18px;background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border);display:flex;flex-direction:column;gap:8px">
      ${sectionHtml}
    </div>`;
}

export function renderAnalysis(analysis: AnalysisResult | undefined, lang: Lang): string {
  if (!analysis) return '';
  const { insights, suggestions } = analysis;
  if ((!insights || insights.length === 0) && (!suggestions || suggestions.length === 0)) return '';

  const issues = (insights || []).filter((insight) => !isConclusion(insight));
  const issueLabel = lang === 'zh' ? '问题与建议' : 'Issues & Suggestions';
  const safeSuggestions = suggestions || [];

  let issuesHtml = '';
  if (issues.length > 0 || safeSuggestions.length > 0) {
    const maxRows = Math.max(issues.length, safeSuggestions.length);
    const rows: string[] = [];
    for (let i = 0; i < maxRows; i++) {
      const issue = issues[i];
      const suggestion = safeSuggestions[i];
      const issueContent = issue
        ? `${severityDot(issue.severity)}<span>${e(issue.message)}</span>`
        : '';
      const suggestionContent = suggestion
        ? e(suggestion)
        : `<span style="color:var(--text-faint)">—</span>`;

      rows.push(`
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:10px 16px;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:flex-start;color:var(--text-secondary);font-size:12.5px;line-height:1.6">${issueContent}</div>
          <div style="color:var(--text-muted);font-size:12.5px;line-height:1.6">${suggestionContent}</div>
        </div>`);
    }

    issuesHtml = `
      <div style="margin-top:12px">
        <h3 style="font-size:12px;color:var(--text-muted);font-weight:600;margin:0 0 8px;letter-spacing:0.03em">${issueLabel}</h3>
        <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:8px 16px;border-bottom:1px solid var(--border)">
            <div style="font-size:11px;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em">${lang === 'zh' ? '问题' : 'Issue'}</div>
            <div style="font-size:11px;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em">${lang === 'zh' ? '建议' : 'Suggestion'}</div>
          </div>
          ${rows.join('')}
        </div>
      </div>
    `;
  }

  const summaryHtml = analysis.summary
    ? renderSummaryStructured(analysis.summary)
    : '';

  return `
    <h2 data-i18n="autoAnalysis">${t('autoAnalysis', lang)}</h2>
    ${summaryHtml}
    ${issuesHtml}
  `;
}

export function renderAgentOverview(variants: string[], summary: Record<string, VariantSummary>, lang: Lang): string {
  const hasAgentData = variants.some((variant) => summary[variant]?.avgToolCalls != null && summary[variant].avgToolCalls! > 0);
  if (!hasAgentData) return '';

  const variantCards = variants.map((variant, i) => {
    const stats = summary[variant];
    if (!stats) return '';
    const color = COLORS[i % COLORS.length];
    const avgTools = stats.avgToolCalls ?? 0;
    const successRate = stats.toolSuccessRate != null ? `${(stats.toolSuccessRate * 100).toFixed(0)}%` : '-';
    const successRateColor = (stats.toolSuccessRate ?? 1) >= 0.8 ? 'var(--green)' : 'var(--red)';
    const turns = stats.avgNumTurns || 0;
    const distributionEntries = Object.entries(stats.toolDistribution || {}).sort((a, b) => b[1] - a[1]);
    const maxCount = distributionEntries.length > 0 ? distributionEntries[0][1] : 0;
    const distributionBars = distributionEntries.map(([tool, count]) => {
      const pct = maxCount > 0 ? Math.max(8, (count / maxCount) * 100) : 0;
      return `<div style="display:flex;align-items:center;gap:6px;margin:2px 0">
        <span style="font-size:11px;color:var(--text-muted);width:100px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0" title="${e(tool)}">${e(tool)}</span>
        <div style="flex:1;height:8px;background:var(--bg-surface);border-radius:4px">
          <div style="width:${pct}%;height:100%;background:${color};border-radius:4px"></div>
        </div>
        <span style="font-size:11px;color:var(--text-secondary);min-width:20px">${count}</span>
      </div>`;
    }).join('');

    return `<div style="flex:1;min-width:240px;padding:16px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius);border-left:3px solid ${color}">
      <div style="font-weight:600;margin-bottom:12px">${e(variant)}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div>
          <div style="font-size:11px;color:var(--text-muted)">${t('agentAvgTurns', lang)}</div>
          <div style="font-size:20px;font-weight:600">${turns}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted)">${t('agentAvgTools', lang)}</div>
          <div style="font-size:20px;font-weight:600">${avgTools}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted)">${t('agentToolSuccess', lang)}</div>
          <div style="font-size:20px;font-weight:600;color:${successRateColor}">${successRate}</div>
        </div>
      </div>
      ${distributionEntries.length > 0 ? `
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${t('agentToolDist', lang)}</div>
        ${distributionBars}
      ` : ''}
    </div>`;
  }).join('');

  return `
    <section style="margin-top:24px">
      <h2>${t('agentOverview', lang)}</h2>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        ${variantCards}
      </div>
    </section>
  `;
}

export function renderCoverageSection(coverage: Record<string, KnowledgeCoverage> | undefined, lang: Lang): string {
  if (!coverage || Object.keys(coverage).length === 0) return '';

  const variantSections = Object.entries(coverage).map(([variant, knowledgeCoverage]) => {
    if (knowledgeCoverage.filesTotal === 0) return '';

    const pct = Math.round(knowledgeCoverage.fileCoverageRate * 100);
    const pctColor = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)';
    const barW = Math.max(2, pct);

    const fileRows = knowledgeCoverage.entries
      .sort((a, b) => (a.accessed === b.accessed ? 0 : a.accessed ? -1 : 1))
      .map((entry) => {
        const icon = entry.accessed ? '✓' : '✗';
        const color = entry.accessed ? 'var(--green)' : 'var(--text-muted)';
        const countBadge = entry.accessCount > 1
          ? `<span style="font-size:10px;color:var(--accent);margin-left:4px">×${entry.accessCount}</span>`
          : '';
        const lines = entry.lineCount ? `<span style="font-size:10px;color:var(--text-muted);margin-left:4px">${entry.lineCount}L</span>` : '';
        const typeTag = `<span style="font-size:10px;padding:1px 4px;border-radius:2px;background:var(--bg-surface);color:var(--text-muted);margin-left:4px">${e(entry.type)}</span>`;
        return `<div style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:12px">
          <span style="color:${color};width:16px;text-align:center">${icon}</span>
          <span style="color:${entry.accessed ? 'var(--text-primary)' : 'var(--text-muted)'};${entry.accessed ? '' : 'text-decoration:line-through;opacity:0.6'}">${e(entry.path)}</span>
          ${typeTag}${lines}${countBadge}
        </div>`;
      }).join('');

    const uncoveredByType: Record<string, string[]> = {};
    for (const entry of knowledgeCoverage.entries.filter((item) => !item.accessed)) {
      const category = entry.path.startsWith('repos/') ? 'code' : entry.type;
      (uncoveredByType[category] = uncoveredByType[category] || []).push(entry.path);
    }
    const hintLines: string[] = [];
    const typeLabels: Record<string, string> = lang === 'zh'
      ? { principle: '原则文件', semantic: '语义索引', design: '设计文档', code: '代码路径', script: '脚本工具', other: '其他知识' }
      : { principle: 'Principles', semantic: 'Semantic index', design: 'Design docs', code: 'Code paths', script: 'Scripts', other: 'Other' };
    for (const [type, files] of Object.entries(uncoveredByType)) {
      const label = typeLabels[type] || type;
      hintLines.push(`<strong>${label}</strong>（${files.length}）：${files.slice(0, 3).map((file) => `<code>${e(file)}</code>`).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`);
    }
    const uncoveredHint = hintLines.length > 0
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:10px;border-top:1px solid var(--border);padding-top:8px">
          <div style="margin-bottom:4px">${lang === 'zh' ? '💡 建议从以下维度补充测试用例：' : '💡 Consider adding test cases for:'}</div>
          ${hintLines.map((line) => `<div style="margin:2px 0">${line}</div>`).join('')}
        </div>`
      : '';

    return `<div style="flex:1;min-width:280px;padding:16px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <strong>${e(variant)}</strong>
        <span style="font-size:20px;font-weight:600;color:${pctColor}">${pct}%</span>
      </div>
      <div style="height:8px;background:var(--bg-card);border-radius:4px;margin-bottom:8px">
        <div style="width:${barW}%;height:100%;background:${pctColor};border-radius:4px"></div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${knowledgeCoverage.filesCovered}/${knowledgeCoverage.filesTotal} ${lang === 'zh' ? '文件被访问' : 'files accessed'} · ${knowledgeCoverage.grepPatternsUsed} ${lang === 'zh' ? '次搜索' : 'searches'}</div>
      ${fileRows}
      ${uncoveredHint}
    </div>`;
  }).join('');

  const title = lang === 'zh' ? '测评用例知识覆盖率' : 'Test Case Knowledge Coverage';
  const desc = lang === 'zh'
    ? '当前测试用例触及了 artifact 知识域中多少文件。覆盖率低说明需要补充测试样本，而非知识本身不完整。'
    : 'How much of the artifact\'s knowledge domain was exercised by current test cases. Low coverage suggests more test samples are needed.';

  return `
    <section style="margin-top:24px">
      <h2>${title}</h2>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${desc}</p>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        ${variantSections}
      </div>
    </section>
  `;
}
