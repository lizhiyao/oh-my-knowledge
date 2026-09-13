'use client';
import { useState } from 'react';
import { Button, Space, Tabs, Tag, Typography } from 'antd';
import type { ObservationInboxViewModel } from '../../../../observability/inbox/view-model';
import type { Language } from '../layout/shell';
import { SignalSection } from './signals';
import { SkillBoard } from './skill-board';
import { ExperienceReviewSection } from './experience-review';
import { MetricsGuide } from './metrics-guide';
import { TimelineView } from './timeline-view';
import { SkillChains } from './skill-chains';
import { ReviewActionsPanel } from './review-actions-panel';

/**
 * 观测收件箱页面外壳（#839 收口后的唯一实现）：子视图只呈现 observability/inbox 投影，
 * skill 筛选与子视图切换是本地状态，复核 mutation 走 /api/observe-inbox/review-state。
 */
export function InboxView({ model, lang }: { model: ObservationInboxViewModel; lang: Language }) {
  const zh = lang === 'zh';
  const [activeTab, setActiveTab] = useState('signals');
  const [skillFilter, setSkillFilter] = useState<string | undefined>(undefined);
  const filteredItems = skillFilter ? model.items.filter((item) => item.skillName === skillFilter) : model.items;
  return (
    <>
      <div>
        <h1>{zh ? '观测收件箱' : 'Observation inbox'}</h1>
        <Space size={8} wrap>
          <Typography.Text type="secondary">
            {zh
              ? `${filteredItems.length} 条信号（共 ${model.allItems.length} 条）`
              : `${filteredItems.length} signals (${model.allItems.length} total)`}
          </Typography.Text>
          {model.activeSkill ? (
            <>
              <Tag color="processing">{`${zh ? '已按 Skill 过滤' : 'Filtered by skill'}: ${model.activeSkill}`}</Tag>
              <Typography.Link href={lang === 'zh' ? '/observe/inbox' : `/observe/inbox?lang=${lang}`} style={{ fontSize: 12 }}>
                {zh ? '查看全量' : 'View all'}
              </Typography.Link>
            </>
          ) : null}
        </Space>
      </div>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'signals',
            label: zh ? '信号' : 'Signals',
            children: (
              <>
                {skillFilter ? (
                  <Button size="small" onClick={() => setSkillFilter(undefined)} style={{ marginBottom: 8 }}>
                    {zh ? `清除筛选：${skillFilter}` : `Clear filter: ${skillFilter}`}
                  </Button>
                ) : null}
                <SignalSection items={filteredItems} lang={lang} />
              </>
            ),
          },
          {
            key: 'skill-board',
            label: zh ? 'Skill 看板' : 'Skill board',
            children: (
              <SkillBoard
                model={model}
                lang={lang}
                onSelectSkill={(skillName) => {
                  setSkillFilter(skillName);
                  setActiveTab('signals');
                }}
              />
            ),
          },
          {
            key: 'experience',
            label: zh ? '体验复盘' : 'Experience review',
            children: (
              <ExperienceReviewSection
                sessions={model.effectiveExperienceReports.flatMap((report) => report.sessions)}
                reviewState={model.reviewState}
                unappliedMetricAnnotations={model.unappliedMetricAnnotations}
                lang={lang}
              />
            ),
          },
          {
            key: 'metrics',
            label: zh ? '指标' : 'Metrics',
            children: <MetricsGuide lang={lang} />,
          },
          {
            key: 'timeline',
            label: zh ? '时间轴' : 'Timeline',
            children: (
              <TimelineView
                sessions={model.effectiveExperienceReports.flatMap((report) => report.sessions)}
                lang={lang}
              />
            ),
          },
          {
            key: 'action',
            label: zh ? '复核待办' : 'Review actions',
            children: (
              <ReviewActionsPanel
                model={model}
                lang={lang}
                onSelectSkill={(skillName) => {
                  setSkillFilter(skillName);
                  setActiveTab('signals');
                }}
              />
            ),
          },
          {
            key: 'chains',
            label: zh ? 'Skill 链' : 'Skill chains',
            children: <SkillChains chains={model.skillChains} lang={lang} />,
          },
        ]}
      />
    </>
  );
}
