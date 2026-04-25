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
    noRuns: '暂无评测记录。运行 <code>omk bench run --control v1 --treatment v2</code> 开始。',
    runId: '报告名称', variants: '实验分组', model: '执行模型', samples: '用例数',
    score: '分数', cost: '成本', time: '时间',
    deleteBtnText: '删除', deleteConfirm: '确定删除报告', deleteFail: '删除失败',
    reportTitle: '评测报告', backToList: '← 返回列表',
    judge: '评委', executor: '执行器', blindLabel: '盲测', revealBlind: '显示变体对应关系',
    dimFact: '📋 事实', dimFactDesc: '输出的事实声明是否正确（规则可验证：关键词匹配、格式校验等断言）',
    dimBehavior: '🛠️ 行为', dimBehaviorDesc: '执行过程是否合规（规则可验证：工具调用路径、轮次限制、成本约束等断言）',
    dimJudge: '💬 LLM 评价', dimJudgeDesc: '请一个 LLM 当评委，读被测模型的输出内容，按预先写好的评分规则（英文 rubric）打 1-5 分。主观但能抓到规则断言判不了的"整体好不好"',
    dimQuality: '📊 质量', dimQualityDesc: '事实 + 行为 + LLM 评价的等权平均（1-5 分）。UI 已拆出三层平铺展示，composite 字段仅保留在 JSON 数据层',
    dimCost: '💰 成本', dimCostDesc: '基于 Token 消耗量和模型定价计算的 API 调用费用',
    dimEfficiency: '⚡ 效率', dimEfficiencyDesc: 'Skill 从发送请求到模型返回完整响应的端到端耗时',
    dimStability: '🛡️ 稳定性', dimStabilityDesc: '多次运行（--repeat ≥ 2）分数一致性的 CV 变异系数，单轮显示"—"',
    compositeScore: '综合分数', scoreRange: '分数范围',
    assertions: '断言', assertionsDesc: '规则检查得分：通过的断言权重占比映射到 1-5 分',
    llmJudge: 'LLM 评委', llmJudgeDesc: '由评委模型按预先写好的评分规则（英文叫 rubric）打出的 1-5 分',
    judgeStddev: '评委波动', judgeStddevDesc: '同一份输出让评委评 N 次 (--judge-repeat) 得到 N 个分数的标准差。值低 = 评委对自己很坚定；值高 = 这个分本身就是噪声',
    judgeFailures: '评委失败', judgeFailuresDesc: 'N 次评委评分中返回 score=0（解析失败 / 调用错误）的次数。stddev=0 + failureCount>0 不是"完美一致"，是"大部分炸了"',
    judgeReasoning: '评委推理', judgeReasoningExpand: '展开',
    ensembleHeader: '多评委评分对比', ensembleDesc: '不同评委模型对同一份输出的独立评分。用于反驳"同模态偏差"',
    agreementHeader: '跨用例评委一致性', agreementDesc: '在所有测评用例上算的多评委一致性',
    pearsonLabel: '皮尔逊系数 (Pearson)', pearsonDesc: '皮尔逊相关系数：1=完全同向排序，0=无关，-1=完全反向',
    madLabel: '平均绝对差 (MAD)', madDesc: '平均绝对差。1-5 制下 < 0.5 紧密一致, > 1.5 大分歧',
    judgeModelsLabel: '评委模型',
    judgeRepeatLabel: '每条用例评委评价次数',
    judgePromptHashLabel: '评委提示词指纹', judgePromptHashDesc: '评委提示词模板的 SHA256 前 12 位。两份报告 hash 相同才能严格比分数',
    sampleHashCount: '用例指纹', sampleHashCountDesc: '已记录内容指纹的测评用例数 / 全部用例数。每条用例算 SHA256 前 12 位，用于跨 run 识别"测的是不是同一件事"。两份报告对同一 sample_id hash 一致才能严格比分',
    totalCost: '总成本', inputTokens: '输入', outputTokens: '输出',
    totalTokens: '总计', tokPerReq: 'tokens/次', avgLatency: '平均延迟',
    successRate: '完成率', success: '成功', errors: '失败',
    tokenComparison: 'Tokens 对比', latencyComparison: '延迟对比',
    avgTurns: '平均轮次', turnsPerReq: '轮/次', minScore: '最低',
    autoAnalysis: '自动分析',
    perSampleDetail: '逐用例详情', sample: '用例',
    scoreCol: '分数', tokensCol: 'Tokens', msCol: '延迟(ms)',
    eachOverview: '总览', eachSkill: 'Skill', eachBaseline: '无 Skill', eachWithSkill: '有 Skill', eachImprovement: '提升',
    eachSkills: '个 Skill', eachSamples: '个用例',
    agentLabel: 'Agent 评测',
    skillLabel: 'Skill 评测',
    promptLabel: 'Prompt 评测',
    workflowLabel: 'Workflow 评测',
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
    variantConfigDesc: '先看清楚在比较什么，再看分数。本表展示每个 variant 背后的 artifact 和运行环境。',
    variantType: '实验类型',
    variantArtifactKind: '知识类型',
    variantArtifactSource: '知识来源',
    variantExecutionStrategy: '执行策略',
    variantRuntimeContext: '运行环境',
    // --- observability (skill health / trend / diff) ---
    skillHealthTitle: 'Skill 健康度日报',
    noAnalyses: '暂无 skill 健康度日报。运行 <code>omk analyze &lt;trace-dir&gt;</code> 生成。',
    backToEvalReports: '← 评测报告',
    backToAnalyses: '← Skill 健康度日报',
    analysesCompareHint: '选两个报告的 from/to 单选框,点 Compare 生成 diff。',
    analysesCompareBtn: '对比 →',
    analysesFromLabel: 'from',
    analysesToLabel: 'to',
    analysesSessions: '会话',
    analysesSegs: '段',
    analysesSkills: '技能',
    skillTrendHeading: 'Skill 趋势',
    noTrendData: '暂无趋势数据。该 skill 尚未出现在任何分析报告里。',
    trendNPoints: '个时间点',
    trendEarliest: '最早',
    trendLatest: '最新',
    trendLegendGap: 'gap rate',
    trendLegendWeighted: 'weighted gap',
    trendLegendFailure: 'failure rate',
    trendLegendCoverage: 'coverage',
    trendColTimestamp: '时间',
    trendColSegs: '段数',
    trendColGap: 'Gap',
    trendColWeighted: '加权',
    trendColFailure: '失败率',
    trendColCoverage: '覆盖',
    trendColTokens: 'Tokens',
    trendColDuration: '耗时',
    skillDiffHeading: 'Skill 健康度对比',
    diffSortHint: '按 gap 变化量排序;绿色=改善,红色=恶化',
    diffTagRemoved: '已消失',
    diffTagNew: '新增',
    diffNavFrom: '起点',
    diffNavTo: '终点',
    diffColSkill: 'Skill',
    diffColSegments: '段数',
    diffColWeightedGap: '加权 Gap',
    diffColFailureRate: '失败率',
    diffColCoverage: '覆盖',
    viewTrendLink: '查看趋势 →',
    artifactHashLabel: '版本指纹',
    artifactHashTooltip: 'skill 文件内容的 SHA-256 前 12 位(不含路径/时间/git),用于辨别报告对应哪一版 skill;同文件多次跑指纹不变,改一字节就变——防止"改动效果"和"随机波动"混淆',
    switchLang: 'EN',
  },
  en: {
    title: 'Evaluation Reports',
    subtitle: 'Knowledge Artifact Evaluation',
    noRuns: 'No evaluation runs yet. Run <code>omk bench run --control v1 --treatment v2</code> to start.',
    runId: 'Report', variants: 'Variant', model: 'Execution model', samples: 'Samples',
    score: 'Score', cost: 'Cost', time: 'Time',
    deleteBtnText: 'Delete', deleteConfirm: 'Delete report', deleteFail: 'Delete failed',
    reportTitle: 'Evaluation Report', backToList: '← Back to list',
    judge: 'judge', executor: 'executor', blindLabel: 'BLIND', revealBlind: 'Reveal variant mapping',
    dimFact: '📋 Fact', dimFactDesc: 'Are factual claims correct (rule-verified: keyword matching, schema checks, etc.)',
    dimBehavior: '🛠️ Behavior', dimBehaviorDesc: 'Is execution compliant (rule-verified: tool paths, turn limits, cost constraints)',
    dimJudge: '💬 LLM judge', dimJudgeDesc: 'A separate LLM acts as judge: reads the tested model output, scores 1-5 against a predefined rubric. Subjective, catches "overall feel" rule-based assertions miss',
    dimQuality: '📊 Quality', dimQualityDesc: 'Equal-weight average of Fact + Behavior + LLM judge (1-5). UI now splits the three layers into separate columns; composite lives only in JSON data',
    dimCost: '💰 Cost', dimCostDesc: 'API cost calculated from token usage and model pricing',
    dimEfficiency: '⚡ Efficiency', dimEfficiencyDesc: 'End-to-end latency from sending request to receiving full response',
    dimStability: '🛡️ Stability', dimStabilityDesc: 'How much the score swings across repeated runs. Needs `--repeat ≥ 2`; single-run shows "—" because stability cannot be measured from one run',
    compositeScore: 'composite score', scoreRange: 'Range',
    assertions: 'Assertions', assertionsDesc: 'Rule-based score: passed assertion weight ratio mapped to 1-5',
    llmJudge: 'LLM Judge', llmJudgeDesc: 'Score (1-5) from the judge model based on a predefined rubric (scoring criteria)',
    judgeStddev: 'Judge stddev', judgeStddevDesc: 'Stddev across N judge calls (--judge-repeat). Low = judge is consistent; high = this score itself is noisy',
    judgeFailures: 'Judge failures', judgeFailuresDesc: 'How many of N judge calls returned score=0 (parse / executor failure). stddev=0 + failureCount>0 is NOT "perfect agreement" — it means most calls failed',
    judgeReasoning: 'CoT reasoning', judgeReasoningExpand: 'expand',
    ensembleHeader: 'Per-judge scores', ensembleDesc: 'Independent scores from different judge models for the same output — refutes same-modality bias',
    agreementHeader: 'Inter-judge agreement', agreementDesc: 'Cross-sample agreement metrics across all judges in this variant',
    pearsonLabel: 'Pearson', pearsonDesc: 'Pearson correlation: 1=perfect rank agreement, 0=independent, -1=anti-correlated',
    madLabel: 'MAD', madDesc: 'Mean absolute difference. On 1-5 scale: < 0.5 tight, > 1.5 large disagreement',
    judgeModelsLabel: 'Judge models',
    judgeRepeatLabel: 'Judge calls per sample',
    judgePromptHashLabel: 'Judge prompt fingerprint', judgePromptHashDesc: 'SHA256-12 of the judge prompt template. Reports must share the same hash before scores are strictly comparable',
    sampleHashCount: 'Sample fingerprints', sampleHashCountDesc: 'Number of samples with content hashes recorded / total samples. Each sample gets a SHA256-12 fingerprint identifying "is this the same sample as before". Two reports must share the same hash for a given sample_id to be strictly comparable',
    totalCost: 'total cost', inputTokens: 'Input', outputTokens: 'Output',
    totalTokens: 'Total', tokPerReq: 'tokens/req', avgLatency: 'avg latency',
    successRate: 'completion rate', success: 'Success', errors: 'Errors',
    tokenComparison: 'Tokens Comparison', latencyComparison: 'Latency Comparison',
    avgTurns: 'Avg Turns', turnsPerReq: 'turns/req', minScore: 'Min',
    autoAnalysis: 'Auto Analysis',
    perSampleDetail: 'Per-Sample Detail', sample: 'Sample',
    scoreCol: 'Score', tokensCol: 'Tokens', msCol: 'ms',
    eachOverview: 'Overview', eachSkill: 'Skill', eachBaseline: 'Baseline', eachWithSkill: 'With Skill', eachImprovement: 'Improvement',
    eachSkills: ' skills', eachSamples: ' samples',
    agentLabel: 'Agent Eval',
    skillLabel: 'Skill Eval',
    promptLabel: 'Prompt Eval',
    workflowLabel: 'Workflow Eval',
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
    // --- observability (skill health / trend / diff) ---
    skillHealthTitle: 'Skill Health Reports',
    noAnalyses: 'No skill health reports yet. Run <code>omk analyze &lt;trace-dir&gt;</code> to generate.',
    backToEvalReports: '← Eval reports',
    backToAnalyses: '← Skill Health Reports',
    analysesCompareHint: 'Pick from/to radios on two reports, then click Compare to generate a diff.',
    analysesCompareBtn: 'Compare →',
    analysesFromLabel: 'from',
    analysesToLabel: 'to',
    analysesSessions: 'sessions',
    analysesSegs: 'segs',
    analysesSkills: 'skills',
    skillTrendHeading: 'Skill Trend',
    noTrendData: 'No trend data. This skill has not appeared in any analysis report yet.',
    trendNPoints: 'data points',
    trendEarliest: 'earliest',
    trendLatest: 'latest',
    trendLegendGap: 'gap rate',
    trendLegendWeighted: 'weighted gap',
    trendLegendFailure: 'failure rate',
    trendLegendCoverage: 'coverage',
    trendColTimestamp: 'Timestamp',
    trendColSegs: 'Segs',
    trendColGap: 'Gap',
    trendColWeighted: 'Weighted',
    trendColFailure: 'Failure',
    trendColCoverage: 'Coverage',
    trendColTokens: 'Tokens',
    trendColDuration: 'Duration',
    skillDiffHeading: 'Skill Health Diff',
    diffSortHint: 'Sorted by |Δgap|; green=improved, red=regressed',
    diffTagRemoved: 'removed',
    diffTagNew: 'new',
    diffNavFrom: 'from',
    diffNavTo: 'to',
    diffColSkill: 'Skill',
    diffColSegments: 'Segments',
    diffColWeightedGap: 'Weighted gap',
    diffColFailureRate: 'Failure rate',
    diffColCoverage: 'Coverage',
    viewTrendLink: 'trend →',
    artifactHashLabel: 'Version fingerprint',
    artifactHashTooltip: 'First 12 hex chars of SHA-256 over the skill file content (content-only: no path/time/git); identifies which version of the skill this report ran — same file = same fingerprint, any byte change = different fingerprint. Keeps "intentional change" separate from "random variance"',
    switchLang: '中文',
  },
};

export const DEFAULT_LANG: Lang = 'zh';

export function t(key: string, lang: Lang = DEFAULT_LANG): string {
  return I18N[lang]?.[key] || I18N.en[key] || key;
}

function globalKeyboardScript(): string {
  return `
  <script>
  // Global modal helpers. openModal/closeModal manage focus so the close
  // button becomes the first tab stop when a modal opens.
  window.openModal = function(id) {
    var modal = document.getElementById(id);
    if (!modal) return;
    modal.style.display = 'flex';
    setTimeout(function() {
      var closeBtn = modal.querySelector('.modal-close');
      if (closeBtn) closeBtn.focus();
    }, 30);
  };
  window.closeModal = function(id) {
    var modal = document.getElementById(id);
    if (!modal) return;
    modal.style.display = 'none';
  };
  // Global ESC to close any open modal-overlay
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay').forEach(function(m) {
        if (m.style.display === 'flex') m.style.display = 'none';
      });
    }
  });
  </script>`;
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
    // 同步写入 URL ?lang= 和 localStorage,让刷新/跳转保持语言选择
    try {
      var url = new URL(window.location.href);
      url.searchParams.set('lang', next);
      window.history.replaceState(null, '', url.toString());
      localStorage.setItem('omk-lang', next);
    } catch (e) { /* ignore */ }
  }
  // 页面加载时,若 URL 无 lang 但 localStorage 有,跳转到带 lang 的 URL (仅一次)
  (function() {
    try {
      var url = new URL(window.location.href);
      if (!url.searchParams.get('lang')) {
        var saved = localStorage.getItem('omk-lang');
        if (saved && saved !== '${DEFAULT_LANG}') {
          url.searchParams.set('lang', saved);
          window.location.replace(url.toString());
        }
      }
    } catch (e) { /* ignore */ }
  })();
  </script>`;
}

function langToggleButton(lang: Lang): string {
  return `<button id="lang-toggle" onclick="switchLang()" class="lang-toggle">${t('switchLang', lang)}</button>`;
}

export function layout(title: string, body: string, lang: Lang = DEFAULT_LANG): string {
  const htmlLang = lang === 'zh' ? 'zh-CN' : 'en';
  const favicon = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs><circle cx="16" cy="16" r="15" fill="#0f172a"/><circle cx="16" cy="16" r="8" stroke="url(#g)" stroke-width="3.5" fill="none"/></svg>');
  return `<!doctype html><html lang="${htmlLang}" data-lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OMK · ${title}</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${favicon}">${globalKeyboardScript()}
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
  --fs-micro:11px;
  --fs-detail:12px;
  --fs-label:12px;
  --fs-body:13px;
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
/* Summary table — inherits the global center + middle from the base td/th. */
.summary-cell{min-width:100px}
.summary-value-primary{font-size:1.375rem;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-0.02em}

/* Hint tooltip (legacy span-based, kept for hover-only hints) */
.hint{position:relative;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;font-size:10px;font-weight:600;color:var(--text-muted);border:1px solid var(--border-hover);border-radius:50%;cursor:help;margin-left:6px;vertical-align:middle}
.hint-click{cursor:pointer}

/* Hint button — accessible, keyboard-focusable replacement for click-to-open-modal hints */
button.hint-btn{display:inline-flex;align-items:center;justify-content:center;min-width:22px;min-height:22px;padding:3px;font-size:var(--fs-micro);font-weight:600;color:var(--text-muted);background:transparent;border:1px solid var(--border-hover);border-radius:50%;cursor:pointer;margin-left:6px;vertical-align:middle;line-height:1;transition:color 0.15s,border-color 0.15s}
button.hint-btn:hover{color:var(--text-primary);border-color:var(--text-primary)}
button.hint-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* Verdict + detail pattern used in variance & significance cells */
.verdict-line{color:var(--text-secondary);font-size:var(--fs-body)}
.detail-line{font-size:var(--fs-detail);color:var(--text-muted);margin-top:2px}

/* Modal glossary layout — grid rows with tree connectors for sub-items */
.modal-glossary-hint{font-size:var(--fs-detail);color:var(--text-muted);margin:4px 0 14px;font-style:italic}
.modal-glossary{display:flex;flex-direction:column}
.modal-glossary-row{display:grid;grid-template-columns:100px 1fr;gap:16px;padding:9px 0;border-bottom:1px solid var(--border)}
.modal-glossary-row:last-child{border-bottom:none}
.modal-glossary-label{font-size:var(--fs-body);color:var(--text-primary);font-weight:600}
.modal-glossary-desc{font-size:var(--fs-detail);color:var(--text-secondary);line-height:1.55}
.modal-glossary-sub{display:grid;grid-template-columns:86px 1fr;gap:14px;padding:6px 0 6px 28px;position:relative}
.modal-glossary-sub::before{content:'';position:absolute;left:10px;top:0;bottom:0;width:2px;background:var(--border-hover);border-radius:1px}
.modal-glossary-sub-label{font-size:var(--fs-detail);color:var(--text-secondary);font-weight:500}
.modal-glossary-sub-desc{font-size:var(--fs-detail);color:var(--text-muted);line-height:1.55}

/* Modal section divider */
.modal-section{margin-top:20px;padding-top:16px;border-top:1px solid var(--border-hover)}
.modal-section-title{font-size:var(--fs-body);font-weight:600;color:var(--text-primary);margin-bottom:10px}

/* Four-quadrant diagnostic rule cards (matches the table's icon+text style) */
.diag-rules{display:flex;flex-direction:column;gap:8px}
.diag-rule-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg-elevated);border-radius:var(--radius);border-left:3px solid var(--border-hover)}
.diag-rule-row.rule-good{border-left-color:var(--green)}
.diag-rule-row.rule-warn{border-left-color:var(--yellow)}
.diag-rule-row.rule-neutral{border-left-color:var(--text-muted)}
.diag-rule-icon{font-size:15px;flex-shrink:0;line-height:1.4}
.diag-rule-icon.rule-good{color:var(--green)}
.diag-rule-icon.rule-warn{color:var(--yellow)}
.diag-rule-icon.rule-neutral{color:var(--text-muted)}
.diag-rule-body{flex:1;min-width:0}
.diag-rule-title{font-size:var(--fs-detail);font-weight:600;color:var(--text-primary);margin-bottom:3px}
.diag-rule-desc{font-size:var(--fs-detail);color:var(--text-secondary);line-height:1.5}
.diag-rule-example{font-size:var(--fs-micro);color:var(--text-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:4px;opacity:0.85}

/* Variance & significance table: all cells use the global center + middle. */
.variance-table td{padding-top:12px;padding-bottom:12px}
.variance-table td.diagnostic-cell{min-width:180px}
.variance-table .diag-faded strong{opacity:0.5;font-weight:500}

/* Knowledge Interaction section (v0.17 / A):
   variant card is the only visual container, two inner columns use a
   single vertical divider instead of nested bg — compresses hierarchy
   from 3-4 layers to 2. */
.ki-card{margin-bottom:10px;padding:12px 14px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius)}
.ki-card-header{display:flex;flex-direction:column;gap:3px;margin-bottom:10px}
.ki-card-title{font-size:15px;font-weight:600;color:var(--text-primary)}
.ki-card-meta{font-size:var(--fs-micro);color:var(--text-muted);font-weight:400}
.ki-columns{display:flex;gap:0;flex-wrap:wrap}
.ki-col{flex:1;min-width:220px;padding:0 18px}
.ki-col:first-child{padding-left:0;border-right:1px solid var(--border)}
.ki-col:last-child{padding-right:0}
@media(max-width:640px){
  .ki-col{padding:0;min-width:100%;border-right:none !important}
  .ki-col+.ki-col{margin-top:16px;padding-top:14px;border-top:1px solid var(--border)}
}
.ki-col-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.ki-col-title{font-size:13px;color:var(--text-secondary);font-weight:500}
.ki-col-value{font-size:22px;font-weight:600}
.ki-bar{height:6px;background:var(--bg-card);border-radius:4px;margin-bottom:8px;overflow:hidden}
.ki-bar-fill{height:100%;border-radius:4px;transition:width 0.2s}
.ki-inventory-item{padding:6px 10px;margin:4px 0;background:var(--bg-card);border-left:3px solid var(--border-hover);border-radius:4px;font-size:var(--fs-detail);line-height:1.5}
.ki-inventory-item[data-severity="strong"]{border-left-color:var(--red)}
.ki-inventory-item[data-severity="medium"]{border-left-color:var(--yellow)}
.ki-inventory-item[data-severity="weak"]{border-left-color:var(--text-muted)}
.ki-inventory-item-meta{color:var(--text-muted);font-size:var(--fs-micro);margin-bottom:2px}
.ki-inventory-item-ctx{color:var(--text-secondary);word-break:break-all}
.ki-desc{font-size:12px;color:var(--text-muted);margin-bottom:4px;line-height:1.6}
.ki-desc-hint{font-size:11px;color:var(--text-faint);margin-bottom:12px;line-height:1.5}
.ki-details{margin-top:8px;padding-top:8px;border-top:1px solid var(--border)}
.ki-details>summary{cursor:pointer;font-size:var(--fs-micro);color:var(--text-muted);padding:2px 0;list-style:revert;user-select:none;transition:color 0.15s}
.ki-details>summary:hover{color:var(--text-secondary)}
.ki-details[open]>summary{color:var(--text-secondary);margin-bottom:6px}

/* Three-layer independent significance breakdown (PR-2).
   Default collapsed; expands inline under each comparison. */
.layer-breakdown-row>td{padding:0 !important;background:transparent;border-top:1px dashed var(--border-hover)}
.layer-breakdown{padding:10px 16px 14px 32px;background:var(--bg-elevated)}
.layer-breakdown>summary{cursor:pointer;font-size:var(--fs-detail);color:var(--text-muted);padding:4px 0;list-style:revert;user-select:none}
.layer-breakdown>summary:hover{color:var(--text-secondary)}
.layer-breakdown[open]>summary{color:var(--text-primary);margin-bottom:8px}
.layer-sub-table{margin:0;width:100%;font-size:var(--fs-detail)}
.layer-sub-table td{padding-top:8px;padding-bottom:8px}
/* Multiple-comparisons disclaimer for the three-layer breakdown (PR-2) */
.layer-breakdown-disclaimer{font-size:var(--fs-micro);color:var(--text-muted);line-height:1.5;padding:4px 8px 10px 0;font-style:italic}
.modal-overlay{display:none;position:fixed;inset:0;z-index:999;background:rgba(0,0,0,0.6);align-items:center;justify-content:center}
.modal-content{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);max-width:800px;max-height:80vh;overflow:auto;padding:24px;margin:20px;width:90%}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.modal-close{cursor:pointer;background:none;border:none;color:var(--text-muted);font-size:18px;padding:8px 12px;border-radius:var(--radius);transition:background 0.15s,color 0.15s}
.modal-close:hover{color:var(--text-primary);background:var(--bg-surface)}
.modal-table{width:100%;font-size:13px;margin:12px 0;background:transparent;border:none;table-layout:auto}
.modal-table td{padding:6px 0;border:none;background:transparent;word-break:break-word;overflow-wrap:anywhere}
.modal-table td:first-child{white-space:nowrap;vertical-align:top;min-width:80px;padding-right:16px;word-break:keep-all}
/* Inline <code> inside modal text — improve readability on dark surfaces */
.modal-table code,.modal-glossary code,.modal-section code{background:var(--bg-surface);padding:1px 6px;border-radius:3px;font-size:var(--fs-micro);color:var(--text-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
@media(max-width:480px){.modal-table td{display:block;padding:3px 0}.modal-table td:first-child{font-weight:600}}
.hint-tip{display:none;position:absolute;bottom:calc(100% + 6px);right:0;background:var(--bg-elevated);border:1px solid var(--border-hover);border-radius:var(--radius);padding:6px 10px;font-size:11px;font-weight:400;color:var(--text-secondary);white-space:normal;max-width:280px;width:max-content;z-index:10}
.hint:hover .hint-tip,.hint:focus .hint-tip{display:block}
.summary-value{font-size:1rem;font-weight:600;color:var(--text-primary);font-variant-numeric:tabular-nums}
.summary-detail{font-size:0.6875rem;color:var(--text-muted);margin-top:3px}
.summary-unit{font-size:0.75rem;font-weight:400;color:var(--text-muted)}
.card-detail{margin-top:8px;font-size:12px;color:var(--text-secondary)}
.card-detail div{margin:2px 0}

/* Table */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:16px 0;position:relative}
/* 窄屏下 6 列宽 >700px 会横向溢出,右侧稳定性列容易被遮盖。
   加一条渐变阴影作为"可滑动"视觉提示,仅在 ≤768px 且可滚动容器里显示。 */
@media(max-width:768px){
  .table-wrap::after{content:'';position:sticky;right:0;top:0;display:block;float:right;width:32px;height:100%;margin-left:-32px;margin-top:-100%;pointer-events:none;background:linear-gradient(to right,transparent,var(--bg-card) 85%);z-index:2}
}
table{border-collapse:collapse;width:100%;font-size:0.8125rem;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;line-height:1.4}
th{background:var(--bg-elevated);padding:8px 14px;text-align:center;vertical-align:middle;font-weight:500;color:var(--text-muted);border-bottom:1px solid var(--border);font-size:0.6875rem;text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap}
td{padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text-secondary);font-variant-numeric:tabular-nums;text-align:center;vertical-align:middle}
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
  /* Override: hint buttons stay compact so they don't dominate mobile layout */
  button.hint-btn{min-width:28px;min-height:28px;padding:4px}
  /* Bump detail font so secondary lines are readable on mobile */
  .detail-line{font-size:var(--fs-label)}
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
</style></head><body>${langToggleButton(lang)}${body}<footer class="footer" style="margin-top:40px;padding-top:16px;border-top:1px solid var(--border);font-size:11px;color:var(--text-faint);text-align:center">Powered by oh-my-knowledge</footer>${langToggleScript()}</body></html>`;
}
