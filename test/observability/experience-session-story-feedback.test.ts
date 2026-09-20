/**
 * 会话故事的「反馈归因」行为用例：一条用户反馈该记在哪个能力头上。
 *
 * 归因结果会直接出现在观察报告的「主要归因」里，所以每条用例同时钉住
 * 「凭什么归因」和「证据不足时不许归因」两个方向。
 */
import { describe, expect, it } from 'vitest';
import {
  CHILD_SESSION,
  CHILD_SOURCE,
  CHILD_TRACE,
  MAIN_SESSION,
  childExecutorSegment,
  event,
  invocationsOf,
  mainlineSegment,
  refOf,
  routerSegment,
  sessionOf,
} from './experience-story-fixtures.js';
import {
  feedbackAttributionsForText,
  feedbackSignalType,
  feedbackTargetObject,
  sessionStoryFeedbackSignals,
  sessionStoryPromiseOwners,
} from '../../src/observability/experience/session-story-feedback.js';
import type {
  ExperienceOrchestrationEdge,
  ExperienceSkillSegment,
  ExperienceTimelineEvent,
} from '../../src/observability/experience.js';

const mainSegment = mainlineSegment({
  id: 'seg-exec',
  order: 1,
  skillName: 'deep-review',
  startMessageIndex: 0,
  endMessageIndex: 20,
  skillType: 'executor',
  episodeRole: 'main_executor',
});

const edgeRouterToExecutor = (evidenceRef: ExperienceOrchestrationEdge['runnerStartedRef']): ExperienceOrchestrationEdge => ({
  id: 'edge-1',
  episodeId: 'episode-1',
  edgeKind: 'external_child_session',
  parentSkillSegmentId: 'seg-router',
  executorSkillSegmentId: 'seg-executor',
  status: 'completed',
  runnerStartedRef: evidenceRef ?? undefined,
  evidenceRefs: evidenceRef ? [evidenceRef] : [],
});

const promiseEvents = (): { promise: ExperienceTimelineEvent; feedback: ExperienceTimelineEvent } => ({
  promise: event({
    kind: 'assistant_message',
    messageIndex: 5,
    traceId: CHILD_TRACE,
    sourceTrace: CHILD_SOURCE,
    sessionId: CHILD_SESSION,
    snippet: '有结果我会同步回主线',
  }),
  feedback: event({
    kind: 'user_message',
    messageIndex: 8,
    traceId: CHILD_TRACE,
    sourceTrace: CHILD_SOURCE,
    sessionId: CHILD_SESSION,
    snippet: '为什么没返回结论',
  }),
});

describe('会话故事：反馈归因', () => {
  it('点名某个 skill 的反馈按对象匹配归它自己，凭位置归因时理由不同', () => {
    const named = event({ kind: 'user_message', messageIndex: 10, snippet: 'deep-review 跑偏了，重来' });
    const inside = feedbackAttributionsForText(named.snippet ?? '', refOf(named), [mainSegment], [], [named], []);
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatchObject({ skillName: 'deep-review', attributionRole: 'primary_fault', reasonCode: 'object_match' });

    // 同一条反馈不点名：仍然落在该 skill 的消息窗内，只能按位置归因。
    const unnamed = event({ kind: 'user_message', messageIndex: 12, snippet: '这个结果跑偏了，重来' });
    const byWindow = feedbackAttributionsForText(unnamed.snippet ?? '', refOf(unnamed), [mainSegment], [], [unnamed], []);
    expect(byWindow).toHaveLength(1);
    expect(byWindow[0]).toMatchObject({ skillName: 'deep-review', attributionRole: 'primary_fault', reasonCode: 'episode_context' });
  });

  it('点名具体能力时优先于异步承诺，上游只作为下游关联列出', () => {
    const { promise, feedback } = promiseEvents();
    const named = { ...feedback, snippet: 'deep-review 为什么还没返回结论' };
    const segments = [routerSegment(), childExecutorSegment()];
    const promises = sessionStoryPromiseOwners([promise, named], segments);

    const attributions = feedbackAttributionsForText(
      named.snippet ?? '',
      refOf(named),
      segments,
      [edgeRouterToExecutor(refOf(promise))],
      [promise, named],
      promises,
    );

    expect(attributions.map((attribution) => [attribution.skillName, attribution.attributionRole, attribution.reasonCode])).toEqual([
      ['deep-review', 'primary_fault', 'object_match'],
      ['omk', 'downstream_related', 'orchestration_edge'],
    ]);
  });

  it('委派型能力且不谈子任务时，窗内反馈只作上下文', () => {
    const delegator = mainlineSegment({
      id: 'seg-delegator',
      order: 1,
      skillName: 'delegate-flow',
      startMessageIndex: 0,
      endMessageIndex: 20,
      skillType: 'delegation',
      episodeRole: 'delegator',
    });
    const inside = event({ kind: 'user_message', messageIndex: 10, snippet: '这个结果跑偏了，重来' });
    const attributions = feedbackAttributionsForText(inside.snippet ?? '', refOf(inside), [delegator], [], [inside], []);

    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({ skillName: 'delegate-flow', attributionRole: 'context_only', reasonCode: 'episode_context' });
    expect(attributions.some((attribution) => attribution.attributionRole === 'primary_fault')).toBe(false);
  });

  it('反馈落在所有消息窗之外时只留上下文，不指派主要责任', () => {
    const outside = event({ kind: 'user_message', messageIndex: 40, snippet: '这个结果跑偏了，重来' });
    const attributions = feedbackAttributionsForText(outside.snippet ?? '', refOf(outside), [mainSegment], [], [outside], []);

    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({ skillName: 'deep-review', attributionRole: 'context_only', reasonCode: 'episode_context' });
    expect(attributions.some((attribution) => attribution.attributionRole === 'primary_fault')).toBe(false);
  });

  it('异步承诺的进度反馈先归上游委派方，承诺执行的能力只作为上下文', () => {
    const { promise, feedback } = promiseEvents();
    const segments = [routerSegment(), childExecutorSegment()];
    const promises = sessionStoryPromiseOwners([promise, feedback], segments);
    const edges = [edgeRouterToExecutor(refOf(promise))];

    const attributions = feedbackAttributionsForText(
      feedback.snippet ?? '',
      refOf(feedback),
      segments,
      edges,
      [promise, feedback],
      promises,
    );

    expect(promises).toHaveLength(1);
    expect(promises[0]?.segment.id).toBe('seg-executor');
    expect(attributions.map((attribution) => [attribution.skillName, attribution.attributionRole, attribution.reasonCode])).toEqual([
      ['omk', 'primary_fault', 'promise_match'],
      ['deep-review', 'context_only', 'promise_match'],
    ]);
  });

  it('没有委派边时，做出承诺的能力自己承担主要归因', () => {
    const { promise, feedback } = promiseEvents();
    const segments = [routerSegment(), childExecutorSegment()];
    const promises = sessionStoryPromiseOwners([promise, feedback], segments);

    const attributions = feedbackAttributionsForText(
      feedback.snippet ?? '',
      refOf(feedback),
      segments,
      [],
      [promise, feedback],
      promises,
    );

    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({ skillName: 'deep-review', attributionRole: 'primary_fault', reasonCode: 'promise_match' });
  });

  it('反馈类型按中断 > 纠正 > 挫败 > 正面取值，中性首轮消息不计为反馈', () => {
    expect(feedbackSignalType('[Request interrupted by user] 不对', 3)).toBe('interruption');
    expect(feedbackSignalType('不对，怎么还没返回结论', 1)).toBe('correction');
    expect(feedbackSignalType('太慢了，怎么还没返回', 1)).toBe('frustration');
    expect(feedbackSignalType('这样很好', 1)).toBe('positive');
    expect(feedbackSignalType('继续吧', 0)).toBe('unknown');
    expect(feedbackSignalType('继续吧', 1)).toBe('follow_up');
  });

  it('首条中性用户消息不生成反馈信号，有编排边时按整片段范围归属', () => {
    const neutral = event({ kind: 'user_message', messageIndex: 1, snippet: '继续吧' });
    const complaint = event({ kind: 'user_message', messageIndex: 2, snippet: '太慢了，还没返回' });
    const session = sessionOf({ sessionId: MAIN_SESSION, main: [neutral, complaint], branches: [] });
    const invocations = invocationsOf([neutral, complaint]);
    const segments: ExperienceSkillSegment[] = [mainSegment];

    const withoutEdges = sessionStoryFeedbackSignals(session, invocations, segments, []);
    expect(withoutEdges.map((signal) => signal.type)).toEqual(['frustration']);
    expect(withoutEdges[0]?.sourceWindow).toBe('skill_invocation');

    const withEdges = sessionStoryFeedbackSignals(session, invocations, segments, [edgeRouterToExecutor(refOf(neutral))]);
    expect(withEdges[0]?.sourceWindow).toBe('episode');
  });

  it('目标对象优先取被点名的 skill，其次才是 PR／异步结果／执行流程／产物', () => {
    const segments = [mainSegment];

    expect(feedbackTargetObject('deep-review 的 PR 提错了', segments)).toBe('deep-review');
    expect(feedbackTargetObject('把 PR 拉下来看下', segments)).toBe('PR');
    expect(feedbackTargetObject('有结论了吗', segments)).toBe('异步结果');
    expect(feedbackTargetObject('先停止一下', segments)).toBe('执行流程');
    expect(feedbackTargetObject('报告写好了吗', segments)).toBe('产物');
    expect(feedbackTargetObject('继续吧', segments)).toBeUndefined();
  });
});
