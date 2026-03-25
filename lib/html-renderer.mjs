const I18N = {
  zh: {
    // Run list page
    title: 'OMK Bench',
    subtitle: '知识载体评测报告',
    noRuns: '暂无评测记录。运行 <code>omk bench run --variants v1,v2</code> 开始。',
    runId: '运行 ID',
    variants: '变体',
    model: '模型',
    samples: '样本数',
    score: '分数',
    cost: '成本',
    time: '时间',
    deleteBtnText: '删除',
    deleteConfirm: '确定删除报告',
    deleteFail: '删除失败',
    // Run detail page
    reportTitle: '评测报告',
    backToList: '← 返回列表',
    judge: '评委',
    executor: '执行器',
    blindLabel: '盲测',
    revealBlind: '显示变体对应关系',
    // Four dimensions
    dimQuality: '📊 质量',
    dimQualityDesc: '基于断言检查和 LLM 评委的综合评分（1-5 分）',
    dimCost: '💰 成本',
    dimCostDesc: '基于 Token 消耗量和模型定价计算的 API 调用费用',
    dimEfficiency: '⚡ 效率',
    dimEfficiencyDesc: 'Skill 从发送请求到模型返回完整响应的端到端耗时',
    dimStability: '🛡️ 稳定性',
    dimStabilityDesc: '模型调用的成功率，失败包括超时、API 错误等',
    compositeScore: '综合分数',
    scoreRange: '分数范围',
    assertions: '断言',
    assertionsDesc: '规则检查得分：通过的断言权重占比映射到 1-5 分',
    llmJudge: 'LLM 评委',
    llmJudgeDesc: '由评委模型按 rubric 标准打出的 1-5 分',
    totalCost: '总成本',
    inputTokens: '输入',
    outputTokens: '输出',
    totalTokens: '总计',
    tokPerReq: 'tok/次',
    avgLatency: '平均延迟',
    successRate: '成功率',
    success: '成功',
    errors: '失败',
    // Charts
    tokenComparison: 'Token 对比',
    latencyComparison: '延迟对比',
    // Analysis
    autoAnalysis: '自动分析',
    // Per-sample detail
    perSampleDetail: '逐样本详情',
    sample: '样本',
    scoreCol: '分数',
    tokensCol: 'Tokens',
    msCol: '延迟(ms)',
    // Feedback
    feedback: '反馈',
    feedbackPlaceholder: '备注',
    feedbackSubmit: '提交',
    feedbackSubmitted: '已提交',
    feedbackSelectRating: '请先选择评分',
    feedbackFail: '提交失败',
    // Language toggle
    switchLang: 'EN',
  },
  en: {
    title: 'OMK Bench',
    subtitle: 'Knowledge Artifact Evaluation Reports',
    noRuns: 'No evaluation runs yet. Run <code>omk bench run --variants v1,v2</code> to start.',
    runId: 'Run ID',
    variants: 'Variants',
    model: 'Model',
    samples: 'Samples',
    score: 'Score',
    cost: 'Cost',
    time: 'Time',
    deleteBtnText: 'Delete',
    deleteConfirm: 'Delete report',
    deleteFail: 'Delete failed',
    reportTitle: 'Evaluation Report',
    backToList: '← Back to list',
    judge: 'judge',
    executor: 'executor',
    blindLabel: 'BLIND',
    revealBlind: 'Reveal variant mapping',
    dimQuality: '📊 Quality',
    dimQualityDesc: 'Composite score (1-5) from assertion checks and LLM judge',
    dimCost: '💰 Cost',
    dimCostDesc: 'API cost calculated from token usage and model pricing',
    dimEfficiency: '⚡ Efficiency',
    dimEfficiencyDesc: 'End-to-end latency from sending request to receiving full response',
    dimStability: '🛡️ Stability',
    dimStabilityDesc: 'Success rate of model calls. Failures include timeouts, API errors, etc.',
    compositeScore: 'composite score',
    scoreRange: 'Range',
    assertions: 'Assertions',
    assertionsDesc: 'Rule-based score: passed assertion weight ratio mapped to 1-5',
    llmJudge: 'LLM Judge',
    llmJudgeDesc: 'Score (1-5) from judge model based on rubric criteria',
    totalCost: 'total cost',
    inputTokens: 'Input',
    outputTokens: 'Output',
    totalTokens: 'Total',
    tokPerReq: 'tok/req',
    avgLatency: 'avg latency',
    successRate: 'success rate',
    success: 'Success',
    errors: 'Errors',
    tokenComparison: 'Token Comparison',
    latencyComparison: 'Latency Comparison',
    autoAnalysis: 'Auto Analysis',
    perSampleDetail: 'Per-Sample Detail',
    sample: 'Sample',
    scoreCol: 'Score',
    tokensCol: 'Tokens',
    msCol: 'ms',
    feedback: 'Feedback',
    feedbackPlaceholder: 'Comment',
    feedbackSubmit: 'Submit',
    feedbackSubmitted: 'Submitted',
    feedbackSelectRating: 'Please select a rating first',
    feedbackFail: 'Submit failed',
    switchLang: '中文',
  },
};

// Default language
const DEFAULT_LANG = 'zh';

function t(key, lang = DEFAULT_LANG) {
  return I18N[lang]?.[key] || I18N.en[key] || key;
}

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

function fmtLocalTime(isoStr) {
  const d = new Date(isoStr);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

function langToggleScript() {
  return `
  <script>
  var I18N = ${JSON.stringify(I18N)};
  function switchLang() {
    var cur = document.documentElement.dataset.lang || '${DEFAULT_LANG}';
    var next = cur === 'zh' ? 'en' : 'zh';
    document.documentElement.dataset.lang = next;
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      var key = el.dataset.i18n;
      if (I18N[next][key]) {
        if (el.tagName === 'INPUT') { el.placeholder = I18N[next][key]; }
        else { el.innerHTML = I18N[next][key]; }
      }
    });
    document.getElementById('lang-toggle').textContent = I18N[next].switchLang;
  }
  </script>`;
}

function langToggleButton(lang) {
  return `<button id="lang-toggle" onclick="switchLang()" style="position:fixed;top:16px;right:16px;padding:6px 14px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;z-index:100">${t('switchLang', lang)}</button>`;
}

function layout(title, body, lang = DEFAULT_LANG) {
  return `<!doctype html><html data-lang="${lang}"><head><meta charset="utf-8"><title>${e(title)}</title>
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
.dim-desc{font-size:13px;color:#94a3b8;font-weight:400;margin-left:8px}
</style></head><body>${langToggleButton(lang)}${body}${langToggleScript()}</body></html>`;
}

function renderAnalysis(analysis, lang) {
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
    <h2 data-i18n="autoAnalysis">${t('autoAnalysis', lang)}</h2>
    ${insightCards}
    ${suggestionList}
  `;
}

export function renderRunList(runs, lang = DEFAULT_LANG) {
  if (!runs || runs.length === 0) {
    return layout(t('title', lang), `
      <h1>${t('title', lang)}</h1>
      <p class="subtitle">${t('subtitle', lang)}</p>
      <p style="color:#94a3b8;margin-top:40px">${t('noRuns', lang)}</p>
    `, lang);
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
      <td>${e(m.timestamp ? fmtLocalTime(m.timestamp) : '-')}</td>
      <td><button onclick="deleteRun('${e(run.id)}',this)" style="padding:4px 10px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;color:#dc2626" data-i18n="deleteBtnText">${t('deleteBtnText', lang)}</button></td>
    </tr>`;
  }).join('');

  return layout(t('title', lang), `
    <h1>${t('title', lang)}</h1>
    <p class="subtitle" data-i18n="subtitle">${t('subtitle', lang)} &middot; ${runs.length} runs</p>
    <table>
      <thead><tr>
        <th data-i18n="runId">${t('runId', lang)}</th>
        <th data-i18n="variants">${t('variants', lang)}</th>
        <th data-i18n="model">${t('model', lang)}</th>
        <th data-i18n="samples">${t('samples', lang)}</th>
        <th data-i18n="score">${t('score', lang)}</th>
        <th data-i18n="cost">${t('cost', lang)}</th>
        <th data-i18n="time">${t('time', lang)}</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:16px;font-size:12px;color:#94a3b8">API: <a href="/api/runs">/api/runs</a></p>
    <script>
    function deleteRun(id, btn) {
      var lang = document.documentElement.dataset.lang || '${DEFAULT_LANG}';
      if (!confirm(I18N[lang].deleteConfirm + ' ' + id + ' ?')) return;
      fetch('/api/run/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.ok) { btn.closest('tr').remove(); }
          else { alert(I18N[lang].deleteFail + ': ' + (d.error || 'unknown')); }
        })
        .catch(function(err) { alert(I18N[lang].deleteFail + ': ' + err.message); });
    }
    </script>
  `, lang);
}

export function renderRunDetail(report, lang = DEFAULT_LANG) {
  if (!report) {
    return layout('OMK Bench', `
      <div class="nav"><a href="/">${t('backToList', lang)}</a></div>
      <h1>Run not found</h1>
    `, lang);
  }

  const m = report.meta || {};
  const variants = m.variants || [];
  const summary = report.summary || {};
  const results = report.results || {};

  // Summary cards — organized by 4 dimensions
  const dimensionSections = [
    {
      titleKey: 'dimQuality',
      descKey: 'dimQualityDesc',
      render: (s) => {
        const mainScore = s.avgCompositeScore ?? s.avgLlmScore ?? '-';
        const range = s.minCompositeScore != null
          ? `<div><span data-i18n="scoreRange">${t('scoreRange', lang)}</span>: ${s.minCompositeScore} ~ ${s.maxCompositeScore}</div>`
          : '';
        return `
          <div class="card-value">${mainScore}</div>
          <div class="card-sub" data-i18n="compositeScore">${t('compositeScore', lang)}</div>
          <div style="margin-top:8px;font-size:13px">
            ${range}
            ${s.avgAssertionScore != null ? `<div title="${t('assertionsDesc', lang)}"><span data-i18n="assertions">${t('assertions', lang)}</span>: ${s.avgAssertionScore}</div>` : ''}
            ${s.avgLlmScore != null ? `<div title="${t('llmJudgeDesc', lang)}"><span data-i18n="llmJudge">${t('llmJudge', lang)}</span>: ${s.avgLlmScore} (${s.minLlmScore}~${s.maxLlmScore})</div>` : ''}
          </div>`;
      },
    },
    {
      titleKey: 'dimCost',
      descKey: 'dimCostDesc',
      render: (s) => `
        <div class="card-value">${fmtCost(s.totalCostUSD)}</div>
        <div class="card-sub" data-i18n="totalCost">${t('totalCost', lang)}</div>
        <div style="margin-top:8px;font-size:13px">
          <div><span data-i18n="inputTokens">${t('inputTokens', lang)}</span>: ${fmtNum(s.avgInputTokens)} tok</div>
          <div><span data-i18n="outputTokens">${t('outputTokens', lang)}</span>: ${fmtNum(s.avgOutputTokens)} tok</div>
          <div><span data-i18n="totalTokens">${t('totalTokens', lang)}</span>: ${fmtNum(s.avgTotalTokens)} ${t('tokPerReq', lang)}</div>
        </div>`,
    },
    {
      titleKey: 'dimEfficiency',
      descKey: 'dimEfficiencyDesc',
      render: (s) => `
        <div class="card-value">${fmtNum(s.avgDurationMs)}<span style="font-size:14px">ms</span></div>
        <div class="card-sub" data-i18n="avgLatency">${t('avgLatency', lang)}</div>`,
    },
    {
      titleKey: 'dimStability',
      descKey: 'dimStabilityDesc',
      render: (s) => {
        const total = s.totalSamples || 0;
        const successCount = s.successCount || 0;
        const successRate = total > 0 ? Number((successCount / total * 100).toFixed(1)) : 0;
        const rateColor = successRate === 100 ? '#16a34a' : successRate >= 90 ? '#f59e0b' : '#dc2626';
        return `
          <div class="card-value" style="color:${rateColor}">${successRate}%</div>
          <div class="card-sub" data-i18n="successRate">${t('successRate', lang)}</div>
          <div style="margin-top:8px;font-size:13px">
            <div><span data-i18n="success">${t('success', lang)}</span>: ${successCount}/${total}</div>
            ${s.errorCount > 0 ? `<div><span data-i18n="errors">${t('errors', lang)}</span>: ${s.errorCount}</div>` : ''}
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
    return `<h2 data-i18n="${dim.titleKey}">${t(dim.titleKey, lang)}</h2><span class="dim-desc" data-i18n="${dim.descKey}">${t(dim.descKey, lang)}</span><div class="cards">${variantCards}</div>`;
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
    `<th>${e(v)} <span data-i18n="scoreCol">${t('scoreCol', lang)}</span></th><th>${e(v)} <span data-i18n="tokensCol">${t('tokensCol', lang)}</span></th><th>${e(v)} <span data-i18n="msCol">${t('msCol', lang)}</span></th>`
  ).join('');

  const sampleRows = results.map((r) => {
    const cols = variants.map((v, i) => {
      const d = r.variants?.[v];
      if (!d) return '<td>-</td><td>-</td><td>-</td>';

      const score = d.compositeScore ?? d.llmScore;
      const scoreClass = d.ok ? 'badge-ok' : 'badge-err';
      const scoreText = typeof score === 'number' ? score : (d.ok ? 'OK' : 'ERR');

      let assertionHtml = '';
      if (d.assertions?.details) {
        const items = d.assertions.details.map((a) => {
          const icon = a.passed ? '&#10003;' : '&#10007;';
          const cls = a.passed ? 'badge-pass' : 'badge-fail';
          return `<li><span class="badge ${cls}" style="font-size:10px;padding:1px 4px">${icon}</span> ${e(a.type)}: ${e(a.value)}</li>`;
        }).join('');
        assertionHtml = `<ul class="assertion-list">${items}</ul>`;
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
        ? `<br><span style="font-size:11px;color:#64748b">${e(d.llmReason.slice(0, 80))}</span>`
        : '';

      const firstV = r.variants?.[variants[0]];
      const tokenDelta = i > 0 && firstV ? delta(firstV.totalTokens, d.totalTokens, true) : '';
      const msDelta = i > 0 && firstV ? delta(firstV.durationMs, d.durationMs, true) : '';

      const existingFeedback = (r.humanFeedback || []).filter((f) => f.variant === v);
      const feedbackDisplay = existingFeedback.length > 0
        ? existingFeedback.map((f) => `<div style="font-size:11px;color:#64748b;margin-top:2px">${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)} ${f.comment ? e(f.comment) : ''}</div>`).join('')
        : '';

      return `<td><span class="badge ${scoreClass}">${scoreText}</span>${reasonHtml}${assertionHtml}${dimHtml}${feedbackDisplay}</td><td>${fmtNum(d.totalTokens)}${tokenDelta}</td><td>${fmtNum(d.durationMs)}${msDelta}</td>`;
    }).join('');

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
          <input type="text" placeholder="${t('feedbackPlaceholder', lang)}" data-i18n="feedbackPlaceholder" style="border:1px solid #e2e8f0;border-radius:4px;padding:2px 6px;font-size:12px;width:120px" />
          <button onclick="submitFeedback('${e(report.id)}','${e(r.sample_id)}','${e(v)}',this)" style="padding:2px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#f8fafc;cursor:pointer;font-size:12px" data-i18n="feedbackSubmit">${t('feedbackSubmit', lang)}</button>
        </div>
      </td>`;
    }).join('');

    return `<tr><td><strong>${e(r.sample_id)}</strong></td>${cols}</tr>
    <tr style="background:#fafafa"><td style="font-size:11px;color:#94a3b8" data-i18n="feedback">${t('feedback', lang)}</td>${feedbackCols}</tr>`;
  }).join('');

  return layout(`OMK Bench - ${report.id}`, `
    <div class="nav"><a href="/" data-i18n="backToList">${t('backToList', lang)}</a></div>
    <h1 data-i18n="reportTitle">${t('reportTitle', lang)}</h1>
    <p class="subtitle">${e(report.id)} &middot; ${t('model', lang)}: ${e(m.model)} &middot; ${t('judge', lang)}: ${e(m.judgeModel || 'none')} &middot; ${t('executor', lang)}: ${e(m.executor || 'claude')} &middot; ${t('cost', lang)}: ${fmtCost(m.totalCostUSD)}${m.blind ? ` &middot; <span class="badge badge-ok" data-i18n="blindLabel">${t('blindLabel', lang)}</span>` : ''}</p>
    ${m.blind ? `
    <div style="margin:12px 0">
      <button onclick="document.getElementById('blind-reveal').style.display=document.getElementById('blind-reveal').style.display==='none'?'block':'none'" style="padding:6px 14px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px" data-i18n="revealBlind">${t('revealBlind', lang)}</button>
      <div id="blind-reveal" style="display:none;margin-top:8px;padding:12px;background:#f1f5f9;border-radius:6px;font-size:14px">
        ${Object.entries(m.blindMap || {}).map(([label, real]) => `<div><strong>Variant ${e(label)}</strong> → ${e(real)}</div>`).join('')}
      </div>
    </div>` : ''}

    ${cards}

    <h2 data-i18n="tokenComparison">${t('tokenComparison', lang)}</h2>
    ${tokenChart}

    <h2 data-i18n="latencyComparison">${t('latencyComparison', lang)}</h2>
    ${durationChart}

    ${renderAnalysis(report.analysis, lang)}

    <h2 data-i18n="perSampleDetail">${t('perSampleDetail', lang)}</h2>
    <table>
      <thead><tr><th data-i18n="sample">${t('sample', lang)}</th>${headerCols}</tr></thead>
      <tbody>${sampleRows}</tbody>
    </table>

    <p style="margin-top:16px;font-size:12px;color:#94a3b8">API: <a href="/api/run/${e(report.id)}">/api/run/${e(report.id)}</a></p>
    <script>
    function submitFeedback(runId, sampleId, variant, btn) {
      var lang = document.documentElement.dataset.lang || '${DEFAULT_LANG}';
      var container = btn.parentElement;
      var starsEl = container.querySelector('.stars');
      var rating = parseInt(starsEl.dataset.rating) || 0;
      if (rating === 0) { alert(I18N[lang].feedbackSelectRating); return; }
      var comment = container.querySelector('input').value || '';
      fetch('/api/run/' + encodeURIComponent(runId) + '/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_id: sampleId, variant: variant, rating: rating, comment: comment })
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.ok) { btn.textContent = I18N[lang].feedbackSubmitted; btn.disabled = true; btn.style.color = '#16a34a'; }
        else { alert(I18N[lang].feedbackFail + ': ' + (d.error || 'unknown')); }
      }).catch(function(err) { alert(I18N[lang].feedbackFail + ': ' + err.message); });
    }
    </script>
  `, lang);
}
