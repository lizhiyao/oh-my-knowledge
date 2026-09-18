/**
 * 本机 Agent 视图的双语呈现：同一批落盘报告在两种语言下给出同一批事实。
 *
 * 语言是本机设置，HTTP 层不再按请求地址切换，双语差异只能在视图边界验。断言只看用户可读的
 * 措辞与数字：截断与未识别计数换语言后仍然在场，才算两种界面说的是同一件事。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  agentStorageLayout,
  saveAgentCollectionReport,
  saveAgentInventoryReport,
} from '../../../src/observability/agents/index.js';
import { buildAgentsPageModel } from '../../../src/studio/application/agents/agents-view.js';
import { AgentsView } from '../../../src/studio/web/components/agents/agents.js';
import { sampleCollectionReport, sampleInventoryReport } from '../_agents-report-fixtures.js';

const temporaryDirs: string[] = [];
let dir = '';

function tempDir(prefix: string): string {
  const created = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(created);
  return created;
}

beforeAll(() => {
  dir = tempDir('omk-agents-view-render-');
  saveAgentInventoryReport(sampleInventoryReport(), agentStorageLayout(dir));
  saveAgentCollectionReport(sampleCollectionReport(), dir);
});

afterAll(() => {
  for (const path of temporaryDirs.splice(0, temporaryDirs.length)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function render(lang: 'zh' | 'en', from = dir): string {
  const page = { pageKind: 'agents' as const, model: buildAgentsPageModel(from) };
  return renderToString(createElement(AgentsView, { page, lang }));
}

describe('本机 Agent 视图的双语呈现', () => {
  it('中文界面呈现识别计数、截断告警与未识别事件比', () => {
    const zh = render('zh');
    assert.match(zh, /<h1>本机 Agent<\/h1>/);
    assert.match(zh, /登记表 3 个 · 已安装 2 个 · 会话日志 42 份/);
    assert.match(zh, /有日志根被容量上限截断/);
    assert.match(zh, /25 \/ 100/);
    assert.match(zh, /修复登录态丢失/);
  });

  it('未识别事件按三档分别呈现，行内与汇总同源', () => {
    const zh = render('zh');
    assert.match(zh, /未支持格式 3/);
    assert.match(zh, /重复视图已忽略 20/);
    assert.match(zh, /待映射证据 2/);
    assert.match(zh, /未支持 3 · 重复视图 20 · 待映射 2/, '行内摘要要能对上同一会话的三档');
    assert.match(zh, /属于未支持的格式/, '占比告警只说未支持缺口，不拿三档总数冒充能力缺口');
    assert.ok(zh.includes('重复视图已忽略：同一条事实已被别的视图映射过'), '三档含义要写在页面上，标签名本身分不清缺口与刻意不映射');
  });

  it('英文界面读同一批事实，不丢截断与未识别计数', () => {
    const en = render('en');
    assert.match(en, /<h1>Installed agents<\/h1>/);
    assert.match(en, /3 registered · 2 installed · 42 session logs/);
    assert.match(en, /Some log roots hit a capacity ceiling/);
    assert.match(en, /25 \/ 100/);
    assert.match(en, /Unsupported format 3/);
    assert.match(en, /Duplicate view ignored 20/);
    assert.match(en, /Evidence pending mapping 2/);
    assert.match(en, /unsupported 3 · duplicate view 20 · unmapped 2/);
    assert.ok(en.includes('Duplicate view ignored: another view already carried this fact'), '英文界面同样把三档含义写在页面上');
    // 数字与标识符不随语言变：会话产物路径与产品名是同一份证据。
    assert.match(en, /traces\/codex\/trace-1\.json/);
    assert.ok(!en.includes('登记表'), '英文界面不得混入中文文案');
  });

  it('报告是旧口径时双语都只说「重新采集」，不拿旧计数继续渲染表格', () => {
    const legacyDir = tempDir('omk-agents-view-render-outdated-');
    saveAgentInventoryReport(sampleInventoryReport(), agentStorageLayout(legacyDir));
    const legacy = { ...sampleCollectionReport(), schemaVersion: 'agent-collection-v1' };
    delete (legacy as Record<string, unknown>).unknownDispositionRulesVersion;
    writeFileSync(join(legacyDir, 'collection.json'), JSON.stringify(legacy));

    const zh = render('zh', legacyDir);
    assert.match(zh, /采集报告是 agent-collection-v1 口径/);
    assert.match(render('en', legacyDir), /written in the agent-collection-v1 scheme/);
    assert.ok(!zh.includes('修复登录态丢失'), '旧口径的会话计数不再被当作本轮事实呈现');
  });

  it('两种语言都指向候选知识页，且不把语言拼进地址', () => {
    for (const lang of ['zh', 'en'] as const) {
      const html = render(lang);
      assert.match(html, /<a[^>]*href="\/knowledge\/candidates"/);
      assert.doesNotMatch(html, /href="[^"]*[?&]lang=/);
    }
  });
});
