'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Button, Space, Tabs, Tag, Typography } from 'antd';
import type { ObservationInboxViewModel } from '../../../../../observability/view-models/index';
import { OBSERVE_INBOX_PATH } from '../../../../http/page-paths';
import { DEFAULT_OBSERVE_INBOX_TAB, type ObserveInboxTab } from '../../../../http/page-params';
import { type Language } from '../../layout/shell';
import { mirrorTabToUrl } from '../../tab-url';
import { SignalSection } from './signals';
import { SkillBoard } from './skill-board';
import { ExperienceReviewSection } from './experience-review';
import { MetricsGuide } from './metrics-guide';
import { TimelineView } from './timeline-view';
import { SkillChains } from './skill-chains';
import { ReviewActionsPanel } from './review-actions-panel';

/**
 * 观测收件箱页面外壳（#839 收口后的唯一实现）：子视图只呈现 observability/inbox 投影，
 * skill 筛选是本地状态，子视图切换由地址承载（#903 D3：初始值来自路由页校验过的 `?tab=`，
 * 之后每次切换浅写回地址，分享与刷新都能回到所见面板），复核 mutation 走 /api/observe-inbox/review-state。
 */
export function InboxView({
  model,
  lang,
  initialTab,
}: {
  model: ObservationInboxViewModel;
  lang: Language;
  initialTab: ObserveInboxTab;
}) {
  const zh = lang === 'zh';
  const [activeTab, setActiveTab] = useState<ObserveInboxTab>(initialTab);
  const [skillFilter, setSkillFilter] = useState<string | undefined>(undefined);
  function changeTab(next: ObserveInboxTab) {
    setActiveTab(next);
    mirrorTabToUrl(next, DEFAULT_OBSERVE_INBOX_TAB);
  }
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
              <Link href={OBSERVE_INBOX_PATH} style={{ fontSize: 12 }}>
                {zh ? '查看全量' : 'View all'}
              </Link>
            </>
          ) : null}
        </Space>
      </div>
      <Tabs
        activeKey={activeTab}
        // antd 回填的是 string，取值只可能来自下面 items 里出现过的键；键集合与本模块的一致性由
        // test/architecture/studio-page-params.test.ts 钉住。
        onChange={(next) => changeTab(next as ObserveInboxTab)}
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
                  changeTab('signals');
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
                  changeTab('signals');
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
