import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { writeMeasurementReportBundle } from '../../../src/evidence/storage/report-bundle.js';
import { createNextStudioServer } from '../../../src/studio/http/next-server.js';
import { createCoreStudioCatalog } from '../../../src/studio/application/core-run-catalog.js';
import { createNodeCoreRunArtifactStore } from '../../../src/eval-workflows/artifact-store/index.js';
import { runConformanceScenario } from '../../eval-core/conformance/harness.js';
import type { ReportServer } from '../../../src/studio/http/contracts.js';

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
    writeMeasurementReportBundle({ rootDir: doctorsDir, measurementDomain: 'doctor', recordId: 'knowledge-test', reportId: 'doctor-test', createdAt: '2026-09-10T00:00:00Z', report: {
      kind: 'doctor', schemaVersion: '3.0.0', id: 'doctor-test', timestamp: '2026-09-10T00:00:00Z', cliVersion: 'test', cwd: root, executorName: 'script', model: 'test', outcome: 'passed', totals: {pass:1,warn:0,fail:0}, ruleStats: {pass:1,warn:0,fail:0,skipped:0,total:1}, skills: [{skillName,skillPath:root,status:'pass',results:[{ruleId:'fixture',severity:'info',labelKey:'fixture',status:'pass',message:'<script>unsafe()</script>',durationMs:0}]}],
    }});
    const a = createNextStudioServer({port:0,doctorsDir,analysesDir,observationsDir:join(root,'a'),coreStudioCatalog:catalog});
    const b = createNextStudioServer({port:0,doctorsDir:join(root,'empty-doctors'),analysesDir,observationsDir:join(root,'b'),coreStudioCatalog:{...catalog,list:async()=>[]}});
    servers.push(a,b);
    const [urlA,urlB] = await Promise.all([a.start(),b.start()]);
    const [pageA,pageB] = await Promise.all([fetch(`${urlA}/measure?lang=en`),fetch(`${urlB}/measure?lang=en`)]);
    const [htmlA,htmlB] = await Promise.all([pageA.text(),pageB.text()]);
    assert.equal(pageA.status,200);
    assert.match(htmlA, /<html lang="en"/);
    assert.match(htmlA,/next-real-run/);
    assert.doesNotMatch(htmlB,/next-real-run/);
    for (const label of ['Run status','Evidence status','Conclusion status']) assert.ok(htmlA.includes(label));
    const detail = await fetch(`${urlA}/measure/next-real-run`);
    assert.equal(detail.status,200);
    const detailHtml=await detail.text();
    for(const label of ['评测范围','分析结果','证据与定义']) assert.ok(detailHtml.includes(label));
    const asset = htmlA.match(/src="([^\"]*\/_next\/[^\"]+\.js[^\"]*)"/)?.[1];
    assert.ok(asset);
    assert.equal((await fetch(new URL(asset.replaceAll('&amp;','&'),urlA))).status,200);
    assert.equal((await fetch(`${urlA}/api/reports`)).status,200);
    assert.equal((await fetch(`${urlA}/measure/missing`)).status,404);
    assert.equal((await fetch(`${urlA}/measure/%ZZ`)).status,404);
    assert.equal((await fetch(`${urlA}/measure`,{method:'POST'})).status,405);
    const knowledge = await fetch(`${urlA}/knowledge`);
    const knowledgeHtml = await knowledge.text();
    assert.equal(knowledge.status, 200);
    assert.match(knowledgeHtml, /href="\/knowledge" aria-current="page"/);
    assert.match(knowledgeHtml, /knowledge-table/);
    assert.match(knowledgeHtml, /audit\/&lt;script&gt;/);
    assert.doesNotMatch(knowledgeHtml, /<script>alert\(1\)<\/script>/);
    const skill = await fetch(`${urlA}/knowledge/skills/${encodeURIComponent(skillName)}`);
    assert.equal(skill.status, 200);
    const skillHtml = await skill.text();
    assert.match(skillHtml, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
    for (const label of ['健康体检','生产观测','待优化项']) assert.ok(skillHtml.includes(label));
    assert.doesNotMatch(await (await fetch(`${urlB}/knowledge`)).text(), /audit\/&lt;script&gt;/);
    // 壳层只有一份：迁移完成后评测页与兄弟页面共用同一个 header，差异只在 aria-current。
    const knowledgeEn = await (await fetch(`${urlA}/knowledge?lang=en`)).text();
    const shellOf = (html: string): string => (html.match(/<header class="studio-header">[\s\S]*?<\/header>/u) ?? ['<missing header>'])[0].replaceAll(' aria-current="page"', '');
    const measureShell = shellOf(htmlA);
    assert.equal(measureShell, shellOf(knowledgeEn));
    for (const href of ['href="/observe?lang=en"', 'href="/measure?lang=en"', 'href="/knowledge?lang=en"']) {
      assert.ok(measureShell.includes(href), `primary navigation links ${href}`);
    }
    assert.match(htmlA, /href="\/measure\?lang=en" aria-current="page"/);
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
});
