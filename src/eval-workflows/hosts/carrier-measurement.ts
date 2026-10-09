import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { EvaluationStatusSchema } from '../../eval-core/contracts/index.js';
import { CORE_CLI_RUN_OUTCOME_SCHEMA_VERSION } from '../projections/contracts.js';
import { CarrierLibrary } from '../../knowledge-artifacts/authoring/library.js';
import { distributableCopyFilter, hashArtifactSource } from '../../knowledge-artifacts/sources/content-hash.js';
import { projectLayout } from '../../evidence/storage/layout.js';
import { createJsonFileAtomic, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { withFileLock } from '../../shared/file-lock.js';
import { listSampleFilesInDir, loadSamples } from '../inputs/load-samples.js';
import { hasResolvableSampleUrls } from '../orchestration/sample-content-resolution.js';
import { createNodeEvaluationApplication, parseCliEvaluationRequest, type EvaluationApplication, type CliEvaluationRequest } from './application.js';
import { captureNodeCliEvaluationEnvironment } from './node-environment.js';
import type { CarrierMeasurementInput, CarrierMeasurementPlan, CarrierMeasurementRecord } from '../projections/carrier-measurement.js';

const uuid = z.string().uuid();
const text = z.string().trim().min(1).max(4096);
const inputSchema = z.strictObject({ workspace: text, artifactId: uuid, version: z.number().int().positive(), control: z.discriminatedUnion('sourceKind', [z.strictObject({ sourceKind: z.literal('version'), artifactId: uuid, version: z.number().int().positive() }), z.strictObject({ sourceKind: z.literal('local'), path: text })]), samples: text, executor: z.enum(['codex', 'claude', 'openai-api', 'anthropic-api']), model: text.max(200), judge: z.boolean(), judgeModel: z.string().trim().max(200) });
interface StoredMeasurement extends Omit<CarrierMeasurementRecord, 'plan'> { plan: CarrierMeasurementPlan; schemaVersion: 'omk-carrier-measurement-v1'; startedAt?: string; input: CarrierMeasurementInput; inputDigests: { definition: string; policy: string }; owner: { pid: number; host: string } }
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const planSchema = z.strictObject({measurementId:uuid,expiresAt:z.string().datetime(),treatment:z.strictObject({artifactId:uuid,revisionId:uuid,version:z.number().int().positive(),name:text,contentHash:hash,content:z.string().max(2*1024*1024),knowledgeRefs:z.array(z.strictObject({knowledgeId:uuid,revisionId:uuid,generation:z.number().int().positive()})).max(1000)}),control:z.strictObject({label:text,path:text,contentHash:hash,content:z.string().max(2*1024*1024)}),samplesPath:text,samples:z.array(z.strictObject({sampleId:text,input:z.string(),provenance:text,criteria:z.string()})).max(100),executor:text,model:text,judgeModel:text.nullable(),trials:z.number().int().positive(),executionCoordinates:z.number().int().positive(),evaluatorCount:z.number().int().nonnegative(),scoringModels:z.array(text).max(100),runContractDigest:text});
const outcomeSchema=z.object({projectionKind:z.literal('core-cli-run-outcome'),schemaVersion:z.literal(CORE_CLI_RUN_OUTCOME_SCHEMA_VERSION),runId:text,runContractDigest:text,status:EvaluationStatusSchema}).passthrough();
const storedSchema = z.strictObject({schemaVersion:z.literal('omk-carrier-measurement-v1'),measurementId:uuid,createdAt:z.string().datetime(),startedAt:z.string().datetime().optional(),status:z.enum(['prepared','running','finished','failed','cancelled','interrupted']),input:inputSchema,owner:z.strictObject({pid:z.number().int().positive(),host:text}),inputDigests:z.strictObject({definition:text,policy:text}),plan:planSchema,outcome:outcomeSchema.optional(),errorCode:z.enum(['measurement_conflict','measurement_request_failed','measurement_persistence_failed']).optional()});
function directory(path: string, create=false) { if(existsSync(path)) { const stat=lstatSync(path); if(!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('measurement_invalid_directory'); } else if(create) mkdirSync(path); }
function files(workspace: string, create=false) { const root=realpathSync(resolve(workspace)); const layout=projectLayout(root); const state=layout.root; directory(state,create); directory(layout.stateDir,create); const jobs=layout.jobsDir; directory(jobs,create); const folder=join(jobs,'carrier-measurements'); directory(folder,create); return folder; }
function pathOf(workspace:string,id:string,create=false) { uuid.parse(id); return join(files(workspace,create),`${id}.json`); }
function read(workspace:string,id:string):StoredMeasurement { const path=pathOf(workspace,id); const stat=lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size>6*1024*1024) throw new Error('measurement_invalid_record'); const value=storedSchema.parse(JSON.parse(readFileSync(path,'utf8'))) as unknown as StoredMeasurement; if(value.measurementId!==id || value.plan.measurementId!==id || value.input.artifactId!==value.plan.treatment.artifactId || value.input.version!==value.plan.treatment.version || value.outcome && value.outcome.runContractDigest!==value.plan.runContractDigest || resolve(value.input.workspace)!==realpathSync(resolve(workspace))) throw new Error('measurement_identity_mismatch'); return value; }
function publicRecord(value:StoredMeasurement):CarrierMeasurementRecord {
  const {measurementId,createdAt,status,outcome,errorCode}=value;
  const {artifactId,revisionId,version,name,contentHash,knowledgeRefs}=value.plan.treatment;
  const treatment={artifactId,revisionId,version,name,contentHash,knowledgeRefs};
  const control={label:value.plan.control.label,path:value.plan.control.path,contentHash:value.plan.control.contentHash};
  const {model,executor,judgeModel,trials,runContractDigest}=value.plan;
  return {measurementId,createdAt,status,plan:{treatment,control,model,executor,judgeModel,trials,runContractDigest,sampleCount:value.plan.samples.length},...(outcome?{outcome}: {}),...(errorCode?{errorCode}: {})};
}
function ownerAlive(owner:StoredMeasurement['owner']) { if(owner.host!==hostname()) return true; try {process.kill(owner.pid,0);return true;} catch(cause) {return (cause as NodeJS.ErrnoException).code!=='ESRCH';} }
function boundedSamples(path:string) {
  const stat=lstatSync(path); const files=stat.isDirectory()?listSampleFilesInDir(path).map(name=>join(path,name)):[path];
  if(files.length>100)throw new Error('measurement_capacity');let total=0;
  for(const file of files){const value=lstatSync(file);total+=value.size;if(!value.isFile() || value.isSymbolicLink() || value.size>2*1024*1024 || total>8*1024*1024)throw new Error('measurement_capacity');}
}
function boundedAssets(root:string) {
  const include=distributableCopyFilter(root);let bytes=0;let entries=0;
  const walk=(path:string)=>{for(const name of readdirSync(path)){const entry=join(path,name);if(!include(entry))continue;const stat=lstatSync(entry);if(++entries>1000)throw new Error('measurement_capacity');if(stat.isDirectory())walk(entry);else if(stat.isFile()){bytes+=stat.size;if(bytes>64*1024*1024)throw new Error('measurement_capacity');}else throw new Error('measurement_control_invalid');}};walk(root);
}
function sources(input:CarrierMeasurementInput) {
  const library=new CarrierLibrary(input.workspace); const treatment=library.show(input.artifactId,input.version); if(treatment.drifted) throw new Error('measurement_conflict');
  const baseline=input.control.sourceKind==='version'?library.show(input.control.artifactId,input.control.version):undefined;
  if(baseline && (baseline.drifted || baseline.artifactKind!==treatment.artifactKind)) throw new Error('measurement_conflict');
  const path=baseline?.artifactPath ?? realpathSync(resolve(input.workspace,(input.control as {path:string}).path));
  const isSkill=treatment.artifactKind==='skill';
  const controlPath=isSkill && basename(path)==='SKILL.md'?resolve(path,'..'):path;
  if(!isSkill && basename(controlPath)==='SKILL.md') throw new Error('measurement_control_invalid');
  const stat=lstatSync(controlPath); if(isSkill ? !stat.isDirectory() : !stat.isFile()) throw new Error('measurement_control_invalid');
  const main=isSkill?join(controlPath,'SKILL.md'):controlPath; const mainStat=lstatSync(main); if(!mainStat.isFile() || mainStat.isSymbolicLink() || mainStat.size>2*1024*1024) throw new Error('measurement_control_invalid');
  if(isSkill)boundedAssets(controlPath);
  const controlContent=readFileSync(main,'utf8'); const hash=hashArtifactSource(controlPath,isSkill);
  if(treatment.baseline?.locator && existsSync(treatment.baseline.locator) && input.control.sourceKind==='local' && realpathSync(resolve(treatment.baseline.locator))=== (isSkill?join(controlPath,'SKILL.md'):controlPath) && treatment.baseline.contentHash!==hash) throw new Error('measurement_conflict');
  if(treatment.contentHash===hash) throw new Error('measurement_identical');
  return {treatment,controlPath,controlHash:hash,controlContent,controlLabel:baseline?`${baseline.name} · v${baseline.version}`:basename(controlPath)};
}
function request(input:CarrierMeasurementInput, control:string,treatment:string,dryRun:boolean,lang:'zh'|'en'):CliEvaluationRequest {
  if(input.judge && !input.judgeModel) throw new Error('measurement_judge_required');
  const output=projectLayout(input.workspace).evalDir;
  return parseCliEvaluationRequest({evalConfig:{samples:input.samples,variants:[{name:'control',role:'control',artifact:control},{name:'treatment',role:'treatment',artifact:treatment}]},explicitCliFlags:{samples:input.samples,executor:input.executor,model:input.model,'judge-models':`${input.executor}:${input.judgeModel || input.model}`,'no-judge':!input.judge,retry:0,concurrency:1,'dry-run':dryRun,'skip-doctor':dryRun,'skip-connectivity':dryRun,'no-serve':true,'output-dir':output}, defaults:{samplesLocator:input.samples,skillDirectoryLocator:input.workspace,targetRuntime:{executorId:input.executor,model:input.model,effort:'low'},judgeMembers:[{executorId:input.executor,model:input.judgeModel || input.model}],presentation:{projectOutputDirectoryLocator:output,globalOutputDirectoryLocator:output,language:lang,languageDefaultSource:'environment-selection'}}});
}

/** Per-server ownership; disk records only describe attempts, never replace Core measurement evidence. */
export function createCarrierMeasurementService(application:EvaluationApplication=createNodeEvaluationApplication(captureNodeCliEvaluationEnvironment())) {
  const active=new Map<string,{workspace:string;controller:AbortController;done:Promise<void>}>(); const unpublished=new Map<string,StoredMeasurement>(); let closed=false;
  async function preview(raw:unknown,lang:'zh'|'en',signal?:AbortSignal):Promise<CarrierMeasurementPlan> {
    if(closed) throw new Error('measurement_closed');
    const input=inputSchema.parse(raw); input.workspace=realpathSync(resolve(input.workspace)); input.samples=realpathSync(resolve(input.workspace,input.samples));
    boundedSamples(input.samples);
    const {treatment,controlPath,controlHash,controlLabel,controlContent}=sources(input);
    const loaded=loadSamples(input.samples); if(!loaded.samples.length || loaded.samples.length>100 || hasResolvableSampleUrls(loaded.samples)) throw new Error('measurement_samples_unsupported');
    const sampleViews=loaded.samples.map(sample=>({sampleId:sample.sample_id,input:sample.input.inputKind==='text'?sample.input.text:JSON.stringify(sample.input),provenance:sample.provenance??'unspecified',criteria:JSON.stringify({expected:sample.expected,reference:sample.reference,checks:sample.checks,rubric:sample.rubric,assertions:sample.assertions})}));
    if(Buffer.byteLength(JSON.stringify(sampleViews))>512*1024) throw new Error('measurement_capacity');
    const temporary=mkdtempSync(join(tmpdir(),'omk-carrier-preview-')); let inputDigests:StoredMeasurement['inputDigests'] | undefined; let scoringModels:string[]=[];
    try {
      const result=await application.run({request:request(input,controlPath,treatment.artifactPath,true,lang),projectRoot:input.workspace,materializationRoot:join(temporary,'inputs'),resourceLeaseRoot:join(temporary,'leases'),signal,validateCompiled:compiled=>{inputDigests=compiled.canonicalDigests;scoringModels=[...new Set(compiled.runtimeBinding.bindings.flatMap(binding=>binding.runtimeKind==='evaluator' && binding.qualification?[`${binding.qualification.executorId} / ${binding.qualification.model}`]:[]))];}});
      if(result.outcomeKind!=='dry-run' || !inputDigests) throw new Error('measurement_plan_invalid'); signal?.throwIfAborted();
      const verified=sources(input); if(verified.treatment.revisionId!==treatment.revisionId || verified.treatment.contentHash!==treatment.contentHash || verified.controlHash!==controlHash || JSON.stringify(loadSamples(input.samples))!==JSON.stringify(loaded)) throw new Error('measurement_conflict');
      const sealed=result.outcome; const measurementId=randomUUID();
      const plan:CarrierMeasurementPlan={measurementId,expiresAt:new Date(Date.now()+15*60*1000).toISOString(),treatment:{artifactId:treatment.artifactId,revisionId:treatment.revisionId,version:treatment.version,name:treatment.name,contentHash:treatment.contentHash,knowledgeRefs:treatment.knowledgeRefs,content:treatment.content},control:{label:controlLabel,path:controlPath,contentHash:controlHash,content:controlContent},samplesPath:input.samples,samples:sampleViews,executor:input.executor,model:input.model,judgeModel:input.judge?input.judgeModel:null,trials:sealed.experiment.trials,executionCoordinates:sealed.dataset.sampleCount*sealed.targets.length*sealed.experiment.trials,evaluatorCount:sealed.evaluation.evaluatorCount,scoringModels,runContractDigest:sealed.runContractDigest};
      createJsonFileAtomic(pathOf(input.workspace,measurementId,true),{schemaVersion:'omk-carrier-measurement-v1',measurementId,createdAt:new Date().toISOString(),status:'prepared',input,inputDigests,plan,owner:{pid:process.pid,host:hostname()}} satisfies StoredMeasurement);
      return plan;
    } finally {rmSync(temporary,{recursive:true,force:true});}
  }
  function status(workspace:string,id:string) { const memory=unpublished.get(id);if(memory && memory.input.workspace===realpathSync(resolve(workspace)))return publicRecord(memory); const value=read(workspace,id); if(value.status==='running' && !ownerAlive(value.owner)) {value.status='interrupted';writeJsonFileAtomic(pathOf(workspace,id),value);} return publicRecord(value); }
  function list(workspace:string,artifactId:string,version:number) {uuid.parse(artifactId);const folder=files(workspace);if(!existsSync(folder))return [];return readdirSync(folder).filter(name=>/^[a-f0-9-]+\.json$/.test(name)).map(name=>read(workspace,name.slice(0,-5))).filter(value=>value.startedAt!==undefined).map(value=>status(workspace,value.measurementId)).filter(value=>value.plan.treatment.artifactId===artifactId && value.plan.treatment.version===version).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
  async function run(value:StoredMeasurement,lang:'zh'|'en',controller:AbortController) {
    const workspace=value.input.workspace; let temporary:string|undefined;
    try {
      temporary=mkdtempSync(join(tmpdir(),'omk-carrier-measure-'));
      const source=sources(value.input);
      if(source.treatment.revisionId!==value.plan.treatment.revisionId || source.treatment.contentHash!==value.plan.treatment.contentHash || source.controlHash!==value.plan.control.contentHash) throw new Error('measurement_conflict');
      const result=await application.run({request:request(value.input,source.controlPath,source.treatment.artifactPath,false,lang),projectRoot:workspace,materializationRoot:join(temporary,'inputs'),resourceLeaseRoot:join(temporary,'leases'),signal:controller.signal,expectedRunContractDigest:value.plan.runContractDigest,validateCompiled:compiled=>{if(compiled.canonicalDigests.definition!==value.inputDigests.definition || compiled.canonicalDigests.policy!==value.inputDigests.policy) throw new Error('measurement_conflict');}});
      if(result.outcomeKind!=='run' || result.outcome.runContractDigest!==value.plan.runContractDigest) throw new Error('measurement_result_invalid');
      value.outcome=result.outcome; value.status=controller.signal.aborted?'cancelled':'finished';
    } catch(cause) { value.errorCode=cause instanceof Error && ['measurement_conflict','evaluation_plan_conflict'].includes(cause.message)?'measurement_conflict':'measurement_request_failed'; value.status=controller.signal.aborted?'cancelled':'failed'; }
    finally {try {if(temporary)rmSync(temporary,{recursive:true,force:true});writeJsonFileAtomic(pathOf(workspace,value.measurementId),value);} catch {value.status='failed';value.errorCode='measurement_persistence_failed';unpublished.set(value.measurementId,value);if(unpublished.size>16)unpublished.delete(unpublished.keys().next().value!);} finally {active.delete(value.measurementId);}}
  }
  function start(workspace:string,id:string,lang:'zh'|'en') {
    if(active.has(id))throw new Error('measurement_conflict');
    if(closed || active.size>=4) throw new Error('measurement_capacity');
    const path=pathOf(workspace,id);
    const value=withFileLock(`${path}.lock`,()=>{const value=read(workspace,id);if(value.status!=='prepared' || Date.parse(value.plan.expiresAt)<Date.now()) throw new Error('measurement_conflict');value.status='running';value.startedAt=new Date().toISOString();value.owner={pid:process.pid,host:hostname()};writeJsonFileAtomic(path,value);return value;});
    const controller=new AbortController(); const done=Promise.resolve().then(()=>run(value,lang,controller)).catch(()=>{ /* Publication failure remains running on disk; never retry model calls automatically. */ });active.set(id,{workspace:realpathSync(resolve(workspace)),controller,done});
    return publicRecord(value);
  }
  async function cancel(workspace:string,id:string) {const value=read(workspace,id);const job=active.get(id);if(job && job.workspace!==realpathSync(resolve(workspace))) throw new Error('measurement_identity_mismatch');if(value.status==='running' && !job) throw new Error('measurement_other_server');if(job){job.controller.abort();await job.done;}else if(value.status==='prepared'){const path=pathOf(workspace,id);withFileLock(`${path}.lock`,()=>{const current=read(workspace,id);if(current.status!=='prepared')throw new Error('measurement_conflict');current.status='cancelled';writeJsonFileAtomic(path,current);});}return status(workspace,id);}
  function close(){closed=true;for(const job of active.values())job.controller.abort();}
  return {preview,start,status,list,cancel,close};
}

/** Origin is an attempt association only; require the authenticated Core contract digest before displaying it. */
export function findCarrierMeasurementOrigin(workspace:string,runId:string,runContractDigest:string) {
  const folder=files(workspace);if(!existsSync(folder))return undefined;
  for(const name of readdirSync(folder).filter(name=>/^[a-f0-9-]+\.json$/.test(name))) {
    const value=read(workspace,name.slice(0,-5));
    if(value.outcome?.runId===runId && value.plan.runContractDigest===runContractDigest) {
      const {artifactId,revisionId,version,name}=value.plan.treatment;
      return {artifactId,revisionId,version,name};
    }
  }
  return undefined;
}
