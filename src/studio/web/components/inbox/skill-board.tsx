'use client';
import { useMemo } from 'react';
import { Table, Tag, Tooltip, Typography } from 'antd';
import {
  buildObservationSkillRollups,
  skillReviewLabel,
  type ObservationSkillRollup,
  type SkillReviewTone,
} from '../../../../observability/inbox/skill-rollups';
import type { ObservationInboxViewModel } from '../../../../observability/inbox/view-model';
import type { Language } from '../layout/shell';

const REVIEW_TAG_COLOR: Record<SkillReviewTone, string> = {
  error: 'error',
  warning: 'warning',
  neutral: 'default',
  success: 'success',
};

const METRIC_LABELS: Record<keyof ObservationSkillRollup['metricCounts'], { zh: string; en: string }> = {
  bash: { zh: 'Bash调用', en: 'Bash calls' },
  read: { zh: 'Read', en: 'Read' },
  grep: { zh: 'Grep', en: 'Grep' },
  uncertainty: { zh: '回答不确定', en: 'Uncertain' },
  explicitMarker: { zh: '明确说缺口', en: 'Explicit gap' },
  bashProbe: { zh: 'Bash试探', en: 'Bash probes' },
  notFound: { zh: '路径不存在', en: 'Path missing' },
  toolLimit: { zh: '工具限制', en: 'Tool limits' },
  toolFailure: { zh: '工具执行失败', en: 'Tool failures' },
};

function formatTimestamp(value: string): string {
  return value ? value.slice(0, 19).replace('T', ' ') : '—';
}

export function SkillBoard({
  model,
  lang,
  onSelectSkill,
}: {
  model: ObservationInboxViewModel;
  lang: Language;
  onSelectSkill?: (skillName: string) => void;
}) {
  const zh = lang === 'zh';
  const rollups = useMemo(() => buildObservationSkillRollups(model), [model]);
  return (
    <Table
      size="small"
      rowKey="skillName"
      dataSource={rollups}
      pagination={{ pageSize: 20, showSizeChanger: false }}
      scroll={{ x: 1280 }}
      onRow={(row) => ({
        onClick: () => row.observationCount > 0 && onSelectSkill?.(row.skillName),
        style: { cursor: row.observationCount > 0 && onSelectSkill ? 'pointer' : 'default' },
      })}
      columns={[
        {
          title: 'Skill',
          dataIndex: 'skillName',
          render: (name: string) => <Typography.Text strong code>{name}</Typography.Text>,
        },
        { title: zh ? '调用' : 'Calls', dataIndex: 'invocationCount', align: 'right' },
        { title: 'Session', dataIndex: 'sessionCount', align: 'right' },
        { title: zh ? '过程发现' : 'Findings', dataIndex: 'observationCount', align: 'right' },
        {
          title: zh ? '子项指标' : 'Metrics',
          render: (_: unknown, row) => (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {(Object.keys(METRIC_LABELS) as Array<keyof ObservationSkillRollup['metricCounts']>)
                .map((key) => `${zh ? METRIC_LABELS[key].zh : METRIC_LABELS[key].en} ${row.metricCounts[key]}`)
                .join(' · ')}
            </Typography.Text>
          ),
        },
        { title: zh ? '高风险' : 'High', dataIndex: ['counts', 'high'], align: 'right' },
        {
          title: zh ? '低风险' : 'Low',
          align: 'right',
          render: (_: unknown, row) => row.counts.medium + row.counts.low,
        },
        { title: zh ? '路径/工具' : 'Path/tool', dataIndex: ['counts', 'noise'], align: 'right' },
        {
          title: zh ? '最近发现问题' : 'Last finding',
          dataIndex: 'lastProblemSeen',
          render: (value: string) => (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatTimestamp(value)}</Typography.Text>
          ),
        },
        {
          title: zh ? '最近使用' : 'Last used',
          dataIndex: 'lastUsed',
          render: (value: string) => (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatTimestamp(value)}</Typography.Text>
          ),
        },
        {
          title: zh ? '来源' : 'Source',
          dataIndex: 'sources',
          render: (sources: readonly string[]) => (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{sources.length > 0 ? sources.join(', ') : '—'}</Typography.Text>
          ),
        },
        {
          title: 'Review',
          align: 'right',
          render: (_: unknown, row) => (
            <Tooltip title={zh ? '按过程发现的最高严重度给出复盘优先级' : 'Review priority from the highest observation severity'}>
              <Tag color={REVIEW_TAG_COLOR[row.reviewTone]}>{skillReviewLabel(row.reviewTone, lang)}</Tag>
            </Tooltip>
          ),
        },
      ]}
    />
  );
}
