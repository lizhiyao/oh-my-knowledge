import type { ExperienceReviewPriority } from '../contracts/experience.js';
import type { ObservationReviewTargetType, ObservationReviewVerdict } from '../contracts/review.js';

/**
 * 观测收件箱复核语义的展示元信息（宿主无关纯函数）。
 * 优先级与判定文案只此一份，React 页面直接消费；样式归呈现层。
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

/** 一次复核点击对应的 review-state 请求：撤销走 DELETE，写入走 POST。 */
export type ReviewActionRequest =
  | {
      readonly method: 'DELETE';
      readonly targetType: ObservationReviewTargetType;
      readonly targetId: string;
    }
  | {
      readonly method: 'POST';
      readonly targetType: ObservationReviewTargetType;
      readonly targetId: string;
      readonly verdict: ObservationReviewVerdict;
      readonly reason?: string;
    };

/**
 * 点击当前结论且没有附带意见即撤销这条复核，其余情况写入新结论。
 * 放在数据层是为了让「撤销」这条口径可独立测试，而不是埋在组件的事件处理里。
 */
export function reviewActionRequest(
  targetType: ObservationReviewTargetType,
  targetId: string,
  current: ObservationReviewVerdict | undefined,
  next: ObservationReviewVerdict,
  reason?: string,
): ReviewActionRequest {
  if (current === next && !reason) return { method: 'DELETE', targetType, targetId };
  return reason === undefined
    ? { method: 'POST', targetType, targetId, verdict: next }
    : { method: 'POST', targetType, targetId, verdict: next, reason };
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
  revoke: string;
  revokeHint: string;
} {
  return lang === 'en'
    ? {
        confirm: 'Confirm',
        reject: 'Reject',
        note: 'Note',
        saveNote: 'Save note',
        cancelNote: 'Cancel',
        notePlaceholder: 'Add context or rationale for this session…',
        revoke: 'Undo review',
        revokeHint: 'Click the active verdict again to revoke this review.',
      }
    : {
        confirm: '同意',
        reject: '否决',
        note: '留意见',
        saveNote: '保存意见',
        cancelNote: '取消',
        notePlaceholder: '补充这个 session 的上下文或理由…',
        revoke: '撤销复核',
        revokeHint: '再次点击当前结论即可撤销这条复核。',
      };
}
