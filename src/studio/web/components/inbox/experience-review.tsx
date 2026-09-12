'use client';
import { useMemo } from 'react';
import { Empty, Listy, Space, Tag, Typography } from 'antd';
import type { ExperienceSessionSummary } from '../../../../observability/contracts/experience';
import type { ObservationMetricKey, ObservationReviewState } from '../../../../observability/contracts/review';
import {
  reviewPriorityMeta,
  reviewStateKey,
} from '../../../../observability/inbox/review-semantics';
import { ownRecordValue } from '../../../../shared/record-count';
import type { Language } from '../layout/shell';
import { SessionReviewActions } from './review-actions';

const PRIORITY_RANK: Record<string, number> = { review_first: 0, sample_review: 1 };

function formatRange(start?: string, end?: string): string {
  const fmt = (value?: string) => (value ? value.slice(0, 19).replace('T', ' ') : '');
  const startLabel = fmt(start);
  const endLabel = fmt(end);
  if (!startLabel && !endLabel) return '—';
  return `${startLabel} → ${endLabel}`;
}

function conversationHref(threadId: string, lang: Language): string {
  const path = `/observe/conversations/${encodeURIComponent(threadId)}`;
  return lang === 'zh' ? path : `${path}?lang=${lang}`;
}

/**
 * 经验会话复盘列表：skill、复盘优先级、会话摘要、时间范围、对话任务深链与复核操作组。
 * 输入是读取时派生的有效复核投影，因此指标与已提交的复核结论一致。
 */
export function ExperienceReviewSection({
  sessions,
  reviewState,
  unappliedMetricAnnotations,
  lang,
}: {
  sessions: readonly ExperienceSessionSummary[];
  reviewState: ObservationReviewState;
  unappliedMetricAnnotations?: Record<string, ObservationMetricKey[]>;
  lang: Language;
}) {
  const zh = lang === 'zh';
  const sorted = useMemo(() => [...sessions].sort((a, b) => {
    const rankDelta = (PRIORITY_RANK[a.reviewPriority] ?? 2) - (PRIORITY_RANK[b.reviewPriority] ?? 2);
    if (rankDelta !== 0) return rankDelta;
    return b.endTimestamp.localeCompare(a.endTimestamp);
  }), [sessions]);
  if (sorted.length === 0) {
    return <Empty description={zh ? '暂无经验会话复盘记录。' : 'No experience review sessions yet.'} />;
  }
  return (
    <Listy
      items={sorted}
      rowKey={(session) => session.id}
      itemRender={(session) => {
        const priority = reviewPriorityMeta(session.reviewPriority, lang);
        const entry = reviewState.entries[reviewStateKey('experience_session', session.id)];
        const unapplied = unappliedMetricAnnotations ? ownRecordValue(unappliedMetricAnnotations, session.id) : undefined;
        return (
          <div style={{ width: '100%' }}>
            <Space size={8} wrap style={{ marginBottom: 4 }}>
              <Typography.Text strong code>{session.skillName}</Typography.Text>
              <Tag color={priority.tone}>{priority.label}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatRange(session.startTimestamp, session.endTimestamp)}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {session.sourceKind}
              </Typography.Text>
              <Typography.Link href={conversationHref(session.threadId, lang)} style={{ fontSize: 12 }}>
                {zh ? '查看对话任务' : 'Conversation tasks'}
              </Typography.Link>
            </Space>
            {session.sessionStory?.summary ? (
              <Typography.Paragraph style={{ fontSize: 13, marginBottom: 8 }}>
                {session.sessionStory.summary}
              </Typography.Paragraph>
            ) : null}
            {unapplied && unapplied.length > 0 ? (
              <Typography.Paragraph type="warning" style={{ fontSize: 12, marginBottom: 8 }}>
                {zh
                  ? `标注未生效：${unapplied.join('、')}。证据不足以完整重放，已存指标未改变。`
                  : `Annotations not applied: ${unapplied.join(', ')}. Evidence is insufficient for a full replay; stored metrics are unchanged.`}
              </Typography.Paragraph>
            ) : null}
            <SessionReviewActions
              sessionId={session.id}
              verdict={entry?.verdict}
              reason={entry?.reason}
              lang={lang}
            />
          </div>
        );
      }}
    />
  );
}
