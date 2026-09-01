import { e } from '../layout.js';
import {
  getSkillChainAdvisory,
  resolveAdvisoryCommand,
} from '../../../observability/inbox/view-model.js';
import type {
  ObservationInboxViewModel,
  SkillChainAdvisoryCode,
  SkillDerivedStandard,
  SkillLlmEnhancedReviewSections,
} from '../../../observability/inbox/view-model.js';
import { truncateText } from './helpers.js';
import type { ObservationMetricRenderers } from './metric-renderer.js';

export type ObservationSkillChainRenderers = ReturnType<typeof createObservationSkillChainRenderers>;

export function softStandardStatusLabel(status: SkillDerivedStandard['status']): string {
  if (status === 'author_confirmed') return '作者已确认';
  if (status === 'rejected') return '已否决';
  if (status === 'stale') return '已过期';
  return '待作者确认';
}

export function createObservationSkillChainRenderers({
  experienceToolCountsBySkill,
  skillChains,
  skillDerivedStandards,
  metricRenderers,
}: {
  readonly experienceToolCountsBySkill: ReadonlyMap<string, Record<string, number>>;
  readonly skillChains: ObservationInboxViewModel['skillChains'];
  readonly skillDerivedStandards: ObservationInboxViewModel['skillDerivedStandards'];
  readonly metricRenderers: ObservationMetricRenderers;
}) {
  const {
    renderMetric,
    renderMetricShare,
    renderDecisionMetric,
    renderDecisionMetricIfPositive,
    renderDecisionMetricShare,
    renderSoftMetric,
    renderRankedCounts,
    userFacingToolLabel,
    mergeCountsByLabel,
    renderSkillProblemPatterns,
    displayIndicatorsBySkill,
  } = metricRenderers;
  const renderSkillEvidenceSummary = (
    skill: ObservationInboxViewModel['experienceReports'][number]['skills'][number],
  ): string => {
    const indicators = displayIndicatorsBySkill.get(skill.skillName) ?? skill.indicators;
    const toolCounts = Object.keys(skill.toolCounts ?? {}).length > 0
      ? skill.toolCounts
      : experienceToolCountsBySkill.get(skill.skillName);
    const displayToolCounts = mergeCountsByLabel(toolCounts, userFacingToolLabel);
    const total = indicators.toolCallCount;
    const failed = Math.max(0, indicators.toolFailureCount);
    const cancelled = Math.max(0, indicators.toolCancelledCount ?? 0);
    const unknown = Math.max(0, indicators.toolUnknownCount ?? 0);
    const interrupted = Math.max(0, indicators.userInterruptionCount);
    const success = Math.max(0, total - failed - cancelled - unknown);
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
      <div class="summary-row"><span class="summary-title">【skill 运行】</span>${renderMetric('调用段', skill.invocationCount, '次')}<span class="summary-muted">分布 ${skill.sessionCount} 个 session</span>${renderMetric('工具调用', total, '次')}${renderMetricShare('成功', success, total)}${renderDecisionMetricShare('失败', failed, total, 'sample')}${cancelled > 0 ? renderMetricShare('取消', cancelled, total) : ''}${unknown > 0 ? renderMetricShare('状态未知', unknown, total) : ''}${renderDecisionMetric('人工中断', interrupted, 'priority')}${renderDecisionMetricIfPositive('自我纠正', indicators.selfCorrectionCount ?? 0, 'sample')}${renderDecisionMetricIfPositive('重复执行', indicators.repeatedExecutionCount ?? 0, 'sample')}${renderSoftMetric('有结果', indicators.assistantDeliverySignalCount ?? 0, '助手回复里出现明确完成态或结果反馈。')}${renderSoftMetric('有产物', indicators.deliverableArtifactSignalCount ?? 0, '助手回复里出现文档链接、Demo 地址、文件路径、代码块或上传产物。')}</div>
      <div class="summary-row"><span class="summary-title">【用户交互】</span>${renderDecisionMetric('用户纠正', indicators.userCorrectionCount, 'priority')}${renderDecisionMetric('人工中断', indicators.userInterruptionCount, 'priority')}${renderMetric('追问', indicators.userFollowUpCount)}${renderDecisionMetric('负向反馈', indicators.negativeFeedbackCount ?? 0, 'priority')}${renderMetric('正向反馈', indicators.positiveFeedbackCount ?? 0)}${renderMetric('目标切换', indicators.userGoalShiftCount ?? 0)}</div>
      <div class="summary-row"><span class="summary-title">【工具调用】</span>${renderMetric('总计', total, '次')}<span class="summary-detail">(${renderRankedCounts(displayToolCounts, total)})</span>${renderDecisionMetricShare('工具执行失败', failed, total, 'sample')}${cancelled > 0 ? renderMetricShare('工具调用取消', cancelled, total) : ''}${unknown > 0 ? renderMetricShare('结果状态未知', unknown, total) : ''}</div>
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
  return {
    renderSkillEvidenceSummary,
    renderSkillChainSummary,
    collectSkillChainAdvisoryCodes,
    renderSkillChainButton,
    renderRuntimeRuleFlow,
    renderSkillChainTemplate,
  };
}
