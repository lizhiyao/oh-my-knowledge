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
      // 标签标题按页面与对象给出：对话详情带上 threadId，列表只给页面名。
      assert.ok(html.includes(path === '/observe' ? '<title>OMK · 对话列表</title>' : '<title>OMK · 对话详情 · thread</title>'), `title of ${path}`);
      assert.match(html,/<a(?=[^>]*href="\/observe")(?=[^>]*aria-current="page")/u);
      if(path==='/observe') {
        assert.match(html,/项目与对话/);
        assert.match(html,/全部对话/);
        assert.match(html,/未归属项目/);
        // 语言不进地址：站内链接一律不带 lang，渲染语言由本机设置决定。
        assert.match(html,/href="\/observe\/conversations\/empty-thread"/);
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
  it('语言只看本机设置：地址里的 lang 不生效，页面链接不带语言参数',async()=>{
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
      // 裸地址直接按本机偏好渲染。
      const bare=await fetch(`${url}/observe`,{redirect:'manual'});
      assert.equal(bare.status,200);
      const english=await bare.text();
      assert.match(english,/<html lang="en"/);
      assert.match(english,/<a(?=[^>]*href="\/observe")(?=[^>]*aria-current="page")/u);
      assert.doesNotMatch(english,/href="[^"]*[?&]lang=/,'页面内链接不带语言参数');
      // 地址里的 lang 既不生效也不被清理：不重定向，页面仍按本机设置渲染。
      const legacy=await fetch(`${url}/observe?lang=zh&view=recent`,{redirect:'manual'});
      assert.equal(legacy.status,200);
      assert.match(await legacy.text(),/<html lang="en"/);
      // JSON 接口同样不受语言参数影响。
      assert.equal((await fetch(`${url}/api/settings?lang=en`,{redirect:'manual'})).status,200,'JSON 接口不受语言参数影响');
    }finally{
      if(previous===undefined)delete process.env.OMK_LANG;else process.env.OMK_LANG=previous;
    }
  },20000);
  it('切换语言 = 写设置文件，之后页面按新设置渲染，地址不含语言参数',async()=>{
    const root=await mkdtemp(join(tmpdir(),'omk-observe-switch-'));roots.push(root);
    const home=await mkdtemp(join(tmpdir(),'omk-home-switch-'));roots.push(home);
    const conversation={threadId:'thread',sourceThreadId:'thread',sourceKind:'codex' as const,title:'语言切换样例',relatedSkillNames:[],tasks:[]};
    const catalog:ConversationCatalog={
      async listConversations(){return {conversations:[conversation],totalTurnCount:0,totalToolCallCount:0,totalToolFailureCount:0};},
      async getConversation(id){return id==='thread'?conversation:undefined;},
      async loadTaskTrajectory(){return undefined;},
    };
    const server=createNextStudioServer({port:0,observationsDir:root,conversationCatalog:catalog});servers.push(server);
    const url=await server.start();
    const previousHome=process.env.OMK_HOME;
    const previousLang=process.env.OMK_LANG;
    try{
      process.env.OMK_HOME=home;delete process.env.OMK_LANG;
      assert.match(await (await fetch(`${url}/observe`)).text(),/<html lang="zh-CN"/);
      const current=await (await fetch(`${url}/api/settings`)).json() as {revision:string;settings:Record<string,unknown>};
      const saved=await fetch(`${url}/api/settings`,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({revision:current.revision,settings:{...current.settings,language:'en'}})});
      assert.equal(saved.status,200);
      const english=await (await fetch(`${url}/observe`)).text();
      assert.match(english,/<html lang="en"/);
      assert.match(english,/Conversations/);
      assert.doesNotMatch(english,/href="[^"]*[?&]lang=/,'切换后页面链接仍不带语言参数');
    }finally{
      if(previousHome===undefined)delete process.env.OMK_HOME;else process.env.OMK_HOME=previousHome;
      if(previousLang===undefined)delete process.env.OMK_LANG;else process.env.OMK_LANG=previousLang;
    }
  },20000);
  it('设置文件损坏时页面退回内置语言默认，损坏由设置接口报告',async()=>{
    const root=await mkdtemp(join(tmpdir(),'omk-observe-broken-settings-'));roots.push(root);
    const home=await mkdtemp(join(tmpdir(),'omk-home-broken-'));roots.push(home);
    await writeFile(join(home,'settings.json'),'{"schemaVersion":1,');
    const server=createNextStudioServer({port:0,observationsDir:root,conversationCatalog:{
      async listConversations(){return {conversations:[],totalTurnCount:0,totalToolCallCount:0,totalToolFailureCount:0};},
      async getConversation(){return undefined;},async loadTaskTrajectory(){return undefined;},
    }});servers.push(server);
    const url=await server.start();
    const previousHome=process.env.OMK_HOME;
    const previousLang=process.env.OMK_LANG;
    try{
      process.env.OMK_HOME=home;delete process.env.OMK_LANG;
      // 语言只是偏好：读不到就按内置默认渲染，不能让整个 Studio 变成 500（诊断入口也在同一个页面壳里）。
      const page=await fetch(`${url}/observe`,{redirect:'manual'});
      assert.equal(page.status,200);
      assert.match(await page.text(),/<a(?=[^>]*href="\/observe")(?=[^>]*aria-current="page")/u);
      const api=await fetch(`${url}/api/settings`);
      assert.equal(api.status,400);
      assert.equal((await api.json() as {error?:string}).error,'settings_unavailable');
    }finally{
      if(previousHome===undefined)delete process.env.OMK_HOME;else process.env.OMK_HOME=previousHome;
      if(previousLang===undefined)delete process.env.OMK_LANG;else process.env.OMK_LANG=previousLang;
    }
  },20000);
});
