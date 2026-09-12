import type { ExperienceReviewPriority } from '../contracts/experience.js';
import type { ObservationReviewVerdict } from '../contracts/review.js';

/**
 * 观测收件箱复核语义的展示元信息（宿主无关纯函数，#839 批次 3）。
 * HTML 渲染器与 React 页面共用同一份优先级与判定文案；样式归呈现层。
 */

export type ReviewPriorityTone = 'error' | 'warning' | 'neutral';

export function reviewPriorityMeta(
  priority: ExperienceReviewPriority,
  lang: 'zh' | 'en' = 'zh',
): { label: string; tone: ReviewPriorityTone } {
  if (priority === 'review_first') {
    return { label: lang === 'en' ? 'Review first' : '建议优先复盘', tone: 'error' };
  }
  if (priority === 'sample_review') {
    return { label: lang === 'en' ? 'Sample review' : '值得抽样复盘', tone: 'warning' };
  }
  return { label: lang === 'en' ? 'Routine sample' : '常规抽样', tone: 'neutral' };
}

/** 复核判定当前态徽章文案（与历史 HTML 客户端脚本标签一致）。 */
export function reviewVerdictBadge(
  verdict: ObservationReviewVerdict,
  lang: 'zh' | 'en' = 'zh',
): { label: string; color: string } {
  switch (verdict) {
    case 'real_issue':
      return { label: lang === 'en' ? 'Confirmed' : '已同意', color: 'success' };
    case 'not_issue':
      return { label: lang === 'en' ? 'Rejected' : '已否决', color: 'error' };
    case 'needs_more_context':
      return { label: lang === 'en' ? 'Noted' : '已留意见', color: 'warning' };
    case 'reviewed':
      return { label: lang === 'en' ? 'Reviewed' : '已看过', color: 'processing' };
    case 'confirmed':
      return { label: lang === 'en' ? 'Confirmed' : '已确认', color: 'success' };
    case 'rejected':
      return { label: lang === 'en' ? 'Rejected' : '已否决', color: 'error' };
    default:
      return { label: String(verdict), color: 'default' };
  }
}

/** 复核状态条目的 key（与 review-state.ts 的持久化 key 同构；独立为纯函数供 client bundle 使用）。 */
export function reviewStateKey(targetType: string, targetId: string): string {
  return `${targetType}:${targetId}`;
}

/** 复核操作按钮文案。 */
export function reviewActionLabels(lang: 'zh' | 'en' = 'zh'): {
  confirm: string;
  reject: string;
  note: string;
  saveNote: string;
  cancelNote: string;
  notePlaceholder: string;
} {
  return lang === 'en'
    ? {
        confirm: 'Confirm',
        reject: 'Reject',
        note: 'Note',
        saveNote: 'Save note',
        cancelNote: 'Cancel',
        notePlaceholder: 'Add context or rationale for this session…',
      }
    : {
        confirm: '同意',
        reject: '否决',
        note: '留意见',
        saveNote: '保存意见',
        cancelNote: '取消',
        notePlaceholder: '补充这个 session 的上下文或理由…',
      };
}
