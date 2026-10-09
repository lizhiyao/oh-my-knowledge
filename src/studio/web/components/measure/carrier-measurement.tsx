'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Modal, Select, Space, Table, Tabs, Tag } from 'antd';
import type { Language } from '../layout/shell';
import type { CarrierDetail, CarrierRow } from '../../../view-models/knowledge/artifact-authoring';
import type { CarrierControl, CarrierMeasurementInput, CarrierMeasurementPlan, CarrierMeasurementRecord } from '../../../view-models/measure/carrier-measurement';
import { requestArtifact } from '../knowledge/artifact-authoring';
import { workspaceHref } from '../layout/workspace-link';
import { runReportHref } from '../run-report-link';

async function action<T>(operation:string, fields:Record<string,unknown>, signal?:AbortSignal):Promise<T> {
  const response=await fetch('/api/knowledge/measurements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation,...fields}),signal});
  const result=await response.json();if(!response.ok)throw new Error(result.error??'measurement_request_failed');return result as T;
}
function statusLabel(status:CarrierMeasurementRecord['status'],zh:boolean) {
  const labels={prepared:['待确认','Awaiting confirmation'],running:['运行中','Running'],finished:['运行结束','Finished'],failed:['运行失败','Failed'],cancelled:['已取消','Cancelled'],interrupted:['已中断','Interrupted']};return labels[status][zh?0:1];
}
export function CarrierMeasurementHistory({workspace,detail,lang}:{workspace:string;detail:CarrierDetail;lang:Language}) {
  const zh=lang==='zh';const [rows,setRows]=useState<CarrierMeasurementRecord[]>([]);const [error,setError]=useState(false);const [working,setWorking]=useState('');
  useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout> | undefined;
    const load=async()=>{try{const next=await action<CarrierMeasurementRecord[]>('list',{workspace,artifactId:detail.artifactId,version:detail.version},controller.signal);if(controller.signal.aborted)return;setRows(next);setError(false);if(next.some(row=>row.status==='running'))timer=setTimeout(()=>void load(),2000);}catch{if(!controller.signal.aborted)setError(true);}};
    void load();return ()=>{controller.abort();if(timer)clearTimeout(timer);};
  },[workspace,detail.artifactId,detail.version,working]);
  async function cancel(id:string){setWorking(id);try{await action('cancel',{workspace,id});}catch{setError(true);}finally{setWorking('');}}
  return <div className="carrier-measurement-history">{error && <Alert type="error" title={zh?'未能读取评测记录，请重新打开此版本。':'Could not read evaluation attempts. Reopen this version.'}/>}
    <Table<CarrierMeasurementRecord> className="studio-table" rowKey="measurementId" dataSource={rows} size="small" scroll={{x:760}} tableLayout="fixed" pagination={{pageSize:10,hideOnSinglePage:true,showSizeChanger:false}} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={zh?'此版本尚无评测记录。点击“验证这个版本”开始。':'No evaluation attempts for this version. Select “Evaluate this version”.'}/>}} columns={[
      {title:zh?'比较基线':'Control',ellipsis:true,render:(_,row)=><span title={row.plan.control.path}>{row.plan.control.label}</span>},
      {title:zh?'模型':'Model',ellipsis:true,render:(_,row)=><span title={row.plan.model}>{row.plan.model}</span>},
      {title:zh?'运行状态':'Run status',width:120,render:(_,row)=><Tag>{statusLabel(row.status,zh)}</Tag>},
      {title:zh?'结果与证据':'Results and evidence',width:250,render:(_,row)=>row.outcome?<Link href={workspaceHref(runReportHref(row.outcome.runId),workspace)}>{zh?'查看结果与证据':'View results and evidence'} · {row.outcome.status.evidenceStatus}</Link>:row.status==='running'?<Button size="small" loading={working===row.measurementId} onClick={()=>void cancel(row.measurementId)}>{zh?'取消运行':'Cancel run'}</Button>:row.errorCode==='measurement_conflict'?(zh?'输入已变化，请重新预览。':'Inputs changed. Preview again.'):row.errorCode==='measurement_persistence_failed'?(zh?'记录保存失败，请查看评测页面核对已有证据。':'Could not save the attempt. Check existing evidence on the Measure page.'):row.errorCode==='measurement_request_failed'?(zh?'运行失败，请检查执行器和用例后重新预览。':'Run failed. Check the executor and samples, then preview again.'):'—'},
    ]}/><p>{zh?'运行结束不等于效果已验证。结论及证据完整性以评测报告为准。':'A finished run does not establish effectiveness. Review the conclusion and evidence in the report.'}</p>
  </div>;
}
export function CarrierMeasurementConfirmation({plan,lang}:{plan:CarrierMeasurementPlan;lang:Language}) {
  const zh=lang==='zh';return <div className="carrier-measurement-confirmation"><p><strong>{plan.control.label} → {plan.treatment.name} · v{plan.treatment.version}</strong></p>
    <p>{zh?'固定执行模型':'Fixed task model'}：{plan.executor} / {plan.model}；{zh?'评分模型':'Scoring models'}：{plan.scoringModels.join('；')||(zh?'仅确定性评分':'Deterministic scoring only')}</p>
    <p>{plan.samples.length} {zh?'个相同用例':'identical samples'} × {plan.trials} {zh?'次试验':'trials'} × 2 {zh?'个版本':'versions'} = {plan.executionCoordinates} {zh?'个计划执行任务':'planned execution coordinates'}；{plan.evaluatorCount} {zh?'个评分器':'evaluators'}。</p>
    <Alert type="info" title={zh?'确认后才调用模型。费用无法提前准确估算，预检及模型评分可能产生额外调用。无自动重试，可取消运行；已发生的调用仍可能计费。':'Models are called only after confirmation. Cost cannot be estimated precisely; preflight and model grading may add calls. No automatic retries. Cancelling may still incur charges for calls already made.'}/>
    <Tabs className="carrier-review-tabs" items={[
      {key:'samples',label:zh?'用例与评分依据':'Samples and scoring',children:<div className="carrier-measurement-samples"><p className="carrier-path">{plan.samplesPath}</p>{plan.samples.map(sample=><section key={sample.sampleId}><h3>{sample.sampleId}</h3><p>{zh?'来源':'Provenance'}：{sample.provenance}</p><pre>{sample.input}</pre><pre>{sample.criteria}</pre></section>)}<p>{zh?'生成用例需要复核，不能自动作为独立发布验证证据。':'Generated samples require review and are not automatically independent release evidence.'}</p></div>},
      {key:'control',label:zh?'原版本':'Control',children:<pre className="carrier-original">{plan.control.content}</pre>},
      {key:'treatment',label:zh?'待测版本':'Treatment',children:<pre className="carrier-original">{plan.treatment.content}</pre>},
    ]}/>
  </div>;
}
export function CarrierMeasurementDialog({workspace,detail,lang,onClose,onStarted}:{workspace:string;detail:CarrierDetail;lang:Language;onClose():void;onStarted(record:CarrierMeasurementRecord):void}) {
  const zh=lang==='zh';const [carriers,setCarriers]=useState<CarrierRow[]>([]);
  const initial=detail.version>1?`version:${detail.artifactId}:${detail.version-1}`:detail.baseline?'local':'';
  const [control,setControl]=useState(initial);const [path,setPath]=useState(detail.baseline?.locator??'');const [samples,setSamples]=useState('');const [executor,setExecutor]=useState<'codex'|'claude'|'openai-api'|'anthropic-api'>('codex');const [model,setModel]=useState('');const [judge,setJudge]=useState(true);const [judgeModel,setJudgeModel]=useState('');
  const [plan,setPlan]=useState<CarrierMeasurementPlan>();const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [uncertain,setUncertain]=useState(false);
  useEffect(()=>{const controller=new AbortController();void requestArtifact<CarrierRow[]>(workspace,'list',{},controller.signal).then(setCarriers).catch(()=>{if(!controller.signal.aborted)setError(zh?'未能读取比较版本，请关闭后重试。':'Could not read control versions. Reopen this dialog.');});return()=>controller.abort();},[workspace]);
  const options=[...detail.versions.filter(version=>version.version!==detail.version).map(version=>({value:`version:${detail.artifactId}:${version.version}`,label:`${detail.name} · v${version.version}`})),...carriers.filter(row=>row.artifactId!==detail.artifactId && row.artifactKind===detail.artifactKind && !row.drifted).map(row=>({value:`version:${row.artifactId}:${row.version}`,label:`${row.name} · v${row.version}`})),{value:'local',label:zh?'选择本地载体':'Choose local artifact'}];
  function fail(cause:unknown){const code=cause instanceof Error?cause.message:'';return code==='measurement_identical'?(zh?'两个版本内容相同，请选择有变化的比较基线。':'The two versions are identical. Choose a different control.'):code==='measurement_conflict'?(zh?'输入已变化或预览已过期，请重新预览。':'Inputs changed or the preview expired. Preview again.'):code==='measurement_samples_unsupported'?(zh?'请选择 1–100 个本地用例，当前入口不支持需要远程内容解析的用例。':'Select 1–100 local samples. Remote content resolution is not supported in this entry.'):(zh?'未能完成操作。请检查本地路径、当前执行器安装／认证、模型及用例格式，再重新预览。':'Could not complete the operation. Check local paths, executor installation/authentication, model and sample format, then preview again.');}
  async function preview(){setBusy(true);setError('');try{const parts=control.split(':');const baseline:CarrierControl=control==='local'?{sourceKind:'local',path}:{sourceKind:'version',artifactId:parts[1],version:Number(parts[2])};const input:CarrierMeasurementInput={workspace,artifactId:detail.artifactId,version:detail.version,control:baseline,samples,executor,model,judge,judgeModel:judgeModel||model};setPlan(await action<CarrierMeasurementPlan>('preview',{input}));}catch(cause){setError(fail(cause));}finally{setBusy(false);}}
  async function start(){if(!plan || uncertain)return;setBusy(true);setError('');try{onStarted(await action<CarrierMeasurementRecord>('start',{workspace,id:plan.measurementId}));onClose();}catch(cause){if(cause instanceof Error && ['measurement_conflict','measurement_capacity'].includes(cause.message))setError(fail(cause));else{setUncertain(true);setError(zh?'启动结果未能读取，请先核对运行状态，避免重复调用。':'Start response could not be read. Check run status before another attempt.');}}finally{setBusy(false);}}
  async function check(){if(!plan)return;setBusy(true);try{const record=await action<CarrierMeasurementRecord>('status',{workspace,id:plan.measurementId});if(record.status==='prepared'){setUncertain(false);setError(zh?'尚未启动，可再次确认。':'Not started. You can confirm again.');}else{onStarted(record);onClose();}}catch(cause){setError(fail(cause));}finally{setBusy(false);}}
  async function back(){if(plan){try{await action('cancel',{workspace,id:plan.measurementId});}catch{setError(zh?'未能关闭此预览，请重试。':'Could not close this preview. Retry.');return;}}setPlan(undefined);setError('');}
  return <Modal open width={900} className="carrier-authoring-modal" title={zh?'验证这个版本':'Evaluate this version'} closable={!busy} maskClosable={false} keyboard={!busy} onCancel={()=>{if(!busy)onClose();}} footer={<Space wrap>{plan&&!uncertain&&<Button disabled={busy} onClick={()=>void back()}>{zh?'调整配置':'Adjust configuration'}</Button>}<Button disabled={busy} onClick={onClose}>{zh?'关闭':'Close'}</Button><Button type="primary" loading={busy} disabled={!plan&&(!control||control==='local'&&!path.trim()||!samples.trim()||!model.trim())} onClick={()=>void(uncertain?check():plan?start():preview())}>{uncertain?(zh?'核对运行状态':'Check run status'):plan?(zh?'确认并开始评测':'Confirm and evaluate'):(zh?'预览评测计划':'Preview evaluation plan')}</Button></Space>}>
    {error&&<Alert type="error" showIcon title={error}/>}{plan?<CarrierMeasurementConfirmation plan={plan} lang={lang}/>:<div className="carrier-selection"><p>{zh?'比较两个版本时使用相同模型、用例和运行条件。预览不调用模型。':'Compare both versions with the same model, samples and runtime conditions. Preview does not call models.'}</p>
      <label>{zh?'比较基线':'Control version'}<Select aria-label={zh?'比较基线':'Control version'} value={control||undefined} options={options} onChange={setControl}/></label>
      {control==='local'&&<label>{zh?'基线路径':'Control path'}<Input aria-label={zh?'基线路径':'Control path'} value={path} onChange={event=>setPath(event.target.value)} placeholder={zh?'skill 目录／SKILL.md 或 prompt 文件的完整路径':'Full path to skill directory/SKILL.md or prompt file'}/></label>}
      <label>{zh?'用例文件或目录':'Samples file or directory'}<Input aria-label={zh?'用例文件或目录':'Samples file or directory'} value={samples} onChange={event=>setSamples(event.target.value)} placeholder="eval-samples.json / eval-samples.yaml"/></label>
      <label>{zh?'执行器':'Executor'}<Select aria-label={zh?'执行器':'Executor'} value={executor} onChange={setExecutor} options={['codex','claude','openai-api','anthropic-api'].map(value=>({value,label:value}))}/></label>
      <label>{zh?'固定执行模型':'Fixed task model'}<Input aria-label={zh?'固定执行模型':'Fixed task model'} value={model} onChange={event=>setModel(event.target.value)}/></label>
      <Checkbox checked={judge} onChange={event=>setJudge(event.target.checked)}>{zh?'启用模型评委':'Enable model judges'}</Checkbox>
      {judge&&<label>{zh?'评委模型':'Judge model'}<Input aria-label={zh?'评委模型':'Judge model'} value={judgeModel} onChange={event=>setJudgeModel(event.target.value)} placeholder={zh?'默认使用同一模型':'Defaults to the same model'}/></label>}
    </div>}
  </Modal>;
}
