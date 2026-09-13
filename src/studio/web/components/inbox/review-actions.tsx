'use client';
import { useState } from 'react';
import { Button, Input, message, Space, Tag, Typography } from 'antd';
import type { ObservationReviewVerdict } from '../../../../observability/contracts/review';
import { reviewActionLabels, reviewActionRequest, reviewVerdictBadge } from '../../../../observability/inbox/review-semantics';
import type { Language } from '../layout/shell';

const REVIEW_ENDPOINT = '/api/observe-inbox/review-state';

/**
 * 经验会话复核操作组：同意／否决／留意见三按钮，请求成功才更新本地状态；
 * 再次点击当前结论即撤销该条复核。
 */
export function SessionReviewActions({
  sessionId,
  verdict,
  reason,
  lang,
}: {
  sessionId: string;
  verdict?: ObservationReviewVerdict;
  reason?: string;
  lang: Language;
}) {
  const zh = lang === 'zh';
  const labels = reviewActionLabels(lang);
  const [current, setCurrent] = useState<ObservationReviewVerdict | undefined>(verdict);
  const [currentReason, setCurrentReason] = useState<string | undefined>(reason);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState(reason ?? '');
  const [pending, setPending] = useState(false);

  async function submit(next: ObservationReviewVerdict, note?: string) {
    const request = reviewActionRequest('experience_session', sessionId, current, next, note);
    const revoking = request.method === 'DELETE';
    setPending(true);
    try {
      const response = revoking
        ? await fetch(
            `${REVIEW_ENDPOINT}?targetType=${encodeURIComponent(request.targetType)}&targetId=${encodeURIComponent(request.targetId)}`,
            { method: 'DELETE' },
          )
        : await fetch(REVIEW_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetType: request.targetType,
              targetId: request.targetId,
              verdict: request.verdict,
              ...(request.reason ? { reason: request.reason } : {}),
            }),
          });
      if (!response.ok) throw new Error(String(response.status));
      setCurrent(revoking ? undefined : next);
      setCurrentReason(revoking ? undefined : note);
      if (revoking) setNoteText('');
      setNoteOpen(false);
    } catch {
      message.error(revoking
        ? (zh ? '撤销复核失败，请重试。' : 'Failed to revoke the review; please retry.')
        : (zh ? '复核保存失败，请重试。' : 'Failed to save the review; please retry.'));
    } finally {
      setPending(false);
    }
  }

  const buttonType = (value: ObservationReviewVerdict) => (current === value ? 'primary' : 'default');
  const revokeTitle = (value: ObservationReviewVerdict) => (current === value ? labels.revokeHint : undefined);
  return (
    <Space orientation="vertical" size={4} style={{ alignItems: 'flex-start' }}>
      <Space size={4} wrap>
        <Button size="small" type={buttonType('real_issue')} title={revokeTitle('real_issue')} loading={pending} onClick={() => void submit('real_issue')}>
          {labels.confirm}
        </Button>
        <Button size="small" type={buttonType('not_issue')} danger={current === 'not_issue'} title={revokeTitle('not_issue')} loading={pending} onClick={() => void submit('not_issue')}>
          {labels.reject}
        </Button>
        <Button size="small" type={buttonType('needs_more_context')} title={current === 'needs_more_context' ? labels.revoke : undefined} loading={pending} onClick={() => setNoteOpen((open) => !open)}>
          {labels.note}
        </Button>
        {current ? (
          <Tag color={reviewVerdictBadge(current, lang).color} style={{ marginInlineStart: 4 }}>
            {reviewVerdictBadge(current, lang).label}
          </Tag>
        ) : null}
      </Space>
      {noteOpen ? (
        <Space.Compact style={{ width: 360 }}>
          <Input.TextArea
            rows={2}
            value={noteText}
            placeholder={labels.notePlaceholder}
            onChange={(event) => setNoteText(event.target.value)}
          />
          <Button size="small" type="primary" loading={pending} onClick={() => void submit('needs_more_context', noteText.trim() || undefined)}>
            {labels.saveNote}
          </Button>
          <Button size="small" onClick={() => setNoteOpen(false)}>{labels.cancelNote}</Button>
        </Space.Compact>
      ) : null}
      {currentReason ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{currentReason}</Typography.Text>
      ) : null}
    </Space>
  );
}
