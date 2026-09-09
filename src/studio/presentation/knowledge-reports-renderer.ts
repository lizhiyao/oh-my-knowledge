import type { Lang } from '../../shared/language.js';
import type { AnalysisListItem, SkillTrendResult, SkillDiffResult } from '../view-models/knowledge-reports.js';
import { DEFAULT_LANG, e, layout, t } from './layout.js';

function fmtDelta(d: number | null | undefined, isPercent = true, direction: 'lower' | 'higher' | 'neutral' = 'lower'): string {
  if (d == null) return '—';
  const pct = isPercent ? d * 100 : d;
  const sign = pct > 0 ? '+' : '';
  const improves = direction === 'higher' ? pct > 0 : pct < 0;
  const color = direction === 'neutral' || Math.abs(pct) < 1 ? '#888' : improves ? '#16a34a' : '#dc2626';
  return `<span style="color:${color}">${sign}${pct.toFixed(isPercent ? 1 : 0)}${isPercent ? '%' : ''}</span>`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${Math.round(v * 100)}%`;
}

export function renderSkillDiffPage(diff: SkillDiffResult, lang: Lang = DEFAULT_LANG): string {
  const { fromId, toId, fromAt, toAt, rows } = diff;
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const rowHtml = rows.map((r) => {
    const tag = r.presence === 'only-from' ? `<span style="color:var(--green);font-size:10px;padding:1px 6px;background:var(--green-bg);border-radius:3px" data-i18n="diffTagRemoved">${t('diffTagRemoved', lang)}</span>`
      : r.presence === 'only-to' ? `<span style="color:var(--accent);font-size:10px;padding:1px 6px;background:var(--info-bg);border-radius:3px" data-i18n="diffTagNew">${t('diffTagNew', lang)}</span>`
      : '';
    return `<tr>
      <td style="padding:8px 10px;font-family:ui-monospace,monospace">${e(r.skillName)} ${tag}</td>
      <td style="padding:8px 10px;text-align:right">${r.fromSegments ?? '—'} → ${r.toSegments ?? '—'} ${r.presence === 'both' ? `(${fmtDelta(r.deltaSegments, false, 'neutral')})` : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromGap)} → ${fmtPct(r.toGap)} ${r.presence === 'both' ? fmtDelta(r.deltaGap) : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromFailure)} → ${fmtPct(r.toFailure)} ${r.presence === 'both' ? fmtDelta(r.deltaFailure) : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromCoverage)} → ${fmtPct(r.toCoverage)} ${r.presence === 'both' && r.deltaCoverage != null ? fmtDelta(r.deltaCoverage, true, 'higher') : ''}</td>
    </tr>`;
  }).join('');
  const body = `
    <main style="max-width:1000px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:8px">
        <a href="/observe/health${langQ}" data-i18n="backToAnalyses" style="color:var(--accent);text-decoration:none;margin-right:12px">${t('backToAnalyses', lang)}</a>
        <a href="/observe/health/${encodeURIComponent(fromId)}${langQ}" data-i18n="diffNavFrom" style="color:var(--accent);text-decoration:none;margin-right:12px">${t('diffNavFrom', lang)}</a>
        <a href="/observe/health/${encodeURIComponent(toId)}${langQ}" data-i18n="diffNavTo" style="color:var(--accent);text-decoration:none">${t('diffNavTo', lang)}</a>
      </nav>
      <h1 data-i18n="skillDiffHeading" style="font-size:20px;margin:8px 0">${t('skillDiffHeading', lang)}</h1>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:20px">
        <span data-i18n="diffNavFrom">${t('diffNavFrom', lang)}</span> <code>${e(fromId)}</code> (${e(fromAt.slice(0, 19).replace('T', ' '))}) → <span data-i18n="diffNavTo">${t('diffNavTo', lang)}</span> <code>${e(toId)}</code> (${e(toAt.slice(0, 19).replace('T', ' '))})<br/>
        <span data-i18n="diffSortHint">${t('diffSortHint', lang)}</span>
      </div>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <thead><tr>
          <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColSkill">${t('diffColSkill', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColSegments">${t('diffColSegments', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColWeightedGap">${t('diffColWeightedGap', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColFailureRate">${t('diffColFailureRate', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColCoverage">${t('diffColCoverage', lang)}</th>
        </tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </main>`;
  return layout(t('skillDiffHeading', lang), body, lang, { navigation: 'observe' });
}

export function renderSkillTrendPage(trend: SkillTrendResult, lang: Lang = DEFAULT_LANG): string {
  const { skillName, points } = trend;
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  if (points.length === 0) {
    const emptyBody = `
    <main style="max-width:900px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:12px"><a href="/observe/health${langQ}" data-i18n="backToAnalyses" style="color:var(--accent);text-decoration:none">${t('backToAnalyses', lang)}</a></nav>
      <h1 style="font-size:20px;margin:8px 0 4px"><span data-i18n="skillTrendHeading">${t('skillTrendHeading', lang)}</span> · ${e(skillName)}</h1>
      <p style="color:var(--text-muted)" data-i18n="noTrendData">${t('noTrendData', lang)}</p>
    </main>`;
    return layout(`${t('skillTrendHeading', lang)} · ${skillName}`, emptyBody, lang, { navigation: 'observe' });
  }
  // SVG 折线图: gapRate 主线 + failureRate 辅线, X 轴时间序
  const W = 760, H = 200, PAD = 40;
  const toX = (i: number) => points.length === 1 ? W / 2 : PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const toY = (v: number) => H - PAD - v * (H - 2 * PAD);
  const pathOf = (key: 'gapRate' | 'weightedGapRate' | 'failureRate' | 'coverageRate') => {
    const usable = points.map((p, i) => ({ x: toX(i), y: p[key] ?? null }));
    let d = '';
    let drawing = false;
    for (const pt of usable) {
      if (pt.y == null) {
        drawing = false;
        continue;
      }
      d += drawing ? ` L ${pt.x} ${toY(pt.y as number)}` : `M ${pt.x} ${toY(pt.y as number)}`;
      drawing = true;
    }
    return d;
  };
  const dots = (key: 'gapRate' | 'weightedGapRate' | 'failureRate' | 'coverageRate', color: string) =>
    points.map((p, i) => p[key] == null ? '' : `<circle cx="${toX(i)}" cy="${toY(p[key] as number)}" r="3" fill="${color}"/>`).join('');
  const yTicks = [0, 0.5, 1.0].map((v) => `<g><line x1="${PAD}" y1="${toY(v)}" x2="${W - PAD}" y2="${toY(v)}" stroke="var(--border)"/><text x="${PAD - 6}" y="${toY(v) + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${Math.round(v * 100)}%</text></g>`).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:${H}px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius)">
    ${yTicks}
    <path d="${pathOf('gapRate')}" stroke="#f87171" stroke-width="2" fill="none"/>
    <path d="${pathOf('weightedGapRate')}" stroke="#fbbf24" stroke-width="2" fill="none" stroke-dasharray="4 4"/>
    <path d="${pathOf('failureRate')}" stroke="#a78bfa" stroke-width="2" fill="none"/>
    <path d="${pathOf('coverageRate')}" stroke="#4ade80" stroke-width="2" fill="none"/>
    ${dots('gapRate', '#f87171')}${dots('weightedGapRate', '#fbbf24')}${dots('failureRate', '#a78bfa')}${dots('coverageRate', '#4ade80')}
  </svg>`;
  const legend = `<div style="margin:12px 0;font-size:12px;color:var(--text-secondary)">
    <span style="color:#f87171">● <span data-i18n="trendLegendGap">${t('trendLegendGap', lang)}</span></span> ·
    <span style="color:#fbbf24">◆ <span data-i18n="trendLegendWeighted">${t('trendLegendWeighted', lang)}</span></span> ·
    <span style="color:#a78bfa">● <span data-i18n="trendLegendFailure">${t('trendLegendFailure', lang)}</span></span> ·
    <span style="color:#4ade80">● <span data-i18n="trendLegendCoverage">${t('trendLegendCoverage', lang)}</span></span>
  </div>`;
  const rows = points.map((p) => {
    const failureCell = p.failureRate == null
      ? '—'
      : `${Math.round(p.failureRate * 100)}%${p.toolCallCount > 0
        ? `<br><span style="color:var(--text-muted);font-size:11px">${p.toolComparableCount}/${p.toolCallCount} ${lang === 'zh' ? '结果可比较' : 'comparable'}${p.toolCancelledCount > 0 ? ` · ${p.toolCancelledCount} ${lang === 'zh' ? '取消' : 'cancelled'}` : ''}</span>`
        : ''}`;
    return `<tr>
    <td style="padding:6px 10px;font-family:ui-monospace,monospace;font-size:12px"><a href="/observe/health/${encodeURIComponent(p.analysisId)}${langQ}" style="color:var(--accent);text-decoration:none">${e(p.generatedAt.slice(0, 19).replace('T', ' '))}</a></td>
    <td style="padding:6px 10px;text-align:right">${p.segmentCount}</td>
    <td style="padding:6px 10px;text-align:right;color:#f87171">${Math.round(p.gapRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#fbbf24">${Math.round(p.weightedGapRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#a78bfa">${failureCell}</td>
    <td style="padding:6px 10px;text-align:right;color:#4ade80">${p.coverageRate == null ? '—' : Math.round(p.coverageRate * 100) + '%'}</td>
    <td style="padding:6px 10px;text-align:right;font-family:ui-monospace,monospace;font-size:12px" title="input+output only; cache 分开计">${(p.billableTokens / 1000).toFixed(1)}k</td>
    <td style="padding:6px 10px;text-align:right;font-family:ui-monospace,monospace;font-size:12px">${(p.durationMs / 1000).toFixed(1)}s</td>
  </tr>`;
  }).join('');
  const subtitle = `${points.length} <span data-i18n="trendNPoints">${t('trendNPoints', lang)}</span> · <span data-i18n="trendEarliest">${t('trendEarliest', lang)}</span> ${e(points[0].generatedAt.slice(0, 10))} · <span data-i18n="trendLatest">${t('trendLatest', lang)}</span> ${e(points[points.length - 1].generatedAt.slice(0, 10))}`;
  const body = `
    <main style="max-width:900px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:8px"><a href="/observe/health${langQ}" data-i18n="backToAnalyses" style="color:var(--accent);text-decoration:none">${t('backToAnalyses', lang)}</a></nav>
      <h1 style="font-size:20px;margin:8px 0 4px"><span data-i18n="skillTrendHeading">${t('skillTrendHeading', lang)}</span> · ${e(skillName)}</h1>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:16px">${subtitle}</div>
      ${svg}
      ${legend}
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:12px">
        <thead><tr>
          <th style="text-align:left;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColTimestamp">${t('trendColTimestamp', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColSegs">${t('trendColSegs', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColGap">${t('trendColGap', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColWeighted">${t('trendColWeighted', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColFailure">${t('trendColFailure', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColCoverage">${t('trendColCoverage', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColTokens">${t('trendColTokens', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColDuration">${t('trendColDuration', lang)}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </main>`;
  return layout(`${t('skillTrendHeading', lang)} · ${skillName}`, body, lang, { navigation: 'observe' });
}

export function renderAnalysisList(items: AnalysisListItem[], lang: Lang = DEFAULT_LANG): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const body = items.length === 0
    ? `
    <main style="max-width:900px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:12px"><a href="/observe${langQ}" style="color:var(--accent);text-decoration:none">${lang === 'zh' ? '← 返回观测' : '← Back to Observe'}</a></nav>
      <h1 data-i18n="skillHealthTitle" style="font-size:20px;margin:8px 0 16px">${t('skillHealthTitle', lang)}</h1>
      <div style="color:var(--text-muted);padding:16px" data-i18n="noAnalyses">${t('noAnalyses', lang)}</div>
    </main>`
    : (() => {
      const rows = items.map((it) => {
        // 低 N 报告的色带仅供参考:列表入口圆点改中性灰,避免点进去才看到「样本不足」的口径错位。
        const underpowered = it.confidence === 'underpowered';
        const badgeColor = underpowered
          ? 'var(--text-faint)'
          : it.healthBand === 'red' ? 'var(--red)' : it.healthBand === 'yellow' ? 'var(--yellow)' : 'var(--green)';
        const enc = encodeURIComponent(it.id);
        return `<li style="padding:10px 14px;border-bottom:1px solid var(--border);list-style:none;display:flex;align-items:center;gap:12px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${badgeColor}"></span>
          <label style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:3px"><input type="radio" name="from" value="${enc}" onchange="updateCompare()"> <span data-i18n="analysesFromLabel">${t('analysesFromLabel', lang)}</span></label>
          <label style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:3px"><input type="radio" name="to" value="${enc}" onchange="updateCompare()"> <span data-i18n="analysesToLabel">${t('analysesToLabel', lang)}</span></label>
          <a href="/observe/health/${enc}${langQ}" style="color:var(--accent);text-decoration:none;flex:1;font-family:ui-monospace,monospace">${e(it.id)}</a>
          <span style="color:var(--text-muted);font-size:12px">${it.sessionCount} <span data-i18n="analysesSessions">${t('analysesSessions', lang)}</span> · ${it.segmentCount} <span data-i18n="analysesSegs">${t('analysesSegs', lang)}</span> · ${it.skillCount} <span data-i18n="analysesSkills">${t('analysesSkills', lang)}</span>${underpowered ? ` · <span data-i18n="analysesLowN" style="color:var(--text-faint)">${t('analysesLowN', lang)}</span>` : ''}</span>
        </li>`;
      }).join('');
      return `
      <main style="max-width:900px;margin:0 auto;padding:24px">
        <nav style="margin-bottom:12px"><a href="/observe${langQ}" style="color:var(--accent);text-decoration:none">${lang === 'zh' ? '← 返回观测' : '← Back to Observe'}</a></nav>
        <h1 data-i18n="skillHealthTitle" style="font-size:20px;margin:8px 0 16px">${t('skillHealthTitle', lang)}</h1>
        <div style="margin-bottom:12px;padding:8px 12px;background:var(--bg-surface);border-radius:var(--radius);font-size:12px;color:var(--text-secondary)">
          <span data-i18n="analysesCompareHint">${t('analysesCompareHint', lang)}</span>
          <a id="compare-btn" style="margin-left:8px;padding:4px 10px;background:var(--accent);color:white;text-decoration:none;border-radius:3px;opacity:0.4;pointer-events:none" data-i18n="analysesCompareBtn">${t('analysesCompareBtn', lang)}</a>
        </div>
        <ul style="padding:0;margin:0;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">${rows}</ul>
      </main>
      <script>
        function updateCompare() {
          var f = document.querySelector('input[name=from]:checked');
          var t2 = document.querySelector('input[name=to]:checked');
          var btn = document.getElementById('compare-btn');
          if (f && t2 && f.value !== t2.value) {
            btn.href = '/observe/health-diff?from=' + f.value + '&to=' + t2.value + '&lang=' + (document.documentElement.dataset.lang || '${DEFAULT_LANG}');
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
          } else {
            btn.removeAttribute('href');
            btn.style.opacity = '0.4';
            btn.style.pointerEvents = 'none';
          }
        }
      </script>`;
    })();
  return layout(t('skillHealthTitle', lang), body, lang, { navigation: 'observe' });
}

