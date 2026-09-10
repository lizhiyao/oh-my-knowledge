import type {
  KnowledgeDebuggerViewModel
} from '../../../observability/view-models/index.js';
import type { Lang } from '../../../shared/language.js';
import type { ReplayCard, ReplayCardInput, ReplayCardTone, ReplayFacet, ReplayFacetGroup, ReplayLaneKind, ReplayMilestone, ReplayOperation, ReplayProjection, ReplayProjectionOptions } from '../../view-models/replay.js';
import { inlineMarkdownText } from '../inline-markdown.js';
import {
  trajectoryEvidenceRef
} from '../trajectory-evidence.js';
import { compactText, durationBetween, formatDisplayTimestamp, formatRelativeTimestamp, parseTimestamp, shortHash } from './format.js';
import { adaptiveCardWidth, buildOperationLayout, milestonePosition, projectsAsOperation, projectsToSemanticTrajectory, TRACK_START_PADDING } from './layout.js';
import { ACCESS_LABELS, attachmentSummary, eventPreview, evidenceForStep, evidenceTimestampForStep, inferToolActionLabel, knowledgeKindLabel, lifecycleEventLabel, lifecycleMilestoneTone, observableContextContent, reasoningContentSourceLabel, replayEventModel, resolveToolResultState, resultCardDetail, resultCardStatusLabel, resultCardTone, resultTitle, roleLabel, STEP_LABELS, toolInputPreview, toolOperationTitle, toolStatusLabel } from './summary.js';

export function projectReplay(
  model: KnowledgeDebuggerViewModel,
  lang: Lang,
  options: ReplayProjectionOptions,
): ReplayProjection {
  const { steps, knowledgeEvidence, summary } = model;
  const evidenceById = new Map(knowledgeEvidence.map((item) => [item.id, item]));
  const startTimestamp = summary.observedStartTimestamp;
  const endTimestamp = summary.observedEndTimestamp;
  const startMs = parseTimestamp(startTimestamp);
  const endMs = parseTimestamp(endTimestamp);
  const durationMs = startMs !== undefined && endMs !== undefined && endMs >= startMs ? endMs - startMs : Math.max(1, steps.length - 1) * 1000;
  const cards: ReplayCardInput[] = [];
  const operations: ReplayOperation[] = [];
  const milestones: ReplayMilestone[] = [];
  const facetsById = new Map<string, ReplayFacet>();
  const zh = lang === 'zh';
  const semanticSteps = steps.filter(projectsAsOperation);
  const operationLayout = buildOperationLayout(semanticSteps, startTimestamp, lang, options.pendingToolResults);

  const registerFacet = (group: ReplayFacetGroup, key: string, label: string): string => {
    const id = `${group}:${encodeURIComponent(key.trim().toLocaleLowerCase())}`;
    if (!facetsById.has(id)) facetsById.set(id, { id, label, group });
    return id;
  };

  steps.forEach((step, index) => {
    if (!projectsToSemanticTrajectory(step)) return;
    const operationId = `operation-${index}`;
    const evidence = evidenceForStep(step, evidenceById);

    if (step.stepKind === 'lifecycle') {
      const event = step.events[0];
      const tone = lifecycleMilestoneTone(event?.label);
      milestones.push({
        position: milestonePosition(
          index,
          steps,
          operationLayout.positionsByStepId,
          tone,
          step.timestamp,
          startTimestamp,
          lang,
          options.pendingToolResults,
        ),
        timestamp: step.timestamp,
        label: lifecycleEventLabel(event?.label, lang),
        tone,
      });
      return;
    }

    const position = operationLayout.positionsByStepId.get(step.id) ?? TRACK_START_PADDING;

    if (step.stepKind === 'tool_exchange') {
      const call = step.events[0];
      const result = step.events[1];
      const actionTimestamp = call?.timestamp ?? step.timestamp;
      const resultTimestamp = result?.timestamp ?? step.timestamp;
      const knowledgeTimestamp = evidenceTimestampForStep(evidence, step) ?? resultTimestamp;
      const input = toolInputPreview(call);
      const skillEvidence = evidence.filter((item) => item.knowledgeKind === 'skill');
      const operationTitle = skillEvidence.length > 0
        ? (zh ? `读取 ${skillEvidence.map((item) => item.label).join('、')} Skill` : `Read ${skillEvidence.map((item) => item.label).join(', ')} skill`)
        : toolOperationTitle(call?.toolName ?? step.title, input, lang);
      const cardTitle = compactText(operationTitle, 72);
      const resultState = resolveToolResultState(step, options.pendingToolResults);
      const failed = resultState === 'failure';
      const duration = durationBetween(call?.timestamp, result?.timestamp, lang);
      const operationFacetIds = [
        registerFacet('tool', call?.toolName ?? step.title, call?.toolName ?? step.title),
        ...evidence.map((item) => registerFacet('knowledge', item.knowledgeKind, knowledgeKindLabel(item, lang))),
        ...(failed ? [registerFacet('status', 'failure', zh ? '失败' : 'Failure')] : []),
      ].filter((id, facetIndex, all) => all.indexOf(id) === facetIndex);

      cards.push({
        id: `${operationId}-action`, operationId, lane: 'action', timestamp: actionTimestamp,
        position, tone: 'action', kindLabel: call?.toolName ?? step.title,
        title: cardTitle, detail: '',
        facetIds: operationFacetIds,
        rawId: call ? `${call.kind} · ${call.id}` : step.id, primary: true,
      });

      const firstEvidence = evidence[0];
      if (firstEvidence) {
        cards.push({
          id: `${operationId}-knowledge-${cards.length}`, operationId, lane: 'knowledge', timestamp: knowledgeTimestamp,
          position, tone: 'knowledge',
          kindLabel: evidence.length === 1
            ? `${knowledgeKindLabel(firstEvidence, lang)} · ${ACCESS_LABELS[firstEvidence.accessKind][lang]}`
            : (zh ? `${evidence.length} 项 Knowledge` : `${evidence.length} Knowledge items`),
          title: evidence.length === 1 ? firstEvidence.label : `${firstEvidence.label} +${evidence.length - 1}`,
          detail: evidence.map((item) => item.sourceLocator ?? item.label).join(' · '),
          facetIds: operationFacetIds,
          rawId: evidence.flatMap((item) => item.evidenceRefs.map((ref) => ref.id)).join(' · '), primary: false,
        });
      }

      cards.push({
        id: `${operationId}-result`, operationId, lane: 'result', timestamp: resultTimestamp,
        position, tone: resultCardTone(resultState),
        kindLabel: resultCardStatusLabel(resultState, lang),
        title: resultTitle(step, evidence, lang, input, call?.toolName ?? step.title, resultState),
        detail: resultCardDetail(step, result, duration, lang),
        facetIds: operationFacetIds,
        rawId: result ? `${result.kind} · ${result.id}` : step.id, primary: false,
      });

      operations.push({
        id: operationId,
        facetIds: operationFacetIds,
        selectionLabel: zh ? `${operationTitle} · ${step.events.length + evidence.length} 条关联证据` : `${operationTitle} · ${step.events.length + evidence.length} related records`,
        typeLabel: evidence.length > 0 ? (zh ? '语义操作 · Knowledge 访问' : 'Semantic operation · Knowledge access') : (zh ? '语义操作 · 工具执行' : 'Semantic operation · Tool execution'),
        title: operationTitle,
        summary: result
          ? (zh ? `工具调用与返回结果已按调用标识配对${evidence.length > 0 ? '，相关 Knowledge 同组呈现' : ''}。` : `The tool call and result are paired by call identity${evidence.length > 0 ? ', with related Knowledge shown in the same group' : ''}.`)
          : resultState === 'pending'
            ? (zh ? '已观测到工具调用，正在等待匹配的返回结果。' : 'The tool call is observable and its matching result is still pending.')
            : (zh ? '已观测到工具调用，但当前 trace 中没有匹配到返回结果。' : 'A tool call was observed, but no matching result appears in the trace.'),
        evidenceLabel: zh ? `${step.events.length + evidence.length} 条关联证据` : `${step.events.length + evidence.length} related records`,
        fields: [
          { label: zh ? '执行' : 'Action', value: `${call?.toolName ?? step.title} · ${inferToolActionLabel(evidence, lang)}`, detail: compactText(input || (zh ? '未记录输入' : 'Input not recorded'), 520), evidence: trajectoryEvidenceRef(call), detailKind: 'content' },
          { label: zh ? '结果' : 'Result', value: `${toolStatusLabel(resultState, lang)}${duration ? ` · ${duration}` : ''}`, detail: result ? eventPreview(result, zh ? '工具没有返回内容。' : 'The tool returned no content.') : resultState === 'pending' ? (zh ? '正在等待工具结果写入 trace。' : 'Waiting for the tool result to appear in the trace.') : (zh ? '当前 trace 中没有匹配到工具结果。' : 'No matching tool result in this trace.'), evidence: trajectoryEvidenceRef(result), detailKind: 'result' },
          { label: 'Knowledge', value: evidence.length > 0 ? evidence.map((item) => `${knowledgeKindLabel(item, lang)} · ${item.label}`).join('、') : (zh ? '未关联' : 'Not associated'), detail: evidence.length > 0 ? evidence.map((item) => `${item.accessKind} · ${shortHash(item.contentHash)}`).join('\n') : (zh ? '未从本次工具交换投影出 Knowledge' : 'No Knowledge projected from this tool exchange') },
        ],
        events: step.events,
      });
      return;
    }

    if (step.stepKind === 'runtime_context' || step.stepKind === 'skill_context') {
      const first = evidence[0];
      const contextEvent = step.events[0];
      const contextContent = observableContextContent(contextEvent);
      const knowledgeTimestamp = evidenceTimestampForStep(evidence, step) ?? step.timestamp;
      const operationFacetIds = first
        ? [registerFacet('knowledge', first.knowledgeKind, knowledgeKindLabel(first, lang))]
        : [];
      cards.push({
        id: `${operationId}-knowledge-${cards.length}`, operationId, lane: 'knowledge', timestamp: knowledgeTimestamp,
        position, tone: 'knowledge',
        kindLabel: first
          ? (evidence.length === 1 ? `${knowledgeKindLabel(first, lang)} · ${ACCESS_LABELS[first.accessKind][lang]}` : (zh ? `${evidence.length} 项 Knowledge` : `${evidence.length} Knowledge items`))
          : STEP_LABELS[step.stepKind][lang],
        title: first ? (evidence.length === 1 ? first.label : `${first.label} +${evidence.length - 1}`) : step.title,
        detail: first
          ? evidence.map((item) => item.sourceLocator ?? item.label).join(' · ')
          : compactText(eventPreview(step.events[0], zh ? '任务上下文进入 trace' : 'Task context entered the trace'), 100),
        facetIds: operationFacetIds,
        rawId: first
          ? evidence.flatMap((item) => item.evidenceRefs.map((ref) => ref.id)).join(' · ')
          : step.events.map((event) => event.id).join(' · '),
        primary: true,
      });
      operations.push({
        id: operationId,
        facetIds: operationFacetIds,
        selectionLabel: zh ? `${first?.label ?? STEP_LABELS[step.stepKind][lang]} · ${Math.max(1, step.events.length)} 条证据` : `${first?.label ?? STEP_LABELS[step.stepKind][lang]} · ${Math.max(1, step.events.length)} record${step.events.length === 1 ? '' : 's'}`,
        typeLabel: zh ? 'Knowledge · 进入上下文' : 'Knowledge · Entered context',
        title: first ? `${first.label} ${ACCESS_LABELS[first.accessKind][lang]}` : STEP_LABELS[step.stepKind][lang],
        summary: zh ? '该信息在本次任务的可见上下文中出现。' : 'This information appears in the observable context for the task.',
        evidenceLabel: zh ? `${step.events.length} 条规范化事件` : `${step.events.length} normalized event${step.events.length === 1 ? '' : 's'}`,
        fields: [
          { label: 'Knowledge', value: evidence.map((item) => `${knowledgeKindLabel(item, lang)} · ${item.label}`).join('、') || step.title, detail: evidence.map((item) => item.sourceLocator ?? '').filter(Boolean).join('\n') || (zh ? '来源未记录' : 'Source not recorded') },
          { label: zh ? '访问方式' : 'Access', value: first ? ACCESS_LABELS[first.accessKind][lang] : STEP_LABELS[step.stepKind][lang], detail: formatDisplayTimestamp(first?.firstSeen ?? step.timestamp, lang) },
          {
            label: zh ? '上下文内容' : 'Context content',
            value: contextContent ? (zh ? '源日志已记录可见内容' : 'Observable content recorded') : (zh ? '源日志未记录上下文内容' : 'Context content not recorded by the source log'),
            detail: contextContent ?? (zh ? '当前规范化事件只保留了上下文类型与元数据。' : 'The normalized event only retains the context type and metadata.'),
            copyable: Boolean(contextContent),
            evidence: trajectoryEvidenceRef(contextEvent),
            detailKind: 'content',
          },
          { label: zh ? '内容身份' : 'Content identity', value: first?.contentHash ? `sha256:${shortHash(first.contentHash)}` : (zh ? '未记录哈希' : 'Hash not recorded'), detail: zh ? '只标识观测到的内容，不推断是否被模型采用' : 'Identifies observed content without inferring model use' },
        ],
        events: step.events,
      });
      return;
    }

    const event = step.events[0];
    const modelActivity = step.stepKind === 'model_activity';
    const eventModel = replayEventModel(step, event);
    const conversation = ['user_request', 'user_message', 'user_correction', 'assistant_message', 'model_activity'].includes(step.stepKind);
    const lane: ReplayLaneKind = conversation ? 'conversation' : 'result';
    const tone: ReplayCardTone = step.stepKind === 'user_correction'
      ? 'warning'
      : modelActivity
        ? 'reasoning'
      : step.toolStatus === 'failure'
        ? 'failure'
        : conversation ? 'message' : 'result';
    const opaqueModelActivity = modelActivity && event?.contentVisibility === 'opaque';
    const messageAttachments = event?.attachments ?? [];
    const messageAttachmentLabel = attachmentSummary(messageAttachments, lang);
    const text = eventPreview(event, opaqueModelActivity
      ? (zh ? '不可见' : 'Unavailable')
      : (zh ? '没有可展示的事件内容。' : 'No event content available.'));
    const operationFacetIds = step.toolStatus === 'failure'
      ? [registerFacet('status', 'failure', zh ? '失败' : 'Failure')]
      : [];
    cards.push({
      id: `${operationId}-event`, operationId, lane, timestamp: step.timestamp, position, tone,
      conversationRole: conversation ? (step.stepKind === 'assistant_message' || modelActivity ? 'assistant' : 'user') : undefined,
      kindLabel: modelActivity
        ? STEP_LABELS.model_activity[lang]
        : conversation
        ? (step.stepKind === 'user_correction' ? STEP_LABELS.user_correction[lang] : roleLabel(event, lang))
        : STEP_LABELS[step.stepKind][lang],
      model: eventModel,
      title: text,
      detail: messageAttachmentLabel,
      facetIds: operationFacetIds,
      rawId: event ? `${event.kind} · ${event.id}` : step.id, primary: true,
      compact: opaqueModelActivity,
    });
    operations.push({
      id: operationId,
      facetIds: operationFacetIds,
      selectionLabel: zh ? `${STEP_LABELS[step.stepKind][lang]} · ${step.events.length} 条证据` : `${STEP_LABELS[step.stepKind][lang]} · ${step.events.length} record${step.events.length === 1 ? '' : 's'}`,
      typeLabel: modelActivity
        ? (zh ? '模型活动 · 可观测事实' : 'Model activity · Observable fact')
        : conversation ? (zh ? '消息 · 对话' : 'Message · Conversation') : (zh ? '事件 · 系统结果' : 'Event · System result'),
      title: STEP_LABELS[step.stepKind][lang],
      summary: modelActivity
        ? (opaqueModelActivity
          ? (zh ? 'Trace 记录了模型思考事件，但没有暴露可读内容。' : 'The trace records model reasoning, but exposes no readable content.')
          : (zh ? '以下内容来自 trace 暴露的明文摘要或文本，不是 OMK 对未公开模型内部状态的推断。' : 'The content below is plaintext exposed by the trace, not an OMK inference about unexposed model internals.'))
        : conversation ? (zh ? '按 trace 中记录的角色、时间和内容客观呈现。' : 'Shown from the role, time, and content recorded in the trace.') : (zh ? '该事件按原始 trace 顺序呈现。' : 'This event is shown in source trace order.'),
      evidenceLabel: zh ? `${step.events.length} 条规范化事件` : `${step.events.length} normalized event${step.events.length === 1 ? '' : 's'}`,
      fields: modelActivity
        ? [
          {
            label: zh ? '可见性' : 'Visibility',
            value: opaqueModelActivity ? (zh ? '内容不可见' : 'Content unavailable') : (zh ? '可读明文' : 'Readable plaintext'),
            detail: opaqueModelActivity
              ? (zh ? '来源只提供加密内容；OMK 不解密，也不推断其含义。' : 'The source only provides encrypted content; OMK neither decrypts nor infers it.')
              : reasoningContentSourceLabel(event?.contentSource, lang),
          },
          { label: zh ? '时间' : 'Time', value: formatRelativeTimestamp(step.timestamp, startTimestamp), detail: formatDisplayTimestamp(step.timestamp, lang) },
          ...(eventModel ? [{ label: zh ? '模型' : 'Model', value: eventModel, detail: zh ? '由 trace 明确记录的事件模型' : 'Event model explicitly recorded by the trace' }] : []),
          ...(opaqueModelActivity ? [] : [{
            label: zh ? '可见内容' : 'Visible content',
            value: text,
            detail: reasoningContentSourceLabel(event?.contentSource, lang),
            presentation: 'content' as const,
            evidence: trajectoryEvidenceRef(event),
          }]),
        ]
        : [
          { label: zh ? '角色' : 'Role', value: roleLabel(event, lang), detail: event?.kind ?? step.stepKind },
          { label: zh ? '时间' : 'Time', value: formatRelativeTimestamp(step.timestamp, startTimestamp), detail: formatDisplayTimestamp(step.timestamp, lang) },
          ...(eventModel ? [{ label: zh ? '模型' : 'Model', value: eventModel, detail: zh ? '由 trace 明确记录的事件模型' : 'Event model explicitly recorded by the trace' }] : []),
          ...(messageAttachments.length > 0 ? [{
            label: zh ? '附件' : 'Attachments',
            value: messageAttachmentLabel,
            detail: messageAttachments.map((attachment) => attachment.name).join('\n'),
          }] : []),
          {
            label: zh ? '内容' : 'Content',
            value: text,
            detail: zh ? '未做隐藏意图或原因推断' : 'No hidden-intent or causal inference',
            presentation: 'content',
            evidence: trajectoryEvidenceRef(event),
          },
        ],
      events: step.events,
    });
  });

  const sizedCards = cards.map((card): ReplayCard => ({
    ...card,
    row: card.lane === 'conversation' && card.conversationRole === 'assistant' ? 1 : 0,
    width: card.compact ? 14 : adaptiveCardWidth([card.kindLabel, card.model].filter(Boolean).join(' · '), compactText(inlineMarkdownText(card.title), 72), card.detail),
  }));
  const toolOperationCenters = new Map<string, number>();
  sizedCards.filter((card) => card.lane === 'action').forEach((actionCard) => {
    const operationCards = sizedCards.filter((card) => card.operationId === actionCard.operationId);
    const columnWidth = Math.max(...operationCards.map((card) => card.width));
    toolOperationCenters.set(actionCard.operationId, actionCard.position + columnWidth / 2);
  });
  const placedCards = sizedCards.map((card): ReplayCard => {
    const operationCenter = toolOperationCenters.get(card.operationId);
    return operationCenter === undefined
      ? card
      : { ...card, position: operationCenter - card.width / 2 };
  });
  const laneRows: Record<ReplayLaneKind, number> = {
    conversation: placedCards.some((card) => card.lane === 'conversation') ? 2 : 1,
    knowledge: 1,
    action: 1,
    result: 1,
  };

  const facetOrder: Record<ReplayFacetGroup, number> = { knowledge: 0, tool: 1, status: 2 };
  const facets = [...facetsById.values()].sort((a, b) => facetOrder[a.group] - facetOrder[b.group] || a.label.localeCompare(b.label, lang));
  return {
    cards: placedCards,
    operations,
    facets,
    laneRows,
    gaps: operationLayout.gaps,
    axisTicks: operationLayout.axisTicks,
    milestones,
    startTimestamp,
    endTimestamp,
    durationMs,
    detailWidth: operationLayout.detailWidth,
  };
}
