/**
 * 本机 Agent 页面的报告夹具：只构造符合 `observability/agents/contracts.ts` 的公开契约的对象，
 * 不从内部模块借用私有助手——页面读取的是落盘契约，夹具就必须按同一份契约写盘。
 */

import type {
  AgentCollectionReport,
  AgentInventoryReport,
} from '../../src/observability/agents/index.js';

export function sampleInventoryReport(overrides: Partial<AgentInventoryReport> = {}): AgentInventoryReport {
  return {
    schemaVersion: 'agent-inventory-v1',
    generatedAt: '2026-09-11T14:54:30.000Z',
    platform: 'darwin',
    homeDirectory: '/Users/tester',
    agents: [
      {
        agentId: 'codex',
        displayName: 'Codex',
        vendor: 'OpenAI',
        traceSourceKind: 'codex',
        installed: true,
        evidence: [{ via: 'binary', path: '/opt/homebrew/bin/codex' }],
        binaryPath: '/opt/homebrew/bin/codex',
        logRoots: [{
          rootId: 'codex-sessions',
          path: '/Users/tester/.codex/sessions',
          traceSourceKind: 'codex',
          exists: true,
          readable: true,
          sessionFileCount: 42,
          totalBytes: 3_200_000,
          newestModifiedAt: '2026-09-11T14:54:30.000Z',
          truncated: false,
        }],
        sessionFileCount: 42,
      },
      {
        agentId: 'cursor',
        displayName: 'Cursor',
        vendor: 'Anysphere',
        traceSourceKind: null,
        installed: true,
        evidence: [{ via: 'install-dir', path: '/Applications/Cursor.app' }],
        logRoots: [],
        sessionFileCount: 0,
      },
      {
        agentId: 'openclaw',
        displayName: 'OpenClaw',
        vendor: 'Other',
        traceSourceKind: 'openclaw',
        installed: false,
        evidence: [],
        logRoots: [{
          rootId: 'openclaw-sessions',
          path: '/Users/tester/.openclaw/sessions',
          traceSourceKind: 'openclaw',
          exists: false,
          readable: false,
          sessionFileCount: 0,
          totalBytes: 0,
          truncated: true,
        }],
        sessionFileCount: 0,
      },
    ],
    summary: {
      knownAgentCount: 3,
      installedAgentCount: 2,
      sessionFileCount: 42,
      rootsWithFiles: 1,
      truncatedRootCount: 1,
    },
    ...overrides,
  };
}

export function sampleCollectionReport(overrides: Partial<AgentCollectionReport> = {}): AgentCollectionReport {
  return {
    schemaVersion: 'agent-collection-v1',
    generatedAt: '2026-09-11T15:00:00.000Z',
    outputDir: '/Users/tester/.oh-my-knowledge/observe/agents',
    inventoryGeneratedAt: '2026-09-11T14:54:30.000Z',
    agents: [{
      agentId: 'codex',
      displayName: 'Codex',
      logRoots: [{
        rootId: 'codex-sessions',
        path: '/Users/tester/.codex/sessions',
        traceSourceKind: 'codex',
        discoveredCount: 42,
        collectedCount: 2,
        skippedCount: 40,
        failedCount: 0,
      }],
    }],
    sessions: [
      {
        agentId: 'codex',
        rootId: 'codex-sessions',
        sourceKind: 'codex',
        sourcePath: '/Users/tester/.codex/sessions/rollout-2026-09-11.jsonl',
        runId: 'run-1',
        traceId: 'trace-1',
        artifactPath: 'traces/codex/trace-1.json',
        sizeBytes: 1_048_576,
        modifiedAt: '2026-09-11T14:54:30.000Z',
        contentDigest: 'sha256:aaaa',
        eventCount: 100,
        unknownEventCount: 25,
        title: '修复登录态丢失',
      },
      {
        agentId: 'codex',
        rootId: 'codex-sessions',
        sourceKind: 'codex',
        sourcePath: '/Users/tester/.codex/sessions/rollout-2026-09-10.jsonl',
        runId: 'run-2',
        traceId: 'trace-2',
        artifactPath: 'traces/codex/trace-2.json',
        sizeBytes: 2_048,
        modifiedAt: '2026-09-10T09:00:00.000Z',
        contentDigest: 'sha256:bbbb',
        eventCount: 12,
        unknownEventCount: 0,
      },
    ],
    limitations: ['本轮采集上限为 200 个会话文件、512 MiB，剩余 0 个待采文件留到后续增量运行。'],
    summary: {
      agentCount: 1,
      discoveredCount: 42,
      collectedCount: 2,
      skippedCount: 40,
      failedCount: 0,
      eventCount: 112,
      unknownEventCount: 25,
      totalBytes: 1_050_624,
    },
    ...overrides,
  };
}
