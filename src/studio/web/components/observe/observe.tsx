'use client';
import { ExtractedKnowledge } from './extracted-knowledge';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Breadcrumb, Button, Popover, Space, Table, Tabs, Tag } from 'antd';
import type { ObservePage } from '../../../http/pages/observe-page';
import { EventRecords, RawRecords } from './records';
import type { ObservationSourceRecordArchiveView } from '../../../../observability/contracts/inbox';
import { Swimlane } from './swimlane';
import { ObserveWorkspace } from './workspace';
import { Status } from './activity';
import { langSuffix, type Language } from '../layout/shell';
import { displayTime } from '../../../application/display/format';
import { conversationHref } from '../conversation-link';
function Evidence({value}: {value: unknown}) { return <pre className="observe-evidence">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>; }

export function ObserveView({page, lang}: {page: ObservePage; lang: Language}) {
  if (page.pageKind !== 'trajectory') return <ObserveWorkspace page={page} lang={lang}/>;
  return <Trajectory page={page} lang={lang}/>;
}
function SourceRecords({endpoint,lang}: {endpoint:string;lang:Language}) {
  const [value,setValue]=useState<ObservationSourceRecordArchiveView>(); const [failed,setFailed]=useState(false);
  useEffect(()=>{const controller=new AbortController();
    fetch(endpoint,{signal:controller.signal,cache:'no-store'}).then(response=>{if(!response.ok)throw new Error('unavailable');return response.json();}).then(value=>{if(!controller.signal.aborted)setValue(value);}).catch(()=>{if(!controller.signal.aborted)setFailed(true);});
    return()=>controller.abort();
  },[endpoint]);
  if(failed)return <Alert type="error" title={lang==='zh'?'原始记录暂时无法读取，请重新打开此标签。':'Source records are unavailable. Reopen this tab to retry.'}/>;
  return value===undefined?<p role="status">{lang==='zh'?'正在读取原始记录…':'Loading source records…'}</p>:<RawRecords archive={value} lang={lang}/>;
}
function Trajectory({page,lang}: {page:Extract<ObservePage,{pageKind:'trajectory'}>;lang:Language}) {
  const zh=lang==='zh'; const router=useRouter();
  const api=`/api/conversations/${encodeURIComponent(page.threadId)}/tasks/${encodeURIComponent(page.turnId)}`;
  const [connection,setConnection]=useState('connecting'); const [retry,setRetry]=useState(0);
  const [follow,setFollow]=useState(true);
  const [activeTab,setActiveTab]=useState('replay');
  const [integrityOpen,setIntegrityOpen]=useState(false);
  useEffect(()=>{
    if(!page.live)return;
    const source=new EventSource(`${api}/live`); let timer:ReturnType<typeof setTimeout>|undefined;
    const refresh=()=>{if(timer===undefined)timer=setTimeout(()=>{timer=undefined;router.refresh();},250);};
    source.onopen=()=>setConnection('live');
    source.addEventListener('trajectory',event=>{
      try {const update=JSON.parse((event as MessageEvent<string>).data) as {revision:string;liveObservable:boolean};
        if(update.revision!==page.revision)refresh();
        if(!update.liveObservable){source.close();refresh();}
      }catch {setConnection('failed');source.close();}
    });
    source.addEventListener('trajectory-error',()=>{setConnection('failed');source.close();});
    source.onerror=()=>setConnection('reconnecting');
    return()=>{source.close();if(timer!==undefined)clearTimeout(timer);};
  },[api,page.live,page.revision,router,retry]);
  const model=page.model;
  const onlyUnknown = model.integrity.notices.length > 0 && model.integrity.notices.every(notice => notice.code === 'unknown_events');
  const unknownCount = model.integrity.notices.filter(notice => notice.code === 'unknown_events').reduce((sum, notice) => sum + notice.count, 0);
  const noticeLabels: Record<string, string> = zh ? {
    task_boundary_unavailable: '任务边界无法确定', timeline_truncated: '时间轴已截断', malformed_records: '格式异常的记录', ignored_values: '未处理的数据项', unknown_events: '未解析的事件', unmatched_tool_calls: '缺少对应结果的工具调用', unmatched_tool_results: '缺少对应调用的工具结果', missing_timestamps: '缺少时间戳的事件',
  } : {
    task_boundary_unavailable: 'Task boundary unavailable', timeline_truncated: 'Timeline truncated', malformed_records: 'Malformed records', ignored_values: 'Ignored values', unknown_events: 'Unparsed events', unmatched_tool_calls: 'Unmatched tool calls', unmatched_tool_results: 'Unmatched tool results', missing_timestamps: 'Missing timestamps',
  };
  const connectionLabels:Record<string,string>={connecting:'正在连接',live:'实时更新中',reconnecting:'正在重连',failed:'更新失败'};
  return <div className="observe-trajectory" data-live-revision={page.revision}>
    <header className="observe-detail-header">
      <Breadcrumb items={[{title:<Link href={`/observe${langSuffix(lang)}`}>{zh?'会话列表':'Conversations'}</Link>},{title:<Link href={conversationHref(page.threadId,lang)}>{zh?'会话详情':'Conversation details'}</Link>},{title:zh?'任务轨迹':'Task trajectory'}]}/>
    <div className="observe-detail-title trajectory-heading">
      <Popover trigger="click" content={<div className="trajectory-goal-detail">{model.summary.userGoal??(zh?'未记录用户请求':'No user request recorded')}</div>}>
        <h1 className="trajectory-goal"><button type="button" aria-label={zh?'查看完整任务请求':'View full task request'}>{model.summary.userGoal??(zh?'任务轨迹':'Task trajectory')}</button></h1>
      </Popover>
      <Space className="trajectory-controls" size="small" wrap><ExtractedKnowledge threadId={page.threadId} turnId={page.turnId} lang={lang}/><Status status={page.status} lang={lang}/>{page.live&&<><Tag role="status">{zh?connectionLabels[connection]:connection}</Tag><Button size="small" onClick={()=>setFollow(!follow)}>{follow?(zh?'暂停跟随':'Pause following'):(zh?'跟随最新':'Follow latest')}</Button>{connection==='failed'&&<Button size="small" onClick={()=>{setConnection('connecting');setRetry(value=>value+1);}}>{zh?'重试连接':'Retry connection'}</Button>}</>}</Space>
    </div>
    <div className="observe-detail-meta"><span>{displayTime(model.summary.observedStartTimestamp)}</span><span>{model.summary.observedModels.join(', ')}</span><span>{model.summary.toolCallCount} {zh?'次工具调用':'tool calls'}</span><span className={model.summary.toolFailureCount>0?'observe-failure':undefined}>{model.summary.toolFailureCount} {zh?'次工具失败':'tool failures'}</span>
      {model.integrity.status==='partial'&&<Popover trigger="click" placement="bottomRight" open={integrityOpen} onOpenChange={setIntegrityOpen} styles={{container:{padding:16},title:{marginBottom:8,fontSize:14,lineHeight:'20px'},content:{fontSize:13,lineHeight:'20px'}}} title={onlyUnknown?(zh?'部分事件未解析':'Some events are unparsed'):(zh?'轨迹展示受限':'Trajectory limitations')} content={<div className="observe-integrity-detail">
        {onlyUnknown?<p>{zh?`${unknownCount} 条原始事件未能归入当前轨迹视图，可能影响展示完整性。这不等于原始记录丢失。`:`${unknownCount} raw events could not be mapped into this view, which may affect its completeness. This does not mean the raw records are missing.`}</p>:<><p>{zh?'以下问题可能影响轨迹展示，请核对原始记录。':'These issues may affect the trajectory view. Check the source records.'}</p><ul>{model.integrity.notices.map(notice=><li key={notice.code}>{noticeLabels[notice.code]??notice.code}：{notice.count}</li>)}</ul></>}
        <Button type="link" size="small" onClick={()=>{setActiveTab('source');setIntegrityOpen(false);}}>{zh?'查看原始记录':'View source records'}</Button>
      </div>}><button type="button" className="observe-evidence-status" aria-expanded={integrityOpen}>{onlyUnknown?(zh?`部分事件未解析 · ${unknownCount}`:`Unparsed events · ${unknownCount}`):(zh?'轨迹展示受限 · 查看原因':'Trajectory limitations · Details')}</button></Popover>}
    </div>
    </header>
    <Tabs className="trajectory-tabs" activeKey={activeTab} onChange={setActiveTab} destroyOnHidden items={[
      {key:'replay',label:zh?'语义轨迹':'Semantic trajectory',children:<Swimlane projection={page.replay} lang={lang} revision={page.revision} follow={follow} onPause={()=>setFollow(false)}/>},
      {key:'knowledge',label:zh?'知识访问':'Knowledge access',children:<><Alert type="info" title={zh?'访问记录说明知识曾被读取或注入，不代表它导致了结果。':'Access records show reads or injections; they do not establish causation.'}/><Table rowKey="id" size="small" tableLayout="auto" dataSource={model.knowledgeEvidence} scroll={{x:'max-content'}} columns={[{title:zh?'知识':'Knowledge',dataIndex:'label',width:220},{title:zh?'方式':'Access',dataIndex:'accessKind',width:140},{title:zh?'次数':'Count',dataIndex:'accessCount',width:80,align:'right'},{title:zh?'来源':'Source',dataIndex:'sourceLocator'}]} expandable={{expandedRowRender:item=><Evidence value={item}/>}}/></>},
      {key:'events',label:zh?'标准化事件':'Normalized events',children:<EventRecords events={model.normalizedEvents} lang={lang}/>},
      {key:'source',label:zh?'原始记录':'Source records',children:<SourceRecords key={page.revision} endpoint={`${api}/source-records`} lang={lang}/>},
    ]}/>
  </div>;
}
