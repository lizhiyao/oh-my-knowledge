import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createReportServer } from '../../src/server/report-server.js';
import type { ConversationCatalog } from '../../src/observability/conversation-catalog.js';
import { reportFileName } from '../../src/eval-core/artifact-file-names.js';
import { buildVariantSummary } from '../../src/eval-core/schema.js';
import { managedRecordId } from '../../src/managed/store.js';
import type { ArtifactKind, VariantResult } from '../../src/types/index.js';

const TEST_DIR = join(tmpdir(), `omk-test-reports-${Date.now()}`);
const JOBS_DIR = join(tmpdir(), `omk-test-jobs-${Date.now()}`);
const OBSERVATIONS_DIR = join(tmpdir(), `omk-test-observations-${Date.now()}`);
// 隔离 analyses / doctors dir,避免读取 home dir 的真实 SkillHealthReport / doctor report
// 导致 fixture skill 意外携带 observe / doctor snapshot(本地 / CI 漂移)。
const ANALYSES_DIR = join(tmpdir(), `omk-test-analyses-${Date.now()}`);
const DOCTORS_DIR = join(tmpdir(), `omk-test-doctors-${Date.now()}`);
const MANAGED_DIR = join(tmpdir(), `omk-test-managed-${Date.now()}`);
const REVIEW_RECORD_ID = managedRecordId('skill', 'review');
const CURVE_RECORD_ID = managedRecordId('skill', 'curvy');
const EMPTY_CONVERSATION_CATALOG: ConversationCatalog = {
  async listConversations() {
    return {
      conversations: [],
      totalTurnCount: 0,
      totalToolCallCount: 0,
      totalToolFailureCount: 0,
      indexedConversationCount: 0,
      unarchivedConversationCount: 0,
      archivedConversationCount: 0,
      workspaceCount: 0,
    };
  },
  async getConversation() {
    return undefined;
  },
  async loadTaskTrajectory() {
    return undefined;
  },
};

function variantResult(compositeScore: number): VariantResult {
  return {
    ok: true,
    durationMs: 100,
    durationApiMs: 90,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    execCostUSD: 0,
    judgeCostUSD: 0,
    costUSD: 0,
    numTurns: 1,
    outputPreview: 'ok',
    compositeScore,
    timing: { execMs: 90, gradeMs: 10, totalMs: 100 },
  };
}

function evaluationReport(
  id: string,
  scores: Record<string, number>,
  artifactHashes: Record<string, string>,
  sampleCount = 1,
) {
  const variants = Object.keys(scores);
  const executorRuntime = {
    executor: 'claude',
    model: 'sonnet',
    runtimeKind: 'agent-cli' as const,
    fingerprint: 'claude:sonnet:test',
    capabilities: {
      systemPrompt: 'native' as const,
      costUSD: 'reported' as const,
      trace: 'native' as const,
      skillIsolation: 'full' as const,
    },
  };
  const judgeRuntime = {
    executor: 'claude',
    model: 'haiku',
    runtimeKind: 'agent-cli' as const,
    fingerprint: 'claude:haiku:test',
    capabilities: {
      systemPrompt: 'native' as const,
      costUSD: 'reported' as const,
      trace: 'native' as const,
      skillIsolation: 'full' as const,
    },
  };
  const results = Array.from({ length: sampleCount }, (_, index) => ({
    sample_id: `s${String(index + 1).padStart(3, '0')}`,
    variants: Object.fromEntries(
      variants.map((variant) => [variant, variantResult(scores[variant])]),
    ) as Record<string, VariantResult>,
  }));
  return {
    kind: 'evaluation' as const,
    id,
    meta: {
      variants,
      model: 'sonnet',
      executor: 'claude',
      sampleCount,
      taskCount: sampleCount * variants.length,
      totalCostUSD: 0,
      timestamp: '2026-03-25T10:00:00.000Z',
      cliVersion: 'test',
      nodeVersion: process.version,
      schemaVersion: 4,
      artifactHashes,
      executorRuntime,
      executorRuntimes: Object.fromEntries(
        variants.map((variant) => [variant, executorRuntime]),
      ),
      judgeModels: [{ executor: 'claude', model: 'haiku', runtime: judgeRuntime }],
    },
    summary: Object.fromEntries(variants.map((variant) => [
      variant,
      {
        ...buildVariantSummary(results.map((entry) => entry.variants[variant])),
        avgCompositeScore: scores[variant],
      },
    ])),
    results,
  };
}

// 受管记录 fixture:git+url 源 → probeSourceState 直接 reachable + record.contentHash,零文件 IO、跨机稳定。
// install + 两版本证据(NOISE→PROGRESS) + promote(当前内容)→ 行状态应为 promoted。
const MANAGED_RECORD = {
  recordKind: 'managed-artifact',
  schemaVersion: 2,
  id: REVIEW_RECORD_ID,
  name: 'review',
  kind: 'skill',
  source: { sourceKind: 'git', locator: 'git+https://example.com/r@abc123:review', url: 'https://example.com/r', ref: 'abc123', isDirectorySkill: true },
  contentHash: 'hashV2smoke',
  installedAt: '2026-03-01T00:00:00.000Z',
  distribution: [],
  evidence: [
    { reportId: 'r1', contentHash: 'hashV1smoke', recordedAt: '2026-03-02T00:00:00.000Z', verdict: 'NOISE', sampleCoverage: { count: 6, hash: 'sh1' }, comparability: { cliVersion: '0.37.0' } },
    { reportId: 'test-run-001', contentHash: 'hashV2smoke', recordedAt: '2026-03-05T00:00:00.000Z', verdict: 'PROGRESS', sampleCoverage: { count: 6, hash: 'sh2' }, comparability: { cliVersion: '0.37.0' } },
  ],
  decisions: [
    { decisionKind: 'promote', actor: 'alice', decidedAt: '2026-03-06T00:00:00.000Z', contentHash: 'hashV2smoke', reportId: 'test-run-001' },
  ],
};

const SAMPLE_REPORT = evaluationReport(
  'test-run-001',
  { v1: 4, v2: 4.5 },
  { v1: 'hashV1smoke', v2: 'hashV2smoke' },
);

// 版本回归曲线集成 fixture:独立 record + 两版报告(都带 artifactHashes + composite/CI)→ GET /managed/<id>
// 应真的读报告、算点、画出 SVG 曲线。与 SAMPLE_REPORT / MANAGED_RECORD 解耦,不扰动它们的既有断言。
function curveReport(id: string, contentHash: string, composite: number, ci: [number, number]) {
  const report = evaluationReport(id, { cand: composite }, { cand: contentHash }, 6);
  report.summary.cand.bootstrapCI = {
    low: ci[0],
    high: ci[1],
    estimate: composite,
    samples: 1000,
  };
  return report;
}

// 两版同口径(同评委 JH / 同样本集 cs)→ 都可比;当前 = hashCurveV1。2 个可画点 → 曲线渲染。
const CURVE_RECORD = {
  recordKind: 'managed-artifact', schemaVersion: 2, id: CURVE_RECORD_ID, name: 'curvy', kind: 'skill',
  source: { sourceKind: 'git', locator: 'git+https://example.com/c@abc:curvy', url: 'https://example.com/c', ref: 'abc', isDirectorySkill: true },
  contentHash: 'hashCurveV1', installedAt: '2026-03-01T00:00:00.000Z', distribution: [],
  evidence: [
    { reportId: 'curve-r0', contentHash: 'hashCurveV0', recordedAt: '2026-03-02T00:00:00.000Z', verdict: 'CAUTIOUS', sampleCoverage: { count: 6, hash: 'cs' }, comparability: { cliVersion: '0.39.0', judgePromptHash: 'JH' } },
    { reportId: 'curve-r1', contentHash: 'hashCurveV1', recordedAt: '2026-03-04T00:00:00.000Z', verdict: 'PROGRESS', sampleCoverage: { count: 6, hash: 'cs' }, comparability: { cliVersion: '0.39.0', judgePromptHash: 'JH' } },
  ],
  decisions: [],
};

const SAMPLE_JOB = {
  jobId: 'job-test-run-001',
  status: 'succeeded',
  createdAt: '2026-03-25T10:00:00.000Z',
  updatedAt: '2026-03-25T10:00:02.000Z',
  startedAt: '2026-03-25T10:00:01.000Z',
  finishedAt: '2026-03-25T10:00:02.000Z',
  request: {
    samplesPath: 'eval-samples.json',
    skillDir: 'skills',
    artifacts: [],
    project: 'alpha',
    owner: 'lizhiyao',
    tags: ['smoke', 'nightly'],
    model: 'sonnet',
    judgeModel: 'haiku',
    executor: 'claude',
    judgeExecutor: 'claude',
    judgeModels: [{ executor: 'claude', model: 'haiku' }],
    noJudge: false,
    concurrency: 1,
    noCache: false,
    dryRun: false,
  },
  runId: 'test-run-001',
  resultReportId: 'test-run-001',
};

const FAILED_JOB = {
  jobId: 'job-test-run-002',
  status: 'failed',
  createdAt: '2026-03-25T11:00:00.000Z',
  updatedAt: '2026-03-25T11:00:03.000Z',
  startedAt: '2026-03-25T11:00:01.000Z',
  finishedAt: '2026-03-25T11:00:03.000Z',
  request: {
    samplesPath: 'eval-samples-2.json',
    skillDir: 'skills',
    artifacts: [],
    project: 'beta',
    owner: 'other-user',
    tags: ['regression'],
    model: 'sonnet',
    judgeModel: 'haiku',
    executor: 'claude',
    judgeExecutor: 'claude',
    judgeModels: [{ executor: 'claude', model: 'haiku' }],
    noJudge: false,
    concurrency: 1,
    noCache: false,
    dryRun: false,
  },
  runId: 'test-run-002',
  error: 'skill not found',
  errorCategory: 'user',
};

function stripScriptAndStyle(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

interface FetchResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function fetch(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('report-server', () => {
  let server: ReturnType<typeof createReportServer>;
  let baseUrl: string;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(JOBS_DIR, { recursive: true });
    mkdirSync(OBSERVATIONS_DIR, { recursive: true });
    mkdirSync(ANALYSES_DIR, { recursive: true });
    mkdirSync(DOCTORS_DIR, { recursive: true });
    mkdirSync(MANAGED_DIR, { recursive: true });
    writeFileSync(join(MANAGED_DIR, `${REVIEW_RECORD_ID}.json`), JSON.stringify(MANAGED_RECORD, null, 2));
    writeFileSync(join(TEST_DIR, reportFileName('test-run-001')), JSON.stringify(SAMPLE_REPORT, null, 2));
    writeFileSync(join(JOBS_DIR, 'job-test-run-001.json'), JSON.stringify(SAMPLE_JOB, null, 2));
    writeFileSync(join(JOBS_DIR, 'job-test-run-002.json'), JSON.stringify(FAILED_JOB, null, 2));
    writeFileSync(join(OBSERVATIONS_DIR, reportFileName('20260507T000000-a111')), JSON.stringify({
      kind: 'observe-inbox',
      schemaVersion: 2,
      meta: {
        tracePath: '/tmp/trace',
        generatedAt: '2026-05-07T00:00:00.000Z',
        segmentCount: 2,
        itemCount: 2,
      },
      items: [
        {
          id: 'obs-high',
          skillName: 'audit',
          artifactVersion: 'unknown',
          cwd: '/repo',
          sessionId: 's1',
          sourceTrace: '/tmp/trace/session.jsonl',
          sourceKind: 'claude',
          signalType: 'failed_search',
          signalSubtype: 'hard_miss',
          confidence: 0.9,
          attributionConfidence: 0.85,
          severity: 'high',
          severityReasonCode: 'knowledge_gap_suspected',
          evidence: { tool: 'Grep', query: 'schema' },
          firstSeen: '2026-05-07T00:00:00.000Z',
          lastSeen: '2026-05-07T00:00:00.000Z',
          occurrences: 1,
          recentSessionIds: ['s1'],
          representativeEvidence: [{ tool: 'Grep', query: 'schema' }],
        },
        {
          id: 'obs-noise',
          skillName: 'audit',
          artifactVersion: 'unknown',
          cwd: '/repo',
          sessionId: 's2',
          sourceTrace: '/tmp/trace/session.jsonl',
          sourceKind: 'claude',
          signalType: 'failed_search',
          signalSubtype: 'tool_limit',
          confidence: 0.2,
          attributionConfidence: 0.85,
          severity: 'noise',
          severityReasonCode: 'tool_or_runtime_noise',
          evidence: { tool: 'Read', path: '/repo/large.ts' },
          firstSeen: '2026-05-07T00:00:01.000Z',
          lastSeen: '2026-05-07T00:00:01.000Z',
          occurrences: 1,
          recentSessionIds: ['s2'],
          representativeEvidence: [{ tool: 'Read', path: '/repo/large.ts' }],
        },
      ],
      diagnostics: {
        schemaVersion: 1,
        generatedAt: '2026-05-07T00:00:00.000Z',
        sourceCoverage: { observe: true, doctor: false, eval: false },
        bySkill: {
          audit: [
            {
              id: 'diag-audit-skill-md',
              stableKey: 'skill:audit|type:definition_gap|signal:skill_md_not_found|target:definition:skill_md',
              skillName: 'audit',
              type: 'definition_gap',
              signal: 'skill_md_not_found',
              title: 'SKILL.md was not found',
              severity: 'high',
              audience: 'skill-author',
              lifecycle: 'detected',
              scope: { primary: 'definition', refs: { skillName: 'audit' } },
              occurrences: [{
                id: 'occ-audit-skill-md',
                diagnosisStableKey: 'skill:audit|type:definition_gap|signal:skill_md_not_found|target:definition:skill_md',
                source: 'observe',
                sourceId: 'skill_chain:audit:skill_md_not_found',
                sourceKind: 'skill_chain',
                timestamp: '2026-05-07T00:00:00.000Z',
                severity: 'high',
                evidenceRefs: [],
                producer: 'deterministic_rule',
                payload: {},
              }],
              occurrenceCount: 1,
            },
          ],
        },
      },
    }, null, 2));
    server = createReportServer({
      port: 0,
      reportsDir: TEST_DIR,
      observationsDir: OBSERVATIONS_DIR,
      jobsDir: JOBS_DIR,
      analysesDir: ANALYSES_DIR,
      doctorsDir: DOCTORS_DIR,
      managedDir: MANAGED_DIR,
      conversationCatalog: EMPTY_CONVERSATION_CATALOG,
    });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server.stop();
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(JOBS_DIR, { recursive: true, force: true });
    rmSync(OBSERVATIONS_DIR, { recursive: true, force: true });
    rmSync(ANALYSES_DIR, { recursive: true, force: true });
    rmSync(DOCTORS_DIR, { recursive: true, force: true });
    rmSync(MANAGED_DIR, { recursive: true, force: true });
  });

  it('GET /managed lists managed skills with link + verdict', async () => {
    const res = await fetch(`${baseUrl}/managed`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.ok(res.body.includes('review'), 'should show skill name');
    assert.ok(res.body.includes(`/managed/${REVIEW_RECORD_ID}`), 'should link to detail page by stable id');
    assert.ok(res.body.includes('verdict-PROGRESS'), 'current verdict badge');
    assert.ok(res.body.includes('已采用'), 'localized lifecycle label from promote decision (raw token stays in /api/managed)');
    assert.ok(res.body.includes('mh-legend'), 'state/marker legend present for first-time viewers');
  });

  it('GET /api/managed returns versioned envelope', async () => {
    const res = await fetch(`${baseUrl}/api/managed`);
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.schemaVersion, 1);
    assert.ok(Array.isArray(json.rows));
    const row = json.rows.find((r: { name: string }) => r.name === 'review');
    assert.ok(row, 'review row present');
    assert.equal(row.state, 'promoted');
    assert.equal(row.latestVerdict, 'PROGRESS');
  });

  it('GET /managed/<id> renders the decision timeline', async () => {
    const res = await fetch(`${baseUrl}/managed/${REVIEW_RECORD_ID}`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.ok(res.body.includes('mh-timeline'), 'timeline present');
    assert.ok(res.body.includes('安装纳管'), 'install event');
    assert.ok(res.body.includes('verdict-PROGRESS') && res.body.includes('verdict-NOISE'), 'both version verdicts');
    assert.ok(res.body.includes('alice'), 'promote actor');
    assert.ok(res.body.includes('/reports/test-run-001'), 'links to evidence report');
  });

  it('GET /managed/<id> 渲染版本回归曲线（路由读报告 → buildVersionScores → SVG）', async () => {
    // 独立 server + dirs:曲线报告不进共享 TEST_DIR,免得撑破 /api/reports 等按报告集合的断言。
    const cReports = join(tmpdir(), `omk-curve-reports-${Date.now()}`);
    const cManaged = join(tmpdir(), `omk-curve-managed-${Date.now()}`);
    mkdirSync(cReports, { recursive: true });
    mkdirSync(cManaged, { recursive: true });
    writeFileSync(join(cManaged, `${CURVE_RECORD_ID}.json`), JSON.stringify(CURVE_RECORD, null, 2));
    writeFileSync(join(cReports, reportFileName('curve-r0')), JSON.stringify(curveReport('curve-r0', 'hashCurveV0', 3.0, [2.7, 3.3]), null, 2));
    writeFileSync(join(cReports, reportFileName('curve-r1')), JSON.stringify(curveReport('curve-r1', 'hashCurveV1', 4.2, [3.9, 4.5]), null, 2));
    const cServer = createReportServer({ port: 0, reportsDir: cReports, managedDir: cManaged });
    const cUrl = await cServer.start();
    try {
      const res = await fetch(`${cUrl}/managed/${CURVE_RECORD_ID}`);
      assert.equal(res.status, 200);
      // 曲线出现 ⇒ 路由确实按 evidence.reportId 读到两版报告、取了 composite/CI 交给渲染器(端到端接线)。
      assert.ok(res.body.includes('mh-curve'), '曲线 section 渲染');
      assert.ok(res.body.includes('版本回归曲线'), '曲线标题');
      assert.ok(res.body.includes('<svg'), 'SVG 画出');
      assert.ok(res.body.includes('mh-timeline'), '时间线仍在');
    } finally {
      await cServer.stop();
      rmSync(cReports, { recursive: true, force: true });
      rmSync(cManaged, { recursive: true, force: true });
    }
  });

  it('GET /managed/<missing> → 404 (zh default, en via ?lang=en)', async () => {
    const zh = await fetch(`${baseUrl}/managed/nope`);
    assert.equal(zh.status, 404);
    assert.ok(zh.body.includes('受管记录不存在'));
    const en = await fetch(`${baseUrl}/managed/nope?lang=en`);
    assert.equal(en.status, 404);
    assert.ok(en.body.includes('managed record not found'));
  });

  it('GET /managed/<malformed %> → 404, not 500', async () => {
    const res = await fetch(`${baseUrl}/managed/%E0%A4%A`);
    assert.equal(res.status, 404, 'bad percent-encoding decodes to no match, not a crash');
  });

  it('EN 页内跳转透传 lang=en —— 列表行 / 返回 / 报告链接都带 lang(P2)', async () => {
    const list = await fetch(`${baseUrl}/managed?lang=en`);
    assert.ok(list.body.includes(`/managed/${REVIEW_RECORD_ID}?lang=en`), 'list row link carries lang');
    const detail = await fetch(`${baseUrl}/managed/${REVIEW_RECORD_ID}?lang=en`);
    assert.ok(detail.body.includes('/managed?lang=en'), 'back-to-list link carries lang');
    assert.ok(detail.body.includes('/reports/test-run-001?lang=en'), 'evidence report link carries lang');
  });

  it('同名跨 kind —— skill/review 与 prompt/review 各有独立 id,都可达(P1)', async () => {
    const dir = join(tmpdir(), `omk-test-managed-xkind-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const mk = (kind: ArtifactKind, name: string) => ({
      recordKind: 'managed-artifact', schemaVersion: 2, id: managedRecordId(kind, name), name, kind,
      source: { sourceKind: 'git', locator: 'git+https://x@s:review', url: 'https://x', ref: 's', isDirectorySkill: kind === 'skill' },
      contentHash: 'h', installedAt: '2026-03-01T00:00:00.000Z', distribution: [], evidence: [], decisions: [],
    });
    const skillRecord = mk('skill', 'review');
    const promptRecord = mk('prompt', 'review');
    writeFileSync(join(dir, `${skillRecord.id}.json`), JSON.stringify(skillRecord));
    writeFileSync(join(dir, `${promptRecord.id}.json`), JSON.stringify(promptRecord));
    const s = createReportServer({ port: 0, reportsDir: TEST_DIR, jobsDir: JOBS_DIR, observationsDir: OBSERVATIONS_DIR, analysesDir: ANALYSES_DIR, doctorsDir: DOCTORS_DIR, managedDir: dir });
    const u = await s.start();
    try {
      assert.equal((await fetch(`${u}/managed/${skillRecord.id}`)).status, 200, 'skill/review reachable');
      assert.equal((await fetch(`${u}/managed/${promptRecord.id}`)).status, 200, 'prompt/review reachable');
      const listBody = (await fetch(`${u}/managed`)).body;
      assert.ok(listBody.includes(`/managed/${skillRecord.id}`) && listBody.includes(`/managed/${promptRecord.id}`), 'both rows link to distinct ids');
    } finally {
      await s.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('受管根目录按请求解析 —— 会话中途项目获首条记录后从 global 切回 project,不冻结于启动(P1)', async () => {
    // 复现 reviewer 场景的可控版:local 空 → 解析到 global;local 有记录 → 解析到 local(模拟 resolveManagedDir
    // 的 project→global 回退,但用受控 temp 目录、不碰 homedir,跨机稳定)。注入解析器 = server 持有的是「如何解析」
    // 策略而非冻结 root —— 若 server 在启动时定死,中途新增的 project 记录就永远看不到。
    const projDir = join(tmpdir(), `omk-test-managed-proj-${Date.now()}`);
    const globalDir = join(tmpdir(), `omk-test-managed-glob-${Date.now()}`);
    mkdirSync(projDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    const mk = (name: string) => ({
      recordKind: 'managed-artifact', schemaVersion: 2, id: managedRecordId('skill', name), name, kind: 'skill',
      source: { sourceKind: 'git', locator: 'git+https://x@s:review', url: 'https://x', ref: 's', isDirectorySkill: true },
      contentHash: 'h', installedAt: '2026-03-01T00:00:00.000Z', distribution: [], evidence: [], decisions: [],
    });
    const globalRecord = mk('global-skill');
    writeFileSync(join(globalDir, `${globalRecord.id}.json`), JSON.stringify(globalRecord));
    // local 非空才用 local,否则回退 global —— 即 resolveManagedDir 的口径。
    const resolver = (): string => (readdirSync(projDir).length > 0 ? projDir : globalDir);
    const s = createReportServer({ port: 0, reportsDir: TEST_DIR, jobsDir: JOBS_DIR, observationsDir: OBSERVATIONS_DIR, analysesDir: ANALYSES_DIR, doctorsDir: DOCTORS_DIR, managedDir: resolver });
    const u = await s.start();
    try {
      const before = JSON.parse((await fetch(`${u}/api/managed`)).body);
      assert.deepEqual(before.rows.map((r: { name: string }) => r.name), ['global-skill'], '启动时 local 空 → 解析到 global');
      // 会话中途:项目里首次 install,local 目录获得记录。
      const projectRecord = mk('project-skill');
      writeFileSync(join(projDir, `${projectRecord.id}.json`), JSON.stringify(projectRecord));
      const after = JSON.parse((await fetch(`${u}/api/managed`)).body);
      assert.deepEqual(after.rows.map((r: { name: string }) => r.name), ['project-skill'], '中途 local 获记录 → 同一会话实时切回 project');
    } finally {
      await s.stop();
      rmSync(projDir, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it('analyses 目录按请求解析 —— 项目获报告后同会话切回 project,不冻结(P1)', async () => {
    // 同 managed:注入受控 resolver(项目空→global),验 server 持有「如何解析」而非启动时冻结 root。
    // doctorsDir 也传函数,顺带验三模式接受函数不报错。
    const projA = join(tmpdir(), `omk-test-an-proj-${Date.now()}`);
    const globA = join(tmpdir(), `omk-test-an-glob-${Date.now()}`);
    mkdirSync(projA, { recursive: true });
    mkdirSync(globA, { recursive: true });
    const healthReport = (gen: string): string => JSON.stringify({
      meta: { generatedAt: gen, sessionCount: 1, segmentCount: 0, toolCallCount: 0, toolFailureRate: 0, messageCount: 0, tracePath: '/t', kbPath: null, timeRange: { from: '', to: '' } },
      overall: { gapRate: 0, weightedGapRate: 0, healthBand: 'green', confidence: 'underpowered' },
      bySkill: {},
    });
    writeFileSync(join(globA, reportFileName('global-h')), healthReport('2026-01-01T00:00:00Z'));
    const analysesResolver = (): string => (readdirSync(projA).length > 0 ? projA : globA);
    const s = createReportServer({ port: 0, reportsDir: TEST_DIR, jobsDir: JOBS_DIR, observationsDir: OBSERVATIONS_DIR, analysesDir: analysesResolver, doctorsDir: (): string => DOCTORS_DIR, managedDir: MANAGED_DIR });
    const u = await s.start();
    try {
      const before = JSON.parse((await fetch(`${u}/api/observe-health`)).body) as Array<{ id: string }>;
      assert.deepEqual(before.map((x) => x.id), ['global-h'], '启动时项目空 → 解析到 global');
      writeFileSync(join(projA, reportFileName('proj-h')), healthReport('2026-02-02T00:00:00Z'));
      const after = JSON.parse((await fetch(`${u}/api/observe-health`)).body) as Array<{ id: string }>;
      assert.deepEqual(after.map((x) => x.id), ['proj-h'], '中途项目获报告 → 同会话实时切回 project');
    } finally {
      await s.stop();
      rmSync(projA, { recursive: true, force: true });
      rmSync(globA, { recursive: true, force: true });
    }
  });

  it('GET /health returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
  });

  it('GET /api/reports returns run list', async () => {
    const res = await fetch(`${baseUrl}/api/reports`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'test-run-001');
  });

  it('GET /api/jobs returns job list', async () => {
    const res = await fetch(`${baseUrl}/api/jobs`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 2);
    assert.deepEqual(data.map((job: { jobId: string }) => job.jobId).sort(), ['job-test-run-001', 'job-test-run-002']);
  });

  it('GET /api/job/:id returns job detail', async () => {
    const res = await fetch(`${baseUrl}/api/job/job-test-run-001`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.jobId, 'job-test-run-001');
    assert.equal(data.resultReportId, 'test-run-001');
  });

  it('GET /api/jobs supports filtering by status', async () => {
    const res = await fetch(`${baseUrl}/api/jobs?status=failed`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.length, 1);
    assert.equal(data[0].jobId, 'job-test-run-002');
  });

  it('GET /observe-health 列表入口:underpowered 报告圆点改灰 + 样本不足,high-N red 仍硬红', async () => {
    // underpowered(segmentCount 2,缺 confidence 走 segmentCount 兜底)+ red 健康带。
    const healthFixture = (segmentCount: number, generatedAt: string) => {
      const signals = Array.from({ length: segmentCount / 2 }, (_, index) => ({
        sampleId: `audit:${index}`,
        type: 'failed_search',
        context: 'No matches found',
        weight: 1,
      }));
      return {
        meta: { generatedAt, sessionCount: 1, segmentCount, toolCallCount: 0, toolFailureRate: 0, messageCount: 0, tracePath: '/t', kbPath: null, timeRange: { from: '2026-05-09T00:00:00Z', to: generatedAt } },
        overall: { gapRate: 0.5, weightedGapRate: 0.5, healthBand: 'red' },
        bySkill: {
          audit: {
            skillName: 'audit',
            segmentCount,
            toolCallCount: 0,
            toolFailureCount: 0,
            toolFailureRate: 0,
            coverage: null,
            gap: { gapRate: 0.5, weightedGapRate: 0.5, signals },
          },
        },
      };
    };
    const lowN = healthFixture(2, '2026-05-09T01:00:00Z');
    const highN = healthFixture(40, '2026-05-09T02:00:00Z');
    writeFileSync(join(ANALYSES_DIR, reportFileName('an-lown')), JSON.stringify(lowN));
    writeFileSync(join(ANALYSES_DIR, reportFileName('an-highn')), JSON.stringify(highN));
    try {
      const res = await fetch(`${baseUrl}/observe-health`);
      assert.equal(res.status, 200);
      // 低 N 报告:中性灰圆点 + 「样本不足」,不出现硬红圆点(本列表只有这一种带背景色的圆点)。
      assert.match(res.body, /background:var\(--text-faint\)/);
      assert.match(res.body, /样本不足/);
      // high-N red 报告仍保留硬红圆点。
      assert.match(res.body, /background:var\(--red\)/);
    } finally {
      rmSync(join(ANALYSES_DIR, reportFileName('an-lown')), { force: true });
      rmSync(join(ANALYSES_DIR, reportFileName('an-highn')), { force: true });
    }
  });

  it('skill trend 对未知工具结果保留不可测，不伪造 0% 失败率', async () => {
    const id = 'an-unknown-tool-outcomes';
    const path = join(ANALYSES_DIR, reportFileName(id));
    writeFileSync(path, JSON.stringify({
      kind: 'observe-health',
      meta: {
        generatedAt: '2026-05-10T01:00:00Z',
        sessionCount: 10,
        segmentCount: 10,
        messageCount: 10,
        toolCallCount: 5,
        toolResolvedCount: 0,
        toolUnknownCount: 5,
        toolOutcomeCoverage: 0,
        toolFailureRate: 0,
        tracePath: '/t',
        kbPath: null,
        timeRange: { from: '2026-05-10T00:00:00Z', to: '2026-05-10T01:00:00Z' },
      },
      overall: { gapRate: 0.1, weightedGapRate: 0.1, healthBand: 'yellow', confidence: 'low' },
      bySkill: {
        audit: {
          skillName: 'audit',
          segmentCount: 10,
          toolCallCount: 5,
          toolFailureCount: 0,
          toolResolvedCount: 0,
          toolUnknownCount: 5,
          toolOutcomeCoverage: 0,
          toolFailureRate: 0,
          stability: 'unknown',
          confidence: 'low',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 0,
            durationMs: 0,
            numTurns: 0,
            avgTokensPerSegment: 0,
            avgDurationMsPerSegment: 0,
          },
          coverage: null,
          gap: {
            gapRate: 0.1,
            weightedGapRate: 0.1,
            signals: [{
              sampleId: 'audit:1',
              type: 'failed_search',
              context: 'No matches found',
              weight: 1,
            }],
          },
        },
      },
    }));
    try {
      const api = await fetch(`${baseUrl}/api/skill-trend/audit`);
      assert.equal(api.status, 200);
      const point = JSON.parse(api.body).points.find((value: { analysisId: string }) => value.analysisId === id);
      assert.equal(point.failureRate, null);
      assert.equal(point.stability, 'unknown');
      assert.equal(point.toolResolvedCount, 0);
      assert.equal(point.toolCallCount, 5);
      assert.equal(point.toolOutcomeCoverage, 0);

      const page = await fetch(`${baseUrl}/skill-trend/audit`);
      assert.equal(page.status, 200);
      assert.match(page.body, /color:#a78bfa">—<\/td>/);
      assert.doesNotMatch(page.body, /<circle[^>]+fill="#a78bfa"/);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('skill trend 对全部取消的工具结果保留 100% 结果覆盖率，但失败率不可测', async () => {
    const id = 'an-cancelled-tool-outcomes';
    const path = join(ANALYSES_DIR, reportFileName(id));
    writeFileSync(path, JSON.stringify({
      kind: 'observe-health',
      meta: {
        generatedAt: '2026-05-10T03:00:00Z',
        sessionCount: 10,
        segmentCount: 10,
        messageCount: 10,
        toolCallCount: 5,
        toolResolvedCount: 5,
        toolCancelledCount: 5,
        toolUnknownCount: 0,
        toolOutcomeCoverage: 1,
        toolFailureRate: 0,
        tracePath: '/t',
        kbPath: null,
        timeRange: { from: '2026-05-10T02:00:00Z', to: '2026-05-10T03:00:00Z' },
      },
      overall: { gapRate: 0, weightedGapRate: 0, healthBand: 'green', confidence: 'low' },
      bySkill: {
        audit: {
          skillName: 'audit',
          segmentCount: 10,
          toolCallCount: 5,
          toolFailureCount: 0,
          toolResolvedCount: 5,
          toolCancelledCount: 5,
          toolUnknownCount: 0,
          toolOutcomeCoverage: 1,
          toolFailureRate: 0,
          stability: 'unknown',
          confidence: 'low',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 0,
            durationMs: 0,
            numTurns: 0,
            avgTokensPerSegment: 0,
            avgDurationMsPerSegment: 0,
          },
          coverage: null,
          gap: { gapRate: 0, weightedGapRate: 0, signals: [] },
        },
      },
    }));
    try {
      const api = await fetch(`${baseUrl}/api/skill-trend/audit`);
      assert.equal(api.status, 200);
      const point = JSON.parse(api.body).points.find((value: { analysisId: string }) => value.analysisId === id);
      assert.equal(point.failureRate, null);
      assert.equal(point.stability, 'unknown');
      assert.equal(point.toolResolvedCount, 5);
      assert.equal(point.toolComparableCount, 0);
      assert.equal(point.toolCancelledCount, 5);
      assert.equal(point.toolOutcomeCoverage, 1);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('skill trend 重算稀疏旧报告的稳定性，并转义技能名', async () => {
    const id = 'an-sparse-legacy-tool-outcomes';
    const path = join(ANALYSES_DIR, reportFileName(id));
    const skillName = '<img src=x onerror=alert(1)>';
    writeFileSync(path, JSON.stringify({
      kind: 'observe-health',
      meta: {
        generatedAt: '2026-05-11T01:00:00Z',
        sessionCount: 1,
        segmentCount: 1,
        messageCount: 1,
        toolCallCount: 1,
        toolFailureRate: 1,
        tracePath: '/t',
        kbPath: null,
        timeRange: { from: '2026-05-11T00:00:00Z', to: '2026-05-11T01:00:00Z' },
      },
      overall: { gapRate: 0, weightedGapRate: 0, healthBand: 'yellow', confidence: 'underpowered' },
      bySkill: {
        [skillName]: {
          skillName,
          segmentCount: 1,
          toolCallCount: 1,
          toolFailureCount: 1,
          toolFailureRate: 1,
          stability: 'very-unstable',
          confidence: 'underpowered',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 0,
            durationMs: 0,
            numTurns: 0,
            avgTokensPerSegment: 0,
            avgDurationMsPerSegment: 0,
          },
          coverage: null,
          gap: { gapRate: 0, weightedGapRate: 0, signals: [] },
        },
      },
    }));
    try {
      const api = await fetch(`${baseUrl}/api/skill-trend/${encodeURIComponent(skillName)}`);
      assert.equal(api.status, 200);
      const point = JSON.parse(api.body).points.find((value: { analysisId: string }) => value.analysisId === id);
      assert.equal(point.failureRate, 1);
      assert.equal(point.stability, 'unstable');

      const page = await fetch(`${baseUrl}/skill-trend/${encodeURIComponent(skillName)}`);
      assert.equal(page.status, 200);
      assert.match(page.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
      assert.doesNotMatch(page.body, /<img src=x onerror=alert\(1\)>/);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('旧 observe 路由兜底到 observe-* canonical:页面 302、API 307(querystring 透传)', async () => {
    // 改名后旧外链 / 书签 / 已打开页面的旧 fetch 不能 404。helper 用 http.request 不跟随重定向,直接验状态码 + Location。
    // 页面 302(临时);API 307 —— review-state 有 POST/DELETE,302 会被降级成 GET,307 保留 method。
    const cases: Array<[string, number, string]> = [
      ['/analyses', 302, '/observe-health'],
      ['/analyses/some-id?lang=en', 302, '/observe-health/some-id?lang=en'],
      ['/observations', 302, '/observe-inbox'],
      ['/observations/inbox?skill=foo', 302, '/observe-inbox?skill=foo'],
      ['/api/analyses', 307, '/api/observe-health'],
      ['/api/analyses/some-id', 307, '/api/observe-health/some-id'],
      ['/api/observations/inbox?severity=high', 307, '/api/observe-inbox?severity=high'],
      ['/api/observations/show?id=obs-high', 307, '/api/observe-inbox/show?id=obs-high'],
      ['/api/observations/diagnostics', 307, '/api/observe-inbox/diagnostics'],
      ['/api/observations/review-state', 307, '/api/observe-inbox/review-state'],
    ];
    for (const [from, status, to] of cases) {
      const res = await fetch(`${baseUrl}${from}`);
      assert.equal(res.status, status, `${from} should ${status}`);
      assert.equal(res.headers.location, to, `${from} → ${to}`);
    }
  });

  it('GET /api/observe-inbox supports severity and limit query params', async () => {
    const res = await fetch(`${baseUrl}/api/observe-inbox?severity=high&limit=1`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.length, 1);
    assert.equal(data[0].skillName, 'audit');
    assert.equal(data[0].severity, 'high');
  });

  it('review-state API distinguishes invalid and oversized client payloads from server failures', async () => {
    const invalidJson = await fetch(`${baseUrl}/api/observe-inbox/review-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(JSON.parse(invalidJson.body).error, 'invalid json body');

    const invalidShape = await fetch(`${baseUrl}/api/observe-inbox/review-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    });
    assert.equal(invalidShape.status, 400);
    assert.equal(JSON.parse(invalidShape.body).error, 'json body must be an object');

    const invalidDomain = await fetch(`${baseUrl}/api/observe-inbox/review-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'inbox_item', targetId: '', verdict: 'real_issue' }),
    });
    assert.equal(invalidDomain.status, 400);
    assert.equal(JSON.parse(invalidDomain.body).error, 'invalid review targetId');

    const objectTargetId = await fetch(`${baseUrl}/api/observe-inbox/review-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetType: 'inbox_item',
        targetId: { id: 'must-not-coerce' },
        verdict: 'real_issue',
      }),
    });
    assert.equal(objectTargetId.status, 400);
    assert.equal(JSON.parse(objectTargetId.body).error, 'invalid review targetId');

    const invalidMetadata = await fetch(`${baseUrl}/api/observe-inbox/review-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetType: 'inbox_item',
        targetId: 'invalid-metadata',
        verdict: 'real_issue',
        note: { text: 'must-not-drop' },
      }),
    });
    assert.equal(invalidMetadata.status, 400);
    assert.equal(JSON.parse(invalidMetadata.body).error, 'invalid review metadata');

    const oversized = await fetch(`${baseUrl}/api/observe-inbox/review-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'x'.repeat(1024 * 1024 + 1) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(JSON.parse(oversized.body).error, 'request body too large');
  });

  it('review-state and shutdown mutations reject cross-origin browser requests', async () => {
    const crossOriginPost = await fetch(`${baseUrl}/api/observe-inbox/review-state`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
      },
      body: JSON.stringify({
        targetType: 'inbox_item',
        targetId: 'cross-origin-write',
        verdict: 'real_issue',
      }),
    });
    assert.equal(crossOriginPost.status, 403);
    assert.equal(JSON.parse(crossOriginPost.body).error, 'cross-origin mutation is not allowed');

    const crossOriginDelete = await fetch(
      `${baseUrl}/api/observe-inbox/review-state?targetType=inbox_item&targetId=cross-origin-write`,
      {
        method: 'DELETE',
        headers: { Origin: 'https://attacker.example' },
      },
    );
    assert.equal(crossOriginDelete.status, 403);

    const crossOriginShutdown = await fetch(`${baseUrl}/api/shutdown`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example' },
    });
    assert.equal(crossOriginShutdown.status, 403);

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
  });

  it('report deletion rejects cross-origin browser requests', async () => {
    const id = 'cross-origin-delete';
    writeFileSync(
      join(TEST_DIR, reportFileName(id)),
      JSON.stringify({ ...SAMPLE_REPORT, id }),
    );
    try {
      const rejected = await fetch(`${baseUrl}/api/reports/${id}`, {
        method: 'DELETE',
        headers: { Origin: 'https://attacker.example' },
      });
      assert.equal(rejected.status, 403);
      assert.equal(
        JSON.parse(rejected.body).error,
        'cross-origin mutation is not allowed',
      );
      assert.equal((await fetch(`${baseUrl}/api/reports/${id}`)).status, 200);
    } finally {
      rmSync(join(TEST_DIR, reportFileName(id)), { force: true });
    }
  });

  it('review-state POST only accepts JSON media types', async () => {
    const plainText = await fetch(`${baseUrl}/api/observe-inbox/review-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        targetType: 'inbox_item',
        targetId: 'plain-text-write',
        verdict: 'real_issue',
      }),
    });
    assert.equal(plainText.status, 415);
    assert.equal(JSON.parse(plainText.body).error, 'content-type must be application/json');
  });

  it('GET /observe-inbox exposes the observe → sample draft next action', async () => {
    const res = await fetch(`${baseUrl}/observe-inbox`);
    assert.equal(res.status, 200);
    assert.match(res.body, /data-observe-feedback-loop/);
    assert.match(res.body, /把已确认的 observe gap 回流成 eval sample/);
    assert.match(res.body, /omk sample --from-traces --observations-dir/);
  });

  it('GET /observe-inbox?skill exposes a skill-scoped sample draft command', async () => {
    const res = await fetch(`${baseUrl}/observe-inbox?skill=audit`);
    assert.equal(res.status, 200);
    assert.match(res.body, /data-observe-feedback-loop/);
    assert.match(res.body, /omk sample --from-traces --observations-dir[^<]*--skill audit/);
  });

  it('GET /api/observe-inbox/diagnostics exposes observe-backed Diagnosis data', async () => {
    const res = await fetch(`${baseUrl}/api/observe-inbox/diagnostics`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.sourceCoverage.observe, true);
    assert.equal(data.summary.totalCount, 1);
    assert.equal(data.bySkill.audit[0].signal, 'skill_md_not_found');
  });

  it('GET /api/skills includes diagnosis counts without changing renderer output', async () => {
    const res = await fetch(`${baseUrl}/api/skills`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    const audit = data.entries.find((entry: { skillName: string }) => entry.skillName === 'audit');
    assert.ok(audit);
    assert.equal(audit.diagnosisCount, 1);
    assert.equal(data.diagnosisSummary.sourceCoverage.observe, true);
  });

  it('Diagnosis-only skill 的 band 被升级,API summary 跟 HTML renderer 口径一致', async () => {
    // audit skill 在 fixture 里只有 observe Diagnosis(high `skill_md_not_found`),没有
    // doctor / eval / observe snapshot。原先 band 一律 gray,summary.gray += 1,renderer
    // 通过 assessHealth 把卡片标红 —— 跨层矛盾。修后 entry.band 应升级为 red,summary.red
    // 包含它,/api/skills 暴露的 band 跟 HTML 视觉一致。
    const res = await fetch(`${baseUrl}/api/skills`);
    const data = JSON.parse(res.body);
    const audit = data.entries.find((entry: { skillName: string }) => entry.skillName === 'audit');
    assert.ok(audit);
    assert.equal(audit.band, 'red', 'Diagnosis-only skill 的 band 应升级到 red(high severity)');
    assert.ok(data.summary.red >= 1, 'summary.red 应包含 Diagnosis-only red skill');
  });

  it('GET /api/skills/:name/diagnostics returns per-skill diagnostics', async () => {
    const res = await fetch(`${baseUrl}/api/skills/audit/diagnostics`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.skillName, 'audit');
    assert.equal(data.diagnostics.length, 1);
    assert.equal(data.diagnostics[0].signal, 'skill_md_not_found');
  });

  it('GET /api/jobs supports filtering by project and tag', async () => {
    const res = await fetch(`${baseUrl}/api/jobs?project=alpha&tag=nightly`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.length, 1);
    assert.equal(data[0].jobId, 'job-test-run-001');
  });

  it('GET /api/reports/:id returns run detail', async () => {
    const res = await fetch(`${baseUrl}/api/reports/test-run-001`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.id, 'test-run-001');
    assert.equal(data.meta.model, 'sonnet');
  });

  it('GET /api/reports/:id returns 404 for missing run', async () => {
    const res = await fetch(`${baseUrl}/api/reports/nonexistent`);
    assert.equal(res.status, 404);
  });

  it('GET / returns the Codex conversation overview', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']!.includes('text/html'));
    assert.ok(res.body.includes('Codex 对话'));
    assert.ok(res.body.includes('conversation-app-nav'));
    assert.ok(res.body.includes('<h1>对话</h1>'));
    assert.ok(res.body.includes('conversation-index-app'));
    assert.ok(res.body.includes('data-page-next'));
  });

  it('GET /api/conversations/activity returns a compact activity snapshot', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/activity`);

    assert.equal(res.status, 200);
    const snapshot = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(snapshot.schemaVersion, 1);
    assert.match(String(snapshot.revision), /^[a-f0-9]{24}$/u);
    assert.equal(typeof snapshot.runningCount, 'number');
  });

  it('GET /knowledge returns the skill list', async () => {
    const res = await fetch(`${baseUrl}/knowledge`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']!.includes('text/html'));
    assert.ok(res.body.includes('data-href="/skills/'));
  });

  it('GET /reports/:id returns HTML detail page', async () => {
    const res = await fetch(`${baseUrl}/reports/test-run-001`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']!.includes('text/html'));
    assert.ok(res.body.includes('test-run-001'));
  });

  it('passes ?lang=en through skill list and detail pages', async () => {
    const list = await fetch(`${baseUrl}/knowledge?lang=en`);
    assert.equal(list.status, 200);
    assert.ok(list.body.includes('data-lang="en"'));
    // 列表行链接到 skill hub 并保留 ?lang=en
    assert.ok(/data-href="\/skills\/[^"]*\?lang=en/.test(list.body));

    const detail = await fetch(`${baseUrl}/reports/test-run-001?lang=en`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.includes('data-lang="en"'));
    assert.ok(detail.body.includes('Evaluation Report'));
    assert.ok(detail.body.includes('Back to list'));
    assert.ok(!stripScriptAndStyle(detail.body).includes('评测报告'));
  });

  it('DELETE /api/reports/:id removes report', async () => {
    // Create a temp report to delete
    writeFileSync(join(TEST_DIR, reportFileName('to-delete')), JSON.stringify({ ...SAMPLE_REPORT, id: 'to-delete' }));

    const res = await fetch(`${baseUrl}/api/reports/to-delete`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    // Verify it's gone
    const check = await fetch(`${baseUrl}/api/reports/to-delete`);
    assert.equal(check.status, 404);
  });

  it('DELETE /api/reports/:id returns 404 for missing run', async () => {
    const res = await fetch(`${baseUrl}/api/reports/nonexistent`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  it('DELETE /api/reports/:id rejects sanitized filename aliases', async () => {
    const id = 'encoded_alias';
    writeFileSync(
      join(TEST_DIR, reportFileName(id)),
      JSON.stringify({ ...SAMPLE_REPORT, id }),
    );
    try {
      const alias = await fetch(`${baseUrl}/api/reports/encoded%2Falias`, {
        method: 'DELETE',
      });
      assert.equal(alias.status, 404);
      assert.equal((await fetch(`${baseUrl}/api/reports/${id}`)).status, 200);
    } finally {
      rmSync(join(TEST_DIR, reportFileName(id)), { force: true });
    }
  });

  it('GET /doctors/:id?skill= 批量 doctor 同 id 多文件时按 skill 选中对应 per-skill 文件', async () => {
    // persistDoctorReport 把批量 doctor 按 skill 拆成多份文件,每份 spread 同一个 report.id;
    // 修复前 loadDoctorReport 只按 id 命中 readdir 顺序的第一份,?skill= 第二个 skill 时
    // 可能渲染第一个 skill 的体检结果。
    const batchId = 'doctor-batch-20260610';
    const mkPerSkill = (skillName: string, ruleId: string) => ({
      kind: 'doctor',
      schemaVersion: '3.0.0',
      id: batchId,
      timestamp: '2026-06-10T10:00:00.000Z',
      cliVersion: '0.0.0-test',
      cwd: '/repo',
      executorName: 'claude',
      model: 'sonnet',
      skills: [{
        skillName,
        skillPath: `/repo/skills/${skillName}`,
        status: 'warn',
        results: [{ ruleId, severity: 'warn', labelKey: 'doctor.rule.test', status: 'warn', message: `${skillName} 警告`, durationMs: 1 }],
      }],
      ruleStats: { pass: 0, warn: 1, fail: 0, skipped: 0, total: 1 },
      totals: { pass: 0, warn: 1, fail: 0 },
      outcome: 'warnings_only',
    });
    writeFileSync(join(DOCTORS_DIR, reportFileName(`batch-skill-one-batch-20260610`)), JSON.stringify(mkPerSkill('batch-skill-one', 'rule-only-in-one'), null, 2));
    writeFileSync(join(DOCTORS_DIR, reportFileName(`batch-skill-two-batch-20260610`)), JSON.stringify(mkPerSkill('batch-skill-two', 'rule-only-in-two'), null, 2));
    try {
      const res = await fetch(`${baseUrl}/doctors/${batchId}?skill=batch-skill-two`);
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type']!.includes('text/html'));
      assert.ok(res.body.includes('batch-skill-two'), '应渲染 ?skill= 指定 skill 的体检结果');
      assert.ok(res.body.includes('rule-only-in-two'), '应包含第二个 skill 独有的规则');
      assert.ok(!res.body.includes('rule-only-in-one'), '不应渲染另一个 per-skill 文件独有的规则');
      assert.ok(!res.body.includes('batch-skill-one'), '不应回退展示第一个 skill');
    } finally {
      rmSync(join(DOCTORS_DIR, reportFileName(`batch-skill-one-batch-20260610`)), { force: true });
      rmSync(join(DOCTORS_DIR, reportFileName(`batch-skill-two-batch-20260610`)), { force: true });
    }
  });

  it('GET /doctors/:id 不存在时返回 404 + 中文文案(?lang=en 走英文)', async () => {
    const res = await fetch(`${baseUrl}/doctors/no-such-doctor-id`);
    assert.equal(res.status, 404);
    assert.ok(res.body.includes('体检报告不存在'));

    const en = await fetch(`${baseUrl}/doctors/no-such-doctor-id?lang=en`);
    assert.equal(en.status, 404);
    assert.ok(en.body.includes('doctor report not found'));
  });

  it('GET /skills/:name returns the skill hub', async () => {
    const res = await fetch(`${baseUrl}/skills/v1`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']!.includes('text/html'));
    assert.ok(res.body.includes('v1'));
    assert.ok(res.body.includes('Back to Skills') || res.body.includes('返回 Skill 列表'));
  });

  it('GET /skills/:name with malformed encoding returns 404', async () => {
    const res = await fetch(`${baseUrl}/skills/%`);
    assert.equal(res.status, 404);
    assert.ok(res.body.includes('Not Found'));
  });

  it('all parameterized routes fail closed on malformed percent encoding', async () => {
    const paths = [
      '/doctors/%',
      '/observe-health/%',
      '/api/observe-health/%',
      '/api/skill-trend/%',
      '/skill-trend/%',
      '/api/job/%',
      '/api/reports/%',
      '/api/trends/%',
      '/trends/%',
      '/reports/%',
      '/api/skills/%/diagnostics',
    ];
    for (const path of paths) {
      assert.equal((await fetch(`${baseUrl}${path}`)).status, 404, path);
    }
  });

  it('GET unknown path returns 404', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    assert.equal(res.status, 404);
  });
});
