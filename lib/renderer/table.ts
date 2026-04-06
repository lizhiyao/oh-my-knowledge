import { e, fmtNum, fmtDuration, delta, t } from './layout.js';
import type { Lang, ResultEntry, TurnInfo, ToolCallInfo } from '../types.js';

function renderTrace(turns: TurnInfo[], toolCalls: ToolCallInfo[] | undefined, timing: { execMs: number; gradeMs: number; totalMs: number } | undefined, fullOutput: string | undefined, id: string, lang: Lang): string {
  if (!turns || turns.length === 0) return '';

  const timingHtml = timing
    ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${t('traceExecMs', lang)} ${fmtDuration(timing.execMs)} · ${t('traceGradeMs', lang)} ${fmtDuration(timing.gradeMs)} · ${t('traceTotalMs', lang)} ${fmtDuration(timing.totalMs)}</div>`
    : '';

  const steps = turns.map((turn, i) => {
    const durTag = turn.durationMs ? `<span style="color:var(--text-muted);font-size:10px;margin-left:6px">${fmtDuration(turn.durationMs)}</span>` : '';

    if (turn.role === 'assistant') {
      const toolTags = (turn.toolCalls || []).map((tc) => {
        const statusColor = tc.success ? 'var(--green)' : 'var(--red)';
        const inputPreview = typeof tc.input === 'string' ? tc.input.slice(0, 80) : JSON.stringify(tc.input || '').slice(0, 80);
        return `<div style="margin:2px 0 2px 16px;font-size:11px"><span style="color:${statusColor}">●</span> <strong>${e(tc.tool)}</strong> <span style="color:var(--text-muted)">${e(inputPreview)}</span></div>`;
      }).join('');
      const textPreview = turn.content ? `<div style="font-size:11px;color:var(--text-secondary);margin-left:16px;white-space:pre-wrap;max-height:60px;overflow:hidden">${e(turn.content.slice(0, 200))}</div>` : '';
      return `<div style="margin:4px 0;padding:4px 0;border-left:2px solid var(--accent)">
        <div style="font-size:11px;padding-left:8px"><span style="color:var(--accent);font-weight:600">[${i + 1}] ${t('traceAssistant', lang)}</span>${durTag}</div>
        ${toolTags}${textPreview}
      </div>`;
    }
    // tool result
    const statusIcon = turn.content.length > 0 ? '✓' : '✗';
    return `<div style="margin:4px 0;padding:4px 0;border-left:2px solid var(--border)">
      <div style="font-size:11px;padding-left:8px"><span style="color:var(--text-muted)">[${i + 1}] ${t('traceTool', lang)} ${statusIcon}</span>${durTag}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-left:16px;white-space:pre-wrap;max-height:40px;overflow:hidden">${e(turn.content.slice(0, 200))}</div>
    </div>`;
  }).join('');

  const outputBtn = fullOutput
    ? `<button onclick="document.getElementById('modal-${id}').style.display='flex'" style="font-size:11px;margin-top:4px;padding:2px 8px;cursor:pointer;background:var(--bg-surface);color:var(--accent);border:1px solid var(--border);border-radius:var(--radius)">${t('traceFullOutput', lang)}</button>
       <div id="modal-${id}" style="display:none;position:fixed;inset:0;z-index:999;background:rgba(0,0,0,0.6);align-items:center;justify-content:center" onclick="if(event.target===this)this.style.display='none'">
         <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);max-width:800px;max-height:80vh;overflow:auto;padding:20px;margin:20px;width:90%">
           <div style="display:flex;justify-content:space-between;margin-bottom:12px"><strong>${t('traceFullOutput', lang)}</strong><button onclick="this.closest('[id^=modal]').style.display='none'" style="cursor:pointer;background:none;border:none;color:var(--text-muted);font-size:16px">✕</button></div>
           <pre style="font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--text-primary)">${e(fullOutput)}</pre>
         </div>
       </div>`
    : '';

  return `<details style="margin-top:6px">
    <summary style="font-size:11px;color:var(--accent);cursor:pointer">${t('traceToggle', lang)} (${turns.length} steps)</summary>
    <div style="margin-top:4px;padding:8px;background:var(--bg-surface);border-radius:var(--radius);max-height:400px;overflow-y:auto">
      ${timingHtml}${steps}${outputBtn}
    </div>
  </details>`;
}

export function renderSampleTable(variants: string[], results: ResultEntry[], lang: Lang): string {
  const headerCols = variants.map((v) =>
    `<th>${e(v)} <span data-i18n="scoreCol">${t('scoreCol', lang)}</span></th><th>${e(v)} <span data-i18n="tokensCol">${t('tokensCol', lang)}</span></th><th>${e(v)} <span data-i18n="msCol">${t('msCol', lang)}</span></th>`
  ).join('');

  const sampleRows = results.map((r) => {
    const cols = variants.map((v, i) => {
      const d = r.variants?.[v];
      if (!d) return '<td>-</td><td>-</td><td>-</td>';

      const score = d.compositeScore ?? d.llmScore;
      const hasScore = typeof score === 'number';
      const scoreClass = !d.ok ? 'badge-err' : hasScore ? 'badge-ok' : 'badge-muted';
      const scoreText = hasScore ? score : (d.ok ? '-' : 'ERR');

      // Layered score badges
      let layeredHtml = '';
      if (d.layeredScores) {
        const ls = d.layeredScores;
        const badges: string[] = [];
        if (ls.factScore != null) badges.push(`<span class="dim-tag" title="${lang === 'zh' ? '事实性：输出中的事实声明是否正确' : 'Factual: Are factual claims correct'}">${lang === 'zh' ? '事实' : 'F'}:${ls.factScore}</span>`);
        if (ls.behaviorScore != null) badges.push(`<span class="dim-tag" title="${lang === 'zh' ? '行为合规：执行路径是否符合预期' : 'Behavioral: Is execution path compliant'}">${lang === 'zh' ? '行为' : 'B'}:${ls.behaviorScore}</span>`);
        if (ls.qualityScore != null) badges.push(`<span class="dim-tag" title="${lang === 'zh' ? '质量：LLM 评委对输出整体质量的评分' : 'Quality: LLM judge score on output quality'}">${lang === 'zh' ? '质量' : 'Q'}:${ls.qualityScore}</span>`);
        if (badges.length > 0) layeredHtml = `<div class="dim-scores">${badges.join('')}</div>`;
      }

      // Fact check badge
      let factCheckHtml = '';
      if (d.factCheck && d.factCheck.totalCount > 0) {
        const fc = d.factCheck;
        const fcColor = fc.verifiedRate >= 0.8 ? 'var(--green)' : fc.verifiedRate >= 0.5 ? 'var(--yellow)' : 'var(--red)';
        factCheckHtml = `<div style="font-size:11px;margin-top:2px"><span style="color:${fcColor}">${lang === 'zh' ? '事实验证' : 'Verified'} ${fc.verifiedCount}/${fc.totalCount}</span></div>`;
      }

      const errorHtml = !d.ok && d.error
        ? `<br><span class="error-detail">${e(d.error)}</span>`
        : '';

      // Only show failed assertions
      let assertionHtml = '';
      if (d.assertions?.details) {
        const failed = d.assertions.details.filter((a) => !a.passed);
        if (failed.length > 0) {
          const items = failed.map((a) =>
            `<li><span class="badge badge-fail" style="font-size:10px;padding:1px 4px">&#10007;</span> ${e(a.type)}: ${e(a.value)}</li>`
          ).join('');
          assertionHtml = `<ul class="assertion-list">${items}</ul>`;
        }
      }

      let dimHtml = '';
      if (d.dimensions) {
        const tags = Object.entries(d.dimensions).map(([dim, info]) => {
          const s = typeof info === 'object' ? info.score : info;
          return `<span class="dim-tag">${e(dim)}: ${s}</span>`;
        }).join('');
        dimHtml = `<div class="dim-scores">${tags}</div>`;
      }

      const reasonHtml = d.llmReason
        ? `<br><span style="font-size:11px;color:var(--text-muted)">${e(d.llmReason?.slice(0, 80))}</span>`
        : '';

      // Agent tool call summary
      let toolHtml = '';
      if (d.numToolCalls != null && d.numToolCalls > 0) {
        const srColor = (d.toolSuccessRate ?? 1) >= 0.8 ? 'var(--green)' : 'var(--red)';
        const srText = d.toolSuccessRate != null ? `${(d.toolSuccessRate * 100).toFixed(0)}%` : '-';
        const toolList = (d.toolNames || []).join(', ');
        const toolTip = toolList ? ` title="${e(toolList)}"` : '';
        toolHtml = `<div style="font-size:11px;margin-top:2px;color:var(--text-muted)"${toolTip}>🔧 ${d.numToolCalls} calls · <span style="color:${srColor}">${srText} OK</span></div>`;
      }

      // Execution trace (expandable)
      const traceId = `trace-${r.sample_id}-${v}`.replace(/[^a-zA-Z0-9-]/g, '_');
      const traceHtml = d.turns ? renderTrace(d.turns, d.toolCalls, d.timing, d.fullOutput, traceId, lang) : '';

      // Timing summary
      const timingHtml = d.timing
        ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">${t('traceExecMs', lang)} ${fmtDuration(d.timing.execMs)} · ${t('traceGradeMs', lang)} ${fmtDuration(d.timing.gradeMs)}</div>`
        : '';

      const firstV = r.variants?.[variants[0]];
      const totalMs = d.timing?.totalMs || d.durationMs;
      const firstTotalMs = firstV?.timing?.totalMs || firstV?.durationMs || 0;
      const tokenDelta = i > 0 && firstV ? delta(firstV.totalTokens, d.totalTokens, true) : '';
      const msDelta = i > 0 && firstTotalMs ? delta(firstTotalMs, totalMs, true) : '';

      return `<td><span class="badge ${scoreClass}">${scoreText}</span>${layeredHtml}${factCheckHtml}${errorHtml}${reasonHtml}${assertionHtml}${dimHtml}${toolHtml}${timingHtml}${traceHtml}</td><td>${fmtNum(d.totalTokens)}${tokenDelta}</td><td>${fmtDuration(totalMs)}${msDelta}</td>`;
    }).join('');

    return `<tr><td><strong>${e(r.sample_id)}</strong></td>${cols}</tr>`;
  }).join('');

  return `
    <h2 data-i18n="perSampleDetail">${t('perSampleDetail', lang)}</h2>
    <div class="table-wrap">
    <table>
      <thead><tr><th data-i18n="sample">${t('sample', lang)}</th>${headerCols}</tr></thead>
      <tbody>${sampleRows}</tbody>
    </table>
    </div>`;
}
