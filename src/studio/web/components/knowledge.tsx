'use client';
import { useState } from 'react';
import { Descriptions, Empty, Input, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { KnowledgePage, KnowledgeRow } from '../../http/knowledge-page';
import type { Language } from './shell';

const { Text } = Typography;
function Health({ row }: { row: KnowledgeRow }) {
  const color = { green: 'success', yellow: 'warning', red: 'error', gray: 'default' }[row.health.color];
  return <Space size={4}><Tag color={color}>{row.health.label}</Tag>{row.health.score !== null && <Text>{row.health.score}</Text>}</Space>;
}
function date(value: string | undefined) { return value ? value.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC') : '—'; }
export function KnowledgeView({ page, lang }: { page: KnowledgePage; lang: Language }) {
  const zh = lang === 'zh';
  const suffix = zh ? '' : '?lang=en';
  const [query, setQuery] = useState('');
  if (page.pageKind === 'index') {
    const rows = page.rows.filter((row) => row.skillName.toLowerCase().includes(query.toLowerCase()));
    return <>
      <div className="observe-toolbar knowledge-toolbar"><Input.Search allowClear placeholder={zh ? '搜索知识对象' : 'Search knowledge'} value={query} onChange={(event) => setQuery(event.target.value)}/><Space><Text type="secondary">{page.summary.totalSkills} {zh ? '个知识对象' : 'knowledge artifacts'}</Text><Tag color="error">{page.summary.red} {zh ? '红' : 'red'}</Tag><Tag color="warning">{page.summary.yellow} {zh ? '黄' : 'yellow'}</Tag><Tag color="success">{page.summary.green} {zh ? '绿' : 'green'}</Tag></Space></div>
      <Table<KnowledgeRow> className="measure-table knowledge-table" size="small" rowKey="skillName" tableLayout="fixed" scroll={{ x: 960 }} dataSource={rows} pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={zh ? '尚无体检或生产观测数据。' : 'No doctor or observe data yet.'}/> }} columns={[
        { title: zh ? '知识对象' : 'Knowledge', dataIndex: 'skillName', ellipsis: true, render: (name: string) => <a href={`/knowledge/skills/${encodeURIComponent(name)}${suffix}`} title={name}>{name}</a> },
        { title: zh ? '健康' : 'Health', width: 140, render: (_, row) => <Health row={row}/> },
        { title: zh ? '健康体检' : 'Doctor', width: 140, render: (_, { doctor }) => doctor ? `${doctor.passCount}✓ ${doctor.warnCount}⚠ ${doctor.failCount}✗` : '—' },
        { title: zh ? '生产观测' : 'Observe', width: 120, render: (_, { observe }) => !observe ? '—' : observe.confidence === 'underpowered' ? (zh ? '样本不足' : 'Underpowered') : `${(observe.gapRate * 100).toFixed(1)}% ${zh ? '缺口' : 'gap'}` },
        { title: zh ? '问题' : 'Findings', dataIndex: 'insightCount', width: 72, align: 'right' },
        { title: zh ? '更新时间' : 'Updated', width: 200, ellipsis: true, render: (_, row) => date([row.doctor?.timestamp, row.observe?.generatedAt].filter((value): value is string => Boolean(value)).sort().at(-1)) },
      ]}/>
    </>;
  }
  const { row, insights, toolFailureRate } = page;
  const { doctor, observe } = row;
  return <>
    <div className="measure-heading"><div><a href={`/knowledge${suffix}`}>{zh ? '返回知识列表' : 'Back to knowledge'}</a><h1 title={row.skillName}>{row.skillName}</h1></div><Health row={row}/></div>
    <Tabs className="studio-detail-tabs" items={[
      { key: 'doctor', label: zh ? '健康体检' : 'Doctor', children: doctor ? <>
        <Space className="knowledge-summary"><Tag color="success">{doctor.passCount} {zh ? '通过' : 'passed'}</Tag><Tag color="warning">{doctor.warnCount} {zh ? '警告' : 'warnings'}</Tag><Tag color="error">{doctor.failCount} {zh ? '失败' : 'failed'}</Tag><Text type="secondary">{date(doctor.timestamp)}</Text></Space>
        <Table size="small" rowKey="ruleId" pagination={false} dataSource={doctor.results} columns={[{ title: zh ? '规则' : 'Rule', dataIndex: 'ruleId', width: 220 }, { title: zh ? '状态' : 'Status', dataIndex: 'status', width: 100, render: (value: string) => <Tag color={value === 'fail' ? 'error' : value === 'warn' ? 'warning' : value === 'pass' ? 'success' : 'default'}>{zh ? ({pass:'通过',warn:'警告',fail:'失败',skipped:'跳过'}[value] ?? value) : value}</Tag> }, { title: zh ? '说明' : 'Description', dataIndex: 'message' }]}/>
      </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={zh ? '尚未运行体检。' : 'Not run yet.'}/> },
      { key: 'observe', label: zh ? '生产观测' : 'Observe', children: observe ? <Descriptions bordered size="small" column={2} items={[
        { key: 'gap', label: zh ? '知识缺口' : 'Knowledge gap', children: `${(observe.gapRate * 100).toFixed(1)}%` },
        { key: 'fail', label: zh ? '工具失败' : 'Tool failures', children: toolFailureRate === null ? (zh ? '未测得' : 'Not measured') : `${(toolFailureRate * 100).toFixed(1)}%` },
        { key: 'segments', label: zh ? '片段数' : 'Segments', children: observe.segmentCount },
        { key: 'confidence', label: zh ? '可信度' : 'Confidence', children: observe.confidence === 'underpowered' ? (zh ? '样本不足，仅供参考' : 'Underpowered; indicative only') : observe.confidence },
      ]}/> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={zh ? '尚无生产观测。' : 'No production observations yet.'}/> },
      { key: 'findings', label: `${zh ? '待优化项' : 'Findings'} (${insights.length})`, children: <Table size="small" rowKey="id" pagination={false} dataSource={insights} locale={{ emptyText: zh ? '当前没有活跃问题。' : 'No active findings.' }} columns={[{ title: zh ? '问题' : 'Finding', dataIndex: 'title', width: 240 }, { title: zh ? '说明' : 'Description', dataIndex: 'description' }, { title: zh ? '受众' : 'Audience', dataIndex: 'audience', width: 100 }, { title: zh ? '严重度' : 'Severity', dataIndex: 'severity', width: 100, render: (value: string) => <Tag color={value === 'high' ? 'error' : value === 'medium' ? 'warning' : 'default'}>{value}</Tag> }]}/> },
    ]}/>
  </>;
}
