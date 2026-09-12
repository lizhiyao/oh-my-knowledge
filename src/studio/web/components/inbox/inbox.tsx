'use client';
import { useState } from 'react';
import { Button, Empty, Tabs, Typography } from 'antd';
import type { ObservationInboxViewModel } from '../../../../observability/inbox/view-model';
import type { Language } from '../layout/shell';
import { SignalSection } from './signals';
import { SkillBoard } from './skill-board';

const PENDING_TABS = [
  { key: 'metrics', zh: '指标', en: 'Metrics' },
  { key: 'experience', zh: '体验复盘', en: 'Experience review' },
  { key: 'action', zh: '复核待办', en: 'Review actions' },
  { key: 'timeline', zh: '时间轴', en: 'Timeline' },
  { key: 'chains', zh: 'Skill 链', en: 'Skill chains' },
] as const;

/**
 * 观测收件箱 React 骨架（#839 批次 2）：信号明细与 Skill 看板已迁移，
 * 其余子视图占位，后续批次逐个替换并删除对应 HTML 渲染器。
 * 页面在收口批次接通路由前不经生产入口可达。
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
        <Typography.Text type="secondary">
          {zh
            ? `${filteredItems.length} 条信号（共 ${model.allItems.length} 条）`
            : `${filteredItems.length} signals (${model.allItems.length} total)`}
        </Typography.Text>
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
          ...PENDING_TABS.map((tab) => ({
            key: tab.key,
            label: zh ? tab.zh : tab.en,
            children: (
              <Empty
                description={zh
                  ? '该子视图将在 #839 后续批次迁移。'
                  : 'This section will be migrated in a later #839 batch.'}
              />
            ),
          })),
        ]}
      />
    </>
  );
}
