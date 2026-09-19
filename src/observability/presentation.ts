/** 浏览器可用的观测展示语义；不得引入存储、进程或服务端装配。 */
export {
  INDICATOR_KEYS,
  indicatorHelp,
  indicatorLabel,
} from './inbox/metric-semantics.js';
export type {
  IndicatorHelpKey,
} from './inbox/metric-semantics.js';
export {
  reviewActionLabels,
  reviewActionRequest,
  reviewPriorityMeta,
  reviewStateKey,
  reviewVerdictBadge,
} from './inbox/review-semantics.js';
export {
  signalEvidenceConclusion,
  signalRuleDescription,
  signalSeverityMeta,
  signalSourceMeta,
} from './inbox/signal-semantics.js';
export type {
  SignalSeverityTone,
} from './inbox/signal-semantics.js';
export {
  buildObservationSkillRollups,
  buildReviewActionItems,
  skillReviewLabel,
} from './inbox/skill-rollups.js';
export type {
  ObservationSkillRollup,
} from './inbox/skill-rollups.js';
