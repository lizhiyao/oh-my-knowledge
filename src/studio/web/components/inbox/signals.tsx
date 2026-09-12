'use client';
import { Table, Tag, Tooltip, Typography } from 'antd';
import type { ObservationInboxItem } from '../../../../observability/contracts/inbox';
import {
  signalEvidenceConclusion,
  signalRuleDescription,
  signalSeverityMeta,
  signalSourceMeta,
  type SignalSeverityTone,
} from '../../../../observability/inbox/signal-semantics';
import type { Language } from '../layout/shell';

const SEVERITY_TAG_COLOR: Record<SignalSeverityTone, string> = {
  error: 'error',
  warning: 'warning',
  info: 'processing',
  neutral: 'default',
};

function evidenceQuote(item: ObservationInboxItem): string {
  const evidence = item.evidence;
  return evidence.query || evidence.path || evidence.assistantSnippet || evidence.outputSnippet || '';
}

export function SignalSection({ items, lang }: { items: ObservationInboxItem[]; lang: Language }) {
  const zh = lang === 'zh';
  return (
    <Table
      size="small"
      rowKey="id"
      dataSource={items}
      pagination={{ pageSize: 20, showSizeChanger: false }}
      scroll={{ x: 1100 }}
      columns={[
        {
          title: 'Skill',
          dataIndex: 'skillName',
          render: (name: string, item) => (
            <>
              <Typography.Text strong>{name}</Typography.Text>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.artifactVersion}</Typography.Text>
            </>
          ),
        },
        {
          title: zh ? '信号' : 'Signal',
          dataIndex: 'signalType',
          render: (type: string, item) => (
            <>
              <Typography.Text>{type}</Typography.Text>{' '}
              <Tooltip title={signalRuleDescription(item, lang)}>
                <Typography.Text type="secondary" aria-label={signalRuleDescription(item, lang)}>?</Typography.Text>
              </Tooltip>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>OMK subtype: {item.signalSubtype}</Typography.Text>
            </>
          ),
        },
        {
          title: zh ? '严重度' : 'Severity',
          dataIndex: 'severity',
          render: (_: unknown, item) => {
            const meta = signalSeverityMeta(item.severity, lang);
            return (
              <>
                <Tag color={SEVERITY_TAG_COLOR[meta.tone]}>{meta.label}</Tag>
                <br />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{meta.decision}</Typography.Text>
              </>
            );
          },
        },
        {
          title: zh ? '证据' : 'Evidence',
          render: (_: unknown, item) => {
            const quote = evidenceQuote(item);
            return (
              <div style={{ maxWidth: 360 }}>
                <Typography.Text style={{ fontSize: 12 }}>{signalEvidenceConclusion(item, lang)}</Typography.Text>
                {quote ? (
                  <div>
                    <Typography.Text code style={{ fontSize: 11 }} ellipsis={{ tooltip: quote }}>
                      {quote.slice(0, 220)}
                    </Typography.Text>
                  </div>
                ) : null}
              </div>
            );
          },
        },
        {
          title: zh ? '次数' : 'Count',
          dataIndex: 'occurrences',
          align: 'right',
          render: (count: number) => (
            <Tooltip title={zh ? '按 skill + cwd + signal + subtype + query/path 归一化去重后的聚合次数，不是样本量。' : 'Aggregated count after dedup by skill + cwd + signal + subtype + query/path; not a sample size.'}>
              <Typography.Text strong>{count}</Typography.Text>
            </Tooltip>
          ),
        },
        {
          title: zh ? '来源' : 'Source',
          dataIndex: 'sourceKind',
          render: (_: unknown, item) => {
            const meta = signalSourceMeta(item.sourceKind);
            return <Tag color={meta.tone === 'neutral' ? 'default' : meta.tone}>{meta.label}</Tag>;
          },
        },
        {
          title: zh ? '最近出现' : 'Last seen',
          dataIndex: 'lastSeen',
          sorter: (a, b) => a.lastSeen.localeCompare(b.lastSeen),
          defaultSortOrder: 'descend',
        },
      ]}
    />
  );
}
