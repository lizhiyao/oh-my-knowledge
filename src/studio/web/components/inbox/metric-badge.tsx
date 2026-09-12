'use client';
import { Popover, Typography } from 'antd';
import {
  indicatorHelp,
  indicatorLabel,
  type IndicatorHelpKey,
} from '../../../../observability/inbox/metric-semantics';
import type { Language } from '../layout/shell';

/** 指标徽章：标签 + 计数，悬停/点击展示该指标的口径说明（#839 批次 4）。 */
export function MetricBadge({ metricKey, value, lang }: { metricKey: IndicatorHelpKey; value: number; lang: Language }) {
  const label = indicatorLabel(metricKey, lang);
  return (
    <Popover
      content={<Typography.Text style={{ fontSize: 12 }}>{indicatorHelp(metricKey, lang)}</Typography.Text>}
      title={label}
      trigger={['hover', 'click']}
    >
      <Typography.Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>
        {label} <Typography.Text strong style={{ fontSize: 12 }}>{value}</Typography.Text>
      </Typography.Text>
    </Popover>
  );
}
