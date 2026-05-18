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
});
