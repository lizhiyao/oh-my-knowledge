import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { resolveObservationReviewSession } from '../../src/observability/resolved-review.js';
import type { ObservationReviewState } from '../../src/observability/review-state.js';
import type { ExperienceSessionStoryAnswer } from '../../src/observability/experience.js';

const emptyReviewState: ObservationReviewState = {
  kind: 'observe-review-state',
  schemaVersion: 1,
  updatedAt: '2026-05-18T00:00:00.000Z',
  entries: {},
};

function answer(key: ExperienceSessionStoryAnswer['key'], label: string): ExperienceSessionStoryAnswer {
  return {
    key,
    label,
    status: 'unknown',
    reason: 'unknown_dominant',
    sourceItemKeys: [],
    text: '',
    evidenceRefs: [],
    checklistItems: [],
  };
}

describe('resolveObservationReviewSession', () => {
  it('uses LLM assessment to promote priority and replace answers when there is no manual review', () => {
    const resolved = resolveObservationReviewSession({
      session: {
        id: 'session-a',
        skillName: 'yuque',
        reviewPriority: 'routine_sample',
        sessionStory: {
          answers: [answer('goal_satisfaction', '用户目标有没有被满足')],
        },
      },
      enhancedReview: {
        runtimeAssessment: {
          goalSatisfaction: 'failed',
          declaredBehaviorFit: 'passed',
          artifactGoalMatch: 'failed',
          userFeeling: 'frustrated',
        },
        userExperienceSignals: {
          useful: 'failed',
          followUp: 'passed',
          correction: 'unknown',
          negativeFeedback: 'passed',
          interruption: 'unknown',
          frustration: 'passed',
        },
        userGoal: {
          summary: '读取语雀文档并总结',
          slots: ['语雀文档', '总结'],
          expectedOutcome: '文档结论',
        },
        reviewerSummary: 'LLM 判断目标未满足。',
      },
      reviewState: emptyReviewState,
    });

    assert.equal(resolved.priority, 'review_first');
    assert.equal(resolved.answers[0].status, 'attention');
    assert.equal(resolved.answers[0].checklistItems.some((item) => item.source === 'llm_soft'), true);
    assert.equal(resolved.answers[0].checklistItems.some((item) => /passed|failed|unknown|frustrated/.test(item.label)), false);
    assert.equal(resolved.reviewerSummary, 'LLM 判断目标未满足。');
  });

  it('keeps deterministic priority when the session has manual review', () => {
    const resolved = resolveObservationReviewSession({
      session: {
        id: 'session-b',
        skillName: 'yuque',
        reviewPriority: 'routine_sample',
        sessionStory: {
          answers: [answer('goal_satisfaction', '用户目标有没有被满足')],
        },
      },
      enhancedReview: {
        runtimeAssessment: {
          goalSatisfaction: 'failed',
          declaredBehaviorFit: 'failed',
          artifactGoalMatch: 'failed',
          userFeeling: 'negative',
        },
      },
      reviewState: {
        ...emptyReviewState,
        entries: {
          'experience_session:session-b': {
            targetType: 'experience_session',
            targetId: 'session-b',
            verdict: 'reviewed',
            reviewedAt: '2026-05-18T00:01:00.000Z',
          },
        },
      },
    });

    assert.equal(resolved.priority, 'routine_sample');
    assert.equal(resolved.source, 'manual');
  });

  it('uses type-specific checklist to promote priority and bind owner suggestions', () => {
    const resolved = resolveObservationReviewSession({
      session: {
        id: 'session-c',
        skillName: 'apply-cc',
        reviewPriority: 'routine_sample',
        sessionStory: {
          answers: [
            answer('goal_satisfaction', '用户目标有没有被满足'),
            answer('declared_behavior_fit', '行为是否符合能力用途'),
          ],
        },
      },
      enhancedReview: {
        skillType: 'delegation',
        runtimeAssessment: {
          goalSatisfaction: 'passed',
          declaredBehaviorFit: 'passed',
          artifactGoalMatch: 'unknown',
          userFeeling: 'neutral',
        },
        typeSpecificAssessment: {
          summary: '父会话越界接手。',
          checklist: [{
            key: 'parent_boundary_kept',
            label: '父会话没有接手原任务',
            status: 'failed',
            reason: '父会话直接读取目标项目源码。',
            evidence: ['grep project source'],
            suggestionKey: 'delegation_parent_boundary',
          }],
        },
        ownerSuggestions: [{
          title: '补强父会话边界',
          body: 'child 跑偏后只能纠偏或重跑。',
          acceptanceCriteria: '下次复盘不再出现 parent takeover。',
          checklistItemKey: 'parent_boundary_kept',
        }],
      },
      reviewState: emptyReviewState,
    });

    assert.equal(resolved.priority, 'review_first');
    assert.equal(resolved.skillType, 'delegation');
    assert.equal(resolved.typeSpecificChecklist[0]?.suggestionKey, 'delegation_parent_boundary');
    assert.equal(resolved.answers.find((item) => item.key === 'declared_behavior_fit')?.status, 'attention');
    assert.equal(resolved.ownerSuggestions[0]?.checklistItemKey, 'parent_boundary_kept');
    assert.equal(resolved.ownerSuggestions[0]?.checklistItemLabel, '委派型：父会话没有接手原任务');
  });
});
