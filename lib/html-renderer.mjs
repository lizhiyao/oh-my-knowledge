function e(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtNum(n, digits = 0) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: digits });
}

function fmtCost(usd) {
  return `$${Number(usd || 0).toFixed(4)}`;
}

function delta(a, b, lowerIsBetter = false) {
  if (!a || !b || a === 0) return '';
  const pct = ((b - a) / a * 100).toFixed(1);
  const better = lowerIsBetter ? b < a : b > a;
  const color = better ? '#16a34a' : b === a ? '#6b7280' : '#dc2626';
  const arrow = b > a ? '↑' : b < a ? '↓' : '→';
  return `<span style="color:${color};font-size:12px;margin-left:4px">${arrow}${Math.abs(pct)}%</span>`;
}

function barChart(items, maxVal) {
  if (!maxVal || maxVal === 0) return '';
  return items.map(({ label, value, color }) => {
    const pct = Math.max(2, (value / maxVal) * 100);
    return `<div style="margin:4px 0"><span style="display:inline-block;width:50px;font-size:12px;color:#6b7280">${e(label)}</span><div style="display:inline-block;width:${pct}%;background:${color};height:18px;border-radius:3px;vertical-align:middle"></div><span style="font-size:12px;margin-left:6px">${fmtNum(value)}</span></div>`;
  }).join('');
}

const COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899'];

function layout(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(title)}</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:24px;background:#f8fafc;color:#1e293b}
h1{margin:0 0 4px;font-size:22px}
h2{margin:24px 0 12px;font-size:18px;color:#334155}
.subtitle{color:#64748b;font-size:14px;margin:0 0 20px}
a{color:#2563eb;text-decoration:none}
a:hover{text-decoration:underline}
.cards{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;min-width:180px;flex:1}
.card-label{font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px}
.card-value{font-size:28px;font-weight:700;margin:4px 0}
.card-sub{font-size:12px;color:#94a3b8}
table{border-collapse:collapse;width:100%;font-size:14px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}
th{background:#f1f5f9;padding:10px 12px;text-align:left;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0}
td{padding:10px 12px;border-bottom:1px solid #f1f5f9}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f8fafc}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600}
.badge-ok{background:#dcfce7;color:#166534}
.badge-err{background:#fee2e2;color:#991b1b}
.badge-pass{background:#dcfce7;color:#166534}
.badge-fail{background:#fee2e2;color:#991b1b}
.preview{font-size:12px;color:#64748b;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav{margin-bottom:20px;font-size:14px}
.assertion-list{margin:4px 0;padding:0;list-style:none;font-size:12px}
.assertion-list li{margin:2px 0}
.dim-scores{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.dim-tag{font-size:11px;padding:2px 6px;border-radius:3px;background:#f1f5f9}
</style></head><body>${body}</body></html>`;
}

export function renderRunList(runs) {
  if (!runs || runs.length === 0) {
    return layout('OMK Bench', `
      <h1>OMK Bench</h1>
      <p class="subtitle">oh-my-knowledge evaluation reports</p>
      <p style="color:#94a3b8;margin-top:40px">No evaluation runs yet. Run <code>omk bench run --variants v1,v2</code> to start.</p>
    `);
  }

  const rows = runs.map((run) => {
    const m = run.meta || {};
    const variants = (m.variants || []).join(', ');
    const hasScores = Object.values(run.summary || {}).some((s) =>
      typeof s.avgCompositeScore === 'number' || typeof s.avgLlmScore === 'number'
    );
    const scoreCol = hasScores
      ? Object.entries(run.summary || {}).map(([v, s]) =>
          `${e(v)}: ${s.avgCompositeScore ?? s.avgLlmScore ?? '-'}`
        ).join('<br>')
      : '-';
    return `<tr>
      <td><a href="/run/${e(run.id)}">${e(run.id)}</a></td>
      <td>${e(variants)}</td>
      <td>${e(m.model || '-')}</td>
      <td>${m.sampleCount || 0}</td>
      <td>${scoreCol}</td>
      <td>${fmtCost(m.totalCostUSD)}</td>
      <td>${e(m.timestamp ? m.timestamp.slice(0, 19).replace('T', ' ') : '-')}</td>
    </tr>`;
  }).join('');

  return layout('OMK Bench', `
    <h1>OMK Bench</h1>
    <p class="subtitle">oh-my-knowledge evaluation reports &middot; ${runs.length} runs</p>
    <table>
      <thead><tr><th>Run ID</th><th>Variants</th><th>Model</th><th>Samples</th><th>Score</th><th>Cost</th><th>Time</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:16px;font-size:12px;color:#94a3b8">API: <a href="/api/runs">/api/runs</a></p>
  `);
}

export function renderRunDetail(report) {
  if (!report) {
    return layout('OMK Bench - Not Found', `
      <div class="nav"><a href="/">← Back to list</a></div>
      <h1>Run not found</h1>
    `);
  }

  const m = report.meta || {};
  const variants = m.variants || [];
  const summary = report.summary || {};
  const results = report.results || [];

  // Summary cards
  const cards = variants.map((v, i) => {
    const s = summary[v] || {};
    const color = COLORS[i % COLORS.length];
    const mainScore = s.avgCompositeScore ?? s.avgLlmScore ?? '-';
    return `<div class="card" style="border-top:3px solid ${color}">
      <div class="card-label">${e(v)}</div>
      <div class="card-value">${mainScore}</div>
      <div class="card-sub">composite score</div>
      <div style="margin-top:8px;font-size:13px">
        ${s.avgAssertionScore != null ? `<div>Assertions: ${s.avgAssertionScore}</div>` : ''}
        ${s.avgLlmScore != null ? `<div>LLM Judge: ${s.avgLlmScore}</div>` : ''}
        <div>Tokens: ${fmtNum(s.avgTotalTokens)}</div>
        <div>Latency: ${fmtNum(s.avgDurationMs)}ms</div>
        <div>Cost: ${fmtCost(s.totalCostUSD)}</div>
        <div>Errors: ${s.errorCount || 0}/${s.totalSamples || 0}</div>
      </div>
    </div>`;
  }).join('');

  // Comparison charts
  const maxTokens = Math.max(...variants.map((v) => summary[v]?.avgTotalTokens || 0));
  const maxDuration = Math.max(...variants.map((v) => summary[v]?.avgDurationMs || 0));

  const tokenChart = barChart(
    variants.map((v, i) => ({ label: v, value: summary[v]?.avgTotalTokens || 0, color: COLORS[i % COLORS.length] })),
    maxTokens,
  );
  const durationChart = barChart(
    variants.map((v, i) => ({ label: v, value: summary[v]?.avgDurationMs || 0, color: COLORS[i % COLORS.length] })),
    maxDuration,
  );

  // Per-sample detail table
  const headerCols = variants.map((v) =>
    `<th>${e(v)} Score</th><th>${e(v)} Tokens</th><th>${e(v)} ms</th>`
  ).join('');

  const sampleRows = results.map((r) => {
    const cols = variants.map((v, i) => {
      const d = r.variants?.[v];
      if (!d) return '<td>-</td><td>-</td><td>-</td>';

      // Score display
      const score = d.compositeScore ?? d.llmScore;
      const scoreClass = d.ok ? 'badge-ok' : 'badge-err';
      const scoreText = typeof score === 'number' ? score : (d.ok ? 'OK' : 'ERR');

      // Assertion details
      let assertionHtml = '';
      if (d.assertions?.details) {
        const items = d.assertions.details.map((a) => {
          const icon = a.passed ? '&#10003;' : '&#10007;';
          const cls = a.passed ? 'badge-pass' : 'badge-fail';
          return `<li><span class="badge ${cls}" style="font-size:10px;padding:1px 4px">${icon}</span> ${e(a.type)}: ${e(a.value)}</li>`;
        }).join('');
        assertionHtml = `<ul class="assertion-list">${items}</ul>`;
      }

      // Dimension scores
      let dimHtml = '';
      if (d.dimensions) {
        const tags = Object.entries(d.dimensions).map(([dim, info]) => {
          const s = typeof info === 'object' ? info.score : info;
          return `<span class="dim-tag">${e(dim)}: ${s}</span>`;
        }).join('');
        dimHtml = `<div class="dim-scores">${tags}</div>`;
      }

      // Reason
      const reasonHtml = d.llmReason
        ? `<br><span style="font-size:11px;color:#64748b">${e(d.llmReason.slice(0, 80))}</span>`
        : '';

      // Delta vs first variant
      const firstV = r.variants?.[variants[0]];
      const tokenDelta = i > 0 && firstV ? delta(firstV.totalTokens, d.totalTokens, true) : '';
      const msDelta = i > 0 && firstV ? delta(firstV.durationMs, d.durationMs, true) : '';

      return `<td><span class="badge ${scoreClass}">${scoreText}</span>${reasonHtml}${assertionHtml}${dimHtml}</td><td>${fmtNum(d.totalTokens)}${tokenDelta}</td><td>${fmtNum(d.durationMs)}${msDelta}</td>`;
    }).join('');
    return `<tr><td><strong>${e(r.sample_id)}</strong></td>${cols}</tr>`;
  }).join('');

  return layout(`OMK Bench - ${report.id}`, `
    <div class="nav"><a href="/">← Back to list</a></div>
    <h1>Evaluation Report</h1>
    <p class="subtitle">${e(report.id)} &middot; model: ${e(m.model)} &middot; judge: ${e(m.judgeModel || 'none')} &middot; executor: ${e(m.executor || 'claude')} &middot; cost: ${fmtCost(m.totalCostUSD)}</p>

    <h2>Variant Summary</h2>
    <div class="cards">${cards}</div>

    <h2>Token Comparison</h2>
    ${tokenChart}

    <h2>Latency Comparison</h2>
    ${durationChart}

    <h2>Per-Sample Detail</h2>
    <table>
      <thead><tr><th>Sample</th>${headerCols}</tr></thead>
      <tbody>${sampleRows}</tbody>
    </table>

    <p style="margin-top:16px;font-size:12px;color:#94a3b8">API: <a href="/api/run/${e(report.id)}">/api/run/${e(report.id)}</a></p>
  `);
}
