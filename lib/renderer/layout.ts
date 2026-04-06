import type { Lang } from '../types.js';

export function e(text: unknown): string {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function fmtNum(n: number | undefined | null, digits: number = 0): string {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function fmtDuration(ms: number | undefined | null): string {
  const v = Number(ms || 0);
  if (v < 1000) return `${v}ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)}s`;
  const min = Math.floor(v / 60000);
  const sec = Math.round((v % 60000) / 1000);
  return sec > 0 ? `${min}m${sec}s` : `${min}m`;
}

export function fmtCost(usd: number | undefined | null): string {
  return `$${Number(usd || 0).toFixed(4)}`;
}

export function fmtLocalTime(isoStr: string): string {
  const d = new Date(isoStr);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function delta(a: number | undefined | null, b: number | undefined | null, lowerIsBetter: boolean = false): string {
  if (!a || !b || a === 0) return '';
  const pct = ((b - a) / a * 100).toFixed(1);
  const better = lowerIsBetter ? b < a : b > a;
  const color = better ? 'var(--green)' : b === a ? 'var(--text-muted)' : 'var(--red)';
  const arrow = b > a ? '↑' : b < a ? '↓' : '→';
  return `<span style="color:${color};font-size:11px;margin-left:4px">${arrow}${Math.abs(Number(pct))}%</span>`;
}

export const COLORS: string[] = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];

export const I18N: Record<Lang, Record<string, string>> = {
  zh: {
    title: '评测报告',
    subtitle: '知识载体评测',
    noRuns: '暂无评测记录。运行 <code>omk bench run --variants v1,v2</code> 开始。',
    runId: '报告名称', variants: '实验分组', model: '模型', samples: '样本数',
    score: '分数', cost: '成本', time: '时间',
    deleteBtnText: '删除', deleteConfirm: '确定删除报告', deleteFail: '删除失败',
    reportTitle: '评测报告', backToList: '← 返回列表',
    judge: '评委', executor: '执行器', blindLabel: '盲测', revealBlind: '显示变体对应关系',
    dimQuality: '📊 质量', dimQualityDesc: '基于断言检查和 LLM 评委的综合评分（1-5 分）',
    dimCost: '💰 成本', dimCostDesc: '基于 Token 消耗量和模型定价计算的 API 调用费用',
    dimEfficiency: '⚡ 效率', dimEfficiencyDesc: 'Skill 从发送请求到模型返回完整响应的端到端耗时',
    dimStability: '🛡️ 稳定性', dimStabilityDesc: '模型调用的成功率，失败包括超时、API 错误等',
    compositeScore: '综合分数', scoreRange: '分数范围',
    assertions: '断言', assertionsDesc: '规则检查得分：通过的断言权重占比映射到 1-5 分',
    llmJudge: 'LLM 评委', llmJudgeDesc: '由评委模型按 rubric 标准打出的 1-5 分',
    totalCost: '总成本', inputTokens: '输入', outputTokens: '输出',
    totalTokens: '总计', tokPerReq: 'tokens/次', avgLatency: '平均延迟',
    successRate: '成功率', success: '成功', errors: '失败',
    tokenComparison: 'Tokens 对比', latencyComparison: '延迟对比',
    avgTurns: '平均轮次', turnsPerReq: '轮/次', minScore: '最低',
    cvDesc: '变异系数（CV）= 标准差 ÷ 平均分，衡量分数波动程度。CV 越低越稳定，0% 表示所有样本得分一致',
    autoAnalysis: '自动分析',
    perSampleDetail: '逐样本详情', sample: '样本',
    scoreCol: '分数', tokensCol: 'Tokens', msCol: '延迟(ms)',
    eachOverview: '总览', eachSkill: 'Skill', eachBaseline: '无 Skill', eachWithSkill: '有 Skill', eachImprovement: '提升',
    eachSkills: '个 Skill', eachSamples: '个样本',
    agentLabel: 'Agent 评测',
    agentOverview: 'Agent 执行概览',
    agentToolCalls: '工具调用',
    agentToolSuccess: '工具成功率',
    agentToolDist: '工具分布',
    agentAvgTurns: '平均轮次',
    agentAvgTools: '平均工具调用',
    traceToggle: '执行轨迹',
    traceAssistant: '助手',
    traceTool: '工具',
    traceFullOutput: '查看完整输出',
    traceExecMs: '执行',
    traceGradeMs: '评分',
    traceTotalMs: '总计',
    variantConfig: '实验配置',
    variantConfigDesc: '先看清楚在比较什么，再看分数。',
    variantType: '实验类型',
    variantArtifactKind: '知识类型',
    variantArtifactSource: '知识来源',
    variantExecutionStrategy: '执行策略',
    variantRuntimeContext: '运行环境',
    switchLang: 'EN',
  },
  en: {
    title: 'Evaluation Reports',
    subtitle: 'Knowledge Artifact Evaluation',
    noRuns: 'No evaluation runs yet. Run <code>omk bench run --variants v1,v2</code> to start.',
    runId: 'Report', variants: 'Variant', model: 'Model', samples: 'Samples',
    score: 'Score', cost: 'Cost', time: 'Time',
    deleteBtnText: 'Delete', deleteConfirm: 'Delete report', deleteFail: 'Delete failed',
    reportTitle: 'Evaluation Report', backToList: '← Back to list',
    judge: 'judge', executor: 'executor', blindLabel: 'BLIND', revealBlind: 'Reveal variant mapping',
    dimQuality: '📊 Quality', dimQualityDesc: 'Composite score (1-5) from assertion checks and LLM judge',
    dimCost: '💰 Cost', dimCostDesc: 'API cost calculated from token usage and model pricing',
    dimEfficiency: '⚡ Efficiency', dimEfficiencyDesc: 'End-to-end latency from sending request to receiving full response',
    dimStability: '🛡️ Stability', dimStabilityDesc: 'Success rate of model calls. Failures include timeouts, API errors, etc.',
    compositeScore: 'composite score', scoreRange: 'Range',
    assertions: 'Assertions', assertionsDesc: 'Rule-based score: passed assertion weight ratio mapped to 1-5',
    llmJudge: 'LLM Judge', llmJudgeDesc: 'Score (1-5) from judge model based on rubric criteria',
    totalCost: 'total cost', inputTokens: 'Input', outputTokens: 'Output',
    totalTokens: 'Total', tokPerReq: 'tokens/req', avgLatency: 'avg latency',
    successRate: 'success rate', success: 'Success', errors: 'Errors',
    tokenComparison: 'Tokens Comparison', latencyComparison: 'Latency Comparison',
    avgTurns: 'Avg Turns', turnsPerReq: 'turns/req', minScore: 'Min',
    cvDesc: 'Coefficient of Variation (CV) = StdDev ÷ Mean. Measures score volatility. Lower is more stable, 0% means all samples scored identically',
    autoAnalysis: 'Auto Analysis',
    perSampleDetail: 'Per-Sample Detail', sample: 'Sample',
    scoreCol: 'Score', tokensCol: 'Tokens', msCol: 'ms',
    eachOverview: 'Overview', eachSkill: 'Skill', eachBaseline: 'Baseline', eachWithSkill: 'With Skill', eachImprovement: 'Improvement',
    eachSkills: ' skills', eachSamples: ' samples',
    agentLabel: 'Agent Eval',
    agentOverview: 'Agent Execution Overview',
    agentToolCalls: 'Tool Calls',
    agentToolSuccess: 'Tool Success Rate',
    agentToolDist: 'Tool Distribution',
    agentAvgTurns: 'Avg Turns',
    agentAvgTools: 'Avg Tool Calls',
    traceToggle: 'Execution Trace',
    traceAssistant: 'Assistant',
    traceTool: 'Tool',
    traceFullOutput: 'Full Output',
    traceExecMs: 'Exec',
    traceGradeMs: 'Grade',
    traceTotalMs: 'Total',
    variantConfig: 'Experiment Setup',
    variantConfigDesc: 'Confirm what is being compared before reading the score. This table explains the artifact and runtime context behind each variant.',
    variantType: 'Role',
    variantArtifactKind: 'Artifact Kind',
    variantArtifactSource: 'Source',
    variantExecutionStrategy: 'Execution Strategy',
    variantRuntimeContext: 'Runtime Context',
    switchLang: '中文',
  },
};

export const DEFAULT_LANG: Lang = 'zh';

export function t(key: string, lang: Lang = DEFAULT_LANG): string {
  return I18N[lang]?.[key] || I18N.en[key] || key;
}

function langToggleScript(): string {
  return `
  <script>
  var I18N = ${JSON.stringify(I18N)};
  function switchLang() {
    var cur = document.documentElement.dataset.lang || '${DEFAULT_LANG}';
    var next = cur === 'zh' ? 'en' : 'zh';
    document.documentElement.dataset.lang = next;
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
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

function langToggleButton(lang: Lang): string {
  return `<button id="lang-toggle" onclick="switchLang()" class="lang-toggle">${t('switchLang', lang)}</button>`;
}

export function layout(title: string, body: string, lang: Lang = DEFAULT_LANG): string {
  const htmlLang = lang === 'zh' ? 'zh-CN' : 'en';
  const favicon = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs><circle cx="16" cy="16" r="15" fill="#0f172a"/><circle cx="16" cy="16" r="8" stroke="url(#g)" stroke-width="3.5" fill="none"/></svg>');
  return `<!doctype html><html lang="${htmlLang}" data-lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OMK · ${title}</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${favicon}">
<style>
:root{
  --bg-base:#0f172a;
  --bg-surface:rgba(30,41,59,0.7);
  --bg-elevated:rgba(15,23,42,0.6);
  --border:rgba(148,163,184,0.1);
  --border-hover:rgba(148,163,184,0.25);
  --text-primary:#e2e8f0;
  --text-secondary:#94a3b8;
  --text-muted:#64748b;
  --text-faint:#475569;
  --accent:#60a5fa;
  --accent-hover:#93bbfd;
  --green:#4ade80;
  --green-bg:rgba(34,197,94,0.12);
  --red:#f87171;
  --red-bg:rgba(239,68,68,0.12);
  --yellow:#fbbf24;
  --yellow-bg:rgba(245,158,11,0.12);
  --info-bg:rgba(96,165,250,0.1);
  --chart-1:#60a5fa;
  --chart-2:#a78bfa;
  --chart-3:#34d399;
  --chart-4:#fb923c;
  --chart-5:#f472b6;
  --chart-6:#fbbf24;
  --bg-card:#1e293b;
  --radius:8px;
  --radius-lg:12px;
}
*{box-sizing:border-box;margin:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:32px;background:var(--bg-base);color:var(--text-primary);min-height:100vh;line-height:1.5;max-width:1100px;margin:0 auto}
h1{margin:0 0 6px;font-size:1.5rem;font-weight:700;color:var(--text-primary);letter-spacing:-0.02em}
h2{margin:24px 0 8px;font-size:0.9375rem;color:var(--text-secondary);font-weight:600}
.subtitle{color:var(--text-muted);font-size:0.8125rem;margin:0 0 20px}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-hover);text-decoration:underline}

/* Meta tags */
.meta-tags{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 20px}
.meta-tag{font-size:0.6875rem;color:var(--text-muted);padding:3px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:20px}

/* Cards */
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0}
.card{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px;min-width:140px;flex:1;transition:border-color 0.15s}
.card:hover{border-color:var(--border-hover)}
.card-label{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px}
.card-value{font-size:22px;font-weight:700;margin:2px 0;color:var(--text-primary);font-variant-numeric:tabular-nums}
.card-sub{font-size:11px;color:var(--text-muted)}
/* Summary table */
.summary-table td,.summary-table th{vertical-align:middle;text-align:center}
.summary-table td:first-child,.summary-table th:first-child{text-align:left}
.summary-cell{min-width:100px}
.summary-value-primary{font-size:1.375rem;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-0.02em}

/* Hint tooltip */
.hint{position:relative;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;font-size:10px;font-weight:600;color:var(--text-muted);border:1px solid var(--border-hover);border-radius:50%;cursor:help;margin-left:6px;vertical-align:middle}
.hint-click{cursor:pointer}
.modal-overlay{display:none;position:fixed;inset:0;z-index:999;background:rgba(0,0,0,0.6);align-items:center;justify-content:center}
.modal-content{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);max-width:600px;max-height:80vh;overflow:auto;padding:24px;margin:20px;width:90%}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.modal-close{cursor:pointer;background:none;border:none;color:var(--text-muted);font-size:18px;padding:8px 12px;border-radius:var(--radius);transition:background 0.15s,color 0.15s}
.modal-close:hover{color:var(--text-primary);background:var(--bg-surface)}
.modal-table{width:100%;font-size:13px;margin:12px 0;background:transparent;border:none}
.modal-table td{padding:6px 0;border:none;background:transparent}
.modal-table td:first-child{white-space:nowrap;vertical-align:top;min-width:80px;padding-right:12px}
@media(max-width:480px){.modal-table td{display:block;padding:3px 0}.modal-table td:first-child{font-weight:600}}
.hint-tip{display:none;position:absolute;bottom:calc(100% + 6px);right:0;background:var(--bg-elevated);border:1px solid var(--border-hover);border-radius:var(--radius);padding:6px 10px;font-size:11px;font-weight:400;color:var(--text-secondary);white-space:normal;max-width:280px;width:max-content;z-index:10}
.hint:hover .hint-tip,.hint:focus .hint-tip{display:block}
.summary-value{font-size:1rem;font-weight:600;color:var(--text-primary);font-variant-numeric:tabular-nums}
.summary-detail{font-size:0.6875rem;color:var(--text-muted);margin-top:3px}
.summary-unit{font-size:0.75rem;font-weight:400;color:var(--text-muted)}
.card-detail{margin-top:8px;font-size:12px;color:var(--text-secondary)}
.card-detail div{margin:2px 0}

/* Table */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:16px 0}
table{border-collapse:collapse;width:100%;font-size:0.8125rem;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;line-height:1.4}
th{background:var(--bg-elevated);padding:8px 14px;text-align:left;font-weight:500;color:var(--text-muted);border-bottom:1px solid var(--border);font-size:0.6875rem;text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap}
td{padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text-secondary);font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(148,163,184,0.04)}

/* Badges */
.badge{display:inline-block;padding:2px 8px;border-radius:var(--radius);font-size:11px;font-weight:600}
.badge-ok{background:var(--green-bg);color:var(--green)}
.badge-err{background:var(--red-bg);color:var(--red)}
.badge-pass{background:var(--green-bg);color:var(--green)}
.badge-fail{background:var(--red-bg);color:var(--red)}
.badge-muted{background:var(--bg-surface);color:var(--text-muted);border:1px solid var(--border)}

/* Nav */
.nav{margin-bottom:24px;font-size:13px}

/* Error detail */
.error-detail{display:inline-block;font-size:11px;color:var(--red);word-break:break-all;max-width:260px}

/* Assertion & dimension tags */
.assertion-list{margin:4px 0;padding:0;list-style:none;font-size:11px}
.assertion-list li{margin:2px 0;color:var(--text-secondary)}
.dim-scores{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.dim-tag{font-size:10px;padding:2px 7px;border-radius:4px;background:var(--info-bg);color:var(--accent)}
.dim-desc{font-size:11px;color:var(--text-muted);font-weight:400;margin-left:6px}

/* Bar chart */
.bar-row{display:flex;align-items:center;gap:8px;margin:6px 0}
.bar-label{flex:0 0 60px;font-size:12px;color:var(--text-muted)}
.bar-fill{flex:1;height:16px;border-radius:4px;opacity:0.8}
.bar-value{flex:0 0 auto;font-size:12px;color:var(--text-secondary)}

/* Forms */
input[type="text"]{background:var(--bg-elevated);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:4px 8px;font-size:12px}
input[type="text"]:focus{outline-color:transparent;border-color:var(--accent);box-shadow:0 0 0 2px rgba(96,165,250,0.15)}
button{background:var(--bg-surface);border:1px solid var(--border);color:var(--text-secondary);border-radius:var(--radius);cursor:pointer;padding:4px 12px;font-size:12px;transition:border-color 0.15s,color 0.15s}
button:hover{border-color:var(--border-hover);color:var(--text-primary)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* Lang toggle */
.lang-toggle{position:fixed;top:16px;right:16px;padding:6px 14px;z-index:100;font-size:12px}

/* Misc */
.btn-danger{color:var(--red)}

/* Focus */
a:focus-visible,.badge:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}

/* Responsive */
@media(max-width:768px){
  body{padding:16px}
  .cards{flex-direction:column}
  .card{min-width:0}
  h1{font-size:1.25rem}
  h2{font-size:0.875rem}
  .lang-toggle{top:8px;right:8px;padding:4px 10px;font-size:11px}
  button{min-height:44px;padding:8px 14px}
}
@media(max-width:480px){
  body{padding:12px}
  td,th{padding:8px 10px;font-size:12px}
}
@media print{
  body{background:#fff;color:#1e293b;padding:20px;max-width:none}
  h1,h2,.card-value,.summary-value,.summary-value-primary{color:#1e293b}
  .card,.summary-table,table{background:#fff;border-color:#e2e8f0}
  th{background:#f8fafc;color:#475569;border-color:#e2e8f0}
  td{color:#334155;border-color:#f1f5f9}
  .badge-ok,.badge-pass{background:#dcfce7;color:#166534}
  .badge-err,.badge-fail{background:#fee2e2;color:#991b1b}
  .badge-muted{background:#f8fafc;color:#94a3b8;border-color:#e2e8f0}
  .dim-tag{background:#f1f5f9;color:#3b82f6}
  .meta-tag{background:#f8fafc;border-color:#e2e8f0;color:#475569}
  .bar-fill{opacity:1}
  a{color:#1e293b;text-decoration:none}
  .lang-toggle,.btn-danger,.nav{display:none}
  .hint-tip{display:none}
  .footer{color:#475569}
}
</style></head><body>${langToggleButton(lang)}${body}<footer class="footer" style="margin-top:40px;padding-top:16px;border-top:1px solid var(--border);font-size:11px;color:var(--text-faint);text-align:center">Powered by oh-my-knowledge · Built by lizhiyao</footer>${langToggleScript()}</body></html>`;
}
