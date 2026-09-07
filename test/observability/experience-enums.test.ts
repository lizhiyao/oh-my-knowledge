import { describe, expect, it } from 'vitest';
import * as enums from '../../src/observability/contracts/experience-enums.js';
import {
  isExperienceEvidenceKind,
  isExperienceReviewPriority,
} from '../../src/observability/experience/report-value-guards.js';

const cases = [
  ['ExperienceReviewPriority', enums.ExperienceReviewPrioritySchema, [
    'review_first',
    'sample_review',
    'routine_sample',
  ]],
  ['ExperienceGoalSliceReasonCode', enums.ExperienceGoalSliceReasonCodeSchema, [
    'skill_segment_boundary',
    'explicit_user_goal_shift',
    'default_session_slice',
  ]],
  ['ExperienceEvidenceKind', enums.ExperienceEvidenceKindSchema, [
    'user_message',
    'synthetic_user_event',
    'assistant_message',
    'model_activity',
    'agent_activity',
    'tool_use',
    'tool_result',
    'skill_context',
    'runtime_context',
    'lifecycle',
    'observation',
  ]],
  ['ExperienceAssistiveInferenceCode', enums.ExperienceAssistiveInferenceCodeSchema, [
    'review_recommended',
    'sample_recommended',
    'positive_signal_observed',
    'user_switched_topic_neutral',
    'no_obvious_issue_from_rules',
    'insufficient_human_context',
  ]],
  ['ExperienceAssistiveInferenceConfidence', enums.ExperienceAssistiveInferenceConfidenceSchema, [
    'low',
    'medium',
    'high',
  ]],
  ['ExperienceAssistiveInferenceCautionCode', enums.ExperienceAssistiveInferenceCautionCodeSchema, [
    'no_llm_judge',
    'rule_only',
    'runtime_context_excluded',
    'skill_context_excluded',
    'no_human_user_message',
    'limited_timeline_window',
  ]],
  ['ExperienceReviewBasisCode', enums.ExperienceReviewBasisCodeSchema, [
    'has_high_observation',
    'has_medium_observation',
    'user_correction',
    'user_interruption',
    'session_interrupted',
    'negative_feedback',
    'hard_rule_text_hit',
    'tool_failure',
    'hedging_signal',
    'explicit_marker',
  ]],
  ['ExperienceRuleFindingLevel', enums.ExperienceRuleFindingLevelSchema, [
    'attention',
    'sample',
    'normal',
  ]],
  ['ExperienceReviewerReportScope', enums.ExperienceReviewerReportScopeSchema, [
    'single_skill_single_goal',
    'degraded_complex',
  ]],
  ['ExperienceReviewerReportStepStatus', enums.ExperienceReviewerReportStepStatusSchema, [
    'ok',
    'attention',
    'unknown',
    'degraded',
    'not_applicable',
  ]],
  ['ExperienceReviewerReportFindingLevel', enums.ExperienceReviewerReportFindingLevelSchema, [
    'attention',
    'possible_false_positive',
    'note',
  ]],
  ['ExperienceReviewerReportFindingSource', enums.ExperienceReviewerReportFindingSourceSchema, [
    'deterministic_rule',
    'llm_soft',
    'manual',
  ]],
  ['ExperienceChecklistItemStatus', enums.ExperienceChecklistItemStatusSchema, [
    'passed',
    'failed',
    'unknown',
    'not_declared',
    'not_applicable',
    'degraded',
  ]],
  ['ExperienceChecklistContribution', enums.ExperienceChecklistContributionSchema, [
    'blocking',
    'attention',
    'informational',
    'positive',
    'neutral',
  ]],
  ['ExperienceParentReason', enums.ExperienceParentReasonSchema, [
    'data_degraded',
    'blocking_failed',
    'attention_accumulated',
    'unknown_dominant',
    'all_passed',
    'not_applicable',
  ]],
  ['ExperienceSessionStoryNodeKind', enums.ExperienceSessionStoryNodeKindSchema, [
    'user_goal',
    'skill_invocation',
    'subagent_branch',
    'tool_execution',
    'delivery',
    'user_feedback',
    'goal_shift',
  ]],
  ['ExperienceSessionStoryAnswerKey', enums.ExperienceSessionStoryAnswerKeySchema, [
    'goal_satisfaction',
    'declared_behavior_fit',
    'user_feeling',
  ]],
  ['ExperienceSessionStorySkillRole', enums.ExperienceSessionStorySkillRoleSchema, [
    'router',
    'executor',
    'mixed',
    'unknown',
  ]],
  ['ExperienceEpisodeBoundaryReason', enums.ExperienceEpisodeBoundaryReasonSchema, [
    'goal_shift',
    'checkpoint_or_subagent',
    'downstream_closed',
    'session_end',
  ]],
  ['ExperienceEpisodeRole', enums.ExperienceEpisodeRoleSchema, [
    'main_executor',
    'router',
    'delegator',
    'supporting',
    'observer',
  ]],
  ['ExperienceFeedbackSignalType', enums.ExperienceFeedbackSignalTypeSchema, [
    'correction',
    'follow_up',
    'frustration',
    'interruption',
    'positive',
    'unknown',
  ]],
  ['ExperienceFeedbackAttributionRole', enums.ExperienceFeedbackAttributionRoleSchema, [
    'primary_fault',
    'downstream_related',
    'context_only',
  ]],
  ['ExperienceFeedbackAttributionReason', enums.ExperienceFeedbackAttributionReasonSchema, [
    'object_match',
    'promise_match',
    'action_match',
    'orchestration_edge',
    'episode_context',
  ]],
  ['ExperienceOutcomeClosure', enums.ExperienceOutcomeClosureSchema, [
    'closed',
    'unresolved',
    'abandoned',
    'unknown',
  ]],
  ['ExperienceRuntimeSkillType', enums.ExperienceRuntimeSkillTypeSchema, [
    'router',
    'delegation',
    'executor',
    'advisory',
    'workflow_owner',
    'unknown',
  ]],
  ['ExperienceRuntimeSkillTypeSource', enums.ExperienceRuntimeSkillTypeSourceSchema, [
    'frontmatter',
    'trace',
    'unknown',
  ]],
  ['ExperienceEpisodeArtifactKind', enums.ExperienceEpisodeArtifactKindSchema, [
    'path',
    'url',
    'document',
    'code',
    'execution_window',
    'unknown',
  ]],
  ['ExperienceOrchestrationEdgeStatus', enums.ExperienceOrchestrationEdgeStatusSchema, [
    'started',
    'completed',
    'failed',
    'unknown',
  ]],
  ['ExperienceOrchestrationEdgeKind', enums.ExperienceOrchestrationEdgeKindSchema, [
    'internal_skill',
    'external_child_session',
  ]],
  ['ExperienceRuleFindingCode', enums.ExperienceRuleFindingCodeSchema, [
    'high_observation_seen',
    'medium_observation_seen',
    'user_correction_seen',
    'user_interruption_seen',
    'session_interrupted_seen',
    'negative_feedback_seen',
    'positive_feedback_seen',
    'user_goal_shift_seen',
    'hard_rule_seen',
    'tool_failure_seen',
    'hedging_seen',
    'explicit_marker_seen',
    'runtime_context_excluded',
    'skill_context_excluded',
    'no_priority_signal',
  ]],
  ['TaskWindowBasis', enums.TaskWindowBasisSchema, [
    'turn_id',
    'turn_lifecycle',
    'user_message',
    'unresolved',
  ]],
  ['ExperienceTurnStatus', enums.ExperienceTurnStatusSchema, [
    'completed',
    'failed',
    'aborted',
    'interrupted',
    'open',
    'unknown',
  ]],
] as const;

const invalidValues = [undefined, null, false, 0, {}, [], '', 'UNKNOWN'];

describe('Experience enum wire identities', () => {
  it.each(cases)('%s preserves its complete wire value set', (_name, schema, values) => {
    expect(schema.options).toEqual(values);
    for (const value of values) expect(schema.safeParse(value).success).toBe(true);
    for (const value of invalidValues) expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['evidence kind', enums.ExperienceEvidenceKindSchema, isExperienceEvidenceKind],
    ['review priority', enums.ExperienceReviewPrioritySchema, isExperienceReviewPriority],
  ] as const)('%s guard uses the schema value set', (_name, schema, guard) => {
    for (const value of schema.options) expect(guard(value)).toBe(true);
    for (const value of invalidValues) expect(guard(value)).toBe(false);
  });
});
