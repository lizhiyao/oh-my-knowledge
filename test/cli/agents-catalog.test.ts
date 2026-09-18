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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, runCliFailing } from '../helpers/cli-process.js';
import { UNKNOWN_DISPOSITION_RULES_VERSION } from '../../src/observability/trace/unknown-disposition.js';
import {
  AGENT_CATALOG_VERSION,
  AGENT_COLLECTION_VERSION,
  type AgentCollectionReport,
  type AgentInventoryReport,
} from '../../src/observability/agents/contracts.js';

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
  });

  it('extract 遇到已被取代的采集报告时停在「重新采集」，不走到执行器', async () => {
    const sandbox = createSandbox(catalogJson([SIBLING]));
    mkdirSync(sandbox.outDir, { recursive: true });
    writeFileSync(join(sandbox.outDir, 'collection.json'), JSON.stringify({ schemaVersion: 'agent-collection-v1' }));

    const chinese = await runCliFailing(['agents', 'extract', '--session', 'trace-1', '--dir', sandbox.outDir], 1, {
      env: sandbox.env,
      cwd: sandbox.home,
    });
    assert.match(`${chinese.stdout}${chinese.stderr}`, /采集报告是 agent-collection-v1 口径/);

    const english = await runCliFailing(
      ['agents', 'extract', '--session', 'trace-1', '--lang', 'en', '--dir', sandbox.outDir],
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
