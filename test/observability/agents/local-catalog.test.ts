import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_CATALOG_VERSION,
  type AgentDescriptor,
} from '../../../src/observability/agents/contracts.js';
import {
  loadLocalAgentCatalog,
  mergeAgentCatalog,
  resolveAgentCatalog,
} from '../../../src/observability/agents/local-catalog.js';
import { KNOWN_AGENTS, findAgentDescriptor } from '../../../src/observability/agents/registry.js';

/**
 * 本机登记表扩展用例：全部落在显式临时目录里，绝不读用户真实的 `<OMK_HOME>/agents.json`。
 *
 * 用例只认三种结果——没有文件（内置表继续）、有合法条目（按身份合并）、文件不合法（抛错并点名路径）。
 * 「不合法却继续」是最坏结果：清单会静默少一个宿主，使用者以为本机没装。
 */

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0, tempRoots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function catalogFile(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'omk-agent-catalog-'));
  tempRoots.push(root);
  const path = join(root, 'agents.json');
  writeFileSync(path, contents);
  return path;
}

/** 一个确定不存在的扩展文件路径，临时根仍由 afterEach 清理。 */
function missingCatalogPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'omk-agent-catalog-'));
  tempRoots.push(root);
  return join(root, 'agents.json');
}

function catalogPathWith(contents: unknown): string {
  return catalogFile(JSON.stringify(contents));
}

function entry(overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, 'agentId'>): AgentDescriptor {
  return {
    displayName: `${overrides.agentId} host`,
    vendor: 'unknown',
    traceSourceKind: 'claude',
    binaries: [],
    installDirs: [`.${overrides.agentId}`],
    logRoots: [
      {
        rootId: `${overrides.agentId}-projects`,
        relativePath: `.${overrides.agentId}/projects`,
        traceSourceKind: 'claude',
        matchExtensions: ['.jsonl'],
        recursive: true,
      },
    ],
    ...overrides,
  };
}

function catalogOf(agents: readonly unknown[]): unknown {
  return { schemaVersion: AGENT_CATALOG_VERSION, agents };
}

function ids(descriptors: readonly AgentDescriptor[]): string[] {
  return descriptors.map((descriptor) => descriptor.agentId);
}

describe('loadLocalAgentCatalog 缺失与不合法', () => {
  it('文件不存在是「没有扩展条目」，内置登记表照常工作', () => {
    const path = missingCatalogPath();
    const loaded = loadLocalAgentCatalog({ catalogPath: path });
    assert.equal(loaded.present, false);
    assert.deepEqual(loaded.descriptors, []);
    assert.deepEqual(resolveAgentCatalog({ catalogPath: path }), [...KNOWN_AGENTS]);
  });

  it('空 agents 是合法声明，不额外造条目', () => {
    const loaded = loadLocalAgentCatalog({ catalogPath: catalogFile(JSON.stringify(catalogOf([]))) });
    assert.equal(loaded.present, true);
    assert.deepEqual(loaded.descriptors, []);
  });

  it('畸形 JSON、版本不符与多余键都抛错并点名文件路径', () => {
    const cases: readonly string[] = [
      '{ not json',
      JSON.stringify({ schemaVersion: 'agent-catalog-v0', agents: [] }),
      JSON.stringify({ schemaVersion: AGENT_CATALOG_VERSION, agents: [], extraKey: true }),
      JSON.stringify({ schemaVersion: AGENT_CATALOG_VERSION, agents: [{ agentId: 'no-roots' }] }),
    ];
    for (const contents of cases) {
      const path = catalogFile(contents);
      assert.throws(
        () => loadLocalAgentCatalog({ catalogPath: path }),
        (error: unknown) => error instanceof Error && error.message.includes(path),
        `本应失败：${contents}`,
      );
    }
  });

  it('文件存在却读不了（这里是目录占位）不当成「没有扩展条目」', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-agent-catalog-'));
    tempRoots.push(root);
    const path = join(root, 'agents.json');
    mkdirSync(path);
    assert.throws(
      () => loadLocalAgentCatalog({ catalogPath: path }),
      (error: unknown) => error instanceof Error && error.message.includes(path),
    );
  });

  it('绝对路径与越出主目录的相对段都 fail-closed，错误里说清是哪一条', () => {
    for (const relativePath of ['/var/log/agents', '../outside', '.good/../escape']) {
      const path = catalogPathWith(catalogOf([
        entry({ agentId: 'escapee', installDirs: [relativePath] }),
      ]));
      assert.throws(
        () => loadLocalAgentCatalog({ catalogPath: path }),
        (error: unknown) => error instanceof Error && error.message.includes('escapee') && error.message.includes(path),
        relativePath,
      );
    }
  });

  it('同一文件里重复声明同一身份时抛错，不留下「哪条算数」的歧义', () => {
    const path = catalogPathWith(catalogOf([entry({ agentId: 'twice' }), entry({ agentId: 'twice' })]));
    assert.throws(
      () => loadLocalAgentCatalog({ catalogPath: path }),
      (error: unknown) => error instanceof Error && error.message.includes('twice'),
    );
  });
});

describe('mergeAgentCatalog 与 resolveAgentCatalog', () => {
  it('新身份追加在内置条目之后，产品身份与格式归属仍分开表达', () => {
    const path = catalogPathWith(catalogOf([entry({ agentId: 'sibling-host' })]));
    const catalog = resolveAgentCatalog({ catalogPath: path });
    assert.deepEqual(catalog.slice(0, KNOWN_AGENTS.length).map((descriptor) => descriptor.agentId), ids(KNOWN_AGENTS));
    assert.equal(catalog[catalog.length - 1].agentId, 'sibling-host');
    const sibling = findAgentDescriptor(catalog, 'sibling-host') as AgentDescriptor;
    assert.equal(sibling.traceSourceKind, 'claude');
    assert.deepEqual(sibling.logRoots.map((root) => root.relativePath), ['.sibling-host/projects']);
  });

  it('同身份的扩展条目整条替换内置条目并保留原位置，不做字段级合并', () => {
    const builtIn = [entry({ agentId: 'host-a', installDirs: ['.built-in'] }), entry({ agentId: 'host-b' })];
    const override = entry({ agentId: 'host-a', logRoots: [] });
    const merged = mergeAgentCatalog(builtIn, [override]);
    assert.deepEqual(ids(merged), ['host-a', 'host-b']);
    assert.equal(findAgentDescriptor(merged, 'host-a'), override);
    assert.deepEqual(findAgentDescriptor(merged, 'host-a')?.logRoots, []);
  });

  it('没有扩展条目时返回内置表的副本，调用方改动不会污染模块级常量', () => {
    const resolved = resolveAgentCatalog({ catalogPath: missingCatalogPath() });
    assert.notEqual(resolved, KNOWN_AGENTS);
    resolved.push(entry({ agentId: 'mutated' }));
    assert.equal(findAgentDescriptor(KNOWN_AGENTS, 'mutated'), undefined);
  });
});
