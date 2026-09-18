import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { globalLayout } from '../../../src/evidence/storage/layout.js';
import { collectAgentLogs } from '../../../src/observability/agents/collect.js';
import { detectAgentInventory } from '../../../src/observability/agents/detect.js';
import { resolveAgentCatalog } from '../../../src/observability/agents/local-catalog.js';
import { KNOWN_AGENTS } from '../../../src/observability/agents/registry.js';
import type { AgentCollectionReport, AgentInventoryReport } from '../../../src/observability/agents/contracts.js';

/**
 * 真机 smoke：默认跳过，只有 `OMK_AGENT_SMOKE=1` 时才跑。
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

function agentOf(report: AgentInventoryReport, agentId: string) {
  const agent = report.agents.find((entry) => entry.agentId === agentId);
  assert.ok(agent, `登记表里应当有 ${agentId}`);
  return agent;
}

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
    `unknownEvents=${report.summary.unknownEventCount}`,
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

describe.skipIf(!ENABLED)('本机 Agent 探测与采集 smoke（OMK_AGENT_SMOKE=1）', () => {
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

    // 内置表里本机真正在用的产品：安装事实 + 非零会话计数。
    for (const agentId of ['codex', 'claude-code', 'qoder-cn']) {
      const agent = agentOf(report, agentId);
      assert.equal(agent.installed, true, `${agentId} 应当被判为已安装：${JSON.stringify(agent.evidence)}`);
      assert.ok(agent.evidence.length > 0);
      assert.ok(agent.sessionFileCount > 0, `${agentId} 的会话计数应大于 0，实际 ${agent.sessionFileCount}`);
      for (const root of agent.logRoots) {
        if (!root.exists) continue;
        assert.equal(root.readable, true, `${agentId}/${root.rootId} 存在却读不了，要复查扫描口径`);
        assert.equal(
          root.truncated,
          false,
          `${agentId}/${root.rootId} 命中了默认扫描上限，说明每根 5000 个文件的默认值在本机不成立`,
        );
      }
    }

    // Qoder 国际版本机只留了 projects/memory，没有会话文件：只断言安装事实。
    const qoder = agentOf(report, 'qoder');
    assert.equal(qoder.installed, true);
    console.info('[omk agents] qoder 会话计数 =', qoder.sessionFileCount, '（0 表示该产品本机没有会话日志，不是漏扫）');

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
