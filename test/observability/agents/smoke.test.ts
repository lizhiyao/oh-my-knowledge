import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { globalLayout } from '../../../src/evidence/storage/layout.js';
import { AGENT_TRACE_ARTIFACT_VERSION, agentCollectionReportPath, collectAgentLogs, loadAgentCollectionReport, type AgentTraceArtifact } from '../../../src/observability/agents/collect.js';
import { detectAgentInventory } from '../../../src/observability/agents/detect.js';
import { resolveAgentCatalog } from '../../../src/observability/agents/local-catalog.js';
import { KNOWN_AGENTS } from '../../../src/observability/agents/registry.js';
import { AGENT_COLLECTION_VERSION } from '../../../src/observability/agents/contracts.js';
import { UNKNOWN_DISPOSITION_RULES_VERSION } from '../../../src/observability/trace/unknown-disposition.js';
import type { AgentCollectionReport, AgentInventoryReport } from '../../../src/observability/agents/contracts.js';
import { claudeTrace } from '../../helpers/claude-trace.js';

/**
 * 默认 smoke 使用临时 HOME、真实文件系统与生产登记表，不依赖本机 Agent 安装。
 * 真实 HOME 的检查仅由 `OMK_AGENT_SMOKE=1` 显式启用，不属于 hosted CI 证据。
 *
 * 它不替代用例，只回答一个问题——登记表与扫描口径在真实机器上是否站得住：
 * 目录结构变了、格式判错了、容量口径不合理，都会在这里以数字暴露出来。
 * 产物一律写进临时 OMK 根，绝不落 `~/.omk`，跑完即删。
 */

const ENABLED = process.env.OMK_AGENT_SMOKE === '1';
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0, tempRoots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function describeInventory(report: AgentInventoryReport): string {
  return report.agents
    .map((agent) => [
      `${agent.agentId}=${agent.installed ? '已安装' : '未安装'}`,
      `会话=${agent.sessionFileCount}`,
      agent.binaryPath ? `入口=${agent.binaryPath}` : '入口=无',
      ...agent.logRoots.map((root) => `${root.rootId}:${root.sessionFileCount}/${root.exists ? '存在' : '缺失'}${root.readable ? '' : '/不可读'}`),
    ].join(' '))
    .join('\n  ');
}

function describeCollection(report: AgentCollectionReport): string {
  return [
    `agents=${report.summary.agentCount}`,
    `discovered=${report.summary.discoveredCount}`,
    `collected=${report.summary.collectedCount}`,
    `skipped=${report.summary.skippedCount}`,
    `failed=${report.summary.failedCount}`,
    `events=${report.summary.eventCount}`,
    `unsupported=${report.summary.unknownEventCount}`,
    `duplicateViews=${report.summary.duplicateViewCount}`,
    `unmappedEvidence=${report.summary.unmappedEvidenceCount}`,
    `bytes=${Math.round(report.summary.totalBytes / (1024 * 1024))}MiB`,
    `limitations=${report.limitations.length}`,
  ].join(' ');
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out.sort();
}

describe('Agent 探测与采集 smoke（临时 HOME，默认执行）', () => {
  // 从 collect.test.ts 迁入多格式产物与增量用例，复用真实接线而非新增重复覆盖。
  it('从生产登记表发现多格式日志，归档证据后增量归零，并能补回丢失产物', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-agents-fixture-smoke-'));
    tempRoots.push(root);
    const home = join(root, 'home');
    const layout = globalLayout(join(root, 'omk'));
    const session = (path: string, content: string) => {
      const target = join(home, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return target;
    };
    const claudeA = session('.claude/projects/-repo-a/session-a.jsonl', claudeTrace('sess-a')
      .userText('解释这个仓库的分层').assistantText('结论在下面。').toJsonl());
    const claudeB = session('.claude/projects/-repo-b/session-b.jsonl', claudeTrace('sess-b')
      .userText('帮我修一个测试').assistantText('已经修复。').toJsonl());
    const codexA = session('.codex/sessions/2026-05-18/rollout-a.jsonl', [
      { type: 'session_meta', payload: { id: 'cx-a', session_id: 'cx-a', timestamp: '2026-05-18T09:00:00.000Z', cwd: '/repo-a' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"ls"}', call_id: 'c1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'AGENTS.md\nsrc\n' } },
    ].map((record) => JSON.stringify(record)).join('\n'));
    const originalBytes = [claudeA, claudeB, codexA].map((path) => readFileSync(path));
    const detect = {
      homeDirectory: home, pathDirectories: [],
      descriptors: resolveAgentCatalog({ catalogPath: layout.agentCatalogPath }),
      now: () => '2026-05-18T00:00:00.000Z',
    };
    const inventory = detectAgentInventory(detect);
    assert.equal(inventory.homeDirectory, home);
    assert.deepEqual(inventory.agents.filter((agent) => agent.installed).map((agent) => agent.agentId).sort(), ['claude-code', 'codex']);
    assert.equal(inventory.summary.sessionFileCount, 3);
    const collect = (now: string) => collectAgentLogs(inventory, { layout, detect, now: () => now });
    const first = collect('2026-05-18T11:00:00.000Z');
    assert.equal(first.schemaVersion, AGENT_COLLECTION_VERSION);
    assert.equal(first.unknownDispositionRulesVersion, UNKNOWN_DISPOSITION_RULES_VERSION);
    assert.equal(first.outputDir, layout.observeAgentsDir);
    assert.equal(first.inventoryGeneratedAt, inventory.generatedAt);
    assert.deepEqual(first.limitations, []);
    assert.deepEqual([first.summary.discoveredCount, first.summary.collectedCount, first.summary.skippedCount, first.summary.failedCount], [3, 3, 0, 0]);
    assert.deepEqual([first.summary.unknownEventCount, first.summary.duplicateViewCount, first.summary.unmappedEvidenceCount], [0, 0, 0]);
    assert.equal(first.sessions.length, 3);
    assert.deepEqual(first.agents.find((agent) => agent.agentId === 'claude-code')?.logRoots.map((logRoot) => [logRoot.rootId, logRoot.discoveredCount, logRoot.collectedCount]), [['claude-projects', 2, 2]]);
    assert.deepEqual(first.agents.find((agent) => agent.agentId === 'codex')?.logRoots.map((logRoot) => logRoot.rootId), ['codex-sessions', 'codex-archived-sessions']);
    for (const [sourcePath, sourceKind, runId] of [[claudeA, 'claude', 'sess-a'], [claudeB, 'claude', 'sess-b'], [codexA, 'codex', 'cx-a']] as const) {
      const entry = first.sessions.find((value) => value.sourcePath === sourcePath)!;
      assert.equal(entry.sourceKind, sourceKind);
      assert.equal(entry.runId, runId);
      assert.ok(entry.traceId.startsWith('trace:'));
      assert.equal(entry.contentDigest, `sha256:${createHash('sha256').update(readFileSync(sourcePath)).digest('hex')}`);
      assert.deepEqual([entry.unknownEventCount, entry.duplicateViewCount, entry.unmappedEvidenceCount], [0, 0, 0]);
      assert.match(entry.artifactPath, /^traces\/.*trace_[0-9a-f]{32}\.json$/);
      const artifact = JSON.parse(readFileSync(join(layout.observeAgentsDir, entry.artifactPath), 'utf8')) as AgentTraceArtifact;
      assert.equal(artifact.schemaVersion, AGENT_TRACE_ARTIFACT_VERSION);
      assert.equal(artifact.sourcePath, sourcePath);
      assert.equal(artifact.contentDigest, entry.contentDigest);
      assert.equal(artifact.sourceKind, sourceKind);
      assert.equal(artifact.session.traceId, entry.traceId);
      assert.equal(artifact.session.sourcePath, sourcePath);
      assert.ok(artifact.session.events.length > 0);
      assert.equal(artifact.session.events.length, entry.eventCount);
    }
    assert.equal(first.sessions.find((entry) => entry.sourcePath === claudeA)?.title, '解释这个仓库的分层');
    assert.equal(existsSync(layout.observeAgentsInventoryPath), true);
    const persistedInventory = JSON.parse(readFileSync(layout.observeAgentsInventoryPath, 'utf8')) as AgentInventoryReport;
    assert.deepEqual(persistedInventory.agents.filter((agent) => agent.installed).map((agent) => agent.agentId).sort(), ['claude-code', 'codex']);
    assert.equal(first.inventoryGeneratedAt, persistedInventory.generatedAt);
    assert.equal(existsSync(agentCollectionReportPath(layout.observeAgentsDir)), true);
    assert.deepEqual(loadAgentCollectionReport(layout.observeAgentsDir), first);
    assert.equal(loadAgentCollectionReport(join(root, 'nowhere')), undefined);
    const artifactPaths = first.sessions.map((entry) => join(layout.observeAgentsDir, entry.artifactPath));
    const artifactBytes = artifactPaths.map((path) => readFileSync(path));
    const second = collect('2026-05-18T12:00:00.000Z');
    assert.deepEqual([second.summary.collectedCount, second.summary.skippedCount, second.summary.failedCount], [0, 3, 0]);
    assert.equal(second.generatedAt, '2026-05-18T12:00:00.000Z');
    assert.deepEqual(second.limitations, []);
    assert.deepEqual(second.sessions, first.sessions);
    assert.deepEqual(artifactPaths.map((path) => readFileSync(path)), artifactBytes);
    rmSync(artifactPaths[0]);
    const third = collect('2026-05-18T13:00:00.000Z');
    assert.deepEqual([third.summary.collectedCount, third.summary.skippedCount], [1, 2]);
    assert.equal(existsSync(artifactPaths[0]), true);
    assert.deepEqual(third.sessions.map((entry) => entry.traceId).sort(), first.sessions.map((entry) => entry.traceId).sort());
    assert.deepEqual([claudeA, claudeB, codexA].map((path) => readFileSync(path)), originalBytes);
    assert.ok(listFiles(layout.root).every((path) => path.startsWith(layout.observeAgentsDir) && !path.endsWith('.tmp')));
  });
});

describe.skipIf(!ENABLED)('本机 Agent 探测与采集 smoke（真实 HOME，OMK_AGENT_SMOKE=1）', () => {
  it('真实主目录探测：登记表内的产品按事实分类，会话计数可信', () => {
    const catalog = resolveAgentCatalog();
    const extensionIds = catalog
      .filter((descriptor) => !KNOWN_AGENTS.some((entry) => entry.agentId === descriptor.agentId))
      .map((descriptor) => descriptor.agentId);
    const report = detectAgentInventory({ descriptors: catalog });
    console.info('[omk agents] 探测口径', {
      home: report.homeDirectory,
      platform: report.platform,
      extensionIds,
      summary: report.summary,
    });
    console.info('[omk agents] 逐产品:\n  ' + describeInventory(report));

    assert.equal(report.homeDirectory, resolve(homedir()), '默认主目录必须来自 os.homedir()');
    assert.equal(report.agents.length, catalog.length);
    assert.equal(report.summary.knownAgentCount, catalog.length);
    // 扩展文件只能增补或整条替换同身份条目，不能让内置条目从清单里消失。
    for (const descriptor of KNOWN_AGENTS) {
      assert.ok(report.agents.some((agent) => agent.agentId === descriptor.agentId),
        `内置条目 ${descriptor.agentId} 不在探测结果里`);
    }
    assert.ok(report.summary.installedAgentCount > 0, '这台机器上至少要有已安装的 Agent');

    // 只断言本机实际安装的产品，不把某一台机器的安装组合带给其他维护者。
    for (const agent of report.agents.filter((entry) => entry.installed)) {
      assert.ok(agent.evidence.length > 0);
      for (const root of agent.logRoots) {
        if (!root.exists) continue;
        assert.equal(root.readable, true, `${agent.agentId}/${root.rootId} 存在却读不了，要复查扫描口径`);
        assert.equal(
          root.truncated,
          false,
          `${agent.agentId}/${root.rootId} 命中了默认扫描上限，说明每根 5000 个文件的默认值在本机不成立`,
        );
      }
    }

    // 计数不能凭空而来：每个非零根至少能核对到一个真实文件。
    for (const agent of report.agents) {
      for (const root of agent.logRoots) {
        if (root.sessionFileCount === 0) continue;
        assert.equal(existsSync(root.path), true, `${root.path} 计数非零但路径不存在`);
        assert.ok(root.totalBytes >= root.sessionFileCount, `${root.rootId} 字节数与会话数不自洽`);
        assert.ok(root.newestModifiedAt === undefined || !Number.isNaN(Date.parse(root.newestModifiedAt)));
      }
    }
  });

  it('真实日志采集：投影产物、复跑增量归零，且不越出临时 OMK 根', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-agents-smoke-'));
    tempRoots.push(root);
    const layout = globalLayout(join(root, 'omk'));
    const catalog = resolveAgentCatalog();
    const inventory = detectAgentInventory({ descriptors: catalog });

    const first = collectAgentLogs(inventory, {
      layout,
      detect: { descriptors: catalog },
      now: () => '2026-05-18T00:00:00.000Z',
    });
    console.info('[omk agents] 首轮采集', describeCollection(first));
    console.info('[omk agents] limitations:', first.limitations);
    assert.ok(first.summary.collectedCount > 0, '本轮至少要采到会话');
    assert.ok(first.summary.eventCount > 0);
    assert.ok(first.sessions.length > 0);
    for (const session of first.sessions) {
      assert.equal(existsSync(session.sourcePath), true, `原始日志必须还在：${session.sourcePath}`);
      assert.equal(session.sourcePath.startsWith(inventory.homeDirectory), true, session.sourcePath);
      assert.match(session.contentDigest, /^sha256:[0-9a-f]{64}$/);
      const artifact = join(layout.observeAgentsDir, session.artifactPath);
      assert.equal(existsSync(artifact), true, artifact);
      const parsed = JSON.parse(readFileSync(artifact, 'utf-8')) as { sourcePath: string; session: { events: unknown[] } };
      assert.equal(parsed.sourcePath, session.sourcePath);
      assert.equal(parsed.session.events.length, session.eventCount);
    }

    // 产物只在临时 OMK 根里，且原子写入不留临时文件。
    const produced = listFiles(layout.root);
    assert.ok(produced.length >= first.sessions.length + 2);
    for (const path of produced) {
      assert.equal(path.startsWith(layout.observeAgentsDir), true, path);
      assert.equal(path.endsWith('.tmp'), false, `残留临时文件：${path}`);
    }
    assert.equal(existsSync(join(layout.observeAgentsDir, 'collection.json')), true);
    assert.equal(existsSync(layout.observeAgentsInventoryPath), true);

    const firstArtifacts = new Map(
      first.sessions.map((session) => [session.sourcePath, readFileSync(join(layout.observeAgentsDir, session.artifactPath))]),
    );
    // 复跑之前先固定「这一批里哪些源文件真的没再动」：本机主目录仍在产生会话，
    // 仍在被写入的文件被重采是正确行为，不能拿它当增量失效的证据。
    const unchanged = first.sessions.filter((session) => {
      const stats = statSync(session.sourcePath);
      return stats.size === session.sizeBytes && stats.mtime.toISOString() === session.modifiedAt;
    });

    const second = collectAgentLogs(inventory, {
      layout,
      detect: { descriptors: catalog },
      now: () => '2026-05-18T01:00:00.000Z',
    });
    console.info('[omk agents] 复跑采集', describeCollection(second), '未变源文件 =', unchanged.length);
    assert.ok(
      second.summary.skippedCount >= unchanged.length,
      `未变化的文件不得重新解析：skipped=${second.summary.skippedCount} vs 未变=${unchanged.length}`,
    );
    assert.ok(unchanged.length > 0, '本机至少要真正核对到一条未变化的条目');
    for (const session of unchanged) {
      const again = second.sessions.find((entry) => entry.sourcePath === session.sourcePath);
      assert.deepEqual(again, session, `${session.sourcePath} 的索引条目不应在复跑中改变`);
      assert.deepEqual(
        readFileSync(join(layout.observeAgentsDir, session.artifactPath)),
        firstArtifacts.get(session.sourcePath),
        `${session.sourcePath} 的产物不应被复跑改写`,
      );
    }
    assert.ok(second.sessions.length >= first.sessions.length);
    assert.equal(existsSync(join(root, 'omk', 'observe', 'agents', 'traces')), true);
  });
});
