/**
 * 本机 Agent 视图的双语呈现：同一批落盘报告在两种语言下给出同一批事实。
 *
 * 语言是本机设置，HTTP 层不再按请求地址切换，双语差异只能在视图边界验。断言只看用户可读的
 * 措辞与数字：截断与未识别计数换语言后仍然在场，才算两种界面说的是同一件事。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'omk-agents-view-render-'));
  saveAgentInventoryReport(sampleInventoryReport(), agentStorageLayout(dir));
  saveAgentCollectionReport(sampleCollectionReport(), dir);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function render(lang: 'zh' | 'en'): string {
  const page = { pageKind: 'agents' as const, model: buildAgentsPageModel(dir) };
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

  it('英文界面读同一批事实，不丢截断与未识别计数', () => {
    const en = render('en');
    assert.match(en, /<h1>Installed agents<\/h1>/);
    assert.match(en, /3 registered · 2 installed · 42 session logs/);
    assert.match(en, /Some log roots hit a capacity ceiling/);
    assert.match(en, /25 \/ 100/);
    // 数字与标识符不随语言变：会话产物路径与产品名是同一份证据。
    assert.match(en, /traces\/codex\/trace-1\.json/);
    assert.ok(!en.includes('登记表'), '英文界面不得混入中文文案');
  });

  it('两种语言都指向候选知识页，且不把语言拼进地址', () => {
    for (const lang of ['zh', 'en'] as const) {
      const html = render(lang);
      assert.match(html, /<a[^>]*href="\/knowledge\/candidates"/);
      assert.doesNotMatch(html, /href="[^"]*[?&]lang=/);
    }
  });
});
