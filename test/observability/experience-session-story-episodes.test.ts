import { describe, expect, it } from 'vitest';
import {
  episodeFeedbackAttributionBelongsToEpisode,
  episodeRangeContainsRef,
  messageRangeOverlapsEpisodeRange,
  sessionStoryEpisodeBoundaryReason,
} from '../../src/observability/experience/session-story-episodes.js';
import type {
  ExperienceEpisodeBoundaryReason,
  ExperienceFeedbackAttribution,
  ExperienceOrchestrationEdge,
} from '../../src/observability/experience.js';
import type { ExperienceEpisodeRange } from '../../src/observability/experience/session-story-episodes.js';
import type { ExperienceMessageRange } from '../../src/observability/contracts/experience.js';

const range: ExperienceEpisodeRange = {
  startMessageIndex: 10,
  endMessageIndex: 20,
  traceId: 'trace-main',
  sourceTrace: 'session-a.jsonl',
  sessionId: 'session-a',
};

describe('会话故事：证据归属与片段边界', () => {
  it('episodeRangeContainsRef 要求索引落在窗口内且三重身份一致', () => {
    const ref = { messageIndex: 15, traceId: 'trace-main', sourceTrace: 'session-a.jsonl', sessionId: 'session-a' };
    expect(episodeRangeContainsRef(range, ref)).toBe(true);
    // 索引相同但属于另一条 trace：不能算进本片段，否则跨会话证据会被串起来。
    expect(episodeRangeContainsRef(range, { ...ref, traceId: 'trace-other' })).toBe(false);
    expect(episodeRangeContainsRef(range, { ...ref, sourceTrace: 'session-b.jsonl' })).toBe(false);
    expect(episodeRangeContainsRef(range, { ...ref, sessionId: 'session-b' })).toBe(false);
    // 窗口边界闭合：10/20 含，越界不含；缺索引不含。
    expect(episodeRangeContainsRef(range, { ...ref, messageIndex: 10 })).toBe(true);
    expect(episodeRangeContainsRef(range, { ...ref, messageIndex: 20 })).toBe(true);
    expect(episodeRangeContainsRef(range, { ...ref, messageIndex: 21 })).toBe(false);
    expect(episodeRangeContainsRef(range, { ...ref, messageIndex: 9 })).toBe(false);
    const refWithoutIndex = { traceId: 'trace-main' } as unknown as typeof ref;
    expect(episodeRangeContainsRef(range, refWithoutIndex)).toBe(false);
    expect(episodeRangeContainsRef(range, undefined)).toBe(false);
  });

  it('messageRangeOverlapsEpisodeRange 只在区间真相交且同源时成立', () => {
    const messageRange = {
      startMessageIndex: 18,
      endMessageIndex: 25,
      traceId: 'trace-main',
      sourceTrace: 'session-a.jsonl',
      sessionId: 'session-a',
    } satisfies ExperienceMessageRange;
    expect(messageRangeOverlapsEpisodeRange(messageRange, range)).toBe(true);
    expect(messageRangeOverlapsEpisodeRange(
      { ...messageRange, startMessageIndex: 21, endMessageIndex: 30 },
      range,
    )).toBe(false);
    // 相接于边界也算相交（10 与 20 都属闭区间）。
    expect(messageRangeOverlapsEpisodeRange(
      { ...messageRange, startMessageIndex: 0, endMessageIndex: 10 },
      range,
    )).toBe(true);
    expect(messageRangeOverlapsEpisodeRange({ ...messageRange, traceId: 'trace-other' }, range)).toBe(false);
    expect(messageRangeOverlapsEpisodeRange({ ...messageRange, sourceTrace: 'session-b.jsonl' }, range)).toBe(false);
    expect(messageRangeOverlapsEpisodeRange({ ...messageRange, sessionId: 'session-b' }, range)).toBe(false);
  });

  it('编排边理由的反馈归属必须真挂到本片段的边上', () => {
    // 只填该判定读到的两个身份字段，其余字段与本用例无关。
    const edges = [{ parentSkillSegmentId: 'seg-parent', executorSkillSegmentId: 'seg-exec' }] as unknown as ExperienceOrchestrationEdge[];
    const segmentIds = new Set(['seg-parent', 'seg-exec', 'seg-alone']);
    const attribution = (over: Partial<ExperienceFeedbackAttribution>): ExperienceFeedbackAttribution => ({
      skillSegmentId: 'seg-exec',
      reasonCode: 'orchestration_edge',
      ...over,
    } as unknown as ExperienceFeedbackAttribution);

    expect(episodeFeedbackAttributionBelongsToEpisode(attribution({}), segmentIds, edges)).toBe(true);
    // 段在集合里但不沾本片段任何一条边：不能因为"存在边"就归进来。
    expect(episodeFeedbackAttributionBelongsToEpisode(
      attribution({ skillSegmentId: 'seg-alone' }),
      segmentIds,
      edges,
    )).toBe(false);
    expect(episodeFeedbackAttributionBelongsToEpisode(
      attribution({ skillSegmentId: 'seg-outside' }),
      segmentIds,
      edges,
    )).toBe(false);
    expect(episodeFeedbackAttributionBelongsToEpisode(
      attribution({ skillSegmentId: undefined }),
      segmentIds,
      edges,
    )).toBe(false);
    // 非编排边的归属只看段是否属于本片段。
    expect(episodeFeedbackAttributionBelongsToEpisode(
      attribution({ skillSegmentId: 'seg-alone', reasonCode: 'same_trace' as ExperienceFeedbackAttribution['reasonCode'] }),
      segmentIds,
      edges,
    )).toBe(true);
  });

  it('片段边界理由按既定优先级取值', () => {
    const session = (userGoalShiftCount: number) => ({
      indicators: { userGoalShiftCount },
    }) as Parameters<typeof sessionStoryEpisodeBoundaryReason>[0];
    const edge = { parentSkillSegmentId: 'seg-a', executorSkillSegmentId: 'seg-b' } as ExperienceOrchestrationEdge;
    const dispatch = { branchId: 'branch-1' } as Parameters<typeof sessionStoryEpisodeBoundaryReason>[1][number];
    const pick = (
      userGoalShiftCount: number,
      dispatches: number,
      edges: number,
      closure: 'closed' | 'open',
    ): ExperienceEpisodeBoundaryReason => sessionStoryEpisodeBoundaryReason(
      session(userGoalShiftCount),
      dispatches > 0 ? [dispatch] : [],
      edges > 0 ? [edge] : [],
      closure as Parameters<typeof sessionStoryEpisodeBoundaryReason>[3],
    );

    expect(pick(2, 1, 1, 'closed')).toBe('goal_shift');
    expect(pick(0, 1, 1, 'closed')).toBe('checkpoint_or_subagent');
    expect(pick(0, 0, 1, 'closed')).toBe('downstream_closed');
    // 有编排边但未闭合，不能声称下游已收口。
    expect(pick(0, 0, 1, 'open')).toBe('session_end');
    expect(pick(0, 0, 0, 'closed')).toBe('session_end');
  });
});
