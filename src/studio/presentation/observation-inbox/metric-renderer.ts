import { e } from '../layout.js';
import { incrementRecordCount } from '../../../shared/record-count.js';
import {
  hasAssistantDeliverableArtifactText,
  hasAssistantDeliverySignalText,
  hasUserHardRuleText,
  isSyntheticUserMessageText,
  isUserInteractionMetricText,
  observationMetricAnnotationEntry,
} from '../../../observability/inbox/view-model.js';
import type {
  ExperienceProblemBucket,
  ExperienceProblemPattern,
  ExperienceProblemSignal,
  ObservationInboxViewModel,
  ObservationMetricKey,
} from '../../../observability/inbox/view-model.js';
import {
  findNegativeFeedbackMatches,
  findPositiveFeedbackMatches,
  findUserCorrectionMatches,
  findUserGoalShiftMatches,
  hasUserGoalShiftSignal,
} from '../../../observability/inbox/feedback-projection.js';
import type {
  ExperienceAssistiveInference,
  ExperienceAssistiveInferenceCode,
  ExperienceEvidenceRef,
  ExperienceFeedbackAttribution,
  ExperienceFeedbackSignal,
  ExperienceReviewBasisCode,
  ExperienceReviewIndicators,
  ExperienceReviewPriority,
  ExperienceRuleFinding,
  ExperienceRuleFindingCode,
  ExperienceRuleFindingLevel,
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
} from '../../../observability/inbox/feedback-projection.js';
import {
  hasRepeatedExecutionSignal,
  hasSelfCorrectionSignal,
} from './timeline.js';

export type IndicatorHelpKey =
  | 'userCorrection' | 'userInterruption' | 'userFollowUp' | 'negativeFeedback' | 'positiveFeedback' | 'userGoalShift' | 'hardRule' | 'selfCorrection' | 'repeatedExecution'
  | 'toolCall' | 'toolFailure' | 'toolCancelled' | 'toolUnknown' | 'highObservation' | 'mediumObservation' | 'hedging' | 'explicitMarker'
  | 'bash' | 'read' | 'grep' | 'bashProbe' | 'notFound' | 'toolLimit'
  | 'skillRoleRouter' | 'skillRoleExecutor' | 'skillRoleMixed' | 'skillRoleUnknown'
  | 'llmSkillTypeRouter' | 'llmSkillTypeDelegation' | 'llmSkillTypeExecutor' | 'llmSkillTypeAdvisory' | 'llmSkillTypeWorkflowOwner' | 'llmSkillTypeUnknown';

export type ObservationMetricRenderers = ReturnType<typeof createObservationMetricRenderers>;

export function createObservationMetricRenderers({
  experience,
  reviewState,
}: {
  readonly experience: ObservationInboxViewModel['experienceReports'][number] | undefined;
  readonly reviewState: ObservationInboxViewModel['reviewState'];
}) {
  const experienceSessionIdBySkillAndSession = new Map(
    (experience?.sessions ?? []).map((session) => [
      `${session.skillName}\u0000${session.sessionId}`,
      session.id,
    ]),
  );
  const confidenceHeaderHelp = '判断把握：OMK 对“这条 过程发现 是否需要处理/是否高风险/需关注”的规则判断有多确定。归属把握：OMK 把这条 过程发现 归到当前 skill 名下有多确定，例如明确调用 skill 通常更高。';
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
    toolCancelled: '工具调用取消',
    toolUnknown: '工具状态未知',
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
    toolCancelled: '统计 runtime 明确标记为 cancelled 的工具调用。取消与工具执行失败分开统计，也不作为知识缺口证据。',
    toolUnknown: '统计 runtime 未提供可信终态的工具调用。状态未知不计入工具成功率或失败率分母。',
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
      'codex-desktop': 'ChatGPT 桌面端（Codex）',
      'codex-cli': 'Codex CLI',
      'codex-sdk': 'Codex SDK',
      'codex-vscode': 'Codex VS Code',
      claudian: 'Claudian',
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
    indicators: {
      userInterruptionCount: number;
      toolFailureCount: number;
      toolCancelledCount?: number;
      toolUnknownCount?: number;
      toolCallCount: number;
    },
    invocationCount: number,
  ): string => {
    const total = indicators.toolCallCount;
    const failed = Math.max(0, indicators.toolFailureCount);
    const cancelled = Math.max(0, indicators.toolCancelledCount ?? 0);
    const unknown = Math.max(0, indicators.toolUnknownCount ?? 0);
    const interrupted = Math.max(0, indicators.userInterruptionCount);
    const success = Math.max(0, total - failed - cancelled - unknown);
    const pct = (value: number): string => total > 0 ? `${Math.round(value / total * 100)}%` : '—';
    return `<div class="invocation-summary" title="这是 trace 中可观测到的调用过程汇总。工具执行失败/人工中断是过程信号，不直接等同于整个 skill 失败或用户目标失败。">
      <div class="invocation-total">工具调用总次数 <strong>${total}</strong></div>
      <div class="invocation-breakdown">
        <span>工具执行成功 ${success} / ${pct(success)}</span>
        <span>工具执行失败 ${failed} / ${pct(failed)}</span>
        ${cancelled > 0 ? `<span>工具调用取消 ${cancelled} / ${pct(cancelled)}</span>` : ''}
        ${unknown > 0 ? `<span>结果状态未知 ${unknown} / ${pct(unknown)}</span>` : ''}
        <span>人工中断 ${interrupted} 次</span>
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
      incrementRecordCount(next, display, count);
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
        if (typeof value === 'number') incrementRecordCount(merged, key, value);
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
    toolCancelledCount: 0,
    toolUnknownCount: 0,
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
    const entry = observationMetricAnnotationEntry(
      reviewState,
      { ...event, metricScopeId },
      metricKey,
    );
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
      toolCancelledCount: (current.toolCancelledCount ?? 0) + (next.toolCancelledCount ?? 0),
      toolUnknownCount: (current.toolUnknownCount ?? 0) + (next.toolUnknownCount ?? 0),
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
  return {
    confidenceHeaderHelp,
    indicatorLabels,
    indicatorHelps,
    metric,
    formatEntrypoint,
    formatAttributionSource,
    renderInvocationSummary,
    renderMetric,
    renderMetricShare,
    renderDecisionMetric,
    renderDecisionMetricIfPositive,
    renderDecisionMetricShare,
    renderSoftMetric,
    renderRankedCounts,
    userFacingToolLabel,
    mergeCountsByLabel,
    compactRankedCountText,
    renderOpenClawSourceMetadata,
    renderSessionOpenClawSourceMetadata,
    renderSkillProblemPatterns,
    shouldIncludeDownstreamFeedbackForDisplay,
    canonicalFeedbackSignalsForDisplay,
    displayIndicatorsForSession,
    sessionMetricSourceTitle,
    displayIndicatorsBySkill,
    displayBasisCodes,
    displayPriority,
    displayAssistiveInference,
    displayRuleFindings,
  };
}
