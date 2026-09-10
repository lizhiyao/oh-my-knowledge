'use client';
import { useState } from 'react';
import { Button, Descriptions, Drawer, Empty, Input, Space, Table, Tag, Typography } from 'antd';
import type { ExperienceTimelineEvent } from '../../../../observability/contracts/experience';
import type { ObservationSourceRecordArchiveView } from '../../../../observability/contracts/inbox';
import type { Language } from '../layout/shell';

type RecordRow = { id: string; index: number; timestamp?: string; type: string; label: string; text: string; data: Record<string, unknown>; limited: boolean };
export function EventRecords({events,lang}: {events:ExperienceTimelineEvent[];lang:Language}) {
  return <RecordBrowser lang={lang} rows={events.map(event=>({id:event.id,index:event.order,timestamp:event.timestamp,type:event.kind,label:event.label??event.toolName??event.kind,text:event.fullText??event.snippet??'',data:event,limited:false}))}/>;
}
export function RawRecords({archive,lang}: {archive:ObservationSourceRecordArchiveView;lang:Language}) {
  const zh=lang==='zh';
  const limited=archive.truncated||archive.omittedRecordCount>0||archive.status!=='available';
  return <RecordBrowser lang={lang} notice={limited?`${zh?'原始记录可用性受限':'Source records limited'} · ${archive.status} · ${zh?'省略':'omitted'} ${archive.omittedRecordCount}${archive.reason?` · ${archive.reason}`:''}`:undefined} rows={archive.records.map(record=>({id:`${record.traceId}:${record.sourceIndex}`,index:record.sourceIndex,timestamp:record.timestamp,type:record.sourceType,label:record.sourceEventId??record.sourceType,text:record.raw,data:{...record},limited:record.truncated||record.redacted}))} raw/>;
}
function RecordBrowser({rows,lang,raw=false,notice}: {rows:RecordRow[];lang:Language;raw?:boolean;notice?:string}) {
  const zh=lang==='zh';
  const [query,setQuery]=useState('');
  const [selectedId,setSelectedId]=useState<string>();
  const selected=rows.find(row=>row.id===selectedId);
  const filtered=rows.filter(row=>`${row.index} ${row.timestamp??''} ${row.type} ${row.label} ${row.text}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="record-browser">
    <div className="observe-toolbar"><Input allowClear aria-label={zh?'搜索记录':'Search records'} placeholder={zh?'搜索类型、时间或内容':'Search type, time or content'} value={query} onChange={event=>setQuery(event.target.value)}/><Space><Typography.Text type="secondary">{filtered.length} / {rows.length} {zh?'条记录':'records'}</Typography.Text>{notice&&<Tag color="warning" title={notice}>{zh?'部分记录受限':'Limited records'}</Tag>}</Space></div>
    {notice&&<p className="record-notice">{notice}</p>}
    <Table<RecordRow> className="measure-table" size="small" rowKey="id" dataSource={filtered} scroll={{x:'max-content'}} pagination={{pageSize:20,showSizeChanger:false,hideOnSinglePage:true}} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={zh?'没有匹配的记录':'No matching records'}/>}} columns={[
      {title:zh?'序号':'Index',dataIndex:'index',width:80,align:'right'},
      {title:zh?'时间':'Time',dataIndex:'timestamp',width:210,render:(value:string|undefined)=>value?.replace('T',' ').replace(/Z$/,' UTC')??'—'},
      {title:zh?'类型':'Type',dataIndex:'type',width:200},
      ...(!raw?[{title:zh?'事件':'Event',dataIndex:'label'}]:[]),
      {title:zh?'内容':'Content',width:130,fixed:'right',render:(_,row)=><Space><Button type="link" size="small" onClick={()=>setSelectedId(row.id)}>{zh?'查看详情':'View details'}</Button>{row.limited&&<Tag color="warning">{zh?'受限':'Limited'}</Tag>}</Space>},
    ]}/>
    <Drawer title={selected?`${zh?'记录':'Record'} #${selected.index} · ${selected.type}`:''} open={Boolean(selected)} onClose={()=>setSelectedId(undefined)} size="large">
      {selected&&<><Descriptions size="small" column={1} items={Object.entries(selected.data).filter(([key])=>key!=='raw'&&key!=='fullText'&&key!=='snippet').map(([key,value])=>({key,label:key,children:<span className="record-field">{typeof value==='object'?JSON.stringify(value,null,2):String(value??'—')}</span>}))}/><h3>{raw?(zh?'原始文本':'Raw text'):(zh?'完整内容':'Full content')}</h3><pre className="record-text">{selected.text|| (zh?'未记录文本内容':'No text content recorded')}</pre></>}
    </Drawer>
  </section>;
}
