import type { Lang } from '../types/index.js';
import { brandLogo, BRAND_LOGO_RAW } from './icons.js';

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

export function fmtCost(usd: number | undefined | null, reported: boolean = true): string {
  // reported=false 时 executor 不报 cost(如 codex CLI),`usd` 是占位 0,
  // 显示 "—" 跟"真的花了 $0"区分开。callsite 传 reported 时通常来自
  // `VariantSummary.execCostReported !== false` 或 `VariantResult.costReportedByExecutor !== false`。
  if (!reported) return '—';
  return `$${Number(usd || 0).toFixed(4)}`;
}

export function fmtKnownCost(usd: number | undefined | null, fullyReported: boolean = true): string {
  const value = Number(usd || 0);
  if (fullyReported) return fmtCost(value);
  return value > 0 ? `≥${fmtCost(value)}` : '—';
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
    noRuns: '暂无评测记录。运行 <code>omk eval --control v1 --treatment v2</code> 开始。',
    runId: '报告名称', variants: '实验分组', model: '任务执行模型', samples: '评测用例数',
    score: '分数', cost: '执行成本', time: '时间',
    deleteBtnText: '删除', deleteConfirm: '确定删除报告', deleteFail: '删除失败',
    reportTitle: '评测报告', backToList: '← 返回列表',
    judge: '评委', executor: '执行器', blindLabel: '盲测', revealBlind: '显示变体对应关系',
    dimFact: '📋 事实', dimFactDesc: '输出的事实声明是否正确（规则可验证：关键词匹配、格式校验等断言）',
    dimBehavior: '🛠️ 行为', dimBehaviorDesc: '执行过程是否合规（规则可验证：工具调用路径、轮次限制、成本约束等断言）',
    dimJudge: '💬 LLM 评价', dimJudgeDesc: '请一个 LLM 当评委，读任务执行模型的输出内容，按预先写好的评分规则（英文 rubric）打 1-5 分。主观但能抓到规则断言判不了的"整体好不好"',
    dimQuality: '📊 质量', dimQualityDesc: '事实 + 行为 + LLM 评价的等权平均（1-5 分）。UI 已拆出三层平铺展示，composite 字段仅保留在 JSON 数据层',
    dimCost: '💰 执行成本', dimCostDesc: '基于 Token 消耗量和模型定价计算的任务执行模型调用费用',
    dimEfficiency: '⚡ 效率', dimEfficiencyDesc: 'Skill 从发送请求到模型返回完整响应的端到端耗时',
    dimStability: '🛡️ 稳定性', dimStabilityDesc: '多次运行（--repeat ≥ 2）分数一致性的 CV 变异系数，单轮显示"—"',
    compositeScore: '综合分数', scoreRange: '分数范围',
    assertions: '断言', assertionsDesc: '规则检查得分：通过的断言权重占比映射到 1-5 分',
    llmJudge: 'LLM 评委', llmJudgeDesc: '由评委模型按预先写好的评分规则（英文叫 rubric）打出的 1-5 分',
    judgeStddev: '评委波动', judgeStddevDesc: '同一份输出让评委评 N 次 (--judge-repeat) 得到 N 个分数的标准差。值低 = 评委对自己很坚定；值高 = 这个分本身就是噪声',
    judgeFailures: '评委失败', judgeFailuresDesc: 'N 次评委评分中返回 score=0（解析失败 / 调用错误）的次数。stddev=0 + failureCount>0 不是"完美一致"，是"大部分炸了"',
    judgeReasoning: '评委推理', judgeReasoningExpand: '展开',
    ensembleHeader: '多评委评分对比', ensembleDesc: '不同评委模型对同一份输出的独立评分。用于反驳"同模态偏差"',
    agreementHeader: '跨用例评委一致性', agreementDesc: '在所有评测用例上算的多评委一致性',
    pearsonLabel: '皮尔逊系数 (Pearson)', pearsonDesc: '皮尔逊相关系数：1=完全同向排序，0=无关，-1=完全反向',
    madLabel: '平均绝对差 (MAD)', madDesc: '平均绝对差。1-5 制下 < 0.5 紧密一致, > 1.5 大分歧',
    judgeModelsLabel: '评委模型',
    judgeRepeatLabel: '每条用例评委评价次数',
    judgePromptHashLabel: '评委提示词指纹', judgePromptHashDesc: '评委提示词模板的 SHA256 前 12 位。两份报告 hash 相同才能严格比分数',
    sampleHashCount: '评测用例指纹', sampleHashCountDesc: '已记录内容指纹的评测用例数 / 全部评测用例数。每条评测用例算 SHA256 前 12 位，用于跨 run 识别"测的是不是同一件事"。两份报告对同一 sample_id hash 一致才能严格比分',
    evalFrameworkLabel: '统计框架', evalFrameworkBootstrap: 'bootstrap CI', evalFrameworkBoth: 't-test + bootstrap', evalFrameworkTTest: 't-test',
    evalFrameworkDesc: '分数置信区间用什么算法。bootstrap 不假设分布,适合 LLM 1-5 序数评分;t-test 假设正态,小样本下不稳。"both" = 报告同时含两种,renderer 优先 bootstrap',
    bootstrapDiffSignificant: '✓ 显著差异', bootstrapDiffNotSignificant: '✗ 无显著差异', bootstrapDiffLabel: 'Δ (treatment - control)',
    totalCost: '已上报总成本', inputTokens: '输入', outputTokens: '输出',
    totalTokens: '总计', tokPerReq: 'tokens/次', avgLatency: '平均延迟',
    successRate: '完成率', success: '成功', errors: '失败',
    tokenComparison: 'Tokens 对比', latencyComparison: '延迟对比',
    avgTurns: '平均轮次', turnsPerReq: '轮/次', minScore: '最低',
    autoAnalysis: '自动分析',
    perSampleDetail: '逐用例详情', sample: '用例',
    scoreCol: '分数', tokensCol: 'Tokens', msCol: '延迟(ms)',
    batchOverview: '总览', batchSkill: 'Skill', batchBaseline: '无 Skill', batchWithSkill: '有 Skill', batchImprovement: '提升',
    batchSkills: '个 Skill', batchSamples: '个评测用例',
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
    noAnalyses: '暂无 skill 健康度日报。运行 <code>omk observe &lt;trace-dir&gt;</code> 生成。',
    backToEvalReports: '← 评测报告',
    backToAnalyses: '← Skill 健康度日报',
    analysesCompareHint: '选两个报告的 from/to 单选框,点 Compare 生成 diff。',
    analysesCompareBtn: '对比 →',
    analysesFromLabel: 'from',
    analysesToLabel: 'to',
    analysesSessions: '会话',
    analysesSegs: '段',
    analysesSkills: '技能',
    analysesLowN: '样本不足',
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
    artifactHashTooltip: 'skill 内容指纹的 SHA-256 前 12 位(不含路径/时间/git):目录-skill(本地或 git)覆盖整棵可分发树(SKILL.md + references/ 资产,排除 .omk/.git/node_modules/evolve;改任意资产都变,git 源经隔离副本物化、整树暴露给 executor),单文件-skill 取该 .md 字节;用于辨别报告对应哪一版 skill,同输入指纹不变——防止"改动效果"和"随机波动"混淆',
    switchLang: '英文',
  },
  en: {
    title: 'Evaluation Reports',
    subtitle: 'Knowledge Artifact Evaluation',
    noRuns: 'No evaluation runs yet. Run <code>omk eval --control v1 --treatment v2</code> to start.',
    runId: 'Report', variants: 'Variant', model: 'Task execution model', samples: 'Samples',
    score: 'Score', cost: 'Execution cost', time: 'Time',
    deleteBtnText: 'Delete', deleteConfirm: 'Delete report', deleteFail: 'Delete failed',
    reportTitle: 'Evaluation Report', backToList: '← Back to list',
    judge: 'Judge', executor: 'Executor', blindLabel: 'BLIND', revealBlind: 'Reveal variant mapping',
    dimFact: '📋 Fact', dimFactDesc: 'Are factual claims correct (rule-verified: keyword matching, schema checks, etc.)',
    dimBehavior: '🛠️ Behavior', dimBehaviorDesc: 'Is execution compliant (rule-verified: tool paths, turn limits, cost constraints)',
    dimJudge: '💬 LLM judge', dimJudgeDesc: 'A separate LLM acts as judge: reads the task execution model output, scores 1-5 against a predefined rubric. Subjective, catches "overall feel" rule-based assertions miss',
    dimQuality: '📊 Quality', dimQualityDesc: 'Equal-weight average of Fact + Behavior + LLM judge (1-5). UI now splits the three layers into separate columns; composite lives only in JSON data',
    dimCost: '💰 Exec cost', dimCostDesc: 'API cost for the task execution model, calculated from token usage and model pricing',
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
    evalFrameworkLabel: 'CI framework', evalFrameworkBootstrap: 'bootstrap CI', evalFrameworkBoth: 't-test + bootstrap', evalFrameworkTTest: 't-test',
    evalFrameworkDesc: 'Algorithm used for confidence intervals. Bootstrap is distribution-free and recommended for ordinal LLM scores; t-test assumes normality and is unstable on small N. "both" = report has both, renderer prefers bootstrap',
    bootstrapDiffSignificant: '✓ significant', bootstrapDiffNotSignificant: '✗ not significant', bootstrapDiffLabel: 'Δ (treatment - control)',
    totalCost: 'Reported total cost', inputTokens: 'Input', outputTokens: 'Output',
    totalTokens: 'Total', tokPerReq: 'tokens/req', avgLatency: 'avg latency',
    successRate: 'completion rate', success: 'Success', errors: 'Errors',
    tokenComparison: 'Tokens Comparison', latencyComparison: 'Latency Comparison',
    avgTurns: 'Avg Turns', turnsPerReq: 'turns/req', minScore: 'Min',
    autoAnalysis: 'Auto Analysis',
    perSampleDetail: 'Per-Sample Detail', sample: 'Sample',
    scoreCol: 'Score', tokensCol: 'Tokens', msCol: 'ms',
    batchOverview: 'Overview', batchSkill: 'Skill', batchBaseline: 'Baseline', batchWithSkill: 'With Skill', batchImprovement: 'Improvement',
    batchSkills: ' skills', batchSamples: ' samples',
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
    noAnalyses: 'No skill health reports yet. Run <code>omk observe &lt;trace-dir&gt;</code> to generate.',
    backToEvalReports: '← Eval reports',
    backToAnalyses: '← Skill Health Reports',
    analysesCompareHint: 'Pick from/to radios on two reports, then click Compare to generate a diff.',
    analysesCompareBtn: 'Compare →',
    analysesFromLabel: 'from',
    analysesToLabel: 'to',
    analysesSessions: 'sessions',
    analysesSegs: 'segs',
    analysesSkills: 'skills',
    analysesLowN: 'low N',
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
    artifactHashTooltip: 'First 12 hex chars of SHA-256 over the skill content (content-only: no path/time/git): a directory-skill (local or git) covers the whole distributable tree (SKILL.md + references/ assets, excluding .omk/.git/node_modules/evolve; any asset change flips it; git sources are materialized into an isolated copy whose whole tree is exposed to the executor), a file-skill covers the single .md bytes. Identifies which version of the skill this report ran — same input = same fingerprint. Keeps "intentional change" separate from "random variance"',
    switchLang: 'Chinese',
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
  // 复制 paste-ready 片段到剪贴板:供 insight modal 的"复制片段"按钮调用。
  // 元素 id 指 <code> 节点;复制后按钮加 .copied 类做 1.5s 视觉反馈。
  // i18n:按钮反馈文案随页面 data-lang(layout 写在 <html> 上,langToggleScript 切换时更新)。
  // 未设 dataset 时按 DEFAULT_LANG(zh)兜底,跟旧报告/无 toggle 入口的页面一致。
  window.omkCopySnippet = function(elementId, btn) {
    var el = document.getElementById(elementId);
    if (!el) return;
    var text = el.textContent || '';
    var pageLang = document.documentElement.dataset.lang || '${DEFAULT_LANG}';
    var copiedLabel = pageLang === 'en' ? '✓ Copied' : '✓ 已复制';
    var done = function() {
      if (!btn) return;
      var orig = btn.textContent;
      btn.textContent = copiedLabel;
      btn.classList.add('copied');
      setTimeout(function() { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function() { /* swallow */ });
    } else {
      // 老浏览器兜底:execCommand fallback
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch(e) { /* swallow */ }
      document.body.removeChild(ta);
    }
  };
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
  const favicon = encodeURIComponent(BRAND_LOGO_RAW);
  // 中英文切换按钮临时隐藏(URL ?lang= / localStorage 切换逻辑保留,按钮 UI 不渲染)。
  // 想恢复:在 body 模板里加回 ${langToggleButton(lang)}。
  void langToggleButton;
  const appBar = `<header class="app-bar"><a class="app-brand" href="/"><span class="app-brand-logo">${brandLogo(30)}</span><span class="app-brand-tag">Studio</span></a><span class="app-bar-spacer"></span></header>`;
  return `<!doctype html><html lang="${htmlLang}" data-lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OMK · ${e(title)}</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${favicon}">${globalKeyboardScript()}
<style>
/* 跨文档 view transition：同源 MPA 导航(如维度 chip 跳转)淡入淡出,消除白屏闪烁(Chromium)。 */
@view-transition{navigation:auto}
/* 滚动条始终预留 gutter:短页无滚动条、长页有,切换时内容宽度会跳;stable 让宽度恒定。 */
html{scrollbar-gutter:stable}
/* 参照 aima-knowledge SkillHealth 配色（2026-06）。
   设计原则：冷白底 + indigo 强调色 + 精确匹配参考系统色板。 */
:root{
  --bg-base:rgb(246,248,251);    /* 页面底 */
  --bg-surface:#ffffff;          /* 卡片白 */
  --bg-elevated:#f8f9fd;         /* 浅面板 */
  --bg-soft:#f8fafc;             /* 柔和背景 */
  --border:#e4e8f1;              /* 分隔线 */
  --border-hover:#d1d5db;
  --text-primary:#182033;        /* 主文字 */
  --text-secondary:#637083;      /* 次文字 */
  --text-muted:#9ca3af;
  --text-faint:#b0b8c5;
  --accent:#4f46e5;              /* 品牌 indigo-600 */
  --accent-hover:#4338ca;
  --green:#1f9d63;               /* 通过绿 */
  --green-bg:rgba(31,157,99,.14);
  --red:#dc2626;                 /* 失败红 */
  --red-bg:rgba(220,38,38,.14);
  --yellow:#d97706;              /* 警告琥珀 */
  --yellow-bg:rgba(217,119,6,.16);
  --info-bg:rgba(79,70,229,.06);
  /* 图表色 */
  --chart-1:#4f46e5;
  --chart-2:#d97706;
  --chart-3:#059669;
  --chart-4:#ec4899;
  --chart-5:#06b6d4;
  --chart-6:#7c3aed;
  --bg-card:#ffffff;
  --radius:8px;
  --radius-lg:12px;
  /* 字号 */
  --fs-micro:12px;
  --fs-detail:13px;
  --fs-label:13px;
  --fs-body:14px;
  --shadow-sm:0 8px 24px rgba(31,41,55,.04);
  --shadow-md:0 8px 28px rgba(79,70,229,.08);
}
*{box-sizing:border-box;margin:0}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",Roboto,sans-serif;padding:0;background:var(--bg-base);color:var(--text-primary);min-height:100vh;line-height:1.7;margin:0;font-size:var(--fs-body);letter-spacing:-.005em}

/* ── 常驻品牌栏(白玻璃,无菜单)— 让品牌身份贯穿首页与所有详情页 ── */
.app-bar{position:sticky;top:0;z-index:30;height:52px;background:rgba(255,255,255,.82);backdrop-filter:saturate(180%) blur(12px);-webkit-backdrop-filter:saturate(180%) blur(12px);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;padding:0 22px}
.app-brand{display:flex;align-items:center;gap:9px;font-weight:650;font-size:15px;letter-spacing:-.02em;color:var(--text-primary);text-decoration:none}
.app-brand:hover{color:var(--text-primary);text-decoration:none}
.app-brand-logo{display:inline-flex;align-items:center;flex-shrink:0}
.app-brand-logo svg{display:block;border-radius:50%}
.app-brand-tag{font-size:11px;font-weight:600;color:var(--text-muted);border:1px solid var(--border);border-radius:5px;padding:1px 7px;letter-spacing:.02em}
.app-bar-spacer{flex:1}
/* 内容容器:居中、留出页边距(原本在 body 上,现下移到 main 容器) */
.app-main{max-width:1280px;margin:0 auto;padding:18px 20px 24px}
@media(max-width:768px){.app-main{padding:14px 14px 20px}.app-bar{padding:0 14px}}
h1{margin:0 0 8px;font-size:1.75rem;font-weight:600;color:var(--text-primary);letter-spacing:-0.01em;line-height:1.3}
h2{margin:32px 0 12px;font-size:1.0625rem;color:var(--text-primary);font-weight:600;line-height:1.4}
.subtitle{color:var(--text-secondary);font-size:0.875rem;margin:0 0 24px}
a{color:var(--accent);text-decoration:none;transition:color .15s}
a:hover{color:var(--accent-hover);text-decoration:underline}

/* Meta tags — 浅色主题下加大对比度,小一点的字号也清晰可读 */
.meta-tags{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 20px}
.meta-tag{font-size:13px;color:var(--text-secondary);padding:4px 12px;background:var(--bg-surface);border:1px solid var(--border);border-radius:20px;line-height:1.5}
.meta-tag code{font-size:12px;color:var(--text-secondary);background:transparent;padding:0;letter-spacing:0.02em}

/* Run ID stamp — H1 保留完整 run-id (与列表页一致), 时间戳从 ID 解出来作为副标小字,
   告诉用户「这次跑的时间」,无需用户自己解析 ID 后缀。 */
.run-id-stamp{font-size:0.75rem;color:var(--text-muted);margin:2px 0 12px;font-variant-numeric:tabular-nums}

/* Audit fingerprints — judge prompt hash + 执行环境 fingerprint 默认折叠,
   平日 review 不需要看, 复现 / 审计时再展开。 */
.audit-fingerprints{margin:0 0 18px}
.audit-fingerprints>summary{cursor:pointer;font-size:0.75rem;color:var(--text-muted);padding:4px 0;list-style:revert;user-select:none;transition:color 0.15s}
.audit-fingerprints>summary:hover{color:var(--text-secondary)}
.audit-fingerprints[open]>summary{color:var(--text-secondary);margin-bottom:6px}
.audit-fingerprints[open]>.meta-tags{margin-top:0}

/* Methodology audit — 方法学证据 (评委一致 / 差异显著 / 已饱和 / 人工对齐) 默认折叠,
   summary 行直接显示 4 个 badge: 全 ✓ = 流程健康,任一 ⚠/✗ = 强制 open. */
.methodology-audit{margin:24px 0;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-elevated)}
.methodology-audit>summary{cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:12px 16px;font-size:13px;color:var(--text-primary);font-weight:600;list-style:revert;user-select:none}
.methodology-audit>summary:hover{color:var(--accent)}
.methodology-summary-label{font-size:14px;font-weight:600}
.methodology-summary-hint{flex:1 1 auto;text-align:right;font-size:11px;color:var(--text-muted);font-weight:400}
.methodology-badges{display:inline-flex;flex-wrap:wrap;gap:6px}
.methodology-badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:3px 10px;border-radius:12px;letter-spacing:0.02em;line-height:1.5;white-space:nowrap}
/* Pantone 哑色 — 用 var(--green-bg) 等(浅色主题已重定义) */
.methodology-badge-pass{background:var(--green-bg);color:var(--green)}
.methodology-badge-warn{background:var(--yellow-bg);color:var(--yellow)}
.methodology-badge-fail{background:var(--red-bg);color:var(--red)}
.methodology-badge-skip{background:var(--bg-soft);color:var(--text-muted)}
.methodology-body{padding:0 16px 14px;border-top:1px solid var(--border);margin-top:8px}
.methodology-body>h2:first-child{margin-top:14px}

/* Cards */
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0}
.card{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px;min-width:140px;flex:1;transition:border-color 0.15s}
.card:hover{border-color:var(--border-hover)}
/* 卡片标签:de-uppercase(uppercase 在 pantone 哑色调里太"科技报"),轻微 letter-spacing
   保留排版感,字号上调到 12 让读者看清。值/数字改 weight 600(700 在浅色配色里太硬)。 */
.card-label{font-size:12px;color:var(--text-muted);letter-spacing:0.02em;margin-bottom:4px;font-weight:500}
.card-value{font-size:20px;font-weight:600;margin:2px 0;color:var(--text-primary);font-variant-numeric:tabular-nums;line-height:1.3}
.card-sub{font-size:12px;color:var(--text-muted);line-height:1.5}
/* Summary table — inherits the global center + middle from the base td/th. */
.summary-cell{min-width:96px}
.summary-value-primary{font-size:1.25rem;font-weight:600;font-variant-numeric:tabular-nums}

/* Hint tooltip (legacy span-based, kept for hover-only hints) */
.hint{position:relative;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;font-size:10px;font-weight:600;color:var(--text-muted);border:1px solid var(--border-hover);border-radius:50%;cursor:help;margin-left:6px;vertical-align:middle}
.hint-click{cursor:pointer}

/* Hint button — accessible, keyboard-focusable replacement for click-to-open-modal hints */
button.hint-btn{display:inline-flex;align-items:center;justify-content:center;min-width:20px;min-height:20px;padding:2px;font-size:11px;font-weight:600;color:var(--text-muted);background:transparent;border:1px solid var(--border);border-radius:50%;cursor:pointer;margin-left:6px;vertical-align:middle;line-height:1;transition:color 0.15s,border-color 0.15s;outline:none;appearance:none}
button.hint-btn:hover{color:var(--text-primary);border-color:var(--text-secondary)}
button.hint-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
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

/* v0.21 B.4 — Verdict pill (GitHub PR check 风, 水平 status banner + CTA + 层 strip).
   颜色严格按 level 编码: PROGRESS 绿, REGRESS 红, CAUTIOUS/UNDERPOWERED 黄,
   NOISE/SOLO 用 secondary 而非 muted (深底下保证对比度). border-left 4px 是
   status 视觉信号, 不堆边框/卡片 — 整体融入页面排版. */
.verdict-banner{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:12px 18px;margin:12px 0 0;border-left:4px solid var(--text-secondary);background:rgba(99,112,131,.06);border-radius:var(--radius)}
.verdict-banner.verdict-PROGRESS{border-left-color:var(--green);background:rgba(31,157,99,.07)}
.verdict-banner.verdict-REGRESS{border-left-color:var(--red);background:rgba(220,38,38,.07)}
.verdict-banner.verdict-CAUTIOUS{border-left-color:var(--yellow);background:rgba(217,119,6,.07)}
.verdict-banner.verdict-UNDERPOWERED{border-left-color:var(--yellow);background:rgba(217,119,6,.04)}
.verdict-banner.verdict-NOISE{border-left-color:var(--text-secondary);background:rgba(99,112,131,.06)}
.verdict-banner.verdict-SOLO{border-left-color:var(--border-hover);background:transparent}
.verdict-icon{font-size:12px;line-height:1;flex-shrink:0}
.verdict-line{font-size:14px;font-weight:500;color:var(--text-primary);line-height:1.6;letter-spacing:-0.005em}

/* page-verdict: verdict 是报告的「答案」,头部 hero 形式呈现.
   行 1: enum + ship-action badge (PROGRESS · SHIP) + 自然语言 ("明显更好,可以发布")
   行 2: Δ / 95% CI / N / CV — 测量学核心数字, 不需要滚到下方表才看到.
   颜色按 level 编码 (PROGRESS 绿 / REGRESS 红 / CAUTIOUS+UNDERPOWERED 黄 / NOISE+SOLO 中性). */
/* 结论卡内的 verdict —— 不再用「卡中卡」式的 tint 盒子,改成干净的一行结论:
   level 色 chip + 一句话。颜色靠 chip 传达,无外框/无左色条。 */
.page-verdict{display:flex;flex-direction:column;gap:8px;margin:0 0 14px}
.page-verdict-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.page-verdict-badge{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;padding:4px 11px;border-radius:13px;background:var(--bg-soft);color:var(--text-secondary);white-space:nowrap;letter-spacing:.01em}
.verdict-PROGRESS .page-verdict-badge{background:var(--green-bg);color:var(--green)}
.verdict-REGRESS .page-verdict-badge{background:var(--red-bg);color:var(--red)}
.verdict-CAUTIOUS .page-verdict-badge,
.verdict-UNDERPOWERED .page-verdict-badge{background:var(--yellow-bg);color:var(--yellow)}
.verdict-NOISE .page-verdict-badge,
.verdict-SOLO .page-verdict-badge{background:var(--bg-soft);color:var(--text-secondary)}
.page-verdict-badge-dot{font-size:8px;line-height:1}
.page-verdict-text{font-size:14.5px;font-weight:500;color:var(--text-primary);line-height:1.55;flex:1 1 auto;min-width:0}
.page-verdict-metrics{display:flex;flex-wrap:wrap;gap:10px 20px;align-items:baseline;padding-top:2px}
.verdict-metric{display:inline-flex;align-items:baseline;gap:6px}
.verdict-metric-label{font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.06em;font-weight:600}
.verdict-metric-value{font-size:15px;font-weight:700;color:var(--text-primary);font-variant-numeric:tabular-nums;letter-spacing:-0.01em}

.verdict-cta{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:10px 18px;margin:0;border-left:4px solid var(--accent);background:var(--bg-surface);border-top:1px solid var(--border);border-radius:0}
.verdict-cta.verdict-cta-PROGRESS{border-left-color:var(--green);background:rgba(31,157,99,.04)}
.verdict-cta.verdict-cta-REGRESS{border-left-color:var(--red);background:rgba(220,38,38,.04)}
.verdict-cta.verdict-cta-CAUTIOUS{border-left-color:var(--yellow);background:rgba(217,119,6,.04)}
.verdict-cta.verdict-cta-NOISE,
.verdict-cta.verdict-cta-UNDERPOWERED,
.verdict-cta.verdict-cta-SOLO{border-left-color:var(--text-secondary)}
.verdict-cta-icon{font-size:13px;flex-shrink:0;color:var(--text-secondary)}
.verdict-cta-PROGRESS .verdict-cta-icon{color:var(--green)}
.verdict-cta-REGRESS .verdict-cta-icon{color:var(--red)}
.verdict-cta-CAUTIOUS .verdict-cta-icon{color:var(--yellow)}
.verdict-cta-action{font-size:13px;font-weight:700;color:var(--text-primary);letter-spacing:0.04em;text-transform:uppercase;white-space:nowrap}
.verdict-cta-detail{font-size:13px;color:var(--text-secondary);line-height:1.55;flex:1 1 200px;min-width:0}

.verdict-layers{display:flex;align-items:baseline;gap:10px;padding:6px 18px 0;margin:0 0 16px;border-left:4px solid transparent;flex-wrap:wrap}
.verdict-layers-label{font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);font-weight:500}
.verdict-layers-content{font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums}

/* v0.21 B.4 — 列表页 RUN ID 旁的 verdict status pill. inline-flex 紧凑 pill,
   颜色编码同 banner, 字号微小但对比清晰. 鼠标悬停/键盘聚焦时不抢戏 — 它只是
   "这个 run 是什么 status" 的一眼瞥. */
.run-status{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:1px 8px;border-radius:var(--radius);margin-right:8px;line-height:1.5;letter-spacing:-0.005em;white-space:nowrap;color:var(--text-secondary);background:rgba(99,112,131,.1);vertical-align:1px}
.run-status .run-status-dot{font-size:8px;line-height:1}
.run-status.verdict-PROGRESS{color:var(--green);background:rgba(31,157,99,.12)}
.run-status.verdict-REGRESS{color:var(--red);background:rgba(220,38,38,.12)}
.run-status.verdict-CAUTIOUS{color:var(--yellow);background:rgba(251,191,36,0.12)}
.run-status.verdict-UNDERPOWERED{color:var(--yellow);background:rgba(251,191,36,0.08)}
.run-status.verdict-NOISE{color:var(--text-secondary);background:rgba(99,112,131,.1)}
.run-status.verdict-SOLO{color:var(--text-muted);background:transparent;border:1px solid var(--border)}

@media print{
  .verdict-banner,.verdict-cta{break-inside:avoid;page-break-inside:avoid}
  .run-status{border:1px solid #d1d5db;background:transparent !important}
}

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
.summary-value{font-size:15px;font-weight:600;color:var(--text-primary);font-variant-numeric:tabular-nums}
.summary-detail{font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.5}
.summary-unit{font-size:12px;font-weight:400;color:var(--text-muted)}
.card-detail{margin-top:8px;font-size:12px;color:var(--text-secondary)}
.card-detail div{margin:2px 0}

/* Table */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:16px 0;position:relative}
/* 窄屏下 6 列宽 >700px 会横向溢出,右侧稳定性列容易被遮盖。
   加一条渐变阴影作为"可滑动"视觉提示,仅在 ≤768px 且可滚动容器里显示。 */
@media(max-width:768px){
  .table-wrap::after{content:'';position:sticky;right:0;top:0;display:block;float:right;width:32px;height:100%;margin-left:-32px;margin-top:-100%;pointer-events:none;background:linear-gradient(to right,transparent,var(--bg-card) 85%);z-index:2}
}
/* 表格 — 稍紧凑(padding 7px 12px),正文 13px,字号上调跟全站对齐;
   非数字列保留 left-align(td.text 类),其它默认居中。 */
table{border-collapse:collapse;width:100%;font-size:13px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;line-height:1.5}
th{background:var(--bg-elevated);padding:8px 12px;text-align:center;vertical-align:middle;font-weight:600;color:var(--text-secondary);border-bottom:1px solid var(--border);font-size:12px;letter-spacing:0.02em;white-space:nowrap}
td{padding:7px 12px;border-bottom:1px solid var(--border);color:var(--text-secondary);font-variant-numeric:tabular-nums;text-align:center;vertical-align:middle}
td:first-child, th:first-child { text-align:left }
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(99,112,131,.04)}

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
input[type="text"]{background:var(--bg-surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:6px 12px;font-size:13px;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
input[type="text"]:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--info-bg)}
/* 通用 button — 浅色主题里默认 transparent + 边框更细。子样式(.run-card-delete,
   .hint-btn 等)各自有显式 reset 覆盖默认样式。 */
button{background:var(--bg-surface);border:1px solid var(--border);color:var(--text-secondary);border-radius:var(--radius);cursor:pointer;padding:6px 14px;font-size:13px;font-family:inherit;transition:border-color .15s,color .15s,background .15s;outline:none;appearance:none;-webkit-appearance:none}
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
  .dim-tag{background:#eef2ff;color:#6366f1}
  .meta-tag{background:#f8fafc;border-color:#e2e8f0;color:#475569}
  .bar-fill{opacity:1}
  a{color:#1e293b;text-decoration:none}
  .lang-toggle,.btn-danger,.nav{display:none}
  .hint-tip{display:none}
  .footer{color:#475569}
}
</style></head><body>${appBar}<div class="app-main">${body}<footer class="footer" style="margin-top:40px;padding-top:16px;border-top:1px solid var(--border);font-size:11px;color:var(--text-faint);text-align:center">Powered by oh-my-knowledge</footer></div>${langToggleScript()}</body></html>`;
}
