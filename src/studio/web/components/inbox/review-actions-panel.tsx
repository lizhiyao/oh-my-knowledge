'use client';
import { useMemo } from 'react';
import { Table, Tag, Typography } from 'antd';
import {
  buildReviewActionItems,
  type SkillReviewTone,
} from '../../../../observability/inbox/skill-rollups';
import type { ObservationInboxViewModel } from '../../../../observability/inbox/view-model';
import type { Language } from '../layout/shell';

const PRIORITY_COLOR: Record<SkillReviewTone, string> = {
  error: 'error',
  warning: 'warning',
  neutral: 'default',
  success: 'success',
};

/** Reviewer 待办建议（#839 批次 5）：回答"现在该先看哪个 skill、看什么"。 */
export function ReviewActionsPanel({
  model,
  lang,
  onSelectSkill,
}: {
  model: ObservationInboxViewModel;
  lang: Language;
  onSelectSkill?: (skillName: string) => void;
}) {
  const zh = lang === 'zh';
  const items = useMemo(() => buildReviewActionItems(model, lang).slice(0, 8), [model, lang]);
  return (
    <>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {zh
          ? '这张表回答“我现在该先看哪个 skill、看什么”。它只给 review 优先级，不自动判定必须改。点击行可跳到对应 skill 明细。'
          : 'Which skill to review first, and what to look at. It only assigns review priority; it does not decide that a skill must change. Click a row to open the skill findings.'}
      </Typography.Paragraph>
      <Table
        size="small"
        rowKey="skillName"
        dataSource={items}
        pagination={false}
        onRow={(row) => ({
          onClick: () => onSelectSkill?.(row.skillName),
          style: { cursor: onSelectSkill ? 'pointer' : 'default' },
        })}
        columns={[
          {
            title: 'P',
            dataIndex: 'priority',
            width: 64,
            render: (priority: string, row) => <Tag color={PRIORITY_COLOR[row.tone]}>{priority}</Tag>,
          },
          {
            title: 'Skill',
            dataIndex: 'skillName',
            render: (name: string) => <Typography.Text strong code>{name}</Typography.Text>,
          },
          {
            title: zh ? '现在要做什么' : 'What to do now',
            dataIndex: 'action',
            render: (action: string) => <Typography.Text strong style={{ fontSize: 12 }}>{action}</Typography.Text>,
          },
          {
            title: zh ? '为什么这么建议' : 'Why',
            dataIndex: 'reason',
            render: (reason: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{reason}</Typography.Text>,
          },
          { title: zh ? '次数' : 'Count', dataIndex: 'evidenceCount', align: 'right', width: 70 },
        ]}
      />
    </>
  );
}
