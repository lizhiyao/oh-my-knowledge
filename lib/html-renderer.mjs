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

function renderAnalysis(analysis) {
  if (!analysis) return '';
  const { insights, suggestions } = analysis;
  if ((!insights || insights.length === 0) && (!suggestions || suggestions.length === 0)) return '';

  const severityColors = { error: '#fee2e2', warning: '#fef3c7', info: '#dbeafe' };
  const severityTextColors = { error: '#991b1b', warning: '#92400e', info: '#1e40af' };

  const insightCards = (insights || []).map((ins) => {
    const bg = severityColors[ins.severity] || '#f1f5f9';
    const fg = severityTextColors[ins.severity] || '#334155';
    return `<div style="background:${bg};color:${fg};padding:12px 16px;border-radius:6px;margin:6px 0;font-size:14px">${e(ins.message)}</div>`;
  }).join('');

  const suggestionList = (suggestions || []).length > 0
    ? `<ul style="margin:8px 0;padding-left:20px;font-size:14px;color:#475569">${suggestions.map((s) => `<li>${e(s)}</li>`).join('')}</ul>`
    : '';

  return `
    <h2>自动分析</h2>
    ${insightCards}
    ${suggestionList}
  `;
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

  // Summary cards — organized by 4 dimensions
  const dimensionSections = [
    {
      title: '📊 Quality',
      render: (s) => {
        const mainScore = s.avgCompositeScore ?? s.avgLlmScore ?? '-';
        const range = s.minCompositeScore != null ? `<div>Range: ${s.minCompositeScore} ~ ${s.maxCompositeScore}</div>` : '';
        return `
          <div class="card-value">${mainScore}</div>
          <div class="card-sub">composite score</div>
          <div style="margin-top:8px;font-size:13px">
            ${range}
            ${s.avgAssertionScore != null ? `<div>Assertions: ${s.avgAssertionScore}</div>` : ''}
            ${s.avgLlmScore != null ? `<div>LLM Judge: ${s.avgLlmScore} (${s.minLlmScore}~${s.maxLlmScore})</div>` : ''}
          </div>`;
      },
    },
    {
      title: '💰 Cost',
      render: (s) => `
        <div class="card-value">${fmtCost(s.totalCostUSD)}</div>
        <div class="card-sub">total cost</div>
        <div style="margin-top:8px;font-size:13px">
          <div>Input: ${fmtNum(s.avgInputTokens)} tok</div>
          <div>Output: ${fmtNum(s.avgOutputTokens)} tok</div>
          <div>Total: ${fmtNum(s.avgTotalTokens)} tok/req</div>
        </div>`,
    },
    {
      title: '⚡ Efficiency',
      render: (s) => `
        <div class="card-value">${fmtNum(s.avgDurationMs)}<span style="font-size:14px">ms</span></div>
        <div class="card-sub">avg latency</div>`,
    },
    {
      title: '🛡️ Stability',
      render: (s) => {
        const rate = s.errorRate ?? 0;
        const rateColor = rate === 0 ? '#16a34a' : rate < 10 ? '#f59e0b' : '#dc2626';
        return `
          <div class="card-value" style="color:${rateColor}">${rate}%</div>
          <div class="card-sub">error rate</div>
          <div style="margin-top:8px;font-size:13px">
            <div>Success: ${s.successCount || 0}/${s.totalSamples || 0}</div>
            <div>Errors: ${s.errorCount || 0}</div>
          </div>`;
      },
    },
  ];

  const cards = dimensionSections.map((dim) => {
    const variantCards = variants.map((v, i) => {
      const s = summary[v] || {};
      const color = COLORS[i % COLORS.length];
      return `<div class="card" style="border-top:3px solid ${color}">
        <div class="card-label">${e(v)}</div>
        ${dim.render(s)}
      </div>`;
    }).join('');
    return `<h2>${dim.title}</h2><div class="cards">${variantCards}</div>`;
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

      // Feedback display
      const existingFeedback = (r.humanFeedback || []).filter((f) => f.variant === v);
      const feedbackDisplay = existingFeedback.length > 0
        ? existingFeedback.map((f) => `<div style="font-size:11px;color:#64748b;margin-top:2px">${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)} ${f.comment ? e(f.comment) : ''}</div>`).join('')
        : '';

      return `<td><span class="badge ${scoreClass}">${scoreText}</span>${reasonHtml}${assertionHtml}${dimHtml}${feedbackDisplay}</td><td>${fmtNum(d.totalTokens)}${tokenDelta}</td><td>${fmtNum(d.durationMs)}${msDelta}</td>`;
    }).join('');

    // Feedback form row
    const feedbackCols = variants.map((v) => {
      const formId = `fb-${r.sample_id}-${v}`.replace(/[^a-zA-Z0-9-]/g, '_');
      return `<td colspan="3">
        <div style="display:flex;align-items:center;gap:6px;font-size:12px" id="${formId}">
          <span class="stars" style="cursor:pointer;font-size:16px" data-rating="0"
            onclick="(function(el,evt){var t=evt.target;if(t.dataset.star){var r=+t.dataset.star;el.dataset.rating=r;var s=el.children;for(var i=0;i<5;i++){s[i].style.color=i<r?'#f59e0b':'#cbd5e1'}}})(this,event)">
            <span data-star="1" style="color:#cbd5e1">&#9733;</span>
            <span data-star="2" style="color:#cbd5e1">&#9733;</span>
            <span data-star="3" style="color:#cbd5e1">&#9733;</span>
            <span data-star="4" style="color:#cbd5e1">&#9733;</span>
            <span data-star="5" style="color:#cbd5e1">&#9733;</span>
          </span>
          <input type="text" placeholder="备注" style="border:1px solid #e2e8f0;border-radius:4px;padding:2px 6px;font-size:12px;width:120px" />
          <button onclick="submitFeedback('${e(report.id)}','${e(r.sample_id)}','${e(v)}',this)" style="padding:2px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#f8fafc;cursor:pointer;font-size:12px">提交</button>
        </div>
      </td>`;
    }).join('');

    return `<tr><td><strong>${e(r.sample_id)}</strong></td>${cols}</tr>
    <tr style="background:#fafafa"><td style="font-size:11px;color:#94a3b8">反馈</td>${feedbackCols}</tr>`;
  }).join('');

  return layout(`OMK Bench - ${report.id}`, `
    <div class="nav"><a href="/">← Back to list</a></div>
    <h1>Evaluation Report</h1>
    <p class="subtitle">${e(report.id)} &middot; model: ${e(m.model)} &middot; judge: ${e(m.judgeModel || 'none')} &middot; executor: ${e(m.executor || 'claude')} &middot; cost: ${fmtCost(m.totalCostUSD)}${m.blind ? ' &middot; <span class="badge badge-ok">BLIND</span>' : ''}</p>
    ${m.blind ? `
    <div style="margin:12px 0">
      <button onclick="document.getElementById('blind-reveal').style.display=document.getElementById('blind-reveal').style.display==='none'?'block':'none'" style="padding:6px 14px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px">显示变体对应关系</button>
      <div id="blind-reveal" style="display:none;margin-top:8px;padding:12px;background:#f1f5f9;border-radius:6px;font-size:14px">
        ${Object.entries(m.blindMap || {}).map(([label, real]) => `<div><strong>Variant ${e(label)}</strong> → ${e(real)}</div>`).join('')}
      </div>
    </div>` : ''}

    ${cards}

    <h2>Token Comparison</h2>
    ${tokenChart}

    <h2>Latency Comparison</h2>
    ${durationChart}

    ${renderAnalysis(report.analysis)}

    <h2>Per-Sample Detail</h2>
    <table>
      <thead><tr><th>Sample</th>${headerCols}</tr></thead>
      <tbody>${sampleRows}</tbody>
    </table>

    <p style="margin-top:16px;font-size:12px;color:#94a3b8">API: <a href="/api/run/${e(report.id)}">/api/run/${e(report.id)}</a></p>
    <script>
    function submitFeedback(runId, sampleId, variant, btn) {
      var container = btn.parentElement;
      var starsEl = container.querySelector('.stars');
      var rating = parseInt(starsEl.dataset.rating) || 0;
      if (rating === 0) { alert('请先选择评分'); return; }
      var comment = container.querySelector('input').value || '';
      fetch('/api/run/' + encodeURIComponent(runId) + '/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_id: sampleId, variant: variant, rating: rating, comment: comment })
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.ok) { btn.textContent = '已提交'; btn.disabled = true; btn.style.color = '#16a34a'; }
        else { alert('提交失败: ' + (d.error || 'unknown')); }
      }).catch(function(e) { alert('提交失败: ' + e.message); });
    }
    </script>
  `);
}
