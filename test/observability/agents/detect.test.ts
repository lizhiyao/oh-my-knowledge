import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { detectAgentInventory } from '../../../src/observability/agents/detect.js';
import type {
  AgentInventoryReport,
  DetectedAgent,
} from '../../../src/observability/agents/contracts.js';
import {
  REAL_AGENT_FS_PORTS,
  type AgentFsPorts,
} from '../../../src/observability/agents/fs-ports.js';
import { KNOWN_AGENTS } from '../../../src/observability/agents/registry.js';
import { FAKE_MTIME_MS, HOME, FakeFileSystem } from './_helpers.js';

const GENERATED_AT = '2026-05-18T10:00:00.000Z';
const FAKE_MTIME_ISO = new Date(FAKE_MTIME_MS).toISOString();

function detect(fs: FakeFileSystem, overrides: Parameters<typeof detectAgentInventory>[0] = {}): AgentInventoryReport {
  return detectAgentInventory({
    homeDirectory: fs.home,
    platform: 'darwin',
    pathDirectories: ['/usr/local/bin'],
    fsPorts: fs.ports(),
    now: () => GENERATED_AT,
    ...overrides,
  });
}

function agentOf(report: AgentInventoryReport, agentId: string): DetectedAgent {
  const found = report.agents.find((agent) => agent.agentId === agentId);
  assert.ok(found, `报告里必须有 ${agentId}`);
  return found;
}

function rootOf(agent: DetectedAgent, rootId: string) {
  const found = agent.logRoots.find((root) => root.rootId === rootId);
  assert.ok(found, `${agent.agentId} 的日志根 ${rootId} 缺失`);
  return found;
}

describe('detectAgentInventory 安装判定', () => {
  it('PATH 上解析到可执行文件即算已安装，并记录命中的具体入口', () => {
    const fs = new FakeFileSystem();
    fs.executable('/usr/local/bin/codex');

    const codex = agentOf(detect(fs), 'codex');
    assert.equal(codex.installed, true);
    assert.deepEqual(codex.evidence, [{ via: 'binary', path: '/usr/local/bin/codex' }]);
    assert.equal(codex.binaryPath, '/usr/local/bin/codex');
    // 已安装但一条日志都没有：必须仍然可见，不被静默丢弃。
    assert.equal(codex.sessionFileCount, 0);
    assert.deepEqual(codex.logRoots.map((root) => root.exists), [false, false]);
    assert.deepEqual(codex.logRoots.map((root) => root.readable), [false, false]);
  });

  it('同名不可执行文件不构成安装证据；win32 例外按平台口径处理', () => {
    const fs = new FakeFileSystem();
    fs.nonExecutable('/usr/local/bin/gemini');

    assert.equal(agentOf(detect(fs), 'gemini').installed, false);
    assert.equal(agentOf(detect(fs, { platform: 'win32' }), 'gemini').installed, true);
  });

  it('只有安装目录存在也算已安装', () => {
    const fs = new FakeFileSystem();
    fs.file(`${HOME}/.claude/projects/-repo-a/11111111-1111-1111-1111-111111111111.jsonl`, { size: 2048 });
    fs.file(`${HOME}/.claude/projects/-repo-a/subagents/22222222-2222-2222-2222-222222222222.jsonl`, { size: 1024 });

    const claude = agentOf(detect(fs), 'claude-code');
    assert.equal(claude.installed, true);
    assert.deepEqual(claude.evidence, [{ via: 'install-dir', path: `${HOME}/.claude` }]);
    assert.equal(claude.binaryPath, undefined);
    assert.equal(claude.traceSourceKind, 'claude');

    const root = rootOf(claude, 'claude-projects');
    assert.equal(root.exists, true);
    assert.equal(root.readable, true);
    assert.equal(root.sessionFileCount, 2);
    assert.equal(root.totalBytes, 3072);
    assert.equal(root.newestModifiedAt, FAKE_MTIME_ISO);
    assert.equal(root.truncated, false);
    assert.equal(claude.sessionFileCount, 2);
  });

  it('安装目录的软链接会解析真实路径，但仍要求留在主目录内', () => {
    const inside = new FakeFileSystem();
    inside.mkdir(`${HOME}/claude-native`);
    inside.symlink(`${HOME}/.local/share/claude`, `${HOME}/claude-native`);
    const byInside = agentOf(detect(inside), 'claude-code');
    assert.equal(byInside.installed, true);
    assert.ok(byInside.evidence.some((entry) => entry.path === `${HOME}/.local/share/claude`));

    const outside = new FakeFileSystem();
    outside.mkdir('/elsewhere/dsh-state');
    outside.symlink(`${HOME}/.dsh`, '/elsewhere/dsh-state');
    assert.equal(agentOf(detect(outside), 'dsh').installed, false);
  });

  it('未安装的 Agent 仍逐条登记，summary 如实汇总', () => {
    const report = detect(new FakeFileSystem());
    assert.equal(report.summary.knownAgentCount, KNOWN_AGENTS.length);
    assert.equal(report.summary.installedAgentCount, 0);
    assert.equal(report.summary.sessionFileCount, 0);
    assert.equal(report.summary.rootsWithFiles, 0);
    assert.deepEqual(report.agents.filter((agent) => agent.installed).map((agent) => agent.agentId), []);
    assert.equal(report.generatedAt, GENERATED_AT);
    assert.equal(report.homeDirectory, HOME);
    assert.equal(report.platform, 'darwin');
    assert.equal(report.schemaVersion, 'agent-inventory-v1');
  });
});

describe('detectAgentInventory 日志根扫描', () => {
  it('读不了的根整体降级为 readable:false 且计数归零，不给出半份数字', () => {
    const statFails = new FakeFileSystem();
    statFails.file(`${HOME}/.codex/sessions/2026-05-18/rollout-a.jsonl`);
    statFails.unreadableDirectory(`${HOME}/.codex/sessions`);
    const sessions = rootOf(agentOf(detect(statFails), 'codex'), 'codex-sessions');
    assert.deepEqual(
      { ...sessions, newestModifiedAt: undefined },
      {
        rootId: 'codex-sessions',
        path: `${HOME}/.codex/sessions`,
        traceSourceKind: 'codex',
        exists: true,
        readable: false,
        sessionFileCount: 0,
        totalBytes: 0,
        newestModifiedAt: undefined,
        truncated: false,
      },
    );

    const readdirFails = new FakeFileSystem();
    readdirFails.file(`${HOME}/.claude/projects/-repo-a/a.jsonl`);
    readdirFails.unlistableDirectory(`${HOME}/.claude/projects`);
    const projects = rootOf(agentOf(detect(readdirFails), 'claude-code'), 'claude-projects');
    assert.equal(projects.exists, true);
    assert.equal(projects.readable, false);
    assert.equal(projects.sessionFileCount, 0);
    assert.equal(projects.totalBytes, 0);
  });

  it('命中文件与目录上限时标记截断，计数只到上限为止', () => {
    const fs = new FakeFileSystem();
    for (const name of ['a.jsonl', 'b.jsonl', 'c.jsonl']) {
      fs.file(`${HOME}/.claude/projects/-repo-a/${name}`, { size: 10 });
    }
    const byFiles = agentOf(detect(fs, { maxSessionFilesPerRoot: 2 }), 'claude-code');
    assert.equal(rootOf(byFiles, 'claude-projects').sessionFileCount, 2);
    assert.equal(rootOf(byFiles, 'claude-projects').truncated, true);
    assert.equal(byFiles.sessionFileCount, 2);
    assert.equal(detect(fs, { maxSessionFilesPerRoot: 2 }).summary.truncatedRootCount, 1);

    const nested = new FakeFileSystem();
    nested.file(`${HOME}/.claude/projects/-repo-a/deep/a.jsonl`);
    // 根目录 + 一层子目录：只允许访问 1 个目录就会在第二层前截断。
    const byDirectories = rootOf(agentOf(detect(nested, { maxDirectoriesPerRoot: 1 }), 'claude-code'), 'claude-projects');
    assert.equal(byDirectories.truncated, true);
    assert.equal(byDirectories.sessionFileCount, 0);
  });

  it('递归扫描跳过 node_modules 与 .git，并且只统计声明过的扩展名', () => {
    const fs = new FakeFileSystem();
    fs.file(`${HOME}/.claude/projects/-repo-a/main.jsonl`);
    fs.file(`${HOME}/.claude/projects/-repo-a/subagents/nested.jsonl`);
    fs.file(`${HOME}/.claude/projects/-repo-a/node_modules/vendor.jsonl`);
    fs.file(`${HOME}/.claude/projects/-repo-a/.git/hook.jsonl`);
    fs.file(`${HOME}/.claude/projects/-repo-a/notes.md`);
    fs.file(`${HOME}/.claude/projects/-repo-a/runtime.log`);

    const claude = agentOf(detect(fs), 'claude-code');
    assert.equal(rootOf(claude, 'claude-projects').sessionFileCount, 2);
    assert.equal(claude.sessionFileCount, 2);
  });

  it('软链接不得越出日志根，根内的重复目录只算一次', () => {
    const fs = new FakeFileSystem();
    fs.file(`${HOME}/.claude/projects/-repo-a/main.jsonl`);
    fs.file('/outside/leaked.jsonl');
    fs.symlink(`${HOME}/.claude/projects/escape`, '/outside');
    assert.equal(rootOf(agentOf(detect(fs), 'claude-code'), 'claude-projects').sessionFileCount, 1);

    const linked = new FakeFileSystem();
    linked.file(`${HOME}/.claude/projects/-repo-a/main.jsonl`);
    linked.symlink(`${HOME}/.claude/projects/repo-alias`, `${HOME}/.claude/projects/-repo-a`);
    assert.equal(rootOf(agentOf(detect(linked), 'claude-code'), 'claude-projects').sessionFileCount, 1);
  });

  it('多个日志根的计数汇入同一个 Agent 与 summary', () => {
    const fs = new FakeFileSystem();
    fs.file(`${HOME}/.codex/sessions/2026-05-18/rollout-a.jsonl`, { size: 10 });
    fs.file(`${HOME}/.codex/archived_sessions/rollout-old.jsonl`, { size: 20 });
    fs.file(`${HOME}/.claude/projects/-repo-a/main.jsonl`, { size: 30 });

    const report = detect(fs);
    assert.equal(rootOf(agentOf(report, 'codex'), 'codex-archived-sessions').sessionFileCount, 1);
    assert.equal(agentOf(report, 'codex').sessionFileCount, 2);
    assert.equal(report.summary.sessionFileCount, 3);
    assert.equal(report.summary.rootsWithFiles, 3);
    assert.equal(report.summary.installedAgentCount, 2);
  });
});

describe('detectAgentInventory 能力边界', () => {
  const ALLOWED_PORT_KEYS = ['readdir', 'realpath', 'stat'] as const satisfies readonly (keyof AgentFsPorts)[];

  it('注入端口与真实端口都只暴露三个只读入口，不存在执行或读取正文的能力', () => {
    const fake = new FakeFileSystem().ports();
    assert.deepEqual(Object.keys(fake).sort(), [...ALLOWED_PORT_KEYS]);
    assert.deepEqual(Object.keys(REAL_AGENT_FS_PORTS).sort(), [...ALLOWED_PORT_KEYS]);
    for (const port of Object.values(REAL_AGENT_FS_PORTS) as unknown[]) {
      assert.equal(typeof port, 'function');
    }
    for (const key of ['exec', 'execFile', 'spawn', 'readFile', 'open', 'unlink', 'rm'] as const) {
      assert.equal((fake as unknown as Record<string, unknown>)[key], undefined, `端口不得暴露 ${key}`);
    }
  });
});
