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
      async listConversations(){return {conversations:[
        {...item,tasks:[{...item.tasks[0],turnId:'older'},...item.tasks]},
        {...item,threadId:'live-thread',tasks:[
          {...item.tasks[0],turnId:'old-live',status:'open'},
          {...item.tasks[0],turnId:'new-live',sourceTurnId:'source/live',status:'open'},
          {...item.tasks[0],turnId:'later-completed'},
        ]},
        {...item,threadId:'empty-thread',tasks:[]},
      ],totalTurnCount:5,totalToolCallCount:1,totalToolFailureCount:0};},
      async getConversation(id){return id==='thread'?item:undefined;},
      async loadTaskTrajectory(id,turn){return id==='thread'&&turn===turnId?{revision:'revision',status:'completed',liveObservable:false,session,ingestion:report.meta.ingestion!,sourceRecords:archive}:undefined;},
    };
    const server=createNextStudioServer({port:0,observationsDir:join(root,'observations'),conversationCatalog:catalog});servers.push(server);
    const url=await server.start();
    for(const path of ['/observe','/observe/conversations/thread']) {
      const response=await fetch(url+path);assert.equal(response.status,200);
      // 会话页展示的是随时在变的任务状态，浏览器不得用陈旧缓存恢复它。
      assert.match(response.headers.get('cache-control')??'',/no-store/);
      const html=await response.text();assert.match(html,/safe conversation/);assert.doesNotMatch(html,/<script>alert/);
      // 标签标题按页面与对象给出：会话详情带上 threadId，列表只给页面名。
      assert.ok(html.includes(path === '/observe' ? '<title>OMK · 会话列表</title>' : '<title>OMK · 会话详情 · thread</title>'), `title of ${path}`);
      assert.match(html,/href="\/observe\?lang=zh" aria-current="page"/);
      if(path==='/observe') {
        assert.match(html,/项目与会话/);
        assert.match(html,/全部对话/);
        assert.match(html,/未归属项目/);
        // 静态链接显式带当前语言：裸地址的语言由本机全局设置决定。
        assert.match(html,/href="\/observe\/conversations\/empty-thread\?lang=zh"/);
        assert.doesNotMatch(html,/查看最近轨迹|查看实时轨迹/);
      }
    }
    for (const query of ['offset=-1', 'limit=11', 'offset=1.5', 'before=a&after=b', 'before=']) {
      const invalid = await fetch(`${url}/api/conversations/thread/messages?${query}`);
      assert.equal(invalid.status, 400);
      assert.deepEqual(await invalid.json(), { error: 'invalid_pagination' });
    }
    assert.equal((await fetch(`${url}/api/conversations/missing/messages`)).status, 404);
    assert.equal((await fetch(`${url}/api/conversations/thread/messages?before=missing`)).status, 409);
    const messages = await fetch(`${url}/api/conversations/thread/messages`);
    assert.equal(messages.status, 200);
    assert.doesNotMatch(await messages.text(), /private-session-locator-must-not-be-serialized/);
    const task=`/observe/conversations/thread/tasks/${encodeURIComponent(turnId)}`;
    const response=await fetch(url+task);assert.equal(response.status,200);
    const html=await response.text();assert.match(html,/语义轨迹/);assert.match(html,/知识访问/);
    assert.ok(html.includes(`<title>OMK · 任务轨迹 · thread/${turnId}</title>`), 'trajectory title names the task');
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
  it('本机语言偏好只接管没有 lang 的地址，单次显式选择不被偏好覆盖',async()=>{
    const root=await mkdtemp(join(tmpdir(),'omk-observe-lang-'));roots.push(root);
    const conversation={threadId:'thread',sourceThreadId:'thread',sourceKind:'codex' as const,title:'语言偏好样例',relatedSkillNames:[],tasks:[]};
    const catalog:ConversationCatalog={
      async listConversations(){return {conversations:[conversation],totalTurnCount:0,totalToolCallCount:0,totalToolFailureCount:0};},
      async getConversation(id){return id==='thread'?conversation:undefined;},
      async loadTaskTrajectory(){return undefined;},
    };
    const server=createNextStudioServer({port:0,observationsDir:root,conversationCatalog:catalog});servers.push(server);
    const url=await server.start();
    const previous=process.env.OMK_LANG;
    try{
      process.env.OMK_LANG='en';
      // 裸地址按本机偏好走，一次跳转就把偏好写进地址，之后的页面内链接都显式带着它。
      const bare=await fetch(`${url}/observe`,{redirect:'manual'});
      assert.equal(bare.status,302);
      assert.equal(bare.headers.get('location'),'/observe?lang=en');
      const english=await (await fetch(`${url}/observe?lang=en`,{redirect:'manual'})).text();
      assert.match(english,/href="\/observe\?lang=en" aria-current="page"/);
      // 显式中文是单次选择：偏好不得改写它，页面里的链接也不得把它丢回裸地址。
      const chinese=await fetch(`${url}/observe?lang=zh`,{redirect:'manual'});
      assert.equal(chinese.status,200);
      const html=await chinese.text();
      assert.match(html,/href="\/observe\?lang=zh" aria-current="page"/);
      assert.match(html,/href="\/observe\/conversations\/thread\?lang=zh"/);
      // 偏好只接管页面地址：JSON 接口一旦被重定向，浏览器的 POST 会退化成 GET。
      assert.notEqual((await fetch(`${url}/api/settings`,{redirect:'manual'})).status,302,'JSON 接口不参与页面语言重定向');
    }finally{
      if(previous===undefined)delete process.env.OMK_LANG;else process.env.OMK_LANG=previous;
    }
  },20000);
});
