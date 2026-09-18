/**
 * `omk agents` 与本机登记表扩展的接线验收。
 *
 * 领域用例已经证明加载与合并口径正确；这里只回答另一件事：命令入口是否真的把
 * 「内置表 + 扩展文件」交给探测与采集。漏传一处，扩展条目会静默不出现在清单里，
 * 而这正是这台机器上唯一能发现它的地方。用例把 HOME 与 OMK_HOME 都指到临时目录，
 * 不读用户真实的 `~/.oh-my-knowledge/agents.json`。
 */

import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, runCliFailing } from '../helpers/cli-process.js';
import { AGENT_CATALOG_VERSION } from '../../src/observability/agents/contracts.js';
import type { AgentInventoryReport } from '../../src/observability/agents/contracts.js';

const tempRoots: string[] = [];

afterEach(() => {
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
