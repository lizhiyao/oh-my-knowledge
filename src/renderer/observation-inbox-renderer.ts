import { DEFAULT_LANG, layout, e } from './layout.js';
import type { Lang } from '../types/index.js';
import {
  severityReasonFor,
  observationMetricAnnotationTargetId,
  getSkillChainAdvisory,
  resolveAdvisoryCommand,
  ASSISTANT_DELIVERABLE_ARTIFACT_RE,
  hasAssistantDeliverableArtifactText,
  hasAssistantDeliverySignalText,
  hasUserHardRuleText,
  HARD_RULE_TEXT_RE,
  isAssistantProgressUpdateText,
  isScheduledTaskPromptText,
  isSyntheticUserMessageText,
  isUserInteractionMetricText,
} from '../observability/inbox-view-model.js';
import type {
  ObservationInboxItem,
  ObservationInboxViewModel,
  ObservationMetricKey,
  ResolvedObservationReviewSession,
  ResolvedOwnerSuggestion,
  SkillChainAdvisoryCode,
  ExperienceProblemBucket,
  ExperienceProblemPattern,
  ExperienceProblemSignal,
  SkillDerivedStandard,
  SkillLlmEnhancedReviewSections,
} from '../observability/inbox-view-model.js';
import { findNegativeFeedbackMatches, findPositiveFeedbackMatches, findUserCorrectionMatches, findUserGoalShiftMatches, hasUserCorrectionSignal, hasUserGoalShiftSignal } from '../observability/feedback-projection.js';
import { durationMsBetween } from '../shared/time.js';
import { OBSERVATION_INBOX_STYLES } from './observation-inbox/styles.js';
import {
  experienceSkillAnchor,
  formatTimeRange as formatTimeRangeImpl,
  formatTimestamp,
  renderArtifactVersion,
  renderField,
  renderJson,
  renderFeedbackAttributionLabel,
  skillAnchor,
  truncateText,
} from './observation-inbox/helpers.js';
export { renderFeedbackAttributionLabel } from './observation-inbox/helpers.js';
import type {
  ExperienceAssistiveInference,
  ExperienceAssistiveInferenceCautionCode,
  ExperienceAssistiveInferenceCode,
  ExperienceChecklistItem,
  ExperienceEvidenceChain,
  ExperienceEvidenceRef,
  ExperienceFeedbackAttribution,
  ExperienceInvocation,
  ExperienceReviewIndicators,
  ExperienceReviewBasisCode,
  ExperienceReviewPriority,
  ExperienceReviewerReport,
  ExperienceRuleFinding,
  ExperienceRuleFindingCode,
  ExperienceRuleFindingLevel,
  ExperienceEpisode,
  ExperienceFeedbackSignal,
  ExperienceSkillSegment,
  ExperienceSessionStoryAnswer,
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
} from '../observability/feedback-projection.js';

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
    skillDerivedStandards,
    totalSkillInvocations,
    severitySkillCounts,
    skillCount,
    reportCount,
    latestSeenLabel,
	    reviewState,
    resolvedReviewSessions,
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
        : invocation.attribution.source === 'business-action' || invocation.attribution.source === ['ai', 'ma-cmd'].join('')
          ? '通过业务动作触发'
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
  const sessionTimeLabel = lang === 'zh' ? 'Session 时间' : 'Session time';
  const sessionTimeRangeLabel = lang === 'zh' ? 'Session 时间范围' : 'Session time range';
  const latestInvocationLabel = lang === 'zh' ? '最近调用' : 'Latest invocation';
  const invocationWindowLabel = lang === 'zh' ? '调用窗口' : 'Invocation window';
  const formatTimeRange = (start?: string, end?: string, durationMs?: number): string => formatTimeRangeImpl(start, end, durationMs, lang);
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
    const label = item.sourceKind === 'openclaw' ? 'OpenClaw' : item.sourceKind === 'markdown_log' ? 'Markdown log' : item.sourceKind === 'claude' ? 'Claude' : 'Unknown';
    const color = item.sourceKind === 'openclaw' ? '#7c3aed' : item.sourceKind === 'markdown_log' ? 'var(--green)' : item.sourceKind === 'claude' ? 'var(--accent)' : 'var(--text-muted)';
    return `<span title="调用日志来源：${e(label)}" style="display:inline-flex;margin-top:4px;padding:2px 6px;border-radius:999px;background:var(--bg-muted);color:${color};font-size:11px;font-weight:650">${e(label)}</span>`;
  };
  const confidenceHeaderHelp = '判断把握：OMK 对“这条 过程发现 是否需要处理/是否高风险/需关注”的规则判断有多确定。归属把握：OMK 把这条 过程发现 归到当前 skill 名下有多确定，例如明确调用 skill 通常更高。';
  type IndicatorHelpKey =
    | 'userCorrection' | 'userInterruption' | 'userFollowUp' | 'negativeFeedback' | 'positiveFeedback' | 'userGoalShift' | 'hardRule' | 'selfCorrection' | 'repeatedExecution'
    | 'toolCall' | 'toolFailure' | 'highObservation' | 'mediumObservation' | 'hedging' | 'explicitMarker'
    | 'bash' | 'read' | 'grep' | 'bashProbe' | 'notFound' | 'toolLimit'
    | 'skillRoleRouter' | 'skillRoleExecutor' | 'skillRoleMixed' | 'skillRoleUnknown'
    | 'llmSkillTypeRouter' | 'llmSkillTypeDelegation' | 'llmSkillTypeExecutor' | 'llmSkillTypeAdvisory' | 'llmSkillTypeWorkflowOwner' | 'llmSkillTypeUnknown';
  const indicatorLabels: Record<IndicatorHelpKey, string> = {
    userCorrection: '用户纠正',
    userInterruption: '人工中断',
    userFollowUp: '追问/补充',
    negativeFeedback: '负向反馈',
    positiveFeedback: '正向反馈',
    userGoalShift: '用户切换目标',
    hardRule: '用户硬性要求',
    selfCorrection: '自我纠正',
    repeatedExecution: '重复执行',
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
    skillRoleRouter: '路由（本 session 角色）',
    skillRoleExecutor: '执行（本 session 角色）',
    skillRoleMixed: '路由+执行（本 session 角色）',
    skillRoleUnknown: '未确定（本 session 角色）',
    llmSkillTypeRouter: '路由型（能力定位）',
    llmSkillTypeDelegation: '委派型（能力定位）',
    llmSkillTypeExecutor: '执行型（能力定位）',
    llmSkillTypeAdvisory: '咨询型（能力定位）',
    llmSkillTypeWorkflowOwner: '流程负责型（能力定位）',
    llmSkillTypeUnknown: '类型待确认（能力定位）',
  };
  const indicatorHelps: Record<IndicatorHelpKey, string> = {
    userCorrection: '只统计人工用户消息里的明确纠偏表达。短词“不对 / 不是 / 错了”必须前后有空格、逗号、句号、问号等分隔；“不对称”“是不是”不会算纠正。',
    userInterruption: '统计 Claude trace 里的 “[Request interrupted by user]” 等用户主动中断事件，表示当前执行被人工叫停。',
    userFollowUp: '按当前报告的归因结果统计追问或补充。router / delegation 类型会把下游调用链路中的用户追问计入体验复盘；与当前 skill 无关的同窗口用户消息不计入。',
    negativeFeedback: '统计“没用 / 垃圾 / 菜 / 做错了 / 不行 / 失败 / 看不懂 / 有问题”等负向表达。这是规则命中，不是 LLM 情绪识别。',
    positiveFeedback: '统计“很好 / good job / 做得好 / 很棒 / 优秀 / 厉害 / 很有用 / 很有价值”等正向表达，用来保留用户认可证据。',
    userGoalShift: '统计“换个方向 / 先不 / 不用这个 / 另一个问题”等目标切换表达。它表示当前目标可能中止或切走，不直接等同于 skill 做错。',
    hardRule: '统计用户在对话里临时提出的硬性要求，例如“必须 / 不要 / 禁止 / 严格 / 一定要 / 只允许”。Skill 自身的强约束请看定义链路里的规则检测结果。',
    selfCorrection: '统计 agent 在没有用户介入的情况下，发现自己的执行路径、结果或工具策略有问题并主动修正。少量说明有恢复能力，高频说明流程不稳。',
    repeatedExecution: '统计同类步骤、工具或流程被重复执行的信号。高频出现通常对应绕路、工具策略不清晰或 workflow 缺少明确顺序。',
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
    skillRoleRouter: '本 session 内 skill 主要在调用 Skill 工具触发下游能力，自己不直接产出。判定来自 trace 行为，看到 Skill tool_use 调用占主导。常见于调度型 skill。',
    skillRoleExecutor: '本 session 内 skill 主要在调用具体工具（Bash / Read / Write / Edit）直接产出 artifact。判定来自 trace 行为。常见于编码 / 文档生成 / 数据处理类 skill。',
    skillRoleMixed: '本 session 内 skill 既调用 Skill 工具触发下游，又自己调用执行工具直接产出。trace 行为同时看到两种特征。常见于负责调度但保留兜底执行的 skill。',
    skillRoleUnknown: '本 session 内 trace 行为没显示明显的路由或执行特征。可能是 advisory / 对话型 skill，或样本太少没足够证据。',
    llmSkillTypeRouter: 'LLM 综合 SKILL.md 描述和 trace 行为判定为路由型：定位是把请求分发到下游，自身不直接产出。和"路由（本 session 角色）"区别：这个是 skill 本质定位，不只是单次 session 表现。',
    llmSkillTypeDelegation: 'LLM 判定为委派型：把任务交给 child session / 子 agent 执行，自己只负责拆任务、监督生命周期和回收结果。区别于路由型在于：路由型主要做转发，委派型还要管 child 跑偏 / 启动 / 终止全生命周期。',
    llmSkillTypeExecutor: 'LLM 判定为执行型：定位是自己直接干活产出 artifact。和"执行（本 session 角色）"区别：这个是 skill 本质定位，不只是单次 session 表现。',
    llmSkillTypeAdvisory: 'LLM 判定为咨询型：定位是回答问题 + 给证据，不一定产出 artifact。常见于审计 / 分析 / 解释类 skill。本 session 角色一般会显示"未确定"，因为 advisory 没有明显工具使用特征。',
    llmSkillTypeWorkflowOwner: 'LLM 判定为流程负责型：定位是管理一条多阶段 workflow 的闭环状态。它可以委派其他 skill 执行阶段动作，但要负责阶段矩阵、产物、异常和用户反馈闭环。',
    llmSkillTypeUnknown: 'LLM 没能从 SKILL.md 和 trace 中得到足够证据判定 skill 类型。可能是 SKILL.md 描述不清，或 trace 样本不足。建议 skill owner 补充 SKILL.md 顶部声明，或多观察几个 session。',
  };
  const metric = (label: string, value: number, helpKey: IndicatorHelpKey, title?: string): string =>
    `<button type="button" class="metric-item" data-metric-key="${helpKey}" onclick="openMetricGuide('${helpKey}')" title="${e(title ?? `点击查看“${label}”指标说明`)}"><span>${e(label)}</span> <strong>${value}</strong></button>`;
  const formatEntrypoint = (value?: string): string => {
    const labels: Record<string, string> = {
      'claude-desktop': 'Claude Code App',
      cli: 'Claude CLI',
      'sdk-ts': 'Claude SDK',
      openclaw: 'OpenClaw',
      markdown_log: 'Markdown 日志',
    };
    return value ? (labels[value] ?? value) : '未记录';
  };
  const formatAttributionSource = (value?: string): string => {
    if (value === 'command-name') return '通过斜杠命令触发';
    if (value === 'business-action' || value === legacyBusinessActionSource()) return '通过业务动作触发';
    if (value === 'skill-tool') return '通过 Skill 工具启动';
    if (value === 'read-skill-md') return '通过读取 Skill 文档推断';
    if (value === 'skill-script') return '通过 Skill 脚本路径推断';
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
  const EMPTY_VALUE = '—';
  const renderShare = (count: number, total: number): string => {
    if (count <= 0 && total <= 0) {
      return `<span class="summary-count">${EMPTY_VALUE}</span>`;
    }
    const safeTotal = Math.max(total, count);
    return `<span class="summary-count">${count}</span><span class="summary-pct">/ ${pct(count, safeTotal)}</span>`;
  };
  const renderMetric = (label: string, count: number, unit = ''): string => {
    const empty = count <= 0;
    return `<span class="summary-metric${empty ? ' summary-metric-empty' : ''}"><span class="summary-name">${e(label)}</span><span class="summary-count">${empty ? EMPTY_VALUE : count}</span>${unit && !empty ? `<span class="summary-unit-text">${e(unit)}</span>` : ''}</span>`;
  };
  const renderMetricShare = (label: string, count: number, total: number): string => {
    const empty = count <= 0;
    return `<span class="summary-metric${empty ? ' summary-metric-empty' : ''}"><span class="summary-name">${e(label)}</span>${renderShare(count, total)}</span>`;
  };
  const reviewImpactTitle = (level: 'priority' | 'sample'): string =>
    level === 'priority'
      ? '命中后会影响“优先复盘”：建议先打开上下文看证据。'
      : '命中后会影响“抽样复盘”：建议抽样打开上下文确认。';
  const renderDecisionMetric = (label: string, count: number, level: 'priority' | 'sample', unit = ''): string => {
    const active = count > 0;
    return `<span class="summary-metric${active ? ` summary-impact summary-impact-${level}` : ' summary-metric-empty'}"${active ? ` title="${e(reviewImpactTitle(level))}"` : ''}><span class="summary-name">${e(label)}</span><span class="summary-count">${active ? count : EMPTY_VALUE}</span>${unit && active ? `<span class="summary-unit-text">${e(unit)}</span>` : ''}</span>`;
  };
  const renderDecisionMetricIfPositive = (label: string, count: number, level: 'priority' | 'sample', unit = ''): string =>
    count > 0 ? renderDecisionMetric(label, count, level, unit) : '';
  const renderDecisionMetricShare = (label: string, count: number, total: number, level: 'priority' | 'sample'): string => {
    const active = count > 0;
    return `<span class="summary-metric${active ? ` summary-impact summary-impact-${level}` : ' summary-metric-empty'}"${active ? ` title="${e(reviewImpactTitle(level))}"` : ''}><span class="summary-name">${e(label)}</span>${renderShare(count, total)}</span>`;
  };
  // 结果类观察指标：>0 时显示轻微 tag（complete chip 视觉），
  // =0 时与其他指标一样走 summary-metric-empty。不接入复盘评分。
  const renderSoftMetric = (label: string, count: number, title?: string): string => {
    const active = count > 0;
    return `<span class="summary-metric${active ? ' summary-impact summary-impact-soft' : ' summary-metric-empty'}"${active && title ? ` title="${e(title)}"` : ''}><span class="summary-name">${e(label)}</span><span class="summary-count">${active ? count : EMPTY_VALUE}</span></span>`;
  };
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
  const userFacingToolLabel = (tool: string): string => {
    const lower = tool.toLowerCase();
    if (['exec', 'process', 'bash', 'shell', 'run'].includes(lower)) return '命令执行';
    if (lower === 'read') return '读取文件';
    if (['grep', 'glob', 'search', 'find'].includes(lower)) return '搜索文件';
    if (['edit', 'write', 'multiedit'].includes(lower)) return '修改文件';
    if (lower === 'todowrite') return '记录待办';
    if (lower === 'skill') return '启动 skill';
    return tool;
  };
  const mergeCountsByLabel = (counts: Record<string, number> | undefined, label: (key: string) => string): Record<string, number> => {
    const next: Record<string, number> = {};
    for (const [key, count] of Object.entries(counts ?? {})) {
      const display = label(key);
      next[display] = (next[display] ?? 0) + count;
    }
    return next;
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
  const sourceMetadataLine = (label: string, counts: Record<string, number> | undefined, options: { max?: number; valueLabel?: (value: string) => string } = {}): string => {
    const text = compactRankedCountText(counts, { max: options.max ?? 2, label: options.valueLabel });
    return text === '未记录' ? '' : `<div>${e(label)}：${e(text)}</div>`;
  };
  const renderOpenClawSourceMetadata = (counts: NonNullable<NonNullable<typeof experience>['skills'][number]['sourceMetadataCounts']> | undefined): string => {
    if (!counts) return '';
    const lines = [
      sourceMetadataLine('渠道', counts.channels, { valueLabel: formatChannel }),
      sourceMetadataLine('用户', counts.senders, { max: 1 }),
      sourceMetadataLine('业务动作', sourceMetadataBusinessActionCounts(counts)),
      sourceMetadataLine('模型', counts.models),
      sourceMetadataLine('供应商', counts.providers),
    ].filter(Boolean);
    return lines.length > 0 ? `<div class="openclaw-source-meta">${lines.join('')}</div>` : '';
  };
  const renderSessionOpenClawSourceMetadata = (session: ExperienceSessionSummary): string => {
    const meta = session.sourceMetadata;
    if (!meta) return '';
    const lines = [
      meta.channel ? `渠道：${formatChannel(meta.channel)}` : '',
      meta.sender || meta.senderId ? `用户：${meta.sender ?? ''}${meta.senderId ? `(${meta.senderId})` : ''}` : '',
      sourceMetadataBusinessActions(meta).length ? `业务动作：${sourceMetadataBusinessActions(meta).join('、')}` : '',
      meta.model ? `模型：${meta.model}` : '',
      meta.provider ? `供应商：${meta.provider}` : '',
    ].filter(Boolean);
    return lines.length > 0 ? `<span style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--text-muted)">${e(lines.join(' · '))}</span>` : '';
  };
  const formatChannel = (value: string): string => {
    const labels: Record<string, string> = {
      [legacyBusinessChannel()]: '业务通道',
      dingtalk: '钉钉',
      cli: 'CLI',
    };
    return labels[value] ?? value;
  };
  const legacyBusinessActionSource = (): string => ['ai', 'ma-cmd'].join('');
  const legacyBusinessActionField = (): string => ['ai', 'maCommands'].join('');
  const legacyBusinessChannel = (): string => ['ai', 'ma'].join('');
  const sourceMetadataBusinessActions = (meta: ExperienceSessionSummary['sourceMetadata']): string[] => {
    if (!meta) return [];
    const legacy = (meta as unknown as Record<string, unknown>)[legacyBusinessActionField()];
    const legacyActions = Array.isArray(legacy) ? legacy.filter((item): item is string => typeof item === 'string') : [];
    return Array.from(new Set([...(meta.businessActions ?? []), ...legacyActions])).sort();
  };
  const sourceMetadataBusinessActionCounts = (
    counts: NonNullable<NonNullable<typeof experience>['skills'][number]['sourceMetadataCounts']> | undefined,
  ): Record<string, number> | undefined => {
    if (!counts) return undefined;
    const legacy = (counts as unknown as Record<string, unknown>)[legacyBusinessActionField()];
    const merged = { ...(counts.businessActions ?? {}) };
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      for (const [key, value] of Object.entries(legacy as Record<string, unknown>)) {
        if (typeof value === 'number') merged[key] = (merged[key] ?? 0) + value;
      }
    }
    return merged;
  };
  const problemBucketLabels: Record<ExperienceProblemBucket, string> = {
    output_format: '输出格式不符合预期',
    content_accuracy: '内容理解可能不对',
    missing_context: '可能没读到关键资料',
    rule_violation: '用户明确提出要求',
    workflow_mismatch: '可能走错流程',
    tool_runtime: '工具/环境问题',
    goal_shift: '用户中途改了目标',
    unclear: '问题类型不明确',
  };
  const problemSignalLabels: Record<ExperienceProblemSignal, string> = {
    user_correction: '用户纠正',
    negative_feedback: '负向反馈',
    user_interruption: '人工中断',
    hard_rule: '用户硬性要求',
    user_goal_shift: '目标变化',
    tool_failure: '工具失败',
    workflow_mismatch: '流程不匹配',
    artifact_missing: '产物缺失',
    observer_lifecycle_failed: '观察器异常',
    orchestration_boundary_violation: '调度边界异常',
  };
  const timelineTagForProblemPattern = (pattern: ExperienceProblemPattern): string => {
    if (pattern.signalTypes.includes('user_correction')) return 'user_correction';
    if (pattern.signalTypes.includes('negative_feedback')) return 'negative_feedback';
    if (pattern.signalTypes.includes('user_interruption')) return 'user_interruption';
    if (pattern.signalTypes.includes('hard_rule')) return 'hard_rule';
    if (pattern.signalTypes.includes('user_goal_shift')) return 'user_goal_shift';
    if (pattern.signalTypes.includes('tool_failure')) return 'tool_failure';
    return '';
  };
  const patternKeywordLabel = (pattern: ExperienceProblemPattern): string => {
    const raw = pattern.patternKey.split(':').slice(1).join(':');
    const labels: Record<string, string> = {
      prd: 'PRD',
      demo: 'Demo',
      format: '格式/模板',
      figma: '设计稿',
      context: '上下文/资料',
      schema: '字段/接口/路径',
      workflow: '流程',
      rule: '规则',
      wrong: '不符合预期',
      tool_limit: '工具限制',
      tool_failure: '工具失败',
      not_found: '文件/路径不存在',
      permission: '权限问题',
      timeout: '超时',
    };
    const parts = raw.split('+').map((part) => labels[part] ?? part).filter(Boolean);
    return parts.length > 0 ? parts.slice(0, 3).join(' + ') : problemBucketLabels[pattern.bucket];
  };
  const renderSkillProblemPatterns = (skillName: string, patterns: ExperienceProblemPattern[] | undefined): string => {
    const top = (patterns ?? []).slice(0, 3);
    if (top.length === 0) return '';
    return `<div class="summary-row problem-pattern-row"><span class="summary-title">【发现问题线索】</span><span class="problem-pattern-list">${top.map((pattern) => {
      const rawSessionId = pattern.recentSessionIds[0] ?? '';
      const sessionId = experienceSessionIdBySkillAndSession.get(`${skillName}\u0000${rawSessionId}`) ?? '';
      const tag = timelineTagForProblemPattern(pattern);
      const signals = pattern.signalTypes.map((signal) => problemSignalLabels[signal]).join('、');
      const title = `${problemBucketLabels[pattern.bucket]}：${patternKeywordLabel(pattern)}。命中 ${pattern.count} 次，涉及 ${pattern.sessionCount} 个 session。来源：${signals || '规则聚合'}。`;
      return `<button type="button" class="problem-pattern-chip" data-no-rollup-click="1"${sessionId ? ` data-open-experience-session="${e(sessionId)}"` : ''}${tag ? ` data-open-timeline-tag="${e(tag)}"` : ''} title="${e(title)}"><span class="pattern-bucket">${e(problemBucketLabels[pattern.bucket])}</span><span class="pattern-key">${e(patternKeywordLabel(pattern))}</span><span class="pattern-count">${pattern.count} 次 / ${pattern.sessionCount} 个 session</span></button>`;
    }).join('')}</span></div>`;
  };
  const ZERO_DISPLAY_INDICATORS: ExperienceReviewIndicators = {
    userMessageCount: 0,
    userFollowUpCount: 0,
    userCorrectionCount: 0,
    userInterruptionCount: 0,
    sessionInterruptedCount: 0,
    negativeFeedbackCount: 0,
    positiveFeedbackCount: 0,
    userGoalShiftCount: 0,
    hardRuleTextHitCount: 0,
	    assistantDeliverySignalCount: 0,
	    deliverableArtifactSignalCount: 0,
	    routerDownstreamCompleted: 0,
	    routerDownstreamFailed: 0,
	    selfCorrectionCount: 0,
    repeatedExecutionCount: 0,
    toolCallCount: 0,
    toolFailureCount: 0,
    highObservationCount: 0,
    mediumObservationCount: 0,
    hedgingCount: 0,
    explicitMarkerCount: 0,
  };
  const USER_INTERRUPTION_DISPLAY_RE = /\[Request interrupted by user(?: for tool use)?\]|interrupted by user|用户中断/i;
  const displayRegexMatches = (pattern: RegExp, value: string): boolean => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  };
  const displayMetricVerdict = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, metricScopeId?: string): 'confirmed' | 'rejected' | '' => {
    const targetId = observationMetricAnnotationTargetId({ ...event, metricScopeId }, metricKey);
    const entry = reviewState.entries[`evidence_metric:${targetId}`];
    return entry?.verdict === 'confirmed' || entry?.verdict === 'rejected' ? entry.verdict : '';
  };
  const displayMetricIsActive = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, ruleDetected: boolean, metricScopeId?: string): boolean => {
    const verdict = displayMetricVerdict(event, metricKey, metricScopeId);
    if (verdict === 'confirmed') return true;
    if (verdict === 'rejected') return false;
    return ruleDetected;
  };
  const displayMetricCount = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, ruleCount: number, metricScopeId?: string): number => {
    const verdict = displayMetricVerdict(event, metricKey, metricScopeId);
    if (verdict === 'confirmed') return Math.max(1, ruleCount);
    if (verdict === 'rejected') return 0;
    return ruleCount;
  };
  const shouldIncludeDownstreamFeedbackForDisplay = (session: ExperienceSessionSummary): boolean => {
    const episodes = session.sessionStory?.episodes ?? [];
    const segmentIds = new Set(episodes.flatMap((episode) =>
      (episode.skillSegments ?? [])
        .filter((segment) => segment.skillName === session.skillName)
        .map((segment) => segment.id)
    ));
    if (segmentIds.size === 0) return false;
    const ownSegments = episodes.flatMap((episode) => episode.skillSegments ?? [])
      .filter((segment) => segment.skillName === session.skillName);
    if (ownSegments.some((segment) =>
      segment.skillType === 'router'
      || segment.skillType === 'delegation'
      || segment.episodeRole === 'router'
      || segment.episodeRole === 'delegator'
    )) return true;
    return episodes.some((episode) =>
      (episode.orchestrationEdges ?? []).some((edge) =>
        Boolean(edge.parentSkillSegmentId && segmentIds.has(edge.parentSkillSegmentId))
      )
    );
  };
  const feedbackAttributionBelongsToDisplaySession = (
    attribution: ExperienceFeedbackAttribution,
    session: ExperienceSessionSummary,
    includeDownstream = shouldIncludeDownstreamFeedbackForDisplay(session),
  ): boolean =>
    attribution.skillName === session.skillName
    && (
      attribution.attributionRole === 'primary_fault'
      || includeDownstream && attribution.attributionRole === 'downstream_related'
    );
  const canonicalFeedbackSignalsForDisplay = (
    session: ExperienceSessionSummary,
    signalType?: ExperienceFeedbackSignal['type'],
  ): ExperienceFeedbackSignal[] => {
    const includeDownstream = shouldIncludeDownstreamFeedbackForDisplay(session);
    return (session.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? []) ?? [])
      .filter((signal) =>
        (!signalType || signal.type === signalType)
        && displayFeedbackSignalIsActive(signal, session)
        && (signal.canonicalAttributions ?? signal.attributions ?? []).some((attribution) =>
          feedbackAttributionBelongsToDisplaySession(attribution, session, includeDownstream)
        )
      );
  };
  const metricKeyForFeedbackSignal = (signal: ExperienceFeedbackSignal): ObservationMetricKey | undefined => {
    if (signal.type === 'follow_up') return 'user_follow_up';
    if (signal.type === 'correction') return 'user_correction';
    if (signal.type === 'interruption') return 'user_interruption';
    if (signal.type === 'frustration') return 'negative_feedback';
    if (signal.type === 'positive') return 'positive_feedback';
    return undefined;
  };
  const displayFeedbackSignalIsActive = (signal: ExperienceFeedbackSignal, session: ExperienceSessionSummary): boolean => {
    const metricKey = metricKeyForFeedbackSignal(signal);
    if (!metricKey) return true;
    const verdict = displayMetricVerdict(signal.evidenceRef as ExperienceTimelineEvent, metricKey, session.id);
    if (verdict === 'confirmed') return true;
    if (verdict === 'rejected') return false;
    return true;
  };
  const feedbackSignalTypeForMetric = (metricKey: ObservationMetricKey): ExperienceFeedbackSignal['type'] | undefined => {
    if (metricKey === 'user_follow_up') return 'follow_up';
    if (metricKey === 'user_correction') return 'correction';
    if (metricKey === 'user_interruption') return 'interruption';
    if (metricKey === 'negative_feedback') return 'frustration';
    if (metricKey === 'positive_feedback') return 'positive';
    return undefined;
  };
  const canonicalFeedbackCountsForDisplay = (session: ExperienceSessionSummary): Pick<ExperienceReviewIndicators, 'userFollowUpCount' | 'userCorrectionCount' | 'userInterruptionCount' | 'negativeFeedbackCount' | 'positiveFeedbackCount'> | undefined => {
    const signals = session.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? []) ?? [];
    if (signals.length === 0) return undefined;
    const owned = canonicalFeedbackSignalsForDisplay(session);
    return {
      userFollowUpCount: owned.filter((signal) => signal.type === 'follow_up').length,
      userCorrectionCount: owned.filter((signal) => signal.type === 'correction').length,
      userInterruptionCount: owned.filter((signal) => signal.type === 'interruption').length,
      negativeFeedbackCount: owned.filter((signal) => signal.type === 'frustration').length,
      positiveFeedbackCount: owned.filter((signal) => signal.type === 'positive').length,
    };
  };
  const displayIndicatorsForSession = (session: ExperienceSessionSummary): ExperienceReviewIndicators => {
    const humanEvents = (session.timelinePreview ?? []).filter((event) => event.kind === 'user_message' && Boolean(event.snippet) && !isSyntheticUserMessageText(event.snippet ?? ''));
    const interactionEvents = humanEvents.filter((event) => isUserInteractionMetricText(event.snippet ?? ''));
    const canonicalFeedback = canonicalFeedbackCountsForDisplay(session);
    return {
      ...session.indicators,
      userFollowUpCount: canonicalFeedback?.userFollowUpCount ?? interactionEvents.reduce((sum, event, index) => sum + (displayMetricIsActive(event, 'user_follow_up', index > 0 && !hasUserGoalShiftSignal(event.snippet ?? ''), session.id) ? 1 : 0), 0),
      userCorrectionCount: canonicalFeedback?.userCorrectionCount ?? interactionEvents.reduce((sum, event) => sum + displayMetricCount(event, 'user_correction', findUserCorrectionMatches(event.snippet ?? '').length, session.id), 0),
      userInterruptionCount: canonicalFeedback?.userInterruptionCount ?? interactionEvents.reduce((sum, event) => sum + (displayMetricIsActive(event, 'user_interruption', displayRegexMatches(USER_INTERRUPTION_DISPLAY_RE, event.snippet ?? ''), session.id) ? 1 : 0), 0),
      negativeFeedbackCount: canonicalFeedback?.negativeFeedbackCount ?? interactionEvents.reduce((sum, event) => sum + displayMetricCount(event, 'negative_feedback', findNegativeFeedbackMatches(event.snippet ?? '').length), 0),
      positiveFeedbackCount: canonicalFeedback?.positiveFeedbackCount ?? interactionEvents.reduce((sum, event) => sum + displayMetricCount(event, 'positive_feedback', findPositiveFeedbackMatches(event.snippet ?? '').length), 0),
      userGoalShiftCount: interactionEvents.reduce((sum, event) => sum + displayMetricCount(event, 'user_goal_shift', findUserGoalShiftMatches(event.snippet ?? '').length, session.id), 0),
      hardRuleTextHitCount: interactionEvents.reduce((sum, event) => sum + (displayMetricIsActive(event, 'hard_rule', hasUserHardRuleText(event.snippet ?? ''), session.id) ? 1 : 0), 0),
      assistantDeliverySignalCount: (session.timelinePreview ?? []).reduce((sum, event) => sum + (displayMetricIsActive(event, 'completion_result', event.kind === 'assistant_message' && hasAssistantDeliverySignalText(event.fullText ?? event.snippet ?? '')) ? 1 : 0), 0),
      deliverableArtifactSignalCount: (session.timelinePreview ?? []).reduce((sum, event) => sum + (displayMetricIsActive(event, 'deliverable_artifact', event.kind === 'assistant_message' && hasAssistantDeliverableArtifactText(event.fullText ?? event.snippet ?? '')) ? 1 : 0), 0),
      selfCorrectionCount: (session.timelinePreview ?? []).reduce((sum, event) => sum + (displayMetricIsActive(event, 'self_correction', hasSelfCorrectionSignal(event)) ? 1 : 0), 0),
      repeatedExecutionCount: (session.timelinePreview ?? []).reduce((sum, event) => sum + (displayMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event)) ? 1 : 0), 0),
    };
  };
  const sessionMetricSourceTitle = (session: ExperienceSessionSummary, metricKey: ObservationMetricKey, label: string): string => {
    const canonicalType = feedbackSignalTypeForMetric(metricKey);
    if (canonicalType) {
      const signals = canonicalFeedbackSignalsForDisplay(session, canonicalType);
      if (signals.length > 0) {
        const rows = signals.slice(0, 8).map((signal) => {
          const role = (signal.canonicalAttributions ?? signal.attributions ?? [])
            .filter((attribution) => feedbackAttributionBelongsToDisplaySession(attribution, session))
            .map((attribution) => attribution.attributionRole === 'downstream_related' ? '下游调用链路' : '直接归因')
            .find(Boolean) ?? '归因命中';
          return `#${signal.evidenceRef.messageIndex ?? '—'} ${role}：${signal.text.slice(0, 80).replace(/\s+/g, ' ')}`;
        });
        return [
          `${label}：最终计入 ${signals.length}`,
          '来源：任务执行归因模型',
          `证据：${rows.join('；')}`,
          '点击原文回溯中的同名标签，可以定位到这些 evidenceRef。',
        ].join('\n');
      }
    }
    const humanEvents = (session.timelinePreview ?? []).filter((event) => event.kind === 'user_message' && Boolean(event.snippet) && !isSyntheticUserMessageText(event.snippet ?? ''));
    const rows: string[] = [];
    let ruleCount = 0;
    let confirmed = 0;
    let rejected = 0;
    let finalCount = 0;
    let interactionIndex = 0;
    humanEvents.forEach((event) => {
      const text = event.snippet ?? '';
      if (!isUserInteractionMetricText(text)) return;
      const effectiveIndex = interactionIndex;
      interactionIndex += 1;
      const rule = metricKey === 'user_follow_up'
        ? (effectiveIndex > 0 && !hasUserGoalShiftSignal(text) ? 1 : 0)
        : metricKey === 'user_correction'
          ? findUserCorrectionMatches(text).length
          : metricKey === 'user_interruption'
            ? (displayRegexMatches(USER_INTERRUPTION_DISPLAY_RE, text) ? 1 : 0)
            : metricKey === 'negative_feedback'
              ? findNegativeFeedbackMatches(text).length
              : metricKey === 'positive_feedback'
                ? findPositiveFeedbackMatches(text).length
                : metricKey === 'hard_rule'
                  ? (hasUserHardRuleText(text) ? 1 : 0)
                  : metricKey === 'user_goal_shift'
                    ? findUserGoalShiftMatches(text).length
                    : 0;
      const verdict = displayMetricVerdict(event, metricKey, session.id);
      const finalValue = displayMetricCount(event, metricKey, rule, session.id);
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
      '点击按钮查看指标定义；人工反对只扣掉对应消息，不会自动扣掉其它来源。',
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
      sessionInterruptedCount: current.sessionInterruptedCount + (next.sessionInterruptedCount ?? 0),
      negativeFeedbackCount: current.negativeFeedbackCount + next.negativeFeedbackCount,
      positiveFeedbackCount: current.positiveFeedbackCount + next.positiveFeedbackCount,
      userGoalShiftCount: current.userGoalShiftCount + next.userGoalShiftCount,
      hardRuleTextHitCount: current.hardRuleTextHitCount + next.hardRuleTextHitCount,
	      assistantDeliverySignalCount: current.assistantDeliverySignalCount + (next.assistantDeliverySignalCount ?? 0),
	      deliverableArtifactSignalCount: current.deliverableArtifactSignalCount + (next.deliverableArtifactSignalCount ?? 0),
	      routerDownstreamCompleted: current.routerDownstreamCompleted + (next.routerDownstreamCompleted ?? 0),
	      routerDownstreamFailed: current.routerDownstreamFailed + (next.routerDownstreamFailed ?? 0),
	      selfCorrectionCount: current.selfCorrectionCount + (next.selfCorrectionCount ?? 0),
      repeatedExecutionCount: current.repeatedExecutionCount + (next.repeatedExecutionCount ?? 0),
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
    if (indicators.sessionInterruptedCount > 0) codes.push('session_interrupted');
    if (indicators.negativeFeedbackCount > 0) codes.push('negative_feedback');
    if (indicators.hardRuleTextHitCount > 0) codes.push('hard_rule_text_hit');
    if (indicators.toolFailureCount > 0) codes.push('tool_failure');
    if (indicators.hedgingCount > 0) codes.push('hedging_signal');
    if (indicators.explicitMarkerCount > 0) codes.push('explicit_marker');
    return codes;
  };
  const displayPriority = (indicators: ExperienceReviewIndicators): ExperienceReviewPriority => {
    if (indicators.highObservationCount > 0 || indicators.userCorrectionCount > 0 || indicators.userInterruptionCount > 0 || indicators.sessionInterruptedCount > 0 || indicators.negativeFeedbackCount > 0) return 'review_first';
    if (indicators.mediumObservationCount > 0 || indicators.toolFailureCount > 0 || indicators.hedgingCount > 0 || indicators.explicitMarkerCount > 0 || indicators.hardRuleTextHitCount > 0) return 'sample_review';
    return 'routine_sample';
  };
  const displayInferenceBasisCodes = (indicators: ExperienceReviewIndicators): ExperienceRuleFindingCode[] => {
    const codes: ExperienceRuleFindingCode[] = [];
    if (indicators.highObservationCount > 0) codes.push('high_observation_seen');
    if (indicators.userCorrectionCount > 0) codes.push('user_correction_seen');
    if (indicators.userInterruptionCount > 0) codes.push('user_interruption_seen');
    if (indicators.sessionInterruptedCount > 0) codes.push('session_interrupted_seen');
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
      indicators.highObservationCount > 0 || indicators.userCorrectionCount > 0 || indicators.userInterruptionCount > 0 || indicators.sessionInterruptedCount > 0 || indicators.negativeFeedbackCount > 0
        ? 'review_recommended'
        : indicators.mediumObservationCount > 0 || indicators.toolFailureCount > 0 || indicators.hedgingCount > 0 || indicators.explicitMarkerCount > 0 || indicators.hardRuleTextHitCount > 0
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
    const refsForCode = (code: ExperienceRuleFindingCode): ExperienceEvidenceRef[] | undefined => {
      const signalType =
        code === 'user_correction_seen' ? 'correction'
        : code === 'user_interruption_seen' ? 'interruption'
        : code === 'negative_feedback_seen' ? 'frustration'
        : code === 'positive_feedback_seen' ? 'positive'
        : undefined;
      if (!signalType) return undefined;
      const refs = canonicalFeedbackSignalsForDisplay(session, signalType).map((signal) => signal.evidenceRef);
      return refs.length > 0 ? refs : undefined;
    };
    const push = (code: ExperienceRuleFindingCode, level: ExperienceRuleFindingLevel, count: number): void => {
      if (count <= 0) return;
      const previous = oldByCode.get(code);
      next.push({ code, level, count, evidenceRefs: refsForCode(code) ?? previous?.evidenceRefs ?? [] });
    };
    push('high_observation_seen', 'attention', indicators.highObservationCount);
    push('user_correction_seen', 'attention', indicators.userCorrectionCount);
    push('user_interruption_seen', 'attention', indicators.userInterruptionCount);
    push('session_interrupted_seen', 'attention', indicators.sessionInterruptedCount);
    push('negative_feedback_seen', 'attention', indicators.negativeFeedbackCount);
    push('tool_failure_seen', 'sample', indicators.toolFailureCount);
    push('medium_observation_seen', 'sample', indicators.mediumObservationCount);
    push('hedging_seen', 'sample', indicators.hedgingCount);
    push('explicit_marker_seen', 'sample', indicators.explicitMarkerCount);
    push('hard_rule_seen', 'sample', indicators.hardRuleTextHitCount);
    push('positive_feedback_seen', 'normal', indicators.positiveFeedbackCount);
    push('user_goal_shift_seen', 'normal', indicators.userGoalShiftCount);
    for (const finding of old) {
      if ([
        'high_observation_seen',
        'user_correction_seen',
        'user_interruption_seen',
        'session_interrupted_seen',
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
    const displayToolCounts = mergeCountsByLabel(toolCounts, userFacingToolLabel);
    const total = indicators.toolCallCount;
    const failed = Math.max(0, indicators.toolFailureCount);
    const interrupted = Math.max(0, indicators.userInterruptionCount);
    const success = Math.max(0, total - failed);
    const processMetrics = [
      renderDecisionMetricIfPositive('高优先级', indicators.highObservationCount, 'priority'),
      renderDecisionMetricIfPositive('抽样过程发现', indicators.mediumObservationCount, 'sample'),
      renderDecisionMetricIfPositive('用户硬性要求', indicators.hardRuleTextHitCount, 'sample'),
      renderDecisionMetricIfPositive('自我纠正', indicators.selfCorrectionCount ?? 0, 'sample'),
      renderDecisionMetricIfPositive('重复执行', indicators.repeatedExecutionCount ?? 0, 'sample'),
      renderDecisionMetricIfPositive('不确定表达', indicators.hedgingCount, 'sample'),
      renderDecisionMetricIfPositive('显式缺口', indicators.explicitMarkerCount, 'sample'),
    ].filter(Boolean).join('');
    return `<div class="skill-evidence-summary">
      <div class="summary-row"><span class="summary-title">【skill 运行】</span>${renderMetric('调用段', skill.invocationCount, '次')}<span class="summary-muted">分布 ${skill.sessionCount} 个 session</span>${renderMetric('工具调用', total, '次')}${renderMetricShare('成功', success, total)}${renderDecisionMetricShare('失败', failed, total, 'sample')}${renderDecisionMetricShare('人工中断', interrupted, total, 'priority')}${renderDecisionMetricIfPositive('自我纠正', indicators.selfCorrectionCount ?? 0, 'sample')}${renderDecisionMetricIfPositive('重复执行', indicators.repeatedExecutionCount ?? 0, 'sample')}${renderSoftMetric('有结果', indicators.assistantDeliverySignalCount ?? 0, '助手回复里出现明确完成态或结果反馈。')}${renderSoftMetric('有产物', indicators.deliverableArtifactSignalCount ?? 0, '助手回复里出现文档链接、Demo 地址、文件路径、代码块或上传产物。')}</div>
      <div class="summary-row"><span class="summary-title">【用户交互】</span>${renderDecisionMetric('用户纠正', indicators.userCorrectionCount, 'priority')}${renderDecisionMetric('人工中断', indicators.userInterruptionCount, 'priority')}${renderMetric('追问', indicators.userFollowUpCount)}${renderDecisionMetric('负向反馈', indicators.negativeFeedbackCount ?? 0, 'priority')}${renderMetric('正向反馈', indicators.positiveFeedbackCount ?? 0)}${renderMetric('目标切换', indicators.userGoalShiftCount ?? 0)}</div>
      <div class="summary-row"><span class="summary-title">【工具调用】</span>${renderMetric('总计', total, '次')}<span class="summary-detail">(${renderRankedCounts(displayToolCounts, total)})</span>${renderDecisionMetricShare('工具执行失败', failed, total, 'sample')}</div>
      <div class="summary-row"><span class="summary-title">【过程发现】</span>${processMetrics || '<span class="summary-muted">未发现需要展示的过程信号</span>'}</div>
      ${renderSkillProblemPatterns(skill.skillName, skill.problemPatterns)}
    </div>`;
  };
  const renderSkillChainSummary = (skillName: string): string => {
    const chain = skillChains[skillName];
    if (!chain?.definition.found) {
      return `<span class="summary-muted">未找到 SKILL.md：当前日志能识别调用，但本机目录里没有对应 skill 定义，无法做 doctor 检查。</span>`;
    }
    const hard = chain.healthCheck.hardRules;
    const workflows = chain.healthCheck.workflows;
    const runtime = chain.runtime.summary;
    const record = skillDerivedStandards[skillName];
    const detectedHardCount = (record?.standards ?? []).filter((standard) =>
      standard.standardKind === 'hard_rule_candidate' && (standard.status === 'author_confirmed' || standard.status === 'pending_review')
    ).length;
    const hardText = hard.declared
      ? `标准化规则 ${hard.count} 条`
      : detectedHardCount > 0
        ? `规则检测 ${detectedHardCount} 条`
        : '标准化规则未声明';
    const workflowText = workflows.workflows.length > 0
      ? workflows.declared
        ? `标准化流程 ${workflows.branchCount} 条 / 节点 ${workflows.nodeCount}`
        : workflows.source === 'markdown_headings'
          ? `流程检测 ${workflows.branchCount} 条 / 节点 ${workflows.nodeCount}（正文流程）`
          : `流程检测 ${workflows.branchCount} 条 / 节点 ${workflows.nodeCount}`
      : '标准化流程未声明';
    const pending = (record?.standards ?? []).filter((standard) => standard.status === 'pending_review' || standard.status === 'stale');
    const hardPending = pending.filter((standard) => standard.standardKind === 'hard_rule_candidate');
    const workflowPending = pending.filter((standard) => standard.standardKind === 'workflow_candidate');
    const pendingLine = pending.length > 0
      ? `<div class="skill-chain-compact-candidates">
          <span>待确认 ${pending.length} 条</span>
          ${hardPending[0] ? `<span title="${e(hardPending[0].title)}">规则：${e(truncateText(hardPending[0].title, 18))}</span>` : ''}
          ${workflowPending[0] ? `<span title="${e(workflowPending[0].title)}">流程：${e(truncateText(workflowPending[0].title, 18))}</span>` : ''}
        </div>`
      : '';
    return `<div class="skill-chain-cell-summary">
      <div>${e(hardText)} · ${e(workflowText)}</div>
      <div>证据符合 ${runtime.passedCount} / 需关注 ${runtime.attentionCount} / 无法判断 ${runtime.manualReviewCount}</div>
      ${pendingLine}
    </div>`;
  };
  const collectSkillChainAdvisoryCodes = (skillName: string): SkillChainAdvisoryCode[] => {
    const chain = skillChains[skillName];
    if (!chain) return [];
    if (!chain.definition.found) return ['skill_md_not_found'];
    const codes: SkillChainAdvisoryCode[] = [];
    if (chain.healthCheck.hardRules.advisoryCode) codes.push(chain.healthCheck.hardRules.advisoryCode);
    if (chain.healthCheck.workflows.advisoryCode) codes.push(chain.healthCheck.workflows.advisoryCode);
    return codes;
  };
  const renderSkillChainButton = (skillName: string, templateId: string): string => {
    const chain = skillChains[skillName];
    const advisoryCodes = collectSkillChainAdvisoryCodes(skillName);
    const advisoryCount = advisoryCodes.length;
    const hasAdvisory = advisoryCount > 0;
    const advisoryLabels = advisoryCodes.map((code) => getSkillChainAdvisory(code).shortLabel);
    const title = chain?.definition.found
      ? (hasAdvisory
        ? `点开查看 skill 定义、标准规则和运行时证据；当前缺：${advisoryLabels.join('、')}。`
        : '点开查看 skill 定义、标准规则和运行时证据。')
      : '本机目录里没有这个 skill 的 SKILL.md。点开看建议怎么补，或试试 omk doctor。';
    return `<button type="button" class="context-chain-button${hasAdvisory ? ' has-advisory' : ''}" onclick="event.stopPropagation(); openContextChainModal('${e(templateId)}', this)" title="${e(title)}"><span class="context-chain-button-icon" aria-hidden="true">🔗</span><span class="context-chain-button-main">定义链路</span>${hasAdvisory ? `<span class="context-chain-button-advisory-list">${advisoryLabels.map((label) => `<span class="context-chain-button-advisory">${e(label)}</span>`).join('')}</span>` : '<span class="context-chain-button-ok">标准已声明</span>'}</button>`;
  };
  const runtimeLiteStatusIcon = (status: string): string =>
    status === 'passed' ? '✅' : status === 'attention' ? '❌' : '?';
  const runtimeLiteStatusLabel = (status: string): string =>
    status === 'passed' ? '有证据' : status === 'attention' ? '需复核' : '待判断';
  const displayRuntimeLiteTitle = (title: string, id: string, index: number): string => {
    const source = title || id;
    const parts = source.split('/').map((part) => part.trim()).filter(Boolean);
    const stepLabel = (value: string): string => {
      const match = value.match(/step[\s_-]*([0-9]+)/i);
      return match ? `第 ${match[1]} 步` : `第 ${index + 1} 步`;
    };
    if (parts.length >= 2 && parts[0] === 'markdown_steps') return `正文流程节点 / ${stepLabel(parts[1])}`;
    if (/^markdown_steps[._-]step/i.test(id)) return `正文流程节点 / ${stepLabel(id.replace(/^markdown_steps[._-]/i, ''))}`;
    if (/^step[\s_-]*[0-9]+$/i.test(source)) return stepLabel(source);
    return source || `检查项 ${index + 1}`;
  };
  const shouldShowRuntimeLiteRawId = (id: string): boolean =>
    Boolean(id) && !/^markdown_steps[._-]step/i.test(id) && id !== 'markdown_steps';
  const runtimeStepDepth = (title: string, id: string): number => {
    const source = `${id} ${title}`.toLowerCase();
    if (/\bstep[\s_-]*\d+[a-z]\b/.test(source)) return 1;
    if (/\bstep[\s_-]*\d+[._-][a-z0-9]+\b/.test(source)) return 1;
    return 0;
  };
  const renderRuntimeLiteList = (
    checks: Array<{ id: string; title: string; status: string; reason?: string; evidenceSnippets: string[] }>,
    kind: 'workflow' | 'rule',
    emptyText = '暂无可检查项。',
  ): string => checks.length > 0
    ? `<ol class="runtime-step-list">${checks.map((check, index) => `<li class="runtime-step runtime-${e(check.status)} is-depth-${runtimeStepDepth(check.title, check.id)}">
        <div class="runtime-step-head">
          <span class="runtime-step-index">${kind === 'workflow' ? `第 ${index + 1} 步` : `规则 ${index + 1}`}</span>
          <span class="runtime-step-name">${e(displayRuntimeLiteTitle(check.title, check.id, index))}</span>
          <span class="runtime-step-state" title="${e(runtimeLiteStatusLabel(check.status))}">${runtimeLiteStatusIcon(check.status)}</span>
        </div>
        <details class="runtime-step-detail">
          <summary>查看证据</summary>
          <div class="runtime-step-detail-body">
            ${shouldShowRuntimeLiteRawId(check.id) ? `<code>原始编号：${e(check.id)}</code>` : ''}
            ${check.reason ? `<p>${e(check.reason)}</p>` : ''}
            ${check.evidenceSnippets.length > 0 ? `<ul>${check.evidenceSnippets.map((snippet) => `<li>${e(snippet)}</li>`).join('')}</ul>` : '<p>没有可展示的证据片段。</p>'}
          </div>
        </details>
      </li>`).join('')}</ol>`
    : emptyText ? `<p class="context-muted">${e(emptyText)}</p>` : '';
  const renderRuntimeRuleFlow = (skillName: string): string => {
    const chain = skillChains[skillName];
    const enhancedReview = skillDerivedStandards[skillName]?.enhancedReview;
    const extractedStandards = enhancedReview?.extractedStandards;
    if (!chain && !extractedStandards) return '<p class="context-muted">没有找到这个 skill 的流程规则检测结果。</p>';
    const workflows = chain?.healthCheck.workflows.workflows ?? [];
    const hardRules = chain?.healthCheck.hardRules.rules ?? [];
    const llmWorkflowStandards = [
      ...(extractedStandards?.workflows ?? []),
      ...(extractedStandards?.completionCriteria ?? []),
      ...(extractedStandards?.artifactCriteria ?? []),
    ];
    const llmHardRuleStandards = extractedStandards?.hardrules ?? [];
    const llmStandardNodes = extractedStandards?.standardNodes ?? [];
    const llmWorkflowNodes = llmStandardNodes.filter((node) => node.nodeKind !== 'hardRule');
    const llmHardRuleNodes = llmStandardNodes.filter((node) => node.nodeKind === 'hardRule');
    const standardNodeById = new Map(llmStandardNodes.map((node) => [node.nodeId, node] as const));
    const standardNodeParentById = new Map<string, string>();
    for (const node of llmStandardNodes) {
      for (const childId of node.childNodeIds ?? []) {
        if (standardNodeById.has(childId) && !standardNodeParentById.has(childId)) {
          standardNodeParentById.set(childId, node.nodeId);
        }
      }
    }
    const standardNodeDepth = (node: typeof llmStandardNodes[number]): number => {
      let depth = 0;
      let current = standardNodeParentById.get(node.nodeId);
      const visited = new Set<string>([node.nodeId]);
      while (current && !visited.has(current) && depth < 3) {
        depth += 1;
        visited.add(current);
        current = standardNodeParentById.get(current);
      }
      if (depth > 0) return depth;
      return runtimeStepDepth(node.title, node.nodeId);
    };
    const sourceContent = chain?.definition.content ?? '';
    const sourcePreview = sourceContent.length > 12000 ? `${sourceContent.slice(0, 12000)}\n\n... 已截断，仅展示前 12000 字符` : sourceContent;
    const runtimeNodeResultById = new Map((enhancedReview?.runtimeNodeResults?.nodes ?? [])
      .map((node) => [node.nodeId, node] as const));
    const modelNodeStatusText = (status?: string): string => {
      if (status === 'passed') return '日志命中';
      if (status === 'failed' || status === 'missed') return '未发现调用';
      if (status === 'violated') return '命中异常';
      if (status === 'degraded') return '证据不可信';
      if (status === 'not_applicable') return '不适用';
      if (status === 'unknown') return '未发现调用';
      return '未发现调用';
    };
    const modelNodeStatusClass = (status?: string): string => {
      if (status === 'passed') return 'is-hit';
      if (status === 'failed' || status === 'missed' || status === 'violated' || status === 'degraded') return 'is-attention';
      return '';
    };
    const modelNodeStatusIcon = (status?: string): string => {
      if (status === 'passed') return '✅';
      if (status === 'failed' || status === 'violated' || status === 'degraded') return '❌';
      return '?';
    };
    type RuntimeNodeReview = NonNullable<SkillLlmEnhancedReviewSections['runtimeNodeResults']>['nodes'][number]
      | NonNullable<SkillLlmEnhancedReviewSections['runtimeNodeAssessment']>['nodes'][number];
    const reviewEvidenceSnippets = (review: RuntimeNodeReview): string[] => {
      if ('evidenceRefs' in review) return (review.evidenceRefs ?? []).map((ref) => ref.snippet).filter((snippet): snippet is string => Boolean(snippet)).slice(0, 3);
      return (review.evidence ?? []).slice(0, 3);
    };
    const compactRuntimeEvidence = (body: string, summary = '展开关键证据'): string => `<details class="runtime-rule-node-model-detail">
      <summary>${e(summary)}</summary>
      <div>${body}</div>
    </details>`;
    const renderRuntimeNodeReview = (review?: RuntimeNodeReview, fallback?: { reason?: string; evidenceSnippets: string[] }): string => {
      if (!review && !fallback) return `<div class="runtime-rule-node-model is-muted">
        <strong>未发现调用</strong>
        ${compactRuntimeEvidence('<p>运行日志中没有命中这个节点要求的调用信号。</p>', '展开说明')}
      </div>`;
      if (!review) return `<div class="runtime-rule-node-model">
        <strong>规则命中</strong>
        ${compactRuntimeEvidence(`${fallback?.reason ? `<p>${e(fallback.reason)}</p>` : ''}${(fallback?.evidenceSnippets ?? []).length > 0 ? `<ul>${(fallback?.evidenceSnippets ?? []).slice(0, 3).map((snippet) => `<li>${e(snippet)}</li>`).join('')}</ul>` : '<p>没有可展示的证据片段。</p>'}`)}
      </div>`;
      const snippets = reviewEvidenceSnippets(review);
      return `<div class="runtime-rule-node-model runtime-node-model-${e(review.status)}">
        <strong>${e(modelNodeStatusText(review.status))}</strong>
        ${compactRuntimeEvidence(`${review.reason ? `<p>${e(review.reason)}</p>` : ''}${snippets.length > 0 ? `<ul>${snippets.map((snippet) => `<li>${e(snippet)}</li>`).join('')}</ul>` : '<p>没有可展示的证据片段。</p>'}`)}
      </div>`;
    };
    const renderSourceHints = (node: typeof llmStandardNodes[number]): string => {
      const hints = (node.sourceHints ?? []).slice(0, 3);
      if (hints.length === 0) return '<p>来源原文：模型抽取节点，未返回可定位原文。</p>';
      return `<div class="runtime-rule-source-hints">
        <span>来源原文</span>
        <ul>${hints.map((hint) => `<li>${hint.line ? `<em>第 ${e(String(hint.line))} 行</em>` : ''}${e(hint.snippet)}</li>`).join('')}</ul>
      </div>`;
    };
    const signalLabel = (signal: typeof llmStandardNodes[number]['expectedSignals'][number]): string => {
      const typeLabel: Record<string, string> = {
        tool_name: '工具',
        tool_input: '工具输入',
        tool_output: '工具输出',
        assistant_text: '助手文本',
        user_text: '用户文本',
        artifact_kind: '产物类型',
        artifact_path: '产物路径',
        event_kind: '事件',
        file_path: '文件路径',
      };
      return `${typeLabel[signal.type] ?? signal.type}:${Array.isArray(signal.value) ? signal.value.join('/') : signal.value}`;
    };
    const renderSignalSummary = (node: typeof llmStandardNodes[number]): string => {
      const expected = node.expectedSignals.slice(0, 3).map(signalLabel);
      const forbidden = node.forbiddenSignals.slice(0, 2).map(signalLabel);
      const failure = node.failureSignals.slice(0, 2).map(signalLabel);
      const parts = [
        expected.length > 0 ? `期望 ${expected.join('、')}` : '',
        forbidden.length > 0 ? `禁止 ${forbidden.join('、')}` : '',
        failure.length > 0 ? `失败信号 ${failure.join('、')}` : '',
      ].filter(Boolean);
      return parts.length > 0
        ? `<p class="runtime-rule-match-spec">日志匹配口径：${e(parts.join('；'))}</p>`
        : '<p class="runtime-rule-match-spec">日志匹配口径：未抽取到结构化信号。</p>';
    };
    const renderModelStandards = (items: Array<{ title: string; body: string; evidence?: string[] }>): string =>
      items.length > 0
        ? `<div class="runtime-rule-model-list">
          <em>模型识别的候选标准，尚未等同于运行命中</em>
          ${items.map((item) => `<article class="runtime-rule-breakdown-item is-model">
            <strong>${e(item.title)}</strong>
            ${item.body ? `<p>${e(item.body)}</p>` : ''}
            ${(item.evidence ?? []).length > 0 ? `<ul>${(item.evidence ?? []).slice(0, 3).map((snippet) => `<li>${e(snippet)}</li>`).join('')}</ul>` : ''}
          </article>`).join('')}
        </div>`
        : '';
    const renderStandardNodeList = (nodes: typeof llmStandardNodes): string =>
      nodes.length > 0
        ? `<ol class="runtime-rule-node-list">${nodes.map((node, index) => {
          const depth = standardNodeDepth(node);
          return `<li class="runtime-rule-node is-depth-${depth}">
            <div class="runtime-rule-node-head">
              <span>${node.nodeKind === 'stage' ? `阶段 ${index + 1}` : `节点 ${index + 1}`}</span>
              <strong>${e(node.title)}</strong>
              <em>标准拆解</em>
            </div>
            ${node.description ? `<p>${e(node.description)}</p>` : ''}
            ${renderSourceHints(node)}
            ${renderSignalSummary(node)}
          </li>`;
        }).join('')}</ol>`
        : '';
    const renderRuntimeNodeResultList = (nodes: typeof llmStandardNodes): string =>
      nodes.length > 0
        ? `<ol class="runtime-step-list runtime-rule-execution-list">${nodes.map((node, index) => {
          const review = runtimeNodeResultById.get(node.nodeId);
          const depth = standardNodeDepth(node);
          return `<li class="runtime-step runtime-rule-execution-item ${modelNodeStatusClass(review?.status)} is-depth-${depth}">
            <div class="runtime-step-head">
              <span class="runtime-step-index">${node.nodeKind === 'stage' ? `阶段 ${index + 1}` : `节点 ${index + 1}`}</span>
              <span class="runtime-step-name">${e(node.title)}</span>
              <span class="runtime-step-state" title="${e(modelNodeStatusText(review?.status))}">${modelNodeStatusIcon(review?.status)}</span>
            </div>
            ${renderRuntimeNodeReview(review)}
          </li>`;
        }).join('')}</ol>`
        : '';
    const workflowBreakdown = workflows.length > 0
      ? workflows.map((workflow, workflowIndex) => `<div class="runtime-rule-flow-block">
          <div class="runtime-rule-flow-title">${e(workflow.id === 'markdown_steps' ? '正文流程' : `流程 ${workflowIndex + 1}`)}${workflow.description ? `<span>${e(workflow.description)}</span>` : ''}</div>
          <ol class="runtime-rule-node-list">${workflow.nodes.map((node, nodeIndex) => {
            return `<li class="runtime-rule-node">
              <div class="runtime-rule-node-head">
                <span>第 ${nodeIndex + 1} 步</span>
                <strong>${e(node.action || `流程节点 ${nodeIndex + 1}`)}</strong>
                <em>原文映射</em>
              </div>
              <p>来源原文：SKILL.md ${workflow.id === 'markdown_steps' ? '正文步骤' : `workflow ${workflow.id}`}。</p>
              <p class="runtime-rule-match-spec">日志匹配口径：根据这一步的动作关键词和工具调用证据进行匹配。</p>
            </li>`;
          }).join('')}</ol>
        </div>`).join('')
      : `<p class="context-muted">${chain?.healthCheck.workflows.declared ? '未解析到流程节点。' : '未标准化声明流程，当前只能依赖正文探测或运行时推断。'}</p>`;
    const hardRuleBreakdown = hardRules.length > 0
      ? `<ol class="runtime-rule-node-list">${hardRules.map((rule, ruleIndex) => {
        return `<li class="runtime-rule-node">
          <div class="runtime-rule-node-head">
            <span>规则 ${ruleIndex + 1}</span>
            <strong>${e(rule.rule)}</strong>
            <em>原文映射</em>
          </div>
          ${rule.expectedBehavior ? `<p>来源原文：${e(rule.expectedBehavior)}</p>` : '<p>来源原文：SKILL.md hardRules 声明。</p>'}
          <p class="runtime-rule-match-spec">日志匹配口径：根据规则约束和异常/禁止信号进行匹配。</p>
        </li>`;
      }).join('')}</ol>`
      : `<p class="context-muted">${chain?.healthCheck.hardRules.declared ? '未解析到硬性规则。' : '未标准化声明硬性规则，当前只能展示已探测到的规则证据。'}</p>`;
    const renderWorkflowRuntimeList = (): string => {
      const deterministic = chain ? renderRuntimeLiteList(chain.runtime.workflowNodes, 'workflow', '') : '';
      const model = renderRuntimeNodeResultList(llmWorkflowNodes);
      const content = `${deterministic}${model}`;
      return content || '<p class="context-muted">没有规则层流程命中数据。</p>';
    };
    const renderHardRuleRuntimeList = (): string => {
      const deterministic = chain ? renderRuntimeLiteList(chain.runtime.hardRules, 'rule', '') : '';
      const model = renderRuntimeNodeResultList(llmHardRuleNodes);
      const content = `${deterministic}${model}`;
      return content || '<p class="context-muted">没有规则层规则命中数据。</p>';
    };
    return `<div class="runtime-rule-three-col">
      <section class="runtime-rule-column">
        <h5>Skill 原文</h5>
        ${chain?.definition.found
          ? `<div class="runtime-rule-source-path"><code>${e(chain.definition.path ?? '')}</code></div><pre class="runtime-rule-source">${e(sourcePreview)}</pre>`
          : '<p class="context-muted">未找到本地 SKILL.md，只能展示运行时证据。</p>'}
      </section>
      <section class="runtime-rule-column">
        <h5>标准拆解 / 原文映射</h5>
        <p class="runtime-rule-column-hint">这一列只说明抽象节点来自哪段 SKILL.md，以及后续用什么口径去匹配日志。</p>
        <div class="runtime-rule-column-group">
          <h6>流程</h6>
          ${workflowBreakdown}
          ${renderStandardNodeList(llmWorkflowNodes)}
          ${renderModelStandards(llmWorkflowStandards)}
        </div>
        <div class="runtime-rule-column-group">
          <h6>硬性规则</h6>
          ${hardRuleBreakdown}
          ${renderStandardNodeList(llmHardRuleNodes)}
          ${renderModelStandards(llmHardRuleStandards)}
        </div>
      </section>
      <section class="runtime-rule-column">
        <h5>日志命中 / 执行判断</h5>
        <p class="runtime-rule-column-hint">这一列只看真实运行日志：节点有没有命中、是否异常，以及对应证据。</p>
        <div class="runtime-rule-column-group">
          <h6>流程命中</h6>
          ${renderWorkflowRuntimeList()}
        </div>
        <div class="runtime-rule-column-group">
          <h6>规则命中</h6>
          ${renderHardRuleRuntimeList()}
        </div>
      </section>
    </div>`;
  };
  const renderSkillChainTemplate = (skillName: string): string => {
    const chain = skillChains[skillName];
    const renderAdvisoryBlock = (advisoryCode?: SkillChainAdvisoryCode, skillNameForCmd?: string): string => {
      if (!advisoryCode) return '';
      const advisory = getSkillChainAdvisory(advisoryCode);
      const exampleBlock = advisory.exampleYaml
        ? `<details class="skill-chain-advisory-example">
            <summary>查看建议示例</summary>
            <pre>${e(advisory.exampleYaml)}</pre>
          </details>`
        : '';
      const resolvedCommand = skillNameForCmd ? resolveAdvisoryCommand(advisory, skillNameForCmd) : undefined;
      const commandBlock = resolvedCommand
        ? `<div class="skill-chain-advisory-cmd-wrap">
            <div class="skill-chain-advisory-cmd-label">如需更多体检维度（依赖检查、可读性等），可以试试 omk doctor（非必须）：</div>
            <div class="skill-chain-advisory-cmd-row">
              <code class="skill-chain-advisory-cmd" data-copy-target="${e(resolvedCommand)}">${e(resolvedCommand)}</code>
              <button type="button" class="skill-chain-advisory-copy-btn" data-copy-source="${e(resolvedCommand)}" title="复制命令到剪贴板">复制</button>
            </div>
          </div>`
        : '';
      return `<div class="skill-chain-advisory">
        <div class="skill-chain-advisory-message">⚠️ ${e(advisory.message)}</div>
        ${exampleBlock}
        ${commandBlock}
      </div>`;
    };
    if (!chain) {
      // SKILL.md 找不到也是一种 advisory，统一用 advisory block 渲染；
      // 同时给出（非强制的）omk doctor 建议命令。
      const notFoundAdvisory = renderAdvisoryBlock('skill_md_not_found', skillName);
      return `<div class="context-chain-grid">
        <section class="context-chain-panel">
          <h3>① 原始 SKILL.md</h3>
          ${notFoundAdvisory}
        </section>
        <section class="context-chain-panel">
          <h3>② 规则 / 流程探测</h3>
          <p class="context-muted">缺少本地 SKILL.md，当前无法探测规则和流程。这不代表作者没声明，只是本地看不到。</p>
        </section>
        <section class="context-chain-panel">
          <h3>③ 运行时</h3>
          <p class="context-muted">运行时证据可从 observe 时间线查看；静态定义链路在本地暂不可用。</p>
        </section>
        <section class="context-chain-panel">
          <h3>④ 候选确认</h3>
          <p class="context-muted">暂无可确认候选。</p>
        </section>
      </div>`;
    }
    const hard = chain.healthCheck.hardRules;
    const workflows = chain.healthCheck.workflows;
    const record = skillDerivedStandards[skillName];
    const softStandards = record?.standards ?? [];
    const statusPriority: Record<SkillDerivedStandard['status'], number> = {
      pending_review: 0,
      author_confirmed: 1,
      rejected: 2,
      stale: 3,
    };
    const sortedSoftStandards = [...softStandards].sort((a, b) =>
      statusPriority[a.status] - statusPriority[b.status] || a.standardKind.localeCompare(b.standardKind) || a.title.localeCompare(b.title)
    );
    const kindLabel = (kind: SkillDerivedStandard['standardKind']): string =>
      kind === 'workflow_candidate' ? '流程候选' : '规则候选';
    const annotationStateClass = (status: SkillDerivedStandard['status']): string =>
      status === 'author_confirmed' ? 'is-confirmed' : status === 'rejected' ? 'is-rejected' : '';
    const annotationStateIcon = (status: SkillDerivedStandard['status']): string =>
      status === 'author_confirmed' ? '✅' : status === 'rejected' ? '❌' : '';
    const candidateSourceTexts = (standard: SkillDerivedStandard): string[] => [
      ...standard.evidence,
      standard.title,
      standard.body,
    ]
      .map((text) => text.trim())
      .filter((text) => text.length >= 4)
      .sort((a, b) => b.length - a.length);
    const findCandidateRange = (
      content: string,
      standard: SkillDerivedStandard,
      usedRanges: Array<{ start: number; end: number }>,
    ): { start: number; end: number; text: string } | undefined => {
      for (const text of candidateSourceTexts(standard)) {
        const start = content.indexOf(text);
        const end = start + text.length;
        if (start >= 0 && !usedRanges.some((range) => start < range.end && end > range.start)) {
          return { start, end, text };
        }
      }
      return undefined;
    };
    const renderCandidateActions = (standard: SkillDerivedStandard): string => `
      <span class="skill-md-annotation-actions">
        <span data-soft-standard-status="${e(standard.status)}">${e(softStandardStatusLabel(standard.status))}</span>
        <button type="button" data-soft-standard-action="author_confirmed" onclick="setSoftStandardStatus('${e(skillName)}', '${e(standard.id)}', 'author_confirmed', this)">确认</button>
        <button type="button" data-soft-standard-action="rejected" onclick="setSoftStandardStatus('${e(skillName)}', '${e(standard.id)}', 'rejected', this)">否决</button>
      </span>`;
    const renderAnnotatedSkillMd = (content: string): string => {
      if (sortedSoftStandards.length === 0) return e(content);
      const usedRanges: Array<{ start: number; end: number }> = [];
      const annotations: Array<{ standard: SkillDerivedStandard; range: { start: number; end: number; text: string } }> = [];
      for (const standard of sortedSoftStandards) {
        const range = findCandidateRange(content, standard, usedRanges);
        if (!range) continue;
        usedRanges.push(range);
        annotations.push({ standard, range });
      }
      annotations.sort((a, b) => a.range.start - b.range.start);
      if (annotations.length === 0) return e(content);
      let cursor = 0;
      const parts: string[] = [];
      for (const { standard, range } of annotations) {
        parts.push(e(content.slice(cursor, range.start)));
        parts.push(`<span class="skill-md-highlight skill-md-highlight-${standard.standardKind === 'workflow_candidate' ? 'workflow' : 'rule'}" data-soft-standard-id="${e(standard.id)}">${e(content.slice(range.start, range.end))}</span><span class="skill-md-annotation ${annotationStateClass(standard.status)}" data-soft-standard-id="${e(standard.id)}" data-soft-standard-skill="${e(skillName)}"><span class="skill-md-annotation-icon" data-soft-standard-icon="${e(standard.status)}">${e(annotationStateIcon(standard.status))}</span><span class="skill-md-annotation-content"><strong>${e(kindLabel(standard.standardKind))}：</strong>${e(standard.title)}${renderCandidateActions(standard)}</span></span>`);
        cursor = range.end;
      }
      parts.push(e(content.slice(cursor)));
      return parts.join('');
    };
    const unlocatedStandards = sortedSoftStandards.filter((standard) => {
      const content = chain.definition.content ?? '';
      return !candidateSourceTexts(standard).some((text) => content.includes(text));
    });
    const renderUnlocatedCandidates = (): string => unlocatedStandards.length > 0
      ? `<details class="skill-md-unlocated">
          <summary>未定位到原文的候选 ${unlocatedStandards.length} 条</summary>
          <div class="soft-standard-modal-list">${unlocatedStandards.map((standard) => `<div class="soft-standard-modal-item ${annotationStateClass(standard.status)}" data-soft-standard-id="${e(standard.id)}" data-soft-standard-skill="${e(skillName)}">
            <div class="soft-standard-modal-head">
              <span class="skill-md-annotation-icon" data-soft-standard-icon="${e(standard.status)}">${e(annotationStateIcon(standard.status))}</span>
              <strong>${e(kindLabel(standard.standardKind))}：${e(standard.title)}</strong>
              <span data-soft-standard-status="${e(standard.status)}">${e(softStandardStatusLabel(standard.status))}</span>
            </div>
            <div class="soft-standard-modal-body">${e(standard.body)}</div>
            ${standard.evidence.length > 0 ? `<div class="soft-standard-modal-evidence">依据：${standard.evidence.map((entry) => e(entry)).join('；')}</div>` : ''}
            <div class="soft-standard-actions">
              <button type="button" data-soft-standard-action="author_confirmed" onclick="setSoftStandardStatus('${e(skillName)}', '${e(standard.id)}', 'author_confirmed', this)">确认</button>
              <button type="button" data-soft-standard-action="rejected" onclick="setSoftStandardStatus('${e(skillName)}', '${e(standard.id)}', 'rejected', this)">否决</button>
            </div>
          </div>`).join('')}</div>
        </details>`
      : '';
    const missingNotices = [
      !hard.declared ? renderAdvisoryBlock(hard.advisoryCode, skillName) : '',
      !workflows.declared ? renderAdvisoryBlock(workflows.advisoryCode, skillName) : '',
    ].filter(Boolean).join('');
    const detectedHardRuleStandards = sortedSoftStandards.filter((standard) =>
      standard.standardKind === 'hard_rule_candidate' && (standard.status === 'author_confirmed' || standard.status === 'pending_review')
    );
    const detectedWorkflowStandards = sortedSoftStandards.filter((standard) =>
      standard.standardKind === 'workflow_candidate' && (standard.status === 'author_confirmed' || standard.status === 'pending_review')
    );
    const detectedMarker = (status: SkillDerivedStandard['status']): string =>
      status === 'author_confirmed' ? '✅' : '待';
    const renderStructuredHardRules = (): string => hard.rules.length > 0
      ? `<div class="standard-checklist">${hard.rules.map((rule) => `<article class="standard-check-item">
          <div class="standard-check-marker" aria-hidden="true">✓</div>
          <div class="standard-check-body">
            <div class="standard-check-title"><code>${e(rule.id)}</code><strong>${e(rule.rule)}</strong></div>
            <div class="standard-check-expectation">期望行为：${e(rule.expectedBehavior)}</div>
          </div>
        </article>`).join('')}</div>`
      : `<div class="probe-anomaly">
          <strong>未声明标准化 hardRules</strong>
          <span>以下内容为规则检测结果；建议优化为能力定义文件顶部声明的标准化规则。</span>
        </div>
        ${detectedHardRuleStandards.length > 0
          ? `<div class="standard-checklist">${detectedHardRuleStandards.map((standard) => `<article class="standard-check-item">
              <div class="standard-check-marker" aria-hidden="true">${e(detectedMarker(standard.status))}</div>
              <div class="standard-check-body">
                <div class="standard-check-title"><code>${e(standard.id)}</code><strong>${e(standard.title)}</strong></div>
                <div class="standard-check-expectation">${e(standard.body)}</div>
              </div>
            </article>`).join('')}</div>`
          : '<p class="context-muted">暂未检测到可展示的规则结果。</p>'}`;
    const workflowStandardNotice = !workflows.declared
      ? `<div class="probe-anomaly">
          <strong>未声明标准化 workflows</strong>
          <span>以下内容为流程检测结果；建议优化为能力定义文件顶部声明的标准化流程。</span>
        </div>`
      : '';
    const displayStepLabel = (id: string, index: number): string => {
      const match = id.match(/^step[\s_-]*([0-9]+)$/i);
      if (match) return `第 ${match[1]} 步`;
      return id ? `流程节点 ${index + 1}` : `第 ${index + 1} 步`;
    };
    const displayWorkflowLabel = (id: string, index: number): string =>
      id === 'markdown_steps' ? '正文流程节点' : `流程 ${index + 1}`;
    const displayRuntimeCheckTitle = (title: string, id: string, index: number): string => {
      const source = title || id;
      const parts = source.split('/').map((part) => part.trim()).filter(Boolean);
      if (parts.length >= 2 && parts[0] === 'markdown_steps') return `正文流程节点 / ${displayStepLabel(parts[1], index)}`;
      if (/^markdown_steps[._-]step/i.test(id)) return `正文流程节点 / ${displayStepLabel(id.replace(/^markdown_steps[._-]/i, ''), index)}`;
      if (/^step[\s_-]*[0-9]+$/i.test(source)) return displayStepLabel(source, index);
      return source || `检查项 ${index + 1}`;
    };
    const shouldShowRuntimeCheckRawId = (id: string): boolean =>
      Boolean(id) && !/^markdown_steps[._-]step/i.test(id) && id !== 'markdown_steps';
    const renderStructuredWorkflows = (): string => workflows.workflows.length > 0
      ? `${workflowStandardNotice}<div class="workflow-line-list">${workflows.workflows.map((workflow, workflowIndex) => `<article class="workflow-line">
          <div class="workflow-line-head">
            <strong>${e(displayWorkflowLabel(workflow.id, workflowIndex))}</strong>
            <span>${workflow.source === 'markdown_headings' ? '正文流程探测' : '标准化声明'} · ${workflow.nodes.length} 个节点</span>
          </div>
          ${workflow.description ? `<div class="workflow-line-desc">${e(workflow.description)}</div>` : ''}
          <div class="workflow-node-line">${workflow.nodes.map((node, index) => `<div class="workflow-node">
            <div class="workflow-node-index">${index + 1}</div>
            <div class="workflow-node-card">
              <strong>${e(displayStepLabel(node.id, index))}</strong>
              <span>${e(node.action)}</span>
            </div>
          </div>`).join('')}</div>
        </article>`).join('')}</div>`
      : `<div class="probe-anomaly">
          <strong>未声明标准化 workflows</strong>
          <span>以下内容为流程检测结果；建议优化为能力定义文件顶部声明的标准化流程。</span>
        </div>
        ${detectedWorkflowStandards.length > 0
          ? `<div class="standard-checklist">${detectedWorkflowStandards.map((standard) => `<article class="standard-check-item">
              <div class="standard-check-marker" aria-hidden="true">${e(detectedMarker(standard.status))}</div>
              <div class="standard-check-body">
                <div class="standard-check-title"><code>${e(standard.id)}</code><strong>${e(standard.title)}</strong></div>
                <div class="standard-check-expectation">${e(standard.body)}</div>
              </div>
            </article>`).join('')}</div>`
          : '<p class="context-muted">暂未检测到可展示的流程结果。</p>'}`;
    const renderProbeLog = (): string => {
      const hardErrors = hard.errors.length > 0 ? hard.errors.join('；') : '无';
      const workflowErrors = workflows.errors.length > 0 ? workflows.errors.join('；') : '无';
      const confirmedHardRules = detectedHardRuleStandards.filter((standard) => standard.status === 'author_confirmed').length;
      const hardDeclareText = hard.declared
        ? `已标准化声明 ${hard.count} 条`
        : detectedHardRuleStandards.length > 0
          ? `未标准化声明；已有规则检测结果 ${detectedHardRuleStandards.length} 条，其中人工确认 ${confirmedHardRules} 条`
          : '未标准化声明；暂无规则检测结果';
      const workflowDeclareText = workflows.source === 'frontmatter'
        ? `已标准化声明 ${workflows.branchCount} 条链路 / ${workflows.nodeCount} 个节点`
        : workflows.source === 'markdown_headings'
          ? `未标准化声明；已从正文流程标题探测 ${workflows.branchCount} 条链路 / ${workflows.nodeCount} 个节点`
          : '未声明';
      return `<details class="probe-log" ${hard.rules.length === 0 || workflows.workflows.length === 0 ? 'open' : ''}>
        <summary>原始探测信息</summary>
        <table>
          <tbody>
            <tr><th>探测来源</th><td>${e(chain.healthCheck.source)}</td></tr>
            <tr><th>规则声明</th><td>${e(hardDeclareText)}</td></tr>
            <tr><th>规则异常</th><td>${e(hardErrors)}</td></tr>
            <tr><th>流程声明</th><td>${e(workflowDeclareText)}</td></tr>
            <tr><th>流程异常</th><td>${e(workflowErrors)}</td></tr>
          </tbody>
        </table>
      </details>`;
    };
    const renderReviewSummary = (): string => {
      const groups: Array<[string, SkillDerivedStandard[]]> = [
        ['待确认', sortedSoftStandards.filter((standard) => standard.status === 'pending_review')],
        ['已确认', sortedSoftStandards.filter((standard) => standard.status === 'author_confirmed')],
        ['已否决', sortedSoftStandards.filter((standard) => standard.status === 'rejected')],
        ['已过期', sortedSoftStandards.filter((standard) => standard.status === 'stale')],
      ];
      const meta = record
        ? `<div class="review-log-meta">
            <div>生成模型：${e(record.model)}</div>
            <div>生成时间：${e(record.generatedAt.slice(0, 19).replace('T', ' '))}</div>
            <div>Prompt：${e(record.promptId)} / ${e(record.promptVersion)}</div>
          </div>`
        : '<p class="context-muted">还没有候选提取记录。</p>';
      const grouped = groups.map(([label, standards]) => `<section class="review-log-group">
        <h4>${e(label)} ${standards.length}</h4>
        ${standards.length > 0
          ? `<ul>${standards.map((standard) => `<li><span>${e(kindLabel(standard.standardKind))}</span><strong>${e(standard.title)}</strong></li>`).join('')}</ul>`
          : '<p class="context-muted">暂无</p>'}
      </section>`).join('');
      return `${meta}${grouped}`;
    };
    const runtimeStatusIcon = (status: string): string =>
      status === 'passed' ? '✅' : status === 'attention' ? '❌' : '⏳';
    const runtimeStatusLabel = (status: string): string =>
      status === 'passed' ? '有数据支撑' : status === 'attention' ? '有异常' : '待补充';
    const runtimeStepList = (checks: typeof chain.runtime.hardRules, kind: 'workflow' | 'rule'): string => checks.length > 0
      ? `<ol class="runtime-step-list">${checks.map((check, index) => `<li class="runtime-step runtime-${e(check.status)}">
          <div class="runtime-step-head">
            <span class="runtime-step-index">${kind === 'workflow' ? `第 ${index + 1} 步` : `规则 ${index + 1}`}</span>
            <span class="runtime-step-name">${e(displayRuntimeCheckTitle(check.title, check.id, index))}</span>
            <span class="runtime-step-state" title="${e(runtimeStatusLabel(check.status))}">${runtimeStatusIcon(check.status)}</span>
          </div>
          <details class="runtime-step-detail">
            <summary>执行细节</summary>
            <div class="runtime-step-detail-body">
              ${shouldShowRuntimeCheckRawId(check.id) ? `<code>原始编号：${e(check.id)}</code>` : ''}
              ${check.reason ? `<p>${e(check.reason)}</p>` : ''}
              ${check.evidenceSnippets.length > 0 ? `<ul>${check.evidenceSnippets.map((snippet) => `<li>${e(snippet)}</li>`).join('')}</ul>` : ''}
            </div>
          </details>
        </li>`).join('')}</ol>`
      : '<p class="context-muted">暂无可检查项。</p>';
    const contextChainNav = `<nav class="context-chain-nav" aria-label="切换查看小节"><a href="#cc-${e(skillName)}-1">① 原始能力定义</a><a href="#cc-${e(skillName)}-2">② 检测结果</a><a href="#cc-${e(skillName)}-3">③ 运行时</a><a href="#cc-${e(skillName)}-4">④ 人工复盘</a><span class="context-chain-nav-hint">可向右滚动查看</span></nav>`;
    return `${contextChainNav}<div class="context-chain-grid">
      <section class="context-chain-panel" id="cc-${e(skillName)}-1">
        <h3>① 原始能力定义 / 候选标注</h3>
        ${chain.definition.found
          ? `<div class="context-meta">SKILL.md：<code>${e(chain.definition.path ?? '')}</code></div>
             <pre class="skill-md-source">${renderAnnotatedSkillMd(chain.definition.content ?? '')}${chain.definition.truncated ? '\n\n... 已截断，仅展示前 12000 字符' : ''}</pre>
             ${renderUnlocatedCandidates()}`
          : '<p class="context-muted">未找到能力定义文件：当前日志里能识别到这个能力，但本机目录没有对应定义。属于"定义不可用"，不是"作者没声明规则"。</p>'}
      </section>
      <section class="context-chain-panel" id="cc-${e(skillName)}-2">
        <h3>② 检测结果 / 标准化建议</h3>
        ${missingNotices || '<p class="context-muted">已探测到标准化声明，下面先看流程执行线，再看规则清单。</p>'}
        <h4>流程执行线</h4>
        ${renderStructuredWorkflows()}
        <h4>规则清单</h4>
        ${renderStructuredHardRules()}
        ${renderProbeLog()}
      </section>
      <section class="context-chain-panel" id="cc-${e(skillName)}-3">
        <h3>③ 运行时</h3>
        <p class="context-muted">${e(chain.runtime.message)}</p>
        <table>
          <tbody>
            <tr><th>调用段</th><td>${chain.runtime.summary.invocationCount}</td></tr>
            <tr><th>工具调用</th><td>${chain.runtime.summary.toolCallCount}</td></tr>
            <tr><th>工具失败</th><td>${chain.runtime.summary.toolFailureCount}</td></tr>
            <tr><th>证据符合</th><td>${chain.runtime.summary.passedCount}</td></tr>
            <tr><th>需关注</th><td>${chain.runtime.summary.attentionCount}</td></tr>
            <tr><th>无法自动判断</th><td>${chain.runtime.summary.manualReviewCount}</td></tr>
          </tbody>
        </table>
        <h4>流程运行时证据</h4>
        ${runtimeStepList(chain.runtime.workflowNodes, 'workflow')}
        <h4>规则运行时证据</h4>
        ${runtimeStepList(chain.runtime.hardRules, 'rule')}
      </section>
      <section class="context-chain-panel" id="cc-${e(skillName)}-4">
        <h3>④ 人工复盘状态</h3>
        ${renderReviewSummary()}
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
      session_interrupted: '会话出现异常中断信号',
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
  const renderAssistiveInference = (inference?: ExperienceAssistiveInference, compact = false, skillNameForAdvisory?: string): string => {
    if (!inference) return '<span style="color:var(--text-muted)">暂无辅助推断</span>';
    const meta = assistiveInferenceMeta(inference.code);
    const basis = inference.basisRuleCodes.length > 0
      ? inference.basisRuleCodes.map((code) => ruleFindingMeta(code).label).join('、')
      : '未命中优先规则';
    // 把 skill 级 advisory（缺 hardRules / 缺 workflows / SKILL.md 找不到）合并进 cautions：
    // 这样 L1 表格里不点开 modal 也能从 hover 看到「标准缺失」这件事。
    const skillAdvisoryCodes = skillNameForAdvisory ? collectSkillChainAdvisoryCodes(skillNameForAdvisory) : [];
    const advisoryShortLabels = skillAdvisoryCodes.map((code) => getSkillChainAdvisory(code).shortLabel);
    const cautionLabels = inference.cautionCodes.map(assistiveCautionLabel);
    const cautions = [...advisoryShortLabels, ...cautionLabels].join('、') || '无';
    const title = `${meta.description}\n依据：${basis}\n边界：${cautions}`;
    if (compact) {
      // L1 compact 模式不再展示「规则把握 high/medium/low」chip：
      // 它与 assistive label 是同一份数据的复读，cautionCodes 在 hover title 里仍可见。
      const advisoryChips = advisoryShortLabels.length > 0
        ? `<div class="assistive-advisory-row">${advisoryShortLabels.map((label) => `<span class="assistive-advisory-chip" title="点开右侧「skill 体检」查看建议">⚠️ ${e(label)}</span>`).join('')}</div>`
        : '';
      return `<div class="assistive-box compact ${meta.className}" title="${e(title)}">
        <div class="assistive-main">
          <span>${e(meta.label)}</span>
          <span class="signal-help assistive-help" tabindex="0" data-signal-title="${e(meta.label)}" data-signal-description="${e(title)}" aria-label="${e(title)}">?</span>
        </div>
        ${advisoryChips}
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  const softStandardStatusLabel = (status: SkillDerivedStandard['status']): string => {
    if (status === 'author_confirmed') return '作者已确认';
    if (status === 'rejected') return '已否决';
    if (status === 'stale') return '已过期';
    return '待作者确认';
  };
  const cleanReportCopy = (value: string): string => value
    .replace(/本次符合里程碑 1 的单个能力 \/ 单个目标报告范围。/g, '本次属于单个能力 / 单个目标报告范围。')
    .replace(/本次是复杂链路，里程碑 1 只做降级展示，不强行拆分语义分支。/g, '本次是复杂链路，当前先做降级展示，不强行拆分语义分支。')
    .replace(/里程碑 1 只做通用展示/g, '当前先做通用展示')
    .replace(/后续里程碑再拆/g, '后续再拆')
    .replace(/基于 deterministic 规则/g, '基于固定规则');
  const fallbackSessionStory = (report: ExperienceReviewerReport): ExperienceReviewerReport['sessionStory'] => {
    const stepByLabel = (label: string): ExperienceReviewerReport['chainSteps'][number] | undefined =>
      report.chainSteps.find((step) => step.label === label);
    const deliveryStep = stepByLabel('结果 / 产物') ?? stepByLabel('实际产物');
    const feedbackStep = stepByLabel('用户反馈');
    const hasFinalDeliveryAbsent = report.findings.some((finding) => finding.ruleSource === 'final_delivery_absent');
    const hasUserPain = report.findings.some((finding) =>
      finding.ruleSource === 'user_correction'
      || finding.ruleSource === 'negative_feedback'
      || finding.ruleSource === 'user_interruption'
    );
    const nodes = report.chainSteps.map((step) => ({
      id: `fallback-story-${step.order}`,
      order: step.order,
      kind: step.label === '用户期待'
        ? 'user_goal' as const
        : step.label === '选择能力'
          ? 'skill_invocation' as const
          : step.label === '执行流程'
            ? 'tool_execution' as const
            : step.label === '结果 / 产物' || step.label === '实际产物'
              ? 'delivery' as const
              : 'user_feedback' as const,
      label: step.label,
      status: step.status,
      text: cleanReportCopy(step.text),
      evidenceRefs: step.evidenceRefs,
    }));
    return {
      schemaVersion: 1,
      summary: '这是从旧版复盘报告回填的语义链路；建议重新运行 observe inbox 生成完整链路数据。',
      invocationCount: 0,
      goalSliceCount: 0,
      branchCount: 0,
      progressUpdateCount: 0,
      finalDeliverySignalCount: deliveryStep?.status === 'ok' ? 1 : 0,
      mainlineNodeIds: nodes.map((node) => node.id),
      goalSlices: [],
      subagentDispatches: [],
      skillLinks: [],
      graph: {
        nodes: nodes.map((node) => ({ id: node.id, label: node.label, kind: node.kind, status: node.status, detailNodeId: node.id })),
        edges: nodes.slice(1).map((node, index) => ({ fromId: nodes[index].id, toId: node.id, label: '下一步' })),
      },
      nodes,
      answers: [
        {
          key: 'goal_satisfaction',
          label: '用户目标有没有被满足',
          status: hasUserPain || hasFinalDeliveryAbsent ? 'attention' : deliveryStep?.status ?? 'unknown',
          reason: hasUserPain || hasFinalDeliveryAbsent ? 'attention_accumulated' : 'unknown_dominant',
          sourceItemKeys: [],
          text: hasFinalDeliveryAbsent ? '没有发现最后结果反馈，无法判断用户目标是否满足。' : '基于旧版报告，只能按结果反馈和用户反馈信号粗略判断。',
          evidenceRefs: [...(deliveryStep?.evidenceRefs ?? []), ...(feedbackStep?.evidenceRefs ?? [])],
          checklistItems: [],
        },
        {
          key: 'declared_behavior_fit',
          label: '行为是否符合能力用途',
          status: stepByLabel('执行流程')?.status ?? 'unknown',
          reason: 'unknown_dominant',
          sourceItemKeys: [],
          text: '基于旧版报告，只能从执行流程和工具失败信号粗略判断；标准化规则/流程请看定义链路。',
          evidenceRefs: stepByLabel('执行流程')?.evidenceRefs ?? [],
          checklistItems: [],
        },
        {
          key: 'user_feeling',
          label: '用户是否觉得有用或绕路',
          status: hasUserPain ? 'attention' : feedbackStep?.status ?? 'unknown',
          reason: hasUserPain ? 'attention_accumulated' : 'unknown_dominant',
          sourceItemKeys: [],
          text: cleanReportCopy(feedbackStep?.text ?? '没有看到明确用户反馈。'),
          evidenceRefs: feedbackStep?.evidenceRefs ?? [],
          checklistItems: [],
        },
      ],
    };
  };
  const renderReviewerReport = (report?: ExperienceReviewerReport): string => {
    if (!report) return '';
    const findingClass = (level: ExperienceReviewerReport['findings'][number]['level']): string =>
      level === 'attention' ? 'rule-attention' : level === 'possible_false_positive' ? 'rule-sample' : 'rule-normal';
    const findingLabel = (level: ExperienceReviewerReport['findings'][number]['level']): string =>
      level === 'attention' ? '要看一眼' : level === 'possible_false_positive' ? '疑似误判' : '记录项';
    const judgmentReviewLabel = (verdict?: string): string => {
      if (verdict === 'real_issue') return '已同意';
      if (verdict === 'not_issue') return '已否决';
      if (verdict === 'needs_more_context') return '已留意见';
      if (verdict === 'reviewed') return '已看过';
      return '未标注';
    };
    const stepStatus = (status: ExperienceReviewerReport['chainSteps'][number]['status']): string =>
      status === 'ok' ? '看起来正常' : status === 'attention' ? '要看一眼' : status === 'degraded' ? '数据有问题' : status === 'not_applicable' ? '不适用' : '信息不够';
    const storyStatusLabel = (status: ExperienceReviewerReport['sessionStory']['nodes'][number]['status']): string =>
      status === 'ok' ? '看起来正常' : status === 'attention' ? '要看一眼' : status === 'degraded' ? '数据有问题' : status === 'not_applicable' ? '不适用' : '要看一眼';
    const storyStatusClass = (status: ExperienceReviewerReport['sessionStory']['nodes'][number]['status']): string =>
      status === 'ok' ? 'is-ok' : status === 'attention' ? 'is-attention' : status === 'degraded' ? 'is-attention' : 'is-unknown';
    const reportModeLabel = report.mode === 'deterministic_milestone_1' || report.mode === 'deterministic_session_story' ? '规则生成，无模型判断' : report.mode;
    const reportScopeLabel = report.scope.kind === 'single_skill_single_goal' ? '单次任务 / 单个能力' : '复杂链路，降级展示';
    const evidenceKindLabel = (kind: ExperienceEvidenceRef['kind']): string => {
      const labels: Record<ExperienceEvidenceRef['kind'], string> = {
        user_message: '用户消息',
        synthetic_user_event: '构造事件',
        assistant_message: '助手回复',
        tool_use: '工具调用',
        tool_result: '工具结果',
        skill_context: '能力说明',
        runtime_context: '运行注入',
        observation: '过程发现',
      };
      return labels[kind] ?? kind;
    };
    const metrics = report.oneLookMetrics;
    const tokenUsage = metrics.tokenUsage;
    const traceLinks = report.traceLinks.slice(0, 8);
    const story = report.sessionStory ?? fallbackSessionStory(report);
    const storyEvidenceButtons = (refs: ExperienceEvidenceRef[]): string => refs.length > 0
      ? `<div class="session-story-evidence">${refs.slice(0, 4).map((ref) => `<button type="button" class="reviewer-trace-link" data-jump-message-index="${ref.messageIndex ?? ''}" data-jump-message-uuid="${e(ref.messageUuid ?? '')}" onclick="jumpToExperienceMessage(this)" title="切换到证据片段并定位到对应消息">#${e(String(ref.messageIndex ?? '-'))} ${e(evidenceKindLabel(ref.kind))}</button>`).join('')}</div>`
      : '';
    const storyKindLabel = (kind: ExperienceReviewerReport['sessionStory']['nodes'][number]['kind']): string => {
      if (kind === 'user_goal') return '目标';
      if (kind === 'skill_invocation') return '能力';
      if (kind === 'subagent_branch') return '分支';
      if (kind === 'tool_execution') return '执行';
      if (kind === 'delivery') return '交付';
      if (kind === 'user_feedback') return '反馈';
      if (kind === 'goal_shift') return '切换';
      return kind;
    };
    const skillRoleLabel = (role?: string): string => {
      if (role === 'router') return '路由';
      if (role === 'executor') return '执行';
      if (role === 'mixed') return '路由+执行';
      return '信息不够';
    };
    const runtimeSkillTypeLabel = (type?: string): string => {
      if (type === 'router') return '路由';
      if (type === 'delegation') return '委派';
      if (type === 'executor') return '执行';
      if (type === 'advisory') return '咨询';
      return '未确认';
    };
    const episodeRoleLabel = (role?: string): string => {
      if (role === 'main_executor') return '主执行';
      if (role === 'router') return '路由';
      if (role === 'delegator') return '调度';
      if (role === 'supporting') return '辅助';
      if (role === 'observer') return '观察';
      return '未确认';
    };
    const feedbackSignalTypeLabel = (type?: string): string => {
      if (type === 'correction') return '用户纠正';
      if (type === 'follow_up') return '用户追问';
      if (type === 'frustration') return '不满/焦虑';
      if (type === 'interruption') return '用户中断';
      if (type === 'positive') return '正向反馈';
      return '反馈';
    };
    const outcomeClosureLabel = (closure?: string): string => {
      if (closure === 'closed') return '已闭环';
      if (closure === 'unresolved') return '未闭环';
      if (closure === 'abandoned') return '用户中断';
      return '未知';
    };
    const storyPriorityLabel = (priority?: string): string => {
      if (priority === 'review_first') return '要看一眼';
      if (priority === 'sample_review') return '抽样复核';
      return '常规复盘';
    };
    const orchestrationStatusLabel = (status?: string): string => {
      if (status === 'started') return '已启动';
      if (status === 'completed') return '已完成';
      if (status === 'failed') return '失败';
      return '未知';
    };
    const storyNodeById = new Map(story.nodes.map((node) => [node.id, node]));
    const mainlineNodes = story.mainlineNodeIds
      .map((id) => storyNodeById.get(id))
      .filter((node): node is NonNullable<ReturnType<typeof storyNodeById.get>> => Boolean(node));
    const storyLlmGoalText = (skillName?: string): string => {
      if (!skillName) return '';
      const goal = skillDerivedStandards[skillName]?.enhancedReview?.userGoal;
      const parts = [
        ...(goal?.slots ?? []),
        goal?.summary,
        goal?.expectedOutcome,
      ]
        .map((value) => (value ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const first = parts[0] ?? '';
      return first.length > 48 ? `${first.slice(0, 48)}…` : first;
    };
    const storyGoalText = (goal: ExperienceReviewerReport['sessionStory']['goalSlices'][number]): string => {
      const fallbackSkill = goal.skillNames[0] ?? story.skillLinks[0]?.skillName;
      return goal.inferredUserGoal
        ?? storyLlmGoalText(fallbackSkill)
        ?? '未提取到明确用户目标';
    };
    const renderStoryGraph = (): string => {
      return `<div class="session-story-graph">
        <div class="session-story-graph-main">
          ${mainlineNodes.map((node, index) => `<button type="button" class="session-story-graph-node ${storyStatusClass(node.status)}" onclick="document.getElementById('${e(node.id)}')?.scrollIntoView({block:'nearest'})">
            <span>${e(storyKindLabel(node.kind))}</span>
            <strong>${e(node.label)}</strong>
          </button>${index < mainlineNodes.length - 1 ? '<i>→</i>' : ''}`).join('')}
        </div>
        ${story.skillLinks.length > 0 ? `<div class="session-story-skill-lanes">
          ${story.skillLinks.map((link) => `<div class="session-story-skill-lane">
            <span>${e(skillRoleLabel(link.role))}</span>
            <strong>${e(link.skillName)}</strong>
            <em>${link.invocationIds.length} 次调用</em>
          </div>`).join('')}
        </div>` : ''}
      </div>`;
    };
    const renderStoryGoalSlices = (): string => story.goalSlices.length > 0
      ? `<div class="session-story-slices">
        ${story.goalSlices.map((goal) => `<div class="session-story-slice">
          <strong>目标段 ${goal.order}</strong>
          <span>${e(goal.skillNames.join('、') || '未记录能力')}</span>
          <p>${e(storyGoalText(goal))}</p>
          ${storyEvidenceButtons(goal.evidenceRefs)}
        </div>`).join('')}
      </div>`
      : '';
    const renderStoryDispatches = (): string => story.subagentDispatches.length > 0
      ? `<div class="session-story-dispatches">
        ${story.subagentDispatches.map((dispatch) => `<div class="session-story-dispatch">
          <strong>分支 ${dispatch.order}：${e(dispatch.label)}</strong>
          <span>${dispatch.eventCount} 条事件${dispatch.attachTo?.messageIndex !== undefined ? ` · 挂接 #${dispatch.attachTo.messageIndex}` : ''}</span>
          ${storyEvidenceButtons(dispatch.evidenceRefs)}
        </div>`).join('')}
      </div>`
      : '';
    const renderStoryEpisodes = (): string => {
      const episodes = story.episodes ?? [];
      if (episodes.length === 0) return '';
      return `<div class="session-story-episodes">
        ${episodes.map((episode) => `<article class="session-story-episode">
          <div class="session-story-episode-head">
            <div>
              <strong>连续任务 ${episode.order}</strong>
              <p>${e(episode.primaryGoal ?? '未提取到明确用户目标')}</p>
            </div>
            <div class="session-story-episode-badges">
              <span>${e(outcomeClosureLabel(episode.outcome?.closure))}</span>
              <span>${e(storyPriorityLabel(episode.outcome?.verdict))}</span>
            </div>
          </div>
          ${episode.skillSegments.length > 0 ? `<div class="session-story-episode-skills">
            ${episode.skillSegments.map((segment) => `<div class="session-story-episode-skill">
              <span>${e(runtimeSkillTypeLabel(segment.skillType))}</span>
              <strong>${e(segment.skillName)}</strong>
              <em>${e(episodeRoleLabel(segment.episodeRole))}</em>
            </div>`).join('')}
          </div>` : ''}
          ${episode.orchestrationEdges.length > 0 ? `<div class="session-story-episode-edges">
            ${episode.orchestrationEdges.map((edge) => `<div>
              <span>链路</span>
              <strong>${e(edge.childSessionId ?? '下游执行')}</strong>
              <em>${e(orchestrationStatusLabel(edge.status))}</em>
              ${storyEvidenceButtons(edge.evidenceRefs)}
            </div>`).join('')}
          </div>` : ''}
          ${episode.feedbackSignals.length > 0 ? `<div class="session-story-episode-feedback">
            ${episode.feedbackSignals.map((signal) => `<div>
              <span>${e(feedbackSignalTypeLabel(signal.type))}</span>
              <strong>${e(signal.targetObject ? `${signal.targetObject}：${signal.text}` : signal.text)}</strong>
              <em>${(signal.canonicalAttributions ?? signal.attributions).map(renderFeedbackAttributionLabel).join('；')}</em>
              ${storyEvidenceButtons([signal.evidenceRef])}
            </div>`).join('')}
          </div>` : ''}
          ${episode.outcome?.artifacts?.length ? `<div class="session-story-episode-artifacts">
            ${episode.outcome.artifacts.map((artifact) => `<div>
              <span>产物</span>
              <strong>${e(artifact.label)}</strong>
              ${storyEvidenceButtons([artifact.evidenceRef])}
            </div>`).join('')}
          </div>` : ''}
          ${episode.outcome?.acceptanceCriteria ? `<p class="session-story-episode-acceptance">${e(episode.outcome.acceptanceCriteria)}</p>` : ''}
        </article>`).join('')}
      </div>`;
    };
    return `<section class="reviewer-report" style="margin:0 0 14px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);text-align:left">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:10px">
        <div>
          <h3 style="font-size:14px;margin:0 0 5px;color:var(--text-primary)">复盘报告</h3>
          <div style="font-size:13px;font-weight:700;color:var(--text-primary)">${e(report.title)}</div>
          <div style="margin-top:4px;color:var(--text-muted);font-size:12px;line-height:1.5">${e(cleanReportCopy(report.summary))}</div>
        </div>
        <div style="flex:0 0 auto;text-align:right;color:var(--text-muted);font-size:11px;line-height:1.45">
          <div>${e(reportModeLabel)}</div>
          <div>${e(reportScopeLabel)}</div>
        </div>
      </div>
      <section class="session-story">
        <div class="session-story-head">
          <div>
            <h4>语义链路</h4>
            <p>${e(story.summary)}</p>
          </div>
          <div class="session-story-meta">
            <span>调用 ${story.invocationCount}</span>
            <span>目标段 ${story.goalSliceCount}</span>
            <span>分支 ${story.branchCount}</span>
            <span>过程进展 ${story.progressUpdateCount}</span>
            <span>有结果 ${story.finalDeliverySignalCount}</span>
          </div>
        </div>
        ${renderStoryGraph()}
        ${renderStoryEpisodes()}
        <div class="session-story-answers">
          ${story.answers.map((answer) => `<article class="session-story-answer ${storyStatusClass(answer.status)}">
            <div>
              <strong>${e(answer.label)}</strong>
              <span>${e(storyStatusLabel(answer.status))}</span>
            </div>
            <p>${e(answer.text)}</p>
            ${storyEvidenceButtons(answer.evidenceRefs)}
          </article>`).join('')}
        </div>
        ${renderStoryGoalSlices()}
        ${renderStoryDispatches()}
        <div class="session-story-line">
          ${story.nodes.map((node) => `<article class="session-story-node ${storyStatusClass(node.status)}">
            <div class="session-story-node-index">${node.order}</div>
            <div class="session-story-node-body">
              <div class="session-story-node-title">
                <strong>${e(node.label)}</strong>
                <span>${e(storyStatusLabel(node.status))}</span>
              </div>
              <p>${e(node.text)}</p>
              ${storyEvidenceButtons(node.evidenceRefs)}
            </div>
          </article>`).join('')}
        </div>
      </section>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;margin-bottom:10px">
        ${report.chainSteps.map((step) => `<div style="min-width:0;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg-surface)">
          <div style="display:flex;justify-content:space-between;gap:6px;margin-bottom:5px">
            <strong style="font-size:12px;color:var(--text-primary)">${step.order}. ${e(step.label)}</strong>
            <span style="font-size:10px;color:var(--text-muted);font-family:ui-monospace,monospace">${e(stepStatus(step.status))}</span>
          </div>
          <div style="font-size:11px;color:var(--text-secondary);line-height:1.45;word-break:break-word">${e(step.text)}</div>
        </div>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:10px">
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:6px">事实层判断</div>
          <div class="rule-finding-list">
            ${report.findings.map((finding) => `<div class="rule-finding ${findingClass(finding.level)} reviewer-judgment-card" data-reviewer-judgment-id="${e(finding.judgmentId)}" style="display:block;margin:0 0 6px;padding:8px 9px;border-radius:6px">
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:4px">
                <strong>${e(finding.title)}</strong>
                <span class="rule-level">${e(findingLabel(finding.level))}</span>
              </div>
              <div style="font-size:11px;color:var(--text-secondary);line-height:1.45">${e(cleanReportCopy(finding.body))}</div>
              <div style="margin-top:5px;font-family:ui-monospace,monospace;font-size:10px;color:var(--text-muted);word-break:break-all">ruleSource: ${e(finding.ruleSource)} / ruleVersion: ${e(finding.ruleVersion)}${finding.evidenceRefs[0]?.messageIndex !== undefined ? ` / evidence #${finding.evidenceRefs[0].messageIndex}` : ''}</div>
              <div class="reviewer-judgment-review" data-reviewer-judgment-current="${e(finding.reviewStateRef.verdict ?? '')}">
                <span data-reviewer-judgment-label>${e(judgmentReviewLabel(finding.reviewStateRef.verdict))}</span>
                <button type="button" data-reviewer-judgment-verdict="real_issue" onclick="setReviewerJudgmentReview('${e(finding.judgmentId)}', 'real_issue', this)">同意</button>
                <button type="button" data-reviewer-judgment-verdict="not_issue" onclick="setReviewerJudgmentReview('${e(finding.judgmentId)}', 'not_issue', this)">否决</button>
                <button type="button" data-reviewer-judgment-verdict="needs_more_context" onclick="openReviewerJudgmentNote('${e(finding.judgmentId)}', this)">留意见</button>
                ${finding.reviewStateRef.reason || finding.reviewStateRef.note ? `<small>${e(finding.reviewStateRef.reason ?? finding.reviewStateRef.note ?? '')}</small>` : ''}
              </div>
            </div>`).join('')}
          </div>
        </div>
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:6px">一眼数据</div>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-bottom:10px">
            ${[
              ['工具调用', metrics.toolCallCount],
              ['工具失败', metrics.toolFailureCount],
              ['用户消息', metrics.userMessageCount],
              ['追问/补充', metrics.userFollowUpCount],
              ['有结果', metrics.assistantDeliverySignalCount],
              ['有产物', metrics.deliverableArtifactSignalCount ?? 0],
              ['自我纠正', metrics.selfCorrectionCount ?? 0],
              ['重复执行', metrics.repeatedExecutionCount ?? 0],
              ['原始事件', metrics.traceEventCount],
            ].map(([label, value]) => `<div style="padding:7px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface)"><div style="font-size:10px;color:var(--text-muted)">${e(String(label))}</div><strong style="font-size:13px;color:var(--text-primary)">${e(String(value))}</strong></div>`).join('')}
          </div>
          <div style="font-size:11px;color:var(--text-muted);line-height:1.5;margin-bottom:8px">
            Token 使用量（按本次能力片段归因）：输入 ${tokenUsage.inputTokens} / 输出 ${tokenUsage.outputTokens} / 缓存读取 ${tokenUsage.cacheReadTokens} / 缓存写入 ${tokenUsage.cacheCreationTokens}
          </div>
          <div style="font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:6px">证据定位</div>
          <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">
            ${traceLinks.length > 0 ? traceLinks.map((ref) => `<button type="button" class="reviewer-trace-link" data-jump-message-index="${ref.messageIndex ?? ''}" data-jump-message-uuid="${e(ref.messageUuid ?? '')}" onclick="jumpToExperienceMessage(this)" title="切换到证据片段并定位到对应消息">#${e(String(ref.messageIndex ?? '-'))} ${e(evidenceKindLabel(ref.kind))}${ref.messageUuid ? ` / ${e(ref.messageUuid)}` : ''}</button>`).join('') : '<span style="color:var(--text-muted);font-size:11px">暂无可定位证据</span>'}
          </div>
          <div style="font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:6px">给作者下一步</div>
          <ul style="margin:0;padding-left:18px;color:var(--text-secondary);font-size:12px;line-height:1.55">
            ${report.authorSuggestions.map((suggestion) => `<li>${e(suggestion)}</li>`).join('')}
          </ul>
        </div>
      </div>
    </section>`;
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
      session_interrupted_seen: { label: '会话异常中断', description: 'trace 中出现会话异常切换或 assistant turn failed 标记。' },
      negative_feedback_seen: { label: '负向反馈', description: '人工用户消息命中明确负向表达。' },
      positive_feedback_seen: { label: '正向反馈', description: '人工用户消息命中明确认可表达，仅作为正向证据展示。' },
      user_goal_shift_seen: { label: '用户切换目标', description: '人工用户消息命中“换个方向/先不/不用这个”等目标切换表达；这通常表示目标切走，不自动归因给 skill。' },
      hard_rule_seen: { label: '用户硬性要求', description: '人工用户消息命中“必须/不要/禁止”等临时硬性要求。Skill 自身的强约束请看定义链路里的规则检测结果。' },
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
      const userEvents = events.filter((event) => event.kind === 'user_message' && !isSyntheticUserMessageText(event.snippet ?? ''));
      return {
      userMessageCount: userEvents.length,
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
    const anchor = (label: string, ref?: ExperienceEvidenceRef): string => {
      if (!ref) return '';
      const title = [ref.timestamp, ref.snippet].filter(Boolean).join(' · ');
      const msg = ref.messageIndex !== undefined ? `#${ref.messageIndex}` : '有记录';
      return `<button type="button" class="evidence-anchor" data-jump-message-index="${ref.messageIndex ?? ''}" data-jump-message-uuid="${e(ref.messageUuid ?? '')}" onclick="jumpToExperienceMessage(this)" title="${e(title || '切换并定位到对应消息')}">${e(label)} ${e(msg)}</button>`;
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
        ${item('失败结果', chain.toolFailureResultCount, 'tool_result 明确失败，或返回内容里带 status=error / error 字段')}
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
  interface TimelineRenderOptions {
    reviewSessionId?: string;
    currentSkillName?: string;
    includeDownstreamFeedback?: boolean;
    feedbackSignals?: ExperienceFeedbackSignal[];
    activeEventIds?: Set<string>;
    activeSourceTrace?: string;
    activeStartRecordIndex?: number;
    activeEndRecordIndex?: number;
    showSkillWindowMarkers?: boolean;
    suppressMetricTagsOutsideSkillWindow?: boolean;
  }
  interface TimelineHighlightRule {
    pattern?: RegExp;
    ranges?: (value: string) => Array<{ start: number; end: number }>;
    className: string;
    title: string;
  }
  const USER_INTERRUPTION_RE = /\[Request interrupted by user(?: for tool use)?\]|interrupted by user|用户中断/i;
  const HARD_RULE_RE = HARD_RULE_TEXT_RE;
  const HEDGING_RE = /可能|不确定|需要确认|大概|也许|presumably|maybe|unclear|not sure/i;
  const EXPLICIT_MARKER_RE = /【推断】|【知识缺口】|【未知】|\[inferred\]|\[unknown\]|\[knowledge\s*gap\]/i;
  const TOOL_FAILURE_RE = /Error|error|failed|失败|Exception|ENOENT|EACCES|permission denied|No such file|exceeds maximum allowed tokens|timed out|timeout/i;
  const DELIVERABLE_ARTIFACT_RE = ASSISTANT_DELIVERABLE_ARTIFACT_RE;
  const evidenceMetricLabels: Record<ObservationMetricKey, string> = {
    user_correction: '纠正',
    user_interruption: '中断',
    user_follow_up: '追问',
    negative_feedback: '负向',
    positive_feedback: '正向',
    hard_rule: '用户硬性要求',
    user_goal_shift: '目标切换',
    result_artifact: '产出结果（旧）',
    completion_result: '有结果',
    deliverable_artifact: '有产物',
    progress_update: '过程进展',
    self_correction: '自我纠正',
    repeated_execution: '重复执行',
  };
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
	    if (event.kind === 'synthetic_user_event') return { icon: 'S', label: '构造事件', tone: 'runtime' };
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
	    return hasAssistantDeliverySignalText(text);
	  };
	  const isAssistantCompletionResultSignal = (event: ExperienceTimelineEvent): boolean => isAssistantDeliverySignal(event);
	  const isAssistantDeliverableArtifactSignal = (event: ExperienceTimelineEvent): boolean => {
	    if (event.kind !== 'assistant_message') return false;
	    const text = event.fullText ?? event.snippet ?? '';
	    return hasAssistantDeliverableArtifactText(text);
	  };
	  const isAssistantProgressUpdateSignal = (event: ExperienceTimelineEvent): boolean => {
	    if (event.kind !== 'assistant_message') return false;
	    const text = event.fullText ?? event.snippet ?? '';
	    return isAssistantProgressUpdateText(text);
	  };
	  function hasSelfCorrectionSignal(event: ExperienceTimelineEvent): boolean {
	    if (event.kind !== 'assistant_message') return false;
	    const text = event.fullText ?? event.snippet ?? '';
	    return /刚才.*(?:不对|错了|有误)|发现.*(?:不对|错了|问题|遗漏)|重新(?:检查|分析|执行|生成|整理)|改用|换成|修正|我再(?:检查|重新|看)|\b(?:recheck|retry|rerun|mistake|wrong)\b/i.test(text);
	  }
	  function hasRepeatedExecutionSignal(event: ExperienceTimelineEvent): boolean {
	    if (event.kind !== 'assistant_message' && event.kind !== 'tool_use') return false;
	    const text = `${event.label ?? ''} ${event.toolName ?? ''} ${event.fullText ?? event.snippet ?? ''}`;
	    return /重复(?:执行|尝试|读取|搜索|调用)|再次(?:执行|读取|搜索|调用)|重新(?:执行|读取|搜索|调用|跑|运行)|再(?:执行|读取|搜索|调用|跑)一遍|重试|\b(?:retry|rerun)\b/i.test(text);
	  }
	  const evidenceMetricVerdictFor = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, metricScopeId?: string): 'confirmed' | 'rejected' | '' => {
	    const targetId = observationMetricAnnotationTargetId({ ...event, metricScopeId }, metricKey);
	    const entry = reviewState.entries[reviewStateKey('evidence_metric', targetId)];
	    return entry?.verdict === 'confirmed' || entry?.verdict === 'rejected' ? entry.verdict : '';
	  };
	  const evidenceMetricIsActive = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, ruleDetected: boolean, metricScopeId?: string): boolean => {
	    const verdict = evidenceMetricVerdictFor(event, metricKey, metricScopeId);
	    if (verdict === 'confirmed') return true;
	    if (verdict === 'rejected') return false;
	    return ruleDetected;
	  };
  const evidenceMetricBadgeLabel = (base: string, event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, ruleDetected: boolean, metricScopeId?: string): string =>
	    evidenceMetricVerdictFor(event, metricKey, metricScopeId) === 'confirmed' && !ruleDetected ? `人工确认：${base}` : base;
  const feedbackSignalMatchesEvent = (signal: ExperienceFeedbackSignal, event: ExperienceTimelineEvent): boolean => {
    const ref = signal.evidenceRef;
    if (ref.messageUuid && event.messageUuid && ref.messageUuid === event.messageUuid) return true;
    return ref.sourceTrace === event.sourceTrace
      && typeof ref.messageIndex === 'number'
      && typeof event.messageIndex === 'number'
      && ref.messageIndex === event.messageIndex;
  };
  const feedbackSignalTag = (type?: string): string | undefined => {
    if (type === 'correction') return 'user_correction';
    if (type === 'follow_up') return 'user_follow_up';
    if (type === 'frustration') return 'negative_feedback';
    if (type === 'interruption') return 'user_interruption';
    if (type === 'positive') return 'positive_feedback';
    return undefined;
  };
  const canonicalFeedbackSignalsForEvent = (
    event: ExperienceTimelineEvent,
    skillName?: string,
    feedbackSignals: ExperienceFeedbackSignal[] = [],
    includeDownstreamFeedback = false,
  ): ExperienceFeedbackSignal[] => {
    if (!skillName || feedbackSignals.length === 0) return [];
    return feedbackSignals.filter((signal) =>
      feedbackSignalMatchesEvent(signal, event)
      && (signal.canonicalAttributions ?? signal.attributions ?? []).some((attribution) =>
        attribution.skillName === skillName
        && (
          attribution.attributionRole === 'primary_fault'
          || includeDownstreamFeedback && attribution.attributionRole === 'downstream_related'
        )
      )
    );
  };
  const timelineSearchTags = (
    event: ExperienceTimelineEvent,
    userIndex: number,
    allowMetricTags: boolean,
    metricScopeId?: string,
    currentSkillName?: string,
    feedbackSignals: ExperienceFeedbackSignal[] = [],
    includeDownstreamFeedback = false,
  ): string[] => {
    if (!allowMetricTags) return [];
    const text = event.fullText ?? event.snippet ?? '';
    const metricText = event.snippet ?? '';
    const tags: string[] = [];
    if (event.kind === 'user_message') {
      const syntheticUser = isSyntheticUserMessageText(metricText);
      if (syntheticUser) tags.push('synthetic_user_message');
      else tags.push('user_message');
      if (isScheduledTaskPromptText(metricText)) tags.push('scheduled_task');
      if (isUserInteractionMetricText(metricText)) {
        if (evidenceMetricIsActive(event, 'user_follow_up', userIndex > 0 && !hasUserGoalShiftSignal(metricText), metricScopeId)) tags.push('user_follow_up');
        if (evidenceMetricIsActive(event, 'user_correction', hasUserCorrectionSignal(metricText), metricScopeId)) tags.push('user_correction');
        if (evidenceMetricIsActive(event, 'user_goal_shift', hasUserGoalShiftSignal(metricText), metricScopeId)) tags.push('user_goal_shift');
        if (evidenceMetricIsActive(event, 'user_interruption', matches(USER_INTERRUPTION_RE, metricText), metricScopeId)) tags.push('user_interruption');
        if (evidenceMetricIsActive(event, 'negative_feedback', findNegativeFeedbackMatches(metricText).length > 0)) tags.push('negative_feedback');
        if (evidenceMetricIsActive(event, 'positive_feedback', findPositiveFeedbackMatches(metricText).length > 0)) tags.push('positive_feedback');
        if (evidenceMetricIsActive(event, 'hard_rule', hasUserHardRuleText(metricText), metricScopeId)) tags.push('hard_rule');
      }
      for (const signal of canonicalFeedbackSignalsForEvent(event, currentSkillName, feedbackSignals, includeDownstreamFeedback)) {
        const tag = feedbackSignalTag(signal.type);
        if (tag) tags.push(tag);
      }
    }
    if (event.kind === 'assistant_message') {
      if (evidenceMetricIsActive(event, 'completion_result', isAssistantCompletionResultSignal(event))) tags.push('completion_result');
      if (evidenceMetricIsActive(event, 'deliverable_artifact', isAssistantDeliverableArtifactSignal(event))) tags.push('deliverable_artifact');
      if (evidenceMetricIsActive(event, 'self_correction', hasSelfCorrectionSignal(event))) tags.push('self_correction');
      if (evidenceMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event))) tags.push('repeated_execution');
      if (matches(HEDGING_RE, text)) tags.push('hedging');
      if (matches(EXPLICIT_MARKER_RE, text)) tags.push('explicit_marker');
    }
    if (event.kind !== 'user_message' && event.kind !== 'assistant_message' && evidenceMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event))) tags.push('repeated_execution');
    if (event.kind === 'tool_result' && event.isError) tags.push('tool_failure');
    if (event.kind === 'observation') tags.push('observation');
    return Array.from(new Set(tags));
  };
	  const timelineMetricBadges = (
    event: ExperienceTimelineEvent,
    userIndex: number,
    allowMetricTags = true,
    metricScopeId?: string,
    currentSkillName?: string,
    feedbackSignals: ExperienceFeedbackSignal[] = [],
    includeDownstreamFeedback = false,
  ): string[] => {
    if (!allowMetricTags) return [];
	    const text = event.fullText ?? event.snippet ?? '';
	    const metricText = event.snippet ?? '';
    const badges: Array<{ label: string; className: string; title: string }> = [];
    if (event.kind === 'user_message') {
      const scheduledTask = isScheduledTaskPromptText(metricText);
      const syntheticUser = isSyntheticUserMessageText(metricText);
      badges.push({
        label: syntheticUser ? '系统构造消息（不计用户交互）' : scheduledTask ? '用户消息来源（定时任务）' : '用户消息来源',
        className: syntheticUser ? 'metric-skill-context' : scheduledTask ? 'metric-user-message metric-scheduled-task' : 'metric-user-message',
        title: syntheticUser
          ? '这是 trace 后处理或工作流系统注入的伪 user message，不计入真实用户消息、追问、纠正或硬性要求。'
          : scheduledTask
          ? '这是 cron 定时任务注入的用户侧任务入口，保留为用户消息来源，但不参与追问、负向反馈、硬性要求等人工交互指标。'
          : '这条人工用户消息计入用户消息数；同一 skill 片段内第 2 条及之后还会计入追问/补充。',
      });
      if (isUserInteractionMetricText(metricText)) {
        if (evidenceMetricIsActive(event, 'user_follow_up', userIndex > 0 && !hasUserGoalShiftSignal(metricText), metricScopeId)) badges.push({ label: evidenceMetricBadgeLabel('追问/补充来源', event, 'user_follow_up', userIndex > 0 && !hasUserGoalShiftSignal(metricText), metricScopeId), className: 'metric-followup', title: '同一 skill 复盘片段内，第 2 条及之后的人工用户消息计入追问/补充；目标切换消息不计入追问。' });
        if (evidenceMetricIsActive(event, 'user_correction', hasUserCorrectionSignal(metricText), metricScopeId)) badges.push({ label: evidenceMetricBadgeLabel('用户纠正来源', event, 'user_correction', hasUserCorrectionSignal(metricText), metricScopeId), className: 'metric-correction', title: '命中明确纠正表达；“不对/不是/错了”要求前后有标点、空格等分隔。人工反对后不会再显示。' });
        if (evidenceMetricIsActive(event, 'user_goal_shift', hasUserGoalShiftSignal(metricText), metricScopeId)) badges.push({ label: evidenceMetricBadgeLabel('目标切换来源', event, 'user_goal_shift', hasUserGoalShiftSignal(metricText), metricScopeId), className: 'metric-goal-shift', title: '命中“换个方向/先不/不用这个/另一个问题”等表达；表示用户可能切走当前目标。' });
        if (evidenceMetricIsActive(event, 'user_interruption', matches(USER_INTERRUPTION_RE, metricText), metricScopeId)) badges.push({ label: evidenceMetricBadgeLabel('人工中断来源', event, 'user_interruption', matches(USER_INTERRUPTION_RE, metricText), metricScopeId), className: 'metric-interruption', title: '用户主动中断了当前执行，通常表示当前路径需要纠偏或停止。' });
        if (evidenceMetricIsActive(event, 'negative_feedback', findNegativeFeedbackMatches(metricText).length > 0)) badges.push({ label: evidenceMetricBadgeLabel('负向反馈来源', event, 'negative_feedback', findNegativeFeedbackMatches(metricText).length > 0), className: 'metric-negative', title: '命中“没用/垃圾/菜/做错了/不行/看不懂”等负向表达。' });
        if (evidenceMetricIsActive(event, 'positive_feedback', findPositiveFeedbackMatches(metricText).length > 0)) badges.push({ label: evidenceMetricBadgeLabel('正向反馈来源', event, 'positive_feedback', findPositiveFeedbackMatches(metricText).length > 0), className: 'metric-positive', title: '命中“很好/good job/做得好/很棒/优秀/很有用”等正向表达。' });
        if (evidenceMetricIsActive(event, 'hard_rule', hasUserHardRuleText(metricText), metricScopeId)) badges.push({ label: evidenceMetricBadgeLabel('用户硬性要求来源', event, 'hard_rule', hasUserHardRuleText(metricText), metricScopeId), className: 'metric-hard-rule', title: '命中“必须/不要/禁止/严格”等用户临时硬性要求。' });
      }
      const canonicalTypes = new Set(canonicalFeedbackSignalsForEvent(event, currentSkillName, feedbackSignals, includeDownstreamFeedback).map((signal) => signal.type));
      if (canonicalTypes.has('correction') && !badges.some((badge) => badge.className === 'metric-correction')) {
        badges.push({ label: '用户纠正来源（归因）', className: 'metric-correction', title: '这条消息被任务执行归因模型判定为当前 skill 的用户纠正来源。' });
      }
      if (canonicalTypes.has('follow_up') && !badges.some((badge) => badge.className === 'metric-followup')) {
        badges.push({ label: '追问/补充来源（归因）', className: 'metric-followup', title: '这条消息被任务执行归因模型判定为当前 skill 的追问/补充来源。' });
      }
      if (canonicalTypes.has('frustration') && !badges.some((badge) => badge.className === 'metric-negative')) {
        badges.push({ label: '负向反馈来源（归因）', className: 'metric-negative', title: '这条消息被任务执行归因模型判定为当前 skill 的负向反馈来源。' });
      }
      if (canonicalTypes.has('interruption') && !badges.some((badge) => badge.className === 'metric-interruption')) {
        badges.push({ label: '人工中断来源（归因）', className: 'metric-interruption', title: '这条消息被任务执行归因模型判定为当前 skill 的人工中断来源。' });
      }
      if (canonicalTypes.has('positive') && !badges.some((badge) => badge.className === 'metric-positive')) {
        badges.push({ label: '正向反馈来源（归因）', className: 'metric-positive', title: '这条消息被任务执行归因模型判定为当前 skill 的正向反馈来源。' });
      }
    }
	    if (event.kind === 'assistant_message') {
	      if (evidenceMetricIsActive(event, 'completion_result', isAssistantCompletionResultSignal(event))) badges.push({ label: evidenceMetricBadgeLabel('有结果', event, 'completion_result', isAssistantCompletionResultSignal(event)), className: 'metric-completion', title: '助手回复里出现明确完成态或结果反馈，表示任务可能已有执行结果。它不等于一定交付了可打开的文档、链接或文件。' });
	      if (evidenceMetricIsActive(event, 'deliverable_artifact', isAssistantDeliverableArtifactSignal(event))) badges.push({ label: evidenceMetricBadgeLabel('有产物', event, 'deliverable_artifact', isAssistantDeliverableArtifactSignal(event)), className: 'metric-completion', title: '助手回复里出现可交付对象，例如文档链接、Demo 地址、文件路径、代码块或上传产物。' });
	      if (evidenceMetricIsActive(event, 'self_correction', hasSelfCorrectionSignal(event))) badges.push({ label: evidenceMetricBadgeLabel('自我纠正', event, 'self_correction', hasSelfCorrectionSignal(event)), className: 'metric-correction', title: 'agent 在没有用户介入的情况下发现问题并主动修正执行策略。少量说明有恢复能力，高频说明流程不稳。' });
	      if (evidenceMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event))) badges.push({ label: evidenceMetricBadgeLabel('重复执行', event, 'repeated_execution', hasRepeatedExecutionSignal(event)), className: 'metric-repeated-execution', title: '同类步骤、工具或流程被重复执行。高频出现时通常对应绕路或 workflow 不清晰。' });
	      if (matches(HEDGING_RE, text)) badges.push({ label: '不确定表达来源', className: 'metric-hedging', title: '命中“可能/不确定/需要确认”等表达。' });
	      if (matches(EXPLICIT_MARKER_RE, text)) badges.push({ label: '显式缺口来源', className: 'metric-explicit', title: '命中“【推断】/【未知】/知识缺口”等标记。' });
    }
    if (event.kind === 'tool_use') {
      if (evidenceMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event))) badges.push({ label: evidenceMetricBadgeLabel('重复执行', event, 'repeated_execution', hasRepeatedExecutionSignal(event)), className: 'metric-repeated-execution', title: '同类工具或流程被重复调用。高频出现时通常对应绕路或 workflow 不清晰。' });
      badges.push({
        label: '工具调用',
        className: 'metric-tool-use',
        title: event.toolName
          ? `这条记录表示 agent 调用了一个工具。原始工具名：${event.toolName}。`
          : '这条记录表示 agent 调用了一个工具。',
      });
    }
	    if (event.kind === 'tool_result') {
	      if (evidenceMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event))) badges.push({ label: evidenceMetricBadgeLabel('重复执行', event, 'repeated_execution', hasRepeatedExecutionSignal(event)), className: 'metric-repeated-execution', title: '同类工具结果或失败恢复路径被重复出现。高频出现时通常对应绕路或 workflow 不清晰。' });
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
    if (badges.length === 0 && event.kind !== 'assistant_message') {
      badges.push({ label: '上下文事件', className: 'metric-neutral', title: '这条时间线事件用于回溯上下文，当前没有额外指标判断。' });
    }
    return badges.map((badge) => `<span class="timeline-badge ${badge.className}" title="${e(badge.title)}">${e(badge.label)}</span>`);
  };
	  const highlightTimelineSnippet = (event: ExperienceTimelineEvent, userIndex: number, allowMetricTags = true, metricScopeId?: string): string => {
	    const rules: TimelineHighlightRule[] = [];
	    const value = event.snippet ?? '';
    if (!allowMetricTags) return e(value);
	    if (event.kind === 'user_message' && isUserInteractionMetricText(value)) {
      if (evidenceMetricIsActive(event, 'user_correction', hasUserCorrectionSignal(value), metricScopeId)) rules.push({ ranges: findUserCorrectionMatches, className: 'metric-correction', title: '用户纠正命中词' });
      if (evidenceMetricIsActive(event, 'user_goal_shift', hasUserGoalShiftSignal(value), metricScopeId)) rules.push({ ranges: findUserGoalShiftMatches, className: 'metric-goal-shift', title: '目标切换命中词' });
      if (evidenceMetricIsActive(event, 'user_interruption', matches(USER_INTERRUPTION_RE, value), metricScopeId)) rules.push({ pattern: cloneRegex(USER_INTERRUPTION_RE), className: 'metric-interruption', title: '人工中断命中词' });
      if (evidenceMetricIsActive(event, 'negative_feedback', findNegativeFeedbackMatches(value).length > 0)) rules.push({ ranges: findNegativeFeedbackMatches, className: 'metric-negative', title: '负向反馈命中词' });
      if (evidenceMetricIsActive(event, 'positive_feedback', findPositiveFeedbackMatches(value).length > 0)) rules.push({ ranges: findPositiveFeedbackMatches, className: 'metric-positive', title: '正向反馈命中词' });
      if (evidenceMetricIsActive(event, 'hard_rule', hasUserHardRuleText(value), metricScopeId)) rules.push({ pattern: cloneRegex(HARD_RULE_RE), className: 'metric-hard-rule', title: '用户硬性要求命中词' });
    }
	    if (event.kind === 'assistant_message') {
	      rules.push(
	        { pattern: /直接生成|已生成|生成如下|结果如下|完成|已完成/g, className: 'metric-completion', title: '有结果命中词' },
	        { pattern: cloneRegex(DELIVERABLE_ARTIFACT_RE), className: 'metric-completion', title: '有产物命中词' },
	        { pattern: /刚才.*(?:不对|错了|有误)|发现.*(?:不对|错了|问题|遗漏)|重新(?:检查|分析|执行|生成|整理)|改用|换成|修正|我再(?:检查|重新|看)|recheck|retry|mistake|wrong/gi, className: 'metric-correction', title: '自我纠正命中词' },
	        { pattern: /重复(?:执行|尝试|读取|搜索|调用)|再次(?:执行|读取|搜索|调用)|重新(?:执行|读取|搜索|调用|跑|运行)|再(?:执行|读取|搜索|调用|跑)一遍|重试|retry|rerun/gi, className: 'metric-repeated-execution', title: '重复执行命中词' },
	        { pattern: cloneRegex(HEDGING_RE), className: 'metric-hedging', title: '不确定表达命中词' },
	        { pattern: cloneRegex(EXPLICIT_MARKER_RE), className: 'metric-explicit', title: '显式缺口命中词' },
	      );
	    }
    if (event.kind !== 'user_message' && event.kind !== 'assistant_message' && evidenceMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event))) {
      rules.push({ pattern: /重复(?:执行|尝试|读取|搜索|调用)|再次(?:执行|读取|搜索|调用)|重新(?:执行|读取|搜索|调用|跑|运行)|再(?:执行|读取|搜索|调用|跑)一遍|重试|retry|rerun/gi, className: 'metric-repeated-execution', title: '重复执行命中词' });
    }
    if (event.kind === 'tool_result' && event.isError) {
      rules.push({ pattern: cloneRegex(TOOL_FAILURE_RE), className: 'metric-tool-failure', title: '工具执行失败命中词' });
    }
	    const html = highlightText(value, rules);
    if (event.kind === 'user_message' && isUserInteractionMetricText(value) && evidenceMetricIsActive(event, 'user_follow_up', userIndex > 0 && !hasUserGoalShiftSignal(value), metricScopeId)) {
      return `<span class="timeline-followup-source" title="整条消息计入追问/补充来源">${html}</span>`;
    }
    return html;
  };
  const evidenceMetricRuleDetected = (event: ExperienceTimelineEvent, userIndex: number, metricKey: ObservationMetricKey): boolean => {
    const text = event.snippet ?? '';
    if (event.kind === 'user_message' && !isUserInteractionMetricText(text)) return false;
    if (metricKey === 'user_correction') return hasUserCorrectionSignal(text);
    if (metricKey === 'user_interruption') return matches(USER_INTERRUPTION_RE, text);
    if (metricKey === 'user_follow_up') return userIndex > 0 && !hasUserGoalShiftSignal(text);
    if (metricKey === 'negative_feedback') return findNegativeFeedbackMatches(text).length > 0;
    if (metricKey === 'positive_feedback') return findPositiveFeedbackMatches(text).length > 0;
    if (metricKey === 'hard_rule') return hasUserHardRuleText(text);
    if (metricKey === 'user_goal_shift') return hasUserGoalShiftSignal(text);
    if (metricKey === 'result_artifact') return isAssistantCompletionResultSignal(event) || isAssistantDeliverableArtifactSignal(event);
    if (metricKey === 'completion_result') return isAssistantCompletionResultSignal(event);
    if (metricKey === 'deliverable_artifact') return isAssistantDeliverableArtifactSignal(event);
    if (metricKey === 'progress_update') return isAssistantProgressUpdateSignal(event);
    if (metricKey === 'self_correction') return hasSelfCorrectionSignal(event);
    if (metricKey === 'repeated_execution') return hasRepeatedExecutionSignal(event);
    return false;
  };
  const metricAnnotationTarget = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, metricScopeId?: string): string =>
    observationMetricAnnotationTargetId({ ...event, metricScopeId }, metricKey);
	  const metricAnnotationVerdict = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, metricScopeId?: string): 'confirmed' | 'rejected' | '' => {
	    const targetId = metricAnnotationTarget(event, metricKey, metricScopeId);
	    const entry = reviewState.entries[reviewStateKey('evidence_metric', targetId)];
	    return entry?.verdict === 'confirmed' || entry?.verdict === 'rejected' ? entry.verdict : '';
	  };
	  const metricAnnotationReason = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, metricScopeId?: string): string => {
	    const targetId = metricAnnotationTarget(event, metricKey, metricScopeId);
	    const entry = reviewState.entries[reviewStateKey('evidence_metric', targetId)];
	    return typeof entry?.reason === 'string' ? entry.reason : '';
	  };
  const timelineManualMetricKeys = (): ObservationMetricKey[] => [
    'user_correction',
    'user_interruption',
    'user_follow_up',
    'negative_feedback',
    'positive_feedback',
    'hard_rule',
    'user_goal_shift',
    'completion_result',
    'deliverable_artifact',
    'progress_update',
    'self_correction',
    'repeated_execution',
  ];
  const renderTimelineManualMarkButton = (sessionId: string, event: ExperienceTimelineEvent, userIndex: number, allowMetrics: boolean): string => {
	    const metrics = allowMetrics ? timelineManualMetricKeys().map((metricKey) => {
	      const targetId = metricAnnotationTarget(event, metricKey, sessionId);
	      const verdict = metricAnnotationVerdict(event, metricKey, sessionId);
	      const reason = metricAnnotationReason(event, metricKey, sessionId);
	      const ruleDetected = evidenceMetricRuleDetected(event, userIndex, metricKey);
	      const label = evidenceMetricLabels[metricKey];
	      return { targetId, metricKey, metricScopeId: sessionId, verdict, reason, ruleDetected, label };
	    }) : [];
    const goalTargetId = `${sessionId}:${event.messageIndex ?? event.id}`;
    const goalAction = goalSliceCorrectionAction(sessionId, event);
    const activeCount = metrics.filter((m) => m.verdict === 'confirmed' || m.verdict === 'rejected').length + (goalAction ? 1 : 0);
    const mode = allowMetrics ? 'metrics' : 'window_only';
    const buttonLabel = allowMetrics
      ? `人工标记${activeCount > 0 ? `(${activeCount})` : ''}`
      : goalAction === 'add_to_current_skill_window'
        ? '已加入窗口'
        : '加入窗口';
    const source = {
      sourceTrace: event.sourceTrace,
      sessionId: event.sessionId,
      messageIndex: event.messageIndex,
      messageUuid: event.messageUuid,
      toolUseId: event.toolUseId,
      snippet: (event.snippet ?? '').slice(0, 240),
    };
    return `<button type="button"
      class="timeline-manual-mark-button ${activeCount > 0 ? 'is-marked' : ''} ${allowMetrics ? '' : 'is-window-only'}"
      data-manual-mark-mode="${mode}"
      data-manual-mark-session-id="${e(sessionId)}"
      data-manual-mark-goal-target="${e(goalTargetId)}"
      data-manual-mark-goal-action="${e(goalAction)}"
      data-manual-mark-metrics="${e(JSON.stringify(metrics))}"
      data-manual-mark-source="${e(JSON.stringify(source))}"
      data-source-trace="${e(event.sourceTrace)}"
      data-session-id="${e(event.sessionId)}"
      data-message-index="${event.messageIndex ?? ''}"
      data-message-uuid="${e(event.messageUuid ?? '')}"
      data-tool-use-id="${e(event.toolUseId ?? '')}"
      data-snippet="${e((event.snippet ?? '').slice(0, 240))}"
      onclick="openTimelineManualMark(this)"
      title="${allowMetrics ? '人工标记这条消息' : '这条消息不在当前 skill 窗口内，先加入窗口后才能标注指标'}">${buttonLabel}</button>`;
  };
  const goalSliceCorrectionAction = (sessionId: string, event: ExperienceTimelineEvent): 'split_goal_slice' | 'add_to_current_skill_window' | '' => {
    const targetId = `${sessionId}:${event.messageIndex ?? event.id}`;
    const key = reviewStateKey('goal_slice_correction', targetId);
    const note = reviewState.entries[key]?.note ?? '';
    if (note.includes('add_to_current_skill_window')) return 'add_to_current_skill_window';
    if (reviewState.entries[key]) return 'split_goal_slice';
    return '';
  };
	  const renderExperienceTimeline = (events: ExperienceTimelineEvent[], sessionId: string, options: TimelineRenderOptions = {}): string => {
    if (events.length === 0) return '<div style="color:var(--text-muted);font-size:12px">没有可展示的时间线片段。</div>';
    const reviewSessionId = options.reviewSessionId ?? sessionId;
    const isInsideSkillWindow = (event: ExperienceTimelineEvent): boolean => {
      if (options.activeEventIds) return options.activeEventIds.has(event.id);
      if (options.activeSourceTrace && event.sourceTrace !== options.activeSourceTrace) return false;
      if (typeof event.messageIndex !== 'number') return true;
      const start = options.activeStartRecordIndex;
      const end = options.activeEndRecordIndex;
      if (typeof start === 'number' && event.messageIndex < start) return false;
      if (typeof end === 'number' && event.messageIndex > end) return false;
      return true;
    };
    const isAddedToSkillWindow = (event: ExperienceTimelineEvent): boolean =>
      goalSliceCorrectionAction(reviewSessionId, event) === 'add_to_current_skill_window';
    const allowMetricTagsFor = (event: ExperienceTimelineEvent): boolean =>
      !options.suppressMetricTagsOutsideSkillWindow || isInsideSkillWindow(event) || isAddedToSkillWindow(event);
    let userIndex = 0;
    const decorated = events.map((event) => {
      const interactionUser = event.kind === 'user_message' && isUserInteractionMetricText(event.snippet ?? '');
      const nextUserIndex = interactionUser ? userIndex++ : -1;
      return { event, userIndex: nextUserIndex };
    });
    const feedbackSignals = options.feedbackSignals ?? [];
    const groups: Array<{ boundary?: ExperienceTimelineEvent; items: typeof decorated }> = [];
    let current: typeof decorated = [];
    let currentBoundary: ExperienceTimelineEvent | undefined;
    for (const item of decorated) {
      const isManualBoundary = goalSliceCorrectionAction(reviewSessionId, item.event) === 'split_goal_slice';
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
      const allowMetricTags = allowMetricTagsFor(event);
      const searchTags = timelineSearchTags(event, currentUserIndex, allowMetricTags, reviewSessionId, options.currentSkillName, feedbackSignals, Boolean(options.includeDownstreamFeedback));
	      const badges = timelineMetricBadges(event, currentUserIndex, allowMetricTags, reviewSessionId, options.currentSkillName, feedbackSignals, Boolean(options.includeDownstreamFeedback)).join('');
	      const visibleText = event.snippet ?? '';
	      const fullText = event.fullText ?? visibleText;
      const isRealUserReply = event.kind === 'user_message'
        && isUserInteractionMetricText(visibleText)
        && !isSyntheticUserMessageText(visibleText)
        && !isScheduledTaskPromptText(visibleText);
	      const hasMoreFullText = Boolean(fullText && fullText.trim() !== visibleText.trim());
	      const fullTextAttrs = fullText
	        ? ` data-timeline-fulltext="${e(fullText)}" data-timeline-fulltext-title="${e(meta.label)} #${event.messageIndex ?? '—'}" data-timeline-has-more="${hasMoreFullText ? '1' : '0'}" tabindex="${hasMoreFullText ? '0' : '-1'}"`
	        : '';
	      return `<div class="timeline-row timeline-${meta.tone} ${isRealUserReply ? 'is-real-user-reply' : 'is-runtime-event'}" data-timeline-tags="${e(searchTags.join(' '))}" data-current-skill-window="${allowMetricTags ? '1' : '0'}" data-message-index="${event.messageIndex ?? ''}" data-message-uuid="${e(event.messageUuid ?? '')}" data-source-trace="${e(event.sourceTrace)}">
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
            ${renderTimelineManualMarkButton(reviewSessionId, event, currentUserIndex, allowMetricTags)}
          </header>
	          <pre class="timeline-snippet ${event.isError ? 'is-tool-error' : ''}"${fullTextAttrs}>${highlightTimelineSnippet(event, currentUserIndex, allowMetricTags, reviewSessionId)}</pre>
        </article>
      </div>`;
    };
    const renderWindowMarker = (kind: 'start' | 'end'): string => {
      const label = kind === 'start' ? '当前 skill 目标分片开始' : '当前 skill 目标分片结束';
      return `<div class="timeline-window-marker timeline-window-${kind}" data-timeline-window-marker="${kind}">
        <span>${e(label)}</span>
      </div>`;
    };
    const renderRowsWithWindowMarkers = (items: typeof decorated): string => {
      if (!options.showSkillWindowMarkers) {
        return items.map(renderRow).join('');
      }
      let firstInsideIdx = -1;
      let lastInsideIdx = -1;
      for (let i = 0; i < items.length; i += 1) {
        const inside = isInsideSkillWindow(items[i].event) || isAddedToSkillWindow(items[i].event);
        if (inside) {
          if (firstInsideIdx === -1) firstInsideIdx = i;
          lastInsideIdx = i;
        }
      }
      let output = '';
      for (let index = 0; index < items.length; index += 1) {
        if (index === firstInsideIdx) output += renderWindowMarker('start');
        output += renderRow(items[index]);
        if (index === lastInsideIdx) output += renderWindowMarker('end');
      }
      return output;
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
        <div class="experience-timeline">${renderRowsWithWindowMarkers(groupItems)}</div>
      </section>`;
    }).join('')}
      </div>
    </div>`;
  };
  const renderSessionTimelineTree = (session: ExperienceSessionSummary): string => {
    const activeEventIds = new Set(session.timelinePreview.map((event) => event.id));
    const fullTimelineOptions: TimelineRenderOptions = {
      reviewSessionId: session.id,
      currentSkillName: session.skillName,
      includeDownstreamFeedback: shouldIncludeDownstreamFeedbackForDisplay(session),
      feedbackSignals: session.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? []) ?? [],
      activeEventIds,
      activeSourceTrace: session.sourceTrace,
      activeStartRecordIndex: session.timelineScope?.segmentStartRecordIndex,
      activeEndRecordIndex: session.timelineScope?.segmentEndRecordIndex,
      showSkillWindowMarkers: true,
      suppressMetricTagsOutsideSkillWindow: true,
    };
    const tree = session.timelineTree;
    if (!tree || tree.branches.length === 0) {
      return renderExperienceTimeline(session.fullSessionTimeline ?? session.timelinePreview, `${session.id}-full`, fullTimelineOptions);
    }
    const main = tree.main;
    return `<div class="session-timeline-tree">
      <section class="timeline-main-chain">
        <header class="timeline-chain-header">
          <strong>主线 main</strong>
          <span>${main.length > 0 ? `${main.length} 条事件` : '未发现主线 jsonl'}</span>
        </header>
        ${main.length > 0 ? renderExperienceTimeline(main, `${session.id}-main`, fullTimelineOptions) : '<div style="color:var(--text-muted);font-size:12px;padding:10px;border:1px solid var(--border);border-radius:8px">这个 session 只发现 subagents 子链路，未发现可作为主线的 jsonl。</div>'}
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
            ${renderExperienceTimeline(branch.events, `${session.id}-branch-${index}`, fullTimelineOptions)}
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
    const truncatedText = scope.truncated ? '当前 skill 窗口不是完整 session 链路' : '当前展示覆盖本次 skill 窗口';
    const omittedText = `前面省略 ${scope.omittedBeforeCount} 个事件，后面省略 ${scope.omittedAfterCount} 个事件`;
    const branchCount = session.timelineTree?.branches.length ?? 0;
    const chainText = branchCount > 0
      ? `链路结构：主线 main + ${branchCount} 条 subagent 子链路；# 编号是各自 jsonl 文件内的 message index。`
      : '链路结构：单 jsonl 时间线。';
    return `<div class="timeline-scope-notice" data-timeline-scope-notice>
      <div>
        <strong>${e(truncatedText)}</strong>
        <span>当前 skill 窗口事件：${scope.previewEventCount} 条 / 完整 session ${scope.fullSessionEventCount} 条事件</span>
        <span>record 粗范围：${e(rangeText(scope.previewStartRecordIndex, scope.previewEndRecordIndex))} · skill 窗口：${e(rangeText(scope.segmentStartRecordIndex, scope.segmentEndRecordIndex))} · 完整 session：${e(rangeText(scope.sessionStartRecordIndex, scope.sessionEndRecordIndex))} · ${e(omittedText)}</span>
        <span>${e(chainText)}</span>
      </div>
      <button type="button" data-full-session-toggle onclick="toggleFullSessionTimeline(this)">查看完整 session 时间线</button>
    </div>`;
  };
  const timelinePreviewWithDisplayFeedback = (session: ExperienceSessionSummary): ExperienceTimelineEvent[] => {
    const preview = session.timelinePreview ?? [];
    const full = session.fullSessionTimeline ?? [];
    if (full.length === 0) return preview;
    const feedbackSignals = canonicalFeedbackSignalsForDisplay(session);
    if (feedbackSignals.length === 0) return preview;
    const alreadyShown = new Set(preview.map((event) => event.id));
    const events = [...preview];
    for (const signal of feedbackSignals) {
      const event = full.find((candidate) => feedbackSignalMatchesEvent(signal, candidate));
      if (!event || alreadyShown.has(event.id)) continue;
      alreadyShown.add(event.id);
      events.push(event);
    }
    return events.sort((a, b) => {
      const time = String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? ''));
      if (time !== 0) return time;
      return a.order - b.order;
    });
  };
  const renderTimelinePair = (session: ExperienceSessionSummary): string => `
    <div class="experience-detail-right timeline-pair-wrap" data-timeline-pair>
      ${renderTimelineScopeNotice(session)}
      <div class="timeline-filter-toolbar" data-timeline-filter-toolbar>
        <label>搜索标签</label>
        <select data-timeline-tag-filter onchange="filterTimelineByTag(this)">
          <option value="">全部标签</option>
          <option value="completion">有结果 / 完成态</option>
          <option value="positive_feedback">用户正向反馈</option>
          <option value="negative_feedback">用户负向反馈</option>
          <option value="user_correction">用户纠正</option>
          <option value="user_follow_up">追问 / 补充</option>
          <option value="user_interruption">人工中断</option>
          <option value="user_goal_shift">目标切换</option>
          <option value="hard_rule">用户硬性要求</option>
          <option value="self_correction">自我纠正</option>
          <option value="repeated_execution">重复执行</option>
          <option value="tool_failure">工具执行失败</option>
          <option value="hedging">不确定表达</option>
          <option value="explicit_marker">显式缺口</option>
        </select>
        <span data-timeline-filter-count>选择标签后，只显示当前回溯里的命中事件。</span>
      </div>
      <div data-timeline-view="segment">${renderExperienceTimeline(timelinePreviewWithDisplayFeedback(session), session.id, {
        reviewSessionId: session.id,
        currentSkillName: session.skillName,
        includeDownstreamFeedback: shouldIncludeDownstreamFeedbackForDisplay(session),
        feedbackSignals: session.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? []) ?? [],
      })}</div>
      <div data-timeline-view="full-session" style="display:none">${renderSessionTimelineTree(session)}</div>
    </div>
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
  const experienceSessionIdBySkillAndSession = new Map((experience?.sessions ?? []).map((session) => [`${session.skillName}\u0000${session.sessionId}`, session.id]));
  const metricGuideSections: Array<{ title: string; keys: IndicatorHelpKey[] }> = [
    { title: '用户交互', keys: ['userCorrection', 'userInterruption', 'userFollowUp', 'negativeFeedback', 'positiveFeedback', 'userGoalShift', 'hardRule'] },
    { title: 'Skill 执行', keys: ['toolCall', 'toolFailure', 'bash', 'read', 'grep'] },
    { title: 'Skill 类型', keys: ['skillRoleRouter', 'skillRoleExecutor', 'skillRoleMixed', 'skillRoleUnknown', 'llmSkillTypeRouter', 'llmSkillTypeDelegation', 'llmSkillTypeExecutor', 'llmSkillTypeAdvisory', 'llmSkillTypeWorkflowOwner', 'llmSkillTypeUnknown'] },
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
  const renderReviewerOverview = (session: ExperienceSessionSummary, detailId: string): string => {
    const report = session.reviewerReport;
    const story = session.sessionStory ?? (report ? report.sessionStory ?? fallbackSessionStory(report) : undefined);
    if (!story) return '<span style="color:var(--text-muted);font-size:12px">暂无复盘报告</span>';
    const answerText = story.answers
      .map((answer) => `${answer.label.replace('用户', '')}：${answer.status === 'ok' ? '看起来正常' : answer.status === 'attention' ? '要看一眼' : answer.status === 'degraded' ? '数据有问题' : answer.status === 'not_applicable' ? '不适用' : '信息不够'}`)
      .join('；');
    const mainline = story.mainlineNodeIds
      .map((id) => story.nodes.find((node) => node.id === id)?.label)
      .filter(Boolean)
      .slice(0, 5)
      .join(' → ');
    return `<div class="reviewer-overview-cell">
      <div class="reviewer-overview-title">${e(story.summary)}</div>
      <div class="reviewer-overview-findings">
        ${mainline ? `<span title="${e(mainline)}">主线：${e(mainline)}</span>` : ''}
        ${story.subagentDispatches.length > 0 ? `<span>关键分叉：${story.subagentDispatches.map((dispatch) => dispatch.label).slice(0, 3).map(e).join('、')}</span>` : ''}
        ${answerText ? `<span title="${e(answerText)}">${e(answerText)}</span>` : ''}
      </div>
      ${report ? `<button type="button" data-open-experience-detail onclick="event.stopPropagation(); openExperienceDetailModal('${detailId}', this, 'reviewer')">查看报告详情</button>` : ''}
    </div>`;
  };
  const sanitizeReviewerReportForDisplay = (report?: ExperienceReviewerReport): ExperienceReviewerReport | undefined => {
    if (!report) return undefined;
    return {
      ...report,
      summary: cleanReportCopy(report.summary),
      findings: report.findings.map((finding) => ({ ...finding, body: cleanReportCopy(finding.body) })),
    };
  };
  const experienceSkillRows = (experience?.skills ?? []).map((skill) => {
    // L1 不再展示 priority badge（与左侧"优先复盘/抽样复盘"列冗余）；priority 仍在 L2 / 详情 modal 使用。
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
    const sourceMetadataHtml = renderOpenClawSourceMetadata(skill.sourceMetadataCounts);
    const hardRuleSession = (experience?.sessions ?? []).find((session) =>
      session.skillName === skill.skillName && (displayIndicatorsForSession(session).hardRuleTextHitCount ?? 0) > 0
    );
    // 旧版按钮挂的是 onclick="event.stopPropagation()"，
    // 这会阻止冒泡到 document 上的 [data-open-experience-session] 全局监听器，
    // 导致点击没反应。改用 data-no-rollup-click 让外层 rollup row 监听器忽略本元素，
    // 但允许冒泡到 document 把 modal 打开。
    const sampleReviewCta = hardRuleSession
      ? `<button type="button" class="review-inline-cta" data-no-rollup-click="1" data-open-experience-session="${e(hardRuleSession.id)}" data-open-timeline-tag="hard_rule">查看详情</button>`
      : '';
    return `<tr data-observe-rollup-row data-skill-anchor="${e(experienceSkillAnchor(skill.skillName))}" style="cursor:pointer">
      <td style="padding:9px 10px;font-family:ui-monospace,monospace;font-weight:650;word-break:break-all">${e(skill.skillName)}</td>
      <td class="num" title="skill 调用段数：同一个 session 内多次触发同一个 skill，会累计为多次调用段。" style="padding:9px 10px;text-align:right;font-weight:700">${skill.invocationCount}<br><span style="color:var(--text-muted);font-size:10px;font-weight:400">调用段</span></td>
      <td class="num" title="需要优先打开看证据的 session 数" style="padding:9px 6px;text-align:right;color:var(--red);font-weight:650">${skill.reviewFirstSessionCount}</td>
      <td class="num" title="适合抽样确认的 session 数" style="padding:9px 6px;text-align:right;color:var(--yellow);font-weight:650">${skill.sampleReviewSessionCount}${sampleReviewCta ? `<br>${sampleReviewCta}` : ''}</td>
      <td data-no-rollup-click="1" style="padding:9px 10px;text-align:left">${renderSkillChainButton(skill.skillName, chainId)}${renderSkillChainSummary(skill.skillName)}</td>
      <td class="experience-evidence-cell" data-no-rollup-click="1" style="padding:8px 10px;color:var(--text-secondary);font-size:11px;line-height:1.45">
        ${renderSkillEvidenceSummary(skill)}
      </td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:11px;line-height:1.45">
        <div>入口：${e(entrypointText)}</div>
        <div>${e(originText)}</div>
        <div>触发判断：${e(attributionText)}</div>
        ${sourceMetadataHtml}
      </td>
      <td style="padding:9px 10px;color:var(--text-muted);font-size:12px">${e(skill.lastSeen.slice(0, 19).replace('T', ' '))}</td>
    </tr>
    <tr id="${e(chainId)}" data-context-chain-template style="display:none">
      <td colspan="8">${renderSkillChainTemplate(skill.skillName)}</td>
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
    const sessionOpenClawMetadata = renderSessionOpenClawSourceMetadata(session);
    const hasReviewerReport = Boolean(session.reviewerReport);
    return `<tr data-observe-experience-session data-experience-session-id="${e(session.id)}">
      <td style="padding:9px 10px">
        ${renderPriorityBadge(shownPriority)}
        <div style="margin-top:6px">${renderAssistiveInference(shownInference, true)}</div>
      </td>
      <td style="padding:9px 10px;font-family:ui-monospace,monospace;font-size:12px;color:var(--text-muted);word-break:break-all">${e(session.sessionId)}<br><span style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--accent)">入口：${e(formatEntrypoint(session.entrypoint))}</span><br><span style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--text-muted)">${e(sessionOriginText)}</span><br><span style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--text-muted)">${e(sessionAttributionText)}</span>${sessionOpenClawMetadata ? `<br>${sessionOpenClawMetadata}` : ''}</td>
      <td style="padding:9px 10px">${renderInvocationSummary(indicators, session.invocationIds.length)}</td>
      <td style="padding:9px 10px;color:var(--text-secondary);line-height:1.45">${renderSessionGoals(session.goalSliceIds)}</td>
      <td style="padding:9px 10px;color:var(--text-secondary);line-height:1.45">${renderReviewerOverview(session, detailId)}</td>
      <td style="padding:9px 10px">${renderRuleFindings(shownRuleFindings, true)}</td>
      <td style="padding:9px 10px;color:var(--text-secondary);font-size:12px;line-height:1.55">
        ${metric('纠正', indicators.userCorrectionCount, 'userCorrection', sessionMetricSourceTitle(session, 'user_correction', '纠正'))} ·
        ${metric('人工中断', indicators.userInterruptionCount, 'userInterruption', sessionMetricSourceTitle(session, 'user_interruption', '人工中断'))} ·
        ${metric('追问', indicators.userFollowUpCount, 'userFollowUp', sessionMetricSourceTitle(session, 'user_follow_up', '追问'))} ·
        ${metric('负向反馈', indicators.negativeFeedbackCount ?? 0, 'negativeFeedback', sessionMetricSourceTitle(session, 'negative_feedback', '负向反馈'))} ·
        ${metric('正向反馈', indicators.positiveFeedbackCount ?? 0, 'positiveFeedback', sessionMetricSourceTitle(session, 'positive_feedback', '正向反馈'))} ·
        ${metric('目标切换', indicators.userGoalShiftCount ?? 0, 'userGoalShift', sessionMetricSourceTitle(session, 'user_goal_shift', '目标切换'))}<br>
        ${metric('自我纠正', indicators.selfCorrectionCount ?? 0, 'selfCorrection')} ·
        ${metric('重复执行', indicators.repeatedExecutionCount ?? 0, 'repeatedExecution')} ·
        ${metric('工具执行失败', indicators.toolFailureCount, 'toolFailure')} ·
        ${metric('高优先级过程发现', indicators.highObservationCount, 'highObservation')}
      </td>
      <td class="session-time-cell" style="padding:9px 10px;color:var(--text-muted);font-size:12px;white-space:normal">
        <div>${e(formatTimeRange(session.sourceSessionStartTimestamp ?? session.startTimestamp, session.sourceSessionEndTimestamp ?? session.endTimestamp, session.sourceSessionDurationMs))}</div>
        <div style="margin-top:3px;color:var(--text-muted);font-size:11px">${e(invocationWindowLabel)}: ${e(formatTimeRange(session.startTimestamp, session.endTimestamp))}</div>
      </td>
      <td class="num" style="padding:9px 10px;text-align:right"><button type="button" data-open-experience-detail onclick="event.stopPropagation(); openExperienceDetailModal('${detailId}', this, 'evidence')" style="font-size:12px;padding:5px 10px;border:1px solid var(--border);background:var(--bg);border-radius:4px;cursor:pointer;white-space:nowrap">证据片段</button></td>
    </tr>
    <tr id="${detailId}" data-experience-detail-template style="display:none;background:var(--bg-muted)">
      <td colspan="9" style="padding:0;border-bottom:1px solid var(--border);text-align:left">
        <div class="experience-detail-shell">
        <div class="experience-detail-tabs" role="tablist" aria-label="Session 回溯视图">
          ${hasReviewerReport ? '<button type="button" class="experience-detail-tab-button is-active" role="tab" aria-selected="true" data-experience-detail-tab="reviewer" onclick="switchExperienceDetailTab(\'reviewer\')">复盘报告</button>' : ''}
          <button type="button" class="experience-detail-tab-button ${hasReviewerReport ? '' : 'is-active'}" role="tab" aria-selected="${hasReviewerReport ? 'false' : 'true'}" data-experience-detail-tab="evidence" onclick="switchExperienceDetailTab('evidence')">证据片段</button>
        </div>
        ${hasReviewerReport ? `<section class="experience-detail-tab-panel experience-detail-report-panel is-active" role="tabpanel" data-experience-detail-panel="reviewer">
          ${renderReviewerReport(session.reviewerReport)}
        </section>` : ''}
        <section class="experience-detail-tab-panel experience-detail-evidence-panel ${hasReviewerReport ? '' : 'is-active'}" role="tabpanel" data-experience-detail-panel="evidence">
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
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.55">
              <div>调用摘要：调用段 ${session.invocationIds.length} · 工具调用 ${indicators.toolCallCount} · 工具执行失败 ${indicators.toolFailureCount} · 人工中断 ${indicators.userInterruptionCount}</div>
              <div>复盘分数：${session.reviewPriorityScore}</div>
              <div>关联 invocation：${session.invocationIds.length}</div>
              <div>关联过程发现：${session.relatedObservationIds.length}</div>
              <div style="margin-top:8px">${renderExperienceBasis(shownBasisCodes)}</div>
            </div>
            ${renderJson({ id: session.id, sourceTrace: session.sourceTrace, sourceMetadata: session.sourceMetadata, cwd: session.cwd, sourceSessionStartTimestamp: session.sourceSessionStartTimestamp, sourceSessionEndTimestamp: session.sourceSessionEndTimestamp, sourceSessionDurationMs: session.sourceSessionDurationMs, invocationStartTimestamp: session.startTimestamp, invocationEndTimestamp: session.endTimestamp, sessionStory: session.sessionStory, evidenceChain, ruleFindings: shownRuleFindings, assistiveInference: shownInference, reviewerReport: sanitizeReviewerReportForDisplay(session.reviewerReport), reviewState: reviewState.entries[reviewStateKey('experience_session', session.id)], indicators, relatedObservationIds: session.relatedObservationIds })}
          </section>
          <section class="experience-detail-right">
            <h3 style="font-size:13px;margin:0 0 8px;color:var(--text-primary)">C1 上下文时间线片段</h3>
            ${renderTimelinePair(session)}
          </section>
        </div>
        </section>
        </div>
      </td>
    </tr>`;
  }).join('');
  void experienceSkillRows;
  // resolvedReviewSessions 在 ViewModel build 阶段已经按 session.id 预投影。
  // 这里只做查表,避免 render path 上对同一 session 反复 resolve。
  const inboxResolvedSession = (skill: ExperienceSessionSummary): ResolvedObservationReviewSession =>
    resolvedReviewSessions[skill.id];
  const inboxResolvedPriority = (skill: ExperienceSessionSummary): ExperienceReviewPriority =>
    resolvedReviewSessions[skill.id].priority;
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
    const earliestSessionStart = sessions.reduce((min, session) => {
      const value = session.sourceSessionStartTimestamp ?? session.startTimestamp;
      return value && value < min ? value : min;
    }, sessions[0]?.sourceSessionStartTimestamp ?? sessions[0]?.startTimestamp ?? '');
    const latestSessionEnd = sessions.reduce((max, session) => {
      const value = session.sourceSessionEndTimestamp ?? session.endTimestamp;
      return value && value > max ? value : max;
    }, sessions[0]?.sourceSessionEndTimestamp ?? sessions[0]?.endTimestamp ?? '');
    const reviewFirst = sessions.filter((session) => inboxResolvedPriority(session) === 'review_first').length;
    const sampleReview = sessions.filter((session) => inboxResolvedPriority(session) === 'sample_review').length;
    return `<details id="${e(experienceSkillAnchor(skillName))}" class="experience-session-group" open style="scroll-margin-top:16px">
      <summary>
        <div>
          <span class="experience-session-skill">${e(skillName)}</span>
          <span class="experience-session-meta">${sessions.length} sessions · ${e(sessionTimeLabel)} ${e(formatTimeRange(earliestSessionStart, latestSessionEnd))} · ${e(latestInvocationLabel)} ${e(formatTimestamp(latest))}</span>
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
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">报告总览</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">C2 规则判断</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">关键指标</th>
            <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--border)">${e(sessionTimeRangeLabel)}</th>
            <th style="text-align:right;padding:9px 10px;border-bottom:1px solid var(--border)">回溯</th>
          </tr></thead>
          <tbody>${renderExperienceSessionRows(sessions, `exp-skill-${groupIndex}`)}</tbody>
        </table>
      </div>
    </details>`;
  }).join('');
  void experienceSessionGroupsHtml;
  const experienceIndicators = experience?.sessions.reduce((acc, session) => {
    const indicators = displayIndicatorsForSession(session);
    return {
      toolCallCount: acc.toolCallCount + indicators.toolCallCount,
      toolFailureCount: acc.toolFailureCount + indicators.toolFailureCount,
      userInterruptionCount: acc.userInterruptionCount + indicators.userInterruptionCount,
    };
  }, { toolCallCount: 0, toolFailureCount: 0, userInterruptionCount: 0 }) ?? { toolCallCount: 0, toolFailureCount: 0, userInterruptionCount: 0 };
  const experienceToolSuccessCount = Math.max(0, experienceIndicators.toolCallCount - experienceIndicators.toolFailureCount);
  void experienceToolSuccessCount;
  const experienceReviewSkillCount = experience?.skills.filter((skill) => skill.reviewFirstSessionCount + skill.sampleReviewSessionCount > 0).length ?? 0;
  void experienceReviewSkillCount;
  const experienceReviewSessionCount = experience?.sessions.filter((session) => inboxResolvedPriority(session) !== 'routine_sample').length ?? 0;
  void experienceReviewSessionCount;
  const experienceReviewFirstSessionCount = experience?.sessions.filter((session) => inboxResolvedPriority(session) === 'review_first').length ?? 0;
  const experienceSampleReviewSessionCount = experience?.sessions.filter((session) => inboxResolvedPriority(session) === 'sample_review').length ?? 0;
  const experienceHardRuleCount = experience?.sessions.reduce((sum, session) =>
    sum + (displayIndicatorsForSession(session).hardRuleTextHitCount ?? 0), 0
  ) ?? 0;
  const experienceFirstHardRuleSession = experience?.sessions.find((session) =>
    (displayIndicatorsForSession(session).hardRuleTextHitCount ?? 0) > 0
  );
  const experienceFirstReviewSession = experienceFirstHardRuleSession
    ?? experience?.sessions.find((session) => displayPriority(displayIndicatorsForSession(session)) !== 'routine_sample');
  const experienceInsightText = experienceReviewFirstSessionCount > 0
    ? `这次 trace 有 ${experienceReviewFirstSessionCount} 个优先复盘 session，建议先看异常证据。`
    : experienceHardRuleCount > 0
      ? `这次 trace 整体未发现明显高风险异常，但有 ${experienceHardRuleCount} 条用户硬性要求值得抽样确认。`
      : experienceSampleReviewSessionCount > 0
        ? `这次 trace 整体未发现明显高风险异常，有 ${experienceSampleReviewSessionCount} 个 session 建议抽样确认。`
        : '这次 trace 未发现明显高风险异常，可以常规抽样。';
  const experienceInsightCta = experienceFirstReviewSession
    ? `<button type="button" class="experience-insight-cta" data-open-experience-session="${e(experienceFirstReviewSession.id)}" data-open-timeline-tag="${experienceFirstHardRuleSession ? 'hard_rule' : ''}">${experienceFirstHardRuleSession ? '看这条用户硬性要求是什么' : '打开建议复盘 session'}</button>`
    : '';
  const reportSessionRanges = reports.flatMap((report) => report.meta.sessionTimeRanges ?? []);
  const reportSessionCount = reportSessionRanges.length > 0
    ? new Set(reportSessionRanges.map((range) => `${range.sessionId}\u0000${range.sourceTrace}`)).size
    : (experience?.meta.sessionCount ?? 0);
  const reportSessionStarts = reportSessionRanges.map((range) => range.startTimestamp).filter((value): value is string => Boolean(value));
  const reportSessionEnds = reportSessionRanges.map((range) => range.endTimestamp).filter((value): value is string => Boolean(value));
  const reportSessionFrom = reportSessionStarts.length > 0 ? reportSessionStarts.reduce((min, value) => value < min ? value : min, reportSessionStarts[0]) : undefined;
  const reportSessionTo = reportSessionEnds.length > 0 ? reportSessionEnds.reduce((max, value) => value > max ? value : max, reportSessionEnds[0]) : undefined;
  const reportSessionDurationMs = durationMsBetween(reportSessionFrom, reportSessionTo);
  const reportSessionRangeLabel = reportSessionFrom || reportSessionTo
    ? formatTimeRange(reportSessionFrom, reportSessionTo, reportSessionDurationMs)
    : '—';
  const experienceTopInsightHtml = experience
    ? `<div class="experience-top-insight">
        <div>
          <strong>复盘建议</strong>
          <span>${e(experienceInsightText)}</span>
        </div>
        ${experienceInsightCta}
      </div>`
    : '';
  void experienceTopInsightHtml;
	  const inboxSessions = (experience?.sessions ?? []).slice();
	  const inboxSiblingsMap = new Map<string, ExperienceSessionSummary[]>();
	  for (const skill of inboxSessions) {
	    const arr = inboxSiblingsMap.get(skill.sessionId) ?? [];
	    arr.push(skill);
	    inboxSiblingsMap.set(skill.sessionId, arr);
	  }
	  for (const arr of inboxSiblingsMap.values()) {
	    arr.sort((a, b) => a.startTimestamp.localeCompare(b.startTimestamp));
	  }
	  type InboxSkillCard = {
	    skillName: string;
	    sessions: ExperienceSessionSummary[];
	    priority: ExperienceReviewPriority;
	    latestEnd: string;
	  };
	  const inboxSkillsMap = new Map<string, ExperienceSessionSummary[]>();
	  for (const s of inboxSessions) {
	    const arr = inboxSkillsMap.get(s.skillName) ?? [];
	    arr.push(s);
	    inboxSkillsMap.set(s.skillName, arr);
	  }
	  const inboxPriorityRank = (priority: ExperienceReviewPriority): number => priority === 'review_first' ? 0 : priority === 'sample_review' ? 1 : 2;
	  const inboxSkillCards: InboxSkillCard[] = Array.from(inboxSkillsMap.entries()).map(([skillName, sessions]) => {
	    sessions.sort((a, b) => b.endTimestamp.localeCompare(a.endTimestamp));
	    const priority = sessions.find((s) => inboxResolvedPriority(s) === 'review_first')
	      ? 'review_first'
	      : sessions.find((s) => inboxResolvedPriority(s) === 'sample_review')
	        ? 'sample_review'
	        : 'routine_sample';
	    const latestEnd = sessions.reduce((latest, s) => s.endTimestamp > latest ? s.endTimestamp : latest, '');
	    return { skillName, sessions, priority, latestEnd };
	  });
	  inboxSkillCards.sort((a, b) => inboxPriorityRank(a.priority) - inboxPriorityRank(b.priority) || b.latestEnd.localeCompare(a.latestEnd) || a.skillName.localeCompare(b.skillName));
	  const inboxSkillCardReviewed = (card: InboxSkillCard): boolean =>
	    card.sessions.every((s) => Boolean(reviewState.entries[`experience_session:${s.id}`]));
	  const inboxReviewFirstCount = inboxSkillCards.filter((c) => c.priority === 'review_first').length;
	  const inboxSampleCount = inboxSkillCards.filter((c) => c.priority === 'sample_review').length;
	  const inboxReviewedCount = inboxSkillCards.filter(inboxSkillCardReviewed).length;
	  const inboxTotalCount = inboxSkillCards.length;
	  const inboxFormatDuration = (ms?: number): string => {
	    if (!ms || ms <= 0) return '—';
	    const totalSec = Math.round(ms / 1000);
	    if (totalSec < 60) return `${totalSec} 秒`;
	    const min = Math.floor(totalSec / 60);
	    const sec = totalSec % 60;
	    if (min < 60) return sec > 0 ? `${min} 分 ${sec} 秒` : `${min} 分钟`;
	    const hour = Math.floor(min / 60);
	    return `${hour} 小时 ${min % 60} 分`;
	  };
	  const inboxTopSession = (card: InboxSkillCard): ExperienceSessionSummary | undefined =>
	    card.sessions.find((s) => inboxResolvedPriority(s) === 'review_first')
	    ?? card.sessions.find((s) => inboxResolvedPriority(s) === 'sample_review')
	    ?? card.sessions[0];
	  const inboxSkillGoalLine = (card: InboxSkillCard): string => {
	    const storyGoal = card.sessions.flatMap((s) => s.sessionStory?.goalSlices ?? [])
	      .find((goal) => inboxCleanSnippet(goal.inferredUserGoal));
	    const directGoal = card.sessions.find((s) => inboxCleanSnippet(s.evidenceChain.firstUserMessage?.snippet))?.evidenceChain.firstUserMessage?.snippet;
	    const llmGoal = inboxLlmEnhancedGoalKeywords(card.skillName);
	    const goal = inboxExtractKeyword(storyGoal?.inferredUserGoal ?? directGoal ?? llmGoal, 48);
	    return goal ? `用户目标：${goal}` : '用户目标：未提取';
	  };
	  const inboxSkillMainline = (card: InboxSkillCard): string => {
	    const story = card.sessions.find((s) => s.sessionStory?.skillLinks?.length)?.sessionStory;
	    const links = story?.skillLinks ?? card.sessions.map((s) => ({
	      skillName: s.skillName,
	      role: 'executor' as const,
	    }));
	    const currentLink = links.find((link) => link.skillName === card.skillName);
	    const roleText = currentLink ? inboxSkillRoleLabel(currentLink.role) : '执行';
	    const chain = links
	      .slice(0, 5)
	      .map((link) => `${link.skillName}〔${inboxSkillRoleLabel(link.role)}〕`)
	      .join(' → ');
	    const delivery = story?.finalDeliverySignalCount && story.finalDeliverySignalCount > 0 ? ' → 有结果' : '';
	    return chain ? `${card.skillName}〔${roleText}〕 · 主线：用户目标 → ${chain}${delivery}` : `${card.skillName}〔${roleText}〕 · 未提取到明确执行主线`;
	  };
	  const inboxCardStatus = (card: InboxSkillCard): string => {
	    // 多 session 聚合: 取 goal_satisfaction 中最严重的 status
	    // 优先级: degraded > attention > unknown > ok / not_applicable
	    const goalStatuses = card.sessions
	      .map((s) => s.sessionStory?.answers?.find((a) => a.key === 'goal_satisfaction')?.status)
	      .filter((status): status is ExperienceSessionStoryAnswer['status'] => Boolean(status));
	    if (goalStatuses.includes('degraded')) return '数据有问题';
	    if (goalStatuses.includes('attention')) return '要看一眼';
	    if (goalStatuses.includes('unknown')) return '信息不够';
	    // 全 ok 或 not_applicable: 不输出文案
	    return '';
	  };
	  const inboxAttentionFindingLabelByRuleSource: Record<string, string> = {
	    final_delivery_absent: '没给最终答复',
	    router_user_facing_closure_absent: '下游结果未回传',
	    tool_error_recovery: '工具调用失败',
	    tool_failure_seen: '工具调用失败',
	    session_interrupted: '会话异常断开',
	    session_interrupted_seen: '会话异常断开',
	    expected_tools_missed: '没用上核心工具',
	    user_correction: '用户纠正',
	    user_correction_seen: '用户纠正',
	    user_interruption: '用户手动叫停',
	    user_interruption_seen: '用户手动叫停',
	    negative_feedback: '用户不满',
	    negative_feedback_seen: '用户不满',
	    complex_scope_degraded: '复杂链路',
	  };
	  const inboxAttentionFindingLabel = (ruleSource: string): string =>
	    inboxAttentionFindingLabelByRuleSource[ruleSource] ?? ruleSource;
	  const inboxSessionAttentionFindingLabels = (session: ExperienceSessionSummary): string[] => {
	    const labels: string[] = [];
	    const push = (label: string): void => {
	      if (label && !labels.includes(label)) labels.push(label);
	    };
	    for (const finding of session.reviewerReport?.findings ?? []) {
	      if (finding.level !== 'attention') continue;
	      push(inboxAttentionFindingLabel(finding.ruleSource));
	    }
	    const indicators = displayIndicatorsForSession(session);
	    if (indicators.toolFailureCount > 0) push(inboxAttentionFindingLabel('tool_error_recovery'));
	    if (indicators.userCorrectionCount > 0) push(inboxAttentionFindingLabel('user_correction'));
	    if (indicators.userInterruptionCount > 0) push(inboxAttentionFindingLabel('user_interruption'));
	    if (indicators.sessionInterruptedCount > 0) push(inboxAttentionFindingLabel('session_interrupted'));
	    if (indicators.negativeFeedbackCount > 0) push(inboxAttentionFindingLabel('negative_feedback'));
	    return labels;
	  };
	  const inboxFindingChips = (card: InboxSkillCard): string => {
	    const totalSessions = card.sessions.length;
	    // 多 session 聚合: 按 ruleSource 统计「N/M session 命中」, chip 文案用中性短标签
	    const byRule = new Map<string, { hit: number; body: string }>();
	    for (const session of card.sessions) {
	      const seenInSession = new Set<string>();
	      for (const finding of session.reviewerReport?.findings ?? []) {
	        if (finding.level !== 'attention') continue;
	        if (seenInSession.has(finding.ruleSource)) continue;
	        seenInSession.add(finding.ruleSource);
	        const entry = byRule.get(finding.ruleSource);
	        if (entry) entry.hit += 1;
	        else byRule.set(finding.ruleSource, { hit: 1, body: finding.body });
	      }
	    }
	    if (byRule.size === 0) return '';
	    const sorted = [...byRule.entries()].sort((a, b) => b[1].hit - a[1].hit).slice(0, 3);
	    return `<div class="inbox-card-chips">${sorted.map(([ruleSource, { hit, body }]) => {
	      const label = inboxAttentionFindingLabel(ruleSource);
	      return `<span class="inbox-card-chip is-attention" title="${e(body)}">${hit}/${totalSessions} · ${e(label)}</span>`;
	    }).join('')}</div>`;
	  };
	  const inboxReviewBadge = (card: InboxSkillCard): string => {
	    const verdicts: string[] = [];
	    for (const s of card.sessions) {
	      const v = reviewState.entries[`experience_session:${s.id}`]?.verdict;
	      if (v) verdicts.push(v);
	    }
	    if (verdicts.length === 0) return '';
	    const total = card.sessions.length;
	    if (verdicts.length < total) return `<span class="inbox-card-state is-reviewed">已标注 ${verdicts.length}/${total}</span>`;
	    if (verdicts.every((v) => v === 'real_issue')) return `<span class="inbox-card-state is-agree">已同意</span>`;
	    if (verdicts.every((v) => v === 'not_issue')) return `<span class="inbox-card-state is-reject">已否决</span>`;
	    if (verdicts.every((v) => v === 'needs_more_context')) return `<span class="inbox-card-state is-note">留意见</span>`;
	    return `<span class="inbox-card-state is-reviewed">已处理</span>`;
	  };
	  const inboxPriorityClass = (card: InboxSkillCard): string => {
	    if (card.priority === 'review_first') return 'is-priority-high';
	    if (card.priority === 'sample_review') return 'is-priority-medium';
	    return 'is-priority-low';
	  };
	  const inboxEntrypointShort = (session: ExperienceSessionSummary): string => formatEntrypoint(session.entrypoint) || '未记录';
	  const inboxFormatSessionLabel = (session: ExperienceSessionSummary): string => {
	    const time = session.endTimestamp ? session.endTimestamp.slice(0, 16).replace('T', ' ') : '';
	    const entrypoint = inboxEntrypointShort(session);
	    const sessionShort = session.sessionId.length > 10 ? `${session.sessionId.slice(0, 8)}…` : session.sessionId;
	    return [`Session ${sessionShort}`, entrypoint !== '未记录' ? entrypoint : '', time].filter(Boolean).join(' · ') || 'Session 调用记录';
	  };
	  const inboxSessionSearchText = (session: ExperienceSessionSummary): string => [
	    session.id,
	    session.sessionId,
	    session.skillName,
	    session.sourceTrace,
	    session.sourceKind,
	    session.entrypoint,
	    session.cwd,
	    session.startTimestamp,
	    session.endTimestamp,
	    session.sourceSessionStartTimestamp,
	    session.sourceSessionEndTimestamp,
	    session.evidenceChain.firstUserMessage?.snippet,
	    session.reviewerReport?.title,
	    session.sessionStory?.summary,
	    ...(session.sessionStory?.goalSlices ?? []).map((goal) => goal.inferredUserGoal ?? ''),
	  ].filter(Boolean).join(' ');
	  const inboxCard = (card: InboxSkillCard, index: number): string => {
	    const filters: string[] = [card.priority, 'all'];
	    if (inboxSkillCardReviewed(card)) filters.push('reviewed');
	    const topSession = inboxTopSession(card);
	    const duration = inboxFormatDuration(topSession?.sourceSessionDurationMs);
	    const entrypoint = topSession ? inboxEntrypointShort(topSession) : '未记录';
	    const sessionCountChip = card.sessions.length > 1 ? `<span title="${card.skillName} 有 ${card.sessions.length} 次调用记录">${card.sessions.length} 次调用</span>` : '';
	    const goalLine = inboxSkillGoalLine(card);
	    const mainline = inboxSkillMainline(card);
	    const skillSearchText = [card.skillName, goalLine, mainline, inboxCardStatus(card)].join(' ');
	    const sessionSearchText = card.sessions.map(inboxSessionSearchText).join(' ');
	    return `<li class="inbox-card ${inboxPriorityClass(card)} ${index === 0 ? 'is-active' : ''}" data-inbox-card="${e(card.skillName)}" data-inbox-filters="${e(filters.join(' '))}" data-inbox-skill-search="${e(skillSearchText)}" data-inbox-session-search="${e(sessionSearchText)}" onclick="selectInboxCard('${e(card.skillName)}', this)">
	      <div class="inbox-card-row inbox-card-row-title">
	        <span class="inbox-card-priority"></span>
	        <span class="inbox-card-title" title="${e(card.skillName)}">${e(card.skillName)}</span>
	        ${inboxReviewBadge(card)}
	      </div>
	      <div class="inbox-card-goal" title="${e(goalLine)}">${e(goalLine)}</div>
	      <div class="inbox-card-story" title="${e(mainline)}">${e(mainline)}</div>
	      ${inboxFindingChips(card)}
	      <div class="inbox-card-row inbox-card-meta">
	        <span title="这条 session 的执行时长">执行 ${e(duration)}</span>
	        <span title="入口来源">入口 ${e(entrypoint)}</span>
	        ${sessionCountChip}
	      </div>
	    </li>`;
	  };
	  const inboxStatusBadge = (status: ExperienceSessionStoryAnswer['status']): string => {
	    if (status === 'degraded') return '<span class="inbox-answer-status is-degraded">数据有问题</span>';
	    if (status === 'attention') return '<span class="inbox-answer-status is-attention">要看一眼</span>';
	    if (status === 'unknown') return '<span class="inbox-answer-status is-unknown">信息不够</span>';
	    if (status === 'not_applicable') return '<span class="inbox-answer-status is-not-applicable">不适用</span>';
	    return '<span class="inbox-answer-status is-ok">看起来正常</span>';
	  };
	  const inboxSkillRoleLabel = (role: 'router' | 'executor' | 'mixed' | 'unknown'): string => {
	    if (role === 'router') return '路由';
	    if (role === 'executor') return '执行';
	    if (role === 'mixed') return '路由+执行';
	    return '未确定';
	  };
	  const inboxLlmSkillTypeLabel = (type?: ResolvedObservationReviewSession['skillType']): string => {
	    if (type === 'router') return '路由型';
	    if (type === 'delegation') return '委派型';
	    if (type === 'executor') return '执行型';
	    if (type === 'advisory') return '咨询型';
	    if (type === 'workflow_owner') return '流程负责型';
	    return '类型待确认';
	  };
    const inboxSkillTypeSourceText = (resolved: ResolvedObservationReviewSession): string => {
      if (resolved.skillTypeSource === 'frontmatter') return '作者声明';
      if (resolved.skillTypeSource === 'llm') return '模型识别';
      if (resolved.skillTypeSource === 'trace') return '规则推断';
      return '建议声明';
    };
	  const inboxSkillRoleHelpKey = (role: 'router' | 'executor' | 'mixed' | 'unknown'): IndicatorHelpKey => {
	    if (role === 'router') return 'skillRoleRouter';
	    if (role === 'executor') return 'skillRoleExecutor';
	    if (role === 'mixed') return 'skillRoleMixed';
	    return 'skillRoleUnknown';
	  };
	  const inboxLlmSkillTypeHelpKey = (type?: ResolvedObservationReviewSession['skillType']): IndicatorHelpKey => {
	    if (type === 'router') return 'llmSkillTypeRouter';
	    if (type === 'delegation') return 'llmSkillTypeDelegation';
	    if (type === 'executor') return 'llmSkillTypeExecutor';
	    if (type === 'advisory') return 'llmSkillTypeAdvisory';
	    if (type === 'workflow_owner') return 'llmSkillTypeWorkflowOwner';
	    return 'llmSkillTypeUnknown';
	  };
	  const inboxSkillTypeBadge = (label: string, helpKey: IndicatorHelpKey, sourceText?: string): string =>
	    `<button type="button" class="inbox-skill-type-badge" data-metric-key="${helpKey}" onclick="event.stopPropagation();openMetricGuide('${helpKey}')" title="点击查看 skill 类型说明">skill 类型：${e(label)}${sourceText ? ` · ${e(sourceText)}` : ''}</button>`;
	  const inboxFlowItem = (cardSkillName: string, skill: ExperienceSessionSummary, index: number, isCurrent: boolean): string => {
	    const link = skill.sessionStory?.skillLinks?.find((l) => l.skillName === skill.skillName);
	    const roleLabel = link ? inboxSkillRoleLabel(link.role) : '执行';
	    const roleHelpKey = inboxSkillRoleHelpKey(link?.role ?? 'executor');
	    const indicators = displayIndicatorsForSession(skill);
	    const dur = formatTimeRange(skill.startTimestamp, skill.endTimestamp);
	    const startTime = skill.startTimestamp ? skill.startTimestamp.slice(5, 16).replace('T', ' ') : '未记录';
	    const resolvedPriority = inboxResolvedPriority(skill);
	    const priorityLabel = resolvedPriority === 'review_first' ? '要看一眼' : resolvedPriority === 'sample_review' ? '抽样' : '常规';
	    const priorityCls = resolvedPriority === 'review_first' ? 'is-priority-high' : resolvedPriority === 'sample_review' ? 'is-priority-medium' : 'is-priority-low';
	    const currentCls = isCurrent ? 'is-current' : '';
	    const tag = isCurrent ? '<span class="inbox-flow-current-tag">当前查看</span>' : '';
	    const sameSkill = skill.skillName === cardSkillName;
	    const jumpAction = sameSkill
	      ? `selectInboxSessionTab('${e(cardSkillName)}', '${e(skill.id)}')`
	      : `selectInboxCardById('${e(skill.skillName)}', '${e(skill.id)}')`;
	    const jumpAttrs = isCurrent ? '' : ` data-inbox-jump-card="${e(sameSkill ? skill.id : skill.skillName)}"`;
	    return `<li class="inbox-flow-item ${priorityCls} ${currentCls}">
	      <div class="inbox-flow-time">${e(startTime)}</div>
	      <div class="inbox-flow-rail"><span class="inbox-flow-index">${index + 1}</span></div>
	      <div class="inbox-flow-anchor"${jumpAttrs}${!isCurrent ? ` onclick="${jumpAction}"` : ''} role="button" title="${isCurrent ? '当前查看的调用段' : '点击切换到这个调用段'}">
	        <div class="inbox-flow-body">
	          <div class="inbox-flow-title"><strong>${e(skill.skillName)}</strong>${inboxSkillTypeBadge(roleLabel, roleHelpKey)}<span class="inbox-flow-priority">${priorityLabel}</span>${tag}</div>
	          <div class="inbox-flow-meta">
	            <span>调用段 ${skill.invocationIds.length}</span>
	            <span>工具 ${indicators.toolCallCount}</span>
	            <span>失败 ${indicators.toolFailureCount}</span>
	          </div>
	          <div class="inbox-flow-range">${e(dur)}</div>
	        </div>
	      </div>
	    </li>`;
	  };
	  const inboxRenderSessionFlow = (cardSkillName: string, session: ExperienceSessionSummary, siblings: ExperienceSessionSummary[], summaryText: string): string => {
	    const goalSlices = session.sessionStory?.goalSlices ?? [];
	    const dispatches = session.sessionStory?.subagentDispatches ?? [];
	    const siblingHint = siblings.length > 1 ? `<span class="inbox-section-hint">本 session 共 ${siblings.length} 个能力调用段，下面高亮当前 ${e(session.skillName)}</span>` : '<span class="inbox-section-hint">这条 session 只触发了当前能力</span>';
	    return `<div class="inbox-flow-popover-content">
	      <header class="inbox-flow-popover-head">
	        <strong>Session 执行过程</strong>
	        <span class="inbox-section-summary is-neutral">${e(summaryText)}</span>
	        ${siblingHint}
	      </header>
	      <div class="inbox-flow-popover-body">
	        <ol class="inbox-flow-list inbox-flow-timeline">${siblings.map((sib, index) => inboxFlowItem(cardSkillName, sib, index, sib.id === session.id)).join('')}</ol>
	        ${goalSlices.length > 0 ? `<div class="inbox-flow-slices"><h4>用户目标段</h4>${goalSlices.map((goal) => `<div class="inbox-flow-slice"><strong>目标段 ${goal.order}</strong><span>${e(goal.skillNames.join('、') || '未记录能力')}</span><p>${e(goal.inferredUserGoal ?? (inboxLlmEnhancedGoalKeywords(goal.skillNames[0] ?? session.skillName) || '未提取到明确用户目标'))}</p></div>`).join('')}</div>` : ''}
	        ${dispatches.length > 0 ? `<div class="inbox-flow-dispatches"><h4>子任务分支</h4>${dispatches.map((d) => `<div class="inbox-flow-dispatch"><strong>分支 ${d.order}：${e(d.label)}</strong><span>${d.eventCount} 条事件${d.attachTo?.messageIndex !== undefined ? ` · 挂接 #${d.attachTo.messageIndex}` : ''}</span></div>`).join('')}</div>` : ''}
	      </div>
	    </div>`;
	  };
	  const inboxAnswerEvidenceButtons = (refs: ExperienceEvidenceRef[]): string => {
	    if (!refs || refs.length === 0) return '';
	    const ref = refs[0];
	    const kindLabel = ({
	      user_message: '用户消息',
	      assistant_message: '助手回复',
	      tool_use: '工具调用',
	      tool_result: '工具结果',
	      skill_context: '能力说明',
	      runtime_context: '运行注入',
	      observation: '过程发现',
	    } as Record<string, string>)[ref.kind] ?? ref.kind;
	    return `<div class="inbox-answer-evidence"><button type="button" class="inbox-answer-evidence-link" data-jump-message-index="${ref.messageIndex ?? ''}" data-jump-message-uuid="${e(ref.messageUuid ?? '')}" onclick="inboxJumpToEvidence(this)" title="定位到消息 #${e(String(ref.messageIndex ?? '-'))} · ${e(kindLabel)}">跳转原文</button></div>`;
	  };
	  const inboxPlaceholderRe = /^\s*(?:NO_REPLY(?:_NEEDED)?|END_OF_REPLY|::FORWARD-?OK::|NO_OP|NULL|UNDEFINED|\.\.\.|—|--)\s*$/i;
	  const inboxCronPromptRe = /^\s*\[cron:[^\]]+\]\s*/i;
	  const inboxCleanSnippet = (text?: string): string => {
	    if (!text) return '';
	    let cleaned = text.replace(/\s+/g, ' ').trim();
	    cleaned = cleaned.replace(inboxCronPromptRe, '');
	    if (inboxPlaceholderRe.test(cleaned)) return '';
	    return cleaned;
	  };
	  const inboxExtractKeyword = (text?: string, max = 36): string => {
	    const cleaned = inboxCleanSnippet(text);
	    if (!cleaned) return '';
	    if (cleaned.length <= max) return cleaned;
	    return `${cleaned.slice(0, max)}…`;
	  };
	  const inboxExtractGoalKeywords = (text?: string): string => {
	    const cleaned = inboxCleanSnippet(text);
	    if (!cleaned) return '';
	    const withoutTags = cleaned
	      .replace(/<command-name>([^<]+)<\/command-name>/gi, ' $1 ')
	      .replace(/<[^>]+>/g, ' ')
	      .replace(/[“”"']/g, ' ')
	      .replace(/\s+/g, ' ')
	      .trim();
	    const candidates: string[] = [];
	    const push = (value?: string): void => {
	      const normalized = (value ?? '').replace(/^[\s:：/]+|[\s:：/。！？,，；;]+$/g, '').trim();
	      if (!normalized || normalized.length < 2) return;
	      if (['这个', '这里', '内容', '当前', '现在', '一下', '能力', '文档', '代码', '需求'].includes(normalized)) return;
	      if (!candidates.includes(normalized)) candidates.push(normalized);
	    };
	    const generationTarget = withoutTags.match(/(?:重新|再次|继续)?\s*(?:生成|创建|写|产出|实现|做|搭建)\s*([A-Za-z0-9_-]*demo|DEMO|Demo|[\u4e00-\u9fa5A-Za-z0-9_-]{2,18}(?:页面|报告|文档|方案|代码|原型|Demo|demo))/i);
	    if (generationTarget) {
	      const target = generationTarget[1].replace(/^一个|^一份|^这个/, '').trim();
	      push(/demo/i.test(target) ? 'Demo生成' : `${target}生成`);
	    }
	    if (/prd|产品需求文档/i.test(withoutTags)) {
	      push(/生成|创建|写|产出|create/i.test(withoutTags) ? 'PRD生成' : 'PRD');
	    }
	    const objectPatterns = [
	      /([\u4e00-\u9fa5A-Za-z0-9_-]{2,18})的(评价|评论|复盘|报告|方案|文档|脚本)/g,
	      /(评价|评论|复盘|review|检查|查看|修改|优化)\s*([\u4e00-\u9fa5A-Za-z0-9_-]{2,18})/gi,
	      /(run-[A-Za-z0-9_-]+|[A-Za-z0-9_-]+\.sh|PR\s*\d+|PRD|session|skill)/gi,
	    ];
	    for (const pattern of objectPatterns) {
	      let match: RegExpExecArray | null;
	      while ((match = pattern.exec(withoutTags))) {
	        if (match.length >= 3) {
	          push(match[1].length <= match[2].length ? `${match[2]}${match[1]}` : `${match[1]}${match[2]}`);
	        } else {
	          push(match[1]);
	        }
	        if (candidates.length >= 2) break;
	      }
	      if (candidates.length >= 2) break;
	    }
	    if (candidates.length === 0) {
	      if (/调用\s*skill|使用\s*skill|skill/i.test(withoutTags)) push('skill调用');
	      else if (/review|评审|评价|复盘|检查/i.test(withoutTags)) push('review');
	      else if (/写代码|代码|实现|修复|开发|code/i.test(withoutTags)) push('代码修改');
	      else if (/看文档|文档|阅读|查看文档|doc/i.test(withoutTags)) push('文档查看');
	      else if (/需求|requirement/i.test(withoutTags)) push('需求分析');
	    }
	    return candidates.slice(0, 2).join(' / ');
	  };
	  const inboxLlmEnhancedGoalKeywords = (skillName: string): string => {
	    const goal = skillDerivedStandards[skillName]?.enhancedReview?.userGoal;
	    const slots = (goal?.slots ?? [])
	      .map((slot) => inboxExtractKeyword(slot, 18))
	      .filter((slot): slot is string => Boolean(slot));
	    if (slots.length > 0) return slots.slice(0, 3).join(' / ');
	    return inboxExtractGoalKeywords(goal?.summary) || inboxExtractKeyword(goal?.expectedOutcome, 36);
	  };
	  // eslint-disable-next-line @typescript-eslint/no-unused-vars
	  const inboxLlmEnhancedDeclaredGoalKeywords = (skillName: string): string => {
	    const goal = skillDerivedStandards[skillName]?.enhancedReview?.skillDeclaredGoal;
	    const keywords = [
	      ...(goal?.keywords ?? []),
	      ...(goal?.expectedOutcomes ?? []),
	    ]
	      .map((keyword) => inboxExtractKeyword(keyword, 18))
	      .filter((keyword): keyword is string => Boolean(keyword));
	    if (keywords.length > 0) return Array.from(new Set(keywords)).slice(0, 4).join(' / ');
	    return inboxExtractGoalKeywords(goal?.summary);
	  };
	  const inboxExtractCompletionKeywords = (text?: string): string => {
	    const cleaned = inboxCleanSnippet(text);
	    if (!cleaned) return '';
	    const candidates: string[] = [];
	    const push = (value: string): void => {
	      if (!candidates.includes(value)) candidates.push(value);
	    };
	    if (/已完成|完成|最终结果|完整结果|结果如下|报告如下/i.test(cleaned)) push('任务完成');
	    if (/已生成|生成如下|直接生成/i.test(cleaned)) push('已生成');
	    if (/已保存|已写入|已创建/i.test(cleaned)) push('已保存');
	    if (/方案路径|产物路径|文档路径|结果文件|输出路径/i.test(cleaned)) push('结果路径');
	    if (/代码|```|tsx?|jsx?|html|css/i.test(cleaned)) push('代码结果');
	    if (/报告|文档|方案/i.test(cleaned)) push('文档结果');
	    return candidates.slice(0, 3).join(' / ') || '未识别到明确完成结果';
	  };
	  const inboxExtractArtifactKeywords = (text?: string): string => {
	    const cleaned = inboxCleanSnippet(text);
	    if (!cleaned) return '';
	    const candidates: string[] = [];
	    const push = (value: string): void => {
	      if (!candidates.includes(value)) candidates.push(value);
	    };
	    const pathMatches = cleaned.match(/(?:\/[\w.-]+){2,}\.(?:md|html|tsx?|jsx?|json|png|jpe?g|pdf|docx?|pptx?|xlsx?|csv)\b|[\w.-]+\.(?:md|html|tsx?|jsx?|json|png|jpe?g|pdf|docx?|pptx?|xlsx?|csv)\b/gi) ?? [];
	    for (const path of pathMatches.slice(0, 2)) push(path);
	    if (/https?:\/\/\S+/i.test(cleaned)) push('链接');
	    if (/```(?:tsx?|jsx?|html|css|json|markdown)?/i.test(cleaned)) push('代码块');
	    if (/\.(?:png|jpe?g)\b|图片|截图/i.test(cleaned)) push('图片');
	    if (/\.(?:md|pdf|docx?)\b|文档|报告|方案/i.test(cleaned)) push('文档');
	    if (/\.(?:html|tsx?|jsx?)\b|demo|Demo|预览|页面/i.test(cleaned)) push('页面/Demo');
	    if (/\.(?:xlsx?|csv)\b|表格/i.test(cleaned)) push('表格');
	    if (/dashboard|看板/i.test(cleaned)) push('看板');
	    return candidates.slice(0, 3).join(' / ') || '未识别到明确产物';
	  };
	  type ManualCorrectionTarget =
	    | 'goal_keyword_correction'
	    | 'result_artifact_correction'
	    | 'completion_result_correction'
	    | 'deliverable_artifact_correction'
	    | 'skill_relevance_correction'
	    | 'workflow_completion_correction'
	    | 'hardrule_execution_correction'
	    | 'main_tool_execution_correction';
	  type ManualCorrectionOption = { value: string; label: string };
	  const manualCorrectionLabel = (raw?: string): string => {
	    if (!raw) return '';
	    try {
	      const parsed = JSON.parse(raw) as { label?: unknown; value?: unknown };
	      if (typeof parsed.label === 'string' && parsed.label.trim()) return parsed.label;
	      if (typeof parsed.value === 'string' && parsed.value.trim()) return parsed.value;
	    } catch {
	      return raw;
	    }
	    return raw;
	  };
	  const manualCorrectionEntry = (targetType: ManualCorrectionTarget, targetId: string) =>
	    reviewState.entries[reviewStateKey(targetType, targetId)];
	  const renderManualCorrectionButton = (
	    targetType: ManualCorrectionTarget,
	    targetId: string,
	    label: string,
	    options: ManualCorrectionOption[],
	    kind: 'choice' | 'text' = 'choice',
	  ): string => {
	    const entry = manualCorrectionEntry(targetType, targetId);
	    const current = manualCorrectionLabel(entry?.note);
	    const optionsJson = e(JSON.stringify(options));
	    return `<button type="button"
	      class="manual-correction-button ${current ? 'is-marked' : ''}"
	      data-manual-correction-key="${e(reviewStateKey(targetType, targetId))}"
	      data-manual-correction-target-type="${e(targetType)}"
	      data-manual-correction-target-id="${e(targetId)}"
	      data-manual-correction-kind="${e(kind)}"
	      data-manual-correction-label="${e(label)}"
	      data-manual-correction-current="${e(current)}"
	      data-manual-correction-options="${optionsJson}"
	      onclick="openManualCorrection(this)"
	      title="人工纠正会写入 review-state.json，不修改原始 trace">${e(label)}${current ? `：${e(current)}` : ''}</button>`;
	  };
	  const inboxManualCorrectionControls = (skill: ExperienceSessionSummary, answerKey: string): string => {
	    const baseId = skill.id;
	    const completionResultOptions = [
	      { value: 'completed', label: '有完成反馈' },
	      { value: 'result_feedback', label: '有结果反馈' },
	      { value: 'progress_only', label: '只是过程进展' },
	      { value: 'not_completed', label: '没有完成反馈' },
	      { value: 'unknown', label: '无法判断' },
	    ];
	    const deliverableArtifactOptions = [
	      { value: 'doc_link', label: '文档链接' },
	      { value: 'demo_url', label: 'Demo 地址' },
	      { value: 'code_block', label: '代码块' },
	      { value: 'file_path', label: '文件路径' },
	      { value: 'uploaded_artifact', label: '上传产物' },
	      { value: 'no_artifact', label: '没有具体产物' },
	      { value: 'unknown', label: '无法判断' },
	    ];
	    const relevanceOptions = [
	      { value: 'relevant', label: '相关' },
	      { value: 'partial', label: '部分相关' },
	      { value: 'not_relevant', label: '不相关' },
	      { value: 'unknown', label: '无法判断' },
	    ];
	    const workflowOptions = [
	      { value: 'complete', label: '完整执行' },
	      { value: 'partial', label: '部分执行' },
	      { value: 'not_executed', label: '未执行' },
	      { value: 'wrong_order', label: '顺序错误' },
	      { value: 'unknown', label: '无法判断' },
	    ];
	    const hardruleOptions = [
	      { value: 'executed', label: '已执行' },
	      { value: 'not_executed', label: '未执行' },
	      { value: 'insufficient', label: '执行不充分' },
	      { value: 'not_applicable', label: '规则不适用' },
	      { value: 'unknown', label: '无法判断' },
	    ];
	    const mainToolOptions = [
	      { value: 'hit', label: '核心工具命中' },
	      { value: 'missed', label: '核心工具未命中' },
	      { value: 'not_declared', label: '未声明核心工具' },
	      { value: 'not_applicable', label: '不适用' },
	      { value: 'unknown', label: '无法判断' },
	    ];
	    const buttons = answerKey === 'goal_satisfaction'
	      ? [
	          renderManualCorrectionButton('goal_keyword_correction', `${baseId}:goal_keyword`, '改目标关键词', [], 'text'),
	          renderManualCorrectionButton('completion_result_correction', `${baseId}:completion_result`, '标注有结果', completionResultOptions),
	          renderManualCorrectionButton('deliverable_artifact_correction', `${baseId}:deliverable_artifact`, '标注有产物', deliverableArtifactOptions),
	        ]
	      : answerKey === 'declared_behavior_fit'
	        ? [
	            renderManualCorrectionButton('skill_relevance_correction', `${baseId}:skill_relevance:${skill.skillName}`, '能力是否相关', relevanceOptions),
	            renderManualCorrectionButton('workflow_completion_correction', `${baseId}:workflow_completion:${skill.skillName}`, '标准流程完整性', workflowOptions),
	            renderManualCorrectionButton('hardrule_execution_correction', `${baseId}:hardrule_execution:${skill.skillName}`, '硬性规则执行', hardruleOptions),
	            renderManualCorrectionButton('main_tool_execution_correction', `${baseId}:main_tool_execution:${skill.skillName}`, '核心工具状态', mainToolOptions),
	          ]
	        : [];
	    if (buttons.length === 0) return '';
	    return `<div class="manual-correction-panel">
	      <span class="manual-correction-title">人工纠正</span>
	      <div class="manual-correction-actions">${buttons.join('')}</div>
	    </div>`;
	  };
	  const inboxManualCorrectionButtonGroup = (skill: ExperienceSessionSummary, answerKey: string): string => {
	    const panel = inboxManualCorrectionControls(skill, answerKey);
	    return panel.replace('class="manual-correction-panel"', 'class="manual-correction-panel is-in-review-popover"');
	  };
	  const inboxManualCorrectionActiveCount = (skill: ExperienceSessionSummary): number => {
	    const targetIds = [
	      ['goal_keyword_correction', `${skill.id}:goal_keyword`],
	      ['completion_result_correction', `${skill.id}:completion_result`],
	      ['deliverable_artifact_correction', `${skill.id}:deliverable_artifact`],
	      ['skill_relevance_correction', `${skill.id}:skill_relevance:${skill.skillName}`],
	      ['workflow_completion_correction', `${skill.id}:workflow_completion:${skill.skillName}`],
	      ['hardrule_execution_correction', `${skill.id}:hardrule_execution:${skill.skillName}`],
	      ['main_tool_execution_correction', `${skill.id}:main_tool_execution:${skill.skillName}`],
	    ] as const;
	    return targetIds.filter(([targetType, targetId]) =>
	      manualCorrectionLabel(manualCorrectionEntry(targetType, targetId)?.note)
	    ).length;
	  };
	  const inboxChecklistDetected = (item: ExperienceChecklistItem): boolean => {
	    // 检测到「需要关注或值得展示的事实」: 失败 / 数据问题 / 正向 passed / 主动声明类 passed
	    if (item.status === 'failed' || item.status === 'degraded') return true;
	    if (item.status === 'unknown' && item.contribution === 'informational' && /^看到/.test(item.label)) return true;
	    if (item.status === 'passed') {
	      // passed 时, 看 contribution 区分「主动发现的事实」vs「未发现负向信号」
	      // - blocking / attention contribution + passed = 「负向 item 未命中」, 视为「未发现」
	      // - positive / informational + passed = 「正向 item 命中 / 中性事实成立」, 视为「发现」
	      return item.contribution === 'positive' || item.contribution === 'informational';
	    }
	    return false;
	  };
	  const inboxChecklistStatusClass = (item: ExperienceChecklistItem): string => {
	    if (inboxChecklistDetected(item)) return 'is-detected';
	    return 'is-absent';
	  };
	  const inboxChecklistStatusIcon = (item: ExperienceChecklistItem): string => {
	    return inboxChecklistDetected(item) ? '●' : '○';
	  };
	  const inboxChecklistSourceLabel = (source?: ExperienceChecklistItem['source']): string => {
	    if (source === 'llm_soft') return '模型识别';
	    if (source === 'manual') return '人工';
	    return '规则判定';
	  };
	  const inboxChecklistSourceBadge = (item: ExperienceChecklistItem): string => {
	    if (item.status === 'unknown' || item.status === 'degraded' || item.status === 'not_applicable') return '';
	    return `<em>${e(inboxChecklistSourceLabel(item.source))}</em>`;
	  };
	  const inboxAnswerChecklistFromItems = (items: ExperienceChecklistItem[]): string => {
	    const isCore = (item: ExperienceChecklistItem): boolean =>
	      item.status === 'failed'
	      || item.status === 'degraded'
	      || item.contribution === 'blocking'
	      || (item.contribution === 'attention' && inboxChecklistDetected(item));
	    const renderItems = (groupItems: ExperienceChecklistItem[]): string => groupItems.map((item) => `<span class="inbox-answer-check ${inboxChecklistStatusClass(item)}" title="${e(item.reason)}">
	      <span class="inbox-answer-check-icon">${e(inboxChecklistStatusIcon(item))}</span><span>${e(item.label)}</span>${inboxChecklistSourceBadge(item)}
	    </span>`).join('');
	    const coreItems = items.filter(isCore);
	    const otherItems = items.filter((item) => !coreItems.includes(item));
	    return `<div class="inbox-answer-checklist is-grouped">
	      ${coreItems.length > 0 ? `<div class="inbox-answer-check-group"><strong>核心关注</strong><div>${renderItems(coreItems)}</div></div>` : ''}
	      ${otherItems.length > 0 ? `<div class="inbox-answer-check-group"><strong>其他发现</strong><div>${renderItems(otherItems)}</div></div>` : ''}
	    </div>`;
	  };
	  const inboxAnswerChecklist = (skill: ExperienceSessionSummary, answer: ExperienceSessionStoryAnswer): string => {
	    const answerKey = answer.key;
	    if ((answer.checklistItems ?? []).length > 0) {
	      return inboxAnswerChecklistFromItems(answer.checklistItems);
	    }
	    const goalKeywords = inboxExtractGoalKeywords(skill.evidenceChain?.firstUserMessage?.snippet) || inboxLlmEnhancedGoalKeywords(skill.skillName);
	    const chain = skillChains[skill.skillName];
	    const displayIndicators = displayIndicatorsForSession(skill);
	    const hasGoalKeyword = goalKeywords.length > 0;
	    const hasCompletionResult = displayIndicators.assistantDeliverySignalCount > 0;
	    const hasDeliverableArtifact = displayIndicators.deliverableArtifactSignalCount > 0;
	    const hasSkillDescriptionHit = (skill.evidenceChain?.skillContextCount ?? 0) > 0;
	    const workflowNodes = chain?.runtime.workflowNodes ?? [];
	    const hasCompleteWorkflow = workflowNodes.length > 0 && workflowNodes.every((node) => node.status === 'passed');
	    const hardRuleChecks = chain?.runtime.hardRules ?? [];
	    const hasExecutedHardRules = hardRuleChecks.length > 0 && hardRuleChecks.every((rule) => rule.status === 'passed');
	    const hasExpectedToolMissed = (skill.reviewerReport?.findings ?? []).some((finding) => finding.ruleSource === 'expected_tools_missed');
	    const executionText = skill.reviewerReport?.chainSteps.find((step) => step.label === '执行流程')?.text ?? '';
	    const expectedToolDeclared = hasExpectedToolMissed || /声明的(?:主业|核心)工具/.test(executionText);
	    const hasMainToolHit = expectedToolDeclared && /命中声明的(?:主业|核心)工具/.test(executionText) && !hasExpectedToolMissed;
	    const mainToolLabel = expectedToolDeclared
	      ? hasMainToolHit
	        ? '核心工具命中'
	        : '核心工具未命中'
	      : '未声明核心工具';
	    const hasNegativeFeedback = displayIndicators.negativeFeedbackCount > 0 || displayIndicators.userCorrectionCount > 0;
	    const hasFollowUp = displayIndicators.userFollowUpCount > 0;
	    const hasSupplementContext = displayIndicators.userFollowUpCount > 0 || displayIndicators.userMessageCount > 1;
	    const hasInterruption = displayIndicators.userInterruptionCount > 0;
	    const checks = answerKey === 'goal_satisfaction'
	      ? [
	          { label: `用户目标关键字：${goalKeywords || '未提取到'}`, ok: hasGoalKeyword },
	          { label: '有结果：看到完成态或结果反馈', ok: hasCompletionResult },
	          { label: '有产物：看到链接、路径、代码块或文件', ok: hasDeliverableArtifact },
	          { label: '用户针对结果或产物反复追问', ok: hasFollowUp },
	        ]
	      : answerKey === 'declared_behavior_fit'
	        ? [
	            { label: '能力描述命中用户提问', ok: hasSkillDescriptionHit },
	            { label: '标准流程完整执行', ok: hasCompleteWorkflow },
	            { label: '硬性规则执行', ok: hasExecutedHardRules },
	            { label: mainToolLabel, ok: hasMainToolHit },
	          ]
	        : [
	            { label: '用户有负面反馈如反驳、不满等', ok: hasNegativeFeedback },
	            { label: '用户有追问', ok: hasFollowUp },
	            { label: '用户有重新补充上下文/文档', ok: hasSupplementContext },
	            { label: '用户有中断流程', ok: hasInterruption },
	          ];
	    return `<div class="inbox-answer-checklist">${checks.map((check) => `<span class="inbox-answer-check ${check.ok ? 'is-detected' : 'is-absent'}"><span class="inbox-answer-check-icon">${check.ok ? '●' : '○'}</span>${e(check.label)}</span>`).join('')}</div>`;
	  };
	  const inboxRecognizedGoalText = (skill: ExperienceSessionSummary): string => {
	    const llmGoal = inboxLlmEnhancedGoalKeywords(skill.skillName);
	    if (llmGoal) return llmGoal;
	    const goals = (skill.sessionStory?.goalSlices ?? [])
	      .map((goal) => inboxExtractGoalKeywords(goal.inferredUserGoal))
	      .filter((goal): goal is string => Boolean(goal));
	    if (goals.length > 0) return goals.slice(0, 3).join('；');
	    return inboxExtractGoalKeywords(skill.evidenceChain?.firstUserMessage?.snippet)
	      || '未提取到明确用户目标';
	  };
	  const inboxSignalSnippet = (
	    skill: ExperienceSessionSummary,
	    predicate: (event: ExperienceTimelineEvent) => boolean,
	    fallback: string,
	  ): string => {
	    const events = (skill.timelinePreview ?? []).filter(predicate);
	    const text = inboxCleanSnippet(events.at(-1)?.snippet ?? events.at(-1)?.fullText);
	    if (text) return text;
	    return inboxCleanSnippet(skill.evidenceChain?.lastAssistantMessage?.snippet) ?? fallback;
	  };
	  const inboxRecognizedCompletionText = (skill: ExperienceSessionSummary): string => {
	    const text = inboxSignalSnippet(
	      skill,
	      (event) => event.kind === 'assistant_message' && isAssistantCompletionResultSignal(event),
	      '未识别到明确完成结果',
	    );
	    return inboxExtractCompletionKeywords(text);
	  };
	  const inboxRecognizedArtifactText = (skill: ExperienceSessionSummary): string => {
	    const text = inboxSignalSnippet(
	      skill,
	      (event) => event.kind === 'assistant_message' && isAssistantDeliverableArtifactSignal(event),
	      '未识别到明确产物',
	    );
	    return inboxExtractArtifactKeywords(text);
	  };
	  const inboxAnswerContext = (skill: ExperienceSessionSummary, answer: ExperienceSessionStoryAnswer): string => {
	    if (answer.key !== 'goal_satisfaction') return '';
	    return `<div class="inbox-answer-context">
	      <div><span>目标关键词</span><strong>${e(inboxRecognizedGoalText(skill))}</strong></div>
	      <div><span>结果关键词</span><strong>${e(inboxRecognizedCompletionText(skill))}</strong></div>
	      <div><span>产物关键词</span><strong>${e(inboxRecognizedArtifactText(skill))}</strong></div>
	    </div>`;
	  };
	  const inboxSuggestionKey = (suggestion: ResolvedOwnerSuggestion): string =>
	    [suggestion.checklistItemKey, suggestion.title, suggestion.body, suggestion.acceptanceCriteria].filter(Boolean).join('\u0000');
	  const inboxTextSuggestion = (title: string, body?: string, acceptanceCriteria?: string): ResolvedOwnerSuggestion => ({
	    title,
	    body,
	    acceptanceCriteria,
	  });
	  const inboxSuggestionHasFeedbackContract = (suggestions: ResolvedOwnerSuggestion[]): boolean =>
	    suggestions.some((suggestion) => /feedback|adopt|reject|useful|thumbs?|反馈|采用|弃用|点赞|点踩|简评|评价/i.test(
	      [suggestion.title, suggestion.body, suggestion.acceptanceCriteria].filter(Boolean).join('\n'),
	    ));
	  const inboxFeedbackContractSuggestion = (): ResolvedOwnerSuggestion => inboxTextSuggestion(
	    '补充用户反馈采集点',
	    '在产物交付或人工复盘入口中补充轻量反馈，例如采用 / 弃用、有用 / 无用、点赞 / 点踩或一句话简评。这样线上观测可以把用户反馈关联到具体 session、skill 调用、产物和规则证据。',
	    '下次观测中，反馈记录能回溯到对应 session、artifact 和 skill invocation。',
	  );
    const inboxTypeDeclarationSuggestion = (resolved: ResolvedObservationReviewSession): ResolvedOwnerSuggestion | undefined => {
      if (resolved.skillTypeSource === 'frontmatter') return undefined;
      const frontmatterExample = '示例：在 SKILL.md 顶部 frontmatter 增加 skillType: router / delegation / executor / advisory / workflow_owner 之一。';
      return inboxTextSuggestion(
        '在 SKILL.md frontmatter 声明 skill 类型',
        `当前类型来自规则推断或模型识别，不如作者声明稳定。建议在 SKILL.md frontmatter 中声明 skillType，让观测报告按正确类型生成流程判断和 owner 建议。${frontmatterExample}`,
        'SKILL.md frontmatter 中出现明确 skillType。',
      );
    };
    const inboxTypeFallbackSuggestion = (resolved: ResolvedObservationReviewSession): ResolvedOwnerSuggestion | undefined => {
      if (resolved.skillType === 'router') {
        return inboxTextSuggestion(
          '完善路由型 skill 的下游闭环标准',
          '路由型 skill 需要声明：如何选择下游能力、如何保留用户目标、如何关联下游 session / 产物、用户追问时如何返回状态。',
          '下次观测中能看到路由选择、下游链路关联、下游完成态、用户侧闭环四类证据。',
        );
      }
      if (resolved.skillType === 'delegation') {
        return inboxTextSuggestion(
          '完善委派型 skill 的 child 生命周期标准',
          '委派型 skill 需要声明：child 如何启动、如何追踪 session / ttyd / tmux、父会话不能接手哪些原始任务、异步完成或失败如何通知用户。',
          '下次观测中能看到 child lifecycle、parent boundary、async notification 三类证据。',
        );
      }
      if (resolved.skillType === 'executor') {
        return inboxTextSuggestion(
          '完善执行型 skill 的完成态和产物标准',
          '执行型 skill 需要声明：核心工具或动作是什么、什么算执行完成、标准产物是什么、最后如何明确交付给用户。',
          '下次观测中能看到核心工具命中、最终回复、标准产物路径或链接。',
        );
      }
      if (resolved.skillType === 'advisory') {
        return inboxTextSuggestion(
          '完善咨询型 skill 的结论和证据标准',
          '咨询型 skill 需要声明：结论如何组织、证据如何引用、未知项如何说明、下一步建议如何表达。',
          '下次观测中能看到明确结论、证据来源、未确认项和可执行下一步。',
        );
      }
      if (resolved.skillType === 'workflow_owner') {
        return inboxTextSuggestion(
          '完善流程负责型 skill 的阶段矩阵',
          '流程负责型 skill 需要声明标准阶段、每个阶段的 owner / executor、期望证据、阶段产物、失败信号和用户反馈处理方式。',
          '下次观测中能看到阶段矩阵、阶段责任、阶段产物、阶段反馈和最终流程闭环。',
        );
      }
      return undefined;
    };
    const inboxRuleTypeSuggestions = (skill: ExperienceSessionSummary, resolved: ResolvedObservationReviewSession): ResolvedOwnerSuggestion[] => {
      const out: ResolvedOwnerSuggestion[] = [];
      const typeSuggestion = inboxTypeDeclarationSuggestion(resolved);
      if (typeSuggestion) out.push(typeSuggestion);
      const typeFallbackSuggestion = inboxTypeFallbackSuggestion(resolved);
      if (typeFallbackSuggestion) out.push(typeFallbackSuggestion);
      const indicators = displayIndicatorsForSession(skill);
      const downstreamSignals = canonicalFeedbackSignalsForDisplay(skill).filter((signal) =>
        (signal.type === 'follow_up' || signal.type === 'interruption')
        && (signal.canonicalAttributions ?? signal.attributions ?? []).some((attribution) =>
          attribution.skillName === skill.skillName && attribution.attributionRole === 'downstream_related'
        )
      );
      if (downstreamSignals.length > 0 && resolved.skillType !== 'router' && resolved.skillType !== 'delegation') {
        const hasInterruption = downstreamSignals.some((signal) => signal.type === 'interruption');
        out.push(inboxTextSuggestion(
          hasInterruption ? '补充下游调用链路的中断处理' : '补充下游调用链路的追问处理',
          hasInterruption
            ? '这次运行出现下游调用链路，且用户在下游链路中手动中断。即使当前 skill 类型未判为路由或委派，也需要声明下游状态回收、停止处理和用户通知规范。'
            : '这次运行出现下游调用链路，且用户对下游进度或结果有追问。即使当前 skill 类型未判为路由或委派，也需要声明下游状态回收和用户追问处理规范。',
          '下次观测中，下游运行中 / 完成 / 失败 / 中断都有明确状态，并能关联到当前 skill 的用户侧闭环。',
        ));
      }
      if (resolved.skillType === 'router') {
        if (indicators.userFollowUpCount > 0 || indicators.userCorrectionCount > 0 || indicators.userInterruptionCount > 0) {
          out.push(inboxTextSuggestion(
            '补充下游调用链路的追问处理',
            '这个路由型 skill 的下游调用链路出现用户追问。建议把下游 session、产物、完成态、失败原因和用户可见状态写清楚。',
            '下次观测中，下游完成 / 失败 / 跑偏能关联到路由能力，并且用户追问时能看到明确状态。',
          ));
        }
      } else if (resolved.skillType === 'delegation') {
        if (indicators.userFollowUpCount > 0 || indicators.userInterruptionCount > 0) {
          out.push(inboxTextSuggestion(
            '补充 child 生命周期和异步通知状态',
            '委派型 skill 需要稳定表达 child 是否已启动、运行中、完成、失败或被停止，避免用户只能通过追问确认进度。',
            'runner / child session / ttyd / cleanup / observer 状态能在报告中形成完整链路。',
          ));
        }
      } else if (resolved.skillType === 'executor') {
        if (indicators.assistantDeliverySignalCount === 0 || indicators.deliverableArtifactSignalCount === 0) {
          out.push(inboxTextSuggestion(
            '补充执行型 skill 的完成态和标准产物',
            '执行型 skill 应明确什么算完成，以及最终产物应该是文件、链接、代码块还是文档路径，避免过程消息被当成结果。',
            '最后回复包含明确完成标记和可回溯产物证据。',
          ));
        }
      } else if (resolved.skillType === 'advisory') {
        if (indicators.userFollowUpCount > 0) {
          out.push(inboxTextSuggestion(
            '补充咨询型 skill 的结论和证据结构',
            '咨询型 skill 被追问时，通常说明结论边界或证据引用不够清楚。建议固定输出结论、证据、未知项和下一步。',
            '下次同类咨询中，用户无需追问即可看到结论和证据来源。',
          ));
        }
      } else if (resolved.skillType === 'workflow_owner') {
        if (indicators.userFollowUpCount > 0 || indicators.userCorrectionCount > 0 || indicators.userInterruptionCount > 0) {
          out.push(inboxTextSuggestion(
            '补充流程阶段的反馈闭环',
            '流程负责型 skill 出现用户追问、纠正或中断时，需要把反馈归到具体阶段，并说明该阶段是已完成、需补救、被跳过还是失败。',
            '下次观测中，用户反馈能定位到具体 workflow 阶段，并生成对应阶段的修复建议。',
          ));
        }
      }
      return out;
    };
	  const inboxBuildSkillActionSuggestions = (skill: ExperienceSessionSummary): ResolvedOwnerSuggestion[] => {
      const resolved = inboxResolvedSession(skill);
	    const llmSuggestions = resolved.ownerSuggestions;
	    const suggestions: ResolvedOwnerSuggestion[] = [
        ...inboxRuleTypeSuggestions(skill, resolved),
        ...llmSuggestions,
      ];
	    const reportSuggestions = skill.reviewerReport?.authorSuggestions ?? [];
	    for (const suggestion of reportSuggestions) {
	      if (/下游|回挂|追问|纠正|中断|异步闭环|结果回传/.test(suggestion)) {
	        suggestions.push(inboxTextSuggestion('补强下游闭环和反馈关联', suggestion));
	      }
	    }
	    if (suggestions.length === 0 && reportSuggestions.length > 0) {
	      suggestions.push(...reportSuggestions.map((suggestion) => inboxTextSuggestion(suggestion)));
	    }
	    const chain = skillChains[skill.skillName];
	    const findings = skill.reviewerReport?.findings ?? [];
      const displayIndicators = displayIndicatorsForSession(skill);
	    const hasFinding = (source: string): boolean => findings.some((finding) => finding.ruleSource === source);
	    const storyAnswers = skill.sessionStory?.answers ?? [];
	    const goalAnswer = storyAnswers.find((answer) => answer.key === 'goal_satisfaction');
	    if (suggestions.length === 0 && chain && (!chain.healthCheck.hardRules.declared || !chain.healthCheck.workflows.declared)) {
	      suggestions.push(inboxTextSuggestion(
	        '优化标准流程和硬性规则声明',
	        '把执行步骤、检查点、失败降级写成可观测的结构。',
	        'SKILL.md 中能识别到标准 workflow 和 hardRules，报告可按声明流程复盘。',
	      ));
	    }
	    if (suggestions.length === 0 && (
	      hasFinding('final_delivery_absent')
	      || goalAnswer?.status === 'degraded'
	      || goalAnswer?.status === 'attention'
	      || goalAnswer?.status === 'unknown'
	      || displayIndicators.assistantDeliverySignalCount === 0
	    )) {
	      suggestions.push(inboxTextSuggestion(
	        '优化完成情况判断',
	        '明确什么算有结果、什么算有产物，过程进展不要当成完成，并保留可回溯证据。',
	        '能力最后一次回复包含明确完成标记；如有产物，附上代码块、文档链接或文件路径。',
	      ));
	    }
	    if (suggestions.length === 0 && (hasFinding('user_hard_rule') || displayIndicators.hardRuleTextHitCount > 0)) {
	      suggestions.push(inboxTextSuggestion(
	        '沉淀用户硬性要求',
	        '把用户反复提出的硬性要求沉淀到 skill 规则或流程检查点，减少依赖用户临时纠偏。',
	      ));
	    }
	    if (suggestions.length === 0 && (displayIndicators.toolFailureCount > 0 || hasFinding('tool_error_recovery'))) {
	      suggestions.push(inboxTextSuggestion(
	        '补充工具失败恢复路径',
	        '让失败处理也能被 workflow 覆盖；读取失败时先说明缺失文件和影响，再尝试备用路径或让用户确认。',
	      ));
	    }
	    if (suggestions.length === 0 && (
	      displayIndicators.userCorrectionCount > 0
	      || displayIndicators.negativeFeedbackCount > 0
	      || displayIndicators.userFollowUpCount > 0
	    )) {
	      suggestions.push(inboxTextSuggestion(
	        '补强用户满意度判断',
	        '把追问、纠正、负向反馈作为改进输入，而不是只看是否调用完成。',
	        '交付后用户继续纠正或追问时，报告定位到对应用户原文并标记为待复核。',
	      ));
	    }
	    if (!inboxSuggestionHasFeedbackContract(suggestions)) {
	      suggestions.push(inboxFeedbackContractSuggestion());
	    }
	    const deduped: ResolvedOwnerSuggestion[] = [];
	    for (const suggestion of suggestions) {
	      const key = inboxSuggestionKey(suggestion);
	      if (!deduped.some((item) => inboxSuggestionKey(item) === key)) deduped.push(suggestion);
	    }
	    return deduped.slice(0, 4);
	  };
	  const inboxRenderActionSuggestion = (suggestion: ResolvedOwnerSuggestion, index: number): string => {
	    const detailBlocks = [
	      suggestion.checklistItemKey ? `<div class="inbox-action-suggestion-detail"><span>关联检查项</span><p>${e(suggestion.checklistItemLabel ?? suggestion.checklistItemKey)}</p></div>` : '',
	      suggestion.body ? `<div class="inbox-action-suggestion-detail"><span>建议细节</span><p>${e(suggestion.body)}</p></div>` : '',
	      suggestion.acceptanceCriteria ? `<div class="inbox-action-suggestion-detail is-acceptance"><span>验收方式</span><p>${e(suggestion.acceptanceCriteria)}</p></div>` : '',
	    ].filter(Boolean).join('');
	    return `<li class="inbox-action-suggestion-item">
	      <details class="inbox-action-suggestion-card"${index === 0 ? ' open' : ''}>
	        <summary>
	          <span class="inbox-action-suggestion-index">${index + 1}</span>
	          <strong>${e(suggestion.title)}</strong>
	          <em>${detailBlocks ? '查看细节' : '无更多细节'}</em>
	        </summary>
	        ${detailBlocks ? `<div class="inbox-action-suggestion-body">${detailBlocks}</div>` : ''}
	      </details>
	    </li>`;
	  };
	  const inboxRenderSkillActionSummary = (sessions: ExperienceSessionSummary[]): string => {
	    const suggestions: ResolvedOwnerSuggestion[] = [];
	    for (const session of sessions) {
	      for (const suggestion of inboxBuildSkillActionSuggestions(session)) {
	        const key = inboxSuggestionKey(suggestion);
	        if (!suggestions.some((item) => inboxSuggestionKey(item) === key)) suggestions.push(suggestion);
	      }
	    }
	    if (suggestions.length === 0) return '';
	    return `<section class="inbox-skill-summary-suggestions">
	      <details class="inbox-suggestion-block is-action" open>
	        <summary class="inbox-suggestion-title">给 skill 作者的优化建议</summary>
	        <ol class="inbox-action-suggestion-list">${suggestions.slice(0, 5).map(inboxRenderActionSuggestion).join('')}</ol>
	      </details>
	    </section>`;
	  };
	  const inboxAnswerReasonLabel = (reason: ExperienceSessionStoryAnswer['reason']): string => {
	    if (reason === 'data_degraded') return '数据质量不足';
	    if (reason === 'blocking_failed') return '关键项未通过';
	    if (reason === 'attention_accumulated') return '存在复核项';
	    if (reason === 'unknown_dominant') return '未知项较多';
	    if (reason === 'all_passed') return '关键项通过';
	    return '当前不适用';
	  };
	  const inboxDataHealth = (skill: ExperienceSessionSummary, answers: ExperienceSessionStoryAnswer[]): { label: string; className: string; facts: string[] } => {
	    const hasDataDegraded = answers.some((answer) => answer.status === 'degraded' || answer.reason === 'data_degraded');
	    const hasAttention = answers.some((answer) => answer.status === 'attention' || answer.reason === 'blocking_failed' || answer.reason === 'attention_accumulated');
	    const hasUnknown = answers.length === 0 || answers.some((answer) => answer.status === 'unknown' || answer.reason === 'unknown_dominant' || answer.reason === 'not_applicable');
	    const label = hasDataDegraded
	      ? '数据健康度：数据有问题'
	      : hasAttention
	        ? '数据健康度：要看一眼'
	        : hasUnknown
	          ? '数据健康度：信息不够'
	          : '数据健康度：看起来正常';
	    const className = hasDataDegraded
	      ? 'is-degraded'
	      : hasAttention
	        ? 'is-attention'
	        : hasUnknown
	          ? 'is-unknown'
	          : 'is-ok';
	    const facts = [
	      `真实用户消息 ${skill.evidenceChain.userMessageCount}`,
	      `skill 上下文 ${skill.evidenceChain.skillContextCount}`,
	      `助手回复 ${skill.evidenceChain.assistantMessageCount}`,
	      `工具调用 ${skill.evidenceChain.toolUseCount}`,
	    ];
	    return { label, className, facts };
	  };
	  // eslint-disable-next-line @typescript-eslint/no-unused-vars
	  const inboxRenderDataHealth = (skill: ExperienceSessionSummary, answers: ExperienceSessionStoryAnswer[]): string => {
	    const health = inboxDataHealth(skill, answers);
	    return `<div class="inbox-trust-layer">
	      <span class="inbox-data-health ${health.className}">${e(health.label)}</span>
	      ${health.facts.map((fact) => `<span class="inbox-trust-fact">${e(fact)}</span>`).join('')}
	    </div>`;
	  };
	  // eslint-disable-next-line @typescript-eslint/no-unused-vars
	  const inboxRenderParentStatuses = (answers: ExperienceSessionStoryAnswer[]): string => {
	    if (answers.length === 0) return '';
	    return `<div class="inbox-parent-status-row">${answers.map((answer) => `<div class="inbox-parent-status ${answer.status === 'degraded' ? 'is-degraded' : answer.status === 'attention' ? 'is-attention' : answer.status === 'unknown' ? 'is-unknown' : answer.status === 'not_applicable' ? 'is-not-applicable' : 'is-ok'}">
	      <span>${e(answer.label)}</span>
	      ${inboxStatusBadge(answer.status)}
	      <em>${e(inboxAnswerReasonLabel(answer.reason))}</em>
	    </div>`).join('')}</div>`;
	  };
	  const inboxRenderTypeSpecificChecklist = (resolved: ResolvedObservationReviewSession): string => {
	    if (resolved.typeSpecificChecklist.length === 0) return '';
	    return `<div class="inbox-review-layer">
	      <div class="inbox-review-layer-title">${e(inboxLlmSkillTypeLabel(resolved.skillType))}检查项</div>
	      ${resolved.typeSpecificSummary ? `<p class="inbox-type-summary">${e(resolved.typeSpecificSummary)}</p>` : ''}
	      ${inboxAnswerChecklistFromItems(resolved.typeSpecificChecklist)}
	    </div>`;
	  };
	  // eslint-disable-next-line @typescript-eslint/no-unused-vars
	  const inboxRenderSessionSuggestions = (skill: ExperienceSessionSummary): string => {
	    const suggestions = inboxBuildSkillActionSuggestions(skill);
	    if (suggestions.length === 0) return '';
	    return `<div class="inbox-review-suggestions">
	      <div class="inbox-review-layer-title">建议</div>
	      <ol class="inbox-action-suggestion-list is-compact">${suggestions.slice(0, 4).map(inboxRenderActionSuggestion).join('')}</ol>
	    </div>`;
	  };
	  const inboxRenderSessionReviewControl = (session: ExperienceSessionSummary): string => {
	    const reviewEntry = reviewState.entries[`experience_session:${session.id}`];
	    const existingNote = reviewEntry?.reason ?? reviewEntry?.note ?? '';
	    const safeId = e(session.id);
	    const activeCount = (reviewEntry?.verdict ? 1 : 0) + inboxManualCorrectionActiveCount(session);
	    return `<details class="inbox-section-review" data-inbox-detail-actions data-inbox-session-id="${safeId}" onclick="event.stopPropagation()">
	      <summary class="inbox-section-review-button">人工标注${activeCount > 0 ? `(${activeCount})` : ''}</summary>
	      <div class="inbox-section-review-panel">
	        <div class="inbox-detail-actions-row"><strong class="inbox-detail-actions-title">这次跑得怎么样</strong><span class="inbox-detail-actions-meta">针对 ${e(session.skillName)}</span></div>
	        <div class="inbox-detail-actions-buttons">
	          <button type="button" class="inbox-action-button ${reviewEntry?.verdict === 'real_issue' ? 'is-active' : ''}" data-inbox-verdict="real_issue" onclick="setInboxSessionReview('${safeId}', 'real_issue', this)">同意</button>
	          <button type="button" class="inbox-action-button ${reviewEntry?.verdict === 'not_issue' ? 'is-active' : ''}" data-inbox-verdict="not_issue" onclick="setInboxSessionReview('${safeId}', 'not_issue', this)">否决</button>
	          <button type="button" class="inbox-action-button ${reviewEntry?.verdict === 'needs_more_context' ? 'is-active' : ''}" data-inbox-verdict="needs_more_context" onclick="toggleInboxNoteEditor('${safeId}', this)">留意见</button>
	        </div>
	        <div class="inbox-note-editor" data-inbox-note-editor="${safeId}" style="display:${reviewEntry?.verdict === 'needs_more_context' || existingNote ? 'block' : 'none'}">
	          <textarea class="inbox-note-textarea" data-inbox-note-input="${safeId}" placeholder="留下你的意见或补充上下文（保存后会写入 review-state）" rows="3">${e(existingNote)}</textarea>
	          <div class="inbox-note-editor-buttons">
	            <button type="button" class="inbox-note-save" onclick="saveInboxSessionNote('${safeId}', this)">保存意见</button>
	            <button type="button" class="inbox-note-cancel" onclick="closeInboxNoteEditor('${safeId}')">收起</button>
	          </div>
	        </div>
	        <div class="inbox-manual-review-groups">
	          <div class="inbox-manual-review-group">
	            <strong>目标 / 结果 / 产物</strong>
	            ${inboxManualCorrectionButtonGroup(session, 'goal_satisfaction')}
	          </div>
	          <div class="inbox-manual-review-group">
	            <strong>能力 / 流程 / 规则</strong>
	            ${inboxManualCorrectionButtonGroup(session, 'declared_behavior_fit')}
	          </div>
	        </div>
	      </div>
	    </details>`;
	  };
	  const inboxRenderSkillCompletion = (skill: ExperienceSessionSummary): string => {
	    const report = skill.reviewerReport;
	    const resolved = inboxResolvedSession(skill);
	    const answers = resolved.answers;
	    const llmSummary = resolved.reviewerSummary;
	    return `<article class="inbox-skill-block">
	      <header class="inbox-skill-head">
	        <div>
	          <div class="inbox-skill-title-row"><h4>${e(skill.skillName)}</h4>${inboxSkillTypeBadge(inboxLlmSkillTypeLabel(resolved.skillType), inboxLlmSkillTypeHelpKey(resolved.skillType), inboxSkillTypeSourceText(resolved))}</div>
	          <span class="inbox-skill-subtitle">${e(report?.title ?? '常规观测')}</span>
	        </div>
	        ${llmSummary || report?.summary ? `<p class="inbox-skill-summary">${e(cleanReportCopy(llmSummary ?? report?.summary ?? ''))}</p>` : ''}
	      </header>
	      ${inboxRenderTypeSpecificChecklist(resolved)}
	      ${answers.length > 0 ? `<div class="inbox-review-layer">
	        <div class="inbox-review-layer-title">这次跑得怎么样</div>
	        <div class="inbox-answer-grid">
	          ${answers.map((answer) => `<article class="inbox-answer ${answer.status === 'degraded' ? 'is-degraded' : answer.status === 'attention' ? 'is-attention' : answer.status === 'unknown' ? 'is-unknown' : answer.status === 'not_applicable' ? 'is-not-applicable' : 'is-ok'}">
	            <div class="inbox-answer-head"><strong>${e(answer.label)}</strong>${inboxStatusBadge(answer.status)}</div>
	            ${inboxAnswerContext(skill, answer)}
	            ${inboxAnswerChecklist(skill, answer)}
	            ${inboxAnswerEvidenceButtons(answer.evidenceRefs)}
	          </article>`).join('')}
	        </div>
	      </div>` : '<p class="inbox-skill-empty">这条能力调用暂未生成完成情况判断。</p>'}
	    </article>`;
	  };
	  const inboxInvocationsById = new Map<string, ExperienceInvocation>();
	  for (const inv of experience?.invocations ?? []) inboxInvocationsById.set(inv.id, inv);
	  const inboxGetSessionInvocations = (session: ExperienceSessionSummary): ExperienceInvocation[] =>
	    session.invocationIds.map((id) => inboxInvocationsById.get(id)).filter((v): v is ExperienceInvocation => Boolean(v));
	  const inboxGetSessionToolCounts = (session: ExperienceSessionSummary): Record<string, number> => {
	    const out: Record<string, number> = {};
	    for (const inv of inboxGetSessionInvocations(session)) {
	      for (const [k, v] of Object.entries(inv.toolCounts ?? {})) out[k] = (out[k] ?? 0) + v;
	    }
	    return out;
	  };
	  const inboxBuildToolDetail = (session: ExperienceSessionSummary): Array<{ name: string; count: number }> => {
	    const counts = inboxGetSessionToolCounts(session);
	    return Object.entries(counts)
	      .map(([name, count]) => ({ name, count }))
	      .sort((a, b) => b.count - a.count);
	  };
	  const inboxBuildToolFailureDetail = (session: ExperienceSessionSummary): Array<{ name: string; count: number }> => {
	    const invocations = inboxGetSessionInvocations(session);
	    const failures: Record<string, number> = {};
	    for (const inv of invocations) {
	      for (const event of inv.timeline) {
	        if (event.kind === 'tool_result' && event.isError && event.toolName) {
	          failures[event.toolName] = (failures[event.toolName] ?? 0) + 1;
	        }
	      }
	    }
	    return Object.entries(failures).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
	  };
	  const inboxMetricCardJson = (detail: Array<{ name: string; count: number }>): string =>
	    e(JSON.stringify(detail));
	  const inboxEpisodeSkillTypeLabel = (type?: string): string => {
	    if (type === 'router') return '路由';
	    if (type === 'delegation') return '委派';
	    if (type === 'executor') return '执行';
	    if (type === 'advisory') return '咨询';
	    return '未确认';
	  };
	  const inboxEpisodeSkillTypeForSegment = (segment: ExperienceSkillSegment): string =>
	    segment.skillType;
	  const inboxEpisodeRoleLabel = (role?: string): string => {
	    if (role === 'main_executor') return '主执行';
	    if (role === 'router') return '路由';
	    if (role === 'delegator') return '调度';
	    if (role === 'supporting') return '辅助';
	    if (role === 'observer') return '观察';
	    return '未确认';
	  };
	  const inboxEpisodeFeedbackLabel = (type?: string): string => {
	    if (type === 'correction') return '纠正';
	    if (type === 'follow_up') return '追问';
	    if (type === 'frustration') return '不满/焦虑';
	    if (type === 'interruption') return '中断';
	    if (type === 'positive') return '正向';
	    return '反馈';
	  };
	  const inboxEpisodeAttributionLabel = (role?: string): string => {
	    if (role === 'primary_fault') return '直接归因';
	    if (role === 'downstream_related') return '下游链路';
	    if (role === 'context_only') return '背景相关';
	    return '关联';
	  };
	  const inboxEpisodeAttributionText = (
	    signal: ExperienceFeedbackSignal,
	    segment: ExperienceSkillSegment,
	    attribution?: ExperienceFeedbackAttribution,
	  ): string => {
	    const signalLabel = inboxEpisodeFeedbackLabel(signal.type);
	    if (attribution?.attributionRole === 'downstream_related') {
	      return `下游调用链路用户有${signalLabel}`;
	    }
	    if (attribution?.attributionRole === 'primary_fault') {
	      if (attribution.reasonCode === 'promise_match') return `直接归因：用户在追问此前承诺的结果`;
	      if (attribution.reasonCode === 'action_match') return `直接归因：用户反馈命中了当前执行动作`;
	      if (attribution.reasonCode === 'object_match') return `直接归因：用户点名了当前能力或产物`;
	      return `直接归因：反馈发生在当前执行窗口`;
	    }
	    if (attribution?.attributionRole === 'context_only') return `背景相关：同一任务上下文里的${signalLabel}`;
	    return `${inboxEpisodeAttributionLabel(attribution?.attributionRole)}：${signalLabel}`;
	  };
	  const inboxEpisodeFeedbackForSegment = (
	    episode: ExperienceEpisode,
	    segmentId: string,
	  ): ExperienceFeedbackSignal[] => episode.feedbackSignals.filter((signal: ExperienceFeedbackSignal) =>
	    (signal.canonicalAttributions ?? signal.attributions).some((attribution) => attribution.skillSegmentId === segmentId)
	  );
	  const inboxRenderEpisodeSegmentTree = (
	    episode: ExperienceEpisode,
	    session: ExperienceSessionSummary,
	  ): string => {
	    const segmentById = new Map(episode.skillSegments.map((segment) => [segment.id, segment]));
	    const childIdsByParentId = new Map<string, string[]>();
	    const parentIdByChildId = new Map<string, string>();
	    for (const edge of episode.orchestrationEdges) {
	      const parentId = edge.parentSkillSegmentId;
	      const childId = edge.executorSkillSegmentId;
	      const edgeKind = edge.edgeKind ?? (childId ? 'internal_skill' : 'external_child_session');
	      if (edgeKind !== 'internal_skill') continue;
	      if (!parentId || !childId || parentId === childId || !segmentById.has(parentId) || !segmentById.has(childId)) continue;
	      const childIds = childIdsByParentId.get(parentId) ?? [];
	      if (!childIds.includes(childId)) childIds.push(childId);
	      childIdsByParentId.set(parentId, childIds);
	      parentIdByChildId.set(childId, parentId);
	    }
	    const orderedChildren = (parentId: string): ExperienceSkillSegment[] => (childIdsByParentId.get(parentId) ?? [])
	      .map((id) => segmentById.get(id))
	      .filter((segment): segment is ExperienceSkillSegment => Boolean(segment))
	      .sort((a, b) => a.order - b.order);
	    const roots = episode.skillSegments
	      .filter((segment) => !parentIdByChildId.has(segment.id))
	      .sort((a, b) => a.order - b.order);
	    const renderSegment = (segment: ExperienceSkillSegment, path: string, depth: number): string => {
	      const segmentSignals = inboxEpisodeFeedbackForSegment(episode, segment.id);
	      const parent = parentIdByChildId.get(segment.id);
	      const parentSegment = parent ? segmentById.get(parent) : undefined;
	      const children = orderedChildren(segment.id);
	      return `<li class="inbox-execution-node ${segment.skillName === session.skillName ? 'is-current' : ''} ${depth > 0 ? 'is-child' : ''}">
	        <div class="inbox-execution-node-main">
	          <span class="inbox-execution-node-index">${e(path)}</span>
	          <div>
	            <strong>${e(segment.skillName)}</strong>
	            <em>${e(inboxEpisodeSkillTypeLabel(inboxEpisodeSkillTypeForSegment(segment)))} · ${e(inboxEpisodeRoleLabel(segment.episodeRole))}${parentSegment ? ` · 由 ${e(parentSegment.skillName)} 调起` : ''}</em>
	          </div>
	        </div>
	        ${segmentSignals.length > 0 ? `<div class="inbox-execution-node-children">
	          ${segmentSignals.map((signal) => {
	            const attribution = (signal.canonicalAttributions ?? signal.attributions).find((item) => item.skillSegmentId === segment.id);
	            return `<div class="inbox-execution-feedback-item">
	              <span>${e(inboxEpisodeFeedbackLabel(signal.type))}</span>
	              <p>${e(signal.text)}</p>
	              <em>${e(inboxEpisodeAttributionText(signal, segment, attribution))}</em>
	            </div>`;
	          }).join('')}
	        </div>` : ''}
	        ${children.length > 0 ? `<ol class="inbox-execution-skill-children">
	          ${children.map((child, childIndex) => renderSegment(child, `${path}.${childIndex + 1}`, depth + 1)).join('')}
	        </ol>` : ''}
	      </li>`;
	    };
	    const rootSegments = roots.length > 0 ? roots : episode.skillSegments;
	    return `<ol class="inbox-execution-timeline">
	      ${rootSegments.map((segment, index) => renderSegment(segment, String(index + 1), 0)).join('')}
	    </ol>`;
	  };
	  const inboxRenderEpisodeOverview = (session: ExperienceSessionSummary): string => {
	    const episodes = session.sessionStory?.episodes ?? [];
	    if (episodes.length === 0) return '<p class="inbox-skill-empty">没有可展示的上下游链路。</p>';
	    return `<div class="inbox-execution-overview-body">
	        <p class="inbox-execution-overview-note">用于看当前 session 里各 skill 片段的关系和用户反馈归因；指标卡仍只统计当前 skill 调用窗口。</p>
	        ${episodes.map((episode, index) => `<details class="inbox-execution-episode"${index === 0 ? ' open' : ''}>
	          <summary class="inbox-execution-episode-head">
	            <strong>用户目标切片 ${episode.order}</strong>
	            <span>${e(episode.primaryGoal ?? '未提取到明确用户目标')}</span>
	          </summary>
	          <div class="inbox-execution-episode-body">
	            ${inboxRenderEpisodeSegmentTree(episode, session)}
	            ${episode.orchestrationEdges.length > 0 ? `<div class="inbox-execution-links">${episode.orchestrationEdges.map((edge) => {
	              const edgeKind = edge.edgeKind ?? (edge.executorSkillSegmentId ? 'internal_skill' : 'external_child_session');
	              const edgeLabel = edgeKind === 'internal_skill' ? '技能链路' : '外部子会话';
	              return `<span>${e(edgeLabel)}：${e(edge.childSessionId ?? '下游执行')} · ${e(edge.status === 'started' ? '已启动' : edge.status === 'completed' ? '已完成' : edge.status === 'failed' ? '失败' : '未知')}</span>`;
	            }).join('')}</div>` : ''}
	          </div>
	        </details>`).join('')}
	      </div>`;
	  };
	  const inboxRenderSkillRuntime = (skill: ExperienceSessionSummary): string => {
	    const report = skill.reviewerReport;
	    const metrics = report?.oneLookMetrics;
	    const templateId = `inbox-skill-chain-${experienceSkillAnchor(skill.skillName)}-${e(skill.id)}`;
	    const evidenceJumpId = `inbox-sec-evidence-${e(skill.id)}`;
	    const toolDetail = inboxBuildToolDetail(skill);
	    const toolFailureDetail = inboxBuildToolFailureDetail(skill);
	    const indicators = displayIndicatorsForSession(skill);
	    const runtimeModel = [
	      skill.sourceMetadata?.provider,
	      skill.sourceMetadata?.model,
	      skill.sourceMetadata?.modelApi,
	    ].filter(Boolean).join(' / ') || '未记录模型';
	    const tokenDetail: Array<{ name: string; count: number }> = metrics?.tokenUsage ? [
	      { name: '输入 token', count: metrics.tokenUsage.inputTokens },
	      { name: '输出 token', count: metrics.tokenUsage.outputTokens },
	      { name: 'cache 读取', count: metrics.tokenUsage.cacheReadTokens },
	      { name: 'cache 写入', count: metrics.tokenUsage.cacheCreationTokens },
	    ] : [];
	    type MetricCard = {
	      key: string;
	      label: string;
	      value: number;
	      detail: Array<{ name: string; count: number }>;
	      note: string;
	      anomaly: boolean;
	    };
	    const cards: MetricCard[] = !metrics ? [] : [
	      { key: 'toolCall', label: '工具调用', value: indicators.toolCallCount, detail: toolDetail, note: '本次能力调用段内触发的工具调用总数及各类工具的命中分布。', anomaly: false },
	      { key: 'toolFailure', label: '工具失败', value: indicators.toolFailureCount, detail: toolFailureDetail, note: '工具执行返回失败的次数。命中失败可在版块 ④ 看具体上下文。', anomaly: indicators.toolFailureCount > 0 },
	      { key: 'userMessage', label: '用户消息', value: indicators.userMessageCount, detail: [], note: '本次能力调用段内的真实人工用户消息条数（已剔除 Skill 文档注入和运行时注入）。', anomaly: false },
	      { key: 'userFollowUp', label: '追问', value: indicators.userFollowUpCount, detail: [], note: '按当前 skill 的归因结果统计用户追问 / 补充；点击版块 ④ 可用同名标签定位原文。', anomaly: indicators.userFollowUpCount > 0 },
	      { key: 'userCorrection', label: '纠正', value: indicators.userCorrectionCount, detail: [], note: '用户明确纠正、否决前一轮交付的次数。出现即建议进版块 ④ 看上下文。', anomaly: indicators.userCorrectionCount > 0 },
	      { key: 'userInterruption', label: '人工中断', value: indicators.userInterruptionCount, detail: [], note: '用户在执行过程中主动中断的次数。可能意味着方向跑偏。', anomaly: indicators.userInterruptionCount > 0 },
	      { key: 'negativeFeedback', label: '负向反馈', value: indicators.negativeFeedbackCount, detail: [], note: '用户出现明确负向情绪表达的次数。', anomaly: indicators.negativeFeedbackCount > 0 },
	      { key: 'completionResult', label: '有结果', value: indicators.assistantDeliverySignalCount, detail: [], note: '回答中出现完成态或结果反馈的次数。它表示任务可能执行完成，不等于一定有可打开产物。', anomaly: false },
	      { key: 'deliverableArtifact', label: '有产物', value: indicators.deliverableArtifactSignalCount ?? 0, detail: [], note: '回答中出现文档链接、Demo 地址、文件路径、代码块或上传产物的次数。', anomaly: false },
	      { key: 'progress', label: '过程进展', value: metrics.assistantProgressUpdateCount ?? 0, detail: [], note: '回答中出现"正在 / 仍在 / 进度更新"等过程进展信号的次数。这类不算最终交付。', anomaly: false },
	      { key: 'selfCorrection', label: '自我纠正', value: metrics.selfCorrectionCount ?? indicators.selfCorrectionCount ?? 0, detail: [], note: 'agent 在没有用户介入的情况下发现问题并主动修正执行策略。少量说明有恢复能力，高频说明流程不稳。', anomaly: (metrics.selfCorrectionCount ?? indicators.selfCorrectionCount ?? 0) > 0 },
	      { key: 'repeatedExecution', label: '重复执行', value: metrics.repeatedExecutionCount ?? indicators.repeatedExecutionCount ?? 0, detail: [], note: '同类步骤、工具或流程被重复执行。高频出现时通常对应绕路或 workflow 不清晰。', anomaly: (metrics.repeatedExecutionCount ?? indicators.repeatedExecutionCount ?? 0) > 0 },
	      { key: 'tokenInput', label: '输入 token', value: metrics.tokenUsage?.inputTokens ?? 0, detail: tokenDetail, note: '按本次能力调用段累计的 token 用量。', anomaly: false },
	      { key: 'tokenOutput', label: '输出 token', value: metrics.tokenUsage?.outputTokens ?? 0, detail: tokenDetail, note: '按本次能力调用段累计的 token 用量。', anomaly: false },
	    ];
	    const metricRow = cards.length === 0
	      ? `<div id="inbox-sec-runtime-metrics-${e(skill.id)}"><p class="inbox-skill-empty">这条能力调用没有运行指标。</p></div>`
	      : `<div id="inbox-sec-runtime-metrics-${e(skill.id)}" class="inbox-metric-grid-wrap"><div class="inbox-metric-hint">点击任意指标卡可查看分布详情，红色卡片是检测到的异常。</div><div class="inbox-metric-grid">${cards.map((card) => `<button type="button" class="inbox-metric-card ${card.anomaly ? 'is-anomaly' : ''}" title="点击查看 ${e(card.label)} 详情" data-metric-key="${e(card.key)}" data-metric-label="${e(card.label)}" data-metric-value="${card.value}" data-metric-detail="${inboxMetricCardJson(card.detail)}" data-metric-note="${e(card.note)}" data-metric-anomaly="${card.anomaly ? '1' : '0'}" data-metric-jump="${evidenceJumpId}" onclick="openInboxMetricPopover(this)"><span>${e(card.label)}</span><strong>${card.value}</strong><em class="inbox-metric-card-hint">点击看详情</em></button>`).join('')}</div></div>`;
	    return `<article class="inbox-skill-block">
	      <header class="inbox-skill-head"><div><h4>${e(skill.skillName)}</h4><span class="inbox-skill-subtitle">运行指标 + 规则 / 流程 · 模型：${e(runtimeModel)}</span></div></header>
	      ${metricRow}
	      <details class="inbox-execution-overview inbox-rule-flow-overview" id="inbox-sec-runtime-rules-${e(skill.id)}" open>
	        <summary>流程规则命中</summary>
	        ${renderRuntimeRuleFlow(skill.skillName)}
	      </details>
	      <input type="hidden" data-inbox-skill-chain-template-id="${e(templateId)}">
	    </article>`;
	  };
	  const inboxRenderEvidence = (session: ExperienceSessionSummary, summaryText: string): string => {
	    const indicators = displayIndicatorsForSession(session);
	    const shownRuleFindings = displayRuleFindings(session, indicators);
	    const shownInference = displayAssistiveInference(indicators, session.assistiveInference);
	    const evidenceChain = session.evidenceChain ?? fallbackEvidenceChain(session);
	    const safeId = e(session.id);
	    const evidenceClass = indicators.toolFailureCount > 0 ? 'is-attention' : 'is-neutral';
	    return `<section class="inbox-section is-collapsed" data-inbox-section="evidence" id="inbox-sec-evidence-${safeId}">
	      <header class="inbox-section-head inbox-section-head-clickable" onclick="toggleInboxSectionHead(this)">
	        <h3>④ 原文回溯</h3>
	        <span class="inbox-section-summary ${evidenceClass}">${e(summaryText)}</span>
	        <span class="inbox-section-hint">展开看当前能力调用段的证据链、规则命中、时间线</span>
	        <button type="button" class="inbox-section-toggle" onclick="event.stopPropagation(); toggleInboxSection(this)" aria-label="收起或展开本版块">展开</button>
	      </header>
	      <div class="inbox-section-body">
	        <div class="inbox-evidence-grid">
	          <section>
	            <h4>证据链</h4>
	            ${renderEvidenceChain(evidenceChain)}
	            <h4>规则命中</h4>
	            ${renderRuleFindings(shownRuleFindings)}
	            <h4>复盘建议</h4>
	            ${renderAssistiveInference(shownInference)}
	          </section>
	          <section>
	            ${renderTimelinePair(session)}
	          </section>
	        </div>
	      </div>
	    </section>`;
	  };
	  const inboxRenderSessionContent = (cardSkillName: string, session: ExperienceSessionSummary, isActive: boolean): string => {
	    const siblings = inboxSiblingsMap.get(session.sessionId) ?? [session];
	    const indicators = displayIndicatorsForSession(session);
	    const safeId = e(session.id);
	    const completionAttentionCount = (session.reviewerReport?.findings ?? []).filter((f) => f.level === 'attention').length;
	    const completionSummaryText = completionAttentionCount > 0
	      ? `${completionAttentionCount} 项要看一眼`
	      : '未见高优复盘点';
	    const completionSummaryClass = completionAttentionCount > 0 ? 'is-attention' : 'is-ok';
	    const chainForSkill = skillChains[session.skillName];
	    const runtimeIssues: string[] = [];
	    if (chainForSkill) {
	      if (!chainForSkill.healthCheck.hardRules.declared) runtimeIssues.push('未标准化规则声明');
	      if (!chainForSkill.healthCheck.workflows.declared) runtimeIssues.push('未标准化流程声明');
	    }
	    if (indicators.toolFailureCount > 0) runtimeIssues.push(`工具失败 ${indicators.toolFailureCount} 次`);
	    const runtimeSummaryText = runtimeIssues.length > 0 ? runtimeIssues.join(' · ') : '运行指标无异常';
	    const runtimeSummaryClass = runtimeIssues.length > 0 ? 'is-attention' : 'is-ok';
	    const flowSummaryText = siblings.length > 1 ? `${siblings.length} 个能力调用段` : '单一能力调用段';
	    const flowTemplateId = `inbox-flow-template-${safeId}`;
	    const evidenceSummaryText = `工具 ${indicators.toolCallCount} · 失败 ${indicators.toolFailureCount} · 用户消息 ${indicators.userMessageCount}`;
	    const navItems = [
	      { id: `inbox-sec-completion-${safeId}`, label: '① 这次跑得怎么样' },
	      { id: `inbox-sec-log-chain-${safeId}`, label: '② 日志上下游链路' },
	      { id: `inbox-sec-runtime-${safeId}`, label: '③ 流程规则执行细节' },
	      { id: `inbox-sec-runtime-metrics-${safeId}`, label: '3.1 指标汇总', sub: true },
	      { id: `inbox-sec-runtime-rules-${safeId}`, label: '3.2 流程规则命中', sub: true },
	      { id: `inbox-sec-evidence-${safeId}`, label: '④ 原文回溯' },
	    ];
	    const navHtml = `<nav class="inbox-detail-nav" aria-label="跳到对应版块">${navItems.map((item) => `<a href="#${item.id}" class="${item.sub ? 'is-sub' : ''}" data-inbox-nav onclick="scrollInboxSectionIntoView('${item.id}', event)">${item.label}</a>`).join('')}</nav>`;
	    return `<article class="inbox-session-pane ${isActive ? 'is-active' : ''}" data-session-pane="${safeId}" data-session-search="${e(inboxSessionSearchText(session))}">
	      <div class="inbox-session-meta">
	        <span>Session <code>${e(session.sessionId)}</code></span>
	        <span>执行 ${e(inboxFormatDuration(session.sourceSessionDurationMs))}</span>
	        <span>入口 ${e(inboxEntrypointShort(session))}</span>
	        <span>调用段 ${session.invocationIds.length}</span>
	        <span>工具调用 ${indicators.toolCallCount}</span>
	      </div>
	      ${navHtml}
	      <template id="${flowTemplateId}">${inboxRenderSessionFlow(cardSkillName, session, siblings, flowSummaryText)}</template>
	      <section class="inbox-section" data-inbox-section="completion" id="inbox-sec-completion-${safeId}">
	        <header class="inbox-section-head inbox-section-head-clickable" onclick="toggleInboxSectionHead(this)">
	          <h3>① 这次跑得怎么样</h3>
	          <span class="inbox-section-summary ${completionSummaryClass}">${e(completionSummaryText)}</span>
	          <span class="inbox-section-hint">${e(session.skillName)} 是否满足用户目标 / 是否符合 skill 用途 / 用户感受</span>
	          ${inboxRenderSessionReviewControl(session)}
	          <button type="button" class="inbox-section-toggle" onclick="event.stopPropagation(); toggleInboxSection(this)" aria-label="收起或展开本版块">收起</button>
	        </header>
	        <div class="inbox-section-body">${inboxRenderSkillCompletion(session)}</div>
	      </section>
	      <section class="inbox-section" data-inbox-section="log-chain" id="inbox-sec-log-chain-${safeId}">
	        <header class="inbox-section-head inbox-section-head-clickable" onclick="toggleInboxSectionHead(this)">
	          <h3>② 日志上下游链路</h3>
	          <span class="inbox-section-summary is-neutral">${e((session.sessionStory?.episodes?.length ?? 0) > 0 ? `${session.sessionStory?.episodes?.length ?? 0} 个用户目标切片` : '暂无链路')}</span>
	          <span class="inbox-section-hint">按日志还原用户目标切片、skill 片段和反馈归因</span>
	          <button type="button" class="inbox-section-toggle" onclick="event.stopPropagation(); toggleInboxSection(this)" aria-label="收起或展开本版块">收起</button>
	        </header>
	        <div class="inbox-section-body">${inboxRenderEpisodeOverview(session)}</div>
	      </section>
	      <section class="inbox-section" data-inbox-section="runtime" id="inbox-sec-runtime-${safeId}">
	        <header class="inbox-section-head inbox-section-head-clickable" onclick="toggleInboxSectionHead(this)">
	          <h3>③ 流程规则执行细节</h3>
	          <span class="inbox-section-summary ${runtimeSummaryClass}">${e(runtimeSummaryText)}</span>
	          <span class="inbox-section-hint">查看运行指标和能力定义链路</span>
	          <button type="button" class="inbox-section-toggle" onclick="event.stopPropagation(); toggleInboxSection(this)" aria-label="收起或展开本版块">收起</button>
	        </header>
	        <div class="inbox-section-body">${inboxRenderSkillRuntime(session)}</div>
	      </section>
	      ${inboxRenderEvidence(session, evidenceSummaryText)}
	    </article>`;
	  };
	  const inboxDetail = (card: InboxSkillCard, index: number): string => {
	    const safeSkill = e(card.skillName);
	    const inboxSessionTabBadges = (session: ExperienceSessionSummary): string => {
	      const labels = inboxSessionAttentionFindingLabels(session);
	      if (labels.length === 0) return '';
	      return `<span class="inbox-session-tab-alerts" title="${e(labels.join(' / '))}">${labels.map((label) => `<span>${e(label)}</span>`).join('')}</span>`;
	    };
	    const sessionTabs = card.sessions.length > 0
	      ? `<div class="inbox-session-tabs" role="tablist" aria-label="切换 ${e(card.skillName)} 的调用记录">${card.sessions.map((s, i) => {
	          const label = inboxFormatSessionLabel(s);
	          const flowTemplateId = `inbox-flow-template-${e(s.id)}`;
	          const resolvedPriority = inboxResolvedPriority(s);
	          const priorityCls = resolvedPriority === 'review_first' ? 'is-priority-high' : resolvedPriority === 'sample_review' ? 'is-priority-medium' : 'is-priority-low';
	          return `<span class="inbox-session-tab-item" data-session-tab-item="${e(s.id)}" data-session-search="${e(inboxSessionSearchText(s))}">
	            <button type="button" class="inbox-session-tab ${priorityCls} ${i === 0 ? 'is-active' : ''}" data-session-tab="${e(s.id)}" onclick="selectInboxSessionTab('${safeSkill}', '${e(s.id)}', this)" title="${e(s.sessionId)}">${e(label)}</button>
	            <button type="button" class="inbox-session-flow-chip" onclick="openInboxSessionFlowPopover('${flowTemplateId}', this, event)" title="查看这条 session 的执行过程">查看过程</button>
	            ${inboxSessionTabBadges(s)}
	          </span>`;
	        }).join('')}</div>`
	      : '';
	    return `<article class="inbox-detail-pane ${index === 0 ? 'is-active' : ''}" data-inbox-detail="${safeSkill}">
	      ${inboxRenderSkillActionSummary(card.sessions)}
	      ${sessionTabs}
	      <div class="inbox-session-panes">${card.sessions.map((s, i) => inboxRenderSessionContent(card.skillName, s, i === 0)).join('')}</div>
	    </article>`;
	  };
	  const inboxCardListHtml = inboxSkillCards.length === 0
	    ? `<li class="inbox-card-empty">没有可展示的观测记录。</li>`
	    : inboxSkillCards.map((card, index) => inboxCard(card, index)).join('');
	  const inboxDetailListHtml = inboxSkillCards.length === 0
	    ? `<article class="inbox-detail-pane is-active inbox-detail-empty-pane">运行 omk observe ingest &lt;sessions-dir&gt; 后这里会展示完整复盘报告。</article>`
	    : inboxSkillCards.map((card, index) => inboxDetail(card, index)).join('');
	  const experienceSection = experience ? `
	    <section class="inbox-shell">
	      <header class="inbox-topbar">
	        <div class="inbox-topbar-meta">
	          <span>${inboxTotalCount} 条复盘</span>
	          <span>${reportSessionCount} 个 session · ${totalSkillInvocations} 次能力调用</span>
	          <span>最近 ingest ${e(latestSeenLabel)}</span>
	        </div>
	        <div class="inbox-chip-bar" role="tablist" aria-label="按状态筛选">
	          <button type="button" class="inbox-chip is-active" data-inbox-filter="all" onclick="setInboxFilter('all', this)">全部 ${inboxTotalCount}</button>
	          <button type="button" class="inbox-chip" data-inbox-filter="review_first" onclick="setInboxFilter('review_first', this)">要看一眼 ${inboxReviewFirstCount}</button>
	          <button type="button" class="inbox-chip" data-inbox-filter="sample_review" onclick="setInboxFilter('sample_review', this)">抽样 ${inboxSampleCount}</button>
	          <button type="button" class="inbox-chip" data-inbox-filter="reviewed" onclick="setInboxFilter('reviewed', this)">已处理 ${inboxReviewedCount}</button>
	        </div>
	        <div class="inbox-search-bar" role="search" aria-label="搜索复盘报告">
	          <label class="inbox-search-field">Skill 搜索
	            <input type="search" data-inbox-skill-search-input placeholder="输入 skill 名 / 目标 / 结论" oninput="applyInboxFilters()">
	          </label>
	          <label class="inbox-search-field">Session 搜索
	            <input type="search" data-inbox-session-search-input placeholder="输入 session id / 入口 / 时间 / 用户目标" oninput="applyInboxFilters()">
	          </label>
	          <button type="button" class="inbox-search-clear" onclick="clearInboxSearch()">清空</button>
	          <span class="inbox-search-count" data-inbox-search-count>${inboxTotalCount} 条复盘</span>
	        </div>
	      </header>
	      <div class="inbox-split">
	        <aside class="inbox-left" aria-label="观测记录列表">
	          <ul class="inbox-card-list" data-inbox-card-list>${inboxCardListHtml}</ul>
	        </aside>
	        <section class="inbox-right" aria-label="观测记录详情"><div class="inbox-no-results" data-inbox-no-results style="display:none">没有匹配的复盘记录。</div>${inboxDetailListHtml}</section>
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
          <div style="color:var(--text-muted);font-size:12px">${reportSessionCount} sessions · ${totalSkillInvocations} skill 调用 · ${allItems.length} 过程发现</div>
          <div style="color:var(--text-muted);font-size:12px">${e(sessionTimeLabel)}: ${e(reportSessionRangeLabel)}</div>
          <div style="color:var(--text-muted);font-size:12px">${reportCount} reports · latest ${e(latestSeenLabel)}</div>
          <div style="color:var(--text-muted);font-size:12px">当前只展示最新一次 ingest 的结果</div>
        </div>
      </section>`;
	  return layout(pageTitle, `
	    <main class="observe-report-root">
	      <nav style="margin-bottom:12px"><a href="/observe-health" style="color:var(--accent);text-decoration:none">${lang === 'zh' ? '能力健康度日报' : 'Skill health reports'}</a></nav>
	      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:8px 0">
	        <div>
	          <h1 style="font-size:22px;margin:0">${activeSkill ? `观测收件箱 · ${e(activeSkill)}` : '观测收件箱'}</h1>
	          ${activeSkill ? `<div style="color:var(--text-muted);font-size:12px;margin-top:4px">当前只展示能力 ${e(activeSkill)} 的复盘记录。</div>` : ''}
	        </div>
	        ${activeSkill ? `<a href="/observe-inbox" style="color:var(--accent);text-decoration:none;font-size:13px">查看全量</a>` : ''}
	      </div>
      <style>${OBSERVATION_INBOX_STYLES}</style>
      <div id="signal-global-tooltip" role="tooltip"></div>
      <div id="timeline-fulltext-tooltip" role="dialog" aria-modal="true" aria-hidden="true" aria-label="时间线消息详情"></div>
      <div id="experience-detail-modal" role="dialog" aria-modal="true" aria-hidden="true" aria-label="Session 回溯详情"></div>
      <aside id="inbox-metric-popover" role="dialog" aria-modal="false" aria-hidden="true" aria-label="指标详情"></aside>
      <div id="metric-guide-toolbar" aria-label="指标说明工具栏">
        <button type="button" title="指标说明" aria-label="指标说明" onclick="window.toggleMetricGuide && window.toggleMetricGuide()">?</button>
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
            <h2 style="font-size:15px;margin:0;color:var(--text-primary)">Skill 观测看板</h2>
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
        var inboxCurrentFilter = 'all';
        function selectInboxCard(id, el) {
          if (window.closeInboxSessionFlowPopover) window.closeInboxSessionFlowPopover();
          var cards = document.querySelectorAll('[data-inbox-card]');
          for (var i = 0; i < cards.length; i++) cards[i].classList.remove('is-active');
          if (el) el.classList.add('is-active');
          var panes = document.querySelectorAll('[data-inbox-detail]');
          var activePane = null;
          for (var j = 0; j < panes.length; j++) {
            var pane = panes[j];
            if (pane.getAttribute('data-inbox-detail') === id) {
              pane.classList.add('is-active');
              activePane = pane;
            } else {
              pane.classList.remove('is-active');
            }
          }
          if (activePane) applyInboxSessionSearchForPane(activePane);
          var right = document.querySelector('.inbox-right');
          if (right) right.scrollTop = 0;
        }
        function selectInboxCardById(id, sessionId) {
          var card = document.querySelector('[data-inbox-card="' + id + '"]');
          if (card) {
            selectInboxCard(id, card);
            if (sessionId) selectInboxSessionTab(id, sessionId);
            if (card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
          }
        }
        window.selectInboxCardById = selectInboxCardById;
        function closeInboxSessionFlowPopover() {
          var old = document.querySelector('.inbox-flow-popover');
          if (old) old.remove();
        }
        function openInboxSessionFlowPopover(templateId, btn, event) {
          if (event) {
            event.preventDefault();
            event.stopPropagation();
          }
          closeInboxSessionFlowPopover();
          var template = document.getElementById(templateId);
          if (!template) return;
          var popover = document.createElement('div');
          popover.className = 'inbox-flow-popover';
          popover.setAttribute('role', 'dialog');
          popover.innerHTML = '<button type="button" class="inbox-flow-popover-close" onclick="closeInboxSessionFlowPopover()">关闭</button>' + template.innerHTML;
          document.body.appendChild(popover);
          var rect = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : { left: 16, bottom: 48, right: 16 };
          var width = Math.min(560, window.innerWidth - 32);
          var left = Math.min(Math.max(16, rect.right - width), window.innerWidth - width - 16);
          var top = Math.min(rect.bottom + 8, window.innerHeight - Math.min(popover.offsetHeight || 620, 620) - 16);
          popover.style.left = left + 'px';
          popover.style.top = Math.max(16, top) + 'px';
        }
        window.closeInboxSessionFlowPopover = closeInboxSessionFlowPopover;
        window.openInboxSessionFlowPopover = openInboxSessionFlowPopover;
        function toggleInboxSection(btn) {
          var sec = btn.closest('.inbox-section');
          if (!sec) return;
          var collapsed = sec.classList.toggle('is-collapsed');
          var label = sec.querySelector('.inbox-section-toggle');
          if (label) label.textContent = collapsed ? '展开' : '收起';
        }
        function toggleInboxSectionHead(head) {
          var sec = head && head.closest ? head.closest('.inbox-section') : null;
          if (!sec) return;
          var collapsed = sec.classList.toggle('is-collapsed');
          var label = sec.querySelector('.inbox-section-toggle');
          if (label) label.textContent = collapsed ? '展开' : '收起';
        }
        function findInboxSectionById(id) {
          var activePane = document.querySelector('.inbox-detail-pane.is-active .inbox-session-pane.is-active');
          if (activePane) {
            var nodes = activePane.querySelectorAll('[id]');
            for (var i = 0; i < nodes.length; i++) {
              if (nodes[i].getAttribute('id') === id) return nodes[i];
            }
          }
          return document.getElementById(id);
        }
        function scrollInboxSectionIntoView(id, event) {
          if (event) event.preventDefault();
          var sec = findInboxSectionById(id);
          if (!sec) return;
          if (sec.tagName === 'DETAILS' && !sec.open) sec.open = true;
          var parentSection = sec.classList && sec.classList.contains('inbox-section') ? sec : (sec.closest ? sec.closest('.inbox-section') : null);
          if (parentSection && parentSection.classList.contains('is-collapsed')) {
            parentSection.classList.remove('is-collapsed');
            var toggle = parentSection.querySelector('.inbox-section-toggle');
            if (toggle) toggle.textContent = '收起';
          }
          var parentDetails = sec.closest ? sec.closest('details') : null;
          if (parentDetails && !parentDetails.open) parentDetails.open = true;
          var right = sec.closest ? sec.closest('.inbox-right') : document.querySelector('.inbox-right');
          var canScrollRight = right && right.scrollHeight > right.clientHeight + 8 && window.getComputedStyle(right).overflowY !== 'visible';
          if (canScrollRight) {
            var rect = sec.getBoundingClientRect();
            var rightRect = right.getBoundingClientRect();
            right.scrollTop += rect.top - rightRect.top - 8;
          } else {
            var top = sec.getBoundingClientRect().top + (window.pageYOffset || document.documentElement.scrollTop || 0) - 88;
            window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
          }
          var activeDetail = sec.closest ? sec.closest('.inbox-detail-pane') : null;
          var navs = activeDetail ? activeDetail.querySelectorAll('[data-inbox-nav]') : document.querySelectorAll('[data-inbox-nav]');
          for (var i = 0; i < navs.length; i++) {
            var match = navs[i].getAttribute('href') === '#' + id;
            if (match) navs[i].classList.add('is-active');
            else navs[i].classList.remove('is-active');
          }
        }
        function inboxJumpToEvidence(btn) {
          var pane = btn && btn.closest ? btn.closest('.inbox-detail-pane') : null;
          if (!pane) return;
          var sessionPane = btn.closest ? btn.closest('[data-session-pane]') : null;
          var sid = sessionPane ? sessionPane.getAttribute('data-session-pane') : pane.getAttribute('data-inbox-detail');
          if (sid) scrollInboxSectionIntoView('inbox-sec-evidence-' + sid);
          var messageUuid = btn.getAttribute('data-jump-message-uuid') || '';
          var messageIndex = btn.getAttribute('data-jump-message-index') || '';
          if (!messageUuid && !messageIndex) return;
          window.setTimeout(function () {
            var rows = pane.querySelectorAll('[data-message-uuid]');
            for (var i = 0; i < rows.length; i++) {
              var row = rows[i];
              if (messageUuid && row.getAttribute('data-message-uuid') === messageUuid) {
                row.scrollIntoView({ block: 'center' });
                row.classList.add('is-flash');
                window.setTimeout(function () { row.classList.remove('is-flash'); }, 1600);
                return;
              }
              if (!messageUuid && messageIndex && row.getAttribute('data-message-index') === messageIndex) {
                row.scrollIntoView({ block: 'center' });
                row.classList.add('is-flash');
                window.setTimeout(function () { row.classList.remove('is-flash'); }, 1600);
                return;
              }
            }
          }, 240);
        }
        window.toggleInboxSection = toggleInboxSection;
        window.toggleInboxSectionHead = toggleInboxSectionHead;
        window.scrollInboxSectionIntoView = scrollInboxSectionIntoView;
        window.inboxJumpToEvidence = inboxJumpToEvidence;
        function selectInboxSessionTab(skillName, sessionId, btn) {
          if (window.closeInboxSessionFlowPopover) window.closeInboxSessionFlowPopover();
          var pane = document.querySelector('[data-inbox-detail="' + skillName + '"]');
          if (!pane) return;
          var tabs = pane.querySelectorAll('[data-session-tab]');
          for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].getAttribute('data-session-tab') === sessionId) tabs[i].classList.add('is-active');
            else tabs[i].classList.remove('is-active');
          }
          var panes = pane.querySelectorAll('[data-session-pane]');
          for (var j = 0; j < panes.length; j++) {
            if (panes[j].getAttribute('data-session-pane') === sessionId) panes[j].classList.add('is-active');
            else panes[j].classList.remove('is-active');
          }
        }
        window.selectInboxSessionTab = selectInboxSessionTab;
        function openInboxMetricPopover(card) {
          var popover = document.getElementById('inbox-metric-popover');
          if (!popover) return;
          var label = card.getAttribute('data-metric-label') || '';
          var value = card.getAttribute('data-metric-value') || '0';
          var note = card.getAttribute('data-metric-note') || '';
          var anomaly = card.getAttribute('data-metric-anomaly') === '1';
          var jumpId = card.getAttribute('data-metric-jump') || '';
          var detail = [];
          try { detail = JSON.parse(card.getAttribute('data-metric-detail') || '[]'); } catch (err) { detail = []; }
          var html = '<header class="inbox-metric-popover-head"><strong></strong><button type="button" class="inbox-metric-popover-close" aria-label="关闭">关闭</button></header>';
          html += '<div class="inbox-metric-popover-body">';
          html += '<div class="inbox-metric-popover-value' + (anomaly ? ' is-anomaly' : '') + '"></div>';
          html += '<p class="inbox-metric-popover-note"></p>';
          if (detail && detail.length > 0) {
            html += '<ul class="inbox-metric-popover-list"></ul>';
          }
          if (anomaly && jumpId) {
            html += '<button type="button" class="inbox-metric-popover-jump" data-jump-target="' + jumpId + '">跳转原文回溯</button>';
          }
          html += '</div>';
          popover.innerHTML = html;
          popover.querySelector('.inbox-metric-popover-head strong').textContent = label;
          popover.querySelector('.inbox-metric-popover-value').textContent = value;
          popover.querySelector('.inbox-metric-popover-note').textContent = note;
          var list = popover.querySelector('.inbox-metric-popover-list');
          if (list && detail.length > 0) {
            for (var i = 0; i < detail.length; i++) {
              var li = document.createElement('li');
              var n = document.createElement('span');
              n.textContent = detail[i].name;
              var c = document.createElement('span');
              c.textContent = detail[i].count;
              li.appendChild(n);
              li.appendChild(c);
              list.appendChild(li);
            }
          }
          popover.classList.add('is-open');
          popover.setAttribute('aria-hidden', 'false');
          var closeBtn = popover.querySelector('.inbox-metric-popover-close');
          if (closeBtn) closeBtn.addEventListener('click', closeInboxMetricPopover);
          var jumpBtn = popover.querySelector('.inbox-metric-popover-jump');
          if (jumpBtn) jumpBtn.addEventListener('click', function () {
            var id = jumpBtn.getAttribute('data-jump-target');
            if (id) scrollInboxSectionIntoView(id);
            closeInboxMetricPopover();
          });
        }
        function closeInboxMetricPopover() {
          var popover = document.getElementById('inbox-metric-popover');
          if (!popover) return;
          popover.classList.remove('is-open');
          popover.setAttribute('aria-hidden', 'true');
          popover.innerHTML = '';
        }
        document.addEventListener('click', function (event) {
          var target = event.target;
          if (target && target.closest && (target.closest('.inbox-metric-card') || target.closest('#inbox-metric-popover'))) return;
          var popover = document.getElementById('inbox-metric-popover');
          if (popover && popover.classList.contains('is-open')) closeInboxMetricPopover();
        });
        document.addEventListener('keydown', function (event) {
          if (event.key === 'Escape') closeInboxMetricPopover();
        });
        window.openInboxMetricPopover = openInboxMetricPopover;
        window.closeInboxMetricPopover = closeInboxMetricPopover;
        function inboxNormalizeSearch(value) {
          return String(value || '').trim().toLowerCase();
        }
        function inboxSearchInput(selector) {
          var input = document.querySelector(selector);
          return input ? inboxNormalizeSearch(input.value) : '';
        }
        function inboxTextMatches(text, query) {
          if (!query) return true;
          return inboxNormalizeSearch(text).indexOf(query) >= 0;
        }
        function activeInboxSearch() {
          return {
            skill: inboxSearchInput('[data-inbox-skill-search-input]'),
            session: inboxSearchInput('[data-inbox-session-search-input]')
          };
        }
        function inboxCardMatchesCurrentSearch(card, search) {
          var filters = (card.getAttribute('data-inbox-filters') || '').split(/\\s+/);
          var filterMatch = filters.indexOf(inboxCurrentFilter) >= 0;
          var skillMatch = inboxTextMatches(card.getAttribute('data-inbox-skill-search') || card.getAttribute('data-inbox-card') || '', search.skill);
          var sessionMatch = inboxTextMatches(card.getAttribute('data-inbox-session-search') || '', search.session);
          return filterMatch && skillMatch && sessionMatch;
        }
        function setInboxNoResultVisible(visible) {
          var empty = document.querySelector('[data-inbox-no-results]');
          if (empty) empty.style.display = visible ? '' : 'none';
        }
        function updateInboxSearchCount(visibleCount, totalCount) {
          var el = document.querySelector('[data-inbox-search-count]');
          if (!el) return;
          var search = activeInboxSearch();
          var searching = Boolean(search.skill || search.session || inboxCurrentFilter !== 'all');
          el.textContent = searching ? visibleCount + ' / ' + totalCount + ' 条复盘' : totalCount + ' 条复盘';
        }
        function clearInboxActiveSelection() {
          var cards = document.querySelectorAll('[data-inbox-card]');
          for (var i = 0; i < cards.length; i++) cards[i].classList.remove('is-active');
          var panes = document.querySelectorAll('[data-inbox-detail]');
          for (var j = 0; j < panes.length; j++) panes[j].classList.remove('is-active');
        }
        function applyInboxSessionSearchForPane(pane) {
          if (!pane) return;
          var query = inboxSearchInput('[data-inbox-session-search-input]');
          var tabItems = pane.querySelectorAll('[data-session-tab-item]');
          var sessionPanes = pane.querySelectorAll('[data-session-pane]');
          var firstVisibleTab = null;
          var activeVisible = null;
          for (var i = 0; i < tabItems.length; i++) {
            var item = tabItems[i];
            var text = item.getAttribute('data-session-search') || '';
            var visible = inboxTextMatches(text, query);
            item.style.display = visible ? '' : 'none';
            var tab = item.querySelector('[data-session-tab]');
            if (visible && !firstVisibleTab) firstVisibleTab = tab;
            if (visible && tab && tab.classList.contains('is-active')) activeVisible = tab;
          }
          for (var j = 0; j < sessionPanes.length; j++) {
            var sessionPane = sessionPanes[j];
            var paneText = sessionPane.getAttribute('data-session-search') || '';
            var paneVisible = inboxTextMatches(paneText, query);
            sessionPane.style.display = paneVisible ? '' : 'none';
            if (!paneVisible) sessionPane.classList.remove('is-active');
          }
          var nextTab = activeVisible || firstVisibleTab;
          if (nextTab) {
            selectInboxSessionTab(pane.getAttribute('data-inbox-detail') || '', nextTab.getAttribute('data-session-tab'), nextTab);
          }
        }
        function applyInboxFilters() {
          var cards = document.querySelectorAll('[data-inbox-card]');
          var search = activeInboxSearch();
          var firstVisible = null;
          var activeVisible = null;
          var visibleCount = 0;
          for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            var visible = inboxCardMatchesCurrentSearch(card, search);
            card.style.display = visible ? '' : 'none';
            if (visible) {
              visibleCount += 1;
              if (!firstVisible) firstVisible = card;
              if (card.classList.contains('is-active')) activeVisible = card;
            }
          }
          updateInboxSearchCount(visibleCount, cards.length);
          setInboxNoResultVisible(visibleCount === 0);
          if (visibleCount === 0) {
            clearInboxActiveSelection();
            return;
          }
          selectInboxCard((activeVisible || firstVisible).getAttribute('data-inbox-card'), activeVisible || firstVisible);
        }
        function clearInboxSearch() {
          var skill = document.querySelector('[data-inbox-skill-search-input]');
          var session = document.querySelector('[data-inbox-session-search-input]');
          if (skill) skill.value = '';
          if (session) session.value = '';
          applyInboxFilters();
        }
        function setInboxFilter(filter, btn) {
          inboxCurrentFilter = filter;
          var chips = document.querySelectorAll('[data-inbox-filter]');
          for (var i = 0; i < chips.length; i++) {
            var active = chips[i].getAttribute('data-inbox-filter') === filter;
            if (active) chips[i].classList.add('is-active');
            else chips[i].classList.remove('is-active');
          }
          applyInboxFilters();
        }
        window.applyInboxFilters = applyInboxFilters;
        window.clearInboxSearch = clearInboxSearch;
        async function setInboxSessionReview(sessionId, verdict, btn) {
          var actionBlock = document.querySelector('[data-inbox-detail-actions][data-inbox-session-id="' + sessionId + '"]');
          var note = '';
          if (verdict === 'needs_more_context') {
            var input = document.querySelector('[data-inbox-note-input="' + sessionId + '"]');
            note = input ? input.value : '';
          }
          try {
            var payload = { targetType: 'experience_session', targetId: sessionId, verdict: verdict };
            if (note) payload.reason = note;
            var resp = await fetch('/api/observations/review-state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (!resp.ok) throw new Error('failed');
            if (actionBlock) {
              var buttons = actionBlock.querySelectorAll('.inbox-action-button');
              for (var i = 0; i < buttons.length; i++) {
                if (buttons[i].getAttribute('data-inbox-verdict') === verdict) buttons[i].classList.add('is-active');
                else buttons[i].classList.remove('is-active');
              }
              var summary = actionBlock.querySelector('.inbox-section-review-button');
              if (summary) summary.textContent = '人工标注(1)';
            }
            var currentPane = actionBlock && actionBlock.closest ? actionBlock.closest('[data-inbox-detail]') : null;
            var cardId = currentPane ? currentPane.getAttribute('data-inbox-detail') : sessionId;
            var card = document.querySelector('[data-inbox-card="' + cardId + '"]');
            if (card) {
              var filters = (card.getAttribute('data-inbox-filters') || '').split(/\\s+/);
              if (filters.indexOf('reviewed') < 0) filters.push('reviewed');
              card.setAttribute('data-inbox-filters', filters.join(' '));
              var existing = card.querySelector('.inbox-card-state');
              if (existing) existing.remove();
              var labels = { real_issue: { label: '已同意', cls: 'is-agree' }, not_issue: { label: '已否决', cls: 'is-reject' }, needs_more_context: { label: '留意见', cls: 'is-note' } };
              var meta = labels[verdict];
              if (meta) {
                var span = document.createElement('span');
                span.className = 'inbox-card-state ' + meta.cls;
                span.textContent = meta.label;
                var titleRow = card.querySelector('.inbox-card-row-title');
                if (titleRow) titleRow.appendChild(span);
              }
            }
          } catch (err) {
            if (window.console) console.error('inbox review failed', err);
          }
        }
        function toggleInboxNoteEditor(sessionId, btn) {
          var editor = document.querySelector('[data-inbox-note-editor="' + sessionId + '"]');
          if (!editor) return;
          editor.style.display = 'block';
          var input = editor.querySelector('textarea');
          if (input) input.focus();
        }
        function closeInboxNoteEditor(sessionId) {
          var editor = document.querySelector('[data-inbox-note-editor="' + sessionId + '"]');
          if (editor) editor.style.display = 'none';
        }
        function saveInboxSessionNote(sessionId, btn) {
          setInboxSessionReview(sessionId, 'needs_more_context', btn);
        }
        window.selectInboxCard = selectInboxCard;
        window.setInboxFilter = setInboxFilter;
        window.setInboxSessionReview = setInboxSessionReview;
        window.toggleInboxNoteEditor = toggleInboxNoteEditor;
        window.closeInboxNoteEditor = closeInboxNoteEditor;
        window.saveInboxSessionNote = saveInboxSessionNote;
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
          if (window.closeGoalSliceCorrectionPopovers) window.closeGoalSliceCorrectionPopovers();
          modal.classList.remove('is-open');
          modal.setAttribute('aria-hidden', 'true');
          modal.innerHTML = '';
        }
        function openExperienceDetailModal(id, btn, initialTab) {
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
            if (initialTab) switchExperienceDetailTab(initialTab);
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
        function switchExperienceDetailTab(name) {
          var modal = document.getElementById('experience-detail-modal');
          if (!modal) return;
          var buttons = modal.querySelectorAll('[data-experience-detail-tab]');
          var panels = modal.querySelectorAll('[data-experience-detail-panel]');
          if (!buttons.length || !panels.length) return;
          for (var i = 0; i < buttons.length; i++) {
            var activeButton = buttons[i].getAttribute('data-experience-detail-tab') === name;
            buttons[i].classList.toggle('is-active', activeButton);
            buttons[i].setAttribute('aria-selected', activeButton ? 'true' : 'false');
          }
          for (var j = 0; j < panels.length; j++) {
            panels[j].classList.toggle('is-active', panels[j].getAttribute('data-experience-detail-panel') === name);
          }
          if (name === 'evidence') {
            window.requestAnimationFrame(function () {
              if (window.refreshTimelineFullTextState) window.refreshTimelineFullTextState();
            });
          }
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
          var toolbar = root.closest ? root.closest('.experience-detail-right') : null;
          var select = toolbar ? toolbar.querySelector('[data-timeline-tag-filter]') : null;
          if (select) filterTimelineByTag(select);
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
            var select = root.querySelector('[data-timeline-tag-filter]');
            if (select) filterTimelineByTag(select);
            if (window.refreshTimelineFullTextState) window.refreshTimelineFullTextState();
          });
        }
        function filterTimelineByTag(select) {
          var root = select && select.closest ? select.closest('.experience-detail-right') : null;
          if (!root) root = document;
          var value = select ? String(select.value || '') : '';
          var rows = root.querySelectorAll('.timeline-row');
          var markers = root.querySelectorAll('.timeline-window-marker');
          var count = 0;
          for (var i = 0; i < rows.length; i++) {
            var tags = String(rows[i].getAttribute('data-timeline-tags') || '').split(/\\s+/);
            var match = !value || tags.indexOf(value) !== -1;
            rows[i].classList.toggle('is-filter-hidden', !match);
            rows[i].classList.toggle('is-filter-match', Boolean(value && match));
            if (match && value) count += 1;
          }
          for (var j = 0; j < markers.length; j++) {
            markers[j].style.display = value ? 'none' : '';
          }
          var text = root.querySelector('[data-timeline-filter-count]');
          if (text) text.textContent = value ? ('命中 ' + count + ' 条；只统计当前 skill 相关标签。') : '选择标签后，只显示当前回溯里的命中事件。';
        }
        function findExperienceTimelineRow(root, messageIndex, messageUuid) {
          if (!root) return null;
          var rows = root.querySelectorAll('.timeline-row');
          if (messageUuid) {
            for (var i = 0; i < rows.length; i++) {
              if (rows[i].getAttribute('data-message-uuid') === messageUuid) return rows[i];
            }
          }
          if (messageIndex !== '') {
            for (var j = 0; j < rows.length; j++) {
              if (rows[j].getAttribute('data-message-index') === String(messageIndex)) return rows[j];
            }
          }
          return null;
        }
        function focusExperienceTimelineRow(row) {
          if (!row) return;
          var fullView = row.closest ? row.closest('[data-timeline-view="full-session"]') : null;
          if (fullView && fullView.style.display === 'none') {
            var right = fullView.closest ? fullView.closest('.experience-detail-right') : null;
            var toggle = right ? right.querySelector('[data-full-session-toggle]') : null;
            if (toggle) toggleFullSessionTimeline(toggle);
          }
          var panel = row.closest ? row.closest('.timeline-tab-panel') : null;
          if (panel && !panel.classList.contains('is-active')) {
            var tabsRoot = panel.closest('[data-timeline-tabs]');
            var base = tabsRoot ? tabsRoot.getAttribute('data-timeline-tabs') : '';
            var panelId = panel.getAttribute('data-timeline-panel') || '';
            if (base && panelId.indexOf(base + '-') === 0) {
              var index = Number(panelId.slice(base.length + 1));
              if (!Number.isNaN(index)) switchTimelineGoalTab(base, index);
            }
          }
          window.requestAnimationFrame(function () {
            row.classList.add('is-cta-focus');
            if (row.scrollIntoView) row.scrollIntoView({ block: 'center', inline: 'nearest' });
            var scrollPanel = row.closest ? (row.closest('.timeline-tab-panel') || row.closest('.session-timeline-tree') || row.closest('.experience-detail-tab-panel')) : null;
            if (scrollPanel && typeof row.offsetTop === 'number') {
              scrollPanel.scrollTop = Math.max(0, row.offsetTop - 80);
            }
            window.setTimeout(function () { row.classList.remove('is-cta-focus'); }, 1800);
          });
        }
        function jumpToExperienceMessage(btn) {
          var modal = document.getElementById('experience-detail-modal');
          if (!modal || !btn) return;
          switchExperienceDetailTab('evidence');
          window.requestAnimationFrame(function () {
            var evidencePanel = modal.querySelector('[data-experience-detail-panel="evidence"]') || modal;
            var messageIndex = btn.getAttribute('data-jump-message-index') || '';
            var messageUuid = btn.getAttribute('data-jump-message-uuid') || '';
            var segmentView = evidencePanel.querySelector('[data-timeline-view="segment"]');
            var row = findExperienceTimelineRow(segmentView, messageIndex, messageUuid) || findExperienceTimelineRow(evidencePanel, messageIndex, messageUuid);
            focusExperienceTimelineRow(row);
          });
        }
        function openExperienceSessionById(sessionId, tag) {
          if (!sessionId) return;
          var rows = document.querySelectorAll('[data-observe-experience-session]');
          var row = null;
          for (var i = 0; i < rows.length; i++) {
            if (rows[i].getAttribute('data-experience-session-id') === sessionId) {
              row = rows[i];
              break;
            }
          }
          if (!row) return;
          var details = row.closest ? row.closest('details') : null;
          if (details) details.open = true;
          var top = row.getBoundingClientRect().top + window.pageYOffset - 90;
          window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
          var button = row.querySelector('[data-open-experience-detail]');
          if (button) button.click();
          window.setTimeout(function () {
            var modal = document.getElementById('experience-detail-modal');
            if (!modal || !modal.classList.contains('is-open')) return;
            if (tag) switchExperienceDetailTab('evidence');
            var evidencePanel = modal.querySelector('[data-experience-detail-panel="evidence"]') || modal;
            var select = evidencePanel.querySelector('[data-timeline-tag-filter]');
            if (select && tag) {
              select.value = tag;
              filterTimelineByTag(select);
            }
            var target = tag ? evidencePanel.querySelector('.timeline-row.is-filter-match') : evidencePanel.querySelector('.timeline-row');
            if (!target) return;
            focusExperienceTimelineRow(target);
          }, 160);
        }
        window.openExperienceDetailModal = openExperienceDetailModal;
        window.openContextChainModal = openContextChainModal;
        window.closeExperienceDetailModal = closeExperienceDetailModal;
        window.switchExperienceDetailTab = switchExperienceDetailTab;
        window.setReviewerJudgmentReview = setReviewerJudgmentReview;
        window.openReviewerJudgmentNote = openReviewerJudgmentNote;
        window.setSoftStandardStatus = setSoftStandardStatus;
        window.switchTimelineGoalTab = switchTimelineGoalTab;
        window.toggleFullSessionTimeline = toggleFullSessionTimeline;
        window.filterTimelineByTag = filterTimelineByTag;
        window.jumpToExperienceMessage = jumpToExperienceMessage;
        window.openExperienceSessionById = openExperienceSessionById;
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
        document.addEventListener('click', function (event) {
          var target = event.target;
          var trigger = target && target.closest ? target.closest('[data-open-experience-session]') : null;
          if (!trigger) return;
          event.preventDefault();
          event.stopPropagation();
          openExperienceSessionById(trigger.getAttribute('data-open-experience-session'), trigger.getAttribute('data-open-timeline-tag') || '');
        });
        // 复制 advisory 命令到剪贴板：data-copy-source 上挂命令文本。
        document.addEventListener('click', function (event) {
          var target = event.target;
          var btn = target && target.closest ? target.closest('[data-copy-source]') : null;
          if (!btn) return;
          event.preventDefault();
          event.stopPropagation();
          var cmd = btn.getAttribute('data-copy-source') || '';
          var done = function () {
            var prev = btn.textContent;
            btn.classList.add('is-copied');
            btn.textContent = '已复制';
            setTimeout(function () {
              btn.classList.remove('is-copied');
              btn.textContent = prev;
            }, 1500);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(cmd).then(done).catch(function () {
              fallbackCopy(cmd); done();
            });
          } else {
            fallbackCopy(cmd); done();
          }
        });
        function fallbackCopy(text) {
          try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          } catch (err) {}
        }
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
        function reviewerJudgmentLabel(verdict) {
          if (verdict === 'real_issue') return '已同意';
          if (verdict === 'not_issue') return '已否决';
          if (verdict === 'needs_more_context') return '已留意见';
          if (verdict === 'reviewed') return '已看过';
          return '未标注';
        }
        function updateReviewerJudgmentUi(targetId, verdict, reason) {
          var cards = document.querySelectorAll('[data-reviewer-judgment-id="' + targetId.replace(/"/g, '\\"') + '"]');
          for (var i = 0; i < cards.length; i++) {
            var review = cards[i].querySelector('[data-reviewer-judgment-current]');
            if (!review) continue;
            review.setAttribute('data-reviewer-judgment-current', verdict || '');
            var label = review.querySelector('[data-reviewer-judgment-label]');
            if (label) label.textContent = reviewerJudgmentLabel(verdict);
            var buttons = review.querySelectorAll('[data-reviewer-judgment-verdict]');
            for (var j = 0; j < buttons.length; j++) {
              var buttonVerdict = buttons[j].getAttribute('data-reviewer-judgment-verdict');
              buttons[j].classList.toggle('is-active', Boolean(verdict && buttonVerdict === verdict));
            }
            var note = review.querySelector('small');
            if (reason) {
              if (!note) {
                note = document.createElement('small');
                review.appendChild(note);
              }
              note.textContent = reason;
            } else if (note) {
              note.remove();
            }
          }
        }
        async function setReviewerJudgmentReview(targetId, verdict, btn, reason) {
          if (btn) btn.disabled = true;
          var review = btn && btn.closest ? btn.closest('[data-reviewer-judgment-current]') : null;
          var current = review ? review.getAttribute('data-reviewer-judgment-current') || '' : '';
          var shouldDelete = current === verdict && !reason;
          try {
            var res = shouldDelete
              ? await fetch('/api/observations/review-state?targetType=reviewer_judgment&targetId=' + encodeURIComponent(targetId), { method: 'DELETE' })
              : await fetch('/api/observations/review-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  targetType: 'reviewer_judgment',
                  targetId: targetId,
                  verdict: verdict,
                  reason: reason || undefined
                })
              });
            if (!res.ok) throw new Error('判断标注写入失败: ' + res.status);
            await res.json();
            updateReviewerJudgmentUi(targetId, shouldDelete ? '' : verdict, shouldDelete ? '' : reason);
          } catch (err) {
            alert(String(err && err.message ? err.message : err));
          } finally {
            if (btn) btn.disabled = false;
          }
        }
        function openReviewerJudgmentNote(targetId, btn) {
          var previous = btn && btn.closest ? btn.closest('[data-reviewer-judgment-current]') : null;
          var oldNote = previous && previous.querySelector('small') ? previous.querySelector('small').textContent || '' : '';
          closeManualCorrectionPopovers();
          if (btn) btn.classList.add('is-editing');
          var popover = document.createElement('div');
          popover.className = 'manual-correction-popover';
          var title = document.createElement('div');
          title.className = 'manual-correction-popover-title';
          title.textContent = '补充判断意见';
          var hint = document.createElement('div');
          hint.className = 'manual-correction-popover-hint';
          hint.textContent = '意见会写入 review-state.json，不修改原始 trace。';
          var input = document.createElement('textarea');
          input.className = 'metric-reason-input';
          input.value = oldNote;
          input.placeholder = '写下需要补充的判断依据';
          var footer = document.createElement('div');
          footer.className = 'manual-correction-popover-actions';
          var save = document.createElement('button');
          save.type = 'button';
          save.textContent = '保存';
          var cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.textContent = '取消';
          footer.appendChild(save);
          footer.appendChild(cancel);
          popover.appendChild(title);
          popover.appendChild(hint);
          popover.appendChild(input);
          popover.appendChild(footer);
          positionManualCorrectionPopover(popover, btn);
          input.focus();
          input.select();
          var close = function () {
            popover.remove();
            if (btn) btn.classList.remove('is-editing');
          };
          save.addEventListener('click', function () {
            setReviewerJudgmentReview(targetId, 'needs_more_context', btn, input.value.trim());
            close();
          });
          cancel.addEventListener('click', close);
          setTimeout(function () {
            document.addEventListener('click', function closeOnOutsideClick(event) {
              if (popover.contains(event.target) || (btn && btn.contains(event.target))) return;
              close();
              document.removeEventListener('click', closeOnOutsideClick);
            });
          }, 0);
        }
        function softStandardStatusLabel(status) {
          if (status === 'author_confirmed') return '作者已确认';
          if (status === 'rejected') return '已否决';
          if (status === 'stale') return '已过期';
          return '待作者确认';
        }
        function softStandardStatusIcon(status) {
          if (status === 'author_confirmed') return '✅';
          if (status === 'rejected') return '❌';
          return '';
        }
        function softStandardReviewVerdict(status) {
          if (status === 'author_confirmed') return 'real_issue';
          if (status === 'rejected') return 'not_issue';
          return 'needs_more_context';
        }
        async function setSoftStandardStatus(skillName, standardId, status, btn) {
          if (btn) btn.disabled = true;
          try {
            var res = await fetch('/api/observations/review-state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                targetType: 'soft_standard',
                targetId: skillName + ':' + standardId,
                verdict: softStandardReviewVerdict(status)
              })
            });
            if (!res.ok) throw new Error('标准候选人工判断写入失败: ' + res.status);
            await res.json();
            var cards = document.querySelectorAll('[data-soft-standard-id="' + standardId.replace(/"/g, '\\"') + '"][data-soft-standard-skill="' + skillName.replace(/"/g, '\\"') + '"]');
            for (var i = 0; i < cards.length; i++) {
              var label = cards[i].querySelector('[data-soft-standard-status]');
              if (label) {
                label.setAttribute('data-soft-standard-status', status);
                label.textContent = softStandardStatusLabel(status);
              }
              cards[i].classList.toggle('is-confirmed', status === 'author_confirmed');
              cards[i].classList.toggle('is-rejected', status === 'rejected');
              var icon = cards[i].querySelector('[data-soft-standard-icon]');
              if (icon) {
                icon.setAttribute('data-soft-standard-icon', status);
                icon.textContent = softStandardStatusIcon(status);
              }
            }
          } catch (err) {
            alert(String(err && err.message ? err.message : err));
          } finally {
            if (btn) btn.disabled = false;
          }
        }
        function closeManualCorrectionPopovers() {
          var popovers = document.querySelectorAll('.manual-correction-popover');
          for (var i = 0; i < popovers.length; i++) popovers[i].remove();
          var buttons = document.querySelectorAll('.manual-correction-button.is-editing');
          for (var j = 0; j < buttons.length; j++) buttons[j].classList.remove('is-editing');
        }
        function manualCorrectionNote(value, label) {
          return JSON.stringify({ value: value, label: label });
        }
        function updateManualCorrectionButtons(targetType, targetId, label) {
          var key = targetType + ':' + targetId;
          var buttons = document.querySelectorAll('[data-manual-correction-key="' + key.replace(/"/g, '\\"') + '"]');
          for (var i = 0; i < buttons.length; i++) {
            var baseLabel = buttons[i].getAttribute('data-manual-correction-label') || '人工纠正';
            buttons[i].setAttribute('data-manual-correction-current', label || '');
            buttons[i].classList.toggle('is-marked', Boolean(label));
            buttons[i].textContent = label ? baseLabel + '：' + label : baseLabel;
          }
        }
        async function submitManualCorrection(targetType, targetId, value, label, btn) {
          if (btn) btn.disabled = true;
          try {
            var res = value === ''
              ? await fetch('/api/observations/review-state?targetType=' + encodeURIComponent(targetType) + '&targetId=' + encodeURIComponent(targetId), { method: 'DELETE' })
              : await fetch('/api/observations/review-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  targetType: targetType,
                  targetId: targetId,
                  verdict: 'reviewed',
                  note: manualCorrectionNote(value, label)
                })
              });
            if (!res.ok) throw new Error('人工纠正写入失败: ' + res.status);
            await res.json();
            updateManualCorrectionButtons(targetType, targetId, value === '' ? '' : label);
            closeManualCorrectionPopovers();
          } catch (err) {
            alert(String(err && err.message ? err.message : err));
          } finally {
            if (btn) btn.disabled = false;
          }
        }
        function positionManualCorrectionPopover(popover, btn) {
          var rect = btn.getBoundingClientRect();
          var width = Math.min(320, Math.max(220, window.innerWidth - 24));
          popover.style.width = width + 'px';
          document.body.appendChild(popover);
          var left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right - width));
          var top = rect.bottom + 8;
          var popRect = popover.getBoundingClientRect();
          if (top + popRect.height > window.innerHeight - 12) {
            top = Math.max(12, rect.top - popRect.height - 8);
          }
          popover.style.left = left + 'px';
          popover.style.top = top + 'px';
        }
        function openManualCorrection(btn) {
          closeManualCorrectionPopovers();
          if (!btn) return;
          var targetType = btn.getAttribute('data-manual-correction-target-type') || '';
          var targetId = btn.getAttribute('data-manual-correction-target-id') || '';
          var label = btn.getAttribute('data-manual-correction-label') || '人工纠正';
          var kind = btn.getAttribute('data-manual-correction-kind') || 'choice';
          if (kind === 'text') {
            var current = btn.getAttribute('data-manual-correction-current') || '';
            btn.classList.add('is-editing');
            var textPopover = document.createElement('div');
            textPopover.className = 'manual-correction-popover';
            var textTitle = document.createElement('div');
            textTitle.className = 'manual-correction-popover-title';
            textTitle.textContent = label;
            var textHint = document.createElement('div');
            textHint.className = 'manual-correction-popover-hint';
            textHint.textContent = '填写人工纠正后的内容。结果写入 review-state.json，不修改原始 trace。';
            var input = document.createElement('textarea');
            input.className = 'metric-reason-input';
            input.value = current;
            input.placeholder = '例如：生成 Demo / PRD 评审 / 修复脚本';
            var footer = document.createElement('div');
            footer.className = 'manual-correction-popover-actions';
            var save = document.createElement('button');
            save.type = 'button';
            save.textContent = '保存';
            var clearText = document.createElement('button');
            clearText.type = 'button';
            clearText.textContent = '清除标注';
            var cancelText = document.createElement('button');
            cancelText.type = 'button';
            cancelText.textContent = '取消';
            footer.appendChild(save);
            footer.appendChild(clearText);
            footer.appendChild(cancelText);
            textPopover.appendChild(textTitle);
            textPopover.appendChild(textHint);
            textPopover.appendChild(input);
            textPopover.appendChild(footer);
            positionManualCorrectionPopover(textPopover, btn);
            input.focus();
            save.addEventListener('click', function () {
              var trimmed = input.value.trim();
              submitManualCorrection(targetType, targetId, trimmed, trimmed, btn);
            });
            clearText.addEventListener('click', function () { submitManualCorrection(targetType, targetId, '', '', btn); });
            cancelText.addEventListener('click', closeManualCorrectionPopovers);
            return;
          }
          btn.classList.add('is-editing');
          var options = [];
          try { options = JSON.parse(btn.getAttribute('data-manual-correction-options') || '[]'); } catch { options = []; }
          var popover = document.createElement('div');
          popover.className = 'manual-correction-popover';
          var title = document.createElement('div');
          title.className = 'manual-correction-popover-title';
          title.textContent = label;
          var hint = document.createElement('div');
          hint.className = 'manual-correction-popover-hint';
          hint.textContent = '选择人工判断。结果写入 review-state.json，不修改原始 trace。';
          var actions = document.createElement('div');
          actions.className = 'manual-correction-popover-actions';
          for (var i = 0; i < options.length; i++) {
            (function (option) {
              var choice = document.createElement('button');
              choice.type = 'button';
              choice.textContent = option.label || option.value;
              choice.addEventListener('click', function () {
                submitManualCorrection(targetType, targetId, option.value || '', option.label || option.value || '', btn);
              });
              actions.appendChild(choice);
            })(options[i]);
          }
          var clear = document.createElement('button');
          clear.type = 'button';
          clear.textContent = '清除标注';
          clear.addEventListener('click', function () { submitManualCorrection(targetType, targetId, '', '', btn); });
          actions.appendChild(clear);
          popover.appendChild(title);
          popover.appendChild(hint);
          popover.appendChild(actions);
          positionManualCorrectionPopover(popover, btn);
          setTimeout(function () {
            document.addEventListener('click', function closeOnOutsideClick(event) {
              if (popover.contains(event.target) || btn.contains(event.target)) return;
              closeManualCorrectionPopovers();
              document.removeEventListener('click', closeOnOutsideClick);
            });
          }, 0);
        }
        window.openManualCorrection = openManualCorrection;
        window.closeManualCorrectionPopovers = closeManualCorrectionPopovers;
        function closeGoalSliceCorrectionPopovers() {
          var popovers = document.querySelectorAll('.goal-slice-popover');
          for (var i = 0; i < popovers.length; i++) popovers[i].remove();
          var buttons = document.querySelectorAll('.goal-slice-correction-button.is-editing');
          for (var j = 0; j < buttons.length; j++) buttons[j].classList.remove('is-editing');
        }
        function updateGoalSliceCorrectionButtons(targetId, action) {
          var key = 'goal_slice_correction:' + targetId;
          var buttons = document.querySelectorAll('[data-goal-slice-correction-key="' + key.replace(/"/g, '\\"') + '"]');
          var label = action === 'split_goal_slice'
            ? '已标记：拆分'
            : action === 'add_to_current_skill_window'
              ? '已标记：加入窗口'
              : '人工标记';
          for (var i = 0; i < buttons.length; i++) {
            buttons[i].textContent = label;
            buttons[i].setAttribute('data-goal-slice-correction-action', action || '');
            buttons[i].classList.toggle('is-marked', Boolean(action));
          }
          var manualButtons = document.querySelectorAll('[data-manual-mark-goal-target="' + targetId.replace(/"/g, '\\"') + '"]');
          for (var j = 0; j < manualButtons.length; j++) {
            manualButtons[j].setAttribute('data-manual-mark-goal-action', action || '');
            var metrics = [];
            try { metrics = JSON.parse(manualButtons[j].getAttribute('data-manual-mark-metrics') || '[]'); } catch { metrics = []; }
            var activeCount = (action ? 1 : 0) + metrics.filter(function (item) {
              return item.verdict === 'confirmed' || item.verdict === 'rejected';
            }).length;
            manualButtons[j].classList.toggle('is-marked', activeCount > 0);
            var mode = manualButtons[j].getAttribute('data-manual-mark-mode') || 'metrics';
            if (mode === 'window_only') {
              manualButtons[j].textContent = action === 'add_to_current_skill_window' ? '已加入窗口' : '加入窗口';
            } else {
              manualButtons[j].textContent = '人工标记' + (activeCount > 0 ? '(' + activeCount + ')' : '');
            }
          }
        }
        async function submitGoalSliceCorrection(targetId, action, btn) {
          if (btn) btn.disabled = true;
          try {
            var res;
            if (!action) {
              res = await fetch('/api/observations/review-state?targetType=goal_slice_correction&targetId=' + encodeURIComponent(targetId), { method: 'DELETE' });
            } else {
              res = await fetch('/api/observations/review-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  targetType: 'goal_slice_correction',
                  targetId: targetId,
                  verdict: 'reviewed',
                  note: action,
                  sourceTrace: btn ? btn.getAttribute('data-source-trace') || undefined : undefined,
                  sessionId: btn ? btn.getAttribute('data-session-id') || undefined : undefined,
                  messageIndex: btn && btn.getAttribute('data-message-index') ? Number(btn.getAttribute('data-message-index')) : undefined,
                  messageUuid: btn ? btn.getAttribute('data-message-uuid') || undefined : undefined,
                  toolUseId: btn ? btn.getAttribute('data-tool-use-id') || undefined : undefined,
                  snippet: btn ? btn.getAttribute('data-snippet') || undefined : undefined
                })
              });
            }
            if (!res.ok) throw new Error('goal slice correction update failed: ' + res.status);
            await res.json();
            updateGoalSliceCorrectionButtons(targetId, action);
            closeGoalSliceCorrectionPopovers();
          } catch (err) {
            alert(String(err && err.message ? err.message : err));
          } finally {
            if (btn) btn.disabled = false;
          }
        }
        function positionGoalSlicePopover(popover, btn) {
          var rect = btn.getBoundingClientRect();
          var isTimelineManual = popover.classList && popover.classList.contains('timeline-manual-popover');
          var preferredWidth = isTimelineManual ? 380 : 320;
          var width = Math.min(preferredWidth, Math.max(220, window.innerWidth - 32));
          popover.style.width = width + 'px';
          var left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right - width));
          var top = rect.bottom + 8;
          document.body.appendChild(popover);
          if (isTimelineManual) {
            popover.style.maxHeight = Math.max(180, window.innerHeight - 24) + 'px';
            popover.style.overflowY = 'auto';
          }
          var popRect = popover.getBoundingClientRect();
          if (top + popRect.height > window.innerHeight - 12) {
            top = Math.max(12, rect.top - popRect.height - 8);
          }
          if (isTimelineManual && top + popRect.height > window.innerHeight - 12) {
            top = 12;
            popover.style.maxHeight = Math.max(180, window.innerHeight - 24) + 'px';
          }
          popover.style.left = left + 'px';
          popover.style.top = top + 'px';
        }
        function openGoalSliceCorrectionPopover(targetId, btn) {
          closeGoalSliceCorrectionPopovers();
          if (!btn) return;
          btn.classList.add('is-editing');
          var popover = document.createElement('div');
          popover.className = 'goal-slice-popover';
          var title = document.createElement('div');
          title.className = 'goal-slice-popover-title';
          title.textContent = '人工标记';
          var hint = document.createElement('div');
          hint.className = 'goal-slice-popover-hint';
          hint.textContent = '这个标记会写入 review-state.json。修改后需要重新执行脚本，报告才会按新切片或新窗口重算。';
          var actions = document.createElement('div');
          actions.className = 'goal-slice-popover-actions';
          var split = document.createElement('button');
          split.type = 'button';
          split.textContent = '拆分目标切片';
          split.title = '把这条 message 作为新的目标片段起点候选。';
          var clear = document.createElement('button');
          clear.type = 'button';
          clear.textContent = '取消打标';
          clear.title = '删除这条 message 的人工切片/窗口标记。';
          var add = document.createElement('button');
          add.type = 'button';
          add.textContent = '添加至当前 skill 窗口';
          add.title = '把这条 message 作为当前 skill 的上下文候选。';
          actions.appendChild(split);
          actions.appendChild(clear);
          actions.appendChild(add);
          popover.appendChild(title);
          popover.appendChild(hint);
          popover.appendChild(actions);
          positionGoalSlicePopover(popover, btn);
          setTimeout(function () {
            document.addEventListener('click', function closeOnOutsideClick(event) {
              if (popover.contains(event.target) || btn.contains(event.target)) return;
              closeGoalSliceCorrectionPopovers();
              document.removeEventListener('click', closeOnOutsideClick);
            });
          }, 0);
          split.addEventListener('click', function () { submitGoalSliceCorrection(targetId, 'split_goal_slice', btn); });
          clear.addEventListener('click', function () { submitGoalSliceCorrection(targetId, '', btn); });
          add.addEventListener('click', function () { submitGoalSliceCorrection(targetId, 'add_to_current_skill_window', btn); });
        }
        window.closeGoalSliceCorrectionPopovers = closeGoalSliceCorrectionPopovers;
        window.openGoalSliceCorrectionPopover = openGoalSliceCorrectionPopover;
        function closeTimelineManualMarkPopovers() {
          var popovers = document.querySelectorAll('.timeline-manual-popover');
          for (var i = 0; i < popovers.length; i++) popovers[i].remove();
          var buttons = document.querySelectorAll('.timeline-manual-mark-button.is-editing');
          for (var j = 0; j < buttons.length; j++) buttons[j].classList.remove('is-editing');
        }
        function metricStateLabel(verdict, ruleDetected) {
          if (verdict === 'confirmed') return '人工同意';
          if (verdict === 'rejected') return '人工反对';
          return ruleDetected ? '规则命中' : '未命中';
        }
        function updateTimelineManualMarkButton(btn, metric, next) {
          var metrics = [];
          try { metrics = JSON.parse(btn.getAttribute('data-manual-mark-metrics') || '[]'); } catch { metrics = []; }
          for (var i = 0; i < metrics.length; i++) {
            if (metrics[i].targetId === metric.targetId) {
              metrics[i].verdict = next;
              break;
            }
          }
          btn.setAttribute('data-manual-mark-metrics', JSON.stringify(metrics));
          var goalAction = btn.getAttribute('data-manual-mark-goal-action') || '';
          var activeCount = (goalAction ? 1 : 0) + metrics.filter(function (item) {
            return item.verdict === 'confirmed' || item.verdict === 'rejected';
          }).length;
          btn.classList.toggle('is-marked', activeCount > 0);
          var mode = btn.getAttribute('data-manual-mark-mode') || 'metrics';
          if (mode === 'window_only') {
            btn.textContent = goalAction === 'add_to_current_skill_window' ? '已加入窗口' : '加入窗口';
          } else {
            btn.textContent = '人工标记' + (activeCount > 0 ? '(' + activeCount + ')' : '');
          }
        }
        async function submitTimelineMetricAnnotation(metric, next, btn) {
          var source = {};
          try { source = JSON.parse(btn.getAttribute('data-manual-mark-source') || '{}'); } catch { source = {}; }
          var res = next === ''
            ? await fetch('/api/observations/review-state?targetType=evidence_metric&targetId=' + encodeURIComponent(metric.targetId), { method: 'DELETE' })
            : await fetch('/api/observations/review-state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                targetType: 'evidence_metric',
                targetId: metric.targetId,
                verdict: next,
                metricKey: metric.metricKey,
                metricScopeId: metric.metricScopeId || undefined,
                sourceTrace: source.sourceTrace || undefined,
                sessionId: source.sessionId || undefined,
                messageIndex: source.messageIndex === undefined ? undefined : Number(source.messageIndex),
                messageUuid: source.messageUuid || undefined,
                toolUseId: source.toolUseId || undefined,
                snippet: source.snippet || undefined
              })
            });
          if (!res.ok) throw new Error('人工标记写入失败: ' + res.status);
          await res.json();
          metric.verdict = next;
          updateTimelineManualMarkButton(btn, metric, next);
        }
        function addTimelineMetricButton(actions, metric, value, text, btn, labelEl) {
          var button = document.createElement('button');
          button.type = 'button';
          button.textContent = text;
          button.className = value && metric.verdict === value ? 'is-active' : '';
          button.addEventListener('click', function () {
            submitTimelineMetricAnnotation(metric, value, btn).then(function () {
              var rowButtons = actions.querySelectorAll('button');
              for (var i = 0; i < rowButtons.length; i++) rowButtons[i].classList.remove('is-active');
              if (value) button.classList.add('is-active');
              if (labelEl) labelEl.textContent = metricStateLabel(value, metric.ruleDetected) + ' · ' + metric.label;
            }).catch(function (err) {
              alert(String(err && err.message ? err.message : err));
            });
          });
          actions.appendChild(button);
        }
        function openTimelineManualMark(btn) {
          closeTimelineManualMarkPopovers();
          closeGoalSliceCorrectionPopovers();
          if (!btn) return;
          btn.classList.add('is-editing');
          var metrics = [];
          try { metrics = JSON.parse(btn.getAttribute('data-manual-mark-metrics') || '[]'); } catch { metrics = []; }
          var mode = btn.getAttribute('data-manual-mark-mode') || 'metrics';
          var isWindowOnly = mode === 'window_only';
          var goalTargetId = btn.getAttribute('data-manual-mark-goal-target') || '';
          var goalAction = btn.getAttribute('data-manual-mark-goal-action') || '';
          var popover = document.createElement('div');
          popover.className = 'timeline-manual-popover';
          var title = document.createElement('div');
          title.className = 'goal-slice-popover-title';
          title.textContent = isWindowOnly ? '加入当前 skill 窗口' : '人工标记这条消息';
          var hint = document.createElement('div');
          hint.className = 'goal-slice-popover-hint';
          hint.textContent = isWindowOnly
            ? '这条消息不在当前 skill 窗口内，不能直接打指标标签。需要先加入当前 skill 窗口，重新执行脚本后再标注。'
            : '这里可以修正消息标签，也可以把这条消息标成目标切片点或加入当前 skill 窗口。消息标签包括纠正、中断、追问、正负反馈、硬性要求、目标切换、有结果、有产物、过程进展、自我纠正和重复执行。';
          var actions = document.createElement('div');
          actions.className = 'timeline-manual-actions';
          var goalSplit = document.createElement('button');
          goalSplit.type = 'button';
          goalSplit.textContent = goalAction === 'split_goal_slice' ? '已标：拆分目标' : '拆分目标切片';
          goalSplit.addEventListener('click', function () { submitGoalSliceCorrection(goalTargetId, 'split_goal_slice', btn); });
          var goalAdd = document.createElement('button');
          goalAdd.type = 'button';
          goalAdd.textContent = goalAction === 'add_to_current_skill_window' ? '已标：加入窗口' : '加入当前 skill 窗口';
          goalAdd.addEventListener('click', function () { submitGoalSliceCorrection(goalTargetId, 'add_to_current_skill_window', btn); });
          var goalClear = document.createElement('button');
          goalClear.type = 'button';
          goalClear.textContent = '清除切片/窗口';
          goalClear.addEventListener('click', function () { submitGoalSliceCorrection(goalTargetId, '', btn); });
          if (!isWindowOnly) actions.appendChild(goalSplit);
          actions.appendChild(goalAdd);
          if (!isWindowOnly || goalAction) actions.appendChild(goalClear);
          for (var i = 0; i < metrics.length; i++) {
            (function (metric) {
              var group = document.createElement('div');
              group.className = 'timeline-manual-metric-row';
              var label = document.createElement('span');
              label.textContent = metricStateLabel(metric.verdict, metric.ruleDetected) + ' · ' + metric.label;
              group.appendChild(label);
              addTimelineMetricButton(group, metric, 'confirmed', '同意', btn, label);
              addTimelineMetricButton(group, metric, 'rejected', '反对', btn, label);
              addTimelineMetricButton(group, metric, '', '清除', btn, label);
              actions.appendChild(group);
            })(metrics[i]);
          }
          popover.appendChild(title);
          popover.appendChild(hint);
          popover.appendChild(actions);
          positionGoalSlicePopover(popover, btn);
          setTimeout(function () {
            document.addEventListener('click', function closeOnOutsideClick(event) {
              if (popover.contains(event.target) || btn.contains(event.target)) return;
              closeTimelineManualMarkPopovers();
              document.removeEventListener('click', closeOnOutsideClick);
            });
          }, 0);
        }
        window.openTimelineManualMark = openTimelineManualMark;
        window.closeTimelineManualMarkPopovers = closeTimelineManualMarkPopovers;
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
