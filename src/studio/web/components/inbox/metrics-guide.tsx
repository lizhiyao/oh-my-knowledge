'use client';
import { Table, Typography } from 'antd';
import {
  INDICATOR_KEYS,
  indicatorHelp,
  indicatorLabel,
  type IndicatorHelpKey,
} from '../../../../observability/inbox/metric-semantics';
import type { Language } from '../layout/shell';

/** 指标含义与评判标准面板（#839 批次 4）：逐项列出指标口径。 */
export function MetricsGuide({ lang }: { lang: Language }) {
  const zh = lang === 'zh';
  return (
    <>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {zh
          ? '这些指标只解释 trace 里观察到的证据，不自动判断 skill 最终好坏。'
          : 'These metrics only describe evidence observed in traces; they do not judge a skill on their own.'}
      </Typography.Paragraph>
      <Table
        size="small"
        rowKey="key"
        dataSource={INDICATOR_KEYS.map((key) => ({ key }))}
        pagination={false}
        columns={[
          {
            title: zh ? '指标' : 'Indicator',
            dataIndex: 'key',
            width: 260,
            render: (key: IndicatorHelpKey) => (
              <Typography.Text strong style={{ fontSize: 12 }}>
                {indicatorLabel(key, lang)}
              </Typography.Text>
            ),
          },
          {
            title: zh ? '口径说明' : 'Definition',
            dataIndex: 'key',
            render: (key: IndicatorHelpKey) => (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {indicatorHelp(key, lang)}
              </Typography.Text>
            ),
          },
        ]}
      />
    </>
  );
}
