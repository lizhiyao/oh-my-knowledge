import { DEFAULT_LANG, layout, e } from './layout.js';
import type { Lang } from '../types/index.js';
import { severityReasonFor } from '../observability/inbox.js';
import type { ObservationInboxItem } from '../observability/inbox.js';
import type { ObservationInboxViewModel } from '../observability/inbox-view-model.js';
import { findNegativeFeedbackMatches, findPositiveFeedbackMatches, findUserCorrectionMatches, findUserGoalShiftMatches, hasUserCorrectionSignal, hasUserGoalShiftSignal } from '../observability/experience.js';
import { observationMetricAnnotationTargetId, type ObservationMetricKey } from '../observability/review-state.js';
import type {
  ExperienceAssistiveInference,
  ExperienceAssistiveInferenceCautionCode,
  ExperienceAssistiveInferenceCode,
  ExperienceEvidenceChain,
  ExperienceReviewIndicators,
  ExperienceReviewBasisCode,
  ExperienceReviewPriority,
  ExperienceRuleFinding,
  ExperienceRuleFindingCode,
  ExperienceRuleFindingLevel,
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
} from '../observability/experience.js';

export function renderObservationInboxPage(model: ObservationInboxViewModel, lang: Lang = DEFAULT_LANG): string {
	  const {
	    activeSkill,
	    allItems,
	    items,
    reports,
    experienceReports,
    skillInvocationCounts,
    skillSessionCounts,
    skillInvocationLastSeen,
    skillToolCallCounts,
    skillChains,
    totalSkillInvocations,
    severitySkillCounts,
    skillCount,
    reportCount,
    latestSeenLabel,
	    reviewState,
	  } = model;
	  const experience = experienceReports.find((report) => report.skills.length > 0 || report.sessions.length > 0 || report.invocations.length > 0);
	  const pageTitle = activeSkill ? `Observe Inbox · ${activeSkill}` : 'Observe Inbox';
  const experienceToolCountsBySkill = new Map<string, Record<string, number>>();
  const experienceEntrypointCountsBySkill = new Map<string, Record<string, number>>();
  const experienceSkillOriginCountsBySkill = new Map<string, Record<string, number>>();
  const experienceAttributionCountsBySkill = new Map<string, Record<string, number>>();
  for (const invocation of experience?.invocations ?? []) {
    const toolCounts = experienceToolCountsBySkill.get(invocation.skillName) ?? {};
    for (const [tool, count] of Object.entries(invocation.toolCounts ?? {})) {
      toolCounts[tool] = (toolCounts[tool] ?? 0) + count;
    }
    experienceToolCountsBySkill.set(invocation.skillName, toolCounts);

    const entrypoint = invocation.entrypoint ?? invocation.sourceKind ?? 'unknown';
    const entrypointCounts = experienceEntrypointCountsBySkill.get(invocation.skillName) ?? {};
    entrypointCounts[entrypoint] = (entrypointCounts[entrypoint] ?? 0) + 1;
    experienceEntrypointCountsBySkill.set(invocation.skillName, entrypointCounts);

    const originLabel = invocation.attribution.pluginName
      ? `Skill 来源：插件 ${invocation.attribution.pluginName}`
      : 'Skill 来源：本地 skill';
    const originCounts = experienceSkillOriginCountsBySkill.get(invocation.skillName) ?? {};
    originCounts[originLabel] = (originCounts[originLabel] ?? 0) + 1;
    experienceSkillOriginCountsBySkill.set(invocation.skillName, originCounts);

    const attributionMethod = invocation.attribution.source === 'command-name'
      ? '通过斜杠命令触发'
      : invocation.attribution.source === 'skill-tool'
        ? '通过 Skill 工具启动'
        : invocation.attribution.source === 'read-skill-md'
          ? '通过读取 Skill 文档推断'
          : invocation.attribution.source === 'general'
            ? '未识别到明确触发方式'
            : invocation.attribution.source || '未记录触发方式';
    const attributionTarget = invocation.attribution.commandName ?? invocation.attribution.rawSkillRef ?? invocation.skillName;
    const attributionLabel = attributionTarget ? `${attributionMethod}：${attributionTarget}` : attributionMethod;
    const attributionCounts = experienceAttributionCountsBySkill.get(invocation.skillName) ?? {};
    attributionCounts[attributionLabel] = (attributionCounts[attributionLabel] ?? 0) + 1;
    experienceAttributionCountsBySkill.set(invocation.skillName, attributionCounts);
  }
  const countSkillsBySeverity = (...severities: ObservationInboxItem['severity'][]): number =>
    new Set(allItems.filter((item) => severities.includes(item.severity)).map((item) => item.skillName)).size;
  const skillAnchor = (skillName: string): string => `skill-${skillName.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'}`;
  const experienceSkillAnchor = (skillName: string): string => `exp-${skillAnchor(skillName)}`;
  const renderJson = (value: unknown): string =>
    `<pre style="margin:8px 0 0;padding:10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.45;max-height:520px;overflow:auto;text-align:left">${e(JSON.stringify(value, null, 2))}</pre>`;
  const renderField = (label: string, value: unknown): string => {
    if (value == null || value === '') return '';
    return `<div style="margin:4px 0;text-align:left"><span style="color:var(--text-muted);font-size:11px">${e(label)}</span><div style="font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;text-align:left;color:var(--text-secondary)">${e(String(value))}</div></div>`;
  };
  const renderArtifactVersion = (value: string): string => {
    if (value === 'unknown') {
      return `<div style="margin:4px 0;text-align:left"><span style="color:var(--text-muted);font-size:11px">artifactVersion</span><div style="font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;color:var(--yellow);font-weight:600;text-align:left">⚠ unknown</div></div>`;
    }
    return renderField('artifactVersion', value);
  };
  const reviewSeverityMeta = (item: ObservationInboxItem): { label: string; decision: string; color: string; bg: string } => {
    if (item.severity === 'high') {
      return { label: '高风险/需关注', decision: '优先看，可能要补 SKILL.md 或改 skill 说明', color: 'var(--red)', bg: 'rgba(220,38,38,.08)' };
    }
    if (item.severity === 'medium') {
      return { label: '低风险/抽样确认', decision: '通常不需要改 skill；抽样确认是否反复浪费时间', color: 'var(--yellow)', bg: 'rgba(202,138,4,.10)' };
    }
    if (item.severity === 'low') {
      return { label: '不确定/低优先级', decision: '模型只是说不确定，不一定需要改 skill', color: 'var(--accent)', bg: 'rgba(37,99,235,.08)' };
    }
    return { label: '无异常/无需改 skill', decision: '更像路径、权限、文件太大或工具限制；先不当成 skill 内容缺失', color: 'var(--text-muted)', bg: 'var(--bg-muted)' };
  };
  const renderSeverityBadge = (item: ObservationInboxItem): string => {
    const meta = reviewSeverityMeta(item);
    return `<div style="display:flex;flex-direction:column;gap:3px">
      <span style="display:inline-flex;align-items:center;width:max-content;max-width:190px;padding:3px 7px;border-radius:999px;background:${meta.bg};color:${meta.color};font-weight:650;white-space:normal">${e(meta.label)}</span>
      <span style="color:var(--text-muted);font-size:11px">${e(meta.decision)}</span>
    </div>`;
  };
  const semanticEvidence = (item: ObservationInboxItem): string => {
    const tool = item.evidence.tool || 'Tool';
    const target = item.evidence.query || item.evidence.path || item.evidence.assistantSnippet || '';
    if (item.signalSubtype === 'tool_limit') return `${tool} 触发工具限制：${item.evidence.outputSnippet || target}`;
    if (item.signalSubtype === 'transient_file_missing') return `${tool} 访问了临时文件但文件不存在：${item.evidence.path || target}`;
    if (item.signalSubtype === 'skill_asset_read_failed') return `${tool} 读取该 skill 自身资源失败：${item.evidence.path || target}`;
    if (item.signalSubtype === 'not_found') return `${tool} 访问了不存在的路径：${item.evidence.path || target}`;
    if (item.signalSubtype === 'permission_denied') return `${tool} 被权限拒绝：${item.evidence.path || target}`;
    if (item.signalSubtype === 'bash_probe') return `skill 运行过程中，agent 调用了一条 Bash 命令：${item.evidence.query || target}`;
    if (item.signalSubtype === 'hard_miss') return `${tool} 未命中且后续未找到同主题成功证据：${target}`;
    if (item.signalSubtype === 'exploratory_miss') return `${tool} 前序未命中，但后续有成功搜索证据：${target}`;
    return target || item.evidence.outputSnippet || '';
  };
  const evidenceConclusion = (item: ObservationInboxItem): string => {
    if (item.signalSubtype === 'bash_probe') return 'skill 运行过程中，agent 调用了一条 Bash 命令。';
    if (item.signalSubtype === 'tool_limit') return `${item.evidence.tool || '工具'} 触发了文件太长、token 或超时限制。`;
    if (item.signalSubtype === 'transient_file_missing') return `${item.evidence.tool || '工具'} 访问了临时文件，但文件不存在。`;
    if (item.signalSubtype === 'skill_asset_read_failed') return `${item.evidence.tool || '工具'} 读取该 skill 自身资源失败。`;
    if (item.signalSubtype === 'not_found') return `${item.evidence.tool || '工具'} 访问了不存在的路径。`;
    if (item.signalSubtype === 'permission_denied') return `${item.evidence.tool || '工具'} 被权限拒绝。`;
    if (item.signalSubtype === 'hard_miss') return `${item.evidence.tool || '工具'} 没有拿到有效结果，后续也没有看到同主题成功证据。`;
    if (item.signalSubtype === 'exploratory_miss') return `${item.evidence.tool || '工具'} 前面没有拿到结果，但后续找到了相关内容。`;
    if (item.signalType === 'hedging') return '模型文本里出现了不确定表达。';
    if (item.signalType === 'explicit_marker') return '模型文本里出现了显式标记。';
    return semanticEvidence(item);
  };
  const evidenceQuote = (item: ObservationInboxItem): string => {
    return item.evidence.query || item.evidence.path || item.evidence.assistantSnippet || item.evidence.outputSnippet || '';
  };
  const quoteFromEvidence = (evidence: ObservationInboxItem['evidence']): string =>
    evidence.query || evidence.path || evidence.assistantSnippet || evidence.outputSnippet || '';
  const renderEvidenceDetailList = (item: ObservationInboxItem): string => {
    const entries = item.representativeEvidence.length > 0 ? item.representativeEvidence : [item.evidence];
    return `<div style="display:flex;flex-direction:column;gap:8px">
      ${entries.map((ev, i) => {
        const quote = quoteFromEvidence(ev);
        const output = ev.outputSnippet && ev.outputSnippet !== quote ? ev.outputSnippet : '';
        return `<div style="padding:9px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);text-align:left">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:5px">
            <span style="font-size:12px;color:var(--text-primary);font-weight:650">Evidence ${i + 1}</span>
            <span style="font-size:11px;color:var(--text-muted);font-family:ui-monospace,monospace">${e(ev.tool || item.signalType)}${ev.markerToken ? ` · ${e(ev.markerToken)}` : ''}</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);line-height:1.45;margin-bottom:5px">${e(evidenceConclusion({ ...item, evidence: ev }))}</div>
          ${quote ? `<pre style="margin:0;padding:8px;background:var(--bg-muted);border-radius:5px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;font-size:11px;line-height:1.45;color:var(--text-primary);max-height:180px;overflow:auto">${e(quote)}</pre>` : ''}
          ${output ? `<div style="margin-top:6px;color:var(--text-muted);font-size:11px">输出片段</div><pre style="margin:3px 0 0;padding:8px;background:var(--bg-muted);border-radius:5px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;font-size:11px;line-height:1.45;color:var(--text-secondary);max-height:140px;overflow:auto">${e(output)}</pre>` : ''}
        </div>`;
      }).join('')}
    </div>`;
  };
  const renderEvidenceCell = (item: ObservationInboxItem, max = 220): string => {
    const quote = evidenceQuote(item);
    return `<div style="max-width:360px">
      <div style="font-size:12px;line-height:1.45;color:var(--text-primary)">${e(evidenceConclusion(item))}</div>
      ${quote ? `<code style="display:block;margin-top:5px;font-family:ui-monospace,monospace;font-size:11px;line-height:1.45;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--bg-muted);padding:4px 6px;border-radius:4px">${e(quote.slice(0, max))}</code>` : ''}
    </div>`;
  };
  const signalRuleDescription = (item: ObservationInboxItem): string => {
    const reason = severityReasonFor(item, lang);
    const meta = reviewSeverityMeta(item);
    const prefix = `${meta.label}: ${item.signalType}/${item.signalSubtype}, confidence=${item.confidence.toFixed(2)}.`;
    return `${prefix} ${reason}`;
  };
  const renderSignalLabel = (item: ObservationInboxItem): string => {
    const desc = signalRuleDescription(item);
    return `<span style="position:relative;display:inline-flex;align-items:center;gap:4px;overflow:visible">
      <span>${e(item.signalType)}</span>
      <span class="signal-help" tabindex="0" data-signal-title="${e(`${item.signalType}/${item.signalSubtype}`)}" data-signal-description="${e(desc)}" aria-label="${e(desc)}" style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border:1px solid var(--border);border-radius:50%;font-size:10px;line-height:15px;color:var(--text-muted);cursor:help;vertical-align:top">?</span>
    </span><br><span style="color:var(--text-muted);font-size:11px">OMK subtype: ${e(item.signalSubtype)}</span>`;
  };
  const renderOccurrences = (item: ObservationInboxItem): string => {
    const text = `出现次数=${item.occurrences}。这是按 skill + cwd + signal + subtype + query/path 归一化去重后的聚合次数，不是样本量。`;
    return `<div style="text-align:right">
      <div style="font-weight:700">${item.occurrences}</div>
      <div title="${e(text)}" style="color:var(--text-muted);font-size:11px;line-height:1.35;max-width:92px;margin-left:auto">同类事件次数</div>
    </div>`;
  };
  const renderSourceBadge = (item: ObservationInboxItem): string => {
    const label = item.sourceKind === 'markdown_log' ? 'Markdown log' : item.sourceKind === 'claude' ? 'Claude' : 'Unknown';
    const color = item.sourceKind === 'markdown_log' ? 'var(--green)' : item.sourceKind === 'claude' ? 'var(--accent)' : 'var(--text-muted)';
    return `<span title="调用日志来源：${e(label)}" style="display:inline-flex;margin-top:4px;padding:2px 6px;border-radius:999px;background:var(--bg-muted);color:${color};font-size:11px;font-weight:650">${e(label)}</span>`;
  };
  const confidenceHeaderHelp = '判断把握：OMK 对“这条 过程发现 是否需要处理/是否高风险/需关注”的规则判断有多确定。归属把握：OMK 把这条 过程发现 归到当前 skill 名下有多确定，例如明确调用 skill 通常更高。';
  type IndicatorHelpKey =
    | 'userCorrection' | 'userInterruption' | 'userFollowUp' | 'negativeFeedback' | 'positiveFeedback' | 'userGoalShift' | 'hardRule'
    | 'toolCall' | 'toolFailure' | 'highObservation' | 'mediumObservation' | 'hedging' | 'explicitMarker'
    | 'bash' | 'read' | 'grep' | 'bashProbe' | 'notFound' | 'toolLimit';
  const indicatorLabels: Record<IndicatorHelpKey, string> = {
    userCorrection: '用户纠正',
    userInterruption: '人工中断',
    userFollowUp: '追问/补充',
    negativeFeedback: '负向反馈',
    positiveFeedback: '正向反馈',
    userGoalShift: '用户切换目标',
    hardRule: '用户硬性要求',
    toolCall: '工具调用',
    toolFailure: '工具执行失败',
    highObservation: '高优先级过程发现',
    mediumObservation: '低风险/抽样过程发现',
    hedging: '不确定表达',
    explicitMarker: '显式缺口',
    bash: 'Bash 调用',
    read: 'Read 调用',
    grep: 'Grep 调用',
    bashProbe: 'Bash 试探',
    notFound: '路径不存在',
    toolLimit: '工具限制',
  };
  const indicatorHelps: Record<IndicatorHelpKey, string> = {
    userCorrection: '只统计人工用户消息里的明确纠偏表达。短词“不对 / 不是 / 错了”必须前后有空格、逗号、句号、问号等分隔；“不对称”“是不是”不会算纠正。',
    userInterruption: '统计 Claude trace 里的 “[Request interrupted by user]” 等用户主动中断事件，表示当前执行被人工叫停。',
    userFollowUp: '同一个 skill 复盘片段内，第 2 条及之后的人工用户消息计入追问或补充。Skill 注入上下文不计入。',
    negativeFeedback: '统计“没用 / 垃圾 / 菜 / 做错了 / 不行 / 失败 / 看不懂 / 有问题”等负向表达。这是规则命中，不是 LLM 情绪识别。',
    positiveFeedback: '统计“很好 / good job / 做得好 / 很棒 / 优秀 / 厉害 / 很有用 / 很有价值”等正向表达，用来保留用户认可证据。',
    userGoalShift: '统计“换个方向 / 先不 / 不用这个 / 另一个问题”等目标切换表达。它表示当前目标可能中止或切走，不直接等同于 skill 做错。',
    hardRule: '统计用户在对话里临时提出的硬性要求，例如“必须 / 不要 / 禁止 / 严格 / 一定要 / 只允许”。Skill 自身的强约束请看 Context Chain 里的 hardRules。',
    toolCall: '统计该 skill 运行片段里的 tool_use 调用总数，包括 Bash、Read、Grep 等工具。',
    toolFailure: '统计该 skill 运行片段里失败的工具执行结果，例如 tool_result 标记 is_error=true。注意：工具执行失败不等于整个 skill 调用失败。',
    highObservation: '统计 severity=high 的过程发现，通常表示可能需要优先复盘的执行问题。',
    mediumObservation: '统计 severity=medium/low 的过程发现，通常进入抽样复盘，不直接等同于必须改 skill。',
    hedging: '统计回答或过程发现里的“不确定 / 可能 / 需要确认”等低置信文本信号。',
    explicitMarker: '统计回答或过程发现里明确出现“未知 / 知识缺口 / 没覆盖”等显式标记。',
    bash: '统计该 skill 运行期间调用 Bash 工具的次数。',
    read: '统计该 skill 运行期间调用 Read 工具的次数。',
    grep: '统计该 skill 运行期间调用 Grep 工具的次数。',
    bashProbe: '统计过程发现中被判断为 Bash 试探的次数，例如命令看起来是在试目录、试路径或探测环境。',
    notFound: '统计过程发现中路径或文件不存在的次数。',
    toolLimit: '统计文件太长、token 上限、超时等工具限制导致的问题。',
  };
  const metric = (label: string, value: number, helpKey: IndicatorHelpKey, title?: string): string =>
    `<button type="button" class="metric-item" data-metric-key="${helpKey}" onclick="openMetricGuide('${helpKey}')" title="${e(title ?? `点击查看“${label}”指标说明`)}"><span>${e(label)}</span> <strong>${value}</strong></button>`;
  const formatEntrypoint = (value?: string): string => {
    const labels: Record<string, string> = {
      'claude-desktop': 'Claude Code App',
      cli: 'Claude CLI',
      'sdk-ts': 'Claude SDK',
      markdown_log: 'Markdown 日志',
    };
    return value ? (labels[value] ?? value) : '未记录';
  };
  const formatAttributionSource = (value?: string): string => {
    if (value === 'command-name') return '通过斜杠命令触发';
    if (value === 'skill-tool') return '通过 Skill 工具启动';
    if (value === 'read-skill-md') return '通过读取 Skill 文档推断';
    if (value === 'general') return '未识别到具体 skill';
    return value || '未记录';
  };
  const renderInvocationSummary = (
    indicators: { userInterruptionCount: number; toolFailureCount: number; toolCallCount: number },
    invocationCount: number,
  ): string => {
    const total = indicators.toolCallCount;
    const failed = Math.max(0, indicators.toolFailureCount);
    const interrupted = Math.max(0, indicators.userInterruptionCount);
    const success = Math.max(0, total - failed);
    const pct = (value: number): string => total > 0 ? `${Math.round(value / total * 100)}%` : '—';
    return `<div class="invocation-summary" title="这是 trace 中可观测到的调用过程汇总。工具执行失败/人工中断是过程信号，不直接等同于整个 skill 失败或用户目标失败。">
      <div class="invocation-total">工具调用总次数 <strong>${total}</strong></div>
      <div class="invocation-breakdown">
        <span>工具执行成功 ${success} / ${pct(success)}</span>
        <span>工具执行失败 ${failed} / ${pct(failed)}</span>
        <span>人工中断 ${interrupted} / ${pct(interrupted)}</span>
      </div>
      <div class="invocation-footnote">Skill 调用段 ${invocationCount}</div>
    </div>`;
  };
  const pct = (value: number, total: number): string => total > 0 ? `${Math.round(value / total * 100)}%` : '—';
  const renderShare = (count: number, total: number): string => {
    const safeTotal = Math.max(total, count);
    return `<span class="summary-count">${count}</span><span class="summary-pct">/ ${pct(count, safeTotal)}</span>`;
  };
  const renderMetric = (label: string, count: number, unit = ''): string =>
    `<span class="summary-metric"><span class="summary-name">${e(label)}</span><span class="summary-count">${count}</span>${unit ? `<span class="summary-unit-text">${e(unit)}</span>` : ''}</span>`;
  const renderMetricShare = (label: string, count: number, total: number): string =>
    `<span class="summary-metric"><span class="summary-name">${e(label)}</span>${renderShare(count, total)}</span>`;
  const renderRankedCounts = (
    counts: Record<string, number> | undefined,
    total: number,
    options: { max?: number; label?: (key: string) => string } = {},
  ): string => {
    const entries = Object.entries(counts ?? {})
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, options.max ?? 4);
    if (entries.length === 0) return '<span class="summary-muted">无明细</span>';
    return entries.map(([key, count]) => renderMetricShare(options.label ? options.label(key) : key, count, total)).join('<span class="summary-sep">，</span>');
  };
  const compactRankedCountText = (
    counts: Record<string, number> | undefined,
    options: { max?: number; label?: (key: string) => string } = {},
  ): string => {
    const entries = Object.entries(counts ?? {})
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, options.max ?? 2);
    if (entries.length === 0) return '未记录';
    return entries.map(([key, count]) => `${options.label ? options.label(key) : key} ${count}`).join('、');
  };
  const ZERO_DISPLAY_INDICATORS: ExperienceReviewIndicators = {
    userMessageCount: 0,
    userFollowUpCount: 0,
    userCorrectionCount: 0,
    userInterruptionCount: 0,
    negativeFeedbackCount: 0,
    positiveFeedbackCount: 0,
    userGoalShiftCount: 0,
    hardRuleTextHitCount: 0,
    toolCallCount: 0,
    toolFailureCount: 0,
    highObservationCount: 0,
    mediumObservationCount: 0,
    hedgingCount: 0,
    explicitMarkerCount: 0,
  };
  const USER_INTERRUPTION_DISPLAY_RE = /\[Request interrupted by user(?: for tool use)?\]|interrupted by user|用户中断/i;
  const HARD_RULE_DISPLAY_RE = /hard rules?|必须|不要|禁止|严格|一定要|务必|不得|不能|只允许/i;
  const displayRegexMatches = (pattern: RegExp, value: string): boolean => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  };
  const displayMetricVerdict = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey): 'confirmed' | 'rejected' | '' => {
    const targetId = observationMetricAnnotationTargetId(event, metricKey);
    const entry = reviewState.entries[`evidence_metric:${targetId}`];
    return entry?.verdict === 'confirmed' || entry?.verdict === 'rejected' ? entry.verdict : '';
  };
  const displayMetricIsActive = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, ruleDetected: boolean): boolean => {
    const verdict = displayMetricVerdict(event, metricKey);
    if (verdict === 'confirmed') return true;
    if (verdict === 'rejected') return false;
    return ruleDetected;
  };
  const displayMetricCount = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, ruleCount: number): number => {
    const verdict = displayMetricVerdict(event, metricKey);
    if (verdict === 'confirmed') return Math.max(1, ruleCount);
    if (verdict === 'rejected') return 0;
    return ruleCount;
  };
  const displayIndicatorsForSession = (session: ExperienceSessionSummary): ExperienceReviewIndicators => {
    const humanEvents = (session.timelinePreview ?? []).filter((event) => event.kind === 'user_message' && Boolean(event.snippet));
    return {
      ...session.indicators,
      userFollowUpCount: humanEvents.reduce((sum, event, index) => sum + (displayMetricIsActive(event, 'user_follow_up', index > 0) ? 1 : 0), 0),
      userCorrectionCount: humanEvents.reduce((sum, event) => sum + displayMetricCount(event, 'user_correction', findUserCorrectionMatches(event.snippet ?? '').length), 0),
      userInterruptionCount: humanEvents.reduce((sum, event) => sum + (displayMetricIsActive(event, 'user_interruption', displayRegexMatches(USER_INTERRUPTION_DISPLAY_RE, event.snippet ?? '')) ? 1 : 0), 0),
      negativeFeedbackCount: humanEvents.reduce((sum, event) => sum + displayMetricCount(event, 'negative_feedback', findNegativeFeedbackMatches(event.snippet ?? '').length), 0),
      positiveFeedbackCount: humanEvents.reduce((sum, event) => sum + displayMetricCount(event, 'positive_feedback', findPositiveFeedbackMatches(event.snippet ?? '').length), 0),
      userGoalShiftCount: humanEvents.reduce((sum, event) => sum + displayMetricCount(event, 'user_goal_shift', findUserGoalShiftMatches(event.snippet ?? '').length), 0),
      hardRuleTextHitCount: humanEvents.reduce((sum, event) => sum + (displayMetricIsActive(event, 'hard_rule', displayRegexMatches(HARD_RULE_DISPLAY_RE, event.snippet ?? '')) ? 1 : 0), 0),
    };
  };
  const sessionMetricSourceTitle = (session: ExperienceSessionSummary, metricKey: ObservationMetricKey, label: string): string => {
    const humanEvents = (session.timelinePreview ?? []).filter((event) => event.kind === 'user_message' && Boolean(event.snippet));
    const rows: string[] = [];
    let ruleCount = 0;
    let confirmed = 0;
    let rejected = 0;
    let finalCount = 0;
    humanEvents.forEach((event, index) => {
      const text = event.snippet ?? '';
      const rule = metricKey === 'user_follow_up'
        ? (index > 0 ? 1 : 0)
        : metricKey === 'user_correction'
          ? findUserCorrectionMatches(text).length
          : metricKey === 'user_interruption'
            ? (displayRegexMatches(USER_INTERRUPTION_DISPLAY_RE, text) ? 1 : 0)
            : metricKey === 'negative_feedback'
              ? findNegativeFeedbackMatches(text).length
              : metricKey === 'positive_feedback'
                ? findPositiveFeedbackMatches(text).length
                : metricKey === 'hard_rule'
                  ? (displayRegexMatches(HARD_RULE_DISPLAY_RE, text) ? 1 : 0)
                  : metricKey === 'user_goal_shift'
                    ? findUserGoalShiftMatches(text).length
                    : 0;
      const verdict = displayMetricVerdict(event, metricKey);
      const finalValue = displayMetricCount(event, metricKey, rule);
      ruleCount += rule;
      if (verdict === 'confirmed') confirmed += 1;
      if (verdict === 'rejected') rejected += 1;
      finalCount += finalValue;
      if (rule > 0 || verdict) {
        rows.push(`#${event.messageIndex ?? '—'} ${verdict === 'confirmed' ? '人工同意' : verdict === 'rejected' ? '人工反对' : '规则命中'}：${text.slice(0, 80).replace(/\s+/g, ' ')}`);
      }
    });
    return [
      `${label}：最终计入 ${finalCount}`,
      `规则命中 ${ruleCount}，人工同意 ${confirmed}，人工反对 ${rejected}`,
      rows.length > 0 ? `来源：${rows.join('；')}` : '来源：无',
      '点击按钮查看指标定义；人工反对只扣掉对应 message，不会自动扣掉其它来源。',
    ].join('\n');
  };
  const displayIndicatorsBySkill = new Map<string, ExperienceReviewIndicators>();
  for (const session of experience?.sessions ?? []) {
    const current = displayIndicatorsBySkill.get(session.skillName) ?? { ...ZERO_DISPLAY_INDICATORS };
    const next = displayIndicatorsForSession(session);
    displayIndicatorsBySkill.set(session.skillName, {
      userMessageCount: current.userMessageCount + next.userMessageCount,
      userFollowUpCount: current.userFollowUpCount + next.userFollowUpCount,
      userCorrectionCount: current.userCorrectionCount + next.userCorrectionCount,
      userInterruptionCount: current.userInterruptionCount + next.userInterruptionCount,
      negativeFeedbackCount: current.negativeFeedbackCount + next.negativeFeedbackCount,
      positiveFeedbackCount: current.positiveFeedbackCount + next.positiveFeedbackCount,
      userGoalShiftCount: current.userGoalShiftCount + next.userGoalShiftCount,
      hardRuleTextHitCount: current.hardRuleTextHitCount + next.hardRuleTextHitCount,
      toolCallCount: current.toolCallCount + next.toolCallCount,
      toolFailureCount: current.toolFailureCount + next.toolFailureCount,
      highObservationCount: current.highObservationCount + next.highObservationCount,
      mediumObservationCount: current.mediumObservationCount + next.mediumObservationCount,
      hedgingCount: current.hedgingCount + next.hedgingCount,
      explicitMarkerCount: current.explicitMarkerCount + next.explicitMarkerCount,
    });
  }
  const displayBasisCodes = (indicators: ExperienceReviewIndicators): ExperienceReviewBasisCode[] => {
    const codes: ExperienceReviewBasisCode[] = [];
    if (indicators.highObservationCount > 0) codes.push('has_high_observation');
    if (indicators.mediumObservationCount > 0) codes.push('has_medium_observation');
    if (indicators.userCorrectionCount > 0) codes.push('user_correction');
    if (indicators.userInterruptionCount > 0) codes.push('user_interruption');
    if (indicators.negativeFeedbackCount > 0) codes.push('negative_feedback');
    if (indicators.hardRuleTextHitCount > 0) codes.push('hard_rule_text_hit');
    if (indicators.toolFailureCount > 0) codes.push('tool_failure');
    if (indicators.hedgingCount > 0) codes.push('hedging_signal');
    if (indicators.explicitMarkerCount > 0) codes.push('explicit_marker');
    return codes;
  };
  const displayPriority = (indicators: ExperienceReviewIndicators): ExperienceReviewPriority => {
    if (indicators.highObservationCount > 0 || indicators.userCorrectionCount > 0 || indicators.userInterruptionCount > 0 || indicators.negativeFeedbackCount > 0) return 'review_first';
    if (indicators.mediumObservationCount > 0 || indicators.toolFailureCount > 0 || indicators.hedgingCount > 0 || indicators.explicitMarkerCount > 0 || indicators.userGoalShiftCount > 0) return 'sample_review';
    return 'routine_sample';
  };
  const displayInferenceBasisCodes = (indicators: ExperienceReviewIndicators): ExperienceRuleFindingCode[] => {
    const codes: ExperienceRuleFindingCode[] = [];
    if (indicators.highObservationCount > 0) codes.push('high_observation_seen');
    if (indicators.userCorrectionCount > 0) codes.push('user_correction_seen');
    if (indicators.userInterruptionCount > 0) codes.push('user_interruption_seen');
    if (indicators.negativeFeedbackCount > 0) codes.push('negative_feedback_seen');
    if (indicators.toolFailureCount > 0) codes.push('tool_failure_seen');
    if (indicators.mediumObservationCount > 0) codes.push('medium_observation_seen');
    if (indicators.hedgingCount > 0) codes.push('hedging_seen');
    if (indicators.explicitMarkerCount > 0) codes.push('explicit_marker_seen');
    if (indicators.hardRuleTextHitCount > 0) codes.push('hard_rule_seen');
    if (indicators.positiveFeedbackCount > 0) codes.push('positive_feedback_seen');
    if (indicators.userGoalShiftCount > 0) codes.push('user_goal_shift_seen');
    return codes;
  };
  const displayAssistiveInference = (
    indicators: ExperienceReviewIndicators,
    fallback?: ExperienceAssistiveInference,
  ): ExperienceAssistiveInference => {
    const basisRuleCodes = displayInferenceBasisCodes(indicators);
    const code: ExperienceAssistiveInferenceCode =
      indicators.highObservationCount > 0 || indicators.userCorrectionCount > 0 || indicators.userInterruptionCount > 0 || indicators.negativeFeedbackCount > 0
        ? 'review_recommended'
        : indicators.mediumObservationCount > 0 || indicators.toolFailureCount > 0 || indicators.hedgingCount > 0 || indicators.explicitMarkerCount > 0
          ? 'sample_recommended'
          : indicators.positiveFeedbackCount > 0
            ? 'positive_signal_observed'
            : indicators.userGoalShiftCount > 0
              ? 'user_switched_topic_neutral'
              : 'no_obvious_issue_from_rules';
    return {
      mode: 'deterministic_rules_only',
      code,
      confidence: fallback?.confidence ?? 'medium',
      basisRuleCodes,
      cautionCodes: fallback?.cautionCodes ?? ['no_llm_judge', 'rule_only'],
      evidenceRefs: fallback?.evidenceRefs ?? [],
    };
  };
  const displayRuleFindings = (
    session: ExperienceSessionSummary,
    indicators: ExperienceReviewIndicators,
  ): ExperienceRuleFinding[] => {
    const old = session.ruleFindings ?? [];
    const oldByCode = new Map(old.map((finding) => [finding.code, finding]));
    const next: ExperienceRuleFinding[] = [];
    const push = (code: ExperienceRuleFindingCode, level: ExperienceRuleFindingLevel, count: number): void => {
      if (count <= 0) return;
      const previous = oldByCode.get(code);
      next.push({ code, level, count, evidenceRefs: previous?.evidenceRefs ?? [] });
    };
    push('high_observation_seen', 'attention', indicators.highObservationCount);
    push('user_correction_seen', 'attention', indicators.userCorrectionCount);
    push('user_interruption_seen', 'attention', indicators.userInterruptionCount);
    push('negative_feedback_seen', 'attention', indicators.negativeFeedbackCount);
    push('tool_failure_seen', 'sample', indicators.toolFailureCount);
    push('medium_observation_seen', 'sample', indicators.mediumObservationCount);
    push('hedging_seen', 'sample', indicators.hedgingCount);
    push('explicit_marker_seen', 'sample', indicators.explicitMarkerCount);
    push('hard_rule_seen', 'normal', indicators.hardRuleTextHitCount);
    push('positive_feedback_seen', 'normal', indicators.positiveFeedbackCount);
    push('user_goal_shift_seen', 'normal', indicators.userGoalShiftCount);
    for (const finding of old) {
      if ([
        'high_observation_seen',
        'user_correction_seen',
        'user_interruption_seen',
        'negative_feedback_seen',
        'tool_failure_seen',
        'medium_observation_seen',
        'hedging_seen',
        'explicit_marker_seen',
        'hard_rule_seen',
        'positive_feedback_seen',
        'user_goal_shift_seen',
        'no_priority_signal',
      ].includes(finding.code)) continue;
      next.push(finding);
    }
    if (next.filter((finding) => finding.level !== 'normal').length === 0) {
      next.push({ code: 'no_priority_signal', level: 'normal', count: 1, evidenceRefs: [] });
    }
    return next;
  };
  const renderSkillEvidenceSummary = (skill: NonNullable<typeof experience>['skills'][number]): string => {
    const indicators = displayIndicatorsBySkill.get(skill.skillName) ?? skill.indicators;
    const toolCounts = Object.keys(skill.toolCounts ?? {}).length > 0
      ? skill.toolCounts
      : experienceToolCountsBySkill.get(skill.skillName);
    const total = indicators.toolCallCount;
    const failed = Math.max(0, indicators.toolFailureCount);
    const interrupted = Math.max(0, indicators.userInterruptionCount);
    const success = Math.max(0, total - failed);
    return `<div class="skill-evidence-summary">
      <div class="summary-row"><span class="summary-title">【skill 运行】</span>${renderMetric('调用段', skill.invocationCount, '次')}<span class="summary-muted">分布 ${skill.sessionCount} 个 session</span>${renderMetric('工具调用', total, '次')}${renderMetricShare('成功', success, total)}${renderMetricShare('失败', failed, total)}${renderMetricShare('人工中断', interrupted, total)}</div>
      <div class="summary-row"><span class="summary-title">【用户交互】</span>${renderMetric('用户纠正', indicators.userCorrectionCount)}${renderMetric('人工中断', indicators.userInterruptionCount)}${renderMetric('追问', indicators.userFollowUpCount)}${renderMetric('负向反馈', indicators.negativeFeedbackCount ?? 0)}${renderMetric('正向反馈', indicators.positiveFeedbackCount ?? 0)}${renderMetric('目标切换', indicators.userGoalShiftCount ?? 0)}</div>
      <div class="summary-row"><span class="summary-title">【工具调用】</span>${renderMetric('总计', total, '次')}<span class="summary-detail">(${renderRankedCounts(toolCounts, total)})</span>${renderMetricShare('工具执行失败', failed, total)}</div>
      <div class="summary-row"><span class="summary-title">【过程发现】</span>${renderMetric('高优先级', indicators.highObservationCount)}${renderMetric('用户硬性要求', indicators.hardRuleTextHitCount)}${renderMetric('不确定表达', indicators.hedgingCount)}${renderMetric('显式缺口', indicators.explicitMarkerCount)}</div>
    </div>`;
  };
  const renderSkillChainSummary = (skillName: string): string => {
    const chain = skillChains[skillName];
    if (!chain?.definition.found) {
      return `<span class="summary-muted">暂无输入来源</span>`;
    }
    const hard = chain.healthCheck.hardRules;
    const workflows = chain.healthCheck.workflows;
    const hardText = hard.declared
      ? `hardRules ${hard.count}（执行：暂不支持）${hard.valid ? '' : ' · 结构异常'}`
      : 'hardRules：暂无输入来源';
    const workflowText = workflows.declared
      ? `workflow 分支链路 ${workflows.branchCount}（执行节点：${workflows.nodeCount}）${workflows.valid ? '' : ' · 结构异常'}`
      : 'workflow：暂无输入来源';
    return `<div class="summary-detail">${e(hardText)}</div><div class="summary-detail" style="margin-top:3px">${e(workflowText)}</div>`;
  };
  const renderSkillChainButton = (skillName: string, templateId: string): string => {
    const chain = skillChains[skillName];
    const title = chain?.definition.found
      ? '查看 skill 定义、doctor 静态检查和 observe 运行时边界'
      : '当前没有找到该 skill 的 SKILL.md，只能显示暂无输入来源';
    return `<button type="button" class="context-chain-button" onclick="event.stopPropagation(); openContextChainModal('${e(templateId)}', this)" title="${e(title)}">运行时链路</button>`;
  };
  const renderSkillChainTemplate = (skillName: string): string => {
    const chain = skillChains[skillName];
    if (!chain) return `<div class="context-chain-grid"><section><h3>① skill 定义</h3><p>暂无输入来源。</p></section><section><h3>② 健康检查</h3><p>暂无输入来源。</p></section><section><h3>③ 运行时</h3><p>暂不支持。</p></section></div>`;
    const hard = chain.healthCheck.hardRules;
    const workflows = chain.healthCheck.workflows;
    const hardRulesList = hard.rules.length > 0
      ? `<ol>${hard.rules.map((rule) => `<li><strong>${e(rule.id)}</strong><div>${e(rule.rule)}</div><small>期望行为：${e(rule.expectedBehavior)}</small></li>`).join('')}</ol>`
      : '<p class="context-muted">暂无输入来源：该 skill 未声明结构化 hardRules。</p>';
    const workflowList = workflows.workflows.length > 0
      ? `<ol>${workflows.workflows.map((workflow) => `<li><strong>${e(workflow.id)}</strong>${workflow.description ? `<div>${e(workflow.description)}</div>` : ''}<small>执行节点：${workflow.nodes.length}</small><ul>${workflow.nodes.map((node) => `<li><code>${e(node.id)}</code> ${e(node.action)}</li>`).join('')}</ul></li>`).join('')}</ol>`
      : '<p class="context-muted">暂无输入来源：该 skill 未声明结构化 workflows。</p>';
    const healthRows = [
      ['hardRules', hard.declared ? `${hard.count} 条` : '暂无输入来源', hard.valid ? '结构合法' : `结构异常：${hard.errors.join('; ')}`],
      ['workflows', workflows.declared ? `${workflows.branchCount} 条分支链路 / ${workflows.nodeCount} 个执行节点` : '暂无输入来源', workflows.valid ? '结构合法' : `结构异常：${workflows.errors.join('; ')}`],
    ];
    return `<div class="context-chain-grid">
      <section class="context-chain-panel">
        <h3>① skill 定义</h3>
        ${chain.definition.found
          ? `<div class="context-meta">SKILL.md：<code>${e(chain.definition.path ?? '')}</code></div>
             <h4>hardRules</h4>${hardRulesList}
             <h4>workflows</h4>${workflowList}
             <h4>SKILL.md 原文</h4>
             <pre>${e(chain.definition.content ?? '')}${chain.definition.truncated ? '\n\n... 已截断，仅展示前 12000 字符' : ''}</pre>`
          : '<p class="context-muted">暂无输入来源：没有在当前工作目录或本机常见 skill 目录中找到对应 SKILL.md。</p>'}
      </section>
      <section class="context-chain-panel">
        <h3>② 健康检查</h3>
        <p class="context-muted">复用 doctor 的静态检查规则；这里只判断 SKILL.md 结构是否机器可读，不判断运行时是否遵守。</p>
        <table>
          <tbody>
            ${healthRows.map(([name, count, status]) => `<tr><th>${e(name)}</th><td>${e(count)}</td><td>${e(status)}</td></tr>`).join('')}
          </tbody>
        </table>
      </section>
      <section class="context-chain-panel">
        <h3>③ 运行时</h3>
        <p class="context-muted">${e(chain.runtime.message)}</p>
        <div class="context-runtime-placeholder">暂不支持</div>
      </section>
    </div>`;
  };
  const renderConfidenceHeader = (padding = '8px 10px', border = '1px solid var(--border)'): string =>
    `<th style="text-align:right;padding:${padding};border-bottom:${border}">
      判断把握 / 归属把握
      <span class="signal-help" tabindex="0" data-signal-title="判断把握 / 归属把握" data-signal-description="${e(confidenceHeaderHelp)}" aria-label="${e(confidenceHeaderHelp)}" style="display:inline-flex;align-items:center;justify-content:center;margin-left:4px;width:15px;height:15px;border:1px solid var(--border);border-radius:50%;font-size:10px;line-height:15px;color:var(--text-muted);cursor:help;vertical-align:middle">?</span>
    </th>`;
  const reviewPriorityMeta = (priority: ExperienceReviewPriority): { label: string; color: string; bg: string } => {
    if (priority === 'review_first') return { label: '建议优先复盘', color: 'var(--red)', bg: 'rgba(220,38,38,.08)' };
    if (priority === 'sample_review') return { label: '值得抽样复盘', color: 'var(--yellow)', bg: 'rgba(202,138,4,.10)' };
    return { label: '常规抽样', color: 'var(--text-muted)', bg: 'var(--bg-muted)' };
  };
  const basisLabel = (code: ExperienceReviewBasisCode): string => {
    const labels: Record<ExperienceReviewBasisCode, string> = {
      has_high_observation: '有高优先级过程发现',
      has_medium_observation: '有需要抽样确认的过程发现',
      user_correction: '用户纠正过方向或结果',
      user_interruption: '用户人工中断过当前执行',
      negative_feedback: '用户出现负向反馈',
      hard_rule_text_hit: '用户提出了必须/不要/禁止等硬性要求',
      tool_failure: '运行中出现工具执行失败',
      hedging_signal: '回答里出现不确定表达',
      explicit_marker: '回答里明确标出未知/缺口',
    };
    return labels[code];
  };
  const renderPriorityBadge = (priority: ExperienceReviewPriority): string => {
    const meta = reviewPriorityMeta(priority);
    return `<span style="display:inline-flex;padding:3px 7px;border-radius:999px;background:${meta.bg};color:${meta.color};font-size:12px;font-weight:650">${e(meta.label)}</span>`;
  };
  const assistiveInferenceMeta = (code: ExperienceAssistiveInferenceCode): { label: string; description: string; className: string } => {
    const values: Record<ExperienceAssistiveInferenceCode, { label: string; description: string; className: string }> = {
      review_recommended: {
        label: '辅助推断：需要人工复盘',
        description: '确定性规则命中了用户纠正、人工中断、负向反馈、高优先级过程发现等信号。不是自动判定 skill 做错。',
        className: 'assistive-attention',
      },
      sample_recommended: {
        label: '辅助推断：建议抽样确认',
        description: '确定性规则命中了工具执行失败、中等过程发现、不确定表达等信号，适合抽样看上下文。',
        className: 'assistive-sample',
      },
      positive_signal_observed: {
        label: '辅助推断：看到正向反馈',
        description: '人工用户消息里出现正向反馈，且未命中更高优先级异常规则。',
        className: 'assistive-positive',
      },
      user_switched_topic_neutral: {
        label: '辅助推断：用户切换目标',
        description: '人工用户消息里出现“换个方向/先不/不用这个”等目标切换表达。当前只记录目标中止或切走，不自动归因给 skill。',
        className: 'assistive-unknown',
      },
      no_obvious_issue_from_rules: {
        label: '辅助推断：未见明显异常',
        description: '只基于当前固定规则，未发现需要优先复盘的异常信号；不代表最终质量结论。',
        className: 'assistive-normal',
      },
      insufficient_human_context: {
        label: '辅助推断：人工上下文不足',
        description: '当前片段缺少足够人工用户消息，只能展示证据，不能推断用户预期是否满足。',
        className: 'assistive-unknown',
      },
    };
    return values[code];
  };
  const assistiveConfidenceLabel = (value: ExperienceAssistiveInference['confidence']): string => {
    if (value === 'high') return '规则把握高';
    if (value === 'medium') return '规则把握中';
    return '规则把握低';
  };
  const assistiveCautionLabel = (code: ExperienceAssistiveInferenceCautionCode): string => {
    const labels: Record<ExperienceAssistiveInferenceCautionCode, string> = {
      no_llm_judge: '未使用 LLM 判断',
      rule_only: '只用固定规则',
      runtime_context_excluded: '运行时注入不计用户表达',
      skill_context_excluded: 'Skill 文档注入不计入用户交互',
      no_human_user_message: '缺少人工用户消息',
      limited_timeline_window: '时间线为截断窗口',
    };
    return labels[code];
  };
  const renderAssistiveInference = (inference?: ExperienceAssistiveInference, compact = false): string => {
    if (!inference) return '<span style="color:var(--text-muted)">暂无辅助推断</span>';
    const meta = assistiveInferenceMeta(inference.code);
    const basis = inference.basisRuleCodes.length > 0
      ? inference.basisRuleCodes.map((code) => ruleFindingMeta(code).label).join('、')
      : '未命中优先规则';
    const cautions = inference.cautionCodes.map(assistiveCautionLabel).join('、');
    const title = `${meta.description}\n依据：${basis}\n边界：${cautions}`;
    if (compact) {
      return `<div class="assistive-box compact ${meta.className}" title="${e(title)}">
        <div class="assistive-main">
          <span>${e(meta.label)}</span>
          <strong>${e(assistiveConfidenceLabel(inference.confidence))}</strong>
          <span class="signal-help assistive-help" tabindex="0" data-signal-title="${e(meta.label)}" data-signal-description="${e(title)}" aria-label="${e(title)}">?</span>
        </div>
      </div>`;
    }
    return `<div class="assistive-box ${meta.className}" title="${e(title)}">
      <div class="assistive-main">
        <span>${e(meta.label)}</span>
        <strong>${e(assistiveConfidenceLabel(inference.confidence))}</strong>
      </div>
      <div class="assistive-desc">${e(meta.description)}</div>
      <div class="assistive-sub">依据：${e(basis)}</div>
      <div class="assistive-sub">边界：${e(cautions)}</div>
    </div>`;
  };
  const reviewStateKey = (targetType: string, targetId: string): string => `${targetType}:${targetId}`;
  const renderReviewStateControls = (targetType: 'experience_session' | 'inbox_item' | 'skill' | 'goal_slice_correction', targetId: string): string => {
    const key = reviewStateKey(targetType, targetId);
    const entry = reviewState.entries[key];
    const safeId = e(targetId);
    const safeType = e(targetType);
    const buttons = [
      { verdict: 'reviewed', label: '已复盘', title: '标记为已经人工看过；再次点击可取消这个本地标记。' },
      { verdict: 'real_issue', label: '确认问题', title: '标记为确认存在问题；可点击其他按钮直接改标记，再次点击可取消。' },
      { verdict: 'not_issue', label: '不是问题', title: '标记为不是问题或无需处理；可点击其他按钮直接改标记，再次点击可取消。' },
      { verdict: 'needs_more_context', label: '证据不足', title: '标记为证据不足，需要更多上下文；可点击其他按钮直接改标记，再次点击可取消。' },
    ];
    return `<div class="review-state-control" data-review-state-key="${e(key)}" data-review-state-current="${e(entry?.verdict ?? '')}">
      <div class="review-state-actions">
        ${buttons.map((button) => {
          const active = entry?.verdict === button.verdict;
          return `<button type="button" class="review-state-button ${active ? `is-active ${reviewVerdictClassName(button.verdict)}` : ''}" data-review-verdict="${button.verdict}" onclick="setObservationReviewState('${safeType}', '${safeId}', '${button.verdict}', this)" title="${e(button.title)}">${e(button.label)}</button>`;
        }).join('')}
      </div>
    </div>`;
  };
  const reviewVerdictClassName = (verdict?: string): string => {
    if (verdict === 'real_issue') return 'review-real-issue';
    if (verdict === 'not_issue') return 'review-not-issue';
    if (verdict === 'needs_more_context') return 'review-needs-context';
    if (verdict === 'reviewed') return 'review-reviewed';
    return '';
  };
  const renderExperienceBasis = (codes: ExperienceReviewBasisCode[]): string => {
    if (codes.length === 0) return '<span style="color:var(--text-muted)">没有触发复盘优先级规则；进入常规抽样池</span>';
    return codes.map((code) => `<span style="display:inline-block;margin:0 4px 4px 0;padding:2px 6px;border-radius:999px;background:var(--bg-muted);color:var(--text-secondary);font-size:11px">${e(basisLabel(code))}</span>`).join('');
  };
  const ruleFindingMeta = (code: ExperienceRuleFindingCode): { label: string; description: string } => {
    const values: Record<ExperienceRuleFindingCode, { label: string; description: string }> = {
      high_observation_seen: { label: '高优先级过程发现', description: '存在 severity=high 的过程发现，建议优先复盘原始上下文。' },
      medium_observation_seen: { label: '抽样过程发现', description: '存在 medium/low 过程发现，适合进入抽样复盘。' },
      user_correction_seen: { label: '用户纠正', description: '人工用户消息命中明确纠偏表达。' },
      user_interruption_seen: { label: '人工中断', description: 'trace 中出现用户主动中断事件。' },
      negative_feedback_seen: { label: '负向反馈', description: '人工用户消息命中明确负向表达。' },
      positive_feedback_seen: { label: '正向反馈', description: '人工用户消息命中明确认可表达，仅作为正向证据展示。' },
      user_goal_shift_seen: { label: '用户切换目标', description: '人工用户消息命中“换个方向/先不/不用这个”等目标切换表达；这通常表示目标切走，不自动归因给 skill。' },
      hard_rule_seen: { label: '用户硬性要求', description: '人工用户消息命中“必须/不要/禁止”等临时硬性要求。Skill 自身的强约束请看 Context Chain 里的 hardRules。' },
      tool_failure_seen: { label: '工具执行失败', description: 'tool_result 标记失败，表示执行过程中存在工具层失败。' },
      hedging_seen: { label: '不确定表达', description: '过程发现里存在“不确定/可能/需要确认”等低置信文本信号。' },
      explicit_marker_seen: { label: '显式缺口', description: '过程发现里存在“未知/知识缺口”等显式标记。' },
      runtime_context_excluded: { label: '运行时注入已排除', description: 'SDK/工作台注入上下文已从用户交互指标里排除。' },
      skill_context_excluded: { label: 'Skill 文档注入不计入用户交互', description: '系统会把 SKILL.md 内容注入给 agent 作为说明书；这不是用户本人说的话，所以不计入用户纠正、追问、情绪反馈或用户硬性要求。' },
      no_priority_signal: { label: '未命中优先规则', description: '未命中需要优先复盘或抽样复盘的固定规则。' },
    };
    return values[code];
  };
  const ruleFindingLevelMeta = (level: ExperienceRuleFindingLevel): { label: string; className: string } => {
    if (level === 'attention') return { label: '需关注', className: 'rule-attention' };
    if (level === 'sample') return { label: '抽样看', className: 'rule-sample' };
    return { label: '记录项', className: 'rule-normal' };
  };
  const renderRuleFindings = (findings: ExperienceRuleFinding[] = [], compact = false): string => {
    if (findings.length === 0) return '<span style="color:var(--text-muted)">没有固定规则命中</span>';
    return `<div class="${compact ? 'rule-finding-list compact' : 'rule-finding-list'}">${findings.map((finding) => {
      const meta = ruleFindingMeta(finding.code);
      const level = ruleFindingLevelMeta(finding.level);
      const anchor = finding.evidenceRefs?.[0]?.messageIndex !== undefined ? ` · #${finding.evidenceRefs[0].messageIndex}` : '';
      return `<span class="rule-finding ${level.className}" title="${e(meta.description)}">
        <span class="rule-level">${e(level.label)}</span>
        <span>${e(meta.label)}</span>
        <strong>${finding.count}</strong>
        <span class="rule-anchor">${e(anchor)}</span>
      </span>`;
    }).join('')}</div>`;
  };
  const fallbackEvidenceChain = (session: ExperienceSessionSummary): ExperienceEvidenceChain => {
    const events = session.timelinePreview ?? [];
    return {
      userMessageCount: events.filter((event) => event.kind === 'user_message').length,
      runtimeContextCount: events.filter((event) => event.kind === 'runtime_context').length,
      skillContextCount: events.filter((event) => event.kind === 'skill_context').length,
      assistantMessageCount: events.filter((event) => event.kind === 'assistant_message').length,
      toolUseCount: events.filter((event) => event.kind === 'tool_use').length,
      toolResultCount: events.filter((event) => event.kind === 'tool_result').length,
      toolFailureResultCount: events.filter((event) => event.kind === 'tool_result' && event.isError === true).length,
      observationCount: session.relatedObservationIds.length,
    };
  };
  const renderEvidenceChain = (chain: ExperienceEvidenceChain): string => {
    const item = (label: string, value: number, title: string): string =>
      `<span class="evidence-chain-item" title="${e(title)}"><span>${e(label)}</span><strong>${value}</strong></span>`;
    const anchor = (label: string, ref?: { messageIndex?: number; timestamp?: string; snippet?: string }): string => {
      if (!ref) return '';
      const title = [ref.timestamp, ref.snippet].filter(Boolean).join(' · ');
      const msg = ref.messageIndex !== undefined ? `#${ref.messageIndex}` : '有记录';
      return `<span class="evidence-anchor" title="${e(title)}">${e(label)} ${e(msg)}</span>`;
    };
    return `<div class="evidence-chain">
      <div class="evidence-chain-row">
        ${item('人工用户消息', chain.userMessageCount, '只包含人工用户原话，不包含 SDK 工作台注入或 SKILL.md 注入内容')}
        ${item('运行时注入', chain.runtimeContextCount, 'SDK/工作台注入上下文，已从用户交互指标里排除')}
        ${item('Skill 文档注入', chain.skillContextCount, 'SKILL.md 注入上下文，已从用户交互指标里排除')}
        ${item('助手回复', chain.assistantMessageCount, 'assistant_message 上下文')}
      </div>
      <div class="evidence-chain-row">
        ${item('工具调用', chain.toolUseCount, 'tool_use 事件数')}
        ${item('工具执行结果', chain.toolResultCount, 'tool_result 事件数')}
        ${item('失败结果', chain.toolFailureResultCount, 'is_error=true 的 tool_result 事件数')}
        ${item('过程发现', chain.observationCount, '关联 observation item 数')}
      </div>
      <div class="evidence-anchor-row">
        ${anchor('首条用户消息', chain.firstUserMessage)}
        ${anchor('运行时注入', chain.firstRuntimeContext)}
        ${anchor('Skill 文档', chain.firstSkillContext)}
        ${anchor('首个工具调用', chain.firstToolUse)}
        ${anchor('首个失败结果', chain.firstToolFailure)}
        ${anchor('最后助手回复', chain.lastAssistantMessage)}
      </div>
    </div>`;
  };
  interface TimelineEventMeta {
    icon: string;
    label: string;
    tone: string;
  }
  interface TimelineHighlightRule {
    pattern?: RegExp;
    ranges?: (value: string) => Array<{ start: number; end: number }>;
    className: string;
    title: string;
  }
  const USER_INTERRUPTION_RE = /\[Request interrupted by user(?: for tool use)?\]|interrupted by user|用户中断/i;
  const HARD_RULE_RE = /hard rules?|必须|不要|禁止|严格|一定要|务必|不得|不能|只允许/i;
  const HEDGING_RE = /可能|不确定|需要确认|大概|也许|presumably|maybe|unclear|not sure/i;
  const EXPLICIT_MARKER_RE = /【推断】|【知识缺口】|【未知】|\[inferred\]|\[unknown\]|\[knowledge\s*gap\]/i;
  const TOOL_FAILURE_RE = /Error|error|failed|失败|Exception|ENOENT|EACCES|permission denied|No such file|exceeds maximum allowed tokens|timed out|timeout/i;
  const evidenceMetricLabels: Record<ObservationMetricKey, string> = {
    user_correction: '纠正',
    user_interruption: '中断',
    user_follow_up: '追问',
    negative_feedback: '负向',
    positive_feedback: '正向',
    hard_rule: '用户硬性要求',
    user_goal_shift: '目标切换',
  };
  const evidenceMetricKeys = Object.keys(evidenceMetricLabels) as ObservationMetricKey[];
  const cloneRegex = (pattern: RegExp): RegExp => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const matches = (pattern: RegExp, value: string): boolean => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  };
  const highlightText = (value: string, rules: TimelineHighlightRule[]): string => {
    if (!value || rules.length === 0) return e(value);
    const ranges: Array<{ start: number; end: number; className: string; title: string }> = [];
    for (const rule of rules) {
      const matches = rule.ranges
        ? rule.ranges(value)
        : rule.pattern
          ? Array.from(value.matchAll(rule.pattern)).map((match) => {
            const text = match[0] ?? '';
            const start = match.index ?? -1;
            return { start, end: start + text.length };
          })
          : [];
      for (const match of matches) {
        const start = match.start;
        const end = match.end;
        if (start < 0 || ranges.some((range) => start < range.end && end > range.start)) continue;
        ranges.push({ start, end, className: rule.className, title: rule.title });
      }
    }
    ranges.sort((a, b) => a.start - b.start);
    let cursor = 0;
    const parts: string[] = [];
    for (const range of ranges) {
      parts.push(e(value.slice(cursor, range.start)));
      parts.push(`<mark class="timeline-mark ${range.className}" title="${e(range.title)}">${e(value.slice(range.start, range.end))}</mark>`);
      cursor = range.end;
    }
    parts.push(e(value.slice(cursor)));
    return parts.join('');
  };
	  const timelineEventMeta = (event: ExperienceTimelineEvent): TimelineEventMeta => {
	    if (event.kind === 'user_message') return { icon: 'U', label: '用户消息', tone: 'user' };
	    if (event.kind === 'assistant_message') return { icon: 'A', label: '助手回复', tone: 'assistant' };
	    if (event.kind === 'tool_use') return { icon: 'TU', label: '工具调用', tone: 'tool-use' };
	    if (event.kind === 'tool_result') {
	      if (event.isError) return { icon: 'TR', label: '工具执行失败', tone: 'tool-error' };
	      return { icon: 'TR', label: isSkillLaunchResult(event) ? '工具调用成功' : '工具执行成功', tone: 'tool-result' };
	    }
	    if (event.kind === 'skill_context') return { icon: 'S', label: 'Skill 注入上下文', tone: 'skill' };
	    if (event.kind === 'runtime_context') return { icon: 'R', label: event.label === 'command envelope' ? '命令注入上下文' : '运行时注入上下文', tone: 'skill' };
	    return { icon: 'O', label: '过程发现', tone: 'observation' };
	  };
	  const isSkillLaunchResult = (event: ExperienceTimelineEvent): boolean =>
	    event.kind === 'tool_result' && /^Launching skill:/i.test((event.fullText ?? event.snippet ?? '').trim());
	  const isAssistantDeliverySignal = (event: ExperienceTimelineEvent): boolean => {
	    if (event.kind !== 'assistant_message') return false;
	    const text = event.fullText ?? event.snippet ?? '';
	    return /```(?:mermaid|plantuml|json|tsx?|jsx?|html|css|excalidraw|markdown)?/i.test(text)
	      || /(?:直接生成|已生成|生成如下|结果如下|如下|完成|已完成|这里是|给出|输出)/i.test(text);
	  };
	  const evidenceMetricVerdictFor = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey): 'confirmed' | 'rejected' | '' => {
	    const targetId = observationMetricAnnotationTargetId(event, metricKey);
	    const entry = reviewState.entries[reviewStateKey('evidence_metric', targetId)];
	    return entry?.verdict === 'confirmed' || entry?.verdict === 'rejected' ? entry.verdict : '';
	  };
	  const evidenceMetricIsActive = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, ruleDetected: boolean): boolean => {
	    const verdict = evidenceMetricVerdictFor(event, metricKey);
	    if (verdict === 'confirmed') return true;
	    if (verdict === 'rejected') return false;
	    return ruleDetected;
	  };
	  const evidenceMetricBadgeLabel = (base: string, event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, ruleDetected: boolean): string =>
	    evidenceMetricVerdictFor(event, metricKey) === 'confirmed' && !ruleDetected ? `人工确认：${base}` : base;
	  const timelineMetricBadges = (event: ExperienceTimelineEvent, userIndex: number): string[] => {
	    const text = event.fullText ?? event.snippet ?? '';
	    const metricText = event.snippet ?? '';
	    const badges: Array<{ label: string; className: string; title: string }> = [];
    if (event.kind === 'user_message') {
      badges.push({ label: '用户消息来源', className: 'metric-user-message', title: '这条人工用户消息计入用户消息数；同一 skill 片段内第 2 条及之后还会计入追问/补充。' });
      if (evidenceMetricIsActive(event, 'user_follow_up', userIndex > 0)) badges.push({ label: evidenceMetricBadgeLabel('追问/补充来源', event, 'user_follow_up', userIndex > 0), className: 'metric-followup', title: '同一 skill 复盘片段内，第 2 条及之后的人工用户消息计入追问/补充。' });
      if (evidenceMetricIsActive(event, 'user_correction', hasUserCorrectionSignal(metricText))) badges.push({ label: evidenceMetricBadgeLabel('用户纠正来源', event, 'user_correction', hasUserCorrectionSignal(metricText)), className: 'metric-correction', title: '命中明确纠正表达；“不对/不是/错了”要求前后有标点、空格等分隔。人工反对后不会再显示。' });
      if (evidenceMetricIsActive(event, 'user_goal_shift', hasUserGoalShiftSignal(metricText))) badges.push({ label: evidenceMetricBadgeLabel('目标切换来源', event, 'user_goal_shift', hasUserGoalShiftSignal(metricText)), className: 'metric-goal-shift', title: '命中“换个方向/先不/不用这个/另一个问题”等表达；表示用户可能切走当前目标。' });
      if (evidenceMetricIsActive(event, 'user_interruption', matches(USER_INTERRUPTION_RE, metricText))) badges.push({ label: evidenceMetricBadgeLabel('人工中断来源', event, 'user_interruption', matches(USER_INTERRUPTION_RE, metricText)), className: 'metric-interruption', title: '用户主动中断了当前执行，通常表示当前路径需要纠偏或停止。' });
      if (evidenceMetricIsActive(event, 'negative_feedback', findNegativeFeedbackMatches(metricText).length > 0)) badges.push({ label: evidenceMetricBadgeLabel('负向反馈来源', event, 'negative_feedback', findNegativeFeedbackMatches(metricText).length > 0), className: 'metric-negative', title: '命中“没用/垃圾/菜/做错了/不行/看不懂”等负向表达。' });
      if (evidenceMetricIsActive(event, 'positive_feedback', findPositiveFeedbackMatches(metricText).length > 0)) badges.push({ label: evidenceMetricBadgeLabel('正向反馈来源', event, 'positive_feedback', findPositiveFeedbackMatches(metricText).length > 0), className: 'metric-positive', title: '命中“很好/good job/做得好/很棒/优秀/很有用”等正向表达。' });
      if (evidenceMetricIsActive(event, 'hard_rule', matches(HARD_RULE_RE, metricText))) badges.push({ label: evidenceMetricBadgeLabel('用户硬性要求来源', event, 'hard_rule', matches(HARD_RULE_RE, metricText)), className: 'metric-hard-rule', title: '命中“必须/不要/禁止/严格”等用户临时硬性要求。' });
    }
	    if (event.kind === 'assistant_message') {
	      if (isAssistantDeliverySignal(event)) badges.push({ label: '产出结果/疑似完成', className: 'metric-completion', title: '助手回复里出现代码块、直接生成、结果如下、完成等交付信号。它表示当前目标可能完成，不等于整个 skill 生命周期结束。' });
	      if (matches(HEDGING_RE, text)) badges.push({ label: '不确定表达来源', className: 'metric-hedging', title: '命中“可能/不确定/需要确认”等表达。' });
	      if (matches(EXPLICIT_MARKER_RE, text)) badges.push({ label: '显式缺口来源', className: 'metric-explicit', title: '命中“【推断】/【未知】/知识缺口”等标记。' });
	      if (badges.length === 0) badges.push({ label: '助手回复上下文', className: 'metric-neutral', title: '这条助手回复用于回溯上下文，当前没有额外文本指标判断。' });
    }
    if (event.kind === 'tool_use') {
      badges.push({ label: '工具调用来源', className: 'metric-tool-use', title: '这条 tool_use 计入工具调用数。' });
      if (event.toolName) {
        const tool = event.toolName;
        const knownTool = ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write'].includes(tool);
        badges.push({
          label: `${tool} 来源`,
          className: knownTool ? `metric-tool-${tool.toLowerCase()}` : 'metric-tool-use',
          title: `这条 tool_use 计入 ${tool} 工具调用明细。`,
        });
      }
    }
	    if (event.kind === 'tool_result') {
	      if (event.isError) {
	        badges.push({ label: '工具执行失败', className: 'metric-tool-failure', title: 'tool_result 标记 is_error=true，表示这次工具执行失败。' });
	      } else if (isSkillLaunchResult(event)) {
	        badges.push({ label: '工具调用成功', className: 'metric-tool-success', title: 'Launching skill 表示 Skill 工具调用已被 runtime 接受并启动；这不是 skill 执行结束。' });
	      } else {
	        badges.push({ label: '工具执行成功', className: 'metric-tool-success', title: '这条 tool_result 没有错误标记，表示这次工具执行返回成功结果。' });
	      }
	    }
    if (event.kind === 'skill_context') {
      badges.push({ label: '不计入用户交互', className: 'metric-skill-context', title: '这是 Skill runtime 注入的 SKILL.md 内容，不计入用户消息、追问、纠正或负向反馈。' });
    }
    if (event.kind === 'runtime_context') {
      badges.push({ label: '不计入用户交互', className: 'metric-skill-context', title: event.label === 'command envelope' ? '这是斜杠命令的系统包装内容，不是人工用户原话，不计入用户消息、追问、纠正、情绪反馈或用户硬性要求。' : '这是 SDK/工作台注入的运行时上下文，不是人工用户原话，不计入用户消息、追问、纠正、情绪反馈或用户硬性要求。' });
    }
    if (event.kind === 'observation') {
      badges.push({ label: '过程发现来源', className: 'metric-explicit', title: '这条事件来自 observation 信号，会进入过程发现类指标。' });
    }
    if (badges.length === 0) {
      badges.push({ label: '上下文事件', className: 'metric-neutral', title: '这条时间线事件用于回溯上下文，当前没有额外指标判断。' });
    }
    return badges.map((badge) => `<span class="timeline-badge ${badge.className}" title="${e(badge.title)}">${e(badge.label)}</span>`);
  };
	  const highlightTimelineSnippet = (event: ExperienceTimelineEvent, userIndex: number): string => {
	    const rules: TimelineHighlightRule[] = [];
	    const value = event.snippet ?? '';
	    if (event.kind === 'user_message') {
      if (evidenceMetricIsActive(event, 'user_correction', hasUserCorrectionSignal(value))) rules.push({ ranges: findUserCorrectionMatches, className: 'metric-correction', title: '用户纠正命中词' });
      if (evidenceMetricIsActive(event, 'user_goal_shift', hasUserGoalShiftSignal(value))) rules.push({ ranges: findUserGoalShiftMatches, className: 'metric-goal-shift', title: '目标切换命中词' });
      if (evidenceMetricIsActive(event, 'user_interruption', matches(USER_INTERRUPTION_RE, value))) rules.push({ pattern: cloneRegex(USER_INTERRUPTION_RE), className: 'metric-interruption', title: '人工中断命中词' });
      if (evidenceMetricIsActive(event, 'negative_feedback', findNegativeFeedbackMatches(value).length > 0)) rules.push({ ranges: findNegativeFeedbackMatches, className: 'metric-negative', title: '负向反馈命中词' });
      if (evidenceMetricIsActive(event, 'positive_feedback', findPositiveFeedbackMatches(value).length > 0)) rules.push({ ranges: findPositiveFeedbackMatches, className: 'metric-positive', title: '正向反馈命中词' });
      if (evidenceMetricIsActive(event, 'hard_rule', matches(HARD_RULE_RE, value))) rules.push({ pattern: cloneRegex(HARD_RULE_RE), className: 'metric-hard-rule', title: '用户硬性要求命中词' });
    }
	    if (event.kind === 'assistant_message') {
	      rules.push(
	        { pattern: /```(?:mermaid|plantuml|json|tsx?|jsx?|html|css|excalidraw|markdown)?|直接生成|已生成|生成如下|结果如下|完成|已完成/g, className: 'metric-completion', title: '当前目标产出结果/疑似完成命中词' },
	        { pattern: cloneRegex(HEDGING_RE), className: 'metric-hedging', title: '不确定表达命中词' },
	        { pattern: cloneRegex(EXPLICIT_MARKER_RE), className: 'metric-explicit', title: '显式缺口命中词' },
	      );
	    }
    if (event.kind === 'tool_result' && event.isError) {
      rules.push({ pattern: cloneRegex(TOOL_FAILURE_RE), className: 'metric-tool-failure', title: '工具执行失败命中词' });
    }
	    const html = highlightText(value, rules);
    if (event.kind === 'user_message' && evidenceMetricIsActive(event, 'user_follow_up', userIndex > 0)) {
      return `<span class="timeline-followup-source" title="整条消息计入追问/补充来源">${html}</span>`;
    }
    return html;
  };
  const evidenceMetricRuleDetected = (event: ExperienceTimelineEvent, userIndex: number, metricKey: ObservationMetricKey): boolean => {
    if (event.kind !== 'user_message') return false;
    const text = event.snippet ?? '';
    if (metricKey === 'user_correction') return hasUserCorrectionSignal(text);
    if (metricKey === 'user_interruption') return matches(USER_INTERRUPTION_RE, text);
    if (metricKey === 'user_follow_up') return userIndex > 0;
    if (metricKey === 'negative_feedback') return findNegativeFeedbackMatches(text).length > 0;
    if (metricKey === 'positive_feedback') return findPositiveFeedbackMatches(text).length > 0;
    if (metricKey === 'hard_rule') return matches(HARD_RULE_RE, text);
    if (metricKey === 'user_goal_shift') return hasUserGoalShiftSignal(text);
    return false;
  };
  const metricAnnotationTarget = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey): string =>
    observationMetricAnnotationTargetId(event, metricKey);
	  const metricAnnotationVerdict = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey): 'confirmed' | 'rejected' | '' => {
	    const targetId = metricAnnotationTarget(event, metricKey);
	    const entry = reviewState.entries[reviewStateKey('evidence_metric', targetId)];
	    return entry?.verdict === 'confirmed' || entry?.verdict === 'rejected' ? entry.verdict : '';
	  };
	  const metricAnnotationReason = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey): string => {
	    const targetId = metricAnnotationTarget(event, metricKey);
	    const entry = reviewState.entries[reviewStateKey('evidence_metric', targetId)];
	    return typeof entry?.reason === 'string' ? entry.reason : '';
	  };
	  const renderMetricCalibration = (event: ExperienceTimelineEvent, userIndex: number): string => {
	    if (event.kind !== 'user_message') return '';
	    const buttons = evidenceMetricKeys.map((metricKey) => {
	      const targetId = metricAnnotationTarget(event, metricKey);
	      const verdict = metricAnnotationVerdict(event, metricKey);
	      const reason = metricAnnotationReason(event, metricKey);
	      const ruleDetected = evidenceMetricRuleDetected(event, userIndex, metricKey);
	      const label = evidenceMetricLabels[metricKey];
	      const stateLabel = verdict === 'confirmed' ? '人工同意' : verdict === 'rejected' ? '人工反对' : ruleDetected ? '规则命中' : '未命中';
	      const className = verdict === 'confirmed' ? 'is-confirmed' : verdict === 'rejected' ? 'is-rejected' : ruleDetected ? 'is-rule-hit' : '';
	      const title = `${stateLabel}：${label}。点击后在弹层里选择同意/反对，并可填写原因；下一次生成报告会优先使用人工标注。`;
	      return `<button type="button"
	        class="metric-calibration-button ${className}"
	        data-evidence-metric-target="${e(targetId)}"
	        data-metric-key="${e(metricKey)}"
	        data-metric-label="${e(label)}"
	        data-metric-annotation="${e(verdict)}"
	        data-metric-reason="${e(reason)}"
	        data-rule-detected="${ruleDetected ? '1' : '0'}"
	        data-source-trace="${e(event.sourceTrace)}"
	        data-session-id="${e(event.sessionId)}"
        data-message-index="${event.messageIndex ?? ''}"
        data-message-uuid="${e(event.messageUuid ?? '')}"
        data-tool-use-id="${e(event.toolUseId ?? '')}"
        data-snippet="${e((event.snippet ?? '').slice(0, 240))}"
	        onclick="openEvidenceMetricAnnotation('${e(targetId)}', '${e(metricKey)}', this)"
	        title="${e(title)}">${e(stateLabel)} · ${e(label)}</button>`;
	    }).join('');
    return `<div class="metric-calibration-row">
      <span class="metric-calibration-title">人工校准</span>
      <div class="metric-calibration-actions">${buttons}</div>
    </div>`;
  };
  const renderGoalSliceCorrectionButton = (sessionId: string, event: ExperienceTimelineEvent): string => {
    const targetId = `${sessionId}:${event.messageIndex ?? event.id}`;
    const key = reviewStateKey('goal_slice_correction', targetId);
    const marked = Boolean(reviewState.entries[key]);
    const help = marked
      ? '已记录为目标切片边界候选。再次点击会取消这个本地标记；当前不会自动重新切片或改变本报告指标。'
      : '点击后会把这一行记录为目标切片边界候选，写入本地 review-state.json；当前不会自动重新切片或改变本报告指标。';
    return `<button type="button" class="goal-slice-correction-button ${marked ? 'is-marked' : ''}" data-goal-slice-correction-key="${e(key)}" data-goal-slice-correction-marked="${marked ? '1' : '0'}" onclick="toggleGoalSliceCorrection('${e(targetId)}', this)" title="${e(help)}" aria-label="${e(help)}">${marked ? '已标记 · 点击取消' : '人工标记切片点'}</button>`;
  };
	  const renderExperienceTimeline = (events: ExperienceTimelineEvent[], sessionId: string): string => {
    if (events.length === 0) return '<div style="color:var(--text-muted);font-size:12px">没有可展示的时间线片段。</div>';
    let userIndex = 0;
    const decorated = events.map((event) => ({
      event,
      userIndex: event.kind === 'user_message' ? userIndex++ : -1,
    }));
    const groups: Array<{ boundary?: ExperienceTimelineEvent; items: typeof decorated }> = [];
    let current: typeof decorated = [];
    let currentBoundary: ExperienceTimelineEvent | undefined;
    for (const item of decorated) {
      const boundaryTargetId = `${sessionId}:${item.event.messageIndex ?? item.event.id}`;
      const isManualBoundary = Boolean(reviewState.entries[reviewStateKey('goal_slice_correction', boundaryTargetId)]);
      if (isManualBoundary && current.length > 0) {
        groups.push({ boundary: currentBoundary, items: current });
        current = [];
      }
      if (isManualBoundary) currentBoundary = item.event;
      current.push(item);
    }
    if (current.length > 0) groups.push({ boundary: currentBoundary, items: current });
    const previousHumanUserFor = (order: number): typeof decorated[number] | undefined => {
      for (let index = decorated.length - 1; index >= 0; index -= 1) {
        const item = decorated[index];
        if (item.event.order < order && item.event.kind === 'user_message') return item;
      }
      return undefined;
    };
    const withLeadUserContext = (items: typeof decorated): typeof decorated => {
      const first = items[0];
      if (!first || first.event.kind === 'user_message') return items;
      const previous = previousHumanUserFor(first.event.order);
      if (!previous || items.some((item) => item.event.id === previous.event.id)) return items;
      return [previous, ...items];
    };
	    const renderRow = ({ event, userIndex: currentUserIndex }: typeof decorated[number]): string => {
	      const meta = timelineEventMeta(event);
	      const badges = timelineMetricBadges(event, currentUserIndex).join('');
	      const visibleText = event.snippet ?? '';
	      const fullText = event.fullText ?? visibleText;
	      const hasMoreFullText = Boolean(fullText && fullText.trim() !== visibleText.trim());
	      const fullTextAttrs = fullText
	        ? ` data-timeline-fulltext="${e(fullText)}" data-timeline-fulltext-title="${e(meta.label)} #${event.messageIndex ?? '—'}" data-timeline-has-more="${hasMoreFullText ? '1' : '0'}" tabindex="${hasMoreFullText ? '0' : '-1'}"`
	        : '';
	      return `<div class="timeline-row timeline-${meta.tone}">
        <div class="timeline-marker">
          <span class="timeline-icon">${e(meta.icon)}</span>
          <span class="timeline-index" title="messageIndex 是各自 jsonl 文件内的索引，跨链路不可直接比较">${event.traceRole === 'subagent' ? '[sub] ' : event.traceRole === 'main' ? '[main] ' : ''}#${event.messageIndex ?? '—'}</span>
        </div>
        <article class="timeline-card">
          <header class="timeline-card-header">
            <div style="min-width:0">
              <div class="timeline-title">${e(meta.label)} <span class="timeline-kind">/ ${e(event.kind)}</span></div>
              <div class="timeline-subtitle">${event.traceLabel ? `链路：${e(event.traceLabel)} · ` : ''}${e(event.label || event.role || event.kind)}${event.toolUseId ? ` · ${e(event.toolUseId)}` : ''}${event.timestamp ? ` · ${e(event.timestamp.slice(0, 19).replace('T', ' '))}` : ''}</div>
            </div>
            <div class="timeline-badges">${badges}</div>
            ${renderGoalSliceCorrectionButton(sessionId, event)}
          </header>
	          <pre class="timeline-snippet ${event.isError ? 'is-tool-error' : ''}"${fullTextAttrs}>${highlightTimelineSnippet(event, currentUserIndex)}</pre>
          ${renderMetricCalibration(event, currentUserIndex)}
        </article>
      </div>`;
    };
    const tabBaseId = `timeline-tabs-${sessionId.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
    return `<div class="timeline-goal-tabs" data-timeline-tabs="${e(tabBaseId)}">
      <div class="timeline-tab-list" role="tablist" aria-label="目标片段">
        ${groups.map((group, index) => {
          const boundary = group.boundary;
          const label = boundary ? `目标片段 ${index + 1} · #${boundary.messageIndex ?? '—'}` : `目标片段 ${index + 1}`;
          return `<button type="button" class="timeline-tab-button ${index === 0 ? 'is-active' : ''}" role="tab" aria-selected="${index === 0 ? 'true' : 'false'}" data-timeline-tab="${e(tabBaseId)}-${index}" onclick="switchTimelineGoalTab('${e(tabBaseId)}', ${index})">${e(label)}</button>`;
        }).join('')}
      </div>
      <div class="timeline-tab-panels">
      ${groups.map((group, index) => {
      const boundary = group.boundary;
      const label = boundary
        ? `人工切片点 #${boundary.messageIndex ?? '—'}`
        : index === 0
          ? '默认起点'
          : '延续片段';
      const groupItems = withLeadUserContext(group.items);
      const firstUser = groupItems.find((item) => item.event.kind === 'user_message')?.event.snippet;
      return `<section class="timeline-tab-panel ${index === 0 ? 'is-active' : ''}" role="tabpanel" data-timeline-panel="${e(tabBaseId)}-${index}">
        <header class="timeline-goal-card-header">
          <strong>目标片段 ${index + 1}</strong>
          <span>${e(label)}</span>
        </header>
        ${firstUser ? `<div class="timeline-goal-summary">${e(firstUser.slice(0, 180))}</div>` : ''}
        <div class="experience-timeline">${groupItems.map(renderRow).join('')}</div>
      </section>`;
    }).join('')}
      </div>
    </div>`;
  };
  const renderSessionTimelineTree = (session: ExperienceSessionSummary): string => {
    const tree = session.timelineTree;
    if (!tree || tree.branches.length === 0) {
      return renderExperienceTimeline(session.fullSessionTimeline ?? session.timelinePreview, `${session.id}-full`);
    }
    const main = tree.main;
    return `<div class="session-timeline-tree">
      <section class="timeline-main-chain">
        <header class="timeline-chain-header">
          <strong>主线 main</strong>
          <span>${main.length > 0 ? `${main.length} 条事件` : '未发现主线 jsonl'}</span>
        </header>
        ${main.length > 0 ? renderExperienceTimeline(main, `${session.id}-main`) : '<div style="color:var(--text-muted);font-size:12px;padding:10px;border:1px solid var(--border);border-radius:8px">这个 session 只发现 subagents 子链路，未发现可作为主线的 jsonl。</div>'}
      </section>
      <section class="timeline-branch-list">
        <header class="timeline-chain-header">
          <strong>子链路 subagents</strong>
          <span>${tree.branches.length} 条分支；点击展开查看每个子 agent 的完整链路</span>
        </header>
        ${tree.branches.map((branch, index) => {
          const attach = branch.attachTo
            ? `挂载点：主线 #${branch.attachTo.messageIndex ?? '—'}${branch.attachTo.toolUseId ? ` · ${branch.attachTo.toolUseId}` : ''}`
            : '挂载点：未能从主线 Task 调用精确定位';
          return `<details class="timeline-branch" ${index === 0 ? 'open' : ''}>
            <summary>
              <span>${e(branch.label)}</span>
              <small>${e(attach)} · ${branch.events.length} 条事件</small>
            </summary>
            ${renderExperienceTimeline(branch.events, `${session.id}-branch-${index}`)}
          </details>`;
        }).join('')}
      </section>
    </div>`;
  };
  const rangeText = (start?: number, end?: number): string =>
    start === undefined || end === undefined ? '未记录' : `#${start} - #${end}`;
  const renderTimelineScopeNotice = (session: ExperienceSessionSummary): string => {
    const scope = session.timelineScope;
    if (!scope) {
      return `<div class="timeline-scope-notice" data-timeline-scope-notice>
        <div>
          <strong>当前报告缺少完整 session 时间线数据</strong>
          <span>这通常说明 observation JSON 是旧版本生成的，只包含 skill 窗口片段。</span>
          <span>重新执行 observe ingest 后，报告会写入完整 session 时间线、展示范围和截断信息。</span>
        </div>
        <button type="button" disabled title="当前 report JSON 没有 fullSessionTimeline 字段，无法在前端还原完整 session。">需要重新生成报告</button>
      </div>`;
    }
    const truncatedText = scope.truncated ? '当前展示不是完整链路' : '当前展示覆盖本次 skill 窗口';
    const omittedText = `前面省略 ${scope.omittedBeforeCount} 个事件，后面省略 ${scope.omittedAfterCount} 个事件`;
    const branchCount = session.timelineTree?.branches.length ?? 0;
    const chainText = branchCount > 0
      ? `链路结构：主线 main + ${branchCount} 条 subagent 子链路；# 编号是各自 jsonl 文件内的 message index。`
      : '链路结构：单 jsonl 时间线。';
    return `<div class="timeline-scope-notice" data-timeline-scope-notice>
      <div>
        <strong>${e(truncatedText)}</strong>
        <span>展示范围：${e(rangeText(scope.previewStartRecordIndex, scope.previewEndRecordIndex))} · 当前 ${scope.previewEventCount} 条事件 / 完整 session ${scope.fullSessionEventCount} 条事件</span>
        <span>skill 窗口：${e(rangeText(scope.segmentStartRecordIndex, scope.segmentEndRecordIndex))} · 完整 session：${e(rangeText(scope.sessionStartRecordIndex, scope.sessionEndRecordIndex))} · ${e(omittedText)}</span>
        <span>${e(chainText)}</span>
      </div>
      <button type="button" data-full-session-toggle onclick="toggleFullSessionTimeline(this)">查看完整 session 时间线</button>
    </div>`;
  };
  const renderTimelinePair = (session: ExperienceSessionSummary): string => `
    ${renderTimelineScopeNotice(session)}
    <div data-timeline-view="segment">${renderExperienceTimeline(session.timelinePreview, session.id)}</div>
    <div data-timeline-view="full-session" style="display:none">${renderSessionTimelineTree(session)}</div>
  `;
  const renderReviewRows = (groupItems: ObservationInboxItem[], idPrefix: string): string => groupItems.map((item, index) => {
    const evidence = semanticEvidence(item);
    const detailsId = `${idPrefix}-detail-${index}`;
    const searchText = [item.severity, item.sourceKind, item.skillName, item.signalType, item.signalSubtype, evidence, item.cwd, item.sourceTrace].join(' ').toLowerCase();
    return `<tr data-observe-row="review" data-severity="${e(item.severity)}" data-search="${e(searchText)}" data-detail-id="${detailsId}">
      <td style="padding:8px 10px">${renderSeverityBadge(item)}${renderSourceBadge(item)}</td>
      <td style="padding:8px 10px">${renderSignalLabel(item)}</td>
      <td class="num" style="padding:8px 10px;text-align:right">${renderOccurrences(item)}</td>
      <td class="num" style="padding:8px 10px;text-align:right">${item.confidence.toFixed(2)} / ${item.attributionConfidence.toFixed(2)}</td>
      <td style="padding:8px 10px;color:var(--text-muted);font-size:12px">${item.lastSeen.slice(0, 19).replace('T', ' ')}</td>
      <td style="padding:8px 10px">${renderEvidenceCell(item)}</td>
      <td class="num" style="padding:8px 10px;text-align:right"><button type="button" onclick="toggleObservationDetail('${detailsId}', this)" style="font-size:12px;padding:4px 8px;border:1px solid var(--border);background:var(--bg);border-radius:4px;cursor:pointer">${lang === 'zh' ? '展开' : 'Details'}</button></td>
    </tr>
    <tr id="${detailsId}" data-observe-detail-for="${detailsId}" style="display:none;background:var(--bg-muted)">
      <td colspan="7" style="padding:14px 18px;border-bottom:1px solid var(--border);text-align:left">
        <div style="display:grid;grid-template-columns:minmax(0,0.75fr) minmax(0,1.55fr);gap:18px;align-items:start;max-width:100%;overflow:hidden">
          <section style="text-align:left;font-size:11px;color:var(--text-muted);min-width:0">
            <h3 style="font-size:12px;margin:0 0 8px;color:var(--text-secondary)">这条记录的来源和判断依据</h3>
            ${renderField('id', item.id)}
            ${renderField('sourceTrace', item.sourceTrace)}
            ${renderField('sourceKind', item.sourceKind)}
            ${renderField('sessionId', item.sessionId)}
            ${renderField('cwd', item.cwd)}
            ${renderArtifactVersion(item.artifactVersion)}
            ${renderField('signalRule', signalRuleDescription(item))}
            ${renderField('signalMeaning', `原始信号=${item.signalType}；OMK 判断出的失败原因=${item.signalSubtype}。例如 failed_search 表示工具搜索/读取失败，bash_probe/not_found/tool_limit 是 OMK 根据命令和输出内容进一步判断出来的原因。`)}
            ${renderField('occurrencesMeaning', `出现次数=${item.occurrences}；按 skill/cwd/signal/subtype/query/path 聚合去重后的同类事件数量。`)}
            ${renderField('reviewDecision', reviewSeverityMeta(item).decision)}
            ${renderField('firstSeen', item.firstSeen)}
            ${renderField('lastSeen', item.lastSeen)}
            ${renderField('recentSessionIds', item.recentSessionIds.join(', '))}
            <button type="button" onclick="openObservationTrace('${e(item.id)}', this)" style="margin-top:8px;font-size:12px;padding:5px 8px;border:1px solid var(--border);background:var(--bg);border-radius:4px;cursor:pointer">Open in trace</button>
            <pre id="trace-${e(item.id)}" style="display:none;margin:8px 0 0;padding:9px;background:var(--bg-muted);border:1px solid var(--border);border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.45;max-height:360px;overflow:auto;text-align:left"></pre>
          </section>
          <section style="text-align:left;min-width:0">
            <h3 style="font-size:13px;margin:0 0 8px;color:var(--text-primary)">Evidence 明细</h3>
            <div style="color:var(--text-muted);font-size:12px;margin-bottom:8px">这里展示这条聚合记录下面的原始明细。列表里每一条都是一次真实命中的证据；上方表格只展示第一条摘要。</div>
            ${renderEvidenceDetailList(item)}
            <details style="margin-top:10px">
              <summary style="cursor:pointer;color:var(--text-muted);font-size:12px">查看原始 JSON</summary>
              ${renderJson({ evidence: item.evidence, representativeEvidence: item.representativeEvidence })}
            </details>
          </section>
        </div>
      </td>
    </tr>`;
  }).join('');
  const skillGroups = Array.from(items.reduce((map, item) => {
    const existing = map.get(item.skillName) ?? [];
    existing.push(item);
    map.set(item.skillName, existing);
    return map;
  }, new Map<string, ObservationInboxItem[]>()).entries())
    .sort((a, b) => {
      const aHigh = a[1].filter((item) => item.severity === 'high').length;
      const bHigh = b[1].filter((item) => item.severity === 'high').length;
      if (bHigh !== aHigh) return bHigh - aHigh;
      return b[1].length - a[1].length;
    });
  const severityOrder: Array<ObservationInboxItem['severity']> = ['high', 'medium', 'low', 'noise'];
  const severityHeading: Record<ObservationInboxItem['severity'], string> = {
    high: '高风险/需关注',
    medium: '低风险/抽样确认',
    low: '不确定/低优先级',
    noise: '无异常/无需改 skill',
  };
  const severityHeadingZh: Record<ObservationInboxItem['severity'], string> = {
    high: '异常需关注',
    medium: '低风险：Bash 探测',
    low: '不确定信号',
    noise: '无异常：路径/权限/工具限制',
  };
  const skillSections = skillGroups.map(([skillName, groupItems], groupIndex) => {
    const counts = {
      high: groupItems.filter((item) => item.severity === 'high').length,
      medium: groupItems.filter((item) => item.severity === 'medium').length,
      low: groupItems.filter((item) => item.severity === 'low').length,
      noise: groupItems.filter((item) => item.severity === 'noise').length,
    };
    const latestObservation = groupItems.reduce((value, item) => item.lastSeen > value ? item.lastSeen : value, '');
    const latest = latestObservation || skillInvocationLastSeen[skillName] || '';
    const invocationCount = skillInvocationCounts[skillName] ?? groupItems.reduce((sum, item) => sum + item.occurrences, 0);
    const sessionCount = skillSessionCounts[skillName] ?? new Set(groupItems.flatMap((item) => item.recentSessionIds)).size;
    const sourceKinds = Array.from(new Set(groupItems.map((item) => item.sourceKind))).sort();
    const searchText = groupItems.map((item) => [item.sourceKind, item.skillName, item.signalType, item.signalSubtype, semanticEvidence(item), item.cwd, item.sourceTrace].join(' ')).join(' ').toLowerCase();
    const buckets = severityOrder.map((severity) => {
      const bucketItems = groupItems.filter((item) => item.severity === severity);
      if (bucketItems.length === 0) return '';
      return `<section data-observe-skill-bucket="${e(severity)}" style="margin-top:12px">
        <h3 style="font-size:13px;margin:0 0 6px;color:var(--text-primary)">${e(severityHeading[severity])} <span style="color:var(--text-muted);font-weight:400">/ ${e(severityHeadingZh[severity])} (${bucketItems.length})</span></h3>
        <div class="observe-table-wrap" style="width:100%">
        <table class="observe-fit-table review-bucket-table" style="border-collapse:collapse;width:100%;font-size:13px;table-layout:fixed">
          <colgroup>
            <col style="width:190px">
            <col style="width:160px">
            <col style="width:96px">
            <col style="width:126px">
            <col style="width:132px">
            <col style="width:auto">
            <col style="width:82px">
          </colgroup>
          <thead><tr>
            <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)">Severity</th>
            <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)">Signal</th>
            <th style="text-align:right;padding:8px 10px;border-bottom:1px solid var(--border)">出现次数<br><span style="color:var(--text-muted);font-weight:400;font-size:11px">dedup 后同类事件</span></th>
            ${renderConfidenceHeader()}
            <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)">Last seen</th>
            <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)">Evidence</th>
            <th style="text-align:right;padding:8px 10px;border-bottom:1px solid var(--border)">Review</th>
          </tr></thead>
          <tbody>${renderReviewRows(bucketItems, `obs-skill-${groupIndex}-${severity}`)}</tbody>
        </table>
        </div>
      </section>`;
    }).join('');
    return `<details id="${e(skillAnchor(skillName))}" data-observe-skill-group data-search="${e(searchText)}" open style="margin-top:14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);overflow:visible;scroll-margin-top:16px">
      <summary style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;cursor:pointer;list-style:none">
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-family:ui-monospace,monospace;font-size:14px;font-weight:700">${e(skillName)}</span>
            <span title="这个 skill 在当前 trace 里被归因/触发的次数" style="padding:2px 7px;border-radius:999px;background:var(--info-bg);color:var(--accent);font-size:12px;font-weight:650">调用 ${invocationCount} 次</span>
          </div>
          <div style="color:var(--text-muted);font-size:12px;margin-top:3px">${groupItems.length} 过程发现 · ${sessionCount} sessions · source ${e(sourceKinds.join(', '))} · latest ${e(latest.slice(0, 19).replace('T', ' '))}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <span title="高风险/需关注：优先看，可能需要补 SKILL.md 或改 skill 说明" style="padding:3px 7px;border-radius:999px;background:rgba(220,38,38,.08);color:var(--red);font-size:12px">高风险/需关注 ${counts.high}</span>
          <span title="低风险/抽样确认：通常不需要改 skill；抽样确认是否反复浪费时间" style="padding:3px 7px;border-radius:999px;background:rgba(202,138,4,.10);color:var(--yellow);font-size:12px">低风险 ${counts.medium}</span>
          <span title="不确定/低优先级：模型只是说不确定，不一定需要改 skill" style="padding:3px 7px;border-radius:999px;background:rgba(37,99,235,.08);color:var(--accent);font-size:12px">说不确定 ${counts.low}</span>
          <span title="无异常/无需改 skill：更像文件不存在、文件太大、权限或工具限制" style="padding:3px 7px;border-radius:999px;background:var(--bg-muted);color:var(--text-muted);font-size:12px">路径/工具问题 ${counts.noise}</span>
        </div>
      </summary>
      <div style="padding:0 14px 14px">${buckets}</div>
    </details>`;
  }).join('');
  const itemsBySkill = allItems.reduce((map, item) => {
    const existing = map.get(item.skillName) ?? [];
    existing.push(item);
    map.set(item.skillName, existing);
    return map;
  }, new Map<string, ObservationInboxItem[]>());
  const allSkillNames = Array.from(new Set([
    ...Object.keys(skillInvocationCounts),
    ...Array.from(itemsBySkill.keys()),
  ]));
  const skillRollups = allSkillNames.map((skillName) => {
    const groupItems = itemsBySkill.get(skillName) ?? [];
    const counts = {
      high: groupItems.filter((item) => item.severity === 'high').length,
      medium: groupItems.filter((item) => item.severity === 'medium').length,
      low: groupItems.filter((item) => item.severity === 'low').length,
      noise: groupItems.filter((item) => item.severity === 'noise').length,
    };
    const invocationCount = skillInvocationCounts[skillName] ?? groupItems.reduce((sum, item) => sum + item.occurrences, 0);
    const sessionCount = skillSessionCounts[skillName] ?? new Set(groupItems.flatMap((item) => item.recentSessionIds)).size;
    const lastProblemSeen = groupItems.reduce((value, item) => item.lastSeen > value ? item.lastSeen : value, '');
    const lastUsed = skillInvocationLastSeen[skillName] || lastProblemSeen || '';
    const sources = Array.from(new Set(groupItems.map((item) => item.sourceKind))).sort();
    const observationCount = groupItems.length;
    const toolCounts = skillToolCallCounts[skillName] ?? {};
    const metricCounts = {
      bash: toolCounts.Bash ?? 0,
      read: toolCounts.Read ?? 0,
      grep: toolCounts.Grep ?? 0,
      uncertainty: groupItems.filter((item) => item.signalType === 'hedging').reduce((sum, item) => sum + item.occurrences, 0),
      explicitMarker: groupItems.filter((item) => item.signalType === 'explicit_marker').reduce((sum, item) => sum + item.occurrences, 0),
      bashProbe: groupItems.filter((item) => item.signalSubtype === 'bash_probe').reduce((sum, item) => sum + item.occurrences, 0),
      notFound: groupItems.filter((item) => item.signalSubtype === 'not_found').reduce((sum, item) => sum + item.occurrences, 0),
      toolLimit: groupItems.filter((item) => item.signalSubtype === 'tool_limit').reduce((sum, item) => sum + item.occurrences, 0),
      toolFailure: groupItems.filter((item) => item.signalSubtype === 'tool_failure').reduce((sum, item) => sum + item.occurrences, 0),
    };
    const actionableCount = counts.high;
    const reviewLabel = actionableCount > 0
      ? '高风险'
      : counts.medium > 0
        ? '低风险'
        : counts.noise > 0
          ? '无异常'
          : '无异常';
    const reviewColor = actionableCount > 0
      ? 'var(--red)'
      : counts.medium > 0
        ? 'var(--yellow)'
        : counts.noise > 0
          ? 'var(--text-muted)'
          : 'var(--green)';
    return {
      skillName,
      invocationCount,
      sessionCount,
      observationCount,
      counts,
      lastProblemSeen,
      lastUsed,
      sources,
      metricCounts,
      reviewLabel,
      reviewColor,
    };
  }).sort((a, b) => {
    const aRisk = a.counts.high * 100 + a.counts.medium * 10 + a.counts.noise;
    const bRisk = b.counts.high * 100 + b.counts.medium * 10 + b.counts.noise;
    if (bRisk !== aRisk) return bRisk - aRisk;
    return b.invocationCount - a.invocationCount;
  });
  const skillRollupRows = skillRollups.map((row) => {
    const hasDetail = (itemsBySkill.get(row.skillName)?.length ?? 0) > 0;
    return `<tr data-observe-rollup-row data-skill-anchor="${e(skillAnchor(row.skillName))}" style="${hasDetail ? 'cursor:pointer' : ''}">
      <td style="padding:9px 10px;font-family:ui-monospace,monospace;font-weight:650;word-break:break-all">${e(row.skillName)}</td>
      <td class="num" style="padding:9px 10px;text-align:right;font-weight:700">${row.invocationCount}</td>
      <td class="num" style="padding:9px 10px;text-align:right">${row.sessionCount}</td>
      <td class="num" style="padding:9px 10px;text-align:right">${row.observationCount}</td>
      <td class="experience-evidence-cell" style="padding:9px 10px;color:var(--text-secondary);font-size:12px;line-height:1.55">
        ${metric('Bash调用', row.metricCounts.bash, 'bash')} ·
        ${metric('Read', row.metricCounts.read, 'read')} ·
        ${metric('Grep', row.metricCounts.grep, 'grep')}<br>
        ${metric('回答不确定', row.metricCounts.uncertainty, 'hedging')} ·
        ${metric('明确说缺口', row.metricCounts.explicitMarker, 'explicitMarker')} ·
        ${metric('Bash试探', row.metricCounts.bashProbe, 'bashProbe')}<br>
        ${metric('路径不存在', row.metricCounts.notFound, 'notFound')} ·
        ${metric('工具限制', row.metricCounts.toolLimit, 'toolLimit')} ·
        ${metric('工具执行失败', row.metricCounts.toolFailure, 'toolFailure')}
      </td>
      <td class="num" style="padding:9px 10px;text-align:right;color:var(--red);font-weight:650">${row.counts.high}</td>
      <td class="num" style="padding:9px 10px;text-align:right;color:var(--yellow);font-weight:650">${row.counts.medium + row.counts.low}</td>
      <td class="num" style="padding:9px 10px;text-align:right;color:var(--text-muted)">${row.counts.noise}</td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:12px" title="${row.lastProblemSeen ? '最近一次产生 过程发现 的时间' : '当前没有发现问题或旧 report 没有 过程发现 时间'}">${row.lastProblemSeen ? e(row.lastProblemSeen.slice(0, 19).replace('T', ' ')) : '—'}</td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:12px" title="${row.lastUsed ? '最近一次在 trace 中识别到 skill 调用的时间' : '当前 过程发现 report 中没有这个 skill 的调用时间信息；旧 report 需要重新 ingest 才会补齐'}">${row.lastUsed ? e(row.lastUsed.slice(0, 19).replace('T', ' ')) : '—'}</td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:12px">${row.sources.length > 0 ? e(row.sources.join(', ')) : '—'}</td>
      <td style="padding:9px 10px;text-align:right">
        <span style="display:inline-flex;width:max-content;padding:3px 7px;border-radius:999px;background:var(--bg-muted);color:${row.reviewColor};font-size:12px;font-weight:650">${e(row.reviewLabel)}</span>
      </td>
    </tr>`;
  }).join('');
  const actionItems = skillRollups
    .filter((row) => row.observationCount > 0)
    .map((row) => {
      const groupItems = itemsBySkill.get(row.skillName) ?? [];
      const repeatedMedium = groupItems
        .filter((item) => item.severity === 'medium')
        .reduce((sum, item) => sum + item.occurrences, 0);
      const noiseCount = groupItems
        .filter((item) => item.severity === 'noise')
        .reduce((sum, item) => sum + item.occurrences, 0);
      let priority = 'P2';
      let action = '打开明细看 1-2 条证据';
      let reason = '这类记录说明运行中出现过异常信号，但现在还不能直接判断 skill 需要修改。';
      let color = 'var(--text-muted)';
      if (row.counts.high > 0) {
        priority = 'P0';
        action = '先看这个 skill 是否漏写了关键信息';
        reason = '有高风险记录：agent 查找失败后，没有看到它在同一轮里找到替代结果，或回答里明确暴露了缺口。';
        color = 'var(--red)';
      } else if (repeatedMedium >= 3) {
        priority = 'P1';
        action = '看是否要补一段“推荐查找路径”';
        reason = `agent 在这个 skill 运行时反复试目录或路径，共 ${repeatedMedium} 次。单次不用改，但反复出现可能说明 skill 没告诉它该优先看哪里。`;
        color = 'var(--yellow)';
      } else if (row.counts.medium > 0 || row.counts.low > 0) {
        priority = 'P2';
        action = '抽几条看看是否真的影响使用';
        reason = '当前主要是低风险记录：可能只是 agent 正常探索路径，或回答里出现了不确定表达。先看样例，不要直接改 skill。';
        color = 'var(--yellow)';
      } else if (noiseCount > 0) {
        priority = 'P3';
        action = '暂时不用改 skill';
        reason = '当前只有文件不存在、权限、文件过大或工具执行失败这类记录。它们更像运行环境或工具限制，默认不作为 skill 修改依据。';
        color = 'var(--text-muted)';
      }
      const topItem = groupItems[0];
      return {
        skillName: row.skillName,
        priority,
        action,
        reason,
        color,
        evidenceCount: groupItems.reduce((sum, item) => sum + item.occurrences, 0),
        anchor: skillAnchor(row.skillName),
        sample: topItem ? evidenceConclusion(topItem) : '',
      };
    })
    .sort((a, b) => {
      const rank: Record<string, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };
      const byPriority = (rank[b.priority] ?? 0) - (rank[a.priority] ?? 0);
      if (byPriority !== 0) return byPriority;
      return b.evidenceCount - a.evidenceCount;
    });
  const actionRows = actionItems.slice(0, 8).map((item) => `
    <tr data-observe-rollup-row data-skill-anchor="${e(item.anchor)}" style="cursor:pointer">
      <td style="padding:9px 10px;color:${item.color};font-weight:700">${e(item.priority)}</td>
      <td style="padding:9px 10px;font-family:ui-monospace,monospace;font-weight:650;word-break:break-all">${e(item.skillName)}</td>
      <td style="padding:9px 10px;color:var(--text-primary);font-weight:650">${e(item.action)}</td>
      <td style="padding:9px 10px;color:var(--text-secondary);line-height:1.45">${e(item.reason)}</td>
      <td class="num" style="padding:9px 10px;text-align:right">${item.evidenceCount}</td>
    </tr>
  `).join('');
  const funnelRows = [
    {
      stage: '1. 调用 skill',
      status: '当前能统计',
      count: totalSkillInvocations,
      desc: '用户或 agent 是否真的用了某个 skill。这里统计的是 trace 中识别到的 skill 调用次数，已排除没有归属到具体 skill 的 general 片段。',
    },
    {
      stage: '2. 运行过程中',
      status: '当前能统计',
      count: allItems.filter((item) => item.signalType === 'failed_search' || item.signalType === 'repeated_failure').reduce((sum, item) => sum + item.occurrences, 0),
      desc: 'skill 运行时，agent 调用了 Read、Grep、Bash 等工具。这里统计工具查找失败、读取失败、Bash 命令异常等记录。',
    },
    {
      stage: '3. 回答阶段',
      status: '只能部分统计',
      count: allItems.filter((item) => item.signalType === 'hedging' || item.signalType === 'explicit_marker').reduce((sum, item) => sum + item.occurrences, 0),
      desc: 'agent 给出回答时，是否出现“不确定、没找到、需要确认”等表达。它只能作为弱信号，不能单独证明 skill 有问题。',
    },
    {
      stage: '4. skill 调用是否跑完',
      status: '只能部分统计',
      count: totalSkillInvocations,
      desc: '当前只能确认 trace 里出现了完整的 skill 调用片段。tool_result 能说明单个工具是否成功，但还不能证明整个 skill 调用产出了正确结果。',
    },
    {
      stage: '5. 用户目标是否完成',
      status: '当前不能统计',
      count: '—',
      desc: '当前不统计。trace 里的 tool_result 只能说明某次工具执行成功或失败，不能证明用户目标已经完成、答案被接受，或用户没有换 session 继续问。',
    },
    {
      stage: '6. 改版后是否变好',
      status: '当前不能统计',
      count: '—',
      desc: '当前不统计。还没有把 SKILL.md 的版本、改动时间和 过程发现 趋势关联起来，所以不能判断 v2 是否比 v1 更好。',
    },
  ];
  const funnelHtml = funnelRows.map((row, index) => {
    const color = row.status === '当前能统计' ? 'var(--green)' : row.status === '只能部分统计' ? 'var(--yellow)' : 'var(--text-muted)';
    const width = Math.max(66, 100 - index * 6);
    return `<div style="width:${width}%;min-width:0;max-width:100%;margin:0 auto;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);position:relative">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <span style="font-weight:650;color:var(--text-primary);line-height:1.3;font-size:12px">${e(row.stage)}</span>
        <span style="font-size:11px;color:${color};font-weight:650;white-space:nowrap">${e(row.status)}</span>
      </div>
      <div style="font-size:17px;font-weight:700;margin-top:3px;color:var(--text-primary)">${e(String(row.count))}</div>
      <div
        class="signal-help"
        tabindex="0"
        data-signal-title="${e(row.stage)}"
        data-signal-description="${e(row.desc)}"
        aria-label="${e(row.desc)}"
        style="font-size:11px;color:var(--text-muted);line-height:1.35;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;cursor:help"
      >${e(row.desc)}</div>
    </div>`;
  }).join('');
  const rawRows = reports.flatMap((report, reportIndex) => report.items.map((item, itemIndex) => {
    const rawId = `obs-raw-${reportIndex}-${itemIndex}`;
    const color = item.severity === 'high' ? 'var(--red)' : item.severity === 'medium' ? 'var(--yellow)' : item.severity === 'noise' ? 'var(--text-muted)' : 'var(--accent)';
    return `<tr>
      <td style="padding:8px 10px;color:${color};font-weight:600">${item.severity}</td>
      <td style="padding:8px 10px">${renderSignalLabel(item)}</td>
      <td style="padding:8px 10px;font-family:ui-monospace,monospace">${item.skillName}</td>
      <td style="padding:8px 10px">${renderSourceBadge(item)}</td>
      <td class="num" style="padding:8px 10px;text-align:right">${item.confidence.toFixed(2)} / ${item.attributionConfidence.toFixed(2)}</td>
      <td style="padding:8px 10px">${renderEvidenceCell(item, 180)}</td>
      <td class="num" style="padding:8px 10px;text-align:right"><button type="button" onclick="toggleObservationDetail('${rawId}', this)" style="font-size:12px;padding:4px 8px;border:1px solid var(--border);background:var(--bg);border-radius:4px;cursor:pointer">${lang === 'zh' ? '原始 JSON' : 'Raw JSON'}</button></td>
    </tr>
    <tr id="${rawId}" style="display:none;background:var(--bg-muted)">
      <td colspan="7" style="padding:14px 18px;border-bottom:1px solid var(--border);text-align:left">
        ${renderJson(item)}
      </td>
    </tr>`;
  })).join('');
  const rawReportBlocks = reports.map((report, index) => `
    <section style="margin-top:18px">
      <h3 style="font-size:14px;margin:0 0 8px;color:var(--text-primary)">过程发现 JSON ${index + 1}</h3>
      <div style="color:var(--text-muted);font-size:12px;margin-bottom:8px">
        tracePath=${e(report.meta.tracePath)} · generatedAt=${e(report.meta.generatedAt)} · segments=${report.meta.segmentCount} · items=${report.meta.itemCount}
      </div>
      ${renderJson(report)}
    </section>
  `).join('');
  const experienceGoalById = new Map((experience?.goalSlices ?? []).map((goal) => [goal.id, goal]));
  const metricGuideSections: Array<{ title: string; keys: IndicatorHelpKey[] }> = [
    { title: '用户交互', keys: ['userCorrection', 'userInterruption', 'userFollowUp', 'negativeFeedback', 'positiveFeedback', 'userGoalShift', 'hardRule'] },
    { title: 'Skill 执行', keys: ['toolCall', 'toolFailure', 'bash', 'read', 'grep'] },
    { title: '过程发现', keys: ['highObservation', 'mediumObservation', 'hedging', 'explicitMarker', 'bashProbe', 'notFound', 'toolLimit'] },
  ];
  const metricGuideHtml = metricGuideSections.map((section) => `
    <section class="metric-guide-section">
      <h3>${e(section.title)}</h3>
      ${section.keys.map((key) => `
        <button type="button" class="metric-guide-item" data-metric-guide-key="${key}" onclick="openMetricGuide('${key}')">
          <strong>${e(indicatorLabels[key])}</strong>
          <span>${e(indicatorHelps[key])}</span>
        </button>
      `).join('')}
    </section>
  `).join('');
  const renderSessionGoals = (goalSliceIds: string[]): string => {
    const goals = goalSliceIds
      .map((id) => experienceGoalById.get(id))
      .filter((goal): goal is NonNullable<ReturnType<typeof experienceGoalById.get>> => Boolean(goal))
      .map((goal) => goal.inferredUserGoal || '未提取到明确用户目标');
    if (goals.length === 0) return '<span style="color:var(--text-muted)">未提取到明确用户目标</span>';
    return `<div class="goal-list">${goals.map((goal, index) => `
      <div class="goal-item">
        <span>目标切片 ${index + 1}/${goals.length}</span>
        <div>${e(goal)}</div>
      </div>
    `).join('')}</div>`;
  };
  const experienceSkillRows = (experience?.skills ?? []).map((skill) => {
    const indicators = displayIndicatorsBySkill.get(skill.skillName) ?? skill.indicators;
    const shownPriority = displayPriority(indicators);
    const shownInference = displayAssistiveInference(indicators, skill.assistiveInference);
    const chainId = `context-chain-${experienceSkillAnchor(skill.skillName)}`;
    const entrypointText = compactRankedCountText(skill.entrypointCounts, { label: formatEntrypoint });
    const originText = compactRankedCountText(experienceSkillOriginCountsBySkill.get(skill.skillName) ?? (
      (skill.pluginNames ?? []).length > 0
        ? Object.fromEntries((skill.pluginNames ?? []).map((plugin) => [`Skill 来源：插件 ${plugin}`, 1]))
        : { 'Skill 来源：本地 skill': skill.invocationCount }
    ));
    const attributionText = compactRankedCountText(experienceAttributionCountsBySkill.get(skill.skillName) ?? (
      Object.keys(skill.attributionCounts ?? {}).length > 0
        ? Object.fromEntries(Object.entries(skill.attributionCounts).map(([key, count]) => [formatAttributionSource(key), count]))
        : {}
    ));
    return `<tr data-observe-rollup-row data-skill-anchor="${e(experienceSkillAnchor(skill.skillName))}" style="cursor:pointer">
      <td style="padding:9px 10px;font-family:ui-monospace,monospace;font-weight:650;word-break:break-all">${e(skill.skillName)}</td>
      <td class="num" title="skill 调用段数：同一个 session 内多次触发同一个 skill，会累计为多次调用段。" style="padding:9px 10px;text-align:right;font-weight:700">${skill.invocationCount}<br><span style="color:var(--text-muted);font-size:10px;font-weight:400">调用段</span></td>
      <td class="num" title="需要优先打开看证据的 session 数" style="padding:9px 6px;text-align:right;color:var(--red);font-weight:650">${skill.reviewFirstSessionCount}</td>
      <td class="num" title="适合抽样确认的 session 数" style="padding:9px 6px;text-align:right;color:var(--yellow);font-weight:650">${skill.sampleReviewSessionCount}</td>
      <td class="experience-evidence-cell" data-no-rollup-click="1" style="padding:8px 10px;color:var(--text-secondary);font-size:11px;line-height:1.45">
        ${renderSkillEvidenceSummary(skill)}
      </td>
      <td data-no-rollup-click="1" style="padding:9px 10px;color:var(--text-secondary);font-size:11px;line-height:1.45">${renderSkillChainSummary(skill.skillName)}</td>
      <td data-no-rollup-click="1" style="padding:9px 10px;text-align:center">${renderSkillChainButton(skill.skillName, chainId)}</td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:11px;line-height:1.45">
        <div>入口：${e(entrypointText)}</div>
        <div>${e(originText)}</div>
        <div>触发判断：${e(attributionText)}</div>
      </td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:12px">${e(skill.lastSeen.slice(0, 19).replace('T', ' '))}</td>
      <td data-no-rollup-click="1" style="padding:9px 10px;text-align:right">
        ${renderPriorityBadge(shownPriority)}
        <div style="margin-top:5px;text-align:left">${renderAssistiveInference(shownInference, true)}</div>
      </td>
    </tr>
    <tr id="${e(chainId)}" data-context-chain-template style="display:none">
      <td colspan="10">${renderSkillChainTemplate(skill.skillName)}</td>
    </tr>`;
  }).join('');
  const renderExperienceSessionRows = (sessions: ExperienceSessionSummary[], idPrefix: string): string => sessions.map((session, index) => {
    const detailId = `${idPrefix}-session-${index}`;
    const evidenceChain = session.evidenceChain ?? fallbackEvidenceChain(session);
    const indicators = displayIndicatorsForSession(session);
    const shownPriority = displayPriority(indicators);
    const shownRuleFindings = displayRuleFindings(session, indicators);
    const shownInference = displayAssistiveInference(indicators, session.assistiveInference);
    const shownBasisCodes = displayBasisCodes(indicators);
    const pluginNames = session.pluginNames ?? [];
    const commandNames = session.commandNames ?? [];
    const attributionSources = session.attributionSources ?? [];
    const sessionOriginText = pluginNames.length > 0 ? `Skill 来源：插件 ${pluginNames.join('、')}` : 'Skill 来源：本地 skill';
    const sessionAttributionText = commandNames.length > 0
      ? `触发判断：通过斜杠命令触发 ${commandNames.join('、')}`
      : `触发判断：${attributionSources.map(formatAttributionSource).join('、') || '未记录'}`;
    return `<tr data-observe-experience-session>
      <td style="padding:9px 10px">
        ${renderPriorityBadge(shownPriority)}
        <div style="margin-top:6px">${renderAssistiveInference(shownInference, true)}</div>
        <div style="margin-top:7px">${renderReviewStateControls('experience_session', session.id)}</div>
      </td>
      <td style="padding:9px 10px;font-family:ui-monospace,monospace;font-size:12px;color:var(--text-muted);word-break:break-all">${e(session.sessionId)}<br><span style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--accent)">入口：${e(formatEntrypoint(session.entrypoint))}</span><br><span style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--text-muted)">${e(sessionOriginText)}</span><br><span style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--text-muted)">${e(sessionAttributionText)}</span></td>
      <td style="padding:9px 10px">${renderInvocationSummary(indicators, session.invocationIds.length)}</td>
      <td style="padding:9px 10px;color:var(--text-secondary);line-height:1.45">${renderSessionGoals(session.goalSliceIds)}</td>
      <td style="padding:9px 10px">${renderRuleFindings(shownRuleFindings, true)}</td>
      <td style="padding:9px 10px;color:var(--text-secondary);font-size:12px;line-height:1.55">
        ${metric('纠正', indicators.userCorrectionCount, 'userCorrection', sessionMetricSourceTitle(session, 'user_correction', '纠正'))} ·
        ${metric('人工中断', indicators.userInterruptionCount, 'userInterruption', sessionMetricSourceTitle(session, 'user_interruption', '人工中断'))} ·
        ${metric('追问', indicators.userFollowUpCount, 'userFollowUp', sessionMetricSourceTitle(session, 'user_follow_up', '追问'))} ·
        ${metric('负向反馈', indicators.negativeFeedbackCount ?? 0, 'negativeFeedback', sessionMetricSourceTitle(session, 'negative_feedback', '负向反馈'))} ·
        ${metric('正向反馈', indicators.positiveFeedbackCount ?? 0, 'positiveFeedback', sessionMetricSourceTitle(session, 'positive_feedback', '正向反馈'))} ·
        ${metric('目标切换', indicators.userGoalShiftCount ?? 0, 'userGoalShift', sessionMetricSourceTitle(session, 'user_goal_shift', '目标切换'))}<br>
        ${metric('工具执行失败', indicators.toolFailureCount, 'toolFailure')} ·
        ${metric('高优先级过程发现', indicators.highObservationCount, 'highObservation')}
      </td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:12px;white-space:normal">${e(session.endTimestamp.slice(0, 19).replace('T', ' '))}</td>
      <td class="num" style="padding:9px 10px;text-align:right"><button type="button" onclick="event.stopPropagation(); openExperienceDetailModal('${detailId}', this)" style="font-size:12px;padding:5px 10px;border:1px solid var(--border);background:var(--bg);border-radius:4px;cursor:pointer;white-space:nowrap">回溯详情</button></td>
    </tr>
    <tr id="${detailId}" data-experience-detail-template style="display:none;background:var(--bg-muted)">
      <td colspan="8" style="padding:0;border-bottom:1px solid var(--border);text-align:left">
        <div class="experience-detail-shell">
        <div class="experience-detail-grid" style="display:grid;grid-template-columns:minmax(0,.6fr) minmax(0,1.4fr);gap:16px;align-items:stretch">
          <section class="experience-detail-left">
            <h3 style="font-size:13px;margin:0 0 8px;color:var(--text-primary)">证据链（C1）</h3>
            <div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:8px">这块说明本次复盘用了哪些原始上下文：人工用户消息、Skill 注入、工具调用、工具执行结果和过程发现。它只回答“证据从哪里来”。</div>
            ${renderEvidenceChain(evidenceChain)}
            <h3 style="font-size:13px;margin:14px 0 8px;color:var(--text-primary)">规则命中（C2）</h3>
            <div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:8px">这块把可数的规则信号列出来，例如用户纠正、人工中断、工具执行失败、用户硬性要求。它不包含 LLM 语义评分，也不自动判断 skill 最终好坏。</div>
            ${renderRuleFindings(shownRuleFindings)}
            <h3 style="font-size:13px;margin:14px 0 8px;color:var(--text-primary)">复盘建议（C3，无 LLM）</h3>
            <div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:8px">这块只根据固定规则给“是否值得先看”的建议，例如优先复盘、抽样确认、上下文不足。它不是“符合预期/不符合预期”的最终结论。</div>
            ${renderAssistiveInference(shownInference)}
            <h3 style="font-size:13px;margin:14px 0 8px;color:var(--text-primary)">人工复盘标记（D1 前置）</h3>
            ${renderReviewStateControls('experience_session', session.id)}
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.55">
              <div>调用摘要：调用段 ${session.invocationIds.length} · 工具调用 ${indicators.toolCallCount} · 工具执行失败 ${indicators.toolFailureCount} · 人工中断 ${indicators.userInterruptionCount}</div>
              <div>复盘分数：${session.reviewPriorityScore}</div>
              <div>关联 invocation：${session.invocationIds.length}</div>
              <div>关联过程发现：${session.relatedObservationIds.length}</div>
              <div style="margin-top:8px">${renderExperienceBasis(shownBasisCodes)}</div>
            </div>
            ${renderJson({ id: session.id, sourceTrace: session.sourceTrace, cwd: session.cwd, evidenceChain, ruleFindings: shownRuleFindings, assistiveInference: shownInference, reviewState: reviewState.entries[reviewStateKey('experience_session', session.id)], indicators, relatedObservationIds: session.relatedObservationIds })}
          </section>
          <section class="experience-detail-right">
            <h3 style="font-size:13px;margin:0 0 8px;color:var(--text-primary)">C1 上下文时间线片段</h3>
            ${renderTimelinePair(session)}
          </section>
        </div>
        </div>
      </td>
    </tr>`;
  }).join('');
  const sessionSkillOrder = new Map((experience?.skills ?? []).map((skill, index) => [skill.skillName, index]));
  const experienceSessionGroups = Array.from((experience?.sessions ?? []).reduce((map, session) => {
    const group = map.get(session.skillName) ?? [];
    group.push(session);
    map.set(session.skillName, group);
    return map;
  }, new Map<string, ExperienceSessionSummary[]>()).entries())
    .sort((a, b) => (sessionSkillOrder.get(a[0]) ?? Number.MAX_SAFE_INTEGER) - (sessionSkillOrder.get(b[0]) ?? Number.MAX_SAFE_INTEGER));
  const experienceSessionGroupsHtml = experienceSessionGroups.map(([skillName, sessions], groupIndex) => {
    const latest = sessions.reduce((max, session) => session.endTimestamp > max ? session.endTimestamp : max, sessions[0]?.endTimestamp ?? '');
    const reviewFirst = sessions.filter((session) => session.reviewPriority === 'review_first').length;
    const sampleReview = sessions.filter((session) => session.reviewPriority === 'sample_review').length;
    return `<details id="${e(experienceSkillAnchor(skillName))}" class="experience-session-group" open style="scroll-margin-top:16px">
      <summary>
        <div>
          <span class="experience-session-skill">${e(skillName)}</span>
          <span class="experience-session-meta">${sessions.length} sessions · 最近 ${e(latest.slice(0, 19).replace('T', ' '))}</span>
        </div>
        <div class="experience-session-tags">
          <span style="color:var(--red)">优先复盘 ${reviewFirst}</span>
          <span style="color:var(--yellow)">抽样复盘 ${sampleReview}</span>
        </div>
      </summary>
      <div class="observe-table-wrap" style="width:100%;border-top:1px solid var(--border)">
        <table class="observe-fit-table experience-session-table" style="border-collapse:collapse;width:100%;font-size:13px;table-layout:fixed;border:0;border-radius:0;background:transparent">
          <colgroup>
            <col><col><col><col><col><col><col><col>
          </colgroup>
          <thead><tr>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">复盘优先级</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">Session</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">调用摘要</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">用户目标切片</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">C2 规则判断</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">关键指标</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">最近时间</th>
            <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">回溯</th>
          </tr></thead>
          <tbody>${renderExperienceSessionRows(sessions, `exp-skill-${groupIndex}`)}</tbody>
        </table>
      </div>
    </details>`;
  }).join('');
  const experienceIndicators = experience?.skills.reduce((acc, skill) => ({
    toolCallCount: acc.toolCallCount + skill.indicators.toolCallCount,
    toolFailureCount: acc.toolFailureCount + skill.indicators.toolFailureCount,
    userInterruptionCount: acc.userInterruptionCount + skill.indicators.userInterruptionCount,
  }), { toolCallCount: 0, toolFailureCount: 0, userInterruptionCount: 0 }) ?? { toolCallCount: 0, toolFailureCount: 0, userInterruptionCount: 0 };
  const experienceToolSuccessCount = Math.max(0, experienceIndicators.toolCallCount - experienceIndicators.toolFailureCount);
  const experienceReviewSkillCount = experience?.skills.filter((skill) => skill.reviewFirstSessionCount + skill.sampleReviewSessionCount > 0).length ?? 0;
  const experienceReviewSessionCount = experience?.sessions.filter((session) => session.reviewPriority !== 'routine_sample').length ?? 0;
  const experienceReviewFirstSessionCount = experience?.sessions.filter((session) => session.reviewPriority === 'review_first').length ?? 0;
  const experienceSampleReviewSessionCount = experience?.sessions.filter((session) => session.reviewPriority === 'sample_review').length ?? 0;
	  const experienceSection = experience ? `
	      <section style="margin-top:16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);overflow:hidden">
	        <div style="padding:13px 14px;border-bottom:1px solid var(--border)">
	          <h2 style="font-size:15px;margin:0;color:var(--text-primary)">V1 · Skill 实战复盘${activeSkill ? ` · ${e(activeSkill)}` : ''}</h2>
          <div style="color:var(--text-muted);font-size:12px;margin-top:4px">
            这一层只做证据展开和复盘优先级排序，不自动给 skill 打最终好坏结论。路径是：Skill 总览 → Session 复盘队列 → 目标切片/判断依据 → 时间线上下文。
          </div>
        </div>
        <div style="padding:12px 14px">
          <div class="experience-stat-grid" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px">
            <div style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-muted)" title="这里的成功/失败是工具调用结果统计，不等同于 LLM 判断 skill 最终成功或失败。">
              <div style="color:var(--text-muted);font-size:12px">调用概览</div>
              <div style="font-size:20px;font-weight:700;margin-top:4px">Session ${experience.meta.sessionCount} · Skill 调用 ${experience.meta.invocationCount}</div>
              <div style="color:var(--text-muted);font-size:12px;margin-top:4px">工具执行成功 ${experienceToolSuccessCount} / ${pct(experienceToolSuccessCount, experienceIndicators.toolCallCount)} · 工具执行失败 ${experienceIndicators.toolFailureCount} / ${pct(experienceIndicators.toolFailureCount, experienceIndicators.toolCallCount)} · 人工中断 ${experienceIndicators.userInterruptionCount} / ${pct(experienceIndicators.userInterruptionCount, experienceIndicators.toolCallCount)}</div>
            </div>
            <div style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-muted)">
              <div style="color:var(--text-muted);font-size:12px">Skill 总数</div>
              <div style="font-size:24px;font-weight:700;margin-top:4px">${experience.meta.skillCount}</div>
              <div style="color:var(--text-muted);font-size:12px">当前 trace 中识别到的 skill</div>
            </div>
            <div style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-muted)">
              <div style="color:var(--text-muted);font-size:12px">建议 review</div>
              <div style="font-size:24px;font-weight:700;color:var(--red);margin-top:4px">${experienceReviewSkillCount}</div>
              <div style="color:var(--text-muted);font-size:12px">${experienceReviewSessionCount} 个 session · 优先 ${experienceReviewFirstSessionCount} · 抽样 ${experienceSampleReviewSessionCount}</div>
            </div>
          </div>
          <h3 style="font-size:13px;margin:4px 0 8px;color:var(--text-primary)">Layer 1 · Skill 总览</h3>
          <div class="observe-table-wrap experience-layer-scroll" style="width:100%;border:1px solid var(--border);border-radius:8px">
            <table class="observe-fit-table experience-skill-table" style="border-collapse:collapse;width:100%;font-size:13px;table-layout:fixed">
              <colgroup>
                <col style="width:11%">
                <col style="width:4%">
                <col style="width:4%">
                <col style="width:4%">
                <col style="width:39%">
                <col style="width:9%">
                <col style="width:6%">
                <col style="width:13%">
                <col style="width:5%">
                <col style="width:5%">
              </colgroup>
              <thead><tr>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">Skill</th>
                <th title="skill 调用段数：同一个 session 内多次触发同一个 skill，会累计为多次调用段。" style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">调用段</th>
                <th title="需要优先打开看证据的 session 数" style="text-align:right;padding:9px 6px;border-bottom:1px solid var(--border)">优先复盘</th>
                <th title="适合抽样确认的 session 数" style="text-align:right;padding:9px 6px;border-bottom:1px solid var(--border)">抽样复盘</th>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">用户交互 / 执行证据</th>
                <th title="来自 SKILL.md frontmatter 的结构化 hardRules / workflows；这里只做静态输入检查，运行时遵守情况暂不判断。" style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">标准定义</th>
                <th title="查看 skill 定义、doctor 静态检查和 observe 运行时边界" style="text-align:center;padding:9px 10px;border-bottom:1px solid var(--border)">运行时链路</th>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">入口 / 来源 / 归因</th>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">最近使用</th>
                <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">复盘优先级</th>
              </tr></thead>
              <tbody>${experienceSkillRows}</tbody>
            </table>
          </div>
          <h3 style="font-size:13px;margin:16px 0 4px;color:var(--text-primary)">Layer 2 · Session 复盘队列</h3>
          <div style="color:var(--text-muted);font-size:12px;margin-bottom:8px">先按 skill 聚合；展开某个 skill 后，再看它在不同 session 里的目标切片、判断依据和时间线回溯。</div>
          <div class="experience-layer-scroll experience-session-groups">
            ${experienceSessionGroupsHtml || `<div style="padding:14px;color:var(--text-muted)">暂无 session 复盘数据。</div>`}
          </div>
        </div>
      </section>
  ` : '';
	  const empty = items.length === 0 && !experience
	    ? `<p style="color:var(--text-muted);margin-top:24px">${activeSkill ? `当前 skill 没有可展示的调用或过程发现：${e(activeSkill)}` : (lang === 'zh' ? '暂无 inbox item。运行 omk observe ingest <sessions-dir> 生成。' : 'No inbox items. Run omk observe ingest <sessions-dir> first.')}</p>`
	    : '';
  const v0SummarySection = `
      <section class="observe-summary-grid" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px">
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface)">
          <div style="color:var(--text-muted);font-size:12px">需要优先 review</div>
          <div style="font-size:24px;font-weight:700;color:var(--red);margin-top:4px">${severitySkillCounts.high}</div>
          <div style="color:var(--text-muted);font-size:12px">个 skill 有高风险</div>
        </div>
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface)">
          <div style="color:var(--text-muted);font-size:12px">低风险/抽样确认</div>
          <div style="font-size:24px;font-weight:700;color:var(--yellow);margin-top:4px">${countSkillsBySeverity('medium', 'low')}</div>
          <div style="color:var(--text-muted);font-size:12px">个 skill 是低风险或不确定</div>
        </div>
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface)">
          <div style="color:var(--text-muted);font-size:12px">无异常/无需改 skill</div>
          <div style="font-size:24px;font-weight:700;color:var(--text-muted);margin-top:4px">${severitySkillCounts.noise}</div>
          <div style="color:var(--text-muted);font-size:12px">个 skill 无异常，仅路径/权限/工具问题</div>
        </div>
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface)">
          <div style="color:var(--text-muted);font-size:12px">数据范围</div>
          <div style="font-size:18px;font-weight:700;margin-top:6px">${skillCount} trace skills</div>
          <div style="color:var(--text-muted);font-size:12px">${totalSkillInvocations} skill 调用 · ${allItems.length} 过程发现</div>
          <div style="color:var(--text-muted);font-size:12px">${reportCount} reports · latest ${e(latestSeenLabel)}</div>
          <div style="color:var(--text-muted);font-size:12px">当前只展示最新一次 ingest 的结果</div>
        </div>
      </section>`;
	  return layout(pageTitle, `
	    <main class="observe-report-root" style="max-width:1120px;margin:0 auto;padding:24px">
	      <nav style="margin-bottom:12px"><a href="/analyses" style="color:var(--accent);text-decoration:none">${lang === 'zh' ? 'Skill 健康度日报' : 'Skill health reports'}</a></nav>
	      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:8px 0">
	        <div>
	          <h1 style="font-size:22px;margin:0">${activeSkill ? `Observe Inbox · ${e(activeSkill)}` : 'Observe Inbox'}</h1>
	          ${activeSkill ? `<div style="color:var(--text-muted);font-size:12px;margin-top:4px">当前是单 skill 报告，只展示 ${e(activeSkill)} 的调用、session 复盘、过程发现和原始 JSON。</div>` : ''}
	        </div>
	        ${activeSkill ? `<a href="/observations/inbox" style="color:var(--accent);text-decoration:none;font-size:13px">查看全量报告</a>` : ''}
	      </div>
      <p style="color:var(--text-muted);font-size:13px">真实 session trace 中聚合出的待 review 问题。判断把握表示这条 过程发现 的规则判断有多确定；归属把握表示它归到当前 skill 名下有多确定。</p>
      <style>
        *,
        *::before,
        *::after {
          box-sizing: border-box;
        }
        html,
        body {
          width: 100vw !important;
          max-width: 100vw !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow-x: hidden !important;
        }
        main {
          width: min(1120px, calc(100vw - 32px)) !important;
          max-width: 100% !important;
          margin: 0 auto !important;
          padding: 24px 16px !important;
          overflow-x: hidden !important;
        }
        body > * {
          max-width: 100vw !important;
        }
        .observe-report-root {
          font-size: 12px !important;
          line-height: 1.45;
        }
        .observe-report-root h1 { font-size: 20px !important; }
        .observe-report-root h2 { font-size: 14px !important; }
        .observe-report-root h3 { font-size: 12px !important; }
        .observe-report-root table { font-size: 12px !important; }
        .observe-report-root th {
          font-size: 10.5px !important;
          padding: 7px 8px !important;
        }
        .observe-report-root td {
          font-size: 11.5px !important;
          padding: 7px 8px !important;
        }
        .observe-report-root button,
        .observe-report-root input {
          font-size: 12px !important;
        }
        .observe-report-root,
        .observe-report-root section,
        .observe-report-root details,
        .observe-report-root summary,
        .observe-report-root div,
        .observe-report-root article {
          min-width: 0;
        }
        .observe-report-root pre,
        .observe-report-root code {
          max-width: 100%;
        }
        .observe-table-wrap {
          width: 100%;
          max-width: 100%;
          min-width: 0;
          overflow-x: auto !important;
          overflow-y: visible;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior-x: contain;
        }
        .experience-layer-scroll {
          max-height: 80vh;
          overflow: auto !important;
          overscroll-behavior: contain;
        }
        .observe-fit-table,
        #observe-tab-review table,
        #observe-tab-raw table {
          width: 100% !important;
          table-layout: fixed;
        }
        .review-bucket-table { min-width: 980px !important; }
        .experience-skill-table { min-width: 1680px !important; }
        .experience-session-table { min-width: 1480px !important; }
        .skill-health-table { min-width: 1360px !important; }
        .action-table { min-width: 820px !important; }
        .raw-observation-table { min-width: 1040px !important; }
        .scoring-guide-table { min-width: 720px !important; }
        .observe-fit-table col,
        #observe-tab-review col,
        #observe-tab-raw col {
          width: auto !important;
        }
        .experience-skill-table col:nth-child(1) { width: 11% !important; }
        .experience-skill-table col:nth-child(2) { width: 4% !important; }
        .experience-skill-table col:nth-child(3) { width: 4% !important; }
        .experience-skill-table col:nth-child(4) { width: 4% !important; }
        .experience-skill-table col:nth-child(5) { width: 39% !important; }
        .experience-skill-table col:nth-child(6) { width: 9% !important; }
        .experience-skill-table col:nth-child(7) { width: 6% !important; }
        .experience-skill-table col:nth-child(8) { width: 13% !important; }
        .experience-skill-table col:nth-child(9) { width: 5% !important; }
        .experience-skill-table col:nth-child(10) { width: 5% !important; }
        .experience-session-table col:nth-child(1) { width: 13% !important; }
        .experience-session-table col:nth-child(2) { width: 12% !important; }
        .experience-session-table col:nth-child(3) { width: 12% !important; }
        .experience-session-table col:nth-child(4) { width: 20% !important; }
        .experience-session-table col:nth-child(5) { width: 17% !important; }
        .experience-session-table col:nth-child(6) { width: 10% !important; }
        .experience-session-table col:nth-child(7) { width: 9% !important; }
        .experience-session-table col:nth-child(8) { width: 6% !important; }
        .observe-fit-table th,
        .observe-fit-table td,
        #observe-tab-review table th,
        #observe-tab-review table td,
        #observe-tab-raw table th,
        #observe-tab-raw table td {
          overflow-wrap: anywhere;
          word-break: break-word;
          min-width: 0;
          white-space: normal;
        }
	        #signal-global-tooltip {
	          position: fixed;
	          z-index: 9999;
          display: none;
          width: min(360px, calc(100vw - 32px));
          padding: 10px 12px;
          background: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 6px;
          box-shadow: 0 8px 24px rgba(0,0,0,.18);
          color: var(--text-primary);
          font-size: 12px;
          line-height: 1.5;
          white-space: normal;
	          pointer-events: none;
	          font-family: system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
	        }
	        #timeline-fulltext-tooltip {
	          position: fixed;
	          z-index: 2147483000;
	          display: none;
	          inset: 0;
	          align-items: center;
	          justify-content: center;
	          padding: 24px;
	          background: #020617;
	          color: var(--text-primary);
	        }
	        #timeline-fulltext-tooltip.is-open {
	          display: flex;
        }
	        #timeline-fulltext-tooltip .timeline-fulltext-dialog {
	          width: min(860px, calc(100vw - 48px));
	          max-height: min(82vh, 760px);
	          background: #111827;
	          border: 1px solid #334155;
	          border-radius: 10px;
	          box-shadow: 0 24px 72px rgba(15,23,42,.45);
	          display: flex;
	          flex-direction: column;
	          overflow: hidden;
	          opacity: 1;
	          isolation: isolate;
        }
	        #timeline-fulltext-tooltip .timeline-fulltext-header {
	          display: flex;
	          align-items: center;
	          justify-content: space-between;
	          gap: 12px;
	          padding: 12px 14px;
	          border-bottom: 1px solid #334155;
	          font-family: system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
	          background: #0f172a;
	        }
	        #timeline-fulltext-tooltip strong {
	          display: block;
	          margin: 0;
	          color: #cbd5e1;
	          font-family: system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
	          font-size: 12px;
	        }
	        #timeline-fulltext-tooltip .timeline-fulltext-close {
	          flex: 0 0 auto;
	          border: 1px solid #475569;
	          border-radius: 6px;
	          background: #1e293b;
	          color: #e2e8f0;
	          padding: 4px 9px;
	          cursor: pointer;
	          font-size: 12px;
	        }
	        #timeline-fulltext-tooltip .timeline-fulltext-body {
	          flex: 1 1 auto;
	          min-height: 0;
	          overflow: auto;
	          padding: 14px 16px;
	          white-space: pre-wrap;
	          word-break: break-word;
	          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	          font-size: 11px;
	          line-height: 1.58;
        }
        #experience-detail-modal {
          position: fixed;
          z-index: 2147482000;
          display: none;
          inset: 0;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: #020617;
        }
        #experience-detail-modal.is-open {
          display: flex;
        }
        #experience-detail-modal .experience-detail-dialog {
          width: min(1180px, calc(100vw - 48px));
          height: min(86vh, 900px);
          display: flex;
          flex-direction: column;
          background: #111827;
          border: 1px solid #334155;
          border-radius: 10px;
          box-shadow: 0 24px 72px rgba(15,23,42,.45);
          overflow: hidden;
        }
        #experience-detail-modal .experience-detail-modal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 14px;
          border-bottom: 1px solid #334155;
          background: #0f172a;
        }
        #experience-detail-modal .experience-detail-modal-title {
          min-width: 0;
          font-size: 13px;
          font-weight: 650;
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #experience-detail-modal .experience-detail-modal-close {
          flex: 0 0 auto;
          border: 1px solid #475569;
          border-radius: 6px;
          background: #1e293b;
          color: #e2e8f0;
          padding: 4px 9px;
          cursor: pointer;
          font-size: 12px;
        }
        #experience-detail-modal .experience-detail-modal-body {
          flex: 1 1 auto;
          min-height: 0;
          overflow: hidden;
          padding: 14px;
        }
        #experience-detail-modal .experience-detail-shell {
          height: 100%;
          max-height: 100%;
          overflow: hidden;
        }
        .context-chain-button {
          border: 1px solid rgba(37,99,235,.28);
          background: rgba(37,99,235,.09);
          color: var(--accent);
          border-radius: 7px;
          padding: 5px 9px;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
        }
        .context-chain-button:hover {
          background: rgba(37,99,235,.14);
        }
        .context-chain-grid {
          height: 100%;
          min-height: 0;
          display: grid;
          grid-template-columns: minmax(0,1.1fr) minmax(0,.8fr) minmax(0,.7fr);
          gap: 12px;
          overflow: hidden;
        }
        .context-chain-panel {
          min-width: 0;
          min-height: 0;
          overflow: auto;
          border: 1px solid #334155;
          border-radius: 9px;
          background: #0f172a;
          padding: 12px;
          color: var(--text-secondary);
        }
        .context-chain-panel h3 {
          margin: 0 0 9px;
          color: var(--text-primary);
          font-size: 13px;
        }
        .context-chain-panel h4 {
          margin: 12px 0 6px;
          color: var(--text-primary);
          font-size: 12px;
        }
        .context-chain-panel pre {
          margin: 6px 0 0;
          padding: 10px;
          max-height: 420px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
          border: 1px solid #334155;
          border-radius: 7px;
          background: #020617;
          color: #cbd5e1;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
          line-height: 1.55;
        }
        .context-chain-panel ol,
        .context-chain-panel ul {
          margin: 6px 0 0 18px;
          padding: 0;
        }
        .context-chain-panel li {
          margin: 0 0 8px;
          font-size: 12px;
          line-height: 1.5;
        }
        .context-chain-panel small,
        .context-muted,
        .context-meta {
          color: var(--text-muted);
          font-size: 12px;
          line-height: 1.5;
        }
        .context-chain-panel table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .context-chain-panel th,
        .context-chain-panel td {
          padding: 8px 7px;
          border-bottom: 1px solid #334155;
          text-align: left;
          vertical-align: top;
        }
        .context-chain-panel th {
          color: var(--text-primary);
          white-space: nowrap;
        }
        .context-runtime-placeholder {
          margin-top: 10px;
          padding: 12px;
          border: 1px dashed #475569;
          border-radius: 8px;
          color: var(--text-muted);
          text-align: center;
        }
        .timeline-scope-notice {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
          margin: 0 0 8px;
          padding: 9px 10px;
          border: 1px solid #334155;
          border-radius: 8px;
          background: #0f172a;
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.45;
        }
        .timeline-scope-notice strong {
          display: block;
          color: var(--yellow);
          font-size: 12px;
          margin-bottom: 2px;
        }
        .timeline-scope-notice span {
          display: block;
        }
        .timeline-scope-notice button {
          flex: 0 0 auto;
          border: 1px solid #475569;
          border-radius: 6px;
          background: #1e293b;
          color: #e2e8f0;
          padding: 5px 9px;
          cursor: pointer;
          font-size: 12px;
          white-space: nowrap;
        }
        .experience-detail-right [data-timeline-view] {
          flex: 1 1 auto;
          min-height: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
	        .timeline-snippet[data-timeline-fulltext].is-overflowing {
	          cursor: pointer;
	        }
	        .timeline-snippet.is-detail-open {
	          outline: 1px solid rgba(37,99,235,.55);
	          outline-offset: -1px;
	        }
        #observe-tab-review table td,
        #observe-tab-review table th,
        #observe-tab-raw table td,
        #observe-tab-raw table th {
          vertical-align: top;
        }
        #observe-tab-review table td,
        #observe-tab-raw table td {
          text-align: left;
        }
        #observe-tab-review table td.num,
        #observe-tab-raw table td.num {
          text-align: right;
        }
        .experience-timeline {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 4px 2px 4px 0;
        }
        .experience-detail-left,
        .experience-detail-right {
          min-width: 0;
        }
        .experience-detail-shell {
          height: 75vh;
          max-height: 75vh;
          overflow: hidden;
        }
        .experience-detail-grid {
          height: 100%;
          max-height: 100%;
          overflow: hidden;
        }
        .experience-detail-left {
          height: 100%;
          overflow: auto;
          padding-right: 4px;
        }
        .experience-detail-right {
          display: flex;
          flex-direction: column;
          min-height: 0;
          height: 100%;
          overflow: hidden;
        }
        .session-timeline-tree {
          display: flex;
          flex-direction: column;
          gap: 12px;
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
          padding-right: 4px;
        }
        .timeline-main-chain,
        .timeline-branch-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-height: 0;
        }
        .timeline-chain-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 8px 10px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-muted);
          color: var(--text-secondary);
          font-size: 12px;
        }
        .timeline-chain-header strong {
          color: var(--text-primary);
        }
        .timeline-branch {
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--bg);
          overflow: hidden;
        }
        .timeline-branch summary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          cursor: pointer;
          padding: 9px 10px;
          background: rgba(37,99,235,.05);
          color: var(--text-primary);
          font-size: 12px;
          font-weight: 650;
        }
        .timeline-branch summary small {
          min-width: 0;
          color: var(--text-muted);
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .timeline-branch .timeline-goal-tabs {
          border: 0;
          border-top: 1px solid var(--border);
          border-radius: 0;
          min-height: 360px;
        }
        .session-timeline-tree .timeline-goal-tabs {
          flex: 0 0 auto;
          height: auto;
          overflow: visible;
        }
        .session-timeline-tree .timeline-tab-panels,
        .session-timeline-tree .timeline-tab-panel.is-active {
          overflow: visible;
          height: auto;
        }
        .timeline-goal-tabs {
          display: flex;
          flex-direction: column;
          flex: 1 1 auto;
          min-height: 0;
          height: 100%;
          overflow: hidden;
          border: 1px solid rgba(37,99,235,.18);
          border-radius: 10px;
          background: var(--bg);
        }
        .timeline-tab-list {
          display: flex;
          gap: 6px;
          flex: 0 0 auto;
          overflow-x: auto;
          padding: 8px 9px;
          border-bottom: 1px solid var(--border);
          background: rgba(37,99,235,.05);
        }
        .timeline-tab-button {
          flex: 0 0 auto;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg);
          color: var(--text-secondary);
          padding: 5px 9px;
          font-size: 11px;
          font-weight: 650;
          cursor: pointer;
          white-space: nowrap;
        }
        .timeline-tab-button.is-active {
          border-color: rgba(37,99,235,.36);
          background: var(--accent);
          color: #fff;
        }
        .timeline-tab-panels {
          flex: 1 1 auto;
          min-height: 0;
          overflow: hidden;
        }
        .timeline-tab-panel {
          display: none;
          height: 100%;
          min-height: 0;
          overflow: auto;
          padding: 0 10px 10px;
        }
        .timeline-tab-panel.is-active {
          display: block;
        }
        .timeline-goal-card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 8px 10px;
          border-bottom: 1px solid var(--border);
          background: var(--bg);
          position: sticky;
          top: 0;
          z-index: 2;
        }
        .timeline-goal-card-header strong {
          color: var(--text-primary);
          font-size: 12px;
        }
        .timeline-goal-card-header span {
          color: var(--text-muted);
          font-size: 11px;
        }
        .timeline-goal-summary {
          margin: 8px 0;
          padding: 7px 9px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-muted);
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.45;
        }
        .timeline-row {
          display: grid;
          grid-template-columns: 46px minmax(0, 1fr);
          gap: 10px;
          position: relative;
        }
        .timeline-row::before {
          content: "";
          position: absolute;
          left: 22px;
          top: 34px;
          bottom: -12px;
          width: 1px;
          background: var(--border);
        }
        .timeline-row:last-child::before {
          display: none;
        }
        .timeline-marker {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding-top: 2px;
          color: var(--text-muted);
          font-family: ui-monospace, monospace;
          font-size: 10px;
          z-index: 1;
        }
        .timeline-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--bg-surface);
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0;
        }
        .timeline-user .timeline-icon { color: var(--accent); background: rgba(37,99,235,.08); border-color: rgba(37,99,235,.25); }
        .timeline-assistant .timeline-icon { color: var(--green); background: rgba(22,163,74,.08); border-color: rgba(22,163,74,.25); }
        .timeline-tool-use .timeline-icon { color: var(--yellow); background: rgba(202,138,4,.10); border-color: rgba(202,138,4,.28); }
        .timeline-tool-result .timeline-icon { color: var(--text-secondary); background: var(--bg-muted); }
        .timeline-tool-error .timeline-icon { color: var(--red); background: rgba(220,38,38,.08); border-color: rgba(220,38,38,.28); }
        .timeline-skill .timeline-icon { color: var(--text-muted); background: var(--bg-muted); border-style: dashed; }
        .timeline-card {
          min-width: 0;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-surface);
          overflow: hidden;
        }
        .timeline-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 10px;
          padding: 9px 10px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-muted);
        }
        .timeline-title {
          font-size: 12px;
          font-weight: 700;
          color: var(--text-primary);
        }
        .timeline-kind,
        .timeline-subtitle,
        .timeline-index {
          color: var(--text-muted);
        }
        .timeline-subtitle {
          margin-top: 3px;
          font-size: 11px;
          word-break: break-all;
        }
        .timeline-badges {
          display: flex;
          justify-content: flex-end;
          flex-wrap: wrap;
          gap: 4px;
          max-width: 42%;
        }
        .timeline-badge {
          display: inline-flex;
          padding: 2px 6px;
          border-radius: 999px;
          font-size: 11px;
          line-height: 1.35;
          border: 1px solid transparent;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .goal-slice-correction-button {
          flex: 0 0 auto;
          border: 1px solid rgba(255,255,255,.80);
          background: var(--accent);
          color: #fff;
          border-radius: 8px;
          padding: 5px 9px;
          font-size: 11px;
          font-weight: 750;
          box-shadow: 0 4px 12px rgba(37,99,235,.22);
          cursor: pointer;
          white-space: nowrap;
        }
        .goal-slice-correction-button:hover {
          filter: brightness(.96);
        }
        .goal-slice-correction-button.is-marked {
          border-color: rgba(255,255,255,.80);
          background: var(--green);
          color: #fff;
          box-shadow: 0 4px 12px rgba(22,163,74,.22);
        }
        .timeline-snippet {
          position: relative;
          margin: 0;
          padding: 10px;
          background: var(--bg);
          white-space: pre-wrap;
          word-break: break-word;
          font-family: ui-monospace, monospace;
          font-size: 11px;
          line-height: 1.55;
          color: var(--text-primary);
          max-height: 210px;
          overflow: hidden;
        }
        .timeline-snippet.is-overflowing::after {
          content: "... 点击查看详情";
          position: sticky;
          display: block;
          bottom: 0;
          margin: -22px 0 0 auto;
          width: 108px;
          padding: 2px 6px 3px;
          text-align: right;
          color: var(--text-secondary);
          font-weight: 700;
          background: linear-gradient(90deg, rgba(255,255,255,0), var(--bg) 45%);
          pointer-events: none;
        }
        .timeline-snippet.is-tool-error {
          border-left: 3px solid var(--red);
          background: rgba(220,38,38,.04);
        }
        .metric-calibration-row {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 7px 10px;
          border-top: 1px solid var(--border);
          background: var(--bg-muted);
        }
        .metric-calibration-title {
          flex: 0 0 auto;
          color: var(--text-muted);
          font-size: 11px;
          line-height: 22px;
        }
        .metric-calibration-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
        }
        .metric-calibration-button {
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          color: var(--text-muted);
          padding: 3px 6px;
          font-size: 10.5px;
          font-weight: 650;
          cursor: pointer;
        }
        .metric-calibration-button.is-rule-hit {
          border-color: rgba(37,99,235,.25);
          color: var(--accent);
          background: rgba(37,99,235,.06);
        }
        .metric-calibration-button.is-confirmed {
          border-color: rgba(22,163,74,.30);
          color: var(--green);
          background: rgba(22,163,74,.10);
        }
        .metric-calibration-button.is-rejected {
          border-color: rgba(220,38,38,.30);
          color: var(--red);
          background: rgba(220,38,38,.08);
          text-decoration: line-through;
        }
        .metric-calibration-button.is-editing-reason {
          outline: 2px solid rgba(37,99,235,.22);
          outline-offset: 1px;
        }
        .metric-reason-popover {
          flex: 1 0 100%;
          margin-top: 3px;
          max-width: min(560px, 100%);
        }
        .metric-reason-panel {
          border: 1px solid rgba(37,99,235,.22);
          border-radius: 8px;
          background: var(--bg-surface);
          box-shadow: 0 12px 28px rgba(15,23,42,.12);
          padding: 10px;
        }
        .metric-reason-title {
          color: var(--text-primary);
          font-size: 12px;
          font-weight: 700;
          margin-bottom: 4px;
        }
	        .metric-reason-hint {
	          color: var(--text-muted);
	          font-size: 11px;
	          line-height: 1.45;
	          margin-bottom: 8px;
	        }
	        .metric-reason-choice-row {
	          display: flex;
	          align-items: center;
	          gap: 6px;
	          margin-bottom: 8px;
	        }
	        .metric-reason-choice-label {
	          color: var(--text-muted);
	          font-size: 11px;
	          margin-right: 2px;
	        }
	        .metric-reason-choice {
	          border: 1px solid var(--border);
	          border-radius: 999px;
	          background: var(--bg);
	          color: var(--text-secondary);
	          padding: 3px 9px;
	          font-size: 11px;
	          font-weight: 700;
	          cursor: pointer;
	        }
	        .metric-reason-choice.is-confirmed {
	          border-color: rgba(22,163,74,.35);
	          background: rgba(22,163,74,.12);
	          color: var(--green);
	        }
	        .metric-reason-choice.is-rejected {
	          border-color: rgba(220,38,38,.35);
	          background: rgba(220,38,38,.10);
	          color: var(--red);
	        }
	        .metric-reason-input {
	          width: 100%;
          min-height: 58px;
          resize: vertical;
          box-sizing: border-box;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          color: var(--text-primary);
          font: inherit;
          font-size: 12px;
          line-height: 1.45;
          padding: 7px 8px;
        }
        .metric-reason-actions {
          display: flex;
          justify-content: flex-end;
          gap: 6px;
          margin-top: 8px;
        }
        .metric-reason-action {
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          color: var(--text-secondary);
          padding: 4px 9px;
          font-size: 11px;
          font-weight: 650;
          cursor: pointer;
        }
        .metric-reason-action.is-primary {
          border-color: rgba(37,99,235,.32);
          background: var(--accent);
          color: #fff;
        }
        .timeline-mark {
          padding: 1px 3px;
          border-radius: 4px;
          color: inherit;
        }
        .metric-item {
          display: inline-flex;
          align-items: baseline;
          gap: 2px;
          margin: 0;
          padding: 0 2px;
          border: 0;
          border-radius: 4px;
          background: transparent;
          color: inherit;
          font: inherit;
          white-space: normal;
          cursor: pointer;
          text-align: left;
        }
        .metric-item:hover { background: var(--bg-muted); color: var(--accent); }
        .metric-item strong {
          color: var(--text-primary);
          font-weight: 700;
        }
        .experience-evidence-cell {
          text-align: left !important;
        }
        .experience-evidence-cell .metric-item {
          justify-content: center;
        }
        .skill-evidence-summary {
          display: flex;
          flex-direction: column;
          gap: 4px;
          text-align: left;
          color: var(--text-secondary);
        }
        .skill-evidence-summary .summary-row {
          display: flex;
          align-items: baseline;
          flex-wrap: wrap;
          gap: 3px 8px;
        }
        .skill-evidence-summary .summary-title {
          min-width: 58px;
          color: var(--text-muted);
          font-weight: 650;
        }
        .skill-evidence-summary .summary-name {
          color: var(--text-muted);
          margin-right: 2px;
        }
        .skill-evidence-summary .summary-count {
          color: var(--text-secondary);
          font-weight: 650;
          font-variant-numeric: tabular-nums;
        }
        .skill-evidence-summary .summary-pct {
          color: var(--text-muted);
          font-size: 10px;
          margin-left: 2px;
          font-variant-numeric: tabular-nums;
        }
        .skill-evidence-summary .summary-unit-text,
        .skill-evidence-summary .summary-muted,
        .skill-evidence-summary .summary-sep {
          color: var(--text-muted);
        }
        .skill-evidence-summary .summary-detail {
          display: inline;
          margin: 0;
          color: var(--text-secondary);
          font-size: inherit;
        }
        .skill-evidence-summary .summary-metric {
          display: inline-flex;
          align-items: baseline;
          white-space: nowrap;
        }
        .invocation-summary {
          display: block;
          max-width: 100%;
          font-size: 11px;
          line-height: 1.5;
          color: var(--text-muted);
          text-align: center;
        }
        .invocation-total {
          color: var(--text-primary);
          font-weight: 650;
          margin-bottom: 2px;
        }
        .invocation-breakdown {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 3px 8px;
        }
        .invocation-breakdown span {
          display: inline;
          white-space: normal;
        }
        .invocation-footnote {
          margin-top: 2px;
          color: var(--text-muted);
        }
	        .experience-session-groups {
	          border: 1px solid var(--border);
	          border-radius: 8px;
	          background: var(--bg-surface);
	          max-height: 150vh;
	          overflow: auto;
	        }
        .experience-session-group {
          border-bottom: 1px solid var(--border);
          background: var(--bg-surface);
        }
        .experience-session-group:last-child {
          border-bottom: 0;
        }
        .experience-session-group > summary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 11px 13px;
          cursor: pointer;
          list-style: none;
          background: var(--bg-muted);
        }
        .experience-session-group > summary::-webkit-details-marker {
          display: none;
        }
        .experience-session-skill {
          font-family: ui-monospace, monospace;
          font-size: 13px;
          font-weight: 700;
          color: var(--text-primary);
          word-break: break-all;
        }
        .experience-session-meta {
          margin-left: 8px;
          color: var(--text-muted);
          font-size: 12px;
        }
        .experience-session-tags {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 6px;
          font-size: 12px;
          font-weight: 650;
        }
        .evidence-chain {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-bottom: 10px;
        }
        .evidence-chain-row,
        .evidence-anchor-row {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .evidence-chain-item,
        .evidence-anchor {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 3px 7px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg);
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.35;
        }
        .evidence-chain-item strong {
          color: var(--text-secondary);
          font-weight: 700;
        }
        .evidence-anchor {
          background: var(--bg-muted);
          color: var(--text-secondary);
          border-radius: 6px;
        }
        .rule-finding-list {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          margin-bottom: 8px;
        }
        .rule-finding-list.compact {
          margin-bottom: 0;
        }
        .rule-finding {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          max-width: 100%;
          padding: 3px 7px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg);
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.35;
          white-space: normal;
        }
        .rule-finding strong {
          color: inherit;
          font-weight: 700;
        }
        .rule-level {
          color: var(--text-muted);
          font-size: 10px;
        }
        .rule-anchor {
          color: var(--text-muted);
        }
        .rule-attention {
          background: rgba(220,38,38,.08);
          border-color: rgba(220,38,38,.22);
          color: var(--red);
        }
        .rule-sample {
          background: rgba(202,138,4,.08);
          border-color: rgba(202,138,4,.22);
          color: var(--yellow);
        }
        .rule-normal {
          background: var(--bg-muted);
          border-color: var(--border);
          color: var(--text-secondary);
        }
        .assistive-box {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 8px 9px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          text-align: left;
          font-size: 11px;
          line-height: 1.45;
        }
        .assistive-box.compact {
          padding: 4px 7px;
          gap: 0;
        }
        .assistive-box.compact .assistive-main {
          align-items: center;
          gap: 6px;
        }
        .assistive-box.compact .assistive-main span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .assistive-box.compact .assistive-help {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 15px;
          height: 15px;
          border: 1px solid var(--border);
          border-radius: 50%;
          background: var(--bg-surface);
          color: var(--text-muted);
          font-size: 10px;
          line-height: 15px;
          cursor: help;
        }
        .assistive-main {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          color: var(--text-primary);
          font-weight: 650;
        }
        .assistive-main strong {
          color: var(--text-muted);
          font-size: 10px;
          white-space: nowrap;
        }
        .assistive-desc,
        .assistive-sub {
          color: var(--text-muted);
        }
        .assistive-attention {
          border-color: rgba(220,38,38,.24);
          background: rgba(220,38,38,.06);
        }
        .assistive-sample {
          border-color: rgba(202,138,4,.24);
          background: rgba(202,138,4,.07);
        }
        .assistive-positive {
          border-color: rgba(22,163,74,.24);
          background: rgba(22,163,74,.06);
        }
        .assistive-normal,
        .assistive-unknown {
          background: var(--bg-muted);
        }
        .review-state-control {
          display: flex;
          flex-direction: column;
          gap: 5px;
          align-items: flex-start;
        }
        .review-state-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }
        .review-state-button {
          padding: 4px 7px !important;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          color: var(--text-secondary);
          cursor: pointer;
          font-size: 10.5px !important;
          line-height: 1.3;
          font-weight: 650;
        }
        .review-state-button:hover {
          color: var(--accent);
          border-color: rgba(37,99,235,.35);
          background: rgba(37,99,235,.06);
        }
        .review-state-button.is-active {
          color: #fff;
          border-color: rgba(255,255,255,.75);
          box-shadow: 0 3px 10px rgba(0,0,0,.12);
        }
        .review-state-button.review-real-issue { background: var(--red); }
        .review-state-button.review-not-issue { background: var(--green); }
        .review-state-button.review-needs-context { background: var(--yellow); color: #1f2937; }
        .review-state-button.review-reviewed { background: var(--accent); }
        .invocation-summary strong {
          color: var(--text-primary);
          font-weight: 700;
        }
        .goal-list { display: flex; flex-direction: column; gap: 6px; }
        .goal-item span {
          display: inline-flex;
          margin-bottom: 2px;
          padding: 1px 5px;
          border-radius: 999px;
          background: var(--bg-muted);
          color: var(--text-muted);
          font-size: 11px;
        }
        .goal-item div { font-size: 12px; line-height: 1.45; word-break: break-word; }
        #metric-guide-toolbar {
          position: fixed !important;
          right: 18px;
          top: 50vh;
          transform: translateY(-50%);
          z-index: 2147483646;
          display: flex;
          flex-direction: column;
          gap: 8px;
          pointer-events: auto;
        }
        #metric-guide-toolbar button,
        #metric-guide-panel button {
          font-family: system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
        }
        #metric-guide-toolbar button {
          letter-spacing: 0;
          padding: 12px 15px;
          border: 2px solid rgba(255,255,255,.86);
          border-radius: 10px;
          background: var(--accent);
          color: #fff;
          box-shadow: 0 10px 28px rgba(0,0,0,.32);
          cursor: pointer;
          font-size: 13px;
          font-weight: 800;
          white-space: nowrap;
        }
        #metric-guide-panel {
          position: fixed !important;
          right: 18px;
          top: 50vh;
          transform: translateY(-50%);
          z-index: 2147483647;
          display: none;
          width: min(400px, calc(100vw - 24px));
          max-height: 76vh;
          overflow: auto;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-surface);
          box-shadow: 0 12px 32px rgba(0,0,0,.22);
        }
        .metric-guide-header {
          position: sticky;
          top: 0;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
          padding: 12px 13px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-surface);
        }
        .metric-guide-header h2 { margin: 0; font-size: 14px; color: var(--text-primary); }
        .metric-guide-header p { margin: 3px 0 0; font-size: 12px; color: var(--text-muted); line-height: 1.45; }
        .metric-guide-header button {
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
          color: var(--text-secondary);
          cursor: pointer;
          padding: 3px 7px;
        }
        .metric-guide-body { padding: 10px 12px 12px; }
        .metric-guide-section { margin-top: 10px; }
        .metric-guide-section:first-child { margin-top: 0; }
        .metric-guide-section h3 {
          margin: 0 0 6px;
          font-size: 12px;
          color: var(--text-muted);
        }
        .metric-guide-item {
          display: block;
          width: 100%;
          margin: 0 0 6px;
          padding: 8px 9px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          color: var(--text-secondary);
          text-align: left;
          cursor: pointer;
        }
        .metric-guide-item strong {
          display: block;
          color: var(--text-primary);
          font-size: 12px;
          margin-bottom: 3px;
        }
        .metric-guide-item span {
          display: block;
          font-size: 12px;
          line-height: 1.45;
        }
        .metric-guide-item.is-active {
          border-color: rgba(37,99,235,.35);
          background: rgba(37,99,235,.08);
        }
        .report-version-divider {
          display: grid;
          grid-template-columns: minmax(0,1fr) minmax(0,auto) minmax(0,1fr);
          align-items: center;
          gap: 12px;
          margin: 20px 0 4px;
          color: var(--text-muted);
          font-size: 12px;
        }
        .report-version-divider div {
          height: 1px;
          background: var(--border);
        }
        .report-version-divider span {
          padding: 4px 10px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg-surface);
          text-align: center;
          max-width: min(680px, calc(100vw - 48px));
          white-space: normal;
        }
        @media (max-width: 860px) {
          .observe-summary-grid,
          .experience-stat-grid,
          .observe-action-funnel-grid {
            grid-template-columns: 1fr !important;
          }
          #metric-guide-toolbar {
            right: 12px;
          }
          #metric-guide-panel {
            right: 12px;
            width: calc(100vw - 24px);
          }
        }
        .timeline-followup-source {
          display: block;
          margin: -2px;
          padding: 2px;
          border-radius: 5px;
          background: rgba(202,138,4,.06);
          box-shadow: inset 3px 0 0 rgba(202,138,4,.45);
        }
        .metric-followup { background: rgba(202,138,4,.10); color: var(--yellow); border-color: rgba(202,138,4,.25); }
        .metric-user-message { background: rgba(37,99,235,.08); color: var(--accent); border-color: rgba(37,99,235,.20); }
        .metric-correction { background: rgba(37,99,235,.12); color: var(--accent); border-color: rgba(37,99,235,.25); }
        .metric-goal-shift { background: rgba(14,165,233,.12); color: #0284c7; border-color: rgba(14,165,233,.25); }
        .metric-interruption { background: rgba(236,72,153,.12); color: #be185d; border-color: rgba(236,72,153,.25); }
        .metric-negative { background: rgba(220,38,38,.12); color: var(--red); border-color: rgba(220,38,38,.25); }
	        .metric-positive { background: rgba(22,163,74,.12); color: var(--green); border-color: rgba(22,163,74,.25); }
	        .metric-completion { background: rgba(22,163,74,.10); color: var(--green); border-color: rgba(22,163,74,.22); }
        .metric-hard-rule { background: rgba(126,34,206,.12); color: #7e22ce; border-color: rgba(126,34,206,.25); }
        .metric-hedging { background: rgba(14,165,233,.12); color: #0284c7; border-color: rgba(14,165,233,.25); }
        .metric-explicit { background: rgba(220,38,38,.12); color: var(--red); border-color: rgba(220,38,38,.25); }
        .metric-tool-use { background: rgba(202,138,4,.10); color: var(--yellow); border-color: rgba(202,138,4,.25); }
        .metric-tool-success { background: rgba(22,163,74,.10); color: var(--green); border-color: rgba(22,163,74,.24); }
        .metric-tool-bash { background: rgba(202,138,4,.12); color: var(--yellow); border-color: rgba(202,138,4,.28); }
        .metric-tool-read { background: rgba(14,165,233,.12); color: #0284c7; border-color: rgba(14,165,233,.25); }
        .metric-tool-grep { background: rgba(22,163,74,.12); color: var(--green); border-color: rgba(22,163,74,.25); }
        .metric-tool-glob { background: rgba(22,163,74,.08); color: var(--green); border-color: rgba(22,163,74,.18); }
        .metric-tool-edit,
        .metric-tool-write { background: rgba(126,34,206,.10); color: #a855f7; border-color: rgba(126,34,206,.25); }
        .metric-tool-failure { background: rgba(220,38,38,.14); color: var(--red); border-color: rgba(220,38,38,.28); }
        .metric-skill-context { background: var(--bg-muted); color: var(--text-muted); border-color: var(--border); }
        .metric-neutral { background: var(--bg-muted); color: var(--text-muted); border-color: var(--border); }
      </style>
      <div id="signal-global-tooltip" role="tooltip"></div>
      <div id="timeline-fulltext-tooltip" role="dialog" aria-modal="true" aria-hidden="true" aria-label="时间线消息详情"></div>
      <div id="experience-detail-modal" role="dialog" aria-modal="true" aria-hidden="true" aria-label="Session 回溯详情"></div>
      <div id="metric-guide-toolbar" aria-label="指标说明工具栏">
        <button type="button" onclick="window.toggleMetricGuide && window.toggleMetricGuide()">指标说明</button>
      </div>
      <aside id="metric-guide-panel" aria-label="指标含义和评判标准">
        <div class="metric-guide-header">
          <div>
            <h2>指标含义和评判标准</h2>
            <p>这些指标只解释 trace 里观察到的证据，不自动判断 skill 最终好坏。</p>
          </div>
          <button type="button" onclick="closeMetricGuide()">关闭</button>
        </div>
        <div class="metric-guide-body">${metricGuideHtml}</div>
      </aside>
      ${empty}
      ${experienceSection}
      <div data-v0-observation-view style="display:none">
      <div class="report-version-divider" aria-label="1.0 和 2.0 报告分隔">
        <div></div>
        <span>V1 · Skill 实战复盘结束 · 以下进入 V0 · 过程发现视图</span>
        <div></div>
      </div>
      <section style="margin-top:16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-muted);padding:13px 14px">
        <h2 style="font-size:15px;margin:0;color:var(--text-primary)">V0 · 过程发现总览</h2>
        <div style="color:var(--text-muted);font-size:12px;margin-top:3px">这里是老版 inbox / 过程发现维度，只看 severity、signal、dedup 后过程发现，不参与 V1 的 session 复盘判断。</div>
        ${v0SummarySection}
      </section>
      <section style="margin-top:16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);overflow:hidden">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;padding:13px 14px;border-bottom:1px solid var(--border)">
          <div>
            <h2 style="font-size:15px;margin:0;color:var(--text-primary)">Skill 健康度看板</h2>
            <div style="color:var(--text-muted);font-size:12px;margin-top:3px">一行一个 skill。子项指标同时汇总 trace 工具调用和 过程发现 信号：工具调用看运行行为，过程发现 看发现的问题类型。</div>
          </div>
          <div style="color:var(--text-muted);font-size:12px;white-space:nowrap">${skillRollups.length} trace skills</div>
        </div>
        <div class="observe-table-wrap" style="width:100%;max-height:70vh;overflow:auto">
          <table class="observe-fit-table skill-health-table" style="border-collapse:collapse;width:100%;font-size:13px;table-layout:fixed;border:0;border-radius:0;background:transparent">
            <colgroup>
              <col style="width:210px">
              <col style="width:82px">
              <col style="width:82px">
              <col style="width:96px">
              <col style="width:340px">
              <col style="width:82px">
              <col style="width:96px">
              <col style="width:92px">
              <col style="width:142px">
              <col style="width:142px">
              <col style="width:92px">
              <col style="width:96px">
            </colgroup>
            <thead><tr>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">Skill</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">调用</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">Session</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">过程发现</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">子项指标</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">高风险</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">低风险</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">路径/工具</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">最近发现问题</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">最近使用</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">来源</th>
              <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">Review</th>
            </tr></thead>
            <tbody>${skillRollupRows}</tbody>
          </table>
        </div>
      </section>
      <section class="observe-action-funnel-grid" style="margin-top:16px;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr);gap:12px;align-items:start">
        <section id="observe-action-panel" style="border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);overflow:hidden;display:flex;flex-direction:column">
          <div style="padding:13px 14px;border-bottom:1px solid var(--border)">
            <h2 style="font-size:15px;margin:0;color:var(--text-primary)">Reviewer 待办建议</h2>
            <div style="color:var(--text-muted);font-size:12px;margin-top:3px">这张表回答“我现在该先看哪个 skill、看什么”。它只给 review 优先级，不自动判定必须改。点击行可跳到对应 skill 明细。</div>
          </div>
          ${actionRows ? `<div class="observe-table-wrap" style="width:100%;overflow:auto;flex:1;min-height:0">
            <table class="observe-fit-table action-table" style="border-collapse:collapse;width:100%;font-size:13px;table-layout:fixed;border:0;border-radius:0;background:transparent">
              <colgroup>
                <col style="width:58px">
                <col style="width:210px">
                <col style="width:170px">
                <col style="width:auto">
                <col style="width:70px">
              </colgroup>
              <thead><tr>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">P</th>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">Skill</th>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">现在要做什么</th>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">为什么这么建议</th>
                <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">次数</th>
              </tr></thead>
              <tbody>${actionRows}</tbody>
            </table>
          </div>` : `<div style="padding:14px;color:var(--text-muted);font-size:13px">当前没有需要 review 的 过程发现。</div>`}
        </section>
        <section id="observe-funnel-panel" style="border:1px solid var(--border);border-radius:8px;background:var(--bg-muted);padding:13px 14px;box-sizing:border-box;overflow:hidden">
          <h2 style="font-size:15px;margin:0;color:var(--text-primary)">当前可观测漏斗</h2>
          <div style="color:var(--text-muted);font-size:12px;margin-top:3px">这张表说明 OMK 现在能统计用户使用 skill 的哪几步。不能统计的项不会在本报告里伪装成结论。</div>
          <div style="display:grid;grid-template-columns:1fr;gap:6px;margin-top:10px">${funnelHtml}</div>
        </section>
      </section>
      <section style="margin-top:14px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-muted);font-size:13px;line-height:1.6">
        <strong>Reviewer path:</strong>
        先看 <span style="color:var(--red);font-weight:650">高风险/需关注</span>；
        “低风险”表示通常不需要改 skill，只需要抽样确认；
        “无异常”表示更像环境、路径、权限或工具限制。
        展开行看判断原因和原始 evidence，必要时到 过程发现 JSON / 打标 tab 查完整结构。
        <div style="margin-top:6px;color:var(--text-muted)">
          Signal 列第一行是原始信号类型，例如 failed_search；第二行是 OMK 判断出的失败原因，例如 bash_probe 表示 Bash 命令看起来只是在试目录或路径。
          “出现次数”表示这类问题 dedup 后累计出现了几次。
        </div>
        <button type="button" onclick="toggleScoringGuide(this)" style="margin-top:10px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer;font-size:12px">查看判断标准</button>
        <div id="observe-scoring-guide" style="display:none;margin-top:10px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);text-align:left">
          <div style="font-weight:700;margin-bottom:8px">判断漏斗</div>
          <ol style="margin:0 0 10px 18px;padding:0">
            <li>先看发生了什么：工具查找、读取、Bash 命令、模型文本里是否出现失败或不确定。</li>
            <li>再看为什么失败：文件太长、路径不存在、Bash 只是试目录、后续是否又找到了结果。</li>
            <li>最后看要不要改 skill：只有像 skill 没写清楚、没覆盖路径/流程时，才进入“高风险/需关注”。</li>
          </ol>
          <div class="observe-table-wrap">
          <table class="observe-fit-table scoring-guide-table" style="border-collapse:collapse;width:100%;font-size:12px">
            <thead><tr>
              <th style="text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)">页面判断</th>
              <th style="text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)">规则来源</th>
              <th style="text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)">怎么处理</th>
            </tr></thead>
            <tbody>
              <tr>
                <td style="padding:7px 8px;color:var(--red);font-weight:650">高风险/需关注</td>
                <td style="padding:7px 8px">hard_miss、repeated_failure、明确标了未知/缺口。通常表示查找失败后，没有看到后续找到同主题结果。</td>
                <td style="padding:7px 8px">优先看。确认 skill 是否漏了入口、路径、流程、约束或常见问题。</td>
              </tr>
              <tr>
                <td style="padding:7px 8px;color:var(--yellow);font-weight:650">低风险/抽样确认</td>
                <td style="padding:7px 8px">Bash 里有 ls/find、2&gt;/dev/null、|| true 等试目录/试路径写法，或前面没找到但后面又找到了。</td>
                <td style="padding:7px 8px">通常不需要改 skill；抽样确认是否反复浪费时间。只有反复发生时，再考虑给 skill 补“推荐查找路径”。</td>
              </tr>
              <tr>
                <td style="padding:7px 8px;color:var(--accent);font-weight:650">不确定/低优先级</td>
                <td style="padding:7px 8px">模型文本里说“不确定/需要确认”等，但没有强工具证据。</td>
                <td style="padding:7px 8px">低优先级看。只有它影响最终答案时，才考虑改 skill。</td>
              </tr>
              <tr>
                <td style="padding:7px 8px;color:var(--text-muted);font-weight:650">无异常/无需改 skill：路径/工具问题</td>
                <td style="padding:7px 8px">文件不存在、文件太长、权限失败、工具执行失败或超时。</td>
                <td style="padding:7px 8px">通常不是 skill 内容缺失。先看环境、路径、权限、文件大小或工具调用方式。</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
      </section>
      <section style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px">
        <input id="observe-filter-input" type="search" placeholder="Filter skill / signal / evidence / path" style="flex:1;min-width:0;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text-primary);font-size:13px">
        <button type="button" data-severity-filter="all" onclick="setObserveSeverityFilter('all')" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);cursor:pointer">All</button>
        <button type="button" data-severity-filter="high" onclick="setObserveSeverityFilter('high')" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer">高风险/需关注</button>
        <button type="button" data-severity-filter="medium" onclick="setObserveSeverityFilter('medium')" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer">低风险</button>
        <button type="button" data-severity-filter="noise" onclick="setObserveSeverityFilter('noise')" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer">路径/工具问题</button>
      </section>
      <div style="display:flex;gap:8px;margin-top:18px;border-bottom:1px solid var(--border)">
        <button type="button" data-observe-tab-button="review" onclick="showObservationTab('review')" style="font-size:13px;padding:8px 12px;border:1px solid var(--border);border-bottom:0;background:var(--bg-surface);border-radius:6px 6px 0 0;cursor:pointer">${lang === 'zh' ? 'Skill 下钻明细' : 'Skill Details'}</button>
        <button type="button" data-observe-tab-button="raw" onclick="showObservationTab('raw')" style="font-size:13px;padding:8px 12px;border:1px solid var(--border);border-bottom:0;background:var(--bg);border-radius:6px 6px 0 0;cursor:pointer">${lang === 'zh' ? '过程发现 JSON / 打标' : '过程发现 JSON / Tags'}</button>
      </div>
      <section id="observe-tab-review" style="margin-top:4px">
        ${items.length > 0 ? skillSections : ''}
      </section>
      <section id="observe-tab-raw" style="display:none">
        <p style="color:var(--text-muted);font-size:13px;margin:16px 0 8px">这里展示 过程发现 JSON 文件里的原始结构，以及已经计算出的 severity / signal / subtype / confidence / attributionConfidence 等分类打标。</p>
        ${reports.length > 0 ? `<div class="observe-table-wrap" style="width:100%;overflow-x:auto"><table class="observe-fit-table raw-observation-table" style="border-collapse:collapse;width:100%;font-size:13px;margin-top:12px">
          <thead><tr>
            <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border)">Severity</th>
            <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border)">Signal</th>
            <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border)">Skill</th>
            <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border)">Source</th>
            ${renderConfidenceHeader('10px', '2px solid var(--border)')}
            <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border)">Evidence</th>
            <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border)">JSON</th>
          </tr></thead>
          <tbody>${rawRows}</tbody>
        </table></div>${rawReportBlocks}` : `<p style="color:var(--text-muted);margin-top:24px">${lang === 'zh' ? '暂无过程发现 JSON。' : 'No observation JSON yet.'}</p>`}
      </section>
      </div>
      <script>
        var observeSeverityFilter = 'all';
        function showObservationTab(name) {
          var review = document.getElementById('observe-tab-review');
          var raw = document.getElementById('observe-tab-raw');
          if (review) review.style.display = name === 'review' ? '' : 'none';
          if (raw) raw.style.display = name === 'raw' ? '' : 'none';
          var buttons = document.querySelectorAll('[data-observe-tab-button]');
          for (var i = 0; i < buttons.length; i++) {
            var active = buttons[i].getAttribute('data-observe-tab-button') === name;
            buttons[i].style.background = active ? 'var(--bg-surface)' : 'var(--bg)';
            buttons[i].style.fontWeight = active ? '600' : '400';
          }
        }
        function toggleObservationDetail(id, btn) {
          var row = document.getElementById(id);
          if (!row) return;
          var open = row.style.display !== 'none';
          row.style.display = open ? 'none' : 'table-row';
          if (btn) btn.textContent = open ? '${lang === 'zh' ? '展开' : 'Details'}' : '${lang === 'zh' ? '收起' : 'Hide'}';
        }
        function closeExperienceDetailModal() {
          var modal = document.getElementById('experience-detail-modal');
          if (!modal) return;
          modal.classList.remove('is-open');
          modal.setAttribute('aria-hidden', 'true');
          modal.innerHTML = '';
        }
        function openExperienceDetailModal(id, btn) {
          var row = document.getElementById(id);
          var modal = document.getElementById('experience-detail-modal');
          if (!row || !modal) return;
          var cell = row.querySelector('td');
          if (!cell) return;
          var title = 'Session 回溯详情';
          var sessionRow = btn && btn.closest ? btn.closest('tr') : null;
          var sessionCell = sessionRow ? sessionRow.children[1] : null;
          if (sessionCell) title = 'Session 回溯详情 · ' + (sessionCell.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 96);
          modal.innerHTML = '<div class="experience-detail-dialog" role="document"><div class="experience-detail-modal-header"><div class="experience-detail-modal-title"></div><button type="button" class="experience-detail-modal-close" data-experience-detail-close>关闭</button></div><div class="experience-detail-modal-body"></div></div>';
          modal.querySelector('.experience-detail-modal-title').textContent = title;
          modal.querySelector('.experience-detail-modal-body').innerHTML = cell.innerHTML;
          var close = modal.querySelector('[data-experience-detail-close]');
          if (close) close.addEventListener('click', function (event) {
            event.stopPropagation();
            closeExperienceDetailModal();
          });
          modal.classList.add('is-open');
          modal.setAttribute('aria-hidden', 'false');
          if (close && close.focus) close.focus();
          window.requestAnimationFrame(function () {
            var tabs = modal.querySelectorAll('[data-timeline-tabs]');
            for (var i = 0; i < tabs.length; i++) {
              var base = tabs[i].getAttribute('data-timeline-tabs');
              if (base) switchTimelineGoalTab(base, 0);
            }
            if (window.refreshTimelineFullTextState) window.refreshTimelineFullTextState();
          });
        }
        function openContextChainModal(id, btn) {
          var row = document.getElementById(id);
          var modal = document.getElementById('experience-detail-modal');
          if (!row || !modal) return;
          var cell = row.querySelector('td');
          if (!cell) return;
          var title = 'Context Chain';
          var skillRow = btn && btn.closest ? btn.closest('tr') : null;
          var skillCell = skillRow ? skillRow.children[0] : null;
          if (skillCell) title = 'Context Chain · ' + (skillCell.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 96);
          modal.innerHTML = '<div class="experience-detail-dialog" role="document"><div class="experience-detail-modal-header"><div class="experience-detail-modal-title"></div><button type="button" class="experience-detail-modal-close" data-experience-detail-close>关闭</button></div><div class="experience-detail-modal-body"></div></div>';
          modal.querySelector('.experience-detail-modal-title').textContent = title;
          modal.querySelector('.experience-detail-modal-body').innerHTML = cell.innerHTML;
          var close = modal.querySelector('[data-experience-detail-close]');
          if (close) close.addEventListener('click', function (event) {
            event.stopPropagation();
            closeExperienceDetailModal();
          });
          modal.classList.add('is-open');
          modal.setAttribute('aria-hidden', 'false');
          if (close && close.focus) close.focus();
        }
        function switchTimelineGoalTab(tabBaseId, index) {
          var selector = '[data-timeline-tabs="' + tabBaseId.replace(/"/g, '\\"') + '"]';
          var modal = document.getElementById('experience-detail-modal');
          var root = modal && modal.classList.contains('is-open') ? modal.querySelector(selector) : null;
          if (!root) root = document.querySelector(selector);
          if (!root) return;
          var buttons = root.querySelectorAll('[data-timeline-tab]');
          var panels = root.querySelectorAll('[data-timeline-panel]');
          var target = tabBaseId + '-' + index;
          for (var i = 0; i < buttons.length; i++) {
            var active = buttons[i].getAttribute('data-timeline-tab') === target;
            buttons[i].classList.toggle('is-active', active);
            buttons[i].setAttribute('aria-selected', active ? 'true' : 'false');
          }
          for (var j = 0; j < panels.length; j++) {
            panels[j].classList.toggle('is-active', panels[j].getAttribute('data-timeline-panel') === target);
          }
        }
        function toggleFullSessionTimeline(btn) {
          var root = btn && btn.closest ? btn.closest('.experience-detail-right') : null;
          if (!root) return;
          var segment = root.querySelector('[data-timeline-view="segment"]');
          var full = root.querySelector('[data-timeline-view="full-session"]');
          if (!segment || !full) return;
          var showFull = full.style.display === 'none';
          full.style.display = showFull ? '' : 'none';
          segment.style.display = showFull ? 'none' : '';
          btn.textContent = showFull ? '返回 skill 窗口时间线' : '查看完整 session 时间线';
          window.requestAnimationFrame(function () {
            var tabs = root.querySelectorAll('[data-timeline-tabs]');
            for (var i = 0; i < tabs.length; i++) {
              var base = tabs[i].getAttribute('data-timeline-tabs');
              if (base) switchTimelineGoalTab(base, 0);
            }
            if (window.refreshTimelineFullTextState) window.refreshTimelineFullTextState();
          });
        }
        window.openExperienceDetailModal = openExperienceDetailModal;
        window.openContextChainModal = openContextChainModal;
        window.closeExperienceDetailModal = closeExperienceDetailModal;
        window.switchTimelineGoalTab = switchTimelineGoalTab;
        window.toggleFullSessionTimeline = toggleFullSessionTimeline;
        (function setupExperienceDetailModal() {
          var modal = document.getElementById('experience-detail-modal');
          if (!modal) return;
          modal.addEventListener('click', function (event) {
            if (event.target === modal) closeExperienceDetailModal();
          });
          document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && modal.classList.contains('is-open')) closeExperienceDetailModal();
          });
        })();
        function toggleScoringGuide(btn) {
          var guide = document.getElementById('observe-scoring-guide');
          if (!guide) return;
          var open = guide.style.display !== 'none';
          guide.style.display = open ? 'none' : 'block';
          if (btn) btn.textContent = open ? '查看判断标准' : '收起判断标准';
        }
        window.toggleMetricGuide = function toggleMetricGuide() {
          var panel = document.getElementById('metric-guide-panel');
          if (!panel) return;
          panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
        };
        window.closeMetricGuide = function closeMetricGuide() {
          var panel = document.getElementById('metric-guide-panel');
          if (panel) panel.style.display = 'none';
        };
        window.openMetricGuide = function openMetricGuide(key) {
          var panel = document.getElementById('metric-guide-panel');
          if (!panel) return;
          panel.style.display = 'block';
          var items = panel.querySelectorAll('[data-metric-guide-key]');
          var target = null;
          for (var i = 0; i < items.length; i++) {
            var active = items[i].getAttribute('data-metric-guide-key') === key;
            items[i].classList.toggle('is-active', active);
            if (active) target = items[i];
          }
          if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
        };
        async function openObservationTrace(id, btn) {
          var target = document.getElementById('trace-' + id);
          if (!target) return;
          var open = target.style.display !== 'none';
          if (open) {
            target.style.display = 'none';
            if (btn) btn.textContent = 'Open in trace';
            return;
          }
          target.style.display = 'block';
          target.textContent = 'Loading...';
          if (btn) btn.textContent = 'Hide trace';
          try {
            var res = await fetch('/api/observations/show?id=' + encodeURIComponent(id));
            var data = await res.json();
            target.textContent = data.text || data.error || '';
          } catch (err) {
            target.textContent = String(err && err.message ? err.message : err);
          }
        }
        function reviewVerdictClass(verdict) {
          if (verdict === 'real_issue') return 'review-real-issue';
          if (verdict === 'not_issue') return 'review-not-issue';
          if (verdict === 'needs_more_context') return 'review-needs-context';
          if (verdict === 'reviewed') return 'review-reviewed';
          return '';
        }
        async function setObservationReviewState(targetType, targetId, verdict, btn) {
          if (btn) btn.disabled = true;
          var current = btn && btn.closest('[data-review-state-key]')
            ? btn.closest('[data-review-state-key]').getAttribute('data-review-state-current')
            : '';
          var shouldDelete = current === verdict;
          try {
            var res = shouldDelete
              ? await fetch('/api/observations/review-state?targetType=' + encodeURIComponent(targetType) + '&targetId=' + encodeURIComponent(targetId), { method: 'DELETE' })
              : await fetch('/api/observations/review-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetType: targetType, targetId: targetId, verdict: verdict })
              });
            if (!res.ok) throw new Error('review state update failed: ' + res.status);
            await res.json();
            var key = targetType + ':' + targetId;
            var nextVerdict = shouldDelete ? '' : verdict;
            var controls = document.querySelectorAll('[data-review-state-key="' + key.replace(/"/g, '\\"') + '"]');
            for (var i = 0; i < controls.length; i++) {
              controls[i].setAttribute('data-review-state-current', nextVerdict);
              var buttons = controls[i].querySelectorAll('[data-review-verdict]');
              for (var j = 0; j < buttons.length; j++) {
                var buttonVerdict = buttons[j].getAttribute('data-review-verdict');
                var active = buttonVerdict === nextVerdict;
                buttons[j].className = 'review-state-button' + (active ? ' is-active ' + reviewVerdictClass(buttonVerdict) : '');
              }
            }
          } catch (err) {
            alert(String(err && err.message ? err.message : err));
          } finally {
            if (btn) btn.disabled = false;
          }
        }
        async function toggleGoalSliceCorrection(targetId, btn) {
          if (btn) btn.disabled = true;
          var isMarked = btn && btn.getAttribute('data-goal-slice-correction-marked') === '1';
          try {
            var url = '/api/observations/review-state?targetType=goal_slice_correction&targetId=' + encodeURIComponent(targetId);
            var res = isMarked
              ? await fetch(url, { method: 'DELETE' })
              : await fetch('/api/observations/review-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  targetType: 'goal_slice_correction',
                  targetId: targetId,
                  verdict: 'reviewed',
                  note: 'reviewer marked this timeline event as a goal-slice boundary candidate'
                })
              });
            if (!res.ok) throw new Error('goal slice correction update failed: ' + res.status);
            await res.json();
            var key = 'goal_slice_correction:' + targetId;
            var buttons = document.querySelectorAll('[data-goal-slice-correction-key="' + key.replace(/"/g, '\\"') + '"]');
            for (var i = 0; i < buttons.length; i++) {
              buttons[i].textContent = isMarked ? '人工标记切片点' : '已标记 · 点击取消';
              buttons[i].setAttribute('data-goal-slice-correction-marked', isMarked ? '0' : '1');
              buttons[i].classList.toggle('is-marked', !isMarked);
              buttons[i].setAttribute('title', isMarked
                ? '点击后会把这一行记录为目标切片边界候选，写入本地 review-state.json；当前不会自动重新切片或改变本报告指标。'
                : '已记录为目标切片边界候选。再次点击会取消这个本地标记；当前不会自动重新切片或改变本报告指标。');
            }
            window.setTimeout(function () { window.location.reload(); }, 150);
          } catch (err) {
            alert(String(err && err.message ? err.message : err));
          } finally {
            if (btn) btn.disabled = false;
          }
	        }
	        function evidenceMetricText(label, annotation, ruleDetected) {
	          if (annotation === 'confirmed') return '人工同意 · ' + label;
	          if (annotation === 'rejected') return '人工反对 · ' + label;
	          return (ruleDetected ? '规则命中 · ' : '未命中 · ') + label;
	        }
        function evidenceMetricClass(annotation, ruleDetected) {
          if (annotation === 'confirmed') return 'metric-calibration-button is-confirmed';
          if (annotation === 'rejected') return 'metric-calibration-button is-rejected';
          return 'metric-calibration-button' + (ruleDetected ? ' is-rule-hit' : '');
        }
        function findEvidenceMetricButtons(targetId) {
          var all = document.querySelectorAll('[data-evidence-metric-target]');
          var buttons = [];
          for (var i = 0; i < all.length; i++) {
            if (all[i].getAttribute('data-evidence-metric-target') === targetId) buttons.push(all[i]);
          }
          return buttons;
        }
        function closeMetricReasonPopover() {
          var popovers = document.querySelectorAll('.metric-reason-popover');
          for (var i = 0; i < popovers.length; i++) popovers[i].remove();
          var buttons = document.querySelectorAll('.metric-calibration-button.is-editing-reason');
          for (var j = 0; j < buttons.length; j++) buttons[j].classList.remove('is-editing-reason');
        }
        async function submitEvidenceMetricAnnotation(targetId, metricKey, btn, next, reason) {
          var res = next === ''
            ? await fetch('/api/observations/review-state?targetType=evidence_metric&targetId=' + encodeURIComponent(targetId), { method: 'DELETE' })
            : await fetch('/api/observations/review-state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                targetType: 'evidence_metric',
                targetId: targetId,
                verdict: next,
                metricKey: metricKey,
                sourceTrace: btn.getAttribute('data-source-trace') || undefined,
                sessionId: btn.getAttribute('data-session-id') || undefined,
                messageIndex: btn.getAttribute('data-message-index') ? Number(btn.getAttribute('data-message-index')) : undefined,
                messageUuid: btn.getAttribute('data-message-uuid') || undefined,
                toolUseId: btn.getAttribute('data-tool-use-id') || undefined,
                snippet: btn.getAttribute('data-snippet') || undefined,
                reason: reason || undefined
              })
            });
          if (!res.ok) throw new Error('metric annotation update failed: ' + res.status);
          await res.json();
          var buttons = findEvidenceMetricButtons(targetId);
          for (var i = 0; i < buttons.length; i++) {
            var label = buttons[i].getAttribute('data-metric-label') || '';
	            var ruleDetected = buttons[i].getAttribute('data-rule-detected') === '1';
	            buttons[i].setAttribute('data-metric-annotation', next);
	            buttons[i].setAttribute('data-metric-reason', reason || '');
	            buttons[i].textContent = evidenceMetricText(label, next, ruleDetected);
	            buttons[i].className = evidenceMetricClass(next, ruleDetected);
	          }
	          window.setTimeout(function () { window.location.reload(); }, 150);
	        }
	        function openMetricReasonPopover(targetId, metricKey, btn) {
	          closeMetricReasonPopover();
	          var actions = btn && btn.closest ? btn.closest('.metric-calibration-actions') : null;
	          if (!actions) return;
	          var label = btn.getAttribute('data-metric-label') || metricKey;
	          var selected = btn.getAttribute('data-metric-annotation') || '';
	          var previousReason = btn.getAttribute('data-metric-reason') || '';
	          var popover = document.createElement('div');
	          popover.className = 'metric-reason-popover';
	          var panel = document.createElement('div');
	          panel.className = 'metric-reason-panel';
	          var title = document.createElement('div');
	          title.className = 'metric-reason-title';
	          title.textContent = '人工校准：' + label;
	          var hint = document.createElement('div');
	          hint.className = 'metric-reason-hint';
	          hint.textContent = '先选择同意或反对，再填写原因。原因选填，会写入 review-state.json。';
	          var choices = document.createElement('div');
	          choices.className = 'metric-reason-choice-row';
	          var choiceLabel = document.createElement('span');
	          choiceLabel.className = 'metric-reason-choice-label';
	          choiceLabel.textContent = '判断';
	          var agree = document.createElement('button');
	          agree.type = 'button';
	          agree.className = 'metric-reason-choice';
	          agree.textContent = '同意';
	          var disagree = document.createElement('button');
	          disagree.type = 'button';
	          disagree.className = 'metric-reason-choice';
	          disagree.textContent = '反对';
	          choices.appendChild(choiceLabel);
	          choices.appendChild(agree);
	          choices.appendChild(disagree);
	          var input = document.createElement('textarea');
	          input.className = 'metric-reason-input';
	          input.value = previousReason;
	          input.placeholder = '选填：为什么这次要同意或反对这个判断';
	          var footer = document.createElement('div');
	          footer.className = 'metric-reason-actions';
	          var clear = document.createElement('button');
	          clear.type = 'button';
	          clear.className = 'metric-reason-action';
	          clear.textContent = '清除标注';
	          var cancel = document.createElement('button');
	          cancel.type = 'button';
	          cancel.className = 'metric-reason-action';
	          cancel.textContent = '取消';
          var save = document.createElement('button');
	          save.type = 'button';
	          save.className = 'metric-reason-action is-primary';
	          save.textContent = '保存';
	          footer.appendChild(clear);
	          footer.appendChild(cancel);
	          footer.appendChild(save);
	          function syncChoiceButtons() {
	            agree.classList.toggle('is-confirmed', selected === 'confirmed');
	            disagree.classList.toggle('is-rejected', selected === 'rejected');
	          }
	          agree.addEventListener('click', function () {
	            selected = 'confirmed';
	            syncChoiceButtons();
	            input.focus();
	          });
	          disagree.addEventListener('click', function () {
	            selected = 'rejected';
	            syncChoiceButtons();
	            input.focus();
	          });
	          syncChoiceButtons();
	          panel.appendChild(title);
	          panel.appendChild(hint);
	          panel.appendChild(choices);
	          panel.appendChild(input);
	          panel.appendChild(footer);
	          popover.appendChild(panel);
	          actions.appendChild(popover);
	          btn.classList.add('is-editing-reason');
	          cancel.addEventListener('click', closeMetricReasonPopover);
	          clear.addEventListener('click', async function () {
	            clear.disabled = true;
	            save.disabled = true;
	            cancel.disabled = true;
	            btn.disabled = true;
	            try {
	              await submitEvidenceMetricAnnotation(targetId, metricKey, btn, '', '');
	              closeMetricReasonPopover();
	            } catch (err) {
	              alert(String(err && err.message ? err.message : err));
	            } finally {
	              clear.disabled = false;
	              save.disabled = false;
	              cancel.disabled = false;
	              btn.disabled = false;
	            }
	          });
	          save.addEventListener('click', async function () {
	            if (selected !== 'confirmed' && selected !== 'rejected') {
	              alert('请先选择同意或反对。');
	              return;
	            }
	            save.disabled = true;
	            clear.disabled = true;
	            cancel.disabled = true;
	            btn.disabled = true;
	            try {
	              await submitEvidenceMetricAnnotation(targetId, metricKey, btn, selected, input.value.trim());
	              closeMetricReasonPopover();
	            } catch (err) {
	              alert(String(err && err.message ? err.message : err));
	            } finally {
	              save.disabled = false;
	              clear.disabled = false;
	              cancel.disabled = false;
	              btn.disabled = false;
	            }
          });
          input.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') closeMetricReasonPopover();
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') save.click();
          });
	          setTimeout(function () { input.focus(); }, 0);
	        }
	        function openEvidenceMetricAnnotation(targetId, metricKey, btn) {
	          openMetricReasonPopover(targetId, metricKey, btn);
	        }
        function setObserveSeverityFilter(value) {
          observeSeverityFilter = value;
          var buttons = document.querySelectorAll('[data-severity-filter]');
          for (var i = 0; i < buttons.length; i++) {
            var active = buttons[i].getAttribute('data-severity-filter') === value;
            buttons[i].style.background = active ? 'var(--bg-surface)' : 'var(--bg)';
            buttons[i].style.fontWeight = active ? '650' : '400';
          }
          applyObserveFilters();
        }
        function applyObserveFilters() {
          var input = document.getElementById('observe-filter-input');
          var query = input ? String(input.value || '').toLowerCase().trim() : '';
          var rows = document.querySelectorAll('[data-observe-row="review"]');
          for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var severity = row.getAttribute('data-severity') || '';
            var search = row.getAttribute('data-search') || '';
            var detailId = row.getAttribute('data-detail-id');
            var detail = detailId ? document.querySelector('[data-observe-detail-for="' + detailId + '"]') : null;
            var visible = (observeSeverityFilter === 'all' || severity === observeSeverityFilter) && (!query || search.indexOf(query) >= 0);
            row.style.display = visible ? '' : 'none';
            if (!visible && detail) detail.style.display = 'none';
          }
          var groups = document.querySelectorAll('[data-observe-skill-group]');
          for (var g = 0; g < groups.length; g++) {
            var group = groups[g];
            var groupRows = group.querySelectorAll('[data-observe-row="review"]');
            var anyVisible = false;
            for (var r = 0; r < groupRows.length; r++) {
              if (groupRows[r].style.display !== 'none') {
                anyVisible = true;
                break;
              }
            }
            group.style.display = anyVisible ? '' : 'none';
            if (query && anyVisible) group.open = true;
          }
        }
        (function setupObserveFilters() {
          var input = document.getElementById('observe-filter-input');
          if (input) input.addEventListener('input', applyObserveFilters);
        })();
        (function setupSkillRollupRows() {
          var rows = document.querySelectorAll('[data-observe-rollup-row]');
          for (var i = 0; i < rows.length; i++) {
            rows[i].addEventListener('click', function (event) {
              var targetEl = event.target;
              if (targetEl && targetEl.closest && targetEl.closest('[data-no-rollup-click]')) return;
              var id = this.getAttribute('data-skill-anchor');
              if (!id) return;
              var target = document.getElementById(id);
              if (!target) return;
              target.open = true;
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
          }
        })();
        (function syncActionPanelHeight() {
          var action = document.getElementById('observe-action-panel');
          var funnel = document.getElementById('observe-funnel-panel');
          if (!action || !funnel) return;
          function sync() {
            action.style.height = '';
            var h = Math.max(funnel.scrollHeight, funnel.offsetHeight);
            if (h > 0) action.style.height = h + 'px';
          }
          sync();
          window.addEventListener('resize', sync);
          if (document.fonts && document.fonts.ready) document.fonts.ready.then(sync).catch(function () {});
        })();
        (function setupTimelineFullTextTooltips() {
          var tooltip = document.getElementById('timeline-fulltext-tooltip');
          if (!tooltip) return;
          var activeEl = null;
          function hasMoreFullText(el) {
            return el.getAttribute('data-timeline-has-more') === '1';
          }
          function isOverflowing(el) {
            if (!el || (el.clientHeight === 0 && el.clientWidth === 0)) return false;
            return hasMoreFullText(el) || el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2;
          }
          function updateOverflowState(el) {
            var overflowing = isOverflowing(el);
            el.classList.toggle('is-overflowing', overflowing);
            el.tabIndex = overflowing ? 0 : -1;
            return overflowing;
          }
          function refreshOverflowStates() {
            var nodes = document.querySelectorAll('[data-timeline-fulltext]');
            for (var i = 0; i < nodes.length; i++) updateOverflowState(nodes[i]);
          }
          window.refreshTimelineFullTextState = refreshOverflowStates;
          function hide() {
            if (activeEl) activeEl.classList.remove('is-detail-open');
            activeEl = null;
            tooltip.classList.remove('is-open');
            tooltip.setAttribute('aria-hidden', 'true');
            tooltip.innerHTML = '';
          }
          function show(el) {
            if (!updateOverflowState(el)) {
              hide();
              return;
            }
            var text = el.getAttribute('data-timeline-fulltext') || '';
            if (!text) return;
            if (activeEl && activeEl !== el) activeEl.classList.remove('is-detail-open');
            activeEl = el;
            activeEl.classList.add('is-detail-open');
            var title = el.getAttribute('data-timeline-fulltext-title') || '完整内容';
            tooltip.innerHTML = '<div class="timeline-fulltext-dialog" role="document"><div class="timeline-fulltext-header"><strong></strong><button type="button" class="timeline-fulltext-close" data-timeline-fulltext-close>关闭</button></div><div class="timeline-fulltext-body"></div></div>';
            tooltip.querySelector('strong').textContent = title;
            tooltip.querySelector('.timeline-fulltext-body').textContent = text;
            var close = tooltip.querySelector('[data-timeline-fulltext-close]');
            if (close) close.addEventListener('click', function (event) {
              event.stopPropagation();
              hide();
            });
            tooltip.classList.add('is-open');
            tooltip.setAttribute('aria-hidden', 'false');
            if (close && close.focus) close.focus();
          }
          tooltip.addEventListener('click', function (event) {
            if (event.target === tooltip) hide();
          });
          document.addEventListener('click', function (event) {
            var target = event.target;
            var fulltext = target && target.closest ? target.closest('.timeline-snippet[data-timeline-fulltext]') : null;
            if (!fulltext) return;
            if (!updateOverflowState(fulltext)) return;
            event.stopPropagation();
            show(fulltext);
          });
          document.addEventListener('keydown', function (event) {
            var target = event.target;
            var fulltext = target && target.closest ? target.closest('.timeline-snippet[data-timeline-fulltext]') : null;
            if (!fulltext) return;
            if (event.key === 'Enter' || event.key === ' ') {
              if (!updateOverflowState(fulltext)) return;
              event.preventDefault();
              event.stopPropagation();
              show(fulltext);
            }
            if (event.key === 'Escape') hide();
          });
          window.requestAnimationFrame(refreshOverflowStates);
          window.addEventListener('resize', refreshOverflowStates);
          document.addEventListener('click', function (event) {
            var target = event.target;
            if (target && target.closest && target.closest('.timeline-tab-button')) {
              window.setTimeout(refreshOverflowStates, 0);
              hide();
              return;
            }
            if (target && target.closest && (target.closest('#timeline-fulltext-tooltip .timeline-fulltext-dialog') || target.closest('.timeline-snippet[data-timeline-fulltext]'))) return;
            hide();
          });
          document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') hide();
          });
        })();
        (function setupSignalTooltips() {
          var tooltip = document.getElementById('signal-global-tooltip');
          if (!tooltip) return;
          function show(el) {
            var title = el.getAttribute('data-signal-title') || '';
            var description = el.getAttribute('data-signal-description') || '';
            tooltip.innerHTML = '<strong style="display:block;margin-bottom:4px"></strong><div></div>';
            tooltip.querySelector('strong').textContent = title;
            tooltip.querySelector('div').textContent = description;
            tooltip.style.display = 'block';
            var rect = el.getBoundingClientRect();
            var top = rect.bottom + 8;
            var left = rect.left;
            var width = Math.min(360, window.innerWidth - 32);
            if (left + width > window.innerWidth - 16) left = window.innerWidth - width - 16;
            if (left < 16) left = 16;
            tooltip.style.left = left + 'px';
            tooltip.style.top = top + 'px';
            var tipRect = tooltip.getBoundingClientRect();
            if (tipRect.bottom > window.innerHeight - 16) {
              tooltip.style.top = Math.max(16, rect.top - tipRect.height - 8) + 'px';
            }
          }
          function hide() {
            tooltip.style.display = 'none';
          }
          var helps = document.querySelectorAll('.signal-help');
          for (var i = 0; i < helps.length; i++) {
            helps[i].addEventListener('mouseenter', function () { show(this); });
            helps[i].addEventListener('focus', function () { show(this); });
            helps[i].addEventListener('mouseleave', hide);
            helps[i].addEventListener('blur', hide);
          }
        })();
      </script>
    </main>
  `, lang);
}
