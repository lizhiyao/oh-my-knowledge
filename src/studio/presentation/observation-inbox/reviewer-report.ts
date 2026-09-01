import { e } from '../layout.js';
import type { ObservationInboxViewModel } from '../../../observability/inbox/view-model.js';
import type {
  ExperienceEvidenceRef,
  ExperienceReviewerReport,
} from '../../../observability/inbox/feedback-projection.js';
import { renderFeedbackAttributionLabel } from './helpers.js';

interface ReviewerReportRenderers {
  cleanReportCopy(value: string): string;
  fallbackSessionStory(report: ExperienceReviewerReport): ExperienceReviewerReport['sessionStory'];
  renderReviewerReport(report?: ExperienceReviewerReport): string;
}

export function createReviewerReportRenderers(
  skillDerivedStandards: ObservationInboxViewModel['skillDerivedStandards'],
): ReviewerReportRenderers {
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
        model_activity: '模型活动',
        agent_activity: '协作代理活动',
        tool_use: '工具调用',
        tool_result: '工具结果',
        skill_context: '能力说明',
        runtime_context: '运行注入',
        lifecycle: '运行状态',
        observation: '过程发现',
      };
      return labels[kind] ?? kind;
    };
    const metrics = report.oneLookMetrics;
    const tokenUsage = metrics.tokenUsage;
    const tokenCoverage = tokenUsage.coverage ?? 0;
    const tokenUsageText = tokenCoverage > 0
      ? `输入 ${tokenUsage.inputTokens} / 输出 ${tokenUsage.outputTokens} / 缓存读取 ${tokenUsage.cacheReadTokens} / 缓存写入 ${tokenUsage.cacheCreationTokens}${tokenCoverage < 1 ? `（覆盖 ${Math.round(tokenCoverage * 100)}% 调用）` : ''}`
      : '—（trace 未提供可归因的 token 用量）';
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
              ['工具取消', metrics.toolCancelledCount ?? 0],
              ['状态未知', metrics.toolUnknownCount ?? 0],
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
            Token 使用量（按本次能力片段归因）：${tokenUsageText}
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

  return { cleanReportCopy, fallbackSessionStory, renderReviewerReport };
}
