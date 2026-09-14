'use client';
import { useState } from 'react';
import { Alert, Collapse, Descriptions, Empty, Input, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { DoctorGraphView, DoctorRuleView, DoctorSamplingView } from '../../../application/doctor-format';
import { projectDoctorRules, projectDoctorSampling } from '../../../application/doctor-format';
import type { SkillDoctorSnapshot } from '../../../view-models/skill-index';
import type { DoctorRunSummary, KnowledgePage, KnowledgeRow } from '../../../http/knowledge-page';
import type { DoctorRuleStatus } from '../../../../knowledge-artifacts/doctor/contracts';
import type { Language } from '../layout/shell';
import { KnowledgeSectionNav } from './section-nav';

const { Text } = Typography;
function Health({ row }: { row: KnowledgeRow }) {
  const color = { green: 'success', yellow: 'warning', red: 'error', gray: 'default' }[row.health.color];
  return <Space size={4}><Tag color={color}>{row.health.label}</Tag>{row.health.score !== null && <Text>{row.health.score}</Text>}</Space>;
}
function date(value: string | undefined) { return value ? value.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC') : '—'; }

const RULE_STATUS = {
  pass: { color: 'success', zh: '通过', en: 'pass' },
  warn: { color: 'warning', zh: '警告', en: 'warn' },
  fail: { color: 'error', zh: '失败', en: 'fail' },
  skipped: { color: 'default', zh: '跳过', en: 'skipped' },
} as const satisfies Record<DoctorRuleStatus, { color: string; zh: string; en: string }>;

function ruleLabel(rule: DoctorRuleView, zh: boolean) {
  const status = RULE_STATUS[rule.status];
  return <Space size={6}><Tag color={status.color}>{zh ? status.zh : status.en}</Tag><Text strong>{rule.title}</Text></Space>;
}

function ruleBody(rule: DoctorRuleView, zh: boolean) {
  return <div className="knowledge-rule">
    <div className="knowledge-rule-message">
      <Text>{rule.message}</Text>
      {rule.hint && <div className="knowledge-finding-sug">{rule.hint}</div>}
    </div>
    {rule.findings.length === 0
      ? <Text type="secondary">{zh ? '无逐条 finding。' : 'No findings.'}</Text>
      : <div className="knowledge-findings">{rule.findings.map((finding, index) => <div className="knowledge-finding" key={`${rule.ruleId}-${index}`}>
        <div className="knowledge-finding-desc">
          <Text>{finding.description}</Text>
          {finding.support && <Tag color={finding.support.k >= finding.support.n ? 'success' : 'warning'}
            title={zh ? `${finding.support.n} 次采样里有 ${finding.support.k} 次报了这条` : `Reported by ${finding.support.k} of ${finding.support.n} samples`}
          >{finding.support.k}/{finding.support.n}</Tag>}
        </div>
        {finding.suggestion && <div className="knowledge-finding-sug">{finding.suggestion}</div>}
      </div>)}</div>}
  </div>;
}

/** 逐条规则：问题项在前且默认展开首条，通过／跳过项折叠 —— 与退役前的体检详情页同一读法。 */
function DoctorRules({ rules, zh }: { rules: DoctorRuleView[]; zh: boolean }) {
  const issues = rules.filter((rule) => rule.status === 'fail' || rule.status === 'warn');
  const rest = rules.filter((rule) => rule.status !== 'fail' && rule.status !== 'warn');
  const items = (list: DoctorRuleView[], openFirst: boolean) => list.map((rule, index) => ({
    key: rule.ruleId,
    label: ruleLabel(rule, zh),
    forceRender: openFirst && index === 0,
    children: ruleBody(rule, zh),
  }));
  return <>
    {issues.length === 0
      ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={zh ? '所有规则通过，无待处理项。' : 'All rules passed.'}/>
      : <Collapse className="knowledge-rules" size="small" items={items(issues, true)} defaultActiveKey={[issues[0].ruleId]}/>}
    {rest.length > 0 && <Collapse className="knowledge-rules knowledge-rules--fold" size="small" ghost items={[{
      key: 'passed',
      label: zh ? `展开 ${rest.length} 条通过的规则` : `Show ${rest.length} passed rules`,
      children: <Collapse size="small" items={items(rest, false)}/>,
    }]}/>}
  </>;
}

function SamplingAlert({ sampling, zh }: { sampling: DoctorSamplingView; zh: boolean }) {
  return <Alert className="knowledge-alert" type="warning" showIcon title={zh ? '共识置信降级' : 'Consensus confidence degraded'}
    description={zh
      ? `本次只成功解析 ${sampling.succeeded}/${sampling.requested} 次采样，finding 支持度仅基于成功样本。建议重跑，或在限流场景下降低并发。`
      : `Only ${sampling.succeeded}/${sampling.requested} samples parsed successfully. Finding support is based on successful samples only. Re-run or lower concurrency if rate-limited.`}
  />;
}

/** 绑定强度的可视档位：三档弱绑定各有名字与配色，不靠 tooltip 区分。 */
const BINDING_TIER = {
  'content-hash': { color: 'success', zh: '内容哈希绑定', en: 'content-hash binding' },
  'source-locator': { color: 'warning', zh: '仅来源路径一致', en: 'source path only' },
  'name-only': { color: 'error', zh: '仅名称一致', en: 'name only' },
  mixed: { color: 'warning', zh: '绑定强度不一', en: 'mixed binding' },
} as const satisfies Record<DoctorGraphView['binding'], { color: string; zh: string; en: string }>;

/** 每一档的口径直接写进页面正文：计数可以被读成结论，强度说明决定了它能不能被这样读。 */
const BINDING_NOTE = {
  'content-hash': {
    zh: '结构按内容哈希绑定，可以跨机器核对到被体检的那份内容。',
    en: 'Bound by content hash — this structure describes the exact content that was checked.',
  },
  'source-locator': {
    zh: '只核对到来源路径一致，内容有没有变动未被证明，下面的计数不能读成「我改过的就是这份」。',
    en: 'Only the source path matches. Unchanged content is not proven, so the counts below cannot be read as "this is the content I edited".',
  },
  'name-only': {
    zh: '图谱既没有内容哈希也没有来源路径，只按知识对象名称对上；改名或同名换内容都会读成同一份结构，这不是内容证明。',
    en: 'The graph carries neither a content hash nor a source path — nodes were matched by name only. Renames and same-name rewrites collapse into this one structure; it is not proof of content.',
  },
  mixed: {
    zh: '同一轮里各对象的绑定强度不一致，这里按最弱的一档呈现，下面的计数不能读成内容证明。',
    en: 'Binding strengths differ across objects in this run and the weakest one is shown here, so the counts below are not proof of content.',
  },
} as const satisfies Record<DoctorGraphView['binding'], { zh: string; en: string }>;

const NODE_KIND = {
  skill_file: { zh: 'SKILL 文件', en: 'skill files' },
  frontmatter: { zh: 'frontmatter', en: 'frontmatter' },
  reference: { zh: '引用', en: 'references' },
  script: { zh: '脚本', en: 'scripts' },
  preflight: { zh: '预检', en: 'preflights' },
  tool: { zh: '工具', en: 'tools' },
  hard_rule: { zh: '硬规则', en: 'hard rules' },
  workflow: { zh: '工作流', en: 'workflows' },
  workflow_node: { zh: '流程节点', en: 'workflow nodes' },
  doctor_rule_result: { zh: '体检规则结果', en: 'doctor rules' },
} as const satisfies Record<string, { zh: string; en: string }>;

function nodeKindLabel(kind: string, zh: boolean): string {
  const label = NODE_KIND[kind as keyof typeof NODE_KIND];
  return label ? (zh ? label.zh : label.en) : kind;
}

/** 知识对象结构：体检 graph sidecar 的绑定强度与分类计数（#884）。 */
function GraphStructure({ graph, run, zh }: { graph: DoctorGraphView; run: SkillDoctorSnapshot; zh: boolean }) {
  const tier = BINDING_TIER[graph.binding];
  const counts: [string, number][] = [
    [zh ? '引用' : 'references', graph.counts.references],
    [zh ? '脚本' : 'scripts', graph.counts.scripts],
    [zh ? '工作流' : 'workflows', graph.counts.workflows],
    [zh ? '流程节点' : 'workflow nodes', graph.counts.workflowNodes],
    [zh ? '硬规则' : 'hard rules', graph.counts.hardRules],
    [zh ? '图谱节点' : 'graph nodes', graph.nodeCount],
    [zh ? '图谱边' : 'graph edges', graph.edgeCount],
  ];
  const definitionTotal = graph.nodeGroups.reduce((sum, group) => sum + group.nodes.length, 0);
  return <div className="knowledge-graph">
    <div className="knowledge-graph-head">
      <Text strong>{zh ? '知识对象结构' : 'Knowledge structure'}</Text>
      <Tag color={tier.color}>{zh ? tier.zh : tier.en}</Tag>
      {graph.artifactHash && <Text className="knowledge-graph-hash" code title={graph.artifactHash}>{graph.artifactHash}</Text>}
      <Text type="secondary">{zh ? `来自体检 ${graph.sourceId} · ${date(graph.generatedAt)}` : `from doctor run ${graph.sourceId} · ${date(graph.generatedAt)}`}</Text>
    </div>
    <div className="knowledge-graph-note">{zh ? BINDING_NOTE[graph.binding].zh : BINDING_NOTE[graph.binding].en}</div>
    {graph.sourceId !== run.reportId && <div className="knowledge-graph-note">
      {zh
        ? `上面这份结构证据来自体检 ${graph.sourceId}，当前查看的是 ${run.reportId}，计数不属于本轮。`
        : `This structure was captured in run ${graph.sourceId} while you are viewing ${run.reportId}; the counts are not from the displayed run.`}
    </div>}
    <div className="knowledge-graph-counts">{counts.map(([label, value]) => <span key={label}>
      <Text type="secondary">{label}</Text> <Text strong>{value}</Text>
    </span>)}</div>
    {definitionTotal > 0 && <Collapse className="knowledge-rules knowledge-rules--fold" size="small" ghost items={[{
      key: 'definition-nodes',
      label: zh
        ? `展开 ${definitionTotal} 个定义节点（${graph.nodeGroups.length} 类）`
        : `Show ${definitionTotal} definition nodes (${graph.nodeGroups.length} kinds)`,
      children: <Collapse size="small" items={graph.nodeGroups.map((group) => ({
        key: group.nodeKind,
        label: <Space size={6}><Text strong>{nodeKindLabel(group.nodeKind, zh)}</Text><Tag>{group.nodes.length}</Tag></Space>,
        children: <ul className="knowledge-graph-nodes">{group.nodes.map((node, index) => <li key={node.stableKey ?? `${node.nodeKind}:${index}`}>
          <Text>{node.label}</Text>{node.status && <Text type="secondary"> · {node.status}</Text>}
        </li>)}</ul>,
      }))}/>,
    }]}/>}
  </div>;
}

function DoctorPanel({ run, skillName, isCurrent, doctorRuns, rules, sampling, graph, zh, suffix }: {
  run: SkillDoctorSnapshot;
  skillName: string;
  isCurrent: boolean;
  doctorRuns: DoctorRunSummary[];
  rules: DoctorRuleView[];
  sampling: DoctorSamplingView | null;
  graph: DoctorGraphView | null;
  zh: boolean;
  suffix: string;
}) {
  const detailHref = `/knowledge/skills/${encodeURIComponent(skillName)}${suffix}`;
  return <>
    {sampling && <SamplingAlert sampling={sampling} zh={zh}/>}
    <Space className="knowledge-summary" wrap>
      <Tag color="success">{run.passCount} {zh ? '通过' : 'passed'}</Tag>
      <Tag color="warning">{run.warnCount} {zh ? '警告' : 'warnings'}</Tag>
      <Tag color="error">{run.failCount} {zh ? '失败' : 'failed'}</Tag>
      <Text type="secondary">{date(run.timestamp)}</Text>
      {isCurrent
        ? <Tag color="processing">{zh ? '当前' : 'current'}</Tag>
        : <a href={detailHref}>{zh ? '← 返回当前体检' : '← back to current run'}</a>}
    </Space>
    <DoctorRules rules={rules} zh={zh}/>
    {graph && <GraphStructure graph={graph} run={run} zh={zh}/>}
    {doctorRuns.length > 1 && <div className="knowledge-runs">
      <Text strong>{zh ? '体检历史' : 'Doctor history'}</Text>
      <ul>
        {doctorRuns.map((item) => {
          const counts = <Text type="secondary"> {item.passCount}✓ {item.warnCount}⚠ {item.failCount}✗</Text>;
          return <li key={item.reportId}>
            {item.reportId === run.reportId
              ? <Text>{date(item.timestamp)}</Text>
              : <a href={`${detailHref}${detailHref.includes('?') ? '&' : '?'}doctorRun=${encodeURIComponent(item.reportId)}`}>{date(item.timestamp)}</a>}
            {counts}
          </li>;
        })}
      </ul>
    </div>}
  </>;
}

export function KnowledgeView({ page, lang }: { page: KnowledgePage; lang: Language }) {
  const zh = lang === 'zh';
  const suffix = zh ? '' : '?lang=en';
  const [query, setQuery] = useState('');
  if (page.pageKind === 'index') {
    const rows = page.rows.filter((row) => row.skillName.toLowerCase().includes(query.toLowerCase()));
    return <>
      <KnowledgeSectionNav active="skills" lang={lang}/>
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
  const { row, insights, toolFailureRate, doctorRuns, doctorRun, graph } = page;
  const { doctor, observe } = row;
  const activeDoctor = doctorRun ?? doctor;
  return <>
    <KnowledgeSectionNav active="skills" lang={lang}/>
    <div className="measure-heading"><div><a href={`/knowledge${suffix}`}>{zh ? '返回知识列表' : 'Back to knowledge'}</a><h1 title={row.skillName}>{row.skillName}</h1></div><Health row={row}/></div>
    <Tabs className="studio-detail-tabs" items={[
      { key: 'doctor', label: zh ? '健康体检' : 'Doctor', children: activeDoctor ? <>
        <DoctorPanel
          run={activeDoctor}
          skillName={row.skillName}
          isCurrent={doctorRun === null}
          doctorRuns={doctorRuns}
          rules={projectDoctorRules(activeDoctor.results)}
          sampling={projectDoctorSampling(activeDoctor.results)}
          graph={graph}
          zh={zh}
          suffix={suffix}
        />
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
