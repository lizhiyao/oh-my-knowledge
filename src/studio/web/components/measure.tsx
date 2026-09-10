'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, Collapse, Descriptions, Empty, Input, Table, Tabs, Tag, Typography } from 'antd';
import type { CoreStudioRunCard, CoreStudioRunDetail } from '../../core-runs/contracts';
import type { Language } from './shell';

const labels: Record<string, string> = { completed:'已完成', cancelled:'已取消', 'budget-exhausted':'预算耗尽', failed:'失败', complete:'完整', partial:'部分缺失', unresolvable:'无法解析', conclusive:'可形成结论', inconclusive:'证据不足', 'not-evaluated':'未评估' };
function Status({ value, lang }: {value:string; lang:Language}) {
  const color = value === 'failed' || value === 'unresolvable' ? 'error' : ['partial','inconclusive','budget-exhausted'].includes(value) ? 'warning' : undefined;
  return <Tag color={color}>{lang === 'zh' ? labels[value] ?? value : value}</Tag>;
}
export function SourceError({lang}: {lang:Language}) {
  return <Alert type="error" showIcon title={lang === 'zh' ? '暂时无法读取评测产物' : 'Evaluation artifacts are unavailable'} description={lang === 'zh' ? '请检查报告目录是否可读取，然后刷新页面。' : 'Check that the report directory is readable, then reload.'}/>;
}
export function RunList({runs,lang}: {runs:CoreStudioRunCard[];lang:Language}) {
  const [query,setQuery] = useState('');
  const filtered = useMemo(()=>runs.filter(run=>`${run.runId} ${run.reportId}`.toLowerCase().includes(query.toLowerCase())),[runs,query]);
  const zh = lang === 'zh';
  const suffix = zh ? '' : '?lang=en';
  return <>
    <div className="measure-heading"><div><h1>{zh ? '评测记录' : 'Evaluations'}</h1><p>{zh ? '查看版本差异的测量结果和证据，判断知识改动是否有效。' : 'Review measurements and evidence to assess whether knowledge changes are effective.'}</p></div></div>
    <div className="measure-toolbar"><Input allowClear aria-label={zh ? '搜索评测记录' : 'Search evaluations'} placeholder={zh ? '搜索运行或报告 ID' : 'Search run or report ID'} value={query} onChange={event=>setQuery(event.target.value)}/><Typography.Text type="secondary">{filtered.length} / {runs.length}</Typography.Text></div>
    <Table className="measure-table" size="small" rowKey="runId" dataSource={filtered} pagination={{pageSize:15,showSizeChanger:false}} scroll={{x:850}} locale={{emptyText:<Empty description={runs.length === 0 ? (zh ? '尚无评测记录。完成一次评测后，结果会显示在这里。' : 'No evaluations yet. Completed evaluation results will appear here.') : (zh ? '没有匹配的记录' : 'No matching evaluations')}/>}} columns={[
      {title:zh?'运行':'Run',dataIndex:'runId',render:(id:string)=><Link href={`/measure/${encodeURIComponent(id)}${suffix}`} className="measure-id">{id}</Link>},
      {title:zh?'运行状态':'Run status',render:(_,run)=><Status value={run.status.runStatus} lang={lang}/>},
      {title:zh?'证据状态':'Evidence status',render:(_,run)=><Status value={run.status.evidenceStatus} lang={lang}/>},
      {title:zh?'结论状态':'Conclusion status',render:(_,run)=><Status value={run.status.conclusionStatus} lang={lang}/>},
      {title:zh?'创建时间':'Created',dataIndex:'createdAt',sorter:(a,b)=>a.createdAt.localeCompare(b.createdAt),defaultSortOrder:'descend'},
    ]}/>
  </>;
}
export function RunDetail({detail,lang}: {detail:CoreStudioRunDetail;lang:Language}) {
  const zh=lang==='zh'; const suffix=zh?'':'?lang=en';
  const {run}=detail;
  return <>
    <div className="measure-heading"><div><Link href={`/measure${suffix}`}>{zh?'返回评测记录':'Back to evaluations'}</Link><h1 className="measure-id">{run.runId}</h1><p>{run.createdAt}</p></div></div>
    <div className="measure-state-axes">
      <div>{zh?'运行状态':'Run status'}<Status value={run.status.runStatus} lang={lang}/></div>
      <div>{zh?'证据状态':'Evidence status'}<Status value={run.status.evidenceStatus} lang={lang}/></div>
      <div>{zh?'结论状态':'Conclusion status'}<Status value={run.status.conclusionStatus} lang={lang}/></div>
    </div>
    <Alert type="info" showIcon title={zh?'运行完成不代表改动有效；需要结合证据与结论判断。':'A completed run does not imply an effective change. Review its evidence and conclusions.'}/>
    <Tabs className="studio-detail-tabs" items={[
      {key:'scope',label:zh?'评测范围':'Evaluation scope',children:(<section className="measure-section"><h2>{zh?'评测范围':'Evaluation scope'}</h2><Descriptions bordered column={{xs:1,sm:2,lg:3}} items={[
      {key:'dataset',label:zh?'数据集':'Dataset',children:detail.dataset.datasetId},
      {key:'samples',label:zh?'样本数':'Samples',children:detail.dataset.sampleCount},
      {key:'report',label:zh?'报告':'Report',children:run.reportId},
      {key:'targets',label:zh?'被测版本':'Targets',children:detail.targets.map(target=>target.targetId).join(', ')},
      {key:'evaluators',label:zh?'评分器':'Evaluators',children:detail.evaluators.map(item=>item.evaluatorId).join(', ')},
      {key:'decision',label:zh?'判定':'Decision',children:detail.decision?.verdict ?? (zh?'尚无判定':'No verdict')},
    ]}/></section>)},
      {key:'analysis',label:zh?'分析结果':'Analysis results',children:(<section className="measure-section"><h2>{zh?'分析结果':'Analysis results'}</h2><Table className="measure-table" rowKey="resultId" dataSource={[...detail.stages.analysis.records]} scroll={{x:700}} columns={[
      {title:zh?'分析项':'Analysis',dataIndex:'nodeId'},
      {title:zh?'状态':'Status',dataIndex:'analysisStatus'},
      {title:zh?'结果':'Value',render:(_,record)=>record.numericValue ?? record.resultType ?? '—'},
      {title:zh?'原因':'Reasons',dataIndex:'reasonCodes',render:(values:readonly string[]|undefined)=>values?.join(', ')||'—'},
    ]}/></section>)},
      {key:'evidence',label:zh?'证据与定义':'Evidence and definitions',children:(<section className="measure-section"><Collapse items={[
      {key:'execution',label:zh?'执行记录':'Execution records',children:<Evidence value={detail.stages.execution}/>},
      {key:'evaluation',label:zh?'评分记录':'Evaluation records',children:<Evidence value={detail.stages.evaluation}/>},
      {key:'analysis',label:zh?'分析证据':'Analysis evidence',children:<Evidence value={detail.stages.analysis}/>},
      {key:'plan',label:zh?'测量定义与身份':'Measurement definitions and identities',children:<Evidence value={{dataset:detail.dataset,targets:detail.targets,evaluators:detail.evaluators,metrics:detail.metrics,lineage:detail.lineage,decision:detail.decision,run:detail.run,reportProvenance:detail.reportProvenance}}/>},
    ]}/></section>)},
    ]}/>

  </>;
}
function Evidence({value}: {value:unknown}) { return <pre className="measure-evidence">{JSON.stringify(value,null,2)}</pre>; }
