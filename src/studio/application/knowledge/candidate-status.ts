import type { Lang } from '../../../shared/language.js';

export type CandidateChoice = 'retain' | 'discard' | null;

const DECISION_LABELS: Record<Lang, Record<'retain' | 'discard' | 'pending', string>> = {
  zh: { retain: '已保留', discard: '已舍弃', pending: '待处理' },
  en: { retain: 'Retained', discard: 'Discarded', pending: 'Undecided' },
};

/**
 * 只命名用户做过的维护决定。领域复核结论（supported／disputed 之类）是另一个维度，
 * 知识层恒为 `pending`，保留或舍弃都不冒充复核通过。
 */
export function candidateDecisionLabel(choice: CandidateChoice, lang: Lang): string {
  return DECISION_LABELS[lang][choice ?? 'pending'];
}

const RUN_LABELS: Record<Lang, Record<string, string>> = {
  zh: { completed: '流程已结束', active: '阶段待继续或恢复', failed: '正文阶段失败', unsupported: '旧版本不受支持' },
  en: { completed: 'Workflow ended', active: 'Stage continuation or recovery needed', failed: 'Body phase failed', unsupported: 'Legacy version unsupported' },
};

/** 候选页与会话侧的提炼记录读同一套状态词；未知状态原样回显，不替领域补一个猜测。 */
export function extractionRunStatusLabel(status: string, lang: Lang): string {
  return RUN_LABELS[lang][status] ?? status;
}
