import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'vitest';
import { createNextStudioServer } from '../../../src/studio/http/next-server.js';
import { buildObservationInboxReport } from '../../../src/observability/inbox/index.js';
import type { ConversationCatalog } from '../../../src/observability/conversation/catalog.js';
import type { ReportServer } from '../../../src/studio/http/contracts.js';
const servers: ReportServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true})));
});

describe('Observe Next production routes', () => {
  it('renders conversation and task projections without embedding the source session or archive', async () => {
    const root = await mkdtemp(join(tmpdir(),'omk-observe-next-')); roots.push(root);
    const trace = join(root,'trace.jsonl');
    await writeFile(trace,await readFile(new URL('../../fixtures/codex-knowledge-debugger-failure.jsonl',import.meta.url)));
    const report=buildObservationInboxReport(trace);
    const session=report.experience!.sessions[0];
    session.sourceTrace='private-session-locator-must-not-be-serialized';
    const turnId=session.turns[0].turnId;
    const item={threadId:'thread',sourceThreadId:'thread',sourceKind:session.sourceKind,title:'<script>alert("x")</script> safe conversation',relatedSkillNames:[],tasks:[{turnId,title:'发布任务',status:'completed' as const,eventCount:1,toolCallCount:1,toolFailureCount:0,relatedSkillNames:[]}]};
    const archive={status:'available' as const,recordCount:1,records:[],omittedRecordCount:0,byteCount:0,truncated:false};
    const catalog:ConversationCatalog={
      async listConversations(){return {conversations:[item],totalTurnCount:1,totalToolCallCount:1,totalToolFailureCount:0};},
      async getConversation(id){return id==='thread'?item:undefined;},
      async loadTaskTrajectory(id,turn){return id==='thread'&&turn===turnId?{revision:'revision',status:'completed',liveObservable:false,session,ingestion:report.meta.ingestion!,sourceRecords:archive}:undefined;},
    };
    const server=createNextStudioServer({port:0,observationsDir:join(root,'observations'),conversationCatalog:catalog});servers.push(server);
    const url=await server.start();
    for(const path of ['/observe','/observe/conversations/thread']) {
      const response=await fetch(url+path);assert.equal(response.status,200);
      const html=await response.text();assert.match(html,/safe conversation/);assert.doesNotMatch(html,/<script>alert/);
      assert.match(html,/href="\/observe" aria-current="page"/);
    }
    const task=`/observe/conversations/thread/tasks/${encodeURIComponent(turnId)}`;
    const response=await fetch(url+task);assert.equal(response.status,200);
    const html=await response.text();assert.match(html,/语义轨迹/);assert.match(html,/知识访问/);
    assert.doesNotMatch(html,/private-session-locator-must-not-be-serialized/);
    assert.equal((await fetch(`${url}/api/conversations/thread/tasks/${encodeURIComponent(turnId)}/source-records`)).status,200);
    for(const path of ['/observe/conversations/missing','/observe/conversations/%ZZ',`${task}-missing`]) assert.equal((await fetch(url+path)).status,404);
    assert.equal((await fetch(url+'/observe',{method:'POST'})).status,405);
    assert.equal((await fetch(url+'/')).url,url+'/observe');
  },20000);
  it('projects source failures to 503 without leaking raw errors',async()=>{
    const root=await mkdtemp(join(tmpdir(),'omk-observe-error-'));roots.push(root);
    const fail=async()=>{throw new Error('secret=token /private/path');};
    const server=createNextStudioServer({port:0,observationsDir:root,conversationCatalog:{listConversations:fail,getConversation:fail,loadTaskTrajectory:fail}});servers.push(server);
    const url=await server.start();
    for(const path of ['/observe','/observe/conversations/thread','/observe/conversations/thread/tasks/turn']){
      const response=await fetch(url+path);assert.equal(response.status,503);assert.equal(await response.text(),'studio_source_unavailable');
    }
  },15000);
});
