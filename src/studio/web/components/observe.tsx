'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Button, Empty, Input, Segmented, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { ObservePage } from '../../http/observe-page';
import type { ConversationListItem } from '../../../observability/view-models/conversation';
import { Swimlane } from './swimlane';
import type { Language } from './shell';

const suffix = (lang: Language) => lang === 'en' ? '?lang=en' : '';
const conversationHref = (id: string, lang: Language) => `/observe/conversations/${encodeURIComponent(id)}${suffix(lang)}`;
const taskPath = (threadId: string, turnId: string) => `/observe/conversations/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(turnId)}`;
const statuses: Record<string, string> = { open: '进行中', completed: '已完成', failed: '失败', aborted: '已中止', interrupted: '已中断', unknown: '未知', success: '成功', failure: '失败', cancelled: '已取消' };
function Status({status, lang}: {status: string; lang: Language}) {
  return <Tag color={status === 'open' ? 'processing' : status === 'failed' ? 'error' : undefined}>{lang === 'zh' ? statuses[status] ?? status : status}</Tag>;
}
function Evidence({value}: {value: unknown}) { return <pre className="observe-evidence">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>; }

/** Refresh only when the domain activity revision changes; cancel polling on navigation. */
function useActivity(endpoint: string, revision: string) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const timer = setInterval(async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const response = await fetch(endpoint, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('activity unavailable');
        const activity = await response.json() as {revision: string};
        if (!controller.signal.aborted) {
          setFailed(false);
          if (activity.revision !== revision) router.refresh();
        }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { pending = false; }
    }, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [endpoint, revision, router]);
  return failed;
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
  const failed = useActivity('/api/conversations/activity', page.revision);
  const running = (item: ConversationListItem) => item.tasks.some(task => task.status === 'open');
  const rows = page.model.conversations.filter(item => {
    const selected = filter === 'all' || (filter === 'running' ? running(item) : filter === 'archived' ? item.archived : !item.archived);
    return selected && `${item.title} ${item.preview ?? ''} ${item.cwd ?? ''}`.toLowerCase().includes(query.toLowerCase());
  }).sort((a,b) => Number(running(b)) - Number(running(a)));
  return <>
    {failed && <Alert type="warning" title={zh ? '暂时无法更新会话，请刷新重试。' : 'Conversation updates are unavailable. Reload to retry.'}/>}
    <div className="observe-toolbar">
      <Segmented value={filter} onChange={setFilter} options={[{value:'all',label:zh?'全部':'All'},{value:'running',label:zh?'进行中':'Running'},{value:'active',label:zh?'未归档':'Unarchived'},{value:'archived',label:zh?'已归档':'Archived'}]}/>
      <Input allowClear aria-label={zh?'搜索会话':'Search conversations'} placeholder={zh?'搜索标题或工作目录':'Search title or workspace'} value={query} onChange={event=>setQuery(event.target.value)}/>
    </div>
    <Table className="measure-table" rowKey="threadId" dataSource={rows} scroll={{x:850}} pagination={{pageSize:20,showSizeChanger:false}} locale={{emptyText:<Empty description={zh?'没有匹配的会话。受支持的运行时产生任务轨迹后，会话会显示在这里。':'No matching conversations. Sessions appear after a supported runtime produces task traces.'}/>}} columns={[
      {title:zh?'最近活动':'Recent activity',render:(_,item)=><Space orientation="vertical">{running(item)&&<Status status="open" lang={lang}/>}<span>{item.endTimestamp ?? item.startTimestamp ?? '—'}</span><Typography.Text type="secondary">{item.model ?? item.sourceKind}</Typography.Text></Space>},
      {title:zh?'会话':'Conversation',render:(_,item)=><><Link href={conversationHref(item.threadId,lang)}>{item.title}</Link>{item.archived&&<Tag>{zh?'已归档':'Archived'}</Tag>}</>},
      {title:zh?'工作目录':'Workspace',dataIndex:'cwd',render:(value:string|undefined)=>value??'—'},
      {title:zh?'任务':'Tasks',dataIndex:'turnCount',render:(value:number|undefined)=>value??'—'},
      {title:zh?'实时轨迹':'Live trajectory',render:(_,item)=>{const task=[...item.tasks].reverse().find(task=>task.status==='open');return task?<Link href={`${taskPath(item.threadId,task.sourceTurnId??task.turnId)}${suffix(lang)}`}>{zh?'查看实时轨迹':'View live'}</Link>:'—';}},
    ]}/>
  </>;
}
function ConversationDetail({page,lang}: {page: Extract<ObservePage,{pageKind:'conversation'}>;lang:Language}) {
  const zh=lang==='zh'; const item=page.model;
  const [newest,setNewest]=useState(true);
  const failed=useActivity(`/api/conversations/${encodeURIComponent(item.threadId)}/activity`,page.revision);
  const tasks=newest?[...item.tasks].reverse():item.tasks;
  return <>
    <div className="measure-heading"><div><Link href={`/observe${suffix(lang)}`}>{zh?'返回会话':'Back to conversations'}</Link><h1>{item.title}</h1><p>{[item.model,item.cwd].filter(Boolean).join(' · ')}</p><p>{item.turnCount??item.tasks.length} {zh?'次任务':'tasks'} · {item.toolCallCount??'—'} {zh?'次工具调用':'tool calls'} · {item.toolFailureCount??'—'} {zh?'次工具失败':'tool failures'}</p></div></div>
    {failed&&<Alert type="warning" title={zh?'暂时无法更新任务列表，请刷新重试。':'Task updates are unavailable. Reload to retry.'}/>}
    <div className="observe-toolbar"><Segmented value={newest?'newest':'oldest'} onChange={value=>setNewest(value==='newest')} options={[{value:'newest',label:zh?'最新优先':'Newest first'},{value:'oldest',label:zh?'最早优先':'Oldest first'}]}/></div>
    <Table className="measure-table" rowKey="turnId" dataSource={tasks} scroll={{x:750}} locale={{emptyText:zh?'没有识别到任务边界':'No task boundaries found'}} columns={[
      {title:zh?'任务':'Task',render:(_,task)=><Link href={`${taskPath(item.threadId,task.sourceTurnId??task.turnId)}${suffix(lang)}`}>{task.title}</Link>},
      {title:zh?'状态':'Status',dataIndex:'status',render:(status:string)=><Status status={status} lang={lang}/>},
      {title:zh?'开始时间':'Started',dataIndex:'startTimestamp'},
      {title:zh?'耗时（毫秒）':'Duration (ms)',dataIndex:'durationMs',render:(value:number|undefined)=>value??'—'},
      {title:zh?'工具调用':'Tool calls',dataIndex:'toolCallCount'},
      {title:zh?'工具失败':'Tool failures',dataIndex:'toolFailureCount'},
    ]}/>
  </>;
}
function SourceRecords({endpoint,lang}: {endpoint:string;lang:Language}) {
  const [value,setValue]=useState<unknown>(); const [failed,setFailed]=useState(false);
  useEffect(()=>{const controller=new AbortController();
    fetch(endpoint,{signal:controller.signal,cache:'no-store'}).then(response=>{if(!response.ok)throw new Error('unavailable');return response.json();}).then(value=>{if(!controller.signal.aborted)setValue(value);}).catch(()=>{if(!controller.signal.aborted)setFailed(true);});
    return()=>controller.abort();
  },[endpoint]);
  if(failed)return <Alert type="error" title={lang==='zh'?'原始记录暂时无法读取，请重新打开此标签。':'Source records are unavailable. Reopen this tab to retry.'}/>;
  return value===undefined?<p role="status">{lang==='zh'?'正在读取原始记录…':'Loading source records…'}</p>:<Evidence value={value}/>;
}
function Trajectory({page,lang}: {page:Extract<ObservePage,{pageKind:'trajectory'}>;lang:Language}) {
  const zh=lang==='zh'; const router=useRouter();
  const api=`/api/conversations/${encodeURIComponent(page.threadId)}/tasks/${encodeURIComponent(page.turnId)}`;
  const [connection,setConnection]=useState('connecting'); const [retry,setRetry]=useState(0);
  const [follow,setFollow]=useState(true);
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
  const connectionLabels:Record<string,string>={connecting:'正在连接',live:'实时更新中',reconnecting:'正在重连',failed:'更新失败'};
  return <div onWheel={()=>setFollow(false)} data-live-revision={page.revision}>
    <Link href={conversationHref(page.threadId,lang)}>{zh?'返回任务列表':'Back to tasks'}</Link>
    <div className="measure-heading"><div><h1>{zh?'任务轨迹':'Task trajectory'}</h1><p>{model.summary.observedStartTimestamp??'—'} · {model.summary.observedModels.join(', ')}</p></div><Space wrap><Status status={page.status} lang={lang}/>{page.live&&<><Tag role="status">{zh?connectionLabels[connection]:connection}</Tag><Button onClick={()=>{setFollow(!follow);}}>{follow?(zh?'暂停跟随':'Pause following'):(zh?'跟随最新':'Follow latest')}</Button>{connection==='failed'&&<Button onClick={()=>{setConnection('connecting');setRetry(value=>value+1);}}>{zh?'重试连接':'Retry connection'}</Button>}</>}</Space></div>
    {model.integrity.status==='partial'&&<Alert type="warning" showIcon title={zh?'轨迹证据不完整':'Trajectory evidence is incomplete'} description={model.integrity.notices.map(notice=>`${notice.code}: ${notice.count}`).join('；')}/>}
    <div className="observe-summary"><Typography.Paragraph ellipsis={{rows:4,expandable:true,symbol:zh?'展开':'More'}}>{model.summary.userGoal??(zh?'未记录用户请求':'No user request recorded')}</Typography.Paragraph><Typography.Text type="secondary">{model.summary.toolCallCount} {zh?'次工具调用':'tool calls'} · {model.summary.toolFailureCount} {zh?'次工具失败':'tool failures'}</Typography.Text></div>
    <Tabs defaultActiveKey="replay" destroyOnHidden items={[
      {key:'replay',label:zh?'语义轨迹':'Semantic trajectory',children:<Swimlane projection={page.replay} lang={lang} revision={page.revision} follow={follow} onPause={()=>setFollow(false)}/>},
      {key:'knowledge',label:zh?'知识访问':'Knowledge access',children:<><Alert type="info" title={zh?'访问记录说明知识曾被读取或注入，不代表它导致了结果。':'Access records show reads or injections; they do not establish causation.'}/><Table rowKey="id" dataSource={model.knowledgeEvidence} scroll={{x:700}} columns={[{title:zh?'知识':'Knowledge',dataIndex:'label'},{title:zh?'方式':'Access',dataIndex:'accessKind'},{title:zh?'次数':'Count',dataIndex:'accessCount'},{title:zh?'来源':'Source',dataIndex:'sourceLocator'}]} expandable={{expandedRowRender:item=><Evidence value={item}/>}}/></>},
      {key:'events',label:zh?'标准化事件':'Normalized events',children:<Evidence value={model.normalizedEvents}/>},
      {key:'source',label:zh?'原始记录':'Source records',children:<SourceRecords key={page.revision} endpoint={`${api}/source-records`} lang={lang}/>},
    ]}/>
  </div>;
}
