import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { writeMeasurementReportBundle } from '../../../src/evidence/storage/report-bundle.js';
import { persistDoctorGraphSidecars } from '../../../src/evidence/graph/doctor.js';
import { createNextStudioServer } from '../../../src/studio/http/next-server.js';
import { createCoreStudioCatalog } from '../../../src/studio/application/measure/core-run-catalog.js';
import { createNodeCoreRunArtifactStore } from '../../../src/eval-workflows/artifact-store/index.js';
import { runConformanceScenario } from '../../eval-core/conformance/harness.js';
import type { ReportServer } from '../../../src/studio/http/contracts.js';
import type { DoctorReport } from '../../../src/knowledge-artifacts/doctor/contracts.js';

const servers: ReportServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server=>server.stop()));
  await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));
});

describe('Next Studio production boundary', () => {
  it('renders real Core artifacts with isolated request catalogs and working built assets', async () => {
    const root = await mkdtemp(join(tmpdir(),'omk-next-')); roots.push(root);
    const scenario = await runConformanceScenario('function',{runId:'next-real-run'});
    const store = createNodeCoreRunArtifactStore(join(root,'reports'));
    await store.save({runId:'next-real-run',createdAt:'2026-09-10T00:00:00Z',plan:scenario.plan,execution:scenario.execution,evaluation:scenario.evaluation,analysis:scenario.analysis,report:scenario.report});
    const catalog = createCoreStudioCatalog(store);
    const doctorsDir = join(root, 'doctors');
    const analysesDir = join(root, 'analyses');
    const skillName = 'audit/<script>alert(1)</script>';
    const doctorReport: DoctorReport = {
      kind: 'doctor', schemaVersion: '3.0.0', id: 'doctor-test', timestamp: '2026-09-10T00:00:00Z', cliVersion: 'test', cwd: root, executorName: 'script', model: 'test', outcome: 'warnings_only', totals: {pass:0,warn:1,fail:0}, ruleStats: {pass:0,warn:1,fail:0,skipped:0,total:1}, skills: [{skillName,skillPath:root,status:'warn',results:[{ruleId:'fixture',severity:'warn',labelKey:'fixture',status:'warn',message:'fixture warned',detail:{displayName:'<script>unsafe()</script>'},durationMs:0}]}],
    };
    const { reportPath } = writeMeasurementReportBundle({ rootDir: doctorsDir, measurementDomain: 'doctor', recordId: 'knowledge-test', reportId: 'doctor-test', createdAt: '2026-09-10T00:00:00Z', report: doctorReport });
    // 用真实生产者落 graph sidecar：绑定强度、计数与 sourceLocator 都来自体检写入的那份文件，
    // 而不是测试手搓的近似结构。sourceLocator 指向 tmpdir，正好用来验证机器路径不外泄。
    persistDoctorGraphSidecars({
      report: doctorReport,
      skill: doctorReport.skills[0]!,
      sourcePath: reportPath,
      outputDir: doctorsDir,
      fileStem: 'knowledge-test',
      generatedAt: '2026-09-10T00:00:00Z',
      lang: 'zh',
    });
    const a = createNextStudioServer({port:0,doctorsDir,analysesDir,observationsDir:join(root,'a'),coreStudioCatalog:catalog});
    const b = createNextStudioServer({port:0,doctorsDir:join(root,'empty-doctors'),analysesDir,observationsDir:join(root,'b'),coreStudioCatalog:{...catalog,list:async()=>[]}});
    servers.push(a,b);
    const [urlA,urlB] = await Promise.all([a.start(),b.start()]);
    const [pageA,pageB] = await Promise.all([fetch(`${urlA}/measure`),fetch(`${urlB}/measure`)]);
    const [htmlA,htmlB] = await Promise.all([pageA.text(),pageB.text()]);
    assert.equal(pageA.status,200);
    assert.match(htmlA, /<html lang="zh-CN"/);
    assert.match(htmlA,/next-real-run/);
    assert.doesNotMatch(htmlB,/next-real-run/);
    for (const label of ['运行状态','证据状态','结论状态']) assert.ok(htmlA.includes(label));
    const detail = await fetch(`${urlA}/measure/next-real-run`);
    assert.equal(detail.status,200);
    const detailHtml=await detail.text();
    for(const label of ['评测范围','分析结果','证据与定义']) assert.ok(detailHtml.includes(label));
    // 标签标题按页面与对象给出：同开几个评测页时要分得清读的是哪一次运行。
    assert.match(htmlA, /<title>OMK · 评测记录<\/title>/);
    assert.match(detailHtml, /<title>OMK · 运行 · next-real-run<\/title>/);
    const asset = htmlA.match(/src="([^\"]*\/_next\/[^\"]+\.js[^\"]*)"/)?.[1];
    assert.ok(asset);
    assert.equal((await fetch(new URL(asset.replaceAll('&amp;','&'),urlA))).status,200);
    assert.equal((await fetch(`${urlA}/api/reports`)).status,200);
    // 缺页只有一份用户可见结果（#902 §三），且两份都在 Next 开始流式输出之前定下来：
    // 根 `loading.tsx` 一旦先刷出壳层，段内的 `notFound()` 就只改视图、改不掉状态码（实测 200 + Loading…），
    // 所以带壳的 `not-found` 文档不能当服务端缺页用。地址有路由但记录不存在 → 宿主的专属码；
    // 地址根本没有路由 → HTTP adapter 兜底，两种都是纯文本 404。
    const missingRun = await fetch(`${urlA}/measure/missing`);
    assert.equal(missingRun.status, 404);
    assert.equal(await missingRun.text(), 'core_run_not_found');
    assert.equal((await fetch(`${urlA}/measure/%ZZ`)).status, 404, '畸形身份按缺页回答，不拿去查数据源');
    assert.equal((await fetch(`${urlA}/measure/a/b`)).status, 404, '越段地址不冒充运行 id');
    const noRoute = await fetch(`${urlA}/definitely-not-a-page`);
    assert.equal(noRoute.status, 404);
    assert.equal(await noRoute.text(), 'Not Found');
    assert.equal((await fetch(`${urlA}/measure`,{method:'POST'})).status,405);
    const knowledge = await fetch(`${urlA}/knowledge`);
    const knowledgeHtml = await knowledge.text();
    assert.equal(knowledge.status, 200);
    // 语言不进地址：站内链接一律不带 lang，渲染语言由本机设置决定。
    assert.match(knowledgeHtml, /<a(?=[^>]*href="\/knowledge")(?=[^>]*aria-current="page")/u);
    assert.match(knowledgeHtml, /knowledge-table/);
    assert.match(knowledgeHtml, /audit\/&lt;script&gt;/);
    assert.doesNotMatch(knowledgeHtml, /<script>alert\(1\)<\/script>/);
    const skill = await fetch(`${urlA}/knowledge/skills/${encodeURIComponent(skillName)}`);
    assert.equal(skill.status, 200);
    const skillHtml = await skill.text();
    assert.match(skillHtml, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
    for (const label of ['健康体检','生产观测','待优化项']) assert.ok(skillHtml.includes(label));
    // 结构证据随真实 sidecar 出现，且弱绑定必须在页面上自己说清楚（#884）。
    assert.match(skillHtml, /知识载体结构/);
    assert.match(skillHtml, /仅来源路径一致/);
    assert.match(skillHtml, /内容有没有变动未被证明/);
    // 详情页标题带对象身份；skill 名是外部文本，进 `<title>` 也只能是转义后的文字。
    assert.match(knowledgeHtml, /<title>OMK · 知识载体<\/title>/);
    assert.match(skillHtml, /<title>OMK · 知识载体 · audit\/&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
    // RSC 会把页面 props 序列化进 HTML 负载：sourceLocator／graphPath／evidence path 都是用户
    // 机器的绝对路径，一旦上了页面模型就在这里泄出去，所以断言整页读不到 tmpdir。
    assert.ok(!skillHtml.includes(root), 'skill detail must not leak the absolute skill path');
    assert.ok(!knowledgeHtml.includes(root), 'knowledge list must not leak it either');
    // 同一条口径只管页面模型，不扩到 JSON 路由：它是页面之外的机读投影，仓库内的读者只有性能
    // 基线与测试。反向钉住定位符仍在，防止把「收缩 JSON 契约」当成页面清理顺手做掉（见 README）。
    const skillsApi: {entries: {skillName: string, graph?: {
      sourceLocator?: string,
      doctor?: {graphPath?: string},
    }}[]} = await (await fetch(`${urlA}/api/skills`)).json();
    const apiGraph = skillsApi.entries.find((entry) => entry.skillName === skillName)?.graph;
    assert.deepEqual(
      [apiGraph?.sourceLocator, apiGraph?.doctor?.graphPath],
      [root, join(doctorsDir, 'knowledge-test', 'derived', 'graph.json')],
      '/api/skills keeps the locators as the machine-readable projection',
    );
    // 点名一个不存在的轮次不静默回落到当前那次：URL 与所见证据必须一致。
    const staleRun = await fetch(`${urlA}/knowledge/skills/${encodeURIComponent(skillName)}?doctorRun=pruned-run`);
    assert.equal(staleRun.status, 404);
    assert.equal(await staleRun.text(), 'doctor_run_not_found');
    const drilled = await fetch(`${urlA}/knowledge/skills/${encodeURIComponent(skillName)}?doctorRun=doctor-test`);
    assert.equal(drilled.status, 200);
    assert.match(await drilled.text(), /studio-utilities-trigger/);
    assert.doesNotMatch(await (await fetch(`${urlB}/knowledge`)).text(), /audit\/&lt;script&gt;/);
    const knowledgeBare = await (await fetch(`${urlA}/knowledge`)).text();
    assert.match(knowledgeBare, /studio-utilities-trigger/);
    assert.doesNotMatch(knowledgeBare, /class="studio-lang"/);
    // 所有完整 Studio 页面共用全局设置入口；英文渲染由本机设置驱动（OMK_LANG 等同设置文件）。
    const previousLang = process.env.OMK_LANG;
    let knowledgeEn = '';
    let measureEn = '';
    try {
      process.env.OMK_LANG = 'en';
      knowledgeEn = await (await fetch(`${urlA}/knowledge`)).text();
      measureEn = await (await fetch(`${urlA}/measure`)).text();
    } finally {
      if (previousLang === undefined) delete process.env.OMK_LANG; else process.env.OMK_LANG = previousLang;
    }
    assert.match(knowledgeEn, /<html lang="en"/);
    // 外壳一致性看品牌位与侧栏一级导航（#1055 后入口收进侧栏）：两页除 aria-current 外必须逐字节一致；
    // 工作区列表（studio-sidebar-body）随页面不同，不属于外壳比较面。
    const shellOf = (html: string): string => {
      const brand = (html.match(/<a class="studio-brand"[^>]*>/u) ?? ['<missing brand>'])[0];
      const nav = (html.match(/<nav aria-label="Studio primary navigation">[\s\S]*?<\/nav>/u) ?? ['<missing nav>'])[0]
        .replaceAll(' aria-current="page"', '');
      return `${brand}${nav}`;
    };
    assert.equal(shellOf(measureEn), shellOf(knowledgeEn));
    assert.match(knowledgeEn, /studio-utilities-trigger/);
    for (const href of ['href="/observe"', 'href="/measure"', 'href="/knowledge"']) {
      assert.ok(shellOf(measureEn).includes(href), `primary navigation links ${href}`);
    }
    assert.doesNotMatch(measureEn, /href="[^"]*[?&]lang=/, '英文页面链接同样不带语言参数');
    assert.match(measureEn, /<a(?=[^>]*href="\/measure")(?=[^>]*aria-current="page")/u);
    for (const path of ['/knowledge/skills/missing','/knowledge/skills/%ZZ']) assert.equal((await fetch(urlA+path)).status,404);
    assert.equal((await fetch(`${urlA}/knowledge`,{method:'POST'})).status,405);
    await a.stop();
    assert.equal(a.getUrl(),null);
    assert.equal((await fetch(`${await a.start()}/measure`)).status,200);
  },30000);

  it('does not turn catalog failures into streamed 200 responses or expose raw exceptions',async()=>{
    const root=await mkdtemp(join(tmpdir(),'omk-next-error-'));roots.push(root);
    const server=createNextStudioServer({port:0,observationsDir:root,coreStudioCatalog:{async list(){throw new Error('token=secret /private/catalog')},async get(){throw new Error('token=secret')},async inspect(){return undefined}}});servers.push(server);
    const url=await server.start();
    for(const path of ['/measure','/measure/run']){
      const response=await fetch(url+path);assert.equal(response.status,503);
      assert.equal(await response.text(),'core_studio_source_unavailable');
    }
  },15000);

  it('projects a failing knowledge directory resolver to 503 without leaking the cause',async()=>{
    const root=await mkdtemp(join(tmpdir(),'omk-next-knowledge-error-'));roots.push(root);
    // 目录按请求解析，长会话里项目根可能已经消失：读不出事实要收敛成稳定 503，
    // 而不是让 Next 流式吐出 200 或把带路径的原因透给浏览器。口径与受管根目录同源。
    const server=createNextStudioServer({port:0,analysesDir:()=>{throw new Error('EACCES /private/token');},doctorsDir:join(root,'doctors'),observationsDir:root});servers.push(server);
    const url=await server.start();
    for(const path of ['/knowledge','/knowledge/skills/audit']){
      const response=await fetch(url+path);assert.equal(response.status,503,path);
      assert.equal(await response.text(),'studio_source_unavailable',path);
    }
  },15000);
});
