'use client';
import { useMemo, useState } from 'react';
import { Empty, Select, Tag, Timeline, Typography } from 'antd';
import type {
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
} from '../../../../observability/contracts/experience';
import type { Language } from '../layout/shell';

const KIND_COLOR: Record<string, string> = {
  user_message: 'blue',
  assistant_message: 'purple',
  tool_use: 'geekblue',
  tool_result: 'cyan',
  observation: 'orange',
};

function eventTime(event: ExperienceTimelineEvent): string {
  const value = 'timestamp' in event && typeof event.timestamp === 'string' ? event.timestamp : '';
  return value ? value.slice(11, 19) : '';
}

function eventTitle(event: ExperienceTimelineEvent): string {
  return event.label || event.toolName || event.kind;
}

function eventBody(event: ExperienceTimelineEvent): string {
  return event.snippet ?? event.fullText ?? '';
}

/** 会话时间轴（#839 批次 5）：选择会话后按序展示其预览事件。 */
export function TimelineView({
  sessions,
  lang,
}: {
  sessions: readonly ExperienceSessionSummary[];
  lang: Language;
}) {
  const zh = lang === 'zh';
  const options = useMemo(() => sessions.map((session) => ({
    value: session.id,
    label: `${session.skillName} · ${session.endTimestamp.slice(0, 19).replace('T', ' ')}`,
  })), [sessions]);
  const [selectedId, setSelectedId] = useState<string | undefined>(options[0]?.value);
  const selected = sessions.find((session) => session.id === selectedId);
  if (sessions.length === 0) {
    return <Empty description={zh ? '暂无可展示的时间轴。' : 'No timeline to show yet.'} />;
  }
  return (
    <>
      <Select
        style={{ minWidth: 320, marginBottom: 12 }}
        value={selectedId}
        onChange={setSelectedId}
        options={options}
        placeholder={zh ? '选择会话' : 'Select a session'}
      />
      {selected ? (
        <Timeline
          items={selected.timelinePreview.map((event) => ({
            key: event.id,
            color: KIND_COLOR[event.kind] ?? 'gray',
            children: (
              <>
                <div>
                  <Tag style={{ marginInlineEnd: 6 }}>{event.kind}</Tag>
                  <Typography.Text strong style={{ fontSize: 12 }}>{eventTitle(event)}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11, marginInlineStart: 8 }}>
                    {eventTime(event)}
                  </Typography.Text>
                  {event.isError ? <Tag color="error" style={{ marginInlineStart: 6 }}>{zh ? '失败' : 'error'}</Tag> : null}
                </div>
                {eventBody(event) ? (
                  <Typography.Paragraph
                    type="secondary"
                    style={{ fontSize: 12, marginBottom: 0 }}
                    ellipsis={{ rows: 3, expandable: true, symbol: zh ? '展开' : 'more' }}
                  >
                    {eventBody(event)}
                  </Typography.Paragraph>
                ) : null}
              </>
            ),
          }))}
        />
      ) : null}
    </>
  );
}
