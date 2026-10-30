/**
 * `omk agents` 与本机登记表扩展的接线验收。
 *
 * 领域用例已经证明加载与合并口径正确；这里只回答另一件事：命令入口是否真的把
 * 「内置表 + 扩展文件」交给探测与采集。漏传一处，扩展条目会静默不出现在清单里，
 * 而这正是这台机器上唯一能发现它的地方。用例把 HOME 与 OMK_HOME 都指到临时目录，
 * 不读用户真实的 `~/.oh-my-knowledge/agents.json`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, runCliFailing } from '../helpers/cli-process.js';
import { authoredKnowledgeResponse } from './knowledge-fixtures.js';
import { runCommand } from '../helpers/run-command.js';
import AgentsCommand from '../../src/cli/commands/agents.js';
import { createExtractionArchiveProducer } from '../../src/executors/archive.js';
import * as generationHost from '../../src/knowledge/adapters/generation-host.js';
import type { KnowledgeGenerationModel } from '../../src/knowledge/adapters/generation-executor.js';
import { SOURCE_CAPTURE_MAX_SELECTED_BYTES } from '../../src/knowledge/application/source-capture.js';
import { AgentDescriptorSchema, agentStorageLayout, collectAgentLogs } from '../../src/observability/agents/index.js';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { UNKNOWN_DISPOSITION_RULES_VERSION } from '../../src/observability/trace/unknown-disposition.js';
import {
  AGENT_CATALOG_VERSION,
  AGENT_COLLECTION_VERSION,
  type AgentCollectionReport,
  type AgentInventoryReport,
} from '../../src/observability/agents/contracts.js';

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of tempRoots.splice(0, tempRoots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Sandbox {
  readonly home: string;
  readonly omkHome: string;
  readonly outDir: string;
  readonly env: NodeJS.ProcessEnv;
}

/** 造一个只有 `sibling-host` 装着的隔离主目录：扩展文件声明它，安装目录与日志根都在临时 HOME 下。 */
function createSandbox(contents: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'omk-cli-agents-'));
  tempRoots.push(root);
  const home = join(root, 'home');
  const omkHome = join(home, '.oh-my-knowledge');
  mkdirSync(join(omkHome), { recursive: true });
  mkdirSync(join(home, '.sibling-host', 'projects', '-repo-a'), { recursive: true });
  writeFileSync(join(home, '.sibling-host', 'projects', '-repo-a', 'session-a.jsonl'), '{"type":"user"}\n');
  writeFileSync(join(omkHome, 'agents.json'), contents);
  return {
    home,
    omkHome,
    outDir: join(root, 'out'),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OMK_HOME: omkHome,
      PATH: '',
      OMK_SKIP_UPDATE_CHECK: '1',
    },
  };
}

function catalogJson(agents: unknown[]): string {
  return JSON.stringify({ schemaVersion: AGENT_CATALOG_VERSION, agents });
}

const SIBLING = {
  agentId: 'sibling-host',
  displayName: 'Sibling Host',
  vendor: 'unknown',
  traceSourceKind: 'claude',
  binaries: [],
  installDirs: ['.sibling-host'],
  logRoots: [
    {
      rootId: 'sibling-projects',
      relativePath: '.sibling-host/projects',
      traceSourceKind: 'claude',
      matchExtensions: ['.jsonl'],
      recursive: true,
    },
  ],
};

describe('omk agents 与本机登记表扩展', () => {
  it('extract saves an explicit original record range and prepares the full Source3 request without dispatch', async () => {
    const sandbox = createSandbox(catalogJson([SIBLING]));
    const path = join(sandbox.home, '.sibling-host', 'projects', '-repo-a', 'session-a.jsonl');
    const message = (text: string, uuid: string) => ({ type: 'user', uuid, sessionId: 'session-a',
      message: { role: 'user', content: text } });
    const selectedRaw = JSON.stringify(message('Alpha 使用 Beta', 'u2'));
    writeFileSync(path, [JSON.stringify(message('中'.repeat(Math.ceil(SOURCE_CAPTURE_MAX_SELECTED_BYTES / 3)), 'u1')), selectedRaw].join('\n'));
    const invoke = vi.fn<KnowledgeGenerationModel['invoke']>(async () => { throw new Error('Preparation must never dispatch a model.'); });
    const inspect = vi.fn<KnowledgeGenerationModel['inspect']>(() => ({ producerId: 'authored-agents-host', producerRevision: 'fixture-v1', sourceChannels: [],
      maxOutcomeJsonBytes: 1024 * 1024, proof: { synthetic: true } }));
    const model: KnowledgeGenerationModel = { executor: 'codex', model: 'fixture', timeoutMs: 300_000, inspect, invoke };
    const factory = vi.spyOn(generationHost, 'createLocalKnowledgeGenerationModel').mockReturnValue(model);
    const options = { env: sandbox.env, cwd: sandbox.home };
    // The collector has an explicit fixture home/catalog; this test exercises source commands without stale dist.
    const report = collectAgentLogs(undefined, { layout: agentStorageLayout(sandbox.outDir),
      detect: { homeDirectory: sandbox.home, pathDirectories: [], descriptors: [AgentDescriptorSchema.parse(SIBLING)] } });
    assert.ok(report.sessions.length, JSON.stringify(report));
    const workspace = join(sandbox.home, 'knowledge');
    const args = ['extract', '--session', report.sessions[0].runId, '--dir', sandbox.outDir, '--knowledge', workspace, '--executor', 'codex', '--model', 'fixture', '--json'];
    for (const values of [['list', '--generation-policy', '{}'], [...args, '--generation-policy', '{invalid'], [...args, '--generation-policy', '{}']]) {
      await expect(runCommand(AgentsCommand, values, options)).rejects.toMatchObject({ code: 2 });
    }
    for (const values of [args, [...args, '--start-record', '0'], [...args, '--end-record', '1']]) {
      await expect(runCommand(AgentsCommand, values, options)).rejects.toMatchObject({ code: 2, message: expect.stringContaining('--start-record') });
    }
    await expect(runCommand(AgentsCommand, [...args, '--start-record', '2', '--end-record', '1'], options)).rejects.toMatchObject({ code: 2 });
    expect(existsSync(workspace)).toBe(false);
    await expect(runCommand(AgentsCommand, [...args, '--start-record', '0', '--end-record', '1'], options))
      .rejects.toMatchObject({ code: 1, message: expect.stringContaining('knowledge_capacity_exceeded') });
    expect(factory).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled(); expect(existsSync(workspace)).toBe(false);
    const selectedArgs = [...args, '--start-record', '1', '--end-record', '1'];
    const result = JSON.parse((await runCommand(AgentsCommand, selectedArgs, options)).stdout);
    expect(result.preview.items[0]).toMatchObject({ resolvedSelection: { sourceKind: 'agent_trace', sourceId: report.sessions[0].runId,
      traceKind: 'claude', recordRanges: [{ startRecord: 1, endRecord: 1 }] }, retainedUnits: [{ text: selectedRaw, coordinate: { recordIndex: 1 } }] });
    expect(result.capture).toMatchObject({ sendAuthorization: 'not_granted', saveManifest: { items: [{ reused: false }] } });
    expect(result.sources).toEqual(result.capture.saveManifest.items.map(({ snapshotId, sourceVersion }: { snapshotId: string; sourceVersion: string }) => ({ snapshotId, sourceVersion })));
    expect(result.generationInput).toEqual({ sources: result.sources }); expect(result.modelCalls).toBe(0);
    expect(result.prepared.journal).toMatchObject({ schemaVersion: 4, workflowId: 'knowledge-body-first/v4', status: 'active', bodies: [],
      sources: result.sources.map((source: unknown) => expect.objectContaining(source)), stages: [{ stageKind: 'source_ledger', state: 'prepared' }] });
    const stage = result.prepared.journal.stages[0];
    expect(stage.input).toContain('Alpha 使用 Beta'); expect(stage.input).not.toContain('中'); expect(stage.system.length).toBeGreaterThan(0);
    // A collection display title comes from a message; it is not an original trace title.
    expect(result.capture.sources[0].snapshot.origin).toBeUndefined();
    expect(result.nextCommand).toContain('omk observe knowledge continue-stage');
    expect(result.nextCommand).toContain(`--workspace ${workspace}`); expect(result.nextCommand).toContain(`--id ${result.prepared.journal.runId}`);
    expect(result.nextCommand).toContain(`--generation ${result.prepared.journal.generation}`);
    expect(result.nextCommand).toContain(`--confirm-request ${stage.requestDigest}`);
    expect(factory).toHaveBeenCalledExactlyOnceWith('codex', 'fixture', createExtractionArchiveProducer);
    expect(inspect).toHaveBeenCalledOnce(); expect(invoke).not.toHaveBeenCalled();
    const app = createLocalKnowledgeApplication(workspace);
    expect(app.runs().current.find(run => run.runId === result.prepared.journal.runId)).toEqual(result.prepared.journal);
    expect(app.inspect(result.prepared.journal.runId).nativeOutcomes.every(stage => stage.outcome === undefined)).toBe(true);
    expect(existsSync(join(workspace, 'generation-journals', 'outcomes'))).toBe(false);
    const replay = JSON.parse((await runCommand(AgentsCommand, selectedArgs, options)).stdout);
    expect(replay.sources).toEqual(result.sources); expect(replay.capture.saveManifest).toMatchObject({ actualWrittenBytes: 0, items: [{ reused: true }] });
    expect(replay.prepared).toEqual(result.prepared); expect(invoke).not.toHaveBeenCalled(); expect(inspect).toHaveBeenCalledOnce();
    const text = await runCommand(AgentsCommand, selectedArgs.filter(arg => arg !== '--json'), options);
    expect(text.stdout).toContain(JSON.stringify(stage.system)); expect(text.stdout).toContain(stage.requestDigest);
    expect(text.stderr).toContain(result.nextCommand); expect(text.stdout).not.toContain('提炼完成'); expect(invoke).not.toHaveBeenCalled();
    invoke.mockImplementation(async (profile, input, _signal, gate) => {
      gate?.(); return { outcomeKind: 'result', result: { ok: true, output: JSON.stringify(authoredKnowledgeResponse(input, profile.stageKind)), authoredFixture: true } };
    });
    const saved = await app.continueStage(result.prepared.journal.runId, result.prepared.journal.generation, model, undefined, { confirmedRequestDigest: stage.requestDigest });
    expect(saved.nextAction).toBe('prepare_next_stage');
    const bodyPrepared = JSON.parse((await runCommand(AgentsCommand, selectedArgs, options)).stdout);
    expect(bodyPrepared.prepared.journal.stages.map((phase: { stageKind: string; state: string }) => [phase.stageKind, phase.state]))
      .toEqual([['source_ledger', 'completed'], ['body', 'prepared']]);
    expect(bodyPrepared.nextCommand).toContain('omk observe knowledge continue-stage');
    expect(bodyPrepared.nextCommand).toContain(`--generation ${bodyPrepared.prepared.journal.generation}`);
    expect(bodyPrepared.nextCommand).not.toContain('knowledge generate'); expect(invoke).toHaveBeenCalledOnce();

  });
  it('list 把扩展条目当成本机登记表的一部分，并按同一身份与日志根计数', async () => {
    const sandbox = createSandbox(catalogJson([SIBLING]));

    const { stdout } = await runCli(
      ['agents', 'list', '--json', '--dir', sandbox.outDir],
      { env: sandbox.env, cwd: sandbox.home },
    );
    const report = JSON.parse(stdout) as AgentInventoryReport;
    const sibling = report.agents.find((agent) => agent.agentId === 'sibling-host');
    assert.ok(sibling, `清单里应当有扩展条目：${report.agents.map((agent) => agent.agentId).join('、')}`);
    assert.equal(sibling.installed, true);
    assert.equal(sibling.sessionFileCount, 1);
    assert.deepEqual(sibling.logRoots.map((root) => [root.rootId, root.sessionFileCount]), [['sibling-projects', 1]]);
    assert.equal(report.summary.knownAgentCount, report.agents.length);
  });

  it('collect 的三档计数在落盘报告与人读摘要里是同一批数字', async () => {
    const sandbox = createSandbox(catalogJson([SIBLING]));

    const chinese = await runCli(['agents', 'collect', '--dir', sandbox.outDir], {
      env: sandbox.env,
      cwd: sandbox.home,
    });
    const report = JSON.parse(readFileSync(join(sandbox.outDir, 'collection.json'), 'utf-8')) as AgentCollectionReport;
    assert.equal(report.schemaVersion, AGENT_COLLECTION_VERSION);
    assert.equal(report.unknownDispositionRulesVersion, UNKNOWN_DISPOSITION_RULES_VERSION);
    const { unknownEventCount, duplicateViewCount, unmappedEvidenceCount } = report.summary;
    assert.ok(
      unknownEventCount + duplicateViewCount + unmappedEvidenceCount > 0,
      '读不出的日志格式必须落在某一档，不能静默归零',
    );
    assert.equal(
      unknownEventCount > 0,
      true,
      '登记表说得出格式、适配器读不出时算支持缺口，不冒充「刻意不映射」',
    );
    const summary = `${chinese.stdout}${chinese.stderr}`;
    assert.match(
      summary,
      new RegExp(`未支持格式 ${unknownEventCount} · 重复视图 ${duplicateViewCount} · 待映射证据 ${unmappedEvidenceCount}`),
      summary,
    );

    // 增量沿用旧条目时三档计数要跟着一起留下。
    const english = await runCli(['agents', 'collect', '--lang', 'en', '--dir', sandbox.outDir], {
      env: sandbox.env,
      cwd: sandbox.home,
    });
    assert.match(
      `${english.stdout}${english.stderr}`,
      new RegExp(`${unknownEventCount} unsupported format · ${duplicateViewCount} duplicate views · ${unmappedEvidenceCount} unmapped evidence`),
    );
    const reread = JSON.parse(readFileSync(join(sandbox.outDir, 'collection.json'), 'utf-8')) as AgentCollectionReport;
    assert.equal(reread.summary.collectedCount, 0, '第二轮应当走增量');
    assert.deepEqual(
      [
        reread.summary.unknownEventCount,
        reread.summary.duplicateViewCount,
        reread.summary.unmappedEvidenceCount,
      ],
      [unknownEventCount, duplicateViewCount, unmappedEvidenceCount],
      '沿用旧条目时分桶计数必须原样保留',
    );
    const workspace = join(sandbox.home, 'knowledge');
    const invalid = await runCliFailing([
      'agents', 'extract', '--session', report.sessions[0].runId,
      '--dir', sandbox.outDir, '--knowledge', workspace, '--start-record', '0', '--end-record', '0',
    ], 2, { env: { ...sandbox.env, OMK_MODEL: '' }, cwd: sandbox.home });
    assert.match(invalid.stderr, /--model/);
    assert.equal(existsSync(workspace), false, '缺少模型时不能先创建工作区或归档来源');
  });

  it('extract 遇到已被取代的采集报告时停在「重新采集」，不走到执行器', async () => {
    const sandbox = createSandbox(catalogJson([SIBLING]));
    mkdirSync(sandbox.outDir, { recursive: true });
    writeFileSync(join(sandbox.outDir, 'collection.json'), JSON.stringify({ schemaVersion: 'agent-collection-v1' }));

    const chinese = await runCliFailing(['agents', 'extract', '--session', 'trace-1', '--dir', sandbox.outDir, '--start-record', '0', '--end-record', '0'], 1, {
      env: sandbox.env,
      cwd: sandbox.home,
    });
    assert.match(`${chinese.stdout}${chinese.stderr}`, /采集报告是 agent-collection-v1 口径/);

    const english = await runCliFailing(
      ['agents', 'extract', '--session', 'trace-1', '--lang', 'en', '--dir', sandbox.outDir, '--start-record', '0', '--end-record', '0'],
      1,
      { env: sandbox.env, cwd: sandbox.home },
    );
    assert.match(`${english.stdout}${english.stderr}`, /superseded agent-collection-v1 scheme/);
  });

  it('扩展文件不合法时以业务失败退出，并点名要修的文件', async () => {
    const sandbox = createSandbox('{ oops');

    const failure = await runCliFailing(['agents', 'list', '--dir', sandbox.outDir], 1, {
      env: sandbox.env,
      cwd: sandbox.home,
    });
    const message = `${failure.stdout}${failure.stderr}`;
    assert.match(message, /登记表|catalog/);
    assert.ok(message.includes(join(sandbox.omkHome, 'agents.json')), message);
  });
});
