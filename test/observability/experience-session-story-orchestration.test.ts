/**
 * 会话故事的「父子关系还原」行为用例：编排边、分支 dispatch 归属、上游委派证据。
 *
 * 这一层的判定会把「谁启动了谁」写进观察报告，属于容易被误读成因果结论的派生事实，
 * 因此每条用例都同时断言「给出这条边」和「不给这条边」两种方向。
 */
import { describe, expect, it } from 'vitest';
import {
  bestPriorUpstreamSkillSegmentForRuntime,
  dispatchAttachmentEvidenceRef,
  dispatchParentSkillSegment,
  dispatchTerminalLifecycle,
  mentionedUpstreamSkillSegmentForRuntime,
  sessionStoryOrchestrationEdges,
} from '../../src/observability/experience/session-story-orchestration.js';
import type {
  ExperienceSessionStorySubagentDispatch,
  ExperienceSkillSegment,
  ExperienceTimelineEvent,
} from '../../src/observability/experience.js';
import {
  at,
  branchOf,
  CHILD_SESSION,
  CHILD_SOURCE,
  CHILD_TRACE,
  childExecutorSegment,
  dispatchOf,
  event,
  invocationsOf,
  MAIN_SESSION,
  MAIN_TRACE,
  mainlineSegment,
  refOf,
  routerSegment,
  sessionOf,
} from './experience-story-fixtures.js';

describe('会话故事：编排边构建', () => {
  it('已有分支证据时，同一次启动不因推断与分支各记一条而重复', () => {
    const runner = event({ kind: 'tool_use', toolName: 'Task', messageIndex: 10, snippet: 'spawned subagent', fullText: 'session_id: session-child' });
    const completed = event({ kind: 'lifecycle', label: 'turn_completed', messageIndex: 5, traceId: CHILD_TRACE, sourceTrace: CHILD_SOURCE, sessionId: CHILD_SESSION });
    const dispatch = dispatchOf({ id: 'dispatch-1', branchId: 'branch-1', evidenceRefs: [refOf(completed)] });
    const edges = sessionStoryOrchestrationEdges(
      'episode-1',
      [routerSegment(), childExecutorSegment()],
      [dispatch],
      sessionOf({ sessionId: MAIN_SESSION, main: [runner], branches: [branchOf({ id: 'branch-1', events: [completed] })] }),
      invocationsOf([runner]),
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      edgeKind: 'external_child_session',
      parentSkillSegmentId: 'seg-router',
      executorSkillSegmentId: 'seg-executor',
      childSessionId: CHILD_SESSION,
      status: 'completed',
    });
    expect(edges[0]?.runnerCompletedRef?.id).toBe(completed.id);
  });

  it('没有分支终态证据时，推断边只能停在 started，子会话号取自运行文本', () => {
    const runner = event({ kind: 'tool_use', toolName: 'Agent', messageIndex: 10, snippet: 'agent_id: agent-77' });
    const edges = sessionStoryOrchestrationEdges(
      'episode-1',
      [routerSegment(), childExecutorSegment()],
      [],
      sessionOf({ sessionId: MAIN_SESSION, main: [runner], branches: [] }),
      invocationsOf([runner]),
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      edgeKind: 'external_child_session',
      parentSkillSegmentId: 'seg-router',
      executorSkillSegmentId: 'seg-executor',
      childSessionId: 'agent-77',
      status: 'started',
    });
    expect(edges[0]?.runnerStartedRef?.id).toBe(runner.id);
    expect(edges[0]?.runnerCompletedRef).toBeUndefined();
  });

  it('主线内部交接按物理 trace 判定为 internal_skill，不冒充独立子会话', () => {
    const runner = event({ kind: 'tool_use', toolName: 'Task', messageIndex: 5, snippet: '启动子 agent' });
    const inner = mainlineSegment({
      id: 'seg-inner',
      order: 2,
      skillName: 'deep-review',
      startMessageIndex: 30,
      endMessageIndex: 40,
      skillType: 'executor',
      episodeRole: 'main_executor',
    });
    const edges = sessionStoryOrchestrationEdges(
      'episode-1',
      [routerSegment(), inner],
      [],
      sessionOf({ sessionId: MAIN_SESSION, main: [runner], branches: [] }),
      invocationsOf([runner]),
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ edgeKind: 'internal_skill', parentSkillSegmentId: 'seg-router', executorSkillSegmentId: 'seg-inner' });
  });

  it('只有一段运行证据时不编造父辈', () => {
    const runner = event({ kind: 'tool_use', toolName: 'Task', messageIndex: 12, snippet: 'spawned sub-agent' });
    const only = mainlineSegment({
      id: 'seg-only',
      order: 1,
      skillName: 'deep-review',
      startMessageIndex: 10,
      endMessageIndex: 20,
      skillType: 'executor',
      episodeRole: 'main_executor',
    });
    const edges = sessionStoryOrchestrationEdges(
      'episode-1',
      [only],
      [],
      sessionOf({ sessionId: MAIN_SESSION, main: [runner], branches: [] }),
      invocationsOf([runner]),
    );

    expect(edges).toEqual([]);
  });

  it('推断路径因为父子同段而放弃时，仍留一条来自运行证据的兜底边', () => {
    // 运行证据归属 seg-runner（order 2），而更早的 seg-parent 在窗口内被文本提及：
    // 提及段与结构父辈同为 seg-parent，推断边的「父辈 ≠ 执行方」前提不成立，改由运行证据兜底。
    const mention = event({ kind: 'user_message', messageIndex: 30, snippet: '按 seg-parent 流程继续' });
    const runner = event({ kind: 'tool_use', toolName: 'Task', messageIndex: 35, snippet: 'spawned sub-agent' });
    const parent = mainlineSegment({
      id: 'seg-parent',
      order: 1,
      skillName: 'seg-parent',
      startMessageIndex: 0,
      endMessageIndex: 33,
      skillType: 'executor',
      episodeRole: 'main_executor',
    });
    const runnerSegment = mainlineSegment({
      id: 'seg-runner',
      order: 2,
      skillName: 'deep-review',
      startMessageIndex: 34,
      endMessageIndex: 45,
      skillType: 'executor',
      episodeRole: 'main_executor',
    });
    const edges = sessionStoryOrchestrationEdges(
      'episode-1',
      [parent, runnerSegment],
      [],
      sessionOf({ sessionId: MAIN_SESSION, main: [mention, runner], branches: [] }),
      invocationsOf([mention, runner]),
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      edgeKind: 'internal_skill',
      parentSkillSegmentId: 'seg-parent',
      executorSkillSegmentId: 'seg-runner',
      status: 'started',
    });
  });
});

describe('会话故事：分支 dispatch 归属', () => {
  it('父辈候选必须落在主线 trace 上，router 不在主线时退回主线段', () => {
    const offMainRouter = mainlineSegment({
      id: 'seg-router',
      order: 1,
      skillName: 'omk',
      startMessageIndex: 0,
      endMessageIndex: 20,
      skillType: 'router',
      episodeRole: 'router',
      // 该段的全部证据都来自另一条物理 trace：它有 router 身份，但不属于这条会话的主线。
      messageRanges: [{ startMessageIndex: 0, endMessageIndex: 20, traceId: 'trace-other', sourceTrace: 'session-other.jsonl', sessionId: 'session-other' }],
    });
    const onMain = mainlineSegment({
      id: 'seg-main',
      order: 2,
      skillName: 'deep-review',
      startMessageIndex: 21,
      endMessageIndex: 28,
    });
    const mainEvent = event({ kind: 'tool_use', toolName: 'Read', messageIndex: 22, traceId: MAIN_TRACE });
    const session = sessionOf({ sessionId: MAIN_SESSION, main: [mainEvent], branches: [] });
    const dispatch = dispatchOf({ id: 'dispatch-1', branchId: 'branch-1', evidenceRefs: [{ id: 'r', kind: 'tool_use', sourceTrace: CHILD_SOURCE, sessionId: CHILD_SESSION, messageIndex: 2, timestamp: at(25) }] });
    const branchExecutor = childExecutorSegment();

    expect(dispatchParentSkillSegment(
      [offMainRouter, onMain],
      branchExecutor,
      session,
      dispatch,
      offMainRouter,
      undefined,
      undefined,
    )?.id).toBe('seg-main');

    // 同一份证据换成主线 router：角色候选优先，不必退回时序扫描。
    const onMainRouter = mainlineSegment({
      id: 'seg-router',
      order: 1,
      skillName: 'omk',
      startMessageIndex: 0,
      endMessageIndex: 20,
      skillType: 'router',
      episodeRole: 'router',
    });
    expect(dispatchParentSkillSegment(
      [onMainRouter, onMain],
      branchExecutor,
      session,
      dispatch,
      onMainRouter,
      undefined,
      undefined,
    )?.id).toBe('seg-router');
  });

  it('孤立会话的证据自身就是主线，子会话证据不是', () => {
    const mainEvent = event({ kind: 'tool_use', toolName: 'Read', messageIndex: 5, traceId: MAIN_TRACE });
    const session = sessionOf({ sessionId: MAIN_SESSION, main: [mainEvent], branches: [] });
    const dispatch = dispatchOf({
      id: 'dispatch-1',
      branchId: 'branch-1',
      evidenceRefs: [{ id: 'r', kind: 'tool_use', sourceTrace: CHILD_SOURCE, sessionId: CHILD_SESSION, messageIndex: 1, timestamp: at(25) }],
    });
    const standalone = (traceRole: 'standalone' | 'subagent'): ExperienceSkillSegment => mainlineSegment({
      id: `seg-${traceRole}`,
      order: 1,
      skillName: 'deep-review',
      startMessageIndex: 0,
      endMessageIndex: 20,
      // 段窗口挂在另一条物理 trace 上，主线归属只能由证据自身的 traceRole 决定。
      messageRanges: [{ startMessageIndex: 0, endMessageIndex: 20, traceId: 'trace-other', sourceTrace: 'session-other.jsonl', sessionId: 'session-other' }],
      evidenceRefs: [{
        id: `ref-${traceRole}`, kind: 'user_message', sourceTrace: 'session-other.jsonl', sessionId: 'session-other',
        traceId: 'trace-other', traceRole, messageIndex: 1, timestamp: at(1),
      }],
    });

    expect(dispatchParentSkillSegment([standalone('standalone')], childExecutorSegment(), session, dispatch, undefined, undefined, undefined)?.id)
      .toBe('seg-standalone');
    expect(dispatchParentSkillSegment([standalone('subagent')], childExecutorSegment(), session, dispatch, undefined, undefined, undefined))
      .toBeUndefined();
  });

  it('主线段晚于分支启动时不能当父辈，缺分支时间戳时退回顺序', () => {
    const mainEvent = event({ kind: 'tool_use', toolName: 'Read', messageIndex: 5, traceId: MAIN_TRACE });
    const session = sessionOf({ sessionId: MAIN_SESSION, main: [mainEvent], branches: [] });
    const early = mainlineSegment({ id: 'seg-early', order: 1, skillName: 'a', startMessageIndex: 0, endMessageIndex: 9 });
    const late = mainlineSegment({ id: 'seg-late', order: 2, skillName: 'b', startMessageIndex: 30, endMessageIndex: 40 });
    const segments = [early, late];
    const dispatch = dispatchOf({
      id: 'dispatch-1',
      branchId: 'branch-1',
      evidenceRefs: [{ id: 'r', kind: 'tool_use', sourceTrace: CHILD_SOURCE, sessionId: CHILD_SESSION, messageIndex: 1, timestamp: at(20) }],
    });

    expect(dispatchParentSkillSegment(segments, undefined, session, dispatch, undefined, undefined, undefined)?.id).toBe('seg-early');
    // 分支自身没有任何带时间戳的证据时，无法做时序比较，退回「最近开始的主线段」。
    expect(dispatchParentSkillSegment(segments, undefined, session, dispatchOf({ id: 'dispatch-2', branchId: 'branch-2' }), undefined, undefined, undefined)?.id)
      .toBe('seg-late');
  });

  it('分支段自身不在主线时，父辈留空而不是硬塞执行方', () => {
    const mainEvent = event({ kind: 'tool_use', toolName: 'Read', messageIndex: 5, traceId: MAIN_TRACE });
    const session = sessionOf({ sessionId: MAIN_SESSION, main: [mainEvent], branches: [] });
    const executor = childExecutorSegment();

    expect(dispatchParentSkillSegment([executor], executor, session, dispatchOf({ id: 'dispatch-1', branchId: 'branch-1' }), undefined, undefined, undefined))
      .toBeUndefined();
  });

  it('挂载点必须按调用实例身份匹配，身份或位置对不上就不挂', () => {
    const call = event({ kind: 'tool_use', toolName: 'Task', messageIndex: 12, callInstanceId: 'call-1', toolUseId: 'tool-1' });
    const other = event({ kind: 'tool_use', toolName: 'Task', messageIndex: 13, callInstanceId: 'call-2', toolUseId: 'tool-2' });
    const session = sessionOf({ sessionId: MAIN_SESSION, main: [call, other], branches: [] });
    const withMessage = (attachTo: ExperienceSessionStorySubagentDispatch['attachTo']) =>
      dispatchOf({ id: 'dispatch-1', branchId: 'branch-1', attachTo });

    expect(dispatchAttachmentEvidenceRef(session, withMessage({ callInstanceId: 'call-2' }))?.id).toBe(other.id);
    expect(dispatchAttachmentEvidenceRef(session, withMessage({ toolUseId: 'tool-1', messageIndex: 12 }))?.id).toBe(call.id);
    expect(dispatchAttachmentEvidenceRef(session, withMessage({ toolUseId: 'tool-1', messageIndex: 99 }))).toBeUndefined();
    expect(dispatchAttachmentEvidenceRef(session, withMessage({ label: '只看标签不够定位' }))).toBeUndefined();
    expect(dispatchAttachmentEvidenceRef(session, withMessage(undefined))).toBeUndefined();
  });

  it('分支终态只认末事件上的生命周期标签，未收口不得声称完成', () => {
    const completed = event({ kind: 'lifecycle', label: 'turn_completed', messageIndex: 4, traceId: CHILD_TRACE, sourceTrace: CHILD_SOURCE, sessionId: CHILD_SESSION });
    const aborted = event({ kind: 'lifecycle', label: 'turn_aborted', messageIndex: 4, traceId: CHILD_TRACE, sourceTrace: CHILD_SOURCE, sessionId: CHILD_SESSION });
    const stillRunning = event({ kind: 'tool_use', toolName: 'Bash', messageIndex: 4, traceId: CHILD_TRACE, sourceTrace: CHILD_SOURCE, sessionId: CHILD_SESSION });
    const tree = (events: ExperienceTimelineEvent[], branchId = 'branch-1') => sessionOf({
      sessionId: MAIN_SESSION,
      main: [],
      branches: [branchOf({ id: branchId, events })],
    });
    const dispatch = dispatchOf({ id: 'dispatch-1', branchId: 'branch-1', traceId: CHILD_TRACE, sourceTrace: CHILD_SOURCE });

    expect(dispatchTerminalLifecycle(tree([completed]), dispatch)).toMatchObject({ status: 'completed' });
    expect(dispatchTerminalLifecycle(tree([aborted]), dispatch)).toMatchObject({ status: 'failed' });
    expect(dispatchTerminalLifecycle(tree([completed, stillRunning]), dispatch)).toBeUndefined();
    // 分支 id 对不上时按物理 trace 定位，不能因为 id 变了就丢掉终态。
    expect(dispatchTerminalLifecycle(tree([completed], 'branch-other'), dispatch)?.status).toBe('completed');
    expect(dispatchTerminalLifecycle(sessionOf({ sessionId: MAIN_SESSION, main: [], branches: [] }), dispatch)).toBeUndefined();
  });
});

describe('会话故事：上游委派证据窗口', () => {
  const runnerOwner = mainlineSegment({
    id: 'seg-runner',
    order: 2,
    skillName: 'deep-review',
    startMessageIndex: 31,
    endMessageIndex: 45,
    skillType: 'executor',
    episodeRole: 'main_executor',
  });
  const earlier = mainlineSegment({
    id: 'seg-earlier',
    order: 1,
    skillName: 'knowledge-extract',
    startMessageIndex: 0,
    endMessageIndex: 30,
    skillType: 'delegation',
    episodeRole: 'delegator',
  });
  const runner = event({ kind: 'tool_use', toolName: 'Task', messageIndex: 40 });

  const mentionAt = (messageIndex: number): ExperienceTimelineEvent => event({
    kind: 'user_message',
    messageIndex,
    snippet: '按 knowledge-extract 流程处理',
  });

  it('委派提及必须在 runner 前 8 条消息内，结构父辈可回溯到 20 条', () => {
    const near = [mentionAt(34), runner];
    expect(mentionedUpstreamSkillSegmentForRuntime(runnerOwner, runner, near, [earlier, runnerOwner])?.id).toBe('seg-earlier');
    // 同一条提及只是离 runner 更远（12 条），就不再算「本次委派的直接证据」。
    const far = [mentionAt(28), runner];
    expect(mentionedUpstreamSkillSegmentForRuntime(runnerOwner, runner, far, [earlier, runnerOwner])).toBeUndefined();
    expect(bestPriorUpstreamSkillSegmentForRuntime(runnerOwner, runner, far, [earlier, runnerOwner])?.id).toBe('seg-earlier');
  });

  it('没有文本提及就不声称委派，来自别的物理 trace 的提及也不算证据', () => {
    const silent = [event({ kind: 'user_message', messageIndex: 38, snippet: '继续吧' }), runner];
    expect(mentionedUpstreamSkillSegmentForRuntime(runnerOwner, runner, silent, [earlier, runnerOwner])).toBeUndefined();

    const crossTrace = [mentionAt(38), runner];
    const branchEvent = { ...crossTrace[0], traceId: CHILD_TRACE, sourceTrace: CHILD_SOURCE, sessionId: CHILD_SESSION };
    expect(mentionedUpstreamSkillSegmentForRuntime(runnerOwner, runner, [branchEvent, runner], [earlier, runnerOwner])).toBeUndefined();
  });

  it('两个窗口都不得把更晚的段当父辈', () => {
    const later = mainlineSegment({
      id: 'seg-later',
      order: 3,
      skillName: 'knowledge-extract',
      startMessageIndex: 46,
      endMessageIndex: 60,
      skillType: 'delegation',
      episodeRole: 'delegator',
    });
    const timeline = [mentionAt(38), runner, event({ kind: 'user_message', messageIndex: 50, snippet: '按 knowledge-extract 流程处理' })];
    const segments = [runnerOwner, later];

    expect(mentionedUpstreamSkillSegmentForRuntime(runnerOwner, runner, timeline, segments)).toBeUndefined();
    expect(bestPriorUpstreamSkillSegmentForRuntime(runnerOwner, runner, timeline, segments)).toBeUndefined();
  });
});
