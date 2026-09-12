'use client';
import { useMemo } from 'react';
import { Empty, List, Space, Tag, Typography } from 'antd';
import type { ExperienceSessionSummary } from '../../../../observability/contracts/experience';
import type { ObservationReviewState } from '../../../../observability/contracts/review';
import {
  reviewPriorityMeta,
  reviewStateKey,
} from '../../../../observability/inbox/review-semantics';
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

/**
 * V1 经验会话复盘概要列表（#839 批次 3）：skill、复盘优先级、会话摘要、
 * 时间范围与复核操作组。证据链、规则发现与时间轴明细随后续批次迁移。
 */
export function ExperienceReviewSection({
  sessions,
  reviewState,
  lang,
}: {
  sessions: readonly ExperienceSessionSummary[];
  reviewState: ObservationReviewState;
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
    <List
      dataSource={sorted}
      rowKey={(session) => session.id}
      renderItem={(session) => {
        const priority = reviewPriorityMeta(session.reviewPriority, lang);
        const entry = reviewState.entries[reviewStateKey('experience_session', session.id)];
        return (
          <List.Item>
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
              </Space>
              {session.sessionStory?.summary ? (
                <Typography.Paragraph style={{ fontSize: 13, marginBottom: 8 }}>
                  {session.sessionStory.summary}
                </Typography.Paragraph>
              ) : null}
              <SessionReviewActions
                sessionId={session.id}
                verdict={entry?.verdict}
                reason={entry?.reason}
                lang={lang}
              />
            </div>
          </List.Item>
        );
      }}
    />
  );
}
