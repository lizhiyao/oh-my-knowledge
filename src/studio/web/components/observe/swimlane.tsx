'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Drawer, Empty, Select, Typography } from 'antd';
import type { ReplayProjection } from '../../../view-models/replay.js';
import { createHorizontalObstacleIndex, planFlowRoute } from '../../../application/replay/routing';
import type { Language } from '../layout/shell';

type Card = ReplayProjection['cards'][number];
const lanes = ['conversation', 'action', 'result', 'knowledge'] as const;
const labels = {
  conversation: {zh:['对话','用户与 AI'],en:['Conversation','User and AI']},
  action: {zh:['执行','AI 发起的工具调用'],en:['Actions','AI-initiated tool calls']},
  result: {zh:['结果','工具返回及调用状态'],en:['Results','Tool returns and status']},
  knowledge: {zh:['知识','何时、从何处出现'],en:['Knowledge','When and where it appeared']},
};
const labelWidth = 108;
const axisHeight = 32;
function rect(card: Card, laneHeight: number) {
  const centerY = axisHeight + lanes.indexOf(card.lane)*laneHeight + (card.lane==='conversation' ? (card.row===0?laneHeight/4:laneHeight*3/4) : laneHeight/2);
  const height=card.compact?14:Math.min(64,Math.max(20,card.lane==='conversation'?laneHeight/2-8:laneHeight-16));
  const left=labelWidth+card.position-(card.compact?7:0);
  return {left,right:left+card.width,top:centerY-height/2,bottom:centerY+height/2,owner:card.id};
}
function relative(timestamp: string | undefined, start: string | undefined) {
  if (!timestamp || !start) return '—';
  const ms=Date.parse(timestamp)-Date.parse(start);
  if(!Number.isFinite(ms))return '—';
  const seconds=Math.max(0,ms)/1000;
  return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toFixed(1).padStart(4,'0')}`;
}
/** Reuse the existing semantic projection and obstacle-aware routing, not a new event interpretation. */
function connections(projection: ReplayProjection, laneHeight: number) {
  const obstacles=createHorizontalObstacleIndex(projection.cards.map(card=>rect(card,laneHeight)));
  const result:{id:string;d:string;linkKind:string;operations:string[]}[]=[];
  const entries=projection.operations.map(operation=>{
    const cards=projection.cards.filter(card=>card.operationId===operation.id);
    const action=cards.find(card=>card.lane==='action');
    const returned=cards.find(card=>card.lane==='result');
    const conversation=cards.find(card=>card.lane==='conversation');
    return {id:operation.id,action,returned,knowledge:cards.filter(card=>card.lane==='knowledge'),start:action??conversation??returned,end:returned??conversation??action};
  });
  function connect(from:Card|undefined,to:Card|undefined,linkKind:string,operations:string[]) {
    if(!from||!to)return;
    const route=planFlowRoute({fromRect:rect(from,laneHeight),toRect:rect(to,laneHeight),fromLane:from.lane,toLane:to.lane,obstacleIndex:obstacles,fromOwner:from.id,toOwner:to.id});
    if(route)result.push({id:`${from.id}:${to.id}`,d:route.d,linkKind,operations});
  }
  let previous:typeof entries[number]|undefined;
  for(const [index,entry] of entries.entries()){
    connect(entry.action,entry.returned,'call-result',[entry.id]);
    for(const knowledge of entry.knowledge){
      const source=entry.returned??entry.action??previous?.end??entries.slice(index+1).find(item=>item.start)?.start;
      connect(source,knowledge,'knowledge',[entry.id,...(source?[source.operationId]:[])]);
    }
    if(entry.start&&entry.end){connect(previous?.end,entry.start,'flow',[...(previous?[previous.id]:[]),entry.id]);previous=entry;}
  }
  return result;
}
export function Swimlane({projection,lang,revision,follow,onPause}: {projection:ReplayProjection;lang:Language;revision:string;follow:boolean;onPause:()=>void}) {
  const zh=lang==='zh'; const scroll=useRef<HTMLDivElement>(null);
  const [selected,setSelected]=useState<string>(); const [facet,setFacet]=useState<string>();
  const arrowId=useId().replaceAll(':','');
  const [height,setHeight]=useState(672);
  const laneHeight=Math.max(1,(height-axisHeight)/lanes.length);
  const links=useMemo(()=>connections(projection,laneHeight),[projection,laneHeight]);
  const operation=projection.operations.find(item=>item.id===selected);
  const width=projection.detailWidth;
  useEffect(()=>{
    const element=scroll.current;
    if(!element)return;
    const resize=()=>setHeight(element.clientHeight);
    const observer=new ResizeObserver(resize);
    observer.observe(element); resize();
    return()=>observer.disconnect();
  },[projection.cards.length===0]);
  useEffect(()=>{if(follow&&scroll.current)scroll.current.scrollLeft=scroll.current.scrollWidth;},[revision,follow]);
  const highlighted=(card:Card)=>selected?card.operationId===selected:facet?card.facetIds.includes(facet):true;
  return <>
    <div className="swimlane-toolbar"><Typography.Text type="secondary">{relative(projection.startTimestamp,projection.startTimestamp)} — {relative(projection.endTimestamp,projection.startTimestamp)}</Typography.Text><Select allowClear value={facet} onChange={value=>{setFacet(value);setSelected(undefined);}} aria-label={zh?'聚焦轨迹':'Focus trajectory'} placeholder={zh?'聚焦知识、工具或状态':'Focus knowledge, tool or status'} options={projection.facets.map(item=>({value:item.id,label:item.label}))}/></div>
    {projection.cards.length===0?<Empty description={zh?'没有可呈现的语义轨迹':'No semantic trajectory available'}/>:<div className="swimlane-scroll" ref={scroll} tabIndex={0} role="region" aria-label={zh?'任务轨迹泳道图':'Task trajectory swimlane'} onWheel={onPause} onTouchStart={onPause} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key))onPause();}}>
      <div className="swimlane-canvas" style={{width:`max(100%, ${width}px)`,height}}>
        <div className="swimlane-axis" style={{height:axisHeight}}><span className="swimlane-axis-label">{zh?'时间':'Time'}</span>{projection.axisTicks.map((tick,index)=><span className="swimlane-tick" key={index} style={{left:labelWidth+tick.position}}>{tick.label}</span>)}</div>
        {projection.gaps.map((gap,index)=><div key={`gap-${index}`} className="swimlane-gap" style={{left:labelWidth+gap.position,width:gap.width,top:axisHeight,height:height-axisHeight}}/>)}
        {projection.axisTicks.map((tick,index)=><div key={`guide-${index}`} className="swimlane-guide" style={{left:labelWidth+tick.position,top:axisHeight,height:height-axisHeight}}/>)}
        {projection.milestones.map((milestone,index)=><div className={`swimlane-milestone is-${milestone.tone}`} key={`milestone-${index}`} style={{left:labelWidth+milestone.position,height}}><span>{milestone.label}</span></div>)}
        {lanes.map((lane,index)=><section key={lane} data-lane={lane} className="swimlane-lane" aria-label={labels[lane][lang][0]} style={{top:axisHeight+index*laneHeight,height:laneHeight}}><div className="swimlane-label"><strong>{labels[lane][lang][0]}</strong><span>{labels[lane][lang][1]}</span></div>{!projection.cards.some(card=>card.lane===lane)&&<span className="swimlane-empty">{zh?'未观测到记录':'No records observed'}</span>}</section>)}
        <svg className="swimlane-links" width="100%" height={height} aria-hidden="true"><defs><marker id={arrowId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7 Z" fill="#8a96a8"/></marker></defs>{links.map(link=><path key={link.id} d={link.d} data-connection={link.linkKind} className={`swimlane-link is-${link.linkKind}${selected&&link.operations.includes(selected)?' is-active':''}`} markerEnd={link.linkKind==='knowledge'?undefined:`url(#${arrowId})`}/>)}</svg>
        {projection.cards.map(card=>{const box=rect(card,laneHeight);return <button key={card.id} type="button" data-operation={card.operationId} data-density={box.bottom-box.top<42?'tiny':box.bottom-box.top<56?'short':'normal'} className={`swimlane-card is-${card.tone}${card.compact?' is-compact':''}${highlighted(card)?'':' is-dimmed'}${selected===card.operationId?' is-selected':''}`} style={{left:box.left,top:box.top,width:card.width,height:box.bottom-box.top}} aria-label={[relative(card.timestamp,projection.startTimestamp),card.kindLabel,card.title].join(' · ')} aria-pressed={selected===card.operationId} title={card.title} onClick={()=>{onPause();setSelected(card.operationId);}}>{!card.compact&&<><span className="swimlane-card-meta"><time>{relative(card.timestamp,projection.startTimestamp)}</time> {card.kindLabel} {card.model}</span><strong>{card.title}</strong><span className="swimlane-card-detail">{card.detail}</span></>}</button>;})}
      </div>
    </div>}
    <Drawer open={Boolean(operation)} onClose={()=>setSelected(undefined)} title={operation?.title} size={460} mask={false}>
      {operation&&<><Typography.Paragraph>{operation.summary}</Typography.Paragraph>{operation.fields.map((field,index)=><section key={index} className="swimlane-detail-field"><Typography.Title level={5}>{field.label}</Typography.Title><Typography.Paragraph>{field.value}</Typography.Paragraph><Typography.Paragraph copyable={{text:field.detail}}><pre className="observe-evidence">{field.detail}</pre></Typography.Paragraph></section>)}<Typography.Title level={5}>{zh?'完整关联事件':'Full related events'}</Typography.Title>{operation.events.map(event=><section key={event.id}><Typography.Text type="secondary">{event.kind} · {event.id}</Typography.Text><pre className="observe-evidence">{event.fullText??event.snippet??JSON.stringify(event,null,2)}</pre></section>)}</>}
    </Drawer>
  </>;
}
