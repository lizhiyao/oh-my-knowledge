'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Breadcrumb, Button, Empty, Input, Popover, Segmented, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { ObservePage } from '../../http/observe-page';
import type { ConversationListItem } from '../../../observability/view-models/conversation';
import { EventRecords, RawRecords } from './records';
import type { ObservationSourceRecordArchiveView } from '../../../observability/contracts/inbox';
import { Swimlane } from './swimlane';
import type { Language } from './shell';

const displayTime = (value: string | undefined) => value?.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC') ?? '—';
const suffix = (lang: Language) => lang === 'en' ? '?lang=en' : '';
const conversationHref = (id: string, lang: Language) => `/observe/conversations/${encodeURIComponent(id)}${suffix(lang)}`;
const taskPath = (threadId: string, turnId: string) => `/observe/conversations/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(turnId)}`;
const statuses: Record<string, string> = { open: '进行中', completed: '已完成', failed: '失败', aborted: '已中止', interrupted: '已中断', unknown: '未知', success: '成功', failure: '失败', cancelled: '已取消' };
function Status({status, lang}: {status: string; lang: Language}) {
  return <Tag className={status === 'open' ? 'studio-running-status' : undefined} color={status === 'open' ? 'processing' : status === 'failed' ? 'error' : undefined}>{status === 'open' && <span className="studio-running-dot" aria-hidden="true"/>}{lang === 'zh' ? statuses[status] ?? status : status}</Tag>;
}
function Evidence({value}: {value: unknown}) { return <pre className="observe-evidence">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>; }

/** Refresh only when the domain activity revision changes; cancel polling on navigation. */
function useActivity(endpoint: string, revision: string) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const check = async () => {
      if (pending || document.hidden) return;
      pending = true;
      setChecking(true);
      try {
        const response = await fetch(endpoint, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('activity unavailable');
        const activity = await response.json() as {revision: string};
        if (!controller.signal.aborted) {
          setFailed(false);
          if (activity.revision !== revision) router.refresh();
        }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { pending = false; if (!controller.signal.aborted) setChecking(false); }
    };
    if (attempt > 0) void check();
    const timer = setInterval(check, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [endpoint, revision, router, attempt]);
  return { failed, checking, retry: () => setAttempt(value => value + 1) };
}

function ActivityNotice({activity, lang}: {activity: ReturnType<typeof useActivity>; lang: Language}) {
  if (!activity.failed) return null;
  return <div className="observe-update-notice"><span role="status" title={lang === 'zh' ? '暂时无法获取新内容，当前列表仍可查看；系统会自动重试。' : 'Updates are unavailable. Existing records remain available; automatic retries continue.'}><span aria-hidden="true">⚠</span> {lang === 'zh' ? '更新暂不可用' : 'Updates unavailable'}</span><Button type="link" size="small" loading={activity.checking} onClick={activity.retry}>{lang === 'zh' ? '重试' : 'Retry'}</Button></div>;
}

export function ObserveView({page, lang}: {page: ObservePage; lang: Language}) {
  if (page.pageKind === 'index') return <ConversationList page={page} lang={lang}/>;
  if (page.pageKind === 'conversation') return <ConversationDetail page={page} lang={lang}/>;
  return <Trajectory page={page} lang={lang}/>;
}
function ConversationList({page, lang}: {page: Extract<ObservePage, {pageKind:'index'}>; lang: Language}) {
  const zh = lang === 'zh';
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const activity = useActivity('/api/conversations/activity', page.revision);
  const running = (item: ConversationListItem) => item.tasks.some(task => task.status === 'open');
  const rows = page.model.conversations.filter(item => {
    const selected = filter === 'all' || (filter === 'running' ? running(item) : filter === 'archived' ? item.archived : !item.archived);
    return selected && `${item.title} ${item.preview ?? ''} ${item.cwd ?? ''}`.toLowerCase().includes(query.toLowerCase());
  }).sort((a,b) => Number(running(b)) - Number(running(a)));
  return <>
    <div className="observe-toolbar">
      <Segmented value={filter} onChange={setFilter} options={[{value:'all',label:zh?'全部':'All'},{value:'running',label:zh?'进行中':'Running'},{value:'active',label:zh?'未归档':'Unarchived'},{value:'archived',label:zh?'已归档':'Archived'}]}/>
      <div className="observe-toolbar-actions"><ActivityNotice activity={activity} lang={lang}/><Input allowClear aria-label={zh?'搜索会话':'Search conversations'} placeholder={zh?'搜索标题或工作目录':'Search title or workspace'} value={query} onChange={event=>setQuery(event.target.value)}/></div>
    </div>
    <Table className="measure-table conversation-table" tableLayout="fixed" size="small" rowKey="threadId" rowClassName={item => running(item) ? 'studio-running-row' : ''} dataSource={rows} scroll={{x:900}} pagination={{pageSize:20,showSizeChanger:false}} locale={{emptyText:<Empty description={zh?'没有匹配的会话。受支持的运行时产生任务轨迹后，会话会显示在这里。':'No matching conversations. Sessions appear after a supported runtime produces task traces.'}/>}} columns={[
      {title:zh?'最近活动':'Recent activity',width:200,render:(_,item)=><div className="conversation-activity"><div className="conversation-activity-time"><time className="conversation-time" title={item.endTimestamp??item.startTimestamp}>{(item.endTimestamp??item.startTimestamp)?.replace('T',' ').replace(/\.\d{3}Z$/,' UTC')??'—'}</time></div><div className="conversation-activity-meta"><Typography.Text type="secondary" title={item.model ?? item.sourceKind}>{item.model ?? item.sourceKind}</Typography.Text>{running(item)&&<span className="conversation-running"><span className="studio-running-dot" aria-hidden="true"/>{zh?'进行中':'Running'}</span>}</div></div>},
      {title:zh?'会话':'Conversation',ellipsis:true,render:(_,item)=><><Link title={item.title} href={conversationHref(item.threadId,lang)}>{item.title}</Link>{item.archived&&<Tag>{zh?'已归档':'Archived'}</Tag>}</>},
      {title:zh?'工作目录':'Workspace',width:'28%',ellipsis:true,dataIndex:'cwd',render:(value:string|undefined)=><span title={value}>{value??'—'}</span>},
      {title:zh?'任务':'Tasks',width:72,align:'right',dataIndex:'turnCount',render:(value:number|undefined)=>value??'—'},
      {title:zh?'任务轨迹':'Task trajectory',width:132,className:'conversation-action',render:(_,item)=>{
        const liveTask=[...item.tasks].reverse().find(task=>task.status==='open');
        const task=liveTask??item.tasks.at(-1);
        if(!task)return <Typography.Text type="secondary">{zh?'暂无轨迹':'No trajectory'}</Typography.Text>;
        return <Link href={`${taskPath(item.threadId,task.sourceTurnId??task.turnId)}${suffix(lang)}`}>{liveTask?(zh?'查看实时轨迹':'View live'):(zh?'查看最近轨迹':'View latest')}</Link>;
      }},
    ]}/>
  </>;
}
function ConversationDetail({page,lang}: {page: Extract<ObservePage,{pageKind:'conversation'}>;lang:Language}) {
  const zh=lang==='zh'; const item=page.model;
  const [newest,setNewest]=useState(true);
  const activity=useActivity(`/api/conversations/${encodeURIComponent(item.threadId)}/activity`,page.revision);
  const tasks=newest?[...item.tasks].reverse():item.tasks;
  return <>
    <header className="observe-detail-header">
      <Breadcrumb items={[{title:<Link href={`/observe${suffix(lang)}`}>{zh?'会话列表':'Conversations'}</Link>},{title:zh?'会话详情':'Conversation details'}]}/>
      <div className="observe-detail-title"><h1 title={item.title}>{item.title}</h1><span className="observe-detail-count">{item.turnCount??item.tasks.length} {zh?'个任务':'tasks'}</span></div>
      <div className="observe-detail-meta"><span>{item.model??item.sourceKind}</span><span className="observe-workspace" title={item.cwd}>{item.cwd??'—'}</span><span>{item.toolCallCount??'—'} {zh?'次工具调用':'tool calls'}</span><span className={(item.toolFailureCount??0)>0?'observe-failure':undefined}>{item.toolFailureCount??'—'} {zh?'次工具失败':'tool failures'}</span></div>
    </header>
    <div className="observe-toolbar"><Segmented value={newest?'newest':'oldest'} onChange={value=>setNewest(value==='newest')} options={[{value:'newest',label:zh?'最新优先':'Newest first'},{value:'oldest',label:zh?'最早优先':'Oldest first'}]}/><ActivityNotice activity={activity} lang={lang}/></div>
    <Table className="measure-table" tableLayout="fixed" size="middle" rowKey="turnId" rowClassName={task => task.status === 'open' ? 'studio-running-row' : ''} dataSource={tasks} scroll={{x:750}} locale={{emptyText:zh?'没有识别到任务边界':'No task boundaries found'}} columns={[
      {title:zh?'任务':'Task',ellipsis:true,render:(_,task)=><Link href={`${taskPath(item.threadId,task.sourceTurnId??task.turnId)}${suffix(lang)}`}>{task.title}</Link>},
      {title:zh?'状态':'Status',width:100,dataIndex:'status',render:(status:string)=><Status status={status} lang={lang}/>},
      {title:zh?'开始时间':'Started',width:210,ellipsis:true,dataIndex:'startTimestamp'},
      {title:zh?'耗时（毫秒）':'Duration (ms)',width:120,dataIndex:'durationMs',render:(value:number|undefined)=>value??'—'},
      {title:zh?'工具调用':'Tool calls',width:100,dataIndex:'toolCallCount'},
      {title:zh?'工具失败':'Tool failures',width:100,dataIndex:'toolFailureCount'},
    ]}/>
  </>;
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
      <Breadcrumb items={[{title:<Link href={`/observe${suffix(lang)}`}>{zh?'会话列表':'Conversations'}</Link>},{title:<Link href={conversationHref(page.threadId,lang)}>{zh?'本会话':'This conversation'}</Link>},{title:zh?'任务轨迹':'Task trajectory'}]}/>
    <div className="observe-detail-title trajectory-heading">
      <Popover trigger="click" content={<div className="trajectory-goal-detail">{model.summary.userGoal??(zh?'未记录用户请求':'No user request recorded')}</div>}>
        <h1 className="trajectory-goal"><button type="button" aria-label={zh?'查看完整任务请求':'View full task request'}>{model.summary.userGoal??(zh?'任务轨迹':'Task trajectory')}</button></h1>
      </Popover>
      <Space className="trajectory-controls" size="small"><Status status={page.status} lang={lang}/>{page.live&&<><Tag role="status">{zh?connectionLabels[connection]:connection}</Tag><Button size="small" onClick={()=>setFollow(!follow)}>{follow?(zh?'暂停跟随':'Pause following'):(zh?'跟随最新':'Follow latest')}</Button>{connection==='failed'&&<Button size="small" onClick={()=>{setConnection('connecting');setRetry(value=>value+1);}}>{zh?'重试连接':'Retry connection'}</Button>}</>}</Space>
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
