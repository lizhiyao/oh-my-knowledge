import { e, fmtCost, fmtLocalTime, t } from './layout.js';
import type { Lang, Report, ReportMeta, VariantSummary } from '../types.js';

interface ChartPoint {
  timestamp: string;
  score: number | null;
  artifactHash: string | null;
}

/**
 * Render SVG line chart for score trends.
 */
function renderChart(points: ChartPoint[]): string {
  if (points.length < 2) return '';

  const W = 720, H = 280, PAD = { top: 20, right: 20, bottom: 40, left: 45 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const scores = points.map((p) => p.score).filter((s): s is number => s != null);
  const yMin = Math.max(0, Math.floor(Math.min(...scores) - 0.5));
  const yMax = Math.min(5, Math.ceil(Math.max(...scores) + 0.5));
  const yRange = yMax - yMin || 1;

  const toX = (i: number): number => PAD.left + (i / (points.length - 1)) * plotW;
  const toY = (v: number): number => PAD.top + plotH - ((v - yMin) / yRange) * plotH;

  // Grid lines
  const gridLines: string[] = [];
  for (let y = yMin; y <= yMax; y++) {
    const py = toY(y);
    gridLines.push(`<line x1="${PAD.left}" y1="${py}" x2="${W - PAD.right}" y2="${py}" stroke="var(--border)" stroke-dasharray="4,4"/>`);
    gridLines.push(`<text x="${PAD.left - 8}" y="${py + 4}" text-anchor="end" fill="var(--text-muted)" font-size="11">${y}</text>`);
  }

  // Data line
  const linePoints = points.map((p, i) => `${toX(i)},${toY(p.score ?? 0)}`).join(' ');

  // Dots + artifactHash change markers
  const dots: string[] = [];
  let prevHash: string | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const cx = toX(i);
    const cy = toY(p.score ?? 0);
    const hashChanged = prevHash && p.artifactHash && p.artifactHash !== prevHash;

    // Vertical line on skill hash change
    if (hashChanged) {
      dots.push(`<line x1="${cx}" y1="${PAD.top}" x2="${cx}" y2="${PAD.top + plotH}" stroke="var(--yellow)" stroke-dasharray="4,4" stroke-width="1.5"/>`);
    }

    dots.push(`<circle cx="${cx}" cy="${cy}" r="4" fill="${hashChanged ? 'var(--yellow)' : 'var(--chart-1)'}" stroke="var(--bg-primary)" stroke-width="2">
      <title>${fmtLocalTime(p.timestamp)} — ${p.score}${hashChanged ? ' (skill changed)' : ''}</title>
    </circle>`);

    // X-axis label (show for first, last, and hash changes)
    if (i === 0 || i === points.length - 1 || hashChanged) {
      const label = new Date(p.timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
      dots.push(`<text x="${cx}" y="${H - 8}" text-anchor="middle" fill="var(--text-muted)" font-size="10">${label}</text>`);
    }

    prevHash = p.artifactHash;
  }

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:auto;display:block;margin:16px 0">
    ${gridLines.join('')}
    <polyline points="${linePoints}" fill="none" stroke="var(--chart-1)" stroke-width="2" stroke-linejoin="round"/>
    ${dots.join('')}
  </svg>`;
}

/**
 * Render the trends history table.
 */
function renderTable(variantName: string, runs: Report[], lang: Lang): string {
  const rows = runs.map((r) => {
    const s: Partial<VariantSummary> = r.summary?.[variantName] || {};
    const m: ReportMeta = r.meta;
    const hash: string = m.artifactHashes?.[variantName] || '-';
    const git = m.gitInfo;
    const commitCell = git ? `${e(git.commitShort)}${git.dirty ? '*' : ''}` : '-';
    const branchCell = git ? e(git.branch) : '-';

    const gapReport = r.analysis?.gapReports?.[variantName];
    let gapCell: string;
    if (gapReport && gapReport.sampleCount > 0) {
      const pct = Math.round(gapReport.gapRate * 100);
      const color = pct <= 10 ? 'var(--green)' : pct <= 30 ? 'var(--yellow)' : 'var(--red)';
      gapCell = `<span style="color:${color}">${pct}%</span>`;
    } else {
      gapCell = '<span style="color:var(--text-muted)">-</span>';
    }

    return `<tr>
      <td><a href="/run/${e(r.id)}">${fmtLocalTime(m.timestamp)}</a></td>
      <td>${s.avgCompositeScore ?? '-'}</td>
      <td>${gapCell}</td>
      <td>${s.avgFullNumTurns ?? s.avgNumTurns ?? '-'}</td>
      <td>${fmtCost(s.avgCostPerSample)}</td>
      <td><code style="font-size:11px">${e(hash.slice(0, 8))}</code></td>
      <td>${commitCell}</td>
      <td>${branchCell}</td>
    </tr>`;
  }).join('');

  const gapHeader = lang === 'zh' ? '缺口率' : 'Gap rate';

  return `
    <div class="table-wrap">
    <table>
      <thead><tr>
        <th>${t('time', lang)}</th>
        <th>${t('score', lang)}</th>
        <th>${gapHeader}</th>
        <th>${t('avgTurns', lang)}</th>
        <th>${t('cost', lang)}</th>
        <th>Artifact Hash</th>
        <th>Commit</th>
        <th>Branch</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}

/**
 * Render full trends page for a variant.
 */
export function renderTrendsBody(variantName: string, runs: Report[], lang: Lang = 'zh'): string {
  // Reverse to ASC for chart
  const sorted = [...runs].reverse();

  const points: ChartPoint[] = sorted.map((r) => ({
    timestamp: r.meta?.timestamp,
    score: r.summary?.[variantName]?.avgCompositeScore ?? null,
    artifactHash: r.meta?.artifactHashes?.[variantName] || null,
  })).filter((p): p is ChartPoint & { score: number } => p.score != null);

  const chart = renderChart(points);
  const table = renderTable(variantName, runs, lang);
  const title = lang === 'zh' ? `${e(variantName)} 评测趋势` : `${e(variantName)} Trends`;
  const countLabel = lang === 'zh' ? `共 ${runs.length} 次评测` : `${runs.length} evaluations`;

  return `
    <nav class="nav"><a href="/" data-i18n="backToList">${t('backToList', lang)}</a></nav>
    <h1>${title}</h1>
    <p class="subtitle">${countLabel}</p>
    ${chart}
    ${table}
  `;
}
