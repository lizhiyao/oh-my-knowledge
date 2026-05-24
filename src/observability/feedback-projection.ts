/**
 * observability → renderer 的公开投影层(facade)。
 *
 * 把 renderer 需要的「feedback / experience 投影面」收敛为一个公开 surface:
 * renderer 只 import 这里,experience / feedback-matchers / frontmatter 等内部
 * module 如何重组对 renderer 透明。配合 `inbox-view-model.ts` 共同构成 observability
 * 对 renderer 的两个 facade 入口。
 *
 * 设计原则:
 *   - 仅 re-export,不做语义合并 / 不引入新类型 / 不写运行时逻辑
 *   - 不改任何字节级输出(html-renderer snapshot 必须字节一致)
 *
 * 范围:仅 renderer 用到的子集。其它消费者(diagnosis / CLI observe ingest)
 * 继续直接 import experience.ts —— 它们不是「视图」,不在 facade 收敛范围内。
 */

export {
  findNegativeFeedbackMatches,
  findPositiveFeedbackMatches,
  findUserCorrectionMatches,
  findUserGoalShiftMatches,
  hasUserCorrectionSignal,
  hasUserGoalShiftSignal,
} from './feedback-matchers.js';

export type {
  ExperienceAssistiveInference,
  ExperienceAssistiveInferenceCautionCode,
  ExperienceAssistiveInferenceCode,
  ExperienceChecklistItem,
  ExperienceEvidenceChain,
  ExperienceEvidenceRef,
  ExperienceFeedbackAttribution,
  ExperienceInvocation,
  ExperienceReviewIndicators,
  ExperienceReviewBasisCode,
  ExperienceReviewPriority,
  ExperienceReviewerReport,
  ExperienceRuleFinding,
  ExperienceRuleFindingCode,
  ExperienceRuleFindingLevel,
  ExperienceEpisode,
  ExperienceFeedbackSignal,
  ExperienceSkillSegment,
  ExperienceSessionStoryAnswer,
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
} from './experience.js';
