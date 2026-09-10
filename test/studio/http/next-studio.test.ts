import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { createNextStudioServer } from '../../../src/studio/http/next-server.js';
import { createCoreStudioCatalog } from '../../../src/studio/core-runs/catalog.js';
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
    const a = createNextStudioServer({port:0,observationsDir:join(root,'a'),coreStudioCatalog:catalog});
    const b = createNextStudioServer({port:0,observationsDir:join(root,'b'),coreStudioCatalog:{...catalog,list:async()=>[]}});
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
