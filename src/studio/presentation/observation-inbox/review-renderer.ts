import { e } from '../layout.js';
import type { Lang } from '../../../shared/language.js';
import {
  getSkillChainAdvisory,
  isSyntheticUserMessageText,
} from '../../../observability/inbox/view-model.js';
import type {
  ObservationInboxItem,
  ObservationInboxViewModel,
} from '../../../observability/inbox/view-model.js';
import type {
  ExperienceAssistiveInference,
  ExperienceAssistiveInferenceCautionCode,
  ExperienceAssistiveInferenceCode,
  ExperienceEvidenceChain,
  ExperienceEvidenceRef,
  ExperienceReviewBasisCode,
  ExperienceReviewPriority,
  ExperienceRuleFinding,
  ExperienceRuleFindingCode,
  ExperienceRuleFindingLevel,
  ExperienceSessionSummary,
} from '../../../observability/inbox/feedback-projection.js';
import { renderArtifactVersion, renderField, renderJson } from './helpers.js';
import type { ObservationMetricRenderers } from './metric-renderer.js';
import type { ObservationSignalRenderers } from './signal-renderer.js';
import type { ObservationSkillChainRenderers } from './skill-chain-renderer.js';
import { createObservationTimelineRenderers } from './timeline.js';

export type ObservationReviewRenderers = ReturnType<typeof createObservationReviewRenderers>;

export function createObservationReviewRenderers({
  experience,
  lang,
  observedItemTimestamp,
  reviewState,
  timestampedOccurrences,
  metricRenderers,
  signalRenderers,
  skillChainRenderers,
}: {
  readonly experience: ObservationInboxViewModel['experienceReports'][number] | undefined;
  readonly lang: Lang;
  readonly observedItemTimestamp: (item: ObservationInboxItem, value: string) => string;
  readonly reviewState: ObservationInboxViewModel['reviewState'];
  readonly timestampedOccurrences: (item: ObservationInboxItem) => number;
  readonly metricRenderers: ObservationMetricRenderers;
  readonly signalRenderers: ObservationSignalRenderers;
  readonly skillChainRenderers: ObservationSkillChainRenderers;
}) {
  const {
    canonicalFeedbackSignalsForDisplay,
    confidenceHeaderHelp,
    shouldIncludeDownstreamFeedbackForDisplay,
  } = metricRenderers;
  const { collectSkillChainAdvisoryCodes } = skillChainRenderers;
  const {
    renderEvidenceCell,
    renderEvidenceDetailList,
    renderOccurrences,
    renderSeverityBadge,
    renderSignalLabel,
    renderSourceBadge,
    reviewSeverityMeta,
    semanticEvidence,
    signalRuleDescription,
  } = signalRenderers;
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
  const {
    renderTimelinePair,
  } = createObservationTimelineRenderers({
    experience,
    reviewState,
    canonicalFeedbackSignalsForDisplay,
    reviewStateKey,
    shouldIncludeDownstreamFeedbackForDisplay,
  });
  const renderReviewRows = (groupItems: ObservationInboxItem[], idPrefix: string): string => groupItems.map((item, index) => {
    const evidence = semanticEvidence(item);
    const detailsId = `${idPrefix}-detail-${index}`;
    const searchText = [item.severity, item.sourceKind, item.skillName, item.signalType, item.signalSubtype, evidence, item.cwd, item.sourceTrace].join(' ').toLowerCase();
    return `<tr data-observe-row="review" data-severity="${e(item.severity)}" data-search="${e(searchText)}" data-detail-id="${detailsId}">
      <td style="padding:8px 10px">${renderSeverityBadge(item)}${renderSourceBadge(item)}</td>
      <td style="padding:8px 10px">${renderSignalLabel(item)}</td>
      <td class="num" style="padding:8px 10px;text-align:right">${renderOccurrences(item)}</td>
      <td class="num" style="padding:8px 10px;text-align:right">${item.confidence.toFixed(2)} / ${item.attributionConfidence.toFixed(2)}</td>
      <td style="padding:8px 10px;color:var(--text-muted);font-size:12px">${e(observedItemTimestamp(item, item.lastSeen))}</td>
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
            ${renderField('firstSeen', timestampedOccurrences(item) > 0 ? item.firstSeen : '未记录')}
            ${renderField('lastSeen', timestampedOccurrences(item) > 0 ? item.lastSeen : '未记录')}
            ${renderField('timestampCoverage', `${timestampedOccurrences(item)}/${item.occurrences}`)}
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
  return {
    fallbackEvidenceChain,
    renderConfidenceHeader,
    renderPriorityBadge,
    renderAssistiveInference,
    reviewStateKey,
    renderExperienceBasis,
    renderRuleFindings,
    renderEvidenceChain,
    renderReviewRows,
    renderTimelinePair,
  };
}
