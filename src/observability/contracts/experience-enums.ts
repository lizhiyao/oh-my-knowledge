import { z } from 'zod';

export const ExperienceReviewPrioritySchema = z.enum([
  'review_first',
  'sample_review',
  'routine_sample',
]);

export const ExperienceGoalSliceReasonCodeSchema = z.enum([
  'skill_segment_boundary',
  'explicit_user_goal_shift',
  'default_session_slice',
]);

export const ExperienceEvidenceKindSchema = z.enum([
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
]);

export const ExperienceAssistiveInferenceCodeSchema = z.enum([
  'review_recommended',
  'sample_recommended',
  'positive_signal_observed',
  'user_switched_topic_neutral',
  'no_obvious_issue_from_rules',
  'insufficient_human_context',
]);

export const ExperienceAssistiveInferenceConfidenceSchema = z.enum([
  'low',
  'medium',
  'high',
]);

export const ExperienceAssistiveInferenceCautionCodeSchema = z.enum([
  'no_llm_judge',
  'rule_only',
  'runtime_context_excluded',
  'skill_context_excluded',
  'no_human_user_message',
  'limited_timeline_window',
]);

export const ExperienceReviewBasisCodeSchema = z.enum([
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
]);

export const ExperienceRuleFindingLevelSchema = z.enum([
  'attention',
  'sample',
  'normal',
]);

export const ExperienceReviewerReportScopeSchema = z.enum([
  'single_skill_single_goal',
  'degraded_complex',
]);

export const ExperienceReviewerReportStepStatusSchema = z.enum([
  'ok',
  'attention',
  'unknown',
  'degraded',
  'not_applicable',
]);

export const ExperienceReviewerReportFindingLevelSchema = z.enum([
  'attention',
  'possible_false_positive',
  'note',
]);

export const ExperienceReviewerReportFindingSourceSchema = z.enum([
  'deterministic_rule',
  'llm_soft',
  'manual',
]);

export const ExperienceChecklistItemStatusSchema = z.enum([
  'passed',
  'failed',
  'unknown',
  'not_declared',
  'not_applicable',
  'degraded',
]);

export const ExperienceChecklistContributionSchema = z.enum([
  'blocking',
  'attention',
  'informational',
  'positive',
  'neutral',
]);

export const ExperienceParentReasonSchema = z.enum([
  'data_degraded',
  'blocking_failed',
  'attention_accumulated',
  'unknown_dominant',
  'all_passed',
  'not_applicable',
]);

export const ExperienceSessionStoryNodeKindSchema = z.enum([
  'user_goal',
  'skill_invocation',
  'subagent_branch',
  'tool_execution',
  'delivery',
  'user_feedback',
  'goal_shift',
]);

export const ExperienceSessionStoryAnswerKeySchema = z.enum([
  'goal_satisfaction',
  'declared_behavior_fit',
  'user_feeling',
]);

export const ExperienceSessionStorySkillRoleSchema = z.enum([
  'router',
  'executor',
  'mixed',
  'unknown',
]);

export const ExperienceEpisodeBoundaryReasonSchema = z.enum([
  'goal_shift',
  'checkpoint_or_subagent',
  'downstream_closed',
  'session_end',
]);

export const ExperienceEpisodeRoleSchema = z.enum([
  'main_executor',
  'router',
  'delegator',
  'supporting',
  'observer',
]);

export const ExperienceFeedbackSignalTypeSchema = z.enum([
  'correction',
  'follow_up',
  'frustration',
  'interruption',
  'positive',
  'unknown',
]);

export const ExperienceFeedbackAttributionRoleSchema = z.enum([
  'primary_fault',
  'downstream_related',
  'context_only',
]);

export const ExperienceFeedbackAttributionReasonSchema = z.enum([
  'object_match',
  'promise_match',
  'action_match',
  'orchestration_edge',
  'episode_context',
]);

export const ExperienceOutcomeClosureSchema = z.enum([
  'closed',
  'unresolved',
  'abandoned',
  'unknown',
]);

export const ExperienceRuntimeSkillTypeSchema = z.enum([
  'router',
  'delegation',
  'executor',
  'advisory',
  'workflow_owner',
  'unknown',
]);

export const ExperienceRuntimeSkillTypeSourceSchema = z.enum([
  'frontmatter',
  'trace',
  'unknown',
]);

export const ExperienceEpisodeArtifactKindSchema = z.enum([
  'path',
  'url',
  'document',
  'code',
  'execution_window',
  'unknown',
]);

export const ExperienceOrchestrationEdgeStatusSchema = z.enum([
  'started',
  'completed',
  'failed',
  'unknown',
]);

export const ExperienceOrchestrationEdgeKindSchema = z.enum([
  'internal_skill',
  'external_child_session',
]);

export const ExperienceRuleFindingCodeSchema = z.enum([
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
]);

export const TaskWindowBasisSchema = z.enum([
  'turn_id',
  'turn_lifecycle',
  'user_message',
  'unresolved',
]);

export const ExperienceTurnStatusSchema = z.enum([
  'completed',
  'failed',
  'aborted',
  'interrupted',
  'open',
  'unknown',
]);
