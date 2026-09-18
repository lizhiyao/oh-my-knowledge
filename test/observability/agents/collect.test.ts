import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { globalLayout, type GlobalOmkLayout } from '../../../src/evidence/storage/layout.js';
import {
  AGENT_TRACE_ARTIFACT_VERSION,
  agentCollectionReportPath,
  AgentCollectionReportOutdatedError,
  collectAgentLogs,
  loadAgentCollectionReport,
  type AgentTraceArtifact,
  type CollectAgentLogsOptions,
} from '../../../src/observability/agents/collect.js';
import { detectAgentInventory, type DetectAgentInventoryOptions } from '../../../src/observability/agents/detect.js';
import { resolveAgentCatalog } from '../../../src/observability/agents/local-catalog.js';
import {
  AGENT_CATALOG_VERSION,
  AGENT_COLLECTION_VERSION,
} from '../../../src/observability/agents/contracts.js';
import { UNKNOWN_DISPOSITION_RULES_VERSION } from '../../../src/observability/trace/unknown-disposition.js';
import type {
  AgentCollectionReport,
  AgentDescriptor,
  AgentInventoryReport,
  CollectedSession,
} from '../../../src/observability/agents/contracts.js';
import { claudeTrace } from '../../helpers/claude-trace.js';

/**
 * 采集用例走真实 fs + 显式临时目录：既有 trace 解析器（loadTraceCorpus）只接受路径，
 * 注入假端口会让「发现」与「解析」看到两个世界。因此这里全部用临时主目录与临时
 * OMK 根，绝不允许用例写到 ~/.omk。
 */

const tempRoots: string[] = [];
/** 被用例 chmod 000 的目录：清理前必须恢复权限，否则临时目录删不掉。 */
const lockedDirs: string[] = [];

interface Harness {
  readonly root: string;
  readonly home: string;
  readonly binDir: string;
  readonly layout: GlobalOmkLayout;
  readonly detectOptions: DetectAgentInventoryOptions;
  /** 往主目录里写一个会话文件；mtime 可控，用于「最新优先」与增量用例。 */
  session(relativePath: string, content: string, mtimeMs?: number): string;
}

afterEach(() => {
  // 成功与失败都要清干净：先恢复权限再删，被锁住的临时目录否则删不掉。
  for (const dir of lockedDirs.splice(0, lockedDirs.length)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // 目录已随临时根一起消失，没有需要恢复的东西。
    }
  }
  for (const root of tempRoots.splice(0, tempRoots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 把一个目录变成读不了的日志根。以 root 身份跑用例时权限位不生效，
 * 调用方必须先用 canLockDir() 判据跳过，否则断言的是内核而不是本模块。
 */
function lockDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  lockedDirs.push(dir);
  chmodSync(dir, 0o000);
  return dir;
}

function canLockDir(): boolean {
  return typeof process.getuid === 'function' && process.getuid() !== 0;
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'omk-agents-collect-'));
  tempRoots.push(root);
  const home = join(root, 'home');
  const binDir = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const harness: Harness = {
    root,
    home,
    binDir,
    layout: globalLayout(join(root, 'omk')),
    detectOptions: { homeDirectory: home, platform: 'darwin', pathDirectories: [binDir] },
    session(relativePath: string, content: string, mtimeMs?: number) {
      const path = join(home, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      if (mtimeMs !== undefined) utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
      return path;
    },
  };
  // 安装状态目录：detect 只 stat，不执行任何东西。
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  return harness;
}

function collect(
  harness: Harness,
  options: Omit<CollectAgentLogsOptions, 'layout' | 'detect'> & { report?: AgentInventoryReport } = {},
): AgentCollectionReport {
  const { report, ...rest } = options;
  return collectAgentLogs(report, {
    ...rest,
    layout: harness.layout,
    detect: report === undefined ? harness.detectOptions : undefined,
  });
}

function claudeSession(sessionId: string, prompt: string): string {
  return claudeTrace(sessionId)
    .userText(prompt)
    .assistantText('已经看完，结论在下面。')
    .toJsonl();
}

/** 一条最小可被判定的 codex rollout：首条 session_meta 是 codex 适配器的入口判据。 */
function codexSession(sessionId: string): string {
  return [
    {
      type: 'session_meta',
      payload: { id: sessionId, session_id: sessionId, timestamp: '2026-05-18T09:00:00.000Z', cwd: '/repo-a' },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: '{"command":"ls"}', call_id: 'c1' },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c1', output: 'AGENTS.md\nsrc\n' },
    },
  ].map((record) => JSON.stringify(record)).join('\n');
}

/**
 * 一份同时踩到三个未识别桶的 codex rollout：可映射的 reasoning 原件、它的两条 item_completed
 * 视图（第二条超出「同类已映射事件」上界）、累计 token 快照、待映射的命令执行证据，以及一条
 * 适配器完全读不出语义的记录。
 */
function codexSessionWithUnknownViews(): string {
  return [
    {
      type: 'session_meta',
      payload: { id: 'cx-views', session_id: 'cx-views', timestamp: '2026-05-18T09:00:00.000Z', cwd: '/repo-a' },
    },
    {
      type: 'response_item',
      payload: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '先看目录结构' }] },
    },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning', id: 'item-1' } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning', id: 'item-2' } } },
    { type: 'token_usage_record', payload: { usage: { input_tokens: 10, output_tokens: 2 } } },
    {
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', status: 'completed' } },
    },
    { type: 'mystery_record', payload: { type: 'also_mystery' } },
  ].map((record) => JSON.stringify(record)).join('\n');
}

function agentOf(report: AgentCollectionReport, agentId: string) {
  const entry = report.agents.find((candidate) => candidate.agentId === agentId);
  assert.ok(entry, `报告里应当有 ${agentId}`);
  return entry;
}

function sessionFor(report: AgentCollectionReport, sourcePath: string): CollectedSession {
  const session = report.sessions.find((entry) => entry.sourcePath === sourcePath);
  assert.ok(session, `报告里应当有 ${sourcePath} 的会话条目`);
  return session;
}

function digestOf(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function artifactFile(harness: Harness, session: CollectedSession): string {
  assert.ok(session.artifactPath.startsWith('traces/'), 'artifactPath 必须是 OMK 侧相对路径');
  return join(harness.layout.observeAgentsDir, session.artifactPath);
}

/** 分桶是对产物里 unknown 事件的再分类：口径要能对上原始计数。 */
function artifactOfUnknownTotal(harness: Harness, session: CollectedSession): number {
  const artifact = JSON.parse(readFileSync(artifactFile(harness, session), 'utf-8')) as AgentTraceArtifact;
  return artifact.session.events.filter((event) => event.eventKind === 'unknown').length;
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

function seedClaudeAndCodex(harness: Harness): { claudeA: string; claudeB: string; codexA: string } {
  const claudeA = harness.session(
    '.claude/projects/-repo-a/session-a.jsonl',
    claudeSession('sess-a', '解释这个仓库的分层'),
    Date.parse('2026-05-18T09:00:00.000Z'),
  );
  const claudeB = harness.session(
    '.claude/projects/-repo-b/session-b.jsonl',
    claudeSession('sess-b', '帮我修一个测试'),
    Date.parse('2026-05-18T10:00:00.000Z'),
  );
  const codexA = harness.session(
    '.codex/sessions/2026-05-18/rollout-a.jsonl',
    codexSession('cx-a'),
    Date.parse('2026-05-17T09:00:00.000Z'),
  );
  return { claudeA, claudeB, codexA };
}

describe('collectAgentLogs 产物投影', () => {
  it('把已支持格式的日志写成归一化 Trace IR 产物，并保留原始路径', () => {
    const harness = createHarness();
    const { claudeA, claudeB, codexA } = seedClaudeAndCodex(harness);
    const report = collect(harness);

    assert.equal(report.schemaVersion, AGENT_COLLECTION_VERSION);
    assert.equal(report.unknownDispositionRulesVersion, UNKNOWN_DISPOSITION_RULES_VERSION);
    assert.equal(report.outputDir, harness.layout.observeAgentsDir);
    assert.deepEqual(report.limitations, [], '干净场景不应编造 limitations');
    assert.equal(report.summary.discoveredCount, 3);
    assert.equal(report.summary.collectedCount, 3);
    assert.equal(report.summary.skippedCount, 0);
    assert.equal(report.summary.failedCount, 0);
    assert.deepEqual([
      report.summary.unknownEventCount,
      report.summary.duplicateViewCount,
      report.summary.unmappedEvidenceCount,
    ], [0, 0, 0], '干净场景下三个未识别桶都应当是 0');
    assert.equal(report.sessions.length, 3);
    assert.deepEqual(agentOf(report, 'claude-code').logRoots.map((root) => [
      root.rootId, root.discoveredCount, root.collectedCount,
    ]), [['claude-projects', 2, 2]]);
    assert.deepEqual(agentOf(report, 'codex').logRoots.map((root) => root.rootId), ['codex-sessions', 'codex-archived-sessions']);

    for (const [sourcePath, kind, runId] of [
      [claudeA, 'claude', 'sess-a'],
      [claudeB, 'claude', 'sess-b'],
      [codexA, 'codex', 'cx-a'],
    ] as const) {
      const session = sessionFor(report, sourcePath);
      assert.equal(session.sourceKind, kind);
      assert.equal(session.runId, runId);
      assert.ok(session.traceId.startsWith('trace:'));
      assert.equal(session.contentDigest, digestOf(sourcePath), '摘要必须是文件内容的 sha256');
      assert.ok(session.eventCount > 0);
      assert.deepEqual(
        [session.unknownEventCount, session.duplicateViewCount, session.unmappedEvidenceCount],
        [0, 0, 0],
        '最小样例不应产生任何未识别记录',
      );
      assert.match(artifactFile(harness, session), /trace_[0-9a-f]{32}\.json$/);

      const artifact = JSON.parse(readFileSync(artifactFile(harness, session), 'utf-8')) as AgentTraceArtifact;
      assert.equal(artifact.schemaVersion, AGENT_TRACE_ARTIFACT_VERSION);
      assert.equal(artifact.sourcePath, sourcePath, '产物必须保留原始日志绝对路径');
      assert.equal(artifact.contentDigest, session.contentDigest);
      assert.equal(artifact.sourceKind, kind);
      assert.equal(artifact.session.traceId, session.traceId);
      assert.equal(artifact.session.sourcePath, sourcePath);
      assert.ok(artifact.session.events.length === session.eventCount);
    }

    // 展示用标题只取第一条人类提问，不参与任何测量语义。
    assert.equal(sessionFor(report, claudeA).title, '解释这个仓库的分层');

    // 两份报告都落在 OMK 侧，且能被 load 回来。
    assert.equal(existsSync(harness.layout.observeAgentsInventoryPath), true);
    assert.equal(existsSync(agentCollectionReportPath(harness.layout.observeAgentsDir)), true);
    assert.deepEqual(loadAgentCollectionReport(harness.layout.observeAgentsDir), report);
    const inventory = JSON.parse(readFileSync(harness.layout.observeAgentsInventoryPath, 'utf-8')) as AgentInventoryReport;
    assert.deepEqual(
      inventory.agents.filter((agent) => agent.installed).map((agent) => agent.agentId).sort(),
      ['claude-code', 'codex'],
    );
    assert.equal(report.inventoryGeneratedAt, inventory.generatedAt);
    assert.equal(loadAgentCollectionReport(join(harness.root, 'nowhere')), undefined);
  });

  it('外部传入清单时按传入的清单采集，不重复探测', () => {
    const harness = createHarness();
    const { claudeA, claudeB, codexA } = seedClaudeAndCodex(harness);
    const inventory = detectAgentInventory({ ...harness.detectOptions, now: () => '2026-05-18T00:00:00.000Z' });
    // 清单之后现场又变了：codex 目录整体消失，采集只能照清单办事并如实说明。
    rmSync(join(harness.home, '.codex'), { recursive: true, force: true });

    const report = collect(harness, { report: inventory });
    assert.equal(report.inventoryGeneratedAt, '2026-05-18T00:00:00.000Z');
    assert.deepEqual(report.sessions.map((session) => session.sourcePath), [claudeA, claudeB]);
    assert.equal(existsSync(codexA), false);
    assert.deepEqual(
      agentOf(report, 'codex').logRoots.map((root) => [root.rootId, root.discoveredCount]),
      [['codex-sessions', 0], ['codex-archived-sessions', 0]],
      '根不存在要如实记 0，但不编造成「扫描受限」',
    );
    assert.deepEqual(report.limitations, []);
    assert.equal(loadAgentCollectionReport(harness.layout.observeAgentsDir)?.summary.collectedCount, 2);
  });

  it('产物逐事件流式写盘后，与整篇 JSON.stringify 的结果逐字节相同', () => {
    const harness = createHarness();
    seedClaudeAndCodex(harness);
    const report = collect(harness);
    assert.ok(report.sessions.length >= 3, '样本要覆盖多种宿主的产物形态');
    for (const session of report.sessions) {
      const text = readFileSync(artifactFile(harness, session), 'utf-8');
      assert.equal(
        text,
        JSON.stringify(JSON.parse(text), null, 2),
        `${session.sourcePath} 的产物与标准 2 空格缩进不一致`,
      );
    }
  });

  it('第二次运行同一批日志采集 0 个新文件，删掉产物后又能补回', () => {
    const harness = createHarness();
    seedClaudeAndCodex(harness);
    const first = collect(harness, { now: () => '2026-05-18T11:00:00.000Z' });
    const artifactPaths = first.sessions.map((session) => artifactFile(harness, session));
    const artifactBytes = artifactPaths.map((path) => readFileSync(path));

    const second = collect(harness, { now: () => '2026-05-18T12:00:00.000Z' });
    assert.equal(second.summary.collectedCount, 0, '增量运行不得重新解析未变化的文件');
    assert.equal(second.summary.skippedCount, 3);
    assert.equal(second.summary.failedCount, 0);
    assert.deepEqual(second.sessions, first.sessions, '沿用条目必须与上一轮逐字相同');
    assert.deepEqual(
      artifactPaths.map((path) => readFileSync(path)),
      artifactBytes,
      '跳过时不得改写已产出的归一化产物',
    );
    assert.equal(second.generatedAt, '2026-05-18T12:00:00.000Z');
    assert.deepEqual(second.limitations, []);

    // 产物被删掉：mtime/size 未变也不能谎报「已采集」。
    rmSync(artifactPaths[0], { force: true });
    const third = collect(harness, { now: () => '2026-05-18T13:00:00.000Z' });
    assert.equal(third.summary.collectedCount, 1);
    assert.equal(third.summary.skippedCount, 2);
    assert.equal(existsSync(artifactPaths[0]), true);
    assert.deepEqual(third.sessions.map((session) => session.traceId).sort(), first.sessions.map((session) => session.traceId).sort());
  });

  it('内容摘要按块流式计算，超过读取块大小的文件与整文件摘要逐字等值', () => {
    const harness = createHarness();
    const path = harness.session(
      '.codex/sessions/2026-05-16/rollout-big.jsonl',
      // 填充到 1 MiB 摘要块之上：分块边界算错的话，下面的逐字节摘要断言会直接失配。
      [
        codexSession('cx-big'),
        ...Array.from({ length: 6_000 }, (_unused, index) => JSON.stringify({
          type: 'token_usage_record',
          payload: { usage: { input_tokens: index, cached_input_tokens: 0 }, note: 'x'.repeat(200) },
        })),
      ].join('\n'),
      Date.parse('2026-05-16T09:00:00.000Z'),
    );
    assert.ok(readFileSync(path).length > 1024 * 1024, '样本必须超过单个摘要块');

    const report = collect(harness);
    const session = sessionFor(report, path);
    assert.equal(
      session.contentDigest,
      `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
      '流式摘要必须与整文件摘要逐字节相同，否则增量复用会误判成文件变化',
    );

    const second = collect(harness);
    assert.equal(second.summary.collectedCount, 0, '摘要一致时不得重新解析');
  });

  it('源文件变化后按 mtime+size 增量重采，内容没变只刷新时间戳', () => {
    const harness = createHarness();
    const { claudeA } = seedClaudeAndCodex(harness);
    const first = collect(harness);
    const firstEntry = sessionFor(first, claudeA);

    // mtime 变、size 也变：必须重采并换摘要。
    writeFileSync(claudeA, `${readFileSync(claudeA, 'utf-8')}\n${JSON.stringify({
      type: 'assistant',
      uuid: 'a9',
      parentUuid: 'a1',
      sessionId: 'sess-a',
      timestamp: '2026-05-18T11:11:11.000Z',
      cwd: '/repo-a',
      message: { role: 'assistant', content: [{ type: 'text', text: '补一段结论' }] },
    })}`);
    const second = collect(harness, { now: () => '2026-05-19T09:00:00.000Z' });
    const secondEntry = sessionFor(second, claudeA);
    assert.equal(second.summary.collectedCount, 1);
    assert.equal(second.summary.skippedCount, 2);
    assert.notEqual(secondEntry.contentDigest, firstEntry.contentDigest);
    assert.equal(secondEntry.contentDigest, digestOf(claudeA));
    assert.equal(secondEntry.sizeBytes, statSync(claudeA).size);

    // 只碰 mtime、内容不变：沿用产物，但索引里的时间戳刷新到本轮口径。
    const untouched = digestOf(claudeA);
    utimesSync(claudeA, new Date(0), new Date(0));
    const third = collect(harness, { now: () => '2026-05-20T09:00:00.000Z' });
    assert.equal(third.summary.collectedCount, 0, '内容未变时不得重复解析');
    assert.equal(third.summary.skippedCount, 3);
    const thirdEntry = sessionFor(third, claudeA);
    assert.equal(thirdEntry.contentDigest, untouched);
    assert.equal(thirdEntry.modifiedAt, new Date(0).toISOString());
  });

  it('persist:false 只算不写，用于预览与自检', () => {
    const harness = createHarness();
    seedClaudeAndCodex(harness);
    const report = collect(harness, { persist: false });
    assert.equal(report.summary.collectedCount, 3);
    assert.deepEqual(listFiles(harness.layout.root), [], '预览不得写出任何产物');
  });
});

describe('collectAgentLogs 容量与失败口径', () => {
  it('命中本轮文件上限时按最新优先摄取，并如实说明剩余', () => {
    const harness = createHarness();
    harness.session('.claude/projects/-repo-a/old.jsonl', claudeSession('old', '老问题'), Date.parse('2026-05-01T00:00:00.000Z'));
    harness.session('.claude/projects/-repo-a/mid.jsonl', claudeSession('mid', '中等问题'), Date.parse('2026-05-02T00:00:00.000Z'));
    const newest = harness.session('.claude/projects/-repo-a/new.jsonl', claudeSession('new', '最新问题'), Date.parse('2026-05-03T00:00:00.000Z'));

    const first = collect(harness, { limits: { maxFilesPerRun: 1 } });
    assert.equal(first.summary.discoveredCount, 3);
    assert.equal(first.summary.collectedCount, 1);
    assert.deepEqual(first.sessions.map((session) => session.sourcePath), [newest], '容量受限时要先拿到最近的证据');
    assert.equal(
      first.limitations.find((text) => text.includes('本轮采集上限')),
      '本轮采集上限为 1 个会话文件、2 GiB，剩余 2 个待采文件留到后续增量运行。',
    );

    const second = collect(harness, { limits: { maxFilesPerRun: 5 } });
    assert.equal(second.summary.collectedCount, 2, '后续运行继续补齐被推迟的文件');
    assert.equal(second.summary.skippedCount, 1);
    assert.equal(second.sessions.length, 3);
    assert.deepEqual(second.limitations, []);
  });

  it('单个文件超过字节上限时本轮不碰它，单独记录而不是算作失败', () => {
    const harness = createHarness();
    const big = harness.session(
      '.claude/projects/-repo-a/big.jsonl',
      claudeSession('big', '很长的会话内容'.repeat(60)),
      Date.parse('2026-05-03T00:00:00.000Z'),
    );
    const small = harness.session('.claude/projects/-repo-a/small.jsonl', claudeSession('small', '很小'), Date.parse('2026-05-02T00:00:00.000Z'));
    const smallBytes = statSync(small).size;
    assert.ok(statSync(big).size > smallBytes, '用例前提：big 必须明显大于 small');

    const report = collect(harness, { limits: { maxFileBytes: smallBytes } });
    assert.equal(report.summary.discoveredCount, 2);
    assert.equal(report.summary.collectedCount, 1);
    assert.equal(report.summary.failedCount, 0, '留到以后采集不算失败');
    assert.deepEqual(report.sessions.map((session) => session.sourcePath), [small]);
    assert.match(
      report.limitations.join('\n'),
      /1 个会话文件超过单文件上限 \d+ (?:字节|KiB|MiB)，本轮未采集。/,
    );
  });

  it('命中单根扫描上限时计数只到上限为止，并声明不是全量', () => {
    const harness = createHarness();
    const kept: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const path = harness.session(
        `.claude/projects/-repo-a/${name}.jsonl`,
        claudeSession(name, `会话 ${name}`),
        Date.parse('2026-05-03T00:00:00.000Z'),
      );
      if (name !== 'c') kept.push(path);
    }

    const report = collect(harness, { limits: { maxSessionFilesPerRoot: 2 } });
    assert.equal(report.summary.discoveredCount, 2, '截断后的计数不得被当成全量');
    assert.equal(agentOf(report, 'claude-code').logRoots[0].discoveredCount, 2);
    assert.equal(report.summary.collectedCount, 2);
    assert.deepEqual(report.sessions.map((session) => session.sourcePath), kept);
    assert.equal(
      report.limitations.find((text) => text.includes('命中单根扫描上限')),
      '1 个日志根命中单根扫描上限（每根最多 2 个文件），报告里的计数是截断结果，不是全量。',
    );
  });

  it.skipIf(!canLockDir())('日志根存在但读不了：计数归零并交代原因，不给半份数字', () => {
    const harness = createHarness();
    harness.session('.claude/projects/-repo-a/main.jsonl', claudeSession('main', '问题'), Date.parse('2026-05-03T00:00:00.000Z'));
    const root = join(harness.home, '.claude/projects');
    lockDir(root);

    const report = collect(harness);
    assert.equal(report.summary.discoveredCount, 0);
    assert.equal(report.summary.collectedCount, 0);
    assert.deepEqual(report.sessions, []);
    assert.match(report.limitations.join('\n'), /个日志根存在但无法完整扫描/);
    assert.deepEqual(agentOf(report, 'claude-code').logRoots.map((entry) => entry.discoveredCount), [0]);

    const inventory = JSON.parse(readFileSync(harness.layout.observeAgentsInventoryPath, 'utf-8')) as AgentInventoryReport;
    const claude = inventory.agents.find((agent) => agent.agentId === 'claude-code');
    assert.ok(claude);
    assert.deepEqual(claude.logRoots.map((entry) => [entry.exists, entry.readable, entry.sessionFileCount]), [[true, false, 0]]);
  });

  it('单个文件解析不出会话不中断整轮，失败进 limitations', () => {
    const harness = createHarness();
    const broken = harness.session('.claude/projects/-repo-a/broken.jsonl', '这不是 jsonl\n{{{ 半截 JSON', Date.parse('2026-05-03T00:00:00.000Z'));
    const good = harness.session('.claude/projects/-repo-a/good.jsonl', claudeSession('good', '正常的会话'), Date.parse('2026-05-02T00:00:00.000Z'));

    const report = collect(harness);
    assert.equal(report.summary.collectedCount, 1);
    assert.equal(report.summary.failedCount, 1);
    assert.equal(sessionFor(report, good).sourceKind, 'claude');
    assert.equal(report.sessions.some((session) => session.sourcePath === broken), false);
    assert.match(report.limitations.join('\n'), /个会话文件解析后没有产生任何会话/);
    assert.ok(report.limitations.join('\n').includes(broken), 'limitations 要能指回具体文件');
    // 失败也被登记进 per-root 口径，Studio 侧才看得到「发现了但没拿到」。
    assert.deepEqual(agentOf(report, 'claude-code').logRoots[0].failedCount, 1);
  });

  it('无法归类的 jsonl 按 unknown 归档，而不是被静默丢弃', () => {
    const harness = createHarness();
    const odd = harness.session(
      '.claude/projects/-repo-a/odd.jsonl',
      JSON.stringify({ type: 'custom_event', id: 'e-1', timestamp: '2026-05-18T09:00:00.000Z' }),
      Date.parse('2026-05-03T00:00:00.000Z'),
    );

    const report = collect(harness);
    const session = sessionFor(report, odd);
    assert.equal(session.sourceKind, 'unknown');
    assert.equal(session.unknownEventCount, 1, '读不出格式的记录算未支持缺口');
    assert.equal(session.duplicateViewCount, 0);
    assert.equal(session.unmappedEvidenceCount, 0);
    assert.equal(session.eventCount, 1);
    assert.equal(report.summary.collectedCount, 1);
    assert.match(report.limitations.join('\n'), /按 unknown 格式归档/);
  });

  it('未识别记录分档为未支持格式、重复视图、待映射证据', () => {
    const harness = createHarness();
    const mixed = harness.session(
      '.codex/sessions/2026-05-16/rollout-views.jsonl',
      codexSessionWithUnknownViews(),
      Date.parse('2026-05-16T09:00:00.000Z'),
    );

    const report = collect(harness);
    const session = sessionFor(report, mixed);
    assert.equal(session.sourceKind, 'codex');
    assert.equal(session.unknownEventCount, 1, '只有适配器完全读不出的记录才是支持缺口');
    assert.equal(session.duplicateViewCount, 2, '与原件同一事实的 item 视图和累计快照不映射，也不计入缺口');
    assert.equal(session.unmappedEvidenceCount, 2, '超出同类上界的视图与待映射证据不能冒充重复视图');
    assert.equal(
      session.unknownEventCount + session.duplicateViewCount + session.unmappedEvidenceCount,
      artifactOfUnknownTotal(harness, session),
      '三档之和必须等于产物里的 unknown 事件总数，一档都不许丢',
    );
    assert.deepEqual([
      report.summary.unknownEventCount,
      report.summary.duplicateViewCount,
      report.summary.unmappedEvidenceCount,
    ], [1, 2, 2]);
  });

  it('已定论的族写进产物时带上观测效果与执行属性，大记录只留摘要', () => {
    const harness = createHarness();
    const decided = harness.session(
      '.codex/sessions/2026-05-16/rollout-decided.jsonl',
      [
        {
          type: 'session_meta',
          payload: { id: 'cx-decided', session_id: 'cx-decided', timestamp: '2026-05-18T09:00:00.000Z', cwd: '/repo-a' },
        },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'call-1',
            id: 'ctc-1',
            name: 'exec',
            input: 'const r = await tools.exec_command({"cmd": "npm test"});',
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            started_at_ms: 1_700_000_000_000,
            completed_at_ms: 1_700_000_004_000,
            item: {
              type: 'CommandExecution',
              id: 'exec-1',
              parsed_cmd: [{ type: 'command', cmd: 'npm test' }],
              exit_code: 3,
              status: 'completed',
            },
          },
        },
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: '1 test failed' },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'FileChange',
              id: 'exec-2',
              status: 'completed',
              changes: { '/repo-a/src/a.ts': { type: 'update', unified_diff: '--- a\n+++ b\n+x\n-y' } },
            },
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: { type: 'SubAgentActivity', id: 'exec-3', kind: 'started', agent_thread_id: 't-child', agent_path: 'main/a' },
          },
        },
        {
          type: 'event_msg',
          payload: { type: 'item_completed', item: { type: 'EnteredReviewMode', id: 'item-4', user_facing_hint: 'review main' } },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: { type: 'ExitedReviewMode', id: 'item-5', review_output: { findings: [{ body: 'x'.repeat(20_000) }] } },
          },
        },
      ].map((record) => JSON.stringify(record)).join('\n'),
      Date.parse('2026-05-16T09:00:00.000Z'),
    );

    const report = collect(harness);
    const session = sessionFor(report, decided);
    assert.deepEqual(
      [session.unknownEventCount, session.duplicateViewCount, session.unmappedEvidenceCount],
      [0, 0, 1],
      '只有评审结论这一条还没定论，其余都按各自口径成了事件',
    );

    const artifact = JSON.parse(readFileSync(artifactFile(harness, session), 'utf-8')) as AgentTraceArtifact;
    assert.equal(artifact.schemaVersion, 'agent-trace-v2', '产物声明的 IR 版本要随新增事件档一起升');
    const result = artifact.session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result && result.eventKind === 'tool_result');
    assert.equal(result.exitCode, 3, '退出码来自运行时结果视图，不再从输出文本猜');
    assert.equal(result.durationMs, 4_000);
    assert.deepEqual(result.sourceIds, ['call-1', 'exec-1']);
    const effect = artifact.session.events.find((event) => event.eventKind === 'observed_effect');
    assert.ok(effect && effect.eventKind === 'observed_effect');
    assert.deepEqual(effect.paths, ['src/a.ts'], '绝对路径不进派生层');
    const pending = artifact.session.events.find((event) => event.eventKind === 'unknown');
    assert.ok(pending && pending.eventKind === 'unknown');
    assert.equal(pending.rawTruncated, true, 'MB 级结论只留摘要与节选');
    assert.equal(pending.recordFamily, 'ExitedReviewMode', '摘要之后仍要认得出这是哪一族');
    assert.equal(pending.recordId, 'item-5');
  });

  it('实际解析格式与日志根登记格式不一致时，按实际结果记录', () => {
    const harness = createHarness();
    const mislabeled = harness.session(
      '.claude/projects/-repo-a/codex-shaped.jsonl',
      codexSession('cx-mismatch'),
      Date.parse('2026-05-03T00:00:00.000Z'),
    );

    const report = collect(harness);
    const session = sessionFor(report, mislabeled);
    assert.equal(session.sourceKind, 'codex', 'sourceKind 要说真话，不能跟着登记表写');
    assert.equal(session.rootId, 'claude-projects', '产品与根归属仍然保留');
    assert.match(report.limitations.join('\n'), /与日志根登记格式不一致/);
    const artifact = JSON.parse(readFileSync(artifactFile(harness, session), 'utf-8')) as AgentTraceArtifact;
    assert.equal(artifact.sourceKind, 'codex');
  });

  it('上一轮 collection.json 损坏时按全量重采并说明原因', () => {
    const harness = createHarness();
    seedClaudeAndCodex(harness);
    assert.equal(collect(harness).summary.collectedCount, 3);

    writeFileSync(agentCollectionReportPath(harness.layout.observeAgentsDir), '{ 坏掉的 json');
    const report = collect(harness);
    assert.equal(report.summary.collectedCount, 3, '索引读不了就退回全量，不能谎报跳过');
    assert.equal(report.summary.skippedCount, 0);
    assert.match(report.limitations.join('\n'), /无法解析，本轮按全量重新采集/);
  });

  it('上一轮报告是旧口径时按全量重采，并把报告改写成当前版本', () => {
    const harness = createHarness();
    const { claudeA } = seedClaudeAndCodex(harness);
    const first = collect(harness);
    const reportPath = agentCollectionReportPath(harness.layout.observeAgentsDir);
    // 旧报告只被取代、不被改写：这里模拟磁盘上留着一份 agent-collection-v1。
    const legacy = { ...(first as unknown as Record<string, unknown>) };
    delete legacy.unknownDispositionRulesVersion;
    legacy.schemaVersion = 'agent-collection-v1';
    writeFileSync(reportPath, JSON.stringify(legacy));

    assert.throws(
      () => loadAgentCollectionReport(harness.layout.observeAgentsDir),
      (error: unknown) => error instanceof AgentCollectionReportOutdatedError
        && error.foundVersion === 'agent-collection-v1',
      '旧口径与文件损坏必须区分，页面才给得出「重新采集」而不是「读不动」',
    );

    const second = collect(harness);
    assert.equal(second.schemaVersion, AGENT_COLLECTION_VERSION, '本轮按当前口径重写');
    assert.equal(second.summary.collectedCount, 3, '旧计数不可沿用，全部重采');
    assert.equal(second.summary.skippedCount, 0);
    assert.match(
      second.limitations.join('\n'),
      /上一轮报告是 agent-collection-v1 口径，未识别事件的计数无法沿用/,
    );
    assert.equal(sessionFor(second, claudeA).eventCount, sessionFor(first, claudeA).eventCount);
    assert.deepEqual(loadAgentCollectionReport(harness.layout.observeAgentsDir), second);
  });

  it('分桶口径表更新后，旧报告的计数同样不可复用', () => {
    const harness = createHarness();
    seedClaudeAndCodex(harness);
    const first = collect(harness);
    const reportPath = agentCollectionReportPath(harness.layout.observeAgentsDir);
    writeFileSync(
      reportPath,
      JSON.stringify({ ...first, unknownDispositionRulesVersion: 'unknown-disposition-v0' }),
    );

    const second = collect(harness);
    assert.equal(second.summary.collectedCount, 3);
    assert.match(second.limitations.join('\n'), /unknown-disposition-v0 口径/);
    assert.equal(second.unknownDispositionRulesVersion, UNKNOWN_DISPOSITION_RULES_VERSION);
  });

  it('历史条目对应的日志已被用户删掉时移出索引，但产物不删', () => {
    const harness = createHarness();
    const { claudeA, claudeB, codexA } = seedClaudeAndCodex(harness);
    const first = collect(harness);
    const kept = artifactFile(harness, sessionFor(first, claudeA));
    rmSync(claudeB, { force: true });
    rmSync(codexA, { force: true });

    const second = collect(harness);
    assert.deepEqual(second.sessions.map((session) => session.sourcePath), [claudeA]);
    assert.equal(kept.startsWith(harness.layout.observeAgentsTracesDir), true);
    assert.equal(existsSync(kept), true, '派生产物不随源文件删除而消失');
    assert.equal(existsSync(artifactFile(harness, sessionFor(first, claudeB))), true, '不得删除既有证据');
    assert.equal(
      second.limitations.find((text) => text.includes('个历史条目对应的原始日志已不在本轮扫描结果里')),
      '2 个历史条目对应的原始日志已不在本轮扫描结果里，已从索引移除；已产出的归一化产物不删除。',
    );
  });
});

describe('collectAgentLogs 证据边界', () => {
  it('只读用户日志：采集前后主目录内容逐字节不变', () => {
    const harness = createHarness();
    seedClaudeAndCodex(harness);
    const beforeHome = listFiles(harness.home).map((path) => ({
      path,
      bytes: readFileSync(path),
      mtimeMs: statSync(path).mtimeMs,
      size: statSync(path).size,
    }));
    const beforeOmk = listFiles(harness.layout.root);

    const report = collect(harness);

    const afterHome = listFiles(harness.home).map((path) => ({
      path,
      bytes: readFileSync(path),
      mtimeMs: statSync(path).mtimeMs,
      size: statSync(path).size,
    }));
    assert.deepEqual(afterHome, beforeHome, '原始日志必须一个字节、一个时间戳都不变');
    assert.deepEqual(listFiles(harness.home).map((path) => relative(harness.home, path)).sort(), beforeHome.map((entry) => relative(harness.home, entry.path)).sort());
    assert.deepEqual(listFiles(harness.root).filter((path) => !path.startsWith(harness.layout.root)), beforeHome.map((entry) => entry.path).sort());
    assert.equal(beforeOmk.length, 0);

    // 产物只进 OMK 侧目录，且原子写入不留临时文件。
    const produced = listFiles(harness.layout.root);
    assert.ok(produced.length >= 5);
    for (const path of produced) {
      assert.equal(path.startsWith(harness.layout.observeAgentsDir), true, `产物只能落在 ${harness.layout.observeAgentsDir}`);
      assert.equal(path.endsWith('.tmp'), false, `原子写入不得残留临时文件：${path}`);
      assert.match(path, /(?:collection|inventory)\.json$|\.json$/, `不应产生非 JSON 文件：${path}`);
    }
    assert.equal(report.sessions.length, 3);
    for (const session of report.sessions) {
      assert.equal(listFiles(harness.home).includes(session.sourcePath), true, session.sourcePath);
    }
  });

  it('会话正文之外的东西一律不读：非会话扩展名与 node_modules 都不进产物', () => {
    const harness = createHarness();
    const kept = harness.session('.claude/projects/-repo-a/main.jsonl', claudeSession('main', '正经会话'), Date.parse('2026-05-03T00:00:00.000Z'));
    harness.session('.claude/projects/-repo-a/notes.md', '# 这不是会话');
    harness.session('.claude/projects/-repo-a/node_modules/pkg/vendor.jsonl', claudeSession('vendor', '依赖里的日志'));
    harness.session('.claude/projects/-repo-a/.git/hooks.jsonl', claudeSession('hook', 'git 目录里的日志'));

    const report = collect(harness);
    assert.deepEqual(report.sessions.map((session) => session.sourcePath), [kept]);
    assert.equal(report.summary.discoveredCount, 1);
    assert.deepEqual(report.limitations, []);
  });
});

describe('collectAgentLogs 本机登记表扩展', () => {
  const SIBLING: AgentDescriptor = {
    agentId: 'sibling-host',
    displayName: 'Sibling Host',
    vendor: 'unknown',
    // 与内置宿主一样走 Claude 落盘格式：身份与格式归属分开。
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

  function seedSiblingCatalog(harness: Harness): AgentDescriptor[] {
    writeFileSync(
      join(harness.root, 'agents.json'),
      JSON.stringify({ schemaVersion: AGENT_CATALOG_VERSION, agents: [SIBLING] }),
    );
    mkdirSync(join(harness.home, '.sibling-host'), { recursive: true });
    harness.session(
      '.sibling-host/projects/-repo-a/session-c.jsonl',
      claudeSession('sess-c', '扩展登记表里的宿主也要能采到'),
      Date.parse('2026-05-18T11:00:00.000Z'),
    );
    return resolveAgentCatalog({ catalogPath: join(harness.root, 'agents.json') });
  }

  it('传入合并后的登记表时，只由扩展文件声明的宿主既进清单也进产物', () => {
    const harness = createHarness();
    const catalog = seedSiblingCatalog(harness);

    const report = collectAgentLogs(undefined, {
      layout: harness.layout,
      detect: { ...harness.detectOptions, descriptors: catalog },
    });
    const sibling = report.sessions.find((session) => session.agentId === 'sibling-host');
    assert.ok(sibling, `采集结果里应当有扩展条目：${JSON.stringify(report.agents)}`);
    assert.equal(sibling.rootId, 'sibling-projects');
    assert.equal(sibling.sourceKind, 'claude');
    assert.equal(existsSync(join(harness.layout.observeAgentsDir, sibling.artifactPath)), true);
    assert.equal(agentOf(report, 'sibling-host').logRoots[0]?.discoveredCount, 1);
  });

  it('清单用了扩展条目而根查找没拿到同一份表时，如实说明有多少 Agent 不在登记表内', () => {
    const harness = createHarness();
    const catalog = seedSiblingCatalog(harness);
    const inventory = detectAgentInventory({ ...harness.detectOptions, descriptors: catalog });

    // 只传清单、不传登记表：采集不得静默跳过这台机器上真实存在的宿主。
    const report = collectAgentLogs(inventory, { layout: harness.layout });
    assert.ok(
      report.limitations.some((line) => line.includes('不在当前登记表内')),
      JSON.stringify(report.limitations),
    );
    assert.equal(report.sessions.some((session) => session.agentId === 'sibling-host'), false);
  });
});
