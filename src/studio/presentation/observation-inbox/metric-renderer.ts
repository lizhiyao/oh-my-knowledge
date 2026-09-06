import { e } from '../layout.js';
import { incrementRecordCount } from '../../../shared/record-count.js';
import {
  INDICATOR_FOR_METRIC,
  observationMetricAnnotationVerdict,
  canonicalFeedbackSignalsForSession,
  metricKeyForFeedbackSignal,
  shouldIncludeDownstreamFeedbackForSession as shouldIncludeDownstreamFeedbackForDisplay,
  type ExperienceProblemBucket,
  type ExperienceProblemPattern,
  type ExperienceProblemSignal,
  type ObservationInboxViewModel,
  type ObservationMetricKey,
  type ExperienceSessionSummary,
  type ExperienceFeedbackSignal,
} from '../../../observability/inbox/view-model.js';

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
  unappliedMetricAnnotations,
}: {
  readonly experience: ObservationInboxViewModel['experienceReports'][number] | undefined;
  readonly reviewState: ObservationInboxViewModel['reviewState'];
  readonly unappliedMetricAnnotations: ObservationInboxViewModel['unappliedMetricAnnotations'];
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
  const canonicalFeedbackSignalsForDisplay = (session: ExperienceSessionSummary, signalType?: ExperienceFeedbackSignal['type']) =>
    canonicalFeedbackSignalsForSession(session, reviewState).filter((signal) => !signalType || signal.type === signalType);
  const displayIndicatorsBySkill = new Map((experience?.skills ?? []).map((skill) => [skill.skillName, skill.indicators]));
  const sessionMetricSourceTitle = (session: ExperienceSessionSummary, metricKey: ObservationMetricKey, label: string): string => {
    const field = INDICATOR_FOR_METRIC[metricKey as keyof typeof INDICATOR_FOR_METRIC];
    const count = field ? session.indicators[field] : undefined;
    const signals = canonicalFeedbackSignalsForSession(session, reviewState)
      .filter((signal) => metricKeyForFeedbackSignal(signal) === metricKey);
    const refs = signals.length > 0 ? signals.map((signal) => signal.evidenceRef) : session.timelinePreview;
    let confirmed = 0;
    let rejected = 0;
    for (const ref of refs) {
      const verdict = observationMetricAnnotationVerdict(reviewState, { ...ref, metricScopeId: session.id }, metricKey);
      if (verdict === 'confirmed') confirmed += 1;
      if (verdict === 'rejected') rejected += 1;
    }
    return [
      `${label}：最终计入 ${count ?? '未记录'}`,
      unappliedMetricAnnotations[session.id]?.includes(metricKey)
        ? '证据不完整：该指标的人工标注尚未应用，当前保留原始报告计数。'
        : '来源：领域有效观测投影；原始报告与人工审阅分别保留。',
      `人工同意 ${confirmed}，人工反对 ${rejected}`,
      signals.length > 0 ? `证据：${signals.slice(0, 8).map((signal) => signal.text.slice(0, 80)).join('；')}` : '预览不是完整计数来源；证据不完整时保留报告指标。',
    ].join('\n');
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
    sessionMetricSourceTitle,
    displayIndicatorsBySkill,
  };
}
