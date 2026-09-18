/**
 * 本机 Agent 页面投影：把盘上的两份报告读成四种状态，并且互不牵连。
 *
 * 立在这里的理由是用户在页面上读到的「没有记录」「记录读不动」「记录是旧口径」必须是三件事：
 * 前者说明还没跑过命令，中者说明报告本身坏了，后者说明报告读得懂但计数口径已被取代、只需要
 * 重新采集——把后两者降级成空列表等于谎报本机什么都没装。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { agentStorageLayout, saveAgentCollectionReport, saveAgentInventoryReport } from '../../../src/observability/agents/index.js';
import { buildAgentsPageModel } from '../../../src/studio/application/agents/agents-view.js';
import { sampleCollectionReport, sampleInventoryReport } from '../_agents-report-fixtures.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omk-agents-view-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('本机 Agent 页面投影', () => {
  it('两份报告都在场时按原样投影，并给出页面要展示的落盘位置', () => {
    saveAgentInventoryReport(sampleInventoryReport(), agentStorageLayout(dir));
    saveAgentCollectionReport(sampleCollectionReport(), dir);

    const model = buildAgentsPageModel(dir);
    assert.equal(model.layout.observeAgentsInventoryPath, join(dir, 'inventory.json'));
    assert.equal(model.inventory.status, 'ready');
    assert.equal(model.collection.status, 'ready');
    if (model.inventory.status !== 'ready' || model.collection.status !== 'ready') return;
    assert.equal(model.inventory.report.summary.installedAgentCount, 2);
    assert.equal(model.collection.report.sessions.length, 2);
    // 投影不改写报告内容：页面读到的是 CLI 写下的那份事实，包括截断与限制。
    assert.equal(model.inventory.report.agents[2]?.logRoots[0]?.truncated, true);
    assert.deepEqual(model.collection.report.limitations, sampleCollectionReport().limitations);
  });

  it('目录存在但两份报告都没有时，呈现「还没跑过」而不是空列表', () => {
    const model = buildAgentsPageModel(dir);
    assert.equal(model.inventory.status, 'missing');
    assert.equal(model.collection.status, 'missing');
  });

  it('识别报告读不动时只坏它自己，采集结果照常可读', () => {
    saveAgentCollectionReport(sampleCollectionReport(), dir);
    writeFileSync(join(dir, 'inventory.json'), '{"schemaVersion":"agent-inventory-v1"');

    const model = buildAgentsPageModel(dir);
    assert.equal(model.inventory.status, 'unreadable');
    assert.equal(model.collection.status, 'ready');
  });

  it('采集报告不符合契约时判为读不动，不拿字段缺失的对象继续渲染', () => {
    saveAgentInventoryReport(sampleInventoryReport(), agentStorageLayout(dir));
    writeFileSync(join(dir, 'collection.json'), JSON.stringify({ ...sampleCollectionReport(), schemaVersion: 'agent-collection-v0' }));

    const model = buildAgentsPageModel(dir);
    assert.equal(model.inventory.status, 'ready');
    assert.equal(model.collection.status, 'unreadable');
  });

  it('报告读得懂但口径已被取代时判为过期，页面给「重新采集」而不是「文件坏了」', () => {
    saveAgentInventoryReport(sampleInventoryReport(), agentStorageLayout(dir));
    const legacy = { ...sampleCollectionReport(), schemaVersion: 'agent-collection-v1' };
    delete (legacy as Record<string, unknown>).unknownDispositionRulesVersion;
    writeFileSync(join(dir, 'collection.json'), JSON.stringify(legacy));

    const outdated = buildAgentsPageModel(dir);
    assert.equal(outdated.inventory.status, 'ready');
    assert.deepEqual(outdated.collection, { status: 'outdated', foundVersion: 'agent-collection-v1' });

    writeFileSync(
      join(dir, 'collection.json'),
      JSON.stringify({ ...sampleCollectionReport(), unknownDispositionRulesVersion: 'unknown-disposition-v0' }),
    );
    assert.deepEqual(buildAgentsPageModel(dir).collection, {
      status: 'outdated',
      foundVersion: 'unknown-disposition-v0',
    }, '分桶口径表更新后旧计数同样不可信');
  });
});
