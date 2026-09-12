'use client';
import { Empty, Tabs, Typography } from 'antd';
import type { ObservationInboxViewModel } from '../../../../observability/inbox/view-model';
import type { Language } from '../layout/shell';
import { SignalSection } from './signals';

const PENDING_TABS = [
  { key: 'metrics', zh: '指标', en: 'Metrics' },
  { key: 'experience', zh: '体验', en: 'Experience' },
  { key: 'process', zh: '流程', en: 'Process' },
  { key: 'review', zh: '复核', en: 'Review' },
  { key: 'timeline', zh: '时间轴', en: 'Timeline' },
  { key: 'chains', zh: 'Skill 链', en: 'Skill chains' },
] as const;

/**
 * 观测收件箱 React 骨架（#839 批次 1）：信号子视图已迁移，
 * 其余子视图占位，后续批次逐个替换并删除对应 HTML 渲染器。
 * 页面在收口批次接通路由前不经生产入口可达。
 */
export function InboxView({ model, lang }: { model: ObservationInboxViewModel; lang: Language }) {
  const zh = lang === 'zh';
  return (
    <>
      <div>
        <h1>{zh ? '观测收件箱' : 'Observation inbox'}</h1>
        <Typography.Text type="secondary">
          {zh
            ? `${model.items.length} 条信号（共 ${model.allItems.length} 条）`
            : `${model.items.length} signals (${model.allItems.length} total)`}
        </Typography.Text>
      </div>
      <Tabs
        items={[
          {
            key: 'signals',
            label: zh ? '信号' : 'Signals',
            children: <SignalSection items={model.items} lang={lang} />,
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
