/**
 * observability → renderer 的公开投影层(facade)。
 *
 * renderer(视图层)以前直接 import `observability/experience.ts` 的内部符号
 * (6 个 feedback matcher + 21 个 type),与 experience 内部强耦合。这层 facade
 * 把 renderer 需要的「feedback / experience 投影面」收敛为一个公开 surface:
 * renderer 只 import 这里,experience.ts 内部如何重组(后续阶段 3 拆分 feedback
 * matchers / frontmatter IO)对 renderer 透明。
 *
 * 设计原则(阶段 1.5,roadmap):
 *   - 仅 re-export,不做语义合并 / 不引入新类型 / 不写运行时逻辑
 *   - 不改任何字节级输出(html-renderer snapshot 必须字节一致)
 *   - 阶段 8 的 ViewModel 边界会进一步把这些符号封进 ViewModel,renderer 那时
 *     连这层也不直接看到。本 facade 是中间过渡层,降低阶段 8 的改动面。
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
