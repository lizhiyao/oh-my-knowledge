import type {
  DebugKnowledgeAccessKind,
  DebugKnowledgeEvidence,
  ExperienceTimelineEvent,
  KnowledgeDebuggerViewModel,
  TaskReplayStep,
  TaskReplayStepKind
} from '../../observability/view-models/index.js';
import type { Lang } from '../../shared/language.js';
import { inlineMarkdownText } from './inline-markdown.js';
import {
  trajectoryEvidenceRef,
  type TrajectoryEvidenceRef
} from './trajectory-evidence.js';

const ACCESS_LABELS: Record<DebugKnowledgeAccessKind, Record<Lang, string>> = {
  injected: { zh: '已注入', en: 'Injected' },
  read: { zh: '已读取', en: 'Read' },
  returned: { zh: '工具返回', en: 'Tool return' },
};

const STEP_LABELS: Record<TaskReplayStepKind, Record<Lang, string>> = {
  user_request: { zh: '用户消息', en: 'User message' },
  user_message: { zh: '用户补充', en: 'User follow-up' },
  user_correction: { zh: '用户纠正', en: 'User correction' },
  runtime_context: { zh: '任务上下文', en: 'Task context' },
  skill_context: { zh: 'Skill 上下文', en: 'Skill context' },
  tool_exchange: { zh: '工具调用', en: 'Tool call' },
  unmatched_tool_result: { zh: '未配对工具结果', en: 'Unmatched tool result' },
  assistant_message: { zh: 'AI 回答', en: 'AI response' },
  model_activity: { zh: '模型思考', en: 'Model reasoning' },
  lifecycle: { zh: '运行状态', en: 'Lifecycle' },
  observation: { zh: '观测事件', en: 'Observation' },
  system_event: { zh: '系统事件', en: 'System event' },
};

export type ReplayLaneKind = 'conversation' | 'knowledge' | 'action' | 'result';

type ReplayCardTone = 'message' | 'reasoning' | 'knowledge' | 'action' | 'result' | 'pending' | 'failure' | 'warning';

type ConversationRole = 'user' | 'assistant';

export type ReplayFacetGroup = 'knowledge' | 'tool' | 'status';

type ReplayMilestoneTone = 'start' | 'end' | 'warning' | 'neutral';

type ToolResultState = 'pending' | 'missing' | 'failure' | 'cancelled' | 'success';

interface ReplayProjectionOptions {
  pendingToolResults: boolean;
}

export interface ReplayFacet {
  id: string;
  label: string;
  group: ReplayFacetGroup;
}

export interface ReplayCard {
  id: string;
  operationId: string;
  lane: ReplayLaneKind;
  timestamp?: string;
  position: number;
  row: number;
  conversationRole?: ConversationRole;
  tone: ReplayCardTone;
  kindLabel: string;
  model?: string;
  title: string;
  detail: string;
  facetIds: string[];
  rawId: string;
  primary: boolean;
  compact?: boolean;
  width: number;
}

interface ReplayGap {
  position: number;
  width: number;
  durationMs: number;
}

interface ReplayAxisTick {
  position: number;
  label: string;
}

interface ReplayMilestone {
  position: number;
  timestamp?: string;
  label: string;
  tone: ReplayMilestoneTone;
}

export interface ReplayField {
  label: string;
  value: string;
  detail: string;
  presentation?: 'default' | 'content';
  copyable?: boolean;
  evidence?: TrajectoryEvidenceRef;
  detailKind?: 'content' | 'result';
}

export interface ReplayOperation {
  id: string;
  facetIds: string[];
  selectionLabel: string;
  typeLabel: string;
  title: string;
  summary: string;
  evidenceLabel: string;
  fields: ReplayField[];
  events: ExperienceTimelineEvent[];
}

export interface ReplayProjection {
  cards: ReplayCard[];
  operations: ReplayOperation[];
  facets: ReplayFacet[];
  laneRows: Record<ReplayLaneKind, number>;
  gaps: ReplayGap[];
  axisTicks: ReplayAxisTick[];
  milestones: ReplayMilestone[];
  startTimestamp?: string;
  endTimestamp?: string;
  durationMs: number;
  detailWidth: number;
}

type ReplayCardInput = Omit<ReplayCard, 'row' | 'width'>;

const REPLAY_CARD_WIDTH = 190;

const REPLAY_CARD_MEDIUM_WIDTH = 154;

const REPLAY_CARD_SMALL_WIDTH = 118;

const REPLAY_COMPACT_CARD_WIDTH = 14;

const OPERATION_LANE_GAP = 20;

const OPERATION_FLOW_ADVANCE = 28;

const COMPACT_FLOW_ADVANCE = 18;

export const TRACK_START_PADDING = 16;

const AXIS_TICK_PADDING = 7;

const AXIS_TICK_GLYPH_WIDTH = 5.5;

const AXIS_TICK_CLEARANCE = 8;

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

function lifecycleEventLabel(label: string | undefined, lang: Lang): string {
  const labels: Record<string, Record<Lang, string>> = {
    session_started: { zh: '会话开始', en: 'Session started' },
    session_ended: { zh: '会话结束', en: 'Session ended' },
    turn_started: { zh: '本轮开始', en: 'Turn started' },
    turn_completed: { zh: '本轮完成', en: 'Turn completed' },
    turn_failed: { zh: '本轮失败', en: 'Turn failed' },
    turn_aborted: { zh: '本轮中止', en: 'Turn aborted' },
    turn_interrupted: { zh: '本轮被打断', en: 'Turn interrupted' },
    turn_ended_unknown: { zh: '本轮结束状态未知', en: 'Turn ended with unknown status' },
    step_started: { zh: '步骤开始', en: 'Step started' },
    step_completed: { zh: '步骤完成', en: 'Step completed' },
  };
  return labels[label ?? '']?.[lang] ?? (label || (lang === 'zh' ? '运行状态变化' : 'Lifecycle event'));
}

function lifecycleMilestoneTone(label: string | undefined): ReplayMilestoneTone {
  if (label === 'session_started' || label === 'turn_started') return 'start';
  if (label === 'session_ended' || label === 'turn_completed') return 'end';
  if (label === 'turn_failed' || label === 'turn_aborted' || label === 'turn_interrupted') return 'warning';
  return 'neutral';
}

function projectsToSemanticTrajectory(step: TaskReplayStep): boolean {
  return step.stepKind !== 'observation' && step.stepKind !== 'system_event';
}

function projectsAsOperation(step: TaskReplayStep): boolean {
  return projectsToSemanticTrajectory(step) && step.stepKind !== 'lifecycle';
}

function displayWidthUnits(value: string): number {
  return [...value].reduce((total, character) => total + (/[^\x00-\xff]/.test(character) ? 2 : 1), 0);
}

function adaptiveCardWidth(kindLabel: string, title: string, detail = ''): number {
  const headUnits = 8 + displayWidthUnits(kindLabel);
  const titleUnitsPerLine = Math.ceil(displayWidthUnits(title) / 2);
  const detailUnits = Math.min(32, displayWidthUnits(detail));
  const requiredUnits = Math.max(headUnits, titleUnitsPerLine, detailUnits);
  if (requiredUnits <= 18) return REPLAY_CARD_SMALL_WIDTH;
  if (requiredUnits <= 27) return REPLAY_CARD_MEDIUM_WIDTH;
  return REPLAY_CARD_WIDTH;
}

function replayEventModel(
  step: TaskReplayStep,
  event: ExperienceTimelineEvent | undefined,
): string | undefined {
  return step.stepKind === 'assistant_message' || step.stepKind === 'model_activity'
    ? event?.model?.trim() || undefined
    : undefined;
}

function attachmentSummary(
  attachments: NonNullable<ExperienceTimelineEvent['attachments']>,
  lang: Lang,
): string {
  const imageCount = attachments.filter((attachment) => attachment.attachmentKind === 'image').length;
  const fileCount = attachments.length - imageCount;
  const parts = lang === 'zh'
    ? [imageCount > 0 ? `图片 ${imageCount} 张` : '', fileCount > 0 ? `文件 ${fileCount} 个` : '']
    : [imageCount > 0 ? `${imageCount} image${imageCount === 1 ? '' : 's'}` : '', fileCount > 0 ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : ''];
  return parts.filter(Boolean).join(' · ');
}

function replayCardWidth(step: TaskReplayStep, lang: Lang, pendingToolResults: boolean): number {
  const event = step.events[0];
  if (step.stepKind === 'model_activity' && event?.contentVisibility === 'opaque') return REPLAY_COMPACT_CARD_WIDTH;
  if (step.stepKind === 'runtime_context' || step.stepKind === 'skill_context') return REPLAY_CARD_WIDTH;
  if (step.stepKind === 'tool_exchange') {
    const call = step.events[0];
    const result = step.events[1];
    const input = toolInputPreview(call).replace(/\s+/g, ' ').trim();
    const resultState = resolveToolResultState(step, pendingToolResults);
    const actionTitle = toolOperationTitle(call?.toolName ?? step.title, input, lang);
    const actionWidth = adaptiveCardWidth(call?.toolName ?? step.title, actionTitle);
    const resultWidth = adaptiveCardWidth(
      resultCardStatusLabel(resultState, lang),
      resultTitle(step, [], lang, input, call?.toolName ?? step.title, resultState),
      resultCardDetail(step, result, durationBetween(call?.timestamp, result?.timestamp, lang), lang),
    );
    return Math.max(actionWidth, resultWidth, step.knowledgeEvidenceIds.length > 0 ? REPLAY_CARD_WIDTH : 0);
  }
  const kindLabel = step.stepKind === 'model_activity'
    ? STEP_LABELS.model_activity[lang]
    : STEP_LABELS[step.stepKind][lang];
  const eventModel = replayEventModel(step, event);
  return adaptiveCardWidth(
    [kindLabel, eventModel].filter(Boolean).join(' · '),
    compactText(inlineMarkdownText(eventPreview(event, step.title)), 72),
  );
}

function replayLayoutTracks(step: TaskReplayStep): ReplayLaneKind[] {
  if (step.stepKind === 'tool_exchange') {
    return step.knowledgeEvidenceIds.length > 0
      ? ['action', 'result', 'knowledge']
      : ['action', 'result'];
  }
  if (step.stepKind === 'runtime_context' || step.stepKind === 'skill_context') return ['knowledge'];
  if (['user_request', 'user_message', 'user_correction', 'assistant_message', 'model_activity'].includes(step.stepKind)) {
    return ['conversation'];
  }
  return ['result'];
}

function operationFlowAdvance(previousStep: TaskReplayStep | undefined, step: TaskReplayStep): number {
  const compact = (candidate: TaskReplayStep | undefined): boolean =>
    candidate?.stepKind === 'model_activity' && candidate.events[0]?.contentVisibility === 'opaque';
  return compact(previousStep) || compact(step) ? COMPACT_FLOW_ADVANCE : OPERATION_FLOW_ADVANCE;
}

function milestonePosition(
  stepIndex: number,
  steps: TaskReplayStep[],
  positionsByStepId: Map<string, number>,
  tone: ReplayMilestoneTone,
  timestamp: string | undefined,
  taskStartTimestamp: string | undefined,
  lang: Lang,
  pendingToolResults: boolean,
): number {
  const milestoneMs = parseTimestamp(timestamp);
  const taskStartMs = parseTimestamp(taskStartTimestamp);
  if (
    tone === 'start'
    && milestoneMs !== undefined
    && taskStartMs !== undefined
    && milestoneMs <= taskStartMs
  ) return 4;

  const operationPositions = [...positionsByStepId.values()];
  const lastPosition = operationPositions.at(-1) ?? TRACK_START_PADDING;
  const lastStep = [...steps].reverse().find(projectsAsOperation);
  const previousStep = [...steps.slice(0, stepIndex)].reverse().find(projectsAsOperation);
  const nextStep = steps.slice(stepIndex + 1).find(projectsAsOperation);
  const previousPosition = previousStep ? positionsByStepId.get(previousStep.id) : undefined;
  const nextPosition = nextStep ? positionsByStepId.get(nextStep.id) : undefined;

  if (previousPosition === undefined) return 4;
  if (nextPosition === undefined) return lastPosition + (lastStep ? replayCardWidth(lastStep, lang, pendingToolResults) : REPLAY_CARD_WIDTH) + 5;
  return tone === 'start'
    ? Math.max(4, nextPosition - 5)
    : previousPosition + (previousStep ? replayCardWidth(previousStep, lang, pendingToolResults) : REPLAY_CARD_WIDTH) + 5;
}

function buildOperationLayout(
  steps: TaskReplayStep[],
  startTimestamp: string | undefined,
  lang: Lang,
  pendingToolResults: boolean,
): { positionsByStepId: Map<string, number>; gaps: ReplayGap[]; axisTicks: ReplayAxisTick[]; detailWidth: number } {
  const gapWidth = 96;
  const gapPadding = 16;
  const laneLabelWidth = 108;
  const idleGapThresholdMs = 60_000;
  const positionsByStepId = new Map<string, number>();
  const positions: number[] = [];
  const gaps: ReplayGap[] = [];
  const rightEdgeByTrack = new Map<ReplayLaneKind, number>();
  const taskStartMs = parseTimestamp(startTimestamp);
  // Session-level context may predate the selected task; keep its card without expanding the task axis.
  const inTaskTimeDomain = (timestamp: string | undefined): number | undefined => {
    const value = parseTimestamp(timestamp);
    if (value === undefined || taskStartMs === undefined) return value;
    return Math.max(value, taskStartMs);
  };
  let previousPosition = TRACK_START_PADDING;
  let previousEndMs: number | undefined;

  steps.forEach((step, index) => {
    const startMs = inTaskTimeDomain(step.timestamp);
    let position = index === 0
      ? TRACK_START_PADDING
      : previousPosition + operationFlowAdvance(steps[index - 1], step);
    if (
      index > 0
      && startMs !== undefined
      && previousEndMs !== undefined
      && startMs - previousEndMs >= idleGapThresholdMs
    ) {
      const occupiedRight = Math.max(position, ...rightEdgeByTrack.values());
      const gapPosition = occupiedRight + gapPadding;
      gaps.push({ position: gapPosition, width: gapWidth, durationMs: startMs - previousEndMs });
      position = gapPosition + gapWidth + gapPadding;
    }

    const tracks = replayLayoutTracks(step);
    for (const track of tracks) {
      const rightEdge = rightEdgeByTrack.get(track);
      if (rightEdge !== undefined) position = Math.max(position, rightEdge + OPERATION_LANE_GAP);
    }

    positions.push(position);
    positionsByStepId.set(step.id, position);
    const rightEdge = position + replayCardWidth(step, lang, pendingToolResults);
    tracks.forEach((track) => rightEdgeByTrack.set(track, rightEdge));
    previousPosition = position;
    const eventTimes = step.events
      .map((event) => inTaskTimeDomain(event.timestamp))
      .filter((value): value is number => value !== undefined);
    previousEndMs = eventTimes.length > 0 ? Math.max(...eventTimes) : startMs ?? previousEndMs;
  });

  const tickStride = Math.max(1, Math.ceil(steps.length / 9));
  const axisTickCandidates = steps.flatMap((step, index): ReplayAxisTick[] => (
    index === 0 || index === steps.length - 1 || index % tickStride === 0
      ? [{ position: positions[index] ?? TRACK_START_PADDING, label: formatRelativeTimestamp(step.timestamp, startTimestamp) }]
      : []
  ));
  const axisTicks = axisTickCandidates.filter((tick, index) => index === 0 || tick.label !== axisTickCandidates[index - 1]?.label);
  const lastPosition = positions.at(-1) ?? TRACK_START_PADDING;
  const lastWidth = steps.length > 0 ? replayCardWidth(steps[steps.length - 1], lang, pendingToolResults) : REPLAY_CARD_WIDTH;
  const occupiedRight = Math.max(lastPosition + lastWidth, ...rightEdgeByTrack.values());
  const detailWidth = Math.max(960, laneLabelWidth + occupiedRight + 24);
  return { positionsByStepId, gaps, axisTicks, detailWidth };
}

function evidenceTimestampForStep(
  evidence: DebugKnowledgeEvidence[],
  step: TaskReplayStep,
): string | undefined {
  const eventIds = new Set(step.events.map((event) => event.id));
  return evidence
    .flatMap((item) => item.evidenceRefs)
    .filter((ref) => eventIds.has(ref.id) && parseTimestamp(ref.timestamp) !== undefined)
    .map((ref) => ref.timestamp as string)
    .sort((a, b) => (parseTimestamp(a) ?? 0) - (parseTimestamp(b) ?? 0))[0];
}

export function visibleAxisTicks(projection: ReplayProjection): ReplayAxisTick[] {
  const candidates = projection.axisTicks
    .filter((tick) => !projection.milestones.some((milestone) => Math.abs(milestone.position - tick.position) < 110))
    .sort((left, right) => left.position - right.position);
  const selectedFromRight: ReplayAxisTick[] = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const tick = candidates[index];
    const rightNeighbor = selectedFromRight.at(-1);
    const occupiedWidth = AXIS_TICK_PADDING + tick.label.length * AXIS_TICK_GLYPH_WIDTH + AXIS_TICK_CLEARANCE;
    if (!rightNeighbor || rightNeighbor.position - tick.position >= occupiedWidth) {
      selectedFromRight.push(tick);
    }
  }
  return selectedFromRight.reverse();
}

function evidenceForStep(
  step: TaskReplayStep,
  evidenceById: Map<string, DebugKnowledgeEvidence>,
): DebugKnowledgeEvidence[] {
  return step.knowledgeEvidenceIds
    .map((id) => evidenceById.get(id))
    .filter((item): item is DebugKnowledgeEvidence => Boolean(item));
}

function toolInputPreview(event: ExperienceTimelineEvent | undefined): string {
  if (!event) return '';
  const text = event.fullText ?? event.snippet ?? '';
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const input = value as Record<string, unknown>;
      for (const key of ['cmd', 'command', 'file_path', 'path', 'url', 'query']) {
        if (typeof input[key] === 'string' && input[key]) return input[key];
      }
      return JSON.stringify(value, null, 2);
    }
  } catch {
    // Keep the source text when the tool input is not JSON.
  }
  return text;
}

function toolOperationTitle(toolName: string, input: string, lang: Lang): string {
  const patchTargets = extractPatchTargets(input);
  if (patchTargets.length > 0) {
    const first = patchTargets[0];
    if (!first) return toolName;
    const action = first.action === 'Add'
      ? (lang === 'zh' ? '新增文件' : 'Add file')
      : first.action === 'Delete'
        ? (lang === 'zh' ? '删除文件' : 'Delete file')
        : (lang === 'zh' ? '修改文件' : 'Update file');
    const suffix = patchTargets.length > 1 ? ` +${patchTargets.length - 1}` : '';
    const separator = lang === 'zh' ? '：' : ': ';
    return `${action}${separator}${first.path}${suffix}`;
  }

  const normalized = input.replace(/\s+/g, ' ').trim();
  const scriptedOperation = scriptedOperationTitle(normalized, lang);
  if (scriptedOperation) return scriptedOperation;
  const toolOperation = semanticToolOperation(toolName, normalized, lang);
  if (toolOperation) return toolOperation.title;
  if (/bash|exec|shell/i.test(toolName)) {
    const shellOperation = shellOperationTitle(normalized, lang);
    if (shellOperation) return shellOperation;
    if (normalized && normalized.length <= 72) return normalized;
    return lang === 'zh' ? '执行 Bash 命令' : 'Run Bash command';
  }
  if (normalized && normalized.length <= 72) return normalized;
  return lang === 'zh' ? `调用 ${toolName}` : `Call ${toolName}`;
}

function scriptedOperationTitle(input: string, lang: Lang): string | undefined {
  if (!input) return undefined;
  if (/\bALL_TOOLS\.filter\s*\(/.test(input)) return lang === 'zh' ? '筛选可用工具' : 'Filter available tools';
  if (/\btools\.update_plan\s*\(/.test(input)) return lang === 'zh' ? '更新任务计划' : 'Update task plan';
  if (/\btools\.apply_patch\s*\(/.test(input)) return lang === 'zh' ? '应用代码修改' : 'Apply code changes';
  const toolCall = input.match(/\btools\.([A-Za-z0-9_]+)\s*\(/)?.[1];
  return toolCall ? (lang === 'zh' ? `调用 ${toolCall}` : `Call ${toolCall}`) : undefined;
}

function shellOperationTitle(input: string, lang: Lang): string | undefined {
  if (!input) return undefined;
  const searchCommand = input.match(/^\s*(?:rg|grep)\b/i);
  if (searchCommand) {
    const quotedTerm = input.match(/["']([^"']+)["']/)?.[1];
    const term = quotedTerm ? compactText(quotedTerm, 42) : undefined;
    return term
      ? (lang === 'zh' ? `搜索：${term}` : `Search: ${term}`)
      : (lang === 'zh' ? '搜索内容' : 'Search content');
  }

  const sedRead = input.match(/^\s*sed\s+-n\s+(?:"[^"]*"|'[^']*'|\S+)\s+(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/i);
  const simpleRead = input.match(/^\s*(?:cat|head|tail)\b(?:\s+-\S+(?:\s+\S+)?)?\s+(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/i);
  const readTarget = sedRead?.slice(1).find(Boolean) ?? simpleRead?.slice(1).find(Boolean);
  if (readTarget) return lang === 'zh' ? `读取：${compactText(readTarget, 48)}` : `Read: ${compactText(readTarget, 48)}`;

  const nodeCommand = parseNodeCommand(input);
  if (nodeCommand) {
    const semanticTitle = semanticNodeOperation(nodeCommand.args, lang)?.title;
    if (semanticTitle) return semanticTitle;
    if (nodeCommand.args[0]?.toLocaleLowerCase() === 'call' && nodeCommand.args[1]) {
      return lang === 'zh' ? `调用：${nodeCommand.args[1]}` : `Call: ${nodeCommand.args[1]}`;
    }
    const scriptName = nodeCommand.script.split('/').at(-1) ?? nodeCommand.script;
    const suffix = nodeCommand.args[0] ? ` ${nodeCommand.args[0]}` : '';
    return lang === 'zh' ? `运行：${scriptName}${suffix}` : `Run: ${scriptName}${suffix}`;
  }

  const gitCommand = input.match(/^\s*git\s+([^\s;|]+)/i)?.[1];
  if (gitCommand) return lang === 'zh' ? `运行：git ${gitCommand}` : `Run: git ${gitCommand}`;
  return undefined;
}

type SemanticAction = 'list' | 'read' | 'resolve' | 'create' | 'update' | 'delete' | 'export' | 'import' | 'search' | 'verify' | 'publish' | 'wait';

interface SemanticOperation {
  action: SemanticAction;
  title: string;
}

function semanticToolOperation(toolName: string, input: string, lang: Lang): SemanticOperation | undefined {
  const normalized = toolName.trim().toLocaleLowerCase().replace(/[\s-]+/g, '_');
  if (/^(?:edit|patch|apply_patch)$/.test(normalized)) {
    return { action: 'update', title: lang === 'zh' ? '编辑内容' : 'Edit content' };
  }
  if (/^(?:wait|write_stdin)$/.test(normalized)) {
    const background = /(?:cell_id|session_id)/i.test(input);
    return {
      action: 'wait',
      title: lang === 'zh'
        ? (background ? '等待后台任务' : '等待任务完成')
        : (background ? 'Wait for background task' : 'Wait for task'),
    };
  }
  if (/^(?:view_image|image_view)$/.test(normalized)) {
    return { action: 'read', title: lang === 'zh' ? '查看图片' : 'View image' };
  }
  return undefined;
}

function parseNodeCommand(input: string): { script: string; args: string[] } | undefined {
  const tokens = tokenizeShellCommand(input);
  if (tokens[0]?.toLocaleLowerCase() !== 'node') return undefined;
  const scriptIndex = tokens.findIndex((token, index) => index > 0 && !token.startsWith('-'));
  const script = scriptIndex >= 0 ? tokens[scriptIndex] : undefined;
  if (!script) return undefined;
  return { script, args: tokens.slice(scriptIndex + 1) };
}

function tokenizeShellCommand(input: string): string[] {
  const tokens: string[] = [];
  const matcher = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s;|]+)/g;
  for (const match of input.matchAll(matcher)) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(["\\])/g, '$1'));
  }
  return tokens;
}

function semanticNodeOperation(args: string[], lang: Lang): SemanticOperation | undefined {
  const mode = args[0]?.toLocaleLowerCase();
  if (!mode) return undefined;
  if (mode === 'call') {
    const operation = args[1];
    if (!operation) return undefined;
    return semanticIdentifierOperation(operation, lang);
  }
  return semanticIdentifierOperation(mode, lang);
}

function semanticIdentifierOperation(identifier: string, lang: Lang): SemanticOperation | undefined {
  const tokens = identifier
    .split(/[._:/-]+/)
    .map((token) => token.toLocaleLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return undefined;

  const actionByToken: Record<string, SemanticAction> = {
    list: 'list', query: 'search', search: 'search', find: 'search',
    get: 'read', read: 'read', fetch: 'read', detail: 'read', details: 'read', toc: 'read',
    resolve: 'resolve', create: 'create', add: 'create', new: 'create',
    update: 'update', edit: 'update', modify: 'update', delete: 'delete', remove: 'delete',
    export: 'export', import: 'import', verify: 'verify', check: 'verify', validate: 'verify',
    publish: 'publish',
  };
  const actionTokenIndex = tokens.findIndex((token) => actionByToken[token]);
  if (actionTokenIndex < 0) return undefined;
  const actionToken = tokens[actionTokenIndex] ?? '';
  const action = actionByToken[actionToken];
  if (!action) return undefined;

  const knownResourceTokens = new Set([
    'api', 'book', 'content', 'detail', 'details', 'doc', 'docs', 'document', 'documents',
    'file', 'files', 'issue', 'markdown', 'md', 'page', 'plan', 'report', 'result', 'results',
    'toc', 'tool', 'tools', 'url', 'urls',
  ]);
  const firstMeaningfulIndex = tokens.findIndex((token) => actionByToken[token] || knownResourceTokens.has(token));
  const meaningfulTokens = tokens.slice(Math.max(0, firstMeaningfulIndex));
  const targetTokens = meaningfulTokens.filter((token) =>
    !actionByToken[token] || token === 'detail' || token === 'details' || token === 'toc');
  const target = semanticResourceLabel(targetTokens, lang);
  const actionLabels: Record<SemanticAction, Record<Lang, string>> = {
    list: { zh: '列出', en: 'List' },
    read: { zh: '读取', en: 'Read' },
    resolve: { zh: '解析', en: 'Resolve' },
    create: { zh: '创建', en: 'Create' },
    update: { zh: '更新', en: 'Update' },
    delete: { zh: '删除', en: 'Delete' },
    export: { zh: '导出', en: 'Export' },
    import: { zh: '导入', en: 'Import' },
    search: { zh: '查询', en: 'Search' },
    verify: { zh: '校验', en: 'Verify' },
    publish: { zh: '发布', en: 'Publish' },
    wait: { zh: '等待', en: 'Wait for' },
  };
  const fallbackTarget = lang === 'zh' ? '可用项' : 'available items';
  const displayTarget = target || fallbackTarget;
  const separator = lang === 'en' || /^[A-Za-z0-9]/.test(displayTarget) ? ' ' : '';
  return { action, title: `${actionLabels[action][lang]}${separator}${displayTarget}` };
}

function semanticResourceLabel(tokens: string[], lang: Lang): string {
  if (tokens.length === 0) return '';
  const joined = tokens.join('_');
  const compoundLabels: Record<string, Record<Lang, string>> = {
    book_toc: { zh: '知识库目录', en: 'knowledge base contents' },
    doc_detail: { zh: '文档详情', en: 'document details' },
    document_detail: { zh: '文档详情', en: 'document details' },
    markdown_doc: { zh: 'Markdown 文档', en: 'Markdown document' },
    markdown_document: { zh: 'Markdown 文档', en: 'Markdown document' },
  };
  const compound = compoundLabels[joined];
  if (compound) return compound[lang];
  const labels: Record<string, Record<Lang, string>> = {
    api: { zh: 'API', en: 'API' }, book: { zh: '知识库', en: 'knowledge base' },
    content: { zh: '内容', en: 'content' }, detail: { zh: '详情', en: 'details' },
    details: { zh: '详情', en: 'details' }, doc: { zh: '文档', en: 'document' },
    docs: { zh: '文档', en: 'documents' }, document: { zh: '文档', en: 'document' },
    documents: { zh: '文档', en: 'documents' }, file: { zh: '文件', en: 'file' },
    files: { zh: '文件', en: 'files' }, issue: { zh: 'Issue', en: 'issue' },
    markdown: { zh: 'Markdown', en: 'Markdown' }, md: { zh: 'Markdown', en: 'Markdown' },
    page: { zh: '页面', en: 'page' }, plan: { zh: '计划', en: 'plan' },
    report: { zh: '报告', en: 'report' }, result: { zh: '结果', en: 'result' },
    results: { zh: '结果', en: 'results' }, toc: { zh: '目录', en: 'contents' },
    tool: { zh: '工具', en: 'tool' }, tools: { zh: '工具', en: 'tools' },
    url: { zh: 'URL', en: 'URL' }, urls: { zh: 'URL', en: 'URLs' },
  };
  const translated = tokens.map((token) => labels[token]?.[lang] ?? token);
  return lang === 'zh' ? translated.join('') : translated.join(' ');
}

function extractPatchTargets(input: string): Array<{ action: 'Add' | 'Update' | 'Delete'; path: string }> {
  const expanded = input.replace(/\\r\\n|\\n/g, '\n');
  return [...expanded.matchAll(/\*\*\*\s+(Add|Update|Delete) File:\s*([^\n\\"']+)/g)]
    .map((match) => ({
      action: match[1] as 'Add' | 'Update' | 'Delete',
      path: match[2]?.trim() ?? '',
    }))
    .filter((target) => target.path.length > 0);
}

function inferToolActionLabel(evidence: DebugKnowledgeEvidence[], lang: Lang): string {
  if (evidence.some((item) => item.accessKind === 'read')) return lang === 'zh' ? '文件读取' : 'File read';
  return lang === 'zh' ? '工具执行' : 'Tool execution';
}

function resultTitle(
  step: TaskReplayStep,
  evidence: DebugKnowledgeEvidence[],
  lang: Lang,
  input = '',
  toolName = '',
  resultState = resolveToolResultState(step, false),
): string {
  const zh = lang === 'zh';
  if (resultState === 'pending') return zh ? '结果获取中' : 'Waiting for result';
  if (resultState === 'missing') return zh ? '结果缺失' : 'Result missing';
  if (resultState === 'failure') return zh ? '工具执行失败' : 'Tool execution failed';
  if (resultState === 'cancelled') return zh ? '工具执行已取消' : 'Tool execution cancelled';
  const result = step.events[1];
  const skillRead = evidence.some((item) => item.knowledgeKind === 'skill' && item.accessKind === 'read');
  if (skillRead && result) {
    const text = result.fullText ?? result.snippet ?? '';
    const lineCount = text ? text.split(/\r?\n/).length : 0;
    return zh ? `返回 ${lineCount} 行内容` : `Returned ${lineCount} line${lineCount === 1 ? '' : 's'}`;
  }
  const facts = structuredResultFacts(result);
  if (facts.ok === false) return zh ? '返回错误信息' : 'Returned an error';
  const nodeCommand = parseNodeCommand(input);
  const action = nodeCommand
    ? semanticNodeOperation(nodeCommand.args, lang)?.action
    : semanticToolOperation(toolName, input, lang)?.action;
  if (facts.itemCount !== undefined) {
    return zh ? `返回 ${facts.itemCount} 项` : `Returned ${facts.itemCount} item${facts.itemCount === 1 ? '' : 's'}`;
  }
  if (facts.title) {
    const title = compactText(facts.title, 52);
    if (action === 'create') return zh ? `已创建：${title}` : `Created: ${title}`;
    if (action === 'update') return zh ? `已更新：${title}` : `Updated: ${title}`;
    return zh ? `返回：${title}` : `Returned: ${title}`;
  }
  const completionLabels: Partial<Record<SemanticAction, Record<Lang, string>>> = {
    create: { zh: '创建完成', en: 'Creation completed' },
    update: { zh: '更新完成', en: 'Update completed' },
    delete: { zh: '删除完成', en: 'Deletion completed' },
    export: { zh: '导出完成', en: 'Export completed' },
    import: { zh: '导入完成', en: 'Import completed' },
    publish: { zh: '发布完成', en: 'Publish completed' },
    wait: { zh: '等待结束', en: 'Wait completed' },
  };
  if (action && completionLabels[action]) return completionLabels[action][lang];
  return zh ? '工具返回结果' : 'Tool returned a result';
}

interface StructuredResultFacts {
  ok?: boolean;
  itemCount?: number;
  title?: string;
}

function structuredResultFacts(event: ExperienceTimelineEvent | undefined): StructuredResultFacts {
  const facts: StructuredResultFacts = {};
  const text = event?.fullText ?? event?.snippet ?? '';
  const parsed = parseStructuredResultText(text);
  if (parsed !== undefined) collectStructuredResultFacts(parsed, facts, undefined, 0);
  return facts;
}

function parseStructuredResultText(text: string): unknown {
  const trimmed = text.trim();
  const outputIndex = trimmed.indexOf('Output:');
  const candidates = outputIndex >= 0
    ? [trimmed.slice(outputIndex + 'Output:'.length).trim(), trimmed]
    : [trimmed];
  for (const candidate of candidates) {
    if (!candidate || !['{', '['].includes(candidate[0] ?? '')) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next observable representation.
    }
  }
  return undefined;
}

function collectStructuredResultFacts(
  value: unknown,
  facts: StructuredResultFacts,
  parentKey: string | undefined,
  depth: number,
): void {
  if (depth > 7 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const parsed = parseStructuredResultText(value);
    if (parsed !== undefined) collectStructuredResultFacts(parsed, facts, parentKey, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    if (['data', 'items', 'results', 'tools'].includes(parentKey ?? '') && facts.itemCount === undefined) {
      facts.itemCount = value.length;
    }
    value.slice(0, 4).forEach((item) => collectStructuredResultFacts(item, facts, parentKey, depth + 1));
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.ok === 'boolean' && facts.ok === undefined) facts.ok = record.ok;
  if (typeof record.title === 'string' && record.title.trim() && facts.title === undefined) {
    facts.title = record.title.trim();
  }
  for (const key of ['output', 'result', 'data', 'items', 'results', 'tools', 'content', 'text']) {
    if (key in record) collectStructuredResultFacts(record[key], facts, key, depth + 1);
  }
}

function resolveToolResultState(step: TaskReplayStep, pendingToolResults: boolean): ToolResultState {
  if (step.toolStatus === 'failure') return 'failure';
  if (step.toolStatus === 'cancelled') return 'cancelled';
  if (step.events.length > 1) return 'success';
  return pendingToolResults ? 'pending' : 'missing';
}

function resultCardTone(state: ToolResultState): ReplayCardTone {
  if (state === 'failure') return 'failure';
  if (state === 'pending') return 'pending';
  if (state === 'missing' || state === 'cancelled') return 'warning';
  return 'result';
}

function resultCardStatusLabel(state: ToolResultState, lang: Lang): string {
  if (state === 'pending') return lang === 'zh' ? '获取中' : 'Pending';
  if (state === 'missing') return lang === 'zh' ? '结果缺失' : 'Missing';
  if (state === 'failure') return lang === 'zh' ? '失败' : 'Failed';
  if (state === 'cancelled') return lang === 'zh' ? '已取消' : 'Cancelled';
  return lang === 'zh' ? '成功' : 'Success';
}

function resultCardDetail(
  step: TaskReplayStep,
  event: ExperienceTimelineEvent | undefined,
  duration: string,
  lang: Lang,
): string {
  if (!event) return '';
  if (step.toolStatus !== 'failure' && !event.isError) return duration;
  const failure = compactText(
    event.fullText ?? event.snippet ?? (lang === 'zh' ? '未记录失败信息' : 'Failure details not recorded'),
    72,
  );
  return [duration, failure].filter(Boolean).join(' · ');
}

function toolStatusLabel(state: ToolResultState, lang: Lang): string {
  const zh = lang === 'zh';
  if (state === 'pending') return zh ? '结果获取中' : 'Waiting for result';
  if (state === 'failure') return zh ? '失败' : 'Failed';
  if (state === 'cancelled') return zh ? '已取消' : 'Cancelled';
  if (state === 'success') return zh ? '成功返回' : 'Returned';
  return zh ? '结果缺失' : 'Result missing';
}

function knowledgeKindLabel(item: DebugKnowledgeEvidence, lang: Lang): string {
  if (item.knowledgeKind === 'project_instruction') return lang === 'zh' ? '项目规则' : 'Project instruction';
  if (item.knowledgeKind === 'skill') return 'Skill';
  return lang === 'zh' ? '运行时证据' : 'Runtime evidence';
}

function roleLabel(event: ExperienceTimelineEvent | undefined, lang: Lang): string {
  if (event?.role === 'user') return lang === 'zh' ? '用户' : 'User';
  if (event?.role === 'assistant') return 'AI';
  if (event?.role === 'tool') return lang === 'zh' ? '工具' : 'Tool';
  return event?.role ?? (lang === 'zh' ? '系统' : 'System');
}

function reasoningContentSourceLabel(
  source: ExperienceTimelineEvent['contentSource'],
  lang: Lang,
): string {
  if (source === 'summary') return lang === 'zh' ? '来源：reasoning summary' : 'Source: reasoning summary';
  if (source === 'content') return lang === 'zh' ? '来源：reasoning content' : 'Source: reasoning content';
  return lang === 'zh' ? '来源：reasoning text' : 'Source: reasoning text';
}

function eventPreview(event: ExperienceTimelineEvent | undefined, fallback: string): string {
  return event?.fullText?.trim() || event?.snippet?.trim() || fallback;
}

function observableContextContent(event: ExperienceTimelineEvent | undefined): string | undefined {
  const fullText = event?.fullText?.trim();
  if (fullText && fullText !== '{}') return fullText;
  return event?.snippet?.trim() || undefined;
}

export function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function durationBetween(start: string | undefined, end: string | undefined, lang: Lang): string {
  const startMs = parseTimestamp(start);
  const endMs = parseTimestamp(end);
  if (startMs === undefined || endMs === undefined || endMs < startMs) return '';
  return formatElapsed(endMs - startMs, lang);
}

export function formatRelativeTimestamp(value: string | undefined, start: string | undefined): string {
  const valueMs = parseTimestamp(value);
  const startMs = parseTimestamp(start);
  if (valueMs === undefined || startMs === undefined) return '—';
  return formatRelativeTime(Math.max(0, valueMs - startMs));
}

export function formatRelativeTime(milliseconds: number): string {
  const totalTenths = Math.max(0, Math.round(milliseconds / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

export function formatDisplayTimestamp(value: string | undefined, lang: Lang): string {
  if (!value) return lang === 'zh' ? '时间未知' : 'Time unknown';
  return value.slice(0, 19).replace('T', ' ');
}

export function formatElapsed(milliseconds: number, lang: Lang): string {
  const seconds = Math.max(0, milliseconds / 1000);
  if (seconds < 60) {
    const value = Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1);
    return lang === 'zh' ? `${value} 秒` : `${value}s`;
  }
  const roundedSeconds = Math.round(seconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  return lang === 'zh' ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes}m ${remainingSeconds}s`;
}

export function shortHash(value: string | undefined): string {
  return value ? value.slice(0, 12) : '—';
}
